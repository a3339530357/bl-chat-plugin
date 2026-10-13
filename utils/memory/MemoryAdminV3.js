import { botIdForEvent } from '../../core/promptCache.js'
import { memoryV3Enabled, memoryV3Settings } from './MemoryExtractorV3.js'

// 旧命令名称保留，运行时读写统一转到 V3；不再实例化旧提取/记忆管理器。
export class MemoryAdminV3 {
  constructor(service, event = {}) { this.service = service; this.event = event }
  get config() { return { ...this.service.config.memorySystem, automaticExtraction: false } }
  scope(groupId) { return this.service.store.scope(botIdForEvent(this.event), groupId) }
  async adminStatus({ groupId, userId }) {
    const state = await this.service.store.snapshot(this.scope(groupId))
    return { enabled: memoryV3Enabled(this.service.config, groupId), v3: true,
      organizeEnabled: memoryV3Settings(this.service.config).organizeEnabled, injectEnabled: memoryV3Settings(this.service.config).injectEnabled,
      user: { factCount: Object.values(state.facts).filter(item => item.subjectId === String(userId) && item.status === 'active').length, disabled: !!JSON.parse(state.meta.disabledSubjects || '{}')[userId] },
      group: { factCount: Object.values(state.events).filter(item => item.status === 'active').length },
      pendingReviews: Object.values(state.review).filter(item => item.status === 'pending').length, revision: state.meta.memoryRevision || '0', config: { semanticRecallEnabled: false } }
  }
  async adminListMemories({ scope = 'user', groupId, userId, query = '', limit = 30, includeDeleted = false }) {
    const state = await this.service.store.snapshot(this.scope(groupId))
    const items = scope === 'user' ? Object.values(state.facts).filter(item => item.subjectId === String(userId)) : [...Object.values(state.events), ...(this.event.isMaster ? Object.values(state.facts) : [])]
    return { facts: items.filter(item => (includeDeleted || item.status === 'active') && (!query || item.text.includes(query))).slice(0, limit).map(item => ({ ...item, content: item.text, category: item.kind || 'event' })) }
  }
  async adminDeleteMemory({ scope, groupId, userId, id }) {
    if (id.length < 8) return { deleted: false, reason: 'id-too-short' }
    const { facts } = await this.adminListMemories({ scope, groupId, userId, limit: 10000 })
    const matches = facts.filter(item => item.id === id || item.id.startsWith(id))
    if (matches.length !== 1) return { deleted: false, reason: matches.length ? 'ambiguous-id' : 'not-found' }
    return this.service.store.forget(this.scope(groupId), { id: matches[0].id, subjectId: scope === 'user' ? String(userId) : null, actorId: this.event.user_id, isMaster: this.event.isMaster })
  }
  adminClearMemories({ scope, groupId, userId }) {
    return this.service.store.forget(this.scope(groupId), { subjectId: scope === 'user' ? String(userId) : null, actorId: this.event.user_id, isMaster: this.event.isMaster })
  }
  adminSetUserMemoryEnabled({ groupId, userId, enabled }) {
    return this.service.store.forget(this.scope(groupId), { subjectId: String(userId), enabled, actorId: this.event.user_id, isMaster: this.event.isMaster })
  }
  getMemoryPromptForUser() { return Promise.resolve('') }
  getGroupMemoryPrompt() { return Promise.resolve('') }
}
