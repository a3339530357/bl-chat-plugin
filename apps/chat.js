import { checkPendingReminders } from "../functions/functions_tools/ReminderTool.js"
import { TakeImages } from "../utils/fileUtils.js"
import { mcpManager } from "../utils/MCPClient.js"
import { pluginBridge } from "../utils/pluginBridge.js"
import { scanRedisKeys, deleteRedisKeys } from "../utils/redisScan.js"
import { personProfileInjector } from "../utils/PersonProfileInjector.js"
import fs from "fs"
import path from "path"
import { randomUUID } from "crypto"
import schedule from 'node-schedule'
import { parseToolConfigEntry, buildAgentControls, hasAgentToolIntent, agentToolDenied } from "../core/toolConfig.js"
import { buildChatSystemPrompt, buildPromptCacheHeaders, buildAgentPromptCacheHeaders } from "../core/prompts.js"
import { isPromptCacheEnabled, promptCacheMode, agentConfigurationError, botIdForEvent, wireClone, freezeWire, replayEventRow, cacheDiagnostic } from '../core/promptCache.js'
import { contextStore } from '../core/contextStore.js'
import { bindCacheRequest } from '../core/cacheTurn.js'
import { getV2MessageManager } from '../utils/MessageManager.js'
import { initializeSharedState, getSharedState, refreshLocalTools, applyToolRegistrySnapshot } from "../core/sharedState.js"
import { configManagerMethods } from "../core/configManager.js"
import { taskStatusMethods } from "../core/taskStatus.js"
import { toolHistoryMethods } from "../core/toolHistory.js"
import { tryAutoGrabRedBag } from "../core/redBag.js"
import { messageBuilderMethods, roleMap, shortTimeOf, roleTagOf, extractParticipants, formatParticipants, displayNameFor } from "../core/messageBuilder.js"
import { conversationTrackerMethods, activeConversations, trackingThrottle } from "../core/conversationTracker.js"
import { replySenderMethods } from "../core/replySender.js"
import { toolExecutorMethods } from "../core/toolExecutor.js"
import { sessionHistoryMethods } from "../core/sessionHistory.js"
import { mcpLifecycleMethods, startMcpInit } from "../core/mcpLifecycle.js"
import { agentLoopMethods } from '../core/agentLoop.js'
import { resolveAgentRoute } from '../utils/apiClient.js'

const _path = process.cwd()


// 群级并发计数：groupId -> 处理中的对话数。达到 concurrentLimit 时新消息直接不触发（不排队）。
// 必须放模块级：Yunzai 每条消息都会 new 一个插件实例，实例属性跨消息不共享。
const activeGroupChatCounts = new Map()

let pluginInitialized = false

export class ChatPlugin extends plugin {
  constructor() {
    super({
      name: "全局方案-test",
      dsc: "全局方案测试版",
      event: "message",
      priority: 9999,
      rule: [
        { reg: "^#tool\\s*(.*)", fnc: "handleTool" },
        { reg: "[\\s\\S]*", fnc: "handleRandomReply", log: false }
      ]
    })

    // 配置发生全量重载（首启/mtime 变化/chokidar 丢事件后的兜底）时刷新共享子系统，
    // 否则直接复用进程级单例（Yunzai 每条消息都会实例化本类）
    const configReloaded = this.initConfig()
    const state = (!configReloaded && getSharedState()) || initializeSharedState(this.config)

    this.messageManager = state.messageManager
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.sessionMap = state.sessionMap
    this.emotionManager = state.emotionManager
    this.memoryManager = state.memoryManager
    this.expressionLearner = state.expressionLearner
    this.knowledgeSearcher = state.knowledgeSearcher
    this.REDIS_KEY_PREFIX = 'ytbot:messages:'
    this.TASK_STATUS_PREFIX = 'ytbot:tool_task_status:'
    this.dedupeToolNames = new Set()

    this.localToolsReady = false
    this.tools = []
    this.initMessageHistory()
    mcpManager.setToolsChangedCallback(() => this.updateToolsList())
    // 不加 force：注册器内部有 5s 节流 + 并发去重，首次启动时会与 sharedState 的强制加载合并；
    // 之前每条消息都强制重扫 custom_tools 目录，纯属浪费
    this.localToolsReadyPromise = this.refreshLocalToolRegistry({ silent: true }).catch(error => {
      logger.error("[LocalToolRegistry] 启动加载本地工具失败:", error)
      this.localToolsReady = true
      this.initTools()
      return null
    })

    if (!pluginInitialized) {
      pluginInitialized = true
      startMcpInit(this)
      this.initScheduledTasks()
      this.startActiveChatLruScanner()
    }

    pluginBridge.instance = this
  }

  async refreshLocalToolRegistry(options = {}) {
    const state = await refreshLocalTools(getSharedState(), options)
    this.toolInstances = state.toolInstances
    this.functions = state.functions
    this.functionMap = state.functionMap
    this.localToolsReady = true
    this.updateToolsList({ silent: options.silent === true })
    return state
  }

  initTools() {
    const sharedState = getSharedState()
    applyToolRegistrySnapshot(sharedState)
    this.toolInstances = sharedState.toolInstances
    this.functions = sharedState.functions
    this.functionMap = sharedState.functionMap

    const provider = this.config.providers.toLowerCase()
    const toolConfig = {
      oneapi: this.config.oneapi_tools
    }

    this.syncDedupeToolConfig(this.config.oneapi_tools || [])
    const localTools = this.getToolsByName(toolConfig[provider] || this.config.openai_tools, {
      warnMissing: this.localToolsReady !== false
    })
    const mcpTools = mcpManager.getAllTools() || []
    this.tools = [...localTools, ...mcpTools]
  }

  initMessageHistory() {
    this.messageHistoriesRedisKey = "group_user_message_history"
    this.messageHistoriesDir = path.join(process.cwd(), "data/AItools/user_history")
    this.MAX_HISTORY = this.config.groupMaxMessages || 100

    // 目录只需保证一次；pluginInitialized 在首个实例构造完成后置 true
    if (!pluginInitialized && !fs.existsSync(this.messageHistoriesDir)) {
      fs.mkdirSync(this.messageHistoriesDir, { recursive: true })
    }
  }

  initScheduledTasks() {
    schedule.scheduleJob({ rule: '0 0 * * *', tz: 'Asia/Shanghai' }, async () => {
      if (!getSharedState()?.config?.promptCache?.enabled) return
      await this.cleanupPromptCacheHistory().catch(error => logger.error('[PromptCacheV2] daily cleanup failed:', error))
    })
    // 每天0点清理消息历史记录
    schedule.scheduleJob('0 0 * * *', async () => {
      try {
        logger.info('开始执行消息历史记录清理定时任务')
        await this.clearAllMessages()
        logger.info('消息历史记录清理完成')
      } catch (error) {
        logger.error(`定时清理消息历史记录失败: ${error}`)
      }
    })

    // 每秒检查待触发的提醒
    schedule.scheduleJob('* * * * * *', async () => {
      try {
        await checkPendingReminders(this.toolInstances)
      } catch (error) {
        logger.error(`[定时提醒] 检查失败: ${error}`)
      }
    })

    logger.info('[定时任务] 提醒检查任务已启动（每秒）')
  }

  /**
   * 外部插件主动触发：注入 intent 到群历史 + 强制下一轮 Gate continue
   * @param {string|number} groupId
   * @param {string} intent 主动想说的话题/意图
   * @param {object} opts { source: '插件名', anchorE: 可选锚点 e }
   */
  async enqueueProactiveTask(groupId, intent, opts = {}) {
    if (!groupId || !intent) return { ok: false, error: 'missing_params' }
    const anchor = opts.anchorE
    if (!anchor) {
      logger.warn(`[Proactive] group=${groupId} 缺少锚点 e，无法触发；intent="${String(intent).slice(0, 40)}"`)
      return { ok: false, error: 'missing_anchor' }
    }
    if (String(anchor.group_id) !== String(groupId)) {
      logger.warn(`[Proactive] anchor.group_id(${anchor.group_id}) 与传入 groupId(${groupId}) 不匹配，拒绝触发`)
      return { ok: false, error: 'anchor_group_mismatch' }
    }
    if (!this.checkGroupPermission(anchor)) {
      return { ok: false, error: 'not_whitelisted' }
    }
    if (await this.isMutedInGroup(anchor)) {
      return { ok: false, error: 'muted' }
    }

    logger.info(`[Proactive] group=${groupId} source=${opts.source || 'unknown'} intent="${String(intent).slice(0, 40)}"`)
    try {
      const wrapped = Object.create(anchor)
      wrapped.msg = `[系统主动触发 来自 ${opts.source || '插件'}] ${intent}`
      wrapped._smartOriginKey = `${groupId}:proactive:${randomUUID()}`
      const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
      if (mode === 'smart') {
        const state = this.getSmartState(groupId)
        state.forceContinue = true
        wrapped._proactiveReply = true
        setImmediate(() => this.handleRandomReplySmart(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      } else {
        // strict 模式没有 Gate，直接走 handleTool（绕过 @/前缀破冰）
        setImmediate(() => this.handleTool(wrapped).catch(err => logger.error('[Proactive] 处理失败:', err)))
      }
      return { ok: true }
    } catch (err) {
      return { ok: false, error: err.message }
    }
  }

  // 保留实例方法签名（pluginBridge 对外暴露本实例），实现委托给 utils/redisScan.js 共享版
  async scanRedisKeys(pattern) {
    return scanRedisKeys(pattern, "Redis")
  }

  async deleteRedisKeys(keys = []) {
    return deleteRedisKeys(keys)
  }

  async clearAllMessages() {
    const keys = await this.scanRedisKeys(`${this.REDIS_KEY_PREFIX}*`)
    if (keys?.length) {
      await this.deleteRedisKeys(keys)
      logger.info(`已清除${keys.length}条消息历史记录`)
    }
    if (this.config.promptCache?.enabled) await this.cleanupPromptCacheHistory()
  }

  async beginConversationTask(e) {
    const groupId = e.group_id
    const userId = e.user_id
    if (!groupId || !userId) return { groupId, userId, messageId: e.message_id || null }

    const task = {
      groupId,
      userId,
      messageId: e.message_id || null,
      startedAt: Date.now()
    }

    if (task.messageId) {
      await this.saveTaskStatus({
        groupId,
        userId,
        messageId: task.messageId,
        status: "processing"
      })
    }

    return task
  }

  async finishConversationTask(task, session) {
    if (!task?.groupId || !task?.userId) return

    if (!task.messageId || session?.taskDedupeToolTouched) return

    const status = await this.getTaskStatus(task.groupId, task.messageId)
    if (!status || status.status === "processing") {
      await this.clearTaskStatus(task.groupId, task.messageId)
    }
  }

  /**
   * 群对话并发是否已达上限（concurrentLimit）。
   * 供 handleTool 之前的路径（会话追踪判定 / smart Gate）提前让步，
   * 避免先消耗一次判定 API、最后又被 handleTool 的并发检查丢弃。
   */
  isGroupChatAtCapacity(groupId) {
    if (!groupId) return false
    const { active, limit } = this.getGroupChatConcurrency(groupId)
    return active >= limit
  }

  /**
   * 取群当前并发占用情况，供日志统一输出。
   */
  getGroupChatConcurrency(groupId) {
    const limit = Math.max(1, Number(this.config.concurrentLimit) || 5)
    return { active: activeGroupChatCounts.get(groupId) || 0, limit }
  }

  getToolsByName(toolNames, options = {}) {
    if (!toolNames || !Array.isArray(toolNames)) return []
    const warnMissing = options.warnMissing !== false

    return toolNames
      .map(item => {
        const { name } = parseToolConfigEntry(item)
        if (name === 'sendLocalEmojiTool' && !this.config?.emojiSystem?.enabled) {
          return null
        }
        if (name === 'waitTool') {
          const mode = String(this.config?.chatTriggerMode || 'strict').toLowerCase()
          if (mode !== 'smart' || !this.config?.smartTrigger?.waitToolEnabled) return null
        }
        const func = this.functionMap.get(name)
        if (!func) {
          if (warnMissing) logger.warn(`未找到工具 "${name}"`)
          return null
        }
        return {
          type: "function",
          function: {
            name: func.name,
            description: func.description,
            parameters: {
              type: "object",
              properties: func.parameters.properties,
              required: func.parameters.required || []
            }
          }
        }
      })
      .filter(Boolean)
  }

  getToolsDescriptionString() {
    if (!this.tools?.length) return "当前没有可用的工具。"

    const localDesc = this.tools
      ?.filter(t => !mcpManager.isMCPTool(t.function?.name))
      .map(t => `${t.function.name}: ${t.function.description}`)
      .join("\n") || ""

    const mcpDesc = mcpManager.getToolsDescription ? mcpManager.getToolsDescription() : ""

    const parts = []
    if (localDesc) parts.push("【本地工具】\n" + localDesc)
    if (mcpDesc) parts.push("【MCP工具】\n" + mcpDesc)

    return parts.length ? parts.join("\n\n") : "当前没有可用的工具。"
  }

  checkGroupPermission(e) {
    if (!this.config.enableGroupWhitelist) return true
    return this.config.allowedGroups.some(id => String(id) === String(e.group_id))
  }

  getProvider() {
    return this.config?.providers?.toLowerCase()
  }

  getModel() {
    const models = {
      oneapi: this.config.chatAiConfig.chatApiModel
    }
    return models[this.getProvider()]
  }

  buildRequestData(messages, tools, toolChoice = "auto", cacheTurn = null) {
    const config = cacheTurn?.apiConfig || this.config
    const data = {
      model: cacheTurn ? config.chatAiConfig.chatApiModel : this.getModel(),
      messages,
      // 最终聊天偏自然表达；工具决策会在 YTapi 中单独降温。
      temperature: 0.85,
      top_p: 0.95
    }

    if (cacheTurn?.mode === 'agent') {
      data.model = cacheTurn.route?.model || config.chatAiConfig.chatApiModel
      data.temperature = cacheTurn.settings.agentTemperature
      data.top_p = cacheTurn.settings.agentTopP
      if (config.useTools && cacheTurn.header.tools.length) {
        data.tools = cacheTurn.header.tools
        data.tool_choice = 'auto'
      }
      return bindCacheRequest(data, cacheTurn)
    }

    if (config.useTools && tools?.length && (toolChoice !== "none" || cacheTurn)) {
      data.tools = tools
      data.tool_choice = toolChoice
    }
    return bindCacheRequest(data, cacheTurn)
  }

  checkTriggers(e) {
    try {
      const hasMessage = e.msg && typeof e.msg === "string" &&
        this.config.triggerPrefixes.some(p => p && e.msg.toLowerCase().includes(p.toLowerCase()))

      // 用 e.self_id / e.bot.uin（收到消息的账号）做 @ 检测；
      // TRSS 多账号下 Bot.uin 是数组，`qq == Bot.uin` 永远不成立会导致 @bot 检测失效
      const selfId = e?.self_id ?? e?.bot?.uin ?? (typeof Bot !== "undefined" ? Bot.uin : "")
      const hasAt = Array.isArray(e.message) &&
        e.message.some(msg => msg?.type == "at" && String(msg?.qq) === String(selfId))

      return hasMessage || hasAt
    } catch {
      return false
    }
  }

  isCommand(e) {
    return e.msg?.startsWith("#")
  }

  async handleRandomReply(e) {
    if (!this.config.enabled || !this.checkGroupPermission(e) || this.isCommand(e) || !e.group_id) {
      return false
    }

    const messageTypes = e.message?.map(m => m.type) || []
    if (this.config.excludeMessageTypes.some(t => messageTypes.includes(t))) return false

    // 禁言检测：bot 在该群被禁言（个人/全员）时不触发任何回复，避免发送失败 + 表情/red 包等也无意义
    if (await this.isMutedInGroup(e)) return false

    // 静默收集消息用于表达学习（不管是否触发AI对话）
    if (this.config.expressionLearning?.enabled && e.msg) {
      this.expressionLearner.updateGroupExpressions(e.group_id, e.msg).catch(() => {})
    }

    // 检测红包消息并随机触发抢红包（两种模式都生效）
    const redBagResult = await tryAutoGrabRedBag(e, this)
    if (redBagResult) return redBagResult.value

    // smart 模式分发
    const triggerMode = String(this.config.chatTriggerMode || 'strict').toLowerCase()
    if (triggerMode === 'smart') {
      return await this.handleRandomReplySmart(e)
    }


    const hasTrigger = await this.checkTriggers(e)

    // 会话追踪逻辑
    const conversationKey = `${e.group_id}_${e.user_id}`
    const activeConv = activeConversations.get(conversationKey)

    // 如果明确触发（@或前缀），直接触发并更新追踪
    if (hasTrigger) {
      if (this.config.conversationTrackingEnabled) {
        this.setTrackingWithTimer(conversationKey)
      }
      return await this.handleTool(e)
    }

    // 群复读跟读（复读功能两种模式都生效，配置沿用 smartTrigger.repeat*）：
    // 先收集消息进检测窗口，非 @/前缀触发时命中复读潮就直接跟发原文
    this.collectRepeatMessage(e)
    if (await this.tryJoinGroupRepeat(e)) {
      return true
    }

    // 在追踪期内，判断是否在继续对话
    if (this.config.conversationTrackingEnabled && activeConv) {
      // 群并发已满时提前让步，避免白白消耗一次"是否在跟 bot 对话"的判定 API
      if (this.isGroupChatAtCapacity(e.group_id)) {
        const { active, limit } = this.getGroupChatConcurrency(e.group_id)
        logger.info(`[并发限制][strict-追踪] 群${e.group_id} 已有 ${active}/${limit} 条对话在处理，跳过本次接续判定（非API异常，现有对话处理完后下条消息自动恢复）。msg="${String(e.msg || '').slice(0, 30)}"`)
        return false
      }
      // 节流检查
      const throttleKey = conversationKey
      const lastCallTime = trackingThrottle.get(throttleKey) || 0
      const throttleInterval = (this.config.conversationTrackingThrottle || 3) * 1000

      if (Date.now() - lastCallTime < throttleInterval) {
        // 节流期内，直接返回不触发
        return false
      }

      // 更新节流时间
      trackingThrottle.set(throttleKey, Date.now())

      // 登记本条消息序号（须在节流/并发过滤之后：被丢弃的消息若也刷新序号，
      // 前一条的去抖会让位给一条永远不会进判断流程的消息，导致回复丢失——已踩坑修复）
      const arrivalSeq = this.markTrackingArrival(conversationKey)

      // 构建完整格式的用户消息
      const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
      const userMessageFormatted = `${this.formatTime()} ${senderName}: ${e.msg || ''}`

      // 使用批量判断队列
      const isTalking = await this.addToBatchJudgment(conversationKey, userMessageFormatted, activeConv.chatHistory || [], e)

      if (isTalking) {
        // 回复去抖：用户还在连发时让步，只由最后一条触发一次回复（handleTool 自带群历史，能看到连发的全部消息）
        if (!(await this.applyTrackingReplyDebounce(conversationKey, arrivalSeq))) {
          return false
        }
        // 去抖等待期间并发可能被占满，重新检查一次
        if (this.isGroupChatAtCapacity(e.group_id)) {
          const { active, limit } = this.getGroupChatConcurrency(e.group_id)
          logger.info(`[并发限制][strict-追踪] 群${e.group_id} 去抖后并发已满 ${active}/${limit}，跳过本条`)
          return false
        }
        // 重置定时器
        this.setTrackingWithTimer(conversationKey)
        return await this.handleTool(e)
      }
      // 判断不是在跟机器人对话，直接返回不触发
      return false
    }

    // 未在追踪期内，不触发
    return false
  }

  async handleTool(e) {
    if (!this.config.enabled || !e.group_id) {
      if (!e.group_id) await e.reply("该命令只能在群聊中使用。")
      return false
    }

    // 群级并发上限（concurrentLimit）：同群达到上限时，新消息直接不触发（不排队）
    const concurrentLimit = Math.max(1, Number(this.config.concurrentLimit) || 5)
    const activeChats = activeGroupChatCounts.get(e.group_id) || 0
    if (activeChats >= concurrentLimit) {
      logger.info(`[并发限制][handleTool] 群${e.group_id} 已有 ${activeChats}/${concurrentLimit} 条对话在处理，本条消息不触发对话（非API异常，现有对话处理完后下条消息自动恢复）。msg="${String(e.msg || '').slice(0, 30)}"`)
      return false
    }
    activeGroupChatCounts.set(e.group_id, activeChats + 1)
    try { e._conversationProducedOutput = false } catch {}

    try {
      if (this.localToolsReadyPromise) await this.localToolsReadyPromise
      await this.refreshLocalToolRegistry({ silent: true })
      await this.waitForMCPReady()

      const taskContext = await this.beginConversationTask(e)
      const handleToolStartAt = Date.now()

      const { group_id: groupId, user_id: userId, msg } = e
      const sessionId = randomUUID()
      e.sessionId = sessionId
      const session = this.getOrCreateSession(sessionId, this.tools)
      session.taskContext = taskContext
      session.turnId = sessionId
      const useCacheV2 = isPromptCacheEnabled(this.config, groupId)
      const cacheMode = promptCacheMode(this.config, groupId)
      const cacheConfig = useCacheV2 ? wireClone(this.config) : null
      const cacheStore = this.contextStore || contextStore
      const cacheScope = useCacheV2 ? cacheStore.scope(botIdForEvent(e), groupId) : null
      cacheScope?.catch(() => {})

      // smart 模式下记录本轮默认只覆盖到自身事件；读取群历史快照后会提升到当时的
      // groupContextVersion，供 smart Gate 判断排队的 @/新消息是否已经被本轮回复覆盖。
      if (String(this.config.chatTriggerMode || 'strict').toLowerCase() === 'smart') {
        try { e._smartHistoryContextVersion = Number(e?._smartContextVersion) || 0 } catch {}
      }

      let groupUserMessages = session.groupUserMessages

      try {
        const configurationError = agentConfigurationError(this.config, groupId)
        if (configurationError) {
          cacheDiagnostic(this.config, 'agent_config_error', { groupId, reason: configurationError })
          logger.error(`[单阶段配置] ${configurationError}，本轮未发送模型请求或执行工具`)
          this.clearSession(sessionId)
          return true
        }
        const args = msg?.replace(/^#tool\s*/, "").trim() || ""
        // 同 checkTriggers：TRSS 多账号下 Bot.uin 是数组，须用 e.self_id 做字符串比较，
        // 否则 bot 自己的 @ 会漏进 atQq
        const selfIdForAt = e?.self_id ?? e?.bot?.uin ?? Bot.uin
        const atQq = e.message.filter(m => m.type === "at" && String(m.qq) !== String(selfIdForAt)).map(m => m.qq)
        const images = await TakeImages(e)

        let videos = []
        if (e.getReply) {
          const rsp = await e.getReply()
          videos = rsp?.message?.filter(m => m.type === "video") || []
        }

        const memberInfo = await (async () => {
          try {
            return await e.bot.pickGroup(groupId).pickMember(e.sender.user_id).info
          } catch { return {} }
        })()
        const senderRole = roleMap[e.sender?.role] || roleMap[memberInfo?.role] || "member"

        const userContent = await this.buildMessageContent(e.sender, args, images, atQq, e.group, e)

        const getHighLevelMembers = async group => {
          if (!group) return ""
          const members = await group.getMemberMap()
          return Array.from(members.values())
            .filter(m => ["admin", "owner"].includes(m.role))
            .sort((a, b) => useCacheV2 ? String(a.user_id).localeCompare(String(b.user_id), 'en', { numeric: true }) : 0)
            .map(m => `${m.nickname}(${m.user_id})${m.role === 'admin' ? '[管理]' : '[群主]'}`)
            .join("\n")
        }

        const mcpPrompts = mcpManager.getMCPSystemPrompts({
          messageType: e.message_type,
          groupId: e.group_id,
          message: e.msg
        })

        // 情感/记忆/表达学习/知识库/画像/群上下文 这几个 prompt 互相独立，并行构建。
        // 原来是逐个 await 串行，多个含 embedding/RPC 的慢调用会累加，是 @ 回复慢的主因之一。
        const [
          emotionPrompt,
          memoryPrompt,
          groupMemoryPrompt,
          expressionPrompt,
          knowledgePrompt,
          personProfilePrompt,
          groupContext
        ] = await Promise.all([
          this.config.emotionSystem?.enabled
            ? this.emotionManager.getEmotionPromptForGroup(groupId).catch(err => { logger.error(`[情感] 获取失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.memorySystem?.enabled
            ? this.memoryManager.getMemoryPromptForUser(groupId, userId, e.msg || "").catch(err => { logger.error(`[记忆] 用户检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.memorySystem?.enabled && groupId
            ? this.memoryManager.getGroupMemoryPrompt(groupId, e.msg || "").catch(err => { logger.error(`[记忆] 群检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.config.expressionLearning?.enabled
            ? this.expressionLearner.getExpressionPromptForGroup(groupId).catch(err => { logger.error(`[表达学习] 获取失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          (this.knowledgeSearcher && e.msg)
            ? this.knowledgeSearcher.search(e.msg)
                .then(result => result?.knowledgeContext
                  ? `【知识库参考】\n以下是与当前话题相关的参考知识，请在回复时自然融入（不要生硬引用）：\n${result.knowledgeContext}`
                  : '')
                .catch(err => { logger.error(`[知识库] 检索失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          (this.config.personProfileInjection?.enabled && groupId && userId)
            ? personProfileInjector.build(groupId, userId, e, { parts: useCacheV2 }).catch(err => { logger.error(`[画像注入] 失败: ${err.message}`); return '' })
            : Promise.resolve(''),
          this.getCurrentGroupContext(e).catch(err => { logger.error(`[群上下文] 获取失败: ${err.message}`); return { groupId: String(groupId || ''), groupName: '', groupNotice: '' } })
        ])

        // 构建增强系统提示
        const enhancedPrompts = [emotionPrompt, memoryPrompt, groupMemoryPrompt, expressionPrompt, knowledgePrompt, personProfilePrompt?.full ?? personProfilePrompt].filter(Boolean).join('\n')
        const toolHistoryPrompt = await this.getToolHistoryPromptForGroup(groupId)

        // 获取机器人在当前群的真实身份信息(群名片可能被 changeCardTool 改过)
        let botCardInGroup = Bot.nickname || "机器人"
        let botRoleInGroup = "member"
        let botIdentityReliable = false

        try {
          const botMemberInfo = await e.group?.pickMember?.(useCacheV2 ? botIdForEvent(e) : Bot.uin)?.getInfo?.()
          logger.debug(`[身份信息] Bot.uin=${Bot.uin}, botMemberInfo=`, JSON.stringify(botMemberInfo))

          if (botMemberInfo) {
            botIdentityReliable = !!((botMemberInfo.card && botMemberInfo.card.trim()) || botMemberInfo.nickname) && !!roleMap[botMemberInfo.role]
            botCardInGroup = (botMemberInfo.card && botMemberInfo.card.trim()) || botMemberInfo.nickname || Bot.nickname || "机器人"
            botRoleInGroup = roleMap[botMemberInfo.role] || "member"
          }
        } catch (err) {
          logger.warn(`[身份信息] 获取失败, 使用降级方案: ${err.message}`)
        }

        logger.debug(`[身份信息] 最终群名片=${botCardInGroup}, 群身份=${botRoleInGroup}`)

        const administrators = await getHighLevelMembers(e.group)
        const systemContent = buildChatSystemPrompt({
          systemContent: this.config.systemContent,
          botCardInGroup,
          botUin: Bot.uin,
          botRoleInGroup,
          groupContext,
          administrators,
          localTime: "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
          enhancedPrompts,
          mcpPrompts,
          toolHistoryPrompt
        })
        session.userContent = userContent
        if (useCacheV2) {
          try {
            session.cacheToolsPinned = true
            const originalTools = wireClone(session.tools)
            const declarations = cacheConfig.useTools ? [...new Map([
              ...originalTools,
              ...this.getToolsByName(['videoAnalysisTool', 'googleImageEditTool', 'aiMindMapTool', 'grabRedBagTool'], { warnMissing: false })
            ].map(tool => [tool.function.name, tool])).values()].sort((a, b) => a.function.name.localeCompare(b.function.name, 'en')) : []
            const scope = await cacheScope
            const remembered = !botIdentityReliable ? await cacheStore.header(scope, cacheMode) : null
            const rememberedIdentity = remembered?.identity || (!botIdentityReliable && cacheMode === 'agent' ? (await cacheStore.header(scope))?.identity : null)
            const headerOptions = {
              systemContent: cacheConfig.systemContent, botCardInGroup: rememberedIdentity?.botCardInGroup || botCardInGroup,
              botUin: botIdForEvent(e), groupContext, administrators,
              botRoleInGroup: rememberedIdentity?.botRoleInGroup || botRoleInGroup,
              reliable: botIdentityReliable || !!rememberedIdentity
            }
            const route = cacheMode === 'agent' ? resolveAgentRoute(cacheConfig, scope) : null
            const header = cacheMode === 'agent' ? buildAgentPromptCacheHeaders(headerOptions, declarations, route.model, cacheConfig, route.fingerprint) :
              buildPromptCacheHeaders(headerOptions, declarations, { tools: cacheConfig.toolsAiConfig?.toolsAiModel, chat: cacheConfig.chatAiConfig?.chatApiModel })
            if (String(this.config.chatTriggerMode || 'strict').toLowerCase() === 'smart') {
              e._smartHistoryContextVersion = this.getSmartState(groupId).groupContextVersion || 0
            }
            let allowedTools = cacheConfig.useTools ? originalTools.map(tool => tool.function.name) : []
            if (videos?.length) allowedTools = this.getToolsByName(['videoAnalysisTool']).map(tool => tool.function.name)
            if (cacheConfig.forcedAvatarMode && msg?.includes('头像编辑')) allowedTools = this.getToolsByName(['googleImageEditTool']).map(tool => tool.function.name)
            if (msg?.includes('导图') || msg?.includes('思维导图')) allowedTools = this.getToolsByName(['aiMindMapTool']).map(tool => tool.function.name)
            if (e.forceGrabRedBag) allowedTools = this.getToolsByName(['grabRedBagTool']).map(tool => tool.function.name)
            let agentControls
            if (cacheMode === 'agent') {
              allowedTools = cacheConfig.useTools ? originalTools.map(tool => tool.function.name) : []
              let forced = false
              if (cacheConfig.useTools && videos?.length && !agentToolDenied(e, 'videoAnalysisTool')) { allowedTools = this.getToolsByName(['videoAnalysisTool']).map(tool => tool.function.name); forced = true }
              if (cacheConfig.useTools && cacheConfig.forcedAvatarMode && msg?.includes('头像编辑') && hasAgentToolIntent(e, 'googleImageEditTool')) { allowedTools = this.getToolsByName(['googleImageEditTool']).map(tool => tool.function.name); forced = true }
              if (cacheConfig.useTools && hasAgentToolIntent(e, 'aiMindMapTool')) { allowedTools = this.getToolsByName(['aiMindMapTool']).map(tool => tool.function.name); forced = true }
              if (cacheConfig.useTools && e.forceGrabRedBag) { allowedTools = this.getToolsByName(['grabRedBagTool']).map(tool => tool.function.name); forced = true }
              agentControls = buildAgentControls({ e, tools: declarations, allowedTools,
                requiredTools: forced ? allowedTools : [], trustedRequiredTools: e.forceGrabRedBag ? ['grabRedBagTool'] : [],
                config: cacheConfig, senderRole, botId: scope.botId })
              allowedTools = agentControls.allowedTools
            }
            const avatar = cacheConfig.forcedAvatarMode && msg?.includes('头像编辑')
              ? `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640)]` : ''
            // 在场成员表（渲染 v3）：QQ 号/群身份在此声明一次，历史行只留短名字引用
            const participantRows = await this.messageManager.getMessages('group', groupId).catch(() => [])
            // 合入当前发言人（列表拉取失败/消息在窗口外时兜底；插在 bot 之前）
            const participantList = extractParticipants(participantRows, botIdForEvent(e), Bot.nickname)
            const currentQQ = String(e?.user_id ?? '')
            if (currentQQ && !participantList.some(item => item.qq === currentQQ)) {
              participantList.splice(Math.max(0, participantList.length - 1), 0,
                { qq: currentQQ, name: e?.sender?.card || e?.sender?.nickname || '未知用户', role: roleTagOf(e?.sender) || '[member]' })
            }
            const manager = getV2MessageManager(cacheConfig, { update: false })
            session.cacheTurn = await this.preparePromptCacheTurn({
              e, session, scope, header, userContent: userContent + avatar, manager, allowedTools, agentControls, config: cacheConfig,
              participants: participantList,
              profileMessages: personProfilePrompt?.recentMessages || [],
              references: {
                '北京时间': "北京时间: " + new Date().toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" }),
                '情绪': emotionPrompt, '用户记忆': memoryPrompt, '群记忆': groupMemoryPrompt,
                '表达风格': expressionPrompt, '知识库': knowledgePrompt,
                '群公告': groupContext.groupNotice, 'MCP扩展能力': mcpPrompts
              }
            })
            session.cacheTurn.apiConfig = cacheConfig
            if (route) session.cacheTurn.route = route
            session.allowedToolNames = new Set(allowedTools)
            session.tools = freezeWire(wireClone(session.cacheTurn.header.tools))
            session.groupUserMessages = [...session.cacheTurn.toolBase]
            this.messageManager = manager
            e._promptCacheCaptureReceipts = true
          } catch (error) {
            session.cacheToolsPinned = false
            cacheDiagnostic(this.config, 'v1_fallback', { groupId, reason: error.code || error.message })
          }
        }
        // 获取历史记录
        if (!session.cacheTurn && this.config.groupHistory) {
          // 在发起历史读取前固定版本。读取期间才到达的新消息不保证已包含在本次
          // Redis 快照里，必须留给 smart 排队重跑，不能用读取完成后的更高版本冒充已覆盖。
          const smartHistoryContextVersion = String(this.config.chatTriggerMode || 'strict').toLowerCase() === 'smart'
            ? this.getSmartState(groupId).groupContextVersion || 0
            : 0
          const chatHistory = await this.messageManager.getMessages(e.message_type, e.message_type === "group" ? e.group_id : e.user_id)

          if (smartHistoryContextVersion > 0) {
            try { e._smartHistoryContextVersion = smartHistoryContextVersion } catch {}
          }

          if (chatHistory?.length) {
            await e.bot.pickGroup(groupId).getMemberMap()

            // 使用 message_id 过滤当前消息
            const currentMessageId = e.message_id

            groupUserMessages = await Promise.all(chatHistory
              .reverse()
              .filter(msg => {
                // 直接用 message_id 判断，过滤掉当前消息
                if (msg.message_id === currentMessageId) {
                  logger.debug(`[历史去重] 过滤当前消息: message_id=${msg.message_id}`)
                  return false
                }
                return true
              })
              .map(msg => ({
                role: msg.sender.user_id === Bot.uin ? "assistant" : "user",
                messageId: msg.message_id,
                content: `[${shortTimeOf(msg.time)}] ${displayNameFor(msg.sender.nickname || msg.sender.card || '未知', msg.sender.user_id)}${msg.message_id ? `[ID:${msg.message_id}]` : ''}: ${msg.content}`
              }))
            )
            groupUserMessages = await Promise.all(groupUserMessages.map(async msg => {
              const taskStatus = msg.messageId ? await this.getTaskStatus(groupId, msg.messageId) : null
              const statusText = this.formatTaskStatusForPrompt(taskStatus)
              return statusText ? { ...msg, content: `${msg.content}\n${statusText}` } : msg
            }))
          }
        }

        if (!session.cacheTurn) {
          // V1：成员表直接拼 system 尾部（V1 无冻结头约束）。groupHistory 关闭时 chatHistory
          // 不在作用域内，现场拉一份最近记录用于提取成员
          let v1Source = null
          try { v1Source = await this.messageManager.getMessages('group', groupId) } catch { v1Source = null }
          const v1Participants = formatParticipants(extractParticipants(v1Source, botIdForEvent(e), Bot.nickname))
          groupUserMessages = groupUserMessages.filter(m => m.role !== "system")
          groupUserMessages.unshift({ role: "system", content: systemContent + (v1Participants ? `
【今日在场成员】
发言人身份与QQ号（按昵称查询）：
${v1Participants}` : '') })
          groupUserMessages.push({ role: "user", content: userContent })
          groupUserMessages = this.trimMessageHistory(groupUserMessages)
          groupUserMessages = this.filterChatByQQ(groupUserMessages, e.user_id)
          session.groupUserMessages = this.formatMessages(groupUserMessages, e, userContent)
        }

        let toolChoice = "auto"
        if (session.cacheTurn?.mode !== 'agent') {
        if (videos?.length >= 1) {
          if (!session.cacheTurn || session.cacheTurn.settings.preserveForcedSubsets) session.tools = this.getToolsByName(["videoAnalysisTool"])
          if (session.tools?.some(tool => tool.function.name === 'videoAnalysisTool')) toolChoice = { type: "function", function: { name: "videoAnalysisTool" } }
        }

        if ((session.cacheTurn?.apiConfig || this.config).forcedAvatarMode && msg?.includes("头像编辑")) {
          if (!session.cacheTurn || session.cacheTurn.settings.preserveForcedSubsets) session.tools = this.getToolsByName(["googleImageEditTool"])
          if (session.tools?.some(tool => tool.function.name === 'googleImageEditTool')) toolChoice = { type: "function", function: { name: "googleImageEditTool" } }
          if (!session.cacheTurn) session.groupUserMessages.at(-1).content += `[用户头像链接: (https://q1.qlogo.cn/g?b=qq&nk=${e.user_id}&s=640)]`
        }

        if (msg?.includes("导图") || msg?.includes("思维导图")) {
          if (!session.cacheTurn || session.cacheTurn.settings.preserveForcedSubsets) session.tools = this.getToolsByName(["aiMindMapTool"])
          if (session.tools?.some(tool => tool.function.name === 'aiMindMapTool')) toolChoice = { type: "function", function: { name: "aiMindMapTool" } }
        }

        // 强制抢红包模式
        if (e.forceGrabRedBag) {
          if (!session.cacheTurn || session.cacheTurn.settings.preserveForcedSubsets) session.tools = this.getToolsByName(["grabRedBagTool"])
          if (session.tools?.some(tool => tool.function.name === 'grabRedBagTool')) toolChoice = { type: "function", function: { name: "grabRedBagTool" } }
        }
        }

        session.toolContent = session.cacheTurn?.mode === 'agent' ? null :
          await this.buildMessageContent({ nickname: botCardInGroup, user_id: Bot.uin, role: botRoleInGroup }, "", [], [], e.group)

        if (session.cacheTurn) session.tools = freezeWire(wireClone(session.tools))
        if (session.cacheTurn && session.cacheTurn.settings.preserveForcedSubsets && toolChoice !== 'auto') {
          cacheDiagnostic(cacheConfig, 'forced_tool_subset', { groupId, tools: session.tools.map(tool => tool.function.name) })
        }
        if (session.cacheTurn?.mode === 'agent') {
          await this.processAgentTurn(e, session, senderRole)
          this.clearSession(sessionId)
          return true
        }
        const requestData = this.buildRequestData(session.groupUserMessages, session.tools, toolChoice, session.cacheTurn)
        let response = await this.retryRequest(requestData, session.toolContent)

        if (!response?.choices?.[0]) {
          this.clearSession(sessionId)
          return true
        }

        const message = response.choices[0].message || {}

        if (message.tool_calls?.length) {
          await this.processToolCalls(message, e, session, session.groupUserMessages, atQq, senderRole)
        } else if (message.content) {
          session.cacheTurn?.noteFinalAssistant(message)
          await this.handleTextResponse(message.content, e, session, session.groupUserMessages)
        }

        this.clearSession(sessionId)
        return true

      } catch (error) {
        logger.error(`[工具插件] 会话 ${sessionId} 执行异常：`, error)
        this.clearSession(sessionId)
        return true
      } finally {
        await this.commitPromptCacheTurn(session, e).catch(error => {
          logger.error('[PromptCacheV2] finalize failed:', error)
        })
        await this.finishConversationTask(taskContext, session)
        if (e.group_id) this.recordReplyLatency(e.group_id, Date.now() - handleToolStartAt)
      }
    } finally {
      const remaining = (activeGroupChatCounts.get(e.group_id) || 1) - 1
      if (remaining <= 0) activeGroupChatCounts.delete(e.group_id)
      else activeGroupChatCounts.set(e.group_id, remaining)
      logger.debug(`[并发限制] 群${e.group_id} 对话处理完成，释放名额，剩余 ${remaining}/${concurrentLimit}`)
    }
  }

  async handleTextResponse(content, e, session, messages, toolName) {
    const output = await this.processToolSpecificMessage(content, toolName)
    if (!output) {
      logger.warn("[最终回复清理] 模型回复只包含伪工具格式，已跳过发送")
      return
    }
    const shouldUseTextImage = this.shouldUseTextImageForFinalReply({
      content,
      output,
      session,
      toolName,
      e
    })
    const botMessageId = shouldUseTextImage
      ? await this.sendFinalReplyAsTextImage(e, output)
      : await this.sendSegmentedMessage(e, output)
    if (session.cacheTurn?.mode === 'agent' && session.cacheTurn.delivery.failedCount && !session.cacheTurn.delivery.sentCount) {
      try { e._conversationProducedOutput = false } catch {}
      return
    }
    try { e._conversationProducedOutput = true } catch {}

    // 更新会话追踪中的对话历史
    if (this.config.conversationTrackingEnabled && e.group_id && e.user_id) {
      const conversationKey = `${e.group_id}_${e.user_id}`
      const activeConv = activeConversations.get(conversationKey)
      if (activeConv) {
        // 获取当前对话历史
        let chatHistory = activeConv.chatHistory || []

        // 添加用户消息
        const senderName = e.sender?.card || e.sender?.nickname || "未知用户"
        const userMsg = `${this.formatTime()} ${senderName}: ${(session.userContent || e.msg || '').substring(0, 200)}`
        chatHistory.push({ role: 'user', content: userMsg })

        // 添加机器人回复
        const botMsg = `[${Bot.nickname}]: ${output.substring(0, 200)}`
        chatHistory.push({ role: 'bot', content: botMsg })

        // 只保留最近10条
        if (chatHistory.length > 10) {
          chatHistory = chatHistory.slice(-10)
        }

        // 重置定时器并更新数据
        this.setTrackingWithTimer(conversationKey, { chatHistory })
      }
    }

    const now = Math.floor(Date.now() / 1000)
    const replyOrigin = session.cacheTurn && (botMessageId === null || botMessageId === undefined || String(botMessageId) === '')
      ? `reply:${session.cacheTurn.turnId}` : null
    if (replyOrigin) session.cacheTurn.represented.push(replyOrigin)
    if (session.cacheTurn?.mode === 'agent') session.cacheTurn.delivery.syntheticOrigin = replyOrigin

    try {
      // 1. 不再记录工具结果到持久化历史(避免暴露内部格式)
      // 工具结果只在当前轮次上下文中存在,下次加载历史时不会出现

      // 2. 记录 Bot 的最终回复
      if (!(session.cacheTurn?.mode === 'agent' && session.cacheTurn.delivery.status === 'partial')) await this.messageManager.recordMessage({
        ...(replyOrigin ? { _promptCacheOriginKey: replyOrigin } : {}),
        message_type: e.message_type,
        group_id: e.group_id,
        message_id: botMessageId,
        time: now + (session.toolResults?.length || 0) + 1,
        message: [{ type: "text", text: output }],
        source: "send",
        self_id: session.cacheTurn?.scope.botId || Bot.uin,
        sender: { user_id: session.cacheTurn?.scope.botId || Bot.uin, nickname: Bot.nickname, card: Bot.nickname, role: "member" }
      }, session.cacheTurn ? { promptCacheConfig: session.cacheTurn.apiConfig, contextStore: this.contextStore || contextStore } : {})
    } catch (error) {
      logger.error("[MessageRecord] 记录消息失败：", error)
    }

    if (session.cacheTurn) {
      if (session.cacheTurn.mode !== 'agent') session.cacheTurn.finalReply = freezeWire(replayEventRow({ message: {
        time: this.formatTime().slice(1, -1), message_id: botMessageId,
        sender: { user_id: session.cacheTurn.scope.botId, nickname: Bot.nickname, role: 'member' },
        content: output
      } }, session.cacheTurn.scope.botId))
      if (botMessageId) (e._promptCacheDeliveryIds ||= []).push(botMessageId)
      this.updateEnhancedSystems(e, e.msg || '', output).catch(error => logger.error('[增强系统] 更新失败:', error))
      return
    }

    // 保存到 messages 数组
    if (session.toolResults?.length) {
      const existingToolResultIds = new Set(
        messages
          .filter(msg => msg.role === "tool" && msg.tool_call_id)
          .map(msg => msg.tool_call_id)
      )
      for (const { toolCall, toolName: tName, result } of session.toolResults) {
        if (result && result.trim() !== '') {
          const toolCallId = toolCall?.id || randomUUID()
          if (existingToolResultIds.has(toolCallId)) continue
          existingToolResultIds.add(toolCallId)
          messages.push({
            role: "tool",
            tool_call_id: toolCallId,
            name: tName,
            content: result
          })
        }
      }
    }

    messages.push({ role: "assistant", content: output })
    session.groupUserMessages = this.trimMessageHistory(messages)
    await this.saveGroupUserMessages(e.group_id, e.user_id, messages)

    // 更新情感、关系分、表达学习（异步，不阻塞）
    // 使用 e.msg 纯消息内容，而不是格式化的 userContent
    this.updateEnhancedSystems(e, e.msg || '', output).catch(err => {
      logger.error('[增强系统] 更新失败:', err)
    })
  }

  /**
   * 异步更新情感系统和关系分；用户/群记忆由全局消息记录器处理
   */
  async updateEnhancedSystems(e, userMessage, botReply) {
    const { group_id: groupId, user_id: userId } = e
    let emotionState = null

    // 1. 更新情感系统
    if (this.config.emotionSystem?.enabled) {
      const isAtBot = e.message?.some(m => m.type === 'at' && m.qq === Bot.uin)
      emotionState = await this.emotionManager.updateEmotionFromMessage(groupId, userMessage, isAtBot)
    }

    // 2. 更新关系分。用户记忆和群记忆都由全局消息记录器统一入队，
    // 覆盖机器人未回复的真实群消息，并避免在回复路径重复抽取。
    if (this.config.memorySystem?.enabled) {
      const latestEmotionEvent = emotionState?.recentEvents?.[0]
      if (latestEmotionEvent && Number.isFinite(latestEmotionEvent.delta)) {
        const relationDelta = Math.max(-0.03, Math.min(0.03, latestEmotionEvent.delta * 0.2))
        if (relationDelta !== 0) {
          this.memoryManager.updateRelationship(groupId, userId, relationDelta).catch(err => {
            logger.error('[MemoryManager] 根据情绪更新关系分失败:', err)
          })
        }
      }
    }

    // 表达学习已移至 handleRandomReply 静默收集，不在此处调用
  }

}

Object.assign(
  ChatPlugin.prototype,
  configManagerMethods,
  taskStatusMethods,
  toolHistoryMethods,
  messageBuilderMethods,
  conversationTrackerMethods,
  replySenderMethods,
  toolExecutorMethods,
  agentLoopMethods,
  sessionHistoryMethods,
  mcpLifecycleMethods
)
