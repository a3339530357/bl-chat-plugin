import test from 'node:test'
import assert from 'node:assert/strict'
import { CacheTurn, bindCacheRequest } from '../core/cacheTurn.js'
import { agentLoopMethods } from '../core/agentLoop.js'
import { buildAgentPromptCacheHeaders, buildTurnReferenceContent } from '../core/prompts.js'
import { buildAgentControls } from '../core/toolConfig.js'
import { promptCacheSettings, wireClone } from '../core/promptCache.js'
import { validateToolRows } from '../core/replayAdapters.js'

const message = (content, calls) => ({ role: 'assistant', content, ...(calls ? { tool_calls: calls } : {}) })
const call = (id, name = 'probe', args = ' { "value" : 1 } ') => ({ id, type: 'function', signature: `signature-${id}`, function: { name, arguments: args } })

function setup(responses, { msg = 'hello', rounds = 5, terminal = false, requiredTools = [], dispatch, sendFailure = false, policy = 'contextual' } = {}) {
  const config = { useTools: true, maxToolRounds: rounds, promptCache: { diagnostics: false, agentSideEffectPolicy: policy, agentToolPolicies: { probe: { category: 'read' } } }, chatAiConfig: { chatApiModel: 'test' } }
  const tools = ['probe', 'voiceTool', 'pokeTool'].map(name => ({ type: 'function', function: { name, description: name, parameters: { type: 'object', properties: {} } } }))
  const e = { msg, user_id: '42', group_id: 'group', sender: { nickname: 'Alice' }, async reply(content) {
    if (sendFailure) throw new Error('send failed')
    sent.push(content)
    return { message_id: `reply-${sent.length}` }
  } }
  const sent = []
  const executed = []
  const requests = []
  const controls = buildAgentControls({ e, tools, allowedTools: tools.map(tool => tool.function.name), requiredTools, config, botId: 'bot' })
  const header = buildAgentPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group' } }, tools, 'test', config)
  const referenceContent = buildTurnReferenceContent({ turnId: 'turn', userId: '42', references: { memory: 'full current memory' }, taskStatuses: [], allowedTools: controls.allowedTools, agentControls: controls })
  const turn = new CacheTurn({ turnId: 'turn', scope: { groupId: 'group' }, snapshot: { header, blocks: [] }, observers: [],
    userRow: { role: 'user', content: msg + referenceContent }, referenceContent, settings: promptCacheSettings(config), represented: [], messageId: 'source', agentControls: controls })
  turn.apiConfig = config
  const session = { cacheTurn: turn, tools: header.tools, allowedToolNames: new Set(controls.allowedTools) }
  const owner = {
    ...agentLoopMethods, config,
    buildRequestData(messages, declarations, choice, context) { return bindCacheRequest({ messages: [...messages], tools: declarations, tool_choice: choice }, context) },
    async retryRequest(request) {
      requests.push(wireClone(request))
      const item = typeof responses === 'function' ? responses(requests.length) : responses.shift()
      return item?.error ? item : { choices: [{ message: item }] }
    },
    async runToolCall(current) { executed.push(current); return dispatch ? dispatch(current, e) : { toolCall: current, toolName: current.function.name, result: 'success', _executed: true, _terminal: terminal } },
    recordToolHistoryBatch: async () => {},
    processToolSpecificMessage: content => content === '[tool_code]' ? '' : content,
    async handleTextResponse(content) { await e.reply(content) }
  }
  return { owner, session, turn, e, sent, executed, requests }
}
const run = async context => { await context.owner.processAgentTurn(context.e, context.session, 'member'); return context }

test('direct text is one request and saves native final content/signature rather than a formatted reply', async () => {
  const raw = { ...message('plain final'), reasoning_content: 'native reasoning', signature: 'native signature' }
  const ctx = await run(setup([raw]))
  assert.equal(ctx.requests.length, 1)
  assert.deepEqual(ctx.sent, ['plain final'])
  const block = ctx.turn.block()
  assert.equal(block.mode, 'agent')
  assert.equal('toolRows' in block, false)
  assert.equal(block.apiRows[0].content, 'hello')
  assert.deepEqual(block.apiRows.at(-1), raw)
  assert.equal(block.exitReason, 'text')
  assert.deepEqual(block.delivery.messageIds, ['reply-1'])
})

test('one tool round is two requests with a stable prefix, full raw arguments, signatures and no interim send', async () => {
  const native = { ...message('I will inspect', [call('c')]), reasoning_content: 'reasoning' }
  const ctx = await run(setup([native, message('final')]))
  assert.equal(ctx.requests.length, 2)
  assert.deepEqual(ctx.sent, ['final'])
  assert.deepEqual(ctx.requests[1].messages.slice(0, ctx.requests[0].messages.length), ctx.requests[0].messages)
  assert.deepEqual(ctx.requests[0].tools, ctx.requests[1].tools)
  assert.equal(ctx.requests[1].tool_choice, 'auto')
  assert.equal(ctx.turn.block().apiRows[1].tool_calls[0].function.arguments, ' { "value" : 1 } ')
  assert.equal(ctx.turn.block().apiRows[1].tool_calls[0].signature, 'signature-c')
  validateToolRows(ctx.turn.block().apiRows)
})

test('all successful terminal tools stop immediately; mixed/failed terminal batches continue', async () => {
  const ctx = await run(setup([message('', [call('c')])], { terminal: true }))
  assert.equal(ctx.requests.length, 1)
  assert.equal(ctx.turn.exitReason, 'terminal')
  assert.equal(ctx.sent.length, 0)
  const mixed = await run(setup([message('', [call('one'), call('two')]), message('final')], { dispatch: current => ({ toolCall: current,
    toolName: current.function.name, result: current.id === 'one' ? 'error: failed' : 'success', _executed: true, _terminal: true }) }))
  assert.equal(mixed.requests.length, 2)
  assert.deepEqual(mixed.sent, ['final'])
})

test('contextual blocks spontaneous voice and closes rejected calls without dispatch', async () => {
  const ctx = await run(setup([message('', [call('voice', 'voiceTool', '{"text":"hello"}')]), message('normal text')]))
  assert.equal(ctx.executed.length, 0)
  assert.match(ctx.turn.block().apiRows[2].content, /does not authorize/)
  validateToolRows(ctx.turn.block().apiRows)
})

test('same-turn duplicate effects with different IDs and object ordering execute only once', async () => {
  const ctx = await run(setup([message('', [call('v1', 'voiceTool', '{"text":"hello","x":1}'), call('v2', 'voiceTool', '{"x":1,"text":"hello"}')]), message('final')], { msg: '请发语音说你好' }))
  assert.equal(ctx.executed.length, 1)
  assert.match(ctx.turn.block().apiRows[3].content, /duplicate/)
  assert.deepEqual(ctx.turn.block().apiRows.slice(2, 4).map(row => row.tool_call_id), ['v1', 'v2'])
})

test('budget exhaustion keeps tools/auto and never executes a further batch', async () => {
  const ctx = await run(setup(index => message('', [call(`c${index}`)]), { rounds: 1 }))
  assert.equal(ctx.executed.length, 1)
  assert.equal(ctx.requests.length, 3)
  assert.equal(ctx.turn.exitReason, 'tool_budget')
  assert.ok(ctx.requests.every(request => request.tools.length && request.tool_choice === 'auto'))
  assert.ok(ctx.requests[1].messages.at(-1).content.includes('预算已用完'))
  validateToolRows(ctx.turn.block().apiRows)
})

test('malformed calls, empty reasoning and cleared pseudo-tool text share one recovery budget', async () => {
  const malformed = message('', [call('duplicate'), call('duplicate')])
  const ctx = await run(setup([malformed, { ...message(''), reasoning_content: 'not visible' }, message('never reached')]))
  assert.equal(ctx.executed.length, 0)
  assert.equal(ctx.requests.length, 2)
  assert.equal(ctx.sent.length, 0)
  assert.equal(ctx.turn.exitReason, 'empty')
  const cleared = await run(setup([message('[tool_code]'), message('real reply')]))
  assert.deepEqual(cleared.sent, ['real reply'])
})

test('oversized tool batches never dispatch a burst of side effects', async () => {
  const ctx = await run(setup([message('', Array.from({ length: 33 }, (_, index) => call(`c${index}`))), message('final')]))
  assert.equal(ctx.executed.length, 0)
  assert.equal(ctx.requests.length, 2)
  assert.deepEqual(ctx.sent, ['final'])
})

test('missing required action is corrected once, never announced as completed without execution', async () => {
  const ctx = await run(setup([message('already done'), message('', [call('c')]), message('completed')], { requiredTools: ['probe'] }))
  assert.deepEqual(ctx.sent, ['completed'])
  assert.equal(ctx.executed.length, 1)
  assert.ok(ctx.requests[1].messages.at(-1).content.includes('尚未成功执行'))
  const failed = await run(setup([message('done'), message('still done')], { requiredTools: ['probe'] }))
  assert.deepEqual(failed.sent, ['这次操作还没完成。'])
  assert.equal(failed.turn.exitReason, 'required_tool_unmet')
})

test('tool results survive a subsequent API failure and invalid JSON arguments never dispatch', async () => {
  const ctx = await run(setup([message('', [call('c')]), { error: 'HTTP failure' }]))
  assert.equal(ctx.turn.exitReason, 'api_error')
  assert.equal(ctx.turn.block().apiRows.at(-1).role, 'tool')
  const malformed = await run(setup([message('', [call('bad', 'probe', 'not JSON')]), message('sorry')]))
  assert.equal(malformed.executed.length, 0)
  assert.match(malformed.turn.block().apiRows[2].content, /invalid JSON/)
})

test('a locally rejected parameter batch leaves execution budget for one corrected action', async () => {
  const ctx = await run(setup([message('', [call('bad', 'probe', 'not JSON')]), message('', [call('valid')]), message('final')], { rounds: 1 }))
  assert.equal(ctx.executed.length, 1)
  assert.equal(ctx.requests.length, 3)
  assert.equal(ctx.turn.exitReason, 'text')
})

test('failed delivery does not discard the native final row or leave the wrapped reply installed', async () => {
  const ctx = setup([message('final')], { sendFailure: true })
  const originalReply = ctx.e.reply
  await assert.rejects(run(ctx), /send failed/)
  assert.equal(ctx.e.reply, originalReply)
  assert.equal(ctx.turn.delivery.status, 'failed')
  assert.equal(ctx.turn.block().apiRows.at(-1).content, 'final')
})
