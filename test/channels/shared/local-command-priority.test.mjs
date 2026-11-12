// A bridge-local command answers immediately even while a turn is running.
//
// The screenshot that opened this work: a 553-second turn was still counting
// steps when the reader typed `/workspace` and `/display`, and both landed in
// the per-conversation queue — the bot replied 「已排队，等待前序消息处理。」
// to commands that never needed the model. These cases pin the split: local
// view/read commands run ahead of the queue; commands that change which
// Session or workspace the conversation uses keep their queue position.

import assert from 'node:assert/strict';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

const QUEUED = '已排队，等待前序消息处理。';

function deferred() {
  let resolve;
  const promise = new Promise((done) => { resolve = done; });
  return { promise, resolve };
}

async function eventually(predicate, label) {
  for (let attempt = 0; attempt < 400; attempt += 1) {
    if (predicate()) return;
    await delay(5);
  }
  assert.fail(label ?? 'condition was not met');
}

function message(id, text) {
  return {
    messageId: id,
    content: text,
    senderId: 'actor',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat',
    addressed: true,
    plainText: true,
    replyTarget: { id: 'target' },
  };
}

function fixture() {
  const sent = [];
  const asks = [];
  const switches = [];
  const sessions = new Map();
  const seen = new Set();
  const first = deferred();
  const harness = {
    async ensureRunning() {},
    currentWorkspace: () => process.cwd(),
    currentConversationWorkspace: () => process.cwd(),
    async listWorkspaces() { return [process.cwd(), '/tmp']; },
    async switchWorkspace(path) { switches.push(path); return path; },
    async createSession() { return 'session-1'; },
    async sessionExists() { return true; },
    workspaceSession: () => ({
      sessionId: 'session-1',
      async sessionExists() { return true; },
      async models() {
        return {
          current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
          groups: [],
          failures: [],
        };
      },
      async isRunning() { return asks.length > 0; },
      async ask(text) {
        asks.push(text);
        if (asks.length === 1) await first.promise;
        return 'answer';
      },
    }),
    async agentPresetSettings() {
      return { agentPreset: null, agentPresetCatalog: { items: [] } };
    },
  };
  const state = {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, sessionId) => { sessions.set(key, sessionId); },
    clearSession: async (key) => { sessions.delete(key); },
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => { seen.add(id); },
    unmarkSeen: async (id) => { seen.delete(id); },
    pendingMessages: () => [],
  };
  const bot = {
    async sendText(target, text) { sent.push({ target, text }); },
  };
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    logger: { warn() {}, error() {}, info() {} },
  });
  return { bridge, sent, asks, switches, first };
}

function texts(sent) {
  return sent.map((entry) => entry.text);
}

test('local view commands answer during a running turn instead of queueing', async () => {
  const { bridge, sent, asks, switches, first } = fixture();
  const running = bridge.accept(message('turn-1', '请做一个很慢的评审'));
  await eventually(() => asks.length === 1, 'the first turn never reached the Harness');

  // Each command must answer while `turn-1` still owns the conversation.
  const status = bridge.accept(message('cmd-status', '/status'));
  await Promise.race([
    status,
    delay(2_000).then(() => assert.fail('/status waited for the running turn')),
  ]);
  assert.ok(texts(sent).some((text) => text.includes('连接正常')), '/status answered with its text');

  const display = bridge.accept(message('cmd-display', '/display'));
  await Promise.race([
    display,
    delay(2_000).then(() => assert.fail('/display waited for the running turn')),
  ]);
  assert.ok(texts(sent).some((text) => text.includes('极简')), '/display answered with the picker text');

  const workspace = bridge.accept(message('cmd-workspace', '/workspace'));
  await Promise.race([
    workspace,
    delay(2_000).then(() => assert.fail('/workspace waited for the running turn')),
  ]);
  assert.ok(texts(sent).some((text) => text.includes('工作区')), '/workspace answered with its listing');
  assert.deepEqual(switches, [], 'a bare /workspace listing never switches anything');

  assert.equal(
    texts(sent).filter((text) => text === QUEUED).length,
    0,
    'no view command got the queue receipt',
  );

  // Identity-changing commands keep the queue: the turn still owns the Session.
  // These promises settle only after the queued command runs; the receipt
  // arrives first, so wait for the receipt instead of awaiting the turn.
  void bridge.accept(message('cmd-new', '/new'));
  void bridge.accept(message('cmd-switch', '/workspace /tmp'));
  await eventually(
    () => texts(sent).filter((text) => text === QUEUED).length === 2,
    'identity commands never got their queue receipts',
  );
  assert.deepEqual(switches, [], 'the switch must not run before the turn ends');

  first.resolve();
  await running;
  await bridge.waitForIdle();
  assert.deepEqual(switches, ['/tmp'], 'the queued switch runs once the turn releases');
});
