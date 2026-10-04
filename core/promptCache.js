import { createHash, randomUUID } from 'node:crypto'
import { getEncoding } from 'js-tiktoken'
export { formatReplayEventRow as replayEventRow } from './messageBuilder.js'

let encoding
const eventOrigins = new WeakMap()

function finiteSetting(value, fallback) {
  const number = Number(value)
  return Number.isFinite(number) && number > 0 ? Math.floor(number) : fallback
}

function samplingSetting(value, fallback, min, max) {
  const number = Number(value ?? fallback)
  return Number.isFinite(number) && number >= min && number <= max ? number : fallback
}

const matchesGroup = (groups, groupId) => groups.some(id => id === '*' || id === String(groupId))

export function promptCacheSettings(config = {}) {
  const value = config.promptCache || {}
  const highWater = Math.max(4096, finiteSetting(value.highWaterTokens, 65536))
  return {
    enabled: value.enabled === true,
    groups: Array.isArray(value.groups) ? value.groups.map(String) : [],
    singleStage: value.singleStage === true,
    singleStageGroups: Array.isArray(value.singleStageGroups) ? value.singleStageGroups.map(String) : [],
    agentTemperature: samplingSetting(value.agentTemperature, 0.85, 0, 2),
    agentTopP: samplingSetting(value.agentTopP, 0.95, 0.01, 1),
    agentSideEffectPolicy: ['contextual', 'legacy', 'explicit'].includes(value.agentSideEffectPolicy ?? 'contextual')
      ? value.agentSideEffectPolicy ?? 'contextual' : null,
    highWater,
    lowWater: Math.min(highWater, Math.max(2048, finiteSetting(value.lowWaterTokens, 32768))),
    reserveTokens: Math.max(1024, finiteSetting(value.reserveTokens, 8192)),
    rawMaxEvents: Math.max(100, finiteSetting(value.rawMaxEvents, 20000)),
    rawMaxBytes: Math.max(1048576, finiteSetting(value.rawMaxBytes, 33554432)),
    diagnostics: value.diagnostics !== false,
    preserveForcedSubsets: value.preserveForcedSubsets !== false,
    preserveFinalNoTools: value.preserveFinalNoTools !== false
  }
}

export function isPromptCacheEnabled(config, groupId) {
  return promptCacheMode(config, groupId) !== 'v1'
}

export function isSingleStageRequested(config, groupId) {
  const settings = promptCacheSettings(config)
  return settings.enabled && config?.enabled !== false && config?.groupHistory !== false && settings.singleStage &&
    matchesGroup(settings.groups, groupId) && matchesGroup(settings.singleStageGroups, groupId)
}

export function agentConfigurationError(config, groupId) {
  if (!isSingleStageRequested(config, groupId)) return null
  if (!promptCacheSettings(config).agentSideEffectPolicy) return 'invalid_agent_action_policy'
  const chat = config?.chatAiConfig || {}
  const keys = Array.isArray(chat.chatApiKey) ? chat.chatApiKey : [chat.chatApiKey]
  if (!chat.chatApiUrl || !chat.chatApiModel || !keys.some(key => typeof key === 'string' && key.trim())) return 'agent_route_not_configured'
  try {
    const url = new URL(chat.chatApiUrl)
    if (!['http:', 'https:'].includes(url.protocol) || url.pathname.includes('/v1/messages')) return 'agent_route_not_supported'
  } catch { return 'agent_route_not_supported' }
  return null
}

export function promptCacheMode(config, groupId) {
  const settings = promptCacheSettings(config)
  if (!settings.enabled || config?.enabled === false || config?.groupHistory === false || groupId === undefined ||
    !matchesGroup(settings.groups, groupId) || String(config?.chatAiConfig?.chatApiUrl || '').toLowerCase().includes('/v1/messages')) return 'v1'
  const chat = config?.chatAiConfig || {}
  const keys = Array.isArray(chat.chatApiKey) ? chat.chatApiKey : [chat.chatApiKey]
  if (settings.singleStage && matchesGroup(settings.singleStageGroups, groupId) && settings.agentSideEffectPolicy &&
    chat.chatApiUrl && chat.chatApiModel && keys.some(key => typeof key === 'string' && key.trim())) return 'agent'
  return config?.useTools && String(config?.toolsAiConfig?.toolsAiUrl || '').toLowerCase().includes('/v1/messages') ? 'v1' : 'dual'
}

export function beijingDay(now = Date.now()) {
  const date = new Date(now + 8 * 3600000)
  const dayKey = date.toISOString().slice(0, 10).replaceAll('-', '')
  const deadline = Date.UTC(date.getUTCFullYear(), date.getUTCMonth(), date.getUTCDate() + 1) - 8 * 3600000
  return { dayKey, deadline, expiresAt: Math.floor(deadline / 1000) + 2 * 86400 }
}

export function botIdForEvent(e = {}) {
  const botId = e.self_id ?? e.bot?.uin ?? globalThis.Bot?.uin ?? 'unknown'
  return String(Array.isArray(botId) ? botId[0] ?? 'unknown' : botId)
}

export function originKeyForEvent(e = {}) {
  if (Object.hasOwn(e, '_promptCacheOriginKey') && e._promptCacheOriginKey) return e._promptCacheOriginKey
  if (eventOrigins.has(e)) return eventOrigins.get(e)
  const messageId = e.message_id
  const key = e._smartOriginKey ? String(e._smartOriginKey) : messageId !== undefined && messageId !== null && String(messageId) !== ''
    ? `message:${botIdForEvent(e)}:${e.group_id}:${messageId}`
    : `event:${randomUUID()}`
  try { e._promptCacheOriginKey = key } catch {}
  eventOrigins.set(e, key)
  return key
}

export function wireClone(value) {
  return JSON.parse(JSON.stringify(value))
}

export function freezeWire(value) {
  if (value && typeof value === 'object' && !Object.isFrozen(value)) {
    Object.values(value).forEach(freezeWire)
    Object.freeze(value)
  }
  return value
}

export function tokenEstimate(value) {
  encoding ||= getEncoding('cl100k_base')
  return encoding.encode(typeof value === 'string' ? value : JSON.stringify(value), [], []).length
}

export function cacheFingerprint(value) {
  return createHash('sha256').update(JSON.stringify(value)).digest('hex')
}

export function cacheDiagnostic(config, kind, details = {}) {
  if (promptCacheSettings(config).diagnostics) globalThis.logger?.info?.(`[PromptCacheV2] ${JSON.stringify({ kind, ...details })}`)
}
