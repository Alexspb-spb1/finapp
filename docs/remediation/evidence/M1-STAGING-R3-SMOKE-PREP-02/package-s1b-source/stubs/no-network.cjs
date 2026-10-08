// Preloaded into every stub process (`node --require no-network.cjs ...`).
// Any attempt to open a socket, resolve a name, issue an HTTP(S) request or call
// fetch throws immediately and is appended to M1_STUB_NETWORK_LOG (if set).
'use strict'
const fs = require('node:fs')

function blocked(api) {
  const line = `${JSON.stringify({ at: new Date().toISOString(), api, pid: process.pid, script: process.argv[1] || null })}\n`
  if (process.env.M1_STUB_NETWORK_LOG) { try { fs.appendFileSync(process.env.M1_STUB_NETWORK_LOG, line) } catch { /* ignore */ } }
  const err = new Error(`M1_STUB_NETWORK_BLOCKED ${api}`)
  err.code = 'M1_STUB_NETWORK_BLOCKED'
  throw err
}

const net = require('node:net')
const tls = require('node:tls')
const http = require('node:http')
const https = require('node:https')
const dns = require('node:dns')
const http2 = require('node:http2')
const dgram = require('node:dgram')

net.Socket.prototype.connect = function connect() { blocked('net.Socket.connect') }
net.connect = net.createConnection = function connect() { blocked('net.connect') }
tls.connect = function connect() { blocked('tls.connect') }
http.request = http.get = function request() { blocked('http.request') }
https.request = https.get = function request() { blocked('https.request') }
http2.connect = function connect() { blocked('http2.connect') }
dgram.createSocket = function createSocket() { blocked('dgram.createSocket') }
for (const fn of ['lookup', 'resolve', 'resolve4', 'resolve6', 'resolveAny', 'resolveSrv', 'resolveTxt', 'reverse']) {
  dns[fn] = function dnsCall() { blocked(`dns.${fn}`) }
  if (dns.promises && dns.promises[fn]) dns.promises[fn] = async function dnsPromise() { blocked(`dns.promises.${fn}`) }
}
globalThis.fetch = async function fetch() { blocked('fetch') }
globalThis.WebSocket = function WebSocket() { blocked('WebSocket') }
process.env.M1_NO_NETWORK_PRELOADED = '1'
