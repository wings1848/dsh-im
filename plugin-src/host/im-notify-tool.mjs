import { parseSessionChannelTitle } from '../../src/channels/shared/session-channel-labels.mjs';

/** Session-level IM notification tool: any Session can push messages, notifications, or option cards. */
export const IM_NOTIFY_TOOL = 'dsh_im_notify';

const MAX_TEXT = 3500;
const MAX_TITLE = 80;
const MAX_OPTIONS = 8;
const MAX_OPTION_LABEL = 32;
const MAX_OPTION_VALUE = 64;
const MAX_SESSION_TITLE = 40;
const MAX_CANDIDATES_IN_ERROR = 8;

function sessionEvents(session) {
  if (typeof session?.snapshotEvents === 'function') {
    const events = session.snapshotEvents();
    return Array.isArray(events) ? events : [];
  }
  return Array.isArray(session?.events) ? session.events : [];
}

/** Latest accepted Session title, with the IM channel prefix stripped. */
export function sessionDisplayTitle(session) {
  const events = sessionEvents(session);
  const latest = events.findLast((event) => event?.type === 'session/title'
    && typeof event.data?.title === 'string' && event.data.title.trim());
  const raw = typeof latest?.data?.title === 'string' ? latest.data.title.trim() : '';
  if (raw) {
    const parsed = parseSessionChannelTitle(raw);
    // Host caps generated titles already; this only protects IM labels.
    return (parsed?.title ?? raw).slice(0, MAX_SESSION_TITLE);
  }
  const cwd = session?.header?.cwd;
  if (typeof cwd === 'string' && cwd.trim()) {
    const base = cwd.replace(/[\\/]+$/, '').split(/[\\/]/).filter(Boolean).pop();
    if (base) return base.slice(0, MAX_SESSION_TITLE);
  }
  return '未命名会话';
}

/** Stable label every notification carries: short id + Session name. */
export function sessionIdentity(session) {
  const sessionId = session?.header?.id ?? session?.id;
  if (typeof sessionId !== 'string' || !sessionId) {
    throw new Error('当前会话没有可用的 Session id，无法标注通知来源。');
  }
  // DSH ids look like `session-<uuid>`; the raw prefix would label every
  // Session `session-`. Prefer the first id segment after that prefix.
  const shortId = (sessionId.startsWith('session-') ? sessionId.slice('session-'.length) : sessionId)
    .slice(0, 8);
  const title = sessionDisplayTitle(session);
  return Object.freeze({ sessionId, shortId, title, label: `${shortId} · ${title}` });
}

function notifyError(code, message) {
  const error = new Error(message);
  error.code = code;
  return error;
}

function normalizeText(value) {
  if (typeof value !== 'string' || !value.trim()) {
    throw notifyError('bad-request', '通知正文 text 不能为空。');
  }
  const text = value.trim();
  if (text.length > MAX_TEXT) throw notifyError('bad-request', `通知正文过长（上限 ${MAX_TEXT} 字符）。`);
  return text;
}

function normalizeTitle(value) {
  if (value === undefined || value === null) return '';
  if (typeof value !== 'string') throw notifyError('bad-request', 'title 必须是字符串。');
  const title = value.trim();
  if (title.length > MAX_TITLE) throw notifyError('bad-request', `title 过长（上限 ${MAX_TITLE} 字符）。`);
  return title;
}

function normalizeOptions(value) {
  if (value === undefined || value === null) return [];
  if (!Array.isArray(value)) throw notifyError('bad-request', 'options 必须是数组。');
  if (value.length > MAX_OPTIONS) throw notifyError('bad-request', `options 最多 ${MAX_OPTIONS} 项。`);
  return value.map((option, index) => {
    if (!option || typeof option !== 'object' || Array.isArray(option)) {
      throw notifyError('bad-request', `options[${index}] 必须是 {label, value?} 对象。`);
    }
    const label = typeof option.label === 'string' ? option.label.trim() : '';
    if (!label) throw notifyError('bad-request', `options[${index}].label 不能为空。`);
    if (label.length > MAX_OPTION_LABEL) {
      throw notifyError('bad-request', `options[${index}].label 过长（上限 ${MAX_OPTION_LABEL} 字符）。`);
    }
    const out = { label };
    if (option.value !== undefined) {
      if (typeof option.value !== 'string' || !option.value.trim()) {
        throw notifyError('bad-request', `options[${index}].value 必须是非空字符串。`);
      }
      if (option.value.length > MAX_OPTION_VALUE) {
        throw notifyError('bad-request', `options[${index}].value 过长（上限 ${MAX_OPTION_VALUE} 字符）。`);
      }
      out.value = option.value;
    }
    return out;
  });
}

/** One compact header, then the caller's body. */
export function composeNotifyText(identity, text, title = '') {
  const lines = [`🪪 ${identity.label}`];
  if (title) lines.push(`📌 ${title}`);
  lines.push('', text);
  return lines.join('\n');
}

function describeCandidates(candidates) {
  return candidates
    .slice(0, MAX_CANDIDATES_IN_ERROR)
    .map((candidate) => `${candidate.targetId}（${candidate.channel}${candidate.name ? ` · ${candidate.name}` : ''}）`)
    .join('、');
}

async function collectCandidates(deliveryService) {
  const bots = await deliveryService.listBots();
  const candidates = [];
  for (const bot of Array.isArray(bots) ? bots : []) {
    if (typeof bot?.botId !== 'string') continue;
    let listed;
    try {
      listed = await deliveryService.listTargets(bot.botId);
    } catch {
      continue;
    }
    // The Host service answers `{ botId, channel, targets }`; accept a bare
    // array too so the tool stays usable against the public dshIm API.
    const targets = Array.isArray(listed) ? listed : listed?.targets;
    for (const target of Array.isArray(targets) ? targets : []) {
      if (typeof target?.targetId !== 'string') continue;
      candidates.push({
        botId: bot.botId,
        channel: typeof bot.channel === 'string' ? bot.channel : 'unknown',
        targetId: target.targetId,
        name: typeof target.name === 'string' ? target.name : '',
      });
    }
  }
  return candidates;
}

/**
 * Resolution order: explicit targetId → saved default → the only saved target.
 * Ambiguity is reported with the candidates instead of guessing a recipient.
 */
export async function resolveNotifyTarget(deliveryService, store, { targetId } = {}) {
  const candidates = await collectCandidates(deliveryService);
  if (!candidates.length) {
    throw notifyError('no-target', '当前 Host 没有已保存的 IM 投递目标。请先在「设置 → IM机器人 → 投递设置」里新建目标。');
  }
  let saved = null;
  try {
    saved = await store.get();
  } catch {
    saved = null;
  }
  if (typeof targetId === 'string' && targetId.trim()) {
    const wanted = targetId.trim();
    const matches = candidates.filter((candidate) => candidate.targetId === wanted);
    if (!matches.length) {
      throw notifyError('unknown-target', `找不到投递目标 ${wanted}。可选：${describeCandidates(candidates)}`);
    }
    if (matches.length > 1) {
      const preferred = saved && matches.find((candidate) => candidate.botId === saved.botId);
      if (preferred) return preferred;
      throw notifyError('ambiguous-target', `目标 id ${wanted} 在多个机器人下存在，请先设置默认通知目标。`);
    }
    return matches[0];
  }
  if (saved) {
    const match = candidates.find((candidate) => candidate.botId === saved.botId
      && candidate.targetId === saved.targetId);
    if (match) return match;
    // A saved default that no longer exists must not silently redirect the
  // notification to another chat: say it is stale.
    throw notifyError(
      'stale-default-target',
      `默认通知目标 ${saved.targetId} 已不存在（可能已删除），请在「设置 → IM机器人 → 投递设置」重新选择。可选：${describeCandidates(candidates)}`,
    );
  }
  if (candidates.length === 1) return candidates[0];
  throw notifyError(
    'no-default-target',
    `有多个投递目标，但未设置默认通知目标。请先在设置页选择默认目标，或显式传 targetId。可选：${describeCandidates(candidates)}`,
  );
}

export function createImNotifyTool({ deliveryService, store, logger = console } = {}) {
  const output = {
    schema: {
      type: 'object',
      additionalProperties: false,
      properties: {
        sent: { type: 'boolean' },
        targetId: { type: 'string' },
        session: {
          type: 'object',
          additionalProperties: false,
          properties: { shortId: { type: 'string' }, title: { type: 'string' } },
        },
        fallback: { type: 'string' },
      },
    },
    render: (_args, value) => [{
      type: 'text',
      text: `Sent to the user through IM (${value?.targetId ?? 'unknown target'}), tagged with session ${value?.session?.shortId ?? ''} · ${value?.session?.title ?? ''}.${value?.fallback === 'text' ? ' The channel has no buttons; options were rendered as a numbered text list.' : ''}`,
    }],
  };
  return Object.freeze({
    name: IM_NOTIFY_TOOL,
    description: 'Send a proactive message, notification, or option card to the user through the connected IM channel. Every message is tagged with this Session\'s short id and name, so the user knows which Session it came from. Works from any Session, including Web/CLI Sessions that are not bound to a chat. On Telegram, options become buttons and the chosen option is delivered back to this Session as a user message. Use it for long-running completion, background results, or when you need the user\'s decision; do not duplicate the same content in your normal reply.',
    parameters: {
      type: 'object',
      additionalProperties: false,
      properties: {
        text: { type: 'string', description: `Notification body, 1-${MAX_TEXT} characters.` },
        title: { type: 'string', description: `Optional headline shown above the body (up to ${MAX_TITLE} characters).` },
        options: {
          type: 'array',
          description: `Optional 1-${MAX_OPTIONS} single-choice options. Telegram renders them as inline buttons; other channels fall back to a numbered text list.`,
          items: {
            type: 'object',
            additionalProperties: false,
            properties: {
              label: { type: 'string', description: `Button text, up to ${MAX_OPTION_LABEL} characters.` },
              value: { type: 'string', description: 'Optional value delivered back to the Session; defaults to the label.' },
            },
            required: ['label'],
          },
        },
        targetId: { type: 'string', description: 'Optional saved delivery target id. Omit to use the configured default notification target.' },
      },
      required: ['text'],
    },
    output,
    async execute(args, exec) {
      const identity = sessionIdentity(exec?.agent?.session);
      const text = normalizeText(args?.text);
      const title = normalizeTitle(args?.title);
      const options = normalizeOptions(args?.options);
      const target = await resolveNotifyTarget(deliveryService, store, { targetId: args?.targetId });
      const body = composeNotifyText(identity, text, title);
      const base = {
        targetId: target.targetId,
        session: { shortId: identity.shortId, title: identity.title },
      };
      try {
        if (options.length) {
          const result = await deliveryService.sendCard(target.botId, target.targetId, {
            text: body, options, origin: identity,
          });
          return { sent: true, ...base, ...(result?.fallback === 'text' ? { fallback: 'text' } : {}) };
        }
        await deliveryService.send(target.botId, target.targetId, body);
        return { sent: true, ...base };
      } catch (error) {
        logger?.warn?.('[dsh-im] notify tool delivery failed:', error?.message ?? error);
        const message = typeof error?.message === 'string' && error.message && error.message !== error.code
          ? error.message : 'IM 投递失败，请检查机器人连接和目标配置。';
        throw notifyError(error?.code ?? 'delivery-failed', message);
      }
    },
  });
}

export function installImNotifyTool(ctx, { deliveryService, store, logger = console } = {}) {
  if (typeof ctx?.tools?.register !== 'function' || !deliveryService || !store) return false;
  ctx.tools.register(createImNotifyTool({ deliveryService, store, logger }));
  ctx.systemPrompt?.context?.({
    name: 'dsh-im:notify',
    order: 117,
    text: () => 'To proactively reach the user through IM (long task finished, background result, or a decision you need), call dsh_im_notify. It tags the message with this Session\'s short id and name, works from any Session, and turns options into buttons where the channel supports them. Prefer it over repeating the same content in your reply; do not use it for routine progress chatter.',
  });
  return true;
}
