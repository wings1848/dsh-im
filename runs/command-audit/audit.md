# 命令实测审计（24 条命令 × 无参 / 带错参）

方法：用真实 `TextHarnessBridge` + 完整假 harness，把每条命令和常见误用参数各跑一遍，
看返回什么。目的是找「文档说支持但实际不工作」的命令。

## 结论：找到 1 类真缺陷

**无参数命令带多余词时，会被当成普通提问发给模型。**

一次性影响 3 条命令：`/help`、`/status`、`/new`。它们都用 `command === '/xxx'` 全等比较，
所以 `/help 工作区` 这种输入会落空，穿过所有命令守卫，被提交给模型 → 用户收到
`INTERNAL_UNKNOWN` 错误参考号，且消耗一次模型调用。

修法：改成「命令 + 可选空白」匹配（`isBareCommand`），多余参数回用法提示。

## 排除的假象（脚手架造成，不是 bug）

用假 harness 跑时这三条也「成功」，但真实 Host 会校验，故不算缺陷：

| 输入 | 假 harness 表现 | 真实行为 |
| --- | --- | --- |
| `/workspace /nonexistent-path` | 「已切换」 | Host 校验路径存在性 |
| `/conv /nonexistent-path` | 「已切换」 | 同上 |
| `/preset id:123` | 「已设置」 | `validateAgentPresetId` + catalog 校验会拒绝 |

教训：**假 harness 缺方法会把「依赖缺失」伪装成「命令坏了」**。本轮一开始 `/new`、
`/stop` 都报错，原因是我没提供 `clearSession` / `stopActiveTurn`，不是命令的问题。

## 正常工作的（抽样）

`/new` `/compact` `/clear` `/history` `/workspace` `/workspacelist` `/sessionlist`
`/session` `/models` `/reasoninglist` `/reasoning` `/model` `/presetlist` `/preset`
`/stop` `/steer` `/batch` `/send` `/cancel` `/status` `/version` `/help` `/menu`

参数错误处理也都正确（报用法而非报错）：
`/workspace 99`、`/sessionlist --limit 0`、`/sessionlist --limit abc`、`/session bogus-id`、
`/preset 99`、`/history abc`、`/stop now`、`/models extra` 等。
