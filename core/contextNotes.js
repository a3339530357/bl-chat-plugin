import { tokenEstimate } from './promptCache.js'
import { nativeReplayRows } from './replayAdapters.js'

// Facts are versioned independently of source messages. Hashes are deliberately
// not identities: A -> B -> A is three updates, and a trimmed A must be restorable.
export function visibleContextNotes(blocks = []) {
  const visible = {}
  for (const block of blocks) for (const entry of block.contextNotes || []) {
    if (!visible[entry.key] || entry.version >= visible[entry.key].version) visible[entry.key] = entry
  }
  return visible
}

export function contextNoteBlock(entries, { baseline = false } = {}) {
  const content = `${baseline ? '【上下文基线】' : '【上下文更新】'}\n` +
    entries.map(entry => `v${entry.version} ${entry.text}`).join('\n')
  const apiRows = [{ role: 'user', content }]
  return { replayVersion: 3, mode: 'agent', referenceVersion: 2, contextNotes: entries,
    contextBaseline: baseline, apiRows, messageIds: [], tokens: tokenEstimate(apiRows) }
}

export function participantFacts(snapshot, participants = [], e = {}) {
  const people = new Map()
  for (const [key, entry] of Object.entries(snapshot.noteState || {})) {
    if (key.startsWith('member:')) people.set(key.slice(7), JSON.parse(entry.valueJson))
  }
  const observed = new Set()
  const put = (qq, name, role, otherNames = []) => {
    if (qq == null || String(qq) === '' || !name) return
    qq = String(qq)
    const previous = people.get(qq)
    const aliases = [...new Set([...(previous?.aliases || []), previous?.name, ...otherNames, String(name)].filter(Boolean))].sort()
    people.set(qq, { qq, name: String(name), role: role || previous?.role || '[member]', aliases })
    observed.add(qq)
  }
  // The rolling buffer is only a bootstrap/fallback. The source journal, in
  // sequence order, is authoritative and includes speakers outside that buffer.
  for (const person of [...participants].sort((a, b) => String(a.qq).localeCompare(String(b.qq)))) {
    if (!people.has(String(person.qq))) put(person.qq, person.name, person.role)
  }
  for (const event of snapshot.identityEvents || snapshot.events || []) {
    const sender = event.message?.sender || {}
    const role = sender.role === 'owner' ? '[群主]' : sender.role === 'admin' ? '[管理]' : '[member]'
    put(sender.user_id, sender.card || sender.nickname, role, [sender.nickname, sender.card])
  }
  if (!people.has(String(e.user_id))) put(e.user_id, e.sender?.card || e.sender?.nickname || '未知用户', e.sender?.role === 'owner' ? '[群主]' : e.sender?.role === 'admin' ? '[管理]' : '[member]')
  // Keep the configured bot identity, including its bot marker.
  for (const person of participants.filter(person => person.role === '[bot]')) put(person.qq, person.name, person.role)
  return [...people].sort(([a], [b]) => a.localeCompare(b, 'en', { numeric: true })).map(([qq, value]) => {
    const aliases = value.aliases.filter(name => name !== value.name)
    return { key: `member:${qq}`, value, observed: observed.has(qq),
      text: `成员 ${JSON.stringify(value.name)} QQ=${qq} ${value.role}${aliases.length ? ` 旧名=${JSON.stringify(aliases)}` : ''}` }
  })
}

export function planContextNotes(snapshot, facts) {
  const visible = visibleContextNotes(snapshot.blocks)
  const restoreMembers = facts.some(fact => fact.key.startsWith('member:') && snapshot.noteState?.[fact.key] &&
    visible[fact.key]?.valueJson !== snapshot.noteState[fact.key].valueJson)
  const notes = []
  const updates = []
  for (const fact of facts) {
    const previous = snapshot.noteState?.[fact.key]
    const valueJson = JSON.stringify(fact.value)
    const changed = !previous || previous.valueJson !== valueJson
    const entry = { key: fact.key, valueJson, text: fact.text,
      version: changed || fact.observed !== false ? snapshot.noteClock : previous.version,
      ...(fact.retired ? { retired: true } : {}) }
    const missing = visible[fact.key]?.valueJson !== valueJson
    const block = contextNoteBlock([entry])
    notes.push({ eventId: `note:${snapshot.noteClock}:${fact.key}`, entry, block })
    if (!fact.retired && (changed || missing || (restoreMembers && fact.key.startsWith('member:')))) updates.push(entry)
  }
  return { notes, updates, content: updates.map(entry => `v${entry.version} ${entry.text}`).join('\n') }
}

// Retrieval results are scoped to their subject. Absence after a nonempty
// result is a real update, so an old RAG/memory snapshot cannot stay active.
export function referenceFacts(snapshot, references, userId) {
  return Object.entries(references).filter(([name]) => !['北京时间', 'time'].includes(name)).flatMap(([name, content]) => {
    const subject = ['用户记忆', '角色状态', 'memory'].includes(name) ? `QQ=${userId}` : '群'
    const key = `reference:${subject}:${name}`
    const value = content || null
    if (value === null && !snapshot.noteState?.[key]) return []
    return [{ key, value, text: `资料 ${subject} ${name}=${JSON.stringify(value)}` }]
  })
}

export function profileFacts(snapshot, records, userId, currentMessageId, userContent, observers) {
  const facts = []
  const active = new Set()
  const blocks = [...snapshot.blocks, ...observers.map(observer => observer.block)]
  const normalize = value => String(value || '').replace(/\s+/g, ' ').trim()
  for (const [index, record] of records.entries()) {
    const id = record.messageId == null ? '' : String(record.messageId)
    const key = `profile:${userId}:${id || `${record.time}:${index}`}`
    const covered = id && ((id === String(currentMessageId) && normalize(userContent).includes(normalize(record.text))) ||
      blocks.some(block => (block.messageIds || []).map(String).includes(id) && nativeReplayRows(block).some(row => normalize(row.content).includes(normalize(record.text)))))
    if (covered || !record.text) continue
    active.add(key)
    facts.push({ key, value: record.text, text: `近期发言 QQ=${userId} 消息${id || '-'}=${JSON.stringify(record.text)}` })
  }
  for (const key of Object.keys(snapshot.noteState || {})) {
    if (key.startsWith(`profile:${userId}:`) && !active.has(key)) facts.push({ key, value: null, text: '', retired: true })
  }
  return facts
}
