import { MEMORY_SCHEMA_VERSION, SOURCE_PAGE_LIMIT, memoryScope, buildMemorySource } from './sourceSchema.js'
import { setImmediate as yieldLoop } from 'node:timers/promises'

const CLOCK = `local clock = redis.call('TIME'); local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)`

// 调用方先 prepare，再写账本，最后 append；类型/计数/JSON 校验必须在任何写入之前完成。
export const MEMORY_SOURCE_LUA = `
local function prepareMemory(keys, payload, ledgerSeq, resetId)
  local types = {'string', 'zset', 'hash', 'hash'}
  for i, key in ipairs(keys) do
    local kind = redis.call('TYPE', key).ok
    if kind ~= 'none' and kind ~= types[i] then return nil, 'memory_source_type' end
  end
  local ok, source = pcall(cjson.decode, payload)
  if not ok or type(source) ~= 'table' or source.schemaVersion ~= ${MEMORY_SCHEMA_VERSION} or type(source.eventId) ~= 'string' or source.eventId == '' then return nil, 'memory_source_invalid' end
  local latest = tonumber(redis.call('GET', keys[1]) or '0')
  local byteText = redis.call('HGET', keys[4], 'pendingBytes') or '0'
  local bytes = tonumber(byteText)
  local cursor = tonumber(redis.call('HGET', keys[4], 'extractedThrough') or '0')
  if not latest or latest < 0 or latest % 1 ~= 0 or latest >= 9007199254740990 or not bytes or bytes < 0 or bytes % 1 ~= 0 then return nil, 'memory_source_gap' end
  if byteText ~= string.format('%.0f', bytes) then return nil, 'memory_source_gap' end
  if redis.call('HLEN', keys[3]) ~= latest then return nil, 'memory_source_gap' end
  if latest > 0 and redis.call('HEXISTS', keys[4], 'pendingBytes') == 0 then return nil, 'memory_source_gap' end
  if not cursor or cursor < 0 or cursor > latest or cursor % 1 ~= 0 or redis.call('ZCARD', keys[2]) ~= latest-cursor then return nil, 'memory_source_gap' end
  local existing = redis.call('HGET', keys[3], source.eventId)
  if existing then
    local previous = tonumber(existing)
    if not previous or previous < 1 or previous > latest or previous % 1 ~= 0 then return nil, 'memory_source_gap' end
    return {seq=previous, duplicate=true}, nil
  end
  local seq = latest + 1
  local encoded = cjson.encode({memorySeq=seq, eventId=source.eventId, payload=payload,
    ledgerRef=ledgerSeq and {seq=ledgerSeq, resetId=resetId} or cjson.null})
  if bytes + string.len(encoded) >= 9007199254740990 then return nil, 'memory_source_gap' end
  return {seq=seq, encoded=encoded, eventId=source.eventId}, nil
end
local function appendMemory(keys, item, now)
  if item.duplicate then return end
  redis.call('SET', keys[1], item.seq)
  redis.call('ZADD', keys[2], item.seq, item.encoded)
  redis.call('HSET', keys[3], item.eventId, item.seq)
  redis.call('HINCRBY', keys[4], 'pendingBytes', string.len(item.encoded))
  redis.call('HSETNX', keys[4], 'captureStartedAt', now)
  redis.call('HSETNX', keys[4], 'oldestPendingAt', now)
  redis.call('HSETNX', keys[4], 'extractedThrough', 0)
  redis.call('HSETNX', keys[4], 'memoryRevision', 0)
  redis.call('HSET', keys[4], 'lastCapturedAt', now)
end`

const RECORD = `${CLOCK}
${MEMORY_SOURCE_LUA}
local item, err = prepareMemory(KEYS, ARGV[1], tonumber(ARGV[2]), ARGV[3])
if err then return cjson.encode({error=err}) end
appendMemory(KEYS, item, now)
return cjson.encode({memorySeq=item.seq, duplicate=item.duplicate or false})`

const READ_RANGE = `local latest = tonumber(redis.call('GET', KEYS[1]) or '0')
local untilSeq = tonumber(ARGV[2]) or latest
if untilSeq > latest then return cjson.encode({error='memory_source_range'}) end
return cjson.encode({untilSeq=untilSeq, rows=redis.call('ZRANGEBYSCORE', KEYS[2], '(' .. ARGV[1], untilSeq, 'LIMIT', 0, ARGV[3])})`

const STATUS = `local meta = {}; local values = redis.call('HGETALL', KEYS[4])
for i=1,#values,2 do meta[values[i]]=values[i+1] end
return cjson.encode({latest=tonumber(redis.call('GET', KEYS[1]) or '0'), pending=redis.call('ZCARD', KEYS[2]), meta=meta})`

const ERROR = `${CLOCK}
redis.call('HSET', KEYS[1], 'lastError', ARGV[1], 'lastErrorAt', now)
return cjson.encode({recorded=true})`

const REMIND = `${CLOCK}
local count = redis.call('ZCARD', KEYS[1])
local bytes = tonumber(redis.call('HGET', KEYS[2], 'pendingBytes') or '0')
local oldest = tonumber(redis.call('HGET', KEYS[2], 'oldestPendingAt') or now)
local previous = tonumber(redis.call('HGET', KEYS[2], 'remindedAt') or '0')
if count == 0 or (count < tonumber(ARGV[1]) and bytes < tonumber(ARGV[2]) and now-oldest < tonumber(ARGV[3])) or now-previous < tonumber(ARGV[4]) then return cjson.encode({due=false}) end
redis.call('HSET', KEYS[2], 'remindedAt', now)
return cjson.encode({due=true, count=count, bytes=bytes, oldest=oldest})`

const SNAPSHOT_STATUS = `local result = {}; local values = redis.call('HGETALL', KEYS[1])
for i=1,#values,2 do result[values[i]]=values[i+1] end
return cjson.encode(result)`

const SNAPSHOT_UPDATE = `for i=1,#ARGV,2 do redis.call('HSET', KEYS[1], ARGV[i], ARGV[i+1]) end
return cjson.encode({saved=true})`

const ARCHIVE_RECENT = `redis.call('HSETNX', KEYS[2], 'recent', ARGV[1])
return cjson.encode({payload=redis.call('HGET', KEYS[2], 'recent')})`

const ARCHIVE_RAW = `local rows = {}
for i=tonumber(ARGV[1]),tonumber(ARGV[2]) do
  local row = redis.call('HGET', KEYS[1], 'raw:' .. i)
  if row then table.insert(rows, row) end
end
return cjson.encode({rows=rows})`

export class MemorySourceStore {
  constructor(client = null) {
    this.client = client
    this.errors = new Map()
    this.historyTasks = new Map()
    this.historyCompleted = new Set()
  }

  scope(botId, groupId) { return memoryScope(botId, groupId) }

  keys(scope) {
    const root = memoryScope(scope.botId, scope.groupId).root
    return ['source:seq', 'source:pending', 'source:seen', 'meta'].map(suffix => root + suffix)
  }

  snapshotKeys(scope) {
    const root = memoryScope(scope.botId, scope.groupId).root
    return [root + 'source:snapshot', root + 'source:archive']
  }

  async evaluate(script, keys, args = []) {
    const client = this.client || globalThis.redis
    if (!client?.eval) throw new Error('memory_redis_unavailable')
    const result = JSON.parse(await client.eval(script, { keys, arguments: args.map(String) }))
    if (result.error) throw new Error(result.error)
    return result
  }

  async record(scope, source, { ledgerRef = null } = {}) {
    if (source.botId !== String(scope.botId) || source.groupId !== String(scope.groupId)) throw new Error('memory_source_scope')
    try {
      const result = await this.evaluate(RECORD, this.keys(scope), [JSON.stringify(source), ledgerRef?.seq ?? '', ledgerRef?.resetId ?? ''])
      await this.flushError(scope)
      return result
    } catch (error) { await this.noteFailure(scope, error); throw error }
  }

  async readSourceRange(scope, { after = 0, until = null, limit = SOURCE_PAGE_LIMIT } = {}) {
    if (!Number.isSafeInteger(after) || after < 0 || until != null && (!Number.isSafeInteger(until) || until < after)) throw new Error('memory_source_range')
    const size = Math.max(1, Math.min(SOURCE_PAGE_LIMIT, Math.floor(Number(limit)) || SOURCE_PAGE_LIMIT))
    const result = await this.evaluate(READ_RANGE, this.keys(scope).slice(0, 2), [after, until ?? '', size])
    const rows = (Array.isArray(result.rows) ? result.rows : []).map(encoded => {
      const row = JSON.parse(encoded)
      return { ...JSON.parse(row.payload), memorySeq: row.memorySeq, ledgerRef: row.ledgerRef }
    })
    if (rows.some((row, index) => row.memorySeq !== after + index + 1) || rows.length < size && (rows.at(-1)?.memorySeq ?? after) < result.untilSeq) throw new Error('memory_source_gap')
    return { rows, until: result.untilSeq, next: rows.at(-1)?.memorySeq ?? after }
  }

  async status(scope) {
    const result = await this.evaluate(STATUS, this.keys(scope))
    const error = this.errors.get(this.keys(scope)[3])
    return { ...result, meta: { ...result.meta, ...(error || {}) }, snapshot: await this.snapshotStatus(scope) }
  }

  async noteFailure(scope, error) {
    const key = this.keys(scope)[3]
    const message = String(error.code || error.message || 'memory_capture_failed').slice(0, 300)
    this.errors.set(key, { lastError: message, lastErrorAt: Date.now() })
    if (this.errors.size > 1000) this.errors.delete(this.errors.keys().next().value)
    globalThis.logger?.warn?.(`[MemorySource] 采集失败 group=${scope.groupId}: ${message}`)
    await this.flushError(scope)
  }

  async flushError(scope) {
    const key = this.keys(scope)[3]
    const error = this.errors.get(key)
    if (!error) return
    try {
      await this.evaluate(ERROR, [key], [error.lastError])
      if (this.errors.get(key) === error) this.errors.delete(key)
    } catch { /* Redis 不可用时留在内存并记录日志，下次成功连接后补写。 */ }
  }

  claimReminder(scope, settings) {
    const keys = this.keys(scope)
    return this.evaluate(REMIND, [keys[1], keys[3]], [settings.remindMessages, settings.remindBytes, settings.remindAgeHours * 3600000, settings.reminderCooldownHours * 3600000])
  }

  snapshotStatus(scope) { return this.evaluate(SNAPSHOT_STATUS, this.snapshotKeys(scope).slice(0, 1)) }

  updateSnapshot(scope, values) {
    return this.evaluate(SNAPSHOT_UPDATE, this.snapshotKeys(scope).slice(0, 1), Object.entries(values).flat())
  }

  scheduleHistory(scope, contextStore, recent) {
    const key = this.keys(scope)[3]
    if (this.historyCompleted.has(key) || this.historyTasks.has(key)) return this.historyTasks.get(key)
    const task = yieldLoop().then(() => this.preserveHistory(scope, contextStore, recent))
      .then(() => { this.historyCompleted.add(key) })
      .catch(error => this.noteFailure(scope, error))
      .finally(() => { this.historyTasks.delete(key) })
    this.historyTasks.set(key, task)
    return task
  }

  async preserveHistory(scope, contextStore, recent = []) {
    let state = await this.snapshotStatus(scope)
    if (state.importedAt) return state
    if (typeof recent === 'function') recent = await recent()
    // 近期缓冲本来有条数上限；快照只在后台解析。超大旧缓冲报错保留，不静默截断。
    const recentJson = JSON.stringify(recent)
    if (Buffer.byteLength(recentJson) > 4 * 1024 * 1024) throw new Error('memory_recent_snapshot_oversize')
    const archived = await this.evaluate(ARCHIVE_RECENT, this.snapshotKeys(scope), [recentJson])
    const messages = JSON.parse(archived.payload)
    while (!(await contextStore.captureMemoryPage(scope)).done) await yieldLoop()
    state = await this.snapshotStatus(scope)
    for (let next = Number(state.rawImportedThrough ?? Number(state.rawFrom) - 1) + 1; next <= Number(state.rawUntil); next += SOURCE_PAGE_LIMIT) {
      const end = Math.min(Number(state.rawUntil), next + SOURCE_PAGE_LIMIT - 1)
      const page = await this.evaluate(ARCHIVE_RAW, this.snapshotKeys(scope).slice(1), [next, end])
      for (const encoded of Array.isArray(page.rows) ? page.rows : []) {
        const row = JSON.parse(encoded)
        const event = JSON.parse(row.payload)
        await this.record(scope, buildMemorySource(event.message, scope, { eventId: event.eventId, legacy: true }),
          { ledgerRef: { seq: row.seq, resetId: state.resetId } })
      }
      await this.updateSnapshot(scope, { rawImportedThrough: end })
      await yieldLoop()
    }
    for (let index = Number(state.recentImported || 0); index < messages.length; index++) {
      await this.record(scope, buildMemorySource(messages[index], scope, { legacy: true }))
      await this.updateSnapshot(scope, { recentImported: index + 1 })
      if (index % SOURCE_PAGE_LIMIT === 0) await yieldLoop()
    }
    await this.updateSnapshot(scope, { importedAt: Date.now(), recentCount: messages.length,
      recentOldest: messages.map(row => row.time).filter(Boolean).sort()[0] || 'unknown',
      replayPolicy: 'archived_verbatim_not_extracted' })
    return this.snapshotStatus(scope)
  }
}

export const memorySourceStore = new MemorySourceStore()
