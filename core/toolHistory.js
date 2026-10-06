// 工具调用历史：按群保留最近 N 条用户消息触发的工具调用聚合记录，
// 注入到 system prompt 让模型形成跨对话的事件认知。
// 同一条用户消息触发的多个工具（无论一轮并行还是多轮串行）聚合成一条 record。
// 内存 Map + redis 双层缓存，与 taskStatus 同构。
// 以 mixin 形式挂到插件原型上，this 指向插件实例（依赖 this.config）。
// 成败判定用 hasExplicitErrorMarker（严格版，零误判），不用带中文模糊匹配的 isToolResultError。

import { hasExplicitErrorMarker } from "./toolResult.js"
import { replayToolResults } from './replayCoverage.js'
import { tokenEstimate } from './promptCache.js'

const TOOL_HISTORY_PREFIX = "ytbot:tool_history:"
const toolHistoryCache = new Map()

// 终态工具中只有 textImageTool 值得作为执行历史；waitTool / sendLocalEmojiTool 价值低且会刷屏
const TOOL_HISTORY_SKIP_TOOL_NAMES = new Set(["waitTool", "sendLocalEmojiTool"])

function truncateResult(text, max) {
  const s = typeof text === "string" ? text : String(text ?? "")
  if (!s) return ""
  return s.length > max ? s.slice(0, max) + "...(已截断)" : s
}

export function toolHistoryFacts(records, snapshot, budget = 512) {
  const receipts = replayToolResults(snapshot.blocks)
  const consumed = new Set()
  const pending = []
  for (const record of records) for (const [index, tool] of (record.tools || []).entries()) {
    const result = String(tool.result || '')
    const matched = record.messageId && !result.endsWith('...(已截断)') ? receipts.findIndex((receipt, i) => !consumed.has(i) &&
      receipt.messageIds.includes(String(record.messageId)) && receipt.name === tool.toolName && receipt.result === result) : -1
    if (matched >= 0) { consumed.add(matched); continue }
    const failed = tool.success === false || hasExplicitErrorMarker(result)
    const key = `history:${record.messageId || `time-${record.time}`}:${index}`
    const value = { tool: tool.toolName, failed, result }
    let detail = result
    if (failed) {
      try { const parsed = JSON.parse(result); if (parsed.error) detail = typeof parsed.error === 'string' ? parsed.error : JSON.stringify(parsed.error) } catch {}
    }
    pending.push({ key, value, failed, detail, prefix: `工具 消息${record.messageId || '-'} ${tool.toolName}=${failed ? 'failed' : 'success'}` })
  }
  // Failure reasons take priority over success excerpts. Budget only novel
  // summaries; unchanged notes are already present in the cached replay.
  pending.sort((a, b) => Number(b.failed) - Number(a.failed))
  let used = 0
  const activeKeys = new Set(records.flatMap(record => (record.tools || []).map((_, index) => `history:${record.messageId || `time-${record.time}`}:${index}`)))
  const facts = Object.keys(snapshot.noteState || {}).filter(key => key.startsWith('history:') && !activeKeys.has(key))
    .map(key => ({ key, value: null, text: '', retired: true }))
  for (const item of pending) {
    const previous = snapshot.noteState?.[item.key]
    if (previous?.valueJson === JSON.stringify(item.value) && snapshot.blocks.some(block => block.contextNotes?.some(entry => entry.key === item.key && entry.valueJson === previous.valueJson))) {
      facts.push({ key: item.key, value: item.value, text: previous.text })
      continue
    }
    const overhead = tokenEstimate(`v${snapshot.noteClock} ${item.prefix}\n`) + 4
    const remaining = budget - used - overhead
    if (remaining < 8) continue
    const chars = Array.from(item.detail)
    let low = 0; let high = Math.min(chars.length, item.failed ? 240 : 120)
    while (low < high) {
      const middle = Math.ceil((low + high) / 2)
      if (tokenEstimate(chars.slice(0, middle).join('')) <= remaining) low = middle
      else high = middle - 1
    }
    const excerpt = chars.slice(0, low).join('') + (low < chars.length ? '…' : '')
    const text = `${item.prefix}${excerpt ? ` ${excerpt}` : ''}`
    used += tokenEstimate(`v${snapshot.noteClock} ${text}\n`)
    facts.push({ key: item.key, value: item.value, text })
  }
  return facts
}

// 老格式 record（每工具一条，无 tools 字段）兼容到新格式（每消息一条，tools 数组）
function normalizeRecord(raw) {
  if (!raw || typeof raw !== "object") return null
  if (Array.isArray(raw.tools)) return raw
  if (raw.toolName) {
    return {
      messageId: raw.messageId || "",
      tools: [{
        toolName: raw.toolName,
        success: raw.success !== false,
        result: raw.result || ""
      }],
      time: raw.time || Date.now()
    }
  }
  return null
}

export const toolHistoryMethods = {
  isToolHistoryEnabled() {
    return this.config?.toolHistorySystem?.enabled !== false
  }
,
  getToolHistoryConfig() {
    const c = this.config?.toolHistorySystem || {}
    return {
      maxItems: Math.max(1, Math.min(50, Number(c.maxItems) || 10)),
      maxResultLength: Math.max(20, Math.min(2000, Number(c.maxResultLength) || 150)),
      ttlSeconds: Math.max(60, Math.floor((Number(c.ttlDays) || 7) * 24 * 60 * 60))
    }
  }
,
  getToolHistoryRedisKey(groupId) {
    return `${TOOL_HISTORY_PREFIX}${groupId}`
  }
,
  shouldSkipToolHistory(toolName) {
    return TOOL_HISTORY_SKIP_TOOL_NAMES.has(toolName)
  }
,
  async loadToolHistory(groupId) {
    if (!groupId) return []
    const key = String(groupId)
    if (toolHistoryCache.has(key)) return toolHistoryCache.get(key)

    try {
      const raw = await redis.get(this.getToolHistoryRedisKey(groupId))
      if (!raw) {
        toolHistoryCache.set(key, [])
        return []
      }
      const parsed = JSON.parse(raw)
      const arr = Array.isArray(parsed) ? parsed.map(normalizeRecord).filter(Boolean) : []
      toolHistoryCache.set(key, arr)
      return arr
    } catch (error) {
      logger?.warn?.(`[工具历史] 读取失败：${error.message}`)
      return []
    }
  }
,
  /**
   * 批量记录一条用户消息触发的工具结果。
   * - 同 messageId 命中列表头：追加 tools 到现有 record
   * - 否则：新建 record 推到列表头
   * @param {Object} param0
   * @param {string|number} param0.groupId
   * @param {string|number|null} param0.messageId
   * @param {Array<{toolName:string, result:string}>} param0.items
   */
  async recordToolHistoryBatch({ groupId, messageId, items }) {
    if (!this.isToolHistoryEnabled()) return
    if (!groupId) return
    if (!Array.isArray(items) || !items.length) return

    const { maxItems, maxResultLength, ttlSeconds } = this.getToolHistoryConfig()
    const subItems = items
      .filter(it => it && it.toolName && !this.shouldSkipToolHistory(it.toolName))
      .map(it => ({
        toolName: it.toolName,
        success: !hasExplicitErrorMarker(it.result, { chinese: false }),
        result: truncateResult(it.result, maxResultLength)
      }))
    if (!subItems.length) return

    const key = String(groupId)
    const prev = await this.loadToolHistory(groupId)
    const head = prev[0]
    const incomingId = messageId ? String(messageId) : ""

    let list
    if (incomingId && head?.messageId && head.messageId === incomingId) {
      // 同一条用户消息：追加到头部 record 的 tools
      const merged = {
        ...head,
        tools: [...(head.tools || []), ...subItems],
        time: Date.now()
      }
      list = [merged, ...prev.slice(1)]
    } else {
      // 新一条用户消息
      const record = {
        messageId: incomingId,
        tools: subItems,
        time: Date.now()
      }
      list = [record, ...prev].slice(0, maxItems)
    }

    toolHistoryCache.set(key, list)

    try {
      await redis.set(
        this.getToolHistoryRedisKey(groupId),
        JSON.stringify(list),
        { EX: ttlSeconds }
      )
    } catch (error) {
      logger?.warn?.(`[工具历史] 写入失败：${error.message}`)
    }
  }
,
  async getToolHistoryPromptForGroup(groupId) {
    if (!this.isToolHistoryEnabled()) return ""
    if (!groupId) return ""
    const list = await this.loadToolHistory(groupId)
    if (!list.length) return ""

    const lines = list.map(record => {
      const idTag = record.messageId ? `[消息ID:${record.messageId}] ` : ""
      const tools = Array.isArray(record.tools) ? record.tools : []
      if (tools.length === 1) {
        const t = tools[0]
        const flag = t.success ? "✓" : "✗"
        const result = t.result ? ` → ${t.result}` : ""
        return `- ${idTag}${t.toolName} ${flag}${result}`
      }
      const sub = tools.map(t => {
        const flag = t.success ? "✓" : "✗"
        const result = t.result ? ` → ${t.result}` : ""
        return `  · ${t.toolName} ${flag}${result}`
      }).join("\n")
      return `- ${idTag}(${tools.length}个工具)\n${sub}`
    })
    return `【工具调用历史】（最近${list.length}条，按时间倒序，仅供你回忆做过的事，不要据此重复调用工具）\n${lines.join("\n")}`
  }
}
