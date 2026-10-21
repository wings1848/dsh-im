# 三个上游项目的 Telegram 交互设计调研

> 目的：为 dsh-im 的 Telegram「工作区切换卡片 + `/ws` 与 `/wsl` 合并」改造，提炼可直接吸收的设计。
> 路径约定：所有 `file:line` 均相对 `/home/wings/Code_Project/`（如 `openclaw/extensions/...`）。
> 调研快照（浅克隆，未构建、未跑测试）：
>
> | 仓库 | commit | 日期 | 说明 |
> | --- | --- | --- | --- |
> | openclaw | `c16b5166` | 2026-10-21 | Telegram 渠道非常成熟，重点读 `extensions/telegram/` + 核心 `/commands`、`/models` |
> | hermes-agent | `851b389` | 2026-05-04 | 单文件 Python gateway（`gateway/platforms/telegram.py` 3628 行） |
> | Memoh | `2ebe076` | 2026-10-21 | Go；**有** Telegram 渠道，且有独立的「交互卡片」命令框架 |
> | dsh-im | `27bd7a2` | 2026-10-21 | 调研时工作区卡片已落地，本文建议按「增量」理解 |
>
> 范围边界：只读源码与少量设计文档；没有运行任何 Telegram bot，也没有跑三仓测试。所有行为结论来自代码。

---

## 0. 一页结论

**最值得抄的 5 个设计**

| # | 设计 | 一句话 | 上游证据 |
| --- | --- | --- | --- |
| 1 | 位置索引必须在 press 时对「实时列表」复核 | 渲染快照里的 index 在列表重排后会指到别的对象；上游要么用稳定 ID，要么发现列表变了就让用户重选 | `Memoh/internal/command/callback.go:111-118`；`openclaw/src/auto-reply/reply/commands-models.ts:29-30` + `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:469-475` |
| 2 | 按钮只改标记时用 `editMessageReplyMarkup`，不要重发/重编辑正文 | 少一次正文编辑就少一次 parse/`message is not modified`/长度问题 | `openclaw/extensions/telegram/src/bot-handlers.callback-actions.ts:43-51`；dsh-im 已这样做：`dsh-im/src/channels/telegram/telegram-runtime.mjs:624-632` |
| 3 | 点击先 ack（停 spinner），随后再异步干活；所有出口都要 ack | 一个按钮只有一次 `answerCallbackQuery` 机会，漏答=客户端一直转圈 | `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:108-123`；`Memoh/internal/channel/adapters/telegram/telegram.go:600-601` |
| 4 | 卡片有终态：过期/失效时「清掉按不动的键盘 + 告诉下一步」 | 只 toast 不清键盘，会留下大量看似可用实则报错的死按钮 | `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:215-219`；`Memoh/internal/channel/adapters/telegram/telegram.go:611-621` |
| 5 | 一条命令同时承担 list+set，靠「默认动作 + 内部 flags」实现 | `/ws` 无参=列表卡、`/ws N`=切换；按钮回调复用成 `--page/--id` 形式的内脏 flag | `Memoh/internal/command/model.go:11-14`；`Memoh/internal/commandsyntax/parser.go:89-135`；`hermes-agent/gateway/run.py:7438-7456` |

**dsh-im 当前已经做对的（不要为了「对齐上游」改掉）**

- nonce + 索引而不是把路径塞进 `callback_data`，且有 64 字节预算测试：`dsh-im/src/channels/telegram/telegram-bridge.mjs:75-100`、`dsh-im/test/channels/telegram/workspace-card.test.mjs:185`。
- 同步认领 `submitting`（第一 await 之前置位）防连点重复切换：`dsh-im/src/channels/shared/text-harness-bridge.mjs:1949-1955`。
- 回调路径复用命令权限闸门 `isCommand: true`：`dsh-im/src/channels/shared/text-harness-bridge.mjs:1939-1946`。
- 「已经在当前工作区」幂等短路：`dsh-im/src/channels/shared/text-harness-bridge.mjs:1952-1954`。
- 卡片发送失败/工作区过多时回退文字列表，不丢信息：`dsh-im/src/channels/shared/text-harness-bridge.mjs:1890-1913`。
- 卡片正文刻意无状态（只换键盘，避免正文里的「当前：X」立刻说谎）：`dsh-im/src/channels/telegram/telegram-bridge.mjs:99-103`。

---

## 1. openclaw

### 1.1 callback_data：64 字节、版本化命名空间、不透明回退

openclaw 把「类型前缀 + 版本号」作为命名空间的第一原则，三类按钮各占一个前缀，互不误解析：

```ts
// openclaw/extensions/telegram/src/native-command-callback-data.ts:1-2
const TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX = "tgcmd:";
const TELEGRAM_OPAQUE_CALLBACK_PREFIX = "tgcb1:";
```

```ts
// openclaw/extensions/telegram/src/approval-callback-data.ts:4-5
export const TELEGRAM_CALLBACK_DATA_MAX_BYTES = 64;
const TELEGRAM_APPROVAL_CALLBACK_PREFIX = "tga1:";
```

- 64 字节是 **UTF-8 字节数**，不是 JS 字符数：`openclaw/extensions/telegram/src/approval-callback-data.ts:25-27`
  ```ts
  export function fitsTelegramCallbackData(value: string): boolean {
    return Buffer.byteLength(value, "utf8") <= TELEGRAM_CALLBACK_DATA_MAX_BYTES;
  }
  ```
- 装不下时的两种正解：
  1) **短摘要当定位符**，真正数据留在服务端（授权仍在 gateway 复核）：`openclaw/extensions/telegram/src/approval-callback-data.ts:50-52`
     ```ts
     // Telegram caps callback_data at 64 UTF-8 bytes. The full digest is only a
     // durable locator; Gateway authorization still guards the canonical record.
     return encode(buildApprovalResolutionRef({ approvalId: action.approvalId, approvalKind }));
     ```
  2) **sha256(base64url) 43 字符不透明引用**，点击时再回当前目录里反查：`openclaw/extensions/telegram/src/model-buttons.ts:61-65, 102-118`
     ```ts
     const fullCallbackData = `${CALLBACK_PREFIX.selectStandard}${params.provider}/${params.model}`;
     if (LEGACY_PROVIDER_PATTERN.test(params.provider) && fitsTelegramCallbackData(fullCallbackData)) {
       return fullCallbackData;
     }
     return `${CALLBACK_PREFIX.opaqueModel}${hashOpaqueCallback("model", params.provider, params.model)}`;
     ```
- 固定长度 ID + 有界序号，构造上保证不超限：`openclaw/extensions/telegram/src/question-callback-data.ts:1-3, 13-26`
  ```ts
  const QUESTION_RECORD_ID_PATTERN = /^ask_[a-f0-9]{32}$/u;
  // Fixed question IDs and option indices keep both envelopes below Telegram's 64-byte limit.
  return `tgq1:${callback.questionId}:${callback.optionIndex}`;
  ```
- 回调串可以**直接携带要重放的命令文本**（天然幂等、无服务端状态）：`openclaw/extensions/telegram/src/native-command-callback-data.ts:4-6`
  ```ts
  export function buildTelegramNativeCommandCallbackData(commandText: string): string {
    return `${TELEGRAM_NATIVE_COMMAND_CALLBACK_PREFIX}${commandText}`;
  }
  ```

### 1.2 callback 生命周期：先 ack → 分流 → 结算/降级

入口**先答 `answerCallbackQuery`，再做任何 await**，避免 spinner 停留：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:108-123
const answerCallbackQuery = async () => {
  await withTelegramApiErrorLogging({
    operation: "answerCallbackQuery",
    runtime,
    fn: () => startTelegramCallbackQueryAnswer(bot, callback.id, false),
  }).catch(() => {});
};
```

同一个 `callback_query.id` 可能被多条路径重复答（重复投递/重放），openclaw 用 WeakMap 合并：

```ts
// openclaw/extensions/telegram/src/callback-query-answer-state.ts:11
const telegramCallbackQueryAnswers = new WeakMap<object, Map<string, CallbackQueryAnswer>>();
// :13-26 同一 id 的第二次调用直接复用第一次的 promise，而不是再发一次 API
if (existing) { return existing.promise; }
```

分流顺序固定，且**保留命名空间**（未知/畸形也不当普通文本处理）：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:136-150
const nativeCallbackCommand = parseTelegramNativeCommandCallbackData(data);
const hasReservedModelPrefix = data.startsWith("mdl1~");
const hasReservedApprovalPrefix = hasTelegramApprovalCallbackPrefix(data);
...
const isApprovalCallback = hasReservedApprovalPrefix || legacyApprovalCallback !== null;
```

无法识别的旧卡片统一走「终态化」：清键盘 + 明确一句「已不可用」，而不是静默：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:215-219
const terminalizeUnavailableCallback = async () => {
  logVerbose("telegram: typed callback unavailable (handler missing or payload invalid)");
  await clearRoutedCallbackButtons();
  await actions.replyToCallbackChat("This action is no longer available.");
};
```

审批（对并发点击最严格）：**首答胜出**由 canonical 状态所有者裁决；输的一侧收到 `applied:false`，同样清理按钮。

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:105-109
// First-answer-wins returns applied:false to losing surfaces. Their controls
// are stale too, so cleanup follows canonical terminal truth, not local authorship.
await clearCallbackButtons();
```

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:181-188
const result = await resolveCanonicalApproval(approvalCallback);
if (!result.applied) {
  logVerbose(`telegram: approval callback already resolved ...`);
}
await terminalizeCanonicalApproval(approvalCallback, result);
```

过期语义写在文案里（按钮消失后仍可从聊天记录确认）：`openclaw/extensions/telegram/src/approval-terminal.ts:149-152`、请求卡上展示剩余时间 `openclaw/extensions/telegram/src/approval-handler.runtime.ts:96`（`Expires in: ...`）。

### 1.3 press 后原消息更新：两种编辑 + 三类错误降级

只换键盘的辅助函数（最省事、最安全）：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-actions.ts:43-51
const editCallbackButtons = async (buttons: TelegramCallbackButton[][]) => {
  return await bot.api.editMessageReplyMarkup(
    callbackMessage.chat.id,
    callbackMessage.message_id,
    withCallbackBusinessParams({ reply_markup: buildInlineKeyboard(buttons) ?? { inline_keyboard: [] } }),
  );
};
```

「改正文 + 换键盘」时的完整降级链（这是 Telegram 编辑最常踩的坑）：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-actions.ts:70-91
const keyboard = buildInlineKeyboard(buttons);
const editParams = keyboard ? { reply_markup: keyboard, ...extra } : extra;
try {
  await editCallbackMessage(text, editParams);
} catch (editErr) {
  const errStr = String(editErr);
  if (errStr.includes("no text in the message")) {        // 媒体消息没有正文
    try { await deleteCallbackMessage(); } catch { await editCallbackButtons([]).catch(() => {}); }
    await replyToCallbackChat(text, editParams);            // 改成发一条新消息，信息不丢
  } else if (!errStr.includes("message is not modified")) { // 内容没变 = 成功
    throw editErr;
  }
}
```

三类错误有明确谓词，别用字符串散落判断：`openclaw/extensions/telegram/src/network-errors.ts:280-299`

```ts
const MESSAGE_NOT_MODIFIED_RE = /400:\s*Bad Request:\s*message is not modified|MESSAGE_NOT_MODIFIED/i;
const MESSAGE_HAS_NO_TEXT_RE = /400:\s*Bad Request:\s*there is no text in the message to edit/i;
const EDIT_TARGET_MISSING_RE = /400:\s*Bad Request:\s*message to edit not found|.../i;
```

失败是否可重试也有分层：可重试错误包装后抛给上层重投，永久编辑错误直接吞掉：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:628-635
if (err instanceof TelegramRetryableCallbackError) {
  if (isPermanentTelegramCallbackEditError(err.cause)) {
    logVerbose(`telegram: swallowing permanent callback edit error: ${String(err.cause)}`);
    return;
  }
  ... throw err.cause;
}
```

终态渲染的兜底顺序值得抄：先 `editMessageText(..., reply_markup:{inline_keyboard:[]})`，失败就只清键盘，再失败就发一条新消息：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:122-143
try { await editCallbackMessage(text, { reply_markup: { inline_keyboard: [] } }); return; }
catch (editErr) { ... await clearTerminalApprovalButtons(); ... }
try { await replyToCallbackChat(text); } catch (sendErr) { logVerbose(...); }
```

### 1.4 卡片选择器状态机（model picker 为主，multi-select 对照）

**层级与回调命名**（`providers → list(provider,page) → select`，每层都能回退）：

```ts
// openclaw/extensions/telegram/src/model-buttons.ts:1-12
 * - mdl_prov              - show providers list
 * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
 * - mdl_sel_{provider/id} - select model (standard)
 * - mdl_back              - back to providers list
```

**当前项标记 + 标签截断 + 分页行**：

```ts
// openclaw/extensions/telegram/src/model-buttons.ts:211-220
const isCurrentModel = currentSelection.length > 0 && currentSelection === (...);
const displayText = displayLabel.length <= MODEL_BUTTON_LABEL_MAX_LENGTH
  ? displayLabel
  : `…${sliceUtf16Safe(displayLabel, -(MODEL_BUTTON_LABEL_MAX_LENGTH - 1))}`;
const text = isCurrentModel ? `${displayText} ✓` : displayText;
```

```ts
// openclaw/extensions/telegram/src/model-buttons.ts:180-191（Prev / 页码 / Next 同一行；页码也是按钮）
return [
  { page: currentPage - 1, text: "◀ Prev", show: currentPage > 1 },
  { page: null, text: `${currentPage}/${totalPages}`, show: true },
  { page: currentPage + 1, text: "Next ▶", show: currentPage < totalPages },
].filter(({ show }) => show).map(({ page, text }) => ({ text, callback_data: callbackData(page) }));
```

页码按钮的回调是 **noop**（要有回调才能显示为按钮，但点击无副作用）：`openclaw/extensions/telegram/src/command-ui.ts:18-31`

```ts
(page) => `commands_page_${page ?? "noop"}${suffix}`,
```

**失效选择器的统一话术**（列表变了、点进来的 provider/model 已不存在）：

```ts
// openclaw/src/auto-reply/reply/commands-models.ts:29-30
export const MODEL_PICKER_CHANGED_MESSAGE =
  "Available models changed. Open /models and choose again.";
```

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:451-453, 507-513
if (modelCallback.type === "providers" || modelCallback.type === "back") {
  if (providers.length === 0) { await retryModelAction(() => showModelReply("No providers available.", [])); return; }
}
...
if (selection.kind !== "resolved" || !byProvider.get(selection.provider)?.has(selection.model)) {
  await showChangedModelPicker();   // 重新渲染 provider 层，而不是报错
  return;
}
```

**成功后的终态**：正文换成 ✅ 回执、键盘清空（`[]`），并说明作用域（session-only / 默认值）：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:584-589
const scopeText = isDefaultSelection
  ? "Session model selection cleared. ... New replies use the agent's configured default."
  : "Session-only model selection. ... This chat keeps the model selection across /new and /reset; use /model default -s to clear ...";
await showModelReply(`✅ Model ${actionText}\n\n${scopeText}`, [], { parse_mode: "HTML" });
```

分页列表的回调处理：**编辑原消息**（不新发），并记录「已投递命令」用于会话记录：

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:383-403
try {
  await editCallbackMessage(markdownToTelegramHtml(result.text), {
    parse_mode: "HTML",
    ...(keyboard ? { reply_markup: keyboard } : {}),
  });
} catch (editErr) {
  if (!String(editErr).includes("message is not modified")) throw new TelegramRetryableCallbackError(editErr);
}
await recordDeliveredCommandExchange({ ..., commandText: `/commands ${page}`, commandId: `telegram:${accountId}:${callback.id}` });
```

**多选卡的状态存在消息自身**（无服务端状态）：`✅ ` 前缀写进按钮 label，点击时克隆当前键盘再改标记。

```ts
// openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:508-521
const buttons = cloneInlineKeyboardButtons(callbackMessage).map((row) =>
  row.map((button) => {
    const buttonValue = button.callback_data.slice(MULTI_SELECT_TOGGLE_PREFIX.length);
    const baseText = button.text.replace(/^✅\s*/, "");
    const wasSelected = isSelectedMultiButton(button);
    ...
    return { ...button, text: selected ? `${SELECTED_PREFIX}${baseText}` : baseText };
  }),
);
await editCallbackButtons(buttons);
```

> 这套「状态写 label」只适合纯展示型多选；一旦 label 需要本地化/截断就会坏（见 §5）。dsh-im 的单选工作区卡不需要它。

### 1.5 命令菜单收敛（`/help` 精简 + `/commands` 全量分页 + 别名隐藏）

- 帮助层三件套：`/help` 是人工挑选的短表（按 Session/Options/Status/Skills 分组），`/commands` 才是全量分页列表（8 条/页）。`openclaw/src/auto-reply/command-status-builders.ts:29-59, 61, 108-190`
  ```ts
  return [
    "ℹ️ Help", "", "Session", "  /new  |  /reset  |  /compact [instructions]  |  /stop", ...
    "More: /commands for full list, /tools for available capabilities",
  ].join("\n");
  ```
- 别名在列表里以括号展示，但原生菜单只放「主名」：
  ```ts
  // openclaw/src/auto-reply/command-status-builders.ts:79-95
  const aliasLabel = aliases.length ? ` (${aliases.join(", ")})` : "";
  const scopeLabel = command.scope === "text" ? " [text]" : "";
  return `${primary}${aliasLabel}${scopeLabel} - ${command.description}`;
  ```
- 菜单排序把别名放最后（超限时先丢别名），且「隐藏≠不可调用」：
  ```ts
  // openclaw/extensions/telegram/src/bot-native-commands.ts:139-144
  ...nativeMenuCommands.filter((command) => !command.isAlias),
  ...(nativeEnabled ? pluginCatalog.commands.filter(...) : []),
  ...nativeMenuCommands.filter((command) => command.isAlias),
  ```
  ```ts
  // openclaw/extensions/telegram/src/bot-native-commands.ts:184
  // Telegram only limits menu entries; hidden commands remain callable.
  ```
- 菜单预算是硬约束：最多 100 条，**总文本预算 5700 字符**，描述逐条截断/尾部丢弃，并有 `BOT_COMMANDS_TOO_MUCH` 兜底：`openclaw/extensions/telegram/src/bot-native-command-menu.ts:22-27, 85-115, 101-102, 500-527`。
- 菜单同步按内容 hash 去重，避免重启把 Telegram 打到 429：`openclaw/extensions/telegram/src/bot-native-command-menu.ts:416-424, 482`
  ```ts
  const currentHash = hashCommandList(commandsToRegister);
  const cachedHash = syncedCommandHashes.get(owner.hashKey);
  if (cachedHash === currentHash) { return; }
  ```
- 命令本体设计（一条命令吃下 list 与 set）：
  - `/models`：无参 → provider 菜单；`/models <provider>` → 某 provider 的模型列表；`/models list <provider> <page>`。
  - `/model <provider>/<model>` → 切换；失败/越界都给出下一步可复制的命令。
  ```ts
  // openclaw/src/auto-reply/reply/commands-models.ts:249-258（无按钮渠道的文本回退）
  "Providers:", ...providers.map((provider) => `- ${provider} (${byProvider.get(provider)?.size ?? 0})`),
  "", "Use: /models <provider>", "Switch: /model <provider/model>",
  ```
  ```ts
  // openclaw/src/auto-reply/reply/commands-models.ts:339-347（越界页给合法范围 + 建议命令）
  `Page out of range: ${page} (valid: 1-${pageCount})`, "",
  `Try: /models list ${provider} ${safePage}`, `All: /models list ${provider} all`,
  ```

### 1.6 长任务进度 / 审批 / 错误

- 进度消息的**不变量**（明文写在仓库规范里，值得直接抄）：
  ```
  openclaw/extensions/telegram/AGENTS.md:68-70
  - Streaming owns one visible preview message. Edit it forward. Do not send an
    extra final bubble unless the final edit genuinely failed.
  ```
  以及 `openclaw/extensions/telegram/AGENTS.md:72-73`：超 4096 字符拆成续条消息。
- 进度正文有「保留优先级」：失败/审批/阻塞行优先保留，预算不够先丢普通行：`openclaw/extensions/telegram/src/progress-draft-preview.ts:22-33, 115-129`
  ```ts
  return (
    line.kind === "approval" || status === "failed" || status === "error" || status === "blocked"
  );
  ```
- 预览只编辑一条消息：`openclaw/extensions/telegram/src/draft-stream-message.ts:79-110`（`api.editMessageText(chatId, messageId, text, other)`）。
- 审批卡：按钮决策 + 终态回执分别有 renderer，且支持「等待中 → 已处理/已过期/已取消」四态：`openclaw/extensions/telegram/src/approval-terminal.ts:20-24, 149-152`。
- 错误话术都带「下一步」：`❌ Failed to change model: ...`（`openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:594`）、`Could not submit this answer.`（`openclaw/extensions/telegram/src/bot-handlers.callback-actions.ts:180`）。

### 1.7 对 dsh-im 的直接可用点 & 需避免

可用：

- 版本化前缀（`w1|`）+ 严格锚定正则（dsh-im 已有严格正则，补版本号即可）。
- 失效卡「清键盘 + 下一步」终态（dsh-im 目前只 toast）。
- 64 字节按 UTF-8 字节校验（dsh-im 的 nonce 是 ASCII，等价，但测试命名可保持 byte budget）。
- 选择成功后给「作用域」说明（本对话生效 / 仅本次）。
- `/help` 与 `/commands` 分层；`/help` 里展示别名，但原生菜单只留主名。

需避免：

- **不要把多选状态塞进按钮 label**（openclaw 的 `✅ ` 方案依赖 label 不被本地化/截断）。
- **不要用「位置索引」直接当选择键**而不复核列表（见 §0 第 1 条）。

---

## 2. hermes-agent

hermes 的 Telegram 渠道是单文件实现，交互卡片只有两处：模型选择器（`send_model_picker`）和审批（`send_exec_approval`），但把「单命令 list+switch」「菜单上限」「进度用 reaction」三件事做得很有参考价值。

### 2.1 命令注册与菜单上限（100 / 截断 / 优先级 / hidden_count）

- 中心注册表 `CommandDef` 带 `aliases`、`args_hint`、`cli_only`、`gateway_only`、`gateway_config_gate`：`hermes-agent/hermes_cli/commands.py:47-60`
  ```python
  @dataclass(frozen=True)
  class CommandDef:
      name: str; description: str; category: str
      aliases: tuple[str, ...] = ()
      args_hint: str = ""       # argument placeholder: "<prompt>", "[name]"
      gateway_only: bool = False
  ```
- 菜单生成是「核心命令必留 → 插件命令优先 → skill 命令填满剩余槽位」，超出的只统计 `hidden_count`（不静默）：`hermes-agent/hermes_cli/commands.py:876-909`
  ```python
  remaining_slots = max(0, max_commands - len(all_commands))
  entries, hidden_count = _collect_gateway_skill_entries(
      platform="telegram", max_slots=remaining_slots, reserved_names=reserved_names,
      desc_limit=40, sanitize_name=_sanitize_telegram_name,
  )
  ```
- 注册是**best effort**，失败只 warning、不影响通道启动；并且明确把「超过 100 条被隐藏」告诉用户去 `/commands`：`hermes-agent/gateway/platforms/telegram.py:1070-1096`
  ```python
  menu_commands, hidden_count = telegram_menu_commands(max_commands=100)
  await self._bot.set_my_commands([BotCommand(name, desc) for name, desc in menu_commands])
  if hidden_count:
      logger.info("... %d hidden (over 100 limit). Use /commands for full list.", ...)
  ```
- 名称有 32 字符上限与冲突处理（截断 + 数字后缀），见设计文档 `hermes-agent/docs/gateway/telegram-command-registration.md:145-190`；实现入口 `hermes-agent/hermes_cli/commands.py:685-714`。

### 2.2 单命令 list+switch：`/model` 与 `/commands`

- `/model` 的语义在一处 docstring 里定义清楚（无参=交互选择器；带参=切换；`--global`=持久化；`--provider`=切 provider）：`hermes-agent/gateway/run.py:7438-7456`
  ```python
  /model                              — interactive picker (Telegram/Discord) or text list
  /model <name>                       — switch for this session only
  /model <name> --global              — switch and persist to config.yaml
  /model <name> --provider <provider> — switch provider + model
  ```
- 无参时优先交互卡，任何一步失败都**回落到文本列表**（信息不丢）：`hermes-agent/gateway/run.py:7495-7662`
  ```python
  # Fallback: text list (for platforms without picker or if picker failed)
  lines.append("`/model <name>` — switch model")
  lines.append("`/model <name> --provider <slug>` — switch provider")
  lines.append("`/model <name> --global` — persist")
  ```
- 切换成功回执带完整元数据 + 「仅本会话」提示：`hermes-agent/gateway/run.py:7793`
  ```python
  lines.append("_(session only -- add `--global` to persist)_")
  ```
- `/commands [page]`：一个命令吃「无参=第 1 页 / 带数字=第 N 页」，越界自动钳制并明说：`hermes-agent/gateway/run.py:7382-7433`
  ```python
  page_size = 15 if event.source.platform == Platform.TELEGRAM else 20
  total_pages = max(1, (len(entries) + page_size - 1) // page_size)
  page = max(1, min(requested_page, total_pages))
  ...
  if page != requested_page:
      lines.append(f"_(Requested page {requested_page} was out of range, showing page {page}.)_")
  ```
  文本渠道的翻页提示就是可复制的下一条命令：`hermes-agent/gateway/run.py:7420-7428`（`/commands 2` ← prev、next → `/commands 2`）。

### 2.3 picker 卡片与状态机

- 卡片结构：provider 两列，当前项 `✓` 前缀，底部 Cancel；状态按 `chat_id` 存在内存：`hermes-agent/gateway/platforms/telegram.py:1608-1655`
  ```python
  label = f"{p['name']} ({count})"
  if p.get("is_current"):
      label = f"✓ {label}"
  InlineKeyboardButton(label, callback_data=f"mp:{p['slug']}")   # Compact callback data: mp:<slug> (max 64 bytes)
  ...
  self._model_picker_state[str(chat_id)] = {"msg_id": msg.message_id, "providers": providers, ...}
  ```
- 模型层分页 8/页，按钮标签截断到 38 字符，回调只带**扁平绝对索引**（`mm:<abs_idx>`），页码按钮是 `mx:noop`：`hermes-agent/gateway/platforms/telegram.py:1657-1698`
  ```python
  short = model_id.split("/")[-1] if "/" in model_id else model_id
  if len(short) > 38: short = short[:35] + "..."
  InlineKeyboardButton(short, callback_data=f"mm:{abs_idx}")
  ...
  nav.append(InlineKeyboardButton(f"{page + 1}/{total_pages}", callback_data="mx:noop"))
  ```
- 过期/失效一律 `query.answer(text=...)` toast + 提示重新发命令：`hermes-agent/gateway/platforms/telegram.py:1704-1707`
  ```python
  state = self._model_picker_state.get(chat_id)
  if not state:
      await query.answer(text="Picker expired — use /model again.")
      return
  ```
- 每步都 `edit_message_text` 原地更新（provider 层页头 → 模型层页头），点击 `mm:` 后把正文改成结果并清键盘，Markdown 解析失败自动降级纯文本：`hermes-agent/gateway/platforms/telegram.py:1811-1828`
  ```python
  await query.edit_message_text(text=result_text, parse_mode=ParseMode.MARKDOWN, reply_markup=None)
  except Exception:
      try: await query.edit_message_text(text=result_text, parse_mode=None, reply_markup=None)
  ...
  await query.answer(text="Model switched!")
  ```

### 2.4 callback 生命周期（ack / toast / 首答胜出 / 单命令）

- 所有回调先按前缀分流；模型卡优先于审批/确认：`hermes-agent/gateway/platforms/telegram.py:1894-1899`
  ```python
  if data.startswith(("mp:", "mm:", "mb", "mx", "mg:")):
      await self._handle_model_picker_callback(query, data, chat_id)
      return
  ```
- 审批按钮：**未授权先拒**（toast 带 ⛔），然后 `pop` 实现「首答胜出」；已处理/已过期的再点只提示：`hermes-agent/gateway/platforms/telegram.py:1912-1927`
  ```python
  if not self._is_callback_user_authorized(...):
      await query.answer(text="⛔ You are not authorized to approve commands.")
      return
  session_key = self._approval_state.pop(approval_id, None)
  if not session_key:
      await query.answer(text="This approval has already been resolved.")
      return
  ```
- 决策后用「toast + 编辑原消息去键盘」双通道反馈，编辑失败不致命：`hermes-agent/gateway/platforms/telegram.py:1939-1949`
  ```python
  await query.answer(text=label)
  try:
      await query.edit_message_text(text=f"{label} by {user_display}", parse_mode=ParseMode.MARKDOWN, reply_markup=None)
  except Exception:
      pass  # non-fatal if edit fails
  ```
- 回调数据短：审批用**单调计数器**生成 `approval_id`，避免长 ID 塞 64 字节：`hermes-agent/gateway/platforms/telegram.py:1501-1507`
  ```python
  # We'll use the message_id as part of callback_data to look up session_key
  # Send a placeholder first, then update — or use a counter.
  # Simpler: use a monotonic counter to generate short IDs.
  self._approval_counter = itertools.count(1)
  approval_id = next(self._approval_counter)
  ```
- 「更新提示」类临时审批用原子写文件提交决策（tmp + replace），避免半写：`hermes-agent/gateway/platforms/telegram.py:2057-2065`

### 2.5 `/resume`：会话切换的可借鉴点

工作区切换与会话切换同构，`/resume` 是 hermes 最好的对照：

- 无参=列出（带标题、预览、用法提示）；带参=切换；名称不存在时给出「用无参看列表」的下一步：`hermes-agent/gateway/run.py:9431-9464`
  ```python
  lines.append("\nUsage: `/resume <session name>`")
  ...
  return f"No session found matching '**{name}**'.\nUse `/resume` with no arguments to see available sessions."
  ```
- 已在目标上直接幂等返回，不重复切换：`hermes-agent/gateway/run.py:9473-9475`
  ```python
  current_entry = self.session_store.get_or_create_session(source)
  if current_entry.session_id == target_id:
      return f"📌 Already on session **{name}**."
  ```
- 切换动作的「副作用清单」值得对照：释放正在跑的 agent、切 session、清安全状态、驱逐缓存 agent（否则缓存用旧 session 继续写）：`hermes-agent/gateway/run.py:9477-9491`
  ```python
  self._release_running_agent_state(session_key)
  new_entry = self.session_store.switch_session(session_key, target_id)
  self._clear_session_boundary_security_state(session_key)
  self._evict_cached_agent(session_key)
  ```
- 回执带上下文信息（消息条数），让用户确认「切对了」：`hermes-agent/gateway/run.py:9496-9501`
  ```python
  msg_count = len([m for m in history if m.get("role") == "user"]) if history else 0
  return f"↻ Resumed session **{title}**{msg_part}. Conversation restored."
  ```
- 忙时仍可用的命令白名单（列表类/切换类不该排队）：`hermes-agent/hermes_cli/commands.py:491-508`
  ```python
  ACTIVE_SESSION_BYPASS_COMMANDS: frozenset[str] = frozenset(
      {"agents", "approve", "background", "commands", "deny", "help", "new", ...}
  )
  ```

### 2.6 进度与状态反馈（typing / reaction）

- 处理中用 reaction 标记（👀 → 👍/👎），Telegram 的 `set_message_reaction` 是替换而非追加，所以「切终态」不需要先删：`hermes-agent/gateway/platforms/telegram.py:3583-3628`
  ```python
  await self._set_reaction(chat_id, message_id, "\U0001f440")   # on_processing_start
  ...
  "\U0001f44d" if outcome == ProcessingOutcome.SUCCESS else "\U0001f44e"
  ```
  注意默认关闭：`hermes-agent/gateway/platforms/telegram.py:3585-3587`（`TELEGRAM_REACTIONS` 默认 `false`）——所以不能把进度只寄托在 reaction 上。
- typing 指示器与线程参数处理：`hermes-agent/gateway/platforms/telegram.py:2470-2494`。

### 2.7 需避免

- **picker 状态只按 `chat_id` 存且回调用绝对索引**（`hermes-agent/gateway/platforms/telegram.py:1704-1707, 1784-1798`）：同一聊天发第二张卡会覆盖第一张的状态，旧卡在新列表下会用旧索引指向错的对象。dsh-im 的 nonce 快照方案更好，但要注意「快照 vs 实时列表」的错位（见 §4-R1）。
- **审批状态存内存 dict 且 pop 后丢失**（`hermes-agent/gateway/platforms/telegram.py:1924-1927`）：重启后点旧按钮得到「已处理」而不是「已过期」，语义有误导；openclaw/Memoh 都把权威状态放在持久 owner 上。
- **编辑失败直接 `pass`**（`hermes-agent/gateway/platforms/telegram.py:1948-1949`）：可接受，但至少应记录原因（openclaw 会 `logVerbose`），否则线上难排查。

---

## 3. Memoh

**先明确：Memoh 有 Telegram 渠道**，不只是「agent 通信模式」：
`Memoh/internal/channel/adapters/telegram/telegram.go`（2588 行）、`ask_user.go`、`stream.go`、`internal/command/`（命令/卡片框架）、`internal/channel/inbound/result_render.go`（卡片渲染）。它的价值在于：**把「交互卡片」做成了跨渠道的命令结果抽象**，且对 Telegram 64 字节/回调存储问题给了最系统的解法。

### 3.1 回调命名空间与 64 字节：稳定 ID、参数转义、stash 溢出

- 命名空间隔离 + 64 字节常量：`Memoh/internal/command/callback.go:12-17`
  ```go
  // callbackNamespace prefixes every interactive callback_data string so it does
  // not collide with the existing "approve:"/"reject:" tool-approval callbacks.
  const callbackNamespace = "m~"
  // telegramCallbackLimit is Telegram's hard limit on callback_data (64 bytes).
  const telegramCallbackLimit = 64
  ```
- **选择必须用稳定 ID，不能用位置索引**（这是本文最重要的一条上游注释）：
  ```go
  // Memoh/internal/command/callback.go:111-118
  // EncodeModelSelectCallback builds the callback_data for selecting a model by
  // its stable DB id. Layout: "m~ms~{modelDBID}". Using the stable id (not a
  // positional/flat index) means a model-list change between render and tap can't
  // silently resolve the tap to a different model.
  func EncodeModelSelectCallback(modelDBID string) string {
      return fmt.Sprintf("%sms~%s", callbackNamespace, url.QueryEscape(strings.TrimSpace(modelDBID)))
  }
  ```
- 长参数溢出的正解：有界进程内 stash + `#hash` 引用，miss 时**明确降级**而不是崩：
  ```go
  // Memoh/internal/command/callback.go:68-83
  // Layout: "m~lp~{resource}~{action}~{page}~{argsToken}". When the encoded args
  // would push the string past Telegram's 64-byte limit, the args are stashed in
  // a bounded process-local table and referenced by a short token ("#<hash>").
  encoded := base + argsStr
  if len(encoded) <= telegramCallbackLimit { return encoded }
  return base + "#" + stashArgs(argsStr)
  ```
  ```go
  // Memoh/internal/command/callback.go:262-269（miss 的语义：降级成不筛的列表，而不是报错）
  // A miss can happen when an old paginated keyboard is tapped after the
  // bounded stash (256 entries, FIFO) has rolled past the original entry.
  // The downstream synthetic command then re-runs the list without the
  // narrowing args, showing the user an unfiltered view rather than the
  // filtered subset they originally requested.
  ```
- 参数转义的坑写得很具体：**先逐参 escape 再空格 join**，否则带空格的名字会被解码成两个参数（跨设备复现过）：
  ```go
  // Memoh/internal/command/callback.go:85-92
  // Escaping per-arg (rather than the joined string) is what keeps a space
  // *within* an arg from being mistaken for an arg boundary on decode ...
  escaped = append(escaped, url.QueryEscape(a))
  return strings.Join(escaped, " ")
  ```

### 3.2 卡片抽象：`Result` / `Interactive` / `channel.Action` + 渠道渲染

- 命令层只产出「文本 + 交互结构」，按钮是渠道无关的 `channel.Action`（`Type/Label/Value/Row`），由各渠道渲染成 inline keyboard：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:170-193
  if result.Interactive == nil || !rc.Caps.Buttons {
      msg = channel.Message{Text: appendFallbackTrailer(result.Text, result.Interactive, rc.Caps, t)}
  } else {
      switch result.Interactive.Kind {
      case command.InteractiveList:        msg = renderListView(result.Text, result.Interactive.List, t)
      case command.InteractiveModelPicker: msg = renderModelPicker(result.Text, result.Interactive.Picker, t)
  ```
- 无按钮渠道**不是简单甩正文**：从 Interactive 结构派生「可键入的等价命令」追加到正文尾部：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:195-213
  // appendFallbackTrailer adds a typeable-command guide derived from Interactive
  // when buttons aren't available (or absent). ...
  trailer := command.FallbackTrailer(iv, t)
  return strings.TrimRight(text, "\n") + "\n\n" + trailer
  ```

### 3.3 一条命令的 list+set：`CommandGroup` + 内部 flags

- `/model` 是一个 group，默认动作 `list`，另有 `current`/`set`；`set` 标记 `IsWrite`（权限在**执行时**判）：`Memoh/internal/command/model.go:11-24, 40-60`
  ```go
  g := newCommandGroup("model", "Manage bot models")
  g.DefaultAction = "list"
  g.Register(SubCommand{Name: "list", Usage: "list [provider_name] - List available chat models", ...})
  ...
  g.Register(SubCommand{Name: "set", Usage: "set <model_id> | <provider_name> <model_name> - Set the chat model", IsWrite: true, ...})
  ```
- 按钮点击不是特判分支，而是**重放成一条合成命令**，走与手打完全相同的解析/权限/执行管线：
  ```go
  // Memoh/internal/command/callback.go:233-260
  func (p ParsedCallback) SyntheticCommand() string {
      switch p.Kind {
      case callbackKindListPage:    return base + " --page " + strconv.Itoa(p.Page)
      case callbackKindModelProvider: return fmt.Sprintf("/model list --prov %d --page %d", p.ProviderIndex, p.Page)
      case callbackKindModelSelect: return fmt.Sprintf("/model set --id %s", p.SelectID)
      ...
  ```
- 内部 flag 在解析层被摘掉，既不漏进 positional args，也允许用户手打：
  ```go
  // Memoh/internal/commandsyntax/parser.go:89-92
  // extractFlags pulls "--page N", "--prov N" (ints), "--range V" and "--id V"
  // (strings) out of the token stream so they do not leak into positional Args.
  ```
  ```go
  // Memoh/internal/commandsyntax/parser.go:116-130
  // Recognized int flag: always drop the flag token itself, and consume
  // its value token even when the value is invalid ...
  if i+1 < len(tokens) && !strings.HasPrefix(tokens[i+1], "--") { ... }
  continue // drop the flag token regardless
  ```
- 选择按钮的「渲染给所有人，执行时判权限」是有意设计（注释解释了 hide 按钮反而把真正的 owner 挡掉）：
  ```go
  // Memoh/internal/command/model_picker.go:131-136
  // Selecting a model is owner-only (/model set is IsWrite), but the picker
  // buttons render for everyone: permission is enforced at execution time, so a
  // non-owner tap returns a clear "owner only" message. Hiding the buttons for
  // non-owners also hid them from owners whose Telegram identity isn't resolved
  // as owner (WriteAccess=false) — which silently killed the picker on Telegram.
  ```

### 3.4 两种卡片状态机：无状态重放 vs 持久 CAS

Memoh 把「导航类」和「写入类」卡片明确分开：

1. **导航/分页/选择卡片 = 无状态重放**。回调只带 nonce/页码/ID，适配器把点击重放成合成命令，命令重新渲染并**编辑原消息**（`edit_message_id` 元数据）：
   ```go
   // Memoh/internal/channel/adapters/telegram/telegram.go:622-628
   // Pagination/selection: re-dispatch a synthetic command that
   // re-renders the message in place. Do NOT clear the keyboard.
   if msg, ok := a.buildTelegramCallbackInboundMessage(cfg, update); ok {
       a.dispatchInbound(ctx, cfg, handler, msg)
   }
   ```
   ```go
   // Memoh/internal/channel/adapters/telegram/telegram.go:672-678
   if !parsed.IsSkillActivation() {
       // Pagination/selection: re-render the existing message in place
       // rather than posting a new one. ...
       extraMeta["edit_message_id"] = strconv.Itoa(cb.Message.ID)
   }
   ```
   ```go
   // Memoh/internal/channel/inbound/channel.go:618-628
   // A command re-dispatched from an interactive button carries the id of
   // the message to edit in place, so navigation/selection updates the
   // existing message instead of posting a new one. ...
   if editID, ok := msg.Metadata["edit_message_id"].(string); ok && ... && caps.Edit {
       outMsg.ID = strings.TrimSpace(editID)
   } else if mid := strings.TrimSpace(msg.Message.ID); mid != "" {
       outMsg.Reply = &channel.ReplyRef{MessageID: mid}
   }
   ```
2. **写入/问答卡片 = 持久状态 + 乐观 CAS**。`ask_user` 每个按钮带 request UUID，直接打到持久交互状态，卡从返回状态重渲染；重启/换端都不丢：
   ```go
   // Memoh/internal/channel/adapters/telegram/ask_user.go:14-25
   // There is deliberately NO adapter-side state machine here: every button
   // callback carries the request UUID and is applied to the persistent
   // userinput.TextInteractionState via Service.AdvanceInteraction (optimistic
   // CAS). The card is then re-rendered from the returned state. This is the
   // same state machine the plain-text fallback drives, so a pending ask_user
   // survives process restarts and can even be finished from another surface.
   ```
   ```go
   // Memoh/internal/channel/adapters/telegram/telegram.go:765-785
   result, err := a.userInput.AdvanceInteraction(ctx, userinput.AdvanceInteractionInput{...})
   if !result.Handled {
       // Not pending anymore: answered elsewhere, canceled, or expired.
       _ = bot.Respond(cb, &tele.CallbackResponse{Text: loc.T("cmd.userInput.expired"), ShowAlert: true})
       return
   }
   if toast := askUserRejectToast(loc, result.Reject); toast != "" {
       _ = bot.Respond(cb, &tele.CallbackResponse{Text: toast, ShowAlert: true})
       return
   }
   ```
   ```go
   // Memoh/internal/channel/adapters/telegram/telegram.go:793-796（只有真的变了才重渲染）
   if result.Changed && chatID != 0 && msgID != 0 {
       text, actions := renderAskUserPage(req.ID, loc, req.UIPayload, req.Interaction)
       _ = editTelegramMessageTextWithActions(bot, chatID, msgID, text, "", actions)
   }
   ```

### 3.5 列表/选择卡片渲染细节

- 列表项：当前/已选项 `✓ ` 前缀；分页行 Prev / `x/y`（noop）/ Next；底部 Close（dismiss）：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:286-299
  label := item.Label
  if item.Selected { label = "✓ " + label }
  ...
  actions = append(actions, channel.Action{Type: actionTypeCallback, Label: truncateButtonLabel(label), Value: value, Row: row})
  ```
  ```go
  // Memoh/internal/channel/inbound/result_render.go:331-363
  if page > 0 { ... Label: t.T("chrome.prev"), Value: command.EncodeListCallback(lv.Resource, lv.Action, lv.Args, page-1) ... }
  actions = append(actions, channel.Action{Label: fmt.Sprintf("%d/%d", page+1, totalPages), Value: command.NoopCallback(), Row: navRow})
  ...
  actions = append(actions, channel.Action{Label: t.T("chrome.close"), Value: command.DismissCallback(), Row: row})
  ```
- **过期键盘的钳制**（旧卡在列表变短后点 Next/Prev 会出现 `11/3` 或指向不存在的页）：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:265-277
  // Clamp the page index used for nav rendering into [0, totalPages-1] in a
  // local variable; do not mutate lv (a caller-owned pointer). A stale
  // callback from a keyboard captured before the list shrunk (rows deleted
  // on another device) would otherwise emit a broken nav row — "11/3"
  // counter, Prev encoding a Page-1 jump backward into nowhere — and Next
  // would silently vanish. Mirrors the clamp in renderModelPicker.
  if page > totalPages-1 { page = totalPages - 1 }
  ```
- 两级选择器：provider 层两列、`●` 标当前所属 provider；模型层每行一个、`✓` 标已选；底部 Back/Providers/Close：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:408-453
  label := fmt.Sprintf("%s (%d)", prov.Name, prov.Count)
  if prov.HasCurrent { label += " ●" }
  ...
  if m.Selected { label = "✓ " + label }
  Value: command.EncodeModelSelectCallback(m.DBID)
  ```
- 「关闭」不是删消息，而是收成标题行 + 去键盘（保留面包屑）：
  ```go
  // Memoh/internal/channel/adapters/telegram/telegram.go:612-620
  // Close: collapse the card to its title line and drop the keyboard,
  // rather than deleting the whole message — the user keeps a short
  // breadcrumb of what was opened instead of having it vanish.
  if title := collapseToTitle(cb.Message.Text); title != "" {
      _ = editTelegramMessageText(bot, cb.Message.Chat.ID, cb.Message.ID, title, "")
  }
  ```
- 问答卡提交后把当前页替换成「逐题汇总」（终态可回看），并要求「页码按钮点自己不触发重渲染」：
  ```go
  // Memoh/internal/channel/adapters/telegram/ask_user.go:317-323
  // Page indicator navigates to the same page; AdvanceInteraction reports
  // it unchanged, so tapping it never triggers a no-op message edit.
  ```
  ```go
  // Memoh/internal/channel/adapters/telegram/ask_user.go:404-406
  // formatAskUserSubmittedSummary replaces the active page with a stable record
  // of every question and final answer once the request is submitted.
  ```

### 3.6 菜单/帮助收敛

- 原生菜单是**人工挑选的单 token 命令**，注释直接说明「子动作放不进原生菜单，靠 /help 或消息里的按钮发现」：
  ```go
  // Memoh/internal/command/menu.go:12-16
  // MenuCommands returns the curated slash-command list to advertise in a
  // channel's native command menu ... Only single-token commands belong here —
  // the native menu cannot express sub-actions like "schedule list" (those are
  // discovered via /help or in-message buttons).
  ```
- `/help` 有两级：`/help` 是分组总览，`/help <group>` 逐组列动作，`/help <group> <action>` 给单动作用法与兄弟动作（`registry.go:78-114`）。
- 菜单注册同样 best-effort，失败只 warn 不影响连接：`Memoh/internal/channel/adapters/telegram/telegram.go:335-357`

### 3.7 进度流

- 流式只维持一条消息，编辑节流 5s、内容未变跳过、429 按 `retry_after` 回退、终态编辑重试 5 次且 `not modified` 视为成功：
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:21-24
  telegramStreamEditThrottle  = 5000 * time.Millisecond
  telegramStreamPendingSuffix = "\n……"
  ```
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:127-133
  if normalizeStreamComparableText(text) == normalizeStreamComparableText(lastEdited) { return nil }
  text = strings.TrimSpace(text) + telegramStreamPendingSuffix
  if time.Since(lastEditedAt) < telegramStreamEditThrottle { return nil }
  ```
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:201-202
  // not-modified means the message already shows this text — treat as done.
  if editErr == nil || isTelegramMessageNotModified(editErr) { ... }
  ```
- 编辑辅助函数把「not modified / 目标不可恢复」吞成正常；流式终态用 raw 版本以便发现失败后**改发新消息**而不是静默丢内容：
  ```go
  // Memoh/internal/channel/adapters/telegram/telegram.go:1631-1636
  // rawEditTelegramMessageText performs the edit and returns the raw API error,
  // swallowing nothing. editTelegramMessageText wraps it with the
  // not-modified/unrecoverable swallow ...
  ```
- 私聊用 `sendMessageDraft`（有 30s 临时性），群聊用一条消息编辑；openclaw 明确反对为此用 draft（见 `openclaw/extensions/telegram/AGENTS.md:61-67`）——两边取舍不同，dsh-im 若只在群里发卡片，按 openclaw 的单消息编辑即可：`Memoh/internal/channel/adapters/telegram/telegram.go:1382-1386`。

### 3.8 需避免

- **进程内 stash 的过期语义要写进产品文案**（`callback.go:262-282`）：miss 后列表会「退化成未筛选」，用户不一定能理解；dsh-im 的 nonce 过期直接提示重发，语义更清晰，保持即可。
- **不要把「渲染状态」和「权威状态」混在一处**：Memoh 的分层（渲染视图 vs 持久交互状态）是对的，但它的 `model_picker` 又是「无状态重放」，两种模式并存会增加理解成本；dsh-im 只有一种（nonce 快照 + 无状态回调），更简单，不要引入第二套。

---

## 4. 给 dsh-im 的改造建议清单（按收益/成本排序）

> 现状基线：`dsh-im/src/channels/shared/text-harness-bridge.mjs:1890-1985`、
> `dsh-im/src/channels/telegram/telegram-bridge.mjs:75-123`、
> 方案 `dsh-im/docs/方案/Telegram工作区切换卡片方案.md`。
> 「成本」按改动面估计：低 = 单文件 <30 行 + 1 个测试；中 = 跨 2-3 文件；高 = 要动状态模型/协议。

### P0：收益高、成本低（建议本轮就做）

| # | 建议 | 一句话做法 | 上游证据 |
| --- | --- | --- | --- |
| R1 | **press 时对实时列表复核 index** | 点击时先 `listWorkspaces()`，若 `paths[index] !== 快照.paths[index]` 或路径已不存在 → 不切换，toast「工作区列表已变化，请重新发送 /ws」并把该卡键盘清掉 | `Memoh/internal/command/callback.go:111-118`（稳定 ID 的理由）；`openclaw/src/auto-reply/reply/commands-models.ts:29-30` + `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:469-475`（列表变了让用户重选）；dsh-im 文本路径本身就是实时解析：`dsh-im/src/channels/shared/workspace-command.mjs:527-532` |
| R2 | **卡片与文本路径共用同一个「切换 + 错误映射」helper** | 卡片点击不要直接 `harness.switchWorkspace`，改为调用 `workspace-command.mjs` 里已有的分支逻辑，成功文案/`workspace-not-absolute`/`not-found`/`not-directory` 的错误文案与文字命令逐字一致 | `openclaw/extensions/telegram/AGENTS.md:40-45`（send funnel parity：两条发送链路必须同样降级）；`Memoh/internal/channel/inbound/result_render.go:170-193`（按钮渠道与文本渠道共用同一个 Result 渲染） |
| R3 | **过期/失效卡：toast 之后顺手清键盘** | 未知 nonce / TTL 过期 / 快照失效时，除了 toast，再 best-effort `editMessageReplyMarkup(empty)`；忽略 `message is not modified` 与 `message to edit not found` | `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:215-219`（清键盘 + "no longer available"）；`Memoh/internal/channel/adapters/telegram/telegram.go:611-621`（dismiss 收成标题行）；仅 toast 的反例：`hermes-agent/gateway/platforms/telegram.py:1706` |
| R4 | **同一对话只保留一张活跃工作区卡** | 发送新卡时把该 `conversationKey` 下的旧 nonce 标记为 superseded（或直接删）；旧卡被点时回「列表已更新，请用最新卡片」并清键盘 | `openclaw/src/auto-reply/reply/commands-models.ts:29-30` + `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:446-449`（选择器变更统一话术）；`Memoh/internal/command/model.go:49-55`（`cmd.model.listChanged`：渲染后到点击间模型被删则提示列表已变） |
| R5 | **回调命名空间加版本号** | `w\|…` → `w1\|…`（解析器同时接受旧格式并当过期处理），避免以后改格式时旧卡被误解析 | 版本化前缀三例：`openclaw/extensions/telegram/src/approval-callback-data.ts:5`（`tga1:`）、`openclaw/extensions/telegram/src/question-callback-data.ts:1`（`tgq1:`）、`openclaw/extensions/telegram/src/model-buttons.ts:9-10`（`mdl1~`）；Memoh 也按域分命名空间：`Memoh/internal/command/callback.go:14`、`Memoh/internal/channel/adapters/telegram/ask_user.go:26`（`aui~`） |
| R6 | **ack 保证覆盖所有出口** | 成功 toast 保留（hermes 风格），但把 `answerInteractionCallback` 放进 `finally` 或为每条早退路径显式 ack；若 `switchWorkspace` 可能 > 数秒，改成「先 ack 无文案 → 用编辑卡片正文/终态承载结果」 | `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:108-123`（入口先 ack）；`Memoh/internal/channel/adapters/telegram/telegram.go:600-601`（"Acknowledge immediately so the client stops showing a spinner."） |
| R7 | **成功回执标注作用域** | toast 文案从「工作区已切换为：X」补一句「本对话生效」，避免用户以为全局生效 | `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:584-589`（"Session-only model selection. ... This chat keeps ..."）；`hermes-agent/gateway/run.py:7793`（"session only -- add `--global` to persist"） |
| R8 | **「已经在当前工作区」以权威状态为准** | 点击时如果 `entry.listing.current` 落后（别的卡/文字命令已切走），应对比实时 current 再决定：等于当前项 → 幂等回执，不再调 switch | `hermes-agent/gateway/run.py:9473-9475`（"/resume 已在目标会话：Already on session"） |

### P1：收益中、成本中（可排下一轮）

| # | 建议 | 一句话做法 | 上游证据 |
| --- | --- | --- | --- |
| R9 | **卡片分页（若工作区经常 >20）** | 每页 8-10 个，回调带 `page` + 绝对 index；页码按钮用 noop；渲染前把 page 钳制到 `[0, total-1]` | 8/页：`openclaw/extensions/telegram/src/model-buttons.ts:49,230-236`；`hermes-agent/gateway/platforms/telegram.py:1657,1683-1690`；Memoh 8/10/12：`Memoh/internal/command/model_picker.go:12-15`、`Memoh/internal/channel/inbound/result_render.go:256-260`；钳制理由：`Memoh/internal/channel/inbound/result_render.go:265-277` |
| R10 | **按钮 label 规则统一（截断/序号/✓）** | 沿用现有多语言 label 规则，但补一条硬上限（比如 38-40 码点）并在超限时截断；✓ 前缀只加在文本最前，避免与序号重复 | 38：`openclaw/extensions/telegram/src/model-buttons.ts:50,214-220`、`hermes-agent/gateway/platforms/telegram.py:1673-1675`；60 rune + 40 rune：`Memoh/internal/channel/inbound/result_render.go:537-543`、`Memoh/internal/channel/adapters/telegram/ask_user.go:429-438` |
| R11 | **卡片正文补一行「也可以直接发 /ws 2」** | 卡片与文本回退共享同一条提示串（从 listing 派生），提升纯文本用户与卡片用户的双向可发现性 | `Memoh/internal/channel/inbound/result_render.go:195-213`（从 Interactive 派生 fallback trailer）；`openclaw/src/auto-reply/reply/commands-models.ts:249-258`（文本回退给 Use/Switch 两行可复制命令） |
| R12 | **帮助里展示别名，菜单只留主名** | `/wsl`、`/workspaces` 仍可用；`/help`（或命令列表）以 `workspace (ws, wsl)` 形式展示别名；为「隐藏别名仍可 dispatch」补一条测试 | `openclaw/src/auto-reply/command-status-builders.ts:79-95`（别名括号展示）；`openclaw/extensions/telegram/src/bot-native-commands.ts:184`（hidden commands remain callable）；`Memoh/internal/command/menu.go:14-16`（只放单 token） |
| R13 | **i18n 与卡片绑定** | 在 nonce 缓存条目里存发送时的 locale，点击后的重渲染/toast 用它，避免用户切了界面语言后卡片中文、toast 英文 | `Memoh/internal/channel/adapters/telegram/ask_user.go:102-115`（locale 写进回调数据）；`Memoh/internal/channel/inbound/result_render.go:162-174`（Result.Locale 驱动 chrome 文案） |
| R14 | **菜单同步去重** | 若尚未做：按命令列表 hash 缓存，未变化不重复 `setMyCommands`，防重启连打 429 | `openclaw/extensions/telegram/src/bot-native-command-menu.ts:416-424,482` |

### P2：只作为架构参考（不建议本轮动）

| # | 建议 | 说明 | 上游证据 |
| --- | --- | --- | --- |
| R15 | 选择型卡片的两条路 | 「导航/单选 = 无状态重放 + 原地重渲染」「写入/问答 = 持久状态 + CAS」。dsh-im 的工作区卡是「写 + 重渲染」，当前 nonce 快照已经够用；若未来要做多步向导（比如切换前确认），再引入第二套 | `Memoh/internal/command/callback.go:233-260`、`Memoh/internal/channel/adapters/telegram/telegram.go:622-628`（重放）；`Memoh/internal/channel/adapters/telegram/ask_user.go:14-25`、`openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:105-109`（CAS/首答胜出） |
| R16 | 长任务进度一条消息编辑到终态 | 工作区切换本身短，可作为未来「切换后等待 harness 重连」的参考：单消息编辑、失败/审批行优先保留、429 按 retry_after、not modified 视为成功 | `openclaw/extensions/telegram/AGENTS.md:68-73`；`openclaw/extensions/telegram/src/progress-draft-preview.ts:22-33`；`Memoh/internal/channel/adapters/telegram/stream.go:117-133,201-202` |
| R17 | 审批按钮的「终态回执」 | 本期工作区切换不涉及审批；若未来加「切换前确认」，抄 openclaw/hermes 的「按钮 → 编辑原消息成 receipt + 清键盘 + 已处理/已过期话术」 | `openclaw/extensions/telegram/src/approval-terminal.ts:20-24,149-152`；`hermes-agent/gateway/platforms/telegram.py:1939-1949,1924-1927` |

---

## 5. 不确定性与未覆盖

1. **这是静态阅读，不是运行验证**。三仓均未构建/未跑测试，Telegram Bot API 行为细节（例如客户端 spinner 的超时）来自公开文档与代码注释，没有实测。
2. **版本漂移**：hermes 的文档 `hermes-agent/docs/gateway/telegram-command-registration.md` 与实现可能有偏差（该文档描述的命令名截断/冲突处理，本文只在 `hermes_cli/commands.py:685-714` 做了入口核对，未逐行验证 `_clamp_command_names` 的调用链）。
3. **openclaw 体量很大**，本文只覆盖 `extensions/telegram/` 与核心 `/commands`/`/models`；它的 Discord/Slack/Matrix 渠道可能有更贴近「工作区切换」的实现（本次未读）。
4. **Memoh 的 userinput 服务与 DB/CAS 细节未展开**：`AdvanceInteraction` 的乐观并发语义来自调用点注释与 `result.Handled/Changed` 的使用方式推断，未读服务实现与迁移。
5. **dsh-im 现状**：调研时仓库已达到 `27bd7a2`，工作区卡片已实现（`text-harness-bridge.mjs:1890-1985`）。§4 的建议按「增量」理解；若与实际分工（谁在改哪个文件）冲突，以 lead 的任务分配为准。
6. **本文没有覆盖**：Discord/飞书的同类卡片（dsh-im 的 `docs/方案` 里提到飞书已有工作区卡），以及其他 IM 渠道的按钮能力差异；这些可能是后续调研的输入。
