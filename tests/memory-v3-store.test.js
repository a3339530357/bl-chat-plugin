import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { redisFixture } from './helpers/redis-fixture.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'

let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })

async function environment() {
  const store = new MemoryStoreV3(fixture.client)
  const scope = store.scope('bot', randomUUID())
  const add = async (id, text = '我喜欢咖啡', time = 1800000000) => {
    const source = buildMemorySource({ message_id: id, time, user_id: '101', message: [{ type: 'text', text }] }, scope)
    await store.sources.record(scope, source)
    return source
  }
  return { store, scope, add }
}

function fact(source, extra = {}) {
  return { type: 'fact', subjectId: '101', slot: 'preference:coffee', kind: 'preference', text: '喜欢咖啡', value: true,
    basis: 'self_report', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }], ...extra }
}

test('V3 accepts supported facts, persists evidence, and retries commit exactly once', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  const plan = await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] })
  assert.equal((await store.commit(scope, plan)).duplicate, false)
  assert.equal((await store.commit(scope, plan)).duplicate, true)
  const state = await store.snapshot(scope)
  assert.equal(Object.keys(state.facts).length, 1)
  assert.equal(Object.keys(state.evidence).length, 1)
  assert.equal(state.meta.extractedThrough, '1')
  assert.equal(state.meta.memoryRevision, '1')
  await add('2')
  assert.equal((await store.sources.status(scope)).pending, 1, 'committed sources may remain resident')
})

test('V3 ambiguous and joking statements stay out of active facts but advance the processed cursor', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1', '我喜欢咖啡，开玩笑的')
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] }))
  const state = await store.snapshot(scope)
  assert.equal(Object.keys(state.facts).length, 0)
  assert.equal(Object.values(state.review)[0].reason, 'context_uncertain')
  assert.equal(state.meta.extractedThrough, '1')
  await store.reclaim(scope, { retain: 0 })
  assert.equal(Object.values((await store.snapshot(scope)).evidence)[0].text, source.text)
})

test('V3 invalid evidence, bot evidence, and context-only repetition are rejected', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  const first = await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source, { evidence: [{ eventId: 'fake', quote: 'fake' }] })] })
  assert.equal((await store.commit(scope, first)).batch.counts.rejected, 1)
  await add('2', '只是普通闲聊')
  const second = await store.planBatch(scope, { from: 2, to: 2, candidates: [fact(source)] })
  assert.equal((await store.commit(scope, second)).batch.counts.rejected, 1)
  assert.equal(Object.keys((await store.snapshot(scope)).facts).length, 0)
})

test('V3 stale worker and changed source fail before writes or cursor movement', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  await store.claimWorker(scope, 'old')
  const plan = await store.planBatch(scope, { from: 1, to: 1, token: 'old', candidates: [fact(source)] })
  await store.claimWorker(scope, 'new')
  await assert.rejects(store.commit(scope, plan), /memory_stale_worker/)
  assert.equal((await store.snapshot(scope)).meta.extractedThrough, '0')
  plan.token = 'new'
  await fixture.client.command('ZREMRANGEBYSCORE', store.keys(scope)[10], 1, 1)
  await assert.rejects(store.commit(scope, plan), /memory_source_changed/)
})

test('V3 wrong key type and incomplete-write fence block commit, reads and garbage collection', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  const plan = await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] })
  await fixture.client.set(store.keys(scope)[3], 'wrong')
  await assert.rejects(store.commit(scope, plan), /memory_key_type/)
  assert.equal(await fixture.client.command('HGET', store.keys(scope)[0], 'extractedThrough'), '0')
  await fixture.client.del(store.keys(scope)[3])
  await fixture.client.command('HSET', store.keys(scope)[0], 'writePending', 'interrupted')
  await assert.rejects(store.snapshot(scope), /memory_incomplete_write/)
  await assert.rejects(store.commit(scope, plan), /memory_incomplete_write/)
  await assert.rejects(store.reclaim(scope, { retain: 0 }), /memory_incomplete_write/)
})

test('V3 confirmed change retains revision history, and old evidence cannot replace a new fact', async () => {
  const { store, scope, add } = await environment()
  let source = await add('1')
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] }))
  const id = Object.keys((await store.snapshot(scope)).facts)[0]
  source = await add('2', '我现在不喜欢咖啡了', 1800000100)
  await store.commit(scope, await store.planBatch(scope, { from: 2, to: 2, candidates: [fact(source, { value: false, text: '不喜欢咖啡', action: 'replace', changeKind: 'change', verified: true, targetId: id })] }))
  let state = await store.snapshot(scope)
  assert.equal(state.facts[id].value, false)
  assert.equal(state.revisions[`${id}:1`].value, true)
  source = await add('3', '我喜欢咖啡', 1799999900)
  await store.commit(scope, await store.planBatch(scope, { from: 3, to: 3, candidates: [fact(source, { action: 'replace', changeKind: 'correction', verified: true, targetId: id })] }))
  state = await store.snapshot(scope)
  assert.equal(state.facts[id].value, false)
  assert.equal(Object.values(state.review)[0].reason, 'older_evidence')
})

test('V3 master edits invalidate outstanding plans; deletion tombstones prevent resurrection', async () => {
  const { store, scope, add } = await environment()
  let source = await add('1')
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] }))
  const id = Object.keys((await store.snapshot(scope)).facts)[0]
  source = await add('2')
  const stale = await store.planBatch(scope, { from: 2, to: 2, candidates: [fact(source)] })
  await store.manage(scope, { action: 'delete', id, actorId: 'master', isMaster: true })
  await assert.rejects(store.commit(scope, stale), /memory_conflict/)
  await store.commit(scope, await store.planBatch(scope, { from: 2, to: 2, candidates: [fact(source)] }))
  assert.equal(Object.values((await store.snapshot(scope)).facts).filter(item => item.status === 'active').length, 0)
  assert.equal(Object.values((await store.snapshot(scope)).review)[0].reason, 'previously_removed')
  await store.manage(scope, { action: 'undo', id, actorId: 'master', isMaster: true })
  assert.equal((await store.snapshot(scope)).facts[id].status, 'active')
})

test('V3 confirmation, rejection and group isolation require master and matching current revision', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source, { decision: 'review' })] }))
  const id = Object.keys((await store.snapshot(scope)).review)[0]
  await assert.rejects(store.manage(scope, { action: 'confirm', id, actorId: '101' }), /master_required/)
  const other = store.scope('bot', randomUUID())
  await assert.rejects(store.manage(other, { action: 'confirm', id, actorId: 'master', isMaster: true }), /review_missing/)
  await store.manage(scope, { action: 'confirm', id, actorId: 'master', isMaster: true })
  assert.equal(Object.keys((await store.snapshot(scope)).facts).length, 1)
  assert.equal(Object.keys((await store.snapshot(other)).facts).length, 0)
})

test('V3 events keep lifecycle/date precision and revisions instead of confusing plans with occurrences', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1', '明天一起联机')
  const event = { type: 'event', title: '联机', text: '计划联机', participants: ['101'], time: { start: '2027-01', precision: 'month' }, lifecycle: 'planned', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }] }
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [event] }))
  const value = Object.values((await store.snapshot(scope)).events)[0]
  assert.equal(value.lifecycle, 'planned')
  assert.equal(value.time.precision, 'month')
  assert.equal(await fixture.client.command('ZCARD', store.keys(scope)[8]), 1)
})

test('V3 garbage collection only removes committed sources, is idempotent, and preserves evidence/context', async () => {
  const { store, scope, add } = await environment()
  const source = await add('1')
  await add('2', 'hello')
  assert.equal((await store.reclaim(scope, { retain: 0 })).removed, 0)
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [fact(source)] }))
  assert.equal((await store.reclaim(scope, { retain: 0 })).removed, 1)
  assert.equal((await store.reclaim(scope, { retain: 0 })).removed, 0)
  assert.equal((await store.sources.readSourceRange(scope, { after: 1 })).rows.length, 1)
  assert.equal(Object.values((await store.snapshot(scope)).evidence)[0].quote, source.text)
  assert.equal(JSON.parse((await store.snapshot(scope)).meta.contextTail).length, 1)
  await add('3')
  assert.equal((await store.sources.status(scope)).pending, 2)
})
