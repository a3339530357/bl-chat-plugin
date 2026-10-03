import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'
import { randomUUID } from 'node:crypto'
import { ContextStore } from '../core/contextStore.js'
import { tokenEstimate } from '../core/promptCache.js'
import { redisFixture } from './helpers/redis-fixture.js'

register('./helpers/yunzai-cache-loader.mjs', import.meta.url)
globalThis.Bot = { uin: 'bot', nickname: 'Bot' }
globalThis.logger = { warn() {}, error() {}, info() {} }
const { MessageManager } = await import('../utils/MessageManager.js')
let fixture
before(async () => { fixture = await redisFixture(); globalThis.redis = fixture.client; tokenEstimate('warm up') })
after(async () => { await fixture?.stop() })

function deferred() {
  let resolve
  const promise = new Promise(done => { resolve = done })
  return { promise, resolve }
}

async function environment() {
  const group = randomUUID()
  const store = new ContextStore(fixture.client, `test:journal:${group}:`)
  const manager = new MessageManager()
  const config = { promptCache: { enabled: true, groups: [group] } }
  const scope = await store.scope('bot', group)
  const options = { contextStore: store, scope, promptCacheConfig: config }
  const event = id => ({ self_id: 'bot', message_type: 'group', group_id: group, message_id: id,
    time: Math.floor(Date.now() / 1000), msg: id, sender: { user_id: '42', nickname: 'User', role: 'member' },
    message: [{ type: 'text', text: id }] })
  return { manager, store, scope, options, event, group }
}

test('journalOnly bypasses slow formatting and the normal group write queue', { timeout: 10000 }, async () => {
  const env = await environment()
  const started = deferred()
  const release = deferred()
  const original = env.manager.formatMessage.bind(env.manager)
  env.manager.formatMessage = async (event, ...args) => {
    if (event.message_id === 'slow') { started.resolve(); await release.promise }
    return original(event, ...args)
  }
  const queued = env.manager.recordMessage(env.event('slow'), env.options)
  await started.promise
  let timer
  try {
    const fast = env.manager.recordMessage(env.event('current'), {
      ...env.options, journalOnly: true, journalContent: 'resolved current content'
    })
    const outcome = await Promise.race([fast, new Promise(resolve => { timer = setTimeout(() => resolve(null), 2000) })])
    assert.ok(outcome, 'foreground journal must complete while slow formatting remains blocked')
    assert.equal(outcome.seq, 1)
    const rows = await env.manager.getMessages('group', env.group)
    assert.deepEqual(rows, [])
  } finally { clearTimeout(timer); release.resolve(); await queued }
  const rows = await env.manager.getMessages('group', env.group)
  assert.deepEqual(rows.map(row => row.message_id), ['slow'])
})

for (const reason of ['expired_scope', 'stale_scope']) {
  test(`queued ${reason} rejects only the journal and still writes both V1 messages`, { timeout: 10000 }, async () => {
    const env = await environment()
    const started = deferred()
    const release = deferred()
    const original = env.manager.formatMessage.bind(env.manager)
    const calls = []
    env.manager.formatMessage = async (event, ...args) => {
      calls.push(event.message_id)
      if (event.message_id === 'blocker') { started.resolve(); await release.promise }
      return original(event, ...args)
    }
    const first = env.manager.recordMessage(env.event('blocker'), env.options)
    await started.promise
    const queuedScope = { ...env.scope }
    const second = env.manager.recordMessage(env.event('cross-boundary'), { ...env.options, scope: queuedScope })
    try {
      if (reason === 'expired_scope') queuedScope.deadline = Date.now() - 1
      else await env.store.reset('bot', env.group)
    } finally { release.resolve(); await Promise.all([first, second]) }
    const rows = await env.manager.getMessages('group', env.group)
    assert.deepEqual(rows.map(row => row.message_id).sort(), ['blocker', 'cross-boundary'])
    assert.deepEqual(calls.sort(), ['blocker', 'cross-boundary'])
    const current = reason === 'stale_scope' ? await env.store.scope('bot', env.group) : env.scope
    assert.equal((await env.store.lookup(current, `message:bot:${env.group}:cross-boundary`)).seq, undefined)
  })
}
