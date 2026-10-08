// Test-only network audit, preloaded with --require (NODE_OPTIONS) into every node process of an
// emulator-backed rehearsal. It never blocks anything: it appends one line per outgoing socket
// connection and per DNS lookup to M1_NET_AUDIT_LOG, so a test can prove that every destination
// was loopback. It is not part of the staging path (staging refuses NODE_OPTIONS).
'use strict'
const fs = require('node:fs')
const net = require('node:net')
const dns = require('node:dns')
const path = require('node:path')
const log = process.env.M1_NET_AUDIT_LOG
function note(kind, target) {
  if (!log) return
  try { fs.appendFileSync(log, `${JSON.stringify({ kind, target, pid: process.pid, script: process.argv[1] ? path.basename(process.argv[1]) : null })}\n`) } catch { /* ignore */ }
}
// net.connect() hands Socket.prototype.connect a normalised argument array ([options, callback]).
const connect = net.Socket.prototype.connect
net.Socket.prototype.connect = function audited(...args) {
  let a = args[0]
  if (Array.isArray(a)) a = a[0]
  if (a && typeof a === 'object') note('connect', a.path ? 'pipe:local' : `${a.host ?? 'localhost'}:${a.port}`)
  else if (typeof a === 'number') note('connect', `${typeof args[1] === 'string' ? args[1] : 'localhost'}:${a}`)
  else note('connect', 'pipe:local')
  return connect.apply(this, args)
}
const lookup = dns.lookup
dns.lookup = function audited(hostname, ...rest) { note('dns', String(hostname)); return lookup.call(this, hostname, ...rest) }
