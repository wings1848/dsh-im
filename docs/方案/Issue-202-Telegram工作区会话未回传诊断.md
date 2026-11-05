# Issue #202 诊断：Telegram 工作区会话在 Web 端发消息后 bot 看不到回复

日期：2026-09-12。结论：**不是代码缺陷，是「会话双向同步」开关从未开启**。已用本机真实状态文件与真实会话事件在真实代码路径上复现并验证。

- Issue：[#202](https://github.com/xmanrui/dsh-im/issues/202)
- 诊断对象版本：`@xmanrui/dsh-im` v4.20.0（本机 web profile 实际加载版本）
- 宿主版本：DSH `0.1.5-rc.1`

## 0. 结论速览

DSH Web 端的输入与助手回复要回传到 IM，必须满足一个显式授权链：

```text
已保存的私聊投递目标  →  在该目标行打开「会话双向同步」
```

本机 Telegram 通道**从未创建过任何投递目标**，所以：

- 设置页里根本不存在可打开开关的目标行；
- 协调器每次查询「有哪些目标绑定了这个 Session」都返回空数组；
- 端到端结果就是 Web 端说什么、bot 都不动。

这是设计行为（方案 §2.3、§12：默认关闭，避免升级后突然外发内容），不是 Telegram 通道或 DSH 版本兼容问题。

## 1. 事实核对：本机真实状态

| 项 | 实测值 | 判定命令 |
| --- | --- | --- |
| Telegram bot | `telegram_2de558fd2503189dfb22808d`（`wings-pc-dsh`） | `jq .bots ~/.dsh/integrations/dsh-telegram/config.json` |
| 私聊绑定 | `direct:8000442957` → `session-1614e659-0287-4b9e-9f1b-b597ef9e511a` | `jq .sessions .../bots/<botId>/state.json` |
| 该会话工作区 | `/home/wings`，创建于 17:05，最后写入 17:10 | `zstd -dc .../session.v3.jsonl.zstd \| head -1` |
| 投递目标 | **不存在**（`workspaces.json` 无 `deliveryTargets` 段） | `jq 'has("deliveryTargets")' ~/.dsh/integrations/dsh-telegram/workspaces.json` → `false` |
| 状态文件版本/时间 | v2，mtime `09-11 20:37`（Issue 之前一天） | `ls -la ~/.dsh/integrations/dsh-telegram/workspaces.json` |
| 是否远程 Harness | 否（无 `harnessBaseUrl`，会话同步可用） | `jq 'has("harnessBaseUrl")' .../config.json` → `false` |
| 已安装插件 | v4.20.0，产物含协调器 | `grep -c "failed to activate Session sync" .../dsh-im/lib/index.js` → `1` |

「从未开启」的独立佐证：打开开关会写入 v3 并落盘 `sessionSync` 字段，而该文件仍是 v2、时间戳停在 9 月 11 日，且 Issue 当天没有任何写入。

## 2. 真实事件形状核对（DSH 0.1.5-rc.1）

从出问题的那个会话的持久化日志里取真实事件，两者与协调器的读取契约完全一致：

| 事件 | 真实字段 | 协调器期望 | 一致 |
| --- | --- | --- | --- |
| Web 端输入 | `surfaceOp:"append"`、`source:{kind:"user",rpcId:"547aaf3a-…"}`（无 `telegram-` 前缀） | `kind === 'user'` + 非空 `rpcId` → 判定为 `dsh` | 是 |
| Telegram 端输入 | `source:{kind:"user",rpcId:"telegram-fbe6248f-…"}` | 命中 dsh-im 登记 → 判定为 `im`，不同步 | 是 |
| 注入消息 | `source.kind` = `agent-instructions` / `plugin` / `skill-catalog` | 非 `user` → `other`，不同步 | 是 |
| 回合结束 | turn 1 `{kind:"aborted"}`、turn 2 `{kind:"completed"}` | 仅 `completed` 发送助手文字 | 是 |

也就是说：**DSH 侧没有发生破坏该功能的协议变化**，兼容性不是本次原因（但见 §5 风险提示）。

## 3. 复现（真实数据 + 真实代码）

脚本：`.diag/repro-issue-202.mjs`（只读用户状态，全部操作在副本上）

```bash
node .diag/repro-issue-202.mjs
```

它加载真实的 `workspaces.json`、真实的 `state.json`、真实的会话事件，串起真实的
`BotWorkspaceStore → createDeliveryAdapter → DeliveryService → createSessionSyncCoordinator`。

**A. 现状（开关未开启）**

```text
listSessionSyncTargets() = []
bot 的投递目标列表 = []
turn 2（Web 端「你好」+ completed）实际发出 = []
```

→ 与 Issue 现象一致：Web 端有完整问答，bot 一条都收不到。

**B. 先创建私聊目标并打开开关后，同一批事件重跑**

```text
创建目标      = {"targetId":"me","kind":"chat","route":{"chatId":"8000442957"}}
打开前状态    = [{"enabled":false,"state":"off"}]        # 可用、未开启
setSessionSync(true) = {"enabled":true,"state":"active"}
listSessionSyncTargets() = [{botId:"telegram_…", targetId:"me", conversationKey:"direct:8000442957"}]

turn 2 实际发出：
  → "[来自 DSH]\n你好"
  → "[DSH 助手]\n喵~ 你好呀！…"      # 与 Web 端截图中的答复一致
turn 1（Telegram 来源 + aborted）实际发出：[]   # 不回环、不重复
```

→ 机制完全正常：开关一开，Issue 描述的现象立即消失。

仓库自带回归测试同样通过（11/11）：

```bash
node --test test/session-sync-coordinator.test.mjs test/delivery-adapter.test.mjs
```

## 4. 根因

```text
Web 端输入
  → 协调器判定来源 = dsh（正确）
  → DeliveryService.listSessionSyncTargets(sessionId)
  → 逐渠道适配器遍历「已开启同步的目标」
  → 本机 Telegram：0 个目标  ← 断点在这里
  → 什么都不发
```

断点不在事件识别、不在 Telegram 发送路径，而在**从未建立授权**：没有投递目标 → 没有开关 → 没有可发送的收件人。

## 5. 排除的候选原因与遗留风险

| 候选原因 | 排除依据 |
| --- | --- |
| DSH 0.1.5-rc.1 改了事件协议 | §2 真实字段逐条比对一致；复现 B 用真实事件成功发出 |
| Telegram 通道不支持会话同步 | 适配器三个方法齐全，实测 `setSessionSync → active`，发送成功 |
| 渠道被判定为远程 Harness 而禁用 | `config.json` 无 `harnessBaseUrl` |
| 插件版本过旧没有该功能 | v4.20.0 产物含协调器；功能自 v4.19.0 起存在 |
| 群聊/Topic 被拒 | 目标是 `direct:` 私聊，`resolvePrivateConversationKey` 唯一匹配成功 |
| 协调器安装失败 | 该失败会写 `[dsh-im] failed to activate Session sync` 错误日志，本机找不到任何日志文件可佐证；且即便安装成功，0 个目标也必然 0 条发送（安装与否都不改变本次结论） |

**遗留风险（非本次原因）**：`package.json` 的兼容矩阵只声明到 DSH `0.1.5-alpha.1`，本机跑的是 `0.1.5-rc.1`。本次涉及的会话事件路径实测兼容，但该版本未经完整回归，建议补一次兼容验收。

**附带发现（不影响本 Issue 结论）**：协调器 `validRecipient()` 会静默丢弃没有 `channel` 字段的目标。生产链路由 `DeliveryService` 补齐该字段，所以无实际影响；但它是一个「错了也不报错」的失败模式，排查时容易误判为「什么都没发生」。

**另一个现象（与本 Issue 不同因）**：截图里 Telegram 端的提问最终以 `TURN_INTERRUPTED` 收尾，会话日志显示 turn 1 的结束原因是 `{kind:"aborted", reason:{kind:"user"}}`——即该回合被用户主动中断（Web 端显示「提问 · 已中断」）。这是预期语义，不是缺陷。

## 6. 本机要真正开启的操作

设置 → IM机器人 → `wings-pc-dsh` → 卡片右上角齿轮 → 「新建目标」→ 从已聊会话里选该私聊 → 保存目标 → 在该目标行打开「**会话双向同步**」（默认关闭）。

验收：在 Web 端向 `session-1614e659…` 发一条文字，Telegram 应依次收到
`[来自 DSH] …` 与回合完成后的 `[DSH 助手] …`；随后从 Telegram 正常提问，应仍只走原回复链，不重复。

## 7. 给 Issue 的回复要点

1. 这不是 Telegram 或 DSH 版本的 bug：真实事件与真实发送路径实测正常，仓库 11/11 回归用例通过。
2. Web→IM 回传是**显式授权**功能：必须先有「已保存的私聊投递目标」，再打开该目标行的「会话双向同步」（默认关闭，见 README「私聊会话双向同步」）。
3. 本机状态文件里没有任何投递目标，且当天未发生任何写入，因此该开关不可能处于开启状态。
4. 产品侧建议：功能入口藏在「机器人 → 齿轮 → 投递设置 → 目标行」三级之下，且与「主动投递」这一不相关概念耦合——只想「让 bot 看到 Web 回复」的用户很难找到。可考虑在设置页或 `/session` 相关命令里给出直达提示。

## 8. 证据文件

| 文件 | 内容 |
| --- | --- |
| `.diag/repro-issue-202.mjs` | 复现脚本（只读用户状态，操作副本） |
| `.diag/s.jsonl` | 出问题会话的真实事件序列（来自本机 DSH 日志） |
| `.diag/web.png`、`.diag/tg.png` | Issue 原始截图 |

用户状态文件在诊断过程中未被修改：`workspaces.json` 仍为 v2、无 `deliveryTargets`，mtime 保持 `09-11 20:37`。
