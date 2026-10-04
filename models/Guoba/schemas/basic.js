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
    field: 'promptCache.enabled', label: '省钱缓存（V2）', component: 'Switch',
    bottomHelpMessage: '让 AI 记住整天的聊天记录而不用重复付费读一遍（缓存命中后同样的内容几乎不要钱）。只对下面填了群号的群生效'
  },
  {
    field: 'promptCache.groups', label: '启用省钱的群', component: 'GTags',
    bottomHelpMessage: '填群号（回车添加）；* 表示所有群',
    componentProps: { allowAdd: true, allowDel: true }
  },
  { field: 'promptCache.highWaterTokens', label: '记忆超过多少就删旧的', component: 'InputNumber', componentProps: { min: 4096, max: 524288 }, bottomHelpMessage: '聊天记录涨过这条线（token 计），就从最早的消息开始删，防止越聊越贵' },
  { field: 'promptCache.lowWaterTokens', label: '删到多少停手', component: 'InputNumber', componentProps: { min: 2048, max: 524288 }, bottomHelpMessage: '删旧消息删到这条线就停，保留近期聊天' },
  { field: 'promptCache.reserveTokens', label: '给回复留的余量', component: 'InputNumber', componentProps: { min: 1024, max: 65536 }, bottomHelpMessage: '算记忆上限时，给 AI 的回复和工具结果预留的空间，一般不用动' },
  { field: 'promptCache.rawMaxEvents', label: '当天最多记多少条', component: 'InputNumber', componentProps: { min: 100, max: 200000 }, bottomHelpMessage: '一天内消息记录的条数上限，一般不用动' },
  { field: 'promptCache.rawMaxBytes', label: '当天记录最大占用', component: 'InputNumber', componentProps: { min: 1048576, max: 536870912 }, bottomHelpMessage: '一天内消息记录的硬盘占用上限（字节），一般不用动' },
  { field: 'promptCache.diagnostics', label: '缓存诊断日志', component: 'Switch', bottomHelpMessage: '每次请求往日志里记缓存命中率和 token 花销。排查缓存问题时开，平时关了也行' },
  { field: 'promptCache.singleStage', label: '一次搞定模式', component: 'Switch', bottomHelpMessage: 'AI 判断用什么工具和写回复一次完成（不再先问一遍工具再写回复），更快、缓存更好。只对同时勾了上面省钱缓存的群生效' },
  { field: 'promptCache.singleStageGroups', label: '一次搞定模式的群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '填群号；也得同时在上面省钱群列表里才会生效' },
  { field: 'promptCache.agentTemperature', label: '回复随机度', component: 'InputNumber', componentProps: { min: 0, max: 2, step: 0.05 }, bottomHelpMessage: '越高说话越发散跳脱，越低越稳定。0.85 左右比较像真人' },
  { field: 'promptCache.agentTopP', label: '用词范围 (Top P)', component: 'InputNumber', componentProps: { min: 0.01, max: 1, step: 0.01 }, bottomHelpMessage: '和随机度类似的另一个旋钮，一般和随机度配着用，不动也行' },
  { field: 'promptCache.agentSideEffectPolicy', label: '它自作主张的程度', component: 'Select', componentProps: { options: [
    { label: '戳人/表情包可以自己来，语音/禁言/改名要明确要求（推荐）', value: 'contextual' },
    { label: '保留原来的自主动作规则', value: 'legacy' },
    { label: '什么都不自作主张，全部要明确要求', value: 'explicit' }
  ] } },
  { field: 'promptCache.preserveForcedSubsets', label: '强制指定工具（双阶段旧项）', component: 'Switch', bottomHelpMessage: '旧的双阶段模式才用；一次搞定模式下无效' },
  { field: 'promptCache.preserveFinalNoTools', label: '末轮不带工具（双阶段旧项）', component: 'Switch', bottomHelpMessage: '旧的双阶段模式才用；一次搞定模式下无效' },
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
