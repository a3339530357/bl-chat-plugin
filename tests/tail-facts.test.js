import test from 'node:test'
import assert from 'node:assert/strict'
import { taskStatusMethods } from '../core/taskStatus.js'
import { planContextNotes } from '../core/contextNotes.js'
import { toolHistoryFacts, toolHistoryMethods } from '../core/toolHistory.js'
import { hasExplicitErrorMarker, isToolResultError } from '../core/toolResult.js'
import { tokenEstimate } from '../core/promptCache.js'

const toolBlock = (name, outcome) => ({ replayVersion: 3, mode: 'agent', messageIds: ['m1'], taskOutcomes: outcome ? [outcome] : [], apiRows: [
  { role: 'user', content: 'request' },
  { role: 'assistant', tool_calls: [{ id: 'c1', function: { name, arguments: '{}' } }] },
  { role: 'tool', tool_call_id: 'c1', content: 'done' }
] })

test('task facts preserve failure causes, suppress exact repeats, and explicitly close obsolete active states', async () => {
  let status = { messageId: 'm1', toolName: 'probe', status: 'tool_failed', error: 'ECONNRESET', updatedAt: 100 }
  const owner = { getTaskStatus: async () => status }
  const snapshot = { blocks: [], noteState: {}, noteClock: 1 }
  let facts = await taskStatusMethods.getTaskStatusFacts.call(owner, 'group', ['m1'], 'current', snapshot)
  assert.match(facts[0].text, /probe=failed.*ECONNRESET/)
  const plan = planContextNotes(snapshot, facts)
  snapshot.noteState = Object.fromEntries(plan.notes.map(note => [note.entry.key, note.entry]))
  snapshot.blocks = plan.notes.map(note => note.block)
  snapshot.noteClock++
  facts = await taskStatusMethods.getTaskStatusFacts.call(owner, 'group', ['m1'], 'current', snapshot)
  assert.equal(planContextNotes(snapshot, facts).content, '')
  status = null
  facts = await taskStatusMethods.getTaskStatusFacts.call(owner, 'group', ['m1'], 'current', snapshot)
  assert.match(planContextNotes(snapshot, facts).content, /closed/)
})

test('terminal coverage requires matching message, tool, call receipt and outcome version', async () => {
  const status = { messageId: 'm1', toolName: 'probe', status: 'tool_success', error: '', updatedAt: 100, toolCallId: 'c1' }
  const outcome = { ...status, toolCallId: 'c1' }
  const owner = { getTaskStatus: async () => status }
  const snapshot = { noteState: {}, noteClock: 1, blocks: [] }
  for (const block of [toolBlock('different', outcome), toolBlock('probe'), toolBlock('probe', { ...outcome, updatedAt: 99 }), toolBlock('probe', { ...outcome, toolCallId: 'other' })]) {
    snapshot.blocks = [block]
    assert.equal((await taskStatusMethods.getTaskStatusFacts.call(owner, 'group', ['m1'], 'current', snapshot)).length, 1)
  }
  snapshot.blocks = [toolBlock('probe', outcome)]
  assert.deepEqual(await taskStatusMethods.getTaskStatusFacts.call(owner, 'group', ['m1'], 'current', snapshot), [])
})

test('history coverage matches individual results and occurrences, not just a shared message ID', () => {
  const snapshot = { blocks: [toolBlock('probe')], noteState: {}, noteClock: 1 }
  const records = [{ messageId: 'm1', tools: [
    { toolName: 'probe', result: 'done' }, { toolName: 'probe', result: 'done' },
    { toolName: 'other', result: 'done' }, { toolName: 'probe', result: 'different' },
    { toolName: 'probe', result: 'do...(已截断)' }
  ] }]
  const facts = toolHistoryFacts(records, snapshot)
  assert.deepEqual(facts.map(value => value.key), ['history:m1:1', 'history:m1:2', 'history:m1:3', 'history:m1:4'])
  const plan = planContextNotes(snapshot, facts)
  snapshot.blocks.push(...plan.notes.map(note => note.block))
  snapshot.noteState = Object.fromEntries(plan.notes.map(note => [note.entry.key, note.entry]))
  snapshot.noteClock++
  assert.equal(planContextNotes(snapshot, toolHistoryFacts(records, snapshot)).content, '')
})

test('history injection has a total token budget and prefers error reasons buried in a result', () => {
  const snapshot = { blocks: [], noteState: {}, noteClock: 100 }
  const records = [{ messageId: 'm1', tools: [
    ...Array.from({ length: 15 }, () => ({ toolName: 'probe', result: '搜索资料'.repeat(200) })),
    { toolName: 'probe', result: JSON.stringify({ details: 'x'.repeat(300), error: 'ECONNRESET' }) }
  ] }]
  const facts = toolHistoryFacts(records, snapshot, 100)
  const content = planContextNotes(snapshot, facts).content
  assert.match(content, /failed.*ECONNRESET/)
  assert.ok(tokenEstimate(content) <= 100)
  assert.equal(records[0].tools[0].result.length, 800)
})

test('Chinese failure fix applies to V2 projection while legacy stored flags/classification stay unchanged', async () => {
  const text = '搜索失败：' + '网络错误'.repeat(80)
  assert.equal(hasExplicitErrorMarker(text), true)
  assert.equal(hasExplicitErrorMarker('资料中的搜索失败：不代表调用失败'), false)
  assert.equal(isToolResultError(text), false)
  const storage = new Map()
  const previousRedis = globalThis.redis
  globalThis.redis = { get: async key => storage.get(key), set: async (key, value) => storage.set(key, value) }
  try {
    const owner = { ...toolHistoryMethods, config: { toolHistorySystem: { maxResultLength: 500 } } }
    await owner.recordToolHistoryBatch({ groupId: 'tail-history-test', messageId: 'm1', items: [{ toolName: 'probe', result: text }] })
    const records = await owner.loadToolHistory('tail-history-test')
    assert.equal(records[0].tools[0].success, true)
    assert.ok((await owner.getToolHistoryPromptForGroup('tail-history-test')).includes('✓'))
    const facts = toolHistoryFacts(records, { blocks: [], noteState: {}, noteClock: 1 })
    assert.match(facts[0].text, /failed/)
    assert.equal(records[0].tools[0].result, text)
  } finally { globalThis.redis = previousRedis }
})
