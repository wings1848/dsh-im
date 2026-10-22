# Telegram 命令与交互审计（第二轮）

日期：2026-10-22。基线：集成分支 `feat/tg-ux-integration`（`/ws` 卡 + 批次 0/1/2 全部完成、已真机验证的构建）。
第一轮审计见 [`command-ux-audit.md`](./command-ux-audit.md)；路线图见 [`Telegram交互体验路线图.md`](../方案/Telegram交互体验路线图.md)。

## 0. 已有基线（本轮不再重复推荐）

`/ws` 工作区选择卡、审批按钮卡、`/models`+`/model` 模型卡、`/reasoninglist`+`/reasoning` 推理卡、
`/sessionlist`+裸 `/session` 会话绑定卡（已归档会话不显示）、原生命令菜单分 scope/隐藏别名、`/status` 5–6 行文本。
共享地基：`shared/action-card.mjs`（nonce/TTL/首按认领/终态）、`telegram-api.editMessageText(reply_markup)`。

## 1. P0：建议下一批就做

| # | 交互 | 现状与证据 | 建议 | 成本 | 依赖/风险 |
| --- | --- | --- | --- | --- | --- |
| P0-1 | 运行中任务加「⏹ 停止」按钮 | 任务运行时只能手打 `/stop`（`control-command.mjs:6`、`STOP_USAGE:8`）；进度消息没有按钮位 | 在进度/占位消息上挂「⏹ 停止」；按当前 turn 归属校验；点击先 ack，停止成功把按钮改成「已停止」并清键盘 | M | 与上游 #423/#425/#426 的流式/发送预算区域重叠，先开 issue 协调；复用 action-card |
| P0-2 | `/clear` 二次确认卡 | `clear-command.mjs:37,83` 直接执行；`/new` 也直接清会话，误触代价高 | `/clear` 发「确认清空 / 取消」卡；`/new` 不加确认，但成功后给「开始对话 / 菜单」按钮 | S | 飞书同样没有确认，可顺手一起补 |
| P0-3 | `/presetlist` + `/preset` 选择卡 | 仍是文字列表 + 序号（`preset-command.mjs:12,206`）；飞书已有 `presetCard`（`feishu-cards.mjs:369`） | 复用模型卡结构：单列表、当前 ✓、「跟随默认」项、点按即设、原地刷新 | S–M | 与模型卡共用分发；无新地基 |
| P0-4 | `/menu` 主菜单 hub 卡 | Telegram 仍没有 `/menu`（`command-catalog.mjs` 无此项）；飞书有 `menuCard`（`feishu-cards.mjs:136`），Telegram 是唯一没有 `/menu` 的有卡渠道 | 一张摘要卡（连接/工作区/模型/运行中）+ 入口按钮（会话/工作区/模型/预设/停止/压缩/清空/状态/帮助），子卡带「返回」 | M | 需要轻量 menu-snapshot（每段独立降级）；可先只做入口+返回 |

## 2. P1：体验打磨

| # | 交互 | 现状与证据 | 建议 | 成本 |
| --- | --- | --- | --- | --- |
| P1-1 | `/help` 分区卡 | 30 行文本墙（`text-harness-bridge.mjs:1171`、`commandHelpLines`） | 分组卡（会话/工作区/模型/任务/其他 + 返回），文字版保留在无卡渠道 | S |
| P1-2 | `/conv` 对话专属工作区卡 | `workspace-command.mjs:9,465` 仍是文字 | 复用 `/ws` 卡语义（「本对话生效」+ 清除按钮），与全局工作区卡区分标题 | S |
| P1-3 | `/status` 状态卡（可选） | 文本已 5–6 行（够用）；卡可带「刷新 / 菜单 / 模型 / 会话」按钮 | 有卡渠道发卡，无卡发文本；群聊里隐藏工作区绝对路径/模型信息（隐私） | S–M |
| P1-4 | 会话卡补「解绑 / 新会话」 | 现在只能绑定，解绑要打 `/new` 或别的命令 | 卡底加「解绑当前会话 / 开新会话」按钮，复用既有命令语义 | S |
| P1-5 | 选择卡的「假按钮」 | 分组头、页码、当前项都是 noop 按键（点了只 toast）；`telegram-api.mjs` 未透传 Bot API 10.3 的 `InlineKeyboardButton.disabled` | API 层加 `disabled` 透传，分组头/页码/当前项变成真正不可点；保留旧客户端兼容 | S |
| P1-6 | 审批卡小屏布局与长参数 | 两个按钮一行；工具参数很长时卡占满屏 | 窄屏两行布局（可选）；参数超过 N 行折叠为摘要，完整内容留在文字回退里 | S |

## 3. P2：按需/后续批次

1. `/history` 的「再看 N 条」按钮（`commandResult` 需支持附加动作按钮位）。
2. `/batch` 常驻状态卡（已收集 N 条 + 发送/取消）。
3. `/steer` 固定短语 chips（自由文本仍优先，价值有限）。
4. `/permission*`、`/watch*`、`/archived`：Telegram 缺失或依赖飞书存储，先补文本命令，跨渠道化缓做。
5. `/start` onboarding：一次性欢迎卡（菜单/工作区/模型三按钮）。
6. 过程展示：一回合一条进度消息 + 节流 + 429 背压（`telegram-runtime.mjs` 多处 `editMessageText`；与上游 #423/#425/#426 同区域，必须协调）。
7. 卡片 nonce 是内存态：宿主重启后旧卡键盘不再失效（已知限制）→ 持久化 nonce 或把 TTL 调短。
8. 群聊隐私口径：`/status`、审批卡会展示工作区绝对路径/模型名，群聊可配置隐藏或缩短。
9. 统一卡操作错误文案：toast 与聊天文字各说一遍，可合并为「toast 短提示 + 必要时一条文字」。

## 4. 明确不做/低收益

- `/version`、`/send`、`/cancel` 加卡（一句话/瞬态操作）。
- `/steer` 强制按钮化（Telegram 以自由文本为主）。
- `/watch*`、`/archived` 跨渠道化（依赖飞书专属存储，成本高）。
- 把 `/ws` 卡推倒重来（已真机验证）。

## 5. 最值得先做的一件事

**P0-1 `/stop` 按钮**：这是目前唯一「任务跑着时仍必须手打命令」的高频场景；但和上游在途 PR 同区域，
应先在上游 issue 里说明方案、避开 #423/#425/#426，再动手。
