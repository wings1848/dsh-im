import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { Context } from '@deepseek-ai/cordis';

import { createImHostPlugin } from '../plugin-src/host/index.mjs';
import { createDeliveryService } from '../plugin-src/host/delivery-service.mjs';

const SESSION_ID = '9f3a2c1d-aaaa-4bbb-8ccc-dddddddddddd';
const CHANNELS = [
  ['dingtalk', 'applyDingtalk'], ['discord', 'applyDiscord'], ['office', 'applyOffice'],
  ['feishu', 'applyFeishu'], ['qq', 'applyQq'], ['slack', 'applySlack'],
  ['telegram', 'applyTelegram'], ['wecom', 'applyWecom'], ['wecomApp', 'applyWecomApp'],
  ['weixin', 'applyWeixin'], ['whatsapp', 'applyWhatsapp'], ['imessage', 'applyIMessage'],
  ['email', 'applyEmail'], ['matrix', 'applyMatrix'],
];

function fakeSession(title = '集成测试会话') {
  return {
    id: SESSION_ID,
    header: { id: SESSION_ID, cwd: '/home/u/code/it' },
    snapshotEvents: () => (title === null ? [] : [{
      type: 'session/title', data: { title, messageSeqs: [], source: { kind: 'fallback' } },
    }]),
  };
}

async function startHost(t, { rejectPrompts = false } = {}) {
  const tools = [];
  const prompts = [];
  const ctx = new Context();
  ctx.provide('connection', { fetch: { register: () => () => {} } });
  ctx.provide('credentials', {});
  ctx.provide('typertGateway', {
    async invoke(request) {
      prompts.push(request);
      // The real gateway rejects; the compatibility layer turns that rejection
      // into `{ result: { ok: false } }` instead of throwing.
      if (rejectPrompts) throw new Error('Session is gone');
      return {};
    },
    async stream() { throw new Error('stream is not used in this test'); },
  });
  ctx.provide('sessionController', {});
  ctx.provide('workspaceController', {});
  ctx.provide('sessions', { get: () => undefined, list: () => [] });
  ctx.provide('webServer', { register: () => () => {} });
  ctx.provide('tools', { register: (definition) => { tools.push(definition); return () => {}; } });
  ctx.provide('systemPrompt', { context: () => () => {} });

  const dshHome = await mkdtemp(join(tmpdir(), 'dsh-im-host-'));
  t.after(() => rm(dshHome, { recursive: true, force: true }));

  let service = null;
  const internals = Object.fromEntries(CHANNELS.map(([, applyName]) => [applyName, async () => {}]));
  Object.assign(internals, {
    createDeliveryService: (options) => {
      service = createDeliveryService(options);
      return service;
    },
    installDeliveryRpc: () => {},
    installDeliverySyncRpc: () => {},
    installDeliveryHttp: () => {},
    installUpdateRpc: () => {},
    installInboundTtlRpc: () => {},
    installSidebarSettingsRpc: () => {},
    installHostLanguage: () => undefined,
    installSessionSyncCoordinator: () => {},
  });
  const host = ctx.plugin(createImHostPlugin(internals));
  t.after(() => host.dispose());
  await host.await();
  await host.await();
  return { ctx, tools, prompts, service, dshHome };
}

function fakeTelegramAdapter({ cards, onCard } = {}) {
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
    sendCard: async (_botId, _target, card) => {
      cards?.push(card);
      onCard?.(card);
      return { sent: true };
    },
  };
}

test('the Host registers dsh_im_notify and delivers through the shared adapter', async (t) => {
  const { tools, service } = await startHost(t);
  const notify = tools.find((tool) => tool.name === 'dsh_im_notify');
  assert.ok(notify, 'dsh_im_notify must be registered on the Host');
  assert.equal(typeof notify.execute, 'function');

  const cards = [];
  service.registerAdapter(fakeTelegramAdapter({ cards }));

  const value = await notify.execute({
    text: '构建完成，要现在发布吗？',
    title: '发布检查',
    options: [{ label: '发布' }, { label: '等等' }],
  }, { agent: { session: fakeSession() } });

  assert.equal(value.sent, true);
  assert.equal(value.targetId, 'tgt_1');
  assert.deepEqual(value.session, { shortId: '9f3a2c1d', title: '集成测试会话' });
  assert.equal(cards.length, 1);
  assert.equal(cards[0].origin.sessionId, SESSION_ID);
  assert.equal(cards[0].origin.label, '9f3a2c1d · 集成测试会话');
  assert.match(cards[0].text, /^🪪 9f3a2c1d · 集成测试会话\n📌 发布检查\n\n构建完成/);
});

test('a card choice is injected into the originating Session through session.prompt', async (t) => {
  const { tools, prompts, service } = await startHost(t);
  const notify = tools.find((tool) => tool.name === 'dsh_im_notify');
  let card = null;
  service.registerAdapter(fakeTelegramAdapter({ onCard: (value) => { card = value; } }));

  await notify.execute({
    text: '选一个',
    options: [{ label: '发布', value: 'ship' }, { label: '暂停', value: 'hold' }],
  }, { agent: { session: fakeSession() } });

  const result = await service.answerProactiveCard(card.origin, { label: '发布', value: 'ship' });
  assert.deepEqual(result, { ok: true });
  assert.equal(prompts.length, 1);
  const payload = JSON.stringify(prompts[0]);
  assert.match(payload, /"namespace":"session"/);
  assert.match(payload, /"method":"prompt"/);
  assert.match(payload, new RegExp(SESSION_ID));
  assert.match(payload, /已选择：发布/);
  assert.match(payload, /9f3a2c1d · 集成测试会话/);
  assert.match(payload, /ship/, 'the option value reaches the Session, not only its label');
});

test('a rejected prompt is reported as a failure, never a false success', async (t) => {
  const { tools, service } = await startHost(t, { rejectPrompts: true });
  const notify = tools.find((tool) => tool.name === 'dsh_im_notify');
  let card = null;
  service.registerAdapter(fakeTelegramAdapter({ onCard: (value) => { card = value; } }));
  await notify.execute({ text: '选一个', options: [{ label: '发布' }] },
    { agent: { session: fakeSession() } });

  const result = await service.answerProactiveCard(card.origin, { label: '发布' });
  assert.deepEqual(result, { ok: false, code: 'session-unreachable' });
});

test('without options the tool uses the plain text delivery path', async (t) => {
  const { tools, service } = await startHost(t);
  const notify = tools.find((tool) => tool.name === 'dsh_im_notify');
  const texts = [];
  service.registerAdapter({
    ...fakeTelegramAdapter(),
    sendText: async (_botId, _target, text) => { texts.push(text); return { sent: true }; },
  });
  const value = await notify.execute({ text: '背景任务成功。' },
    { agent: { session: fakeSession(null) } });
  assert.equal(value.sent, true);
  assert.equal(texts.length, 1);
  assert.match(texts[0], /^🪪 9f3a2c1d · it\n\n背景任务成功。$/);
});
