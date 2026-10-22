# Telegram 交互体验真机验证记录（批次 0+1 集成）

状态：**已执行（2026-10-22 08:20–08:45）**。验证对象是集成分支
`feat/tg-ux-integration`（`/ws` 工作区卡 + 批次 0 菜单/`/status` + 批次 1 审批按钮卡），
不是单个特性分支；特性分支验收见各自方案文档。

## 0. 环境

| 项 | 值 |
| --- | --- |
| Bot | `@dsh_e2e_22q4_bot`（测试 bot，用户授权创建，验证后删除） |
| Host | `wings-gpd`（CachyOS，KDE Plasma 6.8 Wayland，Telegram Desktop 7.3.1 flatpak） |
| 控制通道 | `computer-use-linux` v0.7.22（MCP over SSH stdio）+ ydotool 1.0.4 + ydotool user service |
| 被测实例 | 独立 `DSH_HOME=~/.dsh-e2e` 的 `dsh web --port 5011`（不触碰生产实例与生产 bot） |
| 沙箱/审批策略 | `DSH_PERMISSION_MODE=workspace-write`（审批 policy=ask） |
| 构建 | 集成分支合并 3 条特性分支 + 2 轮评审修复后 `npm run build`；全量 `npm test` 全绿 |
| 证据截图 | `/home/wings/Code_Project/_notes/tg-e2e/screenshots/`（01–11） |

真机操作全部由 CUS 完成：`activate_window` → `click`（窗口相对坐标）→
`type_text`/`press_key`（ydotool），`screenshot` 取 xdg-desktop-portal 截图；
KDE 首次截图弹过一次「允许应用获取截屏吗？」授权框，批准后复用。

## 1. 用例与结果

| # | 用例 | 操作 | 期望 | 实测 |
| --- | --- | --- | --- | --- |
| E1 | 新 bot 首次可用 | 客户端点「开始」发 `/start` | 独立实例建档并回中文欢迎语 | ✅ 08:20，截图 01 |
| E2 | `/status` 文本补全 | 发送 `/status` | 一条消息 5–6 行：连接/工作区/绑定会话/模型/Preset；空闲时不显示运行中任务 | ✅ 5 行；切换工作区后显示新路径，未绑定时显示「未绑定（发送消息后自动创建）」且模型行说明原因（截图 02/06） |
| E3 | `/ws` 单工作区卡 | 发送 `/ws` | 卡片：标题+每工作区一个按钮，当前项 ✓ | ✅ 「共 1 个」+「✓ 1. im」（截图 03） |
| E4 | `/ws` 多工作区卡 + 点击切换 | 预置 3 个工作区后重发 `/ws`，点「2. dsh-im」 | 原地把 ✓ 移到第 2 项；切换真实生效 | ✅ 卡片原地更新「✓ 2. dsh-im」；随后 `/status` 显示 `工作区：/home/wings/Code_Project/dsh-im`（截图 04/05/06） |
| E5 | 审批卡出现 | 让 bot 执行工作区外写入：`touch /home/wings/dsh-e2e-approval.txt` | 卡片含错误摘要/工具/参数/原因 + `✅ 批准一次` `❌ 拒绝`，不出现「请精准回复」 | ✅ 卡片完整；进度消息先显示「正在使用bash…」，随后审批卡（截图 07） |
| E6 | 批准一次 | 点 `✅ 批准一次` | 卡片原地变「✅ 已批准（仅本次）」并清键盘；agent 继续执行并回报 | ✅ 终态出现、键盘消失；agent 回报文件已创建（0 字节）并补充沙箱升级说明（截图 08） |
| E7 | 拒绝 | 再触发一次删除审批，点 `❌ 拒绝` | 卡片原地变「❌ 已拒绝」并清键盘；agent 收到拒绝并按拒绝继续 | ✅ 终态出现；agent 说明文件仍在、给出两条后续选择（截图 09/10） |
| E8 | 原生命令菜单（私聊）真机展示 | 点输入框左侧「菜单」 | 只列主名，无 8 个别名；私聊含 `/history` | ✅ 列表 `/new /compact /clear /history /workspace …` 无别名（截图 11） |
| E9 | scope 注册真实结果 | Bot API `getMyCommands`（default/private/group） | default=0；private=22；group=18（不含 history/batch/send/cancel） | ✅ default 0 / private 22 / group 18（`probe --live` 与手工查询一致） |
| E10 | 平台数值（批次 0 探测脚本） | `probe-telegram-limits.mjs --live`（测试 bot + 探测 chat） | callback_data 64 收/65 拒、UTF-8 63 收/66 拒；按钮数量上限；编辑+键盘组合；429 | ✅ 64 收/65 拒（`BUTTON_DATA_INVALID`）、63/66 UTF-8 符合预期；按钮 8/20/40/60/100/200 全部接受（范围内未触限）；`editMessageText`+`reply_markup` 一次调用接受；连续 30 次编辑窗口内未触发 429 |
| E11 | 审批挂起时先发普通文字，再点按钮 | 最终构建上触发审批 → 发 `ok` → 点 `✅ 批准一次` | 普通文字不收到「请精准回复…」；终态只出现一次；agent 继续执行 | ✅ 三条都成立（截图 14/15）；终态「✅ 已批准（仅本次）」无重复文字回执 |
| E11b | 终态编辑失败时清键盘 | 单测注入终态 edit 失败 | 仍尝试清键盘（`updateInteractionCard(messageId, 空键盘)`） | ✅ 单测覆盖（评审修复 #1 回归用例，真机无法安全构造 edit 失败） |
| E12 | 文本降级路径 | 卡片发送失败/无卡渠道 | 逐字回退「请精准回复『批准』或『拒绝』」 | ✅ 由单测覆盖（真机无法安全造卡片发送失败，见方案 §3.5） |

## 2. 最终构建复核（评审修复后）

最终构建 = 两条评审修复全部合入 + `npm run build` + 全量 `npm test` 全绿。复核结果：

- `/status`：5–6 行正常，工作区/绑定会话随切换更新（截图 12）。
- 审批卡：卡片完整、`editMessageText` 一次调用更新正文+清键盘；批准后 agent 继续执行（截图 13）。
- 评审修复 #2 真机复核：审批挂起时先发普通文字 `ok` → 不再收到「请精准回复」；点批准后终态只出现一次、无重复「已批准」文字（截图 14/15，用例 E11）。
- `/ws` 卡片点击切换、原生命令菜单在最终构建上与前一次一致（用例 E4/E8 未回归）。

## 3. 真机暴露 / 已知限制

1. KDE 截屏 portal 首次需要一次人工授权（「允许应用获取截屏吗？」）；之后自动复用。
2. `type_text` 走 ydotool 时只支持 US 物理键位可打字符；中文输入需先写剪贴板再 `Ctrl+V`（本次中文提示均由 bot 侧发出，未受影响）。
3. KDE 下 `spectacle -b` 崩溃，截图改由 CUS 的 xdg-desktop-portal 路线完成。
4. 审批卡弹窗期间若发起人先发普通文字再点按钮，终态只出现一次（评审修复 #2 的真机行为在最终构建复核）。
5. `answerCallbackQuery` 的实际超时秒数机器人无法自测；本次点击体验无「转圈卡住」现象。
6. 真机验证的 bot / 独立实例均为临时资产，验证结束后删除（见 §3）。

## 4. 清理

- 测试 bot 通过 BotFather `/deletebot` 删除；token 文件删除。
- 独立实例 `dsh web` 停止；`~/.dsh-e2e` 整个删除；`~/.dsh/profiles/web/cordis.patch.yml` 的
  computer-use-linux MCP 条目回滚（测试期临时添加）。
- `wings-gpd`：停用本次创建的 ydotool user service（保留 unit 便于下次复用）、删除临时 token 文件；
  保留 CUS 二进制与截图授权（后续真机测试可复用）。
