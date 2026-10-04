// 工具配置条目解析与最终回复形态判断

/**
 * 解析 oneapi_tools 配置条目。条目可带 `(dedupe)` 标记，
 * 例如 `bananaTool(dedupe)`，表示同一用户同一工具上一次调用未完成时跳过新调用。
 */
export function parseToolConfigEntry(entry) {
  const raw = String(entry || "").trim()
  const match = raw.match(/^([A-Za-z_][A-Za-z0-9_-]*)(?:\(([^)]*)\))?$/)
  if (!match) return { name: raw, dedupe: false, marker: "" }
  return {
    name: match[1],
    dedupe: match[2] !== undefined,
    marker: match[2] || ""
  }
}

export function toolConfigHasName(toolNames, name) {
  return Array.isArray(toolNames) && toolNames.some(item => parseToolConfigEntry(item).name === name)
}

const AGENT_READ_TOOLS = new Set(['searchInformationTool', 'googleImageAnalysisTool', 'videoAnalysisTool', 'memberInfoTool', 'githubRepoTool', 'searchVideoTool', 'chatHistoryTool'])
const AGENT_LIGHT_TOOLS = new Set(['pokeTool', 'sendLocalEmojiTool', 'reactionTool'])
const AGENT_INTENTS = {
  videoAnalysisTool: /(?:分析|识别|理解|解析|看|总结).{0,12}视频|视频.{0,12}(?:分析|解析)|(?:不要|别|不用).{0,8}分析/,
  googleImageAnalysisTool: /(?:分析|识别|理解|解析|看).{0,12}(?:图片|图像|头像|图)|(?:不要|别|不用).{0,8}分析/,
  searchInformationTool: /(?:搜索|查找|检索|查资料|搜一下)/,
  voiceTool: /(?:发(?:个|条|一段)?语音|用语音(?:说|回答|回复)|朗读|念(?:一下|一遍|出来)|想听.{0,8}(?:你|机器人).{0,4}声音)/i,
  jinyanTool: /(?:禁言|解禁|解除禁言|取消禁言)/,
  changeCardTool: /(?:(?:改|修改|更改|换).{0,8}(?:名片|名称|名字|昵称))|(?:改名)/,
  sendGiftTool: /(?:送|发).{0,8}礼物/,
  recallTool: /(?:撤回|删除).{0,8}(?:消息|发言)/,
  reminderTool: /(?:提醒|定时|闹钟)/,
  qqZoneTool: /(?:发|发布|删除|删).{0,8}(?:说说|空间)/,
  searchMusicTool: /(?:想听|播放|放|来|分享|推荐).{0,12}(?:歌|音乐|一首)/,
  bingImageSearchTool: /(?:搜|找|发|看|来).{0,10}(?:图片|照片|壁纸|图)/,
  emojiSearchTool: /(?:搜|找|发|来).{0,8}(?:表情|贴图)/,
  bananaTool: /(?:画|绘制|生成|做).{0,12}(?:图|画|照片)|(?:画一个|画一张)/,
  googleImageEditTool: /(?:改|编辑|修改|处理|换).{0,12}(?:头像|图片|图|照片)|头像编辑/,
  aiMindMapTool: /(?:做|画|生成|整理).{0,12}(?:导图|思维导图)|^(?:导图|思维导图)(?:$|[：:\s])/,
  textImageTool: /(?:转|生成|做).{0,10}(?:文字图片|文本图片|长图)|(?:文字|代码|markdown).{0,8}(?:转图|截图)/i,
  webParserTool: /(?:解析|打开|读取|看看|看下).{0,12}(?:网页|页面|链接|https?:)/i,
  grabRedBagTool: /(?:抢|领取|拿).{0,8}红包/,
  pokeTool: /(?:戳|poke)/i,
  sendLocalEmojiTool: /(?:发|来|给).{0,8}(?:表情|贴图)/,
  reactionTool: /(?:贴|加|回应).{0,8}表情/
}

export function agentToolCategory(name, config = {}) {
  const override = config.promptCache?.agentToolPolicies?.[name]?.category
  if (!Object.hasOwn(AGENT_INTENTS, name) && !AGENT_READ_TOOLS.has(name) && !AGENT_LIGHT_TOOLS.has(name) && name !== 'waitTool' &&
    ['read', 'light', 'effect', 'manage', 'wait'].includes(override)) return override
  if (AGENT_READ_TOOLS.has(name)) return 'read'
  if (AGENT_LIGHT_TOOLS.has(name)) return 'light'
  if (name === 'jinyanTool') return 'manage'
  if (name === 'waitTool') return 'wait'
  return 'effect'
}

const NEGATED_INTENT = /(?:不要|别(?!人|的|处)|不用|不必|禁止|无需|先不|暂不|不许|不想|不需要|没让你|没有要求|不允许|不准|do\s+not|don't)/i
const DEFERRED_INTENT = /(?:\d+|[一二三四五六七八九十百]+)\s*(?:秒|分钟|小时|天)\s*(?:以?后)|明天|后天|明晚|下周|下个月/

function intentClauses(e) {
  // Quoted/forwarded commands are data, not current-user authorization.
  return String(e.msg || e.raw_message || '')
    .replace(/^#tool\s*/i, '')
    .replace(/^\s*>.*$/gm, '')
    .replace(/"[^"\n]*"|'[^'\n]*'|“[^”]*”|「[^」]*」|\[[^\]]*\]/g, '')
    .split(/[。！？!?；;，,\n]|但是|不过|而是/)
    .filter(clause => !/(?:他|她|群友|有人).{0,8}(?:说|提到|要求)[：:]/.test(clause))
    .filter(clause => !/(?:已经|刚才|上次|之前|有没有|是否).{0,20}(?:语音|禁言|改名|送礼)|(?:了吗|过吗|是什么意思|怎么使用|会.*吗|能.*吗)/.test(clause))
}

export function agentIntentText(e = {}) { return intentClauses(e).filter(clause => !NEGATED_INTENT.test(clause)).join('。') }

export function agentToolDenied(e, name) {
  return intentClauses(e).some(clause => NEGATED_INTENT.test(clause) && (AGENT_INTENTS[name]?.test(clause) || clause.includes(name)))
}

export function hasAgentToolIntent(e, name) {
  return !agentToolDenied(e, name) && intentClauses(e).some(clause => !NEGATED_INTENT.test(clause) &&
    (name === 'reminderTool' || !DEFERRED_INTENT.test(clause)) && AGENT_INTENTS[name]?.test(clause))
}

export function buildAgentControls({ e, tools, allowedTools, requiredTools = [], trustedRequiredTools = [], config, senderRole = 'member', botId }) {
  const policy = config.promptCache?.agentSideEffectPolicy ?? 'contextual'
  if (!['contextual', 'legacy', 'explicit'].includes(policy)) throw new Error('invalid_agent_action_policy')
  const text = agentIntentText(e)
  const categories = {}
  const explicitTools = []
  const permitted = []
  const candidates = new Set(allowedTools)
  for (const tool of tools) {
    const name = tool.function.name
    const category = agentToolCategory(name, config)
    categories[name] = category
    if (!candidates.has(name)) continue
    const hints = config.promptCache?.agentToolPolicies?.[name]?.intentKeywords
    const configuredIntent = Array.isArray(hints) && hints.some(hint => typeof hint === 'string' && hint && text.includes(hint))
    const namedIntent = text.includes(name) && /(?:调用|使用|运行|执行|use|run)/i.test(text)
    const denied = agentToolDenied(e, name)
    const explicit = !denied && (trustedRequiredTools.includes(name) || hasAgentToolIntent(e, name) || configuredIntent || namedIntent)
    if (denied) continue
    if (explicit) explicitTools.push(name)
    if (policy !== 'legacy' && (category === 'manage' || name === 'jinyanTool') && !['admin', 'owner'].includes(senderRole)) continue
    if (policy === 'legacy' || category === 'read' || category === 'wait' || explicit || (policy === 'contextual' && category === 'light')) permitted.push(name)
  }
  return { policy, allowedTools: permitted, requiredTools: requiredTools.filter(name => permitted.includes(name)), explicitTools,
    categories, senderRole, userId: String(e.user_id), botId: String(botId), userName: e.sender?.card || e.sender?.nickname || '' }
}

export function agentCallPolicyError(controls, name, params, autonomousUsed = 0) {
  if (!controls.allowedTools.includes(name)) return 'error: current turn does not authorize this action'
  const category = controls.categories[name] || 'effect'
  const explicit = controls.explicitTools.includes(name)
  if (controls.policy !== 'legacy' && category === 'light' && !explicit &&
    (autonomousUsed >= 1 || params.random === true || Number(params.count ?? params.times ?? params.num ?? 1) > 1 ||
      (Array.isArray(params.target) && params.target.length > 1))) return 'error: autonomous interaction limit reached'
  if (controls.policy !== 'legacy' && name === 'changeCardTool' && !['admin', 'owner'].includes(controls.senderRole)) {
    const targets = new Set([controls.userId, controls.botId, controls.userName, '我', '自己', '你', '机器人'])
    if (!targets.has(String(params.target))) return 'error: changing another member card requires administrator permission'
  }
  if (controls.policy !== 'legacy' && (category === 'manage' || name === 'jinyanTool') && !['admin', 'owner'].includes(controls.senderRole)) return 'error: administrator permission required'
  return null
}

/**
 * 用户消息是否在明确要求生成代码 / Markdown
 */
export function isCodeOrMarkdownRequest(text = "") {
  const content = String(text || "").toLowerCase()
  return /写.*(代码|算法|函数|脚本|程序|markdown|md|文档)|给.*(代码|示例代码|算法|markdown|md文档)|实现.*(算法|函数|代码|脚本|程序)|生成.*(代码|markdown|md文档|文档)|编写.*(代码|markdown|md|文档)|代码给我|md文档|markdown文档|代码截图/.test(content)
}

/**
 * 文本内容看起来像代码或 Markdown（用于决定最终回复是否转图发送）
 */
export function looksLikeCodeOrMarkdown(text = "") {
  const content = String(text || "")
  if (/```[\s\S]*```/.test(content)) return true
  if (/^\s{0,3}#{1,4}\s+\S/m.test(content) && content.split(/\r?\n/).length >= 3) return true
  if (/^\s*\|.+\|\s*$/m.test(content) && /^\s*\|[-:\s|]+\|\s*$/m.test(content)) return true

  const lines = content.split(/\r?\n/)
  const nonEmptyLines = lines.filter(line => line.trim())
  if (nonEmptyLines.length < 3) return false

  const codeLineCount = nonEmptyLines.filter(line =>
    /^\s*(def|class|for|if|elif|else|while|return|import|from|print|break|continue|const|let|var|function|class|export|switch|try|catch|public|private|static|package|func|fn)\b/.test(line) ||
    /^\s{2,}\S/.test(line) ||
    /[A-Za-z_$][\w$.\[\]]*\s*(?:=|==|===|>|<|\+|-|\*|\/)/.test(line) ||
    /[{}();]/.test(line)
  ).length

  return codeLineCount >= 2
}
