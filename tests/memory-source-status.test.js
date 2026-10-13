import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { randomUUID } from 'node:crypto'
import { redisFixture } from './helpers/redis-fixture.js'
import { memorySourceStore } from '../utils/memory/MemorySourceStore.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'

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
