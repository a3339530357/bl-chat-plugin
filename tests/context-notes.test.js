import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ContextStore } from '../core/contextStore.js'
import { participantFacts, planContextNotes, visibleContextNotes, referenceFacts } from '../core/contextNotes.js'
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
    observers: [], notes: plan.notes, unchangedNotes: plan.unchangedNotes, block: block(id) })
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
  assert.deepEqual(plan.notes, [])
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
  assert.equal(after.blocks.at(-1).contextBaseline, true)
  assert.deepEqual(after.blocks.filter(value => !value.contextNotes).map(value => value.apiRows), before.blocks.filter(value => !value.contextNotes).map(value => value.apiRows))
  assert.equal(after.cursor, before.cursor)
  assert.equal(planContextNotes(after, [fact('D')]).content, '')
})

test('source identity bootstrap supplies aliases for active speakers without reviving outside-window speakers', async () => {
  const { store, scope } = await context()
  await store.record(scope, { eventId: 'earlier', message: { content: 'old speech', sender: { user_id: '123', nickname: 'old name', role: 'member' } } })
  await store.commit(scope, { turnId: 'legacy', readUntil: 1, baseCursor: 0, observers: [], block: block('old speech'), represented: ['earlier'] })
  let snapshot = await store.read(scope, header, settings)
  assert.deepEqual(participantFacts(snapshot, []), [])
  let plan = planContextNotes(snapshot, participantFacts(snapshot, [{ qq: '123', name: 'old name', role: '[member]' }]))
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

test('capacity trimming retains the trailing baseline instead of forcing restore and recompaction', async () => {
  const { store, scope } = await context()
  for (const name of ['A', 'B', 'C']) {
    const snapshot = await store.read(scope, header, settings)
    await commit(store, scope, snapshot, planContextNotes(snapshot, [fact(name)]), name)
  }
  const compressed = await store.read(scope, header, { ...settings, noteCompactChanges: 2 })
  const baseline = compressed.blocks.at(-1)
  assert.equal(baseline.contextBaseline, true)
  const budget = tokenEstimate(baseline.apiRows) + 1
  const trimmed = await store.read(scope, header, { ...settings, highWater: budget, lowWater: budget })
  assert.ok(trimmed.dropped > 0)
  assert.equal(trimmed.blocks.length, 1)
  assert.deepEqual(trimmed.blocks[0].apiRows, baseline.apiRows)
  assert.equal(planContextNotes(trimmed, [fact('C')]).content, '')
  const repeated = await store.read(scope, header, { ...settings, highWater: budget, lowWater: budget })
  assert.equal(repeated.dropped, 0)
  assert.equal(repeated.notesCompacted, undefined)
})

test('departed members and their private facts retire silently and a new journal message revives identity', async () => {
  const { store, scope } = await context()
  let snapshot = await store.read(scope, header, settings)
  const people = [{ qq: '123', name: 'Alice', role: '[member]' }, { qq: '456', name: 'Bob', role: '[member]' }]
  const privateFact = { key: 'profile:123:m1', value: 'old text', text: 'private old text' }
  await commit(store, scope, snapshot, planContextNotes(snapshot, [...participantFacts(snapshot, people), privateFact,
    ...referenceFacts(snapshot, { 用户记忆: 'likes books' }, '123')]))
  snapshot = await store.read(scope, header, settings)
  let plan = planContextNotes(snapshot, participantFacts(snapshot, [people[1]]))
  assert.equal(plan.content, '')
  assert.deepEqual(plan.notes.filter(note => note.entry.retired).map(note => note.entry.key).sort(),
    ['member:123', 'profile:123:m1', 'reference:QQ=123:用户记忆'].sort())
  await commit(store, scope, snapshot, plan)
  snapshot = await store.read(scope, header, { ...settings, noteCompactChanges: 2 })
  assert.equal(snapshot.noteState['member:123'].retired, true)
  assert.equal(snapshot.identityEvents.length, 0)
  assert.ok(!snapshot.blocks.some(block => block.contextNotes?.some(entry => entry.key === 'member:123')))
  assert.deepEqual(planContextNotes(snapshot, participantFacts(snapshot, [people[1]])).notes, [])
  await store.record(scope, { eventId: 'return', message: { content: 'back', sender: { user_id: '123', nickname: 'Alice new', role: 'admin' } } })
  snapshot = await store.read(scope, header, settings)
  plan = planContextNotes(snapshot, participantFacts(snapshot, [people[1]]))
  assert.equal(plan.updates.length, 1)
  assert.match(plan.content, /Alice new.*\[管理\]/)
  await commit(store, scope, snapshot, plan)
  snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.noteState['member:123'].retired, undefined)
})

test('null cancellations disappear from a compacted baseline and are not restored on subsequent turns', async () => {
  const { store, scope } = await context()
  let snapshot = await store.read(scope, header, settings)
  await commit(store, scope, snapshot, planContextNotes(snapshot, referenceFacts(snapshot, { 群公告: 'old notice' }, '123')))
  snapshot = await store.read(scope, header, settings)
  await commit(store, scope, snapshot, planContextNotes(snapshot, referenceFacts(snapshot, { 群公告: '' }, '123')))
  snapshot = await store.read(scope, header, { ...settings, noteCompactChanges: 2 })
  assert.ok(snapshot.blocks.every(block => !block.contextNotes?.some(entry => entry.valueJson === 'null')))
  assert.equal(planContextNotes(snapshot, referenceFacts(snapshot, { 群公告: '' }, '123')).content, '')
})

test('initial identity journal scan is limited to the latest 2000 entries in source order', async () => {
  const { store, scope } = await context()
  const keys = store.keys(scope)
  const count = 2005
  for (let start = 1; start <= count; start += 100) {
    const raw = []; const index = []
    for (let seq = start; seq <= Math.min(count, start + 99); seq++) {
      raw.push(seq, JSON.stringify({ seq, eventId: String(seq), payload: JSON.stringify({ message: { sender: { user_id: '123', nickname: `name-${seq}` } } }) }))
      index.push(String(seq), seq)
    }
    await fixture.client.command('ZADD', keys[2], ...raw)
    await fixture.client.command('HSET', keys[3], ...index)
  }
  await fixture.client.command('SET', keys[1], count)
  await fixture.client.command('HSET', keys[4], 'cursor', count, 'eventIndexCount', count)
  const snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.identityEvents.length, 2000)
  assert.equal(snapshot.identityEvents[0].seq, 6)
  assert.equal(snapshot.identityEvents.at(-1).seq, count)
})

test('unchanged facts use compact acknowledgments and cannot be reverted by an older concurrent change', async () => {
  for (const newerFirst of [true, false]) {
    const { store, scope } = await context()
    const initial = await store.read(scope, header, settings)
    await commit(store, scope, initial, planContextNotes(initial, [fact('A')]))
    const older = await store.read(scope, header, settings)
    const newer = await store.read(scope, header, settings)
    const change = planContextNotes(older, [fact('B')])
    const unchanged = planContextNotes(newer, [fact('A')])
    assert.deepEqual(unchanged.notes, [])
    assert.deepEqual(unchanged.updates, [])
    const evaluate = store.evaluate.bind(store)
    let compactPayload = false
    store.evaluate = async (script, keys, args) => {
      if (args[3] === 'newer' && args[9] === '[]') {
        compactPayload = true
        assert.deepEqual(JSON.parse(args[10]), [['member:123', unchanged.unchangedNotes[0].baseVersion, newer.noteClock]])
      }
      return evaluate(script, keys, args)
    }
    if (newerFirst) {
      await commit(store, scope, newer, unchanged, 'newer')
      await commit(store, scope, older, change, 'older')
    } else {
      await commit(store, scope, older, change, 'older')
      await commit(store, scope, newer, unchanged, 'newer')
    }
    const result = await store.read(scope, header, settings)
    assert.equal(compactPayload, true)
    assert.equal(JSON.parse(result.noteState['member:123'].valueJson), 'A')
    assert.equal(JSON.parse(visibleContextNotes(result.blocks)['member:123'].valueJson), 'A')
    assert.equal(result.blocks.filter(block => !block.contextNotes).length, 3)
  }
})
