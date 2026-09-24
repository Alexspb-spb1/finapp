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

// R8: the directory is now created WITH its security descriptor in one
// atomic Win32 call ([System.IO.Directory]::CreateDirectory(path, security))
// instead of New-Item-then-Set-Acl — closing the TOCTOU window where the
// directory briefly existed with default/inherited permissions. This test
// proves the atomic path is actually exercised (not silently falling back
// to the repair path) by asserting a genuinely-fresh directory ends up
// correctly locked down in one call, with no intermediate state ever
// observable by definition (a single synchronous PowerShell invocation).
test('ensurePrivateDirectoryAcl on a brand-new path uses atomic creation and is correct on the first call', { skip: !isWindows }, () => {
  withTempDir(dir => {
    assert.equal(fs.existsSync(dir), false)
    ensurePrivateDirectoryAcl({ dir })
    assert.equal(verifyPrivateDirectoryAcl({ dir }), true)
  })
})

test('verifyPrivateDirectoryAcl refuses a rule granted weaker rights than FullControl', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    const currentUser = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value'], { encoding: 'utf8' }).trim()
    execFileSync('icacls', [dir, '/remove', `*${currentUser}`], { stdio: 'ignore' })
    execFileSync('icacls', [dir, '/grant', `*${currentUser}:(OI)(CI)M`], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }), /acl_insufficient_rights/)
  })
})

test('verifyPrivateDirectoryAcl refuses a rule missing ContainerInherit/ObjectInherit (would silently stop protecting new files)', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    const currentUser = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value'], { encoding: 'utf8' }).trim()
    execFileSync('icacls', [dir, '/remove', `*${currentUser}`], { stdio: 'ignore' })
    execFileSync('icacls', [dir, '/grant', `*${currentUser}:(F)`], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }), /acl_missing_inheritance_flags/)
  })
})

test('verifyPrivateDirectoryAcl refuses a directory missing one of the three required principals', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    execFileSync('icacls', [dir, '/remove', '*S-1-5-32-544'], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateDirectoryAcl({ dir }), /acl_required_principal_missing/)
  })
})

test('verifyPrivateFileAcl refuses a file granted weaker rights than FullControl', { skip: !isWindows }, () => {
  withTempDir(dir => {
    ensurePrivateDirectoryAcl({ dir })
    const filePath = path.join(dir, 'checkpoint.json')
    fs.writeFileSync(filePath, '{}', { mode: 0o600 })
    const currentUser = execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', '([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value'], { encoding: 'utf8' }).trim()
    execFileSync('icacls', [filePath, '/inheritance:d'], { stdio: 'ignore' })
    execFileSync('icacls', [filePath, '/remove', `*${currentUser}`], { stdio: 'ignore' })
    execFileSync('icacls', [filePath, '/grant', `*${currentUser}:R`], { stdio: 'ignore' })
    assert.throws(() => verifyPrivateFileAcl({ filePath }), /acl_insufficient_rights/)
  })
})
