'use strict'
// Test double for the fence self-test: replaces the real network entry points with recorders BEFORE loopback-only.cjs wraps them
// (NODE_OPTIONS="--require=recorder-stub.cjs --require=loopback-only.cjs"). Nothing here touches the network, so the self-test is safe even
// when the fence under test is broken: a request that gets past a broken fence reaches the recorder and is reported, never sent.
const net = require('node:net')
const dns = require('node:dns')
const dgram = require('node:dgram')

const reached = []
globalThis.__M1_REACHED = reached
const rec = (kind, host) => reached.push({ kind, host: String(host === undefined ? 'localhost' : host) })

net.Socket.prototype.connect = function (...args) {
  let o = args[0]
  if (Array.isArray(o)) o = o[0]
  rec('connect', o && typeof o === 'object' ? (o.path ? 'pipe' : o.host) : (typeof args[1] === 'string' ? args[1] : 'localhost'))
  process.nextTick(() => this.destroy())
  return this
}
dns.lookup = function (host, ...rest) {
  rec('dns-lookup', host)
  const cb = rest[rest.length - 1]
  if (typeof cb === 'function') process.nextTick(cb, null, '127.0.0.1', 4)
}
dns.promises.lookup = async function (host) { rec('dns-promise-lookup', host); return { address: '127.0.0.1', family: 4 } }
for (const method of ['resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveCaa', 'resolveCname', 'resolveMx', 'resolveNaptr', 'resolveNs', 'resolvePtr', 'resolveSoa', 'resolveSrv', 'resolveTxt', 'reverse']) {
  if (typeof dns[method] === 'function') dns[method] = function (host) { rec(`dns-${method}`, host) }
  if (typeof dns.promises[method] === 'function') dns.promises[method] = async function (host) { rec(`dns-promise-${method}`, host); return [] }
}
globalThis.fetch = async function (input) { rec('fetch', new URL(typeof input === 'string' || input instanceof URL ? input : input.url).hostname); return new Response('stub') }
for (const method of ['send', 'connect']) {
  dgram.Socket.prototype[method] = function (...args) {
    const i = args.findIndex((a, k) => typeof a === 'number' && k >= (method === 'send' ? 1 : 0) && typeof args[k + 1] === 'string')
    rec(`dgram-${method}`, i >= 0 ? args[i + 1] : undefined)
    const cb = args.find(a => typeof a === 'function')
    if (cb) process.nextTick(cb)
  }
}
