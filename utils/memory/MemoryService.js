import { randomUUID } from 'node:crypto'
import { setTimeout as delay, setImmediate as yieldLoop } from 'node:timers/promises'
import { MemoryStoreV3, memoryHash } from './MemoryStoreV3.js'
import { MemoryExtractorV3, memoryV3Settings, memoryV3Enabled } from './MemoryExtractorV3.js'
import { MemoryJobs } from './MemoryJobs.js'
import { tokenEstimate, replayEventRow } from '../../core/promptCache.js'
import { replayRows } from '../../core/replayAdapters.js'
import { contextStore } from '../../core/contextStore.js'
import { promptCacheSettings } from '../../core/promptCache.js'
import { MemoryRetrieverV3 } from './MemoryRetrieverV3.js'
import { MemoryLegacyImporter } from './MemoryLegacyImporter.js'

let extractionQueue = Promise.resolve()

export class MemoryService {
  constructor(config = {}, { store = new MemoryStoreV3(), model = null } = {}) {
    this.config = config
    this.store = store
    this.jobs = new MemoryJobs(store)
    this.extractor = new MemoryExtractorV3(config, model)
    this.retriever = new MemoryRetrieverV3(store, config)
    this.importer = new MemoryLegacyImporter(store)
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
    const state = await this.store.snapshot(scope, { mode: 'planning' })
    const disabled = JSON.parse(state.meta.disabledSubjects || '{}')
    const suppressed = JSON.parse(state.meta.suppressedSubjects || '{}')
    const visible = row => !disabled[row.senderId] && row.memorySeq > Math.max(Number(state.meta.suppressedThrough || 0), Number(suppressed[row.senderId] || 0))
    input = { ...input, messages: input.messages.filter(visible), context: input.context.filter(visible),
      existing: { facts: (input.existing.facts || []).filter(item => !disabled[item.subjectId] && state.facts[item.id]?.status === 'active')
        .map(item => ({ ...item, text: state.facts[item.id].text, value: state.facts[item.id].value, revision: state.facts[item.id].revision })),
      events: (input.existing.events || []).filter(item => state.events[item.id]?.status === 'active') } }
    if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
    if (!input.messages.length) return { candidates: [], audit: { excludedSources: true, candidateCount: 0, verdicts: [] } }
    const controller = new AbortController()
    this.controllers.set(scope.root, { scope, controller })
    const startedAt = Date.now()
    let timer
    try {
      return await Promise.race([
        this.extractor.extractPart(input, controller.signal),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('memory_request_aborted')), { once: true })
          if (controller.signal.aborted) reject(new Error('memory_request_aborted'))
          timer = setTimeout(() => controller.abort(), settings.timeoutMs)
        })
      ])
    } finally { clearTimeout(timer); this.controllers.delete(scope.root); this.lastModelMs = Date.now() - startedAt }
  }

  // fork 前缀：与主对话 agent 请求同源（同一账本 header/system + replayRows('agent') 投影
  // + 未消化旁听消息渲染）。末条由 fork 指令替换本轮 user 行——前缀到旁听为止与最近一轮
  // 主对话请求逐字节同族，上游 prompt cache 对该前缀命中，全量重读走缓存价。
  async buildForkPrefix(botId, groupId) {
    const store = this.contextStore || contextStore
    const settings = promptCacheSettings(this.config)
    const scope = await store.scope(botId, groupId, { settings })
    let header = await store.header(scope, 'agent')
    let projection = 'agent'
    if (!header?.agentSystem) { header = await store.header(scope, 'dual'); projection = 'tools' }
    const systemText = projection === 'agent' ? header?.agentSystem : header?.toolSystem
    if (!systemText) throw new Error('memory_fork_no_header')
    const snapshot = await store.read(scope, header, settings, 512)
    const rows = [{ role: 'system', content: systemText },
      ...snapshot.blocks.flatMap(block => replayRows(block, projection))]
    for (const event of snapshot.events) {
      const row = replayEventRow(event, scope.botId)
      if (row) rows.push(row)
    }
    if (rows.length < 2) throw new Error('memory_fork_empty_ledger')
    return rows
  }

  // fork 模型调用（超时/abort 与 flash 路径同一套 controllers 机制）
  async requestFork(scope, prefixRows, existing, sources) {
    const settings = memoryV3Settings(this.config)
    if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
    const controller = new AbortController()
    this.controllers.set(scope.root, { scope, controller })
    const startedAt = Date.now()
    let timer
    try {
      return await Promise.race([
        this.extractor.extractFork({ prefixRows, existing, sources }, controller.signal),
        new Promise((_, reject) => {
          controller.signal.addEventListener('abort', () => reject(new Error('memory_request_aborted')), { once: true })
          if (controller.signal.aborted) reject(new Error('memory_request_aborted'))
          timer = setTimeout(() => controller.abort(), settings.timeoutMs)
        })
      ])
    } finally { clearTimeout(timer); this.controllers.delete(scope.root); this.lastModelMs = Date.now() - startedAt }
  }

  // fork 路径：一次全量模型调用（吃缓存、完整语境），提交仍按 planBatch 的 64 条
  // 窗口上限切分——候选按证据所在窗口归组，逐窗走既有 planBatch/commit 管线
  // （validateCandidate、禁用主体、evidence 关联、幂等提交全部复用）。
  async runForkAll(scope, job, token, state, leaseMs) {
    const settings = memoryV3Settings(this.config)
    const after = Number(state.meta.extractedThrough || 0)
    const page = await this.store.sources.readSourceRange(scope, { after, until: job.target, limit: 10000 })
    if (!page.rows.length) throw new Error('memory_source_gap')
    const existing = { facts: [], events: [] }
    let auxiliaryTokens = 0
    for (const item of [...Object.values(state.facts).filter(row => row.status === 'active'),
      ...Object.values(state.events).filter(row => row.status === 'active').slice(-80)]) {
      const summary = { id: item.id, subjectId: item.subjectId, slot: item.slot, text: item.text, value: item.value,
        title: item.title, time: item.time, participants: item.participants, lifecycle: item.lifecycle, revision: item.revision }
      const size = tokenEstimate(summary)
      if (auxiliaryTokens + size > 8192) continue
      existing[item.type === 'fact' ? 'facts' : 'events'].push(summary); auxiliaryTokens += size
    }
    const prefixRows = await this.buildForkPrefix(scope.botId, scope.groupId)
    let output = null
    let attempts = 0
    while (!output) {
      attempts++
      try { output = await this.requestFork(scope, prefixRows, existing, page.rows) }
      catch (error) {
        if (!this.enabled(scope) || attempts >= settings.maxAttempts || !/model|request|429|timeout/i.test(error.message)) throw error
        await this.jobs.update(scope, job.id, token, { lastError: error.message, retryCount: Number(job.retryCount || 0) + 1 }, leaseMs).catch(() => {})
        await delay(Math.min(60000, settings.retryDelayMs * 2 ** (attempts - 1)))
      }
    }
    const rows = page.rows
    const windows = []
    for (let offset = 0; offset < rows.length; offset += 64) windows.push(rows.slice(offset, offset + 64))
    const rowSeq = new Map(rows.map(row => [row.eventId, row.memorySeq]))
    const buckets = windows.map(() => [])
    for (const candidate of output.candidates) {
      const seqs = (candidate.evidence || []).map(ref => rowSeq.get(ref.eventId)).filter(Number.isFinite)
      let index = 0
      if (seqs.length) {
        const maxSeq = Math.max(...seqs)
        index = windows.findIndex(window => maxSeq >= window[0].memorySeq && maxSeq <= window.at(-1).memorySeq)
        if (index < 0) index = windows.length - 1
      }
      buckets[index].push(candidate)
    }
    for (const [index, windowRows] of windows.entries()) {
      if (!this.enabled(scope)) throw new Error('memory_organizing_disabled')
      const overflow = Math.max(0, buckets[index].length - 100)
      const batch = { from: windowRows[0].memorySeq, to: windowRows.at(-1).memorySeq, sourceHash: memoryHash(windowRows),
        extractorVersion: 'v3.2-fork', parts: [{ messages: [], fragment: null }], nextPart: 1,
        candidates: buckets[index].slice(0, 100), context: [], existing, forkOverflow: overflow }
      const plan = await this.store.planBatch(scope, { ...batch, token,
        audit: { extractor: 'fork', model: this.config.chatAiConfig?.chatApiModel || 'fork', prefixRows: prefixRows.length, parts: [output.audit], splits: [] } })
      const result = await this.store.commit(scope, plan)
      const current = await this.jobs.get(scope)
      job = (await this.jobs.update(scope, job.id, token, { batches: Number(current.job?.batches || 0) + 1, lastReceipt: result.batch }, leaseMs)).job
      await yieldLoop()
    }
  }

  async buildBatch(scope, job, state) {    const settings = memoryV3Settings(this.config)
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
    if (parts.length > 128) throw new Error('memory_batch_oversize')
    return { from: after + 1, to: rows.at(-1).memorySeq, sourceHash: memoryHash(rows), extractorVersion: 'v3.1', parts, context, existing, nextPart: 0, candidates: [], audits: [] }
  }

  splitPart(batch) {
    const parent = batch.parts[batch.nextPart]
    if (!parent || batch.parts.length >= 128) return false
    let children
    if (parent.messages.length > 1) {
      const middle = Math.ceil(parent.messages.length / 2)
      children = [parent.messages.slice(0, middle), parent.messages.slice(middle)].map(messages => ({ messages, fragment: parent.fragment }))
    } else if (parent.messages[0]?.text.length > 128) {
      const row = parent.messages[0]
      let middle = Math.floor(row.text.length / 2)
      if (/[\uD800-\uDBFF]/.test(row.text[middle - 1])) middle--
      children = [0, middle].map((offset, index) => ({ messages: [{ ...row, text: row.text.slice(offset, index === 0 ? middle : undefined) }],
        fragment: { offset: (parent.fragment?.offset || 0) + offset, total: parent.fragment?.total || row.text.length } }))
    } else return false
    batch.splitHistory ||= []
    batch.splitHistory.push({ parent: memoryHash(parent), children: children.map(memoryHash), reason: 'truncated', from: batch.from, to: batch.to })
    batch.parts.splice(batch.nextPart, 1, ...children)
    return true
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
        const state = await this.store.snapshot(scope, { mode: 'planning' })
        if (Number(state.meta.extractedThrough || 0) >= job.target) {
          if (memoryV3Settings(this.config).reclaimEnabled) while (!(await this.store.reclaim(scope)).done) await yieldLoop()
          const batches = Number(state.meta.committedBatchCount || 0) - Number(job.startBatchCount || 0)
          await this.jobs.update(scope, id, token, { status: 'complete', finishedAt: Date.now(), elapsedMs: Date.now() - job.createdAt, lastModelMs: this.lastModelMs || 0, batch: null, batches }, 0)
          return
        }
        let batch = job.batch
        if (!batch || batch.to <= Number(state.meta.extractedThrough || 0)) {
          if (memoryV3Settings(this.config).extractor === 'fork') {
            // fork：一次全量模型调用 + 窗口化提交；完成后回顶复核游标
            await this.runForkAll(scope, job, token, state, leaseMs)
            continue
          }
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
          const plan = await this.store.planBatch(scope, { ...batch, token, audit: { sourceHash: batch.sourceHash, parts: batch.audits, splits: batch.splitHistory || [], model: this.config.memoryAiConfig?.memoryAiModel || 'injected' } })
          const result = await this.store.commit(scope, plan)
          job = (await this.jobs.update(scope, id, token, { batch: null, batches: job.batches + 1, lastReceipt: result.batch, attempts: 0 }, leaseMs)).job
        } catch (error) {
          const attempts = Number(job.attempts || 0) + 1
          if (!this.enabled(scope)) throw error
          if (error.message === 'memory_model_truncated' && this.splitPart(batch)) {
            job = (await this.jobs.update(scope, id, token, { attempts: 0, batch, lastError: error.message }, leaseMs)).job
          } else if (/memory_conflict/.test(error.message) && attempts < memoryV3Settings(this.config).maxAttempts) {
            job = (await this.jobs.update(scope, id, token, { attempts }, leaseMs)).job
          } else if (attempts < memoryV3Settings(this.config).maxAttempts && /model|verifier|request|429|timeout/i.test(error.message)) {
            job = (await this.jobs.update(scope, id, token, { attempts, retryCount: Number(job.retryCount || 0) + 1, lastError: error.message, batch }, leaseMs)).job
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
