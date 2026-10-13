import { createHash, randomUUID } from 'node:crypto'
import { MemorySourceStore } from './MemorySourceStore.js'
import { memoryScope, FACT_KINDS, FACT_SLOTS, EVENT_LIFECYCLES } from './sourceSchema.js'

export const memoryHash = value => createHash('sha256').update(JSON.stringify(value, (_key, item) => item && typeof item === 'object' && !Array.isArray(item)
  ? Object.fromEntries(Object.entries(item).sort(([a], [b]) => a.localeCompare(b))) : item)).digest('hex')
const BUCKETS = ['facts', 'events', 'evidence', 'review', 'revisions', 'tombstones', 'batches']
const GUARD = `
for i, key in ipairs(KEYS) do
  local kind = redis.call('TYPE', key).ok
  local expected = i == 9 and 'zset' or i == 10 and 'string' or i == 11 and 'zset' or 'hash'
  if kind ~= 'none' and kind ~= expected then return cjson.encode({error='memory_key_type'}) end
end
if redis.call('HEXISTS', KEYS[1], 'writePending') == 1 then return cjson.encode({error='memory_incomplete_write'}) end`

const SNAPSHOT = `${GUARD}
local result = {}
for i=1,8 do
  local bucket = {}
  if ARGV[1] == 'recall' and i == 1 then
    for _, field in ipairs({'memoryRevision', 'disabledSubjects', 'epoch'}) do bucket[field]=redis.call('HGET', KEYS[i], field) or nil end
  elseif (ARGV[1] ~= 'recall' or i<=3) and (ARGV[1] ~= 'planning' or i<8) then
    local values = redis.call('HGETALL', KEYS[i])
    for n=1,#values,2 do bucket[values[n]]=values[n+1] end
  end
  table.insert(result, bucket)
end
return cjson.encode({buckets=result})`

const COMMIT = `${GUARD}
local plan = cjson.decode(ARGV[1])
local revision = tonumber(redis.call('HGET', KEYS[1], 'memoryRevision') or '0')
local epoch = tonumber(redis.call('HGET', KEYS[1], 'epoch') or '0')
local cursor = tonumber(redis.call('HGET', KEYS[1], 'extractedThrough') or '0')
if not revision or not epoch or not cursor or revision % 1 ~= 0 or epoch % 1 ~= 0 or cursor % 1 ~= 0 then return cjson.encode({error='memory_meta_invalid'}) end
local existing = redis.call('HGET', KEYS[8], plan.id)
if existing then return cjson.encode({duplicate=true, batch=existing}) end
if revision ~= plan.revision or epoch ~= plan.epoch then return cjson.encode({error='memory_conflict'}) end
if plan.token ~= cjson.null and (redis.call('HGET', KEYS[1], 'workerToken') or '') ~= plan.token then return cjson.encode({error='memory_stale_worker'}) end
if plan.from ~= cjson.null then
  if plan.from ~= cursor+1 or plan.to < plan.from or plan.to > tonumber(redis.call('GET', KEYS[10]) or '0') then return cjson.encode({error='memory_cursor_conflict'}) end
  local rows = redis.call('ZRANGEBYSCORE', KEYS[11], plan.from, plan.to)
  if #rows ~= #plan.sourceRows then return cjson.encode({error='memory_source_changed'}) end
  for i, row in ipairs(rows) do if row ~= plan.sourceRows[i] then return cjson.encode({error='memory_source_changed'}) end end
  local byteText = redis.call('HGET', KEYS[1], 'sourcePendingBytes') or redis.call('HGET', KEYS[1], 'pendingBytes') or '0'
  local remaining = tonumber(byteText)
  if not remaining or byteText ~= string.format('%.0f', remaining) then return cjson.encode({error='memory_source_gap'}) end
  for _, row in ipairs(rows) do remaining=remaining-string.len(row) end
  if remaining < 0 then return cjson.encode({error='memory_source_gap'}) end
  plan.remainingBytes=remaining
  local batches=tonumber(redis.call('HGET', KEYS[1], 'committedBatchCount') or '0')
  if not batches or batches % 1 ~= 0 then return cjson.encode({error='memory_meta_invalid'}) end
  plan.batchCount=batches+1
end
for _, change in ipairs(plan.changes) do
  if change.bucket < 2 or change.bucket > 7 or type(change.id) ~= 'string' then return cjson.encode({error='memory_plan_invalid'}) end
  if change.value ~= cjson.null then local ok = pcall(cjson.decode, change.value); if not ok then return cjson.encode({error='memory_plan_invalid'}) end end
end
for _, entry in ipairs(plan.timeline) do
  if type(entry.id) ~= 'string' or (entry.score ~= cjson.null and type(entry.score) ~= 'number') then return cjson.encode({error='memory_plan_invalid'}) end
end
for key, value in pairs(plan.control or {}) do
  if key ~= 'disabledSubjects' and key ~= 'suppressedSubjects' and key ~= 'suppressedThrough' then return cjson.encode({error='memory_plan_invalid'}) end
  if type(value) ~= 'string' then return cjson.encode({error='memory_plan_invalid'}) end
end
-- 运行时异常不回滚：保留 writePending，后续读/写/回收均拒绝，等待检查修复。
redis.call('HSET', KEYS[1], 'writePending', plan.id)
for _, change in ipairs(plan.changes) do
  if change.value == cjson.null then redis.call('HDEL', KEYS[change.bucket], change.id)
  else redis.call('HSET', KEYS[change.bucket], change.id, change.value) end
end
for _, entry in ipairs(plan.timeline) do
  if entry.score == cjson.null then redis.call('ZREM', KEYS[9], entry.id)
  else redis.call('ZADD', KEYS[9], entry.score, entry.id) end
end
redis.call('HSET', KEYS[1], 'memoryRevision', revision+1, 'epoch', plan.nextEpoch)
for key, value in pairs(plan.control or {}) do redis.call('HSET', KEYS[1], key, value) end
if plan.from ~= cjson.null then
  redis.call('HSET', KEYS[1], 'extractedThrough', plan.to, 'contextTail', plan.contextTail, 'sourcePendingBytes', plan.remainingBytes)
  redis.call('HSET', KEYS[1], 'committedBatchCount', plan.batchCount)
  local nextRows=redis.call('ZRANGEBYSCORE', KEYS[11], '(' .. plan.to, '+inf', 'LIMIT', 0, 1)
  local oldest=#nextRows > 0 and (cjson.decode(nextRows[1]).capturedAt or redis.call('HGET', KEYS[1], 'oldestPendingAt')) or 0
  redis.call('HSET', KEYS[1], 'oldestPendingAt', oldest or 0)
end
redis.call('HSET', KEYS[8], plan.id, plan.receipt)
redis.call('HDEL', KEYS[1], 'writePending')
return cjson.encode({duplicate=false, batch=plan.receipt})`

const CLAIM = `${GUARD}
redis.call('HSET', KEYS[1], 'workerToken', ARGV[1])
return cjson.encode({token=ARGV[1]})`

const GC = `${GUARD}
local committed = tonumber(redis.call('HGET', KEYS[1], 'extractedThrough') or '0')
local previous = tonumber(redis.call('HGET', KEYS[1], 'sourceReclaimedThrough') or '0')
local target = math.min(committed-tonumber(ARGV[2]), tonumber(ARGV[1]))
if target <= previous then return cjson.encode({removed=0, through=previous, done=true}) end
if not redis.call('HGET', KEYS[1], 'contextTail') then return cjson.encode({error='memory_context_missing'}) end
local rows = redis.call('ZRANGEBYSCORE', KEYS[11], '(' .. previous, target, 'LIMIT', 0, 64)
local freed = 0; local through = previous
for _, row in ipairs(rows) do
  local event = cjson.decode(row)
  if event.memorySeq ~= through+1 then return cjson.encode({error='memory_source_gap'}) end
  through = event.memorySeq; freed = freed+string.len(row)
end
if #rows == 0 then return cjson.encode({error='memory_source_gap'}) end
local byteText = redis.call('HGET', KEYS[1], 'pendingBytes') or '0'
local bytes = tonumber(byteText)
if not bytes or byteText ~= string.format('%.0f', bytes) or bytes < freed then return cjson.encode({error='memory_source_gap'}) end
redis.call('HSET', KEYS[1], 'writePending', 'gc:' .. through)
redis.call('ZREMRANGEBYSCORE', KEYS[11], '-inf', through)
redis.call('HSET', KEYS[1], 'sourceReclaimedThrough', through, 'pendingBytes', bytes-freed)
redis.call('HDEL', KEYS[1], 'writePending')
return cjson.encode({removed=#rows, through=through, done=through>=target})`

const clone = value => JSON.parse(JSON.stringify(value))
const unique = values => [...new Set(values)]
const text = (value, max = 1000) => typeof value === 'string' && value.trim() && value.length <= max
const identity = item => memoryHash([item.type, item.subjectId || '', item.slot || '', item.type === 'event' ? item.title : '', FACT_SLOTS[item.slot] === 'multiple' ? item.value : null])

export class MemoryStoreV3 {
  constructor(client = null) { this.sources = new MemorySourceStore(client) }
  scope(botId, groupId) { return memoryScope(botId, groupId) }
  keys(scope) {
    const root = this.scope(scope.botId, scope.groupId).root
    return ['meta', ...BUCKETS, 'events:timeline', 'source:seq', 'source:pending'].map(key => root + key)
  }

  async snapshot(scope, { mode = 'full' } = {}) {
    const { buckets } = await this.sources.evaluate(SNAPSHOT, this.keys(scope), [mode])
    const result = { meta: buckets[0] }
    BUCKETS.forEach((name, index) => { result[name] = Object.fromEntries(Object.entries(buckets[index + 1]).map(([id, value]) => [id, JSON.parse(value)])) })
    return result
  }

  claimWorker(scope, token = randomUUID()) { return this.sources.evaluate(CLAIM, this.keys(scope), [token]) }

  async sourceRows(scope, from, to) {
    const page = await this.sources.readSourceRange(scope, { after: from - 1, until: to })
    if (page.rows.length !== to - from + 1) throw new Error('memory_batch_limit')
    // 使用 Redis 原编码做提交 CAS，不依赖 cjson 重排后的 JSON 字节。
    const raw = await this.sources.evaluate(`return cjson.encode({rows=redis.call('ZRANGEBYSCORE', KEYS[1], ARGV[1], ARGV[2], 'LIMIT', 0, 64)})`, [this.keys(scope)[10]], [from, to])
    return { rows: page.rows, encoded: Array.isArray(raw.rows) ? raw.rows : [] }
  }

  validateCandidate(candidate, rows, from, to) {
    if (!candidate || !['fact', 'event'].includes(candidate.type) || !text(candidate.text) || !Array.isArray(candidate.evidence) || !candidate.evidence.length) throw new Error('candidate_schema')
    const byId = new Map(rows.map(row => [row.eventId, row]))
    const support = candidate.evidence.map(ref => {
      const row = byId.get(ref.eventId)
      if (!row || !text(ref.quote, 4000) || !row.text.includes(ref.quote) || row.sourceKind === 'bot_message') throw new Error('candidate_evidence')
      return { ref, row }
    })
    if (!support.some(({ row }) => row.memorySeq >= from && row.memorySeq <= to)) throw new Error('candidate_context_only')
    if (candidate.type === 'fact' && (!text(candidate.subjectId, 64) || !text(candidate.slot, 100) || !FACT_KINDS.includes(candidate.kind) || candidate.value === undefined)) throw new Error('candidate_fact')
    if (candidate.type === 'fact' && candidate.slot === 'birthday') {
      const value = candidate.value
      if (!value || typeof value !== 'object' || !['solar', 'lunar', 'unknown'].includes(value.calendar) ||
          value.month != null && (!Number.isInteger(value.month) || value.month < 1 || value.month > 12) ||
          value.day != null && (!Number.isInteger(value.day) || value.day < 1 || value.day > (value.calendar === 'lunar' ? 30 : 31)) ||
          value.year != null && (!Number.isInteger(value.year) || value.year < 1 || value.year > 9999)) throw new Error('candidate_birthday')
      if (value.calendar === 'solar' && value.month && value.day > new Date(Date.UTC(value.year || 2000, value.month, 0)).getUTCDate()) throw new Error('candidate_birthday')
    }
    if (candidate.type === 'event' && (!text(candidate.title, 200) || !Array.isArray(candidate.participants) || !EVENT_LIFECYCLES.includes(candidate.lifecycle))) throw new Error('candidate_event')
    if (candidate.type === 'event' && candidate.time && !['day', 'month', 'year', 'range', 'unknown'].includes(candidate.time.precision)) throw new Error('candidate_time')
    for (const value of candidate.type === 'event' ? [candidate.time?.start, candidate.time?.end].filter(Boolean) : []) {
      if (!/^\d{4}(-\d{2})?(-\d{2})?$/.test(value)) throw new Error('candidate_time')
      const date = value.length === 4 ? `${value}-01-01` : value.length === 7 ? `${value}-01` : value
      const parsed = new Date(date + 'T00:00:00Z')
      if (!Number.isFinite(parsed.getTime()) || parsed.toISOString().slice(0, 10) !== date) throw new Error('candidate_time')
    }
    if (candidate.type === 'event' && candidate.time?.end && (!candidate.time.start || candidate.time.end < candidate.time.start)) throw new Error('candidate_time')
    return support
  }

  async planBatch(scope, { from, to, candidates = [], token = null, extractorVersion = 'v3.1', audit = null }) {
    if (!Number.isSafeInteger(from) || !Number.isSafeInteger(to) || from < 1 || to < from || to - from >= 64 || !Array.isArray(candidates) || candidates.length > 100) throw new Error('memory_batch_invalid')
    const before = await this.snapshot(scope, { mode: 'planning' })
    const input = await this.sourceRows(scope, from, to)
    const context = JSON.parse(before.meta.contextTail || '[]')
    const allRows = [...context.filter(row => row.memorySeq < from), ...input.rows]
    const batchId = 'batch_' + memoryHash([scope.botId, scope.groupId, from, to, input.encoded, extractorVersion])
    const after = clone(before)
    const counts = { accepted: 0, review: 0, rejected: 0 }
    const rejected = []
    for (const raw of candidates) {
      if (raw?.rejectedReason) { counts.rejected++; rejected.push({ reason: String(raw.rejectedReason).slice(0, 100) }); continue }
      let support
      try { support = this.validateCandidate(raw, allRows, from, to) } catch (error) { counts.rejected++; rejected.push({ reason: error.message }); continue }
      const item = clone(raw)
      const disabled = JSON.parse(before.meta.disabledSubjects || '{}')
      const suppressed = JSON.parse(before.meta.suppressedSubjects || '{}')
      if (item.type === 'fact' && disabled[item.subjectId] || support.every(({ row }) => row.memorySeq <= Math.max(Number(before.meta.suppressedThrough || 0), Number(suppressed[item.subjectId] || 0)))) {
        counts.rejected++; rejected.push({ reason: 'memory_suppressed' }); continue
      }
      const fingerprint = memoryHash([item.type, item.subjectId, item.slot, item.value, item.text, support.map(({ row }) => row.eventId).sort()])
      const bucket = item.type === 'fact' ? after.facts : after.events
      const slot = identity(item)
      const existing = item.targetId ? bucket[item.targetId] : Object.values(bucket).find(value => value.status === 'active' && (item.type === 'fact'
        ? value.subjectId === item.subjectId && value.slot === item.slot && (FACT_SLOTS[item.slot] !== 'multiple' || memoryHash(value.value) === memoryHash(item.value))
        : value.title === item.title && value.time?.start && value.time.start === item.time?.start && value.participants.some(id => item.participants.includes(id))))
      const evidenceIds = support.map(({ ref, row }) => {
        const id = 'evidence_' + memoryHash([row.eventId, ref.quote])
        after.evidence[id] = { id, eventId: row.eventId, senderId: row.senderId, senderNameAtTime: row.senderNameAtTime, sentAt: row.sentAt,
          sourceKind: row.sourceKind, quote: ref.quote, text: row.text, contentHash: row.contentHash,
          context: allRows.filter(other => Math.abs(other.memorySeq - row.memorySeq) <= 2) }
        return id
      })
      const observed = support.map(({ row }) => row.sentAt).filter(Boolean).sort().at(-1) || null
      const same = existing && (item.type === 'fact' ? memoryHash(existing.value) === memoryHash(item.value) : existing.lifecycle === item.lifecycle && existing.text === item.text)
      let reason = item.decision !== 'accept' ? 'ambiguous' : null
      if (item.type === 'fact' && (item.basis !== 'self_report' || support.some(({ row }) => row.senderId !== item.subjectId || row.fidelity !== 'original' || row.replyToMessageId))) reason = 'subject_or_source_uncertain'
      if (support.some(({ row }) => row.fidelity !== 'original' || !row.senderId)) reason = 'legacy_source_uncertain'
      const knownPeople = new Set([...allRows.flatMap(row => [row.senderId, ...(row.mentions || [])]), ...Object.values(before.facts).map(row => row.subjectId), ...Object.values(before.events).flatMap(row => row.participants)])
      if (item.type === 'event' && item.participants.some(id => !knownPeople.has(id))) reason = 'participant_unverified'
      if (support.some(({ row }) => /开玩笑|逗你|假如|假设|他说|她说|“|”/.test(row.text))) reason = 'context_uncertain'
      if (item.targetId && !existing) reason = 'unknown_target'
      if (existing && item.type === 'fact' && (existing.subjectId !== item.subjectId || existing.slot !== item.slot)) reason = 'target_mismatch'
      if (existing && item.type === 'event' && (existing.title !== item.title || existing.time?.start !== item.time?.start || !existing.participants.some(id => item.participants.includes(id)))) reason = 'event_identity_uncertain'
      if (existing && !same && (!['replace', 'retract'].includes(item.action) || item.changeKind !== 'correction' && item.changeKind !== 'change' || !item.verified)) reason = 'conflict'
      if (existing && !same && (!observed || observed < existing.lastSupportedAt)) reason = 'older_evidence'
      if (existing?.basis === 'master_confirmed' && !same && (!observed || observed <= new Date(existing.updatedAt).toISOString())) reason = 'master_revision_newer'
      if (after.tombstones[slot] || after.tombstones[fingerprint]) reason = 'previously_removed'
      const value = { ...item, id: existing?.id || `${item.type}_${randomUUID()}`, evidence: undefined, evidenceIds: unique([...(existing?.evidenceIds || []), ...evidenceIds]),
        fingerprint, slotKey: slot, firstObservedAt: existing?.firstObservedAt || observed, lastSupportedAt: observed,
        status: item.action === 'retract' ? 'retracted' : 'active', core: item.type === 'fact' && item.core !== false,
        createdByBatch: batchId, revision: (existing?.revision || 0) + 1, updatedAt: Date.now() }
      if (item.type === 'fact') {
        value.aliases = unique([...(existing?.aliases || []), ...support.filter(({ row }) => row.senderId === item.subjectId).map(({ row }) => row.senderNameAtTime).filter(Boolean)])
        value.subjectName = value.aliases.at(-1) || item.subjectId
      } else {
        value.participantNames = Object.fromEntries(item.participants.map(id => [id, unique([...(existing?.participantNames?.[id] || []), ...allRows.filter(row => row.senderId === id).map(row => row.senderNameAtTime)].filter(Boolean))]))
      }
      if (reason) {
        const id = 'review_' + fingerprint
        if (!after.review[id]) after.review[id] = { id, candidate: value, reason, status: 'pending', targetId: existing?.id || null, targetRevision: existing?.revision || 0, evidenceIds, createdAt: Date.now() }
        counts.review++
      } else {
        if (existing) after.revisions[`${existing.id}:${existing.revision}`] = existing
        bucket[value.id] = { ...existing, ...value, ...(same ? { lastSupportedAt: [observed, existing.lastSupportedAt].filter(Boolean).sort().at(-1) } : {}) }
        counts.accepted++
      }
    }
    return this.plan(before, after, { id: batchId, from, to, token, sourceRows: input.encoded,
      contextTail: JSON.stringify(allRows.slice(-20)), receipt: { id: batchId, from, to, counts, rejected, extractorVersion, audit, committedAt: Date.now() } })
  }

  plan(before, after, extra = {}) {
    const changes = []
    const timeline = []
    BUCKETS.slice(0, -1).forEach((bucket, index) => {
      for (const id of new Set([...Object.keys(before[bucket]), ...Object.keys(after[bucket])])) {
        if (JSON.stringify(before[bucket][id]) === JSON.stringify(after[bucket][id])) continue
        changes.push({ bucket: index + 2, id, value: after[bucket][id] ? JSON.stringify(after[bucket][id]) : null })
        if (bucket === 'events') {
          const item = after[bucket][id]
          const date = item?.time?.start
          const score = date && item.status === 'active' ? Date.parse(date) : NaN
          timeline.push({ id, score: Number.isFinite(score) ? score : null })
        }
      }
    })
    const result = { id: randomUUID(), revision: Number(before.meta.memoryRevision || 0), epoch: Number(before.meta.epoch || 0),
      nextEpoch: Number(before.meta.epoch || 0), from: null, to: null, token: null, sourceRows: [], contextTail: '[]', changes, timeline, ...extra }
    result.receipt = JSON.stringify(result.receipt || { id: result.id, management: true })
    if (changes.length > 500 || Buffer.byteLength(JSON.stringify(result)) > 2 * 1024 * 1024) throw new Error('memory_plan_oversize')
    return result
  }

  async commit(scope, plan) {
    const result = await this.sources.evaluate(COMMIT, this.keys(scope), [JSON.stringify(plan)])
    return { ...result, batch: JSON.parse(result.batch) }
  }

  async manage(scope, { action, id, patch, revision, actorId, isMaster }) {
    if (!isMaster || !actorId) throw new Error('memory_master_required')
    const before = await this.snapshot(scope, { mode: 'planning' })
    const after = clone(before)
    const review = after.review[id]
    if (['confirm', 'reject'].includes(action)) {
      if (!review || review.status !== 'pending') throw new Error('memory_review_missing')
      const value = review.candidate
      const disabled = JSON.parse(before.meta.disabledSubjects || '{}')
      if (action === 'confirm' && value.type === 'fact' && disabled[value.subjectId]) throw new Error('memory_subject_disabled')
      const bucket = value.type === 'fact' ? after.facts : after.events
      const current = review.targetId ? bucket[review.targetId] : null
      if ((current?.revision || 0) !== review.targetRevision) throw new Error('memory_review_stale')
      if (!current && Object.values(bucket).some(item => item.status === 'active' && item.slotKey === value.slotKey)) throw new Error('memory_review_stale')
      review.status = action === 'confirm' ? 'confirmed' : 'rejected'
      review.reviewedBy = String(actorId)
      if (action === 'reject') after.tombstones[value.fingerprint] = { at: Date.now(), actorId }
      else {
        if (current) after.revisions[`${current.id}:${current.revision}`] = current
        bucket[value.id] = { ...value, revision: (current?.revision || 0) + 1, basis: 'master_confirmed' }
        delete after.tombstones[value.slotKey]
        delete after.tombstones[value.fingerprint]
      }
    } else {
      const bucket = after.facts[id] ? after.facts : after.events
      const current = bucket[id]
      if (!current) throw new Error('memory_object_missing')
      if (revision != null && current.revision !== revision) throw new Error('memory_conflict')
      after.revisions[`${id}:${current.revision}`] = clone(current)
      if (action === 'delete') { current.status = 'retracted'; after.tombstones[current.slotKey] = { at: Date.now(), actorId } }
      else if (action === 'edit') {
        if (!patch || !text(patch.text) || Object.keys(patch).some(key => !['text', 'value', 'core'].includes(key))) throw new Error('memory_patch_invalid')
        Object.assign(current, patch, { basis: 'master_confirmed' })
      } else if (action === 'undo') {
        const prior = after.revisions[`${id}:${current.revision - 1}`]
        if (!prior) throw new Error('memory_revision_missing')
        bucket[id] = { ...prior, revision: current.revision }
        delete after.tombstones[current.slotKey]
      } else throw new Error('memory_action_invalid')
      bucket[id].revision++
      bucket[id].updatedAt = Date.now()
      bucket[id].updatedBy = String(actorId)
    }
    return this.commit(scope, this.plan(before, after, { nextEpoch: Number(before.meta.epoch || 0) + 1 }))
  }

  async forget(scope, { subjectId = null, id = null, enabled, actorId, isMaster }) {
    if (!actorId || !isMaster && (!subjectId || String(actorId) !== String(subjectId))) throw new Error('memory_permission')
    const before = await this.snapshot(scope, { mode: 'planning' })
    const after = clone(before)
    const control = {}
    let count = 0
    if (enabled !== undefined) {
      if (!subjectId) throw new Error('memory_subject_required')
      const disabled = JSON.parse(before.meta.disabledSubjects || '{}')
      if (enabled) delete disabled[subjectId]; else disabled[subjectId] = true
      control.disabledSubjects = JSON.stringify(disabled)
    } else {
      for (const bucket of ['facts', 'events']) for (const item of Object.values(after[bucket])) {
        if (id && item.id !== id || subjectId && (item.type !== 'fact' || item.subjectId !== String(subjectId))) continue
        if (item.status === 'active') count++
        after.revisions[`${item.id}:${item.revision}`] = clone(item)
        item.status = 'retracted'; item.revision++; item.updatedAt = Date.now(); item.updatedBy = String(actorId)
        after.tombstones[item.slotKey] = { actorId, at: Date.now() }
      }
      for (const item of Object.values(after.review)) {
        if (id && item.candidate.id !== id || subjectId && item.candidate.subjectId !== String(subjectId)) continue
        item.status = 'rejected'
        after.tombstones[item.candidate.fingerprint] = { actorId, at: Date.now() }
      }
      if (!id) {
        const latest = (await this.sources.status(scope)).latest
        if (subjectId) { const values = JSON.parse(before.meta.suppressedSubjects || '{}'); values[subjectId] = latest; control.suppressedSubjects = JSON.stringify(values) }
        else control.suppressedThrough = String(latest)
      }
    }
    await this.commit(scope, this.plan(before, after, { control, nextEpoch: Number(before.meta.epoch || 0) + 1 }))
    return { cleared: count, deleted: count > 0, enabled }
  }

  async importLegacyCandidates(scope, records, importId) {
    const before = await this.snapshot(scope, { mode: 'planning' })
    const after = clone(before)
    for (const record of records) {
      if (!text(record.text, 10000)) throw new Error('memory_legacy_candidate_invalid')
      const fingerprint = memoryHash([scope.root, record.subjectId || null, record.text])
      const id = 'review_' + fingerprint
      if (after.review[id] || after.tombstones[fingerprint]) continue
      const evidenceId = 'evidence_' + fingerprint
      after.evidence[evidenceId] = { id: evidenceId, sourceKind: 'legacy_memory', sourceKey: record.key, quote: record.text, text: record.text, senderId: record.subjectId || null, sentAt: null }
      const candidate = { id: (record.subjectId ? 'fact_' : 'event_') + fingerprint, type: record.subjectId ? 'fact' : 'event',
        subjectId: record.subjectId || null, kind: 'identity', slot: 'legacy:' + fingerprint, value: record.text,
        title: '旧群资料待核对', text: record.text, time: { start: null, precision: 'unknown' }, participants: [], lifecycle: 'unknown',
        status: 'active', core: !!record.subjectId, basis: 'legacy_unverified', evidenceIds: [evidenceId], fingerprint, revision: 1, updatedAt: Date.now(), lastSupportedAt: null }
      candidate.slotKey = identity(candidate)
      after.review[id] = { id, candidate, evidenceIds: [evidenceId], reason: 'legacy_without_original_evidence', status: 'pending', targetId: null, targetRevision: 0 }
    }
    return this.commit(scope, this.plan(before, after, { id: 'import_' + importId, receipt: { id: importId, importedCandidates: records.length, committedAt: Date.now() } }))
  }

  reclaim(scope, { through = Number.MAX_SAFE_INTEGER, retain = 20 } = {}) {
    if (!Number.isSafeInteger(through) || through < 0 || !Number.isSafeInteger(retain) || retain < 0) throw new Error('memory_reclaim_range')
    return this.sources.evaluate(GC, this.keys(scope), [through, retain])
  }
}

export const memoryStoreV3 = new MemoryStoreV3()
