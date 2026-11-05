#!/usr/bin/env bash
# 手机调试收尾：恢复自动锁屏、息屏、屏幕超时，并清掉调试临时文件。
#
# 只在“本轮所有验证都做完”之后执行；中途恢复会让后续步骤因锁屏而失败。
set -euo pipefail

command -v adb >/dev/null || { echo '找不到 adb' >&2; exit 1; }
[ -n "${1:-}" ] && ADB=(adb -s "$1") || ADB=(adb)

"${ADB[@]}" shell svc power stayon false
# 用 delete 回到系统默认，不要自己猜一个数值填进去
"${ADB[@]}" shell settings delete system screen_off_timeout >/dev/null 2>&1 || true
"${ADB[@]}" shell rm -f /sdcard/ui.xml

echo '手机调试设置已恢复：'
echo "  stayon            = $("${ADB[@]}" shell settings get global stay_on_while_plugged_in | tr -d '\r')"
echo "  screen_off_timeout= $("${ADB[@]}" shell settings get system screen_off_timeout | tr -d '\r')（null = 系统默认）"
echo
echo '说明：本机（vivo）不支持 locksettings set-disabled，故不涉及锁屏开关的恢复，'
echo '也不会去改动你的锁屏密码或图案。'
echo '不要用强制息屏来“验证”恢复结果 —— 那会真的把设备锁上。'
