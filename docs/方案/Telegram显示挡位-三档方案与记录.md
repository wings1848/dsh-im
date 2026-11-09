# Telegram 过程展示挡位（极简 / 标准 / 全面）方案与记录

状态：**已实现，待真机截图验收**。实现日期：2026-11-10。fork 版本：`5.10.1-wings.2`
基线：`5.10.1-wings.1`（= v5.10.0 + 三套 Telegram 卡片），本次只动「一个回合显示多少」。

## 0. 一页结论

| 结论 | 证据 |
| --- | --- |
| 改版前 Telegram 出厂默认是**逐条新消息**（`thinkingTraces` 缺省 ON、节流 0、编号关），一轮聊天可能几十条消息，且全部计入每聊天 15 条/分钟预算 | `src/channels/telegram/telegram-runtime.mjs:1676`、`src/channels/shared/thinking-cadence.mjs:14`、`src/channels/shared/send-limit.mjs:14` |
| 现在默认是「标准」：**一轮一条占位消息原地改写**，结束时收成一行回执，答案单独一条 | `test/channels/telegram/presentation-levels.test.mjs` L2、L12 |
| 三挡位是**一个 enum 收口**：同时决定「开哪条流」和「哪类进度上屏」 | `src/channels/shared/text-harness-bridge.mjs`（`#presentationLevel`、`turnProgress`） |
| 聊天里可切换：`/display` 卡片三按钮，或 `/display 极简/标准/全面`；设置页也有下拉 | `src/channels/telegram/display-card.mjs`、`plugin-src/client/channels/telegram/thinking-traces.js` |
| 其他渠道（WhatsApp/Slack/Discord…）不传挡位时渲染**逐字节不变** | `test/channels/whatsapp/streaming.test.mjs`（7 例全绿，未改断言） |

## 1. 三挡位到底发什么

以「用户发一句话 → 模型调用 2 个工具 → 回答」为例：

| 挡位 | 过程 | 结束时 |
| --- | --- | --- |
| 极简 | 只有一条占位「正在处理…」，**不改写**（不暴露工具名与步数） | 删除占位 → 发送答案 |
| 标准 | 同一条占位原地改写：`⏳ 处理中 · 12 秒 · 2 步` + `🔧 bash → npm test`；模型开始写答案时换成 `✍️ 正在整理回复`；1.2 秒窗口内合并，10 秒心跳只更新秒数 | 占位**改成** `✅ 完成 · 12 秒 · 2 步` 回执 → 发送答案 |
| 全面 | 每条 💭 思考、每条 🔧 工具调用各自一条消息；工具结果**回写到同一行**：`🔧 bash → npm test · ✓ 0.8s`（失败 `· ⚠️ 失败 0.8s`） | 发送答案（无回执） |

失败回合：三挡位都**不**留回执，占位删除后发错误消息——错误本身就是终态，上面再压一行「已中断」是噪音。

## 2. 事实与实现位置

| # | 断言 | 位置 |
| --- | --- | --- |
| F1 | 挡位归一化、旧布尔映射、输入别名、进度行合成器 | `src/channels/shared/presentation-level.mjs` |
| F2 | 桥里只有一个收口：`#presentationLevel` 决定开流与帧过滤 | `text-harness-bridge.mjs` `#process`（`level`、`turnProgress`、`pushProgress`） |
| F3 | 回执靠 `stream.supportsProgressSummary` + `progressSummary` 字段，只有声明支持的流才会收到 | `telegram-runtime.mjs` `TelegramDeliveryStream`、`openDeliveryStream` |
| F4 | 占位改回执失败（例如 not-modified / 429）时退化为删除，绝不留过期占位 | `telegram-runtime.mjs` `settlePlaceholder` |
| F5 | `/display` 只在声明支持的渠道出现（catalog `channels: ['telegram']`）；`/menu` 同样收进 catalog 并放在菜单第一位，从「隐藏命令」变成可发现入口 | `command-catalog.mjs`、`text-harness-bridge.mjs` `#supportsDisplayCommand` |
| F6 | 卡片命名空间 `d1|<nonce>|<level>`，TTL 30 分钟，首按认领；**每次按完换新 nonce 再重绘**，所以卡片可反复用，点当前项也不死 | `display-card.mjs` |
| F7 | 配置落盘 `presentationLevel`，未知值回落标准；写入挡位时删掉旧布尔 | `telegram/config-store.mjs`、`telegram-controller.mjs` |
| F10 | 全面挡位的工具结果用编辑同一条消息实现（`formatToolOutcome`），不额外发消息 | `telegram-runtime.mjs` `settleToolTrace` |
| F11 | 群聊里点/打共享本地命令（`/status`、`/menu`、`/display` 等）算「已点名」，不再被群触发规则静默丢弃；普通文字与未知 slash 仍按规则处理 | `telegram-runtime.mjs`（`isSharedLocalCommand`）、`command-permission.mjs` |
| F9 | 切换挡位**不重连**：配置落盘后把新挡位推给在跑的 runtime/bridge，下一回合即生效，不会 abort 其它聊天的在飞回合 | `telegram-controller.mjs`、`token-bot-controller.mjs`（`restart:false`）、`telegram-runtime.mjs#setPresentationLevel` |
| F8 | RPC `bot.presentation-level.set` + 设置页下拉 | `plugin-src/host/channels/shared/presentation-level-rpc.mjs`、`rpc.mjs`、`thinking-traces.js` |

## 3. 兼容与行为变更（明说）

1. **默认值变了**：未配置 `thinkingTraces` 的 bot 从「逐条」变为「标准」。这是本次要治的刷屏本身。
2. **`thinkingTraces` 变成别名**：`true`→全面、`false`→标准；保存挡位时删除该字段，避免两个开关打架（`thinking-traces.test.mjs` E1 已按新语义改写）。
3. **其他渠道零变化**：桥的挡位默认是 `null`（= 未接入），只有 Telegram 运行时会传值。

## 4. 验收与证据

红证（改版前会失败的断言，改版后通过）：

| 断言 | 改版前 | 改版后 |
| --- | --- | --- |
| 标准挡位占位行含「处理中 · N 秒 · N 步」 | 只有 `正在使用bash…` | `rich-message.test.mjs`、`presentation-levels.test.mjs` L2 通过 |
| 标准挡位结束时占位被改成回执 | 占位被删除 | `presentation-levels.test.mjs` L12 通过 |
| 极简挡位零改写 | 每步一条进度 | `presentation-levels.test.mjs` L1 通过 |
| `/display` 存在于 Telegram 菜单与 `/help` | 命令不存在 | `command-menu.test.mjs`、`command-help.test.mjs` 通过 |
| 三挡位的**真实运行时调用序列** | 只有一种行为 | `presentation-levels-runtime.test.mjs`（5 例）：极简 `send→delete→rich`、标准 `send→edit→edit(回执)→rich`、全面 `send→send→rich` |

命令（在 `~/Code_Project/dsh-im-build`）：

```bash
node --test test/*.test.mjs test/channels/*/*.test.mjs   # 5088 例：5087 通过、0 失败
npm run build && npm pack && node scripts/verify-package.mjs
```

产物：`xmanrui-dsh-im-5.10.1-wings.2.tgz`（517 文件，`Verified dsh-im package artifacts.`，sha256 `56ce0dd9…`），已复制到 `~/.dsh/local-packages/` 待装。

## 4.1 独立评审修掉的问题（2026-11-10）

第一版有 12 条独立评审意见，阻塞级的两条已修并补了回归测试：

| # | 问题 | 修法 | 回归断言 |
| --- | --- | --- | --- |
| P1 | `TelegramDisplayCard` 没接进生产 bridge，`/display` 只会走文本菜单（卡片是死代码） | `telegram-bridge.mjs` 构造器注入 | `presentation-levels.test.mjs` L15（真 runtime 必须发出带 `d1\|` 按钮的卡片） |
| P2 | `/display <挡位>` 保存会重启 runtime，确认消息随 abort 丢失，且打断其它聊天 | 保存走 `restart:false` + live runtime/bridge 推送 | L11（不重连、就地切换）、L7（确认消息） |
| P3 | 点「当前挡位」按钮 `settle(ACTIVE)` 抛 TypeError，卡片永久卡死 | 当前项不 settle，直接换 nonce 重绘 | L16 |
| P4 | 成功后用同一个 nonce 重绘，第二次点击变「已处理」 | 每次按完 `issue()` 新 nonce | L16 |
| P5 | 设置页下拉恒显示「标准」：客户端归一化漏了字段 | `token-api.js` 白名单加 `presentationLevel` | client-ui / bundle 用例 |
| P6 | 旧 `thinkingTraces` 字段实际没被清掉（config-store 的 `...previous` 合并又写回） | `TelegramConfigStore.save` 在写入挡位时删布尔 | E1、L11 |
| P8 | 标准与全面两套工具摘要（`{"command":"ls"}` vs `ls`） | 抽出共享 `summarizeToolArguments`，两处共用 | P5/P6、A1–A3 |
| P9 | 非 ASCII 截断可能切出孤立代理 | 按码点截断 | P5（emoji 用例） |
| P7 | 飞书面板用例被改成空循环（白跑） | 用 `commandsForChannel('slack')` 代表文本族并断言非空 | 飞书 slash 用例 |

## 5. 未完成（下一轮）

1. **真机截图验收**未做：wings-gpd 的图形会话处于锁屏（`loginctl` `LockedHint=yes`），无法用 computer-use 操作 Telegram 客户端；需要用户解锁或提供临时 bot。
2. 全面挡位的工具结果标记（✓/✗ + 耗时）仍可加强：现在工具行只有 `🔧 name → 摘要`，`tool-result` 事件未回写那一行。
3. `/status` 可增加「当前挡位」一行（现在只有设置页与 `/display` 能看到）。
