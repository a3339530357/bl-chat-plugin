import test, { before, after } from 'node:test'
import assert from 'node:assert/strict'
import http from 'node:http'
import { once } from 'node:events'
import { callChatCompletionOnce, resolveAgentRoute, YTapi } from '../utils/apiClient.js'
import { bindCacheRequest } from '../core/cacheTurn.js'
import { promptCacheSettings } from '../core/promptCache.js'
import { parseAgentSSEText } from '../utils/api/responseParsing.js'

let server
let url
let mode = 'text'
let broken = false
const requests = []
before(async () => {
  server = http.createServer(async (request, response) => {
    let raw = ''
    for await (const chunk of request) raw += chunk
    requests.push({ body: JSON.parse(raw), authorization: request.headers.authorization })
    if (mode === 'retry' && !broken) { broken = true; request.socket.destroy(); return }
    if (mode === 'error') { response.statusCode = 503; response.end('private-key-one'); return }
    const data = { choices: [{ message: { role: 'assistant', content: 'first text', reasoning_content: 'reasoning', signature: 'sig' } }],
      usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 }, completion_tokens: 2 } }
    if (mode === 'sse') response.end(`data: ${JSON.stringify({ choices: [{ delta: { content: 'first text' } }], usage: data.usage })}\n\ndata: [DONE]\n\n`)
    else response.end(JSON.stringify(data))
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  url = `http://127.0.0.1:${server.address().port}`
})
after(async () => { await new Promise(resolve => server.close(resolve)) })
const declaration = { type: 'function', function: { name: 'probe', parameters: { type: 'object', properties: {} } } }
const config = () => ({ useTools: true, promptCache: { diagnostics: false }, chatAiConfig: { chatApiUrl: url, chatApiModel: 'chat-model', chatApiKey: ['private-key-one', 'private-key-two'] }, toolsAiConfig: { toolsAiUrl: 'http://unused.invalid' } })
const turn = () => ({ mode: 'agent', scope: { botId: 'bot', groupId: 'group', dayKey: '20261004' }, turnId: 'turn',
  settings: promptCacheSettings({}), apiConfig: config(), header: { tools: [declaration] }, requests: [], captureTools() {} })

test('YTapi agent returns the first text with one HTTP request and constant tool schema', async () => {
  mode = 'text'; requests.length = 0
  const context = turn()
  const request = bindCacheRequest({ model: 'unused-tool-model', messages: [{ role: 'user', content: 'hello' }], tools: [], tool_choice: 'none' }, context)
  const data = await YTapi(request, context.apiConfig)
  assert.equal(data.choices[0].message.content, 'first text')
  assert.equal(data.choices[0].message.signature, 'sig')
  assert.equal(requests.length, 1)
  assert.equal(requests[0].body.model, 'chat-model')
  assert.equal(requests[0].body.temperature, 0.85)
  assert.equal(requests[0].body.stream, false)
  assert.equal(requests[0].body.tool_choice, 'auto')
  assert.deepEqual(requests[0].body.tools, [declaration])
  context.apiConfig.chatAiConfig.chatApiModel = 'changed-mid-turn'
  await YTapi(request, context.apiConfig)
  assert.equal(requests[1].body.model, 'chat-model')
  assert.equal(requests[1].authorization, requests[0].authorization)
  assert.deepEqual(context.requests.map(record => record.stage), ['agent', 'agent'])
})

test('agent route normalization and key selection are stable across turns', () => {
  const first = resolveAgentRoute(config(), turn().scope)
  assert.equal(first.url, `${url}/v1/chat/completions`)
  assert.deepEqual(resolveAgentRoute(config(), turn().scope), first)
  assert.equal(resolveAgentRoute({ ...config(), chatAiConfig: { ...config().chatAiConfig, chatApiUrl: `${url}/v1` } }, turn().scope).url, first.url)
  assert.throws(() => resolveAgentRoute({ chatAiConfig: {} }), /agent_route_not_configured/)
})

test('agent handles SSE and disables tools only for the global useTools=false setting', async () => {
  mode = 'sse'; requests.length = 0
  const context = turn()
  const data = await callChatCompletionOnce({ messages: [{ role: 'user', content: 'hello' }] }, { ...config(), useTools: false }, context)
  assert.equal(data.choices[0].message.content, 'first text')
  assert.equal('tools' in requests[0].body, false)
  assert.equal(context.requests[0].cached, 80)
})

test('network retry is bounded and observed; HTTP business errors do not retry or leak credentials', async () => {
  mode = 'retry'; broken = false; requests.length = 0
  const context = turn()
  const data = await callChatCompletionOnce({ messages: [{ role: 'user', content: 'hello' }] }, config(), context)
  assert.equal(data.choices[0].message.content, 'first text')
  assert.equal(requests.length, 2)
  assert.equal(context.physicalAttempts, 2)
  mode = 'error'; requests.length = 0
  context.route = resolveAgentRoute({ ...config(), chatAiConfig: { ...config().chatAiConfig, chatApiKey: ['private-key-one'] } }, context.scope)
  const error = await callChatCompletionOnce({ messages: [] }, config(), context)
  assert.equal(requests.length, 1)
  assert.ok(!error.error.includes('private-key-one'))
})

test('native SSE aggregation preserves fragmented calls, reasoning, signatures and usage-only frames', () => {
  const packets = [
    { choices: [{ delta: { reasoning_content: 'reason one', tool_calls: [{ index: 0, id: 'c1', type: 'function', signature: 'signed', function: { name: 'probe', arguments: ' { ' } }] } }] },
    { choices: [{ delta: { reasoning_content: ' two', tool_calls: [{ index: 0, function: { arguments: '"x" : 1 } ' } }] } }] },
    { choices: [{ delta: { tool_calls: [{ index: 0, id: 'c2', function: { name: 'other', arguments: '{}' } }] }, finish_reason: 'tool_calls' }] },
    { choices: [], usage: { prompt_tokens: 100, prompt_tokens_details: { cached_tokens: 80 } } }
  ]
  const data = parseAgentSSEText(packets.map(packet => `data: ${JSON.stringify(packet)}\r\n\r\n`).join('') + 'data: [DONE]\r\n\r\n')
  assert.equal(data.choices[0].message.reasoning_content, 'reason one two')
  assert.equal(data.choices[0].message.tool_calls[0].function.arguments, ' { "x" : 1 } ')
  assert.equal(data.choices[0].message.tool_calls[0].signature, 'signed')
  assert.deepEqual(data.choices[0].message.tool_calls.map(call => call.id), ['c1', 'c2'])
  assert.equal(data.usage.prompt_tokens_details.cached_tokens, 80)
})
