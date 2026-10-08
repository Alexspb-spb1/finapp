'use strict'
// Loopback-only network fence for Node processes (preload: NODE_OPTIONS=--require=<this file>, inherited by every Node child).
// Blocks, synchronously and fail-closed, every attempt of the guarded Node APIs to reach a non-loopback destination:
//   net.Socket.prototype.connect (covers net/tls/http/https/http2/undici fetch), dns.lookup and every dns.resolve*/reverse (+ dns.promises),
//   globalThis.fetch (URL pre-check), dgram send/connect. Loopback and local pipes are allowed.
// NOT covered (stated limits): the JVM of the Firestore/Auth emulators, child processes that are not Node, native add-ons that open
// sockets themselves. Those are only observable (see network-sample.mjs), not enforced. No firewall or system setting is touched.
// The log holds the decision and destination class per attempt; for a blocked attempt also the destination host (never URL path, query or headers).
const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')
const path = require('node:path')

const LOG = process.env.M1_FENCE_LOG
if (!LOG) throw new Error('M1_FENCE_LOG_REQUIRED')

const LOOPBACK_V4 = /^127(?:\.\d{1,3}){3}$/
function isLoopbackHost(host) {
  if (host === undefined || host === null || host === '') return true // node default for connect/listen options: localhost
  let h = String(host).trim().toLowerCase()
  if (h.startsWith('[') && h.endsWith(']')) h = h.slice(1, -1)
  if (h.startsWith('::ffff:')) h = h.slice(7)
  return h === 'localhost' || h === '::1' || LOOPBACK_V4.test(h)
}

let seq = 0
function note(kind, decision, host) {
  const rec = { n: ++seq, pid: process.pid, script: path.basename(process.argv[1] || ''), kind, decision }
  if (decision === 'blocked') rec.host = String(host === undefined ? '' : host).slice(0, 120)
  try { fs.appendFileSync(LOG, JSON.stringify(rec) + '\n') } catch { /* a log failure must not open the fence */ }
}
function denied(kind, host) {
  note(kind, 'blocked', host)
  const e = new Error('M1_NON_LOOPBACK_BLOCKED')
  e.code = 'M1_NON_LOOPBACK_BLOCKED'
  return e
}

const originalConnect = net.Socket.prototype.connect
net.Socket.prototype.connect = function (...args) {
  let options = args[0]
  if (Array.isArray(options)) options = options[0]
  if (options && typeof options === 'object') {
    if (options.path) { note('pipe', 'local'); return originalConnect.apply(this, args) }
    if (!isLoopbackHost(options.host)) throw denied('connect', options.host)
  } else if (typeof options === 'number' || (typeof options === 'string' && /^\d+$/.test(options))) {
    if (!isLoopbackHost(typeof args[1] === 'string' ? args[1] : undefined)) throw denied('connect', args[1])
  } else if (typeof options === 'string') {
    note('pipe', 'local') // net.connect(path)
    return originalConnect.apply(this, args)
  } else throw denied('connect-unknown', '')
  note('connect', 'loopback')
  return originalConnect.apply(this, args)
}

const originalLookup = dns.lookup
dns.lookup = function (host, ...rest) {
  if (!isLoopbackHost(host)) throw denied('dns-lookup', host)
  note('dns-lookup', 'loopback')
  return originalLookup.call(this, host, ...rest)
}
if (dns.promises && typeof dns.promises.lookup === 'function') {
  const originalPromiseLookup = dns.promises.lookup.bind(dns.promises)
  dns.promises.lookup = async function (host, ...rest) {
    if (!isLoopbackHost(host)) throw denied('dns-promise-lookup', host)
    note('dns-promise-lookup', 'loopback')
    return originalPromiseLookup(host, ...rest)
  }
}
for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[method] === 'function') dns[method] = function (host) { throw denied('dns-resolve', host) }
  if (dns.promises && typeof dns.promises[method] === 'function') dns.promises[method] = async function (host) { throw denied('dns-promise-resolve', host) }
}

const originalFetch = globalThis.fetch
if (typeof originalFetch === 'function') {
  globalThis.fetch = async function (input, init) {
    let u
    try { u = new URL(typeof input === 'string' || input instanceof URL ? input : input.url) } catch { throw denied('fetch-unparseable', '') }
    if (!['http:', 'https:'].includes(u.protocol) || !isLoopbackHost(u.hostname)) throw denied('fetch', u.hostname)
    note('fetch', 'loopback')
    return originalFetch.call(this, input, init)
  }
}

for (const method of ['send', 'connect']) {
  const original = dgram.Socket.prototype[method]
  dgram.Socket.prototype[method] = function (...args) {
    // send(msg, [offset, length,] port, address, cb) / connect(port, address, cb): the address is the string argument after the port number
    const portIdx = args.findIndex((a, i) => typeof a === 'number' && i >= (method === 'send' ? 1 : 0) && typeof args[i + 1] === 'string')
    const address = portIdx >= 0 ? args[portIdx + 1] : undefined
    if (!isLoopbackHost(address)) throw denied(`dgram-${method}`, address)
    note(`dgram-${method}`, 'loopback')
    return original.apply(this, args)
  }
}

module.exports = { isLoopbackHost }
