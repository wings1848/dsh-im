# Telegram 提问卡片 E2E 实测记录（真机 · 按钮路径 + 文字回复路径）

日期：2026-09-13 05:38–05:40（Asia/Taipei）
测试者：手机端 UI 自动化（adb + phoneMcp），全程用真实 Telegram 客户端收发
被测版本：DSH-IM `4.20.2`，运行中副本构建于 04:40（含 `0b65cf4`，不含 `f3680cf`）
会话：`session-fa149d87-136c-452a-8e3b-76096802c523`（机器人私聊 `@wings_pc_dsh_bot`）

## 测试目标

验证「提问卡片」这条端到端链路：模型调用 `ask_user_question`
→ 渠道下发带 inline keyboard 的提问消息 → 用户在手机上**点按钮**
→ 结构化答案回到 Harness → 卡片定格为已答状态。

## 触发方式

在手机上以文字消息触发，模型按指令调用工具：

```
E2E card test: call ask_user_question with question \Pick a time slot\ and exactly 3 options: morning, afternoon, evening. Use the tool now.
```

模型实际发出的工具参数：

```json
{"questions":[{"header":"Time Slot","id":"time_slot",
  "options":[{"label":"morning"},{"label":"afternoon"},{"label":"evening"}],
  "question":"Pick a time slot"}]}
```

## 实测结果

| # | 检查项 | 判定方式 | 实测 |
| --- | --- | --- | --- |
| 1 | 提问消息送达并带按钮 | 手机 UI dump 出 3 个 `android.widget.Button` | ✅ morning / afternoon / evening 各一行 |
| 2 | 点击按钮可提交 | adb 点击 `afternoon` 按钮（573,1929） | ✅ 无需辅助操作即提交 |
| 3 | 答案结构化正确 | 会话 `tool/result` 事件 | ✅ `{"answers":[{"id":"time_slot","selected":["afternoon"]}]}`，`isError: false` |
| 4 | 按下哪个就回哪个（不错位） | 按钮文本 vs 工具结果 | ✅ 点第 2 项得到 `afternoon` |
| 5 | 等待期间不被草稿卡住 | 提问→结果间隔 | ✅ 24 秒（05:38:49 → 05:39:13），期间无重新激活的处理草稿 |
| 6 | 卡片定格为已答状态 | 回答后再次 UI dump | ✅ 按钮全部消失，无残留可点元素 |
| 7 | 最终答复送达 | 手机屏幕文本 | ✅ 机器人回「你选了：afternoon 🌤️」 |

会话事件链（`---home-wings--/session-fa149d87…`）：

- `seq 35/36` 05:38:49 `assistant/message` + `tool/call`：`ask_user_question`
- `seq 37` 05:39:13 `tool/result`：`selected: ["afternoon"]`，`isError: false`
- `seq 38/39` `step/end` → `step/start`：问答正常收尾
- `seq 40` 05:39:16 `assistant/message`：最终答复

## 本轮漏检：Web 端选项卡一直阻塞（手机答完也不关）

**首轮记录曾把「Web GUI 也显示了这张提问卡」当成两侧一致的证据，这是错的。**
那张卡当时是**阻塞状态**：手机 05:39 已经作答、手机端卡片已定格为已答，
Web 端选项卡仍在显示选项、仍可点击，直到宿主重启才会消失。

已确认的根因链路：

1. `dsh-client-ui-user-questions`（Web 端提问卡）的 pending 只有三个出口
   （`lib/client.js`）：自己作答、收到 abort 信号、或委派给下一个监听者。
   它**不消费 `question/resolved` 事件**（该包内零命中），所以不存在「收到宿主通知后自己收卡」的路径。

2. Web 端唯一的 abort 来源，是宿主侧适配器持有的 `request.signal`
   （`plugin-src/host/modern-harness-api.mjs` `#requestQuestion`）。
3. 修复前，IM 先答完只做 `im.dismiss(...)`，**没有触发那个 signal**：

   ```js
   // 修复前（运行中副本 04:40）
   .finally(() => { e.dismiss(new Error('another client answered this question')) })
   // 修复后（f3680cf，工作区构建 05:15）
   .finally(() => {
     e.dismiss(new Error('another client answered this question'));
     i && A.signal?.dispatchEvent(new Event('abort'));   // ← 通知 Web 端收卡片
   })
   ```

4. 结果：IM 答案正常回到模型（工具结果 `selected: ["afternoon"]`、`isError: false`），
   而 Web 端 promise 永不 settle，选项卡一直挂着 —— 两个症状同时成立，互不矛盾。

会话事件里也看不到任何「关闭卡片」类事件（05:38:46–05:39:16 全序列为
`turn/start → user/message → request/header → assistant/message → tool/call → tool/result → step/end → … → turn/end`），
与「Web 端只能靠 abort 收卡」的结论一致。

## 复测：修复上线后的真机闭环（06:29 / 06:33）

宿主重启后（新构建 md5 `44e4517523c7be26f34fc00dea6efab2`，与工作区构建一致），
按同一路径又跑了两轮，**这次两侧都真机验证**：

| # | 检查项 | 判定方式 | 实测 |
| --- | --- | --- | --- |
| 8 | 修复确实装进了运行中的宿主 | 已装构建里 `dispatchEvent(abort)` 命中数 | ✅ `1`（且 `#w` 里 `i&&A.signal?.dispatchEvent(...)` 可见） |
| 9 | 按钮路径：答案结构化正确 | 会话 `seq 52` `tool/result` | ✅ `{"answers":[{"id":"fruit","selected":["banana"]}]}`，`isError: false` |
| 10 | **Web 端选项卡自动消失** | 用户肉眼观察 Web GUI | ✅ 卡片自己收掉了，输入框不再阻塞（本轮核心回归项） |
| 11 | 纯文字回复路径可用（不点按钮） | 会话 `seq 65` `tool/result` | ✅ 直接发 `cherry` 也回 `selected: ["cherry"]`，`isError: false` |
| 12 | 文字回复后 Web 端同样不阻塞 | 用户肉眼观察 Web GUI | ✅ 无残留卡片 |

两个真机命令（可复现）：

```bash
# 9 / 11：读会话事件里的工具结果
zstd -dc ~/.dsh/sessions/--home-wings--/session-fa149d87-136c-452a-8e3b-76096802c523/session.v3.jsonl.zstd \
  | python3 -c "import sys,json
for l in sys.stdin:
    o=json.loads(l)
    if o.get('seq') in (52,65): print(o['seq'], json.dumps(o['data'],ensure_ascii=False)[:160])"
# 期望：seq 52 → selected:["banana"]；seq 65 → selected:["cherry"]，两处 isError 均为 false

# 8：确认运行中的构建带修复
python3 -c "s=open('/home/wings/.dsh/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js',encoding='utf-8',errors='replace').read();i=s.find('another client answered this question');print(s[max(0,i-900):i+300].count('dispatchEvent'))"
# 期望：1
```

注意：第 10 项是**人工核对**项（用户看 Web GUI），不是命令判定；这也是这条 bug 首轮漏检的原因 ——
首轮把「Web 端也显示了这张卡」误当成同步证据，而它当时其实是阻塞态。

## 事后评审：修复的机制前提是错的（已更正）

复测通过之后又请了三路独立评审（仓库规范 / 规格符合度 / 对抗性正确性）。
对抗轴推翻了修复注释里的机制断言，这条比 bug 本身更值得记：

**`request.signal` 不是「本问题的生命周期信号」，而是整个 turn 共享的信号。**

- `dsh-agent-loop` 每 turn 新建 `phase.abort`，并把它作为 step 信号传给工具执行；
- `dsh-tools` 的 `fuseToolSignals(caller, wrapper)` 在 caller === wrapper 时**直接返回该对象**，
  所以 `ask_user_question` 拿到的就是这个 turn 信号；
- 因此在它上面 `dispatchEvent(new Event('abort'))` 会退掉**该信号上的每一个**待答项，
  不只是我们这一问。对抗轴用真插件复现过：同信号挂两个 pending、只答 A，B 也收到
  `ASK_ABORTED` 被静默取消。

**当时为什么没炸**：`dsh-tool-ask-user` 没有声明 `isConcurrencySafe`，工具注册表据此判为
`exclusive`（`dsh-tools` 里 `if (!tool?.isConcurrencySafe) return { kind: "exclusive" }`），
一个 turn 里跑不出两个并发提问。是当前实现的巧合，不是设计保证。

**顺带确认的安全性质**：`dispatchEvent` 不会把 `signal.aborted` 置真，agent-loop 也没有把
abort 事件当「该停」的监听器，所以回合照常结束（真机也验证了：作答后回合并正常收尾）。

**已做的处置**（commit `dfc188a`，已推 PR #206）：

1. 更正源码注释，把「request lifetime」改成真实机制，并写明「一旦并发提问可行就必须改成
   每问一个 `AbortController`」；
2. 补镜像回归用例 —— 原断言所在的用例**没给 request 传 signal**，所以 `request.signal?.…`
   在那儿本就是空操作，把守卫改成 `if (true)` 也全绿（对抗轴的变异测试发现的）。
   新增「host 先答 + 带 signal → 派发 0 次」，双向变异均验红。

核验命令（三条就能看到真相）：

```bash
D=~/.bun/install/global/node_modules/@deepseek-ai
rg -n 'new AbortController' $D/dsh-agent-loop/lib/index.js | head    # 每 turn 一个
rg -n -A3 'function fuseToolSignals' $D/dsh-tools/lib/index.js       # caller===wrapper 直接返回
rg -n 'isConcurrencySafe|name:|execute' $D/dsh-tool-ask-user/lib/index.js  # 只有 name/execute → 独占
```

## 维护者复核：`dispatchEvent` 在 PTC 下是实际回归（本轮修复，commit `7143c5b`）

维护者复核 `dfc188a` 时指出：上一节的「派发事件不会让回合停下」只对 agent-loop 成立，
对 **PTC（`run_code`）路径不成立**。他给的复现是「只提问一次、只在 IM 正常作答一次」：

```js
const answer = await tools.ask_user_question({
  questions: [{ id: 'pick', question: 'Pick one', options: [{ label: 'A' }, { label: 'B' }] }],
});
return { continued: true, answer };
```

预期返回 `{ continued: true, answer }`，实际外层 `run_code` 报
`code run failed (abort): undefined`。

根因（三条都能在安装包里读到）：

```bash
D=~/.bun/install/global/node_modules/@deepseek-ai
rg -n 'onOuterAbort' -A3 $D/dsh-tools/lib/index.js          # exec.signal.addEventListener("abort", …) → runController.abort()
rg -n 'onAbort = \(\)' -A5 $D/dsh-code-runtime-worker-thread/lib/index.js  # 监听事件 → kind:"abort" → 收 worker
rg -n 'runtime.run\(\{' -A6 $D/dsh-tools/lib/index.js        # 传给 runtime.run 的正是同一个 runController.signal
```

即 `run_code` 与 worker 都靠**监听 abort 事件**停下，不看 `signal.aborted`；
`exclusive` 调度只挡住并发工具，挡不住「正在等这个子工具的外层程序」。

**改法**（采纳维护者建议，收窄取消范围）：每次提问新建只属于本题的 `AbortController`，
上游真取消转发进来，再把它当作 `request.signal` 交给下游（Cordis waterfall 传同一个
request 对象、`next()` 不接受替换参数 → 原地替换；该对象是 `UserQuestionService.ask`
的每次调用副本，调用方那份不受影响）。IM 胜出只 abort 本题信号，宿主先答则完全不动它。

**验收证据**

| 标准 | 判定 | 实测 |
| --- | --- | --- |
| 修复前必须红 | `node --test test/host-modern-harness-api.test.mjs` | 3 例失败：`AssertionError: a program waiting on the answer must survive an IM answer` |
| 修复后全绿 | 同上 + 全量 | 24/24；合并 main 后 `npm test` **2812 通过** |
| 真取消仍要转发 | 新增 `a question cancelled with its turn` 用例 | 通过（范围收窄未切断取消） |
| 真机：旧版本复现 | 真宿主 + PTC 预设 + 真 Telegram | `代码, Error: code run failed (abort): undefined` |
| 真机：修复后继续执行 | 同上，装上修复并重启宿主 | `{"continued": true, "answer": {"answers": [{"id": "pick", "selected": ["A"]}]}}`，`isError` 空，turn `completed` |
| 旧路径的告警消失 | `journalctl --user -u dsh-web --since 16:01 \| grep -c 'user-question answerer failed'` | `0`（旧版本同场景必打 `typert gateway: Remote event was cancelled`） |

**未做**：仓库内「真实 ToolRuntime + ask-user + WorkerThreadCodeRuntime」的组合测试。
dsh-im 的测试全部是伪造宿主契约的形式（`@deepseek-ai/dsh-*` 不在本仓库依赖里），
写一条依赖本机 harness 安装路径的测试在 CI 里只能 skip；组合层面的结论由上面的真机闭环给出。
组合测试若要进仓库，正确落点是 harness 仓库。

**真机环境提醒**：本轮又踩到一次中文输入法 —— fcitx5 会把 `adb shell input text` 注入的
字母吃成拼音候选（输入框里只剩第一个 `/`）。做法是临时 `ime disable` 掉所有输入法、
用完把三个都 `ime enable` 回来并把默认恢复成 `org.fcitx.fcitx5.android`。
另外 `adb` 在沙箱里看不到 USB（无 `/dev/bus/usb`），需要 `danger-full-access`。

## 未覆盖项（边界路径）

以下边界本次**没有**在真机上复现成功，原因是环境干扰（输入法 composing 截断、
误触消息菜单、来电通知遮挡点击目标），不在本轮证据范围内：

- 连点同一卡片多次 → 只提交一次
- 回答后旧键盘仍被按下 → 不产生第二次提交
- 多选问题 → 走文字降级而非键盘

这些路径由自动测试覆盖，本轮跑通 20/20：

```sh
node --test test/channels/telegram/interaction-card.test.mjs
# tests 20 / pass 20 / fail 0
```

含 `a stale keyboard cannot answer the question now on screen`、
`two presses of one card answer only the question it belongs to`、
`answering by text retires the card keyboard` 等用例。

## 环境注意（版本差异 · 阻塞 bug 未生效的原因）

- 本机 DSH profile 装的 `@xmanrui/dsh-im` 解析到
  `github:wings1848/dsh-im#fix/telegram-interaction-cards`，工作区构建于 **05:15**（含 `f3680cf`）。
- 运行中宿主加载的副本构建于 **04:40**，**不含** `f3680cf`
  （`fix(host): retire the question lifetime when IM answers first`），
  所以本轮真机复现到了 Web 端阻塞 bug —— 这正是 `f3680cf` 要修的问题。
- 判定命令（可复现）：

  ```sh
  python3 -c "
  s=open('/home/wings/.dsh/profiles/web/node_modules/@xmanrui/dsh-im/lib/index.js',encoding='utf-8',errors='replace').read()
  i=s.find('another client answered this question')
  seg=s[max(0,i-900):i+300]
  print('dispatchEvent(abort):', seg.count('dispatchEvent'))"
  # 输出 0 → 修复未加载；输出 1 → 已加载
  ```

- 要让 `f3680cf` 生效：把 profile 依赖从工作区重装（或重新拉取该分支）并**重启宿主**。
- 已经挂在屏幕上的阻塞选项卡，解除方式只有 **浏览器整页刷新**（或重启宿主），
  因为它对应的客户端 pending 不会自己 settle。
- 由于构建产物 `lib/index.js` 在仓库内受版本控制，`git status` 干净，无需担心仓库被测试改动。

## 收尾与防自动锁屏要求（硬性）

**调试手机期间必须防住「设备静置超时自动锁屏」**，否则中途黑屏会让截图全黑、点击落空、
`uiautomator dump` 拿不到元素，整轮白跑。有效做法只有两条：

```sh
adb shell svc power stayon true                              # 充电时常亮（插 USB 即生效）
adb shell settings put system screen_off_timeout 2147483647  # 屏幕超时设永不 —— 关键
```

封装成脚本使用，不要临时手敲：

```sh
scripts/phone-debug-on.sh     # 调试前
scripts/phone-debug-off.sh    # 收尾恢复
```

**本机（vivo V2417A）实测的坑**：

- `locksettings set-disabled true` **不生效**：命令返回成功，但读回恒为 `false`
  （`locksettings get-disabled` 与 `settings get secure lockscreen.disabled` 都是 0/false）。
  这与「是否设置过锁屏凭据」无关（`dumpsys trust` 显示 `deviceLocked=0`）。
  该命令不编译进这套 ROM，别依赖它，也别拿它的读回值判断防护是否生效。
- **不要为了验证防护效果去按 `KEYCODE_SLEEP` 强制息屏** —— 那会真的把设备锁上，
  把用户挡在外面。本次实测就犯了这个错，导致用户需要手动解锁。
  判断防护是否生效只看：`screen_off_timeout` 是否为 `2147483647`、
  `dumpsys power` 的 `mWakefulness` 是否仍为 `Awake`。

**关键约束：只要本轮还有任何后续验证没做完，就不要执行 off 脚本。**
本次实测就因为收尾过早恢复了锁屏相关的防护，导致后续 Web 卡片闭环验证需要重新开一遍前置。
