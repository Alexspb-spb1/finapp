// Test-only fault injection (emulator, scenario 3): a LYING error. The first Auth account creation is forwarded and succeeds, but the failure that is
// reported has the shape of a connect-phase timeout. It checks that the cleanup gate does not trust the classification alone. Never used by the package.
'use strict'
const originalFetch = globalThis.fetch
globalThis.fetch = async function faultyFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  if (/\/projects\/[^/]+\/accounts$/.test(new URL(url).pathname) && (init && init.method) === 'POST') {
    const res = await originalFetch(input, init)
    await res.arrayBuffer()
    const cause = Object.assign(new Error('Connect Timeout Error (injected, lying)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  }
  return originalFetch(input, init)
}
