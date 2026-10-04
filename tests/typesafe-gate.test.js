import test, { afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { typesafeGateJudge } from '../core/tracking/typesafeJudge.js'
import { tokenEstimate } from '../core/promptCache.js'

const nativeFetch = globalThis.fetch
afterEach(() => { globalThis.fetch = nativeFetch })
const config = { typesafeApiKey: 'test-key', typesafeGateThreshold: 0.5 }
const payload = () => ({
  asOf: '2026-10-05T04:00:00Z', bot: { name: 'Bot', qq: '100' }, history: [],
  currentMessage: { sender: { name: 'Member', qq: '200' }, text: '继续聊聊' },
  conversation: { phase: 'focus' }, timing: { sinceLastBotReplySec: 30 },
  trigger: { kind: 'continuation_strong' }, policy: { promptHintBusyGroupRate: 30, promptHintRateLimitWarn: 5 }
})
const choiceAnswer = (choice, probabilities) => ({ type: 'choice', choice, confidence: 0.01, probabilities })
function responseWith(answer) {
  const requests = []
  globalThis.fetch = async (_url, options) => {
    requests.push(JSON.parse(options.body))
    return { ok: true, json: async () => ({ answers: { gate: answer } }) }
  }
  return requests
}

test('Gate Choice maps all three decisions, ignoring confidence as an action threshold', async () => {
  for (const selected of ['continue', 'no_action', 'wait']) {
    const probabilities = { continue: 0.1, no_action: 0.1, wait: 0.1, [selected]: 0.8 }
    const calls = responseWith(choiceAnswer(selected, probabilities))
    const result = await typesafeGateJudge(config, payload())
    assert.equal(result.rawChoice, selected)
    assert.equal(result.decision, selected)
    assert.equal(result.finalDecision, selected)
    assert.equal(calls.length, 1)
    assert.deepEqual(Object.keys(calls[0].questions.gate.criteria), ['continue', 'no_action', 'wait'])
    assert.equal(calls[0].questions.gate.type, 'choice')
    assert.equal(result.wait_seconds, selected === 'wait' ? 6 : undefined)
  }
})

test('Gate continue boundary: 0.50 passes, 0.49 is a valid no_action policy veto', async () => {
  responseWith(choiceAnswer('continue', { continue: 0.5, no_action: 0.3, wait: 0.2 }))
  assert.equal((await typesafeGateJudge(config, payload())).decision, 'continue')
  responseWith(choiceAnswer('continue', { continue: 0.49, no_action: 0.3, wait: 0.21 }))
  const result = await typesafeGateJudge(config, payload())
  assert.equal(result.decision, 'no_action')
  assert.equal(result.rawChoice, 'continue')
  assert.equal(result.reason, 'below_threshold')
  assert.equal(result.threshold, 0.5)
})

test('Gate wait uses Beijing time at the 23:00 and 06:00 boundaries', async () => {
  for (const [asOf, seconds] of [['2026-10-05T14:59:00Z', 6], ['2026-10-05T15:00:00Z', 12],
    ['2026-10-05T21:59:00Z', 12], ['2026-10-05T22:00:00Z', 6]]) {
    responseWith(choiceAnswer('wait', { continue: 0.1, no_action: 0.1, wait: 0.8 }))
    const result = await typesafeGateJudge(config, { ...payload(), asOf })
    assert.equal(result.wait_seconds, seconds)
  }
})

test('Gate rejects invalid answer shapes and distributions', async () => {
  const answers = [
    undefined,
    { type: 'noul', noul: 0.8 },
    choiceAnswer('other', { continue: 0.6, no_action: 0.3, wait: 0.1 }),
    choiceAnswer('continue', { continue: 0.6, no_action: 0.3 }),
    choiceAnswer('continue', { continue: 0.6, no_action: 0.3, wait: 0.3 }),
    choiceAnswer('continue', { continue: Infinity, no_action: 0.3, wait: 0.1 }),
    choiceAnswer('continue', { continue: -0.2, no_action: 0.7, wait: 0.5 }),
    choiceAnswer('continue', { continue: '0.6', no_action: 0.3, wait: 0.1 }),
    choiceAnswer('wait', { continue: 0.6, no_action: 0.3, wait: 0.1 })
  ]
  for (const answer of answers) {
    responseWith(answer)
    await assert.rejects(typesafeGateJudge(config, payload()), /typesafe_gate_invalid/)
  }
})

test('Gate accepts small rounding error and tied maxima, but validates configuration', async () => {
  responseWith(choiceAnswer('continue', { continue: 0.5, no_action: 0.5, wait: 0 }))
  await assert.rejects(typesafeGateJudge({}, payload()), /typesafeApiKey 未配置/)
  assert.equal((await typesafeGateJudge(config, payload())).decision, 'continue')
  responseWith(choiceAnswer('continue', { continue: 0.6, no_action: 0.3, wait: 0.0999 }))
  assert.equal((await typesafeGateJudge(config, payload())).decision, 'continue')
  await assert.rejects(typesafeGateJudge({ ...config, typesafeGateThreshold: 2 }, payload()), /invalid_threshold/)
})

test('Gate history drops oldest records and retains the latest Bot reply without mutating source', async () => {
  const input = payload()
  input.history = Array.from({ length: 20 }, (_, i) => ({
    message_id: `m${i}`, time: `time-${i}`, sender: { nickname: `Member-${i}`, user_id: i === 18 ? '100' : '200', role: i === 18 ? 'bot' : 'member' },
    content: `body-${i} ${'text '.repeat(250)}`, message: [{ type: 'at', qq: 300 }, { type: 'reply', id: 'quoted', sender_id: 100 }]
  }))
  const before = structuredClone(input)
  const calls = responseWith(choiceAnswer('continue', { continue: 0.6, no_action: 0.3, wait: 0.1 }))
  const result = await typesafeGateJudge(config, input)
  const history = calls[0].state.history
  assert.ok(JSON.stringify(history).length <= 8000)
  assert.equal(history[0].messageId, 'm0')
  assert.ok(history.some(row => row.messageId === 'm18'))
  assert.ok(result.historyTrim.dropped > 0)
  assert.equal(calls[0].state.historyOrder, 'newest_first')
  assert.deepEqual(input, before)
})

test('Gate truncates a giant multiline record body while preserving sender, mentions and replies', async () => {
  const input = payload()
  input.history = [{ time: 'time', message_id: 'large', sender: { nickname: 'Member', user_id: '200', role: 'owner' },
    content: '\n"\\'.repeat(12000), message: [{ type: 'at', qq: 300 }, { type: 'reply', id: 'quote', sender_id: 100 }] }]
  input.currentMessage.message = [{ type: 'at', qq: 100 }, { type: 'reply', id: 'current-quote' }]
  const before = structuredClone(input)
  const calls = responseWith(choiceAnswer('no_action', { continue: 0.2, no_action: 0.7, wait: 0.1 }))
  await typesafeGateJudge(config, input)
  const state = calls[0].state
  const row = state.history[0]
  assert.equal(state.history.length, 1)
  assert.equal(row.sender.role, 'owner')
  assert.equal(row.messageId, 'large')
  assert.equal(row.truncated, true)
  assert.equal(row.originalContentChars, input.history[0].content.length)
  assert.deepEqual(row.structure, [{ type: 'at', qq: '300' }, { type: 'reply', messageId: 'quote', senderQQ: '100' }])
  assert.ok(JSON.stringify(state.history).length <= 8000)
  assert.equal(state.currentMessage.structure[1].messageId, 'current-quote')
  assert.equal('message' in state.currentMessage, false)
  assert.deepEqual(input, before)
})

test('Gate rejects aggregate input over 16K estimated tokens before sending', async () => {
  const input = payload()
  input.currentMessage.text = '长消息 '.repeat(20000)
  let calls = 0
  globalThis.fetch = async () => { calls++; throw new Error('must not request') }
  assert.ok(tokenEstimate(input) > 16000)
  await assert.rejects(typesafeGateJudge(config, input), /input_over_budget/)
  assert.equal(calls, 0)
})
