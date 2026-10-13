import { setImmediate as yieldLoop } from 'node:timers/promises'
import { buildMemorySource } from './sourceSchema.js'
import { memoryHash } from './MemoryStoreV3.js'

const READ_ARCHIVE = `local rows={}
for index=tonumber(ARGV[1]),tonumber(ARGV[2]) do
  local value=redis.call('HGET', KEYS[1], ARGV[3] .. index)
  if value then table.insert(rows, {index=index, value=value}) end
end
return cjson.encode({rows=rows})`
const SCAN = `local values=redis.call('SCAN', ARGV[1], 'MATCH', ARGV[2], 'COUNT', 64)
return cjson.encode({cursor=values[1], keys=values[2]})`
const GET = `return cjson.encode({value=redis.call('GET', KEYS[1]) or false})`

export class MemoryLegacyImporter {
  constructor(store) { this.store = store; this.running = new Map() }

  import(scope) {
    if (this.running.has(scope.root)) return this.running.get(scope.root)
    const task = this.run(scope).finally(() => this.running.delete(scope.root))
    this.running.set(scope.root, task)
    return task
  }

  async get(key) {
    const { value } = await this.store.sources.evaluate(GET, [key])
    return value ? JSON.parse(value) : null
  }

  async run(scope) {
    const sources = this.store.sources
    const coverage = await sources.snapshotStatus(scope)
    let imported = 0; let duplicate = 0; let reviews = 0
    const record = async source => {
      const result = await sources.record(scope, source)
      if (result.duplicate) duplicate++; else imported++
    }
    const archive = sources.snapshotKeys(scope)[1]
    const importRecord = async record => {
      const id = memoryHash([scope.root, record.subjectId || null, record.text])
      const result = await this.store.importLegacyCandidates(scope, [record], id)
      if (!result.duplicate) reviews++
      await yieldLoop()
    }
    const recentResult = await sources.evaluate(`return cjson.encode({value=redis.call('HGET', KEYS[1], 'recent') or '[]'})`, [archive])
    for (const message of JSON.parse(recentResult.value)) { await record(buildMemorySource(message, scope, { legacy: true })); await yieldLoop() }
    for (const [prefix, from, until] of [['raw:', Number(coverage.rawFrom || 1), Number(coverage.rawUntil || 0)], ['replay:', 0, Number(coverage.replayCaptured || 0) - 1]]) {
      for (let cursor = from; cursor <= until; cursor += 64) {
        const page = await sources.evaluate(READ_ARCHIVE, [archive], [cursor, Math.min(until, cursor + 63), prefix])
        for (const entry of Array.isArray(page.rows) ? page.rows : []) {
          if (prefix === 'raw:') {
            const row = JSON.parse(entry.value); const event = JSON.parse(row.payload)
            await record(buildMemorySource(event.message, scope, { eventId: event.eventId, legacy: true }))
          } else {
            const block = JSON.parse(entry.value)
            if (block.contextNotes) continue
            const rows = block.apiRows || block.toolRows || []
            const userRows = rows.filter(row => row.role === 'user' && typeof row.content === 'string')
            for (const [index, row] of userRows.entries()) {
              const messageId = userRows.length === 1 && block.messageIds?.length === 1 ? block.messageIds[0] : null
              const eventId = messageId ? `message:${scope.botId}:${scope.groupId}:${messageId}` : `legacy-replay:${memoryHash([scope.root, coverage.resetId, entry.index, index, row.content])}`
              const source = buildMemorySource({ content: row.content, message_id: messageId }, scope, { eventId, legacy: true })
              await record(source)
            }
          }
        }
        await yieldLoop()
      }
    }
    // 旧库只读；按当前群定位事实，不调用旧 MemoryManager 的自动迁移/写入接口。
    const escapedGroup = String(scope.groupId).replace(/[?*\[\]\\]/g, '\\$&')
    for (const pattern of [`ytbot:memory:v2:fact:user:${escapedGroup}:*`, `ytbot:memory:v2:fact:group:${escapedGroup}:*`]) {
      let cursor = '0'
      do {
        const page = await sources.evaluate(SCAN, [], [cursor, pattern])
        cursor = page.cursor
        for (const key of Array.isArray(page.keys) ? page.keys : []) {
          const fact = await this.get(key)
          if (!fact || String(fact.groupId) !== scope.groupId || fact.status === 'deleted' || typeof fact.content !== 'string') continue
          if (fact.scope === 'user' && fact.userId == null) continue
          const record = { key, text: fact.content, subjectId: fact.scope === 'user' ? String(fact.userId) : null }
          await importRecord(record)
        }
      } while (cursor !== '0')
    }
    const legacy = async (key, subjectId) => {
      const value = await this.get(key)
      if (!value) return
      const items = [...(Array.isArray(value.facts) ? value.facts : []), ...Object.values(value.categorizedFacts || {}).filter(Array.isArray).flat(),
        ...(value.preferences?.likes || []), ...(value.preferences?.dislikes || [])]
      for (const item of items) {
        const text = typeof item === 'string' ? item : item?.content
        if (typeof text === 'string') await importRecord({ key, subjectId, text })
      }
    }
    await legacy(`ytbot:memory:group:${scope.groupId}`, null)
    let cursor = '0'
    do {
      const page = await sources.evaluate(SCAN, [], [cursor, `ytbot:memory:${escapedGroup}:*`])
      cursor = page.cursor
      for (const key of Array.isArray(page.keys) ? page.keys : []) {
        const subject = key.slice(`ytbot:memory:${scope.groupId}:`.length)
        if (/^\d+$/.test(subject)) await legacy(key, subject)
      }
    } while (cursor !== '0')
    const result = { imported, duplicate, reviews, coverage, finishedAt: Date.now() }
    await sources.updateSnapshot(scope, { lastManualImport: JSON.stringify(result) })
    return result
  }
}
