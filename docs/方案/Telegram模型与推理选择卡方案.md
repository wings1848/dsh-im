# Telegram 模型与推理等级选择卡方案（批次 2-A）

状态：**实现完成，待集成分支合并 + 真机验收**。基线：`0e7adb7`（`feat/tg-ux-integration`，2026-10-22）。
实施分支：`feat/tg-model-cards`（worktree `_worktrees/dsh-im/model-cards`）。实施日期：2026-10-22。

目标：把 Telegram 的模型切换从「看文字列表 → 抄序号 → 再打 `/model N`」改成「点卡片原地切换」。

- `/models`、`/model`（不带参数）→ 模型选择卡：按 provider 分组、当前模型 `✓`、每页 8 项分页、
  点按即切换并原地更新，失败走既有文字错误语义。
- `/reasoninglist`（别名 `/reasonings`）、`/reasoning`（不带参数）→ 推理等级选择卡：当前等级 `✓`、
  含「跟随默认」项；模型无推理等级时保留原有的明确文字提示。
- 文字路径（无卡能力 / 卡片发送失败 / 列表 > 60 项 / 无会话 / 模型无等级 / 原地更新失败）逐字回退，
  绝不丢功能。

## 闸门 1：事实核对

每条断言都附可复现命令与实测输出（cwd = 仓库根）。

| # | 断言 | 命令 | 实测输出 |
| --- | --- | --- | --- |
| F1 | 四个只读命令的返回对象新增机器可读快照，文字回执原样保留 | `node --input-type=module -e "import {runModelCommand} from './src/channels/shared/model-command.mjs'; ..."`（见下方「验证记录」原命令） | `/models → card=models`、`/model → card=models`、`/reasoninglist → card=reasoning`、`/reasoning → card=reasoning`；首行仍是原来的「可用模型：」/「当前模型：」 |
| F2 | 卡片快照只加字段、不改文案：`model-command.mjs` 的 diff 没有删除任何文案行 | `git diff -U0 src/channels/shared/model-command.mjs \| grep '^-' \| grep -v '^---'` | 只删除 `function commandResult(message)` / 两个 display helper 的 `function` 前缀（改为 `export`）/ 三处 `const current = (await sessionCatalog(...)).current` 与 `return current` / 四处只读分支的单行 `return`；无 `t(...)` 文案删除 |
| F3 | 回调命名空间是版本化前缀 + 12 字符 nonce + 动作，实测最长 18 字节 | `node --input-type=module -e "import {...} from './src/channels/telegram/model-card.mjs'; ..."`（→ 见验证记录） | `{"buttons":15,"maxCallbackBytes":18,"samples":["m2|AbCdEfGhIjKl|h","m2|AbCdEfGhIjKl|c","m2|AbCdEfGhIjKl|2","m2|AbCdEfGhIjKl|3"]}` |
| F4 | Telegram 侧已有统一的 64 字节回调校验；action card 的 nonce/action 正则本身限制大小 | `rg -n "CALLBACK_DATA_MAX_BYTES" src/channels/telegram/telegram-api.mjs`；`rg -n "NONCE_PATTERN|ACTION_PATTERN" src/channels/shared/action-card.mjs` | `telegram-api.mjs:59` 常量、`:83-87` 超限抛错；`action-card.mjs:28-29` 为 `[A-Za-z0-9_-]{1,32}` / `{1,16}` |
| F5 | 首按认领、TTL 过期、同对话新卡取代旧卡都是共享 `ActionCardRegistry` 的现成语义 | `rg -n "claim\(nonce\)|#expireIfNeeded|revokeConversation\(key" src/channels/shared/action-card.mjs` | `claim` 同步置 `CLAIMED`；`get/claim/settle` 前调 `#expireIfNeeded`；`issue()` 先 `revokeConversation(key, SUPERSEDED)` |
| F6 | 卡片渲染/分发接在共享桥的两个既有扩展点：`#processFastCommand`（读命令结果）与 `acceptCallback`（按键） | `rg -n "modelCard|presentModelCard" src/channels/shared/text-harness-bridge.mjs` | `:221/:251/:276` 字段与构造参数；`:1052` `#presentModelCard`；`:1881` `acceptCallback` 的模型卡命名空间分支 |
| F7 | 只有 Telegram 注入模型卡；其他渠道构造 `TextHarnessBridge` 时不传，行为不变 | `rg -n "modelCard" src/channels --glob '!telegram/**' --glob '!shared/**'` | 空（仅 `telegram-bridge.mjs:140-143` 默认注入；`modelCard: null` 可显式关闭） |
| F8 | 切换复用文字命令实现：按键重放 `/model <provider>/<model>`、`/reasoning <effort>` / `--default` | `rg -n "runModelCommand\(" src/channels/telegram/model-card.mjs` | `#runCardCommand` 唯一调用点；busy/等待交互/绑定锁/错误文案全部留在 `model-command.mjs` |
| F9 | 页面容量 8 / 上限 60 是常量且被渲染函数强制 | `rg -n "TELEGRAM_MODEL_CARD_PAGE_SIZE =|TELEGRAM_MODEL_CARD_MAX_ITEMS =" src/channels/telegram/model-card.mjs` | `= 8`、`= 60`（真机 32 个模型的 gpd 环境也出卡；2026-10-22 从 20 上调） |
| F10 | 新增中文 `t()` 字面量都有英文词条（否则共享 i18n 测试变红） | `node --test test/channels/shared/i18n.test.mjs` | `pass 10 fail 0` |
| F11 | 未改依赖、未碰流式/发送预算区域 | `git diff --stat package.json package-lock.json`；`git diff --stat src/channels/telegram/telegram-runtime.mjs` | 两条均空 |
| F12 | 既有 `/ws` 卡与审批卡行为不变：它们的命名空间解析保持独立，模型卡在 `acceptCallback` 里只认 `m2\|`/`r2\|` | `node --test test/channels/telegram/workspace-card.test.mjs test/channels/telegram/approval-card.test.mjs test/channels/telegram/interaction-card.test.mjs` | 全绿（见验证记录） |

## 闸门 2：验收标准

判定列的命令为空即该条不成立；命令在仓库根执行。全部由 `test/channels/telegram/model-card.test.mjs` 覆盖。

| # | 标准 | 判定命令 / 用例 | 期望输出 |
| --- | --- | --- | --- |
| A1 | `/models` 发一张按 provider 分组的选择卡，不再发文字列表；当前模型带 `✓` | `node --test test/channels/telegram/model-card.test.mjs`（用例 `/models sends a provider-grouped picker…`） | 1 张卡；`sent` 为空；键盘行 = `DeepSeek` 分组头 + `✓ 1. Flash` / `2. Pro` + `OpenRouter` + `3. Claude` + 推理等级行；卡正文含「共 3 个」「当前模型：deepseek/flash」「当前推理等级：High (high)」 |
| A2 | `/model` 不带参数打开同一张卡；无会话时仍是原文字「还没有会话」 | 同上（用例 `/model without arguments opens the same picker…`） | 两种场景分别断言卡数 1 / 0 |
| A3 | 超过一页时分页：8 项/页、翻页原地重绘、末页「下一页」为不可点项（noop） | 同上（用例 `a list longer than one page paginates…`） | 10 个模型 → 第 1/2 页 8 行；翻页后 `editInteractionCard` 收到第 2/2 页；末页 next 动作 `h` |
| A4 | 点非当前模型即切换并原地更新 ✓ + 回执；推理等级行随新模型刷新 | 同上（用例 `a press switches the model, re-marks the card in place and follows the new model effort`） | `selectModel` 收到 `{provider:'deepseek',model:'pro'}`；编辑后 `✓ 2. Pro`、正文「当前推理等级：Medium (medium)」、推理行「⚙️ 推理等级：Medium (medium)」；toast「模型已切换为：deepseek/pro」 |
| A5 | 重复点（切换在途）只切换一次，第二下提示稍候 | 同上（用例 `a double press while the switch is in flight…`） | `selectModel` 1 次；第二下 toast「正在切换，请稍候。」 |
| A6 | 点当前模型是幂等回执，不产生切换 | 同上（用例 `pressing the current model is a no-op receipt`） | `selectModel` 0 次；toast「已经是当前模型。」 |
| A7 | 同对话新卡发出时旧卡键盘立即收起；旧按键不能再切 | 同上（用例 `a newer picker retires the previous keyboard…`） | 旧消息收到空键盘；旧按键 toast「已被新操作取代」；旧按键不会清掉新键盘 |
| A8 | 过期卡（TTL）清键盘且不能切换 | 同上（用例 `an expired picker clears its keyboard…`，注入假时钟 registry） | 无 `selectModel`；toast「过期」；旧消息收到空键盘 |
| A9 | 所有按钮回调 ≤64B、能归属到一次呈现、不含路径/会话/聊天 id | 同上（用例 `every callback payload fits the 64-byte budget…`） | 每个 `callback_data` ≤64 字节、正则 `/\|/` 解析成功、不含 `/` 与 `session-`/`chat-a` |
| A10 | 卡片发送失败逐字回退原文字列表 | 同上（用例 `a refused card send falls back to the exact text listing`） | 无卡；文字含「可用模型：」「1. deepseek/flash」「切换模型：/model <序号> [推理等级ID]」 |
| A11 | 列表 > 60 项逐字回退文字列表 | 同上（用例 `a list above the card cap…`） | 21 个模型 → 无卡；文字含「21. deepseek/m21」 |
| A12 | 无卡能力渠道文字输出字节级不变 | 同上（用例 `a channel without card capability keeps the byte-identical text output`） | `modelCard: null` 时 `sent` 与改造前 `formatCatalog` 输出完全相等（整串 deepEqual） |
| A13 | 原地刷新失败不静默：清键盘 + 补发原文字回执 | 同上（用例 `a failed in-place refresh delivers the text receipt…`） | `selectModel` 1 次；`sent` 含「模型已切换为：」；toast「无法更新选择卡片」；旧消息空键盘 |
| A14 | `/reasoninglist`、`/reasonings`、`/reasoning` 都发推理卡；当前等级 ✓、「跟随默认」项存在 | 同上（两个 reasoning 用例） | 卡正文「选择推理等级（共 2 个）」；按钮 `1. Off (off)`、`✓ 2. High (high)`、`跟随默认（由模型决定）` |
| A15 | 点推理等级即切换并原地重绘；「跟随默认」恢复模型默认 | 同上（用例 `a reasoning press…`、`the follow-default row…`） | `selectModel` 收到 `reasoningEffort:'off'` / 无 effort；编辑后 ✓ 移动；toast 对应「推理等级已切换为：Off (off)」/「已恢复默认推理等级。」 |
| A16 | 模型无推理等级时保留显式文字提示 | 同上（用例 `a model without reasoning metadata…`） | 无卡；文字含「该模型不提供可切换的推理等级。」「恢复默认等级：/reasoning --default」 |
| A17 | 卡片发送后模型被别处切走：按旧等级给解释，不静默回退 | 同上（用例 `a reasoning press after the model changed…`） | 无 `selectModel`；文字含「模型不支持推理等级：off」「可用推理等级：medium, xhigh」；清键盘 |
| A18 | 命令权限语义不变：无命令权限的点击不执行 | 同上（用例 `a press without command permission…`） | `selectModel` 0 次；toast 为既有权限拒绝文案 |
| A19 | 解析器只接受 `m2\|`/`r2\|`，其它命名空间不受影响 | 同上（用例 `the callback parser accepts only its own namespaces`） | `w1\|`、`q\|` 返回 null；超 16 字符动作返回 null |
| A20 | 英文界面下卡正文/按钮/回执全部有词条 | 同上（用例 `the selection cards are translated…`） | `Choose a model (3 total, page 1/1)`、`Current model:`、`Follow the default (decided by the model)`、`Reasoning effort switched to:` |
| A21 | 只读命令的结构化快照与文字回执一致 | `node --test test/model-command.test.mjs`（新增 2 个用例） | `card/modelCatalog/reasoningCatalog/selection` 存在；`messages.join('') === message` |
| A22 | 构建成功且产物包含模型卡 | `npm run build`；`grep -c "could not deliver a model picker" lib/index.js` | 构建 exit 0；产物含模型卡代码（中文字符串以 `\uXXXX` 转义形式存在，用 node 解码核对） |
| A23 | scoped 回归全绿 | 见「验证记录」 | 5 组共 443 项、0 fail（模型卡 23 / model-command 40 / Telegram 目录 269 / i18n 10 / 共享桥&会话生命周期&工作区竞态 101） |
| A24 | 全量测试通过 | `npm test` | `tests 4502 / pass 4502 / fail 0`，exit 0，183.9s |
| A25 | 真实 Telegram 机器人收到卡片并可点按切换、原地变 ✓ | 人工（需用户重启 dsh-web 后在真机操作；本批次不连真实 Telegram） | 未做（见「未做与风险」） |

## 设计

### 数据流

```
用户 ── /models /model /reasoninglist /reasoning（不带参数）
        │
        ▼
text-harness-bridge #processFastCommand
        │  runModelCommand(...)  ← 文字输出照旧生成
        ▼
result = { handled, message, messages, card:'models'|'reasoning',
           modelCatalog | reasoningCatalog }
        │
        ├─ 有 #modelCard 且渲染/发送成功 → 发卡，跳过文字
        └─ 否则 → 逐条 sendText(result.messages)   ← 字节不变
```

卡片按键：

```
acceptCallback
  └─ TelegramModelCard.handlePress（先认 namespace，非 m2|/r2| 返回 false）
       1. evaluateInboundAccess(isCommand:true)  ← 与文字命令同一权限闸门
       2. registry.get(nonce)：不存在/不属于本对话/kind 不匹配 → toast + 不清别人的键盘
       3. h/c 无副作用项 → 只 toast，不认领
       4. registry.claim(nonce) 同步认领：CLAIMED → toast「正在切换」，不重复执行
       5. 重放文字命令：/model <provider>/<model> | /reasoning <id> | /reasoning --default
       6. 成功（result.selection 存在）→ registry.issue(新 nonce)
            + editInteractionCard(原文 + 新键盘，✓ 已更新) + toast 回执
          失败 → settle(STALE) + 清键盘 + 补发 result.messages（原文字错误语义）+ toast
```

### 卡片布局

模型卡（3 个模型、1 页时）：

```
选择要使用的模型（共 3 个，第 1/1 页）
当前模型：deepseek/flash
当前推理等级：High (high)

[ DeepSeek ]                      ← provider 分组头（不可点：noop h）
[ ✓ 1. Flash ]                    ← 当前项（noop c）
[ 2. Pro ]
[ OpenRouter ]
[ 3. Claude ]
[ ⚙️ 推理等级：High (high) ]       ← 打开推理卡（e）
```

分页时末行变为 `[上一页] [第 p/P 页] [下一页]`；翻到首/末页时不可用方向与页码本身都是 noop `h`，
不会产生任何切换/认领。

推理卡：

```
选择推理等级（共 2 个）
当前模型：deepseek/flash
当前推理等级：High (high)

[ 1. Off (off) ]
[ ✓ 2. High (high) ]
[ 跟随默认（由模型决定） ]          ← /reasoning --default
```

按钮文案按模型/等级名生成（name 与 id 不同时 `Name (id)`，与文字路径的 `reasoningEffortText` 同一函数），
超 60 字符截断。

### 回调协议

| 卡片 | 载荷 | 动作 | 含义 |
| --- | --- | --- | --- |
| 模型 | `m2\|<nonce>\|<action>` | `<数字>` | 全局序号（与文字列表 `/model N` 同一编号）→ 重放 `/model provider/model` |
| 模型 | 同上 | `p<页>` | 翻页（0 基页号），原地重绘并换新 nonce |
| 模型 | 同上 | `h` | 分组头/页码/不可用方向：noop |
| 模型 | 同上 | `c` | 当前模型：noop + 「已经是当前模型」 |
| 模型 | 同上 | `e` | 打开推理等级卡（新消息；旧卡键盘收起） |
| 推理 | `r2\|<nonce>\|<action>` | `<数字>` | 等级序号 → 重放 `/reasoning <id>` |
| 推理 | 同上 | `d` | 重放 `/reasoning --default` |
| 推理 | 同上 | `c`/`h` | 当前等级/占位：noop |

nonce 是 9 字节随机数的 base64url（12 字符），动作最长 3 字符，实测整个载荷 ≤18 字节。
路径、模型 id、session id、chat id 一律不进回调；按键只按序号/页码索引，执行前先对照本次呈现的快照。

### 终态与并发

- `ActionCardRegistry`（TTL 1 小时、容量 64）负责 nonce 生命周期：新卡 `issue()` 会把同对话的旧卡标为
  `SUPERSEDED`，旧卡键盘在新卡投递成功后清空。
- 每次有效按键先同步 `claim()`：在途重复按键拿到 `CLAIMED`，只 toast 不执行；过期按键拿到 `EXPIRED`，
  toast 并就地清键盘；成功切换后消息用**新 nonce** 原地重绘，旧 nonce 进入终态。
- 若按键属于「原地重绘后已死掉的旧卡」，因为同对话存在 ACTIVE 新卡，不清键盘（避免误杀新卡）；
  只有「死卡且无替补」才清键盘。
- 切换失败（模型不可用、会话忙、等待交互、等级不兼容、绑定变化）统一：清键盘 + 把
  `runModelCommand` 返回的原文字消息逐条补发 + 短 toast，用户看到的原因文案与打字命令完全一致。

### 降级矩阵（不变量 I4）

| 场景 | 行为 |
| --- | --- |
| 渠道没有 `modelCard`（其他所有 IM 渠道） | 不调用卡片逻辑，文字输出不变 |
| bot 无 `sendInteractionCard`（测试/精简客户端） | `present()` 返回 false → 文字 |
| 卡片发送抛错 | 注册表标 `REVOKED` → 文字（原 `messages`） |
| 模型/等级数量为 0，或 >20，或 id 含空白/控制字符（无法作为文字命令参数重放） | `modelCardView/reasoningCardView` 返回 null → 文字 |
| 模型无 reasoning 元数据 | 推理卡返回 null → 原文字明确提示「该模型不提供可切换的推理等级」 |
| 无绑定会话（`/model`、`/reasoninglist`、`/reasoning`） | 结果无卡片快照 → 原文字「还没有会话」 |
| 原地编辑失败 | 清键盘 + 补发文字回执 + toast，不静默 |
| 列表很长（>20） | 文字列表仍完整（`splitWorkspaceCommandMessage` 分片），功能不丢 |

## 闸门 4：不变量（必须保持不变）

| # | 不变量 | 验证方式 | 实测 |
| --- | --- | --- | --- |
| I1 | 所有既有文字命令回执字节级不变（卡片是叠加） | `测试`：A12 整串 deepEqual + A21 快照一致性；`人工核对`：F2 diff 无文案删除 | A12/A21 绿；F2 输出仅结构行 |
| I2 | 回调 ≤64B；路径/UUID/模型 id 不进回调 | `测试`：A9 | 实测最长 18B |
| I3 | 命令权限/actor 语义不变（按键是命令面，走同一 `evaluateInboundAccess`） | `测试`：A18；`人工核对`：桥每次按键传当前 accessPolicy | A18 绿 |
| I4 | 卡片失败必须降级为原文字路径，不丢信息 | `测试`：A10/A11/A12/A13/A16 | 全绿 |
| I5 | `/ws` 卡、审批卡、提问卡行为不变 | `测试`：F12 全目录回归 | 269 项 Telegram 测试全绿 |
| I6 | 不新增运行时依赖；不改流式/发送预算区域 | `人工核对`：F11 | diff 为空 |
| I7 | 中文源字面量都有英文词条 | `测试`：F10 | pass 10 |
| I8 | 不连真实 Telegram、不重启 dsh-web、不改 `~/.dsh` | `人工核对`：全部测试使用假 Telegram API/Bot stub | 本批次无真实网络调用 |

## 测试计划（先红后绿）

新增 `test/channels/telegram/model-card.test.mjs`（23 个用例，覆盖 A1–A20），红证据：
`_notes/tg-model-cards/red-model-card.log`（先写测试 + 空壳模块，20 个用例失败，失败输出含测试名与断言行；
3 个「既有行为不变量」用例在改造前即绿，属预期）。实现后全绿。

更新 `test/model-command.test.mjs`（+2 用例，A21）验证只读命令的结构化快照与切换成功的 `selection`，
同时确认 `messages.join('') === message`。

回归范围：`test/model-command.test.mjs`、`test/model-session-lifecycle.test.mjs`、
`test/channels/telegram/*.test.mjs`、`test/channels/shared/text-harness-bridge.test.mjs`、
`test/channels/shared/i18n.test.mjs`、`test/conversation-*.test.mjs`，最后全量 `npm test`。

## 验证记录（闸门 5）

### 验红（修复前）

```
node --test test/channels/telegram/model-card.test.mjs
ℹ tests 23
ℹ pass 3
ℹ fail 20
✖ /models sends a provider-grouped picker with the current model checked
    AssertionError [ERR_ASSERTION]: the listing becomes one picker card
    0 !== 1  (model-card.test.mjs:255)
✖ a press switches the model, re-marks the card in place ...
    AssertionError: no delivered button matching /^2\. Pro$/ (model-card.test.mjs:328)
✖ the callback parser accepts only its own namespaces ...
    AssertionError: + null - { action:'3', kind:'models', nonce:'abc' } (model-card.test.mjs:620)
```

完整日志：`/home/wings/Code_Project/_notes/tg-model-cards/red-model-card.log`。

### 验绿（修复后）

```
$ node --test test/channels/telegram/model-card.test.mjs
ℹ tests 23   ℹ pass 23   ℹ fail 0

$ node --test test/model-command.test.mjs
ℹ tests 40   ℹ pass 40   ℹ fail 0

$ node --test test/channels/telegram/*.test.mjs
ℹ tests 269  ℹ pass 269  ℹ fail 0

$ node --test test/channels/shared/i18n.test.mjs
ℹ tests 10   ℹ pass 10   ℹ fail 0

$ npm run build
Wrote .../lib/client.js
Wrote .../lib/index.js

$ node --test test/channels/shared/text-harness-bridge.test.mjs \
    test/model-session-lifecycle.test.mjs test/conversation-workspace-races.test.mjs \
    test/conversation-workspace-switch-order.test.mjs
ℹ tests 101  ℹ pass 101  ℹ fail 0
```

### 全量结果

```
$ npm test            # node --test test/*.test.mjs test/channels/*/*.test.mjs
ℹ tests 4502
ℹ suites 3
ℹ pass 4502
ℹ fail 0
ℹ cancelled 0
ℹ skipped 0
ℹ todo 0
ℹ duration_ms 183947.344227
EXIT=0
```

日志归档：`_notes/tg-model-cards/`（`red-model-card.log`、`green-model-card.log`、
`green-model-command.log`、`green-telegram-all.log`、`green-i18n.log`、
`green-shared-related.log`、`green-build.log`、`green-full-test-tail.log`）。

## 未做与风险

- **未做真机**：本批次按要求不连真实 Telegram；`InlineKeyboardButton.disabled` 也未启用（当前 API 封装会
  丢字段），不可点项一律用 noop 回调，点击只 toast、不产生任何切换/认领。真机验收建议：发 `/models`，
  点非当前模型确认卡内 ✓ 与推理行同步变化；切页确认旧页按钮失效；等 1 小时确认过期清键盘。
- **模型 >20 时仍回落文字**（需求不变量）。如果真实目录普遍超过 20 个模型，可后续把上限提高/改成无限分页，
  但需要再评估手机端扫描成本。
- **推理卡的「跟随默认」在切换成功后可能直接显示为具体等级**：服务端 read-back 常常把默认等级回填成显式值，
  与文字路径 `/reasoning --default` 的回执一致（回执展示生效等级）；若未来 Harness 能区分「继承 vs 显式」，
  可在 `catalog.current` 上补字段后再优化。
- `/model`、`/reasoning` 不带参数从「状态说明文字」变成「选择卡 + 同样信息」，属需求要求的交互升级；
  无卡能力渠道仍是原文字。
- 与并行队友（会话卡）共同修改 `text-harness-bridge.mjs` / i18n：本分支只加了独立的 `#modelCard`
  字段、`#presentModelCard` 方法、`acceptCallback` 中一段 `m2|`/`r2|` 分流，未改动 `/ws` 与审批卡代码路径；
  i18n 只在 `i18n-en/telegram.mjs` 末尾追加独立注释段。合并时按文件尾部/相邻区域手工对齐即可。

## 改动文件

| 文件 | 说明 |
| --- | --- |
| `src/channels/telegram/model-card.mjs`（新增） | 模型/推理卡：视图、Telegram 渲染、namespace 解析、`TelegramModelCard`（registry/records/按键状态机/降级） |
| `src/channels/shared/model-command.mjs` | 只读分支返回 `card` + 快照；切换成功返回 `selection` + read-back catalog；导出两个显示 helper；文案不变 |
| `src/channels/shared/text-harness-bridge.mjs` | 新增可选 `modelCard` 控制器、`#presentModelCard`、`acceptCallback` 的 `m2|`/`r2|` 分流 |
| `src/channels/telegram/telegram-bridge.mjs` | 默认注入 `TelegramModelCard`（可用 `modelCard: null` 关闭） |
| `src/channels/shared/i18n-en/telegram.mjs` | 模型/推理卡英文词条（独立注释段，未改已有词条） |
| `test/channels/telegram/model-card.test.mjs`（新增） | 23 个用例：渲染/分组/分页/当前项/切换/重复点/过期清键盘/回调字节/降级/英文 |
| `test/model-command.test.mjs` | +2 用例：结构化快照、切换 selection（文字回执不变） |
| `lib/index.js` / `lib/client.js` | 重新构建；`lib/client.js` 的软链路径注释归一化为 `node_modules/` 后无 diff |
