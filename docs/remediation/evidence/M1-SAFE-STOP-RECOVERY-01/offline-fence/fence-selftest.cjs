'use strict'
// Self-test of loopback-only.cjs. Run inside a process that has the fence preloaded:
//   mode "recorder": NODE_OPTIONS="--require=recorder-stub.cjs --require=loopback-only.cjs" - every external attempt must be blocked and none may reach the recorder (no real traffic is possible);
//   mode "live-loopback": NODE_OPTIONS="--require=loopback-only.cjs" - real loopback server/client traffic must still work.
// Usage: node fence-selftest.cjs <recorder|live-loopback>   (result JSON path: M1_FENCE_SELFTEST_RESULT, optional)
const fs = require('node:fs')
const net = require('node:net')
const tls = require('node:tls')
const dns = require('node:dns')
const http = require('node:http')
const dgram = require('node:dgram')
const { spawnSync } = require('node:child_process')

const mode = process.argv[2]
const BLOCKED = 'M1_NON_LOOPBACK_BLOCKED'
const results = []
const record = (name, ok, detail) => { results.push({ name, ok: !!ok, ...(ok ? {} : { detail: String(detail).slice(0, 200) }) }); console.log(`${ok ? 'PASS' : 'FAIL'} ${name}${ok ? '' : ` :: ${String(detail).slice(0, 200)}`}`) }

async function blocked(name, fn) {
  try { await fn(); record(name, false, 'attempt was not blocked') } catch (e) { record(name, e && e.code === BLOCKED, `unexpected error ${e && (e.code || e.message)}`) }
}
// http/https may report the blocked connect as a synchronous throw or as an 'error' event on the request
function httpBlocked(name, url) {
  return blocked(name, () => new Promise((resolve, reject) => {
    let req
    try { req = http.get(url) } catch (e) { reject(e); return }
    req.on('error', reject)
    req.on('response', r => { r.resume(); resolve() })
  }))
}

async function recorderMode() {
  const external = ['192.0.2.1', 'example.invalid', '203.0.113.7', '::ffff:192.0.2.1', '[2001:db8::1]', '0.0.0.0']
  for (const h of external) await blocked(`net.connect to ${h} is blocked`, () => net.connect({ host: h, port: 9 }))
  await blocked('net.connect(port, host) form is blocked', () => net.connect(9, '192.0.2.1'))
  await blocked('net.connect with an options object without a usable host form (array) is blocked', () => { const s = new net.Socket(); s.connect([{ host: '192.0.2.1', port: 9 }]) })
  await blocked('tls.connect to an external host is blocked', () => tls.connect({ host: '192.0.2.1', port: 443 }))
  await httpBlocked('http.get to an external host is blocked', 'http://192.0.2.1/')
  await blocked('fetch of an external https URL is blocked', () => fetch('https://example.invalid/x?token=SENTINEL'))
  await blocked('fetch of a non-http scheme is blocked', () => fetch('ftp://127.0.0.1/'))
  await blocked('dns.lookup of an external name is blocked', () => dns.lookup('example.invalid', () => {}))
  await blocked('dns.promises.lookup of an external name is blocked', () => dns.promises.lookup('example.invalid'))
  await blocked('dns.resolve4 is blocked', () => dns.resolve4('example.invalid', () => {}))
  await blocked('dns.promises.resolve4 is blocked', () => dns.promises.resolve4('example.invalid'))
  await blocked('dns.reverse is blocked', () => dns.reverse('192.0.2.1', () => {}))
  await blocked('dgram send to an external address is blocked', () => dgram.createSocket('udp4').send(Buffer.from('x'), 9, '192.0.2.1'))

  const before = results.length
  const reachedBefore = globalThis.__M1_REACHED.length
  for (const h of ['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3', '::ffff:127.0.0.1']) {
    try { net.connect({ host: h, port: 9 }).on('error', () => {}); record(`net.connect to loopback ${h} is allowed`, true) } catch (e) { record(`net.connect to loopback ${h} is allowed`, false, e.code || e.message) }
  }
  try { await fetch('http://localhost:9/'); record('fetch to localhost is allowed', true) } catch (e) { record('fetch to localhost is allowed', false, e.code || e.message) }
  try { await new Promise((res, rej) => dns.lookup('localhost', err => err ? rej(err) : res())); record('dns.lookup of localhost is allowed', true) } catch (e) { record('dns.lookup of localhost is allowed', false, e.code || e.message) }
  record('loopback attempts reached the recorder', globalThis.__M1_REACHED.length - reachedBefore >= 8 && results.length > before, `reached=${globalThis.__M1_REACHED.length - reachedBefore}`)

  const loopbackHosts = new Set(['127.0.0.1', 'localhost', '::1', '[::1]', '127.1.2.3', '::ffff:127.0.0.1', 'pipe'])
  const leaked = globalThis.__M1_REACHED.filter(r => !loopbackHosts.has(r.host))
  record('no external destination reached the underlying network layer', leaked.length === 0, `leaked=${leaked.length}`)

  const child = spawnSync(process.execPath, ['-e', "const net=require('node:net');try{net.connect({host:'192.0.2.1',port:9});process.stdout.write('NOT_BLOCKED')}catch(e){process.stdout.write(e.code==='M1_NON_LOOPBACK_BLOCKED'?'BLOCKED':'OTHER')}"], { env: process.env, encoding: 'utf8' })
  record('a Node child process inherits the fence through NODE_OPTIONS', child.stdout === 'BLOCKED', `child=${child.stdout}`)
  const noLog = spawnSync(process.execPath, ['-e', 'process.stdout.write("RAN")'], { env: { ...process.env, M1_FENCE_LOG: '' }, encoding: 'utf8' })
  record('a child without the fence log variable fails to start (fail closed)', noLog.status !== 0 && noLog.stdout !== 'RAN', `status=${noLog.status}`)

  const log = fs.readFileSync(process.env.M1_FENCE_LOG, 'utf8').split('\n').filter(Boolean).map(l => JSON.parse(l))
  const blockedRecords = log.filter(r => r.decision === 'blocked' && r.pid === process.pid)
  const hosts = new Set(blockedRecords.map(r => r.host))
  record('blocked attempts are logged with the destination host and without URL path or query', blockedRecords.length >= 15 && ['192.0.2.1', 'example.invalid', '203.0.113.7'].every(h => hosts.has(h)) && !JSON.stringify(blockedRecords).includes('SENTINEL'), `blocked=${blockedRecords.length}`)
}

async function liveLoopbackMode() {
  await new Promise(resolve => {
    const srv = http.createServer((req, res) => { res.end('ok') })
    srv.listen(0, '127.0.0.1', async () => {
      const port = srv.address().port
      try { const r = await fetch(`http://127.0.0.1:${port}/`); record('fetch to a real loopback server works under the fence', r.status === 200 && (await r.text()) === 'ok', r.status) } catch (e) { record('fetch to a real loopback server works under the fence', false, e.code || e.message) }
      await new Promise(res => { http.get(`http://localhost:${port}/`, r => { r.resume(); record('http.get to localhost works under the fence', r.statusCode === 200, r.statusCode); res() }).on('error', e => { record('http.get to localhost works under the fence', false, e.code || e.message); res() }) })
      await new Promise(res => { const c = net.connect({ host: '127.0.0.1', port }); c.on('connect', () => { record('net.connect to a real loopback server works under the fence', true); c.destroy(); res() }); c.on('error', e => { record('net.connect to a real loopback server works under the fence', false, e.code || e.message); res() }) })
      srv.close(resolve)
    })
  })
  await blocked('an external connect is still blocked in the live mode', () => net.connect({ host: '192.0.2.1', port: 9 }))
}

;(async () => {
  if (mode === 'recorder') await recorderMode()
  else if (mode === 'live-loopback') await liveLoopbackMode()
  else { console.log('USAGE fence-selftest.cjs <recorder|live-loopback>'); process.exit(2) }
  const failed = results.filter(r => !r.ok).length
  console.log(`FENCE_SELFTEST mode=${mode} ${failed ? 'FAIL' : 'PASS'} ${results.length - failed}/${results.length}`)
  if (process.env.M1_FENCE_SELFTEST_RESULT) fs.writeFileSync(process.env.M1_FENCE_SELFTEST_RESULT, JSON.stringify({ mode, total: results.length, failed, results }, null, 2) + '\n')
  process.exit(failed ? 1 : 0)
})()
