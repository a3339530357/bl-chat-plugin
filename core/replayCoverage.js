import { nativeReplayRows } from './replayAdapters.js'

// A message ID alone cannot prove that all of its tools/results are visible.
export function replayToolResults(blocks = []) {
  const results = []
  for (const block of blocks) {
    const calls = new Map()
    for (const row of nativeReplayRows(block)) {
      for (const call of row.tool_calls || []) calls.set(call.id, call.function?.name)
      if (row.role === 'tool' && calls.has(row.tool_call_id)) results.push({
        block, messageIds: (block.messageIds || []).map(String), name: calls.get(row.tool_call_id),
        result: typeof row.content === 'string' ? row.content : JSON.stringify(row.content), callId: row.tool_call_id
      })
    }
  }
  return results
}

export function taskOutcomeCovered(status, results) {
  if (!['tool_success', 'tool_failed'].includes(status?.status) || !status.toolCallId) return false
  return results.some(result => result.name === status.toolName && result.messageIds.includes(String(status.messageId)) &&
    result.block.taskOutcomes?.some(outcome => outcome.toolCallId === status.toolCallId && outcome.toolCallId === result.callId && String(outcome.messageId) === String(status.messageId) && outcome.toolName === status.toolName &&
      outcome.status === status.status && outcome.updatedAt === status.updatedAt && outcome.error === status.error))
}
