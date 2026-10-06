import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ContextStore } from '../core/contextStore.js'
import { participantFacts, planContextNotes, visibleContextNotes } from '../core/contextNotes.js'
import { buildAgentPromptCacheHeaders } from '../core/prompts.js'
import { tokenEstimate } from '../core/promptCache.js'
import { sessionHistoryMethods } from '../core/sessionHistory.js'
import { redisFixture } from './helpers/redis-fixture.js'

let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })
const header = buildAgentPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot' }, [], 'test', {})
const settings = { highWater: 65536, lowWater: 32768, reserveTokens: 0 }
const block = text => {
  const apiRows = [{ role: 'user', content: text }, { role: 'assistant', content: 'reply' }]
  return { replayVersion: 3, mode: 'agent', referenceVersion: 2, apiRows, messageIds: [], tokens: tokenEstimate(apiRows) }
}
const fact = (name, key = 'member:123') => ({ key, value: name, text: `成员 ${name} QQ=123` })
async function context() {
  const store = new ContextStore(fixture.client, `test:notes:${randomUUID()}:`)
  return { store, scope: await store.scope('bot', 'group') }
}
async function commit(store, scope, snapshot, plan, id = randomUUID()) {
  return store.commit(scope, { turnId: id, readUntil: snapshot.readUntil, baseCursor: snapshot.cursor,
    observers: [], notes: plan.notes, block: block(id) })
}

test('unchanged participants and reordered input emit zero updates; new person emits only its delta', async () => {
  const { store, scope } = await context()
  const people = [{ qq: '123', name: 'Alice', role: '[member]' }, { qq: '456', name: 'Bob', role: '[管理]' }]
  let snapshot = await store.read(scope, header, settings)
  let plan = planContextNotes(snapshot, participantFacts(snapshot, people))
  assert.equal(plan.updates.length, 2)
  await commit(store, scope, snapshot, plan)
  snapshot = await store.read(scope, header, settings)
  plan = planContextNotes(snapshot, participantFacts(snapshot, [...people].reverse()))
  assert.equal(plan.content, '')
  assert.deepEqual(plan.updates, [])
  const previous = snapshot.blocks.map(value => JSON.stringify(value))
  await commit(store, scope, snapshot, plan)
  snapshot = await store.read(scope, header, settings)
  assert.deepEqual(snapshot.blocks.slice(0, previous.length).map(value => JSON.stringify(value)), previous)
  plan = planContextNotes(snapshot, participantFacts(snapshot, [...people, { qq: '789', name: 'Carol', role: '[member]' }]))
  assert.equal(plan.updates.length, 1)
  assert.equal(plan.updates[0].key, 'member:789')
})

test('A -> B -> A gets distinct monotonic note identities and late concurrent commit cannot regress facts', async () => {
  const { store, scope } = await context()
  const versions = []
  for (const name of ['A', 'B', 'A']) {
    const snapshot = await store.read(scope, header, settings)
    const plan = planContextNotes(snapshot, [fact(name)])
    versions.push(plan.notes[0].eventId)
    await commit(store, scope, snapshot, plan)
  }
  assert.equal(new Set(versions).size, 3)
  const old = await store.read(scope, header, settings)
  const newer = await store.read(scope, header, settings)
  await commit(store, scope, newer, planContextNotes(newer, [fact('new')]), 'new-turn')
  await commit(store, scope, old, planContextNotes(old, [fact('stale')]), 'old-turn')
  const snapshot = await store.read(scope, header, settings)
  assert.equal(JSON.parse(snapshot.noteState['member:123'].valueJson), 'new')
  assert.equal(JSON.parse(visibleContextNotes(snapshot.blocks)['member:123'].valueJson), 'new')
  assert.equal(snapshot.blocks.at(-1).apiRows[0].content, 'old-turn')
  assert.ok(!snapshot.blocks.some(value => value.contextNotes?.some(entry => entry.text.includes('stale'))))
})

test('capacity loss restores identities once despite prior represented IDs; reset invalidates old notes', async () => {
  const { store, scope } = await context()
  let snapshot = await store.read(scope, header, settings)
  await commit(store, scope, snapshot, planContextNotes(snapshot, [fact('Alice')]))
  snapshot = await store.read(scope, header, { ...settings, highWater: 1, lowWater: 0 })
  assert.equal(snapshot.blocks.length, 0)
  let plan = planContextNotes(snapshot, [fact('Alice')])
  assert.equal(plan.updates.length, 1)
  await commit(store, scope, snapshot, plan)
  snapshot = await store.read(scope, header, settings)
  assert.equal(planContextNotes(snapshot, [fact('Alice')]).updates.length, 0)
  await store.reset('bot', 'group')
  await assert.rejects(commit(store, scope, snapshot, plan), { code: 'stale_scope' })
  const freshScope = await store.scope('bot', 'group')
  snapshot = await store.read(freshScope, header, settings)
  plan = planContextNotes(snapshot, [fact('Alice')])
  assert.equal(plan.updates.length, 1)
})

test('note compression replaces updates with one baseline and preserves all conversation bytes', async () => {
  const { store, scope } = await context()
  for (const name of ['A', 'B', 'C', 'D']) {
    const snapshot = await store.read(scope, header, settings)
    await commit(store, scope, snapshot, planContextNotes(snapshot, [fact(name)]), `turn-${name}`)
  }
  const before = await store.read(scope, header, settings)
  const after = await store.read(scope, header, { ...settings, noteCompactChanges: 3 })
  assert.equal(after.notesCompacted, true)
  assert.equal(after.blocks.filter(value => value.contextNotes).length, 1)
  assert.equal(after.blocks[0].contextBaseline, true)
  assert.deepEqual(after.blocks.filter(value => !value.contextNotes).map(value => value.apiRows), before.blocks.filter(value => !value.contextNotes).map(value => value.apiRows))
  assert.equal(after.cursor, before.cursor)
  assert.equal(planContextNotes(after, [fact('D')]).content, '')
})

test('source identity bootstrap covers earlier consumed speakers outside the rolling member buffer', async () => {
  const { store, scope } = await context()
  await store.record(scope, { eventId: 'earlier', message: { content: 'old speech', sender: { user_id: '123', nickname: 'old name', role: 'member' } } })
  await store.commit(scope, { turnId: 'legacy', readUntil: 1, baseCursor: 0, observers: [], block: block('old speech'), represented: ['earlier'] })
  let snapshot = await store.read(scope, header, settings)
  let plan = planContextNotes(snapshot, participantFacts(snapshot, []))
  assert.ok(plan.content.includes('old name'))
  await commit(store, scope, snapshot, plan)
  await store.record(scope, { eventId: 'renamed', message: { content: 'new speech', sender: { user_id: '123', nickname: 'new name', role: 'admin' } } })
  snapshot = await store.read(scope, header, settings)
  plan = planContextNotes(snapshot, participantFacts(snapshot, []))
  assert.equal(plan.updates.length, 1)
  assert.ok(plan.content.includes('new name'))
  assert.ok(plan.content.includes('old name'))
  assert.ok(plan.content.includes('[管理]'))
})

test('current member delta is request-only, stored separately, and never counts as an observer', async () => {
  const { store, scope } = await context()
  const owner = { ...sessionHistoryMethods, contextStore: store, config: { promptCache: { diagnostics: false } }, getTaskStatus: async () => null, formatTaskStatusForPrompt: () => '' }
  const e = { self_id: 'bot', group_id: 'group', user_id: '123', message_id: 'm1', sender: { user_id: '123', nickname: 'Alice' } }
  const manager = { recordMessage: async () => store.record(scope, { eventId: 'message:bot:group:m1', message: { ...e, content: 'hello' } }) }
  const turn = await owner.preparePromptCacheTurn({ e, session: { turnId: 'test-turn' }, scope, header, userContent: 'hello', references: {}, manager, allowedTools: [], agentControls: {} })
  assert.ok(turn.userRow.content.includes('Alice'))
  assert.match(turn.userRow.content, /"newObserverCount":\s*0/)
  assert.equal(turn.block().apiRows[0].content, 'hello')
  await owner.commitPromptCacheTurn({ cacheTurn: turn }, e)
  const snapshot = await store.read(scope, header, settings)
  assert.ok(snapshot.blocks.some(value => value.contextNotes?.some(entry => entry.key === 'member:123')))
})

test('retired summaries disappear at compression and stale turns cannot resurrect them', async () => {
  const { store, scope } = await context()
  let snapshot = await store.read(scope, header, settings)
  await commit(store, scope, snapshot, planContextNotes(snapshot, [fact('old result', 'history:m1:0')]))
  const stale = await store.read(scope, header, settings)
  snapshot = await store.read(scope, header, settings)
  await commit(store, scope, snapshot, planContextNotes(snapshot, [{ key: 'history:m1:0', value: null, text: '', retired: true }, fact('current')]))
  await commit(store, scope, stale, planContextNotes(stale, [fact('old result', 'history:m1:0')]))
  snapshot = await store.read(scope, header, { ...settings, noteCompactChanges: 2 })
  assert.equal(snapshot.noteState['history:m1:0'].retired, true)
  assert.ok(!snapshot.blocks.some(value => value.contextNotes?.some(entry => entry.key === 'history:m1:0')))
})

test('new reference budget triggers whole-block trimming instead of a repeated V1 overflow fallback', async () => {
  const { store, scope } = await context()
  const old = block('old conversation '.repeat(700))
  await store.commit(scope, { turnId: 'old', readUntil: 0, baseCursor: 0, observers: [], block: old })
  const base = tokenEstimate(header.agentSystem) + tokenEstimate(header.tools) + 1024
  const config = { promptCache: { diagnostics: false, highWaterTokens: Math.max(4096, base + old.tokens + 300), lowWaterTokens: 2048, reserveTokens: 1024 } }
  const owner = { ...sessionHistoryMethods, contextStore: store, config, getTaskStatus: async () => null }
  const e = { self_id: 'bot', group_id: 'group', user_id: '123', message_id: 'm-budget', sender: { user_id: '123', nickname: 'Alice' } }
  let recordings = 0
  const manager = { recordMessage: async () => { recordings++; return store.record(scope, { eventId: 'message:bot:group:m-budget', message: { ...e, content: 'hello' } }) } }
  const turn = await owner.preparePromptCacheTurn({ e, session: { turnId: 'budget' }, scope, header, userContent: 'hello',
    references: { memory: 'new memory '.repeat(650) }, manager, allowedTools: [], agentControls: {} })
  assert.ok(recordings >= 2)
  assert.ok(!turn.snapshot.blocks.some(value => value.turnId === 'old' || value.apiRows?.[0]?.content === old.apiRows[0].content))
  assert.ok(turn.userRow.content.includes('new memory'))
  assert.ok(turn.baseTokens + turn.settings.reserveTokens <= turn.settings.highWater)
  assert.equal(turn.snapshot.readUntil, 1)
})
