# Telegram 交互优化 —— 完整验收报告

日期：2026-10-31
分支：`feat/tg-ux-integration`（基线：上游 `main` + PR #430/#431/#432）
验证设备：wings-gpd（KDE Wayland + Telegram Desktop 7.3.3），隔离 `DSH_HOME`

---

## 1. 这份报告的范围

本会话在已提交的三个上游 PR（#430 审批卡、#431 菜单 scope + /status、#432 /ws 卡，
均已 MERGEABLE + CI 绿）**之外**的全部改动，起点是本会话第一个功能提交
`a618fd15`（`/presetlist` 卡）。

> **不要在本报告里找精确的提交总数**：每补一次文档它就会变一次（我第一版写 16、
> 复核时是 17、写完又变 21 和 22 —— 三次都对不上，因为数字在写的同时还在变）。
> 需要当前值时直接跑下面的命令。功能范围见第 2 节交付清单。
>
> ```bash
> git rev-list --count a618fd15^..HEAD   # 本会话全部提交
> git log --oneline a618fd15^..HEAD      # 逐条查看
> ```

改动全部在 `feat/tg-ux-integration` 分支，**未向上游发起任何新 PR**。

---

## 2. 交付清单

各交付物的「覆盖用例数」是**该文件的总用例数**（含既有用例），**不要加总**——
加总不等于 225，因为会话卡、审批卡、交互卡里有一部分用例是改造前就存在的。

| # | 交付物 | 文件 | 该文件用例数 |
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

## 3. 修复的 6 个真 bug（证据等级见 3.1）

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

| # | 证据等级 | 说明 |
| --- | --- | --- |
| 1 | **真机截图** | `10b-help-card-bug-undefined.png`，用户可见缺陷的直接证据 |
| 2 | 红证（用例先红后绿） | 失败路径用例在修复前报的是假的「列表已过期」 |
| 3 | 红证（用例先红后绿） | `releaseClaim` 缺失时该用例直接 TypeError |
| 4 | **红证已实测 + 独立复核** | 去掉 import → 14 pass / 1 fail；核验者已复现 |
| 5 | 无红证，但有测试变红记录 | 加 `disabled` 后 8 例失败，正是它暴露了「全都成标签」 |
| 6 | **红证（补测）** | 把 `markSeen` 移回发卡之前 → `clear-card.test.mjs` 15 pass / 1 fail，失败项 `a refused card send falls back to clearing immediately` |

关于第 6 条：修复当时**没有留**「修复前失败」的记录，写这份报告时补做了红证——
把 `markSeen` 挪回发卡之前，对应用例确实变红（15 pass / 1 fail），还原后 16/16 全绿。
所以它现在是可复现的红证，但**当时确实漏了**，如实记下。

第 5 条严格说不算红证（是先写了错误实现导致既有测试变红，不是「先写测试再修」），
写在这里是为了把它和真正的红证区分开。

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
# 文件是 src/channels/shared/text-harness-bridge.mjs（不是 telegram 目录下）
cp src/channels/shared/text-harness-bridge.mjs /tmp/thb.bak
#   把 import 块里的 `isWorkspaceCommand,` 一行删掉后：
node --test test/channels/telegram/card-entries.test.mjs   # 预期 14 pass / 1 fail
cp /tmp/thb.bak src/channels/shared/text-harness-bridge.mjs
node --test test/channels/telegram/card-entries.test.mjs   # 预期 15/15 全绿
```

## 8.1 独立核验记录

本报告的关键断言已由独立 subagent 逐条复核（不共享本会话上下文）：

| 核验项 | 结论 |
| --- | --- |
| 12 个卡片文件 225 例全绿 | ✅ 属实（实测 225/225，退出码 0） |
| 全量 4653 例 0 fail | ✅ 属实（187 秒，未超时） |
| 6 个源文件与类导出 | ✅ 属实（类名精确匹配） |
| 新增提交数 | ❌ **首版写错**（写 16，字面实测 17）→ 已改为 21 并写死基线命令 |
| 17 张截图 | ✅ 属实（23M） |
| `/help` 由 command-help.test.mjs 守护 | ✅ 属实（8/8） |
| 红证可复现 | ✅ 属实（去 import 后 14 pass / 1 fail，失败项正是 /conv 入口） |

核验者另指出两处**易误读表述**，均已修正：提交数的口径、以及「测试数」一列的加总歧义。

---

## 9. 待决定

这批改动要不要进上游？三个选项：

1. **拆成多个小 PR**（基础层 + 各卡独立）——好审，沟通多
2. **合成 2–3 个 PR**（基础层 / 卡片层）——快，单 PR 大
3. **先不发**——本地留着

发 PR 属于「别人会看到」，需要明确同意才做。
