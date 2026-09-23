// gate-G-A private-directory ACL guard (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R7).
// Windows-only, by design: the checkpoint/manifest directory holds the
// recipient's CSPRNG password and the run's full identifying state. Before
// ANY checkpoint or manifest file is ever written — before any Auth user is
// created, before any email is sent — this directory's ACL must be locked
// down to exactly three principals (the current user, SYSTEM, and
// BUILTIN\Administrators), with inheritance disabled so no ambient
// permission from a parent directory can leak access in. Verification is by
// SID, never by localized account name (locale-independent). Any mismatch
// blocks — fail-closed, before any external side effect.
import { execFileSync } from 'node:child_process'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'

const blocked = reason => { throw new Error(`gate_ga_private_dir_acl_blocked:${reason ?? ''}`) }
const SID_SYSTEM = 'S-1-5-18'
const SID_ADMINISTRATORS = 'S-1-5-32-544'

function runPowerShell(script) {
  try {
    return execFileSync('powershell.exe', ['-NoProfile', '-NonInteractive', '-Command', script], { encoding: 'utf8' })
  } catch (error) {
    blocked(`powershell_failed:${(error.stderr ?? error.message ?? '').toString().slice(0, 300)}`)
  }
}

/** Creates `dir` if missing (with a locked-down ACL from the very first
 * moment it exists — never created-open-then-locked-down, which would leave
 * a TOCTOU window) and enforces: inheritance disabled, exactly
 * {current user, SYSTEM, BUILTIN\Administrators} granted FullControl,
 * nothing else. Idempotent — safe to call on an already-correct directory. */
export function ensurePrivateDirectoryAcl({ dir }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) blocked('bad_dir')
  // Idempotent: if the directory already exists with exactly the correct
  // ACL, re-running Set-Acl is both unnecessary and (observed in practice)
  // can hit a SeSecurityPrivilege requirement on a second DACL-protection
  // rebuild even for the ACL's own owner — skip it entirely when a plain
  // verify already confirms nothing needs to change.
  if (fs.existsSync(dir)) {
    try { verifyPrivateDirectoryAcl({ dir }); return } catch { /* fall through and (re)apply */ }
  }
  const script = `
$ErrorActionPreference = 'Stop'
$dir = ${JSON.stringify(dir)}
New-Item -ItemType Directory -Path $dir -Force | Out-Null
$acl = Get-Acl -Path $dir
$acl.SetAccessRuleProtection($true, $false)
foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('${SID_SYSTEM}')
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('${SID_ADMINISTRATORS}')
foreach ($sid in @($currentSid, $systemSid, $adminsSid)) {
  $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
  $acl.AddAccessRule($rule)
}
Set-Acl -Path $dir -AclObject $acl
Write-Output 'DONE'
`
  const out = runPowerShell(script)
  if (!out.includes('DONE')) blocked('acl_setup_did_not_confirm')
  verifyPrivateDirectoryAcl({ dir })
}

/** Fail-closed verification, callable independently of setup (and used on
 * every resume, and after every checkpoint/manifest file write) — never
 * assumes a directory it didn't just create is still correctly locked
 * down. Checks, by SID: zero inherited entries, and the effective allow-set
 * is exactly {current user, SYSTEM, Administrators}, nothing more. */
export function verifyPrivateDirectoryAcl({ dir }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) blocked('bad_dir')
  if (!fs.existsSync(dir)) blocked('dir_missing')
  const script = `
$ErrorActionPreference = 'Stop'
$path = ${JSON.stringify(dir)}
$acl = Get-Acl -Path $path
$currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value
$allowed = @($currentSid, '${SID_SYSTEM}', '${SID_ADMINISTRATORS}')
$rows = @()
foreach ($ace in $acl.Access) {
  $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $rows += [PSCustomObject]@{ Sid = $sid; IsInherited = $ace.IsInherited; AccessControlType = $ace.AccessControlType.ToString(); AllowedPrincipal = ($allowed -contains $sid) }
}
[PSCustomObject]@{ AreAccessRulesProtected = $acl.AreAccessRulesProtected; Rows = $rows } | ConvertTo-Json -Depth 5 -Compress
`
  const out = runPowerShell(script)
  let parsed
  try { parsed = JSON.parse(out) } catch { blocked('acl_query_unparseable') }
  if (parsed.AreAccessRulesProtected !== true) blocked('acl_inheritance_not_disabled')
  const rows = Array.isArray(parsed.Rows) ? parsed.Rows : (parsed.Rows ? [parsed.Rows] : [])
  if (rows.length === 0) blocked('acl_no_entries')
  for (const row of rows) {
    if (row.IsInherited === true) blocked('acl_has_inherited_entry')
    if (row.AccessControlType !== 'Allow') blocked(`acl_unexpected_entry_type:${row.AccessControlType}`)
    if (row.AllowedPrincipal !== true) blocked(`acl_unexpected_principal:${row.Sid}`)
  }
  const currentSid = rows.find(r => r.Sid !== SID_SYSTEM && r.Sid !== SID_ADMINISTRATORS)
  if (!currentSid) blocked('acl_current_user_not_granted')
  return true
}

/** Per-file verification (checkpoint/manifest files) — same allowed-SID set
 * as the directory, but (unlike the directory itself) entries INHERITED
 * from a correctly-locked-down parent are expected and fine; only an
 * entry for a principal outside {current user, SYSTEM, Administrators} is
 * ever a violation. Called after every checkpoint/manifest write. */
export function verifyPrivateFileAcl({ filePath }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) blocked('bad_file_path')
  if (!fs.existsSync(filePath)) blocked('file_missing')
  const script = `
$ErrorActionPreference = 'Stop'
$path = ${JSON.stringify(filePath)}
$acl = Get-Acl -Path $path
$currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value
$allowed = @($currentSid, '${SID_SYSTEM}', '${SID_ADMINISTRATORS}')
$rows = @()
foreach ($ace in $acl.Access) {
  $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $rows += [PSCustomObject]@{ Sid = $sid; AccessControlType = $ace.AccessControlType.ToString(); AllowedPrincipal = ($allowed -contains $sid) }
}
[PSCustomObject]@{ Rows = $rows } | ConvertTo-Json -Depth 5 -Compress
`
  const out = runPowerShell(script)
  let parsed
  try { parsed = JSON.parse(out) } catch { blocked('acl_query_unparseable') }
  const rows = Array.isArray(parsed.Rows) ? parsed.Rows : (parsed.Rows ? [parsed.Rows] : [])
  if (rows.length === 0) blocked('acl_no_entries')
  for (const row of rows) {
    if (row.AccessControlType !== 'Allow') blocked(`acl_unexpected_entry_type:${row.AccessControlType}`)
    if (row.AllowedPrincipal !== true) blocked(`acl_unexpected_principal:${row.Sid}`)
  }
  return true
}
