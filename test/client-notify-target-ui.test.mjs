import assert from 'node:assert/strict';
import test from 'node:test';

import React from 'react';
import TestRenderer from 'react-test-renderer';

import {
  DELIVERY_ENDPOINTS,
  DeliveryTargetSettingsPage,
  NOTIFY_ENDPOINTS,
} from '../plugin-src/client/delivery-settings.js';
import { en, setImTranslator } from '../plugin-src/client/i18n.js';

const { act, create } = TestRenderer;

function flush() {
  return new Promise((resolve) => setImmediate(resolve));
}

function textOf(node) {
  if (typeof node === 'string' || typeof node === 'number') return String(node);
  if (Array.isArray(node)) return node.map(textOf).join('');
  return textOf(node?.props?.children ?? '');
}

const account = Object.freeze({
  botId: 'bot_feishu_01',
  botName: '通知机器人',
  connected: true,
  accessPolicy: Object.freeze({}),
});

const savedTargets = Object.freeze([
  { targetId: 'daily', name: '日报', kind: 'group', route: { chatId: 'oc_daily' } },
  { targetId: 'oncall', name: '值班', kind: 'user', route: { openId: 'ou_oncall' } },
]);

async function mount(t, { targets = savedTargets, notifyRpcCall, connected = true } = {}) {
  const deliveryCalls = [];
  let renderer;
  await act(async () => {
    renderer = create(React.createElement(DeliveryTargetSettingsPage, {
      channel: 'feishu',
      account: { ...account, connected },
      rpcCall: async (endpoint, payload) => {
        deliveryCalls.push({ endpoint, payload });
        if (endpoint === DELIVERY_ENDPOINTS.list) {
          return { ok: true, value: { targets: structuredClone(targets) } };
        }
        throw new Error(`unexpected delivery endpoint ${endpoint}`);
      },
      accessRpcCall: async () => ({ ok: true, value: { bots: [account] } }),
      ...(notifyRpcCall ? { notifyRpcCall } : {}),
      onBack() {},
    }));
    await flush();
  });
  await act(async () => {
    renderer.root.findByProps({ id: 'dim-bot-settings-delivery-tab' }).props.onClick();
    await flush();
  });
  t.after(async () => {
    await act(async () => {
      renderer.unmount();
      await flush();
    });
  });
  return { renderer, deliveryCalls };
}

function controlOf(renderer, targetId) {
  return renderer.root.findByProps({ 'data-target-id': targetId })
    .findByProps({ 'aria-label': '默认通知目标' });
}

test('the saved default notification target is selected and toggles through set RPC', async (t) => {
  const notifyCalls = [];
  const { renderer } = await mount(t, {
    notifyRpcCall: async (endpoint, payload) => {
      notifyCalls.push({ endpoint, payload });
      if (endpoint === NOTIFY_ENDPOINTS.get) {
        return { ok: true, value: { defaultTarget: { botId: account.botId, targetId: 'daily' } } };
      }
      return { ok: true, value: { defaultTarget: payload.defaultTarget } };
    },
  });
  assert.deepEqual(notifyCalls[0], { endpoint: NOTIFY_ENDPOINTS.get, payload: {} });
  assert.equal(controlOf(renderer, 'daily').props['aria-pressed'], true);
  assert.match(textOf(controlOf(renderer, 'daily')), /默认通知/);
  assert.equal(controlOf(renderer, 'oncall').props['aria-pressed'], false);

  await act(async () => {
    controlOf(renderer, 'oncall').props.onClick();
    await flush();
    await flush();
  });
  assert.deepEqual(notifyCalls.at(-1), {
    endpoint: NOTIFY_ENDPOINTS.set,
    payload: { defaultTarget: { botId: account.botId, targetId: 'oncall' } },
  });
  assert.equal(controlOf(renderer, 'oncall').props['aria-pressed'], true);
  assert.equal(controlOf(renderer, 'daily').props['aria-pressed'], false);
  assert.match(textOf(renderer.root.findByProps({ 'data-target-id': 'oncall' })), /已设为默认通知目标/);

  await act(async () => {
    controlOf(renderer, 'oncall').props.onClick();
    await flush();
    await flush();
  });
  assert.deepEqual(notifyCalls.at(-1), {
    endpoint: NOTIFY_ENDPOINTS.set,
    payload: { defaultTarget: null },
  });
  assert.equal(controlOf(renderer, 'oncall').props['aria-pressed'], false);
  assert.match(textOf(renderer.root.findByProps({ 'data-target-id': 'oncall' })), /已取消默认通知目标/);
});

test('without the notify channel the control is absent and delivery RPC keeps its calls', async (t) => {
  const { renderer, deliveryCalls } = await mount(t);
  assert.equal(renderer.root.findAllByProps({ 'aria-label': '默认通知目标' }).length, 0);
  assert.deepEqual(deliveryCalls, [{
    endpoint: DELIVERY_ENDPOINTS.list,
    payload: { botId: account.botId },
  }]);
});

test('a failing notify channel hides the control while the page stays usable', async (t) => {
  const { renderer } = await mount(t, {
    notifyRpcCall: async () => { throw new Error('channel missing'); },
  });
  assert.equal(renderer.root.findAllByProps({ 'aria-label': '默认通知目标' }).length, 0);
  assert.ok(renderer.root.findByProps({ 'data-target-id': 'daily' }));
  assert.equal(renderer.root.findByProps({ 'data-target-id': 'daily' })
    .findByProps({ 'aria-label': '测试投递目标' }).props.disabled, false);
});

test('an offline bot disables the control like the test button', async (t) => {
  const { renderer } = await mount(t, {
    connected: false,
    notifyRpcCall: async () => ({ ok: true, value: { defaultTarget: null } }),
  });
  const control = controlOf(renderer, 'daily');
  assert.equal(control.props.disabled, true);
  assert.equal(
    renderer.root.findByProps({ 'data-target-id': 'daily' })
      .findByProps({ 'aria-label': '测试投递目标' }).props.disabled,
    true,
  );
});

test('a failed set keeps the previous selection and shows a row-local error', async (t) => {
  const { renderer } = await mount(t, {
    notifyRpcCall: async (endpoint, payload) => {
      if (endpoint === NOTIFY_ENDPOINTS.get) {
        return { ok: true, value: { defaultTarget: { botId: account.botId, targetId: 'daily' } } };
      }
      return { ok: false, error: { message: '无法读取或保存默认通知目标，请稍后重试。' } };
    },
  });
  await act(async () => {
    controlOf(renderer, 'oncall').props.onClick();
    await flush();
    await flush();
  });
  assert.equal(controlOf(renderer, 'daily').props['aria-pressed'], true);
  assert.equal(controlOf(renderer, 'oncall').props['aria-pressed'], false);
  assert.match(
    textOf(renderer.root.findByProps({ 'data-target-id': 'oncall' })),
    /无法读取或保存默认通知目标/,
  );
});

test('the English UI renders the control in English', async (t) => {
  setImTranslator((key) => en[key] ?? key);
  t.after(() => setImTranslator(null));
  const { renderer } = await mount(t, {
    notifyRpcCall: async () => ({
      ok: true,
      value: { defaultTarget: { botId: account.botId, targetId: 'daily' } },
    }),
  });
  const control = renderer.root.findByProps({ 'data-target-id': 'daily' })
    .findByProps({ 'aria-label': 'Default notification target' });
  assert.match(textOf(control), /Default/);
  assert.match(textOf(renderer.root.findByProps({ className: 'dim-deliverySectionHeading' })),
    /dsh_im_notify/);
});
