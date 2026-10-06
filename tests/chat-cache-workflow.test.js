import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import http from 'node:http'
import { once } from 'node:events'
import { redisFixture } from './helpers/redis-fixture.js'
import { contextStore, ContextStore } from '../core/contextStore.js'
import { wireClone, originKeyForEvent, tokenEstimate } from '../core/promptCache.js'
import { TURN_REFERENCE_START } from '../core/prompts.js'

register('./helpers/yunzai-cache-loader.mjs', import.meta.url)
globalThis.plugin = class {}
const errors = []
globalThis.logger = { debug() {}, info() {}, warn() {}, error(...args) { errors.push(args.map(String).join(' ')) } }
globalThis.Bot = { uin: 'bot', nickname: 'Bot' }
const { ChatPlugin } = await import('../apps/chat.js')
const { MessageManager, getV2MessageManager } = await import('../utils/MessageManager.js')

let fixture
let server
let endpoint
let groupNumber = 9000
let workflowNumber = 0
let mode = 'text'
let decisions = 0
let selectedTool = 'probe'
const requests = []

before(async () => {
  fixture = await redisFixture()
  globalThis.redis = fixture.client
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    const body = JSON.parse(raw)
    requests.push(body)
    response.setHeader('content-type', 'application/json')
    if (mode === 'failure') { response.statusCode = 503; response.end(JSON.stringify({ error: { message: 'test failure' } })); return }
    let message = { role: 'assistant', content: mode === 'empty' ? '' : 'OK' }
    if (mode === 'raw-text') message = { role: 'assistant', content: 'RAW final text '.repeat(80), reasoning_content: 'native reasoning', signature: 'native signature' }
    if (body.tools && (++decisions === 1 || mode === 'round-limit') && ['tool', 'terminal', 'forced', 'round-limit'].includes(mode)) {
      message = { role: 'assistant', content: '', tool_calls: [{ id: `call-${groupNumber}-${decisions}`, type: 'function', function: { name: selectedTool, arguments: '{}' } }] }
    }
    if (body.tools && decisions === 1 && mode === 'malformed') {
      message = { role: 'assistant', content: '', tool_calls: [{ id: 'bad', type: 'unsupported', function: { name: 'probe', arguments: '{}' } }] }
    }
    response.end(JSON.stringify({ choices: [{ message }], usage: { prompt_tokens: 1200, prompt_tokens_details: { cached_tokens: 900 }, completion_tokens: 1 } }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
})
after(async () => {
  if (server) await new Promise(resolve => server.close(resolve))
  await fixture?.stop()
})

async function workflow({ enabled = true, currentMode = 'text', message = 'hello', tool = 'probe', video = false, groupId, useTools = true,
  textImage = false, store = null, identityFailure = false, singleStage = false, sendFailure = false, dedupe = false, configure, afterDispatch } = {}) {
  mode = currentMode
  selectedTool = tool
  decisions = 0
  requests.length = 0
  errors.length = 0
  const group = String(groupId || ++groupNumber)
  const instanceId = ++workflowNumber
  const owner = Object.create(ChatPlugin.prototype)
  if (store) owner.contextStore = store
  owner.config = {
    enabled: true, providers: 'oneapi', groupHistory: true, useTools,
    promptCache: { enabled, groups: [group], diagnostics: false, singleStage, singleStageGroups: [group],
      agentToolPolicies: { probe: { category: 'read' } } },
    groupMaxMessages: 30, groupChatMemoryDays: 1, concurrentLimit: 3, chatTriggerMode: 'strict',
    maxToolRounds: currentMode === 'round-limit' ? 1 : 5,
    forcedAvatarMode: true, segmentedReplyEnabled: false, oneapi_tools: ['probe'],
    emotionSystem: { enabled: true }, memorySystem: { enabled: true }, expressionLearning: { enabled: true },
    toolsAiConfig: { toolsAiUrl: endpoint, toolsAiModel: 'test-model', toolsAiApikey: 'test-key' },
    chatAiConfig: { chatApiUrl: endpoint, chatApiModel: 'test-model', chatApiKey: ['test-key'] }
  }
  configure?.(owner.config)
  owner.sessionMap = new Map()
  owner.messageManager = new MessageManager()
  owner.messageHistoriesRedisKey = 'group_user_message_history'
  owner.messageHistoriesDir = fixture.directory
  owner.REDIS_KEY_PREFIX = 'ytbot:messages:'
  owner.TASK_STATUS_PREFIX = 'ytbot:tool_task_status:'
  owner.MAX_HISTORY = 30
  owner.dedupeToolNames = new Set(dedupe ? ['probe'] : [])
  owner.refreshLocalToolRegistry = async () => {}
  owner.waitForMCPReady = async () => {}
  owner.getCurrentGroupContext = async () => ({ groupId: group, groupName: 'Group', groupNotice: 'current notice' })
  owner.recordReplyLatency = () => {}
  owner.emotionManager = { getEmotionPromptForGroup: async () => 'current mood' }
  owner.memoryManager = { getMemoryPromptForUser: async () => 'user memory', getGroupMemoryPrompt: async () => 'group memory' }
  owner.expressionLearner = { getExpressionPromptForGroup: async () => 'current style' }
  owner.knowledgeSearcher = { search: async () => ({ knowledgeContext: 'reference knowledge' }) }
  owner.updateEnhancedSystems = async () => {}
  owner.executions = []
  const names = ['probe', 'videoAnalysisTool', 'googleImageEditTool', 'aiMindMapTool', 'grabRedBagTool']
  owner.functionMap = new Map(names.map(name => [name, { name, description: name, parameters: { properties: {}, required: [] } }]))
  owner.toolInstances = Object.fromEntries(names.map(name => [name, { async execute() {
    owner.executions.push(name)
    afterDispatch?.(owner.config)
    return currentMode === 'terminal' ? { terminal: true, result: 'sent' } : 'success'
  } }]))
  owner.tools = owner.getToolsByName(['probe'])
  if (textImage) {
    owner.shouldUseTextImageForFinalReply = () => true
    owner.toolInstances.textImageTool = { async execute(_params, event) { await event.reply('rendered image'); return 'sent' } }
  }
  const pickedGroup = {
    pickMember(id) { return { info: { role: 'member' }, getInfo: async () => {
      if (identityFailure) throw new Error('identity unavailable')
      return { card: String(id) === String(Bot.uin) ? 'Bot' : 'Alice', role: 'member' }
    } } },
    getMemberMap: async () => new Map(), name: 'Group'
  }
  const replies = []
  const e = {
    message_type: 'group', self_id: String(Bot.uin), group_id: group, user_id: '42', message_id: `user-${group}-${instanceId}`,
    msg: message, time: Math.floor(Date.now() / 1000), message: [{ type: 'text', text: message }], sender: { user_id: '42', nickname: 'Alice', role: 'member' },
    group: pickedGroup, bot: { uin: Bot.uin, pickGroup: () => pickedGroup },
    async reply(content) { if (sendFailure) throw new Error('test send failure'); replies.push(content); return { message_id: `reply-${group}-${instanceId}-${replies.length}` } }
  }
  if (video) e.getReply = async () => ({ sender: { user_id: '42', nickname: 'Alice' }, message_id: 'quoted', message: [{ type: 'video', url: 'https://example.test/video.mp4' }] })
  await owner.messageManager.recordMessage(e)
  const sessions = []
  const originalSession = owner.getOrCreateSession
  owner.getOrCreateSession = function (...args) { const session = originalSession.apply(this, args); sessions.push(session); return session }
  assert.equal(await owner.handleTool(e), true)
  assert.equal(owner.sessionMap.size, 0)
  return { owner, e, replies, session: sessions[0], group }
}

test('actual agent text sends one request with full current data and commits raw final fields only once', async () => {
  const result = await workflow({ singleStage: true, currentMode: 'raw-text' })
  assert.equal(result.session.cacheTurn.mode, 'agent')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].tool_choice, 'auto')
  assert.equal(requests[0].temperature, 0.85)
  assert.ok(requests[0].messages.at(-1).content.includes('current mood'))
  assert.ok(!requests[0].messages[0].content.includes('你只负责判断'))
  const turn = result.session.cacheTurn
  const snapshot = await contextStore.read(turn.scope, turn.header, turn.settings)
  const block = snapshot.blocks.at(-1)
  assert.equal(block.replayVersion, 3)
  assert.equal('toolRows' in block, false)
  assert.equal(block.apiRows.at(-1).content, 'RAW final text '.repeat(80))
  assert.equal(block.apiRows.at(-1).signature, 'native signature')
  assert.equal(block.apiRows.at(-1).reasoning_content, 'native reasoning')
  assert.ok(!block.apiRows[0].content.includes('本轮参考资料'))
  assert.equal(result.replies.length, 1)
  assert.equal(block.delivery.status, 'sent')
})

test('unchanged second/third agent turns omit reference data and reuse their frozen prefix', async () => {
  const first = await workflow({ singleStage: true })
  const second = await workflow({ singleStage: true, groupId: first.group, message: 'second' })
  const tail = second.session.cacheTurn.userRow.content
  for (const old of ['current mood', 'user memory', 'group memory', 'current style', 'reference knowledge', 'current notice', '成员 ']) assert.equal(tail.includes(old), false)
  assert.ok(tail.includes('"currentUserQQ":"42"'))
  assert.ok(tail.includes('"allowedTools"'))
  const third = await workflow({ singleStage: true, groupId: first.group, message: 'third' })
  const base = second.session.cacheTurn.agentBase
  assert.deepEqual(third.session.cacheTurn.agentBase.slice(0, base.length - 1), base.slice(0, -1))
  assert.ok(third.session.cacheTurn.agentBase.some(row => row.content?.includes('user memory')))
  const tailTokens = item => tokenEstimate(item.session.cacheTurn.userRow.content.slice(item.session.cacheTurn.userRow.content.indexOf(TURN_REFERENCE_START)))
  assert.ok(tailTokens(second) < tailTokens(first))
  console.log(`tail-slim token estimate: first=${tailTokens(first)}, unchanged=${tailTokens(second)}, third=${tailTokens(third)}`)
})

test('actual dedupe tool outcome is recorded and suppresses both terminal facts and duplicate history', async () => {
  const first = await workflow({ singleStage: true, currentMode: 'tool', dedupe: true })
  assert.equal(first.session.cacheTurn.taskOutcomes.length, 1)
  assert.equal(first.session.cacheTurn.block().taskOutcomes[0].status, 'tool_success')
  const second = await workflow({ singleStage: true, groupId: first.group, dedupe: true, message: 'after the tool' })
  assert.equal(second.session.cacheTurn.userRow.content.includes('probe=success'), false)
  assert.equal(second.session.cacheTurn.userRow.content.includes('工具 消息'), false)
})

test('actual agent native tool continuation uses two requests and terminal uses one', async () => {
  const result = await workflow({ singleStage: true, currentMode: 'tool' })
  assert.deepEqual(result.owner.executions, ['probe'])
  assert.deepEqual(result.replies, ['OK'])
  assert.equal(requests.length, 2)
  assert.deepEqual(requests[1].messages.slice(0, requests[0].messages.length), requests[0].messages)
  assert.deepEqual(requests[1].tools, requests[0].tools)
  assert.ok(requests[1].messages.some(row => row.role === 'tool'))
  assert.ok(!requests[1].messages.some(row => row.content?.includes('[tool_execution]')))
  const terminal = await workflow({ singleStage: true, currentMode: 'terminal' })
  assert.equal(requests.length, 1)
  assert.equal(terminal.session.cacheTurn.exitReason, 'terminal')
  const snapshot = await contextStore.read(terminal.session.cacheTurn.scope, terminal.session.cacheTurn.header, terminal.session.cacheTurn.settings)
  assert.equal(snapshot.blocks.at(-1).apiRows.at(-1).role, 'tool')
})

test('actual agent forced scenes keep full schemas and verify successful required actions', async () => {
  for (const scene of [
    { message: '头像编辑', tool: 'googleImageEditTool' },
    { message: '做个思维导图', tool: 'aiMindMapTool' },
    { message: '分析视频', tool: 'videoAnalysisTool', video: true }
  ]) {
    const result = await workflow({ ...scene, singleStage: true, currentMode: 'forced' })
    assert.deepEqual(result.owner.executions, [scene.tool])
    assert.deepEqual(result.session.cacheTurn.agentControls.requiredTools, [scene.tool])
    assert.ok(requests.every(request => request.tools.length > 1 && request.tool_choice === 'auto'))
    assert.equal(requests.length, 2)
  }
})

test('negated forced keywords do not force editing or drawing in actual agent requests', async () => {
  for (const message of ['不要头像编辑', '不要生成思维导图']) {
    const result = await workflow({ singleStage: true, message })
    assert.deepEqual(result.owner.executions, [])
    assert.deepEqual(result.session.cacheTurn.agentControls.requiredTools, [])
    assert.equal(requests.length, 1)
  }
})

test('actual agent budget/empty/API-failure paths commit complete blocks and release the session', async () => {
  const limited = await workflow({ singleStage: true, currentMode: 'round-limit' })
  assert.equal(limited.owner.executions.length, 1)
  assert.equal(requests.length, 3)
  assert.equal(limited.session.cacheTurn.exitReason, 'tool_budget')
  assert.ok(requests.every(request => request.tools.length && request.tool_choice === 'auto'))
  for (const currentMode of ['empty', 'failure']) {
    const result = await workflow({ singleStage: true, currentMode })
    assert.equal(result.session.cacheTurn.mode, 'agent')
    const snapshot = await contextStore.read(result.session.cacheTurn.scope, result.session.cacheTurn.header, result.session.cacheTurn.settings)
    assert.equal(snapshot.blocks.at(-1).apiRows[0].role, 'user')
    assert.equal(snapshot.blocks.at(-1).exitReason, currentMode === 'empty' ? 'empty' : 'api_error')
  }
})

test('actual dual-agent-dual-agent switching retains native results and consumed sequence', async () => {
  const first = await workflow()
  const second = await workflow({ groupId: first.group, singleStage: true, currentMode: 'tool' })
  const third = await workflow({ groupId: first.group })
  assert.equal(third.session.cacheTurn.mode, 'dual')
  assert.ok(requests.some(request => request.messages.some(row => row.content?.includes('[tool_execution]'))))
  const fourth = await workflow({ groupId: first.group, singleStage: true })
  assert.equal(requests.length, 1)
  assert.ok(requests[0].messages.some(row => row.role === 'tool' && row.content === 'success'))
  const snapshot = await contextStore.read(fourth.session.cacheTurn.scope, fourth.session.cacheTurn.header, fourth.session.cacheTurn.settings)
  assert.ok(snapshot.cursor >= second.session.cacheTurn.snapshot.readUntil)
  assert.deepEqual(snapshot.blocks.filter(block => block.turnId).map(block => block.mode || 'dual'), ['dual', 'agent', 'dual', 'agent'])
})

test('actual agent pins its mode, model and declarations despite a config change during dispatch', async () => {
  const result = await workflow({ singleStage: true, currentMode: 'tool', afterDispatch: config => {
    config.promptCache.singleStage = false
    config.chatAiConfig.chatApiModel = 'changed-live-model'
    config.useTools = false
  } })
  assert.equal(result.session.cacheTurn.mode, 'agent')
  assert.equal(requests.length, 2)
  assert.ok(requests.every(request => request.model === 'test-model' && request.tools.length && request.tool_choice === 'auto'))
  assert.deepEqual(result.replies, ['OK'])
})

test('actual concurrent mixed-mode turns append complete blocks to the same source ledger', async () => {
  const seed = await workflow()
  const [dual, agent] = await Promise.all([
    workflow({ groupId: seed.group }), workflow({ groupId: seed.group, singleStage: true })
  ])
  const turn = agent.session.cacheTurn
  const snapshot = await contextStore.read(turn.scope, turn.header, turn.settings)
  const modes = snapshot.blocks.filter(block => block.turnId).map(block => block.mode || 'dual').sort()
  assert.deepEqual(modes, ['agent', 'dual', 'dual'])
  assert.ok(snapshot.cursor >= Math.max(dual.session.cacheTurn.snapshot.readUntil, turn.snapshot.readUntil))
  assert.equal(dual.session.cacheTurn.scope.resetId, turn.scope.resetId)
})

test('actual agent display image receipts suppress duplicate Bot replay and failed sends create no fake Bot journal event', async () => {
  const image = await workflow({ singleStage: true, textImage: true })
  assert.deepEqual(image.replies, ['rendered image'])
  assert.ok(image.session.cacheTurn.delivery.syntheticOrigin)
  const next = await workflow({ groupId: image.group, singleStage: true })
  assert.equal(next.session.cacheTurn.agentBase.filter(row => row.role === 'assistant').length, 1)
  const failed = await workflow({ singleStage: true, sendFailure: true })
  assert.equal(failed.replies.length, 0)
  assert.equal(failed.session.cacheTurn.exitReason, 'reply_failed')
  const snapshot = await contextStore.read(failed.session.cacheTurn.scope, failed.session.cacheTurn.header, failed.session.cacheTurn.settings)
  assert.equal(snapshot.blocks.at(-1).delivery.status, 'failed')
  assert.equal(snapshot.blocks.at(-1).apiRows.at(-1).content, 'OK')
  assert.equal(snapshot.events.length, 0)
})

test('actual agent without tools sends one chat request and follows agent mode during identity lookup failure', async () => {
  const first = await workflow({ singleStage: true, useTools: false })
  assert.equal(requests.length, 1)
  assert.equal('tools' in requests[0], false)
  assert.deepEqual(first.owner.executions, [])
  const second = await workflow({ singleStage: true, useTools: false, groupId: first.group, identityFailure: true })
  assert.equal(second.session.cacheTurn.header.version, first.session.cacheTurn.header.version)
  assert.ok(second.session.cacheTurn.header.agentSystem.includes('【对话与动作职责】'))
})

test('invalid opted-in agent configuration is rejected before any model request instead of widening action policy', async () => {
  const result = await workflow({ singleStage: true, configure: config => { config.promptCache.agentSideEffectPolicy = 'typo' } })
  assert.equal(requests.length, 0)
  assert.deepEqual(result.owner.executions, [])
  assert.ok(errors.some(error => error.includes('invalid_agent_action_policy')))
})

test('actual handleTool sends a full dynamic snapshot but commits only body and reply', async () => {
  const result = await workflow()
  assert.deepEqual(result.replies, ['OK'])
  assert.ok(result.session.cacheTurn)
  assert.deepEqual(errors, [])
  const user = result.session.cacheTurn.userRow.content
  for (const expected of ['current mood', 'user memory', 'group memory', 'current style', 'reference knowledge', 'current notice', '北京时间']) assert.ok(user.includes(expected), expected)
  assert.equal(requests[0].messages[0].content.includes('current mood'), false)
  const snapshot = await contextStore.read(result.session.cacheTurn.scope, result.session.cacheTurn.header, result.session.cacheTurn.settings)
  const block = snapshot.blocks.at(-1)
  assert.equal(block.toolRows[0].content, result.session.cacheTurn.historyUserRow.content)
  assert.equal(block.chatRows[0].content, result.session.cacheTurn.historyUserRow.content)
  for (const expected of ['current mood', 'user memory', 'group memory', 'current style', 'reference knowledge', 'current notice', '本轮参考资料']) {
    assert.equal(block.toolRows[0].content.includes(expected), false, expected)
    assert.equal(block.chatRows[0].content.includes(expected), false, expected)
  }
  for (const request of requests) assert.ok(request.messages.some(row => row.content?.includes('current mood')))
  assert.equal(snapshot.blocks.at(-1).toolRows.at(-1).role, 'assistant')
  assert.ok(snapshot.cursor > 0)
})

test('actual tool continuation and terminal paths commit paired tool rows', async () => {
  const normal = await workflow({ currentMode: 'tool' })
  assert.deepEqual(normal.owner.executions, ['probe'])
  assert.deepEqual(normal.replies, ['OK'])
  assert.deepEqual(errors, [])
  const terminal = await workflow({ currentMode: 'terminal' })
  assert.deepEqual(terminal.owner.executions, ['probe'])
  assert.deepEqual(terminal.replies, [])
  assert.equal(requests.length, 1)
  assert.deepEqual(errors, [])
  const snapshot = await contextStore.read(terminal.session.cacheTurn.scope, terminal.session.cacheTurn.header, terminal.session.cacheTurn.settings)
  assert.equal(snapshot.blocks.at(-1).toolRows.at(-1).role, 'tool')
})

test('actual no-text and API-failure paths still commit the input and release sessions', async () => {
  for (const currentMode of ['empty', 'failure']) {
    const result = await workflow({ currentMode })
    assert.ok(result.session.cacheTurn)
    assert.deepEqual(result.replies, [])
    const snapshot = await contextStore.read(result.session.cacheTurn.scope, result.session.cacheTurn.header, result.session.cacheTurn.settings)
    assert.equal(snapshot.blocks.at(-1).toolRows.at(-1).role, 'user')
    assert.ok(snapshot.cursor > 0)
  }
})

test('actual avatar/video/mind-map forced paths retain singleton schemas and allowed tools', async () => {
  for (const scene of [
    { message: '头像编辑', tool: 'googleImageEditTool' },
    { message: '思维导图', tool: 'aiMindMapTool' },
    { message: '看这个视频', tool: 'videoAnalysisTool', video: true }
  ]) {
    const result = await workflow({ ...scene, currentMode: 'forced' })
    assert.deepEqual(result.owner.executions, [scene.tool])
    assert.deepEqual([...result.session.allowedToolNames], [scene.tool])
    assert.deepEqual(requests[0].tools.map(item => item.function.name), [scene.tool])
    assert.deepEqual(errors, [])
    if (scene.tool === 'googleImageEditTool') assert.ok(result.session.cacheTurn.userRow.content.includes('https://q1.qlogo.cn/'))
    if (scene.video) assert.ok(result.session.cacheTurn.userRow.content.includes('https://example.test/video.mp4'))
  }
})

test('V1 actual workflow remains flattened and does not create V2 state', async () => {
  const before = await fixture.client.keys('ytbot:ctx:v2:*')
  const result = await workflow({ enabled: false })
  assert.equal(result.session.cacheTurn, undefined)
  assert.ok(requests[0].messages.some(row => row.role === 'assistant' && row.content.includes('收到，我会')))
  assert.deepEqual(result.replies, ['OK'])
  assert.deepEqual(await fixture.client.keys('ytbot:ctx:v2:*'), before)
  assert.deepEqual(errors, [])
})

test('unified V2 manager keeps receive-text limit distinct from Bot synthetic replies', async () => {
  const config = { promptCache: { enabled: true, groups: ['length-test'] } }
  const manager = getV2MessageManager(config)
  assert.equal(manager, getV2MessageManager(wireClone(config)))
  const message = { message_type: 'group', group_id: 'length-test', self_id: 'bot', message_id: 'long',
    time: Math.floor(Date.now() / 1000), sender: { user_id: 'user', nickname: 'User' }, message: [{ type: 'text', text: 'x'.repeat(1000) }] }
  await manager.recordMessage(message, { messageMaxLength: 200 })
  const rows = await manager.getMessages('group', 'length-test')
  assert.ok(rows[0].content.length <= 200)
  const long = await manager.formatMessageContent(message)
  assert.ok(long.length > 200)
})

test('reenabling V2 backfills same-day messages collected by V1 without duplicating known source events', async () => {
  const config = { promptCache: { enabled: true, groups: ['resume'] } }
  const manager = getV2MessageManager(config)
  const make = id => ({ message_type: 'group', group_id: 'resume', self_id: 'bot', message_id: id, time: Math.floor(Date.now() / 1000),
    sender: { user_id: 'user', nickname: 'User' }, message: [{ type: 'text', text: id }] })
  await manager.recordMessage(make('before-off'), { messageMaxLength: 200 })
  getV2MessageManager({ promptCache: { enabled: false, groups: ['resume'] } })
  const legacy = new MessageManager()
  await legacy.recordMessage(make('while-off'))
  getV2MessageManager(config)
  await manager.recordMessage(make('after-on'), { messageMaxLength: 200 })
  const scope = await contextStore.scope('bot', 'resume')
  assert.equal((await contextStore.lookup(scope, originKeyForEvent(make('before-off')))).seq, 1)
  assert.equal((await contextStore.lookup(scope, originKeyForEvent(make('while-off')))).seq, 2)
  assert.equal((await contextStore.lookup(scope, originKeyForEvent(make('after-on')))).seq, 3)
})

test('round-limit compatibility removes declarations before final natural reply', async () => {
  const result = await workflow({ currentMode: 'round-limit' })
  assert.deepEqual(result.owner.executions, ['probe'])
  assert.deepEqual(result.replies, ['OK'])
  assert.deepEqual(requests.slice(-2).map(request => 'tools' in request), [false, false])
  assert.deepEqual(errors, [])
})

test('V2 without tools sends one natural-chat request without decision instructions', async () => {
  const result = await workflow({ useTools: false })
  assert.deepEqual(result.replies, ['OK'])
  assert.equal(requests.length, 1)
  assert.equal('tools' in requests[0], false)
  assert.equal(requests[0].messages[0].content.includes('你只负责判断当前需不需要调用工具'), false)
  assert.deepEqual(errors, [])
})

test('actual concurrent same-group workflows append complete independent turns', async () => {
  const groupId = String(++groupNumber)
  const [first, second] = await Promise.all([
    workflow({ currentMode: 'tool', groupId, message: 'first request' }),
    workflow({ currentMode: 'tool', groupId, message: 'second request' })
  ])
  assert.deepEqual(first.replies, ['OK'])
  assert.deepEqual(second.replies, ['OK'])
  assert.deepEqual(errors, [])
  const snapshot = await contextStore.read(first.session.cacheTurn.scope, first.session.cacheTurn.header, first.session.cacheTurn.settings)
  const turns = snapshot.blocks.filter(item => item.turnId)
  assert.equal(turns.length, 2)
  assert.notEqual(turns[0].turnId, turns[1].turnId)
  assert.ok(snapshot.cursor >= 2)
})

test('text-image synthetic reply is represented without a real message_id', async () => {
  const first = await workflow({ textImage: true })
  assert.deepEqual(first.replies, ['rendered image'])
  const turn = first.session.cacheTurn
  const snapshot = await contextStore.read(turn.scope, turn.header, turn.settings)
  const reply = snapshot.events.find(event => event.eventId === `reply:${turn.turnId}`)
  assert.ok(reply)
  assert.equal(reply.message.message_id, null)
  assert.equal(reply.represented, true)
  const second = await workflow({ groupId: first.group })
  assert.equal(second.session.cacheTurn.toolBase.filter(row => row.role === 'assistant').length, 1)
})

test('numeric Bot.uin and string sender id retain the Bot identity', async () => {
  const previous = Bot.uin
  Bot.uin = 12345
  try {
    const result = await workflow()
    const rows = await result.owner.messageManager.getMessages('group', result.group)
    const reply = rows.find(row => String(row.sender.user_id) === '12345')
    assert.ok(reply)
    assert.equal(reply.sender.role, 'bot')
    assert.equal(reply.sender.identity, '[Bot]')
  } finally { Bot.uin = previous }
})

test('malformed tool calls still reach a final reply and commit a valid turn', async () => {
  const result = await workflow({ currentMode: 'malformed' })
  assert.deepEqual(result.owner.executions, [])
  assert.deepEqual(result.replies, ['OK'])
  assert.deepEqual(errors, [])
  const turn = result.session.cacheTurn
  assert.deepEqual(turn.toolTail, [])
  const snapshot = await contextStore.read(turn.scope, turn.header, turn.settings)
  assert.equal(snapshot.blocks.at(-1).toolRows.at(-1).role, 'assistant')
})

test('scope, header, source and commit all use the injected context store', async () => {
  const store = new ContextStore(fixture.client, 'test:injected:')
  let headerReads = 0
  const originalHeader = store.header.bind(store)
  store.header = async (...args) => { headerReads++; return originalHeader(...args) }
  const first = await workflow({ store })
  assert.ok(first.session.cacheTurn.scope.root.startsWith(store.prefix))
  await workflow({ store, groupId: first.group, identityFailure: true })
  assert.equal(headerReads, 1)
  const snapshot = await store.read(first.session.cacheTurn.scope, first.session.cacheTurn.header, first.session.cacheTurn.settings)
  assert.equal(snapshot.blocks.filter(block => block.turnId).length, 2)
})
