import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TelegramConfigStore } from '../../../src/channels/telegram/config-store.mjs';
import { TelegramController } from '../../../src/channels/telegram/telegram-controller.mjs';
import { TelegramDisplayCard } from '../../../src/channels/telegram/display-card.mjs';
import { TelegramHarnessBridge } from '../../../src/channels/telegram/telegram-bridge.mjs';
import { TelegramBotClient } from '../../../src/channels/telegram/telegram-runtime.mjs';

const quietLogger = { warn: () => {}, error: () => {}, debug: () => {} };

function memoryState() {
  const sessions = new Map();
  const seen = new Set();
  return {
    sessionFor: (key) => sessions.get(key) ?? null,
    setSession: async (key, value) => sessions.set(key, value),
    clearSession: async (key) => sessions.delete(key),
    hasSeen: (id) => seen.has(id),
    markSeen: async (id) => seen.add(id),
  };
}

function message(overrides = {}) {
  return {
    messageId: 'm1',
    senderId: 'u1',
    kind: 'direct',
    conversationId: 'u1',
    content: 'hello',
    addressed: true,
    replyTarget: { chatId: 42, replyToMessageId: 7 },
    ...overrides,
  };
}

/** A semantic stream that records what the bridge asked it to show. */
function streamFixture({ failMode = false } = {}) {
  const calls = { updates: [], finish: [], fail: [], cancel: 0, deletes: 0 };
  const stream = {
    presentation: 'telegram-regular',
    previewAnswer: false,
    supportsProgressSummary: true,
    async update(block) { calls.updates.push(block.text); },
    async finish(block) {
      calls.finish.push(block);
      return { presentation: 'telegram-rich-final', providerMessageIds: ['9'], deliveryOutcome: 'sent' };
    },
    async fail(block) {
      if (!failMode) {
        calls.fail.push(block);
        return { presentation: 'telegram-regular', providerMessageIds: ['9'], deliveryOutcome: 'sent' };
      }
      calls.fail.push(block);
      return null;
    },
    cancel() { calls.cancel += 1; },
  };
  return { stream, calls };
}

function botFixture({ stream, onOpen } = {}) {
  const texts = [];
  const bot = {
    async sendText(_target, text) { texts.push(text); },
    async sendTyping() {},
    async openDeliveryStream() {
      onOpen?.('delivery');
      return stream;
    },
    async openThinkingStream() {
      onOpen?.('thinking');
      const lines = [];
      return {
        presentation: 'telegram-thinking',
        keepalive: true,
        async update() {},
        async refresh() {},
        async sendThinking(text) { lines.push(['thinking', text]); },
        async sendToolTrace(name, args) { lines.push(['tool', name, args]); },
        async finish(block) { lines.push(['finish', block.text]); },
        sendLines: () => lines,
      };
    },
    streamLines: null,
  };
  return { bot, texts };
}

function harnessFixture({ onAsk } = {}) {
  return {
    async ensureRunning() { return true; },
    async sessionExists() { return true; },
    async createSession() { return 'session-x'; },
    async ask(_sessionId, _text, options) {
      if (onAsk) await onAsk(options);
      return '**final**';
    },
  };
}

test('L1: minimal opens the placeholder stream and shows no progress at all', async () => {
  const { stream, calls } = streamFixture();
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'reasoning', text: 'thinking out loud' });
        await options.onUpdate({ type: 'status', text: '正在整理结果…' });
        await options.onUpdate({ type: 'text', text: 'partial answer' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'minimal',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.deepEqual(calls.updates, [], 'minimal must not rewrite the placeholder');
  assert.equal(calls.finish.length, 1);
  assert.equal(
    calls.finish[0].progressSummary ?? null,
    null,
    'minimal leaves no receipt: the answer is the only message',
  );
});

test('L2: standard paints one compact line and leaves a one-line receipt', async () => {
  const { stream, calls } = streamFixture();
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: '{"command":"ls"}' });
        await options.onUpdate({ type: 'tool-result', callId: 'c1', toolName: 'bash', text: 'output' });
        await options.onUpdate({ type: 'reasoning', text: 'must stay hidden' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'standard',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.equal(calls.updates.length, 1, 'one update per window, not one per event');
  assert.match(calls.updates[0], /^⏳ 处理中 · \d+ 秒 · 1 步\n🔧 bash → \{"command":"ls"\}$/);
  assert.match(calls.finish[0].progressSummary, /^✅ 完成 · \d+ 秒 · 1 步$/);
  assert.equal(calls.finish[0].format, 'markdown', 'the answer format is unchanged');
});

test('L3: a failed standard turn deletes the placeholder and sends the error', async () => {
  const { stream, calls } = streamFixture({ failMode: true });
  const { bot } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'tool', name: 'bash' });
        throw new Error('the turn died');
      },
    }),
    state: memoryState(),
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.equal(calls.fail.length, 1);
  assert.equal(
    typeof calls.fail[0].progressSummary,
    'undefined',
    'a failure leaves no receipt; the error message is the terminal state',
  );
});

test('L4: full still opens the thinking stream and never adds a receipt', async () => {
  const seen = [];
  const { bot } = botFixture({ onOpen: (kind) => seen.push(kind) });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture({
      onAsk: async (options) => {
        await options.onUpdate({ type: 'reasoning', text: 'Let me look first.' });
        await options.onUpdate({ type: 'tool', name: 'bash', arguments: 'ls' });
      },
    }),
    state: memoryState(),
    presentationLevel: 'full',
    logger: quietLogger,
  });
  await bridge.accept(message());
  assert.deepEqual(seen, ['thinking']);
});

test('L5: a legacy thinkingTraces=true still means the full rung', async () => {
  const seen = [];
  const { bot } = botFixture({ onOpen: (kind) => seen.push(kind) });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    thinkingTraces: true,
    logger: quietLogger,
  });
  assert.equal(bridge.presentationLevel, 'full');
  await bridge.accept(message());
  assert.deepEqual(seen, ['thinking']);
});

test('L6: /display without a card answers with the three rungs', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    displayCard: null,
  });
  await bridge.accept(message({ content: '/display' }));
  assert.equal(texts.length, 1);
  assert.match(texts[0], /显示挡位：标准/u);
  assert.match(texts[0], /极简/u);
  assert.match(texts[0], /全面/u);
});

test('L7: /display <level> persists the new level and confirms it', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const saved = [];
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    onPresentationLevelChange: async (level) => { saved.push(level); },
  });
  await bridge.accept(message({ content: '/display 极简' }));
  assert.deepEqual(saved, ['minimal']);
  assert.equal(bridge.presentationLevel, 'minimal');
  assert.match(texts.at(-1), /显示挡位已设为「极简」/u);
});

test('L8: a failed save keeps the previous level and says so', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    presentationLevel: 'standard',
    onPresentationLevelChange: async () => { throw new Error('config write failed'); },
  });
  await bridge.accept(message({ content: '/display 全面' }));
  assert.equal(bridge.presentationLevel, 'standard', 'a failed write must not claim a new rung');
  assert.match(texts.at(-1), /显示挡位保存失败/u);
});

test('L9: an unknown word is a usage error, not a silent no-op', async () => {
  const { stream } = streamFixture();
  const { bot, texts } = botFixture({ stream });
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
  });
  await bridge.accept(message({ content: '/display loud' }));
  assert.match(texts.at(-1), /用法：\/display/u);
});

test('L10: the picker card switches in place and reports the stored level', async () => {
  const cards = [];
  const edits = [];
  const notices = [];
  const bot = {
    async sendText() { assert.fail('the card path must not send a text menu'); },
    async answerInteractionCallback(queryId, text) { notices.push(text); },
    async sendInteractionCard(_target, { text, markup }) {
      cards.push({ text, markup });
      return { providerMessageIds: ['701'] };
    },
    async editInteractionCard(_target, messageId, { text, markup }) {
      edits.push({ messageId, text, markup });
      return {};
    },
  };
  const bridge = new TelegramHarnessBridge({
    bot,
    harness: harnessFixture(),
    state: memoryState(),
    logger: quietLogger,
    displayCard: new TelegramDisplayCard({ logger: quietLogger }),
    onPresentationLevelChange: async () => {},
  });
  await bridge.accept(message({ content: '/display' }));
  assert.equal(cards.length, 1);
  assert.match(cards[0].text, /当前：标准/u);
  const buttons = cards[0].markup.inline_keyboard.flat();
  assert.equal(buttons.length, 3);
  assert.match(buttons[1].text, /✓.*标准/u);

  const minimalPress = buttons[0].callback_data;
  await bridge.acceptCallback({
    conversationId: 'u1', senderId: 'u1', messageId: '701', kind: 'direct',
    data: minimalPress, replyTarget: { chatId: 42 },
  });
  assert.equal(bridge.presentationLevel, 'minimal');
  assert.equal(edits.length, 1, 'the picker repaints itself');
  assert.match(edits[0].text, /当前：极简/u);
  assert.match(edits[0].markup.inline_keyboard.flat()[0].text, /✓/u);
  assert.match(notices.at(-1), /极简/u);
});

// --- config store + controller -------------------------------------------

test('L11: the level is stored, reported and cleared back to the legacy field', async (t) => {
  const directory = await mkdtemp(join(tmpdir(), 'dsh-im-display-'));
  t.after(() => rm(directory, { recursive: true, force: true }));
  const configPath = join(directory, 'config.json');
  const configStore = await new TelegramConfigStore(configPath).load();
  const runtimeRecords = [];
  const controller = new TelegramController({
    credentials: {
      async resolve() { return { value: '123456789:token' }; },
      async set() {},
      async unset() {},
    },
    configStore,
    inspectToken: async () => ({ platformId: '123456789', name: 'Display Bot', username: 'display_bot' }),
    createRuntime: async ({ botId, config }) => {
      runtimeRecords.push({ botId, config: structuredClone(config) });
      return {
        status: { ready: true, connectionState: 'connected', harnessReachable: true, lastCheckedAt: 10 },
        async start() {},
        async stop() {},
      };
    },
  });
  const bound = await controller.bindCredentials({ token: '123456789:ABCDEFGHIJKLMNOPQRSTUVWXYZabcdef123456' });
  const botId = bound.bots[0].botId;
  assert.equal(bound.bots[0].presentationLevel, 'standard', 'a fresh bot starts compact');

  const full = await controller.setPresentationLevel(botId, 'full');
  assert.equal(full.bots[0].presentationLevel, 'full');
  assert.equal(configStore.get(botId).presentationLevel, 'full');
  assert.equal(runtimeRecords.at(-1).config.presentationLevel, 'full', 'the runtime restarts with the new level');

  // An unknown value clamps to the default instead of poisoning the bot.
  const clamped = await controller.setPresentationLevel(botId, 'shout');
  assert.equal(clamped.bots[0].presentationLevel, 'standard');

  // A legacy explicit `thinkingTraces: true` still renders at the full rung.
  await controller.setThinkingTraces(botId, true);
  assert.equal(controller.status().bots.find((item) => item.botId === botId).presentationLevel, 'full');
  // Choosing a level clears the legacy field so the two cannot disagree.
  await controller.setPresentationLevel(botId, 'minimal');
  assert.equal(configStore.get(botId).thinkingTraces, undefined);
  assert.equal(configStore.get(botId).presentationLevel, 'minimal');
});

// --- runtime: the placeholder becomes the receipt -------------------------

test('L12: a finished standard turn edits the placeholder into its receipt', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 501 }; },
      async editMessageText(payload) { calls.edited.push(payload); return true; },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  assert.equal(stream.supportsProgressSummary, true);
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain', progressSummary: '✅ 完成 · 9 秒 · 2 步' });
  assert.equal(calls.deleted.length, 0, 'the receipt replaces the placeholder');
  assert.equal(calls.edited.at(-1).text, '✅ 完成 · 9 秒 · 2 步');
  assert.equal(calls.sent.at(-1).text, 'answer');
});

test('L13: without a receipt the placeholder is deleted, exactly as before', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 502 }; },
      async editMessageText(payload) { calls.edited.push(payload); return true; },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain' });
  assert.equal(calls.deleted.length, 1);
  assert.equal(calls.edited.length, 0);
});

test('L14: a rejected receipt edit falls back to deleting the placeholder', async () => {
  const calls = { sent: [], edited: [], deleted: [] };
  const client = new TelegramBotClient({
    api: {
      async sendMessage(payload) { calls.sent.push(payload); return { message_id: 503 }; },
      async editMessageText(payload) {
        calls.edited.push(payload);
        throw new Error('message is not modified');
      },
      async deleteMessage(payload) { calls.deleted.push(payload); return true; },
      async sendChatAction() { return true; },
    },
    logger: quietLogger,
  });
  const stream = await client.openDeliveryStream({ chatId: 42 });
  await stream.finish({ kind: 'text', text: 'answer', format: 'plain', progressSummary: '✅ 完成 · 1 秒' });
  assert.equal(calls.deleted.length, 1, 'a stale placeholder must not outlive the turn');
  assert.equal(calls.sent.at(-1).text, 'answer');
});
