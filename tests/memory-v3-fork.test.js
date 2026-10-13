import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import { randomUUID } from 'node:crypto'
import { MemoryService } from '../utils/memory/MemoryService.js'
import { MemoryStoreV3 } from '../utils/memory/MemoryStoreV3.js'
import { ContextStore } from '../core/contextStore.js'
import { buildMemorySource } from '../utils/memory/sourceSchema.js'
import { buildPromptCacheHeaders } from '../core/prompts.js'
import { promptCacheSettings } from '../core/promptCache.js'
import { redisFixture } from './helpers/redis-fixture.js'

// fork 提取：模型输入 = 账本 replay 前缀 + 末条指令；quote 反查原件校验；
// 提交按 64 条窗口切分复用既有管线。
let fixture
const originalFetch = globalThis.fetch
before(async () => { fixture = await redisFixture(); globalThis.fetch = () => { throw new Error('real network forbidden') } })
after(async () => { globalThis.fetch = originalFetch; await fixture?.stop() })

function forkModel(candidates, capture = null) {
  return async messages => {
    if (capture) capture.push(messages)
    const instruction = messages.at(-1)
    assert.equal(instruction.role, 'user', '末条必须是提取指令')
    assert.ok(instruction.content.includes('长期记忆提取器'))
    assert.ok(instruction.content.includes('已有记忆'), '指令应带已有记忆参照')
    assert.ok(messages[0].role === 'system', '前缀首行是账本 system')
    return JSON.stringify({ complete: true, candidates })
  }
}

async function environment(model, options = {}) {
  const store = new MemoryStoreV3(fixture.client)
  const scope = store.scope('bot', randomUUID())
  const ledger = new ContextStore(fixture.client, `test:forkctx:${randomUUID()}:`)
  const config = { memoryV3: { groups: [scope.groupId], extractor: 'fork', timeoutMs: 10000, retryDelayMs: 1, ...options },
    chatAiConfig: { chatApiUrl: 'http://fork.test/v1', chatApiModel: 'fork-model', chatApiKey: ['k'] } }
  const service = new MemoryService(config, { store, model })
  service.contextStore = ledger
  // 造账本：一轮真实 record→read→commit，产生 header 与 replay 块
  const settings = promptCacheSettings({})
  const header = buildPromptCacheHeaders({ systemContent: '测试人设', botUin: 'bot', groupContext: { groupId: scope.groupId } }, [])
  const ledgerScope = await ledger.scope('bot', scope.groupId, { settings })
  const add = async (id, text, userId = '101') => {
    const source = buildMemorySource({ message_id: id, user_id: userId, time: 1800000000, message: [{ type: "text", text }], sender: { nickname: `成员${userId}` } }, scope)
    await ledger.record(ledgerScope, { eventId: source.eventId, message: { content: text, sender: { user_id: userId, nickname: `成员${userId}` } } }, settings, source)
    return source
  }
  const commitTurn = async (represented) => {
    const snapshot = await ledger.read(ledgerScope, header, settings)
    await ledger.commit(ledgerScope, { turnId: `t${represented.length}`, readUntil: snapshot.readUntil, baseCursor: snapshot.cursor,
      observers: [], represented, block: { turnId: `t${represented.length}`, referenceVersion: 2, toolRows: [{ role: 'user', content: 'hi' }], chatRows: [{ role: 'user', content: 'hi' }], tokens: 5, messageIds: represented } })
  }
  return { store, scope, ledger, ledgerScope, config, service, add, commitTurn, header, settings }
}

async function drain(service) { await Promise.all(service.running.values()) }

test('fork prefix is built from the ledger header and replay rows with the instruction appended last', async () => {
  const capture = []
  const env = await environment(forkModel([], capture))
  await env.add('m1', '我喜欢咖啡')
  // 只 read 持久化 header，不 commit：消息留在未消化区，fork 前缀经 replayEventRow 渲染原文
  await env.ledger.read(env.ledgerScope, env.header, env.settings)
  await env.service.start(env.scope)
  await drain(env.service)
  assert.equal(capture.length, 1)
  const messages = capture[0]
  const body = messages.map(row => row.content).join('\n')
  assert.ok(messages[0].content.includes('测试人设'), 'system 来自账本 header')
  assert.ok(body.includes('我喜欢咖啡'), 'replay 原文进入前缀')
  assert.ok(body.includes('101'), 'replay 行带 QQ 标注')
  assert.equal((await env.store.snapshot(env.scope)).meta.extractedThrough, String(1))
})

test('fork candidates with fabricated quotes are rejected and subjects are pinned to the evidence row sender', async () => {
  const env = await environment(forkModel([
    { type: 'fact', subjectId: '101', kind: 'preference', slot: 'preference:tea', value: true, text: '喜欢喝茶', basis: 'self_report', decision: 'accept',
      evidence: [{ quote: '这句话根本不存在于任何消息里' }] },
    { type: 'fact', subjectId: '202', kind: 'identity', slot: 'job', value: '厨师', text: '是厨师', basis: 'self_report', decision: 'accept',
      evidence: [{ quote: '我喜欢咖啡' }] }
  ]))
  const source = await env.add('m1', '我喜欢咖啡')
  await env.commitTurn([source.eventId])
  await env.service.start(env.scope)
  await drain(env.service)
  const state = await env.store.snapshot(env.scope)
  const facts = Object.values(state.facts).filter(item => item.status === 'active')
  assert.equal(facts.length, 1, '伪造 quote 的拒绝；错报 subjectId 的以证据行说话人为准')
  assert.equal(facts[0].subjectId, '101', 'subjectId 被原件 senderId 覆盖，不吃模型自报')
  assert.equal(state.meta.extractedThrough, String(1), '处理完成游标推进')
})

test('fork splits large ranges into 64-row windows and attributes candidates by evidence', async () => {
  const env = await environment(forkModel([
    { type: 'fact', subjectId: '101', kind: 'identity', slot: 'nickname', value: '阿咖', text: '自称阿咖', basis: 'self_report', decision: 'accept',
      evidence: [{ quote: '我是阿咖 seventy' }] }
  ]))
  for (let index = 1; index <= 70; index++) await env.add(`m${index}`, index === 70 ? '我是阿咖 seventy' : `水消息 ${index}`)
  await env.commitTurn([`message:bot:${env.scope.groupId}:m70`])
  const job = await env.service.start(env.scope)
  await drain(env.service)
  const state = await env.store.snapshot(env.scope)
  assert.equal(state.meta.extracttractedThrough ?? state.meta.extractedThrough, String(70), '全部窗口提交完毕')
  assert.equal(state.meta.extractedThrough, String(70))
  const facts = Object.values(state.facts).filter(item => item.status === 'active')
  assert.equal(facts.length, 1)
  assert.equal(facts[0].slot, 'nickname')
  const finished = await env.service.jobs.get(env.scope, job.job.id)
  assert.equal(finished.job.status, 'complete')
  assert.ok(Number(finished.job.batches) >= 2, '70 条应切成至少两个提交窗口')
})

test('fork model failure does not advance the cursor and can retry to success', async () => {
  let calls = 0
  const env = await environment(async messages => {
    calls++
    if (calls === 1) throw new Error('memory_model_invalid_json')
    return forkModel([{ type: 'fact', subjectId: '101', kind: 'preference', slot: 'preference:coffee', value: true, text: '喜欢咖啡', basis: 'self_report', decision: 'accept', evidence: [{ quote: '我喜欢咖啡' }] }])(messages)
  })
  const source = await env.add('m1', '我喜欢咖啡')
  await env.commitTurn([source.eventId])
  await env.service.start(env.scope)
  await drain(env.service)
  const state = await env.store.snapshot(env.scope)
  assert.equal(state.meta.extractedThrough, String(1), '重试成功后游标推进')
  assert.equal(Object.values(state.facts).filter(item => item.status === 'active').length, 1)
  assert.equal(calls, 2)
})

test('style observations need multi-message evidence and land as per-target slots', async () => {
  const env = await environment(forkModel([
    { type: 'fact', subjectId: '101', kind: 'style', slot: 'style:tone', value: '阴阳怪气但心肠好', text: '说话风格：阴阳怪气但心肠好', basis: 'observed', decision: 'accept',
      evidence: [{ quote: '谁他妈的薅了' }, { quote: '你个猪mer' }] },
    { type: 'fact', subjectId: '101', kind: 'style', slot: 'style:口头禅', value: '魔了', text: '说话风格：口头禅是「魔了」', basis: 'observed', decision: 'accept',
      evidence: [{ quote: '魔了' }] }
  ]))
  await env.add('m1', '谁他妈的薅了')
  await env.add('m2', '你个猪mer')
  await env.add('m3', '魔了')
  await env.commitTurn([`message:bot:${env.scope.groupId}:m3`])
  await env.service.start(env.scope)
  await drain(env.service)
  const state = await env.store.snapshot(env.scope)
  const styles = Object.values(state.facts).filter(item => item.status === 'active' && item.kind === 'style')
  assert.equal(styles.length, 1, '两条 quote 的入库，单条 quote 的被拒')
  assert.equal(styles[0].slot, 'style:tone')
})
