import assert from 'node:assert/strict'
import test from 'node:test'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFileSync } from 'node:child_process'
import { ensurePrivateDirectoryAcl, verifyPrivateDirectoryAcl, verifyPrivateFileAcl } from './gateGaPrivateDirAclCore.mjs'

const isWindows = os.platform() === 'win32'

function withTempDir(fn) {
  const dir = path.join(os.tmpdir(), `gate-ga-acl-selftest-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`)
  try { return fn(dir) } finally { fs.rmSync(dir, { recursive: true, force: true }) }
}

test('non-Windows platform: both functions refuse (this mechanism is Windows-only by design)', { skip: isWindows }, () => {
  withTempDir(dir => {
    assert.throws(() => ensurePrivateDirectoryAcl({ dir }))
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }))
  })
})

test('ensurePrivateDirectoryAcl creates the directory locked down to exactly current user + SYSTEM + Administrators, and verify agrees', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    assert.equal(fs.existsSync(dir), true)
    assert.equal(verifyPrivateDirectoryAcl({ dir }), true)
    const icacls = execFileSync('icacls', [dir], { encoding: 'utf8' })
    const lines = icacls.split('\n').filter(l => l.includes(':(') )
    assert.equal(lines.length, 3, `expected exactly 3 ACE lines, got: ${icacls}`)
  })
})

test('verifyPrivateDirectoryAcl is idempotent and safe to call repeatedly', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    verifyPrivateDirectoryAcl({ dir })
    verifyPrivateDirectoryAcl({ dir })
  })
})

test('verifyPrivateDirectoryAcl refuses a directory with an extra grantee (e.g. Everyone)', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    execFileSync('icacls', [dir, '/grant', '*S-1-1-0:(OI)(CI)F'], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }), /acl_unexpected_principal/)
  })
})

test('verifyPrivateDirectoryAcl refuses a directory with inheritance re-enabled', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    execFileSync('icacls', [dir, '/inheritance:e'], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }))
  })
})

test('verifyPrivateDirectoryAcl refuses a missing directory rather than silently treating it as fine', { skip: !isWindows }, () => {
  withTempDir(dir => {
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }), /dir_missing/)
  })
})

test('ensurePrivateDirectoryAcl is idempotent: calling it twice on an already-correct directory leaves it correct', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    ensurePrivateDirectoryAcl({ dir })
    verifyPrivateDirectoryAcl({ dir })
  })
})

test('a relative or non-absolute dir is refused, never silently resolved', { skip: !isWindows }, () => {
  assert.throws(() => ensurePrivateDirectoryAcl({ dir: 'relative\\path' }))
  assert.throws(() => verifyPrivateDirectoryAcl({ dir: 'relative\\path' }))
})

test('verifyPrivateFileAcl: a file created inside a locked-down directory inherits exactly the allowed principals and passes', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    const filePath = path.join(dir, 'checkpoint.json')
    fs.writeFileSync(filePath, '{}', { mode: 0o600 })
    assert.equal(verifyPrivateFileAcl({ filePath }), true)
  })
})

test('verifyPrivateFileAcl refuses a file with an extra grantee, even if the parent directory is correctly locked down', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    const filePath = path.join(dir, 'checkpoint.json')
    fs.writeFileSync(filePath, '{}', { mode: 0o600 })
    execFileSync('icacls', [filePath, '/grant', '*S-1-1-0:F'], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateFileAcl({ filePath }), /acl_unexpected_principal/)
  })
})

test('verifyPrivateFileAcl refuses a missing file', { skip: !isWindows }, () => {
  withTempDir(dir => {
    assert.throws(() => verifyPrivateFileAcl({ filePath: path.join(dir, 'missing.json') }), /file_missing/)
  })
})
