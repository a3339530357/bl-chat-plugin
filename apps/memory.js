import { getSharedState } from "../core/sharedState.js"
import common from "../../../lib/common/common.js"
import { memorySourceStore } from "../utils/memory/MemorySourceStore.js"
import { memorySourceStatusLines } from "../utils/memory/sourceStatus.js"
import { botIdForEvent } from "../core/promptCache.js"
import { memoryStoreV3 } from "../utils/memory/MemoryStoreV3.js"

/**
 * 记忆管理命令插件：查看 / 搜索 / 删除 / 清空 / 启停长期记忆。
 * 数据由 core/sharedState 的 memoryManager 提供（由对话主插件初始化），
 * 这里通过 getter 懒加载，避免 apps 加载顺序问题。
 * priority 9998：先于对话主插件（9999）处理命令，与拆分前
 * "命令规则排在万能触发规则之前"的语义一致。
 */
export class MemoryCommands extends plugin {
  constructor() {
    super({
      name: "记忆管理",
      dsc: "长期记忆查看与管理命令",
      event: "message",
      priority: 9998,
      rule: [
        { reg: "^#记忆(待确认|证据|确认|驳回|修正|撤销修订|删除条目)(?:\\s+[\\s\\S]+)?$", fnc: "manageV3", permission: "master" },
        { reg: "^#记忆状态$", fnc: "memoryStatus" },
        { reg: "^#我的记忆$", fnc: "listMyMemory" },
        { reg: "^#群记忆$", fnc: "listGroupMemory" },
        { reg: "^#搜索记忆\\s+[\\s\\S]+$", fnc: "searchMemory" },
        { reg: "^#删除记忆\\s+\\S+$", fnc: "deleteMemory" },
        { reg: "^#清空我的记忆$", fnc: "clearMyMemory" },
        { reg: "^#清空群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#清除群记忆$", fnc: "clearGroupMemory" },
        { reg: "^#禁用我的记忆$", fnc: "disableMyMemory" },
        { reg: "^#启用我的记忆$", fnc: "enableMyMemory" }
      ]
    })
  }

  get memoryManager() {
    return getSharedState()?.memoryManager
  }

  async manageV3(e) {
    if (!e.isMaster || !e.group_id) { await e.reply("请由主人在目标群使用此命令"); return true }
    const store = getSharedState()?.memoryStoreV3 || memoryStoreV3
    const scope = store.scope(botIdForEvent(e), e.group_id)
    try {
      const [, command, id, body] = e.msg.match(/^#记忆(\S+)(?:\s+(\S+))?(?:\s+([\s\S]+))?$/) || []
      const state = await store.snapshot(scope)
      if (command === '待确认') {
        const lines = Object.values(state.review).filter(item => item.status === 'pending').map(item => `${item.id}\n${item.candidate.text}\n原因：${item.reason}`)
        await e.reply(lines.length ? lines.join('\n\n').slice(0, 12000) : '暂无待确认记忆')
      } else if (command === '证据') {
        const item = state.facts[id] || state.events[id] || state.review[id]
        if (!item) throw new Error('memory_object_missing')
        await e.reply(JSON.stringify((item.evidenceIds || []).map(key => state.evidence[key]), null, 2).slice(0, 12000))
      } else {
        const actions = { 确认: 'confirm', 驳回: 'reject', 修正: 'edit', 撤销修订: 'undo', 删除条目: 'delete' }
        await store.manage(scope, { action: actions[command], id, patch: body ? JSON.parse(body) : undefined, actorId: e.user_id, isMaster: e.isMaster })
        await e.reply('记忆已更新')
      }
    } catch (error) { await e.reply(`记忆操作失败：${error.message}`) }
    return true
  }

  isGroupMemoryAdmin(e) {
    return Boolean(e.isMaster || ["owner", "admin"].includes(e.sender?.role))
  }

  formatMemoryTime(timestamp) {
    if (!timestamp) return "无"
    return new Date(timestamp).toLocaleString("zh-CN", { timeZone: "Asia/Shanghai" })
  }

  formatMemoryFactLines(facts = []) {
    return facts.map(fact => {
      const shortId = String(fact.id).slice(0, 8)
      const score = Number(fact.score ?? fact.importance ?? 0).toFixed(2)
      return `ID:${shortId} [${fact.category}] ${fact.content} (${score})`
    })
  }

  formatMemoryFacts(title, facts = []) {
    if (!facts.length) return `${title}\n暂无记忆`
    const lines = this.formatMemoryFactLines(facts)
    return `${title}\n${lines.join("\n")}\n\n删除单条记忆可发送：#删除记忆 <ID>`.slice(0, 4500)
  }

  async replyMemoryForward(e, title, sections = []) {
    const msgs = []
    for (const section of sections) {
      const facts = section.facts || []
      if (!facts.length) {
        msgs.push(`${section.title}\n暂无记忆`)
        continue
      }

      const lines = this.formatMemoryFactLines(facts)
      for (let i = 0; i < lines.length; i += 12) {
        const page = Math.floor(i / 12) + 1
        const total = Math.ceil(lines.length / 12)
        const header = total > 1 ? `${section.title} (${page}/${total})` : section.title
        msgs.push(`${header}\n${lines.slice(i, i + 12).join("\n")}`)
      }
    }

    msgs.push("删除单条记忆可发送：#删除记忆 <ID>")

    try {
      const forwardMsg = await common.makeForwardMsg(e, msgs, title)
      await e.reply(forwardMsg)
    } catch (error) {
      logger.warn("[记忆管理] 转发消息发送失败，回退为普通文本:", error)
      await e.reply(msgs.join("\n\n").slice(0, 4500))
    }
  }

  async memoryStatus(e) {
    try {
      const status = await this.memoryManager.adminStatus({
        groupId: e.group_id,
        userId: e.user_id
      })
      const lines = [
        `记忆系统：${status.enabled ? "开启" : "关闭"}`,
        `用户记忆：${status.user?.disabled ? "已禁用" : "启用"}，${status.user?.factCount || 0} 条，关系分 ${Number(status.user?.relationshipScore ?? 0.5).toFixed(2)}`,
        `群记忆：${status.group?.disabled ? "已禁用" : "启用"}，${status.group?.factCount || 0} 条`,
        `用户上次抽取：${this.formatMemoryTime(status.user?.lastAttemptAt)}`,
        `群上次抽取：${this.formatMemoryTime(status.group?.lastAttemptAt)}`,
        `阈值：${status.config.importanceThreshold}，语义召回：${status.config.semanticRecallEnabled ? "开启" : "关闭"}`
      ]
      if (e.group_id) {
        try {
          lines.push(...memorySourceStatusLines(await memorySourceStore.status(memorySourceStore.scope(botIdForEvent(e), e.group_id))))
        } catch (error) {
          lines.push("记忆原料状态读取失败，旧记忆状态如上")
          logger.warn(`[MemorySource] 状态读取失败: ${error.message}`)
        }
      }
      await e.reply(lines.join("\n"))
    } catch (error) {
      logger.error("[记忆管理] 读取记忆状态失败:", error)
      await e.reply("记忆状态读取失败，请看日志")
    }
    return true
  }

  async listMyMemory(e) {
    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "我的记忆", [
        { title: "我的记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取我的记忆失败:", error)
      await e.reply("读取我的记忆失败，请看日志")
    }
    return true
  }

  async listGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }

    try {
      const result = await this.memoryManager.adminListMemories({
        scope: "group",
        groupId: e.group_id,
        limit: 30
      })
      await this.replyMemoryForward(e, "群记忆", [
        { title: "群记忆", facts: result.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 读取群记忆失败:", error)
      await e.reply("读取群记忆失败，请看日志")
    }
    return true
  }

  async searchMemory(e) {
    const query = String(e.msg || "").replace(/^#搜索记忆\s+/, "").trim()
    if (!query) {
      await e.reply("请输入要搜索的关键词")
      return true
    }

    try {
      const myResult = await this.memoryManager.adminListMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        query,
        limit: 10
      })
      const groupResult = e.group_id
        ? await this.memoryManager.adminListMemories({
            scope: "group",
            groupId: e.group_id,
            query,
            limit: 10
          })
        : { facts: [] }
      await this.replyMemoryForward(e, "搜索记忆", [
        { title: "我的匹配记忆", facts: myResult.facts },
        { title: "群匹配记忆", facts: groupResult.facts }
      ])
    } catch (error) {
      logger.error("[记忆管理] 搜索记忆失败:", error)
      await e.reply("搜索记忆失败，请看日志")
    }
    return true
  }

  async deleteMemory(e) {
    const id = String(e.msg || "").replace(/^#删除记忆\s+/, "").trim()
    if (!id) {
      await e.reply("请输入要删除的记忆 id")
      return true
    }

    try {
      let result = await this.memoryManager.adminDeleteMemory({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id,
        id
      })

      if (!result.deleted && this.isGroupMemoryAdmin(e)) {
        result = await this.memoryManager.adminDeleteMemory({
          scope: "group",
          groupId: e.group_id,
          id
        })
      }

      const failureMessages = {
        "id-too-short": "记忆 ID 至少需要输入前 8 位",
        "ambiguous-id": "这个 ID 前缀匹配到多条记忆，请输入更完整的 ID",
        "not-found": "没有找到可删除的记忆，普通用户只能删除自己的记忆"
      }
      await e.reply(result.deleted
        ? `已删除记忆 ${id}`
        : failureMessages[result.reason] || "没有找到可删除的记忆，普通用户只能删除自己的记忆")
    } catch (error) {
      logger.error("[记忆管理] 删除记忆失败:", error)
      await e.reply("删除记忆失败，请看日志")
    }
    return true
  }

  async clearMyMemory(e) {
    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "user",
        groupId: e.group_id,
        userId: e.user_id
      })
      await e.reply(`已清空我的记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空我的记忆失败:", error)
      await e.reply("清空我的记忆失败，请看日志")
    }
    return true
  }

  async clearGroupMemory(e) {
    if (!e.group_id) {
      await e.reply("请在群聊中使用这个命令")
      return true
    }
    if (!this.isGroupMemoryAdmin(e)) {
      await e.reply("只有群主、管理员或主人可以清空群记忆")
      return true
    }

    try {
      const result = await this.memoryManager.adminClearMemories({
        scope: "group",
        groupId: e.group_id
      })
      await e.reply(`已清空本群群记忆，共 ${result.cleared} 条`)
    } catch (error) {
      logger.error("[记忆管理] 清空群记忆失败:", error)
      await e.reply("清空群记忆失败，请看日志")
    }
    return true
  }

  async disableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: false
      })
      await e.reply("已禁用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 禁用我的记忆失败:", error)
      await e.reply("禁用失败，请看日志")
    }
    return true
  }

  async enableMyMemory(e) {
    try {
      await this.memoryManager.adminSetUserMemoryEnabled({
        groupId: e.group_id,
        userId: e.user_id,
        enabled: true
      })
      await e.reply("已启用你的长期记忆")
    } catch (error) {
      logger.error("[记忆管理] 启用我的记忆失败:", error)
      await e.reply("启用失败，请看日志")
    }
    return true
  }
}
