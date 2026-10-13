import { randomUUID } from 'node:crypto'
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises'
import { MemoryStoreV3, memoryHash } from './MemoryStoreV3.js'
import { MemoryExtractorV3, memoryV3Settings, memoryV3Enabled } from './MemoryExtractorV3.js'
import { MemoryJobs } from './MemoryJobs.js'
import { tokenEstimate } from '../../core/promptCache.js'
import { MemoryRetrieverV3 } from './MemoryRetrieverV3.js'

let extractionQueue = Promise.resolve()

export class MemoryService {
  constructor(config = {}, { store = new MemoryStoreV3(), model = null } = {}) {
    this.config = config
    this.store = store
    this.jobs = new MemoryJobs(store)
    this.extractor = new MemoryExtractorV3(config, model)
    this.retriever = new MemoryRetrieverV3(store, config)
    this.running = new Map()
    this.controllers = new Map()
    this.recoveryTimers = new Map()
  }

  updateConfig(config) {
    this.config = config
    this.extractor.updateConfig(config)
    this.retriever.updateConfig(config)
    for (const { scope, controller } of this.controllers.values()) if (!this.enabled(scope)) controller.abort()
  }

  enabled(scope) { return memoryV3Enabled(this.config, scope.groupId) && memoryV3Settings(this.config).organizeEnabled }

  buildMemoryTail(input) {
    if (!memoryV3Enabled(this.config, input.groupId) || !memoryV3Settings(this.config).injectEnabled) return Promise.resolve('')
    return this.retriever.buildMemoryTail(input)
  }

  async start(scope) {
    if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
    if (!this.extractor.ready()) throw new Error('memory_model_unconfigured')
    const result = await this.jobs.start(scope)
    if (result.job) this.schedule(scope, result.job.id)
    return result
  }

  schedule(scope, id) {
    if (this.running.has(scope.root)) return this.running.get(scope.root)
    const task = extractionQueue.catch(() => {}).then(() => this.run(scope, id))
      .catch(error => { globalThis.logger?.error?.(`[MemoryV3] 整理失败 group=${scope.groupId}: ${error.message}`) })
      .finally(() => { this.running.delete(scope.root) })
    extractionQueue = task
    this.running.set(scope.root, task)
    return task
  }

  async resumeAll() {
    for (const scope of await this.jobs.scopes()) {
      if (!this.enabled(scope)) continue
      const { job } = await this.jobs.get(scope)
      if (job && ['running', 'queued', 'paused'].includes(job.status)) this.schedule(scope, job.id)
    }
  }

  async requestPart(scope, input) {
    const settings = memoryV3Settings(this.config)
    const controller = new AbortController()
    this.controllers.set(scope.root, { scope, controller })
    let timer
    try {
      return await Promise.race([
        this.extractor.extractPart(input, controller.signal),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('memory_request_aborted')), { once: true })
          timer = setTimeout(() => controller.abort(), settings.timeoutMs)
        })
      ])
    } finally { clearTimeout(timer); this.controllers.delete(scope.root) }
  }

  async buildBatch(scope, job, state) {
    const settings = memoryV3Settings(this.config)
    const after = Number(state.meta.extractedThrough || 0)
    const page = await this.store.sources.readSourceRange(scope, { after, until: job.target, limit: settings.batchMessages })
    const rows = []
    let cost = 0
    for (const row of page.rows) {
      const size = tokenEstimate(row.text)
      if (rows.length && cost + size > settings.batchTokens) break
      rows.push(row); cost += size
    }
    if (!rows.length) throw new Error('memory_source_gap')
    const project = row => ({ eventId: row.eventId, memorySeq: row.memorySeq, senderId: row.senderId, senderNameAtTime: row.senderNameAtTime,
      sentAt: row.sentAt, text: row.text, sourceKind: row.sourceKind, fidelity: row.fidelity, replyToMessageId: row.replyToMessageId, mentions: row.mentions })
    const context = []
    let auxiliaryTokens = 0
    for (const row of JSON.parse(state.meta.contextTail || '[]').slice(-10).reverse()) {
      const projected = project(row)
      const size = tokenEstimate(projected)
      if (auxiliaryTokens + size > settings.batchTokens / 4) break
      context.unshift(projected); auxiliaryTokens += size
    }
    const subjects = new Set(rows.map(row => row.senderId))
    const existing = { facts: [], events: [] }
    for (const item of [...Object.values(state.facts).filter(item => item.status === 'active' && subjects.has(item.subjectId)), ...Object.values(state.events).filter(item => item.status === 'active').slice(-50)]) {
      const { id, subjectId, slot, text, value, title, time, participants, lifecycle, revision } = item
      const summary = { id, subjectId, slot, text, value, title, time, participants, lifecycle, revision }
      const size = tokenEstimate(summary)
      if (auxiliaryTokens + size > settings.batchTokens / 2) continue
      existing[item.type === 'fact' ? 'facts' : 'events'].push(summary); auxiliaryTokens += size
    }
    const parts = []
    // 字符分片上限保守取 token 预算的一半；只拆传给模型的文本，原消息身份和证据原件不变。
    const chunkSize = Math.max(128, Math.floor(settings.batchTokens / 2))
    if (rows.length === 1 && rows[0].text.length > chunkSize) {
      for (let offset = 0; offset < rows[0].text.length; offset += chunkSize) parts.push({ messages: [{ ...project(rows[0]), text: rows[0].text.slice(offset, offset + chunkSize) }], fragment: { offset, total: rows[0].text.length } })
    } else parts.push({ messages: rows.map(project), fragment: null })
    return { from: after + 1, to: rows.at(-1).memorySeq, sourceHash: memoryHash(rows), extractorVersion: 'v3.1', parts, context, existing, nextPart: 0, candidates: [], audits: [] }
  }

  async run(scope, id) {
    if (!this.enabled(scope) || !this.extractor.ready()) return
    const token = randomUUID()
    const leaseMs = memoryV3Settings(this.config).timeoutMs * 2 + 30000
    let claimed = await this.jobs.claim(scope, id, token, leaseMs)
    if (claimed.busy) {
      if (!this.recoveryTimers.has(scope.root)) {
        const timer = setTimeout(() => { this.recoveryTimers.delete(scope.root); this.schedule(scope, id) }, Math.min(60000, Math.max(50, claimed.retryAt - Date.now() + 10)))
        timer.unref?.(); this.recoveryTimers.set(scope.root, timer)
      }
      return
    }
    let job = claimed.job
    const heartbeat = setInterval(() => { this.jobs.update(scope, id, token, {}, leaseMs).catch(() => this.controllers.get(scope.root)?.controller.abort()) }, Math.max(100, Math.floor(leaseMs / 3)))
    heartbeat.unref?.()
    try {
      while (this.enabled(scope)) {
        const state = await this.store.snapshot(scope)
        if (Number(state.meta.extractedThrough || 0) >= job.target) {
          const batches = Object.values(state.batches).filter(batch => batch.from >= job.from && batch.to <= job.target).length
          await this.jobs.update(scope, id, token, { status: 'complete', finishedAt: Date.now(), batch: null, batches }, 0)
          return
        }
        let batch = job.batch
        if (!batch || batch.to <= Number(state.meta.extractedThrough || 0)) {
          batch = await this.buildBatch(scope, job, state)
          job = (await this.jobs.update(scope, id, token, { batch, attempts: 0 }, leaseMs)).job
        }
        try {
          while (batch.nextPart < batch.parts.length) {
            if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
            const output = await this.requestPart(scope, { ...batch.parts[batch.nextPart], context: batch.context, existing: batch.existing })
            batch.candidates.push(...output.candidates)
            batch.audits.push(output.audit)
            batch.nextPart++
            job = (await this.jobs.update(scope, id, token, { batch }, leaseMs)).job
            await yieldLoop()
          }
          if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
          const plan = await this.store.planBatch(scope, { ...batch, token, audit: { sourceHash: batch.sourceHash, parts: batch.audits, model: this.config.memoryAiConfig?.memoryAiModel || 'injected' } })
          const result = await this.store.commit(scope, plan)
          job = (await this.jobs.update(scope, id, token, { batch: null, batches: job.batches + 1, lastReceipt: result.batch, attempts: 0 }, leaseMs)).job
        } catch (error) {
          const attempts = Number(job.attempts || 0) + 1
          if (!this.enabled(scope)) throw error
          if (/memory_conflict/.test(error.message) && attempts < memoryV3Settings(this.config).maxAttempts) {
            job = (await this.jobs.update(scope, id, token, { attempts }, leaseMs)).job
          } else if (attempts < memoryV3Settings(this.config).maxAttempts && /model|verifier|request|429|timeout/i.test(error.message)) {
            job = (await this.jobs.update(scope, id, token, { attempts, lastError: error.message, batch }, leaseMs)).job
            await delay(Math.min(60000, memoryV3Settings(this.config).retryDelayMs * 2 ** (attempts - 1)))
          } else throw error
        }
        await yieldLoop()
      }
      await this.jobs.update(scope, id, token, { status: 'paused' }, 0)
    } catch (error) {
      await this.jobs.update(scope, id, token, { status: this.enabled(scope) ? 'failed' : 'paused', lastError: error.message }, 0).catch(() => {})
      throw error
    } finally { clearInterval(heartbeat) }
  }
}
