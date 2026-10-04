import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs/promises'
import path from 'node:path'
import { randomUUID } from 'node:crypto'
import { execFile } from 'node:child_process'
import { promisify } from 'node:util'
import { ContextStore } from '../core/contextStore.js'
import { promptCacheSettings, tokenEstimate } from '../core/promptCache.js'
import { buildPromptCacheHeaders } from '../core/prompts.js'
import { replayRows, replayTokenBudget } from '../core/replayAdapters.js'
import { exportAgentReplay, RedisCliClient } from '../scripts/export-agent-replay-as-dual.mjs'
import { redisFixture } from './helpers/redis-fixture.js'

let fixture
before(async () => { fixture = await redisFixture() })
after(async () => { await fixture?.stop() })
const settings = promptCacheSettings({})
const dualHeader = buildPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group' } }, [])
const agentHeader = { mode: 'agent', version: 'agent-v1', agentSystem: 'agent persona', tools: [], identity: { botCardInGroup: 'Agent' }, rollbackHeader: dualHeader }
const legacy = id => ({ turnId: id, referenceVersion: 2, toolRows: [{ role: 'user', content: id }], chatRows: [{ role: 'user', content: id }], tokens: 10, messageIds: [id] })
const agent = id => {
  const block = { replayVersion: 3, mode: 'agent', referenceVersion: 2, turnId: id, apiRows: [
    { role: 'user', content: id },
    { role: 'assistant', tool_calls: [{ id: `call-${id}`, type: 'function', function: { name: 'probe', arguments: ' { "x" : 1 } ' } }] },
    { role: 'tool', tool_call_id: `call-${id}`, content: 'exact result' }, { role: 'assistant', content: 'raw final', reasoning_content: 'reasoning' }
  ], messageIds: [id], delivery: { messageIds: ['reply'] } }
  block.tokens = replayTokenBudget(block)
  return block
}
async function context() {
  const store = new ContextStore(fixture.client, `test:mixed:${randomUUID()}:`)
  const scope = await store.scope('bot', 'group')
  await store.record(scope, { eventId: 'source', message: { content: 'source', sender: { user_id: '42' } } })
  return { store, scope }
}
const commit = (store, scope, block) => store.commit(scope, { turnId: block.turnId, readUntil: 1, baseCursor: 0, observers: [], represented: ['source'], block })

test('mixed legacy/agent ledger switches views and headers without resetting source cursor', async () => {
  const { store, scope } = await context()
  await store.read(scope, dualHeader, settings)
  await commit(store, scope, legacy('old'))
  const entering = await store.read(scope, agentHeader, settings)
  assert.equal(entering.modeChanged, true)
  await commit(store, scope, agent('new'))
  const snapshot = await store.read(scope, dualHeader, settings)
  assert.equal(snapshot.modeChanged, true)
  assert.equal(snapshot.cursor, 1)
  assert.deepEqual(snapshot.blocks.map(block => block.turnId), ['old', 'new'])
  assert.equal(replayRows(snapshot.blocks[1], 'chat').at(-1).content, 'raw final')
  assert.equal((await store.header(scope, 'agent')).version, agentHeader.version)
  assert.equal((await store.header(scope)).version, dualHeader.version)
  const degraded = { ...agentHeader, version: 'unreliable', reliable: false }
  assert.equal((await store.read(scope, degraded, settings)).header.version, agentHeader.version)
  await store.read(scope, dualHeader, settings)
  const changedProjection = await store.read(scope, { ...dualHeader, rendererVersion: 2 }, settings)
  assert.equal(changedProjection.projectionChanged, true)
  assert.equal(changedProjection.cursor, 1)
})

test('agent trim keeps complete native blocks and does not regress the watermark', async () => {
  const { store, scope } = await context()
  for (let index = 0; index < 4; index++) await commit(store, scope, { ...agent(`T${index}`), tokens: 1500 })
  const snapshot = await store.read(scope, agentHeader, { ...settings, highWater: 5000, lowWater: 3000, reserveTokens: 0 })
  assert.deepEqual(snapshot.blocks.map(block => block.turnId), ['T2', 'T3'])
  assert.deepEqual(snapshot.blocks[0].apiRows, agent('T2').apiRows)
  assert.equal(snapshot.cursor, 1)
})

test('agent budgets include native calls plus restored final reasoning without altering dual budget or rows', async () => {
  const { store, scope } = await context()
  const block = legacy('reasoning')
  block.toolRows.push({ role: 'assistant', content: 'exact reply' })
  block.chatRows.push({ role: 'assistant', content: 'exact reply', reasoning_content: 'large reasoning '.repeat(1000) })
  await commit(store, scope, block)
  const snapshot = await store.read(scope, agentHeader, settings)
  const kept = snapshot.blocks[0]
  assert.ok(kept.agentTokens > block.tokens)
  assert.equal(kept.tokens, block.tokens)
  assert.deepEqual(kept.toolRows, block.toolRows)
  assert.deepEqual(kept.chatRows, block.chatRows)
})

test('rollback dry-run is read-only; guarded export and restore preserve all source metadata', async () => {
  const { store, scope } = await context()
  await store.read(scope, agentHeader, settings)
  await commit(store, scope, agent('one'))
  const before = await store.exportSnapshot(scope)
  const backupPath = path.join(fixture.directory, `${randomUUID()}.json`)
  const preview = await exportAgentReplay(store, scope, { backupPath })
  assert.equal(preview.dryRun, true)
  assert.equal(preview.changed, 1)
  await assert.rejects(fs.stat(backupPath), { code: 'ENOENT' })
  assert.deepEqual(await store.exportSnapshot(scope), before)
  await exportAgentReplay(store, scope, { apply: true, backupPath })
  const after = await store.exportSnapshot(scope)
  assert.deepEqual(after.represented, before.represented)
  assert.deepEqual(after.committed, before.committed)
  assert.equal(after.meta.cursor, before.meta.cursor)
  assert.equal(JSON.parse(after.blocks[0]).mode, 'dual')
  assert.equal('apiRows' in JSON.parse(after.blocks[0]), false)
  assert.equal((await fs.stat(backupPath)).mode & 0o777, 0o600)
  await exportAgentReplay(store, scope, { apply: true, restorePath: backupPath, backupPath: `${backupPath}.restore` })
  assert.deepEqual(await store.exportSnapshot(scope), before)
})

test('export CAS rejects concurrent commits, reset and expired scopes', async () => {
  const { store, scope } = await context()
  await store.read(scope, agentHeader, settings)
  await commit(store, scope, agent('one'))
  const before = await store.exportSnapshot(scope)
  await commit(store, scope, legacy('late'))
  await assert.rejects(store.replaceReplay(scope, before, before), { code: 'rollback_conflict' })
  await store.reset('bot', 'group')
  await assert.rejects(store.replaceReplay(scope, before, before), { code: 'stale_scope' })
  await assert.rejects(store.exportSnapshot({ ...scope, deadline: Date.now() - 1 }), { code: 'expired_scope' })
})

test('exporter redis transport accepts payloads beyond the single argv limit', async () => {
  const { store: original, scope } = await context()
  const socket = path.join(fixture.directory, 'redis.sock')
  const store = new ContextStore(new RedisCliClient(['-s', socket]), original.prefix)
  await original.read(scope, agentHeader, settings)
  const block = agent('large')
  block.apiRows[2].content = 'large tool result '.repeat(14000)
  block.tokens = tokenEstimate(block.apiRows)
  const encoded = JSON.stringify(block)
  const cli = store.client
  await cli.command('RPUSH', original.keys(scope)[5], encoded)
  await fixture.client.command('HSET', original.keys(scope)[4], 'replayCount', '1')
  const before = await store.exportSnapshot(scope)
  const changed = { ...before, blocks: [JSON.stringify({ ...block, exitReason: 'test' })] }
  await store.replaceReplay(scope, before, changed)
  assert.equal(JSON.parse((await store.exportSnapshot(scope)).blocks[0]).apiRows[2].content, block.apiRows[2].content)
})

test('real rollback CLI defaults to dry-run and applies only with an exclusive backup', async () => {
  const { store, scope } = await context()
  await store.read(scope, agentHeader, settings)
  await commit(store, scope, agent('cli'))
  const script = new URL('../scripts/export-agent-replay-as-dual.mjs', import.meta.url).pathname
  const args = [script, '--socket', path.join(fixture.directory, 'redis.sock'), '--bot', 'bot', '--group', 'group', '--prefix', store.prefix, '--day', scope.dayKey]
  const run = promisify(execFile)
  const before = await store.exportSnapshot(scope)
  const preview = await run(process.execPath, args)
  assert.equal(JSON.parse(preview.stdout).dryRun, true)
  assert.deepEqual(await store.exportSnapshot(scope), before)
  const backup = path.join(fixture.directory, `${randomUUID()}-cli.json`)
  await run(process.execPath, [...args, '--apply', '--backup', backup])
  assert.equal(JSON.parse((await store.exportSnapshot(scope)).blocks[0]).mode, 'dual')
  await run(process.execPath, [...args, '--restore', backup, '--apply', '--backup', `${backup}.restore`])
  assert.deepEqual(await store.exportSnapshot(scope), before)
  await assert.rejects(run(process.execPath, [...args, '--unknown', 'value']))
})
