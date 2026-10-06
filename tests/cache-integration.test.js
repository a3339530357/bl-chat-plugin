import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { randomUUID } from 'node:crypto'
import { ContextStore } from '../core/contextStore.js'
import { sessionHistoryMethods } from '../core/sessionHistory.js'
import { buildPromptCacheHeaders, TURN_REFERENCE_START } from '../core/prompts.js'
import { bindCacheRequest } from '../core/cacheTurn.js'
import { originKeyForEvent, freezeWire } from '../core/promptCache.js'
import { redisFixture } from './helpers/redis-fixture.js'
import { replayRows } from '../core/replayAdapters.js'

globalThis.logger = { debug() {}, info() {}, warn() {}, error() {} }
const { YTapi } = await import('../utils/apiClient.js')
const { toolExecutorMethods } = await import('../core/toolExecutor.js')

let fixture
let server
let endpoint
const requests = []
let toolCalls = 0
const declaration = { type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } } }
const assistantCall = { role: 'assistant', content: '', reasoning_content: 'stable reasoning', tool_calls: [{
  id: 'call-one', type: 'function', function: { name: 'probe', arguments: ' { "value" : 1 } ' }
}] }

before(async () => {
  fixture = await redisFixture()
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    response.setHeader('content-type', 'application/json')
    response.setHeader('x-mapped-model', 'test-model')
    const message = body.tools && ++toolCalls === 1 ? assistantCall : { role: 'assistant', content: body.tools ? 'ignored draft' : 'reply' }
    response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1000, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 2 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
})
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await fixture?.stop()
})

async function context() {
  const store = new ContextStore(fixture.client, `test:integration:${randomUUID()}:`)
  const scope = await store.scope('bot', 'group')
  const config = {
    providers: 'oneapi', useTools: true, groupHistory: true,
    promptCache: { enabled: true, groups: ['group'], diagnostics: false },
    toolsAiConfig: { toolsAiUrl: endpoint, toolsAiModel: 'test-model', toolsAiApikey: 'test-key' },
    chatAiConfig: { chatApiUrl: endpoint, chatApiModel: 'test-model', chatApiKey: ['test-key'] }
  }
  const header = buildPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group', groupName: 'Group' } }, [declaration])
  const states = new Map()
  const owner = {
    ...sessionHistoryMethods, contextStore: store, config,
    getTaskStatus: async (_group, id) => states.get(String(id)) || null,
    formatTaskStatusForPrompt: status => status?.text || ''
  }
  const manager = {
    async recordMessage(e) {
      return store.record(scope, { eventId: originKeyForEvent(e), message: {
        time: '2026-10-03 12:00:00', message_id: e.message_id, content: e.msg,
        sender: { user_id: e.user_id, nickname: e.user_id, role: 'member' }, message: []
      } })
    }
  }
  const makeEvent = (id, userId = 'user') => ({ self_id: 'bot', group_id: 'group', user_id: userId, message_id: id, msg: `message ${id}` })
  async function prepare(e, references = {}, userContent = `[2026-10-03 12:00:00] ${e.user_id}(qq号: ${e.user_id})[群身份: member]: ${e.msg}`) {
    const session = { turnId: randomUUID() }
    const turn = await owner.preparePromptCacheTurn({
      e, session, scope, header, manager, allowedTools: ['probe'], references,
      userContent
    })
    turn.apiConfig = config
    return turn
  }
  const request = (turn, messages = [...turn.toolBase], choice = 'auto') => bindCacheRequest({
    model: 'test-model', messages, tools: turn.header.tools, tool_choice: choice, temperature: 0.85, top_p: 0.95
  }, turn)
  return { store, scope, config, header, owner, states, manager, makeEvent, prepare, request }
}

test('real Redis + HTTP preserve clean turn/tool bytes and carry scoped data in separate annotations', async () => {
  requests.length = 0
  toolCalls = 0
  const ctx = await context()
  const observer = ctx.makeEvent('observer')
  await ctx.manager.recordMessage(observer)
  ctx.states.set('observer', { status: 'processing', messageId: 'observer' })
  const e1 = ctx.makeEvent('current-one', 'user-one')
  const first = await ctx.prepare(e1, { emotion: 'happy', memory: 'user-one likes music', time: 'first time' })
  const firstUserBytes = first.userRow.content
  const decision = await YTapi(ctx.request(first), ctx.config)
  assert.equal(decision.choices[0].message.tool_calls.length, 1)
  const continuation = [...first.toolBase, assistantCall, { role: 'tool', tool_call_id: 'call-one', name: 'probe', content: 'success' }]
  const reply = await YTapi(ctx.request(first, continuation), ctx.config)
  assert.equal(reply.choices[0].message.content, 'reply')
  assert.equal(requests.length, 3)
  const toolRequest = requests[1]
  const chatRequest = requests[2]
  assert.notEqual(toolRequest.messages[0].content, chatRequest.messages[0].content)
  assert.equal('tools' in chatRequest, false)
  assert.equal('tool_choice' in chatRequest, false)
  assert.ok(chatRequest.messages.some(row => row.content?.includes('[tool_execution]')))
  assert.ok(chatRequest.messages.at(-1).content.includes('工具已全部执行完成'))
  assert.deepEqual(first.requests.map(item => item.stage), ['tools', 'tools', 'chat'])
  for (const request of requests) {
    assert.deepEqual(Object.keys(request).sort(), (request.tools
      ? ['messages', 'model', 'stream', 'temperature', 'tool_choice', 'tools', 'top_p']
      : ['messages', 'model', 'stream', 'temperature', 'top_p']).sort())
    assert.ok(request.messages.every(row => !('turnId' in row) && !('api_content' in row) && !('messageId' in row)))
  }
  first.finalReply = freezeWire({ role: 'assistant', content: 'reply' })
  first.noteFinalAssistant({ reasoning_content: 'exact final reasoning bytes' })
  await ctx.store.record(ctx.scope, { eventId: 'message:bot:group:bot-reply', message: {
    time: '2026-10-03 12:00:01', message_id: 'bot-reply', sender: { user_id: 'bot', nickname: 'Bot' }, content: 'reply'
  } })
  await ctx.owner.commitPromptCacheTurn({ cacheTurn: first }, { _promptCacheDeliveryIds: ['bot-reply'] })
  await ctx.manager.recordMessage(ctx.makeEvent('new-bystander'))
  ctx.states.set('observer', { status: 'tool_success', toolName: 'probe', messageId: 'observer' })
  const second = await ctx.prepare(ctx.makeEvent('current-two', 'user-two'), { emotion: 'sad', memory: 'user-two likes books', time: 'second time' })
  assert.equal(first.userRow.content, firstUserBytes)
  const storedToolRequest = toolRequest.messages.map((row, index) => index === first.toolBase.length - 1 ? first.historyUserRow : row)
  const storedChatRequest = chatRequest.messages.map((row, index) => index === first.chatBase.length - 1 ? first.historyUserRow : row)
  const originalRows = view => [{ role: 'system', content: view === 'tools' ? second.header.toolSystem : second.header.chatSystem },
    ...second.snapshot.blocks.filter(block => !block.contextNotes).flatMap(block => replayRows(block, view))]
  assert.deepEqual(originalRows('tools').slice(0, storedToolRequest.length), storedToolRequest)
  assert.deepEqual(originalRows('chat').slice(0, storedChatRequest.length), storedChatRequest)
  assert.ok(second.toolBase.some(row => row.content?.includes('QQ=user-one memory="user-one likes music"')))
  assert.equal(second.userRow.content.includes('user-one likes music'), false)
  assert.equal(second.chatBase.some(row => row.content?.includes('first time')), false)
  assert.equal(second.chatBase.find(row => row.content === 'reply').reasoning_content, 'exact final reasoning bytes')
  assert.equal(second.toolBase.find(row => row.content === 'reply').reasoning_content, undefined)
  assert.ok(second.userRow.content.includes('probe=success'))
  assert.ok(second.userRow.content.includes('user-two'))
  assert.equal(second.toolBase.filter(row => row.content === 'reply').length, 1)
  assert.ok(second.toolBase.some(row => row.content?.includes('new-bystander')))
  await YTapi(ctx.request(second, [...second.toolBase], 'none'), ctx.config)
  assert.equal(requests.at(-2).tool_choice, 'none')
  assert.deepEqual(requests.at(-2).tools, [declaration])
  assert.deepEqual(originalRows('chat').slice(0, storedChatRequest.length), storedChatRequest)
})

test('six turns keep one transient reference wrapper and compact changing data without rewriting conversation rows', async () => {
  const ctx = await context()
  let previousHistory = []
  for (let index = 0; index < 6; index++) {
    const content = `full user body ${index}\nquoted text\n[image https://example.test/${index}.png]`
    const turn = await ctx.prepare(ctx.makeEvent(`ephemeral-${index}`), { memory: `snapshot-${index} ${'large memory '.repeat(400)}` }, content)
    assert.equal(turn.historyUserRow.content, content)
    assert.ok(Object.isFrozen(turn.historyUserRow))
    assert.ok(Object.isFrozen(turn.userRow))
    for (const messages of [turn.toolBase, turn.chatMessages()]) {
      assert.equal(messages.filter(row => row.content?.includes(TURN_REFERENCE_START)).length, 1)
      assert.ok(messages.at(-1).content.includes(`snapshot-${index}`))
      assert.deepEqual(messages.slice(1, 1 + previousHistory.length), previousHistory)
    }
    turn.finalReply = freezeWire({ role: 'assistant', content: `reply-${index}` })
    await ctx.owner.commitPromptCacheTurn({ cacheTurn: turn }, {})
    const snapshot = await ctx.store.read(ctx.scope, ctx.header, turn.settings)
    for (const block of snapshot.blocks) {
      for (const row of [...replayRows(block, 'tools'), ...replayRows(block, 'chat')]) assert.equal(row.content?.includes(TURN_REFERENCE_START), false)
    }
    previousHistory = snapshot.blocks.flatMap(block => replayRows(block, 'tools'))
    assert.equal(snapshot.blocks.at(-1).toolRows[0].content, content)
    assert.ok(snapshot.blocks.filter(block => block.contextNotes).length <= 4)
  }
})

test('terminal tool path persists complete native protocol without another model request', async () => {
  const ctx = await context()
  const turn = await ctx.prepare(ctx.makeEvent('terminal'))
  let requested = false
  const owner = {
    config: { maxToolRounds: 5 },
    dedupeToolCalls: toolExecutorMethods.dedupeToolCalls,
    normalizeAssistantToolMessage: toolExecutorMethods.normalizeAssistantToolMessage,
    runToolCall: async call => ({ toolCall: call, toolName: 'probe', result: 'sent', _executed: true, _terminal: true }),
    recordToolHistoryBatch: async () => {},
    buildRequestData() { requested = true }
  }
  const session = { cacheTurn: turn, tools: [declaration] }
  await toolExecutorMethods.processToolCalls.call(owner, assistantCall, {}, session, [...turn.toolBase], [], 'member')
  assert.equal(requested, false)
  assert.equal(turn.toolTail.length, 2)
  await ctx.owner.commitPromptCacheTurn(session, {})
  const snapshot = await ctx.store.read(ctx.scope, ctx.header, turn.settings)
  assert.equal(snapshot.blocks.at(-1).toolRows.at(-1).role, 'tool')
})

test('declared tools cannot bypass per-turn execution whitelist', async () => {
  let executed = false
  const owner = {
    toolInstances: { probe: {} },
    executeTool: async () => { executed = true },
    isDedupeTool: () => false
  }
  const result = await toolExecutorMethods.runToolCall.call(owner, assistantCall.tool_calls[0], {}, {
    tools: [declaration], allowedToolNames: new Set(['other'])
  })
  assert.equal(executed, false)
  assert.equal(result._executed, false)
  assert.match(result.result, /not available/)
})

test('V1 requests still use original flattening adapter and strip tools for chat', async () => {
  const ctx = await context()
  const before = requests.length
  await YTapi({ model: 'test-model', messages: [
    { role: 'system', content: 'persona\n【工具调用】\nchoose\n【工具使用隐藏规则】\nhide' },
    { role: 'assistant', content: '【系统提示】: bridge' }, { role: 'user', content: 'current' }
  ], tools: [declaration], tool_choice: 'auto' }, ctx.config)
  const chat = requests.slice(before).find(request => !request.tools)
  assert.ok(chat)
  assert.equal(chat.messages.some(row => row.content?.includes('bridge')), false)
  assert.equal(chat.messages[0].content.includes('choose'), false)
})

test('pasted QQ/time text cannot pin the V2 source cursor behind filterChatByQQ', async () => {
  const ctx = await context()
  const pasted = ctx.makeEvent('pasted', 'other')
  pasted.msg = '[2026-10-03 11:11:11] Mentioned(qq号: user-two)[群身份: member]: pasted history'
  await ctx.manager.recordMessage(pasted)
  const diagnostics = []
  const previousInfo = globalThis.logger.info
  globalThis.logger.info = value => diagnostics.push(value)
  ctx.config.promptCache.diagnostics = true
  try {
    const first = await ctx.prepare(ctx.makeEvent('after-paste', 'user-two'), {}, 'current trigger without sender metadata')
    assert.ok(first.toolBase.some(row => row.content?.includes('pasted history')))
    assert.ok(first.userRow.content.includes('current trigger without sender metadata'))
    await ctx.owner.commitPromptCacheTurn({ cacheTurn: first }, {})
    assert.ok(diagnostics.some(value => value.includes('qq_filter_bypassed')))
    const second = await ctx.prepare(ctx.makeEvent('following', 'user-two'), {}, 'following trigger')
    assert.equal(second.snapshot.cursor, first.snapshot.readUntil)
    await ctx.owner.commitPromptCacheTurn({ cacheTurn: second }, {})
    const snapshot = await ctx.store.read(ctx.scope, ctx.header, second.settings)
    assert.equal(snapshot.cursor, second.snapshot.readUntil)
  } finally { globalThis.logger.info = previousInfo }
})

test('disabled diagnostics does not encode the unused tool view on chat-only requests', async () => {
  const ctx = await context()
  const turn = await ctx.prepare(ctx.makeEvent('no-diagnostics'))
  const request = ctx.request(turn)
  Object.defineProperty(request.messages, 'toJSON', { value() { throw new Error('unused tool view was encoded') } })
  const response = await YTapi(request, { ...ctx.config, useTools: false })
  assert.equal(response.choices[0].message.content, 'reply')
})
