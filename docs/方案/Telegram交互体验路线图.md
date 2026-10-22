# Telegram 命令与交互体验优化路线图

状态：**批次 0+1 已实现并通过真机验证，已向上游提交 issue/PR（2026-10-22）**。整理日期：2026-10-22。
基线：`dsh-im@8ebef5c`（`/ws` 工作区卡已上线，dsh web 于 07:15 重启后生效）。
实施：集成分支 `feat/tg-ux-integration`（`/ws` + 批次 0 + 批次 1 + 两轮独立评审修复），真机验证见
[Telegram交互体验真机验证记录.md](./Telegram交互体验真机验证记录.md)。
上游：issue【xmanrui/dsh-im#429】、PR【#430 审批按钮卡】、【#431 菜单 scope + /status】；
`/ws` 工作区卡仍在 fork 分支，是否单独提上游待定。
调研输入（同目录/`docs/research/`）：

- [command-ux-audit.md](../research/command-ux-audit.md) — 仓内命令审计（23 命令 × 12 渠道能力矩阵、19 条问题、Telegram 技术约束）
- [tg-interaction-patterns-supplement.md](../research/tg-interaction-patterns-supplement.md) — 上游命令/菜单/交互模式（16 条模式，openclaw / hermes-agent / Memoh）
- [tg-ux-upstream-brief.md](../research/tg-ux-upstream-brief.md) — 上一轮 TG 渠道调研（17 条建议，`/ws` 卡已吸收其中 5 条）

---

## 0. 一页结论

| 结论 | 依据 |
| --- | --- |
| Telegram 23 条共享命令里，**只有 `/ws` 一条是卡片**，其余全是「一条或几条文本 + 让用户再打一条命令」 | `CAT:25-105`、`THB:1116-1167`、`TG-BR:108-126` |
| **最高频的摩擦不是某条命令，而是审批**：Telegram 审批至今要求用户手打「批准 / 拒绝」 | `HA:19`、`HA:337`（共享层已有 `render` 卡片钩子）、`FS-BR:6242`（飞书已用） |
| 飞书有、Telegram **完全没有**的入口：`/menu`（hub 卡）、`/watch*`、`/archived`、`/permission*`、`/repair` | `FS-BR:1842-1930`、`FS-CARDS:136-361`、`CAT` |
| 仓库内已经有 **4 套独立的 `/menu` 实现**（飞书卡、企微模板卡、钉钉卡、QQ 键盘菜单），都在重复拉同一份「工作区/会话/预设/模型」快照；Telegram 是唯一没有 `/menu` 的有卡渠道 | `feishu-cards.mjs:136`、`wecom-cards.mjs:43`、`dingtalk-menu.mjs:20`、`qq-menu.mjs:89` |
| 「点完原地变已切换 + 换键盘」今天必须两次 API：`editMessageText` 未透传 `reply_markup`（官方支持，封装没传） | `TG-API:394-406`；官方 `editMessageText` 参数表含 `reply_markup`（见 F5） |
| 富文本答案不能同时带按钮：`sendRichMessage` 不收 `reply_markup` | `TG-API:299-314` |

**建议做三件事（按顺序）**：① 审批按钮卡（安全 + 最高频摩擦）；② 抽 `shared/action-card` + 补 `editMessageText(reply_markup)` 地基；③ 把 `models / sessionlist / preset / status / help` 做成选择型/状态型卡片，再加 `/menu` hub。

---

## 1. 命令优化清单

### P0：收益高、成本中低（建议下一批就做）

| # | 命令 | 现状（Telegram） | 目标交互 | 工作量 | 依赖 |
| --- | --- | --- | --- | --- | --- |
| 1 | **审批**（非命令） | 文本「请精准回复『批准』或『拒绝』」+ 60 分钟超时；误回、漏看、无终态 | 卡：`✅ 批准一次` / `❌ 拒绝`；点后原地变「已批准（仅本次）」并清键盘；非发起人点击 toast 拒绝；超时卡收成「已过期」 | L | 共享 `HarnessApprovalQueue.render` 钩子（已有）+ 回调命名空间 + actor/权限校验 |
| 2 | `/models` + `/model` | 纯文本列表，用户要抄序号再打 `/model 2`；长列表拆多条消息 | 模型选择卡：分组标题、当前项 ✓、点按即切换并原地更新；同一张卡可切推理等级 | M | `action-card` 地基 |
| 3 | `/sessionlist` + `/session` | 多屏文本，用户要从文本里抄 UUID 才能绑定 | 会话列表卡：每行「绑定」按钮，分页 8–10，归档标记，返回 | M | 同上 + 会话快照 |
| 4 | `/stop` | 任务运行中只能手打 `/stop` | 进度消息/状态卡挂「⏹ 停止」按钮（按当前 turn 归属校验） | M | 进度消息 id 管理（上游 PR #423/425 同区域，先协调） |
| 5 | 原生命令菜单 | 27 项里有 5 个别名；群聊里还显示只在私聊可用的 `history/batch/send/cancel` | 分 scope 注册：私聊用 `AllPrivateChats`，群聊用 `AllGroupChats`；别名从菜单隐藏（仍可输入） | S | `setMyCommands` 已支持 scope |

### P1：命令体验主体

| # | 命令 | 目标交互 | 工作量 |
| --- | --- | --- | --- |
| 6 | `/menu`（`/m`） | 主菜单 hub 卡：当前状态摘要 + 入口按钮（会话/工作区/预设/模型/停止/压缩/清空/状态/帮助）+ 返回导航 | M |
| 7 | `/presetlist` + `/preset` | 预设选择卡（含「跟随默认」），点按原地更新；去掉 15 分钟快照过期报错 | M |
| 8 | `/status` | 状态卡：连接、工作区、绑定会话、模型、预设、运行中任务；替代现在的一行文本 | S |
| 9 | `/help` | 分区帮助卡（会话/工作区/模型/任务/其他 + 返回），替代 30 行文本墙 | S |
| 10 | `/conv` | 对话专属工作区卡（复用 `/ws` 卡，按钮改为「本对话生效」语义 + 清除按钮） | S |
| 11 | `/reasoninglist` + `/reasoning` | 推理等级选择卡（飞书也没有，可反超） | M |
| 12 | `/clear` | 二次确认卡（`确认清空` / `取消`），防误清；`/new` 不加确认，但成功后给「开始对话/菜单」按钮 | S |
| 13 | 卡片终态统一 | 所有卡操作「先 ack → 干活 → 原地变 ✅ 已…/❌ 失败 → 清键盘」；过期卡统一话术 | M |

### P2：按需/打磨

| # | 命令 | 说明 |
| --- | --- | --- |
| 14 | `/history` | 「再看 N 条」按钮；需要 `commandResult` 支持附加动作按钮位 |
| 15 | `/batch` | 常驻状态卡（已收集 N 条 + `发送`/`取消` 按钮） |
| 16 | `/steer` | 飞书有快捷指令 chips；Telegram 以自由文本为主，按钮只放 2–3 个固定短语（价值有限，缓做） |
| 17 | `/permission`、`/permissionlist` | Telegram 目前完全没有；先补文本命令，再考虑卡 |
| 18 | `/watch*`、`/archived` | 依赖飞书专属存储，跨渠道化成本高，暂不做 |
| 19 | `/version`、`/send`、`/cancel` | 不需要卡（一句话/瞬态操作） |

---

## 2. 上游设计借鉴 → dsh-im 落点

来源：`docs/research/tg-interaction-patterns-supplement.md`（P1–P16）、`tg-ux-upstream-brief.md`（R1–R17），每条都有上游 `file:line` 证据。

| 模式 | 上游代表 | 飞书是否已有 | Telegram 落点 | 批次 |
| --- | --- | --- | --- | --- |
| 审批卡：Approve/Deny + 终态回执 + 首答胜出 | openclaw `approval-callback-data.ts:5`、`approval-terminal.ts:20-24`；hermes `telegram.py:1939-1949` | ✅ `feishu-cards.mjs:921`、`bridge.mjs:6242` | P0-1 审批按钮卡 | 1 |
| 主菜单 Hub：分区 → 子页 → 返回 | Memoh `menu.go:12-16`、`registry.go:78-114`；openclaw 命令注册约定 | ✅ `feishu-cards.mjs:136-361` | P1-6 `/menu` | 3 |
| 选择器分页：8–10/页、页码 noop、当前页钳制 | openclaw `model-buttons.ts:49,230-236`；hermes `telegram.py:1657`；Memoh `result_render.go:256-277` | ✅ 飞书会话卡 10/页 | P0-2/3、P1-7/11 | 2 |
| 当前项标记 + 实时复核（不是纯索引） | Memoh `callback.go:111-118`；hermes `run.py:9473-9475` | ✅ `/ws` 卡已用「快照路径」而非索引 | 所有选择卡沿用 `w1|` 命名空间模式 | 2 |
| 卡片终态收尾：清键盘/收成标题行 | openclaw `callback-router.ts:215-219`；Memoh `telegram.go:611-621` | ✅ `/ws` 已做过期清键盘 | P1-13 统一终态 | 1–3 |
| 破坏性操作二次确认 | openclaw P7 证据 | ❌ 飞书 `/new`、`/clear` 直接执行 | P1-12 `/clear` 确认 | 3 |
| 单消息进度编辑：节流、去重、429 背压、not-modified 视为成功 | Memoh `stream.go:21-24,127-133,201-202`；openclaw `AGENTS.md:61-73` | 部分（飞书 step 卡） | P0-4 `/stop` 按钮 + 批次 0 节流修正 | 0/3 |
| 过程展示承载物：一回合一条而不是一行一条 | Memoh `stream.go`；飞书 step 卡 `feishu-cards.mjs:967-1008` | ✅ 飞书有 step 卡 | 未来「过程卡」；与上游 PR #412/#425 协调 | 4 |
| 帮助分层：`/help` 短表 + `/commands` 全量 + 分组按钮 | Memoh `registry.go:78-114` | ❌ 飞书 `/help` 文字、helpCard 两套并存 | P1-9 `/help` 分区卡 | 3 |
| 原生菜单只放「单 token 主名」，别名隐藏仍可用 | Memoh `menu.go:14-16`；openclaw `bot-native-commands.ts:184` | ❌ 飞书面板仍有 `ws` + `workspace` 重复入口 | P0-5 菜单收敛 + 分 scope | 0 |
| 群聊边界：actor 绑定、命令权限、per-user 状态、topic 隔离 | openclaw P15 证据 | 部分 | P1-13 + 卡回调统一权限闸门（`/ws` 已做） | 1–2 |
| 回调命名空间版本化 + `disabled` 按钮 | openclaw `tga1:`/`tgq1:`/`mdl1~`；Telegram Bot API 10.3 `InlineKeyboardButton.disabled` | ❌ | 统一 `dsh1:<kind>|<nonce>|<action>`；当前页/当前项用 `disabled` 而不是 noop 回调 | 1 |
| onboarding：`/start` 欢迎 + 首次分叉 | hermes P16 证据 | ❌ | `/start` = 一次性欢迎卡（菜单/工作区/模型三个按钮） | 3–4 |

---

## 3. 技术地基（先做，否则每条卡都要重复踩坑）

1. **`shared/action-card.mjs`**：nonce 仓库（容量 + TTL）+ 首按认领 + 陈旧/列表变化复核 + 统一终态与过期文案 + 统一回调命名空间。把现在 `workspace` 卡的实现迁到该模型上，**行为不变**。仓内已有 4 套近似实现（飞书 `cardKeys`、QQ opaque token、钉钉 revision、Telegram nonce），这是把它们收敛成一份的机会。
2. **`telegram-api.editMessageText` 增加可选 `replyMarkup`**：官方支持（F5），当前封装只透传正文。一次调用同时改正文+键盘；如平台实测不允许，退化为两步（`editMessageText` → `editMessageReplyMarkup`），但要在 adapter 里封装掉。
3. **`shared/menu-snapshot.mjs`**：工作区/会话/预设/模型/任务状态快照，**每段独立 catch 降级**（照抄飞书 `#sendMenuCard` 的分段策略），供 `/menu`、`/status` 和四个已有菜单实现复用。
4. **菜单注册分 scope**：`setMyCommands(scope: AllPrivateChats|AllGroupChats, languageCode)`；去掉 5 个别名；`privateOnly` 命令只进私聊菜单。
5. **回调统一入口**：入口先 `answerCallbackQuery` 再干活；`message is not modified` 当成功；429 只退避不重放旧帧。
6. **可选新能力**（Bot API 10.2/10.3，先做小实验再决定）：`InlineKeyboardButton.disabled` 表示当前页/当前项；ephemeral commands/messages 让群聊里的菜单回复只对操作者可见（降噪）。

---

## 4. 事实核对（闸门 1）

| # | 断言 | 可复现命令 / 来源 | 实测 |
| --- | --- | --- | --- |
| F1 | 共享命令 23 条；Telegram 原生菜单 27 项，其中 5 项是别名 | `node --input-type=module -e "import {telegramCommandMenu} from './src/channels/telegram/telegram-runtime.mjs'; ..."`（见 `_notes` 记录） | `menu entries: 27 \| aliases: conversation,thread,sessions,reasonings,presets` |
| F2 | Telegram 审批是纯文本提示 | `grep -n 'APPROVAL_PROMPT' src/channels/shared/harness-approval.mjs` | `19:const APPROVAL_PROMPT = '请精准回复「批准」或「拒绝」...'` |
| F3 | 共享审批队列已有渠道卡片钩子，飞书已接 | `grep -n 'const render = typeof context?.render' src/channels/shared/harness-approval.mjs`；`sed -n '6242p' src/channels/feishu/bridge.mjs` | `harness-approval.mjs:337`；飞书 `render: async (pending) => {...approvalCard...}` |
| F4 | 当前 `editMessageText` 封装不透传 `reply_markup` | `sed -n '394,406p' src/channels/telegram/telegram-api.mjs` | 只有 `chat_id/message_id/text/rich_message` |
| F5 | 官方 `editMessageText` 支持 `reply_markup` | https://core.telegram.org/bots/api/methods/editmessagetext.md | 参数表：`reply_markup \| InlineKeyboardMarkup \| Optional` |
| F6 | `callback_data ≤64B` 已代码强制 | `grep -n 'CALLBACK_DATA_MAX_BYTES' src/channels/telegram/telegram-api.mjs` | `58:const CALLBACK_DATA_MAX_BYTES = 64;` + 83-87 校验抛错 |
| F7 | `sendRichMessage` 不支持 `reply_markup`（富文本+按钮不可共存） | `sed -n '299,314p' src/channels/telegram/telegram-api.mjs` | payload 只有 `rich_message` |
| F8 | 仓内有 4 套独立菜单实现，Telegram 无 `/menu` | `ls src/channels/{qq/qq-menu,wecom/wecom-cards,dingtalk/dingtalk-menu}.mjs; grep -n 'menu' src/channels/shared/command-catalog.mjs` | 三个文件都存在；catalog 无 menu 命令 |
| F9 | Bot API 10.2 有 ephemeral 命令/消息；10.3 有 `InlineKeyboardButton.disabled` | https://core.telegram.org/bots/api（Recent changes / Ephemeral 章节） | 「Bots can declare ephemeral commands…」「Added the class DisabledButton and the field disabled…」 |
| F10 | 上游正在改 Telegram 流式/发送预算，先协调再动同区域 | `gh pr list --repo xmanrui/dsh-im --limit 30` | #423 发送预算、#425 思考帧节奏、#426 占位符编号、#412 最终答案独立消息 |

> 未验证（不写进结论）：平台按钮数量上限、按钮文字长度上限、`answerCallbackQuery` 时限、编辑频率/429 阈值——批次 0 先写一个最小实测脚本记录到本文件。

---

## 5. 验收标准草案（闸门 2 摘要）

| # | 标准 | 判定 |
| --- | --- | --- |
| A1 | 审批收到卡片而非文字；点「批准一次」后 Harness 收到 `allowed-once`，卡原地变已批准且键盘清空 | 新测试 `test/channels/telegram/approval-card.test.mjs` + 真机截图/日志 |
| A2 | 非发起人点审批按钮不生效，只收到 toast | 同上（actor 校验用例） |
| A3 | `/models` 发选择卡；点第 2 个模型后卡原地更新 ✓，无需再打命令 | 新测试 `model-card.test.mjs` |
| A4 | `/sessionlist` 分页（每页 8–10）；点「绑定」后卡原地变已绑定，`/history` 可看到该会话 | `session-card.test.mjs` |
| A5 | `/menu` 有入口卡；点任一入口进入子卡；子卡有「返回」；返回后回到 hub | `menu-card.test.mjs` |
| A6 | `/status` 卡包含连接/工作区/绑定会话/模型/预设/运行中任务 6 项 | `status-card.test.mjs` |
| A7 | 群聊原生菜单不出现 `batch/send/cancel/history`；私聊菜单里不出现别名 | 单元测试 + `getMyCommands(scope)` 实测 |
| A8 | 所有卡操作：点击后 ≤1s 内 toast/终态；重复点击不重复执行；过期卡清键盘 | 复用 `/ws` 卡的测试矩阵 |
| A9 | 文本路径全部保留：无卡渠道与卡片失败时，用户拿到的文字与今天一致 | `test/workspace.test.mjs` 等回归 |
| A10 | `npm run check` 全绿；变更文件在 clean 环境可复现 | CI + 干净副本 `npm ci && npm run check` |

### 不变量

- I1 所有现有文字命令的文本回执字节级不变（卡片是叠加，不是替换）。
- I2 `callback_data ≤64B`；路径/UUID 一律不进回调。
- I3 命令权限/actor 语义不变；卡片是命令面，点击走同一权限判定。
- I4 卡片发送失败必须降级为原文字路径，不丢信息。
- I5 富文本答案不带按钮（F7）；状态/选择卡用常规文本。

---

## 6. 风险与不做清单

| 风险 | 应对 |
| --- | --- |
| 平台数值未实测（按钮上限/编辑频率/ack 时限） | 批次 0 写 3 个小脚本实测，结果回填本文件 §4 |
| 与上游 #423/#425/#426/#412 动同一片 `telegram-runtime` 流式/发送预算代码 | 批次 0 只做菜单/ack；进度节流等上游 PR 落地后再做，或先开 issue 协调 |
| 双渠道漂移（飞书 `/help`、`/status` 已有文字/卡片两套实现） | 抽 shared 时加 parity 测试；先 Telegram-only，验证后再回改飞书 |
| 卡片化过度导致消息噪音 | 选择卡一律「原地更新」；每条命令最多一张活动卡；超过 20 项降级文字 |
| 回调死键盘 | 统一 TTL + 过期清键盘 + 入口先 ack |

**本轮不做**：`/steer` 强制按钮化（自由文本优先）；`/watch*`、`/archived` 跨渠道化；把 `/ws` 卡推倒重来；给 `/version`、`/send`、`/cancel` 加卡。

---

## 7. 建议排期

| 批次 | 内容 | 预估 | 可独立发布 |
| --- | --- | --- | --- |
| **0** | 菜单去别名 + 分 scope；ack 先行；进度节流；`/status` 文本补 3 个字段；平台数值实测 | 1–2 天 | ✅ |
| **1** | `shared/action-card` + `editMessageText(reply_markup)` + **审批按钮卡** | 2–3 天 | ✅ |
| **2** | 选择卡：`/models`→`/model`、`/sessionlist`→`/session`、`/conv`、`/preset*`、`/reasoning*` | 3–5 天 | ✅ |
| **3** | `/menu` hub、`/status` 卡、`/help` 分区卡、`/stop` 按钮、`/clear` 确认 | 2–4 天 | ✅ |
| **4** | `/history` 更多、`/batch` 状态卡、`/permission*`、onboarding、过程卡 | 按需 | ✅ |

实施状态（2026-10-22）：批次 0 与批次 1 均已完成并真机验证；批次 0 的「进度节流」按原计划
暂缓（与上游在途 PR #423/#425/#426 同区域，先协调）；`/stop` 按钮、`/menu`、选择卡属于批次 2/3。

## 8. 决策点（需要拍板）

1. **从哪批开工？** ✅ 已按 0 → 1 完成。
2. **是否抽 shared 抽象**——✅ `shared/action-card.mjs` 已在 Telegram 落地；飞书/QQ/企微反向迁移留作后续。
3. **是否向上游发 PR**——✅ 已提 issue #429 + PR #430/#431；`/ws` 卡片是否也提上游仍待定。
