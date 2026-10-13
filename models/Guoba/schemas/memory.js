const legacyFields = [
  {
    component: "SOFT_GROUP_BEGIN",
    label: "长期记忆系统 (memorySystem)"
  },
  {
    field: "memorySystem.enabled",
    label: "长期记忆开关",
    component: "Switch",
    bottomHelpMessage: "控制旧记忆召回；旧自动提取已停用。V3 原料采集由 memorySource 独立控制，不依赖模型配置"
  },
  {
    field: "memorySystem.maxFactsPerUser",
    label: "每用户最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个用户在每个群最多保存多少条记忆（所有类别总计），超过会按重要性淘汰",
    componentProps: { min: 10, max: 1000, placeholder: "100" }
  },
  {
    field: "memorySystem.maxFactsPerGroup",
    label: "每群最大记忆条数",
    component: "InputNumber",
    bottomHelpMessage: "每个群的全局共识记忆最多保存多少条（所有类别总计）",
    componentProps: { min: 10, max: 1000, placeholder: "50" }
  },
  {
    field: "memorySystem.importanceThreshold",
    label: "重要性阈值",
    component: "InputNumber",
    bottomHelpMessage: "低于此值的事实不会保存",
    componentProps: { min: 0, max: 1, step: 0.05, placeholder: "0.5" }
  },
  {
    field: "memorySystem.memoryDecayDays",
    label: "记忆参考时效（天）",
    component: "InputNumber",
    bottomHelpMessage: "记忆召回时参考的时效天数，越远的记忆权重越低",
    componentProps: { min: 1, max: 365, placeholder: "7" }
  },
  {
    field: "memorySystem.userExtractDebounceSeconds",
    label: "用户记忆提取防抖（秒）",
    component: "InputNumber",
    bottomHelpMessage: "用户对话结束后，等待 N 秒再触发记忆提取，避免短时间重复调用",
    componentProps: { min: 0, max: 600, placeholder: "45" }
  },
  {
    field: "memorySystem.userExtractMaxBatchMessages",
    label: "用户记忆批量大小",
    component: "InputNumber",
    bottomHelpMessage: "用户记忆每次提取时一次性分析的消息条数",
    componentProps: { min: 1, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.groupExtractMinIntervalMinutes",
    label: "群记忆最小整理间隔（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "群记忆两次整理之间至少间隔 N 分钟",
    componentProps: { min: 1, max: 120, placeholder: "10" }
  },
  {
    field: "memorySystem.groupExtractMaxBatchMessages",
    label: "群记忆触发条数",
    component: "InputNumber",
    bottomHelpMessage: "群累计多少条消息后立即整理一次",
    componentProps: { min: 1, max: 100, placeholder: "12" }
  },
  {
    field: "memorySystem.promptMaxUserFacts",
    label: "注入用户记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每次对话时注入 prompt 的用户记忆条数上限",
    componentProps: { min: 0, max: 50, placeholder: "8" }
  },
  {
    field: "memorySystem.promptMaxGroupFacts",
    label: "注入群记忆最大条数",
    component: "InputNumber",
    bottomHelpMessage: "每次对话时注入 prompt 的群共识记忆条数上限",
    componentProps: { min: 0, max: 50, placeholder: "6" }
  },
  {
    field: "memorySystem.promptMaxChars",
    label: "记忆 prompt 字符上限",
    component: "InputNumber",
    bottomHelpMessage: "记忆部分注入 system prompt 的总字符上限，控制 token 消耗",
    componentProps: { min: 100, max: 8000, placeholder: "1200" }
  },
  {
    field: "memorySystem.semanticRecallEnabled",
    label: "语义召回开关",
    component: "Switch",
    bottomHelpMessage: "开启前需在「AI 模型配置」页填好 embeddingAiConfig，默认关闭即可"
  },
  {
    field: "memorySystem.semanticRecallTopK",
    label: "语义召回候选数",
    component: "InputNumber",
    bottomHelpMessage: "仅在开启语义召回时生效，先筛选多少条候选记忆",
    componentProps: { min: 1, max: 100, placeholder: "20" }
  }
]


export default [
  { component: 'SOFT_GROUP_BEGIN', label: '长期记忆 V3' },
  { field: 'memoryV3.enabled', label: '长期记忆 V3', component: 'Switch', bottomHelpMessage: '关闭整理和注入，不删除已保护数据，不重新开启旧自动提取' },
  { field: 'memoryV3.groups', label: '启用记忆的群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '填群号；未配置时沿用原料采集群，显式空列表表示不启用任何群' },
  { field: 'memoryV3.organizeEnabled', label: '允许主人整理', component: 'Switch', bottomHelpMessage: '主人发送 #整理记忆 才启动；关闭会暂停任务，原料仍保留' },
  { field: 'memoryV3.injectEnabled', label: '对话使用长期记忆', component: 'Switch', bottomHelpMessage: '核心事实与相关群事件仅作为本轮尾部资料' },
  { field: 'memoryV3.reclaimEnabled', label: '回收已整理原料', component: 'Switch', bottomHelpMessage: '只回收已成功提交且证据已另存的原料，保留末尾20条语境；未整理原料不删除' },
  { field: 'memoryV3.coreTokens', label: '核心事实预算', component: 'InputNumber', componentProps: { min: 64, max: 16000 }, bottomHelpMessage: '超限会在记忆状态中显示，需精简核心事实；不会静默截断' },
  { field: 'memorySource.enabled', label: '保全记忆原料', component: 'Switch', bottomHelpMessage: '独立于整理、注入和模型配置；关闭停止新采集，不删除已保全数据' },
  { field: 'memorySource.groups', label: '保全原料的群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '未配置时沿用 promptCache.groups；显式空列表不采集任何群' },
  ...legacyFields.map(field => ({ ...field, label: field.field ? `${field.label}（旧字段）` : '旧记忆兼容配置', bottomHelpMessage: '兼容保留；V3不使用此字段，旧自动提取和旧召回已退役' }))
]
