import { randomUUID } from 'node:crypto';
import { mkdir, readFile, rename, rm, writeFile } from 'node:fs/promises';
import { homedir } from 'node:os';
import { dirname, join, resolve } from 'node:path';

import { registerManagementRpc } from '../management-rpc.mjs';

/** Default notification target: one saved delivery target shared by every Session. */
export const NOTIFY_TARGET_RPC_CHANNEL = '/dsh-im-notify';
export const NOTIFY_TARGET_ENDPOINTS = Object.freeze({
  get: 'settings.notify-target.get',
  set: 'settings.notify-target.set',
});

const BOT_ID_PATTERN = /^[A-Za-z0-9_-]{1,128}$/;
const TARGET_ID_PATTERN = /^[A-Za-z0-9._:@-]{1,128}$/;

export function notifyTargetPath(config = {}) {
  const dshHome = resolve(config.dshHome ?? process.env.DSH_HOME ?? join(homedir(), '.dsh'));
  return join(dshHome, 'integrations', 'dsh-im', 'notify-target.json');
}

function normalizeDefaultTarget(value) {
  if (value === null || value === undefined) return null;
  if (!value || typeof value !== 'object' || Array.isArray(value)) {
    throw new TypeError('Invalid default notify target');
  }
  const keys = Object.keys(value);
  if (keys.length !== 2
    || typeof value.botId !== 'string' || !BOT_ID_PATTERN.test(value.botId)
    || typeof value.targetId !== 'string' || !TARGET_ID_PATTERN.test(value.targetId)) {
    throw new TypeError('Invalid default notify target');
  }
  return { botId: value.botId, targetId: value.targetId };
}

export class NotifyTargetStore {
  #path;
  #writes = Promise.resolve();

  constructor(path) {
    if (typeof path !== 'string' || !path) throw new TypeError('Notify target store needs a path');
    this.#path = path;
  }

  async get() {
    let raw;
    try {
      raw = await readFile(this.#path, 'utf8');
    } catch (error) {
      if (error.code === 'ENOENT') return null;
      throw error;
    }
    const value = JSON.parse(raw);
    if (value?.version !== 1) throw new Error('Invalid notify target settings');
    return normalizeDefaultTarget(value.defaultTarget ?? null);
  }

  async set(defaultTarget) {
    const target = normalizeDefaultTarget(defaultTarget);
    const operation = this.#writes.catch(() => {}).then(async () => {
      await mkdir(dirname(this.#path), { recursive: true, mode: 0o700 });
      const temporary = `${this.#path}.${randomUUID()}.tmp`;
      try {
        await writeFile(
          temporary,
          `${JSON.stringify({ version: 1, defaultTarget: target }, null, 2)}\n`,
          { mode: 0o600, flag: 'wx' },
        );
        await rename(temporary, this.#path);
      } finally {
        await rm(temporary, { force: true });
      }
      return target;
    });
    this.#writes = operation;
    return operation;
  }
}

function badRequest() {
  return { ok: false, error: { code: 'bad-request', message: 'Invalid notify target settings.' } };
}

export function createNotifyTargetRpcHandler({ config = {}, store } = {}) {
  store ??= new NotifyTargetStore(notifyTargetPath(config));
  return async (endpoint, payload, signal) => {
    if (signal?.aborted) return { ok: false, error: { code: 'cancelled', message: 'Request cancelled.' } };
    if (!payload || typeof payload !== 'object' || Array.isArray(payload)) return badRequest();
    try {
      if (endpoint === NOTIFY_TARGET_ENDPOINTS.get) {
        if (Object.keys(payload).length !== 0) return badRequest();
        return { ok: true, value: { defaultTarget: await store.get() } };
      }
      if (endpoint === NOTIFY_TARGET_ENDPOINTS.set) {
        if (Object.keys(payload).length !== 1 || !Object.hasOwn(payload, 'defaultTarget')) {
          return badRequest();
        }
        try {
          return { ok: true, value: { defaultTarget: await store.set(payload.defaultTarget ?? null) } };
        } catch (error) {
          // A malformed target is the caller's fault; anything else is storage.
          if (error instanceof TypeError) return badRequest();
          throw error;
        }
      }
    } catch {
      return {
        ok: false,
        error: { code: 'notify-target-unavailable', message: '无法读取或保存默认通知目标，请稍后重试。' },
      };
    }
    return badRequest();
  };
}

export function installNotifyTargetRpc(ctx, { config = {} } = {}) {
  return registerManagementRpc(
    ctx,
    NOTIFY_TARGET_RPC_CHANNEL,
    createNotifyTargetRpcHandler({ config }),
    { authority: config.rpcAuthority },
  );
}
