#!/usr/bin/env bash
# 手机调试前置：关闭自动锁屏与息屏，避免调试中途黑屏导致点击落空、截图全黑。
#
# 这是调试前的第一步，恢复用同目录的 phone-debug-off.sh。
# 注意：只要还有后续验证没做完，就不要执行 off 脚本。
set -euo pipefail

command -v adb >/dev/null || { echo '找不到 adb' >&2; exit 1; }
[ -n "${1:-}" ] && ADB=(adb -s "$1") || ADB=(adb)

# 1) 充电时常亮（本机走 USB，所以这一条直接生效）
"${ADB[@]}" shell svc power stayon true
# 2) 屏幕超时设为永不 —— 这才是防「超时自动锁屏」的关键
#    注意：部分 ROM（本机 vivo 已验证）不编译 `locksettings set-disabled`，
#    该命令会执行但读回始终是 false，因此不要依赖它，也别为此去动设备的锁屏状态。
"${ADB[@]}" shell settings put system screen_off_timeout 2147483647
# 3) 唤醒一次，确保从息屏状态也能直接开测（不改变锁屏开关）
"${ADB[@]}" shell input keyevent KEYCODE_WAKEUP

echo '手机调试前置已开启：'
echo "  stayon            = $("${ADB[@]}" shell settings get global stay_on_while_plugged_in | tr -d '\r')"
echo "  screen_off_timeout= $("${ADB[@]}" shell settings get system screen_off_timeout | tr -d '\r')（2147483647 = 永不）"
echo "  wakefulness       = $("${ADB[@]}" shell dumpsys power | grep -o 'mWakefulness=[A-Za-z]*' | head -1)"
echo "  锁屏是否显示      = $("${ADB[@]}" shell dumpsys window 2>/dev/null | grep -o 'showing=[a-z]*' | head -1)"
echo
# 注意：locksettings get-disabled 在部分国产 ROM（如 vivo）上即使生效也回报 false，
# 别拿它当判据。权威信号是 dumpsys window 的 showing= 与 dumpsys trust 的 deviceLocked=。
echo '判定方法：dumpsys window 里 showing=false 且 dumpsys trust 里 deviceLocked=0 才算真的没锁屏；'
echo 'locksettings get-disabled 在本机（vivo）不可靠，不要用它判断。'
echo
echo '调试完成后请执行 scripts/phone-debug-off.sh 恢复（且必须等本轮所有验证都做完）。'
