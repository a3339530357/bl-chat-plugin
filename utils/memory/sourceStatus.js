import { botIdForEvent } from '../../core/promptCache.js'
import { memorySourceStore } from './MemorySourceStore.js'

const checkedAt = new Map()

function formatTime(value) {
  const timestamp = Number(value) || Date.parse(value)
  return Number.isFinite(timestamp) && timestamp > 0 ? new Date(timestamp).toLocaleString('zh-CN', { timeZone: 'Asia/Shanghai' }) : '无'
}

export function memorySourceStatusLines(status) {
  const { meta, snapshot } = status
  return [
    `记忆原料：待整理 ${status.pending} 条，${Number(meta.pendingBytes || 0)} 字节（未整理原料永久保留）`,
    `保护起点：${formatTime(meta.captureStartedAt)}；最早积压：${formatTime(meta.oldestPendingAt)}`,
    `原料序号：${status.latest}；已整理至：${meta.extractedThrough || 0}；整理需主人手动触发，旧自动提取已停用`,
    `旧历史保全：${snapshot.importedAt ? '已导入可用原料' : snapshot.status || '尚未建立快照'}；raw 范围 ${snapshot.rawFrom || '-'}..${snapshot.rawUntil || '-'}（保全 ${snapshot.rawCaptured || 0} 条）；近期消息 ${snapshot.recentCount || 0} 条；回放 ${snapshot.replayCaptured || 0}/${snapshot.replayCount || 0}`,
    `保全缺口：${snapshot.gap || '未检测到（保护起点之前的完整历史不作保证）'}`,
    `最近采集错误：${meta.lastError || '无'}${meta.lastError ? `（${formatTime(meta.lastErrorAt)}）` : ''}`
  ]
}

export async function maybeRemindMemorySource(e, settings, store = memorySourceStore) {
  if (!e.group_id) return false
  const scope = store.scope(botIdForEvent(e), e.group_id)
  const key = scope.root
  if (Date.now() - (checkedAt.get(key) || 0) < 60000) return false
  checkedAt.set(key, Date.now())
  if (checkedAt.size > 1000) checkedAt.delete(checkedAt.keys().next().value)
  const reminder = await store.claimReminder(scope, settings)
  if (!reminder.due) return false
  await e.reply(`主人，记忆原料已积压 ${reminder.count} 条（${reminder.bytes} 字节），最早积压于 ${formatTime(reminder.oldest)}。原料将继续保留，当前未执行自动整理。`)
  return true
}
