# dsh-im 命令体验审计：Telegram 现状、飞书基线与改造建议

- 审计对象：`/home/wings/Code_Project/dsh-im`，分支 `feat/tg-workspace-picker`，HEAD `8ebef5c`（`/ws` 工作区卡片已在基线内）。
- 方法：**静态阅读源码**（未构建、未跑测试、未连真机）。每条结论带 `file:line`；代码不能证明的标「未验证」。
- 范围：`src/channels/shared/command-catalog.mjs` 的 23 个共享命令在 Telegram 的实际交互、飞书对应交互、差距；12 个渠道的能力矩阵；Telegram 技术约束；纯内部视角的实施批次。
- 不重复推荐：`/ws` 工作区卡片（`src/channels/telegram/telegram-bridge.mjs:73-126`、`src/channels/shared/text-harness-bridge.mjs:1894-2047`）已是基线，本审计把它当作可复用范式，不再列为问题。
- 图例（后文用简写）：
  - `CAT` = `src/channels/shared/command-catalog.mjs`
  - `THB` = `src/channels/shared/text-harness-bridge.mjs`
  - `MC` = `src/channels/shared/model-command.mjs`；`PC` = `preset-command.mjs`；`WC` = `workspace-command.mjs`；`HC` = `history-command.mjs`；`CC` = `control-command.mjs`；`BI` = `batch-input.mjs`；`CLC` = `clear-command.mjs`；`CMP` = `compact-command.mjs`
  - `HA` = `src/channels/shared/harness-approval.mjs`；`HQ` = `harness-question.mjs`
  - `TG-BR` = `src/channels/telegram/telegram-bridge.mjs`；`TG-RT` = `src/channels/telegram/telegram-runtime.mjs`；`TG-API` = `src/channels/telegram/telegram-api.mjs`；`TG-RM` = `telegram-rich-message.mjs`
  - `FS-CARDS` = `src/channels/feishu/feishu-cards.mjs`；`FS-BR` = `src/channels/feishu/bridge.mjs`；`FS-PANEL` = `src/channels/feishu/slash-command-panel.mjs`

---

## 0. 一页结论

1. **Telegram 当前只有两个「卡」**：`/ws` 工作区选择卡（基线）和 Harness 提问卡（`TG-BR:47-71`）。其余 22 条命令（含 `/models`、`/model`、`/reasoning*`、`/preset*`、`/sessionlist`、`/conv`、`/status`、`/help`、`/clear`、`/new`、`/stop`、`/batch`）**全部是一条或几条纯文本回执 + 要求用户手打下一条命令**。核心证据：`THB:1116-1167`（/help、/status、/new、/compact 的纯文本分支；/workspace 也在此处，只是会先尝试卡片）、`MC:280-315`（/models、/model 的文本格式）、`PC:104-133`、`WC:261-285`。
2. **飞书的「命令=卡片」覆盖也不完整，但比 Telegram 高一档**：`/workspace`、`/sessionlist` 被拦截成按钮卡（`FS-BR:1884-1901`），另有 `/m` 主菜单 hub 卡把会话/工作区/预设/模型/停止/压缩/清空/补充指令/状态/帮助都做成了卡（`FS-CARDS:136-361`）；但 `/models`、`/model`、`/reasoning*`、`/preset*` 打命令时仍是共享文本回执（`FS-BR:1338-1345`），只有从菜单卡点进去才有卡（`FS-BR:2897-2935`）。
3. **最痛的单个问题不是某条命令，而是「审批必须手打『批准』」**：Telegram 审批走纯文本（`THB:2061-2068` + `HA:19`），而共享层早已留了卡片渲染钩子（`HA:334-337`、`HA:474-480`），飞书已经在用（`FS-BR:6227-6272`）。只要给 Telegram 接上这个钩子，就能消除最常见的打字摩擦。
4. **仓库内已有 4 套独立的「菜单」实现**（飞书卡 `FS-CARDS:136-361`、企微模板卡 `src/channels/wecom/wecom-cards.mjs:43-55`、钉钉卡 `src/channels/dingtalk/dingtalk-menu.mjs:20-73`、QQ 键盘菜单 `src/channels/qq/qq-menu.mjs:89-172`），它们反复推导同一份「工作区/会话/预设/模型/任务状态」快照并把按钮落回命令文本。Telegram 是唯一没有 `/menu` 的有卡渠道。抽一份 shared `menu snapshot` 是投入产出比最高的结构性改造。
5. **Telegram 平台的最硬约束不是 64B 而是「一次 API 只能改一样」**：`TG-API.editMessageText` 只接受 `text` 或 `richMessage`，不透传 `reply_markup`（`TG-API:394-406`），`sendRichMessage` 也不支持 `reply_markup`（`TG-API:299-314`）。所以「卡片正文+键盘同时原地更新」今天必须两次调用；这是所有「点完原地变已切换」设计的第一技术前提（详见 D 节）。

### 0.1 如果只能做一批（TL;DR）

- **最该改的 5 个命令**（详见 B 节）：
  1. `/models`（含 `/model`）— 纯文本 + 手抄序号（B02/B03）
  2. `/sessionlist`（含 `/session`）— 要从多屏文本里抄 UUID（B06）
  3. `/presetlist`（含 `/preset`）— 15 分钟快照过期就报错（B05）
  4. `/status` — 只有一行，信息量比飞书的文本版还少（B08）
  5. `/help` — 30 行文本墙，没有任何可点入口（B09）
  > 补充：**审批**不是命令，但如果只能改一件事，先改审批按钮（B01）。
- **最值得做的 3 个交互模式**：
  1. **选择型卡**：一条命令既列又切，点按原地重渲染 + ✓ 当前项 + 过期/幂等明确提示（把 `/ws` 卡范式泛化）。
  2. **状态/入口卡**：无参时先给状态 + 下一步按钮（`/status`、`/model`、`/preset` 共用一套「先状态后动作」）。
  3. **动作终态卡**：点按先 ack、再干活、最后原地变「✅ 已…」并清键盘（审批、`/stop`、`/clear`、`/new` 共用）。

---

## A. 命令 × 渠道能力总表（23 个共享命令）

统计口径：`CAT` 共 23 条命令（`CAT:25-105`），Telegram 原生菜单实际注册 **27 项**（22 主命令 + 5 个可见别名，`TG-RT:23-39`，实测计数脚本见下方注）；`/help` 文本共 30 行帮助（`CAT:111-113`）。

> 注：我用 `node` 只读导入 `command-catalog.mjs` 数过菜单项 —— `catalog commands: 23 / menu entries: 27 / help lines: 30`，未运行测试。

| 命令（别名） | Telegram 当前交互（回执原文/模板；需手打什么；是否按钮化） | 飞书当前交互 | 差距 | 证据 |
| --- | --- | --- | --- | --- |
| `/new` | 文本 `已开启新会话。请发送你的问题。`；无参数；无按钮 | 文本 `已开启全新 Harness 会话。` **+ 自动重发主菜单卡** | 飞书把用户接回可点菜单，Telegram 只给一句话 | TG `THB:1142-1153`；FS `FS-BR:1846-1857` |
| `/compact` | 文本如 `已压缩 3 条历史记录（约 1200 个 token）。`；无参数；无按钮；执行前**没有** typing/占位提示（在 `sendTyping` 之前返回，`THB:1155-1169`） | 同一份共享文本（`FS-BR:1864-1868`），可从菜单按钮 `📐 压缩` 触发 | 两端都无过程反馈；Telegram 无按钮入口 | TG `CMP:36-50`、`THB:1155-1169`；FS `FS-BR:2871-2874` |
| `/clear` | 文本 `当前会话上下文已清空；Session 绑定和历史记录仍保留。`；无参数；无按钮 | 共享文本（`FS-BR:1870-1879`），菜单有 `🧹 清空上下文` 按钮 | Telegram 无按钮、无后续引导 | TG `CLC:77`、`THB:448-454`；FS `FS-BR:2875-2878` |
| `/history` | 文本 `会话历史｜<id 前 12 位>｜最近 N 条` + 编号的「用户/助手」正文 + `以上为历史记录，不是本次新回复。`；参数 `[数量]`（默认 3、最多 5）；仅私聊；无按钮 | 同一共享文本（私聊判定 `FS-BR:1713`），无卡 | 无差距（都不支持按钮） | TG `HC:7-12,69-89,118-120`；FS `FS-BR:1338-1345` |
| `/workspace`（`ws`） | **卡片基线**：`选择要切换的工作区（共 N 个）：`，每行 `✓1. <label>`，点按切换+重标键盘；>20 个工作区退回文本列表 | 文本列表换成了按钮卡 `workspaceListCard`（`1. <label>（当前）` → `workspace:<path>`） | 两端都有卡；Telegram 无分页，>20 直接降级 | TG `TG-BR:108-126`、`WC:164-194`、`THB:1894-1920`；FS `FS-BR:1899-1901`、`FS-CARDS:741-758` |
| `/conv`（`conversation`、`thread`） | 文本 `当前对话工作区：<path>` + `状态：已为该对话显式绑定/未显式绑定…` + `可切换的工作区（N）：1. …` + `用法：/conv …`；参数 `序号/绝对路径/clear`；无按钮 | **同样是纯文本**（`/conv` 没有被拦截成卡） | 两端都没卡；且正文把 `/ws` 的列表又抄了一遍 | TG/FS `WC:420-458`；FS 未拦截证据 `FS-BR:1899`（只匹配 workspace/ws/wsl） |
| `/workspacelist`（`workspaces`、`wsl`） | 与 `/ws` 同一条 listing 路径，因此**同样出工作区卡**（`WC:196-199` → `THB:1894-1920`）；菜单里已隐藏；无参数 | 被 `WORKSPACE_LIST_COMMAND` 拦截 → 工作区按钮卡 | 无功能差距；Telegram 菜单只留一个入口的做法正确 | TG `WC:196-199`、`CAT:50-52`；FS `FS-BR:1899-1901` |
| `/sessionlist`（`sessions`） | 文本 `工作区：<path>` / `会话（N）：` / `1. <标题> · 今天 14:20` + 缩进 `ID: <session-id>` / `绑定用法：/session …`；参数 `[工作区序号或路径]`、`--limit N`；无按钮；>1800 字符自动拆成多条消息 | **按钮卡**：每行 `☆ 关注` + `1. <标题>`（点按绑定），带上一页/下一页/关注列表 | 差距最大的一条：Telegram 要用户从多屏文本里抄 UUID | TG `WC:261-285,296-325,136-156`、`THB:1002-1004`；FS `FS-BR:1884-1897`、`FS-CARDS:695-736` |
| `/session` | 文本 `当前聊天已绑定会话：/工作区：…/标题：…/ID：…/归档：否/发送 /history 查看最近对话。`；参数 **Session ID 或当前列表序号**；无按钮 | 文本回执；另有卡片 `use:<id>` 按钮走 `#bindSession` 并原地刷新卡 | 飞书两条路（文本+卡），Telegram 只有文本 | TG `WC:354-418`；FS `FS-BR:2936-2942`、`FS-BR:3117-3180` |
| `/models` | 文本 `可用模型：` + 分组名 + `1. provider/model（当前）` + `切换模型：/model <序号> [推理等级ID]`；无参数；无按钮；超 1800 字符拆多条 | 命令路径同样是共享文本；只有从 `/m` 菜单点 `🧠 切换模型` 才见 `modelCard` | Telegram 无任何卡片入口；飞书卡只在菜单里，命令本身仍文本 | TG `MC:280-303`；FS `FS-BR:1338-1345,2901-2903`、`FS-CARDS:422-481` |
| `/reasoninglist`（`reasonings`） | 文本 `当前模型：`/`当前推理等级：`/`可用推理等级：` + `1. <name> (<id>)（当前、默认）` + 描述 + 切换用法；无参数；无按钮 | **纯文本，飞书也没有卡**（`feishu-cards.mjs` 无 reasoning 卡） | 两端最弱的一条；Telegram 可借此超过飞书 | TG `MC:329-365`；FS `FS-CARDS:517-566`（帮助文本里有，卡里没有） |
| `/reasoning` | 无参 → 文本当前值+三行用法；带参 → 文本 `推理等级已切换为：…`；参数 `序号/等级ID/--default`；无按钮 | 纯文本（同上） | 同 `/reasoninglist` | TG `MC:317-327,553-630` |
| `/model` | 无参 → 文本 `当前模型：…/当前推理等级：…/查看全部模型：/models…`；带参 → 文本 `模型已切换为：…`；参数 `序号或完整 provider/model` + 可选推理等级；无按钮 | 命令路径共享文本；菜单 `modelCard` 下拉可切，切完补发文本回执并原地刷新菜单卡 | Telegram 无卡；飞书的「卡+文本回执」双写也值得在改造时收敛 | TG `MC:305-315,632-737`；FS `FS-BR:3784-3806` |
| `/presetlist`（`presets`） | 文本 `当前机器人用于新会话的 Agent Preset：`/`Host 默认：…`/`可用 Agent Preset（N）：1. …（当前选择）`/三行用法；无参数；无按钮 | 命令路径文本；菜单 `presetCard` 下拉可切 | 同 `/models` | TG `PC:104-133`；FS `FS-BR:3509-3523`、`FS-CARDS:369-413` |
| `/preset` | 无参 → 文本当前设置+`已有会话不会受此设置影响`；带参 → 文本 `…已设置为：…已有会话不变。若当前聊天已有会话，请先发送 /new…`；参数 `序号/ID/id:<数字>/--default`；无按钮 | 同 `/models`（菜单卡） | 序号依赖 15 分钟快照，过期报错（见 B05） | TG `PC:93-102,135-142,144-158`；`command-list-snapshots.mjs:1` |
| `/stop` | 文本 `已请求停止当前任务。` 或 `当前聊天没有正在运行的任务。`；无参数；**无按钮**；「正在处理…」占位消息也不带键盘 | 菜单 `⏹ 停止` 按钮（点击后文本回执） | Telegram 任务运行中只能打字停止 | TG `CC:77-95`、`TG-RT:890-899`；FS `FS-BR:2879-2882` |
| `/steer` | 文本 `已提交补充指令，Agent 会在下一步读取。`；**必须手打完整指令**；无按钮 | 菜单 `➕ 补充指令` 卡：5 个快捷指令下拉 + `✏️ 更多/自定义…` 输入框 | 飞书有快捷 chips，Telegram 每次都要打全句 | TG `CC:97-119`；FS `FS-CARDS:855-912`、`FS-BR:2883-2896` |
| `/batch` | 文本 `已进入批量输入模式，最多可发送 10 条文字。完成后发送 /send，取消请发送 /cancel。`；无参数；无按钮；状态不常驻 | 共享文本（飞书菜单卡没有 batch 入口） | 两端都只能记命令；Telegram 无任何提示卡 | TG `BI:101-105,17-24`；`THB:394-432` |
| `/send` | 无回执文本，提交后直接走回答流；无参数；无按钮 | 共享文本路径 | 两端相同 | `BI:149-166`、`THB:419-430` |
| `/cancel` | 文本 `已取消批量输入，共丢弃 N 条消息。`；无参数；无按钮 | 共享文本路径 | 两端相同 | `BI:141-147` |
| `/status` | 单行 `Telegram机器人与 DeepSeek Harness 连接正常。`；无参数；无按钮；**不含**工作区/预设/模型/绑定会话/任务状态 | `/status` 文本版更详细（连接+工作区+预设）；菜单 `📊 状态` 才出 `statusCard`（连接/工作区/预设/模型/会话数） | Telegram 只有一行，飞书文本版都比它多，卡版信息更全 | TG `THB:1125-1129`；FS `FS-BR:1860-1862,3549-3572,494-508` |
| `/version` | 文本 `dsh-im v<version>`；无参数；无按钮 | 同文本 | 无差距（不需要卡） | TG/FS `CC:71-75` |
| `/help` | 文本 4 行开场 + 30 行帮助（来自 `CAT`）；无参数；无按钮 | `/help` 返回 `menuHelpText()` 长文本（含 `/m`、`/watch`、`/permission`、`/repair` 等飞书专属命令）；菜单 `📖 帮助` 才出 `helpCard` | Telegram 帮助是一堵墙；飞书卡也只是把同一堵墙装进卡里，但至少有分区按钮。另：飞书 `/help` 文本第一行承诺「回复数字即可」（`FS-CARDS:519`），但数字只有先出过菜单卡才有上下文（`FS-BR:1934-1940`），`/help` 本身不建菜单 → 文案与能力漂移的现成例子 | TG `THB:1116-1124`、`CAT:111-113`；FS `FS-BR:1838-1841`、`FS-CARDS:517-566,628-649` |

**飞书/其他渠道有、Telegram 完全没有的命令（能力差，不是交互差）**

| 命令 | 飞书当前 | Telegram | 证据 |
| --- | --- | --- | --- |
| `/menu`、`/m` | 主菜单 hub 卡（会话/工作区/预设/模型下拉 + 新会话/会话列表/停止/压缩/清空/补充指令/归档/状态/帮助 + 数字兜底） | 不存在 | `FS-BR:1842-1844`、`FS-CARDS:136-361`、`CAT:25-105` |
| `/permissionlist`、`/permission` | 共享 `permission-command.mjs`，飞书/企微/QQ 已接 | 不存在（`TextHarnessBridge` 未 import permission 模块） | `src/channels/shared/permission-command.mjs:1-12`；`FS-BR:3,1829-1836`；`src/channels/wecom/wecom-bridge.mjs:989`；`src/channels/qq/qq-bridge.mjs`（`isPermissionCommand`） |
| `/watch`、`/unwatch`、`/watchlist` | 飞书专属会话关注 + 完成推送 | 不存在 | `FS-BR:1903-1916`、`FS-CARDS:760-818` |
| `/archived on/off` | 飞书会话列表归档显隐 | 不存在 | `FS-BR:1917-1930` |
| `/repair` | 飞书权限/卡片回调修复 | 不存在（Telegram 无卡片回调权限概念） | `FS-PANEL:58`、`FS-BR:1828-1831` |

> 观察：Telegram 的原生菜单 27 项里已经有 5 项是别名（`conversation`、`thread`、`sessions`、`reasonings`、`presets`，见 `TG-RT:23-33`），而飞书的 `/` 面板只注册主名（`FS-PANEL:27-59`）。这属于「菜单里该放什么」的交互差异（B16）。

---

## B. 19 条命令体验问题

工作量口径：**S** ≤ 1 天且单文件为主；**M** 2–3 天、跨 2–3 文件、需要一个小抽象；**L** > 3 天、需要新共享层或改多处状态模型。所有「建议交互」都写成用户看到/做到的动作序列。

### B01 审批只能手打「批准 / 拒绝」（跨命令，收益最大）
- 现状：审批走纯文本，提示语 `请精准回复「批准」或「拒绝」（也支持：同意 / 不同意 / yes / no）。`（`HA:19`）；Telegram 的 `#handleInteraction` 只传 `send`，不传 `render`（`THB:2061-2068`）。共享层其实有钩子：`const render = typeof context?.render === 'function' ? context.render : null`（`HA:334-337`），`#present` 里 `if (pending.render) await pending.render(...)`（`HA:474-480`），飞书正是一路（`FS-BR:6227-6272`）。
- 痛点：中文短语必须逐字打对；群聊里还要先 @ 机器人；打错后审批继续挂着直到超时（`HA:19` 的提示语也只教打字）；手机上输入成本最高的一类操作。
- 建议交互：`工具要执行 bash（参数已截断）` 卡片 → `[✅ 批准]` `[❌ 拒绝]` → 点 `✅` 后按钮消失、原消息底部出现 `✅ 已批准，仅对本次操作有效。`；别人点 → toast `只有发起当前任务的用户可以处理这条问题。`（`THB:1825-1827` 已有同款文案）。
- 模块：`HA`（不用改语义，只补 Telegram renderer）+ `THB:2055-2068`（传 render）+ `TG-BR`（新增审批卡 render/parse）+ `TG-RT`（登记/清理键盘）。需要新 shared 抽象：**是**，把「交互卡（提问/审批）」统一成一个 `actionCard` 描述（render/parse/回调命名空间），否则每加一种卡都要复制 workspace 的 nonce 逻辑。
- 工作量：**M**。风险：审批 ID 是 UUID，不能直接进 `callback_data`（64B 约束，`TG-API:58-92`），必须 nonce→pending 映射；卡片发送失败必须回退纯文本（飞书已有 fallback 先例 `FS-BR:6250-6258`），否则审批直接丢失。

### B02 `/models` 纯文本 + 手抄序号 + 长列表拆多条
- 现状：`formatCatalog` 输出带全局序号的文本（`MC:280-303`），回执 1800 字符就拆（`WC:14,136-156`；`THB:1002-1004` 逐条 `sendText`）。
- 痛点：模型多时列表变 3–4 条消息，序号和名称被拆开；用户要回到上面找序号；打错序号得到 `模型序号无效：X`（`MC:249-255`）再重来。
- 建议交互：`发 /models` → 一张 `🧠 选择模型（第 1/3 页）` 卡，按 8 行/页：`1. deepseek-official/deepseek-v4-pro ✓`、…、`[下一页 ▶]`、`[🎚 推理等级]`；点第 2 个 → 卡片原地变 `✅ 模型已切换为 deepseek-official/deepseek-v4-pro`，并保留 `[切换推理等级] [返回列表]`。
- 模块：`MC`（把 `formatCatalog` 的结果再给一份机器可读 `catalog`，workspace 卡的 `listing` 已是先例 `WC:158-187`）+ `TG-BR`（模型选择卡）+ `THB`（卡片按压→复用 `runModelCommand('/model <id>')`，避免第二套切换逻辑，飞书 `#handleModelSelect` 就是这么做的 `FS-BR:3784-3792`）。
- 工作量：**M**。风险：点按后必须对实时 catalog 复核（不能在快照里盲切）；按钮文字需要截断（`workspaceLabels` 的 22 字规则 `src/channels/shared/workspace-labels.mjs:18,57-62` 可复用）；`callback_data` 只能带 nonce+页码+行号。

### B03 `/model` 无参只报状态，没有入口
- 现状：无参回 `当前模型：…/当前推理等级：…/查看全部模型：/models`（`MC:305-315`）。
- 痛点：看完状态想改，必须再记两条命令；改推理等级还要知道 `/reasoninglist`。
- 建议交互：`发 /model` → `⚙️ 当前模型` 卡（模型 / 推理等级 / `[🧠 换模型] [🎚 换推理等级] [🔄 刷新]`）；点 `🎚` 直接原地换成 B04 的推理等级卡。
- 模块：`MC`（状态文本→结构化状态对象）+ `TG-BR`；shared 抽象：状态卡模板（B08 共用）。
- 工作量：**S**。风险：无会话时卡片要能解释「先发一条消息创建会话」（现有 `noSessionMessage` 文案 `MC:367-374` 可直接搬进卡）。

### B04 `/reasoninglist` + `/reasoning` 两步纯文本（飞书也没有卡，可反超）
- 现状：`/reasoninglist` 输出文本（`MC:329-365`），`/reasoning N` 再输出 `推理等级已切换为：…`（`MC:615-625`）；`--default` 也要手打（`MC:587`）。
- 痛点：等级名和 ID 很长（`name (id)`），手打基本不可能，只能打序号；而序号只在「当前模型」下有意义，换模型后旧序号作废（`MC:265-278,590-604` 的报错说明）。
- 建议交互：`发 /reasoninglist` → `🎚 推理等级 · 当前模型 <model>` 卡，每个等级一行（`✓ 高 (high) — 更慢更准`），底部 `[恢复默认] [🧠 换模型]`；点某行 → 原地变 `✅ 推理等级已切换为 高 (high)`，并注明 `后续消息生效`。
- 模块：`MC`（导出结构化 efforts）+ `TG-BR` + `THB`（按压走 `runModelCommand('/reasoning <id>')`）。shared 抽象：**否**（模型选择卡的变体即可，前提是 B02 的通用选择卡先落地）。
- 工作量：**S/M**。风险：`--default` 需要独立按钮（语义是「清空」）；切换时任务在跑会失败（`MC:579-581`），卡上要留 `请先 /stop` 的失败回执路径。

### B05 `/presetlist` + `/preset` 依赖 15 分钟快照 + 纯文本
- 现状：`/presetlist` 把 ID 列表存进内存快照（`PC:218`、`command-list-snapshots.mjs:1` TTL 15 分钟），`/preset 2` 从快照解析（`PC:144-158`），过期/重启后报 `请先执行 /presetlist，再按列表序号选择 Agent Preset。`；纯文本输出见 `PC:104-133`。
- 痛点：用户看完列表去泡杯茶回来，序号就失效；「按序号选择」在手机上还要记住序号。
- 建议交互：`发 /presetlist` → `🤖 选择 Agent Preset（仅影响新会话）` 卡，每行一个预设 + 当前标记 + `[跟随 Host 默认]`；点选 → 原地变 `✅ 已设置：<label>（<id>）`，并补一行 `已有会话不变；发 /new 后再发消息才会用新预设`（文案取自 `PC:140`）。
- 模块：`PC`（把 `formatList` 结果附一份机器可读 items）+ `TG-BR` + `THB`（按压走 `runPresetCommand('/preset <id>')`，飞书 `#handlePresetSelect` 同款 `FS-BR:3755-3782`）。shared 抽象：**否**（B02 的通用选择卡）。
- 工作量：**S/M**。风险：卡片持有的是 ID 而不是序号，绕开了 15 分钟快照的脆弱点（这点必须写进实现注释）；预设是 bot 级设置，卡上必须写清作用域，否则用户以为只影响本对话。

### B06 `/sessionlist` + `/session`：从多屏文本里抄 UUID
- 现状：会话列表是文本（`WC:261-285`），每行带 `ID: <session-id>`；超过 1800 字符拆多条（`WC:136-156`）；绑定要 `/session <ID>` 或序号（`WC:354-418`）。
- 痛点：手机上看不到完整列表、抄不了长 ID；列表分页/条数不受控（`--limit` 要手打）；绑定成功后没有「继续做什么」的入口。
- 建议交互：`发 /sessionlist` → `📂 会话列表（工作区 <path>）` 卡，每行 `1. 标题 · 今天 14:20`，行尾 `[绑定]`；`[上一页] [下一页]`；点绑定 → 卡片原地变 `✅ 已绑定：<标题>` + `[查看历史] [继续对话]`。
- 模块：`WC`（会话列表已拆出 `sessionListMessage`，但需要机器可读 `sessions`）+ `TG-BR` + `THB`（按压复用 `bindWorkspaceSession` 并复用 `sessionBindErrorMessage`，`WC:327-352` 的错误分类不能另写一套）。shared 抽象：**是**，需要「分页列表卡」的通用模型（页码/每页数/陈旧复核）；飞书 `MENU_PAGE_SIZE=10`（`FS-CARDS:21`）与 QQ 6/页（`src/channels/qq/qq-menu.mjs:8`）已是两个不同实现。
- 工作量：**M**。风险：`session-id` 长度远超 64B，必须 nonce→sessionId 映射；渲染与点击之间列表可能变化，需实时复核（workspace 卡已示范「不信任快照」`THB:2005-2015`）；群聊绑定会话是共享状态，按钮必须过命令权限闸门（`THB:1990-1997` 已有先例）。

### B07 `/conv` 把 `/ws` 的列表抄一遍，却没有按钮
- 现状：无参 `/conv` 输出当前对话工作区 + 绑定状态 + 完整工作区编号列表 + 用法（`WC:432-451`），且有 `try { workspacePathSnapshot } catch {}` 静默降级（`WC:440-448`）。
- 痛点：与 `/ws` 内容 90% 重复；明明已经能列出来，却要用户再打 `/conv 2`；「显式绑定 vs 跟随默认」的文字说明很长（`WC:436-438`）。
- 建议交互：`发 /conv` → 复用工作区选择卡，标题换成 `为当前对话选择工作区`，每行标签加 `（bot 默认）` 区分；底部 `[恢复跟随 bot 默认]`；点选 → 原地变 `✅ 本对话固定到 <path>`。
- 模块：`WC` + `TG-BR`（给 `TELEGRAM_WORKSPACE_CARD` 加 mode：`bot-default` / `conversation`，回调命名空间 `w2|nonce|index` 与现有 `w1|` 区分）+ `THB`（`#handleWorkspaceCardPress` 按 mode 调 `switchWorkspace` 或 `switchConversationWorkspace`）。
- 工作量：**M**。风险：改的是共享卡抽象，飞书后续也能直接复用；`/conv clear` 需要单独按钮而不是输入 `clear`；群聊 topic 的 conversationKey 语义（`WC:201-207`）不能被卡片绕过。

### B08 `/status` 只有一行，信息量低于飞书的文本版
- 现状：`await this.#harness.ensureRunning(); sendText('Telegram机器人与 DeepSeek Harness 连接正常。')`（`THB:1125-1129`）。
- 痛点：用户真正想知道的是「我在哪个工作区/哪个模型/预设是什么/绑定的是哪个会话/任务在跑吗」；现在这些都要再发 3–4 条命令才能拼出来。
- 建议交互：`发 /status` → `📊 状态` 卡：连接 ✅ / 工作区 / 预设 / 模型 / 当前会话（标题+短 ID）/ 任务：处理中/空闲；底部 `[🔄 刷新] [🧠 模型] [📂 工作区]`。
- 模块：`THB`（状态分支改成结构化）+ 新建 shared `status snapshot`（字段取飞书 `statusCard` `FS-CARDS:494-508` 与 QQ 状态明细 `qq-menu.mjs:111-121` 的并集）+ `TG-BR`。
- 工作量：**S/M**。风险：一次 `/status` 会触发 workspaceSessions/presets/models 3 个 RPC，必须像飞书一样各段独立降级（`FS-BR:3364-3475` 的 `Promise.all` + 每段 catch）；慢 RPC 不能拖住连接确认那一行。

### B09 `/help` 是一堵 30 行文本墙，且没有可点入口
- 现状：`[{label}机器人已连接…, '', 直接发送文字…, ...commandHelpLines]`（`THB:1116-1124`；30 行来自 `CAT:111-113`）。
- 痛点：只列命令不列「我现在能做什么」；没有任何按钮；用户看完还得回到输入框打命令；也没覆盖 Telegram 已有的卡片（/ws）和交互卡。
- 建议交互：`发 /help` → `📖 帮助` 卡：4 个分区按钮 `[📂 工作区与会话] [🧠 模型与预设] [🧹 会话维护] [📊 状态]`，底部 `[查看完整命令列表]`（点了再发/展开纯文本全文，保留现有 30 行）。
- 模块：`CAT`（已是单一事实源，别在 Telegram 另写一份）+ `THB`（/help 分支）+ `TG-BR`。shared 抽象：**是**，`help` 的「分区 + 命令明细」模型可给飞书/企微复用（它们各自抄了 `menuHelpText` `FS-CARDS:517-566`、`wecom` 帮助文本）。
- 工作量：**M**。风险：把 `/help` 改成卡后，纯文本渠道（Slack/Email…）必须保持原文本；卡里别再复制一份命令清单，避免和 `CAT` 漂移。

### B10 任务在跑时没有可点的 `/stop`
- 现状：进度占位消息是 `正在处理…`（`TG-RT:890-899`），不带键盘；停止只能 `/stop`（`CC:77-95`）。
- 痛点：长任务时用户要切键盘打命令；群聊还要 @ 机器人；「取消」是移动端最高频操作。
- 建议交互：进度消息发成 `正在处理…  [⏹ 停止]`；点 `⏹` → toast `已请求停止当前任务。`，按钮立即变灰/移除；任务结束或失败时 `editMessageReplyMarkup(空)` 收掉按钮（`TG-API:278-288`）。
- 模块：`TG-RT`（占位消息带 markup 且保留 messageId）+ `THB`（`#dispatchTrigger` 所在流程里把 stop 卡回调接进 `acceptCallback`，需要新命名空间 `s1|nonce`）+ `CC`（复用 `runControlCommand('/stop')` 语义，不要重写停止逻辑）。
- 工作量：**M**。风险：终态清除键盘必须做，否则任务结束后按钮还在（点击会落到「该问题已处理」的通用提示 `THB:1824`，语义错误）；`editMessageText` 不会自动清键盘（见 D 节）；群聊里按钮要校验点击者身份（`THB:1825-1827` 模式）。

### B11 `/new`、`/clear` 成功后没有下一步入口
- 现状：`/new` 回 `已开启新会话。请发送你的问题。`（`THB:1152`）；`/clear` 回一句成功文本（`CLC:77`）。飞书 `/new` 会重新发菜单卡（`FS-BR:1846-1857`），`/new` 卡片动作还会把执行状态写回卡（`FS-BR:2833-2847`、`FS-CARDS:158-169`）。
- 痛点：清空/新会话之后用户最常见的下一动作是「换工作区」「换模型」「看状态」，现在都得再打命令。
- 建议交互：`/new` → `✅ 新会话已开启（工作区 <path>）` 卡 + `[📂 换工作区] [🧠 选模型] [📊 状态]`；`/clear` → `✅ 上下文已清空（绑定与历史保留）` + `[🆕 开新会话] [📊 状态]`。
- 模块：`THB` + `TG-BR`（复用 B02/B08 的卡）；shared 抽象：上文的 `actionCard`/`status card`。工作量：**S**（如果 B02/B08 已经落地）。
- 风险：`/new` 在群里是共享会话重置，卡片要提示作用域；`/clear` 失败文案很多（`CLC:11-29` 共 8 类），卡必须透传原文，不能吞掉。

### B12 `/batch` 没有按钮，状态不常驻
- 现状：进入批量模式后只有一句说明（`BI:101-105`），之后每收一条只回计数（`BI:193-198`），提交靠 `/send`、取消靠 `/cancel`；命令被写死识别（`BI:5-6`）。
- 痛点：10 条收集期间没有常驻的「提交/取消」按钮；不小心发错一条无法删除；`/send`/`/cancel` 都要记。
- 建议交互：`/batch` → `📥 批量输入 (0/10)  [📨 提交] [✖ 取消]` 卡；每收 3 条（或满 10 条时）编辑一次计数；点提交 → 卡片变 `⏳ 已提交 7 条，正在处理…`；点取消 → `已取消，丢弃 7 条`。
- 模块：`BI`（`handle()` 已返回 count/limit，卡只需读它）+ `THB:394-445`（批量分支里发卡）+ `TG-BR`。shared 抽象：**否**（逻辑都在 `BI`），但如果做通用 `actionCard` 可复用。
- 工作量：**M**。风险：每次收集都改卡会撞编辑限流（见 D 节），必须节流；重启丢失批次的既有语义（`docs/bot-commands.md:30`）不能因卡而改变。

### B13 `/history` 仅私聊、最多 5 条、没有翻页入口
- 现状：`MAX_MESSAGES=5`、私聊限定（`HC:9,118-119`）、正文截断 500 字符起步并按长度递减（`HC:79-88`）；没有更多/更早的按钮。
- 痛点：看完最后 3 条想再往前看没有入口；只能改数字重打 `/history 5`；正文被截断后无法展开。
- 建议交互：保留文本（隐私内容不宜进卡片正文的按钮），但末尾加 `[再看 5 条] [📊 状态]`；`[再看 5 条]` 按压后用相同的 `beforeSeq` 分页（`HC:139-183` 已有分页循环）再发一条。
- 模块：`HC`（把 records 和分页游标一起返回）+ `THB:448-454`（history 走 fast command，需要扩展返回值）+ `TG-BR`。shared 抽象：**是**（命令结果附带「动作按钮」的能力，目前 `commandResult` 只有 `message/messages/listing/stopped` 几种扩展位，`WC:28-30`、`MC:19-25`）。
- 工作量：**M**。风险：只有私聊才允许，按钮也要沿用 same-actor 校验；历史里可能有敏感内容，卡片正文别重复展示。

### B14 「上限即降级」：>8 选项的提问、多选、>20 工作区直接退回纯文本
- 现状：提问卡 `options.length > MAX_CARD_OPTIONS(8)` 或 `multiSelect` 就 `return null`（`TG-BR:14,47-55`）；工作区卡 `paths.length > MAX_WORKSPACE_BUTTONS(20)` 就 `return null`（`TG-BR:78,112`）→ 调用方回退文本（`THB:1896-1901,1911-1919`）；多选问题只能回文字（`THB:1849-1851`）。
- 痛点：工作区多的人（20+）永远用不上卡；多选问题在 Telegram 上退化成「打逗号分隔的序号」，比飞书多选下拉差一档（`FS-CARDS:763-796` 多选下拉）。
- 建议交互：工作区/模型/会话列表统一「每页 8 个 + 上一页/下一页」而不是整体降级；多选问题改成「点一项切换 ✓，最后点 [提交]」（同一张卡上累加选择，`callback_data` 带选项位掩码或 nonce+index 缓存）。
- 模块：`TG-BR`（两个上限常量的策略）+ `THB`（渲染失败时改为分页而不是直接放弃）+ `TG-API`（键盘复用）。shared 抽象：**是**，分页列表卡模型 + 「多选卡」的状态机。
- 工作量：**M**（分页）/ **M**（多选卡）。风险：多选卡需要服务端保存「已勾选项」，要做 TTL + 单卡权威；分页要防「第 3 页点了但列表只剩 2 页」。

### B15 群聊里手打命令被静默忽略
- 现状：群消息只有在 `addressed` 时才进命令分发（`THB:455`）；群消息非 addressed 在 `#process` 直接静默返回（`THB:1103-1106`，只加 rejected 计数）；addressed 的判定是 @机器人 或回复机器人消息（`TG-RT:296-303`、`src/channels/telegram/group-triggers.mjs:118-130`）。
- 痛点：群成员习惯性打 `/stop`、`/models`，机器人完全没反应，用户以为坏了；原生菜单点选在客户端会带 `@botusername` 所以能用，但手打不带（未验证具体客户端的插入文本）。
- 建议交互：非 addressed 的已知命令 → 回一条一次性提示 `群聊里用命令请 @我，例如 /stop@<bot>`（带「不再提示」的按钮可选）。
- 模块：`THB:1103-1106`（加分支）+ `command-permission.mjs:16-34`（判定是不是已知本地命令）+ `TG-BR`（渠道文案里带 username）。shared 抽象：**否**。
- 工作量：**S**。风险：群里刷提示会烦，需要节流（同一群 10 分钟一次）与开关；不能把普通以 `/` 开头的自然语言误判成命令（用 `isSharedLocalCommand` 白名单，别用 `startsWith('/')`）。

### B16 原生菜单 27 项里有 5 个是别名，菜单噪音
- 现状：`commandMenuEntries` 把每个命令和它的可见别名都注册（`TG-RT:23-33`），实际注册 27 项；`workspace`、`workspacelist` 已隐藏别名/自身（`CAT:41-52`），但 `conversation`、`thread`、`sessions`、`reasonings`、`presets` 仍各占一项（`CAT:45-76`）。
- 痛点：手机端点开菜单看到 `sessions/session`、`reasonings/reasoning` 两两并列，不知道区别；菜单越长越难扫；Telegram 菜单没有分组，只能靠名字。
- 建议交互：原生菜单只留 22 个主名；别名继续可打（`menuVisible:false` 即可，`CAT:23-24` 的语义已支持）。`/help` 文本里以 `workspace (ws)` 形式展示别名（`docs/bot-commands.md:39` 已经是这种文档口径）。
- 模块：`CAT`（5 个 alias 加 `menuVisible:false`）+ 测试 `test/channels/telegram/command-menu.test.mjs`。shared 抽象：**否**。
- 工作量：**S**。风险：极小；要同步更新 `docs/bot-commands.md` 里「原生菜单」的描述。

### B17 Telegram 命令面缺 `/menu`、`/permission*`、`/watch*`、`/archived`
- 现状：`CAT` 23 条里没有这些；`TextHarnessBridge` 也没 import `permission-command`（`THB:1-76` 的 import 列表）；飞书/企微/QQ 都接了 permission（见 A 节附表）。
- 痛点：这不是「体验差」而是「能力缺」：同一套 dsh-im，Telegram 用户切不了权限档位、没有关注推送、没有菜单 hub。
- 建议交互：`/menu` 做成 Telegram 主菜单卡（内容对齐 QQ 的 13 项：会话/工作区/模式/模型/新会话/会话列表/停止/压缩/清空/补充指令/归档/状态/帮助）；`/permissionlist`、`/permission` 直接复用共享模块的文本回执（先不做卡）。
- 模块：`CAT`（加命令）+ `THB`（接 `runPermissionCommand`，参考 `FS-BR:1829-1836`）+ `command-permission.mjs`（把新命令算进本地命令）+ `TG-BR`（/menu 卡）。shared 抽象：**是**（菜单快照，见 C 节）。
- 工作量：**M**（permission 文本）/ **L**（/menu 卡 + shared 快照）。风险：`/watch` 依赖飞书专属的关注存储（`src/channels/feishu/` 内），跨渠道化是另一个 L 级项目，本期建议只做 `/menu` + `/permission*`。

### B18 回调 ack 偏晚：spinner 转在业务 await 之后
- 现状：提问卡点击后先 `await pending.presentationTask` 再 `answerCallbackQuery`（`THB:1853-1858`）；工作区卡点击后先 `await harness.switchWorkspace(path)`、改键盘，最后才 `notice('工作区已切换为…)`（`THB:2016-2037`）；`answerInteractionCallback` 本身没有超时保护，只有注释「Acknowledge a press so the client stops its spinner」（`THB:1777-1788`、`TG-RT:634-641`）。
- 痛点：工作区切换/会话绑定慢时，用户看到按钮一直转圈，会连点（代码已用 `submitting` 防重复，但体验仍是「卡住了」）。
- 建议交互：点按瞬间只 ack 无文案（或 `处理中…`），结果用编辑卡片正文/终态来承载；把「成功 toast」改成「卡片变已切换」。
- 模块：`THB`（所有 callback 出口统一先 ack）+ `HA`/`HQ` 的 present 顺序。shared 抽象：**是**（回调生命周期：ack → 认领 → 执行 → 终态），否则每条卡都自己记得先 ack。
- 工作量：**S**。风险：`answerCallbackQuery` 只能答一次，改结构时别在后续路径再答（当前代码没有重复答检测）；toast 变卡文会改变用户预期，需要文案统一。

### B19 进度编辑没有时间节流，429 只打日志
- 现状：Telegram 的进度流 `TelegramDeliveryStream.update()` 只做「文本相同就跳过」的去重，**没有时间间隔**（`TG-RT:457-471`），每次 tool/text 进度都直接 `editMessageText`（`TG-RT:905-922`）；失败时仅 `logger.warn`（`TG-RT:467-470`）。对比：共享 `createEditableMessageStream` 有 `updateIntervalMs = 800` 的节流（`src/channels/shared/editable-message-stream.mjs:19-57`）。
- 痛点：工具密集回合里编辑频率高，一旦被限流，进度就「停更」且用户无感；结局仍是好的，但过程体验差。
- 建议交互：对 `update()` 加最小间隔（800–1000ms）并合并最新帧；429 时按 `retry_after`（`TG-API:478-482` 已解析）延后一帧，不重试旧帧。
- 模块：`TG-RT`（`TelegramDeliveryStream` 内部加节流）+ `TG-API`（把 `retry_after` 变成可消费的延迟）。shared 抽象：**否**（或把节流策略上移到共享工具，Slack/Discord/Matrix 也各有一份 stream）。
- 工作量：**S**。风险：首帧/末帧不能延迟（finish 必须立即落）；节流时长是经验值，真机 429 阈值未验证。

---

## C. 渠道能力矩阵

| 渠道 | 卡片 | 按钮/回调 | 编辑消息 | 原生命令菜单 | 编号回复回退 | 证据（代码） |
| --- | --- | --- | --- | --- | --- | --- |
| telegram | ✅ 手写 inline keyboard（仅工作区卡/提问卡；审批/模型/预设/会话/状态/帮助无卡） | ✅ callback_query；`answerCallbackQuery`；`callback_data ≤64B` 校验 | ✅ `editMessageText`（不含键盘）/`editMessageReplyMarkup`；富文本 `editMessageText(richMessage)` | ✅ `setMyCommands` 27 项 + 命令按钮 | ❌ | `TG-BR:47-126`、`TG-RT:585-961`、`TG-API:58-92,254-405` |
| feishu | ✅ 全套（menu/preset/model/sessionList/workspaceList/watchList/help/steer/status/completion/approval/question/stepStream） | ✅ `card.action.trigger` + 按钮/下拉/多选/表单 | ✅ `im.v1.message.patch` 原地换卡 | ✅ `/` 面板 31 项（`app_slash_commands` API 服务端注册） | ✅ 回复数字（菜单上下文） | `FS-CARDS:136-1330`、`FS-BR:2672-2950,3258-3321`、`FS-PANEL:27-59`、`src/channels/feishu/slash-command-registry.mjs:1-17` |
| slack | ❌ 只发 markdown block | ❌ 无按钮回调 | ✅ `chat.update`（流式） | ❌ 无 slash 注册（桌面端会拦截 `/` 消息，需前置空格） | ❌ | `src/channels/slack/slack-api.mjs:275-285`、`slack-runtime.mjs:357-405`、`docs/bot-commands.md:12` |
| discord | ❌ | ❌ 无 components/interaction | ✅ 编辑消息（`openStream` 1,900 字符/条） | ❌ | ❌ | `src/channels/discord/discord-runtime.mjs:438-500` |
| whatsapp | ❌ | ❌ | ✅ Baileys `edit` 字段 | ❌ | ❌ | `src/channels/whatsapp/whatsapp-runtime.mjs:504-548,523-537` |
| matrix | ❌ | ❌ | ✅ `m.replace` 编辑 | ❌ | ❌ | `src/channels/matrix/matrix-runtime.mjs:246,711,1163-1193,1502+` |
| qq | ⚠️ 官方「键盘」按钮 + markdown（msgType 2） | ✅ 键盘按钮回调（opaque token） | ❌ 未实现编辑 | ⚠️ `/m` 是聊天内菜单卡，不是输入框原生命令 | ✅ 同一条菜单可回数字 | `src/channels/qq/qq-menu.mjs:7-14,174-208`、`qq-bridge.mjs:471,550-559` |
| wecom | ✅ template_card（`button_interaction` / `multiple_interaction`） | ✅ `template_card_event` 回调 | ✅ `updateTemplateCard`（卡片原地更新） | ⚠️ `/m` 聊天内菜单卡 | ❌ | `src/channels/wecom/wecom-cards.mjs:3-8,75-93`、`wecom-bridge.mjs:703-736,763-836,839-880` |
| wecom-app | ❌ 只有文本 | ❌ | ❌ | ❌ | ❌ | `src/channels/wecom-app/wecom-app-runtime.mjs:191,222`、`wecom-app-bridge.mjs:78-104,318-325` |
| dingtalk | ✅ 卡片实例（AI card / menu card） | ✅ `/v1.0/card/instances/callback`，先 ack 再处理 | ✅ `updateMenuCard`/card stream | ⚠️ `/m` 聊天内卡片菜单 | ❌（卡片选择后合成命令） | `src/channels/dingtalk/dingtalk-menu.mjs:5-95`、`dingtalk-bridge.mjs:871-905`、`dingtalk-runtime.mjs:278-291` |
| email | ❌ | ❌ | ❌（邮件不可编辑） | ❌ | ❌ | `src/channels/email/email-bridge.mjs:7-8`、`email-runtime.mjs:229-240` |
| imessage | ❌ | ❌ | ❌（AppleScript 只能发） | ❌ | ❌ | `src/channels/imessage/runtime.mjs:12-15`、`imessage-api.mjs:233+` |

> 另：`src/channels/weixin/` 存在，但不在本次 12 渠道清单内（未读，未验证）。

### C 结论 1：能放 shared 层的

1. **命令目录与帮助**：`CAT` 已是唯一事实源（`CAT:25-105`），但帮助文案在飞书 `FS-CARDS:517-566`、企微 `wecom-bridge.mjs:82-116`、QQ 帮助页（`qq-menu.mjs:162-172`）各抄了一份 —— 应收敛为「目录 + 每渠道附加命令」。
2. **列表快照与「非直接索引」**：workspace 卡用 nonce+index+TTL（`THB:79-81,1899-1965`），QQ 用 opaque token+15min+单次 claim（`qq-menu.mjs:32-71`），钉钉用 revision（`dingtalk-menu.mjs:61-71`），飞书用菜单仓库与 `cardKeys`（`FS-BR:3032-3050,728,2429-2468`）。这是同一件事的 4 份实现 → 抽 `shared/action-card`（nonce 仓库 + TTL + 首按认领 + 陈旧复核 + 终态文案）。
3. **菜单/状态快照**：飞书 `#sendMenuCard`（`FS-BR:3364-3475`）、钉钉 `dingtalkMenuSnapshot`（`dingtalk-menu.mjs:20-73`）、QQ `qqMenuView` 快照（`qq-menu.mjs:89-172`）、企微 `#runMenuCommand`（`wecom-bridge.mjs:839-880`）都在并行拉「工作区+会话+预设+模型+归档+任务状态」→ 抽 `shared/menu-snapshot`（各段独立 catch 的降级策略照抄飞书）。
4. **动作 → 命令文本的重放**：QQ 的 `action.kind:'command'`（`qq-menu.mjs:12,120-147`）、企微的 entries 直接是 `/new`、`/stop` 命令串（`wecom-cards.mjs:48-55`）、钉钉 `dingtalkMenuCommand` 返回命令文本（`dingtalk-menu.mjs:75-89`）——同一个模式。Telegram 的卡也应该走「合成命令 → 复用 `run*Command`」，而不是为每种卡写一套业务逻辑。
5. **审批/提问的终态与权限语义**：`HA` 已有 `approvalId`、actor 校验、`submitByApprovalId`、render 钩子（`HA:334-337,400-406,467-500`）；`HQ` 已有选项解析（`HQ:53-95`）。缺的是把「点击 → 认领 → 提交 → 终态卡」抽象成渠道无关的 action 定义。
6. **标签规则**：`workspaceLabels` 已跨渠道共享（`workspace-labels.mjs:1-65`）；模型/预设/会话标题也需要同样的截断/去歧义规则（飞书会话卡只做 `safeTitle`，`FS-CARDS:96-98`）。

### C 结论 2：必须留在 channel adapter 的

- 卡片/键盘的结构与上限：飞书 schema 2.0 的 `column_set`/`select_static`/`form`（`FS-CARDS:34-79`）；Telegram `inline_keyboard` 与 64B 回调（`TG-API:58-92`）；企微「多选卡最多 3 个选择器、每个下拉最多 10 项」（`docs/bot-commands.md:8`、`wecom-cards.mjs:14-22`）；QQ 每页 6 个 + 3 列（`qq-menu.mjs:8,181-192`）；飞书每页 10 个（`FS-CARDS:21`）。
- 编辑/原地更新机制：Telegram 两种 API 分开（`TG-API:278-288,394-406`）；飞书 `message.patch`（`FS-BR:3258-3273`）；企微 `updateTemplateCard`（`wecom-bridge.mjs:797`）；钉钉 `updateMenuCard`（`dingtalk-bridge.mjs:977-981`）。
- 原生/平台级菜单注册：Telegram `setMyCommands` + `setChatMenuButton`（`TG-RT:1264-1272,1345-1351`）；飞书 `app_slash_commands`（`slash-command-registry.mjs`）；Slack/Discord 无实现（见矩阵）。
- 回调应答机制：Telegram `answerCallbackQuery`（一次一答）；飞书直接回 HTTP/事件 ack；钉钉先 `socketCallBackResponse` 再处理（`dingtalk-runtime.mjs:283-285`）——这是「先 ack 再干活」的仓内正面样板（对照 B18）。
- 降级形态：Telegram 卡发不出去 → 文本（`THB:1911-1919`）；QQ 键盘被拒 → 数字文本（`qq-menu.mjs:195-208`）；企微模版卡失败 → 文本命令清单（`wecom-bridge.mjs:732-736`）；飞书卡 patch 失败 → 发新卡（`FS-BR:3307-3321`）——每条降级都必须在 adapter 里，因为失败原因和兜底文案是平台相关。

### C 结论 3：明确降级（不要强推卡）

- **email / imessage**：没有编辑、没有回调、没有按钮 → 永久文本 + 「回复数字」；（email 连 reaction 概念都没有，`email-bridge.mjs:7-8`）。
- **whatsapp / matrix**：可以编辑但无按钮 → 文本列表 + 数字回复；WhatsApp 的编辑信封依赖 `edit` 字段（`whatsapp-runtime.mjs:523-537`），可以把「一次性菜单」做成可编辑文本，但交互成本仍高于按钮。
- **slack / discord**：有编辑、无按钮实现（Slack 只有 markdown block，`slack-api.mjs:281`；Discord 无 components）→ 建议只做「文本 + 数字回复」，除非后续真做 Block Kit / Message Components 适配。
- **wecom-app**：文本-only 通道（`wecom-app-runtime.mjs:191,222`）→ 只共享命令语义。

---

## D. Telegram 技术约束核对（只从代码/注释取证）

| # | 约束 | 代码事实 | 代码是否强制 | 对命令卡片的含义 |
| --- | --- | --- | --- | --- |
| D1 | `callback_data` ≤ 64 字节 | 常量 `CALLBACK_DATA_MAX_BYTES = 64`（`TG-API:58-59`），每个按钮在 `inputReplyMarkup` 里 `Buffer.byteLength` 校验并抛错（`TG-API:83-87`） | ✅ 发送前强制 | 路径/ID/UUID 一律不能塞回调 → nonce + index（workspace 卡已这样做并留注释：`TG-BR:18-24,83-89`） |
| D2 | 按钮数量上限 | 代码没有平台上限断言（未验证）。本地策略：提问卡每行一个、上限 8（`TG-BR:13-14`）；工作区卡上限 20（`TG-BR:73-78`） | ❌ 平台上限未验证；本地策略强制 | 列表类卡片必须分页，不能依赖「Telegram 会自动处理」 |
| D3 | 按钮文字长度 | 代码未校验长度（`TG-BR:39-43` 只校验非空/类型）；`workspaceLabels` 用 22 字符截断（`workspace-labels.mjs:18,57-62`） | ❌ 未验证平台上限 | 模型名/会话标题进按钮前必须自己截断 |
| D4 | 消息长度与切分 | 常规文本上限 4,000（`TG-RM:2`，切分函数校验 ≤4,096 `TG-RM:142-148`）；富文本上限 30,000（`TG-RM:1`，校验 128–32,768 `TG-RM:111-113`）；`sendText` 自动切分（`TG-RT:585-601`）；命令回执先按 1,800 切（`WC:14,136-156`） | ✅ 强制 | 卡片正文是 `sendMessage`（常规 4k），列表类文本已天然控制；富文本卡不能带按钮（见 D6） |
| D5 | 编辑消息 API 能力：`editMessageText` 能否同时改 `reply_markup` | **不能**：`editMessageText` 只透传正文，正文要么 `text`、要么 `richMessage`（`TG-API:394-406`）；键盘只能另调 `editMessageReplyMarkup`（`TG-API:278-288`）；`sendMessage` 支持 `reply_markup`（`TG-API:254-265`），`sendRichMessage` **不支持**（`TG-API:299-314`） | ✅ 代码事实 | 「点完原地变已切换 + 换键盘」= 2 次调用；要把正文和键盘一次改，必须先扩展 `TG-API`（平台是否允许 `reply_markup` 与 `text` 同传：未验证）。沿当前发送路径，富文本答案无法挂按钮（`sendRichMessage` 不收 markup）→ 答案后的动作按钮只能单独发一条消息，或改用常规文本答案 |
| D6 | 富文本 + 按钮不可共存 | `sendRichMessage` 的 payload 只有 `rich_message`（`TG-API:299-314`）；交互卡用的是纯文本 `sendMessage` + markup（`TG-RT:603-622`） | ✅ 代码事实 | 状态/选择卡正文只能用常规文本（或接受「富文本正文 + 下一条按钮消息」） |
| D7 | `answerCallbackQuery` 时限 | 代码里只有「停 spinner」注释（`TG-API:267`、`TG-RT:634`），没有时限常量/超时处理；调用走 `#call` 默认 15s 传输超时（`TG-API:439`）；ack 可能被放在业务 await 之后（`THB:1853-1858`、`THB:2016-2037`） | ❌ 时限未验证 | 设计上必须「入口先 ack」，不能等业务完成 |
| D8 | 429/限流处理 | 解析 `retry_after`（`TG-API:478-482`）；产物/文件 429 → `artifact-rate-limited`（`TG-API:107-109`）；用户侧文案 `回复已经生成，但当前渠道正在限流…`（`src/channels/shared/message-failure.mjs:89-90`）；**没有自动重试/退避**（telegram 目录内只有 shutdown 的 setTimeout，无 retry loop） | ⚠️ 只透传，不恢复 | 卡片/进度必须自己做节流；429 后不要重放旧帧 |
| D9 | 编辑频率 | 代码无频率限制；进度富文本流每次变化都编辑（`TG-RT:457-471`）；共享可编辑流有 800ms 节流但 Telegram 不用它（`editable-message-stream.mjs:19-57`） | ❌ 未验证平台阈值 | 见 B19：给进度卡加最小间隔 |
| D10 | 「message is not modified」 | 400 + 该文案被当作成功（`TG-RT:368-371`，用在 `#sendPlain` 698-706、`#editRich` 829-836）；但 `editMessageReplyMarkup` 的重复调用只在工作区 retirement 处被 catch 成 warn（`THB:1944-1950`、`TG-RT:625-632`） | ⚠️ 部分处理 | 卡片「再点一次同一项」会触发该错误，必须当成功处理 |
| D11 | 原生命令菜单 | `setMyCommands` 全量替换（`TG-RT:1345-1351`），启动时 + 语言切换时刷新（`TG-RT:1264-1272,1361-1381`）；校验 ≤100 条、名字 `[a-z0-9_]{1,32}`、描述 ≥1 且 ≤256 字符（`TG-API:129-145`）；当前 27 项 | ✅ 强制 | 想通过菜单表达「分组/层级」做不到，只能靠命名和 `/help`/`/menu` 卡 |
| D12 | 回调路由 | `callback_query` 被归一化成和消息同构的对象（`TG-RT:235-277`），`messageId = update_id`、`providerMessageId` 为卡片消息 id；所有点击都算 addressed（`TG-RT:260`）；回调在轮询里按 update 顺序触发，但**不等待其完成**（`void ...acceptCallback`，`TG-RT:1418-1433`）；同一 update 批次内后续消息不会被卡住 | ✅ 代码事实 | 卡片卡的「首按认领」必须在 bridge 内同步完成；轮询不等待长操作是好事（不会卡住后续 update） |

---

## E. 实施批次建议（纯内部视角）

原则：先把「回执形态」的地基打好，再逐条命令卡片化；每一批都能独立发布、独立回滚；每批都要有对应测试文件（仓库已有 `test/channels/telegram/workspace-card.test.mjs`、`interaction-card.test.mjs`、`command-menu.test.mjs`、`test/channels/shared/text-harness-bridge.test.mjs` 可作模板）。

### 批次 0：不改抽象的低风险修正（约 1–2 天，S）
1. B16 原生菜单去别名（`CAT` 5 个 `menuVisible:false`）+ 更新 `docs/bot-commands.md`。
2. B18 ack 时机：所有 callback 出口先 ack，再干活（改 `THB`，不动业务）。
3. B19 进度流节流（`TG-RT`，800–1000ms 合并帧）。
4. B15 群聊非 addressed 已知命令给一次性提示（`THB` + `isSharedLocalCommand`）。
5. B08 的「代价最小版」：`/status` 文本补上工作区/预设/模型三行（先不做卡），复用飞书 `#showStatusText` 的字段（`FS-BR:3549-3572`）。
- 验收：现有测试全绿；新增测试覆盖「ack 先于业务」「节流合并」「群命令提示只发一次」。

### 批次 1：通用「动作卡」抽象 + 审批卡（约 2–3 天，M）
1. 抽 `shared/action-card.mjs`：nonce 仓库（TTL/容量，照抄 `THB:79-81,1953-1966`）、首按认领、陈旧复核、终态文案；把 workspace 卡的 `render/parse` 迁到该模型上（行为不变）。
2. `TG-API.editMessageText` 扩展可选 `replyMarkup`（若平台不支持则调用方走两步：先 `editMessageText` 再 `editMessageReplyMarkup`）——这是后续所有「原地变已切换」的前提。
3. B01 审批卡接 `HA` 的 render 钩子（`HA:334-337,474-480`），回调命名空间 `a1|nonce|<approve|reject>`；失败回退纯文本。
- 验收：审批按钮点击 → 卡变终态 + 清键盘 + 权限（非发起人 toast）；卡片发送失败 → 审批原文仍可打字完成。

### 批次 2：选择型卡片（约 3–5 天，M×5）
1. 抽「分页选择卡」模型（页大小 8、`上一页/下一页`、当前项 ✓、点击后原地重渲染 + 终态）。
2. 依次接 `/models`→`/model`（B02/B03）、`/reasoninglist`→`/reasoning`（B04）、`/presetlist`→`/preset`（B05）、`/sessionlist`→`/session`（B06）、`/conv`（B07）。
3. 所有按压路径统一走「合成命令文本 → 共享 `run*Command`」（照 QQ `qq-menu.mjs:12` / 企微 `wecom-cards.mjs:48-55` 的做法），不新写业务分支。
- 验收：每条命令都能「发命令 → 卡片 → 点一次 → 原地终态」；文本路径结果不变（保留给无卡渠道，勿删）。

### 批次 3：hub 与状态卡（约 3–4 天，M/L）
1. 抽 `shared/menu-snapshot.mjs`（工作区/会话/预设/模型/归档/任务状态，各段独立降级）——字段并集来自飞书 `statusCard` + QQ 状态明细 + 四家菜单实现（C 节结论 1.3）。
2. Telegram `/menu` 卡（内容对齐 QQ 主菜单，`qq-menu.mjs:89-172`；代码 entries 13 项，文档写 12 项，属文档漂移）+ `/status` 卡 + `/help` 分区卡（B09/B08/B17）。
3. `/new`、`/clear` 接终态卡（B11）；`/stop` 进度卡按钮（B10）。
- 验收：Telegram 与飞书/QQ 的能力清单对齐度可对照；无卡渠道仍走文本。

### 批次 4：补齐与打磨（约 3–5 天，M/L）
1. B14 分页/多选（工作区 >20、多选题、多选下拉等价物）。
2. B12 `/batch` 计数卡；B13 `/history` 的「再看 N 条」按钮（需扩展 `commandResult` 的动作按钮位）。
3. B17 的 `/permissionlist`、`/permission`（先文本）；`/watch*` 视产品优先级，单独评估 L 级跨渠道化。
4. 文档：`docs/bot-commands.md` 增加 Telegram 卡片行为一节（当前只有 `/ws` 一行 `docs/bot-commands.md:38`）。

> 排期建议：批次 0/1 先做（风险低、消除最高频摩擦：审批打字 + ack/节流）；批次 2 是命令体验主体；批次 3 做「像飞书那样有一个能点的入口」；批次 4 按需。
> 不建议本轮做的：把 workspace 卡的「切换」语义改成通用写操作（它已经稳定，动它收益小于风险）；`/watch*` 的跨渠道化（依赖飞书专属存储，`src/channels/feishu/` 内，无 shared 层）。

---

## F. 证据缺口与「未验证」清单

1. **平台硬性数值全部未真机验证**：Telegram 按钮数量上限、按钮文字长度上限、`answerCallbackQuery` 时限、编辑频率/429 阈值、`editMessageText` 是否接受 `reply_markup`（代码层今天没传，`TG-API:394-406`）。这些是 B 节中「风险」的主要来源，实施前应各做一次实测并记录到本文件或 ADR。
2. **飞书 `/` 面板数量漂移**：`docs/bot-commands.md:14` 说注册 34 条，`FS-PANEL:27-59` 的清单实际 31 条（我用只读脚本数过）。可能是文档滞后或服务端残留；真机未验证。
3. **飞书卡片「原地替换」在客户端的表现**未验证：代码里 `patch` 成功只代表 API 接受（`FS-BR:3258-3273`），客户端是否即时重绘需实测。
4. **Telegram 原生菜单在群聊里插入的文本**（是否自动带 `@botusername`）未实测，因此 B15 的「菜单能用、手打不能用」结论只基于 `TG-RT:296-303` 的 addressed 逻辑推断。
5. **未运行任何构建/测试/真机**：本审计是静态阅读；所有「现有测试可作模板」的说法只到文件存在性，未执行。若需要验证 B 节建议的落地成本，应从 `test/channels/telegram/workspace-card.test.mjs` 的用例结构开始。
6. **其他渠道的卡片细节**（企微模板卡上限、钉钉卡片模板字段、QQ 键盘渲染）只读了代码与文档，未真机核对；C 节矩阵中已标出「文档/代码来源」而非实测。
7. **依赖上游调研的部分**：本文件的改造方向若与 `docs/research/tg-ux-upstream-brief.md` 的 R1–R17 重叠，以本文的「仓内证据 + 命令面覆盖」为准；上游 brief 未覆盖飞书/Discord 等卡片差异（其 §5 第 6 条自述），本文件 C 节补上了这一块。
