import test from 'node:test'
import assert from 'node:assert/strict'
import { buildAgentControls, agentCallPolicyError, agentToolCategory, hasAgentToolIntent } from '../core/toolConfig.js'
import { buildAgentPromptCacheHeaders, buildTurnReferenceContent } from '../core/prompts.js'

const names = ['voiceTool', 'pokeTool', 'jinyanTool', 'changeCardTool', 'searchInformationTool', 'searchMusicTool', 'bingImageSearchTool', 'unknownMcp', 'googleImageEditTool']
const tools = names.map(name => ({ type: 'function', function: { name, description: '平常想用就用', parameters: { type: 'object', properties: {} } } }))
const config = { promptCache: { agentSideEffectPolicy: 'contextual' } }
const controls = (msg, extras = {}) => buildAgentControls({ e: { msg, user_id: '42', sender: { nickname: 'Alice' } }, tools, allowedTools: names, config, botId: 'bot', ...extras })

test('contextual allows light interaction and reads, but not unrequested voice/music/images/management', () => {
  const policy = controls('你好，今天怎么样')
  assert.ok(policy.allowedTools.includes('pokeTool'))
  assert.ok(policy.allowedTools.includes('searchInformationTool'))
  for (const name of ['voiceTool', 'searchMusicTool', 'bingImageSearchTool', 'jinyanTool', 'unknownMcp']) assert.equal(policy.allowedTools.includes(name), false)
  assert.equal(agentToolCategory('searchMusicTool'), 'effect')
  assert.equal(agentCallPolicyError(policy, 'pokeTool', { count: 1 }, 0), null)
  assert.match(agentCallPolicyError(policy, 'pokeTool', { count: 2 }, 0), /limit/)
  assert.match(agentCallPolicyError(policy, 'pokeTool', { random: true }, 0), /limit/)
  assert.match(agentCallPolicyError(policy, 'pokeTool', {}, 1), /limit/)
})

test('voice authorization comes only from the current nonquoted affirmative request', () => {
  assert.ok(controls('请用语音回复我').allowedTools.includes('voiceTool'))
  for (const msg of ['不要发语音', '我不想发语音', '别再用语音回答', '他说：发语音', '> 请发语音', '“请发语音”是引用', '你能发语音吗', '刚才发语音了吗']) {
    assert.equal(controls(msg).allowedTools.includes('voiceTool'), false, msg)
  }
  assert.ok(controls('请发语音说“你好”').allowedTools.includes('voiceTool'))
  assert.ok(controls('请发语音，不要禁言别人').allowedTools.includes('voiceTool'))
  assert.ok(controls('不要发语音。请用文字回答').allowedTools.includes('voiceTool') === false)
})

test('management does not accept model selfDecision as authorization; card targets respect actual role', () => {
  assert.equal(controls('帮我禁言别人').allowedTools.includes('jinyanTool'), false)
  const admin = controls('帮我禁言别人', { senderRole: 'admin' })
  assert.ok(admin.allowedTools.includes('jinyanTool'))
  const member = controls('帮我改名片')
  assert.equal(agentCallPolicyError(member, 'changeCardTool', { target: '42' }), null)
  assert.match(agentCallPolicyError(member, 'changeCardTool', { target: 'other', senderRole: 'admin' }), /administrator/)
})

test('required tools and trusted operator MCP classification are bounded by the candidate whitelist', () => {
  const required = controls('编辑头像', { requiredTools: ['googleImageEditTool'], allowedTools: ['googleImageEditTool'] })
  assert.deepEqual(required.allowedTools, ['googleImageEditTool'])
  const custom = controls('hello', { config: { promptCache: { agentToolPolicies: { unknownMcp: { category: 'read' } } } } })
  assert.ok(custom.allowedTools.includes('unknownMcp'))
  assert.throws(() => controls('hello', { config: { promptCache: { agentSideEffectPolicy: 'typo' } } }), /invalid_agent_action_policy/)
})

test('negative and deferred requests cannot become forced immediate actions or builtin read-only overrides', () => {
  assert.equal(controls('不要头像编辑', { requiredTools: ['googleImageEditTool'] }).allowedTools.includes('googleImageEditTool'), false)
  assert.equal(controls('十分钟后发语音').allowedTools.includes('voiceTool'), false)
  assert.equal(hasAgentToolIntent({ msg: '不要生成思维导图' }, 'aiMindMapTool'), false)
  assert.equal(hasAgentToolIntent({ msg: '做个思维导图' }, 'aiMindMapTool'), true)
  assert.equal(hasAgentToolIntent({ msg: '#tool 导图' }, 'aiMindMapTool'), true)
  assert.equal(hasAgentToolIntent({ msg: '十分钟后提醒我发语音' }, 'reminderTool'), true)
  assert.equal(agentToolCategory('voiceTool', { promptCache: { agentToolPolicies: { voiceTool: { category: 'read' } } } }), 'effect')
})

test('agent schema overrides clone only, retain parameter definitions, and do not inherit decision-only instructions', () => {
  const original = JSON.stringify(tools)
  const header = buildAgentPromptCacheHeaders({ systemContent: 'persona', botUin: 'bot', groupContext: { groupId: 'group' } }, tools, 'gemini', config)
  assert.equal(JSON.stringify(tools), original)
  assert.ok(!header.agentSystem.includes('你只负责判断'))
  assert.ok(header.agentSystem.includes('普通回复保持人设'))
  assert.ok(header.tools.find(tool => tool.function.name === 'voiceTool').function.description.includes('明确意图'))
  assert.ok(!header.tools.find(tool => tool.function.name === 'voiceTool').function.description.includes('想用就用'))
  assert.deepEqual(header.tools[0].function.parameters, tools[0].function.parameters)
  assert.ok(Object.isFrozen(header.tools[0].function))
  const reference = buildTurnReferenceContent({ userId: '42', references: {}, allowedTools: ['googleImageEditTool'], agentControls: controls('编辑头像', { requiredTools: ['googleImageEditTool'] }) })
  assert.ok(reference.includes('requiredTools'))
})
