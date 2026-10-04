// TypeSafe System One (Jev) 判定客户端：批量 Noul 判断「群消息是否在跟机器人说话」
// 设计依据（2026-10-04 实测）：45 连发 0 失败、中位 ~700ms、同请求方差 ±0.02；
// 链路经 7890 代理有 ~8% 数秒级长尾 → 必须 5s 超时 + 重试 1 次（重试即恢复）。
// 概率对 state 措辞敏感（±0.15），阈值默认 0.5 留足带宽（0.6~0.85 均稳过线）。

const TYPESAFE_TIMEOUT_MS = 5000
const TYPESAFE_MAX_ATTEMPTS = 2

/**
 * 调 TypeSafe /v1/systemone，带超时与重试。
 * 任何失败（网络/非 2xx/解析）直接 throw，由调用方回退 flash 判定链。
 */
export async function typesafeRequest(config, body) {
  const url = config.typesafeUrl || 'https://api.typesafe.ai/v1/systemone'
  const apiKey = config.typesafeApiKey
  if (!apiKey || apiKey.includes('xxxxx')) throw new Error('typesafeApiKey 未配置')

  let lastError = null
  for (let attempt = 1; attempt <= TYPESAFE_MAX_ATTEMPTS; attempt++) {
    const controller = new AbortController()
    const timer = setTimeout(() => controller.abort(), TYPESAFE_TIMEOUT_MS)
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers: { 'Authorization': `Bearer ${apiKey}`, 'Content-Type': 'application/json' },
        body: JSON.stringify(body),
        signal: controller.signal
      })
      if (!response.ok) {
        const text = await response.text().catch(() => '')
        const status = response.status
        const err = new Error(`HTTP ${status}: ${text.slice(0, 120)}`)
        err.httpStatus = status // 重试判据用状态码，勿从消息文本识别（正文可能恰好含 "HTTP 500" 字样）
        throw err
      }
      return await response.json()
    } catch (error) {
      lastError = error
      // 仅重试网络类故障（超时/连接重置/5xx）；4xx 是请求形状问题，重试无意义
      const retriable = error.name === 'AbortError' || error.name === 'TypeError'
        || (typeof error.httpStatus === 'number' && error.httpStatus >= 500)
      if (!retriable || attempt === TYPESAFE_MAX_ATTEMPTS) throw error
    } finally {
      clearTimeout(timer)
    }
  }
  throw lastError
}

/**
 * 批量判断多条消息是否在跟机器人说话（strict 追踪的判定替换）。
 * @param {object} config trackAiConfig（读 typesafeModel/typesafeThreshold）
 * @param {Array} batch [{id, userMessage, chatHistory, senderName}]
 * @returns {object} {id: noul概率} —— 只包含判定成功的条目，缺失的 id 由调用方回退单判
 */
export async function typesafeBatchJudge(config, batch) {
  const botName = (typeof Bot !== 'undefined' && Bot.nickname) || '机器人'
  const botUin = (typeof Bot !== 'undefined' && Bot.uin) || ''

  const messages = batch.map(item => ({
    id: item.id,
    sender: item.senderName || '未知用户',
    history: (item.chatHistory || []).slice(-3)
      .map(h => `${h.role === 'bot' ? '机器人' : '用户'}: ${h.content}`).join('\n') || '(无)',
    text: item.userMessage
  }))

  // 每条消息一个独立 Noul 问题：Jev 对同一 state 的独立问题并行作答、互不可见
  const questions = {}
  for (const m of messages) {
    questions[m.id] = {
      type: 'noul',
      instructions: `messages 中 id 为 \`${m.id}\` 的这条消息，是在跟机器人${botName}${botUin ? `(QQ号${botUin})` : ''}说话吗？对机器人的回应、追问、催促、抱怨、责骂都算；@了其他群成员、明确叫别人名字、与机器人无关的群聊水群不算。`
    }
  }

  const result = await typesafeRequest(config, {
    state: { bot: { name: botName, qq: String(botUin) }, messages },
    model: config.typesafeModel || 'jev-latest',
    questions
  })

  const threshold = Number(config.typesafeThreshold) || 0.5
  const probabilities = {}
  for (const [id, answer] of Object.entries(result.answers || {})) {
    // 只接受有限且在 [0,1] 内的概率：JSON 1e400 会解析成 Infinity、异常响应可能越界，
    // 无效值按缺项处理交由上层整批回退 flash，不直接采信
    const p = answer?.noul
    if (Number.isFinite(p) && p >= 0 && p <= 1) probabilities[id] = p
  }
  return { probabilities, threshold, model: result.model }
}
