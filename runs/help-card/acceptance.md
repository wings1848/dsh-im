# P1-1：`/help` 分区卡（轻量档）

## 一句话
Telegram 的 `/help` 从 30 行文字墙变成分区卡：主页显示各分区入口，点进去只看那一类命令，可返回。

## 验收表

| # | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| A1 | 有键盘渠道 `/help` 出分区卡，不进文字墙 | `node --test test/channels/telegram/help-card.test.mjs` | ✅ 14/14 |
| A2 | 每个命令恰好归属一个分区，`menu`（helpVisible:false）不出现在任何一处 | 同上 | ✅ 用 `commandHelpSections` 与服务端断言 |
| A3 | 分区正文只含该分区命令，行文来自 catalog | 同上 | ✅ |
| A4 | 点分区原地重绘同一消息，点「← 返回」回主页 | 同上 | ✅ |
| A5 | 按钮只传 `h1\|nonce\|分区`，≤64 字节；未渲染的分区不接受 | 同上 | ✅ |
| A6 | 过期/跨聊天/被替代的卡不能被驱动 | 同上 | ✅ |
| A7 | 重绘失败 → 清键盘 + 告知，不留假按钮 | 同上 | ✅ |
| A8 | 「🏠 控制台」交给 /menu hub，不重绘本卡 | 同上 | ✅ |
| A9 | 全量回归 | `npm test` | ✅ 4587 例 0 fail |
| A10 | 发布物完整 | `npm run check` | ✅ |

## 不变量
- **`/help` 文字输出必须字节不变**：`fixtures/command-help.json` 是 Feishu/Slack/Discord/WhatsApp/Telegram 共用的历史基线。
  卡片只是「有键盘的渠道多一个展示面」，无键盘渠道（以及 `helpCard: null`、卡片被拒）仍然发原来那段文字。
- 分区元数据单独放在 `COMMAND_HELP_GROUPS` + `commandHelpGroup()`，不改动既有 catalog 条目的 help 行。
- 未映射的命令落到「其他」分区，新增命令不可能从卡片里消失。

## 改动文件
- 新增 `src/channels/telegram/help-card.mjs`
- `src/channels/shared/command-catalog.mjs`：新增 `COMMAND_HELP_GROUPS` / `commandHelpGroup()` / `commandHelpSections()`
- `src/channels/shared/text-harness-bridge.mjs`：`#presentHelpCard` 钩子 + `h1` 回调分支
- `src/channels/telegram/telegram-bridge.mjs`：`helpCard` 默认开启
