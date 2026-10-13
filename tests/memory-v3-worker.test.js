import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MemoryService } from '../utils/memory/MemoryService.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { MemoryExtractorV3 } from '../utils/memory/MemoryExtractorV3.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'
import { redisFixture } from './helpers/redis-fixture.js'

let fixture
const originalFetch = globalThis.fetch
before(async () => { fixture = await redisFixture(); globalThis.fetch = () => { throw new Error('real network forbidden') } })
after(async () => { globalThis.fetch = originalFetch; await fixture?.stop() })

function fakeModel(messages) {
  const input = JSON.parse(messages[1].content)
  if (input.candidates) return JSON.stringify({ complete: true, verdicts: input.candidates.map((item, index) => ({ index, decision: 'supported', reason: 'explicit quote' })) })
  return JSON.stringify({ complete: true, candidates: input.messages.filter(row => row.text.includes('我喜欢咖啡')).map(row => ({ type: 'fact', subjectId: row.senderId,
    kind: 'preference', slot: 'preference:coffee', value: true, text: '喜欢咖啡', basis: 'self_report', decision: 'accept', evidence: [{ eventId: row.eventId, quote: '我喜欢咖啡' }] })) })
}

async function environment(model = fakeModel, options = {}) {
  const store = new MemoryStoreV3(fixture.client)
  const scope = store.scope('bot', randomUUID())
  const config = { memoryV3: { groups: [scope.groupId], batchMessages: 2, batchTokens: 1024, timeoutMs: 10000, retryDelayMs: 1, ...options }, memoryAiConfig: { memoryAiModel: 'fake' } }
  const service = new MemoryService(config, { store, model })
  const add = async (id, text = '我喜欢咖啡') => {
    const source = buildMemorySource({ message_id: id, user_id: '101', time: 1800000000, message: [{ type: 'text', text }] }, scope)
    await store.sources.record(scope, source)
    return source
  }
  return { store, scope, config, service, add }
}

async function drain(service) { await Promise.all(service.running.values()) }
function deferred() { let resolve; const promise = new Promise(done => { resolve = done }); return { promise, resolve } }

test('worker freezes cutoff, runs independently of live intake and deduplicates repeated starts', async () => {
  const gate = deferred(); const entered = deferred()
  const env = await environment(async messages => { entered.resolve(); await gate.promise; return fakeModel(messages) })
  await env.add('1')
  const first = await env.service.start(env.scope)
  await entered.promise
  await env.add('2')
  const repeated = await env.service.start(env.scope)
  assert.equal(repeated.job.id, first.job.id)
  assert.equal(repeated.job.target, 1)
  assert.equal(env.service.running.size, 1)
  gate.resolve(); await drain(env.service)
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '1')
  assert.equal((await env.store.sources.status(env.scope)).pending, 1)
  assert.equal((await env.service.jobs.get(env.scope, first.job.id)).job.status, 'complete')
})

test('global extraction queue limits two groups to one active fake model call', async () => {
  let active = 0; let max = 0
  const model = async messages => { active++; max = Math.max(max, active); await new Promise(resolve => setTimeout(resolve, 5)); active--; return fakeModel(messages) }
  const a = await environment(model); const b = await environment(model)
  await a.add('1'); await b.add('1')
  await Promise.all([a.service.start(a.scope), b.service.start(b.scope)])
  await Promise.all([drain(a.service), drain(b.service)])
  assert.equal(max, 1)
  assert.equal((await b.store.snapshot(b.scope)).meta.extractedThrough, '1')
})

for (const failure of ['invalid_json', 'truncated', 'timeout', '429']) {
  test(`worker ${failure} leaves sources unprocessed and persists the failed job`, async () => {
    let calls = 0
    const env = await environment(() => {
      calls++
      if (failure === 'invalid_json') return '{'
      if (failure === 'truncated') return { choices: [{ finish_reason: 'length', message: { content: '{"complete":true,"candidates":[]}' } }] }
      if (failure === '429') throw new Error('429')
      return new Promise(() => {})
    }, { timeoutMs: 20, maxAttempts: 2 })
    await env.add('1')
    const { job } = await env.service.start(env.scope)
    await drain(env.service)
    assert.equal((await env.service.jobs.get(env.scope, job.id)).job.status, 'failed')
    assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '0')
    assert.equal((await env.store.sources.status(env.scope)).pending, 1)
    assert.equal(calls, 2)
  })
}

test('legitimate empty batch advances and saves audit without generating memory', async () => {
  const env = await environment()
  await env.add('1', '普通聊天没有稳定信息')
  await env.service.start(env.scope); await drain(env.service)
  const state = await env.store.snapshot(env.scope)
  assert.equal(state.meta.extractedThrough, '1')
  assert.equal(Object.keys(state.facts).length, 0)
  assert.equal(Object.values(state.batches)[0].audit.parts[0].candidateCount, 0)
})

test('long message fragments persist progress and resume a failed part without redoing completed parts', async () => {
  const seen = []; let fail = true
  const model = messages => {
    const input = JSON.parse(messages[1].content)
    seen.push(input.fragment.offset)
    assert.equal(input.messages[0].segments, undefined, 'full original segments must not bypass fragment budget')
    if (fail && input.fragment.offset > 0) throw new Error('429')
    return JSON.stringify({ complete: true, candidates: [] })
  }
  const env = await environment(model, { batchTokens: 256, maxAttempts: 1 })
  await env.add('long', '普通文本'.repeat(100))
  const result = await env.service.start(env.scope); await drain(env.service)
  assert.equal((await env.service.jobs.get(env.scope, result.job.id)).job.batch.nextPart, 1)
  fail = false
  const resumed = new MemoryService(env.config, { store: env.store, model })
  await resumed.start(env.scope); await drain(resumed)
  assert.equal(seen.filter(offset => offset === 0).length, 1)
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '1')
})

test('lost commit response resumes from committed cursor without applying or extracting again', async () => {
  const env = await environment()
  await env.add('1')
  const commit = env.store.commit.bind(env.store)
  let lose = true
  env.store.commit = async (...args) => { const value = await commit(...args); if (lose) { lose = false; throw new Error('reply_lost') }; return value }
  const started = await env.service.start(env.scope); await drain(env.service)
  assert.equal((await env.service.jobs.get(env.scope, started.job.id)).job.status, 'failed')
  const restarted = new MemoryService(env.config, { store: env.store, model: () => { throw new Error('must not call model again') } })
  await restarted.start(env.scope); await drain(restarted)
  assert.equal(Object.keys((await env.store.snapshot(env.scope)).facts).length, 1)
  assert.equal((await restarted.jobs.get(env.scope, started.job.id)).job.status, 'complete')
})

test('disable aborts only memory work, keeps progress and sources, and resuming preserves original cutoff', async () => {
  const entered = deferred()
  const env = await environment(() => { entered.resolve(); return new Promise(() => {}) })
  await env.add('1')
  const started = await env.service.start(env.scope)
  await entered.promise
  env.service.updateConfig({ ...env.config, memoryV3: { ...env.config.memoryV3, organizeEnabled: false } })
  await drain(env.service)
  assert.equal((await env.service.jobs.get(env.scope, started.job.id)).job.status, 'paused')
  await env.add('2')
  const resumed = new MemoryService(env.config, { store: env.store, model: fakeModel })
  await resumed.resumeAll(); await drain(resumed)
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '1')
})

test('expired job lease permits recovery and rejects the old worker commit', async () => {
  const env = await environment()
  await env.add('1')
  const { job } = await env.service.jobs.start(env.scope)
  await env.service.jobs.claim(env.scope, job.id, 'dead-process', 0)
  const oldPlan = await env.store.planBatch(env.scope, { from: 1, to: 1, token: 'dead-process' })
  await env.service.jobs.claim(env.scope, job.id, 'replacement', 0)
  await assert.rejects(env.store.commit(env.scope, oldPlan), /stale_worker/)
  await env.service.resumeAll(); await drain(env.service)
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, '1')
})

test('extractor normalizes relative dates from source time and sends ungrounded birthday calendar to review', async () => {
  const scope = { botId: 'bot', groupId: 'group' }
  const source = { ...buildMemorySource({ message_id: '1', user_id: '101', time: '2026-10-03 23:00:00', message: [{ type: 'text', text: '明天联机，我生日是八月十五。' }] }, scope), memorySeq: 1 }
  const extractor = new MemoryExtractorV3({}, messages => {
    const input = JSON.parse(messages[1].content)
    if (input.candidates) return fakeModel(messages)
    return JSON.stringify({ complete: true, candidates: [
      { type: 'event', title: '联机', text: '计划联机', participants: ['101'], lifecycle: 'planned', time: { relativeDays: 1, anchorEventId: source.eventId }, evidence: [{ eventId: source.eventId, quote: '明天联机' }] },
      { type: 'fact', subjectId: '101', slot: 'birthday', value: { month: 8, day: 15, calendar: 'solar', year: 2000 }, text: '生日八月十五', evidence: [{ eventId: source.eventId, quote: '我生日是八月十五。' }] }
    ] })
  })
  const result = await extractor.extractPart({ messages: [source], context: [], existing: {} }, new AbortController().signal)
  assert.equal(result.candidates[0].time.start, '2026-10-04')
  assert.equal(result.candidates[0].lifecycle, 'planned')
  assert.equal(result.candidates[1].decision, 'review')
})

test('independent verifier rejects unsupported facts rather than trusting extractor confidence', async () => {
  const env = await environment(messages => {
    const input = JSON.parse(messages[1].content)
    if (input.candidates) return JSON.stringify({ complete: true, verdicts: [{ index: 0, decision: 'unsupported', reason: 'not stable' }] })
    return fakeModel(messages)
  })
  await env.add('1'); await env.service.start(env.scope); await drain(env.service)
  assert.equal(Object.keys((await env.store.snapshot(env.scope)).facts).length, 0)
})
