# P0-4：`/menu` 主菜单 hub 卡（轻量档）

## 一句话
Telegram 新增 `/menu`：一张摘要卡（工作区/会话/模型/预设/运行中）+ 6 个入口按钮，点按钮等价于手打那条命令。

## 验收表

| # | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| A1 | `/menu` 出 hub 卡，6 个按钮两行 | `node --test test/channels/telegram/menu-card.test.mjs` | ✅ 15/15 |
| A2 | 每个按钮只传 `m3\|nonce\|动作码`，≤64 字节 | 同上 | ✅ |
| A3 | 点按钮等价于手打对应命令（重放同一 runner） | 同上 | ✅ |
| A4 | hub 是启动器：可反复点、不消耗 | 同上 | ✅ 连点 3 次都生效 |
| A5 | 过期/被替代的 hub 不能再驱动 | 同上 | ✅ |
| A6 | 无键盘 / `menuCard: null` / 卡片被拒 → 文字菜单 | 同上 | ✅ |
| A7 | `/help` 字节级不变 | `test/channels/shared/command-help.test.mjs` | ✅ 用 `helpVisible:false` 保住 |
| A8 | 全量回归 | `npm test` | ✅ 4573 例 0 fail |
| A9 | 发布物完整 | `npm run check` | ✅ |

## 不变量（重要）
- **`/help` 输出必须字节不变**：`test/channels/shared/fixtures/command-help.json` 是四渠道共用的历史基线，
  不能为了让 `/menu` 出现在帮助里而改它。因此 `/menu` 用 `helpVisible: false`——它会出现在原生命令菜单里，
  但不进 `/help` 正文。
- 其他渠道看不到 `/menu`（`channels: ['telegram']`），行为零变化。
- 卡片按钮不携带工作区路径或 Session ID。

## 方案
- `src/channels/telegram/menu-card.mjs`：`menuCardText` / `renderMenuCard` / `TelegramMenuCard`，`m3|` 命名空间
- `src/channels/shared/menu-command.mjs`：无卡渠道的文字菜单 + `isMenuCommand`
- `text-harness-bridge.mjs`：`#presentMenuHub` 发卡、`#runMenuEntry` 重放命令、`m3` 回调分支
- `command-catalog.mjs`：新增 `/menu`（`helpVisible:false`，`menuVisible:false`），并让 `channels` 覆盖值也被冻结
