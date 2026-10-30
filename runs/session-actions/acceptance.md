# P1-4：会话卡补「解绑 / 新会话」（轻量档）

## 一句话
会话选择卡底部多一行动作：已绑定时可「🔓 解绑当前会话」，任何时候可「🆕 新会话」，两者都走已有命令的同一条路径。

## 验收表

| # | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| A1 | 已绑定 → 两个按钮；未绑定 → 只有「新会话」 | `node --test test/channels/telegram/session-card.test.mjs` | ✅ 27/27 |
| A2 | 点「解绑」只清绑定，卡片变成回执（无键盘） | 同上 | ✅ |
| A3 | 点「新会话」与 `/new` 等价 | 同上 | ✅ |
| A4 | 双击只执行一次 | 同上 | ✅ |
| A5 | 别的聊天点这张卡不影响本会话 | 同上 | ✅ |
| A6 | 操作失败时**不**显示成功回执，卡片保持可用 | 同上 | ✅ |
| A7 | 按钮只传 `s2\|nonce\|u` / `s2\|nonce\|n`，≤64 字节 | 同上 | ✅ |
| A8 | 全量回归 | `npm test` | ✅ 4595 例 0 fail |
| A9 | 发布物完整 | `npm run check` | ✅ |

## 真机/调试抓到的两个真 bug（都已修）

1. **`releaseClaim()` 根本不存在**。失败分支里调 `settle(nonce, ACTIVE)` 想「退回可点」，
   但 `ACTIVE` 不是终态，`settle()` 抛 TypeError，异常冒到外层 catch，变成一句假的
   「这个会话列表已过期」。修法：给 `ActionCardRegistry` 补 `releaseClaim()`（只放回
   仍存活的 `claimed` 卡，已 resolved/expired 的绝不复活），失败分支改用它。
2. 上一版 `releaseClaim` 只存在于 PR430 的 worktree，集成分支从来没有它——所以这次是
   「按需补齐地基」，不是重复实现。

## 不变量
- `/sessionlist` 的文字列表、绑定流程、分页行为都不变（只是多一行动作）。
- 解绑与新会话复用 `clearSession` + `onSessionCleared`，和 `/new` 同一套副作用，
  卡片不再有自己半套语义。
