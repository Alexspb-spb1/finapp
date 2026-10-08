// Test-only fault injection (emulator cleanup-gate T18). Preloaded with --require into ONE
// cleanup process: every Auth `accounts:delete` request fails as a network error, so the
// runner deterministically stops after its document deletes were sent. Never used by the package.
'use strict'
const originalFetch = globalThis.fetch
globalThis.fetch = async function faultyFetch(input, init) {
  const url = typeof input === 'string' ? input : String(input && input.url ? input.url : input)
  if (url.includes('accounts:delete')) {
    const err = new TypeError('fetch failed (injected by fault-auth-delete.cjs)')
    throw err
  }
  return originalFetch(input, init)
}
