# 卡片编辑遇到 429 的处理

## 发现的问题
Telegram 限流时会返回 `retry_after`（「几秒后再来」）。实测各卡片**完全忽略这个字段**：

```
编辑被 429 → 立即失败 → 用户看到「无法更新帮助卡片，请重新发送 /help。」
耗时 0 ms（没有等待）
```

用户刚按了按钮，平台明确告诉了什么时候能重试，代码却立刻放弃、让用户重打命令。

## 修法
`action-card.mjs` 新增 `withActionCardRetry()`，所有卡片的**重绘**操作走它：
- 是 429 且有 `retry_after` → 按它等一次，重试一次
- 等待上限 5 秒（`ACTION_CARD_RETRY_MAX_WAIT_MS`）：更长的等待不值得占住 turn，交给调用方报错
- 非 429、或无 `retry_after` 的 429 → 不重试（不盲目重试）

覆盖：`status` `help` `preset` `clear` `session` `model` `approval` 七张卡的重绘路径。
「清理键盘」（`updateInteractionCard` / 纯 markup 编辑）**不加重试**——那是收尾动作，
失败不影响主流程，重试只会拖慢。

## 过程中自己写出的一个 bug
第一版等待写成 `setTimeout(resolve, delay).unref()`。**`unref` 让定时器不阻塞事件循环，
导致 Node 认为没有待办活干，直接退出 / await 永远不 resolve**，测试里表现为"无输出"。

改成不带 `unref` 后正常：尝试 2 次、耗时 1005ms（≈ retry_after 1s）、用户无错误提示。

教训：只有「等待一个后台任务、进程该继续干别的」时才 unref；这里恰恰是**唯一的等待**。

## 测试
`action-card.test.mjs` 新增 5 例：短 retry_after 重试一次成功、持续失败只重试一次、
超长 retry_after 不等待、非 429 不重试、429 但无 retry_after 不盲重试。
