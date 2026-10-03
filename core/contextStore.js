import { randomUUID } from 'node:crypto'
import { beijingDay, tokenEstimate, replayEventRow } from './promptCache.js'
import { stripHistoricalTurnReferences } from './prompts.js'

// Keep message/header JSON as strings in Lua: cjson round-trips [] as {}.

const CLOCK = `local clock = redis.call('TIME'); local now = tonumber(clock[1]) * 1000 + math.floor(tonumber(clock[2]) / 1000)`
const GUARD = `${CLOCK}
if now >= tonumber(ARGV[2]) then return cjson.encode({error='expired_scope'}) end
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return cjson.encode({error='stale_scope'}) end`
const EXPIRE = `for _, key in ipairs(KEYS) do redis.call('EXPIREAT', key, tonumber(ARGV[3])) end`

const INITIALIZE = `${CLOCK}
if now >= tonumber(ARGV[2]) then return cjson.encode({error='expired_scope'}) end
local active = redis.call('GET', KEYS[1])
if not active then active = ARGV[1]; redis.call('SET', KEYS[1], active); redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3])) end
return cjson.encode({resetId=active})`

const RECORD = `${GUARD}
local existing = redis.call('HGET', KEYS[4], ARGV[4])
if existing then return cjson.encode({seq=tonumber(existing), duplicate=true}) end
if redis.call('EXISTS', KEYS[2]) == 0 and redis.call('ZCARD', KEYS[3]) > 0 then return cjson.encode({error='source_gap'}) end
if tonumber(redis.call('HGET', KEYS[5], 'eventIndexCount') or '0') ~= redis.call('HLEN', KEYS[4]) then return cjson.encode({error='source_gap'}) end
local sourceError = redis.call('HGET', KEYS[5], 'sourceError')
if sourceError then return cjson.encode({error=sourceError}) end
local seq = tonumber(redis.call('GET', KEYS[2]) or '0') + 1
local event = {seq=seq, eventId=ARGV[4], payload=ARGV[5], tokens=tonumber(ARGV[6])}
local encoded = cjson.encode(event)
if redis.call('ZCARD', KEYS[3]) >= tonumber(ARGV[7]) or tonumber(redis.call('HGET', KEYS[5], 'rawBytes') or '0') + string.len(encoded) > tonumber(ARGV[8]) then
  redis.call('HSET', KEYS[5], 'sourceError', 'raw_limit'); ${EXPIRE}
  return cjson.encode({error='raw_limit'})
end
redis.call('INCR', KEYS[2])
redis.call('ZADD', KEYS[3], seq, encoded)
redis.call('HSET', KEYS[4], ARGV[4], seq)
redis.call('HSET', KEYS[5], 'eventIndexCount', redis.call('HLEN', KEYS[4]))
redis.call('HINCRBY', KEYS[5], 'rawBytes', string.len(encoded))
${EXPIRE}
return cjson.encode({seq=seq})`

const REFERENCE_HISTORY = `${GUARD}
local count = redis.call('LLEN', KEYS[6])
if tonumber(redis.call('HGET', KEYS[5], 'referenceCleanCount') or '-1') == count then return cjson.encode({blocks={}}) end
return cjson.encode({blocks=redis.call('LRANGE', KEYS[6], 0, -1)})`

const CLEAN_REFERENCES = `${GUARD}
local blocks = cjson.decode(ARGV[4])
for index, block in ipairs(blocks) do
  local current = redis.call('LINDEX', KEYS[6], index-1)
  if current ~= block.before and current ~= block.after then return cjson.encode({retry=true}) end
end
for index, block in ipairs(blocks) do
  if block.before ~= block.after then redis.call('LSET', KEYS[6], index-1, block.after) end
end
redis.call('HSET', KEYS[5], 'referenceCleanCount', #blocks)
${EXPIRE}
return cjson.encode({cleaned=true})`

const READ = `${GUARD}
local sourceError = redis.call('HGET', KEYS[5], 'sourceError')
if sourceError then return cjson.encode({error=sourceError}) end
local cursor = tonumber(redis.call('HGET', KEYS[5], 'cursor') or '0')
local untilSeq = tonumber(redis.call('GET', KEYS[2]) or '0')
if cursor > untilSeq then return cjson.encode({error='source_gap'}) end
if tonumber(redis.call('HGET', KEYS[5], 'eventIndexCount') or '0') ~= redis.call('HLEN', KEYS[4]) then return cjson.encode({error='source_gap'}) end
if tonumber(redis.call('HGET', KEYS[5], 'replayCount') or '0') ~= redis.call('LLEN', KEYS[6]) then return cjson.encode({error='replay_state_gap'}) end
if tonumber(redis.call('HGET', KEYS[5], 'representedCount') or '0') ~= redis.call('HLEN', KEYS[7]) then return cjson.encode({error='replay_state_gap'}) end
local events = redis.call('ZRANGEBYSCORE', KEYS[3], '(' .. cursor, untilSeq)
local expected = cursor + 1
local incoming = tonumber(ARGV[7])
local decodedEvents = {}
for _, encoded in ipairs(events) do
  local event = cjson.decode(encoded)
  if event.seq ~= expected then return cjson.encode({error='source_gap'}) end
  expected = expected + 1
  event.represented = redis.call('HEXISTS', KEYS[7], event.eventId) == 1
  if not event.represented and event.eventId ~= ARGV[8] then incoming = incoming + (event.tokens or 0) end
  table.insert(decodedEvents, event)
end
if expected ~= untilSeq + 1 then return cjson.encode({error='source_gap'}) end
if incoming > tonumber(ARGV[5]) then return cjson.encode({error='incoming_overflow'}) end
local header = redis.call('HGET', KEYS[5], 'header')
local candidate = ARGV[4]
local changed = false
if not header or (ARGV[9] == '1' and cjson.decode(header).version ~= cjson.decode(candidate).version) then
  changed = header ~= false and header ~= nil
  header = candidate
  redis.call('HSET', KEYS[5], 'header', header)
end
local blocks = redis.call('LRANGE', KEYS[6], 0, -1)
local total = incoming
for _, block in ipairs(blocks) do total = total + (cjson.decode(block).tokens or 0) end
local dropped = 0
if total > tonumber(ARGV[5]) then
  local target = math.max(tonumber(ARGV[6]), incoming)
  while dropped < #blocks and total > target do
    dropped = dropped + 1
    total = total - (cjson.decode(blocks[dropped]).tokens or 0)
  end
  while dropped < #blocks and dropped > 0 do
    local first = cjson.decode(blocks[dropped+1]).toolRows[1]
    if first and first.role == 'user' then break end
    dropped = dropped + 1
    total = total - (cjson.decode(blocks[dropped]).tokens or 0)
  end
  if dropped > 0 then redis.call('LTRIM', KEYS[6], dropped, -1) end
  redis.call('HSET', KEYS[5], 'replayCount', redis.call('LLEN', KEYS[6]))
  local cleanCount = tonumber(redis.call('HGET', KEYS[5], 'referenceCleanCount') or '-1')
  redis.call('HSET', KEYS[5], 'referenceCleanCount', cleanCount == #blocks and (#blocks-dropped) or -1)
end
local kept = {}
for index=dropped+1,#blocks do table.insert(kept, blocks[index]) end
${EXPIRE}
return cjson.encode({cursor=cursor, readUntil=untilSeq, events=decodedEvents, blocks=kept,
  header=header, headerChanged=changed, dropped=dropped, estimatedTokens=total,
  rawCount=redis.call('ZCARD', KEYS[3]), rawBytes=tonumber(redis.call('HGET', KEYS[5], 'rawBytes') or '0')})`

const COMMIT = `${GUARD}
if redis.call('HEXISTS', KEYS[8], ARGV[4]) == 1 then return cjson.encode({duplicate=true}) end
local cursor = tonumber(redis.call('HGET', KEYS[5], 'cursor') or '0')
local untilSeq = tonumber(ARGV[5])
if untilSeq > tonumber(redis.call('GET', KEYS[2]) or '0') then return cjson.encode({error='source_gap'}) end
local candidates = cjson.decode(ARGV[6])
local turn = cjson.decode(ARGV[7])
local replayCount = redis.call('LLEN', KEYS[6])
local referencesClean = tonumber(redis.call('HGET', KEYS[5], 'referenceCleanCount') or '-1') == replayCount
local incoming = {}
for _, candidate in ipairs(candidates) do
  if redis.call('HEXISTS', KEYS[7], candidate.eventId) == 0 then table.insert(incoming, candidate) end
end
for _, candidate in ipairs(incoming) do
  redis.call('RPUSH', KEYS[6], candidate.blockJson)
  redis.call('HSET', KEYS[7], candidate.eventId, '1')
end
redis.call('RPUSH', KEYS[6], ARGV[7])
local represented = cjson.decode(ARGV[8])
for _, id in ipairs(represented) do redis.call('HSET', KEYS[7], id, '1') end
redis.call('HSET', KEYS[5], 'cursor', math.max(cursor, untilSeq))
redis.call('HSET', KEYS[5], 'replayCount', redis.call('LLEN', KEYS[6]), 'representedCount', redis.call('HLEN', KEYS[7]))
if referencesClean and turn.referenceVersion == 2 then redis.call('HSET', KEYS[5], 'referenceCleanCount', redis.call('LLEN', KEYS[6])) end
redis.call('HSET', KEYS[8], ARGV[4], '1')
${EXPIRE}
return cjson.encode({cursor=math.max(cursor, untilSeq), concurrentMerge=cursor~=tonumber(ARGV[9])})`

const RESET = `${CLOCK}
if now >= tonumber(ARGV[2]) then return cjson.encode({error='expired_scope'}) end
redis.call('SET', KEYS[1], ARGV[1]); redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3]))
return cjson.encode({resetId=ARGV[1]})`

const LOOKUP = `${GUARD}
return cjson.encode({seq=tonumber(redis.call('HGET', KEYS[4], ARGV[4])), latest=tonumber(redis.call('GET', KEYS[2]) or '0')})`

const HEADER = `${GUARD}
return cjson.encode({header=redis.call('HGET', KEYS[2], 'header') or false})`

export class ContextStoreError extends Error {
  constructor(code) { super(`PromptCacheV2: ${code}`); this.code = code }
}

export class ContextStore {
  constructor(client = null, prefix = 'ytbot:ctx:v2:') {
    this.client = client
    this.prefix = prefix
  }

  async evaluate(script, keys, args) {
    const client = this.client || globalThis.redis
    if (!client?.eval) throw new ContextStoreError('redis_unavailable')
    const result = JSON.parse(await client.eval(script, { keys, arguments: args.map(String) }))
    if (result.error) throw new ContextStoreError(result.error)
    return result
  }

  async scope(botId, groupId, now = Date.now()) {
    const day = beijingDay(now)
    const root = `${this.prefix}{${encodeURIComponent(botId)}:${encodeURIComponent(groupId)}:${day.dayKey}}:`
    const result = await this.evaluate(INITIALIZE, [`${root}active`], [randomUUID(), day.deadline, day.expiresAt])
    return { ...day, root, resetId: result.resetId, botId: String(botId), groupId: String(groupId) }
  }

  keys(scope) {
    const root = `${scope.root}r:${scope.resetId}:`
    return [`${scope.root}active`, `${root}seq`, `${root}raw`, `${root}event_index`, `${root}meta`, `${root}replay`, `${root}represented`, `${root}committed_turns`]
  }

  args(scope) { return [scope.resetId, scope.deadline, scope.expiresAt] }

  async lookup(scope, eventId) {
    return this.evaluate(LOOKUP, this.keys(scope).slice(0, 4), [...this.args(scope), eventId])
  }

  async header(scope) {
    const keys = this.keys(scope)
    const result = await this.evaluate(HEADER, [keys[0], keys[4]], this.args(scope))
    return result.header ? JSON.parse(result.header) : null
  }

  async record(scope, event, settings = {}) {
    const row = replayEventRow(event, scope.botId)
    const value = { ...event, tokens: row ? tokenEstimate(row) : 0 }
    return this.evaluate(RECORD, this.keys(scope).slice(0, 5), [
      ...this.args(scope), event.eventId, JSON.stringify(value), value.tokens,
      settings.rawMaxEvents || 20000, settings.rawMaxBytes || 33554432
    ])
  }

  async read(scope, header, settings, incomingTokens = 0, currentOrigin = '') {
    await this.cleanHistoricalReferences(scope)
    const result = await this.evaluate(READ, this.keys(scope).slice(0, 7), [
      ...this.args(scope), JSON.stringify(header), settings.highWater, settings.lowWater,
      incomingTokens + settings.reserveTokens, currentOrigin, header.reliable === false ? '0' : '1'
    ])
    // Redis cjson encodes an empty Lua array as {}, not [].
    result.events = Array.isArray(result.events)
      ? result.events.map(event => ({ ...JSON.parse(event.payload), seq: event.seq, represented: event.represented })) : []
    result.blocks = Array.isArray(result.blocks) ? result.blocks.map(block => JSON.parse(block)) : []
    result.header = JSON.parse(result.header)
    return result
  }

  async cleanHistoricalReferences(scope) {
    // One-time legacy format migration, before capacity accounting can trim inflated blocks.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.evaluate(REFERENCE_HISTORY, this.keys(scope).slice(0, 6), this.args(scope))
      if (!Array.isArray(snapshot.blocks)) return
      const blocks = snapshot.blocks.map(before => {
        const block = JSON.parse(before)
        const cleaned = stripHistoricalTurnReferences(block)
        if (cleaned !== block) cleaned.tokens = Math.max(tokenEstimate(cleaned.toolRows), tokenEstimate(cleaned.chatRows))
        return { before, after: cleaned === block ? before : JSON.stringify(cleaned) }
      })
      const result = await this.evaluate(CLEAN_REFERENCES, this.keys(scope).slice(0, 6), [...this.args(scope), JSON.stringify(blocks)])
      if (!result.retry) return
    }
    throw new ContextStoreError('reference_migration_conflict')
  }

  async commit(scope, { turnId, readUntil, baseCursor, observers, block, represented = [] }) {
    validateToolRows(block.toolRows)
    return this.evaluate(COMMIT, this.keys(scope), [
      ...this.args(scope), turnId, readUntil,
      JSON.stringify(observers.map(observer => ({ eventId: observer.eventId, blockJson: JSON.stringify(observer.block) }))),
      JSON.stringify(block), JSON.stringify(represented), baseCursor
    ])
  }

  async reset(botId, groupId) {
    const day = beijingDay()
    const root = `${this.prefix}{${encodeURIComponent(botId)}:${encodeURIComponent(groupId)}:${day.dayKey}}:`
    return this.evaluate(RESET, [`${root}active`], [randomUUID(), day.deadline, day.expiresAt])
  }
}

export function validateToolRows(rows = []) {
  let pending = new Set()
  for (const row of rows) {
    if (row.role === 'tool') {
      if (!pending.delete(row.tool_call_id)) throw new ContextStoreError('unpaired_tool_result')
    } else {
      if (pending.size) throw new ContextStoreError('unfinished_tool_calls')
      if (row.tool_calls?.length) {
        const ids = row.tool_calls.map(call => call.id)
        if (ids.some(id => !id) || new Set(ids).size !== ids.length) throw new ContextStoreError('invalid_tool_call_ids')
        pending = new Set(ids)
      }
    }
  }
  if (pending.size) throw new ContextStoreError('unfinished_tool_calls')
}

export const contextStore = new ContextStore()
