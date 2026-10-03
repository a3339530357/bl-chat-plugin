import { spawn, execFile } from 'node:child_process'
import { promisify } from 'node:util'
import fs from 'node:fs/promises'
import os from 'node:os'
import path from 'node:path'
import { once } from 'node:events'

const run = promisify(execFile)

export async function redisFixture() {
  const directory = await fs.mkdtemp(path.join(os.tmpdir(), 'bl-cache-redis-'))
  const socket = path.join(directory, 'redis.sock')
  const server = spawn('redis-server', ['--port', '0', '--save', '', '--appendonly', 'no', '--unixsocket', socket, '--unixsocketperm', '700'], { stdio: ['ignore', 'pipe', 'pipe'] })
  let failure
  server.on('error', error => { failure = error })
  let output = ''
  server.stdout.on('data', data => { output += data })
  server.stderr.on('data', data => { output += data })
  const client = {
    async command(...args) {
      const result = await run('redis-cli', ['--json', '-s', socket, ...args.map(String)], { maxBuffer: 16 * 1024 * 1024 })
      if (!result.stdout.trim()) return null
      const value = JSON.parse(result.stdout)
      if (value && typeof value === 'object' && value.error) throw new Error(value.error)
      return value
    },
    async eval(script, { keys, arguments: args }) {
      return this.command('EVAL', script, keys.length, ...keys, ...args)
    },
    get(key) { return this.command('GET', key) },
    set(key, value, options = {}) {
      const args = ['SET', key, value]
      for (const flag of ['EX', 'PX']) if (options[flag]) args.push(flag, options[flag])
      for (const flag of ['NX', 'XX']) if (options[flag]) args.push(flag)
      return this.command(...args)
    },
    del(...keys) { return this.command('DEL', ...keys.flat()) },
    keys(pattern) { return this.command('KEYS', pattern) }
  }
  let ready = false
  for (let attempt = 0; attempt < 80; attempt++) {
    if (failure || server.exitCode !== null) break
    try { ready = await client.command('PING') === 'PONG' } catch {}
    if (ready) break
    await new Promise(resolve => setTimeout(resolve, 25))
  }
  if (!ready) {
    server.kill()
    await fs.rm(directory, { recursive: true, force: true })
    throw failure || new Error(`Isolated test Redis failed: ${output}`)
  }
  return {
    client, directory,
    async stop() {
      if (server.exitCode !== null || server.signalCode !== null) {
        await fs.rm(directory, { recursive: true, force: true })
        return
      }
      const exited = once(server, 'exit')
      await client.command('SHUTDOWN', 'NOSAVE').catch(() => {})
      await exited
      await fs.rm(directory, { recursive: true, force: true })
    }
  }
}
