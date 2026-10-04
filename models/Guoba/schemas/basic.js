export default [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "基础与运行"
  },
  {
    field: "enabled",
    label: "插件总开关",
    component: "Switch",
    bottomHelpMessage: "false 时完全关闭 AI 对话功能"
  },
  {
    field: "groupHistory",
    label: "群聊历史记录",
    component: "Switch",
    bottomHelpMessage: "建议开启，使 AI 能参考上下文对话"
  },
  {
    field: "groupMaxMessages",
    label: "最大历史消息数",
    component: "InputNumber",
    bottomHelpMessage: "AI 能记住的最近群聊消息数量",
    componentProps: { min: 10, max: 1000, placeholder: "100" }
  },
  {
    field: "groupChatMemoryDays",
    label: "历史保存天数",
    component: "InputNumber",
    bottomHelpMessage: "群聊记录在内存中保留的时间（天）",
    componentProps: { min: 1, max: 30, placeholder: "1" }
  },
  {
    field: "concurrentLimit",
    label: "并发数限制",
    component: "InputNumber",
    bottomHelpMessage: "同一群聊同时处理的最大对话数，达到上限时新消息直接不触发（不排队）",
    componentProps: { min: 1, max: 20, placeholder: "3" }
  },
  {
    field: 'promptCache.enabled', label: '对话缓存 V2', component: 'Switch',
    bottomHelpMessage: '默认关闭，仅对下面列出的群生效'
  },
  {
    field: 'promptCache.groups', label: 'V2 灰度群', component: 'GTags',
    bottomHelpMessage: '填写群号；空列表不启用任何群，* 表示所有群',
    componentProps: { allowAdd: true, allowDel: true }
  },
  { field: 'promptCache.highWaterTokens', label: 'V2 输入高水位', component: 'InputNumber', componentProps: { min: 4096, max: 524288 } },
  { field: 'promptCache.lowWaterTokens', label: 'V2 历史低水位', component: 'InputNumber', componentProps: { min: 2048, max: 524288 } },
  { field: 'promptCache.reserveTokens', label: 'V2 输出与工具预留', component: 'InputNumber', componentProps: { min: 1024, max: 65536 } },
  { field: 'promptCache.rawMaxEvents', label: 'V2 当日消息源上限', component: 'InputNumber', componentProps: { min: 100, max: 200000 } },
  { field: 'promptCache.rawMaxBytes', label: 'V2 消息源字节上限', component: 'InputNumber', componentProps: { min: 1048576, max: 536870912 } },
  { field: 'promptCache.diagnostics', label: 'V2 缓存诊断日志', component: 'Switch' },
  { field: 'promptCache.singleStage', label: 'V2 单阶段对话', component: 'Switch', bottomHelpMessage: '默认关闭，仅对同时选入 V2 与单阶段灰度的群生效' },
  { field: 'promptCache.singleStageGroups', label: '单阶段灰度群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '空列表不启用；* 仍受 V2 灰度群限制' },
  { field: 'promptCache.agentTemperature', label: '单阶段温度', component: 'InputNumber', componentProps: { min: 0, max: 2, step: 0.05 } },
  { field: 'promptCache.agentTopP', label: '单阶段 Top P', component: 'InputNumber', componentProps: { min: 0.01, max: 1, step: 0.01 } },
  { field: 'promptCache.agentSideEffectPolicy', label: '单阶段动作策略', component: 'Select', componentProps: { options: [
    { label: '轻量自主互动，语音/管理需明确意图', value: 'contextual' },
    { label: '保留原自主动作策略', value: 'legacy' },
    { label: '全部副作用需明确请求', value: 'explicit' }
  ] } },
  { field: 'promptCache.preserveForcedSubsets', label: '强制工具子集兼容', component: 'Switch', bottomHelpMessage: '仅双阶段生效；单阶段保持工具声明不变' },
  { field: 'promptCache.preserveFinalNoTools', label: '末轮空工具兼容', component: 'Switch', bottomHelpMessage: '仅双阶段生效；单阶段通过执行预算收口' },
  {
    field: "segmentedReplyEnabled",
    label: "分段发送",
    component: "Switch",
    bottomHelpMessage: "开启时按标点/换行把回复拆成多条消息（拟人化，默认开启）；关闭则大模型返回什么就整条发送。注意：即使关闭，回复含换行时仍会按换行分段，不受此开关控制"
  },
  {
    field: "triggerPrefixes",
    label: "触发关键词",
    component: "GTags",
    bottomHelpMessage: "包含这些词的消息会激活 AI 回复（按回车添加）",
    componentProps: { allowAdd: true, allowDel: true }
  },
  {
    field: "excludeMessageTypes",
    label: "过滤消息类型",
    component: "GTags",
    bottomHelpMessage: "忽略这些类型的消息，通常保持默认 file 即可",
    componentProps: { allowAdd: true, allowDel: true }
  }
]
