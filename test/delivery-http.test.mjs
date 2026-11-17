import assert from 'node:assert/strict';
import { once } from 'node:events';
import { createServer } from 'node:http';
import test from 'node:test';

import {
  DELIVERY_HTTP_PATH,
  createDeliveryHttpHandler,
  installDeliveryHttp,
  isLoopbackAddress,
} from '../plugin-src/host/delivery-http.mjs';

function serviceFixture() {
  const calls = [];
  const service = {};
  for (const method of [
    'send',
    'listTargets',
    'listSuggestions',
    'createTarget',
    'updateTarget',
    'deleteTarget',
  ]) {
    service[method] = async (...args) => {
      calls.push([method, ...args]);
      return method === 'send' ? { sent: true } : { method };
    };
  }
  return { service, calls };
}

async function withServer(handler, callback) {
  const server = createServer(handler);
  server.listen(0, '127.0.0.1');
  await once(server, 'listening');
  try {
    const address = server.address();
    await callback(`http://127.0.0.1:${address.port}${DELIVERY_HTTP_PATH}`);
  } finally {
    server.close();
    await once(server, 'close');
  }
}

async function request(url, { method = 'POST', body, contentType = 'application/json', headers = {} } = {}) {
  const response = await fetch(url, {
    method,
    headers: { ...(contentType === undefined ? {} : { 'content-type': contentType }), ...headers },
    body,
  });
  return {
    status: response.status,
    allow: response.headers.get('allow'),
    body: await response.json(),
  };
}

test('delivery HTTP POST forwards the exact public payload to the shared service', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const result = await request(url, {
      contentType: 'application/json; charset=utf-8',
      body: JSON.stringify({
        botId: 'bot_one',
        targetId: 'daily-report',
        text: '测试消息',
      }),
    });
    assert.deepEqual(result, {
      status: 200,
      allow: null,
      body: { sent: true },
    });
  });
  assert.equal(calls.length, 1);
  assert.equal(calls[0][0], 'send');
  assert.deepEqual(calls[0].slice(1, 4), ['bot_one', 'daily-report', '测试消息']);
});

test('delivery HTTP accepts optional Markdown format and rejects invalid format before sending', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const payload = { botId: 'bot_one', targetId: 'daily-report', text: '# Report\n\n**done**' };
    for (const format of ['plain', 'markdown']) {
      const result = await request(url, { body: JSON.stringify({ ...payload, format }) });
      assert.equal(result.status, 200);
      assert.equal(calls.at(-1)[4].format, format);
      assert.equal(calls.at(-1)[3], payload.text);
    }
    for (const format of ['html', null, 1, ['markdown']]) {
      const result = await request(url, { body: JSON.stringify({ ...payload, format }) });
      assert.equal(result.status, 400);
      assert.equal(result.body.error.code, 'bad-request');
    }
  });
  assert.equal(calls.length, 2);
});

test('delivery HTTP rejects unsupported methods, media types, JSON, fields, and oversized bodies', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    const method = await request(url, { method: 'GET' });
    assert.equal(method.status, 405);
    assert.equal(method.allow, 'POST');
    assert.equal(method.body.error.code, 'method-not-allowed');

    const media = await request(url, { contentType: 'text/plain', body: '{}' });
    assert.equal(media.status, 415);
    assert.equal(media.body.error.code, 'unsupported-media-type');

    const malformed = await request(url, { body: '{' });
    assert.equal(malformed.status, 400);
    assert.equal(malformed.body.error.code, 'bad-request');

    const extra = await request(url, {
      body: JSON.stringify({
        botId: 'bot_one', targetId: 'target', text: 'hello', sessionId: 'unstable',
      }),
    });
    assert.equal(extra.status, 400);
    assert.equal(extra.body.error.code, 'bad-request');

    const oversized = await request(url, {
      body: JSON.stringify({
        botId: 'bot_one', targetId: 'target', text: 'x'.repeat(1024 * 1024),
      }),
    });
    assert.equal(oversized.status, 413);
    assert.equal(oversized.body.error.code, 'payload-too-large');
  });
  assert.deepEqual(calls, []);
});

test('delivery HTTP maps only stable delivery errors to HTTP status codes', async () => {
  const expected = new Map([
    ['bad-request', 400],
    ['unknown-bot', 404],
    ['unknown-target', 404],
    ['target-conflict', 409],
    ['invalid-target', 422],
    ['bot-not-connected', 503],
    ['target-rejected', 422],
    ['delivery-failed', 502],
    ['cancelled', 408],
  ]);
  const { service } = serviceFixture();
  let code = 'delivery-failed';
  service.send = async () => {
    const error = new Error(`private detail for ${code}`);
    error.code = code;
    throw error;
  };
  await withServer(createDeliveryHttpHandler(service), async (url) => {
    for (const [candidate, status] of expected) {
      code = candidate;
      const result = await request(url, {
        body: JSON.stringify({ botId: 'bot_one', targetId: 'target', text: 'hello' }),
      });
      assert.equal(result.status, status);
      assert.deepEqual(result.body, {
        error: { code: candidate, message: candidate, details: {} },
      });
    }

    code = 'private-internal-error';
    const hidden = await request(url, {
      body: JSON.stringify({ botId: 'bot_one', targetId: 'target', text: 'hello' }),
    });
    assert.equal(hidden.status, 502);
    assert.deepEqual(hidden.body, {
      error: { code: 'delivery-failed', message: 'delivery-failed', details: {} },
    });
  });
});

test('delivery HTTP installs one exact WebServer route with Cordis lifecycle ownership', () => {
  const { service } = serviceFixture();
  const registrations = [];
  const effects = [];
  const dispose = () => {};
  const ctx = {
    webServer: {
      register(route) {
        registrations.push(route);
        return dispose;
      },
    },
    effect(factory, label) {
      effects.push(label);
      return factory();
    },
  };

  assert.equal(installDeliveryHttp(ctx, service), dispose);
  assert.deepEqual(effects, [`dsh-im: ${DELIVERY_HTTP_PATH}`]);
  assert.equal(registrations.length, 1);
  assert.equal(registrations[0].kind, 'exact');
  assert.equal(registrations[0].path, DELIVERY_HTTP_PATH);
  assert.equal(typeof registrations[0].handler, 'function');
});


function fakeRequest(remoteAddress, { method = 'POST', headers = { 'content-type': 'application/json' }, body = '' } = {}) {
  const chunks = body ? [Buffer.from(body)] : [];
  return {
    method,
    headers,
    socket: { remoteAddress },
    once() {},
    off() {},
    async *[Symbol.asyncIterator]() {
      for (const chunk of chunks) yield chunk;
    },
  };
}

function fakeResponse() {
  const result = { status: 0, headers: {}, body: null };
  return {
    result,
    destroyed: false,
    writableEnded: false,
    writeHead(status, headers) {
      result.status = status;
      result.headers = headers;
    },
    end(body) {
      result.body = JSON.parse(body);
      this.writableEnded = true;
    },
    once() {},
    off() {},
  };
}

test('delivery HTTP only recognizes real loopback peers', () => {
  for (const address of ['127.0.0.1', '127.8.9.10', '::1', '::ffff:127.0.0.1']) {
    assert.equal(isLoopbackAddress(address), true, address);
  }
  for (const address of ['10.0.0.5', '192.168.1.2', '::ffff:10.0.0.5', '203.0.113.9', undefined, '']) {
    assert.equal(isLoopbackAddress(address), false, String(address));
  }
});

test('delivery HTTP without a token refuses non-loopback peers before reading the body', async () => {
  const { service, calls } = serviceFixture();
  const response = fakeResponse();
  await createDeliveryHttpHandler(service)(
    fakeRequest('10.0.0.5', { body: JSON.stringify({ botId: 'bot_one', targetId: 't', text: 'hi' }) }),
    response,
  );
  assert.equal(response.result.status, 403);
  assert.equal(response.result.body.error.code, 'loopback-only');
  assert.deepEqual(calls, []);
});

test('delivery HTTP accepts a non-loopback peer only with the configured bearer token', async () => {
  const { service, calls } = serviceFixture();
  const handler = createDeliveryHttpHandler(service, { token: 'delivery-secret' });
  const payload = JSON.stringify({ botId: 'bot_one', targetId: 't', text: 'hi' });

  const anonymous = fakeResponse();
  await handler(fakeRequest('10.0.0.5', { body: payload }), anonymous);
  assert.equal(anonymous.result.status, 401);
  assert.equal(anonymous.result.body.error.code, 'unauthorized');

  const wrong = fakeResponse();
  await handler(fakeRequest('10.0.0.5', {
    body: payload,
    headers: { 'content-type': 'application/json', authorization: 'Bearer nope' },
  }), wrong);
  assert.equal(wrong.result.status, 401);
  assert.deepEqual(calls, []);

  const allowed = fakeResponse();
  await handler(fakeRequest('10.0.0.5', {
    body: payload,
    headers: { 'content-type': 'application/json', authorization: 'Bearer delivery-secret' },
  }), allowed);
  assert.equal(allowed.result.status, 200);
  assert.deepEqual(allowed.result.body, { sent: true });
  assert.equal(calls.length, 1);
});

test('delivery HTTP requires the bearer token even on loopback once it is configured', async () => {
  const { service, calls } = serviceFixture();
  await withServer(createDeliveryHttpHandler(service, { token: 'delivery-secret' }), async (url) => {
    const missing = await request(url, { body: JSON.stringify({ botId: 'bot_one', targetId: 't', text: 'hi' }) });
    assert.equal(missing.status, 401);
    assert.equal(missing.body.error.code, 'unauthorized');

    const allowed = await request(url, {
      body: JSON.stringify({ botId: 'bot_one', targetId: 't', text: 'hi' }),
      headers: { authorization: 'Bearer delivery-secret' },
    });
    assert.equal(allowed.status, 200);
    assert.deepEqual(allowed.body, { sent: true });
  });
  assert.equal(calls.length, 1);
});
