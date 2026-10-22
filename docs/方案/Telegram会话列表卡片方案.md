# Telegram 会话列表与绑定卡片方案（`/sessionlist` / `/session`）

状态：**实施完成，待 Lead 合并 + 真机验收**。基线：集成分支 `feat/tg-ux-integration`（`0e7adb7`）。
实施分支：`feat/tg-session-cards`。实施日期：2026-10-22。

目标：把「`/sessionlist` 多屏文字抄 UUID → 手打 `/session <uuid>`」变成「看列表卡 → 点一下即绑定」。
卡片是**叠加**：文字路径原样保留，无卡/发送失败/列表超长时逐字回退现有文字输出；`/ws` 卡与审批卡行为不变。

---

## 闸门 1：事实核对

每条断言都附可复现命令与实测输出（cwd = 本 worktree 仓库根）。原始输出留档：
`/home/wings/Code_Project/_notes/tg-session-cards/facts-1.txt`、`facts-2.txt`。

| # | 断言 | 命令 | 实测输出 |
| --- | --- | --- | --- |
| F1 | 裸 `/sessionlist` 的返回值除既有 `handled/message/messages` 外，新增 `sessionListing`（工作区 + 会话快照） | 见 `facts-1.txt` 第 1 段：`runWorkspaceCommand('/sessionlist', harness, 'direct:one')` | `keys: handled,message,messages,sessionListing`；快照含 `workspace` 与 `sessionId/title/archived/summaryAvailable` |
| F2 | 带 selector / `--limit` 的列表**不**暴露 `sessionListing`（保持一次性文字问答） | 同上命令换成 `/sessionlist --limit 1` | `sessionListing: undefined` |
| F3 | 共享命令层裸 `/session` 仍是原用法文字；只在有卡适配器的渠道（Telegram）改走列表卡 | 同上 `runWorkspaceCommand('/session', ...)` | `"用法：/session Session ID 或当前工作区序号（/session N）"`（逐字不变） |
| F4 | 绑定的「当前会话」来自对话状态存储，不在 Harness 列表里 | `rg -n "sessionFor\(key\)" src/channels/shared/conversation-state-store.mjs` | `163:  sessionFor(key) {`；真实 harness 的 `bindWorkspaceSession` 经 `setSession` 写回（`bot-workspace-store.mjs:1971` 起的门面） |
| F5 | `callback_data` 预算 1–64 字节，且有本地强制 | `rg -n "CALLBACK_DATA_MAX_BYTES" src/channels/telegram/telegram-api.mjs`；`rg -n "ACTION_CARD_CALLBACK_MAX_BYTES" src/channels/shared/action-card.mjs` | `telegram-api.mjs:59: const CALLBACK_DATA_MAX_BYTES = 64;`（83–88 行按 UTF-8 字节抛错）；`action-card.mjs:25: export const ACTION_CARD_CALLBACK_MAX_BYTES = 64;` |
| F6 | 卡片所需的四个 Bot API 能力已存在：发卡、只改键盘、改正文+键盘、ack | `rg -n "async (sendInteractionCard\|updateInteractionCard\|editInteractionCard\|answerInteractionCallback)" src/channels/telegram/telegram-runtime.mjs` | `660 / 677 / 699 / 737` 行 |
| F7 | 共享 `ActionCardRegistry` 已提供：一对话一活动卡、首按同步认领、TTL 过期、终态 | `sed -n '138,311p' src/channels/shared/action-card.mjs` | `issue()` 会 `revokeConversation(SUPERSEDED)`；`claim()` 同步切 `CLAIMED`；`get()` 惰性标 `EXPIRED`；`settle()` 只接受终态 |
| F8 | 中文 `t()` 字面量必须有英文词条，否则单测变红 | `rg -n "every literal t\(\) key" test/channels/shared/i18n.test.mjs` | `170:test('every literal t() key in src/channels has an English dictionary entry', ...)` |
| F9 | `/help` 完整输出被 legacy fixture 钉死（改帮助文字会破坏既有字节） | `rg -n "preserves all legacy" test/channels/shared/command-help.test.mjs` | `21: test(... /help preserves all legacy ...)` + `deepEqual(commandHelpLines(channel), legacyHelp[language])` |
| F10 | 文字列表的拆分/字节由既有 `splitWorkspaceCommandMessage` 决定，卡片路径复用同一个 `message/messages` | `rg -n "splitWorkspaceCommandMessage\(message\)" src/channels/shared/workspace-command.mjs` | 列表与绑定成功回执都先拼 `message` 再拆 `messages`，回退时逐条 `sendText` 即逐字一致 |
| F11 | 卡片页面/上限：10 行/页、>20 行不出卡 | 见 `facts-2.txt`：`telegramSessionCardRender(...12 条...)` / `...21 条...` | `rows page0: 11`（10 会话行 + 1 翻页行）、`pager: ["第 1/2 页","下一页 ▶"]`；21 条 → `null`；空列表 → `null` |
| F12 | 回调样张与字节数 | 同上 `facts-2.txt` | `s2\|AbCdEfGhIjKl\|i7` = **18B**；`s2\|AbCdEfGhIjKl\|p1` = **18B**；`parse` 回 `{kind:'bind',index:7}` / `{kind:'page',page:1}`；外来前缀 `w1\|...` → `null` |

## 闸门 2：验收标准

判定列的命令为空即该条不成立；全部命令在仓库根执行，实测见「验证记录」。

| # | 标准 | 判定命令 | 期望输出 | 实测 |
| --- | --- | --- | --- | --- |
| A1 | 裸 `/sessionlist` 在 Telegram 发一张会话列表卡（不再发多屏文字） | `node --test test/channels/telegram/session-card.test.mjs`（用例 `sends one session card`） | 1 张卡、0 条文字；每会话一行按钮 | ✅ |
| A2 | 每行按钮显示「标题 + 短 ID」，归档有标记，当前绑定行有 ✓ | 同上（用例 `title, short ID, current ✓ and archived markers`） | `✓ 会话 1 · 00000001` / `会话 2 · 00000002` / `会话 3 · 00000003（已归档）` | ✅ |
| A3 | 每页 10 项；上一页/下一页翻转同一张卡；页码按钮为惰性 noop | 同上（`paginate ten per page`、`page indicator is an idempotent receipt`） | 第 2 页编辑同一 messageId、pager 文本 `['◀ 上一页','第 2/2 页']`；点页码 → toast「已经是第 1 页」且不绑定、不编辑 | ✅ |
| A4 | 点会话按钮 → 绑定当前聊天，✓ 原地移到该行并给回执 | 同上（`binds it, moves ✓ in place and returns a receipt`） | `harness.bindWorkspaceSession(key, sessionId)` 1 次；`updateInteractionCard` 新键盘第 2 行带 ✓、第 1 行无 ✓；toast `已绑定会话：标题 …` | ✅ |
| A5 | 卡片是命令面：无命令权限点击不绑定，走同一权限判定 | 同上（`a press without command permission binds nothing`） | 0 次绑定；toast 等于 `COMMAND_PERMISSION_DENIED_MESSAGE` | ✅ |
| A6 | 绑定失败按既有 `/session` 错误语义说明，不静默 | 同上（`binding failure reuses the typed /session text`） | 卡路径 `sendText`/toast 与 `runWorkspaceCommand('/session x')` 的 message **完全相等**（如「未找到该会话…」）；键盘被清空 | ✅ |
| A7 | 重复点/并发点只绑定一次 | 同上（`second press while binding does not bind twice`） | 挂起 bind 时第二次点击 toast「正在绑定会话，请稍候」，`bindWorkspaceSession` 仍 1 次 | ✅ |
| A8 | 过期卡清键盘、绝不绑定 | 同上（`expired card clears its keyboard`，注入可控时钟 TTL） | 0 次绑定；`updateInteractionCard(msgId, 空键盘)`；toast 含「这个会话列表已过期」 | ✅ |
| A9 | 同对话发出新列表卡时旧卡键盘立即收起 | 同上（`newer session list retires the previous card keyboard`） | 旧卡 `messageId` 收到 `{inline_keyboard: []}` | ✅ |
| A10 | 回调 ≤64B，且路径/UUID 不进回调 | 同上（`callback payloads stay within 64 bytes`） | 每个 `callback_data` UTF-8 ≤64B、不含工作区路径/会话 ID，`parse` 仅出 `bind\|page` 两种 | ✅（真实样张 18B） |
| A11 | 卡片发送失败 → 逐字回退原 `/sessionlist` 文字 | 同上（`card delivery failure falls back`） | 无卡；`sent.join('') === runWorkspaceCommand('/sessionlist').message` | ✅ |
| A12 | 列表 >20 → 逐字回退原文字（不分页卡片） | 同上（`too many sessions fall back`） | 无卡；文字含 `会话（21）` 与 `绑定用法：/session` | ✅ |
| A13 | 空列表 → 明确提示（沿用原文字的「该工作区暂无会话」） | 同上（`empty workspace keeps the explicit empty prompt`） | 无卡；文字含「该工作区暂无会话」 | ✅ |
| A14 | 裸 `/session` 打开同一张卡；带参数保持文字绑定 | 同上（`bare /session opens the same card`） | 裸命令 1 张卡；`/session <id>` 无卡且文字回执「当前聊天已绑定会话」 | ✅ |
| A15 | 无卡能力的渠道裸 `/session` 保持旧用法文字（不变量） | 同上（`without a session card keeps its legacy usage text`） | 文字「用法：/session Session ID…」 | ✅ |
| A16 | 英文界面下卡正文/翻页/提示/回执全部有英文 | 同上（`English UI translates …`） | `Workspace: …` / `Sessions (12): Page 1/2` / `Tap a session button…` / `Bound to Session: …` | ✅ |
| A17 | 共享命令层只加机器字段，文字与旧回归不变 | `node --test test/workspace.test.mjs`（新增用例 `picker snapshot only for the bare listing`） | 裸列表有 `sessionListing`；`--limit`/selector 没有；裸 `/session` 仍返回用法文字；`messages.join('') === message` | ✅ |
| A18 | `/workspace`、`/session` 等既有文字回归全绿 | `node --test test/workspace.test.mjs test/session-bind-command.test.mjs test/conversation-workspace-commands.test.mjs test/channel-conversation-workspace.test.mjs` | 全 pass | ✅ |
| A19 | `/ws` 卡、审批卡、提问卡行为不变 | `node --test test/channels/telegram/workspace-card.test.mjs test/channels/telegram/approval-card.test.mjs test/channels/telegram/interaction-card.test.mjs` | 全 pass | ✅ |
| A20 | 英文词典无重复键、无缺词条 | `node --test test/channels/shared/i18n.test.mjs` | 10/10 pass | ✅ |
| A21 | 构建成功且 `lib/client.js` 无软链路径差异 | `npm run build && git diff --stat lib/` | `EXIT:0`；只有 `lib/index.js` 变化（`client.js` 归一化后 0 差异） | ✅ |
| A22 | 全量测试通过 | `npm test` | `ℹ tests 4498 / pass 4498 / fail 0` | ✅ |
| A23 | Telegram 桥默认注入会话卡适配器（改动的 `telegram-bridge.mjs` 被真实覆盖） | `node --test test/channels/telegram/session-card.test.mjs`（用例 `the Telegram bridge wires the session picker by default`） | 1 张卡、2 行按钮 | ✅ |

**已知不做**：

- 不改 `/help` 文案：`test/channels/shared/command-help.test.mjs` 把整段帮助与 legacy fixture 逐字节钉死，
  而本轮验收不要求帮助文字变化；浏览器/菜单发现新交互的价值低于破坏既有字节的风险。
- 不做「重新加载」按钮与 `/session` 卡内搜索：卡只做列表+绑定，重开列表仍用命令。
- 不把飞书/QQ/企微的会话卡迁移到共享层：本轮只复用 `shared/workspace-command` + `shared/action-card`，不动其他渠道实现。
- 列表 ≤20 才出卡（2 页）；>20 直接文字，理由与 `/ws` 卡一致：手机端翻页成本高于直接滚动文字。

## 闸门 4：不变量（动手前列出，交付时实测）

| # | 不变量 | 守护方式 | 实测 |
| --- | --- | --- | --- |
| I1 | `/sessionlist`、`/sessionlist 序号/路径/--limit` 的文字回执字节级不变 | `workspace.test.mjs` 既有断言 + A17 的 `messages.join('') === message` | ✅ 77/77 pass |
| I2 | 无卡能力、卡发送失败、列表 >20 时，用户拿到的文字与改造前逐字一致 | A11/A12/A13（其中 A11 直接对比命令层 message） | ✅ |
| I3 | `callback_data ≤64B`；路径/UUID 不进回调 | A10 + `telegram-api.mjs` 的 64B 强制 | ✅ 实测样张 18B |
| I4 | 绑定/权限/工作区校验语义不变：卡点击复用 `runWorkspaceCommand('/session <id>')` + 同一 `evaluateInboundAccess(isCommand:true)` | A4/A5/A6 + `session-bind-command.test.mjs` 回归 | ✅ |
| I5 | `/ws` 卡与审批卡行为不变；提问卡回调命名空间不受影响 | A19 | ✅ |
| I6 | 不碰流式/发送预算区域；改动只落在会话卡相关文件 | `git show --stat`（见交付清单） | ✅ |
| I7 | 中文/英文界面无新增未翻译字面量 | A20 | ✅ 10/10 |
| I8 | 裸 `/session` 在共享命令层仍是旧用法文字（只有 Telegram 卡适配器改变呈现） | A15/A17 | ✅ |

## 方案

### 命令语义

| 输入 | 改造前（Telegram） | 改造后（Telegram） | 其他渠道 |
| --- | --- | --- | --- |
| `/sessionlist` / `/sessions` 裸命令 | 多屏文字列表 | **会话列表卡**（10/页，✓/归档标记，翻页） | 文字列表（不变） |
| `/sessionlist 序号`、`绝对路径`、`--limit N` | 文字列表 | 文字列表（不变；卡片只服务裸命令） | 不变 |
| 裸 `/session` | 用法文字 | **同一张会话列表卡** | 用法文字（不变） |
| `/session <ID>`、`/session N` | 绑定 + 文字回执 | 不变（文字回执） | 不变 |
| 无卡/发送失败/列表 >20 | — | 逐字回退上面的文字输出 | 本来就是文字 |

### 数据流

```text
用户输入 /sessionlist（或 Telegram 裸 /session）
  └─ TextHarnessBridge #process
       ├─ runWorkspaceCommand(...) → { message, messages, sessionListing? }
       │    （sessionListing 只在裸列表时出现；文字 half 完全不变）
       └─ #presentSessionCommand
            ├─ 无 sessionCard 适配器 / bot 无 sendInteractionCard → false（走原文字）
            ├─ TelegramSessionCard.present()
            │    ├─ registry.activeFor(key) 记住旧卡 → registry.issue()（旧卡作废）
            │    ├─ bot.sendInteractionCard(target, render(snapshot, page=0, currentSessionId))
            │    └─ 旧卡：updateInteractionCard(空键盘)
            └─ 失败 → false → 逐条 sendText(command.messages)（逐字回退）

用户点按钮
  └─ acceptCallback(callback)
       ├─ workspaceCard.parse 未命中 → sessionCard.parse(data) 命中 → #handleSessionCardPress
       ├─ 权限闸门 evaluateInboundAccess(isCommand:true)
       └─ TelegramSessionCard.handlePress
            ├─ 未知/别的对话/过期 nonce → toast 过期（已知 nonce 还就地清键盘）
            ├─ 翻页按钮 → claim → 重新 issue(同一 listing, page±1) → editInteractionCard 原地换页
            ├─ 当前已绑定行 → toast 幂等，不 claim
            ├─ 绑定行 → claim（同步，重复点得到「正在绑定」）
            │    └─ runWorkspaceCommand('/session <id>', harness, key)（复用文字绑定全链路）
            │         ├─ 成功：新 issue（✓ 移到该行）→ updateInteractionCard
            │         │        → toast「已绑定会话：<标题>」
            │         └─ 失败：settle(STALE) + 清键盘 + sendText(既有错误文案) + toast 同文案
            └─ 旧 nonce 已被 claim，新的 presentation 继续可点
```

### 接口契约

1. `src/channels/shared/workspace-command.mjs`
   - 裸 `/sessionlist` 的返回值新增 `sessionListing: { workspace, sessions:[{sessionId,title,archived,summaryAvailable}] }`；
     带 selector/`--limit` 时**没有**该字段。
   - 绑定成功新增 `bound: { workspace, sessionId, title, archived }`（机器可读回执；文字回执不变）。
   - 导出 `sessionBindErrorMessage(error)`：文字命令与卡片共用同一错误映射。
2. `src/channels/telegram/session-card.mjs`（新增）
   - `TELEGRAM_SESSION_CARD_PAGE_SIZE = 10`、`TELEGRAM_SESSION_CARD_MAX_SESSIONS = 20`。
   - 命名空间 `s2`（`createCallbackNamespace`），回调 `s2|<nonce>|i<idx>` / `s2|<nonce>|p<page>`。
     共享命名空间强制 3 段且整体 ≤64B；页可由 index/10 推导，故不额外占段。
   - `telegramSessionCardRender(listing, {nonce, page, currentSessionId})`：纯函数；空/>20/坏数据返回 `null`。
   - `TelegramSessionCard`：`present()` 发卡 + 收旧键盘；`handlePress()` 认领/翻页/绑定/终态。
     每次成功绑定或翻页后 **re-issue 新 nonce**（旧 nonce 已消耗），所以同一张可见卡可继续操作。
3. `src/channels/shared/text-harness-bridge.mjs`
   - 构造参数新增 `sessionCard = null`（渠道适配器）；`acceptCallback` 在 workspace 命名空间之后分流 session 回调。
   - `#presentSessionCommand`：只在 `sessionListing` 存在且 bot 有 `sendInteractionCard` 时尝试卡片，任何失败返回 false（不抛）。
   - 裸 `/session`：仅当渠道有 `sessionCard` 且 bot 能发卡时尝试用 `/sessionlist` 结果出卡；
     否则完全走旧路径（共享层 `/session` 用法文字）。
4. `src/channels/telegram/telegram-bridge.mjs`
   - 默认注入 `new TelegramSessionCard({logger})`（每 bot 一个 registry）；`sessionCard: null` 可关闭（测试/工具）。

### 明确降级

| 场景 | 行为 |
| --- | --- |
| 渠道没有 `sessionCard` 或 bot 没有 `sendInteractionCard` | 原 `/sessionlist` 文字列表；裸 `/session` 旧用法文字 |
| 卡片发送抛错 | 记 warn，回退文字列表（不重试卡片） |
| 列表为空 | 不出卡，沿用原文字「工作区：… 该工作区暂无会话。」 |
| 列表 >20 | 不出卡，原文字列表 |
| nonce 过期/未知 | toast「这个会话列表已过期，请重新发送 /sessionlist 或 /session。」；已知 nonce 同时清键盘 |
| 新列表卡发出 | 旧卡键盘立即清空；旧 nonce 按「已被取代」处理 |
| 绑定进行中重复点 | toast「正在绑定会话，请稍候。」，不重复绑定 |
| 绑定失败 | 清键盘 + 发送既有错误文案（如「未找到该会话，请先执行 /sessionlist 确认 Session ID。」）+ 同文案 toast |
| 翻页编辑失败 | 清键盘 + toast「暂时无法更新会话列表，请重新发送 /sessionlist。」 |

### 关键决策

1. **每次成功操作 re-issue 新 nonce**：共享 registry 的「首按认领」天然是一次性的，但列表卡需要
   「绑完 A 还能点 B」。做法是成功后在同一个 message 上换一套新 nonce 键盘，旧 nonce 进终态；
   这样重复点仍只绑一次，卡却继续可用。
2. **绑定失败必须留文字**：toast 会消失，所以失败时既 ack(toast) 又 `sendText(同一错误文案)`，
   文案直接来自 `runWorkspaceCommand('/session …')`（`sessionBindErrorMessage`），不另造词。
3. **裸 `/session` 的降级边界**：只在 Telegram 有卡时呈现列表；共享命令层保持旧用法文字，
   因此其他 8 个渠道和既有 `session-bind-command.test.mjs` 的「缺失参数 → 用法」断言完全不受影响。
4. **帮助文案不动**：`/help` 输出被 legacy fixture 逐字节钉死，且本批次验收不含帮助文案变化。

## 测试计划（先红后绿）

1. 新增 `test/channels/telegram/session-card.test.mjs`：20 个用例覆盖 A1–A16 与 A23（默认装配）。
2. 扩展 `test/workspace.test.mjs`：A17（`sessionListing` 只在裸列表、文字不变、裸 `/session` 用法不变）。
3. 回归：`test/session-bind-command.test.mjs`、`test/conversation-workspace-commands.test.mjs`、
   `test/channel-conversation-workspace.test.mjs`、`test/workspace.test.mjs`（A18）。
4. 回归：Telegram `workspace-card/approval-card/interaction-card`（A19）。
5. i18n：`test/channels/shared/i18n.test.mjs`（A20）。
6. 构建 + 全量：A21/A22。

## 验证记录

> 证据目录：`/home/wings/Code_Project/_notes/tg-session-cards/`（本机工作日志，不进仓库）。

| 项 | 结果 | 证据 |
| --- | --- | --- |
| 闸门 3 验红（实现前跑新测试） | ✅ | `red-initial.log`：`ERR_MODULE_NOT_FOUND`（`src/channels/telegram/session-card.mjs` 尚不存在），新测试文件 1 fail / 0 pass |
| 变异 M1：去掉当前会话 ✓ | ✅ 测试变红 | `mutation.log`：`actual: '会话 1 · 00000001' / expected: '✓ 会话 1 · 00000001'` |
| 变异 M2：去掉首按守卫（允许重复绑定） | ✅ 测试变红 | `mutation.log`：`actual: 2 / expected: 1`（`does not bind twice`） |
| 变异 M3：去掉 >20 上限（不该出卡却出卡） | ✅ 测试变红 | `mutation.log`：`actual: 1 / expected: 0`（`too many sessions fall back`） |
| scoped 全绿（Telegram 全部 + workspace/session/help/i18n/bridge） | ✅ | `scoped-3.log`：`ℹ tests 468 / pass 468 / fail 0` |
| 新用例全绿 | ✅ | `green-scoped-new.log`：`ℹ tests 20 / pass 20 / fail 0` |
| 构建 | ✅ | `build.log`：`Wrote …/lib/index.js`、`EXIT:0`；`lib/client.js` 归一化软链注释后与基线 0 差异 |
| 全量测试 | ✅ | `full-test.log`：`ℹ tests 4498 / pass 4498 / fail 0`（181.6s） |
| 真机（重启 dsh web 后点卡绑定） | ⏳ 待 Lead/用户在宿主重启后验收 | 宿主代码仅在进程启动时加载；本 worktree 只交付构建产物 |

### 交付清单（实现）

- 新增：`src/channels/telegram/session-card.mjs`、`test/channels/telegram/session-card.test.mjs`、本文档。
- 修改：`src/channels/shared/workspace-command.mjs`（+`sessionListing`/`bound`/导出错误映射）、
  `src/channels/shared/text-harness-bridge.mjs`（+`sessionCard` 通道与两条分流）、
  `src/channels/telegram/telegram-bridge.mjs`（默认注入）、
  `src/channels/shared/i18n-en/telegram.mjs`（13 条英文词条）、
  `test/workspace.test.mjs`（A17 回归）、重建的 `lib/index.js`。
