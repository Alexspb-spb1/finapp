<#
.SYNOPSIS
  SEC-006-GATE-GA-STAGING-INVITE-REHEARSAL - one owner-run staging invitation
  rehearsal against real finapp-staging, using the reviewed, CI-verified
  branch remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING-winverify.

.DESCRIPTION
  Every identity fact about this rehearsal (recipient, project, remote,
  branch, commit, Firebase account, legacyCleanupApproved) is hard-coded
  below, not a parameter - this script runs exactly one approved scenario,
  nothing else. Only the working directory, the two required input file
  paths, and an optional Node 22 path are configurable.

  Prepares a clean, isolated checkout (core.autocrlf=false, to avoid the
  known Windows CRLF/CODE-SHA256SUMS.txt mismatch), verifies every local
  precondition (HEAD, package bytes, baseline-receipt hash, Firebase CLI
  identity, Node versions, that every output path is new), runs the
  required read-only staging evidence steps, builds one fresh approval,
  and invokes gateGaSecureExecutor.mjs --execute --profile staging exactly
  once.

  SAFE_STOP conditions BEFORE any email is sent (script exits nonzero,
  via Write-SafeStop, whose "no email was sent" claim is true everywhere
  it is used - see the note below about why it is NOT used after the
  executor runs):
    - HEAD does not match the pinned, reviewed commit exactly.
    - The working tree is not clean.
    - The package-integrity check fails (any of the 19 files in
      CODE-SHA256SUMS.txt mismatch).
    - The baseline receipt's SHA-256 does not match
      EXPECTED_BASELINE_RECEIPT_SHA256 as pinned in this exact commit's
      own gateGaDeploymentCheck13Core.mjs.
    - The currently logged-in Firebase CLI account is not the hard-coded
      account below.
    - node --version for the root toolkit is not the hard-coded version.
    - Any evidence/output path (functions receipt, mailbox receipt, auth
      metadata receipt, approval, journal, out, or the out.recovery.jsonl
      file the executor derives from --out) already exists.
    - Any read-only evidence step (deployment check / mailbox discovery /
      auth metadata discovery) exits non-zero.
    - Mailbox discovery's report does not parse as JSON, or its
      accountExists field is anything other than the strict boolean
      $false (missing field, a truthy value, a non-boolean value such as
      the string "false", or a JSON parse error, all stop the script -
      only an exact, typed accountExists: false is treated as "safe to
      proceed"; see Test-MailboxAccountExistsFalse).
    - Approval-draft building fails.

  AFTER gateGaSecureExecutor.mjs runs, this script does NOT call
  Write-SafeStop - by that point an email may genuinely have been sent,
  so printing "no email was sent" could be false. Instead:
    - Missing --out file -> logged as a CRITICAL failure, exit code 2.
    - --out present but corrupted, truncated, or not a JSON object ->
      CRITICAL, exit code 2, journal/recovery paths printed; the read and
      parse are wrapped in try/catch, never an unhandled error.
    - emailsSent missing, not a JSON number (the string "1" is rejected),
      or > 1 -> CRITICAL regardless of any other field, exit code 3.
    - --out content says PASS but the executor process exited nonzero ->
      "CRITICAL: executor exit/status mismatch", exit code 3.
    - A clean, fully-verified pass is recognized ONLY when ALL of:
      the executor's own exit code = 0, status = PASS,
      flowOutcome.status = PASS,
      cleanup.status = CLEANUP_COMPLETE_VERIFIED,
      legacyCleanup.status = NOT_APPLICABLE, emailsSent = 1 (numeric).
      Only this exact combination exits 0.
    - Anything else (including a normal, fully-cleaned-up SAFE_STOP, e.g.
      the recipient never clicked the verification link in time) exits 1.
    - If the run's own runId is present (meaning it very likely created
      real resources) and cleanup.status is not CLEANUP_COMPLETE_VERIFIED,
      this script prints RECOVERY_REQUIRED with the journal and recovery
      file paths, since automated cleanup did not confirm a clean state
      and manual review is needed.
    - The full --out JSON is never printed - only a safe summary (status,
      reason, flow status, cleanup statuses, emailsSent, and the evidence/
      journal/recovery paths).

  EXECUTE behavior (what happens after the email is sent):
    gateGaSecureExecutor.mjs --execute --profile staging is ONE
    synchronous process. After it dispatches the verification email it
    calls into the same run's pollForVerification loop and BLOCKS,
    checking the recipient's Auth record every 5 seconds for up to 10
    minutes (gateGaOrchestratorCore.mjs's DEFAULT_VERIFICATION_DEADLINE_MS
    / DEFAULT_VERIFICATION_INTERVAL_MS - both default, neither overridden
    by this script). During this wait:
      - You must open the real email sent to the recipient address and
        click its verification link yourself - nothing else clicks it.
      - The PowerShell window running this script will appear to pause;
        this script streams the child process's stdout live (no
        buffering), so any lines it prints during the wait appear
        immediately, but the orchestrator does not print a line per poll
        tick - silence for up to ~10 minutes is expected and normal, not
        a hang.
      - For finer-grained live progress, open a second PowerShell window
        and run:  Get-Content <journal path printed above> -Wait -Tail 5
        (the journal is a JSON-Lines file appended in real time as each
        step happens, including VERIFICATION_POLL_STARTED/FINISHED).
      - If you click the link in time: the same process signs the
        recipient in, accepts the invitation (twice, to prove replay
        idempotency), verifies exactly one audit event was written, then
        falls through to cleanup of the run it just created, and exits
        with status PASS.
      - If you do NOT click the link within 10 minutes (or the email
        never arrives): the process's own poll times out, it still runs
        cleanup of whatever it created (admin/company/invitation records
        from this run only - never anything pre-existing), and exits
        with status SAFE_STOP, reason verification_not_completed. No
        further action from you is required in that case; the script
        finishes on its own and prints the final safe summary either way.

  This script never deletes, modifies, or touches any pre-existing
  staging record. legacyCleanupApproved is hard-coded false. Only project
  touched is finapp-staging; main, PR #28, DNS and billing/banking
  integration are never referenced.

  Secrets: .env.staging.local (real Web API key) is copied byte-for-byte
  into the isolated checkout and never printed; only its non-secret
  STAGING_FIREBASE_CONFIG_FINGERPRINT value (a SHA-256 digest, explicitly
  documented upstream as non-reversible/non-secret) is read and reused.
  No token, password, or API key is ever written to console output or to
  the final summary. In `finally`, only the COPY of .env.staging.local
  made inside the isolated checkout is deleted - your original file and
  every evidence file (receipts/approval/journal/out/recovery) are left
  in place for audit.

.PARAMETER WorkDir
  Where to create the isolated checkout + private evidence directory.
  Defaults to a fresh timestamped folder under $env:TEMP.

.PARAMETER EnvStagingLocalPath
  REQUIRED (unless -SelfTest). Absolute path to your existing, real
  .env.staging.local. Not created by this script.

.PARAMETER BaselineReceiptPath
  REQUIRED (unless -SelfTest). Absolute path to the existing, provenance-
  verified baseline functions receipt. Not created by this script. Its
  SHA-256 is checked against EXPECTED_BASELINE_RECEIPT_SHA256 as pinned in
  the checked-out commit before any staging call is made.

.PARAMETER Node22Path
  Path to a Node >=22.12.0 executable, checked for presence/version only
  (informational - functions/lib is never built or loaded locally for a
  --profile staging run, so this is NOT actually invoked by this script).

.PARAMETER SelfTest
  Runs the deterministic, offline unit tests for the mailbox-strictness
  and post-executor result-classification logic (six fixed scenarios)
  against fabricated JSON and exits - no git, no npm, no network, no
  staging call of any kind. Use this to verify the decision logic itself
  without touching anything real.

.EXAMPLE
  & 'D:\projects\finapp\.runtime\Run-GateGaStagingInviteRehearsal.ps1' `
    -EnvStagingLocalPath 'D:\projects\finapp\.env.staging.local' `
    -BaselineReceiptPath 'D:\projects\finapp\.runtime\stage8-deployment-postflight-ab1bd67.json'

.EXAMPLE
  & 'D:\projects\finapp\.runtime\Run-GateGaStagingInviteRehearsal.ps1' -SelfTest
#>
[CmdletBinding()]
param(
  [string]$WorkDir = (Join-Path $env:TEMP "gate-ga-staging-rehearsal-$(Get-Date -Format 'yyyyMMdd-HHmmss')"),
  [string]$EnvStagingLocalPath,
  [string]$BaselineReceiptPath,
  [string]$Node22Path = 'D:\projects\finapp\.runtime\node22-portable\node-v22.23.3-win-x64\node.exe',
  [switch]$SelfTest
)

$ErrorActionPreference = 'Stop'

# --- Hard-coded identity of this one approved scenario - NOT parameters ---
$Recipient = 'lesenenok8787@gmail.com'
$Project = 'finapp-staging'
$RemoteUrl = 'https://github.com/Alexspb-spb1/finapp.git'
$Branch = 'remediation/SEC-006-GATE-GA-APPROVAL-EVIDENCE-BINDING-winverify'
$ExpectedCommit = 'fdf8cab0ca114ba28994bf8f0da1e5bc8a8c2a6e'
$ExpectedFirebaseAccount = 'lesenenok8787@gmail.com'
$ExpectedRootNodeVersion = 'v24.16.0'
$LegacyCleanupApproved = 'false'

function Write-Step($text) { Write-Host "`n=== $text ===" -ForegroundColor Cyan }
function Write-SafeStop($reason) {
  Write-Host "`nSAFE_STOP: $reason" -ForegroundColor Yellow
  Write-Host 'No email was sent. No pre-existing staging record was touched.' -ForegroundColor Yellow
  exit 1
}

# Streams the child process's stdout live (no buffering - required so a
# long wait, such as the up-to-10-minute email-verification poll, does
# not look like a silent hang) while also capturing it for callers that
# need to parse a specific line afterward (e.g. the approval draft's
# printed hash). Deliberately does NOT redirect/merge stderr (no 2>&1):
# PowerShell 5.1 wraps a redirected native command's stderr lines as
# terminating ErrorRecord objects, so a perfectly harmless line such as
# `npm warn deprecated ...` would otherwise abort this whole script under
# $ErrorActionPreference = 'Stop' (confirmed by direct reproduction).
# Leaving stderr unredirected lets it print straight to the console, live,
# exactly as the tool itself intended, with no wrapping and no exit-code
# side effect.
function Invoke-Checked([string]$Exe, [string[]]$ArgList, [string]$Cwd) {
  Push-Location $Cwd
  try {
    $capturedLines = New-Object System.Collections.Generic.List[string]
    & $Exe @ArgList | ForEach-Object {
      $line = $_.ToString()
      Write-Host $line
      $capturedLines.Add($line)
    }
    $exitCode = $LASTEXITCODE
    return [PSCustomObject]@{ ExitCode = $exitCode; StdOut = ($capturedLines -join "`n") }
  }
  finally { Pop-Location }
}

# node -e '<script>' is NOT used anywhere in this file: PowerShell 5.1's
# argument marshaling to native executables strips embedded double-quote
# characters from a string passed this way (confirmed by direct
# reproduction - a script containing require("fs") arrives at node as
# require(fs), a SyntaxError). Every inline script below is instead
# written to a real temp .js file and run as `node <file> [args...]`,
# which sidesteps that quoting problem entirely.
function Invoke-NodeScript([string]$Script, [string[]]$ScriptArgs, [string]$Cwd, [string]$HelperDir) {
  $tempFile = Join-Path $HelperDir "helper-$([guid]::NewGuid().ToString('N')).js"
  Set-Content -LiteralPath $tempFile -Value $Script -Encoding ASCII -NoNewline
  try {
    return Invoke-Checked 'node' (@($tempFile) + $ScriptArgs) $Cwd
  }
  finally {
    Remove-Item -LiteralPath $tempFile -Force -ErrorAction SilentlyContinue
  }
}

function Assert-PathIsNew([string]$Label, [string]$Path) {
  if (Test-Path -LiteralPath $Path) { Write-SafeStop "$Label already exists (must be new): $Path" }
}

# Strict by construction: returns $true ONLY when the parsed JSON has an
# accountExists property whose value is the literal boolean $false. A
# parse error, a missing property, a truthy value, or any non-boolean
# representation (e.g. the string "false") all return $false, which the
# caller treats as SAFE_STOP - never "proceed by default".
function Test-MailboxAccountExistsFalse([string]$JsonText) {
  try {
    $obj = $JsonText | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    return $false
  }
  if (-not $obj) { return $false }
  if (-not ($obj.PSObject.Properties.Name -contains 'accountExists')) { return $false }
  $value = $obj.accountExists
  if ($value -is [bool] -and $value -eq $false) { return $true }
  return $false
}

# Classifies a parsed --out object into the exact pass/critical/recovery
# decision described in the header comment. Pure function of its input -
# no I/O - so it is directly unit-testable via -SelfTest.
function Get-ExecutorOutcomeSummary($OutJson, [int]$ExecutorExitCode) {
  $emailsSent = $OutJson.emailsSent
  $status = $OutJson.status
  $flowStatus = $OutJson.flowOutcome.status
  $cleanupStatus = $OutJson.cleanup.status
  $legacyCleanupStatus = $OutJson.legacyCleanup.status
  $runId = $OutJson.runId
  $reason = $null
  if ($OutJson.PSObject.Properties.Name -contains 'reason' -and $OutJson.reason) { $reason = $OutJson.reason }
  elseif ($OutJson.flowOutcome -and ($OutJson.flowOutcome.PSObject.Properties.Name -contains 'reason')) { $reason = $OutJson.flowOutcome.reason }

  # emailsSent must be a real JSON number: the string "1" would otherwise
  # satisfy `-eq 1` through PowerShell's implicit string-to-number
  # coercion. A missing, non-numeric, or > 1 value is CRITICAL.
  $emailsIsNumeric = ($emailsSent -is [int]) -or ($emailsSent -is [long]) -or ($emailsSent -is [double]) -or ($emailsSent -is [decimal])
  $critical = (-not $emailsIsNumeric) -or ($emailsSent -gt 1)

  # The five content conditions alone (independent of the executor's exit code).
  $contentPass = (-not $critical) -and $status -eq 'PASS' -and $flowStatus -eq 'PASS' -and
    $cleanupStatus -eq 'CLEANUP_COMPLETE_VERIFIED' -and $legacyCleanupStatus -eq 'NOT_APPLICABLE' -and $emailsSent -eq 1

  # PASS is granted only when the content says PASS AND the executor's own
  # process exit code was 0. Content that says PASS under a nonzero exit is
  # an inconsistency, never a pass.
  $exitMismatch = $contentPass -and ($ExecutorExitCode -ne 0)
  $passOk = $contentPass -and ($ExecutorExitCode -eq 0)

  $recoveryRequired = (-not $passOk) -and (-not [string]::IsNullOrEmpty($runId)) -and ($cleanupStatus -ne 'CLEANUP_COMPLETE_VERIFIED')

  return [PSCustomObject]@{
    PassOk = $passOk; Critical = $critical; ExitMismatch = $exitMismatch; RecoveryRequired = $recoveryRequired
    Status = $status; FlowStatus = $flowStatus; CleanupStatus = $cleanupStatus; LegacyCleanupStatus = $legacyCleanupStatus
    EmailsSent = $emailsSent; Reason = $reason; RunId = $runId; ExecutorExitCode = $ExecutorExitCode
  }
}

# Reads and parses the executor's --out file. Never throws: any read or
# parse failure, or a parsed value that is not a JSON object (e.g. null, a
# bare number/string), yields Ok = $false so the caller reports CRITICAL
# instead of dying with an unhandled error.
function Read-ExecutorOut([string]$Path) {
  try {
    $text = Get-Content -LiteralPath $Path -Raw -ErrorAction Stop
    $parsed = $text | ConvertFrom-Json -ErrorAction Stop
  }
  catch {
    return [PSCustomObject]@{ Ok = $false; Json = $null }
  }
  if ($null -eq $parsed -or $parsed -isnot [System.Management.Automation.PSCustomObject]) {
    return [PSCustomObject]@{ Ok = $false; Json = $null }
  }
  return [PSCustomObject]@{ Ok = $true; Json = $parsed }
}

function Write-OutcomeSummary($Outcome) {
  Write-Host "status: $($Outcome.Status)"
  if ($Outcome.Reason) { Write-Host "reason: $($Outcome.Reason)" }
  Write-Host "flowOutcome.status: $($Outcome.FlowStatus)"
  Write-Host "cleanup.status: $($Outcome.CleanupStatus)"
  Write-Host "legacyCleanup.status: $($Outcome.LegacyCleanupStatus)"
  Write-Host "emailsSent: $($Outcome.EmailsSent)"
  if ($Outcome.RunId) { Write-Host "runId: $($Outcome.RunId)" }
}

if ($SelfTest) {
  Write-Step 'SELF-TEST: deterministic result-classification checks (no git/npm/network/staging)'
  $failures = 0
  function Assert-Equal($label, $expected, $actual) {
    if ($expected -eq $actual) { Write-Host "  ok   $label" -ForegroundColor Green }
    else { Write-Host "  FAIL $label (expected $expected, got $actual)" -ForegroundColor Red; $script:failures++ }
  }

  Write-Host '-- Test-MailboxAccountExistsFalse --'
  Assert-Equal 'accountExists: false (bool) -> proceed'     $true  (Test-MailboxAccountExistsFalse '{"accountExists":false}')
  Assert-Equal 'accountExists: true (bool) -> stop'          $false (Test-MailboxAccountExistsFalse '{"accountExists":true}')
  Assert-Equal 'accountExists missing -> stop'                $false (Test-MailboxAccountExistsFalse '{"other":1}')
  Assert-Equal 'accountExists: "false" (string) -> stop'      $false (Test-MailboxAccountExistsFalse '{"accountExists":"false"}')
  Assert-Equal 'corrupted / not JSON -> stop'                 $false (Test-MailboxAccountExistsFalse '{not valid json')

  Write-Host '-- Get-ExecutorOutcomeSummary --'
  $passJsonText = '{"status":"PASS","runId":"r1","flowOutcome":{"status":"PASS"},"cleanup":{"status":"CLEANUP_COMPLETE_VERIFIED"},"legacyCleanup":{"status":"NOT_APPLICABLE"},"emailsSent":1}'
  $passJson = $passJsonText | ConvertFrom-Json
  $o1 = Get-ExecutorOutcomeSummary $passJson 0
  Assert-Equal 'correct PASS + executor exit 0 -> PassOk true (success)' $true  $o1.PassOk
  Assert-Equal 'correct PASS + executor exit 0 -> Critical false'        $false $o1.Critical
  Assert-Equal 'correct PASS + executor exit 0 -> ExitMismatch false'    $false $o1.ExitMismatch
  Assert-Equal 'correct PASS + executor exit 0 -> RecoveryRequired false' $false $o1.RecoveryRequired

  $o1b = Get-ExecutorOutcomeSummary $passJson 1
  Assert-Equal 'PASS content + executor exit 1 -> PassOk false (rejected)' $false $o1b.PassOk
  Assert-Equal 'PASS content + executor exit 1 -> ExitMismatch true'       $true  $o1b.ExitMismatch

  $stringEmailsJson = '{"status":"PASS","runId":"r1s","flowOutcome":{"status":"PASS"},"cleanup":{"status":"CLEANUP_COMPLETE_VERIFIED"},"legacyCleanup":{"status":"NOT_APPLICABLE"},"emailsSent":"1"}' | ConvertFrom-Json
  $o1c = Get-ExecutorOutcomeSummary $stringEmailsJson 0
  Assert-Equal 'emailsSent as string "1" -> PassOk false (numeric type required)' $false $o1c.PassOk
  Assert-Equal 'emailsSent as string "1" -> Critical true'                        $true  $o1c.Critical

  $safeStopCleanJson = '{"status":"SAFE_STOP","runId":"r2","flowOutcome":{"status":"NOT_STARTED","reason":"verification_not_completed"},"cleanup":{"status":"CLEANUP_COMPLETE_VERIFIED"},"legacyCleanup":{"status":"NOT_APPLICABLE"},"emailsSent":1}' | ConvertFrom-Json
  $o2 = Get-ExecutorOutcomeSummary $safeStopCleanJson 1
  Assert-Equal 'SAFE_STOP after 1 email, cleaned -> PassOk false' $false $o2.PassOk
  Assert-Equal 'SAFE_STOP after 1 email, cleaned -> Critical false' $false $o2.Critical
  Assert-Equal 'SAFE_STOP after 1 email, cleaned -> RecoveryRequired false' $false $o2.RecoveryRequired

  # Missing --out is checked at the call site via Test-Path before
  # Get-ExecutorOutcomeSummary is ever invoked - exercise that exact
  # mechanism against a path guaranteed not to exist.
  $missingOutPath = Join-Path $env:TEMP "gate-ga-selftest-missing-out-$([guid]::NewGuid().ToString('N')).json"
  Assert-Equal 'missing --out path -> Test-Path returns false (triggers CRITICAL exit 2 in the script body)' $false (Test-Path -LiteralPath $missingOutPath)

  $twoEmailsJson = '{"status":"SAFE_STOP","runId":"r4","flowOutcome":{"status":"NOT_STARTED"},"cleanup":{"status":"CLEANUP_COMPLETE_VERIFIED"},"legacyCleanup":{"status":"NOT_APPLICABLE"},"emailsSent":2}' | ConvertFrom-Json
  $o4 = Get-ExecutorOutcomeSummary $twoEmailsJson 1
  Assert-Equal 'emailsSent=2 -> Critical true' $true $o4.Critical
  Assert-Equal 'emailsSent=2 -> PassOk false'  $false $o4.PassOk

  $unconfirmedCleanupJson = '{"status":"SAFE_STOP","runId":"r5","flowOutcome":{"status":"NOT_STARTED"},"cleanup":{"status":"CLEANUP_REFUSED","reason":"delete_failed"},"legacyCleanup":{"status":"NOT_APPLICABLE"},"emailsSent":0}' | ConvertFrom-Json
  $o5 = Get-ExecutorOutcomeSummary $unconfirmedCleanupJson 1
  Assert-Equal 'unconfirmed cleanup with runId -> RecoveryRequired true' $true $o5.RecoveryRequired
  Assert-Equal 'unconfirmed cleanup -> PassOk false' $false $o5.PassOk

  Write-Host '-- Read-ExecutorOut (corrupted / incomplete --out) --'
  $corruptOutPath = Join-Path $env:TEMP "gate-ga-selftest-corrupt-out-$([guid]::NewGuid().ToString('N')).json"
  try {
    Set-Content -LiteralPath $corruptOutPath -Value '{"status":"PASS","emailsSent":1,' -NoNewline -Encoding ASCII
    $corruptRead = Read-ExecutorOut $corruptOutPath
    Assert-Equal 'corrupted (truncated) --out -> Ok false (rejected, no unhandled error)' $false $corruptRead.Ok

    Set-Content -LiteralPath $corruptOutPath -Value 'null' -NoNewline -Encoding ASCII
    Assert-Equal 'JSON null --out -> Ok false' $false (Read-ExecutorOut $corruptOutPath).Ok

    Set-Content -LiteralPath $corruptOutPath -Value $passJsonText -NoNewline -Encoding ASCII
    Assert-Equal 'well-formed --out object -> Ok true' $true (Read-ExecutorOut $corruptOutPath).Ok

    Set-Content -LiteralPath $corruptOutPath -Value '{"status":"PASS"}' -NoNewline -Encoding ASCII
    $incomplete = Read-ExecutorOut $corruptOutPath
    $oInc = Get-ExecutorOutcomeSummary $incomplete.Json 0
    Assert-Equal 'incomplete but valid JSON (no emailsSent etc.) -> PassOk false' $false $oInc.PassOk
    Assert-Equal 'incomplete but valid JSON (no emailsSent etc.) -> Critical true' $true $oInc.Critical
  }
  finally {
    Remove-Item -LiteralPath $corruptOutPath -Force -ErrorAction SilentlyContinue
  }

  if ($failures -eq 0) { Write-Host "`nSELF-TEST: all checks passed" -ForegroundColor Green; exit 0 }
  else { Write-Host "`nSELF-TEST: $failures check(s) FAILED" -ForegroundColor Red; exit 1 }
}

if (-not $EnvStagingLocalPath -or -not $BaselineReceiptPath) {
  Write-SafeStop 'EnvStagingLocalPath and BaselineReceiptPath are required unless -SelfTest is used'
}
if (-not (Test-Path -LiteralPath $EnvStagingLocalPath -PathType Leaf)) {
  Write-SafeStop "EnvStagingLocalPath not found: $EnvStagingLocalPath (must already exist; this script does not create it)"
}
if (-not (Test-Path -LiteralPath $BaselineReceiptPath -PathType Leaf)) {
  Write-SafeStop "BaselineReceiptPath not found: $BaselineReceiptPath (must already exist; this script does not create it)"
}

Write-Step 'Preflight: node / git availability and root Node version'
$nodeVersion = (& node --version) 2>$null
if (-not $nodeVersion) { Write-SafeStop 'node not found on PATH' }
Write-Host "node --version (root): $nodeVersion"
if ($nodeVersion.Trim() -ne $ExpectedRootNodeVersion) {
  Write-SafeStop "root Node version mismatch: expected $ExpectedRootNodeVersion (per package.json engines), found $nodeVersion"
}
$gitVersion = (& git --version) 2>$null
if (-not $gitVersion) { Write-SafeStop 'git not found on PATH' }
Write-Host $gitVersion

Write-Step 'Preflight: Node 22 presence (informational - not used for a staging run; functions/lib is never built/loaded locally for --profile staging)'
if (Test-Path -LiteralPath $Node22Path -PathType Leaf) {
  $node22Version = (& $Node22Path --version) 2>$null
  Write-Host "Node 22 found: $Node22Path -> $node22Version"
} else {
  Write-Host "Node 22 not found at $Node22Path - not required for this staging path, continuing." -ForegroundColor Yellow
}

$RepoDir = Join-Path $WorkDir 'repo'
$PrivateDir = Join-Path $WorkDir 'private'
$HelperDir = Join-Path $WorkDir 'node-helpers'
New-Item -ItemType Directory -Force -Path $WorkDir | Out-Null
New-Item -ItemType Directory -Force -Path $PrivateDir | Out-Null
New-Item -ItemType Directory -Force -Path $HelperDir | Out-Null
$copiedEnvStagingLocal = $null

Write-Step "Clean checkout (core.autocrlf=false) of $Branch @ $ExpectedCommit"
& git -c core.autocrlf=false clone --no-hardlinks --single-branch --branch $Branch $RemoteUrl $RepoDir
if ($LASTEXITCODE -ne 0) { Write-SafeStop 'git clone failed' }
Push-Location $RepoDir
try {
  & git config core.autocrlf false
  $actualHead = (& git rev-parse HEAD).Trim()
  if ($actualHead -ne $ExpectedCommit) {
    Write-SafeStop "HEAD mismatch: expected $ExpectedCommit, got $actualHead"
  }
  $status = (& git status --porcelain --untracked-files=all)
  if ($status) { Write-SafeStop "working tree not clean:`n$status" }
  Write-Host "HEAD confirmed: $actualHead (clean)"

  Write-Step 'Package-integrity: verify all 19 files in CODE-SHA256SUMS.txt (real on-disk bytes)'
  $packageIntegrityScript = 'const fs=require("fs"),crypto=require("crypto"),path=require("path");const dir="scripts/invitationRehearsal";const lines=fs.readFileSync(path.join(dir,"CODE-SHA256SUMS.txt"),"utf8").trim().split("\n");let bad=0;for(const line of lines){const m=/^([a-f0-9]{64})\s+\*?(.+)$/.exec(line.trimEnd());if(!m)throw Error("invalid manifest");const actual=crypto.createHash("sha256").update(fs.readFileSync(path.join(dir,m[2]))).digest("hex");if(actual!==m[1]){console.error("PACKAGE_BYTE_MISMATCH",m[2]);bad++}}if(bad)process.exit(1);console.log("PACKAGE_BYTES_VERIFIED",lines.length)'
  $verify = Invoke-NodeScript $packageIntegrityScript @() $RepoDir $HelperDir
  if ($verify.ExitCode -ne 0) { Write-SafeStop 'package-integrity (CODE-SHA256SUMS.txt) check failed' }

  Write-Step 'Baseline receipt: verify SHA-256 against EXPECTED_BASELINE_RECEIPT_SHA256 pinned in this exact commit'
  $pinnedHashScript = 'const fs=require("fs");const content=fs.readFileSync("scripts/invitationRehearsal/gateGaDeploymentCheck13Core.mjs","utf8");const m=/EXPECTED_BASELINE_RECEIPT_SHA256\s*=\s*.([a-f0-9]{64})./.exec(content);if(!m)throw Error("constant not found");console.log(m[1])'
  $pinnedHashResult = Invoke-NodeScript $pinnedHashScript @() $RepoDir $HelperDir
  $pinnedHash = ($pinnedHashResult.StdOut -split "`n" | Where-Object { $_ -match '^[a-f0-9]{64}$' } | Select-Object -First 1)
  if ($pinnedHashResult.ExitCode -ne 0 -or -not $pinnedHash) { Write-SafeStop 'could not extract EXPECTED_BASELINE_RECEIPT_SHA256 from the checked-out source' }
  $actualBaselineHash = (Get-FileHash -LiteralPath $BaselineReceiptPath -Algorithm SHA256).Hash.ToLowerInvariant()
  if ($actualBaselineHash -ne $pinnedHash) {
    Write-SafeStop "baseline receipt hash mismatch: expected $pinnedHash, got $actualBaselineHash (file: $BaselineReceiptPath)"
  }
  Write-Host "Baseline receipt hash confirmed: $actualBaselineHash"

  Write-Step 'Copy .env.staging.local (not printed) into the isolated checkout'
  $copiedEnvStagingLocal = Join-Path $RepoDir '.env.staging.local'
  Copy-Item -LiteralPath $EnvStagingLocalPath -Destination $copiedEnvStagingLocal -Force
  $envLines = Get-Content -LiteralPath $copiedEnvStagingLocal
  $fingerprintLine = $envLines | Where-Object { $_ -match '^STAGING_FIREBASE_CONFIG_FINGERPRINT=' }
  if (-not $fingerprintLine) { Write-SafeStop 'STAGING_FIREBASE_CONFIG_FINGERPRINT not present in .env.staging.local' }
  $stagingFingerprint = ($fingerprintLine -split '=', 2)[1].Trim()
  if ($stagingFingerprint -notmatch '^[a-f0-9]{64}$') { Write-SafeStop 'STAGING_FIREBASE_CONFIG_FINGERPRINT is not a 64-hex value' }
  Write-Host 'Fingerprint read (value not printed: it is a non-secret SHA-256, but withheld here for consistency with the no-secrets-in-output rule).'

  Write-Step 'npm ci (root toolkit dependencies)'
  $npmCi = Invoke-Checked 'npm' @('ci') $RepoDir
  if ($npmCi.ExitCode -ne 0) { Write-SafeStop 'npm ci failed' }

  Write-Step "Firebase CLI identity: must be logged in as $ExpectedFirebaseAccount (local config read only, no network call)"
  $authCheckScript = 'const path=require("path");const root=process.cwd();const ft=n=>require(path.join(root,"node_modules/firebase-tools/lib",n));const account=ft("auth.js").getGlobalDefaultAccount();const email=account&&account.user&&account.user.email;if(email!==process.argv[2]){console.error("FIREBASE_ACCOUNT_MISMATCH",email||"(not logged in)");process.exit(1)}console.log("FIREBASE_ACCOUNT_OK",email)'
  $authIdentity = Invoke-NodeScript $authCheckScript @($ExpectedFirebaseAccount) $RepoDir $HelperDir
  if ($authIdentity.ExitCode -ne 0) { Write-SafeStop "Firebase CLI is not logged in as $ExpectedFirebaseAccount (run 'firebase login' first)" }

  $recipientTrimmedLower = $Recipient.Trim().ToLowerInvariant()
  $recipientHashScript = "console.log(require('crypto').createHash('sha256').update(process.argv[2]).digest('hex'))"
  $recipientConfirmedSha256 = (Invoke-NodeScript $recipientHashScript @($recipientTrimmedLower) $RepoDir $HelperDir).StdOut.Trim()
  if ($recipientConfirmedSha256 -notmatch '^[a-f0-9]{64}$') { Write-SafeStop 'failed to compute recipient-confirmed hash' }

  $functionsReceiptPath = Join-Path $PrivateDir 'functions-receipt.json'
  $mailboxFile = Join-Path $PrivateDir 'mailbox-recipient.txt'
  $mailboxReceiptPath = Join-Path $PrivateDir 'mailbox-receipt.json'
  $authMetadataReceiptPath = Join-Path $PrivateDir 'auth-metadata-receipt.json'
  $approvalPath = Join-Path $PrivateDir 'approval.json'
  $journalPath = Join-Path $PrivateDir 'run-journal.jsonl'
  $outPath = Join-Path $PrivateDir 'run-out.json'
  $recoveryPath = "$outPath.recovery.jsonl"

  Write-Step 'Preflight: every evidence/output path must be new'
  Assert-PathIsNew 'functions receipt' $functionsReceiptPath
  Assert-PathIsNew 'mailbox receipt' $mailboxReceiptPath
  Assert-PathIsNew 'auth metadata receipt' $authMetadataReceiptPath
  Assert-PathIsNew 'approval' $approvalPath
  Assert-PathIsNew 'journal' $journalPath
  Assert-PathIsNew 'out' $outPath
  Assert-PathIsNew 'recovery' $recoveryPath
  Write-Host 'All output paths confirmed new.'

  Write-Host "`n--- All local preconditions satisfied. Every step below this line makes a real call to $Project. ---" -ForegroundColor Magenta

  Write-Step 'Read-only: gateGaDeploymentCheck13.mjs (real staging functions metadata)'
  $depCheck = Invoke-Checked 'node' @(
    'scripts/invitationRehearsal/gateGaDeploymentCheck13.mjs',
    '--project', $Project, '--expected-head', $ExpectedCommit,
    '--baseline-receipt', $BaselineReceiptPath, '--out', $functionsReceiptPath
  ) $RepoDir
  if ($depCheck.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $functionsReceiptPath)) {
    Write-SafeStop 'gateGaDeploymentCheck13.mjs did not complete successfully'
  }

  Write-Step 'Read-only: mailboxDiscovery.mjs (strict accountExists === false required to proceed - SAFE_STOP otherwise)'
  Set-Content -LiteralPath $mailboxFile -Value $Recipient -NoNewline
  $mailboxCheck = Invoke-Checked 'node' @(
    'scripts/invitationRehearsal/mailboxDiscovery.mjs',
    '--project', $Project, '--expected-head', $ExpectedCommit,
    '--mailbox-file', $mailboxFile, '--out', $mailboxReceiptPath
  ) $RepoDir
  if ($mailboxCheck.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $mailboxReceiptPath)) {
    Write-SafeStop 'mailboxDiscovery.mjs did not complete successfully'
  }
  $mailboxReceiptText = Get-Content -LiteralPath $mailboxReceiptPath -Raw
  if (-not (Test-MailboxAccountExistsFalse $mailboxReceiptText)) {
    Write-SafeStop "mailbox discovery did not report a strict accountExists: false for $Recipient on $Project (existing account, missing/malformed field, or unparsable receipt) - refusing to proceed per approved scope."
  }
  Write-Host "No existing account found for $Recipient on $Project (accountExists === false, strictly verified) - safe to proceed."

  Write-Step 'Read-only: authVerificationShapeDiscovery.mjs (real staging Auth template metadata)'
  $authCheck = Invoke-Checked 'node' @(
    'scripts/invitationRehearsal/authVerificationShapeDiscovery.mjs',
    '--project', $Project, '--expected-head', $ExpectedCommit, '--out', $authMetadataReceiptPath
  ) $RepoDir
  if ($authCheck.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $authMetadataReceiptPath)) {
    Write-SafeStop 'authVerificationShapeDiscovery.mjs did not complete successfully'
  }

  Write-Step 'Build one fresh approval (1-hour TTL, built immediately before use)'
  $draftArgs = @(
    '--profile', 'staging', '--project', $Project, '--expected-head', $ExpectedCommit,
    '--journal', $journalPath, '--out', $outPath,
    '--recipient', $Recipient, '--recipient-confirmed-sha256', $recipientConfirmedSha256,
    '--resume', 'false', '--legacy-cleanup-approved', $LegacyCleanupApproved
  )
  $buildArgs = @(
    'scripts/invitationRehearsal/gateGaBuildApprovalDraft.mjs',
    '--mailbox-receipt', $mailboxReceiptPath,
    '--functions-receipt', $functionsReceiptPath,
    '--auth-metadata-receipt', $authMetadataReceiptPath,
    '--staging-fingerprint', $stagingFingerprint,
    '--expected-functions-checker-source-head', $ExpectedCommit,
    '--expected-discovery-source-head', $ExpectedCommit,
    '--review-status', 'PASS', '--ci-status', 'PASS',
    '--owner-confirms-approval', 'true',
    '--out', $approvalPath, '--'
  ) + $draftArgs
  $buildDraft = Invoke-Checked 'node' $buildArgs $RepoDir
  if ($buildDraft.ExitCode -ne 0 -or -not (Test-Path -LiteralPath $approvalPath)) {
    Write-SafeStop 'gateGaBuildApprovalDraft.mjs did not complete successfully'
  }
  $draftLine = ($buildDraft.StdOut -split "`n") | Where-Object { $_ -match '^APPROVAL_DRAFT_WRITTEN' } | Select-Object -First 1
  $draftJson = $draftLine -replace '^APPROVAL_DRAFT_WRITTEN\s+', ''
  $draftInfo = $draftJson | ConvertFrom-Json
  $approvalSha256 = $draftInfo.approvalSha256
  if ($approvalSha256 -notmatch '^[a-f0-9]{64}$') { Write-SafeStop 'could not parse approvalSha256 from gateGaBuildApprovalDraft.mjs output' }
  Write-Host "Approval written: $approvalPath (expires $($draftInfo.expiresAt) - execute must run before then)"

  # ------------------------------------------------------------------
  # From here on, Write-SafeStop is never called again: an email may
  # genuinely have been sent by the process below, so its "no email was
  # sent" message could be false. Every outcome from this point is
  # classified by Get-ExecutorOutcomeSummary and reported explicitly
  # instead.
  # ------------------------------------------------------------------
  Write-Step 'EXECUTE (exactly once): gateGaSecureExecutor.mjs --execute --profile staging'
  Write-Host 'From here on, output streams live. After the email is sent this may go quiet for up to 10 minutes while it waits for you to click the verification link - see the header comment for exactly what to expect.' -ForegroundColor Magenta
  $execArgs = @(
    'scripts/invitationRehearsal/gateGaSecureExecutor.mjs', '--execute',
    '--functions-receipt', $functionsReceiptPath, '--expected-checker-source-head', $ExpectedCommit,
    '--profile', 'staging', '--project', $Project, '--expected-head', $ExpectedCommit,
    '--approval', $approvalPath, '--approval-sha256', $approvalSha256,
    '--journal', $journalPath, '--out', $outPath,
    '--recipient', $Recipient, '--recipient-confirmed-sha256', $recipientConfirmedSha256,
    '--resume', 'false', '--legacy-cleanup-approved', $LegacyCleanupApproved
  )
  Write-Host 'Command (no secrets):'
  Write-Host ("  node " + ($execArgs -join ' '))
  $execResult = Invoke-Checked 'node' $execArgs $RepoDir

  Write-Step 'RESULT'
  Write-Host "gateGaSecureExecutor.mjs exit code: $($execResult.ExitCode)"
  Write-Host "Journal: $journalPath"
  Write-Host "Evidence directory: $PrivateDir"
  Write-Host "Checkout: $RepoDir (HEAD $ExpectedCommit)"

  if (-not (Test-Path -LiteralPath $outPath)) {
    Write-Host "`nCRITICAL: no --out file was written. The executor refused before completing a run (see its own reason= message above) or crashed abnormally. Check the journal above for the last recorded step." -ForegroundColor Red
    exit 2
  }

  $recoveryDisplay = if (Test-Path -LiteralPath $recoveryPath) { $recoveryPath } else { '(none written)' }
  $outRead = Read-ExecutorOut $outPath
  if (-not $outRead.Ok) {
    Write-Host "`nCRITICAL: --out exists but is corrupted, incomplete, or not a JSON object. Executor exit code was $($execResult.ExitCode). The run's real state is unknown - a real email may have been sent and resources may exist. Review the journal and recovery file before doing anything else." -ForegroundColor Red
    Write-Host "journal: $journalPath"
    Write-Host "recovery: $recoveryDisplay"
    Write-Host "out (unparsed, not printed): $outPath"
    exit 2
  }

  $outcome = Get-ExecutorOutcomeSummary $outRead.Json $execResult.ExitCode
  Write-OutcomeSummary $outcome

  if (Test-Path -LiteralPath $recoveryPath) { Write-Host "Recovery file present: $recoveryPath" }

  if ($outcome.Critical) {
    Write-Host "`nCRITICAL: emailsSent = '$($outcome.EmailsSent)' (must be a numeric value, at most 1). This is a serious anomaly - review the journal and recovery file before doing anything else." -ForegroundColor Red
    Write-Host "journal: $journalPath"
    Write-Host "recovery: $recoveryDisplay"
    if ($outcome.RecoveryRequired) { Write-Host "RECOVERY_REQUIRED - journal: $journalPath ; recovery: $recoveryDisplay" -ForegroundColor Red }
    exit 3
  }

  if ($outcome.ExitMismatch) {
    Write-Host "`nCRITICAL: executor exit/status mismatch - --out content says PASS but the executor process exited with code $($outcome.ExecutorExitCode) (expected 0). Not treated as a pass. Review the journal and recovery file." -ForegroundColor Red
    Write-Host "journal: $journalPath"
    Write-Host "recovery: $recoveryDisplay"
    exit 3
  }

  if ($outcome.PassOk) {
    Write-Host "`nPASS - status/flowOutcome/cleanup/legacyCleanup/emailsSent all confirmed as expected." -ForegroundColor Green
    exit 0
  }

  if ($outcome.RecoveryRequired) {
    Write-Host "`nRECOVERY_REQUIRED - a run (runId=$($outcome.RunId)) very likely created real resources, but cleanup.status is '$($outcome.CleanupStatus)', not CLEANUP_COMPLETE_VERIFIED. Manual review needed." -ForegroundColor Red
    Write-Host "journal: $journalPath"
    Write-Host "recovery: $(if (Test-Path -LiteralPath $recoveryPath) { $recoveryPath } else { '(none written)' })"
    exit 1
  }

  Write-Host "`nSAFE_STOP (post-execute) - not a PASS, but cleanup is confirmed complete (or nothing was created). See the summary above." -ForegroundColor Yellow
  exit 1
}
finally {
  # Only the COPY made inside this isolated checkout is removed - never
  # the caller's original file, and never any evidence file.
  if ($copiedEnvStagingLocal -and (Test-Path -LiteralPath $copiedEnvStagingLocal)) {
    Remove-Item -LiteralPath $copiedEnvStagingLocal -Force -ErrorAction SilentlyContinue
  }
  Pop-Location
}
