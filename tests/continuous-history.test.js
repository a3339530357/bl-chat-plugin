import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { ContextStore } from '../core/contextStore.js'
import { promptCacheSettings } from '../core/promptCache.js'
import { buildPromptCacheHeaders } from '../core/prompts.js'
import { redisFixture } from './helpers/redis-fixture.js'

// 跨天连续对话：连续账本不按天分键、滚动过期；按天模式（旧行为）跨午夜开新账本。
let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })

const continuous = promptCacheSettings({ promptCache: { continuousHistory: true } })
const dayScoped = promptCacheSettings({ promptCache: { continuousHistory: false } })
const header = buildPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group' } }, [])
// 未来日期，避免 GUARD 用 redis 真实时钟判定过期
const day1Noon = Date.UTC(2027, 4, 1, 4, 0, 0)
const day2Noon = day1Noon + 24 * 3600 * 1000
const block = id => ({ turnId: id, referenceVersion: 2, toolRows: [{ role: 'user', content: id }], chatRows: [{ role: 'user', content: id }], tokens: 10, messageIds: [id] })

test('continuous ledger keeps one key across midnight and retains yesterday replay', async () => {
  const store = new ContextStore(fixture.client, `test:cont:${randomUUID()}:`)
  const today = await store.scope('bot', 'group', { now: day1Noon, settings: continuous })
  assert.ok(today.root.endsWith('}:'), 'continuous key has no day part')
  await store.record(today, { eventId: 'source-1', message: { content: 'hi', sender: { user_id: '42' } } })
  await store.commit(today, { turnId: 't1', readUntil: 1, baseCursor: 0, observers: [], represented: ['source-1'], block: block('t1') })

  const tomorrow = await store.scope('bot', 'group', { now: day2Noon, settings: continuous })
  assert.equal(tomorrow.root, today.root, 'same key next day')
  assert.equal(tomorrow.resetId, today.resetId, 'same epoch next day')
  const snapshot = await store.read(tomorrow, header, continuous)
  assert.deepEqual(snapshot.blocks.map(entry => entry.turnId), ['t1'], 'yesterday replay survives')
  assert.equal(snapshot.cursor, 1)

  // 新一天的对话接着昨天的账本继续
  await store.record(tomorrow, { eventId: 'source-2', message: { content: 'morning', sender: { user_id: '42' } } })
  await store.commit(tomorrow, { turnId: 't2', readUntil: 2, baseCursor: 1, observers: [], represented: ['source-2'], block: block('t2') })
  const merged = await store.read(tomorrow, header, continuous)
  assert.deepEqual(merged.blocks.map(entry => entry.turnId), ['t1', 't2'])
})

test('day-scoped ledger (legacy mode) still starts fresh after midnight', async () => {
  const store = new ContextStore(fixture.client, `test:cont:${randomUUID()}:`)
  const today = await store.scope('bot', 'group', { now: day1Noon, settings: dayScoped })
  await store.record(today, { eventId: 'source-1', message: { content: 'hi', sender: { user_id: '42' } } })
  await store.commit(today, { turnId: 't1', readUntil: 1, baseCursor: 0, observers: [], represented: ['source-1'], block: block('t1') })

  const tomorrow = await store.scope('bot', 'group', { now: day2Noon, settings: dayScoped })
  assert.notEqual(tomorrow.root, today.root, 'different key per day')
  const snapshot = await store.read(tomorrow, header, dayScoped)
  assert.deepEqual(snapshot.blocks, [], 'next day starts empty')
})

test('commit reclaims digested raw events but keeps dedupe index consistent', async () => {
  const store = new ContextStore(fixture.client, `test:cont:${randomUUID()}:`)
  const scope = await store.scope('bot', 'group', { now: day1Noon, settings: continuous })
  await store.record(scope, { eventId: 'source-1', message: { content: 'hi', sender: { user_id: '42' } } })
  await store.record(scope, { eventId: 'source-2', message: { content: 'again', sender: { user_id: '42' } } })
  await store.read(scope, header, continuous)
  await store.commit(scope, { turnId: 't1', readUntil: 2, baseCursor: 0, observers: [], represented: ['source-1', 'source-2'], block: block('t1') })

  const after = await store.read(scope, header, continuous)
  assert.equal(after.rawCount, 0, 'digested events are reclaimed')
  assert.equal(after.cursor, 2)
  // 查重索引保留：重启后 seed 补录同 eventId 仍幂等
  const replayed = await store.record(scope, { eventId: 'source-1', message: { content: 'hi', sender: { user_id: '42' } } })
  assert.equal(replayed.duplicate, true)
  // 未消化事件不受影响
  await store.record(scope, { eventId: 'source-3', message: { content: 'fresh', sender: { user_id: '42' } } })
  const next = await store.read(scope, header, continuous)
  assert.equal(next.rawCount, 1)
  assert.equal(next.events.length, 1)
  assert.equal(next.events[0].eventId, 'source-3')
})

test('continuous reset starts a clean epoch under the same key', async () => {
  const store = new ContextStore(fixture.client, `test:cont:${randomUUID()}:`)
  const scope = await store.scope('bot', 'group', { now: day1Noon, settings: continuous })
  await store.record(scope, { eventId: 'source-1', message: { content: 'hi', sender: { user_id: '42' } } })
  await store.commit(scope, { turnId: 't1', readUntil: 1, baseCursor: 0, observers: [], represented: ['source-1'], block: block('t1') })

  await store.reset('bot', 'group', { now: day1Noon + 1000, settings: continuous })
  const fresh = await store.scope('bot', 'group', { now: day1Noon + 2000, settings: continuous })
  assert.equal(fresh.root, scope.root)
  assert.notEqual(fresh.resetId, scope.resetId)
  const snapshot = await store.read(fresh, header, continuous)
  assert.deepEqual(snapshot.blocks, [])
  await assert.rejects(store.read(scope, header, continuous), { code: 'stale_scope' })
})
