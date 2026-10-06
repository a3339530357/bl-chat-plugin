import { AbstractTool } from './AbstractTool.js';
import { TotalTokens } from "../../functions/tools/CalculateToken.js";
import fs from "fs";
import YAML from "yaml";
import path from "path";
/**
 * Search 工具类，用于自由搜索并控制返回结果的大小
 */
export class SearchInformationTool extends AbstractTool {
  constructor() {
    super();
    this.name = 'searchInformationTool';
    this.description = '请求外部 API 进行自由搜索，检索结果，对于需要进行搜索或需要实时数据信息的时候使用，总结群聊聊天记录时无需调用';
    this.parameters = {
      type: "object",
      properties: {
        query: {
          type: 'string',
          description: '搜索的查询关键词'
        }
      },
      required: ['query']
    };

    // 固定最大 token 数量为 30000
    this.maxTokens = 30000;
  }

  /**
   * 截断文本以控制 token 数量
   * @param {string} text - 需要截断的文本
   * @returns {Promise<string>} 截断后的文本
   */
  async truncateText(text) {
    if (!text) return '未找到相关搜索结果';

    const tokens = await TotalTokens(text);

    if (tokens.completion_tokens <= this.maxTokens) {
      return text;
    }

    // 如果超出限制，按比例截断文本
    const ratio = this.maxTokens / tokens.completion_tokens;
    const truncatedLength = Math.floor(text.length * ratio);
    const truncated = text.substring(0, truncatedLength);

    return `${truncated}\n\n[注意：结果已截断，显示内容已达到长度限制]`;
  }

  /**
   * 将各种格式的结果转换为字符串
   * @param {any} result - 任意类型的结果
   * @returns {string} 转换后的字符串
   */
  resultToString(result) {
    // logger.error('result', result)
    if (typeof result === 'string') {
      return result;
    }

    if (result === null || result === undefined) {
      return '未找到相关搜索结果';
    }

    if (typeof result === 'object') {
      // 处理常见的结果格式
      if (result.content) {
        return String(result.content);
      }
      if (result.results && Array.isArray(result.results)) {
        return result.results.map((item, index) => {
          if (typeof item === 'string') {
            return `${index + 1}. ${item}`;
          }
          if (item.title && item.content) {
            return `${index + 1}. ${item.title}\n${item.content}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.data.webPages.value && Array.isArray(result.data.webPages.value)) {
        return result.data.webPages.value.map((item, index) => {
          if (typeof item.snippet === 'string') {
            return `${index + 1}. ${item.snippet}`;
          }
          return `${index + 1}. ${JSON.stringify(item)}`;
        }).join('\n\n');
      }
      if (result.message) {
        return String(result.message);
      }
    }

    // 最后的兜底方案
    try {
      return JSON.stringify(result, null, 2);
    } catch {
      return String(result);
    }
  }

  /**
   * 处理搜索操作并返回字符串结果
   * @param {Object} opts - 参数选项
   * @param {Object} e - 事件对象
   * @returns {Promise<string>} 字符串形式的搜索结果
   */
  async func(opts, e) {
    const { query } = opts;

    if (!query?.trim()) {
      return '搜索失败：搜索关键词不能为空';
    }

    try {
      // 配置路径
      const configPath = path.join(process.cwd(), 'plugins/bl-chat-plugin/config/message.yaml');
      const configFile = fs.readFileSync(configPath, 'utf8');
      const config = YAML.parse(configFile).pluginSettings;
      const sc = config.searchAiConfig || {}

      // 智谱 MCP web_search_prime（Coding Plan 套餐内免费；REST 按量端点不通用会报 1113）
      // 曾有百炼 qwen-plus 回退路，账号关停后已移除（2026-10-06）
      const mcp = await this.zhipuMcpSearch(sc, query)
      if (mcp.ok) {
        return mcp.text + '\n\n提示：如果用户想基于搜索结果制作文件，可以使用 aiMindMapTool 工具继续操作。'
      }
      logger.warn(`[searchInformationTool] 搜索失败: ${mcp.error}`)
      return `搜索失败：${mcp.error}（可换个说法再试；部分热点类关键词会触发内容过滤）`

    } catch (error) {
      console.error('搜索过程发生错误:', error);
      return `搜索失败：${error.message || '发生未知错误'}`;
    }
  }

  /**
   * 智谱 MCP web_search_prime 搜索（Coding Plan 套餐内免费）
   * 协议：HTTP MCP —— initialize 拿 Mcp-Session-Id 响应头，再 tools/call，
   * 响应为 SSE 流，结果字符串双层 JSON 编码需解两次。
   * 坑：工具名必须是下划线的 web_search_prime（文档页的 webSearchPrime 会 Tool not found）；
   *     查询词可能触发 1301 内容过滤（isError:true），由调用方回退处理。
   */
  async zhipuMcpSearch(sc, query) {
    const mcpUrl = sc.zhipuMcpUrl || 'https://open.bigmodel.cn/api/mcp/web_search_prime/mcp'
    const apiKey = sc.zhipuApiKey
    if (!apiKey) return { ok: false, error: '未配置 searchAiConfig.zhipuApiKey' }
    const headers = {
      'Authorization': `Bearer ${apiKey}`,
      'Content-Type': 'application/json',
      'Accept': 'application/json, text/event-stream'
    }
    try {
      // 1. initialize 换会话 ID（每次搜索新建会话，量小无需复用）
      const init = await fetch(mcpUrl, {
        method: 'POST', headers,
        body: JSON.stringify({
          jsonrpc: '2.0', id: 0, method: 'initialize',
          params: { protocolVersion: '2025-03-26', capabilities: {}, clientInfo: { name: 'bl-chat-plugin', version: '1.0' } }
        }),
        signal: AbortSignal.timeout(15000)
      })
      const sessionId = init.headers.get('mcp-session-id')
      if (!init.ok || !sessionId) return { ok: false, error: `initialize HTTP ${init.status}` }

      // 2. tools/call 搜索
      const call = await fetch(mcpUrl, {
        method: 'POST', headers: { ...headers, 'Mcp-Session-Id': sessionId },
        body: JSON.stringify({
          jsonrpc: '2.0', id: 2, method: 'tools/call',
          params: { name: 'web_search_prime', arguments: { search_query: query, location: 'cn' } }
        }),
        signal: AbortSignal.timeout(30000)
      })
      if (!call.ok) return { ok: false, error: `tools/call HTTP ${call.status}` }

      // 3. SSE 解析 + 双层 JSON
      const raw = await call.text()
      const dataLine = raw.split('\n').find(l => l.startsWith('data:'))
      if (!dataLine) return { ok: false, error: '响应无 data 行' }
      const payload = JSON.parse(dataLine.slice(5))
      const result = payload?.result
      if (!result || result.isError) {
        return { ok: false, error: (result?.content?.[0]?.text || 'MCP error').slice(0, 120) }
      }
      const text = result.content?.[0]?.text
      if (!text) return { ok: false, error: '结果为空' }
      let results
      try {
        results = JSON.parse(JSON.parse(text))
      } catch {
        try { results = JSON.parse(text) } catch { return { ok: false, error: '结果JSON解析失败' } }
      }
      if (!Array.isArray(results) || !results.length) return { ok: false, error: '搜索结果为空' }

      // 4. 拼成文本喂给主模型
      const lines = results.slice(0, 8).map((r, i) =>
        `[${i + 1}] ${(r.title || '').trim()}\n${(r.content || r.snippet || '').trim()}\n来源: ${r.link || ''}`)
      return { ok: true, text: `联网搜索「${query}」的结果（${results.length} 条，取前 ${Math.min(results.length, 8)} 条）：\n\n${lines.join('\n\n')}` }
    } catch (err) {
      return { ok: false, error: err?.cause?.code || err.message || 'MCP请求异常' }
    }
  }
}
