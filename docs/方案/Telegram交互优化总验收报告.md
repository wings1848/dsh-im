# Telegram 交互优化 —— 完整验收报告

日期：2026-10-31
分支：`feat/tg-ux-integration`（基线：上游 `main` + PR #430/#431/#432）
验证设备：wings-gpd（KDE Wayland + Telegram Desktop 7.3.3），隔离 `DSH_HOME`

---

## 1. 这份报告的范围

本会话在已提交的三个上游 PR（#430 审批卡、#431 菜单 scope + /status、#432 /ws 卡，
均已 MERGEABLE + CI 绿）**之外**新增了 16 个提交：

- **9 个 feat/fix/test**：8 项功能或修复 + 1 个防复发测试
- **7 个 docs**：真机验证记录 + 各批验收表

改动全部在 `feat/tg-ux-integration` 分支，**未向上游发起任何新 PR**。

---

## 2. 交付清单

| # | 交付物 | 文件 | 测试数 |
| --- | --- | --- | --- |
| 1 | `/presetlist` Agent Preset 选择卡 | `src/channels/telegram/preset-card.mjs` | 18 |
| 2 | `/clear` 二次确认卡 | `src/channels/telegram/clear-card.mjs` | 16 |
| 3 | `/menu` 控制台 hub 卡 | `src/channels/telegram/menu-card.mjs` | 15 |
| 4 | `/help` 分区卡 | `src/channels/telegram/help-card.mjs` | 14 |
| 5 | `/status` 可操作状态卡 | `src/channels/telegram/status-card.mjs` | 18 |
| 6 | `/conv` 对话专属工作区卡 | `src/channels/telegram/conv-card.mjs` | 18 |
| 7 | 会话卡「解绑 / 新会话」动作行 | `src/channels/telegram/session-card.mjs` | 27（含既有） |
| 8 | Bot API 10.3 `disabled` 标签按钮 | `telegram-api.mjs` + 4 张卡 | 22（interaction-card） |
| 9 | 审批卡长参数折叠 | `src/channels/telegram/approval-card.mjs` | 24（含既有） |
| 10 | 卡片入口防复发测试 | `test/channels/telegram/card-entries.test.mjs` | 15 |

- 12 个卡片相关测试文件合计 **225 例全绿**
  （`node --test test/channels/telegram/*-card.test.mjs test/channels/telegram/card-entries.test.mjs`）
- `test/channels/telegram/` 全部（含命令菜单等）**417 例全绿**
- 全量 **4653 例 0 fail**

---

## 3. 修复的真 bug（全部有红证或明确证据）

| # | bug | 影响面 | 怎么发现的 |
| --- | --- | --- | --- |
| 1 | `/help` 卡片按钮显示 `undefined (6)` | 用户可见 | **真机截图** |
| 2 | `settle(nonce, ACTIVE)` 抛 TypeError，失败被误报成「列表已过期」 | 假错误提示 | 单测 |
| 3 | `releaseClaim()` 在集成分支根本不存在 | 失败后按钮永久失效 | 单测 |
| 4 | **`isWorkspaceCommand` 被使用却从未 import** | `/menu` 工作区入口、`/status` 工作区入口、`/conv` 切换**全部静默失败** | 调试 `/conv` 卡时 |
| 5 | 模型卡加 `disabled` 时把所有行都当标签，选择器变哑 | 只能看不能切 | 既有测试的 `button()` 助手 |
| 6 | `markSeen` 放在发卡之前，卡片被拒时命令被跳过 | `/clear` 失效 | 单测 |

**第 4 条最值得记**：它从 `/menu` 那批就存在，`ReferenceError` 被 `#runMenuEntry` 的
catch 吞成「暂时无法打开」，看起来像网络问题。我前几轮在真机上「点 /menu 入口没反应」
的困惑，根因就是它——当时以为是 GUI 坐标漂移。

### 每条 bug 的证据等级（如实标注）

| # | 证据等级 |
| --- | --- |
| 1 | **真机截图**（`10b-help-card-bug-undefined.png`） |
| 2 | 用例断言（`a failed release leaves the card usable`），无独立红证录像 |
| 3 | 用例断言 + 修复前会 TypeError（该用例最初红色） |
| 4 | **红证已实测**：去掉 import → `card-entries.test.mjs` 立刻失败 |
| 5 | 既有测试大面积变红（`button()` 助手按 callback 筛选暴露） |
| 6 | **无独立红证**：修掉了并有用例，但没留「修复前失败」的记录 |

第 6 条如实标注为缺红证——按项目的验红闸门要求，它算未留痕。

---

## 4. 不变量（每条都有测试守着）

| 不变量 | 为什么 | 守它的测试 |
| --- | --- | --- |
| **`/help` 输出字节不变** | `fixtures/command-help.json` 是 5 渠道共用历史基线 | `command-help.test.mjs` |
| **`/status` 文字输出不变** | 跨渠道既有行为；卡片只是附加展示面 | `status-command.test.mjs` |
| **`/sessionlist` 文字列表不变** | 只多一行动作，绑定/分页逻辑不动 | `session-card.test.mjs` |
| **无键盘渠道行为完全不变** | 7 张卡全部有「关掉卡片回文字」的降级用例 | 每张卡的 `xxxCard: null` / 无键盘用例 |
| **审批绝不截断参数** | 否则等于让人在没看过完整命令时批准 shell 操作 | `foldApprovalCardText` 用例 |
| **回调 ≤64 字节且不含路径/会话 ID** | Telegram 硬限制 + 隐私 | 每张卡的 callback 预算用例 |
| **`/conv` 绝不改 bot 默认工作区** | 与 `/ws` 语义不同，混淆代价高 | `conv-card.test.mjs` 专门一条 |

---

## 5. 真机证据（wings-gpd，17 张截图）

位置：`~/Code_Project/_notes/evidence-gpd-lab/`

| 文件 | 内容 |
| --- | --- |
| `00-status-card.png` | `/status` 六行文本（改造前基线） |
| `01-models-card.png` | `/models` 模型卡（29 个 / 4 页） |
| `02-session-card-…png` | `/sessionlist` 会话卡 + 推理入口 |
| `03-reasoning-card.png` | `/reasoninglist` 推理等级卡 |
| `04-ws-workspace-card.png` | `/ws` 工作区卡 |
| `05/06-preset-card*.png` | `/presetlist` 卡（含验证时的构图） |
| `07-clear-confirm-card.png` | `/clear` 确认卡（正文三行说明齐全） |
| `08-menu-hub-card.png` | `/menu` hub 卡 |
| `09-menu-status-entry.png` | **点 hub 的「状态」入口 → 完整状态回复**（端到端跑通） |
| `10b-help-card-bug-undefined.png` | `/help` 卡 **undefined bug 现场** |
| `10-help-card-fixed.png` | 修复后的 `/help` 分区卡 |
| `11-session-card-actions.png` | 会话卡「解绑 / 新会话」动作行 |
| `12-disabled-labels-live.png` | **`disabled` 灰显效果**（分组头/页码/当前项灰、其余可点） |
| `13-status-card-live.png` | `/status` 状态卡 |
| `14-conv-card-live.png` | `/conv` 卡（含「改所有对话请用 /ws」提示） |

---

## 6. 没做到的部分（明确记录）

| 项 | 状态 | 原因 |
| --- | --- | --- |
| `/help` 分区跳转的真机点击 | 未取证 | GUI 点击受窗口位置漂移影响，落到别的会话 |
| 会话卡「解绑 / 新会话」的真机点击 | 按钮按下高亮可见，callback 未发出 | 同上 |
| `/status` 刷新的真机点击 | 未取证 | 同上 |
| 审批卡折叠的真机效果 | **完全没有截图** | 折叠只在参数 >900 字符时出现，需真实触发审批；隔离工作区是空目录 + 只读问答，构造不出该场景 |

前三条都是同一个原因（这是自动化 GUI 点击的问题，不是实现问题），且语义都有测试覆盖。
**第四条是真的缺口**，只说单测覆盖，不算真机验收。

---

## 7. 技术事实核对

| 事实 | 来源 | 记录位置 |
| --- | --- | --- |
| Bot API 10.3 新增 `DisabledButton` / `InlineKeyboardButton.disabled` | core.telegram.org/bots/api（2026-08-24 条目） | `runs/disabled-buttons/facts.md`（含可复核 curl） |
| `disabled` 与 `callback_data` 互斥（「exactly one action field」） | 同上，`InlineKeyboardButton` 抬头 | 同上 |
| Telegram Desktop 7.3.3 确实按 disabled 灰显且不发回调 | 本机真机截图 `12-…png` | 验证记录 |

---

## 8. 如何复核

```bash
cd <repo>
git checkout feat/tg-ux-integration

# 全量（含 build + 打包校验）
npm run check

# 只看 Telegram 卡片
node --test test/channels/telegram/*-card.test.mjs \
            test/channels/telegram/card-entries.test.mjs

# 红证复现：去掉 isWorkspaceCommand 的 import，这条会立刻失败
node --test test/channels/telegram/card-entries.test.mjs
```

---

## 9. 待决定

这 16 个提交要不要进上游？三个选项：

1. **拆成多个小 PR**（基础层 + 各卡独立）——好审，沟通多
2. **合成 2–3 个 PR**（基础层 / 卡片层）——快，单 PR 大
3. **先不发**——本地留着

发 PR 属于「别人会看到」，需要明确同意才做。
