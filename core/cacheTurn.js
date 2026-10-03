import { FINAL_TOOL_PROMPT } from '../utils/textUtils.js'
import { convertToolMessagesForChat } from '../utils/api/chatMessageAdapters.js'
import { wireClone, freezeWire, tokenEstimate } from './promptCache.js'
import { validateToolRows } from './contextStore.js'
import { stripTurnReferenceContent } from './prompts.js'

const requestContexts = new WeakMap()

export function bindCacheRequest(request, turn) {
  if (turn) {
    turn.captureTools(request.messages)
    requestContexts.set(request, turn)
  }
  return request
}

export function cacheRequestContext(request) { return requestContexts.get(request) }

export class CacheTurn {
  constructor({ turnId, scope, snapshot, observers, userRow, referenceContent, represented, settings, messageId }) {
    this.turnId = turnId
    this.scope = scope
    this.snapshot = snapshot
    this.header = snapshot.header
    this.settings = settings
    this.messageId = messageId
    this.observers = observers
    this.represented = represented
    this.userRow = freezeWire(wireClone(userRow))
    this.historyUserRow = freezeWire(wireClone({
      ...userRow, content: stripTurnReferenceContent(userRow.content, referenceContent)
    }))
    const newRows = observers.flatMap(item => item.block.toolRows)
    this.toolBase = freezeWire([
      { role: 'system', content: this.header.toolSystem },
      ...snapshot.blocks.flatMap(block => block.toolRows), ...newRows,
      this.userRow
    ])
    this.chatBase = freezeWire([
      { role: 'system', content: this.header.chatSystem },
      ...snapshot.blocks.flatMap(block => block.chatRows), ...newRows,
      this.userRow
    ])
    this.toolTail = []
    this.chatTail = []
    this.chatProjectionKey = null
    this.finalReply = null
    this.finalReasoning = null
    this.requests = []
  }

  captureTools(messages) {
    const tail = messages.slice(this.toolBase.length)
    validateToolRows(tail)
    this.toolTail = freezeWire(wireClone(tail))
  }

  noteFinalAssistant(message) {
    this.finalReasoning = typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content : null
  }

  chatMessages() {
    const key = JSON.stringify(this.toolTail)
    if (this.chatProjectionKey !== key) {
      const projection = convertToolMessagesForChat(this.toolTail).map(row => ({
        ...row, content: `【工具执行记录 所属轮次:${this.turnId}】\n${row.content}`
      }))
      this.chatTail = freezeWire([
        ...projection,
        ...(this.toolTail.some(row => row.role === 'tool') ? [{
          role: 'system', content: `【工具收尾提示 仅适用于轮次:${this.turnId}】\n${FINAL_TOOL_PROMPT}`
        }] : [])
      ])
      this.chatProjectionKey = key
    }
    return [...this.chatBase, ...this.chatTail]
  }

  block() {
    this.chatMessages()
    const base = [this.historyUserRow]
    const reply = this.finalReply ? [this.finalReply] : []
    const toolRows = [...base, ...this.toolTail, ...reply]
    const chatReply = this.finalReply ? [{ ...this.finalReply, ...(this.finalReasoning ? { reasoning_content: this.finalReasoning } : {}) }] : []
    const chatRows = [...base, ...this.chatTail, ...chatReply]
    validateToolRows(toolRows)
    return { turnId: this.turnId, referenceVersion: 2, toolRows, chatRows, messageIds: [this.messageId].filter(Boolean), tokens: Math.max(tokenEstimate(toolRows), tokenEstimate(chatRows)) }
  }
}
