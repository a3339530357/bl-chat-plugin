import { FINAL_TOOL_PROMPT } from '../utils/textUtils.js'
import { convertToolMessagesForChat } from '../utils/api/chatMessageAdapters.js'
import { wireClone, freezeWire, tokenEstimate } from './promptCache.js'
import { validateToolRows } from './contextStore.js'
import { stripTurnReferenceContent } from './prompts.js'
import { replayRows, replayTokenBudget, agentAssistantRow, ContextStoreError } from './replayAdapters.js'

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
  constructor({ turnId, scope, snapshot, observers, userRow, referenceContent, represented, settings, messageId, agentControls }) {
    this.turnId = turnId
    this.scope = scope
    this.snapshot = snapshot
    this.header = snapshot.header
    this.mode = this.header.mode === 'agent' ? 'agent' : 'dual'
    this.settings = settings
    this.messageId = messageId
    this.observers = observers
    this.represented = represented
    this.userRow = freezeWire(wireClone(userRow))
    this.historyUserRow = freezeWire(wireClone({
      ...userRow, content: stripTurnReferenceContent(userRow.content, referenceContent)
    }))
    this.requests = []
    this.finalReply = null
    this.finalReasoning = null
    if (this.mode === 'agent') {
      this.agentControls = freezeWire(wireClone(agentControls))
      this.agentBase = freezeWire([{ role: 'system', content: this.header.agentSystem },
        ...snapshot.blocks.flatMap(block => replayRows(block, 'agent')),
        ...observers.flatMap(item => replayRows(item.block, 'agent')), this.userRow])
      this.toolBase = this.agentBase
      this.agentTail = []
      this.finalAssistant = null
      this.delivery = { messageIds: [], syntheticOrigin: null, sentCount: 0, failedCount: 0, status: 'none' }
      this.exitReason = 'pending'
      return
    }
    const newRows = observers.flatMap(item => replayRows(item.block, 'tools'))
    this.toolBase = freezeWire([
      { role: 'system', content: this.header.toolSystem },
      ...snapshot.blocks.flatMap(block => replayRows(block, 'tools')), ...newRows,
      this.userRow
    ])
    this.chatBase = freezeWire([
      { role: 'system', content: this.header.chatSystem },
      ...snapshot.blocks.flatMap(block => replayRows(block, 'chat')), ...newRows,
      this.userRow
    ])
    this.toolTail = []
    this.chatTail = []
    this.chatProjectionKey = null
  }

  captureTools(messages) {
    if (this.mode === 'agent') return this.captureAgent(messages)
    const tail = messages.slice(this.toolBase.length)
    validateToolRows(tail)
    this.toolTail = freezeWire(wireClone(tail))
  }

  captureAgent(messages) {
    if (JSON.stringify(messages.slice(0, this.agentBase.length)) !== JSON.stringify(this.agentBase)) throw new ContextStoreError('agent_prefix_changed')
    const tail = messages.slice(this.agentBase.length)
    validateToolRows(tail)
    this.agentTail = freezeWire(wireClone(tail))
  }

  noteFinalAssistant(message) {
    if (this.mode === 'agent') {
      this.finalAssistant = freezeWire(agentAssistantRow(message))
      return
    }
    this.finalReasoning = typeof message?.reasoning_content === 'string' && message.reasoning_content
      ? message.reasoning_content : null
  }

  chatMessages() {
    if (this.mode === 'agent') return [...this.agentBase, ...this.agentTail]
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
    if (this.mode === 'agent') {
      const block = { replayVersion: 3, mode: 'agent', referenceVersion: 2, turnId: this.turnId,
        apiRows: [this.historyUserRow, ...this.agentTail, ...(this.finalAssistant ? [this.finalAssistant] : [])],
        messageIds: [this.messageId].filter(Boolean), delivery: wireClone(this.delivery), exitReason: this.exitReason }
      validateToolRows(block.apiRows)
      block.tokens = replayTokenBudget(block)
      return block
    }
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
