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
  globalThis.Bot = { nickname: '哈基米' }
  try {
    assert.equal(clean("[哈基米]: 想听啥？"), "想听啥？")
    // bot 行带 ID（撤回目标）与第二行 bot 复述（逐行处理）
    assert.equal(clean("[哈基米][ID:-AbC]: 想听啥"), "想听啥")
    assert.equal(clean("第一行\n[哈基米]: 第二行复述"), "第一行\n第二行复述")
    // 非 bot 的短方括号标题不受影响
    assert.equal(clean("[注意]: 请勿重启服务"), "[注意]: 请勿重启服务")
    // 旧 bot 前缀也剥
    assert.equal(clean("[Bot回复]: 想听啥"), "想听啥")
  } finally { delete globalThis.Bot }
})

test("processToolSpecificMessage：正文中间的 [ID:x]: 字样不触发兜底截取", () => {
  assert.equal(clean("请完整保留这段 [ID:abc]: 后面的值是 42"), "请完整保留这段 [ID:abc]: 后面的值是 42")
  assert.equal(clean("配置写作 `route[ID:abc]: value` 请勿修改"), "配置写作 `route[ID:abc]: value` 请勿修改")
})

test("processToolSpecificMessage：裸形状日志行只剥前缀保留正文", () => {
  assert.equal(clean("[17:46:37] worker(123): ENOENT /tmp/input"), "ENOENT /tmp/input")
})

test("processToolSpecificMessage：冒号后不跨行，下一行回答不丢", () => {
  assert.equal(clean("[17:46:37] 小羊(123):\n下一行正常回答"), "下一行正常回答")
})

test("processToolSpecificMessage：旧 [消息ID:x] 标签整行删", () => {
  assert.equal(clean("[16:11:11] 哈基米(1694409974)[消息ID:abc]: 你好"), "")
})

test("processToolSpecificMessage：艾特了分支不跨行吞答", () => {
  // 第一行（艾特了所在记录行）整行删，第二行正文保全（复述中夹的艾特段对象壳残留可接受）
  assert.equal(clean("[17:46:37] 小羊(123)[ID:x]: 艾特了\nworker(456): ENOENT /tmp/input"), "worker(456): ENOENT /tmp/input")
})

test("processToolSpecificMessage：无标签但带在群里说引导的旧格式整行删", () => {
  assert.equal(clean("[17:46:37] 小羊(123): 在群里说: 旧复述"), "")
})

test("processToolSpecificMessage：多标签残段截取正文", () => {
  assert.equal(clean("小羊(123)[管理][ID:x]: 正常回答"), "正常回答")
})

test("processToolSpecificMessage：V1 双层包装（bot 外层+记录内层）整体清洗", () => {
  globalThis.Bot = { nickname: '哈基米' }
  try {
    // 外层 bot 前缀先剥、内层记录行再整行删——整行复述清洗为空（上游有空输出保护不发送）
    assert.equal(clean("[哈基米]: [17:46:37] 哈基米(123)[ID:10001]: 第一条"), "")
    assert.equal(clean("[哈基米]: [17:46:37] 哈基米(123): 在群里说: 第二条"), "")
    // 复述夹在正常正文之间时正文保留
    assert.equal(clean("正常话\n[哈基米]: [17:46:37] 哈基米(123)[ID:10001]: 复述\n还有话"), "正常话\n还有话")
  } finally { delete globalThis.Bot }
})

test("processToolSpecificMessage：markdown 链接定义不被裸标签兜底吞", () => {
  assert.equal(clean("[ID:abc]: https://example.com/a"), "[ID:abc]: https://example.com/a")
})

test("processToolSpecificMessage：特殊昵称（含 markdown 元字符）不被链接转换拆坏", () => {
  globalThis.Bot = { nickname: '哈[基](米)+?' }
  try {
    assert.equal(clean("[哈[基](米)+?][ID:10001]: 内容"), "内容")
  } finally { delete globalThis.Bot }
})

test("processToolSpecificMessage：损坏 ID 标签不跨行吞下一行标题", () => {
  // 损坏残行原样留存（无闭合标签无可判形状），关键是下一行通知不被吸入
  assert.equal(clean("[17:46:37] 小羊(123)[ID:x\n[注意]: 请勿重启服务"), "[17:46:37] 小羊(123)[ID:x\n[注意]: 请勿重启服务")
})

test("processToolSpecificMessage：markdown 转换拼出的 bot 前缀补清洗", () => {
  globalThis.Bot = { nickname: '哈基米' }
  try {
    assert.equal(clean("[[哈基米]: 内容](https://example.com/a)"), "内容\n- https://example.com/a")
  } finally { delete globalThis.Bot }
})

test("processToolSpecificMessage：markdown 定义的尖括号与相对路径形式不受兜底剥", () => {
  assert.equal(clean("[ID:abc]: <https://example.com/a>"), "[ID:abc]: <https://example.com/a>")
  assert.equal(clean("[ID:abc]: ./docs/file.md"), "[ID:abc]: ./docs/file.md")
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
  // bot 行保留消息 ID（撤回定位目标）
  const botWithId = formatReplayEventRow({ message: { time: '2026-10-04 17:46:37', message_id: '-AbC',
    sender: { user_id: '1694409974', nickname: '哈基米', role: 'member' }, content: '想听啥' } }, '1694409974')
  assert.equal(botWithId.content, '[哈基米][ID:-AbC]: 想听啥')
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
