// English translations (telegram area). Keys are exact Chinese literals passed to t().
export default {
  // Terminal status written back over a placeholder whose in-place edit was
  // rejected, so it is the last thing a reader sees on a degraded reply.
  '回复已发送。': 'The reply was sent.',
  '回复发送结果未能确认。': 'The reply delivery result could not be confirmed.',
  '消息发送失败，请稍后重试。': 'The message could not be sent. Try again later.',
  '开启一个全新会话': 'Start a brand-new Session',
  '压缩当前会话的较早上下文': 'Compact the earlier context of the current Session',
  '切换工作区': 'Switch Workspace',
  // /ws workspace picker card: one tap switches, the pressed card is re-marked in place.
  '选择要切换的工作区（共 {count} 个）：': 'Choose a Workspace to switch to ({count} total):',
  '这个列表已过期，请重新发送 /ws。': 'This list has expired. Send /ws again.',
  '正在切换工作区，请稍候。': 'Switching Workspaces, one moment.',
  '已经在工作区：{workspace}': 'Already in this Workspace: {workspace}',
  '暂时无法切换工作区，请稍后重试。': 'Could not switch Workspaces right now. Try again later.',
  '列出工作区绝对路径': 'List Workspace absolute paths',
  '列出会话 ID 和标题': 'List Session IDs and titles',
  '将当前聊天绑定到指定会话': 'Bind the current chat to a specific Session',
  '按序号列出所有可用模型': 'List all available models by number',
  '查看或切换当前会话模型': 'View or switch the model of the current Session',
  '列出可用 Agent Preset': 'List available Agent Presets',
  '查看或设置新会话 Agent Preset': 'View or set the Agent Preset for new Sessions',
  '停止当前任务': 'Stop the current task',
  '纠偏当前任务': 'Steer the current task',
  '检查连接状态': 'Check connection status',
  '查看插件版本': 'Show plugin version',
  '显示帮助': 'Show help',
  '该 Telegram 机器人已配置 Webhook，请先在原服务中移除 Webhook 后重试。':
    'This Telegram bot already has a Webhook configured. Remove the Webhook from the original service and try again.',
  'Telegram机器人': 'Telegram Bot',
  ' Bot API 长轮询': ' Bot API long polling',
  // Approval button card (batch 1): buttons, terminal receipts and dead-card
  // notices. Keys match the literals passed through t() in approval-card.mjs.
  '✅ 批准一次': '✅ Approve once',
  '✅ 已批准（仅本次）': '✅ Approved (this time only)',
  '❌ 已拒绝': '❌ Rejected',
  '⏰ 已过期': '⏰ Expired',
  '⛔ 已失效': '⛔ No longer valid',
  '正在提交审批决定，请稍候。': 'Submitting the approval decision, please wait.',
  '该审批已处理，无需重复操作。': 'This approval was already handled. No need to act again.',
  '该审批已过期，已自动拒绝。': 'This approval expired and was rejected automatically.',
  '该审批已被新提示取代，请使用最新一条。':
    'This approval was superseded by a newer prompt; use the latest one.',
  '该审批已失效，请等待新的审批提示。':
    'This approval is no longer valid; wait for a new approval prompt.',
  // Model / reasoning picker cards (batch 2-A): body text, button labels,
  // in-place receipts and dead-card notices. Keys match the literals passed
  // through t() in telegram/model-card.mjs.
  '选择要使用的模型（共 {count} 个，第 {page}/{pages} 页）':
    'Choose a model ({count} total, page {page}/{pages})',
  '推理等级：{effort}': 'Reasoning effort: {effort}',
  '第 {page}/{pages} 页': 'Page {page}/{pages}',
  '选择推理等级（共 {count} 个）': 'Choose a reasoning effort ({count} total)',
  '跟随默认（由模型决定）': 'Follow the default (decided by the model)',
  '已经是当前模型。': 'This is already the current model.',
  '已经是当前推理等级。': 'This is already the current reasoning effort.',
  '模型已切换为：{model}': 'Model switched to: {model}',
  '推理等级已切换为：{effort}': 'Reasoning effort switched to: {effort}',
  '已恢复默认推理等级。': 'Restored the default reasoning effort.',
  '无法切换模型，详情见上方提示。': 'Could not switch the model. See the notice above.',
  '无法切换推理等级，详情见上方提示。':
    'Could not switch the reasoning effort. See the notice above.',
  '无法更新选择卡片，请重新发送命令。':
    'Could not update the picker. Send the command again.',
  '已打开推理等级选择。': 'Opened the reasoning effort picker.',
  '暂时无法打开推理等级列表，请发送 /reasoninglist。':
    'Could not open the reasoning effort list. Send /reasoninglist.',
  '这个列表已过期，请重新发送 /models。': 'This list has expired. Send /models again.',
  '这个列表已过期，请重新发送 /reasoninglist。':
    'This list has expired. Send /reasoninglist again.',
  '正在切换，请稍候。': 'Switching, one moment.',
  '该操作已处理，无需重复操作。': 'This action was already handled. No need to act again.',
  '该操作已过期，请重新发送命令。': 'This action expired. Send the command again.',
  '该操作已被新操作取代，请使用最新一张卡片。':
    'This action was replaced by a newer card; use the latest one.',
  '该列表已变化，请重新发送命令。': 'This list changed. Send the command again.',
  '该操作已失效，请重新发送命令。': 'This action is no longer valid. Send the command again.',
  '该操作已失效或不存在。': 'This action is no longer valid or does not exist.',
  // Session-list picker card (batch 2): pager, row hint, binding receipt and
  // dead-card notices. Keys match the literals passed through t() in
  // session-card.mjs (including the state overrides translated at use).
  '第 {page}/{pageCount} 页': 'Page {page}/{pageCount}',
  '点击按钮把会话绑定到当前聊天。': 'Tap a session button to bind it to this chat.',
  '已经是第 {page} 页。': 'Already on page {page}.',
  '当前聊天已经绑定该会话。': 'This chat is already bound to that Session.',
  '已绑定会话：{title}': 'Bound to Session: {title}',
  '这个会话列表已过期，请重新发送 /sessionlist 或 /session。':
    'This session list has expired. Send /sessionlist or /session again.',
  '当前工作区没有可绑定的会话（已归档的会话不显示）。':
    'No bindable sessions in this workspace (archived sessions are hidden).',
  '这个会话列表已处理，请重新发送 /sessionlist。':
    'This session list was already handled. Send /sessionlist again.',
  '这个会话列表已被更新的列表取代，请使用最新一条。':
    'This session list was replaced by a newer one; use the latest.',
  '这个会话列表已失效，请重新发送 /sessionlist。':
    'This session list is no longer valid. Send /sessionlist again.',
  '正在绑定会话，请稍候。': 'Binding the Session, one moment.',
  '暂时无法更新会话列表，请重新发送 /sessionlist。':
    'Could not update the session list right now. Send /sessionlist again.',
  // Telegram Agent Preset picker (batch 2-C).
  '选择要使用的 Agent Preset（共 {count} 个）': 'Choose an Agent Preset ({count} available)',
  '当前选择：{preset}': 'Current choice: {preset}',
  '当前选择：跟随 Host 默认': 'Current choice: follow the Host default',
  // /clear confirmation card (batch 2-D).
  '确定要清空当前会话的上下文吗？': 'Clear the context of this conversation?',
  '会话：{session}': 'Session: {session}',
  '清空后模型不再记得前面的对话内容。': 'After clearing, the model no longer remembers the earlier conversation.',
  'Session 绑定和历史记录仍会保留。': 'The Session binding and the history are kept.',
  '这个操作不能撤销。': 'This cannot be undone.',
  '🗑 清空上下文': '🗑 Clear context',
  '✖️ 取消': '✖️ Cancel',
  '已取消，当前会话未修改。': 'Cancelled. This conversation was not changed.',
  '已清空。': 'Cleared.',
  '清空没有完成，请查看上面的说明。': 'Clearing did not finish; read the message above.',
  '这条确认已失效，请重新发送 /clear。': 'This confirmation is no longer valid; send /clear again.',
  '正在清空上下文，请稍候。': 'Clearing the context, please wait.',
  '这次清空已处理，无需重复操作。': 'This clear was already handled. No need to act again.',
  '这条清空确认已过期，请重新发送 /clear。': 'This clear confirmation expired; send /clear again.',
  '已显示新的清空确认，请使用最新一条。': 'A newer clear confirmation is shown; use the latest one.',
  '这条清空确认已失效或不存在。': 'This clear confirmation is no longer valid or does not exist.',
};
