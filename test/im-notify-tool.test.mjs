import assert from 'node:assert/strict';
import test from 'node:test';

import {
  IM_NOTIFY_TOOL,
  composeNotifyText,
  createImNotifyTool,
  resolveNotifyTarget,
  sessionDisplayTitle,
  sessionIdentity,
} from '../plugin-src/host/im-notify-tool.mjs';
import { NotifyTargetStore, createNotifyTargetRpcHandler } from '../plugin-src/host/notify-settings.mjs';
import { DeliveryService } from '../plugin-src/host/delivery-service.mjs';

const SESSION_ID = '9f3a2c1d-1111-4222-8333-944455556666';

function sessionWith(title) {
  return {
    id: SESSION_ID,
    header: { id: SESSION_ID, cwd: '/home/u/code/demo' },
    snapshotEvents: () => (title === undefined ? [] : [{
      type: 'session/title',
      data: { title, messageSeqs: [] },
    }]),
  };
}

function fakeService({ bots = [{ botId: 'bot_1', channel: 'telegram' }], targets = {} } = {}) {
  const sent = [];
  const cards = [];
  return {
    sent,
    cards,
    listBots: async () => bots,
    listTargets: async (botId) => targets[botId] ?? [],
    send: async (botId, targetId, text) => {
      sent.push({ botId, targetId, text });
      return { sent: true };
    },
    sendCard: async (botId, targetId, card) => {
      cards.push({ botId, targetId, card });
      return { sent: true };
    },
  };
}

test('session identity carries a short id and the latest Session title', () => {
  const identity = sessionIdentity(sessionWith('Telegram · 方案评审'));
  assert.equal(identity.shortId, '9f3a2c1d');
  assert.equal(identity.title, '方案评审');
  assert.equal(identity.label, '9f3a2c1d · 方案评审');
});

test('a Host session id is shortened past its session- prefix', () => {
  const identity = sessionIdentity({
    header: { id: 'session-076b7cb2-9692-49f1-b74b-42228864659b', cwd: '/home/u/code/demo' },
    snapshotEvents: () => [{ type: 'session/title', data: { title: 'E2E', messageSeqs: [] } }],
  });
  assert.equal(identity.shortId, '076b7cb2');
  assert.equal(identity.label, '076b7cb2 · E2E');
});

test('a session without a title falls back to its workspace name, never empty', () => {
  assert.equal(sessionDisplayTitle(sessionWith()), 'demo');
  const bare = { header: { id: SESSION_ID } };
  assert.equal(sessionDisplayTitle(bare), '未命名会话');
  assert.equal(sessionIdentity(bare).label, '9f3a2c1d · 未命名会话');
});

test('a long generated title is capped so the IM label stays scannable', () => {
  const identity = sessionIdentity(sessionWith('T'.repeat(80)));
  assert.equal(identity.title.length, 40);
});

test('notification text starts with the tagged Session header', () => {
  const identity = sessionIdentity(sessionWith('方案评审'));
  const text = composeNotifyText(identity, '构建完成。', '发布检查');
  assert.match(text, /^🪪 9f3a2c1d · 方案评审\n📌 发布检查\n\n构建完成。$/);
});

test('explicit targetId wins over the saved default', async () => {
  const service = fakeService({ targets: {
    bot_1: [
      { targetId: 'tgt_a', name: '聊天 A', kind: 'chat' },
      { targetId: 'tgt_b', name: '聊天 B', kind: 'chat' },
    ],
  } });
  const store = { get: async () => ({ botId: 'bot_1', targetId: 'tgt_a' }) };
  const target = await resolveNotifyTarget(service, store, { targetId: 'tgt_b' });
  assert.equal(target.targetId, 'tgt_b');
});

test('the saved default is used when no target is passed', async () => {
  const service = fakeService({ targets: {
    bot_1: [
      { targetId: 'tgt_a', kind: 'chat' },
      { targetId: 'tgt_b', kind: 'chat' },
    ],
  } });
  const store = { get: async () => ({ botId: 'bot_1', targetId: 'tgt_b' }) };
  assert.equal((await resolveNotifyTarget(service, store)).targetId, 'tgt_b');
});

test('a single saved target needs no configuration', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_only', kind: 'chat' }] } });
  assert.equal((await resolveNotifyTarget(service, { get: async () => null })).targetId, 'tgt_only');
});

test('ambiguity is reported with candidates instead of guessing', async () => {
  const service = fakeService({ targets: {
    bot_1: [{ targetId: 'tgt_a', kind: 'chat' }, { targetId: 'tgt_b', kind: 'group' }],
  } });
  await assert.rejects(
    resolveNotifyTarget(service, { get: async () => null }),
    (error) => error.code === 'no-default-target' && /tgt_a/.test(error.message) && /tgt_b/.test(error.message),
  );
});

test('a stale saved default is reported instead of silently retargeting', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_new', kind: 'chat' }] } });
  await assert.rejects(
    resolveNotifyTarget(service, { get: async () => ({ botId: 'bot_1', targetId: 'tgt_deleted' }) }),
    (error) => error.code === 'stale-default-target' && /tgt_deleted/.test(error.message),
  );
});

test('the same target id under two bots stays ambiguous without a default', async () => {
  const service = fakeService({
    bots: [{ botId: 'bot_1', channel: 'telegram' }, { botId: 'bot_2', channel: 'telegram' }],
    targets: { bot_1: [{ targetId: 'tgt_dup', kind: 'chat' }], bot_2: [{ targetId: 'tgt_dup', kind: 'chat' }] },
  });
  await assert.rejects(
    resolveNotifyTarget(service, { get: async () => null }, { targetId: 'tgt_dup' }),
    (error) => error.code === 'ambiguous-target',
  );
  assert.equal(
    (await resolveNotifyTarget(service, { get: async () => ({ botId: 'bot_2', targetId: 'tgt_dup' }) },
      { targetId: 'tgt_dup' })).botId,
    'bot_2',
  );
});

test('no targets at all is an actionable error, not a silent drop', async () => {
  const service = fakeService({ bots: [], targets: {} });
  await assert.rejects(
    resolveNotifyTarget(service, { get: async () => null }),
    (error) => error.code === 'no-target',
  );
});

test('the tool sends text with the Session tag to the resolved target', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_only', kind: 'chat' }] } });
  const tool = createImNotifyTool({ deliveryService: service, store: { get: async () => null } });
  const value = await tool.execute({ text: '任务已完成。' }, {
    agent: { session: sessionWith('后台构建') },
  });
  assert.equal(value.sent, true);
  assert.equal(value.targetId, 'tgt_only');
  assert.deepEqual(value.session, { shortId: '9f3a2c1d', title: '后台构建' });
  assert.equal(service.sent.length, 1);
  assert.equal(service.sent[0].text, '🪪 9f3a2c1d · 后台构建\n\n任务已完成。');
  assert.equal(tool.name, IM_NOTIFY_TOOL);
});

test('options go through the card path with the originating Session attached', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_only', kind: 'chat' }] } });
  const tool = createImNotifyTool({ deliveryService: service, store: { get: async () => null } });
  const value = await tool.execute({
    text: '要现在发布吗？',
    options: [{ label: '发布' }, { label: '等等', value: 'wait' }],
  }, { agent: { session: sessionWith('发布检查') } });
  assert.equal(service.cards.length, 1);
  const card = service.cards[0].card;
  assert.equal(card.origin.sessionId, SESSION_ID);
  assert.equal(card.origin.label, '9f3a2c1d · 发布检查');
  assert.equal(card.options.length, 2);
  assert.equal(card.options[1].value, 'wait');
  assert.equal(value.sent, true);
});

test('a text-only channel reports the fallback instead of pretending buttons exist', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_only', kind: 'chat' }] } });
  service.sendCard = async () => ({ sent: true, fallback: 'text' });
  const tool = createImNotifyTool({ deliveryService: service, store: { get: async () => null } });
  const value = await tool.execute({ text: '选一个', options: [{ label: 'A' }] },
    { agent: { session: sessionWith('降级') } });
  assert.equal(value.fallback, 'text');
});

test('invalid input is rejected before any delivery attempt', async () => {
  const service = fakeService({ targets: { bot_1: [{ targetId: 'tgt_only', kind: 'chat' }] } });
  const tool = createImNotifyTool({ deliveryService: service, store: { get: async () => null } });
  const ctx = { agent: { session: sessionWith('校验') } };
  await assert.rejects(tool.execute({ text: '   ' }, ctx), (error) => error.code === 'bad-request');
  await assert.rejects(tool.execute({ text: 'x', options: Array.from({ length: 9 }, () => ({ label: 'a' })) }, ctx),
    (error) => error.code === 'bad-request');
  await assert.rejects(tool.execute({ text: 'x', options: [{ label: 'a'.repeat(33) }] }, ctx),
    (error) => error.code === 'bad-request');
  assert.equal(service.sent.length, 0);
  assert.equal(service.cards.length, 0);
});

test('the default target file round-trips and rejects malformed values', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-notify-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new NotifyTargetStore(join(dir, 'notify-target.json'));
  assert.equal(await store.get(), null);
  await store.set({ botId: 'bot_1', targetId: 'tgt_1' });
  assert.deepEqual(await store.get(), { botId: 'bot_1', targetId: 'tgt_1' });
  await store.set(null);
  assert.equal(await store.get(), null);
  await assert.rejects(store.set({ botId: 'bad id!', targetId: 'tgt_1' }), TypeError);
});

function deliveryAdapter(overrides = {}) {
  return {
    channel: 'telegram',
    ownsBot: (botId) => botId === 'bot_1',
    listBots: () => ['bot_1'],
    listTargets: async () => [{ targetId: 'tgt_1', kind: 'chat', route: { chatId: '8000' } }],
    listSuggestions: async () => [],
    createTarget: async (_botId, target) => target,
    updateTarget: async (_botId, _targetId, target) => target,
    deleteTarget: async () => true,
    sendText: async () => ({ sent: true }),
    sendCard: async () => ({ sent: true }),
    ...overrides,
  };
}

test('DeliveryService.sendCard forwards the card and its origin to the channel adapter', async () => {
  const service = new DeliveryService();
  const calls = [];
  service.registerAdapter(deliveryAdapter({
    sendCard: async (botId, target, card) => {
      calls.push({ botId, target, card });
      return { sent: true };
    },
  }));
  const result = await service.sendCard('bot_1', 'tgt_1', {
    text: 'hi', options: [{ label: 'A' }], origin: { sessionId: SESSION_ID, label: 'short · name' },
  });
  assert.equal(result.sent, true);
  assert.equal(calls.length, 1);
  assert.equal(calls[0].card.origin.sessionId, SESSION_ID);
});

test('DeliveryService.sendCard reports a text fallback from the adapter', async () => {
  const service = new DeliveryService();
  service.registerAdapter(deliveryAdapter({ sendCard: async () => ({ sent: true, fallback: 'text' }) }));
  assert.deepEqual(
    await service.sendCard('bot_1', 'tgt_1', { text: 'hi', options: [{ label: 'A' }] }),
    { sent: true, fallback: 'text' },
  );
});

test('DeliveryService.sendCard rejects an unknown target', async () => {
  const service = new DeliveryService();
  service.registerAdapter(deliveryAdapter());
  await assert.rejects(
    service.sendCard('bot_1', 'missing', { text: 'hi', options: [{ label: 'A' }] }),
    (error) => error.code === 'unknown-target',
  );
});

test('card answers reach the registered Session handler', async () => {
  const service = new DeliveryService();
  const seen = [];
  service.setProactiveAnswerHandler(async (origin, choice) => { seen.push({ origin, choice }); });
  const result = await service.answerProactiveCard(
    { sessionId: SESSION_ID, label: '9f3a2c1d · 名称' },
    { label: '发布', value: 'ship' },
  );
  assert.deepEqual(result, { ok: true });
  assert.equal(seen[0].choice.value, 'ship');
});

test('a handler failure becomes a receipt, never a thrown channel error', async () => {
  const service = new DeliveryService();
  service.setProactiveAnswerHandler(async () => { throw new Error('session-gone'); });
  const result = await service.answerProactiveCard({ sessionId: SESSION_ID, label: 'x' }, { label: 'A' });
  assert.deepEqual(result, { ok: false, code: 'session-unreachable' });
});

test('without a handler the receipt says answers are not wired', async () => {
  const service = new DeliveryService();
  const result = await service.answerProactiveCard({ sessionId: SESSION_ID, label: 'x' }, { label: 'A' });
  assert.deepEqual(result, { ok: false, code: 'not-wired' });
});

test('the notify-target RPC handler validates payloads and round-trips the default', async (t) => {
  const { mkdtemp, rm } = await import('node:fs/promises');
  const { tmpdir } = await import('node:os');
  const { join } = await import('node:path');
  const dir = await mkdtemp(join(tmpdir(), 'dsh-im-notify-rpc-'));
  t.after(() => rm(dir, { recursive: true, force: true }));
  const store = new NotifyTargetStore(join(dir, 'notify-target.json'));
  const handle = createNotifyTargetRpcHandler({ store });

  assert.deepEqual(await handle('settings.notify-target.get', {}), { ok: true, value: { defaultTarget: null } });
  assert.deepEqual(
    await handle('settings.notify-target.set', { defaultTarget: { botId: 'bot_1', targetId: 'tgt_1' } }),
    { ok: true, value: { defaultTarget: { botId: 'bot_1', targetId: 'tgt_1' } } },
  );
  assert.deepEqual(
    await handle('settings.notify-target.set', { defaultTarget: null }),
    { ok: true, value: { defaultTarget: null } },
  );
  assert.equal((await handle('settings.notify-target.set', { defaultTarget: { botId: 'bad id' } })).error.code, 'bad-request');
  assert.equal((await handle('settings.notify-target.get', { extra: 1 })).error.code, 'bad-request');
  assert.equal((await handle('settings.unknown', {})).error.code, 'bad-request');

  const controller = new AbortController();
  controller.abort();
  assert.equal((await handle('settings.notify-target.get', {}, controller.signal)).error.code, 'cancelled');
});
