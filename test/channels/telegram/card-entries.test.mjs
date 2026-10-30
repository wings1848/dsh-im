import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test, { after, before } from 'node:test';

import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TELEGRAM_MENU_ACTIONS } from '../../../src/channels/telegram/menu-card.mjs';
import { TELEGRAM_STATUS_ACTIONS } from '../../../src/channels/telegram/status-card.mjs';

/**
 * Every card entry, pressed for real.
 *
 * Why this file exists: a previous batch shipped `#runMenuEntry` calling
 * `isWorkspaceCommand` without importing it. Nothing caught it, because each
 * card test only exercised the entries its own author happened to press, and the
 * surrounding `catch` turned the `ReferenceError` into an ordinary "could not
 * open that" notice. The symptom looked like a flaky UI, not a code defect.
 *
 * So instead of trusting per-card tests to cover every entry, this one walks the
 * whole action map of the two "hub" cards and presses each button against a real
 * bridge. It asserts two things per press:
 *
 *   1. no programming error escaped (a ReferenceError/TypeError means broken code,
 *      not a runtime failure the user should see);
 *   2. the press produced either a card or some text — silence is the bug.
 */

let WORKSPACE = '';

before(async () => {
  WORKSPACE = await mkdtemp(join(tmpdir(), 'card-entry-'));
});

after(async () => {
  if (WORKSPACE) await rm(WORKSPACE, { recursive: true, force: true });
});

/** Collects everything the bot was asked to do, plus anything that threw. */
function botFixture() {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async sendInteractionCard(_target, { text, markup } = {}) {
      cards.push({ text, markup });
      return { providerMessageIds: [String(300 + cards.length)] };
    },
    async editInteractionCard(_target, messageId, { text, markup } = {}) {
      edits.push({ messageId, text, markup });
      return { messageId, text, markup };
    },
    async updateInteractionCard(_target, messageId, { markup } = {}) {
      edits.push({ messageId, markup });
    },
    async answerInteractionCallback(queryId, text) { notices.push({ queryId, text }); },
  };
  return { bot, sent, cards, edits, notices };
}

function harnessFixture() {
  const calls = [];
  return {
    calls,
    async ensureRunning() {},
    currentWorkspace: () => WORKSPACE,
    currentConversationWorkspace: () => WORKSPACE,
    hasConversationWorkspaceOverride: () => false,
    // workspacePathSnapshot reads a plain path array.
    async listWorkspaces() {
      calls.push('listWorkspaces');
      return [WORKSPACE];
    },
    async listWorkspaceSessions(workspace) {
      calls.push('listWorkspaceSessions');
      return { workspace, sessions: [] };
    },
    async agentPresetSettings() {
      calls.push('agentPresetSettings');
      return {
        agentPreset: null,
        agentPresetCatalog: { defaultId: '', items: [] },
      };
    },
    async switchWorkspace() { calls.push('switchWorkspace'); return WORKSPACE; },
    async switchConversationWorkspace() { calls.push('switchConversationWorkspace'); return WORKSPACE; },
    async clearConversationWorkspace() { calls.push('clearConversationWorkspace'); return WORKSPACE; },
    async bindWorkspaceSession() { calls.push('bindWorkspaceSession'); },
    assertWorkspaceScope() {},
    workspaceSession: () => ({
      async sessionExists() { return true; },
      async models() {
        return {
          groups: [], failures: [],
          current: { provider: 'p', model: 'm' },
        };
      },
      async isRunning() { return false; },
      async executeCommand() { return { result: { kind: 'success' } }; },
    }),
    async executeCommand() { return { result: { kind: 'success' } }; },
  };
}

function bridgeFor({ bot }) {
  return new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: {
      hasSeen: () => false,
      async markSeen() {},
      sessionFor: () => 'session-abcdef1234567890',
    },
    logger: { warn() {}, error() {} },
  });
}

let messageSeq = 0;
function message(content) {
  messageSeq += 1;
  return {
    messageId: `entry-msg-${messageSeq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-entry',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
  };
}

function callbackFor(data, providerMessageId) {
  messageSeq += 1;
  return {
    callbackQueryId: `cb-entry-${messageSeq}`,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-entry',
    messageId: `entry-update-${messageSeq}`,
    providerMessageId,
    data,
    replyTarget: { chatId: 42 },
  };
}

/**
 * Press a card's entry by its visible label, against a real bridge.
 *
 * Returns the recorded effects so a test can assert something actually happened.
 */
async function pressEntry(command, matcher, { action, label } = {}) {
  const env = botFixture();
  const bridge = bridgeFor({ bot: env.bot });
  await bridge.accept(message(command));
  assert.ok(env.cards.length >= 1, `${command} must produce a card`);
  const buttons = env.cards[0].markup.inline_keyboard.flat();
  const button = buttons.find((entry) => matcher(entry.callback_data, entry.text));
  assert.ok(button, `${command} has no entry for ${label ?? action}: `
    + buttons.map((entry) => entry.text).join(' | '));
  const before = { sent: env.sent.length, edits: env.edits.length, notices: env.notices.length };
  await bridge.acceptCallback(callbackFor(button.callback_data, env.cards[0] && '301'));
  return { env, before, button };
}

/**
 * The heart of this file: pressing an entry must never surface a programming
 * error as user-facing text, and must never do nothing at all.
 */
function assertEntryWorked({ env, before }, { action, command }) {
  const newText = env.sent.slice(before.sent);
  const newNotices = env.notices.slice(before.notices);
  const newEdits = env.edits.slice(before.edits);
  const surface = [...newText, ...newNotices.map((entry) => entry.text ?? ''),
    ...newEdits.map((entry) => entry.text ?? '')].join('\n');
  // A ReferenceError/TypeError escaping into the notice means broken code, not a
  // recoverable runtime failure — the exact shape of the old bug.
  assert.doesNotMatch(surface, /is not defined|is not a function|Cannot read propert/u,
    `${command} entry "${action}" surfaced a programming error:\n${surface}`);
  const worked = newText.length > 0 || newEdits.length > 0
    || newNotices.some((entry) => typeof entry.text === 'string' && entry.text.length > 0);
  assert.ok(worked, `${command} entry "${action}" did nothing at all`);
}

for (const [name, action] of Object.entries(TELEGRAM_MENU_ACTIONS)) {
  test(`/menu entry "${name}" works against a real bridge`, async () => {
    const base = await pressEntry('/menu', (data) => data.endsWith(`|${action}`), {
      action, label: name,
    });
    assertEntryWorked(base, { action: name, command: '/menu' });
  });
}

for (const [name, action] of Object.entries(TELEGRAM_STATUS_ACTIONS)) {
  test(`/status entry "${name}" works against a real bridge`, async () => {
    const base = await pressEntry('/status', (data) => data.endsWith(`|${action}`), {
      action, label: name,
    });
    assertEntryWorked(base, { action: name, command: '/status' });
  });
}

/**
 * `/conv` is the entry that actually reaches `#runMenuEntry`'s workspace branch.
 *
 * `/menu`'s 工作区 button sends `/ws`, which `isControlCommand` claims earlier in
 * the chain — so that button never exercised `isWorkspaceCommand`. `/conv <path>`
 * does, which is exactly how the missing import was found. Keeping this press
 * here means a future refactor of that chain fails loudly.
 */
test('the /conv entry reaches the workspace runner (the path that hid a real bug)',
  async () => {
    const env = botFixture();
    const bridge = bridgeFor({ bot: env.bot });
    await bridge.accept(message('/conv'));
    assert.equal(env.cards.length, 1, '/conv must produce a card');
    const buttons = env.cards[0].markup.inline_keyboard.flat();
    // Any workspace row works: it replays `/conv <path>`.
    const pick = buttons.find((entry) => /\|i\d+$/u.test(entry.callback_data));
    assert.ok(pick, `no workspace row: ${buttons.map((entry) => entry.text).join(' | ')}`);
    const before = { sent: env.sent.length, notices: env.notices.length };
    await bridge.acceptCallback(callbackFor(pick.callback_data, '301'));
    const surface = [
      ...env.sent.slice(before.sent),
      ...env.notices.slice(before.notices).map((entry) => entry.text ?? ''),
    ].join('\n');
    assert.doesNotMatch(surface, /is not defined|is not a function/u,
      `/conv pick surfaced a programming error:\n${surface}`);
    // The typed command's own receipt must come back through this path.
    assert.match(surface, /当前对话工作区已切换为|对话窗口|工作区/u, surface);
  });

test('every /menu entry maps to a command the bridge can actually run', async () => {
  // Pressing each one above proves the runner resolves; this pins the mapping so
  // a new entry cannot be added without a command behind it.
  const { TELEGRAM_MENU_ACTIONS: actions } = await import(
    '../../../src/channels/telegram/menu-card.mjs'
  );
  const { menuActionCommand } = await import('../../../src/channels/telegram/menu-card.mjs');
  for (const [name, action] of Object.entries(actions)) {
    assert.match(menuActionCommand(action), /^\//u, `/menu entry "${name}" has no command`);
  }
});
