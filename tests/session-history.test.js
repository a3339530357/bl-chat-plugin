import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ContextStore, validateToolRows } from '../core/contextStore.js'
import { promptCacheSettings, beijingDay, isPromptCacheEnabled, originKeyForEvent, tokenEstimate } from '../core/promptCache.js'
import { buildPromptCacheHeaders } from '../core/prompts.js'
import { legacyReferenceContent } from './helpers/legacy-reference.js'
import { sessionHistoryMethods } from '../core/sessionHistory.js'
import { redisFixture } from './helpers/redis-fixture.js'

let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })

const header = buildPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group', groupName: 'Group' } }, [{
  type: 'function', function: { name: 'probe', description: 'probe', parameters: { type: 'object', properties: {}, required: [] } }
}])
const settings = promptCacheSettings({})
const event = id => ({ eventId: id, message: { time: '2026-10-03 12:00:00', message_id: id, content: `text ${id}`, message: [], sender: { user_id: 'user', nickname: 'User', role: 'member' } } })
const block = id => ({ turnId: id, toolRows: [{ role: 'user', content: id }], chatRows: [{ role: 'user', content: id }], tokens: 20, messageIds: [id] })
async function storeScope() {
  const store = new ContextStore(fixture.client, `test:cache:${randomUUID()}:`)
  return { store, scope: await store.scope('bot', 'group') }
}

test('V2 defaults off; groups must opt in and Anthropic paths stay V1', () => {
  assert.equal(isPromptCacheEnabled({}, '1'), false)
  assert.equal(isPromptCacheEnabled({ promptCache: { enabled: true, groups: [] } }, '1'), false)
  assert.equal(isPromptCacheEnabled({ promptCache: { enabled: true, groups: ['1'] } }, '1'), true)
  assert.equal(isPromptCacheEnabled({ promptCache: { enabled: true, groups: ['1'] } }, '2'), false)
  assert.equal(isPromptCacheEnabled({ promptCache: { enabled: true, groups: ['*'] }, chatAiConfig: { chatApiUrl: 'https://example/v1/messages' } }, '1'), false)
})

test('Beijing day changes at 16:00 UTC, independent of process timezone', () => {
  assert.equal(beijingDay(Date.UTC(2026, 9, 3, 15, 59, 59)).dayKey, '20261003')
  assert.equal(beijingDay(Date.UTC(2026, 9, 3, 16)).dayKey, '20261004')
})

test('source sequence is atomic/idempotent and JSON arrays survive Lua', async () => {
  const { store, scope } = await storeScope()
  const results = await Promise.all(Array.from({ length: 6 }, () => store.record(scope, event('one'))))
  assert.deepEqual(results.map(result => result.seq), [1, 1, 1, 1, 1, 1])
  await store.record(scope, event('two'))
  const snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.readUntil, 2)
  assert.deepEqual(snapshot.events.map(item => item.seq), [1, 2])
  assert.deepEqual(snapshot.events[0].message.message, [])
  assert.deepEqual(snapshot.header.tools[0].function.parameters.required, [])
  assert.deepEqual(snapshot.header.tools[0].function.parameters.properties, {})
})

test('out-of-order commits dedupe observers, keep tool blocks together, and never regress cursor', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('one'))
  await store.record(scope, event('two'))
  await store.read(scope, header, settings)
  const observer = { eventId: 'one', block: block('observer') }
  const toolBlock = block('B')
  toolBlock.toolRows.push(
    { role: 'assistant', content: '', tool_calls: [{ id: 'c1', type: 'function', function: { name: 'probe', arguments: '{}' } }] },
    { role: 'tool', tool_call_id: 'c1', content: 'done' }
  )
  await store.commit(scope, { turnId: 'B', readUntil: 2, baseCursor: 0, observers: [observer], block: toolBlock })
  const late = await store.commit(scope, { turnId: 'A', readUntil: 1, baseCursor: 0, observers: [observer], block: block('A') })
  assert.equal(late.cursor, 2)
  assert.equal(late.concurrentMerge, true)
  const duplicate = await store.commit(scope, { turnId: 'A', readUntil: 1, baseCursor: 0, observers: [observer], block: block('A') })
  assert.equal(duplicate.duplicate, true)
  const snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.cursor, 2)
  assert.deepEqual(snapshot.blocks.map(item => item.turnId), ['observer', 'B', 'A'])
  validateToolRows(snapshot.blocks.flatMap(item => item.toolRows))
})

test('same-day clear and expired deadline reject old tasks without resurrecting history', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('old'))
  await store.reset('bot', 'group')
  await assert.rejects(store.commit(scope, { turnId: 'old', readUntil: 1, baseCursor: 0, observers: [], block: block('old') }), { code: 'stale_scope' })
  const fresh = await store.scope('bot', 'group')
  const snapshot = await store.read(fresh, header, settings)
  assert.equal(snapshot.cursor, 0)
  assert.deepEqual(snapshot.blocks, [])
  await assert.rejects(store.record({ ...fresh, deadline: Date.now() - 1 }, event('late')), { code: 'expired_scope' })
})

test('source holes and capacity exhaustion are explicit failures, not cursor advances', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('one'))
  await store.record(scope, event('two'))
  await fixture.client.command('ZREMRANGEBYSCORE', store.keys(scope)[2], 1, 1)
  await assert.rejects(store.read(scope, header, settings), { code: 'source_gap' })
  const other = await storeScope()
  await other.store.record(other.scope, event('one'), { rawMaxEvents: 1 })
  await assert.rejects(other.store.record(other.scope, event('two'), { rawMaxEvents: 1 }), { code: 'raw_limit' })
  await assert.rejects(other.store.read(other.scope, header, settings), { code: 'raw_limit' })
})

test('capacity trim removes whole blocks and retains exact rows and source watermark', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('one'))
  await store.read(scope, header, settings)
  for (let index = 0; index < 4; index++) {
    const item = { ...block(`T${index}`), tokens: 1500 }
    await store.commit(scope, { turnId: item.turnId, readUntil: 1, baseCursor: 1, observers: [], block: item })
  }
  const snapshot = await store.read(scope, header, { ...settings, highWater: 5000, lowWater: 3000, reserveTokens: 0 })
  assert.equal(snapshot.dropped, 2)
  assert.equal(snapshot.cursor, 1)
  assert.deepEqual(snapshot.blocks.map(item => item.turnId), ['T2', 'T3'])
  assert.deepEqual(snapshot.blocks[0].toolRows, block('T2').toolRows)
})

test('temporary identity lookup failure replays the last reliable header', async () => {
  const { store, scope } = await storeScope()
  await store.read(scope, header, settings)
  const degraded = buildPromptCacheHeaders({ systemContent: 'persona', botCardInGroup: 'wrong', reliable: false }, [])
  const snapshot = await store.read(scope, degraded, settings)
  assert.equal(snapshot.header.version, header.version)
})

test('finalizer commits empty/failed turns once and retries only persistence', async () => {
  const { store, scope } = await storeScope()
  let attempts = 0
  const retryStore = { async commit(...args) { attempts++; if (attempts === 1) throw new Error('lost response'); return store.commit(...args) } }
  const owner = { config: { promptCache: { diagnostics: false } }, contextStore: retryStore }
  const session = { cacheTurn: {
    turnId: 'failed', scope, snapshot: { cursor: 0, readUntil: 0 }, represented: [], observers: [], block: () => block('failed')
  } }
  await sessionHistoryMethods.commitPromptCacheTurn.call(owner, session, {})
  assert.equal(attempts, 2)
  await sessionHistoryMethods.commitPromptCacheTurn.call(owner, session, {})
  const snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.blocks.length, 1)
})

test('malformed native tool conversations are rejected before persistence', () => {
  assert.throws(() => validateToolRows([{ role: 'tool', tool_call_id: 'missing' }]), { code: 'unpaired_tool_result' })
  assert.throws(() => validateToolRows([{ role: 'assistant', tool_calls: [{ id: 'c' }] }, { role: 'user', content: 'interleaved' }]), { code: 'unfinished_tool_calls' })
})

test('lost replay/index state is an explicit recovery error', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('one'))
  await store.read(scope, header, settings)
  await store.commit(scope, { turnId: 'T', readUntil: 1, baseCursor: 0, observers: [], block: block('T'), represented: ['one'] })
  await fixture.client.command('DEL', store.keys(scope)[5])
  await assert.rejects(store.read(scope, header, settings), { code: 'replay_state_gap' })
  const other = await storeScope()
  await other.store.record(other.scope, event('one'))
  await fixture.client.command('DEL', other.store.keys(other.scope)[3])
  await assert.rejects(other.store.read(other.scope, header, settings), { code: 'source_gap' })
})

test('nonfinite configuration cannot become a malformed Redis budget', () => {
  const normalized = promptCacheSettings({ promptCache: { highWaterTokens: Infinity, reserveTokens: NaN } })
  assert.equal(normalized.highWater, 65536)
  assert.equal(normalized.reserveTokens, 8192)
})

test('a proactive event does not inherit the anchor cache identity', () => {
  const anchor = { self_id: 'bot', group_id: 'group', message_id: 'anchor' }
  const original = originKeyForEvent(anchor)
  const proactive = Object.create(anchor)
  proactive._smartOriginKey = 'group:proactive:new'
  assert.equal(originKeyForEvent(proactive), 'group:proactive:new')
  assert.equal(originKeyForEvent(anchor), original)
  assert.doesNotThrow(() => tokenEstimate('literal <|endoftext|> must stay visible'))
  const sealed = Object.freeze({ self_id: 'bot', group_id: 'group' })
  assert.equal(originKeyForEvent(sealed), originKeyForEvent(sealed))
})

test('overflowing new content does not destroy an existing replay prefix', async () => {
  const { store, scope } = await storeScope()
  await store.read(scope, header, settings)
  await store.commit(scope, { turnId: 'kept', readUntil: 0, baseCursor: 0, observers: [], block: block('kept') })
  await assert.rejects(store.read(scope, header, { ...settings, highWater: 5000 }, 6000), { code: 'incoming_overflow' })
  const snapshot = await store.read(scope, header, settings)
  assert.equal(snapshot.blocks[0].turnId, 'kept')
})

test('legacy references migrate before budget trimming without losing tool rows, replies, IDs or cursor', async () => {
  const { store, scope } = await storeScope()
  await store.record(scope, event('old'))
  const legacy = legacyReferenceContent({
    turnId: 'old', userId: 'user', messageId: 'old', asOf: '2026-10-03T12:00:00.000Z',
    references: { memory: 'obsolete memory '.repeat(4000) }, allowedTools: ['probe']
  })
  const user = { role: 'user', content: 'full original user body\nimage URL' + legacy }
  const call = { role: 'assistant', tool_calls: [{ id: 'original-call', type: 'function', function: { name: 'probe', arguments: ' { "x" : 1 } ' } }] }
  const result = { role: 'tool', tool_call_id: 'original-call', content: 'exact result bytes' }
  const reply = { role: 'assistant', content: 'reply', reasoning_content: 'original final reasoning' }
  const old = { ...block('old'), toolRows: [user, call, result, reply], chatRows: [user, { role: 'system', content: '[tool_execution]\nexact result bytes' }, reply], tokens: 20000 }
  await store.commit(scope, { turnId: 'old', readUntil: 1, baseCursor: 0, observers: [], block: old, represented: ['old'] })
  const snapshots = await Promise.all(Array.from({ length: 3 }, () => store.read(scope, header, { ...settings, highWater: 5000, lowWater: 2500, reserveTokens: 0 })))
  for (const snapshot of snapshots) {
    assert.equal(snapshot.dropped, 0)
    assert.equal(snapshot.cursor, 1)
    assert.equal(snapshot.blocks.length, 1)
    const cleaned = snapshot.blocks[0]
    assert.equal(cleaned.toolRows[0].content, 'full original user body\nimage URL')
    assert.equal(cleaned.chatRows[0].content, cleaned.toolRows[0].content)
    assert.deepEqual(cleaned.toolRows.slice(1), old.toolRows.slice(1))
    assert.deepEqual(cleaned.chatRows.slice(1), old.chatRows.slice(1))
    assert.deepEqual(cleaned.messageIds, ['old'])
    assert.equal(cleaned.referenceVersion, 2)
    assert.equal(cleaned.tokens, Math.max(tokenEstimate(cleaned.toolRows), tokenEstimate(cleaned.chatRows)))
  }
  const stored = await fixture.client.command('LRANGE', store.keys(scope)[5], 0, -1)
  assert.deepEqual(JSON.parse(stored[0]), snapshots[0].blocks[0])
  await store.commit(scope, { turnId: 'old', readUntil: 1, baseCursor: 0, observers: [], block: old })
  assert.deepEqual((await store.read(scope, header, settings)).blocks, snapshots[0].blocks)
})

test('legacy writes after cleanup are detected and migrated on the next read', async () => {
  const { store, scope } = await storeScope()
  const makeLegacy = id => {
    const reference = legacyReferenceContent({ turnId: id, userId: 'user', messageId: id, asOf: '2026-10-03T12:00:00.000Z', allowedTools: [] })
    const row = { role: 'user', content: id + reference }
    return { ...block(id), toolRows: [row], chatRows: [row] }
  }
  for (const id of ['old-one', 'old-two']) {
    await store.commit(scope, { turnId: id, readUntil: 0, baseCursor: 0, observers: [], block: makeLegacy(id) })
    const snapshot = await store.read(scope, header, settings)
    assert.ok(snapshot.blocks.every(item => item.toolRows[0].content === item.turnId))
  }
})
