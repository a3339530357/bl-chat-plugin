export default [
  // 整组配置都在"对话追踪"这一个 tab 内；内部用 Divider 做小节分隔
  {
    component: "SOFT_GROUP_BEGIN",
    label: "对话追踪"
  },

  // ===== 严格模式追踪（strict）=====
  { component: "Divider", label: "严格模式：@过之后还能接着聊" },
  {
    field: "conversationTrackingEnabled",
    label: "接着聊功能",
    component: "Switch",
    bottomHelpMessage: "只在严格模式下有效。开了之后：你@它说过一次话，接下来几分钟你不带@继续说，它也能接上（AI 判断你是不是在跟它说）。关了就只认@和前缀。开着会多花一点 AI 调用"
  },
  {
    field: "conversationTrackingTimeout",
    label: "接着聊的记忆时长（分钟）",
    component: "InputNumber",
    bottomHelpMessage: "@过一次后，它能“记得你在跟它说话”多久。默认 2 分钟，超时后你不带@说话它就不理了",
    componentProps: { min: 1, max: 30, placeholder: "2" }
  },
  {
    field: "conversationTrackingThrottle",
    label: "连发省略间隔（秒）",
    component: "InputNumber",
    bottomHelpMessage: "同一个人连着刷屏时，隔几秒才认真判断一次，中间的消息直接跳过。省 AI 调用。默认 3 秒",
    componentProps: { min: 1, max: 60, placeholder: "3" }
  },
  {
    field: "batchJudgmentDelay",
    label: "攒一攒再判断（秒）",
    component: "InputNumber",
    bottomHelpMessage: "消息来了先攒这几秒，把你连发的几条合成一拨、一次判断完再决定回不回。调大=更省但反应慢，调小=反应快但 AI 调用多。默认 5",
    componentProps: { min: 1, max: 60, placeholder: "5" }
  },
  {
    field: "conversationTrackingReplyDebounceMs",
    label: "回话前等一等（毫秒）",
    component: "InputNumber",
    bottomHelpMessage: "决定要回之后先等这一小会儿——你还在连发它就先憋着，等你停了才一次性回。防刷屏。0=不等待。推荐 1000~2000",
    componentProps: { min: 0, max: 10000, placeholder: "1500" }
  },

  // ===== 触发模式切换 =====
  { component: "Divider", label: "什么时候开口说话" },
  {
    field: "chatTriggerMode",
    label: "说话模式",
    component: "Select",
    bottomHelpMessage: "严格模式=叫它才回（必须@或以“哈基米”开头）；智能模式=它自己看着群聊，觉得该插话就插话。⚠️ 智能模式需要先在「AI 模型配置」页配好“对话追踪”那组模型，没配它就永远不会主动说话",
    componentProps: {
      options: [
        { label: "严格模式（叫它才回，默认）", value: "strict" },
        { label: "智能模式（自己判断要不要插话）", value: "smart" }
      ]
    }
  },

  // ===== 智能模式 - 频率与阈值 =====
  { component: "Divider", label: "智能模式：插话的积极程度  ⚠ 需先配好「AI 模型配置」页的对话追踪模型" },
  {
    field: "smartTrigger.talkValue",
    label: "插话积极性",
    component: "InputNumber",
    bottomHelpMessage: "0.1=大约每 10 条消息考虑一次要不要插话，0.15=约 7 条一次（推荐），1=每条都考虑（很活跃但费 token）。越大越爱说话。取值 0.01-1.0",
    componentProps: { min: 0.01, max: 1, step: 0.05, placeholder: "0.15" }
  },
  {
    field: "smartTrigger.idleCompensationEnabled",
    label: "冷群找补",
    component: "Switch",
    bottomHelpMessage: "群里很久没人说话时，把“安静的时间”折算成消息数凑数，让冷群也有机会触发插话检查，不至于永远轮不到它说话"
  },
  {
    field: "smartTrigger.avgLatencyDefaultMs",
    label: "平均发言间隔初始值 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "刚启动还没有统计数据时的估算基数，一般不用动",
    componentProps: { min: 5000, max: 600000, step: 5000, placeholder: "60000" }
  },
  {
    field: "smartTrigger.timingGateCooldownSeconds",
    label: "判断冷却（秒）",
    component: "InputNumber",
    bottomHelpMessage: "判断结果是“先不说话”后，这几秒内不再重复判断。防止同一个话题反复问 AI。默认 5",
    componentProps: { min: 1, max: 60, placeholder: "5" }
  },
  {
    field: "smartTrigger.gateContextSize",
    label: "判断时看多少条聊天记录",
    component: "InputNumber",
    bottomHelpMessage: "决定要不要插话时，往前翻多少条群聊记录。越多判断越准、越费 token。默认 10",
    componentProps: { min: 5, max: 100, placeholder: "10" }
  },

  // ===== 智能模式 - 强制触发 =====
  { component: "Divider", label: "智能模式：什么情况必回" },
  {
    field: "smartTrigger.inevitableAtReply",
    label: "@它或叫它必回",
    component: "Switch",
    bottomHelpMessage: "消息里@它、或以“哈基米”等前缀开头时，跳过所有判断直接回。关掉后连@也要走概率流程（可能不回）。默认开"
  },
  {
    field: "smartTrigger.mentionedNameReply",
    label: "叫到它名字也必回",
    component: "Switch",
    bottomHelpMessage: "没@、也不带前缀，但消息里出现了它的名字/群名片时，也当作在叫它。默认关（容易误触发）"
  },

  // ===== 智能模式 - 时段化频率 =====
  { component: "Divider", label: "智能模式：按时段调积极性" },
  {
    field: "smartTrigger.enableTalkValueRules",
    label: "启用按时段调节",
    component: "Switch",
    bottomHelpMessage: "不同时段用不同的插话积极性（比如夜里安静点、白天活跃点）"
  },
  {
    field: "smartTrigger.talkValueRules",
    label: "时段规则表",
    component: "GSubForm",
    componentProps: {
      multiple: true,
      modalProps: { title: "时段频率规则" },
      schemas: [
        { field: "range", label: "时段", component: "Input", componentProps: { placeholder: "00:00-08:59" }, required: true },
        { field: "value", label: "插话积极性", component: "InputNumber", componentProps: { min: 0.01, max: 1, step: 0.05 }, required: true }
      ]
    },
    bottomHelpMessage: "每条规则一个时段（HH:MM-HH:MM，支持跨夜如 23:00-06:59），从上往下命中第一条就用它；都不命中就用上面的全局积极性"
  },

  // ===== 智能模式 - 打断保护与拟人化 =====
  { component: "Divider", label: "智能模式：别抢话 & 像真人" },
  {
    field: "smartTrigger.replyDebounceMs",
    label: "打字前等新消息 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "准备回复前先等这一会儿，期间来新消息就重新组织再回，避免抢答。0=立即回",
    componentProps: { min: 0, max: 5000, step: 100, placeholder: "1500" }
  },
  {
    field: "smartTrigger.maxConsecutiveInterrupts",
    label: "最多让步几次",
    component: "InputNumber",
    bottomHelpMessage: "同一群里被新消息连续打断的最大次数，超过后强制把话说完不再让步。0=永远让步（可能一直说不出话）",
    componentProps: { min: 0, max: 10, placeholder: "3" }
  },
  {
    field: "smartTrigger.activeChatTtlHours",
    label: "群状态保留时长 (小时)",
    component: "InputNumber",
    bottomHelpMessage: "群超过这么久没动静就清掉内存里的统计状态，纯内部清理，一般不用动",
    componentProps: { min: 1, max: 168, placeholder: "24" }
  },
  {
    field: "smartTrigger.proactiveReplyNoQuote",
    label: "主动插话不带引用",
    component: "Switch",
    bottomHelpMessage: "它自己主动插话时不带“回复某人”的引用样式，像群友自然接话。被@触发的回复仍正常带引用"
  },
  {
    field: "smartTrigger.typingSpeed",
    label: "打字速度 (字符/秒)",
    component: "InputNumber",
    bottomHelpMessage: "分段回复的间隔快慢。0=自动（约 1 秒起步）；数字越大打得越慢越像真人，建议 8-25",
    componentProps: { min: 0, max: 100, placeholder: "0" }
  },
  {
    field: "smartTrigger.waitToolEnabled",
    label: "允许它“话说一半停顿”",
    component: "Switch",
    bottomHelpMessage: "允许 AI 自己安排“过几秒再接着说”，模拟真人打字中途停顿"
  },

  // ===== 智能模式 - 对话热度阶段 =====
  { component: "Divider", label: "智能模式：热聊保鲜期" },
  {
    field: "smartTrigger.focusDurationMs",
    label: "保鲜期时长 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "它刚说过话后的一段时间（默认 3 分钟），期间每条消息都会认真判断要不要接——热聊时更容易接上话",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.fadingDurationMs",
    label: "余热期时长 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "保鲜期结束后的缓冲段（默认 1.5 分钟），插话门槛放宽一半，慢慢冷下来",
    componentProps: { min: 0, max: 600000, step: 30000, placeholder: "90000" }
  },
  {
    field: "smartTrigger.focusMaxReplies",
    label: "保鲜期内最多说几次",
    component: "InputNumber",
    bottomHelpMessage: "一段保鲜期内它最多主动发言几次，超过就强制进入余热期，防止连刷（默认 4）。被@的回复不算",
    componentProps: { min: 1, max: 10, placeholder: "4" }
  },
  {
    field: "smartTrigger.focusMaxNoAction",
    label: "连续几次不接就冷却",
    component: "InputNumber",
    bottomHelpMessage: "保鲜期内连续几次判断“先不说话”就退出保鲜期（默认 2）",
    componentProps: { min: 1, max: 10, placeholder: "2" }
  },
  {
    field: "smartTrigger.fadingForceGate",
    label: "余热期也每条都判断",
    component: "Switch",
    bottomHelpMessage: "默认关=余热期只放宽门槛（省 AI 调用）；开=余热期每条消息都认真判断，更不容易冷场但更费"
  },

  // ===== 智能模式 - "等 bot 回应"识别 =====
  { component: "Divider", label: "智能模式：接话识别（本地规则，不费 token）" },
  {
    field: "smartTrigger.quickResponseMs",
    label: "秒回窗口 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "它刚说完话，这几秒内任何人接话都直接当作在回应它（人类秒回基本都是在跟它说）。默认 30 秒",
    componentProps: { min: 0, max: 120000, step: 5000, placeholder: "30000" }
  },
  {
    field: "smartTrigger.continuationLookbackMs",
    label: "识别规则生效窗口 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "下面这几条接话识别规则，只在它上次发言后的这个时间窗内生效。默认 3 分钟",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.continuationKeywordMatch",
    label: "提到它说过的词算接话",
    component: "Switch",
    bottomHelpMessage: "消息里出现它上句话的关键词时，当作在接它的话，送去判断"
  },
  {
    field: "smartTrigger.continuationQuestionMatch",
    label: "问句算接话",
    component: "Switch",
    bottomHelpMessage: "消息像问句（带 ? ？，或结尾是“吗/呢/啊/么/嘛”）时，送去判断"
  },
  {
    field: "smartTrigger.continuationFeedbackMatch",
    label: "附和词算接话",
    component: "Switch",
    bottomHelpMessage: "消息以“嗯/对/真的/是吗/好的/我也/那你”等开头时，当作在附和它，送去判断"
  },
  {
    field: "smartTrigger.continuationKeywordMaxCount",
    label: "关键词提取上限",
    component: "InputNumber",
    bottomHelpMessage: "从它上次发言里最多提取几个关键词用于上面的匹配",
    componentProps: { min: 1, max: 20, placeholder: "5" }
  },

  // ===== 智能模式 - 速率硬上限 =====
  { component: "Divider", label: "智能模式：防刷屏硬限制（最终保险）" },
  {
    field: "smartTrigger.maxRepliesPer10Min",
    label: "10 分钟内最多主动说几次",
    component: "InputNumber",
    bottomHelpMessage: "任意 10 分钟内它最多主动插话几次（默认 8）。被@/被叫的必回不受此限。0=不限制",
    componentProps: { min: 0, max: 30, placeholder: "8" }
  },
  {
    field: "smartTrigger.rateLimitCooldownMs",
    label: "超限后安静多久 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "触发上限后强制安静的时间（默认 5 分钟）",
    componentProps: { min: 60000, max: 1800000, step: 60000, placeholder: "300000" }
  },

  // ===== 智能模式 - 冷群主动找话 =====
  { component: "Divider", label: "智能模式：冷场时自己找话" },
  {
    field: "smartTrigger.deferredGateEnabled",
    label: "冷场自言自语开关",
    component: "Switch",
    bottomHelpMessage: "群里冷场时，它隔一阵子自己想一想“要不要说点什么”（比如补一句没说完的话题）。关掉=冷场时绝不出声"
  },
  {
    field: "smartTrigger.minDeferredMs",
    label: "最短间隔 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "两次“自己想一想”之间的最短间隔（默认 2 分钟），防止想得太勤",
    componentProps: { min: 30000, max: 600000, step: 30000, placeholder: "120000" }
  },
  {
    field: "smartTrigger.maxDeferredMs",
    label: "最长间隔 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "兜底上限（默认 15 分钟），防止一直不触发",
    componentProps: { min: 60000, max: 3600000, step: 60000, placeholder: "900000" }
  },

  // ===== 智能模式 - 本地预筛 =====
  { component: "Divider", label: "智能模式：直接跳过的消息（不费 token）" },
  {
    field: "smartTrigger.skipWhenAddressedOther",
    label: "@别人时不判断",
    component: "Switch",
    bottomHelpMessage: "消息@的是别人 → 直接跳过，不浪费 AI 判断。推荐开"
  },
  {
    field: "smartTrigger.skipWhenEmptyText",
    label: "没文字的消息不判断",
    component: "Switch",
    bottomHelpMessage: "纯图片/表情/转账等没有文字的消息直接跳过"
  },

  // ===== 智能模式 - 判断时的提醒线 =====
  { component: "Divider", label: "智能模式：给判断 AI 的提醒线" },
  {
    field: "smartTrigger.promptHintBusyGroupRate",
    label: "群太热闹提醒线",
    component: "InputNumber",
    bottomHelpMessage: "群里 5 分钟消息数超过这条线，判断时会提醒它“群里很热闹，别硬插”。默认 30（正常群达不到）；调低=热闹时更安静",
    componentProps: { min: 1, max: 100, placeholder: "30" }
  },
  {
    field: "smartTrigger.promptHintRateLimitWarn",
    label: "自己话多了提醒线",
    component: "InputNumber",
    bottomHelpMessage: "它 10 分钟内已回超过这么多次，判断时会强烈提醒“别刷屏”（默认 5）",
    componentProps: { min: 1, max: 30, placeholder: "5" }
  },

  // ===== 复读跟读 =====
  { component: "Divider", label: "复读跟读（群里刷复读时跟一条，两种模式都生效）" },
  {
    field: "smartTrigger.repeatJoinEnabled",
    label: "复读跟读总开关",
    component: "Switch",
    bottomHelpMessage: "看到群里好几个人发同一句话，按概率让它也跟发一遍（跟真人凑热闹一样，不改写内容）"
  },
  {
    field: "smartTrigger.repeatDetectionWindow",
    label: "看最近几条",
    component: "InputNumber",
    bottomHelpMessage: "往回看最近 N 条消息判断是不是在复读",
    componentProps: { min: 2, max: 20, placeholder: "5" }
  },
  {
    field: "smartTrigger.repeatMinCount",
    label: "几个人发才算复读",
    component: "InputNumber",
    bottomHelpMessage: "至少 N 个不同的人发了相同内容才算复读（含当前这位）。3 比较准，2 偏松容易误判",
    componentProps: { min: 2, max: 10, placeholder: "3" }
  },
  {
    field: "smartTrigger.repeatJoinProbability",
    label: "跟读概率",
    component: "InputNumber",
    bottomHelpMessage: "确认是复读后，它参与的概率。1=每次都跟，0=从不跟",
    componentProps: { min: 0, max: 1, step: 0.1, placeholder: "0.6" }
  },
  {
    field: "smartTrigger.repeatJoinCooldownMs",
    label: "跟完冷却 (ms)",
    component: "InputNumber",
    bottomHelpMessage: "跟读一次后多久内不再跟，防止同一波复读反复凑热闹（默认 3 分钟）",
    componentProps: { min: 0, max: 3600000, step: 60000, placeholder: "180000" }
  },
  {
    field: "smartTrigger.repeatMaxTextLength",
    label: "最多跟多长的话",
    component: "InputNumber",
    bottomHelpMessage: "超过这个字数的复读不跟，避免跟人家的长篇大论",
    componentProps: { min: 1, max: 200, placeholder: "30" }
  },

  // ===== 对方画像注入 =====
  { component: "Divider", label: "认识聊天对象（两种模式都生效）" },
  {
    field: "personProfileInjection.enabled",
    label: "认识对方功能",
    component: "Switch",
    bottomHelpMessage: "每次回复前自动把对方的昵称/长期印象/最近发言塞给它看，让它更像“认识这个人”"
  },
  {
    field: "personProfileInjection.maxRecentMessages",
    label: "看对方最近几条发言",
    component: "InputNumber",
    componentProps: { min: 0, max: 20, placeholder: "3" }
  }
]
