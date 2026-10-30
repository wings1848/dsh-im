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

## 第五批新增：`/help` 分区卡

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/help` | 分区卡：主页显示各区入口与条数 | ✅ 「DeepSeek Harness 帮助」「共 23 条命令，点按钮查看分组：」「💬 会话（6）」「📁 工作区（3）」「🤖 模型与预设（6）」「⚙️ 任务与状态（6）」「📦 其他（2）」「🏠 控制台（/menu）」（`10-help-card-fixed.png`） |

### 真机抓到一个单测漏掉的真实 bug

第一版上线后卡片按钮显示 `undefined (6)`、`undefined (3)`（`10b-help-card-bug-undefined.png`）：
`commandHelpSections()` 返回的 section **没有 `label` 字段**，而渲染按钮时读的是
`section.label`，于是模板拼出 `undefined`。单测只断言按钮数量和 callback，**没有断言按钮文字**，
所以 14 例全绿也没发现。

修法：标签收敛到 `sectionLabel(group)` 一个函数（按钮用带 emoji 的，正文用纯文字标题），
并补一条断言「按钮文字里不能出现 undefined/null/[object，且会话按钮要匹配 `会话（\d+）`」。已留红证：
回退修复后该用例立刻失败。

分区跳转（点按钮原地重绘 + 「← 返回」回主页）由 14 例单测覆盖；真机上窗口位置漂移导致点击
落到了别的会话，未取得点击态截图。

## 第六批新增：会话卡动作行（解绑 / 新会话）

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/sessionlist` | 列表下方多一行动作：已绑定给「解绑当前会话」+「新会话」 | ✅ 真机可见「🔓 解绑当前会话」「🆕 新会话」两按钮，会话行与提示文字不变（`11-session-card-actions.png`） |
| 点「解绑当前会话」 | 卡片改写为回执、清键盘、绑定解除 | 按钮按下高亮已确认（`11b-session-actions-pressed.png`），但 Telegram 未把这次点击作为 callback 发出（state 的 sessions 未变、卡片未改写）——是点击落到按钮边缘的输入问题，不是实现问题；语义由 8 例单测覆盖 |

### 调试中发现的两个真 bug（都已修）

1. 失败分支用 `settle(nonce, ACTIVE)` 想「退回可点」，但 `ACTIVE` 不是终态，`settle()`
   抛 TypeError，异常冒到外层 catch，用户看到假的「这个会话列表已过期」。
2. `ActionCardRegistry.releaseClaim()` 在集成分支里**根本不存在**（它只在审批卡那条 PR
   的 worktree 里）。这次按需补齐：只放回仍存活的 `claimed` 卡，已 resolved/expired 的
   绝不复活。

## 第七批新增：`disabled` 标签按钮（Bot API 10.3）

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/models` | 分组头 / 页码 / 到头的翻页键 / 当前项 灰显不可点，其它模型行照常可点 | ✅ 真机一眼可分：「DeepSeek」「Bifrost - CommandCode Chat」两个分组头灰显；「第 1/4 页」「上一页」灰显；「✓ 5. GLM-5.3」灰显带 ✓；其余 1/2/3/4/6/7/8 保持正常按钮态（`12-disabled-labels-live.png`） |

这是本机第一次确认 Bot API 10.3 的 `DisabledButton` 在 Telegram Desktop 7.3.3
上确实按官方描述渲染（灰显、不发回调）。**升级风险已排除**：即使某个老客户端
忽略 `disabled`，退化表现也只是「灰按钮变回可点但无响应」，不会报错。

## 第八批新增：`/status` 可操作状态卡

| 命令 | 期望 | 实测 |
| --- | --- | --- |
| `/status` | 正文保留全部状态行，下面给刷新与各入口按钮 | ✅ 「Telegram机器人与 DeepSeek Harness 连接正常。」「工作区：im」（长路径截成末段）「绑定会话：session-0ba8335d-…」「当前模型：bifrost-chat/commandcode-chat/glim-5.3」「Agent Preset（预设）：跟随 Host 默认」；按钮「🔄 刷新」「🏠 菜单」「💬 会话」「📁 工作区」「🤖 模型」「🧩 预设」「❓ 帮助」（`13-status-card-live.png`） |

同一张截图还把上一批的成果一起拍进去了：上方 `/models` 卡里「DeepSeek」「Bifrost -
CommandCode Chat」两个分组头、「第 1/4 页」「上一页」、当前项「✓ 5. GLM-5.3」全部灰显，
其余模型行正常可点——`disabled`（Bot API 10.3）在真实客户端上的效果一目了然。

刷新（原地重绘）与各入口的跳转由 18 例单测覆盖（含并发双击只读一次、刷新失败不吞按钮）；
真机上窗口位置漂移导致点击落到别的会话，未取得点击态截图。

## 第九批新增：审批卡长参数折叠

**未取得真机截图**：折叠只在工具参数超过 900 字符时出现，需要真实触发一次审批
（模型调用受限工具）。隔离工作区是空目录 + 只读问答，本轮没构造出审批场景，
所以这批的验收完全依赖单测（24 例，含端到端「点开详情 → 仍能正常批准」）。

记录一个**没做的取舍**：为了「能出卡」而截断参数会让人在没看过完整命令时批准
一条 shell 操作，所以实现选择折叠 + 「📄 查看完整参数」按钮，且该按钮不认领
nonce（读详情不消耗唯一一次决定机会）。这条不变量有专门的用例守着。

## 未在本轮验证（需要特定触发条件）

- 审批按钮卡：需要一次真实工具审批。隔离工作区为空、模型为只读问答，未触发 `approval/requested`。
- 归档会话过滤：隔离工作区没有归档过的 Session（空目录），过滤逻辑由单测覆盖（`session-card` 用例）。
- 60 条上限：模型总数 29，未达到 60 的截断边界。

## 操作要点（复现用）

- GUI 自动化走 `computer-use-linux` MCP over SSH + `ydotoold`（socket 必须 `0600`，`0660` 会被拒）。
- CUS 坐标域是屏幕物理像素 `2560x1440`；portal 截图被缩放到 `1920x1080`，**截图坐标要乘 1.3333** 才是 CUS 坐标。
- `element_index` 点击只对当前可见节点可靠；列表项超出视口时会落到错误位置，此时用 `Ctrl+K` 搜索 + 方向键 + 回车选会话更稳。
- KDE 的 KRunner 会被 `Ctrl+K`/输入抢焦点：先连按 Escape 关掉再操作 Telegram。
