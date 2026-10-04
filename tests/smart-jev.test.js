import test, { before, after, beforeEach, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { register } from 'node:module'
import fs from 'node:fs'
import YAML from 'yaml'
import { tokenEstimate } from '../core/promptCache.js'

register('./helpers/yunzai-cache-loader.mjs', import.meta.url)
const logs = []
globalThis.logger = Object.fromEntries(['info', 'warn', 'error', 'debug'].map(level => [level, text => logs.push(String(text))]))
globalThis.Bot = { nickname: '测试bot', uin: '100' }
const { conversationTrackerMethods } = await import('../core/conversationTracker.js')
const { MessageManager } = await import('../utils/MessageManager.js')
const nativeFetch = globalThis.fetch
let server, endpoint, sequence = 0
let flashStatus, flashContent
const flashRequests = []
const jevRequests = []

before(async () => {
  tokenEstimate('warmup')
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    flashRequests.push(JSON.parse(raw))
    response.writeHead(flashStatus, { 'Content-Type': 'application/json' })
    response.end(JSON.stringify(flashStatus >= 400 ? { error: 'test failure' } : { choices: [{ message: { content: flashContent } }] }))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  endpoint = `http://127.0.0.1:${server.address().port}/v1/chat/completions`
})
after(async () => { server.closeAllConnections(); await new Promise(resolve => server.close(resolve)) })
beforeEach(() => {
  logs.length = flashRequests.length = jevRequests.length = 0
  flashStatus = 200
  flashContent = JSON.stringify({ decision: 'wait', wait_seconds: 7, reason: 'original flash' })
})
afterEach(() => { globalThis.fetch = nativeFetch })

function jev(answer, status = 200) {
  globalThis.fetch = async (_url, options) => {
    const body = JSON.parse(options.body)
    jevRequests.push(body)
    const result = typeof answer === 'function' ? answer(body) : { answers: { gate: answer } }
    if (result instanceof Response) return result
    return new Response(JSON.stringify(result), { status, headers: { 'Content-Type': 'application/json' } })
  }
}
const choice = (selected = 'continue', p = { continue: 0.6, no_action: 0.3, wait: 0.1 }) => ({ type: 'choice', choice: selected, probabilities: p, confidence: 0.1 })
function setup({ history = [], track = {}, smart = {} } = {}) {
  const e = { self_id: '100', group_id: `smart-jev-${++sequence}`, user_id: '200', message_id: `m${sequence}`,
    msg: '继续聊聊', sender: { nickname: 'Member' }, message: [{ type: 'text', text: '继续聊聊' }] }
  const manager = new MessageManager()
  manager.getMessages = async () => history
  const owner = {
    ...conversationTrackerMethods,
    config: { chatTriggerMode: 'smart', batchJudgmentDelay: 0.001,
      trackAiConfig: { judgeProvider: 'typesafe', typesafeUrl: 'http://localhost/unused-jev', typesafeApiKey: 'test-key',
        typesafeGateThreshold: 0.5, trackAiUrl: endpoint, trackAiApikey: 'test-key', trackAiModel: 'gemini-3.8-flash', ...track },
      smartTrigger: { talkValue: 1, timingGateCooldownSeconds: 0, deferredGateEnabled: false, replyDebounceMs: 0, ...smart } },
    messageManager: manager, checkTriggers: () => false, isGroupChatAtCapacity: () => false,
    collectRepeatMessage() {}, tryJoinGroupRepeat: async () => false, checkGroupPermission: () => true,
    isMutedInGroup: async () => false, replies: [],
    async handleTool(event) { this.replies.push(event); event._conversationProducedOutput = true; return true }
  }
  const state = owner.getSmartState(e.group_id)
  return { e, owner, state, manager }
}

test('smart Jev works without flash configuration and logs the raw message on one line', async () => {
  jev(choice())
  const { owner, e, state } = setup({ track: { trackAiUrl: '', trackAiApikey: '' } })
  e.msg = '第一行\n"第二行"\t\u001b'
  const result = await owner.runTimingGate(e, state)
  assert.equal(result.decision, 'continue')
  assert.equal(result.provider, 'typesafe')
  assert.equal(flashRequests.length, 0)
  assert.equal(jevRequests.length, 1)
  assert.equal(jevRequests[0].state.currentMessage.text, e.msg)
  const line = logs.find(text => text.startsWith('[Gate][typesafe]'))
  assert.ok(line.includes('\\n'))
  assert.ok(line.includes('\\u001b'))
  assert.equal(line.includes('\n'), false)
  assert.ok(line.includes('continue (0.60) [cont 0.60/no 0.30/wait 0.10]'))
})

test('smart low-probability continue is logged as a veto and never calls flash', async () => {
  jev(choice('continue', { continue: 0.49, no_action: 0.3, wait: 0.21 }))
  const { owner, e, state } = setup()
  const result = await owner.runTimingGate(e, state)
  assert.equal(result.decision, 'no_action')
  assert.equal(result.rawChoice, 'continue')
  assert.equal(flashRequests.length, 0)
  assert.ok(logs.some(line => line.includes('raw=continue p=0.49 final=no_action reason=below_threshold')))
})

test('smart invalid Choice responses fall back to the original flash Gate', async () => {
  const invalid = [choice('invalid'), choice('continue', { continue: 0.6, no_action: 0.3, wait: 0.3 }),
    choice('continue', { continue: Infinity, no_action: 0.3, wait: 0.1 })]
  for (const answer of invalid) {
    jev(answer.probabilities?.continue === Infinity
      ? () => new Response('{"answers":{"gate":{"type":"choice","choice":"continue","probabilities":{"continue":1e400,"no_action":0.3,"wait":0.1}}}}')
      : answer)
    const { owner, e, state } = setup()
    const result = await owner.runTimingGate(e, state)
    assert.equal(result.decision, 'wait')
    assert.equal(result.wait_seconds, 7)
    assert.equal(result.provider, 'fallback-flash')
  }
  assert.equal(flashRequests.length, 3)
  assert.ok(logs.some(line => line.startsWith('[Gate][fallback-flash]') && line.includes('(n/a)')))
})

test('smart over-budget Jev input falls back without clipping flash history or mutating records', async () => {
  const history = Array.from({ length: 20 }, (_, i) => ({ time: `time-${i}`, group_name: 'Group', message_id: `history-${i}`,
    sender: { nickname: 'Member', user_id: '200', role: 'member' }, content: `original-${i} ${'history '.repeat(1200)}` }))
  const before = structuredClone(history)
  const { owner, e, state, manager } = setup({ history, smart: { gateContextSize: 20 } })
  const originalHistory = await manager.formatMessageHistory('group', e.group_id, 20)
  jev(choice())
  e.msg = '超长当前消息 '.repeat(18000)
  const result = await owner.runTimingGate(e, state)
  assert.equal(result.provider, 'fallback-flash')
  assert.equal(jevRequests.length, 0)
  assert.equal(flashRequests.length, 1)
  assert.ok(flashRequests[0].messages[1].content.includes(originalHistory))
  assert.deepEqual(history, before)
})

test('smart history budget only clips Jev projection and carries all timing signals', async () => {
  const history = [{ time: 'time', group_name: 'Group', message_id: 'long', sender: { nickname: 'Member', user_id: '200' },
    content: 'long history '.repeat(2000), message: [{ type: 'at', qq: '300' }, { type: 'reply', id: 'quoted', sender_id: '100' }] }]
  const before = structuredClone(history)
  jev(choice())
  const { owner, e, state } = setup({ history })
  state.lastBotReplyAt = Date.now() - 10000
  state.recentReplyTimestamps.push(Date.now())
  state.recentIncomingTimestamps.push(Date.now())
  e.message = [{ type: 'at', qq: '300' }, { type: 'reply', id: 'current-quote', sender_id: '100' }]
  await owner.runTimingGate(e, state, { phase: 'focus', prefilter: { kind: 'continuation_strong', reason: 'question' } })
  const context = jevRequests[0].state
  assert.equal(context.conversation.phase, 'focus')
  assert.equal(context.activity.replies10min, 1)
  assert.equal(context.activity.messages5min, 1)
  assert.equal(context.signals.addressedToOther, true)
  assert.equal(context.signals.quotesBot, true)
  assert.equal(context.trigger.kind, 'continuation_strong')
  assert.equal(context.currentMessage.structure[1].messageId, 'current-quote')
  assert.ok(JSON.stringify(context.history).length <= 8000)
  assert.equal(context.history[0].truncated, true)
  assert.deepEqual(history, before)
})

test('smart Jev retry exhaustion and flash failures settle repeated turns and release the lock', async () => {
  jev(undefined, 503)
  flashStatus = 503
  const { owner, e, state } = setup()
  for (let i = 0; i < 2; i++) {
    assert.equal(await owner.handleRandomReplySmart({ ...e, message_id: `failed-${i}` }), false)
    assert.equal(state.inFlight, false)
  }
  assert.equal(jevRequests.length, 4)
  assert.equal(flashRequests.length, 2)
})

test('smart flash selection bypasses Jev and preserves its configured model', async () => {
  jev(choice())
  const { owner, e, state } = setup({ track: { judgeProvider: 'flash' } })
  const result = await owner.runTimingGate(e, state)
  assert.equal(result.provider, 'flash')
  assert.equal(jevRequests.length, 0)
  assert.equal(flashRequests[0].model, 'gemini-3.8-flash')
})

test('smart force paths bypass both judges and log local-force without a probability', async () => {
  jev(choice())
  const { owner, e } = setup()
  owner.checkTriggers = () => true
  assert.equal(await owner.handleRandomReplySmart(e), true)
  assert.equal(owner.replies.length, 1)
  assert.equal(jevRequests.length, 0)
  assert.equal(flashRequests.length, 0)
  assert.ok(logs.some(line => line.includes('[Gate][local-force]') && line.includes('(n/a)')))
})

test('Gate wait reevaluation with no new message becomes no_action once', async () => {
  jev(choice('wait', { continue: 0.1, no_action: 0.2, wait: 0.7 }))
  const { owner, e, state } = setup()
  const waits = []
  owner.scheduleWaitReply = (...args) => waits.push(args)
  assert.equal(await owner.handleRandomReplySmart(e), false)
  const rerun = Object.create(e)
  Object.assign(rerun, { _smartWaitRerun: true, _smartWaitKind: 'gate', _smartGateWaitVersion: state.groupContextVersion })
  assert.equal(await owner.handleRandomReplySmart(rerun), false)
  assert.equal(jevRequests.length, 2)
  assert.equal(waits.length, 1)
  assert.equal(jevRequests[1].state.trigger.kind, 'wait_reevaluation')
  assert.ok(logs.some(line => line.includes('final=no_action reason=gate_wait_recheck_limit')))
  assert.equal(state.inFlight, false)
})

test('new group input resets Gate wait eligibility, while tool waits remain independent', async () => {
  jev(choice('wait', { continue: 0.1, no_action: 0.2, wait: 0.7 }))
  const { owner, e, state } = setup()
  state.groupContextVersion = 2
  const gateRerun = { ...e, _smartWaitRerun: true, _smartWaitKind: 'gate', _smartGateWaitVersion: 1 }
  assert.equal((await owner.runTimingGate(gateRerun, state)).decision, 'wait')
  assert.equal(jevRequests[0].state.trigger.newMessageSinceWait, true)
  const toolRerun = { ...gateRerun, _smartWaitKind: 'tool', _smartGateWaitVersion: 2 }
  assert.equal((await owner.runTimingGate(toolRerun, state)).decision, 'wait')
})

test('wait timer preserves source/version metadata and selects the latest group event', async t => {
  const { owner, e, state } = setup()
  const delivered = []
  owner.handleRandomReplySmart = async event => { delivered.push(event) }
  t.mock.timers.enable({ apis: ['setTimeout'] })
  state.groupContextVersion = 4
  owner.scheduleWaitReply(e, 6, 'gate_wait', 'gate')
  const latest = { ...e, msg: '新消息', message_id: 'new' }
  state.groupContextVersion = 5
  state.latestIncomingEvent = latest
  t.mock.timers.tick(6000)
  await new Promise(resolve => setImmediate(resolve))
  assert.equal(delivered.length, 1)
  assert.equal(delivered[0].msg, '新消息')
  assert.equal(delivered[0]._smartWaitKind, 'gate')
  assert.equal(delivered[0]._smartGateWaitVersion, 4)
  assert.equal(state.waitTimers.size, 0)
})

test('strict Jev logs each adopted result using raw e.msg rather than its wrapper', async () => {
  jev(body => ({ answers: Object.fromEntries(Object.keys(body.questions).map((id, i) => [id, { type: 'noul', noul: i === 0 ? 0.83 : 0.28 }])) }))
  const { owner, e } = setup()
  e.msg = '正文\n第二行'
  const result = await Promise.all([owner.addToBatchJudgment('one', '包装头完全不该作为预览', [], e),
    owner.addToBatchJudgment('two', '另一个包装头', [], { ...e, user_id: '300', msg: '其他话题' })])
  assert.deepEqual(result, [true, false])
  const lines = logs.filter(line => line.startsWith('[批量判断][typesafe]'))
  assert.equal(lines.length, 2)
  assert.ok(lines[0].includes('正文\\n第二行'))
  assert.equal(lines[0].includes('\n'), false)
  assert.ok(lines[0].includes('0.83 (true)'))
  assert.equal(lines.some(line => line.includes('包装头')), false)
})

test('strict partial Jev results are not adopted; every flash result is logged as n/a', async () => {
  jev(body => ({ answers: { [Object.keys(body.questions)[0]]: { type: 'noul', noul: 0.83 } } }))
  const { owner, e } = setup()
  owner.batchIsUserTalkingToBot = async () => [false, true]
  const result = await Promise.all([owner.addToBatchJudgment('one', 'wrapper', [], e),
    owner.addToBatchJudgment('two', 'wrapper', [], { ...e, user_id: '300', msg: '另一个消息' })])
  assert.deepEqual(result, [false, true])
  assert.ok(logs.some(line => line.includes('未采用 Jev')))
  assert.equal(logs.filter(line => line.startsWith('[批量判断][typesafe]') && line.includes('→')).length, 0)
  assert.equal(logs.filter(line => line.startsWith('[批量判断][fallback-flash]') && line.includes('n/a')).length, 2)
})

test('strict flash-only and failed fallback calls keep original results and settle their promises', async () => {
  jev(undefined, 400)
  const { owner, e } = setup({ track: { judgeProvider: 'flash' } })
  owner.isUserTalkingToBot = async () => true
  assert.equal(await owner.addToBatchJudgment('single', 'wrapper', [], e), true)
  assert.equal(jevRequests.length, 0)
  assert.ok(logs.some(line => line.startsWith('[批量判断][flash]') && line.includes('n/a (true)')))
  owner.config.trackAiConfig.judgeProvider = 'typesafe'
  owner.batchIsUserTalkingToBot = async () => { throw new Error('flash batch failure') }
  assert.deepEqual(await Promise.all([owner.addToBatchJudgment('one', 'wrapper', [], e),
    owner.addToBatchJudgment('two', 'wrapper', [], { ...e, user_id: '300' })]), [false, false])
})

test('new Gate threshold default parses from flow YAML without changing provider defaults', () => {
  const defaults = YAML.parse(fs.readFileSync(new URL('../config_default/message.yaml', import.meta.url), 'utf8'))
  assert.equal(defaults.pluginSettings.trackAiConfig.typesafeGateThreshold, 0.5)
  assert.equal(defaults.pluginSettings.trackAiConfig.judgeProvider, 'flash')
})

test('Gate preserves configuration and message snapshots across Jev failure', async () => {
  const { owner, e, state, manager } = setup()
  let releaseHistory
  manager.getMessages = () => new Promise(resolve => { releaseHistory = resolve })
  const request = owner.runTimingGate(e, state)
  owner.config.trackAiConfig.trackAiModel = 'changed-model'
  e.msg = 'changed message'
  e.sender.nickname = 'changed sender'
  jev(choice('invalid'))
  releaseHistory([])
  await request
  assert.equal(jevRequests[0].state.currentMessage.text, '继续聊聊')
  assert.equal(flashRequests[0].model, 'gemini-3.8-flash')
  assert.ok(flashRequests[0].messages[1].content.includes('Member: 继续聊聊'))
  assert.ok(logs.some(line => line.startsWith('[Gate][fallback-flash]') && line.includes('继续聊聊')))
  assert.equal(logs.some(line => line.includes('changed message')), false)
})

test('Gate wait reevaluation is distinguished from its deferred origin', async () => {
  jev(choice('no_action', { continue: 0.1, no_action: 0.8, wait: 0.1 }))
  const { owner, e, state } = setup()
  e._deferredReason = 'cold_idle'
  e._smartWaitRerun = true
  await owner.runTimingGate(e, state)
  assert.equal(jevRequests[0].state.trigger.kind, 'deferred')
  e._smartWaitKind = 'gate'
  e._smartGateWaitVersion = state.groupContextVersion
  await owner.runTimingGate(e, state)
  assert.equal(jevRequests[1].state.trigger.kind, 'wait_reevaluation')
  assert.equal(jevRequests[1].state.trigger.reason, 'gate_wait')
})

test('diagnostic logger errors cannot change a valid Jev decision', async () => {
  jev(choice())
  const { owner, e, state } = setup()
  const previous = globalThis.logger.info
  globalThis.logger.info = () => { throw new Error('log failure') }
  try {
    assert.equal((await owner.runTimingGate(e, state)).decision, 'continue')
    assert.equal(flashRequests.length, 0)
  } finally { globalThis.logger.info = previous }
})
