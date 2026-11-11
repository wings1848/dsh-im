import assert from 'node:assert/strict';
import test from 'node:test';

import { createDeliveryAdapter } from '../plugin-src/host/delivery-adapter.mjs';

function adapterFor(channel, coreController) {
  return createDeliveryAdapter({
    channel,
    workspaces: {
      listBotIds: () => [],
      listDeliveryTargets: () => [],
      has: () => true,
    },
    coreController,
    stateFor: async () => ({ snapshot: () => ({ sessions: {} }) }),
  });
}

const TELEGRAM_TARGET = { targetId: 'tgt_1', kind: 'chat', route: { chatId: '8000' } };

test('Telegram notification cards go out as native buttons', async () => {
  const calls = [];
  const adapter = adapterFor('telegram', {
    async sendProactiveCard(botId, target, card, options) {
      calls.push({ botId, target, card, options });
      return { providerMessageIds: ['42'] };
    },
    async sendProactiveText() { throw new Error('text path must not run'); },
  });
  const result = await adapter.sendCard('bot_1', TELEGRAM_TARGET, {
    text: 'hi',
    options: [{ label: 'A' }, { label: 'B' }],
    origin: { sessionId: 's-1', label: 'short · name' },
  });
  assert.deepEqual(result, { sent: true });
  assert.equal(calls.length, 1);
  assert.equal(calls[0].card.origin.sessionId, 's-1');
  assert.equal(calls[0].card.options.length, 2);
});

test('a channel without native buttons degrades to numbered text', async () => {
  const texts = [];
  const adapter = adapterFor('slack', {
    async sendProactiveText(botId, target, text, options) {
      texts.push({ target, text, options });
      return { sent: true };
    },
  });
  const result = await adapter.sendCard('bot_1', {
    targetId: 'tgt_1', kind: 'conversation', route: { channelId: 'C0123456789' },
  }, {
    text: '要发布吗？',
    options: [{ label: '发布' }, { label: '等等' }],
    origin: { sessionId: 's-1' },
  });
  assert.deepEqual(result, { sent: true, fallback: 'text' });
  assert.equal(texts.length, 1);
  assert.match(texts[0].text, /要发布吗？\n\n1\. 发布\n2\. 等等/);
  assert.match(texts[0].text, /不支持交互按钮/);
});

test('a card without options is plain text, not a keyboard', async () => {
  const texts = [];
  const adapter = adapterFor('telegram', {
    async sendProactiveText(_botId, _target, text) { texts.push(text); return { sent: true }; },
    async sendProactiveCard() { throw new Error('card path must not run'); },
  });
  const result = await adapter.sendCard('bot_1', TELEGRAM_TARGET, { text: '只有文字' });
  assert.deepEqual(result, { sent: true });
  assert.deepEqual(texts, ['只有文字']);
});

test('a native renderer that refuses buttons reports the text fallback', async () => {
  const texts = [];
  const adapter = adapterFor('telegram', {
    async sendProactiveCard() { return { providerMessageIds: [], fallback: 'text' }; },
    async sendProactiveText(_botId, _target, text) { texts.push(text); return { sent: true }; },
  });
  const result = await adapter.sendCard('bot_1', TELEGRAM_TARGET, {
    text: 'hi', options: [{ label: 'A' }], origin: { sessionId: 's-1' },
  });
  assert.deepEqual(result, { sent: true, fallback: 'text' });
  assert.match(texts[0], /hi\n\n1\. A/);
});

test('a group target never gets buttons, only the text form', async () => {
  const texts = [];
  const adapter = adapterFor('telegram', {
    async sendProactiveCard() { throw new Error('groups must not receive cards'); },
    async sendProactiveText(_botId, _target, text) { texts.push(text); return { sent: true }; },
  });
  const result = await adapter.sendCard('bot_1', {
    targetId: 'tgt_g', kind: 'chat', route: { chatId: '-1001234567890' },
  }, {
    text: '要发布吗？', options: [{ label: '发布' }], origin: { sessionId: 's-1' },
  });
  assert.deepEqual(result, { sent: true, fallback: 'text' });
  assert.match(texts[0], /不支持交互按钮/);
});

test('a card send failure still delivers the notification as text', async () => {
  const texts = [];
  const adapter = adapterFor('telegram', {
    async sendProactiveCard() { throw Object.assign(new Error('telegram down'), { code: 'delivery-failed' }); },
    async sendProactiveText(_botId, _target, text) { texts.push(text); return { sent: true }; },
  });
  const result = await adapter.sendCard('bot_1', TELEGRAM_TARGET, {
    text: '要发布吗？', options: [{ label: '发布' }], origin: { sessionId: 's-1' },
  });
  assert.deepEqual(result, { sent: true, fallback: 'text' });
  assert.match(texts[0], /1\. 发布/);
});
