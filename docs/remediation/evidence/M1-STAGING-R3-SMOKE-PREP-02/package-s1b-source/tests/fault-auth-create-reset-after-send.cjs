// Test-only fault injection (emulator, scenario 2). The first Auth account creation IS forwarded and succeeds at the provider, then the answer is
// lost: the connection is reported as reset while reading. The account exists, the runner never learns its uid. Never used by the package.
'use strict'
const originalFetch = globalThis.fetch
globalThis.fetch = async function faultyFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  if (/\/projects\/[^/]+\/accounts$/.test(new URL(url).pathname) && (init && init.method) === 'POST') {
    const res = await originalFetch(input, init)
    await res.arrayBuffer()
    const cause = Object.assign(new Error('read ECONNRESET (injected)'), { code: 'ECONNRESET', syscall: 'read' })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  }
  return originalFetch(input, init)
}
