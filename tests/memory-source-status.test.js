import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { randomUUID } from 'node:crypto'
import { redisFixture } from './helpers/redis-fixture.js'
import { memorySourceStore } from '../utils/memory/MemorySourceStore.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { MemoryService } from '../utils/memory/MemoryService.js'

register('./helpers/memory-command-loader.mjs', import.meta.url)
globalThis.plugin = class {}
globalThis.logger = { warn() {}, error() {} }
const { MemoryCommands } = await import('../apps/memory.js')
let fixture
before(async () => { fixture = await redisFixture(); globalThis.redis = fixture.client })
after(async () => { await fixture?.stop() })

test('#记忆状态 retains old status and adds permanent source counts and coverage', async () => {
  const group = randomUUID()
  const scope = memorySourceStore.scope('bot', group)
  await memorySourceStore.record(scope, buildMemorySource({ message_id: 'one', user_id: '101', msg: '原文' }, scope))
  globalThis.memoryCommandState = { memoryManager: { adminStatus: async () => ({ enabled: true, user: { factCount: 3 }, group: { factCount: 2 }, config: { importanceThreshold: 0.5 } }) } }
  const replies = []
  const command = new MemoryCommands()
  await command.memoryStatus({ self_id: 'bot', group_id: group, user_id: '101', reply: text => replies.push(text) })
  assert.match(replies[0], /用户记忆：启用，3 条/)
  assert.match(replies[0], /群记忆：启用，2 条/)
  assert.match(replies[0], /待整理 1 条/)
  assert.match(replies[0], /保护起点/)
})

test('#记忆状态 still returns old information if new source status is unavailable', async () => {
  globalThis.memoryCommandState = { memoryManager: { adminStatus: async () => ({ enabled: false, config: {} }) } }
  const client = globalThis.redis
  globalThis.redis = { eval: async () => { throw new Error('source unavailable') } }
  try {
    const replies = []
    await new MemoryCommands().memoryStatus({ self_id: 'bot', group_id: 'g', reply: text => replies.push(text) })
    assert.match(replies[0], /记忆系统：关闭/)
    assert.match(replies[0], /旧记忆状态如上/)
  } finally { globalThis.redis = client }
})

test('V3 review commands require master in the target group and support evidence, confirm, edit and undo', async () => {
  const store = new MemoryStoreV3(fixture.client)
  const group = randomUUID()
  const scope = store.scope('bot', group)
  const source = buildMemorySource({ message_id: 'review', user_id: '101', message: [{ type: 'text', text: '我喜欢咖啡' }] }, scope)
  await store.sources.record(scope, source)
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [{ type: 'fact', subjectId: '101', kind: 'preference', slot: 'preference:coffee', value: true, text: '喜欢咖啡', decision: 'review', evidence: [{ eventId: source.eventId, quote: source.text }] }] }))
  globalThis.memoryCommandState = { memoryStoreV3: store }
  const id = Object.keys((await store.snapshot(scope)).review)[0]
  const replies = []
  const command = new MemoryCommands()
  const event = msg => ({ msg, self_id: 'bot', group_id: group, user_id: 'master', isMaster: true, reply: text => replies.push(text) })
  await command.manageV3({ ...event(`#记忆确认 ${id}`), isMaster: false })
  assert.equal(Object.keys((await store.snapshot(scope)).facts).length, 0)
  await command.manageV3(event(`#记忆证据 ${id}`))
  assert.match(replies.at(-1), /我喜欢咖啡/)
  await command.manageV3(event(`#记忆确认 ${id}`))
  const factId = Object.keys((await store.snapshot(scope)).facts)[0]
  await command.manageV3(event(`#记忆修正 ${factId} {"text":"只喝无咖啡因饮料","value":false}`))
  assert.equal((await store.snapshot(scope)).facts[factId].value, false)
  await command.manageV3(event(`#记忆撤销修订 ${factId}`))
  assert.equal((await store.snapshot(scope)).facts[factId].value, true)
})

test('#整理记忆 returns its persistent job before the fake model finishes and rejects non-master', async () => {
  const store = new MemoryStoreV3(fixture.client)
  const group = randomUUID()
  const scope = store.scope('bot', group)
  await store.sources.record(scope, buildMemorySource({ message_id: 'one', user_id: '101', msg: '普通聊天' }, scope))
  let release
  const gate = new Promise(resolve => { release = resolve })
  const service = new MemoryService({ memoryV3: { groups: [group] } }, { store, model: async () => { await gate; return '{"complete":true,"candidates":[]}' } })
  globalThis.memoryCommandState = { memoryService: service }
  const replies = []
  const event = { self_id: 'bot', group_id: group, user_id: 'master', reply: text => replies.push(text) }
  await new MemoryCommands().organizeV3(event)
  assert.equal((await service.jobs.get(scope)).job, null)
  try {
    await new MemoryCommands().organizeV3({ ...event, isMaster: true })
    assert.match(replies.at(-1), /后台执行/)
    assert.equal((await store.snapshot(scope)).meta.extractedThrough, '0')
  } finally { release(); await Promise.all(service.running.values()) }
  assert.equal((await store.snapshot(scope)).meta.extractedThrough, '1')
})

test('legacy command names now list, disable and forget V3 personal facts without touching sources', async () => {
  const store = new MemoryStoreV3(fixture.client)
  const group = randomUUID(); const scope = store.scope('bot', group)
  const source = buildMemorySource({ message_id: 'one', user_id: '101', message: [{ type: 'text', text: '我是程序员' }] }, scope)
  await store.sources.record(scope, source)
  await store.commit(scope, await store.planBatch(scope, { from: 1, to: 1, candidates: [{ type: 'fact', subjectId: '101', kind: 'identity', slot: 'occupation', value: '程序员', text: '我是程序员', basis: 'self_report', decision: 'accept', evidence: [{ eventId: source.eventId, quote: source.text }] }] }))
  const service = new MemoryService({ memoryV3: { groups: [group] } }, { store, model: () => { throw new Error('must not extract') } })
  globalThis.memoryCommandState = { memoryService: service }
  const replies = []; const e = { self_id: 'bot', group_id: group, user_id: '101', reply: text => replies.push(text) }
  const commands = new MemoryCommands()
  await commands.listMyMemory(e)
  assert.match(replies.at(-1), /我是程序员/)
  await commands.disableMyMemory(e)
  assert.equal(JSON.parse((await store.snapshot(scope)).meta.disabledSubjects)['101'], true)
  await commands.clearMyMemory(e)
  assert.equal(Object.values((await store.snapshot(scope)).facts).filter(item => item.status === 'active').length, 0)
  assert.equal((await store.sources.status(scope)).resident, 1)
})

test('#导入历史记忆 is master-only, asynchronous and never invokes a model', async () => {
  const store = new MemoryStoreV3(fixture.client)
  const group = randomUUID(); const scope = store.scope('bot', group)
  await fixture.client.set(`ytbot:memory:${group}:101`, JSON.stringify({ facts: ['喜欢音乐'] }))
  const service = new MemoryService({ memoryV3: { groups: [group] } }, { store, model: () => { throw new Error('no model during import') } })
  globalThis.memoryCommandState = { memoryService: service }
  const replies = []; const event = { self_id: 'bot', group_id: group, user_id: '101', reply: text => replies.push(text) }
  const commands = new MemoryCommands()
  await commands.importV3(event)
  assert.equal(Object.keys((await store.snapshot(scope)).review).length, 0)
  await commands.importV3({ ...event, isMaster: true })
  assert.match(replies.at(-1), /后台导入/)
  await Promise.all(service.importer.running.values())
  assert.equal(Object.keys((await store.snapshot(scope)).review).length, 1)
  assert.equal(Object.keys((await store.snapshot(scope)).facts).length, 0)
})
