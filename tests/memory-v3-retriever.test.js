import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { redisFixture } from './helpers/redis-fixture.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { MemoryRetrieverV3 } from '../utils/memory/MemoryRetrieverV3.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'

let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })

async function environment() {
  const store = new MemoryStoreV3(fixture.client)
  const scope = store.scope('bot', randomUUID())
  const source = buildMemorySource({ user_id: '101', sender: { user_id: '101', nickname: '阿甲' }, message_id: '1', time: 1800000000,
    message: [{ type: 'text', text: '我是前端开发，喜欢咖啡。2025年国庆联机已经举办，2026年国庆联机计划取消了。' }] }, scope)
  await store.sources.record(scope, source)
  const evidence = [{ eventId: source.eventId, quote: source.text }]
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [
    { type: 'fact', kind: 'identity', subjectId: '101', slot: 'occupation', text: '前端开发', value: '前端开发', basis: 'self_report', decision: 'accept', evidence },
    { type: 'event', title: '2025国庆联机', text: '国庆联机活动', time: { start: '2025-10-01', precision: 'day' }, participants: ['101'], lifecycle: 'occurred', decision: 'accept', evidence },
    { type: 'event', title: '2026国庆联机', text: '国庆联机计划取消', time: { start: '2026-10', precision: 'month' }, participants: ['101'], lifecycle: 'cancelled', decision: 'accept', evidence },
    { type: 'event', title: '日期不明的活动', text: '另一次活动，日期不明', time: { start: null, precision: 'unknown' }, participants: ['101'], lifecycle: 'unknown', decision: 'accept', evidence }
  ] }))
  const retriever = new MemoryRetrieverV3(store)
  return { store, scope, retriever, input: queryContext => ({ botId: scope.botId, groupId: scope.groupId, queryContext }) }
}

test('core facts are complete on every query and unrelated event lookup returns empty', async () => {
  const env = await environment()
  for (const query of ['煮面条要多久', '明天天气怎么样']) {
    const tail = await env.retriever.buildMemoryTail(env.input({ text: query }))
    assert.match(tail, /QQ 101.*前端开发/)
    assert.match(tail, /没有达到相关性要求的事件/)
    assert.ok(!tail.includes('国庆联机活动'))
  }
})

test('explicit and relative years retrieve older events without recency decay', async () => {
  const env = await environment()
  for (const query of ['2025年国庆联机', '去年国庆联机']) {
    const tail = await env.retriever.buildMemoryTail({ ...env.input({ text: query }), now: Date.parse('2026-10-13') })
    assert.match(tail, /2025-10-01/)
    assert.ok(!tail.includes('2026-10（'))
    assert.match(tail, /已发生/)
  }
})

test('same QQ in another group never reuses the core cache or event set', async () => {
  const env = await environment()
  await env.retriever.buildMemoryTail(env.input({ text: '国庆联机' }))
  const other = await env.retriever.buildMemoryTail({ botId: 'bot', groupId: randomUUID(), queryContext: { text: '国庆联机 QQ 101' } })
  assert.ok(!other.includes('前端开发'))
  assert.ok(!other.includes('国庆联机活动'))
  assert.match(other, /暂无已确认核心事实/)
})

test('core overflow is explicit and never silently truncates the all-core promise', async () => {
  const env = await environment()
  const state = await env.store.snapshot(env.scope)
  const id = Object.keys(state.facts)[0]
  await env.store.manage(env.scope, { action: 'edit', id, isMaster: true, actorId: 'master', patch: { text: '长期稳定事实'.repeat(120) } })
  env.retriever.updateConfig({ memoryV3: { coreTokens: 64 } })
  await assert.rejects(env.retriever.buildMemoryTail(env.input({})), /memory_core_over_budget/)
  assert.equal(env.retriever.status.get(env.scope.root).state, 'over_budget')
})

test('cancelled events retain month precision, and missing dates remain explicitly unknown', async () => {
  const env = await environment()
  const tail = await env.retriever.buildMemoryTail(env.input({ text: '2026年国庆联机' }))
  assert.match(tail, /2026-10（month）/)
  assert.match(tail, /已取消/)
  const unknown = await env.retriever.buildMemoryTail(env.input({ text: 'QQ 101 的活动', mentions: ['101'] }))
  assert.match(unknown, /日期不明（unknown）/)
  assert.match(unknown, /发生状态不明/)
})

test('tail uses one captured revision when a master correction arrives during rendering', async () => {
  const env = await environment()
  const original = env.store.snapshot.bind(env.store)
  let changed = false
  env.store.snapshot = async scope => {
    const captured = await original(scope)
    if (!changed) {
      changed = true
      await env.store.manage(scope, { action: 'edit', id: Object.keys(captured.facts)[0], actorId: 'master', isMaster: true, patch: { text: '后端开发', value: '后端开发' } })
    }
    return captured
  }
  const first = await env.retriever.buildMemoryTail(env.input({}))
  assert.match(first, /v1】/)
  assert.match(first, /前端开发/)
  assert.ok(!first.includes('后端开发'))
  const second = await env.retriever.buildMemoryTail(env.input({}))
  assert.match(second, /v2】/)
  assert.match(second, /后端开发/)
})

test('ambiguous shared nickname does not silently resolve to one QQ', async () => {
  const env = await environment()
  const source = buildMemorySource({ user_id: '102', sender: { user_id: '102', nickname: '阿甲' }, message_id: '2', message: [{ type: 'text', text: '我是医生' }] }, env.scope)
  await env.store.sources.record(env.scope, source)
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 2, to: 2, candidates: [
    { type: 'fact', kind: 'identity', subjectId: '102', slot: 'occupation', text: '医生', value: '医生', basis: 'self_report', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }] }
  ] }))
  const snapshot = await env.store.snapshot(env.scope)
  assert.deepEqual(env.retriever.retrieveEvents(snapshot, { text: '阿甲之前怎么样' }), [])
  assert.ok(env.retriever.retrieveEvents(snapshot, { text: '阿甲之前怎么样', mentions: ['101'] }).length > 0)
})

test('deletion invalidates core cache by revision and unavailable reads are distinct from empty', async () => {
  const env = await environment()
  await env.retriever.buildMemoryTail(env.input({}))
  const id = Object.keys((await env.store.snapshot(env.scope)).facts)[0]
  await env.store.manage(env.scope, { action: 'delete', id, isMaster: true, actorId: 'master' })
  assert.ok(!(await env.retriever.buildMemoryTail(env.input({}))).includes('前端开发'))
  env.store.snapshot = async () => { throw new Error('disconnected') }
  await assert.rejects(env.retriever.buildMemoryTail(env.input({})), /disconnected/)
  assert.equal(env.retriever.status.get(env.scope.root).state, 'unavailable')
})
