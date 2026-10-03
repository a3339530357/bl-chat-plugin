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
  { field: 'promptCache.preserveForcedSubsets', label: '强制工具子集兼容', component: 'Switch', bottomHelpMessage: '保留视频、头像、导图、红包场景原有单工具声明，优先保证强制工具行为' },
  { field: 'promptCache.preserveFinalNoTools', label: '末轮空工具兼容', component: 'Switch', bottomHelpMessage: '保留原空工具收尾，关闭前需验证网关 none 行为' },
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
