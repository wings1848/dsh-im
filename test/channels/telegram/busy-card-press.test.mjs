// Picker presses must not become a side door around the queue.
//
// `/workspace` and `/session` are answered while a turn is running (they used to
// wait behind it). The cards they open replay identity-changing commands —
// switching the bot workspace or rebinding the Session — so a press during that
// same turn has to be refused instead of changing what the turn belongs to.

import assert from 'node:assert/strict';
import { mkdtemp, mkdir, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { setTimeout as delay } from 'node:timers/promises';

import { ActionCardRegistry } from '../../../src/channels/shared/action-card.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { TELEGRAM_WORKSPACE_CARD } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramSessionCard } from '../../../src/channels/telegram/session-card.mjs';

const BUSY_NOTICE = '当前任务仍在运行，请先停止任务或等待任务完成后再执行此操作。';

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

let messageSeq = 0;
function message(content) {
  messageSeq += 1;
  return {
    messageId: `msg-${messageSeq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
  };
}

function callback(data) {
  messageSeq += 1;
  return {
    messageId: `update-${messageSeq}`,
    callbackQueryId: 'cb-1',
    providerMessageId: 700,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    replyTarget: { chatId: 42 },
    data,
  };
}

function buttons(cards) {
  return (cards.at(-1)?.markup?.inline_keyboard ?? []).flat();
}

async function press(bridge, data) {
  await bridge.acceptCallback(callback(data));
  await delay(0);
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'busy-card-'));
  const paths = [join(root, 'w0'), join(root, 'w1')];
  for (const path of paths) await mkdir(path);
  const sessions = [1, 2].map((index) => ({
    sessionId: `${String(index).padStart(8, '0')}-1111-2222-3333-444455556666`,
    title: `会话 ${index}`,
    archived: false,
    summaryAvailable: true,
  }));
  const asks = [];
  const cards = [];
  const notices = [];
  const switches = [];
  const binds = [];
  const gate = deferred();
  let bound = null;
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    workspaceCard: TELEGRAM_WORKSPACE_CARD,
    sessionCard: new TelegramSessionCard({ registry: new ActionCardRegistry() }),
    state: {
      seen: new Set(),
      hasSeen(id) { return this.seen.has(id); },
      async markSeen(id) { this.seen.add(id); },
      sessionFor() { return bound; },
      async setSession(_key, sessionId) { bound = sessionId; },
      async clearSession() { bound = null; },
    },
    bot: {
      async sendText() {},
      async sendInteractionCard(_target, { text, markup }) {
        cards.push({ text, markup });
        return { providerMessageIds: [String(700 + cards.length)] };
      },
      async updateInteractionCard() {},
      async editInteractionCard() {},
      async answerInteractionCallback(_queryId, text) { notices.push(text); },
    },
    harness: {
      currentWorkspace: () => paths[0],
      async listWorkspaces() { return [...paths]; },
      async listWorkspaceEntries() { return paths.map((path) => ({ path })); },
      async listWorkspaceSessions(workspace) {
        return { workspace, sessions: sessions.map((session) => ({ ...session })) };
      },
      async switchWorkspace(path) { switches.push(path); return path; },
      async bindWorkspaceSession(_key, sessionId) {
        binds.push(sessionId);
        return { sessionId, workspace: paths[0], title: '标题', archived: false };
      },
      assertWorkspaceScope() {},
      async ensureRunning() {},
      async createSession() { return sessions[0].sessionId; },
      async sessionExists() { return true; },
      workspaceSession: () => ({
        sessionId: sessions[0].sessionId,
        async sessionExists() { return true; },
        async models() {
          return {
            current: { provider: 'deepseek-official', model: 'deepseek-v4-pro' },
            groups: [],
            failures: [],
          };
        },
        async isRunning() { return asks.length > 0; },
        async ask() { asks.push(1); await gate.promise; return 'answer'; },
      }),
    },
    logger: { warn() {}, error() {} },
  });
  return { bridge, root, cards, notices, switches, binds, asks, release: gate.resolve };
}

async function startSlowTurn(fixture) {
  const running = fixture.bridge.accept(message('请做一个很慢的任务'));
  await eventually(() => fixture.asks.length === 1, 'the turn never started');
  // Return the pending accept promise inside an object: awaiting the helper
  // must not await the turn itself.
  return { running };
}

test('a workspace picker opened during a turn refuses to switch', async () => {
  const f = await fixture();
  const { running } = await startSlowTurn(f);

  await f.bridge.accept(message('/workspace'));
  assert.equal(f.cards.length, 1, 'the picker is shown immediately');
  const target = buttons(f.cards).find((button) => !button.text.includes('✓'));
  assert.ok(target, 'the picker offers a different workspace');
  await press(f.bridge, target.callback_data);

  assert.deepEqual(f.switches, [], 'the press must not switch mid-turn');
  assert.equal(f.notices.at(-1), BUSY_NOTICE);

  f.release();
  await running;
  await f.bridge.waitForIdle();
  await rm(f.root, { recursive: true, force: true });
});

test('a session picker opened during a turn refuses to rebind', async () => {
  const f = await fixture();
  const { running } = await startSlowTurn(f);

  await f.bridge.accept(message('/session'));
  assert.equal(f.cards.length, 1, 'the picker is shown immediately');
  const target = buttons(f.cards).at(-1);
  assert.ok(target, 'the picker offers a session');
  await press(f.bridge, target.callback_data);

  assert.deepEqual(f.binds, [], 'the press must not rebind mid-turn');
  assert.equal(f.notices.at(-1), BUSY_NOTICE);

  f.release();
  await running;
  await f.bridge.waitForIdle();
  await rm(f.root, { recursive: true, force: true });
});
