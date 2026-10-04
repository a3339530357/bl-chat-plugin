import { convertToolMessagesForChat } from '../utils/api/chatMessageAdapters.js'
import { FINAL_TOOL_PROMPT } from '../utils/textUtils.js'
import { wireClone, tokenEstimate } from './promptCache.js'

export const REPLAY_VERSION = 3
export const REPLAY_RENDERER_VERSION = 1

export function agentAssistantRow(message) {
  if (message.role && message.role !== 'assistant') throw new ContextStoreError('invalid_agent_role')
  const result = { ...wireClone(message), role: 'assistant' }
  if (result.tool_calls) result.tool_calls = result.tool_calls.map(call => ({ ...call, type: call.type || 'function',
    function: { ...call.function, arguments: call.function?.arguments ?? '{}' } }))
  return result
}

export class ContextStoreError extends Error {
  constructor(code) { super(`PromptCacheV2: ${code}`); this.code = code }
}

export function validateToolRows(rows = []) {
  let pending = new Set()
  for (const row of rows) {
    if (row.role === 'tool') {
      if (!pending.delete(row.tool_call_id)) throw new ContextStoreError('unpaired_tool_result')
    } else {
      if (pending.size) throw new ContextStoreError('unfinished_tool_calls')
      if (row.tool_calls?.length) {
        const ids = row.tool_calls.map(call => call.id)
        if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new ContextStoreError('invalid_tool_call_ids')
        pending = new Set(ids)
      }
    }
  }
  if (pending.size) throw new ContextStoreError('unfinished_tool_calls')
}

export function replayFormat(block) {
  if (block?.replayVersion === REPLAY_VERSION && block.mode === 'agent' && Array.isArray(block.apiRows)) return 'agent'
  if ((block?.replayVersion === undefined || block.replayVersion === 2) &&
    (block?.mode === undefined || block.mode === 'dual') && Array.isArray(block?.toolRows) && Array.isArray(block?.chatRows)) return 'dual'
  throw new ContextStoreError('unsupported_replay_format')
}

export function nativeReplayRows(block) {
  const rows = replayFormat(block) === 'agent' ? block.apiRows : block.toolRows
  if (rows.some(row => !row || !['user', 'assistant', 'system', 'tool'].includes(row.role))) throw new ContextStoreError('invalid_replay_rows')
  validateToolRows(rows)
  return rows
}

function agentChatRows(block) {
  const rows = convertToolMessagesForChat(nativeReplayRows(block)).map(row => row.role === 'system' && row.content?.startsWith('[tool_execution]')
    ? { ...row, content: `【工具执行记录 所属轮次:${block.turnId}】\n${row.content}` } : row)
  if (block.apiRows.some(row => row.role === 'tool')) {
    const last = rows.at(-1)
    const index = last?.role === 'assistant' && !last.tool_calls?.length ? rows.length - 1 : rows.length
    rows.splice(index, 0, { role: 'system', content: `【工具收尾提示 仅适用于轮次:${block.turnId}】\n${FINAL_TOOL_PROMPT}` })
  }
  return rows
}

export function replayRows(block, view = 'tools') {
  const format = replayFormat(block)
  const native = nativeReplayRows(block)
  if (format === 'agent') return view === 'chat' ? agentChatRows(block) : native
  if (view === 'chat') return block.chatRows
  if (view !== 'agent') return native
  const last = native.at(-1)
  const chatLast = block.chatRows.at(-1)
  if (last?.role === 'assistant' && !last.tool_calls?.length && !last.reasoning_content &&
    chatLast?.role === 'assistant' && chatLast.content === last.content && chatLast.reasoning_content) {
    return [...native.slice(0, -1), { ...last, reasoning_content: chatLast.reasoning_content }]
  }
  return native
}

export function replayTokenBudget(block) {
  return Math.max(tokenEstimate(replayRows(block, 'agent')), tokenEstimate(replayRows(block, 'tools')), tokenEstimate(replayRows(block, 'chat')))
}

export function exportDualBlock(block) {
  if (replayFormat(block) === 'dual') return block
  const { apiRows: _apiRows, ...metadata } = block
  const result = { ...metadata, replayVersion: 2, mode: 'dual', referenceVersion: 2,
    toolRows: wireClone(replayRows(block, 'tools')), chatRows: wireClone(replayRows(block, 'chat')) }
  result.tokens = Math.max(tokenEstimate(result.toolRows), tokenEstimate(result.chatRows))
  return result
}
