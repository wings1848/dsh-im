import { createHash, timingSafeEqual } from 'node:crypto';

import { createDeliveryRpcHandler, DELIVERY_ENDPOINTS } from './delivery-rpc.mjs';

export const DELIVERY_HTTP_PATH = '/api/dsh-im/delivery/messages';

const MAX_BODY_BYTES = 1024 * 1024;

/**
 * The endpoint is loopback-only until the profile configures
 * `deliveryHttpToken`; that token is the only way to accept a caller from
 * another host. A forwarded header is deliberately ignored: only the socket
 * peer decides, so a reverse proxy cannot widen reachability by accident.
 */
export function isLoopbackAddress(address) {
  if (typeof address !== 'string') return false;
  const value = address.trim().toLowerCase();
  if (value === '::1') return true;
  if (value.startsWith('::ffff:')) return isLoopbackAddress(value.slice('::ffff:'.length));
  return /^127(?:\.\d{1,3}){3}$/u.test(value);
}

function digest(value) {
  return createHash('sha256').update(value, 'utf8').digest();
}

function bearerToken(request) {
  const header = request.headers?.authorization;
  if (typeof header !== 'string') return null;
  const [scheme, ...rest] = header.trim().split(/\s+/u);
  if (scheme?.toLowerCase() !== 'bearer' || rest.length !== 1 || !rest[0]) return null;
  return rest[0];
}

function refused(response, status, code, headers = {}) {
  json(response, status, {
    error: { code, message: code, details: {} },
  }, headers);
}

const DELIVERY_ERROR_STATUS = Object.freeze({
  'bad-request': 400,
  'unknown-bot': 404,
  'unknown-target': 404,
  'target-conflict': 409,
  'invalid-target': 422,
  'bot-not-connected': 503,
  'target-rejected': 422,
  'delivery-failed': 502,
  cancelled: 408,
});

class HttpRequestError extends Error {
  constructor(status, code) {
    super(code);
    this.status = status;
    this.code = code;
  }
}

function json(response, status, value, headers = {}) {
  if (response.destroyed || response.writableEnded) return;
  const body = JSON.stringify(value);
  response.writeHead(status, {
    'cache-control': 'no-store',
    'content-type': 'application/json; charset=utf-8',
    'content-length': String(Buffer.byteLength(body)),
    ...headers,
  });
  response.end(body);
}

function isJsonContentType(value) {
  return typeof value === 'string'
    && value.split(';', 1)[0].trim().toLowerCase() === 'application/json';
}

async function readJsonBody(request) {
  const declaredLength = Number(request.headers['content-length']);
  if (Number.isFinite(declaredLength) && declaredLength > MAX_BODY_BYTES) {
    throw new HttpRequestError(413, 'payload-too-large');
  }

  const chunks = [];
  let length = 0;
  for await (const chunk of request) {
    const buffer = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk);
    length += buffer.length;
    if (length > MAX_BODY_BYTES) {
      throw new HttpRequestError(413, 'payload-too-large');
    }
    chunks.push(buffer);
  }

  try {
    return JSON.parse(Buffer.concat(chunks, length).toString('utf8'));
  } catch {
    throw new HttpRequestError(400, 'bad-request');
  }
}

export function createDeliveryHttpHandler(service, { token } = {}) {
  const dispatch = createDeliveryRpcHandler(service);
  const expectedToken = typeof token === 'string' && token.trim() ? digest(token.trim()) : null;
  return async (request, response) => {
    if (expectedToken === null) {
      if (!isLoopbackAddress(request.socket?.remoteAddress)) {
        refused(response, 403, 'loopback-only');
        return;
      }
    } else {
      const provided = bearerToken(request);
      if (provided === null || !timingSafeEqual(expectedToken, digest(provided))) {
        refused(response, 401, 'unauthorized', { 'www-authenticate': 'Bearer' });
        return;
      }
    }
    if (request.method !== 'POST') {
      json(response, 405, {
        error: { code: 'method-not-allowed', message: 'method-not-allowed', details: {} },
      }, { allow: 'POST' });
      return;
    }
    if (!isJsonContentType(request.headers['content-type'])) {
      json(response, 415, {
        error: { code: 'unsupported-media-type', message: 'unsupported-media-type', details: {} },
      });
      return;
    }

    const abort = new AbortController();
    const cancel = () => abort.abort();
    const cancelClosedResponse = () => {
      if (!response.writableEnded) cancel();
    };
    request.once('aborted', cancel);
    response.once('close', cancelClosedResponse);
    try {
      const payload = await readJsonBody(request);
      const result = await dispatch(DELIVERY_ENDPOINTS.send, payload, abort.signal);
      if (result.ok) {
        json(response, 200, result.value);
        return;
      }
      json(response, DELIVERY_ERROR_STATUS[result.error.code] ?? 500, {
        error: result.error,
      });
    } catch (error) {
      if (error instanceof HttpRequestError) {
        json(response, error.status, {
          error: { code: error.code, message: error.code, details: {} },
        });
        return;
      }
      json(response, 500, {
        error: { code: 'delivery-failed', message: 'delivery-failed', details: {} },
      });
    } finally {
      request.off('aborted', cancel);
      response.off('close', cancelClosedResponse);
    }
  };
}

export function installDeliveryHttp(ctx, service, { token } = {}) {
  if (!ctx?.webServer || typeof ctx.webServer.register !== 'function'
    || typeof ctx.effect !== 'function') {
    throw new TypeError('DSH Host WebServer is required');
  }
  const route = {
    kind: 'exact',
    path: DELIVERY_HTTP_PATH,
    handler: createDeliveryHttpHandler(service, { token }),
  };
  return ctx.effect(
    () => ctx.webServer.register(route),
    `dsh-im: ${DELIVERY_HTTP_PATH}`,
  );
}
