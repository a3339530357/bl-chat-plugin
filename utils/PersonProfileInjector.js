import { pluginBridge } from "./pluginBridge.js"

export class PersonProfileInjector {
  async build(groupId, userId, e, { parts = false } = {}) {
    const sharedState = pluginBridge.sharedState
    const config = pluginBridge.instance?.config
    const cfg = config?.personProfileInjection
    if (!cfg?.enabled) return ""
    if (!groupId || !userId) return ""

    const senderName = e?.sender?.card || e?.sender?.nickname || `用户${userId}`
    const lines = [`【当前对话者画像】`, `- 昵称: ${senderName} (QQ: ${userId})`]
    const recentLines = []
    const recentMessages = []
    let hasData = false

    try {
      const recent = await sharedState?.messageManager?.getMessages?.("group", groupId)
      if (Array.isArray(recent)) {
        const limit = Math.max(0, Number(cfg.maxRecentMessages) || 3)
        if (limit > 0) {
          const userMsgs = recent
            .filter(m => String(m?.sender?.user_id) === String(userId))
            .slice(0, limit)
          if (userMsgs.length > 0) {
            lines.push(`- 此人最近发言:`)
            recentLines.push(`- 此人最近发言:`)
            userMsgs.forEach(m => {
              const raw = String(m?.raw_message || m?.content || "").replace(/\s+/g, " ").trim()
              if (raw) {
                lines.push(`  · ${raw.slice(0, 60)}`); recentLines.push(`  · ${raw.slice(0, 60)}`)
                recentMessages.push({ messageId: m.message_id, time: m.time, text: raw.slice(0, 60) })
              }
            })
            hasData = true
          }
        }
      }
    } catch {}

    if (!hasData) return ""
    return parts ? { full: lines.join("\n"), recent: recentLines.join("\n"), recentMessages } : lines.join("\n")
  }
}

export const personProfileInjector = new PersonProfileInjector()
