import { randomUUID } from 'node:crypto'
import { beijingDay, tokenEstimate, replayEventRow } from './promptCache.js'
import { stripHistoricalTurnReferences } from './prompts.js'
import { ContextStoreError, nativeReplayRows, replayFormat, replayRows, REPLAY_RENDERER_VERSION } from './replayAdapters.js'
import { contextNoteBlock } from './contextNotes.js'
export { ContextStoreError, validateToolRows } from './replayAdapters.js'

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
if tonumber(redis.call('HGET', KEYS[5], ARGV[4] or 'referenceCleanCount') or '-1') == count then return cjson.encode({blocks={}}) end
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
redis.call('HSET', KEYS[5], ARGV[5] or 'referenceCleanCount', #blocks)
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
local headerKey = ARGV[10]
local header = redis.call('HGET', KEYS[5], headerKey)
local candidate = ARGV[4]
local changed = false
if not header or (ARGV[9] == '1' and cjson.decode(header).version ~= cjson.decode(candidate).version) then
  changed = header ~= false and header ~= nil
  header = candidate
  redis.call('HSET', KEYS[5], headerKey, header)
end
local previousMode = redis.call('HGET', KEYS[5], 'lastMode')
redis.call('HSET', KEYS[5], 'lastMode', ARGV[11])
local blocks = redis.call('LRANGE', KEYS[6], 0, -1)
local hasAgent = false
local total = incoming
local function blockCost(encoded)
  local block = cjson.decode(encoded)
  return ARGV[11] == 'agent' and math.max(block.tokens or 0, block.agentTokens or 0) or (block.tokens or 0)
end
for _, block in ipairs(blocks) do
  local decoded = cjson.decode(block)
  if decoded.replayVersion == 3 then
    hasAgent = true
    if decoded.mode ~= 'agent' or type(decoded.apiRows) ~= 'table' then return cjson.encode({error='unsupported_replay_format'}) end
  elseif (decoded.replayVersion ~= nil and decoded.replayVersion ~= 2) or
      (decoded.mode ~= nil and decoded.mode ~= 'dual') or type(decoded.toolRows) ~= 'table' or type(decoded.chatRows) ~= 'table' then
    return cjson.encode({error='unsupported_replay_format'})
  end
  total = total + blockCost(block)
end
local previousRenderer = redis.call('HGET', KEYS[5], 'dualRendererVersion')
local projectionChanged = hasAgent and ARGV[11] == 'dual' and previousRenderer and previousRenderer ~= ARGV[12] or false
if hasAgent and ARGV[11] == 'dual' then redis.call('HSET', KEYS[5], 'dualRendererVersion', ARGV[12]) end
local dropped = 0
if total > tonumber(ARGV[5]) then
  local target = math.max(tonumber(ARGV[6]), incoming)
  while dropped < #blocks and total > target do
    dropped = dropped + 1
    total = total - blockCost(blocks[dropped])
  end
  while dropped < #blocks and dropped > 0 do
    local decoded = cjson.decode(blocks[dropped+1])
    local first = (decoded.apiRows or decoded.toolRows)[1]
    if first and first.role == 'user' then break end
    dropped = dropped + 1
    total = total - blockCost(blocks[dropped])
  end
  if dropped > 0 then redis.call('LTRIM', KEYS[6], dropped, -1) end
  redis.call('HSET', KEYS[5], 'replayCount', redis.call('LLEN', KEYS[6]))
  local cleanCount = tonumber(redis.call('HGET', KEYS[5], 'referenceCleanCount') or '-1')
  redis.call('HSET', KEYS[5], 'referenceCleanCount', cleanCount == #blocks and (#blocks-dropped) or -1)
  local budgetCount = tonumber(redis.call('HGET', KEYS[5], 'agentBudgetCount') or '-1')
  redis.call('HSET', KEYS[5], 'agentBudgetCount', budgetCount == #blocks and (#blocks-dropped) or -1)
end
local kept = {}
for index=dropped+1,#blocks do table.insert(kept, blocks[index]) end
local noteState = redis.call('HGET', KEYS[5], 'contextNoteState') or '{}'
local hasMembers = false
for key, _ in pairs(cjson.decode(noteState)) do if string.sub(key, 1, 7) == 'member:' then hasMembers = true; break end end
local identityEvents = {}
if not hasMembers then
  for _, encoded in ipairs(redis.call('ZRANGE', KEYS[3], -2000, -1)) do
    local event = cjson.decode(encoded)
    local payload = cjson.decode(event.payload)
    table.insert(identityEvents, {seq=event.seq, message={sender=payload.message and payload.message.sender}})
  end
end
local noteClock = redis.call('HINCRBY', KEYS[5], 'contextNoteClock', 1)
${EXPIRE}
return cjson.encode({cursor=cursor, readUntil=untilSeq, events=decodedEvents, blocks=kept,
  header=header, headerChanged=changed, modeChanged=previousMode and previousMode~=ARGV[11] or false,
  firstModeUse=not previousMode, projectionChanged=projectionChanged, dropped=dropped, estimatedTokens=total,
  rawCount=redis.call('ZCARD', KEYS[3]), rawBytes=tonumber(redis.call('HGET', KEYS[5], 'rawBytes') or '0'),
  noteState=noteState, noteClock=noteClock, identityEvents=identityEvents})`

const COMMIT = `${GUARD}
if redis.call('HEXISTS', KEYS[8], ARGV[4]) == 1 then return cjson.encode({duplicate=true}) end
local cursor = tonumber(redis.call('HGET', KEYS[5], 'cursor') or '0')
local untilSeq = tonumber(ARGV[5])
if untilSeq > tonumber(redis.call('GET', KEYS[2]) or '0') then return cjson.encode({error='source_gap'}) end
local candidates = cjson.decode(ARGV[6])
local turn = cjson.decode(ARGV[7])
local replayCount = redis.call('LLEN', KEYS[6])
local referencesClean = tonumber(redis.call('HGET', KEYS[5], 'referenceCleanCount') or '-1') == replayCount
local budgetsKnown = tonumber(redis.call('HGET', KEYS[5], 'agentBudgetCount') or '-1') == replayCount
local state = cjson.decode(redis.call('HGET', KEYS[5], 'contextNoteState') or '{}')
local acknowledgments = cjson.decode(ARGV[11] or '[]')
local conflicts = {}
for _, ack in ipairs(acknowledgments) do
  local previous = state[ack[1]] and cjson.decode(state[ack[1]])
  if not previous or (previous.version <= ack[3] and previous.version ~= ack[2]) then table.insert(conflicts, ack[1]) end
end
-- An unchanged value may have raced an earlier turn's change. Ask the caller
-- to materialize only those conflicted entries before any state is written.
if #conflicts > 0 then return cjson.encode({noteConflicts=conflicts}) end
for _, ack in ipairs(acknowledgments) do
  local previous = cjson.decode(state[ack[1]])
  if previous.version < ack[3] then previous.version = ack[3]; state[ack[1]] = cjson.encode(previous) end
end
local visible = {}
local notes = cjson.decode(ARGV[10] or '[]')
if #notes > 0 then
  for _, encoded in ipairs(redis.call('LRANGE', KEYS[6], 0, -1)) do
    for _, entry in ipairs(cjson.decode(encoded).contextNotes or {}) do
      if not visible[entry.key] or entry.version >= visible[entry.key].version then visible[entry.key] = entry end
    end
  end
end
for _, candidate in ipairs(notes) do
  local entry = cjson.decode(candidate.entryJson)
  local previous = state[entry.key] and cjson.decode(state[entry.key])
  if not previous or entry.version >= previous.version then
    if not entry.retired and (not visible[entry.key] or visible[entry.key].valueJson ~= entry.valueJson) then
      redis.call('RPUSH', KEYS[6], candidate.blockJson)
      redis.call('HSET', KEYS[7], candidate.eventId, '1')
      visible[entry.key] = entry
    end
    state[entry.key] = candidate.entryJson
  end
end
redis.call('HSET', KEYS[5], 'contextNoteState', cjson.encode(state))
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
if budgetsKnown and turn.mode == 'agent' then redis.call('HSET', KEYS[5], 'agentBudgetCount', redis.call('LLEN', KEYS[6])) end
redis.call('HSET', KEYS[8], ARGV[4], '1')
${EXPIRE}
return cjson.encode({cursor=math.max(cursor, untilSeq), concurrentMerge=cursor~=tonumber(ARGV[9])})`

// Compression is the only operation allowed to rewrite the note prefix. Keep
// every conversation/tool block verbatim and CAS the entire captured replay.
const COMPACT_NOTES = `${GUARD}
local before = cjson.decode(ARGV[4]); local after = cjson.decode(ARGV[5])
if redis.call('HGET', KEYS[5], 'contextNoteState') ~= ARGV[6] or redis.call('LLEN', KEYS[6]) ~= #before then return cjson.encode({retry=true}) end
for index, encoded in ipairs(before) do
  if redis.call('LINDEX', KEYS[6], index-1) ~= encoded then return cjson.encode({retry=true}) end
end
redis.call('DEL', KEYS[6])
for _, encoded in ipairs(after) do redis.call('RPUSH', KEYS[6], encoded) end
redis.call('HSET', KEYS[5], 'replayCount', #after, 'referenceCleanCount', '-1', 'agentBudgetCount', '-1')
${EXPIRE}
return cjson.encode({compacted=true})`

const RESET = `${CLOCK}
if now >= tonumber(ARGV[2]) then return cjson.encode({error='expired_scope'}) end
redis.call('SET', KEYS[1], ARGV[1]); redis.call('EXPIREAT', KEYS[1], tonumber(ARGV[3]))
return cjson.encode({resetId=ARGV[1]})`

const LOOKUP = `${GUARD}
return cjson.encode({seq=tonumber(redis.call('HGET', KEYS[4], ARGV[4])), latest=tonumber(redis.call('GET', KEYS[2]) or '0')})`

const HEADER = `${GUARD}
return cjson.encode({header=redis.call('HGET', KEYS[2], ARGV[4]) or false})`

const HASH_MAP = `local function hashMap(key)
  local values = redis.call('HGETALL', key); local result = {}
  for index=1,#values,2 do result[values[index]]=values[index+1] end
  return result
end`

const EXPORT_SNAPSHOT = `${GUARD}
${HASH_MAP}
return cjson.encode({blocks=redis.call('LRANGE', KEYS[6], 0, -1), meta=hashMap(KEYS[5]),
  represented=hashMap(KEYS[7]), committed=hashMap(KEYS[8])})`

const REPLACE_REPLAY = `${GUARD}
${HASH_MAP}
local payload = cjson.decode(ARGV[4])
local before = payload.before; local after = payload.after
local function matches(key, expected)
  local count = 0
  for field, value in pairs(expected) do
    count = count+1
    if redis.call('HGET', key, field) ~= value then return false end
  end
  return redis.call('HLEN', key) == count
end
if redis.call('LLEN', KEYS[6]) ~= #before.blocks or #after.blocks ~= #before.blocks or
    not matches(KEYS[5], before.meta) or not matches(KEYS[7], before.represented) or not matches(KEYS[8], before.committed) then
  return cjson.encode({error='rollback_conflict'})
end
for index, encoded in ipairs(before.blocks) do
  if redis.call('LINDEX', KEYS[6], index-1) ~= encoded then return cjson.encode({error='rollback_conflict'}) end
end
for index, encoded in ipairs(after.blocks) do redis.call('LSET', KEYS[6], index-1, encoded) end
for field, _ in pairs(before.meta) do if after.meta[field] == nil then redis.call('HDEL', KEYS[5], field) end end
for field, value in pairs(after.meta) do redis.call('HSET', KEYS[5], field, value) end
${EXPIRE}
return cjson.encode({replaced=#after.blocks})`

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

  async header(scope, mode = 'dual') {
    const keys = this.keys(scope)
    const result = await this.evaluate(HEADER, [keys[0], keys[4]], [...this.args(scope), mode === 'agent' ? 'agentHeader' : 'header'])
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

  async read(scope, header, settings, incomingTokens = 0, currentOrigin = '', compactAttempt = 0) {
    await this.cleanHistoricalReferences(scope)
    if (header.mode === 'agent') await this.prepareAgentBudgets(scope)
    const result = await this.evaluate(READ, this.keys(scope).slice(0, 7), [
      ...this.args(scope), JSON.stringify(header), settings.highWater, settings.lowWater,
      incomingTokens + settings.reserveTokens, currentOrigin, header.reliable === false ? '0' : '1',
      header.mode === 'agent' ? 'agentHeader' : 'header', header.mode === 'agent' ? 'agent' : 'dual', header.rendererVersion || REPLAY_RENDERER_VERSION
    ])
    // Redis cjson encodes an empty Lua array as {}, not [].
    result.events = Array.isArray(result.events)
      ? result.events.map(event => ({ ...JSON.parse(event.payload), seq: event.seq, represented: event.represented })) : []
    const encodedBlocks = Array.isArray(result.blocks) ? result.blocks : []
    result.blocks = encodedBlocks.map(block => JSON.parse(block))
    result.blocks.forEach(nativeReplayRows)
    result.header = JSON.parse(result.header)
    const encodedState = result.noteState
    result.noteState = Object.fromEntries(Object.entries(JSON.parse(encodedState)).map(([key, value]) => [key, JSON.parse(value)]))
    result.identityEvents = Array.isArray(result.identityEvents) && result.identityEvents.length ? result.identityEvents : result.events
    const notes = result.blocks.filter(block => block.contextNotes)
    const deltaNotes = notes.filter(block => !block.contextBaseline)
    const compact = deltaNotes.length >= (settings.noteCompactChanges || 32) ||
      deltaNotes.reduce((sum, block) => sum + block.tokens, 0) >= (settings.noteCompactTokens || 2048)
    if (compact && notes.length > 1 && compactAttempt < 3) {
      const baseline = contextNoteBlock(Object.values(result.noteState).filter(entry => !entry.retired && entry.valueJson !== 'null').sort((a, b) => a.key.localeCompare(b.key)), { baseline: true })
      // A baseline must be trimmed last, after old conversation blocks. Putting
      // it at index zero causes capacity -> restore -> recompress oscillation.
      // Readers arbitrate facts by version, so physical position is immaterial.
      const after = [...encodedBlocks.filter((_, index) => !result.blocks[index].contextNotes), JSON.stringify(baseline)]
      const compressed = await this.evaluate(COMPACT_NOTES, this.keys(scope).slice(0, 7),
        [...this.args(scope), JSON.stringify(encodedBlocks), JSON.stringify(after), encodedState])
      const refreshed = await this.read(scope, header, settings, incomingTokens, currentOrigin, compactAttempt + 1)
      return { ...refreshed, headerChanged: result.headerChanged || refreshed.headerChanged,
        modeChanged: result.modeChanged || refreshed.modeChanged, projectionChanged: result.projectionChanged || refreshed.projectionChanged,
        firstModeUse: result.firstModeUse || refreshed.firstModeUse, dropped: result.dropped + refreshed.dropped,
        notesCompacted: compressed.compacted || refreshed.notesCompacted || false }
    }
    return result
  }

  async prepareAgentBudgets(scope) {
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.evaluate(REFERENCE_HISTORY, this.keys(scope).slice(0, 6), [...this.args(scope), 'agentBudgetCount'])
      if (!Array.isArray(snapshot.blocks)) return
      const blocks = snapshot.blocks.map(before => {
        const block = JSON.parse(before)
        const estimate = tokenEstimate(replayRows(block, 'agent'))
        return { before, after: block.agentTokens === estimate ? before : JSON.stringify({ ...block, agentTokens: estimate }) }
      })
      const result = await this.evaluate(CLEAN_REFERENCES, this.keys(scope).slice(0, 6), [...this.args(scope), JSON.stringify(blocks), 'agentBudgetCount'])
      if (!result.retry) return
    }
    throw new ContextStoreError('budget_migration_conflict')
  }

  async cleanHistoricalReferences(scope) {
    // One-time legacy format migration, before capacity accounting can trim inflated blocks.
    for (let attempt = 0; attempt < 3; attempt++) {
      const snapshot = await this.evaluate(REFERENCE_HISTORY, this.keys(scope).slice(0, 6), this.args(scope))
      if (!Array.isArray(snapshot.blocks)) return
      const blocks = snapshot.blocks.map(before => {
        const block = JSON.parse(before)
        replayFormat(block)
        const cleaned = stripHistoricalTurnReferences(block)
        if (cleaned !== block) cleaned.tokens = Math.max(tokenEstimate(cleaned.toolRows), tokenEstimate(cleaned.chatRows))
        return { before, after: cleaned === block ? before : JSON.stringify(cleaned) }
      })
      const result = await this.evaluate(CLEAN_REFERENCES, this.keys(scope).slice(0, 6), [...this.args(scope), JSON.stringify(blocks)])
      if (!result.retry) return
    }
    throw new ContextStoreError('reference_migration_conflict')
  }

  async commit(scope, { turnId, readUntil, baseCursor, observers, block, represented = [], notes = [], unchangedNotes = [] }) {
    nativeReplayRows(block)
    observers.forEach(observer => nativeReplayRows(observer.block))
    notes.forEach(note => nativeReplayRows(note.block))
    const candidates = [...notes]
    let pending = [...unchangedNotes]
    const prefix = [...this.args(scope), turnId, readUntil,
      JSON.stringify(observers.map(observer => ({ eventId: observer.eventId, blockJson: JSON.stringify(observer.block) }))),
      JSON.stringify(block), JSON.stringify(represented), baseCursor]
    for (;;) {
      const result = await this.evaluate(COMMIT, this.keys(scope), [...prefix,
        JSON.stringify(candidates.map(note => ({ eventId: note.eventId, entryJson: JSON.stringify(note.entry), blockJson: JSON.stringify(note.block) }))),
        JSON.stringify(pending.map(note => [note.entry.key, note.baseVersion, note.entry.version]))
      ])
      if (!result.noteConflicts?.length) return result
      const conflicts = new Set(result.noteConflicts)
      for (const { entry } of pending.filter(note => conflicts.has(note.entry.key))) candidates.push({
        eventId: `note:${entry.version}:${entry.key}`, entry, block: contextNoteBlock([entry])
      })
      // Every retry removes at least one acknowledgment, so progress is bounded
      // by the captured facts even under concurrent commits.
      pending = pending.filter(note => !conflicts.has(note.entry.key))
    }
  }

  async exportSnapshot(scope) {
    const snapshot = await this.evaluate(EXPORT_SNAPSHOT, this.keys(scope), this.args(scope))
    snapshot.blocks = Array.isArray(snapshot.blocks) ? snapshot.blocks : []
    snapshot.blocks.forEach(encoded => nativeReplayRows(JSON.parse(encoded)))
    return snapshot
  }

  async replaceReplay(scope, before, after) {
    after.blocks.forEach(encoded => nativeReplayRows(JSON.parse(encoded)))
    return this.evaluate(REPLACE_REPLAY, this.keys(scope), [...this.args(scope), JSON.stringify({ before, after })])
  }

  async reset(botId, groupId) {
    const day = beijingDay()
    const root = `${this.prefix}{${encodeURIComponent(botId)}:${encodeURIComponent(groupId)}:${day.dayKey}}:`
    return this.evaluate(RESET, [`${root}active`], [randomUUID(), day.deadline, day.expiresAt])
  }
}

export const contextStore = new ContextStore()
