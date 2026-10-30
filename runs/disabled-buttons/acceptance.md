# P1-5：`disabled` 按钮透传，假按钮变成真正不可点（轻量档）

## 一句话
Bot API 10.3 的 `InlineKeyboardButton.disabled` 让「分组头 / 页码 / 当前项」变成客户端灰显、点了不发的标签，取代之前的 noop 回调。

## 验收表

| # | 标准 | 判定命令 | 实测 |
| --- | --- | --- | --- |
| A1 | API 层把 `disabled` 原样透传为 `{}` | `node --test test/channels/telegram/interaction-card.test.mjs` | ✅ |
| A2 | `disabled` 与 `callback_data` 同时出现 → 明确报错 | 同上 | ✅ |
| A3 | 非法 `disabled` 值（非空对象）→ 报错 | 同上 | ✅ |
| A4 | 模型卡：分组头、页码、**当前项**、到头/到尾的翻页键 → disabled | `test/channels/telegram/model-card.test.mjs` | ✅ 23/23 |
| A5 | 预设卡：当前项 → disabled | `test/channels/telegram/preset-card.test.mjs` | ✅ 18/18 |
| A6 | 会话卡：页码指示器 → disabled | `test/channels/telegram/session-card.test.mjs` | ✅ 27/27 |
| A7 | **除当前项外每一行仍是可点按钮**（不能把整个选择器变哑） | 三个卡测试 | ✅ 曾因此抓到一个真 bug |
| A8 | 全量回归 + 打包 | `npm run check` | ✅ 4597 例 0 fail |

## 不变量
- 可点按钮的 `callback_data` 仍然 ≤64 字节、仍带 nonce、仍可归因（原断言只改成「只对可点按钮生效」）。
- 卡片文字、行数、顺序都不变，只是假按钮的交互语义变了。
- 旧客户端（不支持 10.3）收到 `disabled` 会当未知字段忽略——退化表现是「灰按钮变回可点但无响应」，不会报错。

## 事实核对
见 `runs/disabled-buttons/facts.md`（含官方原文与可复核命令）。

## 实现中抓到的真 bug
给模型卡加 disabled 时，第一版把**所有**模型行都当成了标签，于是整个选择器变哑（只能看不能切）。
现有测试的 `button()` 助手原本按「有无 callback」筛，正好把这个错误暴露成大片失败；修正后
只有当前项是标签。这条教训写进了 `labelButton` 的注释与 `button()`/`pressable()` 助手注释里。
