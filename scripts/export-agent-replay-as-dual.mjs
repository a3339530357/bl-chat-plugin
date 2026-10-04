import fs from 'node:fs/promises'
import { spawn } from 'node:child_process'
import { pathToFileURL } from 'node:url'
import { ContextStore, ContextStoreError } from '../core/contextStore.js'
import { beijingDay } from '../core/promptCache.js'
import { exportDualBlock, replayFormat } from '../core/replayAdapters.js'

export class RedisCliClient {
  constructor(connection = []) { this.connection = connection }
  command(...args) {
    const input = String(args.pop())
    return new Promise((resolve, reject) => {
      // The final argument travels on stdin, avoiding argv size limits for full histories.
      const child = spawn('redis-cli', ['--json', ...this.connection, '-x', ...args.map(String)], { stdio: ['pipe', 'pipe', 'pipe'] })
      const chunks = []
      child.stdout.on('data', chunk => chunks.push(chunk))
      child.stderr.resume()
      child.on('error', error => reject(new Error(`redis_transport_${error.code || 'failed'}`)))
      child.on('close', code => {
        if (code !== 0) return reject(new Error('redis_transport_failed'))
        try {
          const raw = Buffer.concat(chunks).toString().trim()
          const value = raw ? JSON.parse(raw) : null
          if (value?.error) reject(new Error('redis_command_failed'))
          else resolve(value)
        } catch { reject(new Error('redis_invalid_reply')) }
      })
      child.stdin.on('error', () => {})
      child.stdin.end(input)
    })
  }
  get(key) { return this.command('GET', key) }
  eval(script, { keys, arguments: args }) { return this.command('EVAL', script, keys.length, ...keys, ...args) }
}

export function dualExportSnapshot(snapshot, dualHeader) {
  const blocks = snapshot.blocks.map(encoded => {
    const block = JSON.parse(encoded)
    return replayFormat(block) === 'dual' ? encoded : JSON.stringify(exportDualBlock(block))
  })
  const originalAgentHeader = snapshot.meta.agentHeader ? JSON.parse(snapshot.meta.agentHeader) : null
  const header = dualHeader || (snapshot.meta.header ? JSON.parse(snapshot.meta.header) : originalAgentHeader?.rollbackHeader)
  if (!header?.toolSystem || !header?.chatSystem || !header.version) throw new ContextStoreError('missing_rollback_header')
  return { ...snapshot, blocks, meta: { ...snapshot.meta, header: JSON.stringify(header), lastMode: 'dual', referenceCleanCount: String(blocks.length) } }
}

export async function exportAgentReplay(store, scope, { apply = false, backupPath, dualHeader, restorePath } = {}) {
  const before = await store.exportSnapshot(scope)
  let after
  if (restorePath) {
    const backup = JSON.parse(await fs.readFile(restorePath, 'utf8'))
    if (backup.scope.root !== scope.root || backup.scope.resetId !== scope.resetId) throw new ContextStoreError('stale_scope')
    if (JSON.stringify(before) !== JSON.stringify(backup.after)) {
      // Object field order is not a state revision; the store checks each hash field atomically.
      const canonical = value => JSON.stringify(value, Object.keys(value).sort())
      if (JSON.stringify(before.blocks) !== JSON.stringify(backup.after.blocks) ||
        ['meta', 'represented', 'committed'].some(key => canonical(before[key]) !== canonical(backup.after[key]))) throw new ContextStoreError('rollback_conflict')
    }
    after = backup.before
  } else after = dualExportSnapshot(before, dualHeader)
  const changed = before.blocks.filter((encoded, index) => encoded !== after.blocks[index]).length
  if (!apply) return { dryRun: true, blocks: before.blocks.length, changed, cursor: before.meta.cursor || '0' }
  if (!backupPath) throw new ContextStoreError('backup_required')
  await fs.writeFile(backupPath, JSON.stringify({ version: 1, scope, before, after }, null, 2), { flag: 'wx', mode: 0o600 })
  const result = await store.replaceReplay(scope, before, after)
  return { dryRun: false, blocks: before.blocks.length, changed, cursor: after.meta.cursor || '0', ...result, backupPath }
}

async function main() {
  const options = {}
  const validOptions = new Set(['bot', 'group', 'socket', 'host', 'port', 'db', 'prefix', 'day', 'backup', 'restore', 'header'])
  for (let index = 2; index < process.argv.length; index++) {
    const key = process.argv[index]
    if (key === '--apply') options.apply = true
    else if (key.startsWith('--') && validOptions.has(key.slice(2)) && process.argv[index + 1] && !process.argv[index + 1].startsWith('--')) options[key.slice(2)] = process.argv[++index]
    else throw new Error('invalid_arguments')
  }
  if (!options.bot || !options.group) throw new Error('required_arguments: --bot BOT --group GROUP [--socket PATH] [--day YYYYMMDD] [--apply --backup PATH] [--restore PATH]')
  const connection = options.socket ? ['-s', options.socket] : ['-h', options.host || '127.0.0.1', '-p', options.port || '6379']
  if (options.db) connection.push('-n', options.db)
  const client = new RedisCliClient(connection)
  const store = new ContextStore(client, options.prefix || 'ytbot:ctx:v2:')
  const day = options.day || beijingDay().dayKey
  if (!/^\d{8}$/.test(day)) throw new Error('invalid_day')
  const date = Date.UTC(Number(day.slice(0, 4)), Number(day.slice(4, 6)) - 1, Number(day.slice(6)), 4)
  const scope = { ...beijingDay(date), botId: options.bot, groupId: options.group,
    root: `${store.prefix}{${encodeURIComponent(options.bot)}:${encodeURIComponent(options.group)}:${day}}:` }
  if (scope.dayKey !== day) throw new Error('invalid_day')
  // Dry-run must never initialize a missing scope or write a backup.
  scope.resetId = await client.get(`${scope.root}active`)
  if (!scope.resetId) throw new ContextStoreError('scope_not_found')
  const dualHeader = options.header ? JSON.parse(await fs.readFile(options.header, 'utf8')) : undefined
  const result = await exportAgentReplay(store, scope, { apply: options.apply, backupPath: options.backup, dualHeader, restorePath: options.restore })
  console.log(JSON.stringify(result))
}

if (process.argv[1] && import.meta.url === pathToFileURL(process.argv[1]).href) {
  main().catch(error => { console.error(error.code || error.message); process.exitCode = 1 })
}
