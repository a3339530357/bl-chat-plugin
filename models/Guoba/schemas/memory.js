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
  { field: 'memoryV3.enabled', label: '长期记忆总开关', component: 'Switch', bottomHelpMessage: '关掉只是暂停（整理和聊天带记忆都停），已经记下的东西不删，随时再开' },
  { field: 'memoryV3.extractor', label: '整理时怎么看聊天', component: 'Select', componentProps: { options: [
    { label: '复刻整段对话让主模型看（推荐）', value: 'fork' },
    { label: '旧方式：小模型分小批看原文', value: 'flash' }
  ] }, bottomHelpMessage: 'fork = 把哈基米平时看到的完整聊天记录（含系统提示）原样再给一次主对话模型，末尾追加提取指令——和聊天共用同一段缓存，全量重读很便宜，语境也最完整。flash = 旧方式，用便宜小模型分批看消息原文' },
  { field: 'memoryV3.groups', label: '启用记忆的群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '填要让哈基米动用长期记忆的群号，#整理记忆 和聊天时带记忆都只对这些群生效。不填 = 跟下面「保全原料的群」保持一致；想全关就把群号都删掉保存' },
  { field: 'memoryV3.organizeEnabled', label: '允许 #整理记忆 命令', component: 'Switch', bottomHelpMessage: '关掉后命令发了也不干活；攒下的聊天原文不受影响' },
  { field: 'memoryV3.injectEnabled', label: '聊天时带记忆', component: 'Switch', bottomHelpMessage: '把记下的成员情况和群里的大事带给哈基米参考，只在当轮生效，不会塞进聊天记录' },
  { field: 'memoryV3.reclaimEnabled', label: '整理完删原件省空间', component: 'Switch', bottomHelpMessage: '整理成功后的消息原件删掉省空间（证据会留底，没整理过的绝不删）。拿不准就开着' },
  { field: 'memoryV3.coreTokens', label: '固定记忆体积上限', component: 'InputNumber', componentProps: { min: 64, max: 16000 }, bottomHelpMessage: '每轮聊天都带的「固定记忆」的体积上限，超了会在 #记忆状态 里提醒你删几条不重要的，不会偷偷截断' },
  { field: 'memorySource.enabled', label: '悄悄备份聊天原文', component: 'Switch', bottomHelpMessage: '每条群消息的原文自动备份一份给记忆用，只是备份不影响任何功能；关掉只停新备份，已备份的不删' },
  { field: 'memorySource.groups', label: '备份原文的群', component: 'GTags', componentProps: { allowAdd: true, allowDel: true }, bottomHelpMessage: '不填 = 跟「启用省钱的群」一致；一个都不想备份就清空保存' },
  ...legacyFields.map(field => ({ ...field, label: field.field ? `${field.label}（旧字段）` : '旧记忆兼容配置', bottomHelpMessage: '兼容保留；V3不使用此字段，旧自动提取和旧召回已退役' }))
]
