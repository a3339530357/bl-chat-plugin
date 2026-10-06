import fs from 'node:fs/promises'
import { randomUUID } from 'node:crypto'
import { tokenEstimate } from './promptCache.js'

export async function dumpTurnTail(config, turn, content) {
  if (config.promptCache?.tailDump !== true) return
  const target = `/root/tmp/tail-dump-${encodeURIComponent(turn.scope.groupId)}.json`
  const temporary = `${target}.${randomUUID()}.tmp`
  try {
    await fs.mkdir('/root/tmp', { recursive: true })
    await fs.writeFile(temporary, JSON.stringify({ groupId: turn.scope.groupId, turnId: turn.turnId,
      noteVersion: turn.snapshot.noteClock, tokensEstimate: tokenEstimate(content), content }, null, 2), { mode: 0o600 })
    await fs.rename(temporary, target)
  } catch (error) {
    globalThis.logger?.warn?.(`[PromptCacheV2] tail dump failed: ${error.message}`)
  } finally { await fs.unlink(temporary).catch(() => {}) }
}
