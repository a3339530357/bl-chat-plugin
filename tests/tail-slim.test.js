import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { referenceFacts, profileFacts, planContextNotes } from '../core/contextNotes.js'
import { buildTurnReferenceContent, stripTurnReferenceContent, TURN_REFERENCE_START, TURN_REFERENCE_END } from '../core/prompts.js'
import { dumpTurnTail } from '../core/tailDump.js'
import { PersonProfileInjector } from '../utils/PersonProfileInjector.js'
import { pluginBridge } from '../utils/pluginBridge.js'

test('reference deltas inherit unchanged data, scope user memory and cancel an empty retrieval once', () => {
  const snapshot = { blocks: [], noteState: {}, noteClock: 1 }
  const data = { 用户记忆: 'likes books', 群公告: 'meeting at 8', 北京时间: 'now' }
  let plan = planContextNotes(snapshot, referenceFacts(snapshot, data, '42'))
  assert.equal(plan.updates.length, 2)
  snapshot.blocks = plan.notes.map(note => note.block)
  snapshot.noteState = Object.fromEntries(plan.notes.map(note => [note.entry.key, note.entry]))
  snapshot.noteClock++
  assert.equal(planContextNotes(snapshot, referenceFacts(snapshot, data, '42')).content, '')
  plan = planContextNotes(snapshot, referenceFacts(snapshot, data, '43'))
  assert.equal(plan.updates.length, 1)
  assert.match(plan.content, /QQ=43 用户记忆/)
  plan = planContextNotes(snapshot, referenceFacts(snapshot, { ...data, 用户记忆: '' }, '42'))
  assert.equal(plan.updates.length, 1)
  assert.match(plan.content, /用户记忆=null/)
})

test('profile skips only recent text actually visible for the same message, retaining outside-window facts', () => {
  const snapshot = { noteState: {}, blocks: [{ replayVersion: 3, mode: 'agent', messageIds: ['old'], apiRows: [{ role: 'user', content: 'visible old text' }] }] }
  const records = [{ messageId: 'old', text: 'visible old text' }, { messageId: 'now', text: 'current text' }, { messageId: 'outside', text: 'outside-window text' }]
  const facts = profileFacts(snapshot, records, '42', 'now', 'current text', [])
  assert.deepEqual(facts.map(value => value.value), ['outside-window text'])
  assert.equal(profileFacts(snapshot, [{ messageId: 'old', text: 'different missing text' }], '42', 'now', '', []).length, 1)
})

test('profile parts preserve V1 bytes while exposing independently deduplicable recent messages', async () => {
  const saved = { ...pluginBridge }
  pluginBridge.instance = { config: { personProfileInjection: { enabled: true, maxRecentMessages: 3 } } }
  pluginBridge.sharedState = { messageManager: { getMessages: async () => [{ message_id: '1', sender: { user_id: '42' }, raw_message: 'recent text' }] } }
  try {
    const injector = new PersonProfileInjector()
    const e = { sender: { nickname: 'Alice' } }
    const legacy = await injector.build('g', '42', e)
    const parts = await injector.build('g', '42', e, { parts: true })
    assert.equal(legacy, '【当前对话者画像】\n- 昵称: Alice (QQ: 42)\n- 此人最近发言:\n  · recent text')
    assert.equal(parts.full, legacy)
    assert.equal(parts.recent.includes('Alice'), false)
    assert.deepEqual(parts.recentMessages.map(row => row.messageId), ['1'])
  } finally { Object.assign(pluginBridge, saved) }
})

test('minimal reference has no fixed explanatory prose and retains exact suffix stripping', () => {
  const reference = buildTurnReferenceContent({ userId: '42', messageId: 'm', allowedTools: [], declaredTools: [], references: {}, taskStatuses: [] })
  assert.equal(reference, TURN_REFERENCE_START + '{"currentUserQQ":"42","targetMessageId":"m","allowedTools":[],"newObserverCount":0}' + TURN_REFERENCE_END)
  const body = `quoted ${TURN_REFERENCE_START} literal ${TURN_REFERENCE_END}`
  assert.equal(stripTurnReferenceContent(body + reference, reference), body)
  assert.equal(stripTurnReferenceContent(body + reference + 'extra', reference), body + reference + 'extra')
})

test('tail dump defaults off and writes the actual reference with private file permissions when enabled', async () => {
  const groupId = `tailslim-test-${randomUUID()}`
  const target = `/root/tmp/tail-dump-${groupId}.json`
  const turn = { scope: { groupId }, turnId: 't', snapshot: { noteClock: 7 } }
  try {
    await dumpTurnTail({}, turn, 'actual tail')
    await assert.rejects(fs.stat(target), { code: 'ENOENT' })
    await dumpTurnTail({ promptCache: { tailDump: true } }, turn, 'actual tail')
    const data = JSON.parse(await fs.readFile(target, 'utf8'))
    assert.equal(data.content, 'actual tail')
    assert.equal(data.noteVersion, 7)
    assert.equal((await fs.stat(target)).mode & 0o777, 0o600)
  } finally { await fs.unlink(target).catch(() => {}) }
})
