// Proactive notification cards are not tied to a turn: any Session can ask the
// Host to send one, and a press must resolve to the snapshot kept here rather
// than to a pending question. These tests drive a real TextHarnessBridge with a
// fake bot client, the same fixture shape as interaction-card.test.mjs.

import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';
import { createProductionController } from '../../../plugin-src/host/channels/telegram/production.mjs';

function stateFixture() {
  const seen = new Set();
  return {
    hasSeen: (id) => seen.has(id),
    async markSeen(id) { seen.add(id); },
  };
}

const TARGET = { chatId: 42 };
const ORIGIN = Object.freeze({
  sessionId: 'session-abc',
  shortId: 'session-',
  title: '后台任务',
  label: 'session- · 后台任务',
});
const CARD = Object.freeze({
  text: '任务已完成，请选择下一步：',
  options: [{ label: '继续' }, { label: '停止', value: 'stop' }],
  origin: ORIGIN,
});

function bridgeFixture({ cardResult = 'ok', answer = async () => ({ ok: true }), accessPolicy = undefined } = {}) {
  const sent = [];
  const cards = [];
  const notices = [];
  const edits = [];
  const answers = [];
  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram', reactions: {} },
    state: stateFixture(),
    harness: {},
    accessPolicy,
    onProactiveCardAnswer: async (origin, choice) => {
      answers.push({ origin, choice });
      return answer(origin, choice);
    },
    bot: {
      async sendText(target, text) { sent.push({ target, text }); },
      async sendInteractionCard(target, { text, markup }) {
        if (cardResult === 'fail') throw new Error('telegram refused the keyboard');
        cards.push({ target, text, markup });
        return { providerMessageIds: [String(700 + cards.length)] };
      },
      async updateInteractionCard(target, messageId, { markup }) {
        edits.push({ target, messageId, markup });
      },
      async answerInteractionCallback(queryId, text) {
        notices.push({ queryId, text });
      },
    },
  });
  return { bridge, sent, cards, notices, edits, answers };
}

function callback(data, overrides = {}) {
  return {
    messageId: 'update-1',
    callbackQueryId: 'cb-1',
    providerMessageId: 701,
    senderId: 'actor-a',
    senderIsBot: false,
    kind: 'direct',
    conversationId: 'chat-a',
    addressed: true,
    replyTarget: { chatId: 42 },
    data,
    ...overrides,
  };
}

async function press(bridge, data, overrides = {}) {
  await bridge.acceptCallback(callback(data, overrides));
  await new Promise((resolve) => setTimeout(resolve, 0));
}

test('proactive card encodes one n1 button per option under the 64-byte budget', async () => {
  const fixture = bridgeFixture();
  const result = await fixture.bridge.sendProactiveCard(TARGET, CARD);
  assert.deepEqual(result, { providerMessageIds: ['701'] });
  const card = fixture.cards[0];
  assert.equal(card.text, CARD.text);
  assert.deepEqual(card.target, TARGET);
  assert.equal(card.markup.inline_keyboard.length, 2);
  const buttons = card.markup.inline_keyboard.map((row) => row[0]);
  assert.equal(buttons[0].text, '继续');
  assert.equal(buttons[1].text, '停止');
  assert.match(buttons[0].callback_data, /^n1\|[A-Za-z0-9_-]{8,16}\|0$/);
  assert.match(buttons[1].callback_data, /^n1\|[A-Za-z0-9_-]{8,16}\|1$/);
  // Both buttons of one card share the card's nonce.
  assert.equal(buttons[0].callback_data.split('|')[1], buttons[1].callback_data.split('|')[1]);
  for (const button of buttons) {
    assert.ok(
      Buffer.byteLength(button.callback_data, 'utf8') < 64,
      `callback_data exceeds 64 bytes: ${button.callback_data}`,
    );
  }
});

test('a press hands the choice to the host, clears the keyboard and acknowledges in chat', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.sendProactiveCard(TARGET, CARD);
  const data = fixture.cards[0].markup.inline_keyboard[1][0].callback_data;
  await press(fixture.bridge, data);

  assert.equal(fixture.answers.length, 1, 'the host callback ran exactly once');
  assert.equal(fixture.answers[0].origin.sessionId, ORIGIN.sessionId);
  assert.equal(fixture.answers[0].origin.label, ORIGIN.label);
  assert.deepEqual(fixture.answers[0].choice, { label: '停止', value: 'stop' });

  // The keyboard is retired in place with an empty one.
  assert.equal(fixture.edits.length, 1);
  assert.equal(fixture.edits[0].messageId, '701');
  assert.deepEqual(fixture.edits[0].markup, { inline_keyboard: [] });

  // The chat gets the success receipt, addressed to the callback's chat.
  const receipt = fixture.sent.at(-1);
  assert.equal(receipt.text, '✅ 已选择「停止」，已转给会话 session- · 后台任务');
  assert.equal(receipt.target.chatId, 42);
  // The press is acknowledged first, so the client stops its spinner.
  assert.equal(fixture.notices.length, 1);
  assert.equal(fixture.notices[0].queryId, 'cb-1');
});

test('a label without a value is handed back as its own value', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.sendProactiveCard(TARGET, CARD);
  await press(fixture.bridge, fixture.cards[0].markup.inline_keyboard[0][0].callback_data);
  assert.deepEqual(fixture.answers[0].choice, { label: '继续', value: '继续' });
});

test('a group or topic press cannot steer the originating Session', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.sendProactiveCard(TARGET, CARD);
  await press(fixture.bridge, fixture.cards[0].markup.inline_keyboard[0][0].callback_data, {
    kind: 'group',
    conversationId: '42:7',
    replyTarget: { chatId: 42, messageThreadId: 7 },
  });
  assert.equal(fixture.answers.length, 0, 'a group press never reaches the host');
  assert.equal(fixture.notices.at(-1).text, '该通知只在私聊中可操作。');
});

test('a sender without command permission cannot press a notification card', async () => {
  const fixture = bridgeFixture({
    accessPolicy: {
      direct: { mode: 'allowlist', allowlist: { users: [{ id: 'owner' }], permissions: { commands: true } } },
    },
  });
  await fixture.bridge.sendProactiveCard(TARGET, CARD);
  await press(fixture.bridge, fixture.cards[0].markup.inline_keyboard[0][0].callback_data, { senderId: 'stranger' });
  assert.equal(fixture.answers.length, 0, 'an unauthorized sender never reaches the host');
  assert.match(fixture.notices.at(-1).text, /没有执行命令的权限/);
});

test('a failed hand-off is reported as 未转交 instead of throwing', async () => {
  const cases = [
    { answer: async () => ({ ok: false, code: 'session-unreachable' }), receipt: '⚠️ 目标会话已结束，未转交' },
    { answer: async () => ({ ok: false, code: 'not-wired' }), receipt: '通知回传未启用' },
    {
      answer: async () => { throw new Error('target Session is gone'); },
      receipt: '⚠️ 目标会话已结束，未转交',
    },
  ];
  for (const { answer, receipt } of cases) {
    const fixture = bridgeFixture({ answer });
    await fixture.bridge.sendProactiveCard(TARGET, CARD);
    await press(fixture.bridge, fixture.cards[0].markup.inline_keyboard[0][0].callback_data);
    assert.equal(fixture.answers.length, 1);
    assert.equal(fixture.sent.at(-1).text, receipt);
    // The keyboard is still retired even when the hand-off fails.
    assert.deepEqual(fixture.edits[0].markup, { inline_keyboard: [] });
  }
});

test('unknown, malformed and replayed nonces are acknowledged as expired', async () => {
  const fixture = bridgeFixture();
  await fixture.bridge.sendProactiveCard(TARGET, CARD);

  await press(fixture.bridge, 'n1|deadbeef|0');
  assert.equal(fixture.answers.length, 0, 'an unknown nonce never reaches the host');
  assert.equal(fixture.notices.at(-1).text, '⏰ 已过期');

  await press(fixture.bridge, 'n1|broken');
  assert.equal(fixture.answers.length, 0);
  assert.equal(fixture.notices.at(-1).text, '⏰ 已过期');

  const data = fixture.cards[0].markup.inline_keyboard[0][0].callback_data;
  await press(fixture.bridge, data);
  assert.equal(fixture.answers.length, 1);
  await press(fixture.bridge, data);
  assert.equal(fixture.answers.length, 1, 'a consumed nonce cannot deliver twice');
  assert.equal(fixture.notices.at(-1).text, '⏰ 已过期');
  assert.equal(fixture.sent.length, 1, 'only the successful press produced a receipt');
});

test('proactive card validates text, options and origin', async () => {
  const fixture = bridgeFixture();
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, { ...CARD, text: '   ' }),
    /text must be a non-empty string/,
  );
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, { ...CARD, options: [] }),
    /1-8 options/,
  );
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, {
      ...CARD,
      options: Array.from({ length: 9 }, () => ({ label: 'x' })),
    }),
    /1-8 options/,
  );
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, { ...CARD, options: [{ label: '  ' }] }),
    /non-empty label/,
  );
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, { ...CARD, origin: { label: '没有 id' } }),
    /requires a sessionId/,
  );
  assert.equal(fixture.cards.length, 0, 'nothing was sent for an invalid card');
});

test('an overlong label is truncated to the 60-character button budget', async () => {
  const fixture = bridgeFixture();
  const long = '字'.repeat(80);
  await fixture.bridge.sendProactiveCard(TARGET, { ...CARD, options: [{ label: long }] });
  assert.equal(fixture.cards[0].markup.inline_keyboard[0][0].text, '字'.repeat(60));
});

test('a refused keyboard throws and leaves no pressable snapshot behind', async () => {
  const fixture = bridgeFixture({ cardResult: 'fail' });
  await assert.rejects(
    fixture.bridge.sendProactiveCard(TARGET, CARD),
    /refused the keyboard/,
  );
  // The failed send never produced a nonce, so any n1 press is simply expired.
  await press(fixture.bridge, 'n1|deadbeef|0');
  assert.equal(fixture.notices.at(-1).text, '⏰ 已过期');
  assert.equal(fixture.sent.length, 0);
});

test('production wires a card press to the Host delivery service', async (t) => {
  const dataDir = await mkdtemp(join(tmpdir(), 'dsh-telegram-proactive-card-'));
  t.after(() => rm(dataDir, { recursive: true, force: true }));
  const runtimes = [];
  const calls = [];
  let controllerOptions;

  class ConfigStore {
    async load() { return this; }
    list() { return []; }
  }
  class StateStore {
    async load() { return this; }
  }
  class Harness {
    stopManagedProcess() {}
  }
  class Runtime {
    constructor(options) { runtimes.push(options); }
  }
  class Controller {
    constructor(options) { controllerOptions = options; }
    async close() {}
  }
  const supervisor = {
    ready: Promise.resolve(),
    start() { return this; },
    async close() {},
  };

  const production = await createProductionController({
    credentials: {},
    typertGateway: { invoke() {}, stream() {} },
    logger: () => ({ error() {}, warn() {}, info() {}, debug() {} }),
  }, {
    dataDir,
    deliveryService: {
      async answerProactiveCard(origin, choice) {
        calls.push({ origin, choice });
        return { ok: true };
      },
    },
  }, {
    ConfigStore,
    StateStore,
    HarnessClient: Harness,
    Controller,
    Runtime,
    createConnectionSupervisor: () => supervisor,
  });
  await controllerOptions.createRuntime({
    botId: 'telegram_default',
    config: { botId: 'telegram_default' },
    token: 'host-only',
  });

  assert.equal(typeof runtimes[0].onProactiveCardAnswer, 'function');
  const outcome = await runtimes[0].onProactiveCardAnswer(
    { sessionId: 'session-abc', label: 'session- · 后台任务' },
    { label: '继续', value: '继续' },
  );
  assert.deepEqual(outcome, { ok: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].origin.sessionId, 'session-abc');
  assert.deepEqual(calls[0].choice, { label: '继续', value: '继续' });
  await production.close();
});
