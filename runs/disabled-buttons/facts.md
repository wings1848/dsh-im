# 事实核对：Telegram `disabled` 按钮（Bot API 10.3）

## 来源
https://core.telegram.org/bots/api （2026-10-31 拉取）

## 官方原文（Recent changes → August 24, 2026 / Bot API 10.3）
> Reply markup
> - Added the class `DisabledButton` and the field `disabled` to the class `InlineKeyboardButton`.

## InlineKeyboardButton.disabled 字段说明
> `disabled` | DisabledButton | Optional. If set, then the button is disabled and does nothing

## DisabledButton 类
> This object represents a disabled button which does nothing. Currently holds no information.

## 抬头约束（关键）
> This object represents one button of an inline keyboard. **Exactly one of the fields other than `text`, `icon_custom_emoji_id`, and `style` must be used to specify the type of the button.**

**推论**：`disabled` 与 `callback_data` 互斥。要做一个真·不可点按钮，必须**去掉** `callback_data`
改成 `{ text, disabled: {} }`；同时保留 `callback_data` 是违规组合（虽可能被服务端容忍，但不能依赖）。

## 复现命令（可复核）
```bash
curl -s https://core.telegram.org/bots/api | grep -o 'Added the class \[DisabledButton\][^<]*'
```
