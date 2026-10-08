// Test-only fault injection (emulator, M1-SAFE-STOP-RECOVERY-01 scenario 1). Preloaded with --require into ONE seed process: the first Auth account
// creation (POST .../projects/<p>/accounts) is rejected the way undici reports a connect timer expiry - the request is NOT forwarded anywhere.
// Every other request passes. Never used by the package.
'use strict'
const originalFetch = globalThis.fetch
globalThis.fetch = async function faultyFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  if (/\/projects\/[^/]+\/accounts$/.test(new URL(url).pathname) && (init && init.method) === 'POST') {
    await new Promise(r => setTimeout(r, 50))
    const cause = Object.assign(new Error('Connect Timeout Error (injected)'), { name: 'ConnectTimeoutError', code: 'UND_ERR_CONNECT_TIMEOUT' })
    throw Object.assign(new TypeError('fetch failed'), { cause })
  }
  return originalFetch(input, init)
}
