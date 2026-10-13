import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { redisFixture } from './helpers/redis-fixture.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { MemoryService } from '../utils/memory/MemoryService.js'
import { MemoryLegacyImporter } from '../utils/memory/MemoryLegacyImporter.js'
import { MemoryAdminV3 } from '../utils/memory/MemoryAdminV3.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'

let fixture
const originalFetch = globalThis.fetch
before(async () => { fixture = await redisFixture(); globalThis.fetch = () => { throw new Error('real API forbidden') } })
after(async () => { globalThis.fetch = originalFetch; await fixture?.stop() })

async function environment(options = {}) {
  const store = new MemoryStoreV3(fixture.client)
  const scope = store.scope('bot', randomUUID())
  const config = { memoryV3: { groups: [scope.groupId], extractor: 'flash', batchMessages: 1, timeoutMs: 10000, ...options } }
  const add = async (id, text, userId = '101') => {
    const message = { message_id: id, time: 1800000000 + Number(id || 0), user_id: userId, sender: { user_id: userId, nickname: userId }, message: [{ type: 'text', text }] }
    const source = buildMemorySource(message, scope)
    await store.sources.record(scope, source)
    return { message, source }
  }
  return { store, scope, config, add }
}

const fact = (source, extra = {}) => ({ type: 'fact', subjectId: source.senderId, kind: 'identity', slot: 'occupation', text: source.text, value: source.text,
  basis: 'self_report', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }], ...extra })

test('manual archive import is idempotent with live overlap and preserves unknown replay provenance', async () => {
  const env = await environment()
  const { message, source } = await env.add('1', '我是程序员')
  const archive = env.store.sources.snapshotKeys(env.scope)[1]
  await fixture.client.command('HSET', archive, 'recent', JSON.stringify([message]),
    'raw:1', JSON.stringify({ seq: 1, payload: JSON.stringify({ eventId: source.eventId, message }) }),
    'replay:0', JSON.stringify({ messageIds: [], apiRows: [{ role: 'user', content: '[12:00] 某人：生日快乐' }, { role: 'assistant', content: '不应导入机器人回复' }] }))
  await env.store.sources.updateSnapshot(env.scope, { resetId: 'old', rawFrom: 1, rawUntil: 1, replayCaptured: 1, gap: 'previous_history_missing' })
  const importer = new MemoryLegacyImporter(env.store)
  const first = await importer.import(env.scope)
  const second = await importer.import(env.scope)
  assert.equal(first.imported, 1)
  assert.equal(second.imported, 0)
  assert.equal(first.coverage.gap, 'previous_history_missing')
  const rows = (await env.store.sources.readSourceRange(env.scope)).rows
  assert.equal(rows.length, 2)
  assert.equal(rows[1].senderId, null)
  assert.equal(rows[1].sentAt, null)
  assert.equal(rows[1].fidelity, 'legacy_content')
  assert.ok(!rows.some(row => row.text.includes('机器人回复')))
})

test('old V1 and V2 facts import as one unverified review without mutating the old namespace or another group', async () => {
  const env = await environment()
  const key = `ytbot:memory:v2:fact:user:${env.scope.groupId}:101:old`
  const old = JSON.stringify({ scope: 'user', groupId: env.scope.groupId, userId: '101', content: '喜欢古典音乐', status: 'active' })
  await fixture.client.set(key, old)
  const v1Key = `ytbot:memory:${env.scope.groupId}:101`
  await fixture.client.set(v1Key, JSON.stringify({ facts: ['喜欢古典音乐'] }))
  await fixture.client.set(`ytbot:memory:v2:fact:user:other:101:x`, JSON.stringify({ scope: 'user', groupId: 'other', userId: '101', content: '别的群秘密' }))
  const importer = new MemoryLegacyImporter(env.store)
  assert.equal((await importer.import(env.scope)).reviews, 1)
  assert.equal((await importer.import(env.scope)).reviews, 0)
  const state = await env.store.snapshot(env.scope)
  assert.equal(Object.keys(state.facts).length, 0)
  assert.equal(Object.keys(state.review).length, 1)
  assert.equal(Object.values(state.review)[0].reason, 'legacy_without_original_evidence')
  assert.ok(!JSON.stringify(state).includes('别的群秘密'))
  assert.equal(await fixture.client.get(key), old)
})

test('legacy content with missing source identity cannot automatically become an occurred event', async () => {
  const env = await environment()
  const source = buildMemorySource({ content: '生日聚会' }, env.scope, { legacy: true, eventId: 'legacy-record' })
  await env.store.sources.record(env.scope, source)
  const candidate = { type: 'event', title: '生日聚会', text: '生日聚会已举办', time: { start: null, precision: 'unknown' }, participants: [], lifecycle: 'occurred', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }] }
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [candidate] }))
  const state = await env.store.snapshot(env.scope)
  assert.equal(Object.keys(state.events).length, 0)
  assert.equal(Object.values(state.review)[0].reason, 'legacy_source_uncertain')
})

test('member disable hides core facts and prevents future extraction while source collection remains active', async () => {
  const env = await environment()
  const { source } = await env.add('1', '我是程序员')
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(source)] }))
  const service = new MemoryService(env.config, { store: env.store, model: () => { throw new Error('disabled member must not reach model') } })
  const admin = new MemoryAdminV3(service, { self_id: 'bot', user_id: '101' })
  await admin.adminSetUserMemoryEnabled({ groupId: env.scope.groupId, userId: '101', enabled: false })
  assert.ok(!(await service.buildMemoryTail({ botId: 'bot', groupId: env.scope.groupId })).includes('我是程序员'))
  await env.add('2', '更多个人信息')
  await service.start(env.scope); await Promise.all(service.running.values())
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '2')
  assert.equal((await env.store.sources.status(env.scope)).resident, 2)
  await admin.adminSetUserMemoryEnabled({ groupId: env.scope.groupId, userId: '101', enabled: true })
  assert.ok((await service.buildMemoryTail({ botId: 'bot', groupId: env.scope.groupId })).includes('我是程序员'))
})

test('member forget and group clear invalidate stale work without deleting protected original data', async () => {
  const env = await environment()
  const { source } = await env.add('1', '我是程序员')
  const stale = await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(source)] })
  await env.store.forget(env.scope, { subjectId: '101', actorId: '101' })
  await assert.rejects(env.store.commit(env.scope, stale), /memory_conflict/)
  const result = await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(source)] }))
  assert.equal(result.batch.counts.rejected, 1)
  assert.equal((await env.store.sources.status(env.scope)).resident, 1)
  await assert.rejects(env.store.forget(env.scope, { actorId: '101' }), /memory_permission/)
  await env.store.forget(env.scope, { actorId: 'master', isMaster: true })
  assert.equal((await env.store.sources.status(env.scope)).resident, 1)
  const service = new MemoryService(env.config, { store: env.store, model: () => { throw new Error('forgotten sources must not reach model') } })
  const output = await service.requestPart(env.scope, { messages: [{ ...source, memorySeq: 1 }], context: [], existing: { facts: [], events: [] } })
  assert.equal(output.audit.excludedSources, true)
})

test('group rollout and rollback switches preserve storage and never reenable legacy retrieval', async () => {
  const env = await environment()
  const other = env.store.scope('bot', randomUUID())
  const { source } = await env.add('1', '我是程序员')
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(source)] }))
  const service = new MemoryService(env.config, { store: env.store, model: () => '{"complete":true,"candidates":[]}' })
  assert.equal(await service.buildMemoryTail({ botId: 'bot', groupId: other.groupId }), '')
  service.updateConfig({ memoryV3: { groups: [env.scope.groupId, other.groupId] } })
  assert.match(await service.buildMemoryTail({ botId: 'bot', groupId: other.groupId }), /暂无已确认核心事实/)
  service.updateConfig({ memoryV3: { groups: [env.scope.groupId], injectEnabled: false, organizeEnabled: false } })
  assert.equal(await service.buildMemoryTail({ botId: 'bot', groupId: env.scope.groupId }), '')
  await assert.rejects(service.start(env.scope), /disabled/)
  const adapter = new MemoryAdminV3(service, { self_id: 'bot' })
  assert.equal(await adapter.getMemoryPromptForUser(), '')
  assert.equal(adapter.config.automaticExtraction, false)
  assert.equal(Object.keys((await env.store.snapshot(env.scope)).facts).length, 1)
})

test('completed task reclaims only committed excess sources and leaves evidence and last twenty context rows', async () => {
  const env = await environment({ batchMessages: 24 })
  for (let index = 1; index <= 25; index++) await env.add(String(index), '普通群聊')
  const service = new MemoryService(env.config, { store: env.store, model: () => '{"complete":true,"candidates":[]}' })
  const started = await service.start(env.scope)
  await Promise.all(service.running.values())
  const state = await env.store.snapshot(env.scope)
  assert.equal(state.meta.sourceReclaimedThrough, '5')
  assert.equal(state.meta.sourcePendingBytes, '0')
  assert.equal((await env.store.sources.status(env.scope)).resident, 20)
  assert.equal((await env.store.sources.status(env.scope)).pending, 0)
  assert.equal(JSON.parse(state.meta.contextTail).length, 20)
  const { job } = await service.jobs.get(env.scope, started.job.id)
  assert.ok(job.elapsedMs >= 0)
  assert.ok(job.lastModelMs >= 0)
  await env.add('26', '新原料必须留下')
  assert.equal((await env.store.sources.status(env.scope)).pending, 1)
})

test('integration covers add, correction, event update, rejection, review confirmation and empty batch', async () => {
  const env = await environment()
  const scenario = ['我是程序员', '更正：我是教师', '群内联机已举行', '那次联机的结果已补充', '我想吃火锅', '我爱猫，但不太确定', '天气真好']
  const model = messages => {
    const input = JSON.parse(messages[1].content)
    if (input.candidates) return JSON.stringify({ complete: true, verdicts: input.candidates.map((item, index) => ({ index, decision: item.text === '喜欢猫' ? 'ambiguous' : 'supported', reason: 'synthetic evidence check' })) })
    const row = input.messages[0]
    const index = Number(row.messageId || row.eventId.split(':').at(-1))
    let candidates = []
    if (index === 1) candidates = [fact(row)]
    if (index === 2) candidates = [fact(row, { targetId: input.existing.facts[0].id, action: 'replace', changeKind: 'correction' })]
    if (index === 3 || index === 4) candidates = [{ type: 'event', title: '群内联机', text: row.text, participants: ['101'], time: { start: '2026-10-01', precision: 'day' }, lifecycle: 'occurred', decision: 'accept',
      ...(index === 4 ? { targetId: input.existing.events[0].id, action: 'replace', changeKind: 'change' } : {}), evidence: [{ eventId: row.eventId, quote: row.text }] }]
    if (index === 5) candidates = [fact(row, { evidence: [{ eventId: 'invented', quote: '编造' }] })]
    if (index === 6) candidates = [fact(row, { slot: 'preference:cat', kind: 'preference', text: '喜欢猫', value: true })]
    return JSON.stringify({ complete: true, candidates })
  }
  for (const [index, text] of scenario.entries()) await env.add(String(index + 1), text)
  const service = new MemoryService(env.config, { store: env.store, model })
  const started = await service.start(env.scope); await Promise.all(service.running.values())
  const state = await env.store.snapshot(env.scope)
  assert.equal((await service.jobs.get(env.scope, started.job.id)).job.status, 'complete')
  assert.equal(state.meta.extractedThrough, '7')
  assert.equal(Object.values(state.facts)[0].text, '更正：我是教师')
  assert.equal(Object.values(state.events)[0].revision, 2)
  assert.equal(Object.values(state.batches).reduce((sum, item) => sum + (item.counts?.rejected || 0), 0), 1)
  const review = Object.values(state.review).find(item => item.candidate.text === '喜欢猫')
  assert.equal(review.status, 'pending')
  await env.store.manage(env.scope, { action: 'confirm', id: review.id, actorId: 'master', isMaster: true })
  assert.equal(Object.values((await env.store.snapshot(env.scope)).facts).filter(item => item.status === 'active').length, 2)
})

test('multiple occupations coexist while explicit target correction revises only its target', async () => {
  const env = await environment()
  const a = await env.add('1', '我是程序员')
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(a.source)] }))
  const b = await env.add('2', '我还兼职教师')
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 2, to: 2, candidates: [fact(b.source)] }))
  const state = await env.store.snapshot(env.scope)
  assert.equal(Object.keys(state.facts).length, 2)
  assert.equal(Object.keys(state.review).length, 0)
})

test('recall snapshot excludes growing audit, evidence and source context payloads', async () => {
  const env = await environment()
  const { source } = await env.add('1', '我是程序员')
  await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [fact(source)], audit: { input: 'AUDIT_ONLY'.repeat(1000) } }))
  const full = await env.store.snapshot(env.scope)
  const view = await env.store.snapshot(env.scope, { mode: 'recall' })
  assert.ok(JSON.stringify(full).includes('AUDIT_ONLY'))
  assert.ok(!JSON.stringify(view).includes('AUDIT_ONLY'))
  assert.deepEqual(view.evidence, {})
  assert.deepEqual(view.revisions, {})
  assert.equal(view.meta.contextTail, undefined)
  assert.equal(Object.keys(view.facts).length, 1)
})

test('delayed extraction leaves event loop and live Redis intake responsive with a fixed cutoff', async () => {
  const env = await environment()
  await env.add('1', '普通聊天')
  let release; let entered
  const gate = new Promise(resolve => { release = resolve })
  const started = new Promise(resolve => { entered = resolve })
  const service = new MemoryService(env.config, { store: env.store, model: async () => { entered(); await gate; return '{"complete":true,"candidates":[]}' } })
  let ticks = 0
  const timer = setInterval(() => ticks++, 1)
  try {
    await service.start(env.scope); await started
    await env.add('2', '模型等待期间的消息')
    assert.equal((await env.store.sources.status(env.scope)).pending, 2)
    assert.ok(ticks > 0)
  } finally { clearInterval(timer); release(); await Promise.all(service.running.values()) }
  assert.equal((await env.store.sources.status(env.scope)).pending, 1)
})

test('truncated model input splits persistently without changing the source batch or double committing', async () => {
  const env = await environment({ batchMessages: 2 })
  await env.add('1', '普通消息一'); await env.add('2', '普通消息二')
  const calls = []
  const service = new MemoryService(env.config, { store: env.store, model: messages => {
    const input = JSON.parse(messages[1].content); calls.push(input.messages.map(row => row.memorySeq))
    if (input.messages.length > 1) return { choices: [{ finish_reason: 'length', message: { content: '{}' } }] }
    return '{"complete":true,"candidates":[]}'
  } })
  await service.start(env.scope); await Promise.all(service.running.values())
  assert.deepEqual(calls, [[1, 2], [1], [2]])
  const state = await env.store.snapshot(env.scope)
  assert.equal(state.meta.extractedThrough, '2')
  assert.equal(state.meta.committedBatchCount, '1')
  const receipt = Object.values(state.batches)[0]
  assert.equal(receipt.audit.splits.length, 1)
  assert.equal(receipt.from, 1); assert.equal(receipt.to, 2)
})

test('impossible birthdays are rejected and cross-year event ranges remain searchable at both ends', async () => {
  const env = await environment()
  const { source } = await env.add('1', '我的公历生日是二月，跨年活动在2025年12月31日到2026年1月1日举行。')
  const evidence = [{ eventId: source.eventId, quote: source.text }]
  const result = await env.store.commit(env.scope, await env.store.planBatch(env.scope, { from: 1, to: 1, candidates: [
    fact(source, { slot: 'birthday', value: { month: 2, day: 31, calendar: 'solar', year: null } }),
    { type: 'event', title: '跨年活动', text: '跨年活动已举行', time: { start: '2025-12-31', end: '2026-01-01', precision: 'range' }, lifecycle: 'occurred', participants: ['101'], decision: 'accept', evidence }
  ] }))
  assert.equal(result.batch.counts.rejected, 1)
  const service = new MemoryService(env.config, { store: env.store, model: () => { throw new Error('retrieval must stay local') } })
  const tail = await service.buildMemoryTail({ botId: 'bot', groupId: env.scope.groupId, queryContext: { text: '2026年的跨年活动' } })
  assert.match(tail, /2025-12-31～2026-01-01/)
})
