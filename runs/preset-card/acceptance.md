# P0-3：`/presetlist` + `/preset` 选择卡（轻量档）

## 一句话
Telegram 的 `/presetlist` 从「文字列表 + 序号」升级为可点的选择卡，`/preset` 保持文字路径。

## 验收标准（每条都有判定命令）

| # | 标准 | 判定 | 期望 |
| --- | --- | --- | --- |
| A1 | `/presetlist` 在支持键盘的渠道出卡 | `node --test test/channels/telegram/preset-card.test.mjs` | 新增用例全绿 |
| A2 | 卡的按钮数、文案、当前项 ✓ 正确 | 同上 | 断言 `inline_keyboard` 形状 |
| A3 | 点按即设，并原地刷新成「已设置为」终态 | 同上 | 卡片编辑为新文案 + 键盘清空 |
| A4 | 「跟随 Host 默认」项可点 | 同上 | 调 `/preset --default` 语义 |
| A5 | 无键盘/卡片被拒/无卡渠道 → 文字列表不丢 | 同上 + 既有 `preset-command` 用例 | 文字与改动前字节级一致 |
| A6 | 双击只提交一次 | 同上 | 第二次点击得到「正在提交/已处理」提示 |
| A7 | 全量回归不破 | `npm test` | 0 fail |
| A8 | 发布物包含新文件 | `npm run check` | 通过 |

## 不变量
- 文字路径（`formatList` / `formatCurrent` / `formatUpdated`）**字节级不变**。
- `callback_data` ≤ 64 字节，且不携带 preset ID（用 nonce+index）。
- `runPresetCommand` 的返回结构向后兼容（新增可选 `presetCatalog` 字段）。

## 方案（一句话）
新增 `src/channels/telegram/preset-card.mjs`（复用 `action-card.mjs` 地基，`p1|` 命名空间）+
`src/channels/shared/preset-command.mjs` 在 `/presetlist` 成功时附带 `presetCatalog`，
`text-harness-bridge.mjs` 增加 `#presentPresetCard` 钩子（照 `#presentModelCard` 的形状）。
