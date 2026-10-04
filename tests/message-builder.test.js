import test from "node:test"
import assert from "node:assert/strict"
import { messageBuilderMethods, formatReplayEventRow } from "../core/messageBuilder.js"

const clean = text => messageBuilderMethods.processToolSpecificMessage(text, "anyTool")

test("processToolSpecificMessage：普通文本原样保留", () => {
  assert.equal(clean("今天天气不错"), "今天天气不错")
})

test("processToolSpecificMessage：剥离行内 [图片] 标记", () => {
  assert.equal(clean("看这个[图片]好玩"), "看这个好玩")
})

test("processToolSpecificMessage：markdown 链接转纯文本", () => {
  assert.equal(clean("[百度](https://baidu.com)"), "百度\n- https://baidu.com")
})

test("processToolSpecificMessage：markdown 图片转纯文本（不被 [图片] 剥离拆坏）", () => {
  assert.equal(clean("![图片](https://x.com/a.jpg)"), "图片\n- https://x.com/a.jpg")
})

test("processToolSpecificMessage：完整消息记录行整行移除", () => {
  const record = "[2026-01-27 16:12:51] 哈基米(QQ号: 2127498644)[群身份: member]: 以后注意点。"
  assert.equal(clean(record), "")
})

test("processToolSpecificMessage：多行中只移除消息记录行", () => {
  const input = "你好\n[2026-01-27 16:12:51] 哈基米(QQ号: 123)[群身份: member]: 测试\n再见"
  assert.equal(clean(input), "你好\n再见")
})

test("processToolSpecificMessage：无时间戳的记录前缀残留时提取正文", () => {
  assert.equal(clean("哈基米(QQ号: 123)[群身份: member]: 你好呀"), "你好呀")
})

test("processToolSpecificMessage：v2 短格式记录行整行移除", () => {
  assert.equal(clean("[16:12:51] 哈基米(1694409974)[ID:-AbC]: 以后注意点。"), "")
  assert.equal(clean("[16:12:51] 老王(123)[管理]: 让让"), "")
  assert.equal(clean("你好\n[16:12:51] 小羊(1107491439)[ID:x1]: 测试\n再见"), "你好\n再见")
})

test("processToolSpecificMessage：v2 bot 行只剥 [昵称]: 前缀保留正文", () => {
  assert.equal(clean("[哈基米]: 想听啥？"), "想听啥？")
})

test("formatReplayEventRow：v2 短格式与 bot 行", () => {
  const user = formatReplayEventRow({ message: { time: '2026-10-04 17:46:37', message_id: '-AbC',
    sender: { user_id: '1107491439', nickname: '小羊可粒', role: 'member' }, content: '你好' } }, '1694409974')
  assert.equal(user.role, 'user')
  assert.equal(user.content, '[17:46:37] 小羊可粒(1107491439)[ID:-AbC]: 你好')
  const admin = formatReplayEventRow({ message: { time: '2026-10-04 17:46:37',
    sender: { user_id: '123', nickname: '老王', role: 'admin' }, content: 'hi' } }, '1694409974')
  assert.equal(admin.content, '[17:46:37] 老王(123)[管理]: hi')
  const bot = formatReplayEventRow({ message: { time: '2026-10-04 17:46:37',
    sender: { user_id: '1694409974', nickname: '哈基米', role: 'member' }, content: '想听啥' } }, '1694409974')
  assert.equal(bot.role, 'assistant')
  assert.equal(bot.content, '[哈基米]: 想听啥')
})

test("processToolSpecificMessage：剥离开头的 说: 前缀", () => {
  assert.equal(clean("说: 你好"), "你好")
})

test('V2 ordinary assistant history clips once while source and user content remain intact', () => {
  const original = { time: '2026-10-03 12:00:00', sender: { user_id: 'bot', nickname: 'Bot' }, content: 'x'.repeat(500) }
  const bot = formatReplayEventRow(original, 'bot')
  assert.equal(bot.role, 'assistant')
  assert.ok(bot.content.endsWith('...'))
  assert.equal(original.content.length, 500)
  const user = formatReplayEventRow({ ...original, sender: { user_id: 'user', nickname: 'User' } }, 'bot')
  assert.ok(user.content.includes('x'.repeat(500)))
  assert.equal(formatReplayEventRow({ ...original, content: '【系统提示】 internal' }, 'bot'), null)
})
