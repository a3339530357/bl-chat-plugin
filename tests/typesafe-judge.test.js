import test from "node:test"
import assert from "node:assert/strict"
import { typesafeBatchJudge, typesafeRequest } from "../core/tracking/typesafeJudge.js"

const batch = [
  { id: 'MSG_1_g_100', senderName: '此奶的方子', chatHistory: [{ role: 'bot', content: '表情包弄好了没？' }],
    userMessage: '[22:46:08] 此奶的方子(100)[群主]: 你又死了吗，说话啊，多发几张' },
  { id: 'MSG_2_g_200', senderName: '阿伟', chatHistory: [],
    userMessage: '[22:47:00] 阿伟(200): 今晚食堂有糖醋排骨，冲不冲' }
]
const config = { typesafeModel: 'jev-latest', typesafeThreshold: 0.5, typesafeApiKey: 'apikey_test' }

function mockFetch(responses) {
  const calls = []
  let i = 0
  globalThis.fetch = async (url, opts) => {
    calls.push({ url, body: JSON.parse(opts.body) })
    const r = responses[Math.min(i++, responses.length - 1)]
    if (r instanceof Error) throw r
    if (r.timeout) await new Promise((_, rej) => { const t = setTimeout(() => rej(Object.assign(new Error('timed out'), { name: 'AbortError' })), 100); opts.signal?.addEventListener('abort', () => { clearTimeout(t); rej(Object.assign(new Error('aborted'), { name: 'AbortError' })) }) })
    return { ok: (r.status || 200) < 300, status: r.status || 200, json: async () => r.json, text: async () => JSON.stringify(r.json) }
  }
  return calls
}

test('typesafeBatchJudge：批量 Noul 判定映射回概率', async () => {
  const calls = mockFetch([{ json: { model: 'jev-1.13.0', answers: {
    'MSG_1_g_100': { type: 'noul', noul: 0.83 }, 'MSG_2_g_200': { type: 'noul', noul: 0.28 } } } }])
  const { probabilities, threshold } = await typesafeBatchJudge(config, batch)
  assert.equal(probabilities['MSG_1_g_100'], 0.83)
  assert.equal(probabilities['MSG_2_g_200'], 0.28)
  assert.equal(threshold, 0.5)
  // 请求形状：state 含 bot 与 messages，questions 每消息一个 noul
  const body = calls[0].body
  assert.equal(body.model, 'jev-latest')
  assert.equal(body.state.messages.length, 2)
  assert.equal(body.state.messages[0].id, 'MSG_1_g_100')
  assert.equal(body.questions['MSG_1_g_100'].type, 'noul')
  assert.ok(body.questions['MSG_1_g_100'].instructions.includes('MSG_1_g_100'))
})

test('typesafeRequest：网络故障重试一次后成功', async () => {
  const calls = mockFetch([
    Object.assign(new Error('socket hang up'), { name: 'TypeError' }),
    { json: { answers: { 'MSG_1_g_100': { noul: 0.7 } } } }
  ])
  const r = await typesafeRequest(config, { state: 'x', questions: {} })
  assert.equal(r.answers['MSG_1_g_100'].noul, 0.7)
  assert.equal(calls.length, 2)
})

test('typesafeRequest：4xx 不重试直接抛', async () => {
  const calls = mockFetch([{ status: 400, json: { detail: 'bad' } }])
  await assert.rejects(() => typesafeRequest(config, {}), /HTTP 400/)
  assert.equal(calls.length, 1)
})

test('typesafeRequest：连续网络失败重试耗尽后抛（供上层回退 flash）', async () => {
  mockFetch([
    Object.assign(new Error('timed out'), { name: 'AbortError' }),
    Object.assign(new Error('timed out'), { name: 'AbortError' })
  ])
  await assert.rejects(() => typesafeBatchJudge(config, batch), /AbortError|timed out/)
})

test('typesafeRequest：未配置 key 直接抛', async () => {
  await assert.rejects(() => typesafeRequest({ typesafeApiKey: '' }, {}), /未配置/)
})
