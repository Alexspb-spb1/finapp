<#
FINAPP-1.0-M1 R3 staging release (HEAD 714d0f91) - single executor for steps 0-8.
Windows PowerShell 5.1 compatible. Saved as UTF-8 with BOM. ASCII only.

Release order (owner decision): Functions -> frontend -> immediately Rules -> smoke tests, staging first,
a fresh Firestore export directly before the Rules, STOP on any error, Rules and frontend roll back together.
On staging: the 13 Functions are already live and the Functions source did not change between 8526a79 and 714d0f91,
so the Functions step is a read-only exact-state check; the frontend is the verified local build served by the UI
smoke (staging has no published frontend); the only deploys this executor can ever run are the round-3 Rules and
the Rules rollback from the fresh verified backup of the live pre-release (round-2) Rules.

Run (staging - only after an explicit approval of this package):
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <pkg>\m1-orchestrator.ps1
      -RunProfile staging -WebConfig <abs staging web config> -Node22Dir <abs node22 dir> -ExportUri gs://<bucket>/<path>

Run (local rehearsal against emulators and no-network stubs):
  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File <pkg>\m1-orchestrator.ps1
      -RunProfile rehearsal -WebConfig <abs> -Node22Dir <abs> -ExportUri gs://<bucket>/<path> -EvidenceRoot <new abs dir under
      D:\projects\finapp\.runtime\m1-r4-rehearsal\> -Scenario <abs scenario json> [-SmokeMode emulator|stub]
      [-PriorEvidenceRoot <abs> -PriorRunRoot <abs>]   (rehearsal only)

Steps:
  0 local gates (HEAD, worktree, Node 24 root, CI run, package hashes, staging build, web config, Node 22 functions
    build, Functions/config unchanged since 8526a79, pinned Rules files) + LOCAL provenance of the prior (rev8) evidence
  1 read-only state: exactly the 13 pinned functions, exactly the pinned pre-release (round-2) Rules; a FRESH backup of the
    live Rules is taken, verified byte for byte, and the rollback is prepared (local)
  2 readiness gate: all five M1 callables answer an unauthenticated probe from the APPLICATION layer
  3 smoke preflight (creates the private run dir with a protected ACL) - after readiness, before any Auth user
  4 fresh Firestore export (one gcloud export, verified by operation state and by listing the export metadata object)
  5 frontend ready (verified local build) + Rules deploy (round 3) + independent post-deploy verification;
    any doubt -> STOP; if the live Rules are not provably unchanged -> one conservative rollback
  6 smoke: seed, ui, api, ui-r3 (fail-closed classification of a failed mode)
  7 cleanup (gates G0-G5) and verify-clean / inventory
  8 final read-only checks: the same exact functions and the target (round-3) Rules
Rules of this executor:
- every external action goes through a Node helper with an argument array (no shell, no inline
  code, no output redirection); native output is only displayed via Out-Host;
- every step is journaled; the executor stops at the first failed check and then runs only the
  package's rollback / cleanup branches; it never repeats a smoke mode;
- rollback triggers: c = confirmed R1-R9 Rules failure in smoke, d = indeterminate smoke outcome,
  e = the Rules deploy is not confirmed and the live Rules are not provably the pre-release ones.
  An ordinary application/UI failure never triggers a rollback;
- orchestrator-state.json is written atomically after every state change, so the last saved state
  always agrees with orchestrator-result.json;
- exit code: 0 STAGE_PASS, 2 SAFE_STOP, 3 INIT_REFUSED (nothing executed).
#>
[CmdletBinding()]
param(
  [Parameter(Mandatory = $true)][ValidateSet('staging', 'rehearsal')][string]$RunProfile,
  [Parameter(Mandatory = $true)][string]$WebConfig,
  [Parameter(Mandatory = $true)][string]$Node22Dir,
  [Parameter(Mandatory = $true)][string]$ExportUri,
  [string]$EvidenceRoot,
  [string]$Scenario,
  [ValidateSet('emulator', 'stub')][string]$SmokeMode = 'emulator',
  [string]$PriorEvidenceRoot,
  [string]$PriorRunRoot
)
Set-StrictMode -Version 2.0
$ErrorActionPreference = 'Continue'

# ---------------------------------------------------------------- constants
$TaskId    = 'FINAPP-1.0-M1-R3-STAGING-RELEASE'
$H         = '714d0f91c60a582ee87dc7da82d6249b3106329f'
$PriorHead = '8526a791ce3f62dee5a64aa239b795c609a39226'
$CiRunId   = '36830077757'
$Repo      = 'D:\projects\finapp\m1-release-714d0f91'
$R         = 'D:\projects\finapp\.runtime'
$Pkg       = $PSScriptRoot
$PRE       = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
$TARGET    = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
$M1List    = @('changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers')
$RehearsalBase = 'D:\projects\finapp\.runtime\m1-r4-rehearsal\'
$PriorEvidenceDefault = 'D:\projects\finapp\.runtime\m1-stg-rev8-8526a79'
$PriorRunDefault      = 'D:\projects\finapp\.runtime\m1-staging-run-8526a79-rev8'
$ExportMaxAgeMinutes  = 30
# Firestore Rules reach every serving backend within about a minute of the release. The smoke starts only after this wait on staging
# (a probe that ran against a not-yet-propagated ruleset would be misread as a Rules failure and cost a rollback). Rehearsals do not wait.
$RulesSettleSeconds   = if ($RunProfile -eq 'staging') { 60 } else { 0 }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$OrchestratorRunId = 'r3-' + ([Guid]::NewGuid().ToString('N').Substring(0, 8))

function Write-Console([string]$text) { [Console]::Out.WriteLine($text) }

# ---------------------------------------------------------------- init (refuse before anything runs)
function Refuse-Init([string]$reason) {
  Write-Console "M1_ORCHESTRATOR_STATUS=INIT_REFUSED reason=$reason"
  exit 3
}
$stubVars = @(Get-ChildItem Env: | Where-Object { $_.Name -like 'M1_STUB_*' })
if ($RunProfile -eq 'staging') {
  if ($PSBoundParameters.ContainsKey('EvidenceRoot') -or $PSBoundParameters.ContainsKey('Scenario') -or $PSBoundParameters.ContainsKey('SmokeMode') -or $PSBoundParameters.ContainsKey('PriorEvidenceRoot') -or $PSBoundParameters.ContainsKey('PriorRunRoot')) { Refuse-Init 'staging profile takes no EvidenceRoot/Scenario/SmokeMode/Prior override' }
  if ($stubVars.Count -gt 0) { Refuse-Init 'stub environment variables present' }
  $Ev       = Join-Path $R 'm1-stg-r4-714d0f91'
  $RunDir   = Join-Path $R 'm1-staging-run-714d0f91-v6'
  $PriorEv  = $PriorEvidenceDefault
  $PriorRun = $PriorRunDefault
} else {
  if (-not $EvidenceRoot -or -not $Scenario) { Refuse-Init 'rehearsal requires EvidenceRoot and Scenario' }
  if (-not $EvidenceRoot.StartsWith($RehearsalBase, [StringComparison]::OrdinalIgnoreCase) -or $EvidenceRoot.Contains('..')) { Refuse-Init 'EvidenceRoot outside rehearsal base' }
  if (-not (Test-Path -LiteralPath $Scenario -PathType Leaf)) { Refuse-Init 'scenario file missing' }
  $Ev       = $EvidenceRoot
  $RunDir   = Join-Path $Ev 'run'
  $PriorEv  = if ($PriorEvidenceRoot) { $PriorEvidenceRoot } else { $PriorEvidenceDefault }
  $PriorRun = if ($PriorRunRoot) { $PriorRunRoot } else { $PriorRunDefault }
  foreach ($p in @($PriorEv, $PriorRun)) {
    if (-not [IO.Path]::IsPathRooted($p) -or $p.Contains('..')) { Refuse-Init 'Prior roots must be absolute' }
    if (-not (Test-Path -LiteralPath $p -PathType Container)) { Refuse-Init 'Prior root missing' }
    $inBase = $p.StartsWith($RehearsalBase, [StringComparison]::OrdinalIgnoreCase)
    if (-not $inBase -and $p -ne $PriorEvidenceDefault -and $p -ne $PriorRunDefault) { Refuse-Init 'Prior root must be the real rev8 directory or a copy under the rehearsal base' }
  }
}
# ExportUri is validated case-sensitively (-cnotmatch) and before every other value, so that a bad bucket can never let a run start.
if ($ExportUri -cnotmatch '^gs://[a-z0-9][a-z0-9._-]{2,220}(/[A-Za-z0-9._-]{1,100}){1,6}$' -or $ExportUri.EndsWith('/') -or $ExportUri.Contains('..')) { Refuse-Init 'ExportUri must be gs://<bucket>/<path> with a safe path' }
foreach ($p in @($WebConfig, $Node22Dir)) { if (-not [IO.Path]::IsPathRooted($p)) { Refuse-Init 'WebConfig and Node22Dir must be absolute' } }
if (Test-Path -LiteralPath $Ev) { Refuse-Init 'evidence directory already exists (repeat run refused before any action)' }
if (Test-Path -LiteralPath $RunDir) { Refuse-Init 'smoke run directory already exists (repeat run refused before any action)' }
$nodeCmd = Get-Command node -CommandType Application -ErrorAction SilentlyContinue | Select-Object -First 1
if (-not $nodeCmd) { Refuse-Init 'node not found' }
$NodeExe = $nodeCmd.Source
if (-not (Test-Path -LiteralPath (Join-Path $R 'm1-r4-rehearsal')) -and $RunProfile -eq 'rehearsal') { New-Item -ItemType Directory -Path (Join-Path $R 'm1-r4-rehearsal') | Out-Null }
try { New-Item -ItemType Directory -Path $Ev -ErrorAction Stop | Out-Null } catch { Refuse-Init 'could not create evidence directory' }
if ($RunProfile -eq 'rehearsal') {
  $env:M1_STUB_SCENARIO    = $Scenario
  $env:M1_STUB_STATE       = Join-Path $Ev 'stub-state'
  $env:M1_STUB_NETWORK_LOG = Join-Path $Ev 'stub-state\network-attempts.jsonl'
  New-Item -ItemType Directory -Path $env:M1_STUB_STATE | Out-Null
}

$SmokeLabel = if ($RunProfile -eq 'staging') { 'real-staging' } else { $SmokeMode }
$Journal = Join-Path $Ev 'orchestrator-journal.jsonl'
$State = [ordered]@{
  task = $TaskId; revision = 'r3'; orchestratorRunId = $OrchestratorRunId
  profile = $RunProfile; smokeMode = $SmokeLabel; head = $H; startedAt = (Get-Date).ToUniversalTime().ToString('o')
  completed = @(); priorProvenanceVerified = $false; functionsUnchangedVerified = $false; localRulesVerified = $false
  functionsStateVerified = $false; rulesPreVerified = $false; rollbackPrepared = $false
  readiness = $null
  export = $null
  rulesDeploy = $null; rulesTargetVerified = $false
  rollbackAttempted = $false; rollbackExit = $null; rollbackVerifyExit = $null
  seedAttempted = $false; smokeRulesFailure = $false; smokeIndeterminate = $false; smokeInspect = $null
  cleanup = $null; stop = $null; final = $null
}
function Write-Journal([string]$event, $data) {
  $o = [ordered]@{ at = (Get-Date).ToUniversalTime().ToString('o'); event = $event }
  if ($data) { foreach ($k in $data.Keys) { $o[$k] = $data[$k] } }
  [IO.File]::AppendAllText($Journal, (($o | ConvertTo-Json -Compress -Depth 6) + "`n"), $Utf8NoBom)
}
function Save-State {
  $tmp = Join-Path $Ev 'orchestrator-state.json.tmp'
  [IO.File]::WriteAllText($tmp, ($State | ConvertTo-Json -Depth 6), $Utf8NoBom)
  Move-Item -LiteralPath $tmp -Destination (Join-Path $Ev 'orchestrator-state.json') -Force
}
function Checkpoint([string]$name) { $State.completed += $name; Write-Journal 'CHECKPOINT' @{ name = $name }; Save-State }
function Stop-Stage([string]$step, [string]$reason) {
  $State.stop = [ordered]@{ step = $step; reason = $reason }
  Write-Journal 'STOP' @{ step = $step; reason = $reason }
  Save-State
  throw "M1STOP|$step|$reason"
}
function Invoke-NodeTool([string]$label, [string[]]$NodeArgs) {
  Write-Journal 'RUN' @{ label = $label }
  & $NodeExe @NodeArgs | Out-Host
  $code = $LASTEXITCODE
  Write-Journal 'EXIT' @{ label = $label; exitCode = $code }
  return $code
}
function Read-Json([string]$path) { return (Get-Content -LiteralPath $path -Raw -Encoding UTF8 | ConvertFrom-Json) }
# Exact child exit code recorded by the deploy wrapper; $null when unknown (never coerced to 0).
function Read-DeployExit([string]$outDir) {
  $f = Join-Path $outDir 'exit.json'
  if (-not (Test-Path -LiteralPath $f)) { return $null }
  $ec = (Read-Json $f).exitCode
  if ($ec -eq $null) { return $null }
  return [int]$ec
}

# Tool table: the only place where staging and rehearsal differ.
$StubPre = @('--require', (Join-Path $Pkg 'stubs\no-network.cjs'))
function ToolArgs([string]$tool, [string[]]$toolArgs) {
  if ($RunProfile -eq 'staging') {
    switch ($tool) {
      'stagingResources' { return @((Join-Path $Repo 'scripts\invitationRehearsal\stagingResources.mjs')) + $toolArgs }
      'functionsCheck'   { return @((Join-Path $Pkg 'm1-functions-check.mjs')) + $toolArgs }
      'readiness'        { return @((Join-Path $Pkg 'm1-readiness.mjs')) + $toolArgs }
      'smoke'            { return @((Join-Path $Pkg 'm1-smoke.mjs')) + $toolArgs }
      'ui'               { return @((Join-Path $Pkg 'm1-ui-smoke.mjs')) + $toolArgs }
      'uir3'             { return @((Join-Path $Pkg 'm1-ui-smoke-r3.mjs')) + $toolArgs }
    }
  } else {
    switch ($tool) {
      'stagingResources' { return $StubPre + @((Join-Path $Pkg 'stubs\stub-staging-tools.mjs'), 'stagingResources') + $toolArgs }
      'functionsCheck'   { return $StubPre + @((Join-Path $Pkg 'stubs\stub-staging-tools.mjs'), 'functionsCheck') + $toolArgs }
      'readiness'        { if ($SmokeMode -eq 'stub') { return $StubPre + @((Join-Path $Pkg 'stubs\stub-readiness.mjs')) + $toolArgs } else { return @((Join-Path $Pkg 'm1-readiness.mjs')) + $toolArgs } }
      'smoke'            { if ($SmokeMode -eq 'stub') { return $StubPre + @((Join-Path $Pkg 'stubs\stub-smoke.mjs'), 'smoke') + $toolArgs } else { return @((Join-Path $Pkg 'm1-smoke.mjs')) + $toolArgs } }
      'ui'               { if ($SmokeMode -eq 'stub') { return $StubPre + @((Join-Path $Pkg 'stubs\stub-smoke.mjs'), 'ui') + $toolArgs } else { return @((Join-Path $Pkg 'm1-ui-smoke.mjs')) + $toolArgs } }
      'uir3'             { if ($SmokeMode -eq 'stub') { return $StubPre + @((Join-Path $Pkg 'stubs\stub-smoke.mjs'), 'ui-r3') + $toolArgs } else { return @((Join-Path $Pkg 'm1-ui-smoke-r3.mjs')) + $toolArgs } }
    }
  }
  throw "unknown tool $tool"
}
function SmokeBase { if ($RunProfile -eq 'staging') { return @('--target', 'staging', '--expected-head', $H, '--run-dir', $RunDir, '--web-config', $WebConfig) } else { return @('--target', 'emulator', '--expected-head', $H, '--run-dir', $RunDir) } }
# Readiness limits: fixed inside the tool for staging; short and explicit for local rehearsals.
function ReadinessArgs {
  if ($RunProfile -eq 'staging') { return @('--target', 'staging', '--expected-head', $H, '--out-dir', (EvPath 'readiness')) }
  return @('--target', 'emulator', '--expected-head', $H, '--out-dir', (EvPath 'readiness'), '--deadline-ms', '30000', '--interval-ms', '500', '--request-timeout-ms', '5000')
}
function EvPath([string]$name) { return (Join-Path $Ev $name) }
$ExpectedFile = Join-Path $Pkg 'expected-state-r3.json'
$StateCheck = Join-Path $Pkg 'm1-state-check.mjs'
$DeployWrapper = Join-Path $Pkg 'm1-deploy-wrapper.mjs'

# The readiness result is trusted only when the tool exit code AND the written result agree:
# READY, all five M1 callables, each ready, all in the same round.
function Test-ReadinessResult($rr) {
  try {
    if ($rr -eq $null -or $rr.status -ne 'READY' -or $rr.allReadyInSameRound -ne $true) { return $false }
    $names = @($rr.functions.PSObject.Properties.Name | Sort-Object)
    if (($names -join ',') -ne ((@($M1List) | Sort-Object) -join ',')) { return $false }
    foreach ($n in $names) { $f = $rr.functions.$n; if ($f.ready -ne $true -or [int]$f.attempts -lt 1 -or $f.lastVerdict -ne 'ready') { return $false } }
    return $true
  } catch { return $false }
}

# One read-only verification of the live Rules against a pinned canonical hash plus the independent local check.
# Returns @{ exit; check } - check is $null when the live read itself failed.
function Verify-LiveRules([string]$label, [string]$evidenceName, [string]$canonical) {
  $x = Invoke-NodeTool $label (ToolArgs 'stagingResources' @('--mode', 'verify-current-rules', '--project', 'finapp-staging', '--expected-head', $H, '--expected-rules-hash', $canonical, '--out', (EvPath $evidenceName)))
  $c = $null
  if ($x -eq 0) { $c = Invoke-NodeTool "$label-check" @($StateCheck, '--mode', 'rules', '--expected', $ExpectedFile, '--evidence', (EvPath $evidenceName), '--canonical', $canonical, '--out', (EvPath ('state-check-' + $label + '.json'))) }
  return @{ exit = $x; check = $c }
}

Write-Journal 'START' @{ task = $TaskId; orchestratorRunId = $OrchestratorRunId; profile = $RunProfile; smokeMode = $SmokeLabel; evidence = (Split-Path $Ev -Leaf) }
Save-State
Set-Location -LiteralPath $Repo

# ---------------------------------------------------------------- rollback (RB), used by triggers c, d and e only
function Invoke-RulesRollback([string]$trigger) {
  $State.rollbackAttempted = $true
  Write-Journal 'RULES_ROLLBACK_TRIGGERED' @{ trigger = $trigger }
  Save-State
  $cfg = EvPath 'm1-stg-rules-rollback-r3\firebase.json'
  $wrap = Invoke-NodeTool 'deploy-rules-rollback' @($DeployWrapper, '--profile', $RunProfile, '--kind', 'rules-rollback', '--expected-head', $H, '--out-dir', (EvPath 'deploy-rules-rollback'), '--rollback-config', $cfg)
  $State.rollbackExit = if ($wrap -eq 0) { Read-DeployExit (EvPath 'deploy-rules-rollback') } else { $null }
  $State.rollbackVerifyExit = Invoke-NodeTool 'rules-rollback-verify' (ToolArgs 'stagingResources' @('--mode', 'verify-current-rules', '--project', 'finapp-staging', '--expected-head', $H, '--expected-rules-hash', $PRE, '--out', (EvPath 'm1-stg-rules-rollback-verify-r3.jsonl')))
  $confirmed = ($State.rollbackExit -eq 0) -and ($State.rollbackVerifyExit -eq 0)
  Write-Journal 'RULES_ROLLBACK_RESULT' @{ deployExit = $State.rollbackExit; verifyExit = $State.rollbackVerifyExit; confirmed = $confirmed }
  Save-State
}

# ---------------------------------------------------------------- steps 0-6
try {
  # ===== Step 0 - local gates and local provenance of the prior evidence
  $head = (& git rev-parse HEAD)
  $dirty = (& git status --porcelain --untracked-files=all)
  if ($head -ne $H -or $dirty) { Stop-Stage 'step0' 'HEAD or worktree' }
  $rootVersion = (& $NodeExe --version)
  if (-not ($rootVersion -like 'v24.16.*')) { Stop-Stage 'step0' "root node $rootVersion" }
  if ((Invoke-NodeTool 'ci-check' @((Join-Path $Pkg 'm1-ci-check.mjs'), '--profile', $RunProfile, '--run-id', $CiRunId, '--expected-head', $H, '--out', (EvPath 'ci-check.json'))) -ne 0) { Stop-Stage 'step0' 'CI check' }
  if ((Invoke-NodeTool 'code-sums' @((Join-Path $Pkg 'm1-verify-sums.mjs'), '--sums', (Join-Path $Pkg 'CODE-SHA256SUMS.txt'), '--root', $Pkg)) -ne 0) { Stop-Stage 'step0' 'package code hashes' }
  if ((Invoke-NodeTool 'dist-manifest' @((Join-Path $Pkg 'm1-verify-sums.mjs'), '--manifest', (Join-Path $Pkg 'dist-staging-manifest.txt'), '--dist', (Join-Path $R 'm1-dist-staging-714d0f91'))) -ne 0) { Stop-Stage 'step0' 'staging dist manifest' }
  if ((Invoke-NodeTool 'web-config' @((Join-Path $Pkg 'check-web-config.mjs'), '--web-config', $WebConfig, '--dist', (Join-Path $R 'm1-dist-staging-714d0f91'))) -ne 0) { Stop-Stage 'step0' 'web config' }
  $n22 = Join-Path $Node22Dir 'node.exe'
  if (-not (Test-Path -LiteralPath $n22)) { Stop-Stage 'step0' 'Node 22 not found' }
  $n22Version = (& $n22 --version)
  if (-not ($n22Version -like 'v22.*')) { Stop-Stage 'step0' 'Node22Dir is not Node 22' }
  Write-Journal 'NODE_VERSIONS' @{ cliRoot = $rootVersion; functionsBuild = $n22Version }
  $savedPath = $env:PATH
  try {
    $env:PATH = "$Node22Dir;$savedPath"
    if (-not ((& node --version) -like 'v22.*')) { Stop-Stage 'step0' 'PATH does not resolve Node 22' }
    Write-Journal 'RUN' @{ label = 'functions-build-node22' }
    # npm-cli.js through Node 22 itself: no npm.ps1 (not StrictMode-safe on 5.1) and no npm.cmd.
    $npmCli = Join-Path $Node22Dir 'node_modules\npm\bin\npm-cli.js'
    if (-not (Test-Path -LiteralPath $npmCli)) { Stop-Stage 'step0' 'npm-cli.js not found in Node22Dir' }
    & $n22 $npmCli --prefix functions run build | Out-Host
    $buildExit = $LASTEXITCODE
    Write-Journal 'EXIT' @{ label = 'functions-build-node22'; exitCode = $buildExit }
    if ($buildExit -ne 0) { Stop-Stage 'step0' 'functions build' }
  } finally { $env:PATH = $savedPath }
  if (-not ((& $NodeExe --version) -like 'v24.16.*')) { Stop-Stage 'step0' 'root node not restored' }
  if ((& git status --porcelain --untracked-files=all)) { Stop-Stage 'step0' 'build dirtied worktree' }
  # The Functions source and the Firebase configuration are byte-identical to the reviewed 8526a79 that rev7 deployed
  # and rev8 verified, so this release deploys no Functions and no indexes.
  Write-Journal 'RUN' @{ label = 'functions-unchanged' }
  & git diff --quiet $PriorHead $H -- functions firebase.json firestore.indexes.json .firebaserc
  $unchangedExit = $LASTEXITCODE
  Write-Journal 'EXIT' @{ label = 'functions-unchanged'; exitCode = $unchangedExit }
  if ($unchangedExit -ne 0) { Stop-Stage 'step0' 'Functions or Firebase config changed since 8526a79' }
  $State.functionsUnchangedVerified = $true; Save-State
  # The Rules about to be deployed (repository file, LF) and the round-2 rollback reference are the pinned files.
  if ((Invoke-NodeTool 'local-rules-check' @($StateCheck, '--mode', 'local-rules', '--expected', $ExpectedFile, '--repo', $Repo, '--out', (EvPath 'state-check-local-rules.json'))) -ne 0) { Stop-Stage 'step0' 'pinned Rules files' }
  $State.localRulesVerified = $true; Save-State
  # The prior evidence is only READ: every pinned file, the pinned functions and pre-release Rules, the clean-up outcome.
  if ((Invoke-NodeTool 'prior-provenance' @($StateCheck, '--mode', 'provenance', '--expected', $ExpectedFile, '--evidence-root', $PriorEv, '--run-root', $PriorRun, '--out', (EvPath 'prior-provenance.json'))) -ne 0) { Stop-Stage 'step0' 'prior evidence provenance' }
  $State.priorProvenanceVerified = $true; Save-State
  Checkpoint 'step0'

  # ===== Step 1 - read-only exact state, fresh Rules backup, rollback preparation
  if ((Invoke-NodeTool 'functions-state-pre' (ToolArgs 'functionsCheck' @('--mode', 'exact', '--expected-head', $H, '--expected', $ExpectedFile, '--out', (EvPath 'm1-stg-functions-state-pre-r3.json')))) -ne 0) { Stop-Stage 'step1' 'functions state check' }
  if ((Invoke-NodeTool 'functions-state-pre-check' @($StateCheck, '--mode', 'functions', '--expected', $ExpectedFile, '--evidence', (EvPath 'm1-stg-functions-state-pre-r3.json'), '--out', (EvPath 'state-check-functions-pre.json'))) -ne 0) { Stop-Stage 'step1' 'functions state differs from the pinned state' }
  $State.functionsStateVerified = $true; Save-State
  $preCheck = Verify-LiveRules 'rules-state-pre' 'm1-stg-rules-state-pre-r3.jsonl' $PRE
  if ($preCheck.exit -ne 0) { Stop-Stage 'step1' 'rules state check' }
  if ($preCheck.check -ne 0) { Stop-Stage 'step1' 'rules state differs from the pinned pre-release Rules' }
  $State.rulesPreVerified = $true; Save-State
  $expected = Read-Json $ExpectedFile
  $backupFile = EvPath 'm1-stg-rules-before-r3.json'
  if ((Invoke-NodeTool 'rules-backup' (ToolArgs 'stagingResources' @('--mode', 'backup-rules', '--project', 'finapp-staging', '--expected-head', $H, '--expected-rules-hash', $PRE, '--backup', $backupFile, '--out', (EvPath 'm1-stg-rules-backup-r3.jsonl')))) -ne 0) { Stop-Stage 'step1' 'rules backup' }
  if ((Invoke-NodeTool 'rules-backup-verify' (ToolArgs 'stagingResources' @('--mode', 'verify-rules-backup', '--project', 'finapp-staging', '--expected-head', $H, '--expected-rules-hash', $PRE, '--backup', $backupFile, '--out', (EvPath 'm1-stg-rules-backup-verify-r3.jsonl')))) -ne 0) { Stop-Stage 'step1' 'rules backup verify' }
  $blob = Join-Path $Pkg ($expected.rollback.blobFile -replace '/', '\')
  if ((Invoke-NodeTool 'rollback-prepare' @((Join-Path $Pkg 'm1-rules-rollback-prepare.mjs'), '--backup', $backupFile, '--expected-rules-hash', $PRE, '--expected-raw-sha256', ([string]$expected.rulesPre.rawSha256), '--expected-bytes', ([string]$expected.rulesPre.sourceBytes), '--compare-rules', $blob, '--out-dir', (EvPath 'm1-stg-rules-rollback-r3'))) -ne 0) { Stop-Stage 'step1' 'rollback prepare' }
  $State.rollbackPrepared = $true; Save-State
  Checkpoint 'step1'

  # ===== Step 2 - readiness gate: all five M1 callables answer from the application layer, before any Auth user exists
  $rx = Invoke-NodeTool 'readiness' (ToolArgs 'readiness' (ReadinessArgs))
  $rr = $null
  $rrFile = EvPath 'readiness\readiness-result.json'
  if (Test-Path -LiteralPath $rrFile) { try { $rr = Read-Json $rrFile } catch { $rr = $null } }
  $readyOk = ($rx -eq 0) -and (Test-ReadinessResult $rr)
  $rounds = $null; $rstatus = 'NO_RESULT'
  if ($rr -ne $null) { try { $rounds = $rr.rounds; $rstatus = [string]$rr.status } catch { $rstatus = 'UNREADABLE' } }
  $State.readiness = [ordered]@{ toolExit = $rx; status = $rstatus; rounds = $rounds; verified = $readyOk }
  Write-Journal 'READINESS' @{ toolExit = $rx; status = $rstatus; rounds = $rounds; verified = $readyOk }
  Save-State
  if (-not $readyOk) { Stop-Stage 'step2' "readiness gate not satisfied (tool exit $rx, status $rstatus): no seed, no Auth user" }
  Checkpoint 'step2'

  # ===== Step 3 - smoke preflight and private run dir (after readiness, before seed)
  if ((Invoke-NodeTool 'smoke-preflight' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'preflight')))) -ne 0) { Stop-Stage 'step3' 'smoke preflight' }
  $aclText = (& $NodeExe (Join-Path $Pkg 'show-run-acl.mjs') $RunDir)
  $aclExit = $LASTEXITCODE
  $acl = $null
  try { $acl = (($aclText -join "`n") | ConvertFrom-Json) } catch { $acl = $null }
  if ($aclExit -ne 0 -or -not $acl -or @($acl.dirProblems).Count -ne 0 -or @($acl.fileProblems).Count -ne 0) { Stop-Stage 'step3' 'run dir ACL not verified' }
  Write-Journal 'ACL_VERIFIED' @{ protected = $acl.protected }
  Checkpoint 'step3'

  # ===== Step 4 - fresh Firestore export, directly before the Rules (owner decision). One gcloud export, never retried.
  $State.export = [ordered]@{ attempted = $true; exitCode = $null; status = $null; finishedAt = $null; freshnessAnchor = $null }
  Save-State
  $ex = Invoke-NodeTool 'firestore-export' @((Join-Path $Pkg 'm1-export.mjs'), '--profile', $RunProfile, '--project', 'finapp-staging', '--uri', $ExportUri, '--expected-head', $H, '--out-dir', (EvPath 'm1-stg-firestore-export-r3'))
  $exportResult = $null
  $exportFile = EvPath 'm1-stg-firestore-export-r3\export-result.json'
  if (Test-Path -LiteralPath $exportFile) { try { $exportResult = Read-Json $exportFile } catch { $exportResult = $null } }
  $State.export.exitCode = $ex
  if ($exportResult -ne $null) { $State.export.status = [string]$exportResult.status; $State.export.finishedAt = [string]$exportResult.finishedAt; if ($exportResult.PSObject.Properties['freshnessAnchor']) { $State.export.freshnessAnchor = [string]$exportResult.freshnessAnchor } }
  Save-State
  if ($ex -ne 0 -or $exportResult -eq $null -or $exportResult.status -ne 'EXPORT_VERIFIED') { Stop-Stage 'step4' "fresh Firestore export not verified (exit $ex): no Rules deploy" }
  Checkpoint 'step4'

  # ===== Step 5 - frontend ready + Rules deploy (round 3), independent verification, STOP on any doubt
  # Order Functions -> frontend -> Rules: the Functions were verified in step 1 and the frontend is the staging build
  # whose manifest and web config were verified in step 0 (staging has no published frontend; the UI smoke serves it).
  Write-Journal 'FRONTEND_READY' @{ dist = 'm1-dist-staging-714d0f91'; published = $false }
  # the age of the backup is counted from freshnessAnchor (the earlier of the export request start and the operation's own start time), not from finishedAt
  $exportAge = 9999.0
  try { $exportAge = ((Get-Date).ToUniversalTime() - [DateTime]::Parse($State.export.freshnessAnchor, [Globalization.CultureInfo]::InvariantCulture, [Globalization.DateTimeStyles]::RoundtripKind)).TotalMinutes } catch { Stop-Stage 'step5' 'export freshnessAnchor missing or unreadable: no Rules deploy' }
  if ($exportAge -gt $ExportMaxAgeMinutes -or $exportAge -lt -1) { Stop-Stage 'step5' "export is not fresh ($([int]$exportAge) minutes): no Rules deploy" }
  $State.rulesDeploy = [ordered]@{ attempted = $true; deployExit = $null; verifyExit = $null; checkExit = $null; confirmed = $false; outcome = $null }
  Save-State
  $dw = Invoke-NodeTool 'deploy-rules' @($DeployWrapper, '--profile', $RunProfile, '--kind', 'rules', '--expected-head', $H, '--out-dir', (EvPath 'deploy-rules'))
  $State.rulesDeploy.deployExit = if ($dw -eq 0) { Read-DeployExit (EvPath 'deploy-rules') } else { $null }
  Save-State
  $post = Verify-LiveRules 'rules-state-postdeploy' 'm1-stg-rules-state-postdeploy-r3.jsonl' $TARGET
  $State.rulesDeploy.verifyExit = $post.exit
  $State.rulesDeploy.checkExit = $post.check
  $deployConfirmed = ($State.rulesDeploy.deployExit -eq 0) -and ($post.exit -eq 0) -and ($post.check -eq 0)
  $State.rulesDeploy.confirmed = $deployConfirmed
  Save-State
  if ($deployConfirmed) {
    $State.rulesDeploy.outcome = 'confirmed'
    $State.rulesTargetVerified = $true
    Write-Journal 'RULES_DEPLOY_RESULT' @{ outcome = 'confirmed'; deployExit = $State.rulesDeploy.deployExit }
    Write-Journal 'RULES_SETTLE_WAIT' @{ seconds = $RulesSettleSeconds }
    if ($RulesSettleSeconds -gt 0) { Start-Sleep -Seconds $RulesSettleSeconds }
    Checkpoint 'step5'
  } else {
    # Not confirmed. Is the live state provably still the verified pre-release one? Only then is no rollback owed.
    $again = Verify-LiveRules 'rules-state-reverify' 'm1-stg-rules-state-reverify-r3.jsonl' $PRE
    if ($again.exit -eq 0 -and $again.check -eq 0) {
      $State.rulesDeploy.outcome = 'not-deployed-pre-release-unchanged'
      Write-Journal 'RULES_DEPLOY_RESULT' @{ outcome = 'not-deployed-pre-release-unchanged'; deployExit = $State.rulesDeploy.deployExit; verifyExit = $post.exit }
      Save-State
      Stop-Stage 'step5' 'rules deploy not confirmed; the live Rules are verified unchanged (no rollback needed)'
    }
    $State.rulesDeploy.outcome = 'unconfirmed-rollback'
    Write-Journal 'RULES_DEPLOY_RESULT' @{ outcome = 'unconfirmed-rollback'; deployExit = $State.rulesDeploy.deployExit; verifyExit = $post.exit; reverifyExit = $again.exit }
    Save-State
    Invoke-RulesRollback 'e: Rules deploy not confirmed and the live Rules are not provably the pre-release ones - one conservative rollback from the fresh verified backup'
    Stop-Stage 'step5' 'rules deploy not confirmed; one conservative rollback attempted'
  }

  # ===== Step 6 - smoke
  $State.seedAttempted = $true; Save-State
  foreach ($stage in @('seed', 'ui', 'api', 'ui-r3')) {
    if ($stage -eq 'ui' -or $stage -eq 'ui-r3') {
      $dist = if ($RunProfile -eq 'staging') { Join-Path $R 'm1-dist-staging-714d0f91' } else { Join-Path $R 'm1-dist-emulator-714d0f91' }
      $uiArgs = if ($RunProfile -eq 'staging') { @('--target', 'staging', '--expected-head', $H, '--run-dir', $RunDir, '--web-config', $WebConfig, '--dist', $dist) } else { @('--target', 'emulator', '--expected-head', $H, '--run-dir', $RunDir, '--dist', $dist) }
      $uiTool = if ($stage -eq 'ui') { 'ui' } else { 'uir3' }
      $code = Invoke-NodeTool "smoke-$stage" (ToolArgs $uiTool $uiArgs)
    } else {
      $code = Invoke-NodeTool "smoke-$stage" (ToolArgs 'smoke' ((SmokeBase) + @('--mode', $stage)))
    }
    if ($code -ne 0) {
      # Fail-closed classification of the failed mode. Anything the inspector cannot confirm
      # from a completely readable journal with exactly one trusted terminal event for this
      # mode is treated as indeterminate, which costs one conservative rollback.
      $inspect = EvPath "run-inspect-$stage.json"
      $ix = Invoke-NodeTool "run-inspect-$stage" @((Join-Path $Pkg 'm1-run-inspect.mjs'), '--run-dir', $RunDir, '--mode', $stage, '--out', $inspect)
      $classification = 'indeterminate'
      $problems = $null
      if ($ix -eq 0) {
        $report = $null
        try { $report = Read-Json $inspect } catch { $report = $null }
        if ($report -and $report.classification) { $classification = [string]$report.classification }
        if ($report -and $report.problems) { $problems = @($report.problems) -join '; ' }
      }
      if (-not (@('confirmed-rules-failure', 'confirmed-non-rules-failure') -contains $classification)) { $classification = 'indeterminate' }
      $State.smokeInspect = [ordered]@{ mode = $stage; inspectExit = $ix; classification = $classification; problems = $problems }
      $State.smokeRulesFailure = ($classification -eq 'confirmed-rules-failure')
      $State.smokeIndeterminate = ($classification -eq 'indeterminate')
      Write-Journal 'SMOKE_CLASSIFIED' @{ mode = $stage; exitCode = $code; inspectExit = $ix; classification = $classification }
      Save-State
      if ($classification -eq 'confirmed-rules-failure') { Invoke-RulesRollback 'c: confirmed R1-R9 probe failure during smoke' }
      elseif ($classification -eq 'indeterminate') { Invoke-RulesRollback 'd: indeterminate smoke outcome - one conservative rollback from the fresh verified backup' }
      Stop-Stage 'step6' "smoke $stage exit $code, classification $classification"
    }
  }
  Checkpoint 'step6'
} catch {
  $msg = [string]$_.Exception.Message
  if (-not $msg.StartsWith('M1STOP|')) {
    $State.stop = [ordered]@{ step = 'unexpected'; reason = $msg.Substring(0, [Math]::Min(300, $msg.Length)) }
    Write-Journal 'STOP' @{ step = 'unexpected'; reason = $State.stop.reason }
    Save-State
  }
}

# ---------------------------------------------------------------- step 7 - cleanup branch (only if a run dir exists)
if (Test-Path -LiteralPath $RunDir) {
  # Rules state handed to the cleanup gate. After any rollback (triggers c, d or e) cleanup may only
  # see `rolled-back` together with the exact rollback deploy exit code and the fresh pre-release
  # evidence; an unknown rollback outcome is reported as `unconfirmed`. In both the unconfirmed
  # case and the rolled-back-but-not-confirmed case the gate refuses without deletes and writes a
  # recovery manifest. Without a rollback the target Rules were verified read-only right after the
  # deploy and before the seed, so the gate gets `verified-new` with that evidence (or `untouched`
  # if no seed was attempted: nothing synthetic exists).
  if ($State.rollbackAttempted) {
    if ($State.rollbackExit -ne $null) { $rulesArgs = @('--rules-status', 'rolled-back', '--rules-rollback-deploy-exit', ([string]$State.rollbackExit), '--rules-evidence', (EvPath 'm1-stg-rules-rollback-verify-r3.jsonl')) }
    else { $rulesArgs = @('--rules-status', 'unconfirmed') }
  } elseif (-not $State.seedAttempted) {
    $rulesArgs = @('--rules-status', 'untouched')
  } elseif ($State.rulesTargetVerified -and -not $State.smokeRulesFailure) {
    $rulesArgs = @('--rules-status', 'verified-new', '--rules-evidence', (EvPath 'm1-stg-rules-state-postdeploy-r3.jsonl'))
  } else {
    $rulesArgs = @('--rules-status', 'unconfirmed')
  }
  $cleanup = [ordered]@{ rulesStatus = $rulesArgs[1]; exitCode = $null; branch = $null; verifyCleanExit = $null; inventoryExit = $null }
  $cx = Invoke-NodeTool 'cleanup' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'cleanup') + $rulesArgs))
  $cleanup.exitCode = $cx
  switch ($cx) {
    0 {
      $cleanup.verifyCleanExit = Invoke-NodeTool 'verify-clean' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'verify-clean')))
      if ($cleanup.verifyCleanExit -ne 0) {
        $cleanup.inventoryExit = Invoke-NodeTool 'inventory' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'inventory')))
        $cleanup.branch = 'VERIFY_CLEAN_REMAINDER'
      } else { $cleanup.branch = 'CLEANUP_COMPLETE_VERIFIED' }
    }
    3 { $cleanup.branch = 'CLEANUP_REFUSED' }
    4 {
      $cleanup.inventoryExit = Invoke-NodeTool 'inventory' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'inventory')))
      $cleanup.branch = 'CLEANUP_PARTIAL'
    }
    default {
      $cleanup.inventoryExit = Invoke-NodeTool 'inventory' (ToolArgs 'smoke' ((SmokeBase) + @('--mode', 'inventory')))
      $cleanup.branch = 'CLEANUP_STOPPED_BEFORE_DELETES'
    }
  }
  $State.cleanup = $cleanup
  Write-Journal 'CLEANUP_RESULT' $cleanup
  Save-State
  # A verified cleanup is a checkpoint of its own (also after a step 6 STOP); every other branch is a STOP.
  if ($cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED') { Checkpoint 'step7' }
  if ($cleanup.branch -ne 'CLEANUP_COMPLETE_VERIFIED' -and -not $State.stop) {
    $State.stop = [ordered]@{ step = 'step7'; reason = $cleanup.branch }
    Write-Journal 'STOP' @{ step = 'step7'; reason = $cleanup.branch }
    # The saved state must never lag behind a STOP: state and result stay consistent.
    Save-State
  }
}

# ---------------------------------------------------------------- step 8 - final read-only checks (only on a clean path)
if (-not $State.stop) {
  $finalFunctions = Invoke-NodeTool 'final-functions' (ToolArgs 'functionsCheck' @('--mode', 'exact', '--expected-head', $H, '--expected', $ExpectedFile, '--out', (EvPath 'm1-stg-functions-state-final-r3.json')))
  $finalFunctionsCheck = if ($finalFunctions -eq 0) { Invoke-NodeTool 'final-functions-check' @($StateCheck, '--mode', 'functions', '--expected', $ExpectedFile, '--evidence', (EvPath 'm1-stg-functions-state-final-r3.json'), '--out', (EvPath 'state-check-functions-final.json')) } else { $null }
  $finalRules = Invoke-NodeTool 'final-rules' (ToolArgs 'stagingResources' @('--mode', 'verify-current-rules', '--project', 'finapp-staging', '--expected-head', $H, '--expected-rules-hash', $TARGET, '--out', (EvPath 'm1-stg-rules-state-final-r3.jsonl')))
  $finalRulesCheck = if ($finalRules -eq 0) { Invoke-NodeTool 'final-rules-check' @($StateCheck, '--mode', 'rules', '--expected', $ExpectedFile, '--evidence', (EvPath 'm1-stg-rules-state-final-r3.jsonl'), '--canonical', $TARGET, '--out', (EvPath 'state-check-rules-final.json')) } else { $null }
  $State.final = [ordered]@{ functionsExit = $finalFunctions; functionsCheckExit = $finalFunctionsCheck; rulesExit = $finalRules; rulesCheckExit = $finalRulesCheck }
  Save-State
  if ($finalFunctions -ne 0 -or $finalFunctionsCheck -ne 0 -or $finalRules -ne 0 -or $finalRulesCheck -ne 0) {
    $State.stop = [ordered]@{ step = 'step8'; reason = 'final read-only check' }
    Write-Journal 'STOP' @{ step = 'step8'; reason = 'final read-only check' }
    Save-State
  }
  else { Checkpoint 'step8' }
}

# ---------------------------------------------------------------- result
# Invariant: every field below is written to orchestrator-state.json by the Save-State call that
# follows its assignment (checkpoints, verified flags, readiness, export, rules deploy, rollback, smoke
# classification, cleanup, final, and every STOP, including the ones raised in step 7 and step 8). The result
# is therefore a projection of the last saved state, and the two files agree at every normal termination.
$status = if ($State.stop) { 'SAFE_STOP' } else { 'STAGE_PASS' }
$result = [ordered]@{
  status = $status; task = $TaskId; revision = 'r3'; orchestratorRunId = $OrchestratorRunId; profile = $RunProfile; smokeMode = $SmokeLabel; head = $H
  stop = $State.stop; completed = $State.completed
  state = [ordered]@{ priorProvenanceVerified = $State.priorProvenanceVerified; functionsUnchangedVerified = $State.functionsUnchangedVerified; localRulesVerified = $State.localRulesVerified; functionsStateVerified = $State.functionsStateVerified; rulesPreVerified = $State.rulesPreVerified; rollbackPrepared = $State.rollbackPrepared }
  readiness = $State.readiness
  export = $State.export
  rules = [ordered]@{ deploy = $State.rulesDeploy; targetVerified = $State.rulesTargetVerified; rollbackAttempted = $State.rollbackAttempted; rollbackExit = $State.rollbackExit; rollbackVerifyExit = $State.rollbackVerifyExit; rollbackConfirmed = (($State.rollbackExit -eq 0) -and ($State.rollbackVerifyExit -eq 0)) }
  smoke = [ordered]@{ seedAttempted = $State.seedAttempted; rulesProbeFailure = $State.smokeRulesFailure; indeterminate = $State.smokeIndeterminate; inspect = $State.smokeInspect }
  cleanup = $State.cleanup; final = $State.final
  finishedAt = (Get-Date).ToUniversalTime().ToString('o')
}
[IO.File]::WriteAllText((EvPath 'orchestrator-result.json'), ($result | ConvertTo-Json -Depth 6), $Utf8NoBom)
Write-Journal 'RESULT' @{ status = $status }
$stopText = if ($State.stop) { " step=$($State.stop.step) reason=$($State.stop.reason)" } else { '' }
Write-Console "M1_ORCHESTRATOR_STATUS=$status$stopText"
if ($status -eq 'STAGE_PASS') { exit 0 } else { exit 2 }
