import test from 'node:test'
import assert from 'node:assert/strict'
import { replayFormat, replayRows, replayTokenBudget, exportDualBlock, validateToolRows } from '../core/replayAdapters.js'
import { promptCacheMode, promptCacheSettings } from '../core/promptCache.js'

const config = { useTools: true, promptCache: { enabled: true, groups: ['one'], singleStage: true, singleStageGroups: ['*'] },
  chatAiConfig: { chatApiUrl: 'https://example/v1/chat/completions', chatApiModel: 'gemini', chatApiKey: ['key'] },
  toolsAiConfig: { toolsAiUrl: 'https://unused/v1/messages' } }

test('three modes stay opt-in and validate the actual agent route', () => {
  assert.equal(promptCacheMode({}, 'one'), 'v1')
  assert.equal(promptCacheSettings({}).singleStage, false)
  assert.equal(promptCacheMode(config, 'one'), 'agent')
  assert.equal(promptCacheMode(config, 'other'), 'v1')
  assert.equal(promptCacheMode({ ...config, useTools: false, promptCache: { ...config.promptCache, singleStage: false } }, 'one'), 'dual')
  assert.equal(promptCacheMode({ ...config, toolsAiConfig: {}, promptCache: { ...config.promptCache, singleStageGroups: [] } }, 'one'), 'dual')
  assert.equal(promptCacheMode({ ...config, toolsAiConfig: {}, promptCache: { ...config.promptCache, agentSideEffectPolicy: 'unknown' } }, 'one'), 'dual')
  assert.equal(promptCacheSettings({ promptCache: { agentTemperature: Infinity, agentTopP: NaN } }).agentTemperature, 0.85)
})

const body = { role: 'user', content: 'body' }
const final = { role: 'assistant', content: 'model final', reasoning_content: 'exact reasoning', signature: 'original signature' }
const call = { role: 'assistant', content: 'interim', reasoning_content: 'call reasoning', tool_calls: [{ id: 'c', type: 'function',
  function: { name: 'probe', arguments: ' { "value" : 1 } ' }, signature: 'tool signature' }] }
const result = { role: 'tool', tool_call_id: 'c', name: 'probe', content: 'full exact result' }
const block = { replayVersion: 3, mode: 'agent', referenceVersion: 2, turnId: 'turn', apiRows: [body, call, result, final], messageIds: ['source'] }

test('agent rows replay literally; dual projection is deterministic and does not mutate canonical rows', () => {
  const before = JSON.stringify(block)
  assert.equal(replayRows(block, 'agent'), block.apiRows)
  assert.equal(replayRows(block, 'tools'), block.apiRows)
  const chat = replayRows(block, 'chat')
  assert.ok(chat.some(row => row.content?.includes('[tool_execution]')))
  assert.equal(chat.at(-1), final)
  assert.deepEqual(replayRows(block, 'chat'), chat)
  assert.equal(JSON.stringify(block), before)
  assert.ok(replayTokenBudget(block) > 0)
})

test('dual to agent restores reasoning only for the exact final reply', () => {
  const legacy = { toolRows: [body, { role: 'assistant', content: 'same' }], chatRows: [body, { role: 'assistant', content: 'same', reasoning_content: 'retained' }] }
  assert.equal(replayRows(legacy, 'agent').at(-1).reasoning_content, 'retained')
  legacy.chatRows[1].content = 'different'
  assert.equal(replayRows(legacy, 'agent').at(-1).reasoning_content, undefined)
})

test('export preserves all native calls, byte strings, IDs and metadata in legacy-readable format', () => {
  const exported = exportDualBlock(block)
  assert.equal(replayFormat(exported), 'dual')
  assert.equal('apiRows' in exported, false)
  assert.deepEqual(exported.toolRows, block.apiRows)
  assert.deepEqual(exported.messageIds, block.messageIds)
  assert.deepEqual(replayRows(exported, 'agent'), block.apiRows)
  validateToolRows(exported.toolRows)
})

test('unknown versions, incomplete shapes and dangling tools cannot become empty history', () => {
  for (const item of [{ replayVersion: 4, apiRows: [] }, { replayVersion: 3, mode: 'agent' }, { mode: 'agent', toolRows: [], chatRows: [] }]) {
    assert.throws(() => replayRows(item), { code: 'unsupported_replay_format' })
  }
  assert.throws(() => replayRows({ ...block, apiRows: [body, call] }), { code: 'unfinished_tool_calls' })
})
