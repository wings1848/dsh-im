# 卡片内存与泄漏审计

## 结论：没有内存泄漏，但发现一处可优化

| 项目 | 结论 |
| --- | --- |
| 是否泄漏 | **否**。`ActionCardRegistry` 到 `maxEntries` 后不再增长（压 500 次 issue，size 恒为 64，heap 5.4→5.7MB） |
| 真 bridge 长压测 | 400 条消息 heap 9.39→11.07MB，**有界** |
| 发现的问题 | `session-card` 用了 registry 默认 `maxEntries=256`，其它 6 张卡都是 64 |

## 为什么 session-card 的 256 值钱

每份 session 卡 payload 存完整会话列表（最多 60 条），实测：

- 60 条会话的 listing ≈ 7.9 KB JSON
- 256 份 ≈ 2 MB JSON（JS 对象开销 2–3 倍）

而 `issue()` 会撤销同对话上一张卡，**每个对话最多一张活卡**，所以 256 里绝大部分是
「谁也点不了的历史卡」。统一成 64（= 64 个并发对话，远超单 bot 真实负载）后：

- 400 次 `/sessionlist` 后的内存封顶：**11.7 MB → 9.73 MB（省约 2 MB，-17%）**
- 600→1200 次增长 **-0.02 MB**，确认封顶

## 没改的
`approval-card` 也是默认 256，但它 payload 只有 `{approvalId, actor, fullText?}`（几百字节），
256 份可忽略。**只改真正占内存的地方**，不做无意义的统一。

## 测法（可复现）
`node --expose-gc` 跑脚本，每 200 次采样 heap；用 `global.gc()` 排除 GC 噪声。
两次采样间增量 < 0.6MB 判定为封顶。
