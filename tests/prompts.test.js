import test from "node:test"
import assert from "node:assert/strict"
import {
  buildChatSystemPrompt, buildPromptCacheHeaders, buildTurnReferenceContent,
  stripTurnReferenceContent, stripHistoricalTurnReferences, TURN_REFERENCE_START, TURN_REFERENCE_END
} from "../core/prompts.js"

const baseParams = {
  systemContent: "你是测试人设",
  botCardInGroup: "基基",
  botUin: 12345,
  botRoleInGroup: "admin",
  groupContext: { groupId: "888", groupName: "测试群", groupNotice: "群公告内容" },
  administrators: "管理A(QQ号: 1)[群身份: admin]",
  localTime: "北京时间: 2026/7/8 12:00:00",
  enhancedPrompts: "",
  mcpPrompts: "",
  toolHistoryPrompt: ""
}

test("buildChatSystemPrompt：包含人设与固定段落", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes("【认知系统初始化】\n你是测试人设"))
  assert.ok(prompt.includes("【核心身份原则】"))
  assert.ok(prompt.includes("【工具调用判断原则】"))
  assert.ok(prompt.includes("【回复格式规则 - 极其重要】"))
})

test("buildChatSystemPrompt：机器人身份正确插值", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes('你在本群的当前显示名称（群名片）是"基基"，QQ号 12345，群身份 admin'))
})

test("buildChatSystemPrompt：实时数据 JSON 包含群信息与时间", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.includes('"group_id": "888"'))
  assert.ok(prompt.includes('"group_name": "测试群"'))
  assert.ok(prompt.includes('"group_notice": "群公告内容"'))
  assert.ok(prompt.includes('"local_time": "北京时间: 2026/7/8 12:00:00"'))
})

test("buildChatSystemPrompt：角色状态段随 enhancedPrompts 出现/消失", () => {
  const without = buildChatSystemPrompt(baseParams)
  assert.ok(!without.includes("【角色状态】"))

  const withPrompts = buildChatSystemPrompt({ ...baseParams, enhancedPrompts: "当前情绪：开心" })
  assert.ok(withPrompts.includes("【角色状态】\n当前情绪：开心"))
})

test("buildChatSystemPrompt：工具历史段可选且位于消息记录段之前", () => {
  const prompt = buildChatSystemPrompt({ ...baseParams, toolHistoryPrompt: "【工具调用历史】\n- pokeTool ✓" })
  const historyIndex = prompt.indexOf("【工具调用历史】")
  const recordIndex = prompt.indexOf("【群聊消息记录】")
  assert.ok(historyIndex > -1)
  assert.ok(historyIndex < recordIndex)
})

test("buildChatSystemPrompt：以群聊消息记录段结尾", () => {
  const prompt = buildChatSystemPrompt(baseParams)
  assert.ok(prompt.endsWith("【群聊消息记录】\n"))
})

const referenceOptions = {
  turnId: 'turn-one', userId: '42', messageId: 'message-one', asOf: '2026-10-03T12:00:00.000Z',
  references: { time: 'current time', memory: 'current memory' }, taskStatuses: ['current processing'], allowedTools: ['probe']
}

test('turn reference anchors delimit all current data and strip exactly the generated suffix', () => {
  const reference = buildTurnReferenceContent(referenceOptions)
  assert.ok(reference.startsWith(TURN_REFERENCE_START))
  assert.ok(reference.endsWith(TURN_REFERENCE_END))
  for (const value of ['current time', 'current memory', 'current processing', 'message-one', '42', 'probe']) assert.ok(reference.includes(value))
  const body = 'quoted message and https://example.test/image.png\n\n'
  assert.equal(stripTurnReferenceContent(body + reference, reference), body)
  assert.equal(stripTurnReferenceContent(body, reference), body)
  assert.equal(stripTurnReferenceContent(body, ''), body)
  assert.equal(stripTurnReferenceContent(body + reference, reference.slice(0, -TURN_REFERENCE_END.length)), body + reference)
  assert.equal(stripTurnReferenceContent(body + reference + '\nuser text', reference), body + reference + '\nuser text')
})

test('reference stripping preserves literal anchors in user input and nested markers in RAG', () => {
  const quoted = buildTurnReferenceContent({ ...referenceOptions, turnId: 'quoted' })
  const body = `literal ${TURN_REFERENCE_START} text ${TURN_REFERENCE_END}\n${quoted}`
  const reference = buildTurnReferenceContent({ ...referenceOptions, references: { memory: `data ${TURN_REFERENCE_START} inner ${TURN_REFERENCE_END}` } })
  assert.equal(stripTurnReferenceContent(body + reference, reference), body)
})

test('legacy cleanup requires matching turn/message metadata and complete generated footer', () => {
  const reference = buildTurnReferenceContent(referenceOptions)
  const legacy = '\n\n' + reference.slice(TURN_REFERENCE_START.length, -TURN_REFERENCE_END.length)
  const body = 'a pasted 【本轮参考资料】 title stays in user text'
  const row = { role: 'user', content: body + legacy }
  const reply = { role: 'assistant', content: 'reply', reasoning_content: 'retained reasoning' }
  const block = { turnId: 'turn-one', messageIds: ['message-one'], toolRows: [row, reply], chatRows: [row, reply] }
  const cleaned = stripHistoricalTurnReferences(block)
  assert.equal(cleaned.toolRows[0].content, body)
  assert.equal(cleaned.chatRows[0].content, body)
  assert.deepEqual(cleaned.toolRows[1], reply)
  assert.equal(block.toolRows[0].content, body + legacy)
  assert.equal(stripHistoricalTurnReferences(cleaned), cleaned)
  for (const other of [
    { ...block, turnId: 'foreign' }, { ...block, messageIds: ['foreign'] },
    { ...block, toolRows: [{ ...row, content: row.content + ' added user text' }], chatRows: [] },
    { ...block, toolRows: [{ ...row, content: row.content.replace('"asOf": "2026-10-03T12:00:00.000Z"', '"asOf": "invalid"') }], chatRows: [] }
  ]) assert.equal(stripHistoricalTurnReferences(other), other)
})

test('only V2 system rules declare reference snapshots ephemeral', () => {
  const header = buildPromptCacheHeaders(baseParams, [])
  assert.ok(header.toolSystem.includes('本轮参考资料不进入历史回放'))
  assert.ok(header.chatSystem.includes('本轮参考资料不进入历史回放'))
  assert.ok(!header.toolSystem.includes('历史快照和工具收尾提示'))
  assert.ok(!buildChatSystemPrompt(baseParams).includes('本轮参考资料不进入历史回放'))
})
