// Test-only fault injection (emulator, scenario 4): the first Auth account creation fails with the runner's own abort (TimeoutError) - the outcome of
// the request is unknown. Never used by the package.
'use strict'
const originalFetch = globalThis.fetch
globalThis.fetch = async function faultyFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  if (/\/projects\/[^/]+\/accounts$/.test(new URL(url).pathname) && (init && init.method) === 'POST') {
    throw Object.assign(new Error('The operation was aborted due to timeout (injected)'), { name: 'TimeoutError' })
  }
  return originalFetch(input, init)
}
