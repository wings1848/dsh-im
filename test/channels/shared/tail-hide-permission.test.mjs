import assert from 'node:assert/strict';
import { mkdtemp, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';

import { ConversationStateStore } from '../../../src/channels/shared/conversation-state-store.mjs';
import { TextHarnessBridge } from '../../../src/channels/shared/text-harness-bridge.mjs';

function userEvent(seq, text) {
  return { seq, type: 'user/message', surfaceOp: 'append', data: { source: { kind: 'user' }, content: text } };
}

function assistantAppend(seq, turn, text) {
  return { seq, type: 'assistant/message', surfaceOp: 'append', data: { turn, message: { content: text } } };
}

function turnEnd(seq, turn) {
  return { seq, type: 'turn/end', data: { turn, reason: { kind: 'completed' } } };
}

async function fixture() {
  const root = await mkdtemp(join(tmpdir(), 'dsh-im-tail-hide-'));
  const state = await new ConversationStateStore(join(root, 'state.json')).load();
  const key = 'group:chat-1';
  await state.setSession(key, 's1');
  await state.ensureSessionRing(key, 's1', { title: 'topic' });

  const cards = [];
  const deleted = [];
  const notices = [];
  const sent = [];
  const bot = {
    async sendText(_target, text) { sent.push(text); },
    async sendInteractionCard(_target, { text, markup } = {}) {
      cards.push({ text, markup });
      return { providerMessageIds: ['500'] };
    },
    async answerInteractionCallback(_queryId, text) { notices.push(text); },
    async deleteMessage(_target, messageId) { deleted.push(String(messageId)); },
  };

  const harness = {
    workspaceSession(sessionId) {
      return {
        sessionId,
        async sessionExists() { return true; },
        readHistory({ maxMessages, beforeSeq }) {
          const events = [
            userEvent(1, 'what is 2+2'),
            assistantAppend(3, 0, 'four'),
            turnEnd(4, 0),
          ].filter((event) => beforeSeq === undefined || event.seq < beforeSeq);
          return Promise.resolve({
            events: events.slice(-maxMessages).map((event) => ({ event })),
            hasMore: false,
          });
        },
        async renameTitle(title) { return title; },
      };
    },
  };

  const bridge = new TextHarnessBridge({
    descriptor: { key: 'telegram', label: 'Telegram' },
    bot,
    harness,
    state,
    logger: { warn() {}, error() {} },
  });

  return {
    bridge,
    cards,
    deleted,
    notices,
    sent,
    key,
    async close() { await rm(root, { recursive: true, force: true }); },
  };
}

function inbound(senderId, content) {
  return {
    messageId: 'm-1',
    senderId,
    senderIsBot: false,
    kind: 'group',
    conversationId: 'chat-1',
    content,
    addressed: true,
    replyTarget: { chatId: 42 },
  };
}

function press(senderId, data, queryId) {
  return {
    callbackQueryId: queryId,
    senderId,
    senderIsBot: false,
    kind: 'group',
    conversationId: 'chat-1',
    messageId: 'update-1',
    data,
    replyTarget: { chatId: 42 },
  };
}

test('only the reader who ran /tail may hide the preview', async (t) => {
  const f = await fixture();
  t.after(() => f.close());

  await f.bridge.accept(inbound('actor-a', '/tail'));
  assert.equal(f.cards.length, 1, 'a /tail preview is sent as a card with a Hide button');
  assert.match(f.cards[0].text, /what is 2\+2/u);
  const data = f.cards[0].markup.inline_keyboard[0][0].callback_data;
  assert.match(data, /^tailhide\|/u);

  // Another member of the room presses: nothing is deleted, the owner still can.
  await f.bridge.acceptCallback(press('actor-b', data, 'cb-b'));
  assert.deepEqual(f.deleted, []);
  assert.match(f.notices.at(-1), /只有发起 \/tail 的人可以隐藏这条消息。/u);

  await f.bridge.acceptCallback(press('actor-a', data, 'cb-a'));
  assert.deepEqual(f.deleted, ['500']);
  assert.match(f.notices.at(-1), /已隐藏。/u);

  // The token is single use: a replayed press only gets the expired toast.
  await f.bridge.acceptCallback(press('actor-a', data, 'cb-replay'));
  assert.deepEqual(f.deleted, ['500']);
  assert.match(f.notices.at(-1), /已隐藏。/u);
});
