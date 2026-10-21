# Telegram 命令与交互 UX 补充调研（与 dsh-im 飞书卡片基线交叉核对）

> 上一份 `tg-ux-upstream-brief.md` 讲的是 callback_data 编码、press 生命周期、工作区卡这类**回调内部细节**。
> 本文件只讲**命令与交互/菜单层面的产品模式**：菜单放什么、键盘怎么导航、破坏性操作怎么确认、进度怎么呈现、帮助怎么被找到、边界怎么兜底、新人怎么进门。
>
> 路径约定：带仓库前缀的 `file:line` 相对 `/home/wings/Code_Project/`。下文 dsh-im 的短文件名按目录展开：
> `feishu-cards.mjs` / `bridge.mjs` / `slash-command-panel.mjs` / `step-push-mode.mjs` → `dsh-im/src/channels/feishu/`；
> `text-harness-bridge.mjs` / `editable-message-stream.mjs` / `busy-message-dispatcher.mjs` / `harness-approval.mjs` / `command-catalog.mjs` → `dsh-im/src/channels/shared/`；
> `telegram-*.mjs`（含 `telegram-rich-message.mjs`）→ `dsh-im/src/channels/telegram/`；`command-menu-sync.test.mjs` → `dsh-im/test/channels/telegram/`。
> 调研快照：openclaw `c16b5166`、hermes-agent `851b389`、Memoh `2ebe076`、dsh-im `8ebef5c`（静态阅读，未跑 bot/测试）。
> 同目录的 `command-ux-audit.md` 是 dsh-im 内部命令审计（现状/差距）；本文件是上游模式与移植取舍，两者互补。
>
> 交叉核对基线 —— dsh-im **飞书**已有一整套卡片：
> `dsh-im/src/channels/feishu/feishu-cards.mjs` 的 `menuCard:136` / `presetCard:369` / `modelCard:422` /
> `statusCard:494` / `helpCard:628` / `sessionListCard:695` / `workspaceListCard:741` / `watchListCard:799` /
> `completionCard:827` / `steerCard:855` / `approvalCard:921` / `stepStreamCard:967` / `questionCard:1258`，
> 以及 `dsh-im/src/channels/feishu/bridge.mjs` 里按前缀分派的一整批 card action（任务描述记 47 个）。
> 每条模式都标注「飞书已有（引用位置）/ 飞书也没有」，并回答「该移植到 TG，还是连飞书也值得升级」。

---

## 0. 先看结论

**最值得移植到 Telegram 的 3 个模式**

| 排名 | 模式 | 为什么 | 飞书是否已有 |
| --- | --- | --- | --- |
| 1 | **审批卡 + 终态回执**（P8） | TG 现在只有文字「请回复批准/拒绝」，易误回、易错过、无终态；飞书已有现成卡与 resolvedText | ✅ `feishu-cards.mjs:921-946`、`bridge.mjs:6229-6274` |
| 2 | **主菜单 Hub 卡**（P3） | TG 只能靠记命令；飞书 `/m` 已有分区卡片 + 返回 | ✅ `feishu-cards.mjs:136-360`、`bridge.mjs:2913-2916` |
| 3 | **过程展示承载物：一回合一条过程消息**（P10） | TG 目前 thinking 每行发一条永久消息，长任务会刷屏；飞书 step 卡已证明更粗粒度更好 | ✅ `feishu-cards.mjs:967-1008`、`step-push-mode.mjs:1-14` |

**最值得从飞书移植到 TG 的 3 个命令**

| 命令 | 飞书现状 | TG 缺什么 |
| --- | --- | --- |
| `/m`（菜单卡） | `bridge.mjs:1842-1844` 打开 `menuCard` | TG 命令目录里**没有 menu/start 命令**（`command-catalog.mjs:25-105`），无任何入口卡 |
| `/sessionlist`（会话列表卡） | `feishu-cards.mjs:695-735`：每行「⭐关注 + 会话按钮」、分页、返回菜单 | TG 只有文字列表（共享命令），无按钮绑定会话 |
| `/status`（状态卡） | `feishu-cards.mjs:494-508`：连接/工作区/预设/模型/会话数 + 返回 | TG `/status` 只有一行「连接正常」类文本（`text-harness-bridge.mjs:1125-1128`） |

> 另外 `/help` 也值得一起做：飞书 `/help` 走文字、`helpCard` 只在菜单按钮里出现（两套实现），见 P12；TG 则完全没有卡片帮助。

**连飞书也值得升级的 3 个点**

| # | 问题 | 证据 |
| --- | --- | --- |
| 1 | 飞书原生命令面板同时注册了 `ws` 和 `workspace` 两个重复入口 | `dsh-im/src/channels/feishu/slash-command-panel.mjs:35,41` |
| 2 | 飞书 `/new`、`/clear` 是**直接执行、无二次确认**（只拦截运行中任务；`/stop` 不需要确认，属正常） | `dsh-im/src/channels/feishu/bridge.mjs:1846-1857`、`:3652-3665` |
| 3 | 飞书 `/help`、`/status` 都有「文字版 vs 卡片版」两套实现，容易文案漂移 | `bridge.mjs:1838-1841`（help 文本）vs `:3629-3635`（helpCard）；`:3549-3572`（status 文本）vs `:3574+`（statusCard） |

---

## 1. 原生命令菜单策略

### P1 · 菜单只留「一个入口」，别名隐藏但继续可用
**类别** 1 ｜ **结论** TG 已做对；**飞书值得升级**（重复入口） ｜ **工作量** S

**上游证据**
- openclaw 把别名排在菜单最后（超限先丢别名），并明确「隐藏 ≠ 不可调用」：
  ```ts
  // openclaw/extensions/telegram/src/bot-native-commands.ts:139-144
  ...nativeMenuCommands.filter((command) => !command.isAlias),
  ...(pluginCatalog.commands.filter((command) => !customCommandNames.has(command.command))),
  ...nativeMenuCommands.filter((command) => command.isAlias),
  ```
  ```ts
  // openclaw/extensions/telegram/src/bot-native-commands.ts:184
  // Telegram only limits menu entries; hidden commands remain callable.
  ```
- hermes 菜单生成按优先级取槽位：核心命令必留 → 插件 → skill 兜底（`hermes-agent/hermes_cli/commands.py:876-909`），
  并把被隐藏数量告诉用户去 `/commands`（`hermes-agent/gateway/platforms/telegram.py:1084-1089`）。
- Memoh 的菜单是**人工挑选的单 token 清单**，理由写在注释里：
  ```go
  // Memoh/internal/command/menu.go:14-16
  // Only single-token commands belong here — the native menu cannot express
  // sub-actions like "schedule list" (those are discovered via /help or
  // in-message buttons).
  ```

**dsh-im 核对**
- 飞书：`slash-command-panel.mjs` 的 manifest 同时登记 `ws`（`:35`）与 `workspace`（`:41`），都属于「工作区」入口 → **重复**；但面板有 `default/custom` 两种模式、`hidden ≠ disabled` 语义（`:73-75`）。
- Telegram：命令目录对 `workspacelist` 设 `menuVisible: false`（`command-catalog.mjs:51-53`），`workspace` 别名 `ws` 也隐藏（`:41-45`）→ 已收敛为单入口。

**移植要点**
1. 飞书面板删掉 manifest 里的 `ws`（保留 `workspace`，`/ws` 仍可手打）；顺带评估 `sessionlist`/`sessions` 等是否也有重复（manifest 只有 sessionlist，无重复）。
2. TG 侧把这条固化成测试（菜单只出现 `workspace`，但 `/ws`、`/wsl` 仍能 dispatch），防止以后加别名时漏 `menuVisible:false`。
3. 别名在 `/help` 里仍要展示（见 P12），不要因为菜单隐藏就在帮助里也消失。

**风险**：极低。唯一风险是用户习惯 `/ws` 出现在菜单里；用 `/help` 里的别名说明兜底。

---

### P2 · 菜单容量、本地化与同步：上限、预算、失败降级
**类别** 1 ｜ **结论** TG 需补「字符预算 + BOT_COMMANDS_TOO_MUCH 降级」；**飞书需补运行时本地化** ｜ **工作量** M

**上游证据**
- openclaw：100 条上限 + **5700 字符总预算** + 描述截断 + 超限丢弃尾部：
  ```ts
  // openclaw/extensions/telegram/src/bot-native-command-menu.ts:22-23
  const TELEGRAM_MAX_COMMANDS = 100;
  const TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET = 5700;
  ```
  ```ts
  // openclaw/extensions/telegram/src/bot-native-command-menu.ts:75
  if (commandNameChars + nameChars + commandCount + 1 > TELEGRAM_TOTAL_COMMAND_TEXT_BUDGET) break;
  ```
- openclaw 还处理 Telegram 的 `BOT_COMMANDS_TOO_MUCH`：识别后**退一半命令重试**，仍失败才留空菜单并打日志（`bot-native-command-menu.ts:101-102, 500-527`）。
- openclaw 菜单按 scope（默认 + `all_group_chats`）和 `language_code` 发布多语言变体（`bot-native-command-menu.ts:45, 325-357, 360-395`），并用内容 hash 去重避免重启打 429（`:416-424`）。
- hermes：命令名 1-32 字符、小写字母数字下划线；超长截断 + 冲突加数字后缀；描述截到 40 字符（`hermes-agent/hermes_cli/commands.py:685-714`、`gateway/platforms/telegram.py:1070-1096`）。注册失败只 warning、不影响通道启动。
- Memoh：注册 best-effort，且注释承认原生菜单**还没按 bot 语言本地化**（`Memoh/internal/channel/adapters/telegram/telegram.go:339-343`）。

**dsh-im 核对**
- 飞书：`MAX_SLASH_PANEL_COMMANDS = 100`（`slash-command-panel.mjs:87`）、每 bot 可自定义顺序（`:76-85`）；但 manifest 只有 `default`/`en_us` 两个描述字段（`:27-59`），**没有按 bot 当前语言下发**，也没有字符预算。
- Telegram：有 `validateTelegramCommands`（≤100、去重、格式校验，`telegram-api.mjs:139-145`）；菜单按当前语言生成并在语言切换时重发（`telegram-runtime.mjs:23-38`、测试 `command-menu-sync.test.mjs:120-188`）；**没有**总字符预算、没有 `BOT_COMMANDS_TOO_MUCH` 降级。
- 飞书面板由 `slash-command-registry.mjs` 调 app_slash_commands 接口同步（`:30-40`），已经是「服务端面板」而非 push，需按语言/顺序重建。

**移植要点**
1. TG 在 `commandMenuEntries` 之后增加「总字符预算」截断，复用 openclaw 的 5700 预算思路（Telegram 未文档化，但保守值可防 `BOT_COMMANDS_TOO_MUCH`）。
2. 捕获 `BOT_COMMANDS_TOO_MUCH`：命令数减半重试一次，再失败则空菜单 + 警告日志，不阻塞连接。
3. 飞书：面板描述按 bot 当前语言（zh/en/ja）选择 `default`/`en_us` 之外的字段，或按当前语言只注册一份；顺序重建时保持幂等（已有 `slash-command-registry.mjs` 的批量重建能力）。
4. 两边共用「菜单内容 hash → 仅在变化时同步」的思路（dsh-im TG 已有语言切换重发；补 hash 去重可减少 429）。

**风险**：中低。Telegram 的真实 payload 上限是未文档化经验值（openclaw 5700 就是保守估算），截断策略可能误伤描述可读性；飞书面板重建属于服务端写操作，需避免频繁重建触发限流。

---

## 2. 内联键盘导航

### P3 · 主菜单 Hub 卡：分区 → 子页 → 返回
**类别** 2 ｜ **结论** **移植到 TG**（从飞书 menuCard 简化），飞书已有 ｜ **工作量** M

**上游证据**
- openclaw / hermes 都**没有**真正的主菜单卡；它们的导航只存在于选择器内部（`<< Back` / `Browse providers`）：
  ```ts
  // openclaw/extensions/telegram/src/model-buttons.ts:238-244
  rows.push([{ text: "<< Back", callback_data: CALLBACK_PREFIX.back }]);
  ...
  return [[{ text: "Browse providers", callback_data: CALLBACK_PREFIX.providers }]];
  ```
- Memoh 最接近「菜单 = 按钮」：`/help <group>` 把子动作渲染成按钮，并加「返回该组默认内容」的 Back：
  ```go
  // Memoh/internal/command/registry.go:163-166, 204-224
  // GroupHelpResult returns an interactive version of GroupHelp: each sub-action
  // is a tappable button that dispatches "/{group} {action}" in place, plus a
  // "◀ Back" button that returns to the group's default content view. ...
  back := group.DefaultAction
  if back == "" { back = "list" }
  choices = append(choices, ListItem{Label: t.T("cmd.help.backToGroup", ...),
      Action: &ItemAction{Resource: group.Name, Action: back}})
  ```
- Memoh 的按钮重放机制让「菜单→分区」不需要服务端状态：按钮就是 `/group action` 的合成命令（`Memoh/internal/command/callback.go:233-260`）。

**dsh-im 核对**
- 飞书已有强得多的实现：`menuCard`（`feishu-cards.mjs:136-360`）分「设置 / 任务控制 / 补充指令 / 底部」四区，带 4 个下拉（会话/工作区/预设/模型）+ 新会话、会话列表、停止、压缩、清空、归档、状态、帮助；菜单类子卡（会话/工作区/预设/模型/状态/帮助/关注/补充指令）都有 `backButton()`（`:111`）→ `back_to_menu`（`bridge.mjs:2913-2916`）。
- Telegram：**没有 Hub**。只有两类卡：问题卡（`telegram-bridge.mjs:47-77`）与工作区卡（`:108-126`），其余命令全是文字。

**移植要点**
1. TG 版 `/m`（或 `/menu`）发一张「助手中心」卡，但不强求对齐飞书的下拉：TG 没有 select，用**分区行**表达——
   - 第一行：`📋 会话列表` / `🗂 工作区`
   - 第二行：`🤖 预设` / `🧠 模型`
   - 第三行：`⏹ 停止` / `📐 压缩` / `🧹 清空`
   - 第四行：`📊 状态` / `📖 帮助` / `🔙 收起`
2. 每个按钮回调复用现有命令（合成 `/sessionlist`、`/ws`、`/presetlist`…），卡片只是「可点的命令面板」；不要在回调里重写业务逻辑。
3. 子卡（会话列表/模型列表/帮助…）统一带 `🔙 返回菜单`；返回时**编辑同一条消息**（`editMessageText` + 新 markup），而不是新发（Memoh 的 `edit_message_id` 模式，见上一份 brief §3.4）。
4. 由于 TG 键盘不能像飞书那样塞下拉，Hub 卡要控制行数（建议 ≤8 行）；更多入口放二级页/`/help`。
5. 与现有工作区卡保持一致：`updateInteractionCard` 只换 markup（`telegram-runtime.mjs:624-632`），正文保持无状态。

**风险**：中。Hub 卡会引入「回调命名空间 + 过期语义 + 权限闸门」三件套（可复用工作区卡已有实现）；按钮与命令双入口会造成文案/行为漂移，必须让按钮复用命令，而不是另写一套。

---

### P4 · 两级选择器：列表 drill-down + 返回/取消
**类别** 2 ｜ **结论** **移植到 TG**；飞书用下拉，不需要 ｜ **工作量** M

**上游证据**
- openclaw 的 model picker 是标准两层：providers → list(provider,page) → select，任意层都能退回：
  ```ts
  // openclaw/extensions/telegram/src/model-buttons.ts:1-12
  * - mdl_prov              - show providers list
  * - mdl_list_{prov}_{pg}  - show models for provider (page N, 1-indexed)
  * - mdl_sel_{provider/id} - select model (standard)
  * - mdl_back              - back to providers list
  ```
  入口/返回的渲染在 `openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:451-505`（providers 层 `Select a provider:`，model 层 `Select a model:`）。
- hermes 的 picker 同样两层，且每层底部固定 `Back / Cancel`：
  ```python
  # hermes-agent/gateway/platforms/telegram.py:1692-1695
  rows.append([
      InlineKeyboardButton("◀ Back", callback_data="mb"),
      InlineKeyboardButton("✗ Cancel", callback_data="mx"),
  ])
  ```
- Memoh 的 provider 层用两列、`●` 标出「当前模型所属 provider」；模型层每行一个、`✓` 标当前；两层都能回 providers / 关闭：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:476-486
  if p.Level == command.LevelModels {
      actions = append(actions, channel.Action{Type: actionTypeCallback,
          Label: t.T("chrome.providers"), Value: command.EncodeListCallback("model", "list", nil, 0), Row: row})
  }
  actions = append(actions, channel.Action{Type: actionTypeCallback, Label: t.T("chrome.close"),
      Value: command.DismissCallback(), Row: row})
  ```

**dsh-im 核对**
- 飞书：`presetCard:369`、`modelCard:422` 用 `select_static` 下拉（`/preset`、`/model` 的选中即切换），`menuCard` 也是下拉——飞书不需要 drill-down，**不要照搬两层键盘**。
- Telegram：只有「工作区」有选择器卡，`/sessionlist`、`/models`、`/presetlist` 都是文字 + 序号命令（共享命令目录），没有可点列表。

**移植要点**
1. 优先把**会话列表**做成两级（工作区 → 会话页）或单级分页；`/session` 的绑定动作直接复用。
2. 模型/预设如果条目多，做 provider/preset 组 → 条目页；条目少就直接单页（Memoh 的 `pickerProviderIndex`：单 provider 时自动跳过第一层，`Memoh/internal/command/model_picker.go:199-207`）。
3. 回调只带「层 + 绝对索引 + 页码」，实际对象在点击时用**实时列表**复核（上一份 brief R1 的教训）。
4. 每个子页固定底行：`🔙 返回` + `✖ 关闭`；关闭 = 清键盘或收成标题（P6）。

**风险**：中。多级状态需要「当前层」进回调数据/缓存；与已有工作区卡的 nonce 机制要么统一，要么明确分工，避免两套过期语义。

---

### P5 · 列表键盘三件套：分页、页码 noop、当前项标记 + 布局规则
**类别** 2 ｜ **结论** **移植到 TG**；飞书已有会话分页，其余不必改 ｜ **工作量** S

**上游证据**
- 分页行统一三件：Prev / 「页码」无操作按钮 / Next；页码按钮需要 callback_data 但不能有副作用：
  ```ts
  // openclaw/extensions/telegram/src/model-buttons.ts:180-191
  return [
    { page: currentPage - 1, text: "◀ Prev", show: currentPage > 1 },
    { page: null, text: `${currentPage}/${totalPages}`, show: true },
    { page: currentPage + 1, text: "Next ▶", show: currentPage < totalPages },
  ].filter(({ show }) => show).map(({ page, text }) => ({ text, callback_data: callbackData(page) }));
  ```
  `openclaw/extensions/telegram/src/command-ui.ts:18-31` 用 `commands_page_noop` 表达同一个意思。
- hermes：8 条/页、页码按钮 `mx:noop`、当前项在 provider 层用 `✓` 前缀（`hermes-agent/gateway/platforms/telegram.py:1683-1690, 1613-1614`）。
- Memoh：列表/选择器统一 `✓` 前缀；分页按钮用 `NoopCallback()`；**页码越界要 clamp**（旧键盘在列表变短后会点出 `11/3`）：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:265-270
  // A stale callback from a keyboard captured before the list shrunk ... would
  // otherwise emit a broken nav row — "11/3" counter, Prev encoding a Page-1
  // jump backward into nowhere — and Next would silently vanish.
  ```
- 布局：provider/短选项两列（`openclaw/extensions/telegram/src/model-buttons.ts:169-177`、`Memoh/internal/channel/inbound/result_render.go:408-434`），长条目一行一个（`Memoh/internal/channel/inbound/result_render.go:435-453`）；标签截断 38（openclaw）或 60/40 rune（Memoh）。

**dsh-im 核对**
- 飞书：`sessionListCard:695-735` 已有上一页/下一页（`:728-729`），行内「⭐关注 + 会话按钮」双列布局，当前页编号用于数字兜底；不需要页码 noop（飞书按钮无回调也能显示）。
- Telegram：工作区卡有 `✓` 当前项 + 20 个上限，但**没有分页**（超 20 降级文字列表，`telegram-bridge.mjs:78-83`）；会话/模型/预设均无卡片。

**移植要点**
1. 分出「分页列表」通用渲染：title + N 行条目 + 一行 `◀ 上一页 / x/y(noop) / 下一页 ▶` + `🔙`。
2. 页码按钮必须给一个 noop 回调（否则 Telegram 支持显示，但会与其他回调冲突；统一 `noop` 命名空间）。
3. 当前项统一 `✓ ` 前缀（单选）或 `●`（层级归属）；按钮 label 截到 ~38 字符，序号另起。
4. 渲染前用实时列表 clamp 页码；越界时回「第 X 页不存在，已显示第 Y 页」而不是空白。
5. 布局：短选项两列（工作区/预设），长会话名一行一个；每页 8-10 条（上游三家一致）。

**风险**：低。主要是 label 截断与 i18n 长度（中文按钮长度差异），需要按码点截断而非字节。

---

### P6 · 卡片终态收尾：关闭 / 收起 / 取消回执
**类别** 2+3 ｜ **结论** **移植到 TG**；飞书可顺手加「关闭」（目前只有返回） ｜ **工作量** S

**上游证据**
- Memoh 的「关闭」不是删消息，而是收成标题行 + 去键盘（保留面包屑）：
  ```go
  // Memoh/internal/channel/adapters/telegram/telegram.go:612-621
  // Close: collapse the card to its title line and drop the keyboard,
  // rather than deleting the whole message — the user keeps a short
  // breadcrumb of what was opened instead of having it vanish.
  if title := collapseToTitle(cb.Message.Text); title != "" {
      _ = editTelegramMessageText(bot, cb.Message.Chat.ID, cb.Message.ID, title, "")
  }
  ```
- hermes 的 Cancel 会把消息正文改成终态并移除键盘：
  ```python
  # hermes-agent/gateway/platforms/telegram.py:1866-1872
  elif data == "mx":
      # --- Cancel ---
      self._model_picker_state.pop(chat_id, None)
      await query.edit_message_text(text="Model selection cancelled.", reply_markup=None)
  ```
- openclaw 的终态一律 `reply_markup: { inline_keyboard: [] }` 清键盘（`openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:122-131`）。

**dsh-im 核对**
- 飞书：菜单类子卡有 `🔙 返回菜单`（`feishu-cards.mjs:111`），但**没有关闭/收起**；返回是替换成菜单卡，不是终态。
- Telegram：问题卡答完后会「retire 键盘」（`text-harness-bridge.mjs:1791-1803`）；工作区卡没有关闭/收起；没有通用「收成标题」能力。

**移植要点**
1. 给 Hub/子卡加 `🔙 返回` + `✖ 收起`；收起 = `editMessageText(第一行标题, reply_markup: 空)`，失败就只清键盘。
2. 取消类动作要有**明确回执文案**（「已取消」），不要静默删键盘。
3. 终态收尾与「过期失效」区分：取消是用户主动 → 收成标题；过期是卡片失效 → 见 P14。
4. 飞书可给帮助/状态/列表卡加「收起」按钮（删除卡片或折叠为一行），目前只能到 `back_to_menu`。

**风险**：低。Telegram `editMessageText` 对媒体消息不可用，需像 openclaw 一样降级为「只清键盘」。

---

## 3. 破坏性确认与审批

### P7 · 破坏性操作二次确认：确认 = 重放带 `--confirm` 的命令
**类别** 3 ｜ **结论** **TG 与飞书都值得升级**（两边目前都直接执行 `/new`、`/clear`） ｜ **工作量** M

**上游证据**
- Memoh 对 `/new` 做按钮确认：Confirm 重放 `/new <mode> --confirm`，Cancel = dismiss；无按钮渠道保持直接执行：
  ```go
  // Memoh/internal/channel/inbound/channel.go:4235-4243
  // /new discards history, so on button-capable channels gate it behind a
  // Confirm/Cancel keyboard. Tapping Confirm re-dispatches "/new <mode>
  // --confirm" ... Non-button channels reset immediately (unchanged).
  if caps.Buttons && !newCommandConfirmedParsed(parsed) {
      return p.sendNewConfirmation(ctx, msg, sender, loc, modeText, modeLabel, caps)
  }
  ```
  确认卡本体与 Cancel 语义：
  ```go
  // Memoh/internal/channel/inbound/channel.go:4883-4899
  // Confirm carries a callback that re-dispatches "/new <mode> --confirm";
  // Cancel dismisses (deletes) the prompt.
  {Type: actionTypeCallback, Label: loc.T("newSession.action.confirm"), Value: command.EncodeConfirmNewCallback(modeText), Row: 0},
  {Type: actionTypeCallback, Label: loc.T("newSession.action.cancel"), Value: command.DismissCallback(), Row: 0},
  ```
- hermes 有通用「昂贵命令确认」原语：三按钮（Approve Once / Always Approve / Cancel）、300 秒超时、新确认顶掉旧确认、**先注册再发消息**避免「快点点中」竞态：
  ```python
  # hermes-agent/gateway/run.py:10076-10078
  # Register the pending confirm FIRST so a super-fast button click
  # cannot race the send_slash_confirm return.
  _slash_confirm_mod.register(session_key, confirm_id, command, handler)
  ```
  ```python
  # hermes-agent/tools/slash_confirm.py:9-20（无按钮渠道走 /approve、/always、/cancel 文本兜底）
  # 1. Button UI — adapters that override ``send_slash_confirm`` render
  #    three inline buttons (Approve Once / Always Approve / Cancel).
  # 2. Text fallback — adapters without button UIs get a plain text prompt.
  ```
  按钮渲染见 `hermes-agent/gateway/platforms/telegram.py:1554-1561`。
- openclaw 的破坏性安全主要走 approval（危险命令），**没有**给 `/new`/`/reset` 做按钮确认（`openclaw/extensions/telegram/src/approval-handler.runtime.ts:90-114` 是审批卡，不是 reset 确认）。

**dsh-im 核对**
- 飞书：`/new` 直接清会话 + 回菜单卡，仅提前拦截运行中任务（`bridge.mjs:1846-1857`）；卡片上的「清空」「停止」也是直接执行（`:3652-3689`）。**没有确认**。
- Telegram：`/new`、`/clear` 也是直接执行（共享命令路径），无确认。

**移植要点**
1. 先只给**最不可逆**的 `/new`（清历史）和 `/clear`（清上下文）加确认；`/stop` 不需要确认（停止是安全方向）。
2. TG 实现照 Memoh：确认卡 = 文本 + `✅ 确认 / ✖ 取消`；确认回调重放 `/new --confirm`（或内部 `confirmToken`），**不要**在回调里直接调业务；取消回调 = `dismiss`（收成标题/删提示）。
3. 确认卡带 TTL + 一次性 token；重复点确认 = 幂等（已执行则回「已开启新会话」）。
4. 飞书同样在 `#handleNewSessionMenu` 前加确认卡（或复用 `questionCard` 的 answer 机制），确认后仍走现有执行路径。
5. 高风险场景（有运行中任务/未绑定会话）在确认卡正文里写清楚将丢失什么。

**风险**：中。多一步点击可能让高频用户反感；确认卡本身会引入「过期/重复/越权」问题，需要按 P14/P15 的规则处理。建议先只给 `/new`，观察再扩到 `/clear`。

---

### P8 · 审批卡：Approve/Deny 按钮 + 终态回执 + 首答胜出
**类别** 3 ｜ **结论** **移植到 TG**（从飞书移植，吸收上游终态/并发细节）；飞书已有 ｜ **工作量** L

**上游证据**
- openclaw 的审批卡：正文含操作摘要/agent/剩余时间，按钮是 typed 审批动作，可选「Review in Control UI」深链：
  ```ts
  // openclaw/extensions/telegram/src/approval-handler.runtime.ts:92-97, 109-115
  const lines = ["🔒 OpenClaw change requires approval",
    `Change: ${view.operationSummary}`, `Agent: ${view.agentId ?? "unknown"}`,
    `Expires in: ${formatExecApprovalExpiresIn(params.request.expiresAtMs, params.nowMs)}`];
  ...
  buttons: reviewUrl ? [[{ text: "Review in Control UI", url: reviewUrl }], ...buttons] : buttons,
  ```
  终态：首答胜出（canonical owner 返回 `applied:false`），输家也要清按钮；编辑失败退化为「发一条终态消息」：
  ```ts
  // openclaw/extensions/telegram/src/bot-handlers.callback-router-controls.ts:105-109, 122-131
  // First-answer-wins returns applied:false to losing surfaces. Their controls
  // are stale too, so cleanup follows canonical terminal truth, not local authorship.
  ```
- hermes 审批按钮四选一（Once / Session / Always / Deny），点击后 `pop` state 实现首答胜出，并把原消息改成回执：
  ```python
  # hermes-agent/gateway/platforms/telegram.py:1924-1927, 1939-1947
  session_key = self._approval_state.pop(approval_id, None)
  if not session_key:
      await query.answer(text="This approval has already been resolved.")
      return
  ...
  await query.answer(text=label)
  await query.edit_message_text(text=f"{label} by {user_display}", reply_markup=None)
  ```
- Memoh 审批提示同时提供按钮与文本兜底（`/approve <id>`），按钮回调走合成命令；决定后清键盘：
  ```go
  // Memoh/internal/channel/tool_approval_prompt.go:24-38
  "Tool approval required #%d\nTool: %s%s\nInput: %s\n\nApprove with /approve %d or reply to this message with /approve."
  ...
  {Type: ActionTypeToolApproval, Label: "Approve", Value: ActionApprove + ":" + req.ID},
  {Type: ActionTypeToolApproval, Label: "Reject", Value: ActionReject + ":" + req.ID},
  ```

**dsh-im 核对**
- 飞书已有：`approvalCard`（`feishu-cards.mjs:921-946`）批准/拒绝按钮 + `resolvedText` 终态；`bridge.mjs` 收到 `approve:/reject:` 时按 actor 提交并在原卡上 patch 终态（`:2691-2702, 6229-6274`），卡片发送失败回退文字审批（`:6254-6260`）。
- Telegram：**只有文字审批**——「请精准回复「批准」或「拒绝」…」，60 分钟超时（`harness-approval.mjs:19-24`、`:467-500`），没有按钮卡、没有原消息终态回执。

**移植要点**
1. 在 TG 增加 `approvalCard` 等价物：正文 = 工具名/操作/原因/剩余时间，按钮 = `✅ 批准` / `❌ 拒绝`（可加 `🔒 本会话总是允许`，若 Harness 支持）。
2. 回调命名空间独立（如 `a1|`），数据只带 approvalId + 决策；点击后在原消息上 `editMessageText` 成回执并清键盘（成功/拒绝/已过期/已被他人处理 四种文案）。
3. 并发与权限：actor 必须是审批目标会话的授权用户；首答胜出（后续点击 toast「该审批已处理」）；超时后点击 toast「已超时，已自动拒绝」。
4. 文字回复审批保留为兜底（旧消息/无按钮场景），但按钮命中时不要再让文字重复提交（点击后立即把 pending 标记为 submitting）。
5. 复用现有 `HarnessApprovalQueue` 的 `onResolved` 钩子做卡片 patch，避免第二套审批状态机。

**风险**：高。审批是安全边界：回调必须做权限校验、actor 绑定、终态幂等；卡片编辑失败要能降级（openclaw 的 terminalize 三级降级可直接抄）；还要防止「旧审批卡」被误点（带 approvalId 复核 + 过期 toast）。

---

## 4. 进度 / 状态 UX

### P9 · 单消息进度编辑：节流、去重、429 背压、终态重试
**类别** 4 ｜ **结论** TG 需补「429 退避 + 终态重试」；飞书已领先 ｜ **工作量** S

**上游证据**
- hermes 的流式编辑参数与自适应退避：1s 间隔、40 字符缓冲、`▉` 光标、跳过未变化内容；连续 flood-control 时**编辑间隔翻倍（上限 10s）**，超过次数则禁用编辑并退化为「最终只补尾巴」：
  ```python
  # hermes-agent/gateway/stream_consumer.py:43-45
  edit_interval: float = 1.0
  buffer_threshold: int = 40
  cursor: str = " ▉"
  ```
  ```python
  # hermes-agent/gateway/stream_consumer.py:943-947
  if self._is_flood_error(result):
      self._flood_strikes += 1
      self._current_edit_interval = min(self._current_edit_interval * 2, 10.0)
  ```
- openclaw：一条预览消息、`editMessageText` 前进、首段 debounce、超 4096 字符拆续条（`openclaw/extensions/telegram/AGENTS.md:61-73`、`draft-stream-message.ts:79-110`）。
- Memoh：5s 节流 + 未变化跳过 + 429 按 `retry_after` 回退；**终态编辑重试 5 次**，`not modified` 视为成功：
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:201-202
  // not-modified means the message already shows this text — treat as done.
  if editErr == nil || isTelegramMessageNotModified(editErr) { ... }
  ```
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:21-24
  telegramStreamEditThrottle  = 5000 * time.Millisecond
  telegramStreamPendingSuffix = "\n……"
  ```

**dsh-im 核对**
- 飞书：`stepStreamCard` 有 24KB/表格数上限、卡片 patch（`feishu-cards.mjs:954, 1220-1256`），更新失败有 `#patchCardMessage` 降级；无需 TG 的 429 文本编辑问题。
- Telegram：`editable-message-stream.mjs:19-52` 已有 800ms 间隔、跳过相同文本、单飞（in-flight 不排队）；但 429 只被 `telegram-api.mjs:478-482` 记录成 `error.retry_after`，**流式层没有退避/重试**，编辑失败只 warn（`:44-46`）。

**移植要点**
1. `editable-message-stream` 捕获带 `retryAfter` 的错误：本帧直接丢弃（下帧会带全量文本），把 `updateIntervalMs` 指数放大（上限 10s），成功后恢复。
2. 终态 `finish()` 单独走「重试 N 次 + not modified 视为成功 + 仍失败则改发新消息」，别把最终答案静默丢在失败的 edit 里。
3. 续条逻辑沿用现有 4000 字符拆分（`telegram-rich-message.mjs:1-2`），流式首帧用「正在处理…」占位。
4. 飞书不需要改；可把「429 退避」经验复用到其它文本渠道的流式层（共享 `editable-message-stream` 正是该层）。

**风险**：低。退避参数需压测（Telegram 对本 bot 的 429 是按 token 全局的，编辑失败不代表发送失败）；终态重试要防重复发答案（先检查消息是否已含最终文本）。

---

### P10 · 过程展示的承载物：一回合一条「过程消息」，而不是一行一条
**类别** 4 ｜ **结论** **TG 升级**；飞书已是最佳实践（无需改） ｜ **工作量** M

**上游证据**
- 飞书把过程折叠进一张卡：running 时展开工具/思考面板，完成时收起成「📋 过程详情」+ 状态行；超限拆「sealed」卡：
  ```js
  // dsh-im/src/channels/feishu/feishu-cards.mjs:960-964
  // status: 'running' uses the configured panel expansion and ends with an italic status
  // line; 'completed' / 'stopped' collapse the panels and swap the status text;
  // 'sealed' is an overflow spill chunk with no status line at all.
  ```
  推送模式可配：`post / streaming_card / live_cot`（`dsh-im/src/channels/feishu/step-push-mode.mjs:1-14`）。
- Memoh：**每个工具调用一条消息**，`tool_call_start` 发消息、`tool_call_end` 编辑同一条把状态翻成 completed/failed；需要审批时在该工具消息上挂按钮：
  ```go
  // Memoh/internal/channel/adapters/telegram/stream.go:457-461
  // sendToolCallMessage renders the tool-call presentation. For tool_call_start
  // it posts a new message and records the callID→message mapping. For
  // tool_call_end it edits the previously-posted message to flip the status to
  // completed/failed.
  ```
- openclaw：一条预览消息承载 token 流 + 工具/计划行，预算内**优先保留失败/审批/阻塞行**：
  ```ts
  // openclaw/extensions/telegram/src/progress-draft-preview.ts:30-33
  return (line.kind === "approval" || status === "failed" || status === "error" || status === "blocked");
  ```
- hermes：工具边界会**结束当前段**，后续文本发在新气泡里（避免答案被夹在工具进度中间），思考块默认过滤：
  ```python
  # hermes-agent/gateway/stream_consumer.py:178-184
  # When *text* is ``None``, signals a tool boundary: the current message
  # is finalized and subsequent text will be sent as a new message so it
  # appears below any tool-progress messages the gateway sent in between.
  ```

**dsh-im 核对**
- 飞书：`stepStreamCard` 已是「一回合一张卡 + 折叠面板」，领先。
- Telegram：`openThinkingStream` 的注释写得很清楚——**每个中间行都是一条永久消息**（`telegram-runtime.mjs:964-1023`），`sendThinking`/`sendToolTrace` 逐行 `sendMessage`。长任务会刷屏，且最终答案与思考行混在一起。

**移植要点**
1. TG 改为「一个 turn 一条过程消息」的最小版：一行状态（`⚙️ 正在执行…`）+ 最近 N 条摘要（工具名/结果），编辑同一条消息；turn 结束后改成「✅ 完成（X 次工具调用）」，或收成标题。
2. 可选中间档：每个工具调用一条消息（Memoh 模式），start→end 编辑同一条；推理行不单独发，合并进该工具行或按阈值采样。
3. 保留 openclaw 的「优先级」：失败/审批/阻塞行永远保留，普通行超预算先丢。
4. 答案正文走现有 `openDeliveryStream`/rich 流；过程消息与答案消息**分开两条**，答案不被工具进度挤压（hermes 的 segment break 思路）。
5. 给用户留开关（复用现有 `thinkingTraces` 配置），别强制所有人看过程。

**风险**：中。会改变现有 thinking-trace 用户的观感（少消息但信息密度高）；编辑一条长消息在 4096 字符上限下需要截断策略；与 rich message 30k 上限的取舍。

---

### P11 · 忙碌/排队/steer 的用户反馈：状态明细 + 去抖 + 一次性提示
**类别** 4 ｜ **结论** 共享层补「状态明细 + 一次性提示」；TG/飞书同步受益 ｜ **工作量** S

**上游证据**
- hermes 的 busy 输入三模式（interrupt / queue / steer），回执里带**运行状态**（已运行分钟数、第几轮、当前工具），30 秒去抖，且第一次给出一次性提示：
  ```python
  # hermes-agent/gateway/run.py:2175-2183
  # Debounce: only send an acknowledgment once every 30 seconds per session
  _BUSY_ACK_COOLDOWN = 30
  ...
  last_ack = self._busy_ack_ts.get(session_key, 0)
  if now - last_ack < _BUSY_ACK_COOLDOWN:
  ```
  ```python
  # hermes-agent/gateway/run.py:2195-2201（状态明细）
  status_parts.append(f"{elapsed_min} min elapsed")
  status_parts.append(f"iteration {iteration}/{max_iter}")
  status_parts.append(f"running: {current_tool}")
  ```
  第一次的提示文案与「只出现一次」的持久化 flag 在 `hermes-agent/agent/onboarding.py:1-70`。
- Memoh 的 `/new` 确认与欢迎语会在组里追加一次「群聊要 /command@bot」提示（`Memoh/internal/channel/inbound/result_render.go:128-132`）。

**dsh-im 核对**
- 飞书：运行中拦截只回一句「当前任务仍在运行…」（`bridge.mjs:1846-1853`）；菜单卡 `new` 有 processing/success/failed 三态与禁用按钮（`feishu-cards.mjs:158-168, 296-301`）。
- Telegram / 共享层：已有 **queue/steer 回执**——「已排队，等待前序消息处理。」「已提交补充指令，Agent 会在下一步读取。」（`busy-message-dispatcher.mjs:45, :64`），但**没有**运行时长/轮次/当前工具，也没有一次性提示。

**移植要点**
1. 在 `busy-message-dispatcher` 的排队/steer 回执里追加可选状态明细（来自 harness 的 turn 状态），30s 去抖（同一会话只更新/只发一次）。
2. 给「queue/steer/interrupt」首次触发加一次性提示（flag 持久化在 bot 配置，重启不重复），文案说明如何切换模式。
3. 失败/被停止时明确回执（不要只清 reaction）。
4. TG 与飞书共用该模块，一处改动双端生效；卡片类的处理中状态（飞书 menuCard 的 processing 禁用按钮）作为 TG Hub 卡的实现参考。

**风险**：低-中。状态明细可能暴露内部细节（轮次/工具名），需要裁剪；去抖逻辑若按会话而非用户，多人群聊需按发言人区分。

---

## 5. 帮助与可发现性

### P12 · 帮助分层：`/help` 短表、`/commands` 全量、分组按钮 + 返回
**类别** 5 ｜ **结论** **TG 做卡片化 help hub**；**飞书统一 `/help` 与 helpCard 两套实现** ｜ **工作量** M

**上游证据**
- openclaw 三层：`/help` 人工短表（按 Session/Options/Status/Skills 分组，结尾指向 `/commands`、`/tools`）→ `/commands` 全量分页（8/页，别名括号展示）→ `/tools` 能力清单：
  ```ts
  // openclaw/src/auto-reply/command-status-builders.ts:56-58
  "More: /commands for full list, /tools for available capabilities",
  ```
  ```ts
  // openclaw/src/auto-reply/command-status-builders.ts:79-83
  const aliasLabel = aliases.length ? ` (${aliases.join(", ")})` : "";
  const scopeLabel = command.scope === "text" ? " [text]" : "";
  return `${primary}${aliasLabel}${scopeLabel} - ${command.description}`;
  ```
- hermes 的 `/help` 列命令 + 技能（只列前 10 个并指向 `/commands` 分页），`/commands [page]` 自己带上一页/下一页的可复制命令（`hermes-agent/gateway/run.py:7357-7380, 7382-7433`）。
- Memoh 是最完整的「帮助即导航」：
  ```go
  // Memoh/internal/command/handler.go:476-487
  // /help (and its alias /commands)
  case parsed.Action == "":
      return &Result{Text: h.registry.GlobalHelp(cc.L, input.CommandTarget)}, nil
  case len(parsed.Args) == 0:
      return h.registry.GroupHelpResult(parsed.Action, cc.L), nil
  default:
      return &Result{Text: h.registry.ActionHelp(parsed.Action, parsed.Args[0], cc.L)}, nil
  ```
  `/help <group>` 是按钮列表（点击 = `/group action`），每项带一句说明；`/help <group> <action>` 是单个动作的用法页。

**dsh-im 核对**
- 飞书：`/help` 发**纯文本** `menuHelpText()`（`bridge.mjs:1838-1841`、`feishu-cards.mjs:517-566`）；`helpCard` 只在菜单的「帮助」按钮里打开（`bridge.mjs:3629-3635`、`feishu-cards.mjs:628-649`）——**同一功能两套实现**，且 helpCard 没有按分区分组（只有功能简介 + 命令清单 + 数字兜底 + 返回）。
- Telegram：`/help` 一行机器连接提示 + `commandHelpLines` 平铺（`text-harness-bridge.mjs:1116-1122`），没有分组、没有按钮、没有「更多」入口。
- 两边的命令目录是同一份 `SHARED_COMMAND_CATALOG`（23 条，`command-catalog.mjs:25-105`），适合从同一数据生成帮助结构。

**移植要点**
1. TG `/help` 发一张「帮助 hub」卡：按现有 help 分组（会话 / 任务控制 / 配置 / 系统）各一行按钮 → 点击进入分组清单（按钮 = 对应命令，点击等于发送该命令）→ 底行 `🔙 返回`；过长分组分页。
2. 飞书：让 `/help` 也走 `helpCard`（或把 `menuHelpText` 收敛成 `helpCard` 的文本降级），并在 helpCard 里加「分区按钮」（可复用 `questionCard` 的 answer 机制或新增 help action）。
3. 帮助卡的数据源统一为 `command-catalog`（命令名/描述/别名/用法），避免手写两套文案。
4. 短表 vs 全量：`/help` 只放最常用 + 「更多命令」按钮；完整清单仍可用 `/commands`（可考虑给 TG 加 `/commands`，用 P5 的分页列表卡）。
5. 别名在帮助里展示（如 `workspace (ws, wsl)`），与 P1 的「菜单隐藏」互补。

**风险**：中。帮助卡按钮本质是「发送命令」，要保证权限闸门与文字路径一致（card action = command）；分组是产品信息架构决策，需要和命令目录维护者约定。

---

### P13 · 文本/群聊可发现性：可键入提示 + `/cmd@bot` 引用
**类别** 5 ｜ **结论** TG/共享层补文本兜底提示；飞书不需要 ｜ **工作量** S

**上游证据**
- Memoh 为「无按钮渠道」从交互数据**自动派生**可键入提示（含动词、参数引号处理，保证复制粘贴能重新解析）：
  ```go
  // Memoh/internal/command/fallback.go:43-50
  // Args containing whitespace are double-quoted so a copy-pasted hint
  // round-trips through Parse()/tokenize() back to the same intent. ...
  func formatSlashCommand(resource, action string, args []string, quote bool) string {
  ```
  ```go
  // Memoh/internal/command/fallback.go:105-120（按 Interactive 类型派生）
  func FallbackTrailer(iv *Interactive, t *i18n.Localizer) string {
      switch iv.Kind {
      case InteractiveList: return trailerForList(iv.List, t)
  ```
- openclaw 的文本回退直接写「Use: /models <provider> / Switch: /model <provider/model>」（`openclaw/src/auto-reply/reply/commands-models.ts:249-258`）。
- Memoh 在 Telegram 群聊里把命令引用写成 `/cmd@botname`（`CommandText` 自动加 @），并只在群聊追加一次说明：
  ```go
  // Memoh/internal/command/humanize.go:131-140
  if username != "" && !strings.Contains(parts[0], "@") {
      parts[0] += "@" + username
  }
  ```
  ```go
  // Memoh/internal/command/humanize.go:143-154
  // TelegramGroupCommandTip explains the one transport-specific rule users need
  // when typing commands manually. Command lists stay visually clean; the bot
  // username appears once in this complete, copyable example.
  ```

**dsh-im 核对**
- 飞书：全程卡片，无需文本提示；`menuHelpText` 的「数字兜底」是另一种可发现性（已覆盖）。
- Telegram：`/help` 的 `commandHelpLines` 直接平铺 `/cmd`，没有 `@bot` 后缀；群聊里用户手动输入可能没反应（TG 群隐私模式要求 `@bot`）。卡片发送失败时回退文字列表（工作区卡已做），但没有「也可以点按钮/发命令」的提示。
- TG 的 `mentionedUsername` 只用于判断是否被 @（`telegram-runtime.mjs:47-53`），不生成提示。

**移植要点**
1. 在 TG 的 `/help`、`/start`、欢迎语、群聊首个命令响应里，命令引用统一带 `@botname`（仅群聊），并只出现一次「群聊请 @我」的说明。
2. `commandHelpLines` 增加 `botUsername` 参数，从 descriptor/bot 信息注入；私聊不加。
3. 卡片降级为文字时，追加「点不了按钮也可以发：/ws 2」这类可复制提示（从同一数据派生，勿手写）。
4. 复制友好：命令引用用 code span（Memoh 的 `CmdRef` 思路），中文括号/全角字符不要混入命令本身。

**风险**：低。群聊 @bot 提示若每条都出现会很吵，必须只出现一次（欢迎语/首条帮助）。

---

## 6. 错误与边界

### P14 · 过期卡片/死键盘：统一话术 + 重开引导 + 清键盘
**类别** 6 ｜ **结论** **移植到 TG**；飞书已有 ｜ **工作量** S

**上游证据**
- openclaw 对无效/过期 typed callback 统一「清键盘 + 一句不可用」，不静默：
  ```ts
  // openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:215-219
  const terminalizeUnavailableCallback = async () => {
    logVerbose("telegram: typed callback unavailable (handler missing or payload invalid)");
    await clearRoutedCallbackButtons();
    await actions.replyToCallbackChat("This action is no longer available.");
  };
  ```
- openclaw 的选择器在目录变化时统一话术「Available models changed. Open /models and choose again.」（`openclaw/src/auto-reply/reply/commands-models.ts:29-30`，使用处 `bot-handlers.callback-router.ts:446-449, 507-513`）。
- hermes picker 过期 toast 直接给重开命令：`Picker expired — use /model again.`（`hermes-agent/gateway/platforms/telegram.py:1704-1707`）。
- Memoh 的进程内参数 stash 过期会**降级**而不是报错（列表退回未筛选），并在注释里写明这个取舍（`Memoh/internal/command/callback.go:262-269`）。

**dsh-im 核对**
- 飞书已有：卡片路由表丢失（进程重启/旧卡）时统一回「这个菜单已过期，请回复 /m 重新打开。」（`bridge.mjs:2442`，同一文案在 `:2938, :3135, :3431` 复用），并区分「新会话操作状态未能更新」等更具体场景（`:3008`、`:3060`）。
- Telegram：工作区卡已经做到「过期 toast + 清死键盘 + 同一对话新卡淘汰旧卡 + TTL」（`text-harness-bridge.mjs:1969-1985`、`:1923-1936`）；问题卡有「选项已失效」提示（`:1845`）。但**没有**跨卡片的统一话术/helper：`/m`、选择器、审批卡都还不存在，这套规则目前只活在工作区卡里。

**移植要点**
1. 统一常量文案：`该卡片已过期，请重新发送 /m（或对应命令）打开。`，并带具体命令（`/m`、`/ws`、`/sessionlist`）。
2. 过期处理 = toast + 清掉该消息键盘（`editMessageReplyMarkup` empty），忽略 `message is not modified` / `message to edit not found`（上一份 brief 有错误分类）。
3. Hub/选择器卡引入「版本/会话 key」：同一对话新卡发出后，旧卡点按 → 过期话术（P1 的「同一对话只保留一张活跃卡」）。
4. 飞书把 `这个菜单已过期` 的四处重复文案收敛为常量 + 统一 helper（顺手清理 `:2938` 等处的重复）。
5. 重开命令要可点复制（P13 的 code span）。

**风险**：低。清键盘可能失败（消息被删），要静默容错；过期话术若过于频繁，说明卡片 TTL/失效策略太激进。

---

### P15 · 群聊/多用户边界：actor 绑定 + 命令权限 + 首答胜出 + topic 隔离
**类别** 6 ｜ **结论** **TG 按卡补 actor/权限/并发**（工作区卡已做一部分）；飞书已有 ｜ **工作量** M

**上游证据**
- 飞书（dsh-im 自己的最佳实践）：卡片动作默认走命令权限闸门，只有审批/回答这类「交互回复」豁免；审批提交按 operator 绑定：
  ```js
  // dsh-im/src/channels/feishu/bridge.mjs:2451-2456
  // These buttons are the card equivalent of an ordinary approval or
  // question reply. Every other card action remains command-gated.
  isCommand: !isInteractionResponse,
  ```
  ```js
  // dsh-im/src/channels/feishu/bridge.mjs:2696-2701
  // Bind the decision to the operator so another allowed group member
  // cannot decide someone else's approval.
  const submitted = await this.#approvals.submitByApprovalId(approvalId, outcome, { actor });
  ```
- openclaw：回调入口先做 sender 授权（`callback-allowlist` / `callback-scope`），审批/问答按允许的 sender 判定：
  ```ts
  // openclaw/extensions/telegram/src/bot-handlers.callback-router.ts:243-255
  const authorizationMode = hasReservedQuestionPrefix
    ? "callback-runtime-allowlist" : ...;
  const senderAuthorization = await authorizeTelegramEventSender({...});
  ```
- hermes：回调先 `_is_callback_user_authorized`，未授权只 toast（`hermes-agent/gateway/platforms/telegram.py:1912-1922`）。
- Memoh：`ask_user` 每次点击先 `authorizeAskUser`，再用 CAS 状态判断是否已被别人处理（`Memoh/internal/channel/adapters/telegram/telegram.go:759-781, 2542-2558`）。
- topic 隔离：openclaw 明确区分 DM topic / forum topic / General topic（General topic 发送时不能带 `message_thread_id=1`，typing 又要带）：
  ```ts
  // openclaw/extensions/telegram/src/bot/helpers.ts:368-373
  // Telegram rejects message_thread_id=1 for General forum topic
  if (normalized === TELEGRAM_GENERAL_TOPIC_ID) { return undefined; }
  ```
  hermes 建 DM topic 后把 `thread_id` 持久化到配置并发一条 seed 消息避免隐藏（`hermes-agent/gateway/platforms/telegram.py:756-840`）。
  dsh-im 飞书有 topic 回复锚定（`dsh-im/src/channels/feishu/bridge.mjs:1042-1062`）；TG 的会话 key 已包含 threadId（`telegram-runtime.mjs:247-273`）。

**dsh-im 核对**
- 飞书已有：命令权限闸门 + actor 绑定 + 事件去重 + 每会话队列 + stop 合并（`bridge.mjs:155-160, 2576-2670`）+ topic 锚定。
- Telegram：工作区卡已做命令权限闸门（`text-harness-bridge.mjs:1990-1997`）、`submitting` 同步认领（`:2000-2002`）、同对话单活跃卡（`:1923-1936`）；问题卡按 actor 绑定（`:1823-1827`）。但**没有** stop 合并/每会话控制通道；审批仍是文字，无 actor 卡动作；Hub/选择器/审批卡加入时需要复制这套边界。

**移植要点**
1. 新增卡动作先问三题：是否命令（isCommand）？谁可以点（actor/allowlist）？重复点怎么办（claim/首答胜出）？
2. 引入「控制通道」概念（飞书 `lane: control`）：`/stop` 类动作合并为同一任务，重复点返回同一个 promise（`bridge.mjs:2576-2670`）。
3. 审批卡按 actor 绑定 + 已处理 toast；问题卡已有 actor 逻辑，复用。
4. Topic：TG 卡片发送/编辑携带 `messageThreadId`；callback 的 conversation key 已含 thread，卡片路由/过期判断必须用同一个 key（工作区卡已如此，勿新开一套）。
5. 群聊里「只有发起者能点」与「所有管理员能点」是产品决策，默认按飞书语义（提问/审批 actor 绑定，命令卡按权限）。

**风险**：中-高。权限语义变更影响所有用户；per-user 状态在群聊里可能需要「每个请求一个 actor」而不是「每个会话一个」，设计前先对齐飞书现有语义。

---

## 7. 首次接入 / onboarding

### P16 · `/start` 欢迎 + 首次分叉提示（一次性）
**类别** 7 ｜ **结论** **TG 增加 `/start`**；**飞书也值得加**（目前无欢迎语） ｜ **工作量** S

**上游证据**
- Memoh 的 `/start` 是「轻量欢迎 + 引导」，明确不重置会话、不展示配置；`/new` 才展示完整设置：
  ```go
  // Memoh/internal/channel/inbound/result_render.go:81-96
  // formatStartWelcomeMessage builds the /start doorway greeting. It welcomes the
  // user and invites the first message — it does not reset history or dump bot
  // configuration (that is /new's job after a fresh session is created).
  ```
  ```go
  // Memoh/internal/channel/inbound/result_render.go:103-106
  // formatNewSessionMessage builds the /new confirmation card. A fresh start is an
  // orientation moment, so it confirms the full setup the user is departing with —
  ```
- hermes 的首次触达有两层：
  1) 第一条消息给模型一段一次性 system note，让回复自然介绍自己并提 `/help`（不是模板 UI）：
     ```python
     # hermes-agent/gateway/run.py:6199-6206
     # First-message onboarding -- only on the very first interaction ever
     context_prompt += ("\n\n[System note: This is the user's very first message ever. "
         "Briefly introduce yourself and mention that /help shows available commands. "
         "Keep the introduction concise -- one or two sentences max.]")
     ```
  2) 行为分叉的一次性提示（第一次排队/steer/长工具时），flag 持久化，说明如何改设置，明确「只出现一次」：
     ```python
     # hermes-agent/agent/onboarding.py:43-47
     "💡 First-time tip — I queued your message instead of interrupting. "
     "Send `/busy interrupt` to make new messages stop the current task "
     "immediately, or `/busy status` to check. This notice won't appear again."
     ```
- openclaw 没有 `/start`/欢迎语（DM 配对流程除外），首次触达依赖 doctor/pairing，不作为 UI 参考。

**dsh-im 核对**
- 飞书：没有 `/start`、没有欢迎卡；`/m` 菜单卡是事实上的入口（`bridge.mjs:1842-1844`），首次交互无提示。
- Telegram：命令目录**没有 start**（`command-catalog.mjs:25-105`），机器人也不会主动欢迎；首次消息直接进入正常回复。

**移植要点**
1. TG 增加 `/start`：一句欢迎 + 「直接发消息」+ 「`/help` 看全部命令」+（群聊）`/help@bot` 提示；不重置任何状态。
2. 可选：新会话/首次连接时自动发一次 `/start` 等价欢迎（用户主动 `/start` 仍保留）。
3. 首次触发 busy/steer/长工具时追加一次性提示（复用 P11 的状态明细），flag 持久化在 bot 配置，重启不重复。
4. 飞书：加 `/start`（可复用 `menuCard` 作为引导卡：欢迎语 + 「打开菜单」按钮），或在首次私聊时自动发一次菜单卡。
5. 欢迎语中的命令引用带 `@bot`（群聊）与 code span（P13）。

**风险**：低。唯一风险是「欢迎消息打扰」与多 bot 场景重复发送；用「每 bot + 每个会话一次」的 flag 控制，并允许配置关闭。

---

## 8. 排序表（按用户收益/移植成本）

| # | 模式 | 用户收益 | 移植成本 | 依赖 | 建议批次 |
| --- | --- | --- | --- | --- | --- |
| P8 | 审批卡 + 终态回执 + 首答胜出 | 高（高风险操作可用性） | L | 卡片回调命名空间、actor/权限、HarnessApprovalQueue | **P0** |
| P3 | 主菜单 Hub 卡（分区 + 返回） | 高（可发现性） | M | P6 终态、P14 过期、P15 权限 | **P0** |
| P10 | 过程展示承载物（一回合一条/工具卡） | 高（长任务不再刷屏） | M | P9 编辑节流 | **P0** |
| P9 | 进度编辑 429 背压 + 终态重试 | 中（防丢答案） | S | `editable-message-stream` | **P0** |
| P14 | 过期卡/死键盘统一话术 + 清键盘 | 中（错误边界） | S | 卡片回调统一入口 | **P0** |
| P4 | 两级选择器（模型/会话/预设） | 高（少记命令） | M | P5、P14 | P1 |
| P5 | 列表键盘分页/当前标记/布局 | 中 | S | P3/P4 的列表渲染 | P1 |
| P6 | 卡片终态收尾（返回/收起/取消回执） | 中 | S | P3 | P1 |
| P7 | 破坏性操作二次确认（/new、/clear） | 中（防误清） | M | P6、P14 | P1 |
| P11 | 忙碌/排队/steer 状态明细 + 一次性提示 | 中 | S | 共享 busy dispatcher | P1 |
| P12 | 帮助分层 + 分组按钮 | 高（可发现性） | M | 命令目录、P5 | P1 |
| P15 | 群聊 actor/权限/stop 合并/topic 隔离 | 高（安全边界） | M | 卡片回调统一入口 | P1 |
| P16 | `/start` 欢迎 + 首次分叉提示 | 中 | S | P13 的 @bot 引用 | P1 |
| P1 | 菜单收敛（飞书去掉重复 ws/workspace） | 低-中 | S | 无 | P2 |
| P2 | 菜单容量/本地化/失败降级 | 低-中 | M | 命令目录、飞书面板同步 | P2 |
| P13 | 文本/群聊可发现性（可键入提示 + @bot 引用） | 低-中 | S | 命令目录、P16 | P2 |

**建议实施顺序（依赖最小路径）**：
`P9（独立、立刻可做）` → `P14 + P15（卡片回调统一骨架）` → `P3 + P6（Hub 卡与终态）` → `P4 + P5（选择器/列表复用列表渲染）` → `P8（审批卡，最大但独立）` → `P10（过程承载物）` → `P12 + P16 + P11 + P7` → `P1/P2/P13（清理与打磨）`。

---

## 9. 不确定性与边界

1. **静态阅读，未运行**：三仓与 dsh-im 均未构建/跑测试；Telegram 按钮/编辑的真实限流行为、飞书卡片 30KB 边界等来自代码注释与官方文档，未实测。
2. **飞书 47 个 card action**：按任务说明记录；本文抽查了主要前缀（`approve:/reject:/answer:/workspace:/use:/sessions:/preset:select:/model:select:/steer:/watch:/archive:/back_to_menu`），未逐一列全。
3. **hermes 版本较旧**（2026-05-04）：它的 busy/onboarding 设计可能已被上游更新；本文只对 `851b389` 的代码负责。
4. **openclaw 无主菜单 hub、无欢迎语**：这是「没找到」而非「确认不存在」——openclaw 体量大，可能在其他插件（Discord/Slack/Web UI）里有等价物，本次未读。
5. **dsh-im 现状以 `8ebef5c` 为准**：工作区卡已落地、飞书卡片齐全；P1/P7/P12 的「飞书也值得升级」判断基于该快照，若团队已在改飞书需以实际分支为准。
6. **工作量 S/M/L 是相对估计**：S ≈ 单文件 <80 行 + 少量测试；M ≈ 1-2 文件 150-300 行；L ≈ 新回调命名空间/状态机 + 完整测试。
