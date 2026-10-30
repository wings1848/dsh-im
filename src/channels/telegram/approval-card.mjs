import { t } from '../shared/i18n.mjs';
import {
  ACTION_CARD_STATUS,
  ActionCardRegistry,
  actionCardStateText,
  createCallbackNamespace,
} from '../shared/action-card.mjs';
import { harnessApprovalText } from '../shared/harness-approval.mjs';

/**
 * Telegram approval buttons on top of the shared HarnessApprovalQueue `render`
 * hook and the shared action-card foundation.
 *
 * A press is handled in this order, which is the whole safety story:
 *   1. answerCallbackQuery first (the spinner stops even when the press loses);
 *   2. actor check (only the user who started the turn can decide; a stranger
 *      gets a toast and does not consume the owner's press);
 *   3. a synchronous first-press claim (duplicate/concurrent taps submit once);
 *   4. submit through the shared queue, then edit the original message into a
 *      terminal receipt and clear its keyboard. `message is not modified` is
 *      success (the client already shows the receipt).
 *
 * The plain-text "请精准回复「批准」或「拒绝」" path is never replaced by the
 * card: a channel without keyboard support or a refused card send falls back to
 * the exact text the bridge sent before this feature.
 */

/** Versioned namespace so a stale `a1|`/future `ap2|` payload can never be replayed. */
export const TELEGRAM_APPROVAL_NAMESPACE_PREFIX = 'ap1';
export const TELEGRAM_APPROVAL_ACTIONS = Object.freeze({ approve: 'a', reject: 'd' });
export const TELEGRAM_APPROVAL_CALLBACK = createCallbackNamespace(
  TELEGRAM_APPROVAL_NAMESPACE_PREFIX,
);

const OUTCOME_BY_DECISION = Object.freeze({
  approve: 'allowed-once',
  reject: 'rejected',
});
const ACTION_BY_DECISION = Object.freeze({
  approve: TELEGRAM_APPROVAL_ACTIONS.approve,
  reject: TELEGRAM_APPROVAL_ACTIONS.reject,
});
/** Callback action that opens the full (unfolded) argument text. */
const DETAILS_ACTION = 'v';
const DECISION_BY_ACTION = Object.freeze({
  [TELEGRAM_APPROVAL_ACTIONS.approve]: 'approve',
  [TELEGRAM_APPROVAL_ACTIONS.reject]: 'reject',
});
const BUTTON_TEXT = Object.freeze({
  approve: '✅ 批准一次',
  reject: '❌ 拒绝',
  details: '📄 查看完整参数',
});
/** The card body keeps the tool/argument summary; the buttons replace the prompt. */
const TERMINAL_LABEL = Object.freeze({
  'allowed-once': '✅ 已批准（仅本次）',
  rejected: '❌ 已拒绝',
  expired: '⏰ 已过期',
  unavailable: '⛔ 已失效',
});
/** Telegram rejects a single message body over this many characters. */
export const TELEGRAM_APPROVAL_CARD_MAX_CHARS = 4_096;

/**
 * Above this many characters of tool arguments the card shows a folded summary
 * plus a 「查看完整参数」 button, instead of either a wall of text or (worse)
 * handing the body to a path that silently drops it.
 *
 * The fold is presentation only: approving never happens on a body the user
 * cannot reach, because the button opens the exact same text in full.
 */
export const TELEGRAM_APPROVAL_FOLD_ARGUMENTS_CHARS = 900;
/** Lines kept when folding; enough to recognize the operation at a glance. */
export const TELEGRAM_APPROVAL_FOLD_LINES = 12;
const FOLD_NOTICE = '参数较长，已折叠；点「📄 查看完整参数」看全文后再决定。';

/**
 * Fold the argument block of an approval body, keeping the header and reason.
 *
 * Returns `{ text, folded, fullText }`:
 *   - `text` is what the card shows (with a notice saying it was folded);
 *   - `fullText` is the untouched body, which the button delivers verbatim.
 */
export function foldApprovalCardText(text) {
  const value = typeof text === 'string' ? text : '';
  if (value.length <= TELEGRAM_APPROVAL_FOLD_ARGUMENTS_CHARS) {
    return { text: value, folded: false, fullText: value };
  }
  const lines = value.split('\n');
  // Find the argument block: it starts right after the 操作参数 line and runs
  // until the optional 原因 line or the end. Other channels print the same
  // structure, so this anchors on the localized marker only.
  const marker = t('操作参数：');
  const start = lines.indexOf(marker);
  if (start === -1 || lines.length <= TELEGRAM_APPROVAL_FOLD_LINES) {
    // Nothing safely recognizable to fold: keep it whole and let the caller's
    // size check decide (it either fits or falls back to the text path).
    return { text: value, folded: false, fullText: value };
  }
  let end = lines.length;
  for (let index = start + 1; index < lines.length; index += 1) {
    if (lines[index].startsWith(t('原因：'))) {
      end = index;
      break;
    }
  }
  const body = lines.slice(start + 1, end);
  if (body.length <= TELEGRAM_APPROVAL_FOLD_LINES) {
    return { text: value, folded: false, fullText: value };
  }
  const kept = body.slice(0, TELEGRAM_APPROVAL_FOLD_LINES);
  const hidden = body.length - kept.length;
  const folded = [
    ...lines.slice(0, start + 1),
    ...kept,
    t('…（其余 {count} 行已折叠）', { count: hidden }),
    ...lines.slice(end),
    '',
    t(FOLD_NOTICE),
  ].join('\n');
  return { text: folded, folded: true, fullText: value };
}
const EMPTY_KEYBOARD = Object.freeze({ inline_keyboard: [] });
const TERMINAL_STATUS_BY_OUTCOME = Object.freeze({
  'allowed-once': ACTION_CARD_STATUS.RESOLVED,
  rejected: ACTION_CARD_STATUS.RESOLVED,
  expired: ACTION_CARD_STATUS.EXPIRED,
  unavailable: ACTION_CARD_STATUS.REVOKED,
});
const DEFAULT_STATE_TEXT_OVERRIDES = Object.freeze({
  [ACTION_CARD_STATUS.CLAIMED]: '正在提交审批决定，请稍候。',
  [ACTION_CARD_STATUS.RESOLVED]: '该审批已处理，无需重复操作。',
  [ACTION_CARD_STATUS.EXPIRED]: '该审批已过期，已自动拒绝。',
  [ACTION_CARD_STATUS.SUPERSEDED]: '该审批已被新提示取代，请使用最新一条。',
  [ACTION_CARD_STATUS.STALE]: '该审批已失效，请等待新的审批提示。',
  [ACTION_CARD_STATUS.REVOKED]: '该审批已失效，请等待新的审批提示。',
  [ACTION_CARD_STATUS.UNKNOWN]: '该审批已处理或不存在，无需重复操作。',
});
const APPROVAL_CARD_NOTICES = Object.freeze({
  ownerOnly: '只有发起当前任务的用户可以处理这条审批。',
});

/** Encode one approval button payload (`ap1|<nonce>|<a|d>`). */
export function telegramApprovalCallbackData(nonce, decision) {
  const action = ACTION_BY_DECISION[decision];
  if (!action) throw new TypeError('An approval decision must be approve or reject');
  return TELEGRAM_APPROVAL_CALLBACK.encode({ nonce, action });
}

/** Parse one of our button payloads; null for anything else (question cards, etc.). */
export function parseTelegramApprovalCallback(data) {
  const parsed = TELEGRAM_APPROVAL_CALLBACK.parse(data);
  if (!parsed) return null;
  // `v` opens the unfolded arguments; it is not a decision and must never be
  // mistaken for one.
  if (parsed.action === DETAILS_ACTION) {
    return { nonce: parsed.nonce, action: 'details' };
  }
  const decision = DECISION_BY_ACTION[parsed.action];
  if (!decision) return null;
  return { nonce: parsed.nonce, action: decision };
}

/** The two-button keyboard for one presentation. */
export function telegramApprovalMarkup(nonce, { folded = false } = {}) {
  const rows = [];
  // The details row comes first: read the whole thing, then decide.
  if (folded) {
    rows.push([{
      text: t(BUTTON_TEXT.details),
      callback_data: TELEGRAM_APPROVAL_CALLBACK.encode({ nonce, action: 'v' }),
    }]);
  }
  rows.push([
    {
      text: t(BUTTON_TEXT.approve),
      callback_data: telegramApprovalCallbackData(nonce, 'approve'),
    },
    {
      text: t(BUTTON_TEXT.reject),
      callback_data: telegramApprovalCallbackData(nonce, 'reject'),
    },
  ]);
  return { inline_keyboard: rows };
}

/**
 * The card body: today's approval text (tool + arguments + reason) without the
 * "type 批准/拒绝" prompt, which a button makes obsolete. The plain-text path
 * still uses the unmodified `harnessApprovalText` output.
 */
export function telegramApprovalCardText(pending) {
  const text = harnessApprovalText(pending?.interaction?.payload, {
    toolCall: pending?.toolCall,
    requiresMention: pending?.requiresMention === true,
    hasButtons: true,
  });
  return typeof text === 'string' && text ? text : (pending?.text ?? '');
}

function terminalCardText(cardText, outcome, resolvedText) {
  const label = TERMINAL_LABEL[outcome]
    ? t(TERMINAL_LABEL[outcome])
    : (typeof resolvedText === 'string' ? resolvedText : '');
  return label ? `${cardText}\n\n${label}` : cardText;
}

/**
 * Telegram adapter for the shared approval queue. One instance lives per bridge
 * and owns the nonce registry, so stale cards from earlier turns are recognisable
 * and a new approval in the same conversation supersedes the old keyboard.
 */
export class TelegramApprovalCard {
  #registry;
  #logger;
  #notices;

  constructor({
    logger = console,
    registry,
    stateTexts = {},
    ttlMs = 65 * 60_000,
  } = {}) {
    this.#registry = registry instanceof ActionCardRegistry
      ? registry
      : new ActionCardRegistry({ ttlMs });
    this.#logger = logger;
    this.#notices = {
      ...DEFAULT_STATE_TEXT_OVERRIDES,
      ...stateTexts,
    };
  }

  get registry() {
    return this.#registry;
  }

  /**
   * Build the `render` / `onResolved` / `send` context handed to
   * HarnessApprovalQueue. Returns an empty object when the bot cannot carry a
   * keyboard, leaving the queue's plain-text flow completely untouched.
   */
  createContext({ key, actor, target, send, bot } = {}) {
    if (typeof bot?.sendInteractionCard !== 'function'
      || typeof bot?.editInteractionCard !== 'function') {
      return {};
    }
    const rawSend = typeof send === 'function' ? send : async () => {};
    let card = null;
    // The queue sends the terminal receipt as a separate text right after
    // `onResolved`; when the card edit already delivered it, that copy is noise.
    let swallowResolvedText = null;

    const guardedSend = async (text) => {
      if (swallowResolvedText !== null && text === swallowResolvedText) {
        swallowResolvedText = null;
        return;
      }
      return rawSend(text);
    };

    return {
      send: guardedSend,
      render: async (pending) => {
        // A long argument block is folded, not truncated: the card shows a
        // recognizable summary and a 「查看完整参数」 button that delivers the
        // exact original text. Approving never happens sight-unseen.
        const folded = foldApprovalCardText(telegramApprovalCardText(pending));
        const text = folded.text;
        // sendInteractionCard cannot split a body, and sendMessage rejects
        // anything over 4096 characters. A body that big keeps the text path,
        // which splits the same bytes instead of logging a doomed 400.
        if (text.length > TELEGRAM_APPROVAL_CARD_MAX_CHARS) {
          this.#logger.warn?.(
            '[dsh-im:telegram] approval body exceeds the Telegram message limit; using the plain-text approval:',
            `${text.length} chars`,
          );
          await rawSend(pending.text);
          return;
        }
        const entry = this.#registry.issue({
          conversationKey: key,
          kind: 'approval',
          // `fullText` rides in the payload so the details button can deliver the
          // unfolded body without a second render (and without an extra RPC).
          payload: {
            approvalId: pending.approvalId,
            actor,
            fullText: folded.folded ? folded.fullText : null,
          },
        });
        try {
          const sent = await bot.sendInteractionCard(target, {
            text,
            markup: telegramApprovalMarkup(entry.nonce, { folded: folded.folded }),
          });
          card = {
            nonce: entry.nonce,
            approvalId: pending.approvalId,
            messageId: sent?.providerMessageIds?.at(-1) ?? null,
            text,
            fullText: folded.fullText,
          };
          // The card now owns the decision guidance and the terminal receipt.
          pending.interactiveCard = true;
        } catch (error) {
          // A platform that refuses the keyboard must not lose the approval:
          // clear the registration and send the exact pre-card prompt instead.
          this.#registry.settle(entry.nonce, ACTION_CARD_STATUS.REVOKED);
          card = null;
          this.#logger.warn?.(
            '[dsh-im:telegram] could not deliver an approval card; falling back to the plain-text approval:',
            error?.message ?? error,
          );
          await rawSend(pending.text);
        }
      },
      onResolved: async (resolvedText, outcome) => {
        if (!card) return false;
        this.#registry.settle(
          card.nonce,
          TERMINAL_STATUS_BY_OUTCOME[outcome] ?? ACTION_CARD_STATUS.RESOLVED,
        );
        if (card.messageId === null) return false;
        try {
          await bot.editInteractionCard(target, card.messageId, {
            text: terminalCardText(card.text, outcome, resolvedText),
            markup: EMPTY_KEYBOARD,
          });
          // The edit landed (or the client already shows it): tell the queue the
          // receipt is delivered so it skips the duplicate terminal text.
          swallowResolvedText = resolvedText;
          return true;
        } catch (error) {
          this.#logger.warn?.(
            '[dsh-im:telegram] could not update a resolved approval card; the text receipt follows:',
            error?.message ?? error,
          );
          await this.#retireKeyboard(bot, target, card.messageId);
          return false;
        }
      },
    };
  }

  /**
   * Handle one inline-keyboard press. Returns false for payloads this card did
   * not produce, so question cards keep using their own path.
   */
  async handlePress(callback, { bot, answer, submit } = {}) {
    const parsed = parseTelegramApprovalCallback(callback?.data);
    if (!parsed) return false;
    const senderId = typeof callback?.senderId === 'string' ? callback.senderId : '';
    const entry = this.#registry.get(parsed.nonce);

    // Check the actor before claiming: a stranger's press must not consume the
    // owner's only chance to decide.
    if (entry
      && (entry.status === ACTION_CARD_STATUS.ACTIVE || entry.status === ACTION_CARD_STATUS.CLAIMED)
      && typeof entry.payload?.actor === 'string'
      && entry.payload.actor !== senderId) {
      await answer?.(t(APPROVAL_CARD_NOTICES.ownerOnly));
      return true;
    }

    // 查看完整参数 must not claim the card: reading the details is the whole
    // point of the fold, and the user still has to decide afterwards.
    if (parsed.action === 'details') {
      if (!entry || entry.status === ACTION_CARD_STATUS.UNKNOWN) {
        await answer?.(actionCardStateText(ACTION_CARD_STATUS.UNKNOWN, this.#notices));
        return true;
      }
      const full = typeof entry.payload?.fullText === 'string' ? entry.payload.fullText : '';
      if (full && typeof bot?.sendText === 'function') {
        await answer?.(t('已发送完整参数。'));
        await bot.sendText(callback?.replyTarget, full);
      } else {
        await answer?.(t('暂时无法展开完整参数，请到 Web 端查看。'));
      }
      return true;
    }

    // Synchronous claim: whoever gets here first owns the decision; a second tap
    // (or a second client) is told what happened without submitting again.
    const claimed = this.#registry.claim(parsed.nonce);
    if (claimed.status !== ACTION_CARD_STATUS.ACTIVE) {
      await answer?.(actionCardStateText(claimed.status, this.#notices));
      if (claimed.status !== ACTION_CARD_STATUS.CLAIMED) {
        await this.#retireKeyboard(bot, callback?.replyTarget, callback?.providerMessageId);
      }
      return true;
    }

    const live = claimed.entry;
    // Acknowledge before doing anything that can fail or take time.
    await answer?.();
    if (typeof submit !== 'function') {
      this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
      return true;
    }
    const outcome = OUTCOME_BY_DECISION[parsed.action];
    let submitted = false;
    try {
      submitted = await submit(live.payload?.approvalId, outcome, { actor: senderId });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] failed to submit an approval card decision:',
        error?.message ?? error,
      );
    }
    if (submitted) return true;
    // The live queue no longer has this approval (resolved elsewhere, route
    // closed). Retire the card instead of leaving a keyboard that keeps failing.
    this.#registry.settle(parsed.nonce, ACTION_CARD_STATUS.STALE);
    await this.#retireKeyboard(bot, callback?.replyTarget, callback?.providerMessageId);
    return true;
  }

  async #retireKeyboard(bot, target, providerMessageId) {
    if (typeof bot?.updateInteractionCard !== 'function') return;
    // Card delivery hands back string ids (Bot API message ids are numbers), so
    // normalise before validating; a string guard silently skipped every cleanup.
    const messageId = Number(providerMessageId);
    if (!target || !Number.isSafeInteger(messageId)) return;
    try {
      await bot.updateInteractionCard(target, messageId, { markup: EMPTY_KEYBOARD });
    } catch (error) {
      this.#logger.warn?.(
        '[dsh-im:telegram] could not clear a stale approval keyboard:',
        error?.message ?? error,
      );
    }
  }
}
