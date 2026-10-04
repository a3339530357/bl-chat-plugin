// API 客户端入口：YTapi（主对话/工具调用双阶段）与 callAI（通用子系统调用）。
// 格式转换 / 传输 / 响应解析已拆至 utils/api/*，本文件只保留编排逻辑。
import { removeToolPromptsFromMessages } from "../utils/textUtils.js"
import { cacheRequestContext } from '../core/cacheTurn.js'
import { cacheDiagnostic, cacheFingerprint, tokenEstimate, promptCacheSettings, freezeWire } from '../core/promptCache.js'
import {
    detectApiFormat,
    applyClaudeCodeHeaders,
    convertToAnthropicFormat,
    convertFromAnthropicFormat
} from "./api/anthropicFormat.js"
import { fetchWithThinkingFallback } from "./api/transport.js"
import {
    handleStreamResponseUnified,
    parseSSETextUnified,
    parseAgentSSEText,
    processResponse
} from "./api/responseParsing.js"
import {
    convertToolMessagesForChat,
    moveFinalToolPromptToEnd
} from "./api/chatMessageAdapters.js"

// logger 引用（假设全局可用，否则需要 import）
const logger = global.logger || console;

/**
 * 构造正式聊天模型请求，保留上游已经确定的采样参数。
 * 工具定义由工具模型处理，不传给正式聊天模型。
 */
export function buildChatRequestData(requestData, model, messages) {
    const result = {
        model,
        messages,
        stream: false
    }

    if (requestData?.temperature !== undefined) result.temperature = requestData.temperature
    if (requestData?.top_p !== undefined) result.top_p = requestData.top_p
    return result
}

/**
 * 工具模型只负责选择动作和生成结构化参数，使用比最终聊天更稳定的采样参数。
 */
export function buildToolRequestData(requestData, model) {
    return {
        ...requestData,
        model,
        temperature: 0.3,
        top_p: 0.9,
        stream: false
    }
}

export function resolveAgentRoute(config, scope = {}) {
    const chat = config.chatAiConfig || {}
    const keys = (Array.isArray(chat.chatApiKey) ? chat.chatApiKey : [chat.chatApiKey])
        .filter(key => typeof key === 'string' && key.trim())
    if (!chat.chatApiUrl || !chat.chatApiModel || !keys.length) throw new Error('agent_route_not_configured')
    const url = new URL(chat.chatApiUrl)
    if (!['http:', 'https:'].includes(url.protocol) || detectApiFormat(url.href) !== 'openai') throw new Error('agent_route_not_supported')
    const pathname = url.pathname.replace(/\/+$/, '')
    if (!pathname.endsWith('/chat/completions')) url.pathname = pathname.endsWith('/v1') ? `${pathname}/chat/completions` : `${pathname}/v1/chat/completions`
    const index = parseInt(cacheFingerprint(`${scope.botId}:${scope.groupId}:${scope.dayKey}`).slice(0, 8), 16) % keys.length
    const settings = promptCacheSettings(config)
    return freezeWire({ url: url.href, model: chat.chatApiModel, key: keys[index], temperature: settings.agentTemperature,
        top_p: settings.agentTopP, fingerprint: cacheFingerprint({ url: url.href, model: chat.chatApiModel, key: keys[index] }) })
}

export async function callChatCompletionOnce(requestData, config, turn = null) {
    const route = turn?.route || resolveAgentRoute(config, turn?.scope)
    if (turn) turn.route = route
    const body = { model: route.model, messages: requestData.messages, temperature: route.temperature, top_p: route.top_p, stream: false }
    if (config.useTools && (turn?.header.tools || requestData.tools)?.length) {
        body.tools = turn?.header.tools || requestData.tools
        body.tool_choice = 'auto'
    }
    if (requestData.max_tokens !== undefined) body.max_tokens = requestData.max_tokens
    const redact = value => String(value || '').split(route.key).join('[redacted]').slice(0, 400)
    for (let attempt = 1; attempt <= 2; attempt++) {
        if (turn && (turn.physicalAttempts || 0) >= (turn.maxPhysicalAttempts || Infinity)) return { error: 'agent_attempt_budget_exhausted' }
        if (turn) turn.physicalAttempts = (turn.physicalAttempts || 0) + 1
        const started = Date.now()
        let response
        let data
        let error
        let transportFailed = false
        try {
            const result = await fetchWithThinkingFallback(route.url, { Authorization: `Bearer ${route.key}`, 'Content-Type': 'application/json' }, body)
            response = result.response
            if (!response.ok) error = `agent_http_${response.status}: ${redact(result.errorText)}`
            else {
                const raw = await response.text()
                try { data = JSON.parse(raw) } catch {
                    if (raw.includes('data:')) data = parseAgentSSEText(raw)
                    else error = 'agent_invalid_json'
                }
                if (!error && !data?.choices?.[0]?.message) error = data?.error ? redact(data.error.message || data.error) : 'agent_invalid_response'
            }
        } catch (caught) {
            transportFailed = true
            error = `agent_transport_${caught.code || caught.name || 'failed'}`
        }
        if (turn) {
            const usage = data?.usage || {}
            const record = { stage: 'agent', groupId: turn.scope.groupId, turnId: turn.turnId, attempt,
                model: response?.headers?.get('x-mapped-model') || route.model,
                account: response?.headers?.get('x-account-email') ? cacheFingerprint(response.headers.get('x-account-email')).slice(0, 12) : null,
                gatewaySession: response?.headers?.get('x-session-id') || null,
                input: usage.prompt_tokens ?? usage.input_tokens ?? null,
                cached: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null,
                output: usage.completion_tokens ?? usage.output_tokens ?? null,
                status: response?.status ?? null, durationMs: Date.now() - started, error: error || null }
            turn.requests.push(record)
            cacheDiagnostic(config, 'request', record)
        }
        if (!error) return processResponse(data)
        if (!transportFailed || attempt === 2) return { error }
    }
}

/**
 * 发送请求到 OpenAI API 或其他提供者并处理响应
 * @param {Object} requestData - 请求体数据
 * @param {Object} config - 配置对象
 * @returns {Object|null} - 返回处理后的响应数据或错误信息
 */
export async function YTapi(requestData, config, toolContent, toolName) {
    const provider = config.providers?.toLowerCase();
    const cacheTurn = cacheRequestContext(requestData)
    if (cacheTurn?.mode === 'agent') return callChatCompletionOnce(requestData, cacheTurn.apiConfig || config, cacheTurn)
    const pendingObservations = new Map()
    const beginObservation = (stage, started) => {
        if (!cacheTurn) return
        const record = { stage, started, reported: false }
        pendingObservations.set(stage, record)
    }
    const observe = (stage, data, response, started) => {
        if (!cacheTurn) return
        const pending = pendingObservations.get(stage)
        if (!pending || pending.reported) return
        pending.reported = true
        const usage = data?.usage || {}
        const record = {
            stage, groupId: cacheTurn.scope.groupId, turnId: cacheTurn.turnId,
            model: response?.headers?.get('x-mapped-model') || (stage === 'tools' ? config.toolsAiConfig.toolsAiModel : config.chatAiConfig.chatApiModel),
            account: response?.headers?.get('x-account-email') ? cacheFingerprint(response.headers.get('x-account-email')).slice(0, 12) : null,
            gatewaySession: response?.headers?.get('x-session-id') || null,
            input: usage.prompt_tokens ?? usage.input_tokens ?? null,
            cached: usage.prompt_tokens_details?.cached_tokens ?? usage.input_tokens_details?.cached_tokens ?? null,
            output: usage.completion_tokens ?? usage.output_tokens ?? null,
            status: response?.status ?? null, durationMs: Date.now() - started
        }
        cacheTurn.requests.push(record)
        cacheDiagnostic(config, 'request', record)
    }

    try {
        let url, headers, finalRequestData;
        if (cacheTurn?.settings.diagnostics && tokenEstimate(requestData.messages) + tokenEstimate(requestData.tools || []) + cacheTurn.settings.reserveTokens > cacheTurn.settings.highWater) {
            // The watermark limits retained history, not mandatory results of the live turn.
            cacheDiagnostic(config, 'live_turn_budget_overrun', { groupId: cacheTurn.scope.groupId, turnId: cacheTurn.turnId })
        }

        if (config.useTools) {
            // useTools 开启，先调用工具 API
            const toolsUrl = `${config.toolsAiConfig.toolsAiUrl}`;
            // 确保配置了 API key
            if (!config.toolsAiConfig.toolsAiApikey) return { error: "工具 AI Token 未配置" };

            const toolsApiFormat = detectApiFormat(toolsUrl)
            const toolsHeaders = {
                'Authorization': `Bearer ${config.toolsAiConfig.toolsAiApikey}`,
                'Content-Type': 'application/json'
            };

            if (toolsApiFormat === 'anthropic') {
                applyClaudeCodeHeaders(toolsHeaders)
            }

            let toolsResponse;
            const toolsStarted = Date.now()
            try {
                // 保留原始请求中的 tools 字段
                let toolsRequestData = buildToolRequestData(
                    requestData,
                    config.toolsAiConfig.toolsAiModel
                );
                logger.debug("工具调用上下文：",JSON.stringify(toolsRequestData));
                // 根据格式转换请求
                if (toolsApiFormat === 'anthropic') {
                    try {
                        toolsRequestData = convertToAnthropicFormat(toolsRequestData, requestData)
                    } catch (convertError) {
                        logger.error('[Anthropic] 请求格式转换失败:', convertError)
                        return { error: `请求格式转换失败：${convertError.message}` }
                    }
                }

                beginObservation('tools', toolsStarted)
                const toolsResult = await fetchWithThinkingFallback(toolsUrl, toolsHeaders, toolsRequestData);
                toolsResponse = toolsResult.response;

                if (!toolsResponse.ok) {
                    observe('tools', null, toolsResponse, toolsStarted)
                    logger.error(`工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${toolsResult.errorText}`);
                    return { error: `工具 API 请求失败：${toolsResponse.status} ${toolsResponse.statusText} - ${toolsResult.errorText}` };
                }
            } catch (toolsFetchError) {
                logger.error("工具 API 请求失败:", toolsFetchError);
                return { error: `工具 API 请求失败：${toolsFetchError.message}` };
            }

            let toolsData;
            const toolsRawText = await toolsResponse.text();
            try {
                toolsData = JSON.parse(toolsRawText);
                logger.debug('工具 API 响应:', JSON.stringify(toolsData, null, 2));
            } catch (toolsJsonError) {
                // 工具 API 强制返回 SSE 的兜底
                if (toolsRawText.includes('data: ')) {
                    logger.debug('工具 API 响应是 SSE 格式，降级解析')
                    toolsData = parseSSETextUnified(toolsRawText, toolsApiFormat)
                    if (toolsData?.error) {
                        return toolsData
                    }
                } else {
                    logger.error("解析工具 API 响应失败:", toolsJsonError, toolsRawText.slice(0, 200));
                    return { error: `解析工具 API 响应失败：${toolsJsonError.message}` };
                }
            }

            // 转换 Anthropic 响应为 OpenAI 格式
            if (toolsApiFormat === 'anthropic') {
                try {
                    toolsData = convertFromAnthropicFormat(toolsData)
                } catch (convertError) {
                    logger.error('[Anthropic] 响应格式转换失败:', convertError)
                    return { error: `响应格式转换失败：${convertError.message}` }
                }
            }

            // 验证转换后的格式
            observe('tools', toolsData, toolsResponse, toolsStarted)
            if (toolsData && !toolsData.choices?.[0]?.message) {
                logger.warn('[API] 工具 API 响应格式转换后无效，降级到 OneAPI')
                // 继续执行降级逻辑，不返回错误
            } else {
                // 检查是否包含 tool_calls，无论 finish_reason 是什么
                const hasToolCalls = toolsData?.choices?.[0]?.message?.tool_calls?.length > 0;
                if (hasToolCalls) {
                    // 直接返回 tool_calls 响应
                    return processResponse(toolsData);
                }
            }

            // 检查 OneAPI 配置
            if (!config.chatAiConfig.chatApiUrl || !config.chatAiConfig.chatApiModel || !config.chatAiConfig.chatApiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }

            // 智能 URL 处理：Anthropic 格式直接使用，OpenAI 格式自动拼接端点
            const chatApiFormat = detectApiFormat(config.chatAiConfig.chatApiUrl);
            if (chatApiFormat === 'anthropic') {
                url = config.chatAiConfig.chatApiUrl;
            } else {
                // OpenAI 格式：如果 URL 不包含完整端点，自动拼接
                url = config.chatAiConfig.chatApiUrl.includes('/v1/chat/completions')
                    ? config.chatAiConfig.chatApiUrl
                    : `${config.chatAiConfig.chatApiUrl.replace(/\/$/, '')}/v1/chat/completions`;
            }

            const oneApiKey = Array.isArray(config.chatAiConfig.chatApiKey)
                ? config.chatAiConfig.chatApiKey[Math.floor(Math.random() * config.chatAiConfig.chatApiKey.length)]
                : config.chatAiConfig.chatApiKey;
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };

            finalRequestData = buildChatRequestData(
                requestData,
                config.chatAiConfig.chatApiModel,
                cacheTurn ? cacheTurn.chatMessages() : convertToolMessagesForChat(requestData.messages, toolName)
            );
        } else {
            // useTools 关闭，直接使用 OneAPI
            if (!config.chatAiConfig.chatApiUrl || !config.chatAiConfig.chatApiModel || !config.chatAiConfig.chatApiKey?.length) {
                return { error: "OneAPI URL、模型或 API Key 未配置" };
            }

            // 智能 URL 处理：Anthropic 格式直接使用，OpenAI 格式自动拼接端点
            const chatApiFormat = detectApiFormat(config.chatAiConfig.chatApiUrl);
            if (chatApiFormat === 'anthropic') {
                url = config.chatAiConfig.chatApiUrl;
            } else {
                // OpenAI 格式：如果 URL 不包含完整端点，自动拼接
                url = config.chatAiConfig.chatApiUrl.includes('/v1/chat/completions')
                    ? config.chatAiConfig.chatApiUrl
                    : `${config.chatAiConfig.chatApiUrl.replace(/\/$/, '')}/v1/chat/completions`;
            }

            const oneApiKey = config.chatAiConfig.chatApiKey[Math.floor(Math.random() * config.chatAiConfig.chatApiKey.length)];
            headers = {
                'Authorization': `Bearer ${oneApiKey}`,
                'Content-Type': 'application/json'
            };
            finalRequestData = buildChatRequestData(
                requestData,
                config.chatAiConfig.chatApiModel,
                cacheTurn ? cacheTurn.chatMessages() : requestData.messages
            );
        }

        // 发送 API 请求

        if (!url || !headers || !finalRequestData) {
            return { error: "缺少必要的请求参数（URL、headers 或请求体）" };
        }

        const apiFormat = detectApiFormat(url)
        let response;

        // 判断消息里是否有工具执行记录(用于决定是否给对话模型收尾提示)
        const hasExecutedTools = finalRequestData.messages?.some(m =>
            m.role === 'system' && String(m.content || '').includes('[tool_execution]')
        )

        // 根据 API 格式处理请求体
        if (apiFormat === 'openai') {
            if (url.includes('v1/chat/completions') && typeof finalRequestData === 'object' && finalRequestData !== null) {
                delete finalRequestData.tools;
                delete finalRequestData.tool_choice;
            }
            if (!cacheTurn) {
                finalRequestData.messages = moveFinalToolPromptToEnd(
                    removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages, hasExecutedTools)
                )
            }
        } else if (apiFormat === 'anthropic') {
            // Anthropic 格式转换
            // 注意：对话 API 不传递 tools，避免模型参与工具调用判断
            try {
                // 与 OpenAI 路径保持一致：先清洗 system 里的工具提示词、把最终工具提示移到末尾，再转换格式
                finalRequestData.messages = moveFinalToolPromptToEnd(
                    removeToolPromptsFromMessages(finalRequestData.messages || requestData.messages, hasExecutedTools)
                )
                // 第二个参数传 finalRequestData（不含 tools），而不是 requestData
                finalRequestData = convertToAnthropicFormat(finalRequestData, finalRequestData)
            } catch (convertError) {
                logger.error('[Anthropic] 请求格式转换失败:', convertError)
                return { error: `请求格式转换失败：${convertError.message}` }
            }
            applyClaudeCodeHeaders(headers)
        }

        logger.debug('最终请求体:', finalRequestData);
        const chatStarted = Date.now()
        try {
            beginObservation('chat', chatStarted)
            const result = await fetchWithThinkingFallback(url, headers, finalRequestData);
            response = result.response;

            if (!response.ok) {
                observe('chat', null, response, chatStarted)
                logger.error(`API 请求失败：${response.status} ${response.statusText} - ${result.errorText}`);
                return { error: `API 请求失败：${response.status} ${response.statusText} - ${result.errorText}` };
            }
        } catch (fetchError) {
            logger.error(`${provider || 'API'} 请求失败:`, fetchError);
            return { error: `${provider || 'API'} 请求失败：${fetchError.message}` };
        }

        let responseData;
        // 先读 text，再判断是 JSON 还是 SSE（兜底某些中转强制返回流式）
        const rawText = await response.text();
        try {
            responseData = JSON.parse(rawText);
            logger.debug(`${provider || 'API'} 响应:`, JSON.stringify(responseData, null, 2));
        } catch (jsonError) {
            // JSON 解析失败，尝试当作 SSE 文本解析
            if (rawText.includes('data: ')) {
                logger.debug(`${provider || 'API'} 响应是 SSE 格式，降级解析`)
                responseData = parseSSETextUnified(rawText, apiFormat)
                if (responseData?.error) {
                    return responseData
                }
                observe('chat', responseData, response, chatStarted)
                // SSE 解析后已经是 OpenAI 格式，不需要再走 Anthropic 转换
                return processResponse(responseData)
            }
            logger.error(`解析 ${provider || 'API'} 响应失败:`, jsonError, rawText.slice(0, 200));
            return { error: `解析 ${provider || 'API'} 响应失败：${jsonError.message}` };
        }

        // 根据 API 格式转换响应
        if (apiFormat === 'anthropic') {
            try {
                responseData = convertFromAnthropicFormat(responseData)
            } catch (convertError) {
                logger.error('[Anthropic] 响应格式转换失败:', convertError)
                return { error: `响应格式转换失败：${convertError.message}` }
            }

            // 验证转换后的格式完整性
            if (!responseData?.choices?.[0]?.message) {
                logger.error('[Anthropic] 响应转换后格式无效:', responseData)
                return { error: 'API 响应转换失败，格式不完整' }
            }
        }

        observe('chat', responseData, response, chatStarted)
        return processResponse(responseData);

    } catch (error) {
        logger.error('YTapi 异常:', error);
        return { error: `发生异常：${error.message}` };
    } finally {
        for (const [stage, pending] of pendingObservations) {
            if (!pending.reported) observe(stage, null, null, pending.started)
        }
    }
}

/**
 * 通用 AI API 调用函数
 * 自动检测 API 格式（OpenAI/Anthropic），转换请求和响应，支持流式和非流式
 *
 * @param {Object} config - API 配置 { url, model, apikey }
 * @param {Array} messages - OpenAI 格式的消息数组
 * @param {Object} options - 可选参数
 * @param {number} [options.maxTokens] - 最大 token 数
 * @param {number} [options.temperature] - 温度参数
 * @param {Array} [options.tools] - 工具定义（OpenAI 格式）
 * @param {boolean} [options.stream] - 是否流式响应
 * @param {AbortSignal} [options.signal] - 用于取消请求的 AbortSignal
 * @param {Object} [options.additionalParams] - 其他额外的请求体参数
 * @returns {Promise<Object>} 返回 OpenAI 格式的响应对象，或 { error: string }
 */
export async function callAI(config, messages, options = {}) {
    const {
        maxTokens,
        temperature,
        tools,
        stream = false,
        signal,
        additionalParams = {}
    } = options

    // 验证配置
    if (!config?.url || !config?.model || !config?.apikey) {
        return { error: 'API 配置不完整，需要 url、model、apikey' }
    }

    // 检测 API 格式
    const apiFormat = detectApiFormat(config.url)

    try {
        // 构建请求头
        const headers = {
            'Authorization': `Bearer ${config.apikey}`,
            'Content-Type': 'application/json'
        }

        // 构建基础请求体（OpenAI 格式）
        let requestData = {
            model: config.model,
            messages: messages,
            stream: stream,
            ...additionalParams
        }

        if (maxTokens !== undefined) requestData.max_tokens = maxTokens
        if (temperature !== undefined) requestData.temperature = temperature
        if (tools && tools.length > 0) requestData.tools = tools

        // 根据格式转换请求
        if (apiFormat === 'anthropic') {
            // 应用 Claude Code 请求头（伪装为官方 CLI）
            applyClaudeCodeHeaders(headers)

            // 转换为 Anthropic 格式（自动添加 system 身份串、metadata、thinking 等伪装字段）
            try {
                requestData = convertToAnthropicFormat(requestData, requestData)
            } catch (convertError) {
                logger.error('[callAI] Anthropic 请求格式转换失败:', convertError)
                return { error: `请求格式转换失败：${convertError.message}` }
            }
        }

        // 发送请求（signal 单独传递，不进 body）
        const result = await fetchWithThinkingFallback(config.url, headers, requestData, signal)
        const response = result.response

        if (!response.ok) {
            logger.error(`[callAI] API 请求失败：${response.status} ${response.statusText} - ${result.errorText}`)
            return { error: `API 请求失败：${response.status} ${response.statusText}` }
        }

        // 处理流式响应
        // - 用户主动传 stream: true 时，走真正的流式 reader（必要时模型可以早返回）
        // - 服务端返回 SSE Content-Type 但用户没传 stream:true 时，body 可能不是 ReadableStream
        //   （部分 fetch 实现/中转代理会先缓存完整响应），统一走 text() 兜底解析更稳
        const contentType = response.headers.get('content-type') || ''
        const isSSE = contentType.includes('text/event-stream') || contentType.includes('stream')

        if (stream) {
            // 用户主动流式：走真正的流式 reader
            return handleStreamResponseUnified(response, apiFormat)
        }

        if (isSSE) {
            // 服务端强返 SSE：先读 text 再解析，避免 body.getReader 不可用的兼容性问题
            const sseText = await response.text()
            return parseSSETextUnified(sseText, apiFormat)
        }

        // 处理非流式响应：先读 text，再判断是 JSON 还是 SSE（兜底）
        // 某些服务端会忽略 stream:false 强制返回 SSE，且 content-type 可能不准确
        const rawText = await response.text()
        let responseData
        try {
            responseData = JSON.parse(rawText)
        } catch {
            // JSON 解析失败，尝试当作 SSE 文本解析
            if (rawText.includes('data: ')) {
                return parseSSETextUnified(rawText, apiFormat)
            }
            logger.error('[callAI] 解析响应失败，既不是 JSON 也不是 SSE:', rawText.slice(0, 200))
            return { error: `解析响应失败：响应格式无法识别` }
        }

        // 转换 Anthropic 响应为 OpenAI 格式
        if (apiFormat === 'anthropic') {
            try {
                responseData = convertFromAnthropicFormat(responseData)
            } catch (convertError) {
                logger.error('[callAI] Anthropic 响应格式转换失败:', convertError)
                return { error: `响应格式转换失败：${convertError.message}` }
            }
        }

        return processResponse(responseData)

    } catch (error) {
        logger.error('[callAI] 调用异常:', error)
        return { error: `调用异常：${error.message}` }
    }
}
