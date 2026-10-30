# P0-2：`/clear` 二次确认卡（轻量档）

## 一句话
`/clear` 会丢弃上下文且不可撤销，Telegram 先把命令变成「🗑 清空上下文 / ✖️ 取消」确认卡；点「清空」才真正执行。

## 验收表

| # | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| A1 | `/clear` 不再立即执行，先发确认卡 | `node --test test/channels/telegram/clear-card.test.mjs` | ✅ 16/16 |
| A2 | 点「清空」执行真实 `/clear` 并原地显示结果 | 同上 | ✅ 断言 `executeCommand('/clear')` 恰好一次 + 卡片被编辑 |
| A3 | 点「取消」不改任何状态 | 同上 | ✅ `executeCommand` 调用 0 次 |
| A4 | 无双击重复清空、过期卡不再生效、跨聊天不可用 | 同上 | ✅ 各有独立用例 |
| A5 | 无键盘渠道 / `clearCard: null` / 卡片发送失败 → 立即执行（行为不变） | 同上 | ✅ 三条降级用例 |
| A6 | 没绑定会话时直接由命令回话，不发无意义卡片 | 同上 | ✅ |
| A7 | 全量回归 | `npm test` | ✅ 4558 例 0 fail |
| A8 | 发布物完整 | `npm run check` | ✅ 通过 |

## 不变量
- **无卡渠道的 `/clear` 行为字节级不变**：确认卡只是 Telegram 的附加步骤，不是跨渠道新要求。
- `callback_data` ≤ 64 字节，只含 `c2|<nonce>|y|n`。
- `runClearCommand` 本身零改动（确认逻辑在 bridge 层）。
