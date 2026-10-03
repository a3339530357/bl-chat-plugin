import test from 'node:test'
import assert from 'node:assert/strict'
import { register } from 'node:module'

register('./helpers/yunzai-cache-loader.mjs', import.meta.url, { data: { realSharedState: true } })
globalThis.logger = { error() {}, debug() {}, info() {} }
const { initializeSharedState } = await import('../core/sharedState.js')

test('hot configuration updates the fields actually read by MessageManager', () => {
  const config = { enabled: false, groupMaxMessages: 30, groupChatMemoryDays: 1,
    oneapi_tools: [], memorySystem: { enabled: false }, expressionLearning: { enabled: false }, knowledgeSystem: { enabled: false } }
  const first = initializeSharedState(config)
  assert.equal(first.messageManager.GROUP_MAX_MESSAGES, 30)
  assert.equal(first.messageManager.CACHE_EXPIRE_DAYS, 1)
  const second = initializeSharedState({ ...config, groupMaxMessages: 75, groupChatMemoryDays: 3 })
  assert.equal(second.messageManager, first.messageManager)
  assert.equal(second.messageManager.GROUP_MAX_MESSAGES, 75)
  assert.equal(second.messageManager.CACHE_EXPIRE_DAYS, 3)
  assert.equal(Object.hasOwn(second.messageManager, 'groupMaxMessages'), false)
  assert.equal(Object.hasOwn(second.messageManager, 'cacheExpireDays'), false)
})
