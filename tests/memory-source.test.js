import test, { before, after, afterEach } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { register } from 'node:module'
import { ContextStore } from '../core/contextStore.js'
import { MemorySourceStore } from '../utils/memory/MemorySourceStore.js'
import { memoryScope, buildMemorySource, memorySourceSettings, isMemorySourceEnabled, SOURCE_PAGE_LIMIT } from '../utils/memory/sourceSchema.js'
import { memorySourceStatusLines } from '../utils/memory/sourceStatus.js'
import { promptCacheSettings } from '../core/promptCache.js'
import { buildPromptCacheHeaders } from '../core/prompts.js'
import { redisFixture } from './helpers/redis-fixture.js'
import { memorySourceCases, sourceCaseEvent } from './fixtures/memory-source-messages.js'

register('./helpers/yunzai-cache-loader.mjs', import.meta.url)
globalThis.Bot = { uin: 'bot', nickname: 'Bot' }
globalThis.logger = { warn() {}, error() {}, info() {} }
const { MessageManager } = await import('../utils/MessageManager.js')
let fixture
const stores = []
before(async () => { fixture = await redisFixture(); globalThis.redis = fixture.client })
afterEach(async () => { for (const store of stores.splice(0)) await Promise.all(store.memorySources.historyTasks.values()) })
after(async () => { await fixture?.stop() })
const settings = promptCacheSettings({})
const header = buildPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot' }, [])
const block = id => ({ turnId: id, referenceVersion: 2, toolRows: [{ role: 'user', content: id }], chatRows: [{ role: 'user', content: id }], tokens: 20, messageIds: [id] })

async function environment() {
  const group = randomUUID()
  const store = new ContextStore(fixture.client, `test:source:${group}:`)
  stores.push(store)
  const scope = await store.scope('bot', group, { settings })
  const event = (id, text = id) => ({ ...sourceCaseEvent({ group, id, qq: '101', text }), received_at: Date.now() })
  const record = async (id, text = id) => {
    const message = event(id, text)
    const source = buildMemorySource(message, scope)
    return store.record(scope, { eventId: source.eventId, message }, settings, source)
  }
  return { store, scope, sources: store.memorySources, event, record, group }
}

test('memory source scope encodes delimiter IDs and isolates the same QQ across groups', async () => {
  assert.equal(memoryScope('a:b', 'c{d}').root, 'ytbot:memory:v3:{a%3Ab:c%7Bd%7D}:')
  assert.notEqual(memoryScope('a:b', 'c').root, memoryScope('a', 'b:c').root)
  const sourceStore = new MemorySourceStore(fixture.client)
  const bot = randomUUID()
  for (const item of memorySourceCases) {
    const scope = memoryScope(bot, item.group)
    const message = { ...sourceCaseEvent(item), self_id: bot }
    await sourceStore.record(scope, buildMemorySource(message, scope))
  }
  const a = await sourceStore.readSourceRange(memoryScope(bot, 'group-a'))
  const b = await sourceStore.readSourceRange(memoryScope(bot, 'group-b'))
  assert.equal(a.rows.length, memorySourceCases.length - 1)
  assert.deepEqual(b.rows.map(row => row.text), ['在这个群叫我阿乙。'])
  assert.equal(a.rows.find(row => row.messageId === 'quote').replyToMessageId, 'identity')
  assert.equal(a.rows.find(row => row.messageId === 'occurred').sentAt, '2026-10-03T16:15:00.000Z')
  assert.ok(a.rows.find(row => row.messageId === 'lunar').text.includes('农历'))
})

test('journal and source allocate once atomically, preserve arrays, and never attach ledger TTL to source keys', async () => {
  const { store, scope, sources, record } = await environment()
  const result = await record('first', '完整原文'.repeat(200))
  assert.equal(result.seq, 1)
  assert.equal(result.memorySeq, 1)
  assert.equal((await record('first')).memorySeq, 1)
  const page = await sources.readSourceRange(scope)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].text, '完整原文'.repeat(200))
  assert.deepEqual(page.rows[0].mentions, [])
  assert.deepEqual(page.rows[0].ledgerRef, { seq: 1, resetId: scope.resetId })
  for (const key of sources.keys(scope)) assert.equal(await fixture.client.command('TTL', key), -1)
  assert.ok(await fixture.client.command('TTL', store.keys(scope)[2]) > 0)
})

test('duplicate ledger event still backfills a missing memory source after old raw was reclaimed', async () => {
  const { store, scope, sources, event, record } = await environment()
  const source = buildMemorySource(event('old'), scope)
  await store.record(scope, { eventId: source.eventId, message: event('old') }, settings)
  await store.commit(scope, { turnId: 'old', readUntil: 1, baseCursor: 0, observers: [], block: block('old') })
  const result = await record('old')
  assert.equal(result.duplicate, true)
  assert.equal(result.memorySeq, 1)
  assert.equal(await fixture.client.command('ZCARD', store.keys(scope)[2]), 0)
  assert.equal((await sources.status(scope)).pending, 1)
})

test('raw reclaim and replay high water trimming do not affect protected sources', async () => {
  const { store, scope, sources, record } = await environment()
  await record('first')
  await store.commit(scope, { turnId: 'first', readUntil: 1, baseCursor: 0, observers: [], block: block('first') })
  const snapshot = await store.read(scope, header, { ...settings, highWater: 10, lowWater: 0, reserveTokens: 0 })
  assert.equal(snapshot.blocks.length, 0)
  assert.equal(snapshot.rawCount, 0)
  assert.deepEqual((await sources.readSourceRange(scope)).rows.map(row => row.messageId), ['first'])
})

test('continuous midnight and reset preserve sources and dedupe independently of ledger seq', async () => {
  const { store, scope, sources, event, record } = await environment()
  await record('first')
  const tomorrow = await store.scope('bot', scope.groupId, { now: Date.now() + 86400000, settings })
  assert.equal(tomorrow.resetId, scope.resetId)
  await store.reset('bot', scope.groupId, { settings })
  const fresh = await store.scope('bot', scope.groupId, { settings })
  for (const id of ['first', 'second']) {
    const source = buildMemorySource(event(id), fresh)
    await store.record(fresh, { eventId: source.eventId, message: event(id) }, settings, source)
  }
  assert.equal((await sources.status(scope)).pending, 2)
  assert.deepEqual((await sources.readSourceRange(scope)).rows.map(row => row.memorySeq), [1, 2])
})

test('ledger expiration through Redis expiry leaves permanent source and dedupe keys intact', async () => {
  const { store, scope, sources, record } = await environment()
  await record('first')
  // 使用真实 EXPIREAT 触发过期，不等待三天，也不改变来源键。
  for (const key of store.keys(scope)) await fixture.client.command('EXPIREAT', key, 1)
  assert.equal(await fixture.client.get(store.keys(scope)[0]), null)
  assert.equal((await sources.status(scope)).pending, 1)
  for (const key of sources.keys(scope)) assert.equal(await fixture.client.command('TTL', key), -1)
})

test('readSourceRange is bounded, side-effect-free, and stable with a fixed cutoff', async () => {
  const { sources, scope } = await environment()
  for (let i = 0; i < SOURCE_PAGE_LIMIT + 3; i++) await sources.record(scope, buildMemorySource(sourceCaseEvent({ id: String(i), group: scope.groupId, qq: '101', text: 'hi' }), scope))
  const before = await sources.status(scope)
  const first = await sources.readSourceRange(scope, { limit: 10000 })
  assert.equal(first.rows.length, SOURCE_PAGE_LIMIT)
  await sources.record(scope, buildMemorySource(sourceCaseEvent({ id: 'later', group: scope.groupId, qq: '101', text: 'later' }), scope))
  const next = await sources.readSourceRange(scope, { after: first.next, until: first.until })
  assert.equal(next.rows.length, 3)
  assert.ok(!next.rows.some(row => row.messageId === 'later'))
  assert.equal((await sources.status(scope)).meta.extractedThrough, before.meta.extractedThrough)
  await assert.rejects(sources.readSourceRange(scope, { after: -1 }), /memory_source_range/)
})

test('wrong source key type fails before journal writes and records a collection error', async () => {
  const { store, sources, scope, record } = await environment()
  await fixture.client.set(sources.keys(scope)[1], 'wrong-type')
  await assert.rejects(record('first'), /memory_source_type/)
  assert.equal(await fixture.client.get(store.keys(scope)[1]), null)
  assert.equal(await fixture.client.command('HLEN', store.keys(scope)[3]), 0)
  assert.match(await fixture.client.command('HGET', sources.keys(scope)[3], 'lastError'), /memory_source_type/)
})

test('Redis outage keeps an error for reconnection and never reports a successful capture', async () => {
  const { scope, event } = await environment()
  let offline = true
  const client = { eval: (...args) => offline ? Promise.reject(new Error('offline')) : fixture.client.eval(...args) }
  const sources = new MemorySourceStore(client)
  await assert.rejects(sources.record(scope, buildMemorySource(event('first'), scope)), /offline/)
  assert.equal(sources.errors.size, 1)
  offline = false
  await sources.record(scope, buildMemorySource(event('first'), scope))
  const status = await sources.status(scope)
  assert.equal(status.pending, 1)
  assert.equal(status.meta.lastError, 'offline')
  assert.equal(sources.errors.size, 0)
})

test('collection policy is independent of model and recall switches, and has explicit group selection', () => {
  const config = { enabled: false, memorySystem: { enabled: false }, promptCache: { enabled: false, groups: ['a'] } }
  assert.equal(isMemorySourceEnabled(config, 'a'), true)
  assert.equal(isMemorySourceEnabled(config, 'b'), false)
  assert.equal(isMemorySourceEnabled({ ...config, memorySource: { enabled: false } }, 'a'), false)
  assert.equal(isMemorySourceEnabled({ memorySource: { groups: ['a'] } }, 'a'), true)
})

test('reminder threshold only claims a cooldown and does not remove or process sources across restart', async () => {
  const { sources, scope, record } = await environment()
  await record('first')
  const cfg = memorySourceSettings({ memorySource: { remindMessages: 1 } })
  assert.equal((await sources.claimReminder(scope, cfg)).due, true)
  assert.equal((await new MemorySourceStore(fixture.client).claimReminder(scope, cfg)).due, false)
  const status = await sources.status(scope)
  assert.equal(status.pending, 1)
  assert.equal(status.meta.extractedThrough, '0')
  assert.match(memorySourceStatusLines(status).join('\n'), /待整理 1 条/)
  assert.match(memorySourceStatusLines(status).join('\n'), /旧自动提取已停用/)
})

test('old raw and recent messages import once with captured boundaries while replay stays verbatim', async () => {
  const { store, scope, sources, event } = await environment()
  for (const id of ['one', 'two']) {
    const source = buildMemorySource(event(id), scope)
    await store.record(scope, { eventId: source.eventId, message: event(id) }, settings)
  }
  await store.commit(scope, { turnId: 'old-turn', readUntil: 1, baseCursor: 0, observers: [], block: block('one') })
  const replay = await fixture.client.command('LINDEX', store.keys(scope)[5], 0)
  const state = await sources.preserveHistory(scope, store, [event('one'), event('two'), event('recent-only')])
  assert.equal(state.status, 'captured')
  assert.equal(state.rawFrom, '2')
  assert.equal(state.rawUntil, '2')
  assert.equal(state.recentCount, '3')
  assert.equal(await fixture.client.command('HGET', sources.snapshotKeys(scope)[1], 'replay:0'), replay)
  await new MemorySourceStore(fixture.client).preserveHistory(scope, store, [event('should-not-import')])
  assert.deepEqual((await sources.readSourceRange(scope)).rows.map(row => row.messageId).sort(), ['one', 'recent-only', 'two'])
  assert.equal(await fixture.client.command('TTL', sources.snapshotKeys(scope)[1]), -1)
})

test('snapshot reports a raw gap when concurrent commits reclaim uncaptured pages', async () => {
  const { store, scope, sources, event } = await environment()
  for (const id of ['one', 'two']) await store.record(scope, { eventId: id, message: event(id) }, settings)
  await store.captureMemoryPage(scope, 1)
  await store.commit(scope, { turnId: 'concurrent', readUntil: 2, baseCursor: 0, observers: [], block: block('two') })
  const state = await sources.preserveHistory(scope, store, [])
  assert.equal(state.status, 'partial')
  assert.equal(state.gap, 'raw_reclaimed')
  assert.equal((await sources.status(scope)).pending, 1)
})

test('snapshot survives process restart between archiving and import', async () => {
  const { store, scope, sources, event } = await environment()
  await store.record(scope, { eventId: 'old', message: event('old') }, settings)
  while (!(await store.captureMemoryPage(scope, 1)).done) { /* 保全已完成，尚未导入。 */ }
  await fixture.client.command('DEL', store.keys(scope)[2])
  await new MemorySourceStore(fixture.client).preserveHistory(scope, store)
  assert.equal((await sources.readSourceRange(scope)).rows[0].text, 'old')
})

test('snapshot flags reset or replay mutation rather than mixing generations', async () => {
  const { store, scope, sources, record } = await environment()
  await record('one')
  await store.captureMemoryPage(scope, 1)
  await store.reset('bot', scope.groupId, { settings })
  const state = await sources.preserveHistory(scope, store)
  assert.equal(state.status, 'partial')
  assert.equal(state.gap, 'scope_changed')
})

test('MessageManager keeps full platform text despite journalContent and old 200 character formatting', async () => {
  const { store, scope, sources, event, group } = await environment()
  const config = { promptCache: { enabled: true, groups: [group] }, memorySystem: { enabled: false } }
  const manager = new MessageManager()
  const original = '生日是农历八月十五，'.repeat(80)
  await manager.recordMessage(event('long', original), { contextStore: store, scope, promptCacheConfig: config, journalOnly: true, journalContent: 'resolved prompt with extra references' })
  await manager.recordMessage(event('long', original), { contextStore: store, scope, promptCacheConfig: config, messageMaxLength: 200 })
  await Promise.all(sources.historyTasks.values())
  const page = await sources.readSourceRange(scope)
  assert.equal(page.rows.length, 1)
  assert.equal(page.rows[0].text, original)
  assert.equal(page.rows[0].sourceKind, 'member_message')
})

test('MessageManager restart seed does not duplicate sources and fallback collection needs no model', async () => {
  const { store, scope, sources, event, group } = await environment()
  const config = { promptCache: { enabled: true, groups: [group] } }
  const options = { contextStore: store, scope, promptCacheConfig: config }
  await new MessageManager().recordMessage(event('one'), options)
  await new MessageManager().recordMessage(event('two'), options)
  await Promise.all(sources.historyTasks.values())
  await new MessageManager().recordMessage(event('three'), { ...options, promptCacheConfig: { ...config, enabled: false } })
  assert.deepEqual((await sources.readSourceRange(scope)).rows.map(row => row.messageId).sort(), ['one', 'three', 'two'])
})

test('live record performs no source history scan and history capture is outside the message wait', async () => {
  const { store, scope, sources, record, event, group } = await environment()
  const scripts = []
  const evalOriginal = fixture.client.eval.bind(fixture.client)
  store.client = { eval: (script, args) => { scripts.push(script); return evalOriginal(script, args) } }
  await record('one')
  assert.ok(scripts.every(script => !/ZRANGE|LRANGE|HGETALL|\bSCAN\b/.test(script)))
  let release
  const blocked = new Promise(resolve => { release = resolve })
  sources.preserveHistory = () => blocked
  try {
    await new MessageManager().recordMessage(event('two'), { contextStore: store, scope, promptCacheConfig: { promptCache: { enabled: true, groups: [group] } }, journalOnly: true })
    assert.equal((await sources.status(scope)).pending, 2)
  } finally { release() }
})

test('concurrent live writes and history imports share one atomic source identity', async () => {
  const { record, sources, scope, event } = await environment()
  const source = buildMemorySource(event('same'), scope)
  await Promise.all([record('same'), sources.record(scope, source), record('same'), sources.record(scope, source)])
  assert.equal((await sources.status(scope)).pending, 1)
  assert.equal(await fixture.client.command('HLEN', sources.keys(scope)[2]), 1)
  assert.equal((await sources.readSourceRange(scope)).rows[0].text, 'same')
})

test('legacy seed without a platform ID dedupes across reset and recent snapshot import', async () => {
  const { store, scope, sources, group } = await environment()
  const old = { time: '2026-10-03 12:00:00', sender: { user_id: '101' }, content: '旧消息无平台ID' }
  await fixture.client.set(`ytbot:messages:group:${group}`, JSON.stringify([old]))
  const manager = new MessageManager()
  const config = { promptCache: { enabled: true, groups: [group] } }
  const event = { self_id: 'bot', message_type: 'group', group_id: group, message_id: 'trigger', time: Date.now() / 1000, sender: { user_id: '101' }, message: [{ type: 'text', text: 'trigger' }] }
  await manager.recordMessage(event, { contextStore: store, scope, promptCacheConfig: config })
  await Promise.all(sources.historyTasks.values())
  await store.reset('bot', group, { settings })
  await manager.recordMessage(event, { contextStore: store, promptCacheConfig: config })
  const rows = (await sources.readSourceRange(scope)).rows
  assert.equal(rows.filter(row => row.text === old.content).length, 1)
  assert.equal(rows.find(row => row.text === old.content).fidelity, 'legacy_content')
})

test('missing pending rows are detected by pure reads and block further normal intake', async () => {
  const { sources, scope, record } = await environment()
  await record('one')
  await record('two')
  await fixture.client.command('ZREMRANGEBYSCORE', sources.keys(scope)[1], 1, 1)
  await assert.rejects(sources.readSourceRange(scope), /memory_source_gap/)
  await assert.rejects(record('three'), /memory_source_gap/)
  assert.equal(await fixture.client.get(sources.keys(scope)[0]), '2')
})

test('snapshot pages are capped and a replay mutation is reported with actual captured count', async () => {
  const { store, scope, sources, event } = await environment()
  for (let i = 0; i < SOURCE_PAGE_LIMIT + 1; i++) await store.record(scope, { eventId: String(i), message: event(String(i)) }, settings)
  await store.commit(scope, { turnId: 'old', readUntil: 0, baseCursor: 0, observers: [], block: block('old') })
  await store.captureMemoryPage(scope, 100000)
  assert.equal((await sources.snapshotStatus(scope)).rawCaptured, String(SOURCE_PAGE_LIMIT))
  await store.captureMemoryPage(scope)
  await store.commit(scope, { turnId: 'new', readUntil: 0, baseCursor: 0, observers: [], block: block('new') })
  while (!(await store.captureMemoryPage(scope)).done) { /* 有界分页 */ }
  const state = await sources.snapshotStatus(scope)
  assert.equal(state.gap, 'replay_changed')
  assert.equal(state.replayCaptured, '0')
  assert.equal(state.replayCount, '1')
})

for (const trigger of ['bytes', 'age']) {
  test(`reminder ${trigger} threshold does not trim accumulated sources`, async () => {
    const { scope, sources, record } = await environment()
    await record('one')
    const config = memorySourceSettings({ memorySource: { remindMessages: 99999, remindBytes: trigger === 'bytes' ? 1 : 99999999, remindAgeHours: 1 } })
    if (trigger === 'age') await fixture.client.command('HSET', sources.keys(scope)[3], 'oldestPendingAt', Date.now() - 7200000)
    assert.equal((await sources.claimReminder(scope, config)).due, true)
    assert.equal((await sources.readSourceRange(scope)).rows.length, 1)
    assert.equal((await sources.status(scope)).meta.extractedThrough, '0')
  })
}

test('administrative replay replacement invalidates an in-progress archive without expiring it', async () => {
  const { store, scope, sources, record } = await environment()
  await record('one')
  await store.commit(scope, { turnId: 'old', readUntil: 0, baseCursor: 0, observers: [], block: block('old') })
  await store.captureMemoryPage(scope, 1)
  const before = await store.exportSnapshot(scope)
  const after = { ...before, blocks: [JSON.stringify(block('replacement'))] }
  await store.replaceReplay(scope, before, after)
  const snapshot = await sources.preserveHistory(scope, store)
  assert.equal(snapshot.gap, 'replay_replaced')
  assert.equal(snapshot.status, 'partial')
  assert.equal(await fixture.client.command('TTL', sources.snapshotKeys(scope)[0]), -1)
})

test('noncanonical byte counter is rejected before either journal or source is written', async () => {
  const { store, scope, sources, record } = await environment()
  await fixture.client.command('HSET', sources.keys(scope)[3], 'pendingBytes', '1.0')
  await assert.rejects(record('one'), /memory_source_gap/)
  assert.equal(await fixture.client.get(store.keys(scope)[1]), null)
  assert.equal(await fixture.client.get(sources.keys(scope)[0]), null)
  assert.equal(await fixture.client.command('ZCARD', sources.keys(scope)[1]), 0)
})
