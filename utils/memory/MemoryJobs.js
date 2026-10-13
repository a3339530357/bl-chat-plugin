import { randomUUID } from 'node:crypto'

const CLOCK = `local clock=redis.call('TIME'); local now=tonumber(clock[1])*1000+math.floor(tonumber(clock[2])/1000)`
const START = `${CLOCK}
local active=redis.call('GET', KEYS[1])
if active then return cjson.encode({job=redis.call('HGET', KEYS[2], active), existing=true}) end
local cursor=tonumber(redis.call('HGET', KEYS[3], 'extractedThrough') or '0')
local target=tonumber(redis.call('GET', KEYS[4]) or '0')
if target<=cursor then return cjson.encode({empty=true}) end
local job={id=ARGV[1], from=cursor+1, target=target, status='queued', createdAt=now, owner='', leaseUntil=0, batches=0, attempts=0}
local encoded=cjson.encode(job)
redis.call('HSET', KEYS[2], job.id, encoded); redis.call('SET', KEYS[1], job.id)
return cjson.encode({job=encoded, existing=false})`

const GET = `local id=ARGV[1] ~= '' and ARGV[1] or redis.call('GET', KEYS[1])
return cjson.encode({job=id and redis.call('HGET', KEYS[2], id) or false})`

const CLAIM = `${CLOCK}
if redis.call('GET', KEYS[1]) ~= ARGV[1] then return cjson.encode({error='memory_job_inactive'}) end
local job=cjson.decode(redis.call('HGET', KEYS[2], ARGV[1]))
if job.status=='running' and job.leaseUntil>now and job.owner~=ARGV[2] then return cjson.encode({busy=true, retryAt=job.leaseUntil}) end
job.owner=ARGV[2]; job.status='running'; job.leaseUntil=now+tonumber(ARGV[3]); job.heartbeatAt=now
redis.call('HSET', KEYS[3], 'workerToken', job.owner)
local encoded=cjson.encode(job); redis.call('HSET', KEYS[2], job.id, encoded)
return cjson.encode({job=encoded})`

const UPDATE = `${CLOCK}
if redis.call('GET', KEYS[1]) ~= ARGV[1] or redis.call('HGET', KEYS[3], 'workerToken') ~= ARGV[2] then return cjson.encode({error='memory_stale_worker'}) end
local job=cjson.decode(redis.call('HGET', KEYS[2], ARGV[1]))
if job.owner~=ARGV[2] then return cjson.encode({error='memory_stale_worker'}) end
local patch=cjson.decode(ARGV[3]); for key,value in pairs(patch) do job[key]=value end
job.heartbeatAt=now; job.leaseUntil=now+tonumber(ARGV[4])
if job.status~='running' then job.leaseUntil=0; redis.call('HSET', KEYS[3], 'workerToken', ARGV[2] .. ':stopped') end
local encoded=cjson.encode(job); redis.call('HSET', KEYS[2], job.id, encoded)
if job.status=='complete' then redis.call('DEL', KEYS[1]) end
return cjson.encode({job=encoded})`

export class MemoryJobs {
  constructor(store) { this.store = store }
  keys(scope) { return [scope.root + 'job:active', scope.root + 'jobs', scope.root + 'meta', scope.root + 'source:seq'] }
  async call(script, scope, args) {
    const result = await this.store.sources.evaluate(script, this.keys(scope), args)
    const job = result.job ? JSON.parse(result.job) : null
    if (job) job.batch = job.batchJson ? JSON.parse(job.batchJson) : null
    return { ...result, job }
  }
  async start(scope) {
    await this.store.sources.evaluate(`redis.call('HSET', KEYS[1], ARGV[1], ARGV[2]); return '{}'`, ['ytbot:memory:v3:jobScopes'], [scope.root, JSON.stringify({ botId: scope.botId, groupId: scope.groupId })])
    return this.call(START, scope, [randomUUID()])
  }
  get(scope, id = '') { return this.call(GET, scope, [id]) }
  claim(scope, id, token, leaseMs) { return this.call(CLAIM, scope, [id, token, leaseMs]) }
  update(scope, id, token, patch, leaseMs = 0) {
    const value = { ...patch }
    // 分片/候选含空数组：沿用账本做法，把嵌套 JSON 当字符串经过 Lua。
    if (Object.hasOwn(value, 'batch')) { value.batchJson = value.batch ? JSON.stringify(value.batch) : null; delete value.batch }
    return this.call(UPDATE, scope, [id, token, JSON.stringify(value), leaseMs])
  }
  async scopes() {
    const result = await this.store.sources.evaluate(`return cjson.encode({rows=redis.call('HVALS', KEYS[1])})`, ['ytbot:memory:v3:jobScopes'])
    return (Array.isArray(result.rows) ? result.rows : []).map(row => { const value = JSON.parse(row); return this.store.scope(value.botId, value.groupId) })
  }
}
