# Telegram 交互优化真机验证记录（wings-gpd 隔离环境，2026-10-30）

## 环境

- 设备：wings-gpd（KDE Plasma Wayland，Telegram Desktop 7.3.3 Flatpak）
- DSH：0.2.1-rc.5，**隔离 `DSH_HOME=/home/wings/dsh-lab`**，与生产 `~/.dsh` 完全分离
- 插件：dsh-im 5.4.0（集成分支 `feat/tg-ux-integration` @ `311bc123`，tarball sha256 `60f3b51a…1fa9`）
- 实验 bot：`@dsh_lab_ux_BOT`（platformId 8689229706），token 只落在 `~/dsh-lab/.lab-bot-token`（600）
- 服务：`systemd-run --user --unit=dsh-lab-web` 监听 `127.0.0.1:3180`；测试完毕已 `stop`
- 工作区：`/home/wings/dsh-lab/im`（空目录，验证「无会话」降级路径）

## 已验证项（截图见 `~/Code_Project/_notes/evidence-gpd-lab/`）

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/start` | 中文欢迎 + 能力说明 | ✅ `00-status-card.png`（历史 `/start` 与 `/status` 同屏） |
| `/status` | 5–6 行（连接/工作区/绑定会话/当前模型/Preset） | ✅ 6 行完整，含「Agent Preset（预设）：跟随 Host 默认」 |
| `/models` | 模型选择卡，分组 + 分页 + 底部操作行 | ✅ 标题「选择要使用的模型（共 29 个，第 1/4 页）」，分组 `DeepSeek` / `Bifrost - CommandCode Chat`，8 条目视可见，底部「上一页 / 第 1/4 页 / 下一页」；卡底另有「推理等级：Default」入口（`01-models-card.png`） |
| `/sessionlist` | 会话绑定卡，显示工作区与会话条目 | ✅ 「工作区：/home/wings/dsh-lab/im」「会话（1）：」「点击按钮把会话绑定到当前聊天」，按钮「暂无标题 · session-」；空工作区时仍给出可点条目（`02-…png`） |
| `/reasoninglist` | 推理等级卡 | ✅ 「选择推理等级（共 3 个）」「当前模型：bifrost-chat/commandcode-chat/glim-5.3」「当前推理等级：Default（由模型或 Provider 决定）」，按钮 `1. Low (low)` `2. High (high)` `3. Max (max)` + 「跟随默认（由模型决定）」（`03-…png`） |
| `/ws` | 工作区切换卡 | ✅ 「选择要切换的工作区（共 1 个）：」「✓ 1. im」（`04-…png`） |
| 菜单入口 | 输入框左侧出现「菜单」按钮 | ✅ 上述截图均可见 |

## 第二批新增：`/presetlist` Agent Preset 选择卡

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/presetlist` | 可点选择卡：标题带总数、当前选择、每项 ✓ 标记、跟随默认行 | ✅ 「选择要使用的 Agent Preset（共 4 个）」「当前选择：跟随 Host 默认」`✓ 1. standard` `2. ptc` `3. minimal` `4. cordis`「跟随 Host 默认」（`05/06-preset-card*.png`） |

点按刷新（原地编辑成新 ✓ 行）由 18 例单测覆盖；真机上的鼠标点击受窗口位置漂移影响，
未能稳定命中按钮，故只记录渲染证据。

## 第三批新增：`/clear` 二次确认卡

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/clear` | 不立即清空，先发确认卡，正文说明后果与保留项 | ✅ 「确定要清空当前会话的上下文吗？」「会话：session-0ba8335d-…」「工作区：/home/wings/dsh-lab/im」「清空后模型不再记得前面的对话内容。」「Session 绑定和历史记录仍会保留。」「这个操作不能撤销。」按钮「🗑 清空上下文」「✖️ 取消」（`07-clear-confirm-card.png`） |

顺带观察到一个真实行为：服务重启后，上一轮遗留的 preset 卡片按键再点会得到
「该 Agent Preset 卡片已失效或不存在」——正是 nonce 只存在内存里的已知限制，
文案符合预期。

按钮的「清空 / 取消」语义（清空跑真实命令一次、取消零副作用、双击只清一次、
过期卡不生效、跨聊天不可用）由 16 例单测覆盖；真机点击受窗口位置漂移影响未命中。

## 第四批新增：`/menu` 控制台 hub 卡

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/menu` | 摘要卡 + 6 个入口按钮 | ✅ 「DeepSeek Harness 控制台」「工作区：im」（长路径截成末段）「会话：session-0ba8335d-…」，两行六按钮「💬 会话」「📁 工作区」「🤖 模型」「🧩 预设」「📊 状态」「❓ 帮助」（`08-menu-hub-card.png`） |
| 点「📊 状态」 | 等价于手打 `/status`，hub 保持可用 | ✅ hub 下方出现完整 6 行状态回复（含当前模型 `bifrost-chat/commandcode-chat/glim-5.3`），hub 未被消耗（`09-menu-status-entry.png`） |

这是本轮唯一在真机上**成功点中按钮**的一次，入口链路端到端跑通。

## 未在本轮验证（需要特定触发条件）

- 审批按钮卡：需要一次真实工具审批。隔离工作区为空、模型为只读问答，未触发 `approval/requested`。
- 归档会话过滤：隔离工作区没有归档过的 Session（空目录），过滤逻辑由单测覆盖（`session-card` 用例）。
- 60 条上限：模型总数 29，未达到 60 的截断边界。

## 操作要点（复现用）

- GUI 自动化走 `computer-use-linux` MCP over SSH + `ydotoold`（socket 必须 `0600`，`0660` 会被拒）。
- CUS 坐标域是屏幕物理像素 `2560x1440`；portal 截图被缩放到 `1920x1080`，**截图坐标要乘 1.3333** 才是 CUS 坐标。
- `element_index` 点击只对当前可见节点可靠；列表项超出视口时会落到错误位置，此时用 `Ctrl+K` 搜索 + 方向键 + 回车选会话更稳。
- KDE 的 KRunner 会被 `Ctrl+K`/输入抢焦点：先连按 Escape 关掉再操作 Telegram。
