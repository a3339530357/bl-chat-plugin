// 会话历史 mixin：群成员消息的 redis+本地双写读取/保存/清空、session 工具缓存、
// 历史长度裁剪与按 QQ 过滤。
// 从 apps/chat.js 拆出（行为等价搬迁），经 Object.assign 挂到 ChatPlugin.prototype，this 即插件实例。
import fs from "fs"
import path from "path"
import { loadData, saveData } from "../utils/redisClient.js"
import { contextStore, ContextStoreError } from './contextStore.js'
import { CacheTurn } from './cacheTurn.js'
import { originKeyForEvent, promptCacheSettings, replayEventRow, tokenEstimate, cacheDiagnostic, beijingDay } from './promptCache.js'
import { buildTurnReferenceContent } from './prompts.js'
import { taskStatusMethods } from './taskStatus.js'

const _path = process.cwd()

export const sessionHistoryMethods = {
  async preparePromptCacheTurn({ e, session, scope, header, userContent, references, manager, allowedTools, config = this.config }) {
    const store = this.contextStore || contextStore
    const settings = promptCacheSettings(config)
    await manager.recordMessage(e, {
      journalOnly: true, messageMaxLength: 200, promptCacheConfig: config,
      contextStore: store, scope, journalContent: userContent
    })
    const origin = originKeyForEvent(e)
    const asOf = new Date().toISOString()
    const preliminary = buildTurnReferenceContent({
      turnId: session.turnId, userId: e.user_id, messageId: e.message_id, asOf,
      references, taskStatuses: [], allowedTools
    })
    const incomingTokens = Math.max(tokenEstimate(header.toolSystem) + tokenEstimate(header.tools), tokenEstimate(header.chatSystem)) +
      tokenEstimate(userContent + preliminary)
    const snapshot = await store.read(scope, header, settings, incomingTokens, origin)
    if (snapshot.headerChanged) cacheDiagnostic(config, 'header_change', { groupId: scope.groupId })
    if (snapshot.dropped) cacheDiagnostic(config, 'capacity_trim', { groupId: scope.groupId, blocks: snapshot.dropped })
    const observers = []
    const represented = [origin]
    for (const event of snapshot.events) {
      if (event.represented || event.eventId === origin) continue
      const row = replayEventRow(event, scope.botId)
      if (!row) { represented.push(event.eventId); continue }
      observers.push({ eventId: event.eventId, block: {
        toolRows: [row], chatRows: [row], tokens: tokenEstimate(row),
        messageIds: [event.message?.message_id].filter(Boolean)
      } })
    }
    const newObserverCount = observers.length
    if (!snapshot.blocks.length) {
      const primer = { role: 'user', content: `当前QQ群[${scope.groupId}]的群聊历史记录。` }
      observers.unshift({ eventId: `primer:${scope.resetId}:${snapshot.cursor}:${snapshot.readUntil}`, block: {
        toolRows: [primer], chatRows: [primer], tokens: tokenEstimate(primer), messageIds: []
      } })
    }
    const messageIds = [...new Set([
      ...snapshot.blocks.flatMap(block => block.messageIds || []),
      ...snapshot.events.map(event => event.message?.message_id)
    ].filter(id => id !== undefined && id !== null && String(id) !== String(e.message_id)).map(String))]
    const taskStatuses = await taskStatusMethods.getTaskStatusPromptSnapshot.call(this, scope.groupId, messageIds, e.message_id)
    const selected = this.filterChatByQQ([
      ...observers.flatMap(observer => observer.block.toolRows), { role: 'user', content: userContent }
    ], e.user_id)
    if (selected.length !== observers.reduce((sum, observer) => sum + observer.block.toolRows.length, 0) + 1) {
      cacheDiagnostic(config, 'qq_filter_bypassed', {
        groupId: scope.groupId, turnId: session.turnId,
        removed: observers.reduce((sum, observer) => sum + observer.block.toolRows.length, 0) + 1 - selected.length
      })
    }
    const referenceContent = buildTurnReferenceContent({
      turnId: session.turnId, userId: e.user_id, messageId: e.message_id, asOf,
      references, taskStatuses, allowedTools, newObserverCount
    })
    const turn = new CacheTurn({
      turnId: session.turnId, scope, snapshot, observers, represented, settings, messageId: e.message_id,
      userRow: { role: 'user', content: userContent + referenceContent }
    })
    if (Math.max(tokenEstimate(turn.toolBase) + tokenEstimate(snapshot.header.tools), tokenEstimate(turn.chatBase)) + settings.reserveTokens > settings.highWater) {
      throw new ContextStoreError('incoming_overflow')
    }
    return turn
  },

  async commitPromptCacheTurn(session, e) {
    const turn = session?.cacheTurn
    if (!turn) return
    const ids = e?._promptCacheDeliveryIds || []
    const represented = [...turn.represented, ...ids.map(id => `message:${turn.scope.botId}:${turn.scope.groupId}:${id}`)]
    const store = this.contextStore || contextStore
    const payload = {
      turnId: turn.turnId, readUntil: turn.snapshot.readUntil, baseCursor: turn.snapshot.cursor,
      observers: turn.observers, represented, block: turn.block()
    }
    for (let attempt = 0; attempt < 2; attempt++) {
      try {
        const result = await store.commit(turn.scope, payload)
        if (result.concurrentMerge) cacheDiagnostic(this.config, 'concurrent_merge', { groupId: turn.scope.groupId, turnId: turn.turnId })
        return result
      } catch (error) {
        if (error.code || attempt === 1) {
          cacheDiagnostic(this.config, 'commit_rejected', { groupId: turn.scope.groupId, reason: error.code || error.message })
          return { rejected: true, reason: error.code || error.message }
        }
      }
    }
  },

  async cleanupPromptCacheHistory() {
    const today = beijingDay().dayKey
    const keys = await this.scanRedisKeys(`${(this.contextStore || contextStore).prefix}*`)
    const expired = keys.filter(key => {
      const day = key.match(/\{[^}]+:(\d{8})\}/)?.[1]
      return day && day < today
    })
    const client = (this.contextStore || contextStore).client || globalThis.redis
    for (const key of expired) await client.del(key)
  },

  async getGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)

    try {
      const redisData = await loadData(redisKey, null)
      if (redisData) return redisData

      const fileData = await fs.promises.readFile(filePath, "utf-8").catch(() => null)
      if (fileData) {
        const parsed = JSON.parse(fileData)
        await saveData(redisKey, filePath, parsed)
        return parsed
      }
      return []
    } catch (error) {
      logger.error(`获取消息历史失败:`, error)
      return []
    }
  },

  async saveGroupUserMessages(groupId, userId, messages) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    // 串行写：saveData 在 redis 挂掉时会降级写同一个文件，并发写会导致 JSON 交错损坏
    try {
      await saveData(redisKey, filePath, messages)
      await fs.promises.writeFile(filePath, JSON.stringify(messages, null, 2), "utf-8")
    } catch (err) {
      logger.error(`保存消息历史失败:`, err)
    }
  },

  async clearGroupUserMessages(groupId, userId) {
    const redisKey = `${this.messageHistoriesRedisKey}:${groupId}:${userId}`
    const filePath = path.join(this.messageHistoriesDir, `${groupId}_${userId}.json`)
    await Promise.all([
      redis.del(redisKey),
      fs.promises.unlink(filePath).catch(() => { })
    ])
  },

  async resetGroupUserMessages(groupId, userId) {
    await this.clearGroupUserMessages(groupId, userId)
    await this.saveGroupUserMessages(groupId, userId, [])
  },

  getOrCreateSession(sessionId, tools) {
    if (!this.sessionMap.has(sessionId)) {
      this.sessionMap.set(sessionId, { tools, groupUserMessages: [] })
    }
    return this.sessionMap.get(sessionId)
  },

  clearSession(sessionId) {
    this.sessionMap.delete(sessionId)
  },

  trimMessageHistory(messages) {
    const nonSystem = messages.filter(m => m.role !== "system")
    if (nonSystem.length <= this.MAX_HISTORY) return messages

    const system = messages.filter(m => m.role === "system")
    return [...system, ...nonSystem.slice(-this.MAX_HISTORY)]
  },

  filterChatByQQ(chatArray, qqNumber) {
    const pattern = /\d{2}-\d{2}\s+\d{2}:\d{2}:\d{2}/
    const lastIndex = chatArray.reduce((last, curr, i) =>
      curr.content?.includes(`(qq号: ${qqNumber})`) && pattern.test(curr.content) ? i : last, -1)
    return lastIndex === -1 ? chatArray : chatArray.slice(0, lastIndex + 1)
  },
}
