import { agentCallPolicyError } from './toolConfig.js'
import { agentAssistantRow, validateToolRows } from './replayAdapters.js'
import { cacheDiagnostic, cacheFingerprint, tokenEstimate } from './promptCache.js'
import { isToolResultError } from './toolResult.js'

function canonicalParams(value) {
  if (Array.isArray(value)) return value.map(canonicalParams)
  if (value && typeof value === 'object') return Object.fromEntries(Object.keys(value).sort().map(key => [key, canonicalParams(value[key])]))
  return value
}

function validBatch(calls) {
  if (!Array.isArray(calls) || !calls.length || calls.length > 32) return false
  const ids = new Set()
  return calls.every(call => {
    if (!call || (call.type && call.type !== 'function') || typeof call.id !== 'string' || !call.id || ids.has(call.id) ||
      typeof call.function?.name !== 'string' || !call.function.name ||
      (call.function.arguments !== undefined && typeof call.function.arguments !== 'string')) return false
    ids.add(call.id)
    return true
  })
}

function captureReplies(e, turn) {
  const descriptor = Object.getOwnPropertyDescriptor(e, 'reply')
  const original = e.reply
  if (typeof original !== 'function') return () => {}
  try {
    Object.defineProperty(e, 'reply', { configurable: true, writable: true, enumerable: descriptor?.enumerable ?? true,
      value: async function (...args) {
        try {
          const result = await original.apply(this, args)
          if (result?.error || result?.status === 'failed' || (result?.retcode && Number(result.retcode) !== 0)) throw new Error('agent_delivery_failed')
          turn.delivery.sentCount++
          if (result?.message_id !== undefined && result.message_id !== null) (e._promptCacheDeliveryIds ||= []).push(result.message_id)
          turn.delivery.status = turn.delivery.failedCount ? 'partial' : 'sent'
          return result
        } catch (error) {
          turn.delivery.failedCount++
          turn.delivery.status = turn.delivery.sentCount ? 'partial' : 'failed'
          throw error
        }
      } })
  } catch { return () => {} }
  return () => { if (descriptor) Object.defineProperty(e, 'reply', descriptor); else delete e.reply }
}

export const agentLoopMethods = {
  async processAgentTurn(e, session, senderRole) {
    const turn = session.cacheTurn
    const config = turn.apiConfig
    const controls = turn.agentControls
    const configured = Number(config.maxToolRounds)
    const limit = Number.isFinite(configured) && configured >= 1 ? Math.floor(configured) : 5
    const maxRequests = limit + 2
    turn.maxPhysicalAttempts = 2 * maxRequests
    let requests = 0
    let toolRounds = 0
    let recoveryUsed = false
    let autonomousUsed = 0
    const sideEffects = new Set()
    const completed = new Set()
    const results = []
    const messages = [...turn.agentBase]
    const baseTokens = turn.baseTokens ?? tokenEstimate(turn.agentBase) + tokenEstimate(turn.header.tools)
    const restoreReply = captureReplies(e, turn)
    const end = reason => {
      turn.exitReason = reason
      session.toolResults = results
      cacheDiagnostic(config, 'agent_exit', { groupId: turn.scope.groupId, turnId: turn.turnId, reason, requests, toolRounds,
        physicalAttempts: turn.physicalAttempts || 0, executed: results.filter(result => result._executed).length })
    }
    const fallback = async (reason, text) => {
      turn.noteFinalAssistant({ role: 'assistant', content: text })
      await this.handleTextResponse(text, e, session, messages, session.toolName)
      end(reason)
    }
    try {
      while (requests < maxRequests) {
        if (baseTokens + tokenEstimate(messages.slice(turn.agentBase.length)) + turn.settings.reserveTokens > turn.settings.highWater) {
          await fallback('context_overflow', '这次返回的内容太多，我先停在这里。')
          return
        }
        requests++
        const request = this.buildRequestData(messages, turn.header.tools, 'auto', turn)
        const response = await this.retryRequest(request, null, 0)
        const message = response?.choices?.[0]?.message
        if (!message) { end('api_error'); return }
        if (message.tool_calls && !Array.isArray(message.tool_calls)) {
          if (recoveryUsed) { end('malformed_calls'); return }
          recoveryUsed = true
          continue
        }
        if (message.tool_calls?.length) {
          if (!validBatch(message.tool_calls)) {
            cacheDiagnostic(config, 'agent_malformed_calls', { groupId: turn.scope.groupId, turnId: turn.turnId })
            if (recoveryUsed) { end('malformed_calls'); return }
            recoveryUsed = true
            continue
          }
          const assistant = agentAssistantRow(message)
          messages.push(assistant)
          const exhausted = toolRounds >= limit
          let reservedRound = false
          // Reserve action limits before concurrent dispatch, but return receipts in call order.
          const pending = assistant.tool_calls.map(async call => {
            const name = call.function.name
            const rejected = error => ({ toolCall: call, toolName: name, result: error, _executed: false })
            if (exhausted) return rejected('error: tool execution budget exhausted; reply naturally without new actions')
            let params
            try { params = JSON.parse(call.function.arguments) } catch { return rejected('error: invalid JSON arguments') }
            if (!params || typeof params !== 'object' || Array.isArray(params)) return rejected('error: tool arguments must be an object')
            const error = agentCallPolicyError(controls, name, params, autonomousUsed)
            if (error) return rejected(error)
            const category = controls.categories[name] || 'effect'
            if (category !== 'read' && category !== 'wait') {
              const key = cacheFingerprint({ name, params: canonicalParams(params) })
              if (sideEffects.has(key)) return rejected('error: duplicate action skipped; do not repeat it')
              sideEffects.add(key)
            }
            if (category === 'light' && !controls.explicitTools.includes(name) && controls.policy !== 'legacy') autonomousUsed++
            if (!reservedRound) { toolRounds++; reservedRound = true }
            let hardTimeout
            try {
              // 硬熔断兜底：个别工具内部裸 fetch 挂死时（如改图上游连接不断开），
              // 不让整轮对话无限等。超时后底层调用仍在后台进行，结果被丢弃。
              const run = Promise.resolve(this.runToolCall(call, e, session, senderRole))
              const result = await Promise.race([
                run,
                new Promise((_, fail) => { hardTimeout = setTimeout(() => fail(new Error('tool_hard_timeout')), 600_000) })
              ])
              return result || rejected('error: tool dispatch returned no result')
            } catch (error) {
              if (error?.message === 'tool_hard_timeout') return rejected('error: tool timed out after 10 minutes; wrap up naturally and do not retry immediately')
              return rejected('error: tool dispatch failed; do not automatically repeat the action')
            } finally { clearTimeout(hardTimeout) }
          })
          const batch = await Promise.all(pending)
          results.push(...batch)
          session.toolResults = results
          session.toolName = batch.at(-1)?.toolName
          const receipts = batch.map(result => ({ role: 'tool', tool_call_id: result.toolCall.id, name: result.toolName, content: result.result }))
          const terminal = batch.every(result => result._executed && result._terminal && !isToolResultError(result.result))
          if (toolRounds >= limit && reservedRound && !terminal) receipts.at(-1).content += `\n【插件执行状态 所属轮次:${turn.turnId}】工具执行预算已用完，只能自然收口，不得提出新动作。`
          messages.push(...receipts)
          validateToolRows(messages)
          turn.captureAgent(messages)
          const executed = batch.filter(result => result._executed)
          if (executed.length && this.recordToolHistoryBatch) {
            this.recordToolHistoryBatch({ groupId: e.group_id, messageId: e.message_id || null,
              items: executed.map(result => ({ toolName: result.toolName, result: result.result })) }).catch(error => globalThis.logger?.warn?.(error.message))
          }
          for (const result of executed) if (!isToolResultError(result.result)) completed.add(result.toolName)
          cacheDiagnostic(config, 'agent_tools', { groupId: turn.scope.groupId, turnId: turn.turnId, proposed: batch.length,
            executed: executed.length, denied: batch.length - executed.length, round: toolRounds })
          if (terminal) { end('terminal'); return }
          if (exhausted) {
            if (recoveryUsed || requests >= maxRequests) { await fallback('tool_budget', '这次先处理到这里，还有部分没完成。'); return }
            recoveryUsed = true
          }
          continue
        }
        const content = typeof message.content === 'string' ? message.content : ''
        const missing = controls.requiredTools.filter(name => !completed.has(name))
        const output = content ? this.processToolSpecificMessage(content, session.toolName) : ''
        if (missing.length && content) {
          if (recoveryUsed || requests >= maxRequests) { await fallback('required_tool_unmet', '这次操作还没完成。'); return }
          recoveryUsed = true
          messages.push(agentAssistantRow(message), { role: 'user', content: `【插件本轮纠正 所属轮次:${turn.turnId}】当前必需操作 ${missing.join(', ')} 尚未成功执行。不能声称已经完成，请使用已允许的原生工具处理当前目标。` })
          turn.captureAgent(messages)
          continue
        }
        if (output && !missing.length) {
          turn.noteFinalAssistant(message)
          await this.handleTextResponse(content, e, session, messages, session.toolName)
          end(turn.delivery.failedCount && !turn.delivery.sentCount ? 'reply_failed' : 'text')
          return
        }
        if (recoveryUsed) { end(missing.length ? 'required_tool_unmet' : 'empty'); return }
        recoveryUsed = true
      }
      await fallback('request_budget', '这次先处理到这里，还有部分没完成。')
    } catch (error) {
      end(turn.delivery.failedCount && !turn.delivery.sentCount ? 'reply_failed' : 'exception')
      throw error
    } finally {
      restoreReply()
      turn.delivery.messageIds = [...new Set((e._promptCacheDeliveryIds || []).map(String))]
    }
  }
}
