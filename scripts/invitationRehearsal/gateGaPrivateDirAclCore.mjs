// gate-G-A private-directory ACL guard (FINAPP-1.0-SEC-006-GATE-G-A-PACKAGE-R8).
// Windows-only, by design: the checkpoint/manifest directory holds the
// recipient's CSPRNG password and the run's full identifying state. Before
// ANY checkpoint or manifest file is ever written — before any Auth user is
// created, before any email is sent — this directory's ACL must be locked
// down to exactly three principals (the current user, SYSTEM, and
// BUILTIN\Administrators), with inheritance disabled so no ambient
// permission from a parent directory can leak access in. Verification is by
// SID, never by localized account name (locale-independent). Any mismatch
// blocks — fail-closed, before any external side effect.
//
// R8: the directory's FIRST-EVER creation now applies the security
// descriptor as part of the SAME Win32 CreateDirectory call
// ([System.IO.Directory]::CreateDirectory($path, $security), a real,
// documented .NET Framework overload available under Windows PowerShell
// 5.1) — there is no longer a create-open-then-Set-Acl window where the
// directory briefly exists with default/inherited permissions. The
// Set-Acl rebuild path only ever runs against a directory that already
// exists (e.g. one left with a wrong ACL by a prior process) — an
// unavoidably non-atomic repair of pre-existing state, never the common
// first-creation path. The verifier now also asserts FullControl rights
// and (for the directory) the exact inheritance/propagation flags that
// make child-file inheritance work — a rule present but not marked
// ContainerInherit+ObjectInherit would silently stop protecting anything
// created inside the directory. File permission bits (e.g. 0o600 passed
// to fs.openSync) are NOT relied upon for security on Windows — Node does
// not enforce POSIX mode bits there; the only real protection is this
// directory ACL plus per-file inheritance, which verifyPrivateFileAcl
// checks after every checkpoint/manifest/journal-event write.
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

/** Creates `dir` if missing, with the locked-down ACL applied ATOMICALLY as
 * part of the directory's creation (never created-open-then-locked-down),
 * and enforces: inheritance disabled, exactly {current user, SYSTEM,
 * BUILTIN\Administrators} granted FullControl with ContainerInherit+
 * ObjectInherit, nothing else. Idempotent — safe to call on an
 * already-correct directory. */
export function ensurePrivateDirectoryAcl({ dir }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) blocked('bad_dir')
  // Idempotent: if the directory already exists with exactly the correct
  // ACL, re-running the rebuild is both unnecessary and (observed in
  // practice) can hit a SeSecurityPrivilege requirement on a second
  // DACL-protection rebuild even for the ACL's own owner — skip it
  // entirely when a plain verify already confirms nothing needs to change.
  if (fs.existsSync(dir)) {
    try { verifyPrivateDirectoryAcl({ dir }); return } catch { /* fall through and (re)apply */ }
  }
  const script = `
$ErrorActionPreference = 'Stop'
$dir = ${JSON.stringify(dir)}
$currentSid = [System.Security.Principal.WindowsIdentity]::GetCurrent().User
$systemSid = New-Object System.Security.Principal.SecurityIdentifier('${SID_SYSTEM}')
$adminsSid = New-Object System.Security.Principal.SecurityIdentifier('${SID_ADMINISTRATORS}')
if (-not (Test-Path -Path $dir)) {
  # Atomic path: the security descriptor is applied by the SAME Win32 call
  # that creates the directory — no window where $dir exists without it.
  $security = New-Object System.Security.AccessControl.DirectorySecurity
  $security.SetAccessRuleProtection($true, $false)
  foreach ($sid in @($currentSid, $systemSid, $adminsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $security.AddAccessRule($rule)
  }
  [System.IO.Directory]::CreateDirectory($dir, $security) | Out-Null
} else {
  # Repair path: the directory already exists (e.g. left by a prior
  # process with a wrong ACL) — this rebuild is unavoidably non-atomic,
  # but it never runs on the first-creation path above.
  $acl = Get-Acl -Path $dir
  $acl.SetAccessRuleProtection($true, $false)
  foreach ($rule in @($acl.Access)) { [void]$acl.RemoveAccessRule($rule) }
  foreach ($sid in @($currentSid, $systemSid, $adminsSid)) {
    $rule = New-Object System.Security.AccessControl.FileSystemAccessRule($sid, 'FullControl', 'ContainerInherit,ObjectInherit', 'None', 'Allow')
    $acl.AddAccessRule($rule)
  }
  Set-Acl -Path $dir -AclObject $acl
}
Write-Output 'DONE'
`
  const out = runPowerShell(script)
  if (!out.includes('DONE')) blocked('acl_setup_did_not_confirm')
  verifyPrivateDirectoryAcl({ dir })
}

function queryAclRows(targetPath, { includeInheritanceFlags }) {
  const flagsLine = includeInheritanceFlags
    ? 'InheritanceFlags = $ace.InheritanceFlags.ToString(); PropagationFlags = $ace.PropagationFlags.ToString();'
    : ''
  const script = `
$ErrorActionPreference = 'Stop'
$path = ${JSON.stringify(targetPath)}
$acl = Get-Acl -Path $path
$currentSid = ([System.Security.Principal.WindowsIdentity]::GetCurrent().User).Value
$allowed = @($currentSid, '${SID_SYSTEM}', '${SID_ADMINISTRATORS}')
$rows = @()
foreach ($ace in $acl.Access) {
  $sid = $ace.IdentityReference.Translate([System.Security.Principal.SecurityIdentifier]).Value
  $rows += [PSCustomObject]@{
    Sid = $sid
    IsInherited = $ace.IsInherited
    AccessControlType = $ace.AccessControlType.ToString()
    FileSystemRights = $ace.FileSystemRights.ToString()
    AllowedPrincipal = ($allowed -contains $sid)
    ${flagsLine}
  }
}
[PSCustomObject]@{ AreAccessRulesProtected = $acl.AreAccessRulesProtected; CurrentSid = $currentSid; Rows = $rows } | ConvertTo-Json -Depth 5 -Compress
`
  const out = runPowerShell(script)
  let parsed
  try { parsed = JSON.parse(out) } catch { blocked('acl_query_unparseable') }
  parsed.Rows = Array.isArray(parsed.Rows) ? parsed.Rows : (parsed.Rows ? [parsed.Rows] : [])
  return parsed
}

function hasFullControl(rightsString) {
  // .NET renders a combined FullControl grant either as the literal
  // "FullControl" or as the fully-enumerated flag list depending on how
  // the ACE was constructed; both are accepted, but nothing weaker is.
  return rightsString === 'FullControl' || rightsString.split(',').map(s => s.trim()).includes('FullControl')
}

/** Fail-closed verification, callable independently of setup (and used on
 * every resume, and after every checkpoint/manifest/journal write) — never
 * assumes a directory it didn't just create is still correctly locked
 * down. Checks, by SID: zero inherited entries, exactly the allow-set
 * {current user, SYSTEM, Administrators} (no more, no fewer), each with
 * FullControl and ContainerInherit+ObjectInherit (so files created inside
 * genuinely inherit the same protection — a rule missing those flags would
 * protect the directory itself but silently stop propagating). */
export function verifyPrivateDirectoryAcl({ dir }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof dir !== 'string' || !path.isAbsolute(dir)) blocked('bad_dir')
  if (!fs.existsSync(dir)) blocked('dir_missing')
  const parsed = queryAclRows(dir, { includeInheritanceFlags: true })
  if (parsed.AreAccessRulesProtected !== true) blocked('acl_inheritance_not_disabled')
  const rows = parsed.Rows
  if (rows.length === 0) blocked('acl_no_entries')
  const requiredSids = new Set([parsed.CurrentSid, SID_SYSTEM, SID_ADMINISTRATORS])
  const seenSids = new Set()
  for (const row of rows) {
    if (row.IsInherited === true) blocked('acl_has_inherited_entry')
    if (row.AccessControlType !== 'Allow') blocked(`acl_unexpected_entry_type:${row.AccessControlType}`)
    if (row.AllowedPrincipal !== true) blocked(`acl_unexpected_principal:${row.Sid}`)
    if (!hasFullControl(row.FileSystemRights)) blocked(`acl_insufficient_rights:${row.Sid}:${row.FileSystemRights}`)
    const inheritance = String(row.InheritanceFlags ?? '')
    if (!inheritance.includes('ContainerInherit') || !inheritance.includes('ObjectInherit')) blocked(`acl_missing_inheritance_flags:${row.Sid}:${inheritance}`)
    if (seenSids.has(row.Sid)) blocked(`acl_duplicate_principal:${row.Sid}`)
    seenSids.add(row.Sid)
  }
  for (const required of requiredSids) if (!seenSids.has(required)) blocked(`acl_required_principal_missing:${required}`)
  if (seenSids.size !== requiredSids.size) blocked('acl_extra_principal_present')
  return true
}

/** Per-file verification (checkpoint/manifest/journal-event files) — same
 * allowed-SID set as the directory, but (unlike the directory itself)
 * entries INHERITED from a correctly-locked-down parent are expected and
 * fine; only an entry for a principal outside {current user, SYSTEM,
 * Administrators}, a Deny entry, or a grant weaker than FullControl is
 * ever a violation. Called after every checkpoint/manifest/journal write —
 * this is the only real protection a file gets on Windows; POSIX mode
 * bits passed to fs.openSync (e.g. 0o600) are not enforced there. */
export function verifyPrivateFileAcl({ filePath }) {
  if (os.platform() !== 'win32') blocked('unsupported_platform')
  if (typeof filePath !== 'string' || !path.isAbsolute(filePath)) blocked('bad_file_path')
  if (!fs.existsSync(filePath)) blocked('file_missing')
  const parsed = queryAclRows(filePath, { includeInheritanceFlags: false })
  const rows = parsed.Rows
  if (rows.length === 0) blocked('acl_no_entries')
  const requiredSids = new Set([parsed.CurrentSid, SID_SYSTEM, SID_ADMINISTRATORS])
  const seenSids = new Set()
  for (const row of rows) {
    if (row.AccessControlType !== 'Allow') blocked(`acl_unexpected_entry_type:${row.AccessControlType}`)
    if (row.AllowedPrincipal !== true) blocked(`acl_unexpected_principal:${row.Sid}`)
    if (!hasFullControl(row.FileSystemRights)) blocked(`acl_insufficient_rights:${row.Sid}:${row.FileSystemRights}`)
    seenSids.add(row.Sid)
  }
  for (const required of requiredSids) if (!seenSids.has(required)) blocked(`acl_required_principal_missing:${required}`)
  if (seenSids.size !== requiredSids.size) blocked('acl_extra_principal_present')
  return true
}
