import { t } from './i18n.mjs';

/** Long enough to tell sessions apart in a chat, short enough to read. */
const SESSION_ID_DISPLAY_LENGTH = 12;

/**
 * Optional /status fields must not hold the reply open when the Host is stuck.
 * Three seconds is well above a healthy local RPC and short enough that the
 * connection line is never buried behind a frozen Session/models read.
 */
export const STATUS_FIELD_TIMEOUT_MS = 3_000;

function shortenedSessionId(sessionId) {
  return sessionId.length > SESSION_ID_DISPLAY_LENGTH
    ? `${sessionId.slice(0, SESSION_ID_DISPLAY_LENGTH)}…`
    : sessionId;
}

/**
 * The workspace the current conversation actually runs in: an explicit
 * per-conversation pin when present, otherwise the bot-wide default.
 */
function readWorkspace(harness, conversationKey) {
  if (typeof harness?.currentConversationWorkspace === 'function'
    && typeof conversationKey === 'string' && conversationKey) {
    const workspace = harness.currentConversationWorkspace(conversationKey);
    if (typeof workspace === 'string' && workspace) return workspace;
  }
  if (typeof harness?.currentWorkspace === 'function') {
    const workspace = harness.currentWorkspace();
    if (typeof workspace === 'string' && workspace) return workspace;
  }
  return null;
}

async function readPreset(harness, options) {
  if (typeof harness?.agentPresetSettings !== 'function') return null;
  const settings = await harness.agentPresetSettings(options);
  const preset = settings?.agentPreset;
  if (typeof preset !== 'string' || !preset) return t('跟随 Host 默认');
  const item = settings?.agentPresetCatalog?.items?.find((entry) => entry?.id === preset);
  return item?.label ? `${item.label}（${preset}）` : preset;
}

async function readModel(session, options) {
  if (typeof session?.models !== 'function') return null;
  const catalog = await session.models(options);
  const current = catalog?.current;
  if (typeof current?.provider !== 'string' || !current.provider
    || typeof current?.model !== 'string' || !current.model) return null;
  return `${current.provider}/${current.model}`;
}

async function readRunning(session, options) {
  if (typeof session?.isRunning !== 'function') return false;
  return (await session.isRunning(options)) === true;
}

/** Give the optional reads their own deadline, without cancelling the turn. */
function fieldReadOptions(signal, timeoutMs) {
  const timeout = AbortSignal.timeout(timeoutMs);
  return { signal: signal ? AbortSignal.any([signal, timeout]) : timeout };
}

/** A status field is optional: one failing read must not fail the command. */
async function settled(operation) {
  try {
    return await operation();
  } catch {
    return null;
  }
}

/**
 * A status field is optional AND must not outlive its deadline.
 *
 * The abort signal alone is not enough: the real Host chain
 * (`agentPresetSettings()` reads the preset directory before it re-checks the
 * signal) can ignore it and never settle, which would hold the whole reply
 * open. Race the read against its own timer so the deadline holds no matter
 * how the underlying RPC behaves; the signal still lets cooperative readers
 * cancel their work early.
 */
function settledWithin(operation, timeoutMs) {
  return new Promise((resolve) => {
    let settledAlready = false;
    const finish = (value) => {
      if (settledAlready) return false;
      settledAlready = true;
      clearTimeout(timer);
      resolve(value ?? null);
      return true;
    };
    const timer = setTimeout(() => finish(null), timeoutMs);
    timer.unref?.();
    (async () => operation())().then(finish, () => finish(null));
  });
}

/**
 * Render one readable /status reply for the text channels.
 *
 * The first line is the historical connection confirmation. Everything after
 * it is best-effort: a workspace, session binding, model or Agent Preset that
 * cannot be read is omitted (or explained) instead of turning the command into
 * a failure. The running-task line appears only when this chat's bound session
 * is actually running, so the common idle case stays short. Optional reads use
 * a bounded signal ({@link STATUS_FIELD_TIMEOUT_MS}) so a frozen Host cannot
 * make the command hang.
 */
/** The last path segment, used when a full path must not be shown. */
export function workspaceTail(path) {
  const text = typeof path === 'string' ? path.replace(/[/\\]+$/u, '') : '';
  if (!text) return '（未知）';
  const tail = text.slice(Math.max(text.lastIndexOf('/'), text.lastIndexOf('\\')) + 1);
  return tail || text;
}

/**
 * The short Session tail a shared conversation may see: long enough to tell two
 * bindings apart, short enough that the room never learns a usable identifier.
 */
export function sessionIdTail(sessionId) {
  const text = typeof sessionId === 'string' ? sessionId : '';
  return text ? `…${text.slice(-6)}` : '';
}

/**
 * Whether this conversation's details may be shown in full.
 *
 * A group chat is a room full of people: the absolute workspace path, the Session
 * id and the model name describe the *operator's* machine, not the group's
 * business. So in a group the reply keeps the useful part (is it connected, is
 * something running) and drops the identifying part.
 */
export function isSharedConversation(conversationKey) {
  return typeof conversationKey === 'string' && conversationKey.startsWith('group:');
}

/** A finite, non-negative number, or null when the Host omitted/mangled it. */
function numberOrNull(value) {
  return typeof value === 'number' && Number.isFinite(value) && value >= 0 ? value : null;
}

/** Compact token count: 999 → 999, 1 234 → 1.2k, 1 500 000 → 1.5M. */
export function formatTokenCount(value) {
  const tokens = numberOrNull(value);
  if (tokens === null) return '0';
  if (tokens < 1_000) return String(tokens);
  const scaled = tokens < 1_000_000 ? tokens / 1_000 : tokens / 1_000_000;
  const rounded = scaled >= 100 ? Math.round(scaled) : Math.round(scaled * 10) / 10;
  return `${rounded}${tokens < 1_000_000 ? 'k' : 'M'}`;
}

/**
 * Cache-hit share of prompt-side input.
 *
 * The three prompt buckets are disjoint: uncached input, cache reads, cache
 * writes. A full hit reports 100; a near-full hit never rounds up to 100 while
 * a miss is still recorded, so the reading cannot claim the impossible.
 */
export function cacheHitPercentText(cacheReadTokens, inputTokens) {
  const read = numberOrNull(cacheReadTokens) ?? 0;
  const input = numberOrNull(inputTokens) ?? 0;
  if (input <= 0) return null;
  if (read >= input) return '100';
  const percent = Math.round((read / input) * 1_000) / 10;
  if (percent >= 100) return '99.9';
  return Number.isInteger(percent) ? String(percent) : percent.toFixed(1);
}

/**
 * Read the two projections that make a Session's spend readable.
 *
 * `tokenUsage` is the whole-log cumulative provider report; `contextPressure`
 * is the newest request's prompt size paired with the route capacity. Both are
 * optional: an older Host, a cold Session or a loading projection simply omits
 * its lines instead of failing the command.
 */
async function readUsage(harness, session, options) {
  const sessionId = typeof session?.sessionId === 'string' ? session.sessionId : null;
  const read = typeof session?.readProjections === 'function'
    ? () => session.readProjections(options)
    : sessionId && typeof harness?.readSessionProjections === 'function'
      ? () => harness.readSessionProjections(sessionId, options)
      : null;
  const value = read ? await read() : null;
  const values = value?.values && typeof value.values === 'object' ? value.values : null;
  if (!values) return null;
  const tokenUsage = values.tokenUsage;
  const pressure = values.contextPressure;
  const usage = {
    // A projected prompt is a heuristic anchored to the provider sample; prefer
    // it because it reacts to a compaction that `pressureTokens` cannot see.
    contextUsed: numberOrNull(pressure?.projectedTokens)
      ?? numberOrNull(pressure?.pressureTokens),
    contextWindow: numberOrNull(pressure?.contextWindow),
    cacheReadTokens: numberOrNull(tokenUsage?.cacheReadTokens),
    uncachedInputTokens: numberOrNull(tokenUsage?.uncachedInputTokens),
    cacheWriteTokens: numberOrNull(tokenUsage?.cacheWriteTokens),
    outputTokens: numberOrNull(tokenUsage?.outputTokens),
  };
  const hasContext = usage.contextUsed !== null;
  const hasTokens = usage.uncachedInputTokens !== null
    || usage.cacheReadTokens !== null
    || usage.cacheWriteTokens !== null
    || usage.outputTokens !== null;
  return hasContext || hasTokens ? usage : null;
}

/**
 * Render the usage half of a `/status` reply from one normalized snapshot.
 *
 * Exported so the Telegram card prints exactly the same three readings in the
 * same order; the text path stays authoritative for channels without a card.
 */
export function statusUsageLines(usage) {
  if (!usage || typeof usage !== 'object') return [];
  const lines = [];
  const used = numberOrNull(usage.contextUsed);
  const window = numberOrNull(usage.contextWindow);
  if (used !== null) {
    lines.push(window !== null && window > 0
      ? t('上下文占用：~{used} / {window}（{percent}%）', {
        used: formatTokenCount(used),
        window: formatTokenCount(window),
        percent: String(Math.min(999, Math.round((used / window) * 100))),
      })
      : t('上下文占用：~{used}', { used: formatTokenCount(used) }));
  }
  const inputTokens = (numberOrNull(usage.uncachedInputTokens) ?? 0)
    + (numberOrNull(usage.cacheReadTokens) ?? 0)
    + (numberOrNull(usage.cacheWriteTokens) ?? 0);
  const percent = cacheHitPercentText(usage.cacheReadTokens, inputTokens);
  if (percent !== null) {
    lines.push(t('缓存命中率：{percent}%（缓存读取 {read} / 输入 {input}）', {
      percent,
      read: formatTokenCount(usage.cacheReadTokens),
      input: formatTokenCount(inputTokens),
    }));
  }
  const outputTokens = numberOrNull(usage.outputTokens);
  if (inputTokens > 0 || outputTokens !== null) {
    lines.push(t('本会话 Token：输入 {input} / 输出 {output}', {
      input: formatTokenCount(inputTokens),
      output: formatTokenCount(outputTokens),
    }));
  }
  return lines;
}

export async function runStatusCommand({
  descriptor,
  harness,
  state,
  conversationKey,
  signal,
  fieldTimeoutMs = STATUS_FIELD_TIMEOUT_MS,
} = {}) {
  if (!harness || typeof harness.ensureRunning !== 'function') {
    throw new TypeError('A Harness client with ensureRunning is required');
  }
  const options = signal ? { signal } : {};
  await harness.ensureRunning(options);
  const fieldTimeout = Number.isSafeInteger(fieldTimeoutMs) && fieldTimeoutMs > 0
    ? fieldTimeoutMs
    : STATUS_FIELD_TIMEOUT_MS;
  const fieldOptions = fieldReadOptions(signal, fieldTimeout);

  const label = descriptor?.label ?? 'Telegram';
  const lines = [t('{label}机器人与 DeepSeek Harness 连接正常。', { label })];

  const shared = isSharedConversation(conversationKey);
  const workspace = await settled(() => readWorkspace(harness, conversationKey));
  // The absolute path is the operator's filesystem layout: show its last segment
  // (enough to tell workspaces apart) instead of the full path in a group.
  if (workspace) {
    lines.push(shared
      ? t('工作区：{workspace}（群聊中仅显示末段）', { workspace: workspaceTail(workspace) })
      : t('工作区：{workspace}', { workspace }));
  }

  const sessionId = await settled(async () => (typeof state?.sessionFor === 'function'
    ? state.sessionFor(conversationKey)
    : null));
  const boundSessionId = typeof sessionId === 'string' && sessionId ? sessionId : null;
  lines.push(boundSessionId
    ? t('绑定会话：{session}', {
      session: shared ? sessionIdTail(boundSessionId) : shortenedSessionId(boundSessionId),
    })
    : t('绑定会话：未绑定（发送消息后自动创建）'));

  const session = boundSessionId
    ? await settled(() => (typeof harness.workspaceSession === 'function'
      ? harness.workspaceSession(boundSessionId, conversationKey)
      : null))
    : null;
  const [model, preset, running, usage] = await Promise.all([
    session ? settledWithin(() => readModel(session, fieldOptions), fieldTimeout) : null,
    settledWithin(() => readPreset(harness, fieldOptions), fieldTimeout),
    session ? settledWithin(() => readRunning(session, fieldOptions), fieldTimeout) : false,
    session ? settledWithin(() => readUsage(harness, session, fieldOptions), fieldTimeout) : null,
  ]);
  if (model && !shared) lines.push(t('当前模型：{model}', { model }));
  else if (model && shared) lines.push(t('当前模型：已设置（群聊中不显示具体名称）'));
  else if (!session) lines.push(t('当前模型：暂无（创建会话后显示）'));
  if (preset) lines.push(t('Agent Preset（预设）：{preset}', { preset }));
  if (running === true) lines.push(t('运行中任务：有（发送 /stop 可停止）'));
  lines.push(...statusUsageLines(usage));

  // `statusSnapshot` is the machine-readable half a channel may render as a card.
  // It carries the *same* redaction the text got: a card must never leak what the
  // text path deliberately hid, so `shared` is applied once, here.
  return {
    message: lines.join('\n'),
    statusSnapshot: Object.freeze({
      label,
      shared,
      workspace: workspace ? (shared ? workspaceTail(workspace) : workspace) : null,
      sessionId: boundSessionId,
      model: model ? (shared ? null : model) : null,
      modelHidden: Boolean(model) && shared,
      preset: preset ?? null,
      running: running === true,
      usage: usage ? Object.freeze({ ...usage }) : null,
    }),
  };
}
