import { createHash } from 'node:crypto'

export const MEMORY_SCHEMA_VERSION = 1
export const MEMORY_PREFIX = 'ytbot:memory:v3:'
export const SOURCE_PAGE_LIMIT = 64
export const SOURCE_KINDS = Object.freeze(['member_message', 'bot_message', 'legacy_message'])
export const FACT_KINDS = Object.freeze(['identity', 'preference', 'habit', 'style'])
export const FACT_STATUSES = Object.freeze(['active', 'disputed', 'superseded', 'retracted', 'rejected'])
export const EVENT_LIFECYCLES = Object.freeze(['planned', 'occurred', 'cancelled', 'unknown'])
export const FACT_SLOTS = Object.freeze({ birthday: 'single', residence: 'single', occupation: 'multiple', preference: 'per_target', habit: 'per_target', style: 'per_target' })

export function memoryScope(botId, groupId) {
  if (botId == null || groupId == null || !String(botId) || !String(groupId)) throw new Error('memory_scope_required')
  return { botId: String(botId), groupId: String(groupId), root: `${MEMORY_PREFIX}{${encodeURIComponent(botId)}:${encodeURIComponent(groupId)}}:` }
}

export function memorySourceSettings(config = {}) {
  const value = config.memorySource || {}
  const positive = (number, fallback) => Number.isFinite(Number(number)) && Number(number) > 0 ? Math.floor(Number(number)) : fallback
  return {
    enabled: value.enabled !== false,
    groups: (Array.isArray(value.groups) ? value.groups : config.promptCache?.groups || []).map(String),
    remindMessages: positive(value.remindMessages, 10000),
    remindBytes: positive(value.remindBytes, 32 * 1024 * 1024),
    remindAgeHours: positive(value.remindAgeHours, 168),
    reminderCooldownHours: positive(value.reminderCooldownHours, 24)
  }
}

export function isMemorySourceEnabled(config, groupId) {
  if (groupId == null) return false
  const settings = memorySourceSettings(config)
  return settings.enabled && settings.groups.some(id => id === '*' || id === String(groupId))
}

function sourceTime(value) {
  if (value == null || value === '') return null
  let input = value
  if (typeof value === 'number' || /^\d{10,13}$/.test(String(value))) input = Number(value) < 1e12 ? Number(value) * 1000 : Number(value)
  else if (/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}:\d{2}$/.test(value)) input = value.replace(' ', 'T') + '+08:00'
  const time = new Date(input).getTime()
  return Number.isFinite(time) ? new Date(time).toISOString() : null
}

// 原文从协议消息段取得；journalContent、昵称包装、200 字预览都不能成为证据原件。
export function buildMemorySource(message, scope, { eventId, legacy = false } = {}) {
  const segments = Array.isArray(message.message) ? message.message : []
  const hasText = segments.some(segment => segment.type === 'text')
  const text = hasText ? segments.filter(segment => segment.type === 'text').map(segment => String(segment.text ?? segment.data?.text ?? '')).join('')
    : String(message.raw_message ?? (segments.length ? '' : message.msg ?? message.content ?? ''))
  const senderId = message.sender?.user_id ?? message.user_id
  const sentAt = sourceTime(message.time)
  const messageId = message.message_id == null ? null : String(message.message_id)
  const contentHash = createHash('sha256').update(JSON.stringify([text, segments])).digest('hex')
  const unstableSeed = legacy && messageId == null && !message.origin_key && (!eventId || eventId.startsWith('seed:'))
  const origin = (!unstableSeed && eventId) || message.origin_key || (messageId != null
    ? `message:${scope.botId}:${scope.groupId}:${messageId}`
    : `legacy:${createHash('sha256').update(JSON.stringify([scope.botId, scope.groupId, senderId, sentAt, contentHash])).digest('hex')}`)
  return {
    schemaVersion: MEMORY_SCHEMA_VERSION, eventId: origin, botId: scope.botId, groupId: scope.groupId,
    messageId, senderId: senderId == null ? null : String(senderId),
    senderNameAtTime: message.sender?.card || message.sender?.nickname || null,
    sentAt, receivedAt: sourceTime(message.received_at) || new Date().toISOString(),
    sourceKind: String(senderId) === scope.botId ? 'bot_message' : legacy ? 'legacy_message' : 'member_message',
    text, segments, contentHash,
    replyToMessageId: String(message.source?.message_id ?? segments.find(segment => segment.type === 'reply')?.id ?? '') || null,
    mentions: segments.filter(segment => segment.type === 'at').map(segment => String(segment.qq ?? segment.data?.qq ?? '')).filter(Boolean),
    fidelity: hasText || typeof message.raw_message === 'string' ? 'original' : segments.length ? 'segments_only' : 'legacy_content',
    identityQuality: senderId == null ? 'unknown' : 'platform',
    originQuality: origin.startsWith('legacy:') ? 'derived' : 'stable'
  }
}
