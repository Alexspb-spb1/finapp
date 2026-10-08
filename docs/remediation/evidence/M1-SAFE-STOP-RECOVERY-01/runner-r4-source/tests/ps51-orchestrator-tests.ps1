<#
FINAPP-1.0-M1 R3 - Windows PowerShell 5.1 test suite for the orchestrator and helpers.
Every orchestrator case is a real `powershell.exe -NoProfile -NonInteractive -ExecutionPolicy
Bypass -File m1-orchestrator.ps1` process against local stubs (and emulators for -Set emulator).
ASCII only, saved with BOM.

  powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File tests\ps51-orchestrator-tests.ps1 -Set stub|emulator|helpers
#>
param([Parameter(Mandatory = $true)][ValidateSet('stub', 'emulator', 'helpers')][string]$Set)
Set-StrictMode -Version 2.0
$Pkg = Split-Path $PSScriptRoot -Parent
$Base = 'D:\projects\finapp\.runtime\m1-r4-rehearsal'
$PriorEv = 'D:\projects\finapp\.runtime\m1-stg-rev8-8526a79'
$PriorRun = 'D:\projects\finapp\.runtime\m1-staging-run-8526a79-rev8'
$Repo = 'D:\projects\finapp\m1-release-714d0f91'
$ResultsDir = Join-Path $Pkg 'results'
if (-not (Test-Path -LiteralPath $ResultsDir)) { New-Item -ItemType Directory -Path $ResultsDir | Out-Null }
$Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$script:Cases = New-Object System.Collections.ArrayList
$H = '714d0f91c60a582ee87dc7da82d6249b3106329f'
$PRE = 'f117e489f9549da9083c19bdf4104b3651aa500061aa52426f09cb6fe492adda'
$TARGET = 'c4fe4c097c333f71d971691a2c3be24d15434220bd5f9574fb761494874719fd'
$M1 = @('changeMemberRole', 'disableMember', 'restoreMember', 'removeMember', 'listCompanyMembers')

function Record([string]$name, [bool]$pass, $detail) {
  [void]$script:Cases.Add([ordered]@{ name = $name; pass = $pass; detail = $detail })
  $mark = if ($pass) { 'PASS' } else { 'FAIL' }
  [Console]::Out.WriteLine("$mark $name")
}
function Read-Json([string]$p) { return (Get-Content -LiteralPath $p -Raw -Encoding UTF8 | ConvertFrom-Json) }
function Read-Lines([string]$p) { if (Test-Path -LiteralPath $p) { return @(Get-Content -LiteralPath $p -Encoding UTF8 | Where-Object { $_ } | ForEach-Object { $_ | ConvertFrom-Json }) } else { return @() } }
function Invocations([string]$ev) { return Read-Lines (Join-Path $ev 'stub-state\invocations.jsonl') }
function CountKey($inv, [string]$key) { return @($inv | Where-Object { $_.key -eq $key }).Count }
function CountLike($inv, [string]$like) { return @($inv | Where-Object { $_.key -like $like }).Count }

function Run-Case([string]$name, [string]$scenario, [string]$smoke, [string]$evidence, [string]$priorEv, [string]$priorRun, [string]$nodeOptions) {
  $args2 = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $PSScriptRoot 'run-orchestrator.ps1'), '-Name', $name, '-ScenarioName', $scenario, '-SmokeMode', $smoke, '-PackageDir', $Pkg)
  if ($evidence) { $args2 += @('-EvidenceRoot', $evidence) }
  if ($priorEv) { $args2 += @('-PriorEvidenceRoot', $priorEv, '-PriorRunRoot', $priorRun) }
  if ($nodeOptions) { $args2 += @('-NodeOptions', $nodeOptions) }
  $lines = & powershell.exe @args2
  $ev = (($lines | Where-Object { $_ -like 'EVIDENCE=*' }) -replace '^EVIDENCE=', '')
  $stdout = (($lines | Where-Object { $_ -like 'STDOUT=*' }) -replace '^STDOUT=', '')
  $exit = [int](($lines | Where-Object { $_ -like 'EXIT=*' }) -replace '^EXIT=', '')
  $resultFile = Join-Path $ev 'orchestrator-result.json'
  $result = if (Test-Path -LiteralPath $resultFile) { Read-Json $resultFile } else { $null }
  return [pscustomobject]@{ name = $name; evidence = $ev; stdout = $stdout; exit = $exit; result = $result }
}

function AsJson($value) { if ($value -eq $null) { return 'null' } return ($value | ConvertTo-Json -Depth 8 -Compress) }

# The last saved state must agree with the result at every normal termination: stop, export, Rules deploy,
# cleanup, final, readiness, rollback and the completed checkpoints, including every step7 and step8 STOP.
function StateResult-Checks($c) {
  $stateFile = Join-Path $c.evidence 'orchestrator-state.json'
  $state = if (Test-Path -LiteralPath $stateFile) { Read-Json $stateFile } else { $null }
  $r = $c.result
  $problems = New-Object System.Collections.ArrayList
  if (-not $state) { [void]$problems.Add('orchestrator-state.json missing') }
  if (-not $r) { [void]$problems.Add('orchestrator-result.json missing') }
  if ($state -and $r) {
    if ((AsJson $state.stop) -ne (AsJson $r.stop)) { [void]$problems.Add("stop: state=$(AsJson $state.stop) result=$(AsJson $r.stop)") }
    if ((AsJson $state.cleanup) -ne (AsJson $r.cleanup)) { [void]$problems.Add('cleanup differs') }
    if ((AsJson $state.final) -ne (AsJson $r.final)) { [void]$problems.Add('final differs') }
    if ((AsJson $state.readiness) -ne (AsJson $r.readiness)) { [void]$problems.Add('readiness differs') }
    if ((AsJson $state.export) -ne (AsJson $r.export)) { [void]$problems.Add('export differs') }
    if ((AsJson $state.rulesDeploy) -ne (AsJson $r.rules.deploy)) { [void]$problems.Add('rules deploy differs') }
    if ((AsJson $state.rulesTargetVerified) -ne (AsJson $r.rules.targetVerified)) { [void]$problems.Add('rulesTargetVerified differs') }
    if ((@($state.completed) -join ',') -ne (@($r.completed) -join ',')) { [void]$problems.Add("completed: state=$(@($state.completed) -join ',') result=$(@($r.completed) -join ',')") }
    foreach ($k in @('priorProvenanceVerified', 'functionsUnchangedVerified', 'localRulesVerified', 'functionsStateVerified', 'rulesPreVerified', 'rollbackPrepared')) {
      if ((AsJson $state.$k) -ne (AsJson $r.state.$k)) { [void]$problems.Add("$k differs") }
    }
    if ((AsJson $state.rollbackAttempted) -ne (AsJson $r.rules.rollbackAttempted)) { [void]$problems.Add('rollbackAttempted differs') }
    if ((AsJson $state.rollbackExit) -ne (AsJson $r.rules.rollbackExit)) { [void]$problems.Add('rollbackExit differs') }
    if ((AsJson $state.rollbackVerifyExit) -ne (AsJson $r.rules.rollbackVerifyExit)) { [void]$problems.Add('rollbackVerifyExit differs') }
    if ((AsJson $state.smokeRulesFailure) -ne (AsJson $r.smoke.rulesProbeFailure)) { [void]$problems.Add('smoke rules failure differs') }
    if ((AsJson $state.smokeIndeterminate) -ne (AsJson $r.smoke.indeterminate)) { [void]$problems.Add('smoke indeterminate differs') }
    if ((AsJson $state.smokeInspect) -ne (AsJson $r.smoke.inspect)) { [void]$problems.Add('smoke inspect differs') }
    if ((AsJson $state.orchestratorRunId) -ne (AsJson $r.orchestratorRunId) -or -not ([string]$r.orchestratorRunId).StartsWith('r3-')) { [void]$problems.Add('orchestratorRunId') }
    $expected = if ($state.stop) { 'SAFE_STOP' } else { 'STAGE_PASS' }
    if ($r.status -ne $expected) { [void]$problems.Add("status: result=$($r.status) but the saved state implies $expected") }
    if (($expected -eq 'SAFE_STOP' -and $c.exit -ne 2) -or ($expected -eq 'STAGE_PASS' -and $c.exit -ne 0)) { [void]$problems.Add("exit code $($c.exit) does not match $expected") }
  }
  Record "$($c.name): saved state and result agree (stop, export, Rules deploy, cleanup, final, readiness, rollback, checkpoints)" ($problems.Count -eq 0) $problems
}

# Checks shared by every orchestrator case.
function Common-Checks($c, [bool]$stub) {
  $ev = $c.evidence
  StateResult-Checks $c
  if ($stub) { Record "$($c.name): no network attempts by stubs" (-not (Test-Path -LiteralPath (Join-Path $ev 'stub-state\network-attempts.jsonl'))) $null }
  $inv = Invocations $ev
  $refused = @($inv | Where-Object { $_.refused -eq $true })
  Record "$($c.name): no stub refusals (exact arguments, no repeats)" ($refused.Count -eq 0) ($refused | ForEach-Object { $_.key })
  $deploys = (CountKey $inv 'firebase-deploy-rules')
  $rollbacks = (CountKey $inv 'firebase-rollback')
  Record "$($c.name): the release deploys only Rules - at most one forward Rules deploy and one rollback, no Functions or indexes deploy" ((CountLike $inv 'firebase-*') -eq ($deploys + $rollbacks) -and $deploys -le 1 -and $rollbacks -le 1) $null
  Record "$($c.name): at most one Firestore export and one listing" ((CountKey $inv 'gcloud-export') -le 1 -and (CountKey $inv 'gcloud-list') -le 1) $null
  $statusLines = @(Get-Content -LiteralPath $c.stdout | Where-Object { $_ -like 'M1_ORCHESTRATOR_STATUS=*' })
  Record "$($c.name): exactly one final status line" ($statusLines.Count -eq 1) $statusLines
  foreach ($d in @('deploy-functions', 'deploy-indexes')) { if (Test-Path -LiteralPath (Join-Path $ev $d)) { Record "$($c.name): no $d directory may exist" $false $d } }
  foreach ($d in @('deploy-rules', 'deploy-rules-rollback')) {
    $dir = Join-Path $ev $d
    if (Test-Path -LiteralPath $dir) {
      $ok = Test-Path -LiteralPath (Join-Path $dir 'exit.json')
      $clean = $true
      $sizes = 0
      $combined = 0
      foreach ($f in @('stdout.log', 'stderr.log', 'combined.log')) {
        $bytes = [IO.File]::ReadAllBytes((Join-Path $dir $f))
        if ($bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF) { $clean = $false }
        $text = [Text.Encoding]::UTF8.GetString($bytes)
        if ($text -match 'NativeCommandError|CategoryInfo|FullyQualifiedErrorId|At line:') { $clean = $false }
        if ($f -ne 'combined.log') { $sizes += $bytes.Length } else { $combined = $bytes.Length }
      }
      Record "$($c.name): $d logs raw UTF-8 without BOM/ErrorRecord, combined = stdout+stderr" ($ok -and $clean -and $sizes -eq $combined) $null
    }
  }
}
function Expect($c, [string]$status, [string]$step, [bool]$stub, [scriptblock]$more) {
  $r = $c.result
  $okStatus = $r -and $r.status -eq $status -and (($status -eq 'STAGE_PASS' -and $c.exit -eq 0 -and $r.stop -eq $null) -or ($status -eq 'SAFE_STOP' -and $c.exit -eq 2 -and $r.stop.step -eq $step))
  $detail = if ($r) { "status=$($r.status) exit=$($c.exit) step=$(if ($r.stop) { $r.stop.step } else { '-' }) reason=$(if ($r.stop) { $r.stop.reason } else { '-' })" } else { "no result, exit=$($c.exit)" }
  Record "$($c.name): $status$(if ($step) { " at $step" })" $okStatus $detail
  if ($r -and $more) { & $more $r (Invocations $c.evidence) $c.evidence }
  Common-Checks $c $stub
}

# Order helpers (orchestrator journal): the readiness gate runs before the first Auth-creating smoke mode.
function Journal-Index([string]$ev, [string]$label) {
  $lines = Read-Lines (Join-Path $ev 'orchestrator-journal.jsonl')
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].event -eq 'RUN' -and $lines[$i].label -eq $label) { return $i } }
  return -1
}
function Journal-Event-Index([string]$ev, [string]$event) {
  $lines = Read-Lines (Join-Path $ev 'orchestrator-journal.jsonl')
  for ($i = 0; $i -lt $lines.Count; $i++) { if ($lines[$i].event -eq $event) { return $i } }
  return -1
}
function Attempts([string]$ev) { return Read-Lines (Join-Path $ev 'readiness\readiness-attempts.jsonl') }
function NoSmoke($inv) { return ((CountLike $inv 'smoke-*') -eq 0) }
function NoSeed($inv) { return ((CountKey $inv 'smoke-seed') -eq 0) }
function ReadinessSanitised([string]$ev) {
  $file = Join-Path $ev 'readiness\readiness-attempts.jsonl'
  if (-not (Test-Path -LiteralPath $file)) { return $false }
  $allowed = @('at', 'round', 'fn', 'ready', 'verdict', 'httpStatus')
  foreach ($a in (Attempts $ev)) { foreach ($p in $a.PSObject.Properties.Name) { if ($allowed -notcontains $p) { return $false } } }
  $text = [IO.File]::ReadAllText($file)
  $resultText = [IO.File]::ReadAllText((Join-Path $ev 'readiness\readiness-result.json'))
  return (-not ($text -match 'https?://|authorization|bearer|<html|apikey|key=')) -and (-not ($resultText -match 'https?://|authorization|bearer|<html|apikey|key='))
}
function Node-Versions($ev) {
  $e = @(Read-Lines (Join-Path $ev 'orchestrator-journal.jsonl') | Where-Object { $_.event -eq 'NODE_VERSIONS' })
  return ($e.Count -eq 1 -and ([string]$e[0].cliRoot) -like 'v24.16.*' -and ([string]$e[0].functionsBuild) -like 'v22.*')
}
function SmokeArgs($ev, [string]$mode) { return (Read-Lines (Join-Path $ev 'stub-state\smoke-args.jsonl') | Where-Object { $_.mode -eq $mode }) }

if ($Set -eq 'stub') {
  # ---------------------------------------------------------------- clean pass
  $c = Run-Case 'pass-stub-clean' 'pass-stub-clean' 'stub' $null $null $null $null
  Expect $c 'STAGE_PASS' $null $true {
    param($r, $inv, $ev)
    Record 'pass-stub-clean: all nine checkpoints, readiness READY (verified), export verified, Rules deploy confirmed, no rollback' ((@($r.completed) -join ',') -eq 'step0,step1,step2,step3,step4,step5,step6,step7,step8' -and $r.readiness.status -eq 'READY' -and $r.readiness.verified -eq $true -and $r.export.status -eq 'EXPORT_VERIFIED' -and $r.rules.deploy.outcome -eq 'confirmed' -and $r.rules.targetVerified -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-deploy-rules') -eq 1 -and (CountKey $inv 'firebase-rollback') -eq 0) (@($r.completed) -join ',')
    Record 'pass-stub-clean: exact state read twice (before and after the smoke); pre-release Rules verified before, target Rules verified after the deploy and at the end; fresh backup taken once' ((CountKey $inv 'functionsCheck-pre') -eq 1 -and (CountKey $inv 'functionsCheck-final') -eq 1 -and (CountKey $inv 'stagingResources-verify-current-rules-m1-stg-rules-state-pre-r3.jsonl') -eq 1 -and (CountKey $inv 'stagingResources-verify-current-rules-m1-stg-rules-state-postdeploy-r3.jsonl') -eq 1 -and (CountKey $inv 'stagingResources-verify-current-rules-m1-stg-rules-state-final-r3.jsonl') -eq 1 -and (CountKey $inv 'stagingResources-backup-rules') -eq 1 -and (CountKey $inv 'stagingResources-verify-rules-backup') -eq 1) $null
    Record 'pass-stub-clean: cleanup verified-new with the post-deploy target-Rules evidence -> CLEANUP_COMPLETE_VERIFIED' ($r.cleanup.rulesStatus -eq 'verified-new' -and $r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED') $null
    $sa = SmokeArgs $ev 'cleanup'
    Record 'pass-stub-clean: cleanup received --rules-evidence m1-stg-rules-state-postdeploy-r3.jsonl' ($sa.rulesStatus -eq 'verified-new' -and $sa.rulesEvidence -eq 'm1-stg-rules-state-postdeploy-r3.jsonl') $null
    $iF = Journal-Index $ev 'functions-state-pre'; $iRules = Journal-Index $ev 'rules-state-pre'; $iBackup = Journal-Index $ev 'rules-backup'; $iR = Journal-Index $ev 'readiness'; $iP = Journal-Index $ev 'smoke-preflight'; $iX = Journal-Index $ev 'firestore-export'; $iFe = Journal-Event-Index $ev 'FRONTEND_READY'; $iD = Journal-Index $ev 'deploy-rules'; $iS = Journal-Index $ev 'smoke-seed'
    Record 'pass-stub-clean: order = Functions state -> Rules state -> backup -> readiness -> preflight -> export -> frontend -> Rules deploy -> seed (no Auth user before readiness, no Rules deploy before the export)' ($iF -ge 0 -and $iF -lt $iRules -and $iRules -lt $iBackup -and $iBackup -lt $iR -and $iR -lt $iP -and $iP -lt $iX -and $iX -lt $iFe -and $iFe -lt $iD -and $iD -lt $iS) "functions=$iF rules=$iRules backup=$iBackup readiness=$iR preflight=$iP export=$iX frontend=$iFe deploy=$iD seed=$iS"
    $att = Attempts $ev
    Record 'pass-stub-clean: readiness journal has one round of five ready attempts, sanitised (no URL, header or body)' ($att.Count -eq 5 -and @($att | Where-Object { $_.ready -eq $true -and $_.verdict -eq 'ready' -and $_.httpStatus -eq 401 }).Count -eq 5 -and (ReadinessSanitised $ev)) $att.Count
    Record 'pass-stub-clean: Node 24 CLI root and Node 22 functions build recorded' (Node-Versions $ev) $null
    Record 'pass-stub-clean: Functions/config unchanged since 8526a79, pinned Rules files, prior provenance, pinned functions and Rules were all checked by independent local checks' ($r.state.functionsUnchangedVerified -and $r.state.localRulesVerified -and $r.state.priorProvenanceVerified -and (Test-Path (Join-Path $ev 'state-check-local-rules.json')) -and (Test-Path (Join-Path $ev 'prior-provenance.json')) -and (Test-Path (Join-Path $ev 'state-check-functions-pre.json')) -and (Test-Path (Join-Path $ev 'state-check-rules-state-pre.json')) -and (Test-Path (Join-Path $ev 'state-check-rules-state-postdeploy.json')) -and (Test-Path (Join-Path $ev 'state-check-functions-final.json')) -and (Test-Path (Join-Path $ev 'state-check-rules-final.json'))) $null
    Record 'pass-stub-clean: the rollback directory was prepared from the fresh backup but never used' ((Test-Path (Join-Path $ev 'm1-stg-rules-rollback-r3\firebase.json')) -and -not (Test-Path (Join-Path $ev 'deploy-rules-rollback'))) $null
    $ex = Read-Json (Join-Path $ev 'm1-stg-firestore-export-r3\export-result.json')
    Record 'pass-stub-clean: the export result records the unique prefix, SUCCESSFUL state and a plan written before the request' ($ex.status -eq 'EXPORT_VERIFIED' -and $ex.prefix -like 'gs://m1-rehearsal-bucket/exports/m1-r3-714d0f91-*' -and $ex.operationState -eq 'SUCCESSFUL' -and (Test-Path (Join-Path $ev 'm1-stg-firestore-export-r3\plan.json'))) $ex.prefix
    $dr = Read-Json (Join-Path $ev 'deploy-rules\exit.json')
    Record 'pass-stub-clean: the forward deploy recorded the exact argv (finapp-staging, firestore:rules only, no --config) and exit 0' ($dr.exitCode -eq 0 -and ($dr.argv -join ' ') -like '*deploy --project finapp-staging --only firestore:rules --non-interactive' -and ($dr.argv -join ' ') -notlike '*--config*') ($dr.argv -join ' ')
    $settle = @(Read-Lines (Join-Path $ev 'orchestrator-journal.jsonl') | Where-Object { $_.event -eq 'RULES_SETTLE_WAIT' })
    Record 'pass-stub-clean: the Rules settle wait is journaled once between the confirmed deploy and the seed (0 s in a rehearsal)' ($settle.Count -eq 1 -and [int]$settle[0].seconds -eq 0 -and (Journal-Event-Index $ev 'RULES_SETTLE_WAIT') -gt (Journal-Index $ev 'rules-state-postdeploy') -and (Journal-Event-Index $ev 'RULES_SETTLE_WAIT') -lt (Journal-Index $ev 'smoke-seed')) $null
    Record 'pass-stub-clean: smoke modes ran in order seed, ui, api, ui-r3 (cleanup afterwards)' ((CountKey $inv 'smoke-seed') -eq 1 -and (CountKey $inv 'smoke-ui') -eq 1 -and (CountKey $inv 'smoke-api') -eq 1 -and (CountKey $inv 'smoke-ui-r3') -eq 1 -and (Journal-Index $ev 'smoke-seed') -lt (Journal-Index $ev 'smoke-ui') -and (Journal-Index $ev 'smoke-ui') -lt (Journal-Index $ev 'smoke-api') -and (Journal-Index $ev 'smoke-api') -lt (Journal-Index $ev 'smoke-ui-r3') -and (Journal-Index $ev 'smoke-ui-r3') -lt (Journal-Index $ev 'cleanup')) $null
  }
  $repeat = Run-Case 'repeat-run' 'pass-stub-clean' 'stub' $c.evidence $null $null $null
  $before = @(Invocations $c.evidence).Count
  Record 'repeat-run: same evidence root -> INIT_REFUSED exit 3 before any action' ($repeat.exit -eq 3 -and (Get-Content -LiteralPath $repeat.stdout -Raw) -match 'INIT_REFUSED') "exit=$($repeat.exit)"
  Record 'repeat-run: stub invocation log unchanged' ($before -eq @(Invocations $c.evidence).Count) $null

  # ---------------------------------------------------------------- step 0
  foreach ($ci in @('wrong-head', 'missing-job', 'failed-job', 'incomplete-job', 'extra-job', 'malformed', 'exit-error')) {
    $c = Run-Case "ci-$ci" "ci-$ci" 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step0' $true {
      param($r, $inv, $ev)
      Record "ci-$($ci): stopped on CI; no exact-state read, no readiness, no export, no deploy, no smoke, no run dir" ($r.stop.reason -eq 'CI check' -and (CountKey $inv 'gh') -eq 1 -and (CountLike $inv 'functionsCheck-*') -eq 0 -and (CountKey $inv 'readiness') -eq 0 -and (CountLike $inv 'gcloud-*') -eq 0 -and (CountLike $inv 'firebase-*') -eq 0 -and (NoSmoke $inv) -and -not (Test-Path (Join-Path $ev 'run')) -and -not ((Get-Content (Join-Path $ev 'orchestrator-journal.jsonl') -Raw) -match 'functions-build-node22')) $r.stop.reason
    }
  }
  foreach ($case in @(@('prior-tampered-functions', 'functions'), @('prior-tampered-rules', 'rules'))) {
    $name = $case[0]; $tamper = $case[1]
    $exp = Read-Json (Join-Path $Pkg 'expected-state-r3.json')
    $root = Join-Path $Base ("priorcopy-$name-" + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
    $evc = Join-Path $root 'evidence'; $runc = Join-Path $root 'run'
    New-Item -ItemType Directory -Path $evc -Force | Out-Null; New-Item -ItemType Directory -Path $runc -Force | Out-Null
    foreach ($pin in $exp.priorEvidence) {
      $srcRoot = if ($pin.root -eq 'evidence') { $PriorEv } else { $PriorRun }
      $dstRoot = if ($pin.root -eq 'evidence') { $evc } else { $runc }
      $rel = ($pin.path -replace '/', '\')
      New-Item -ItemType Directory -Path (Split-Path (Join-Path $dstRoot $rel) -Parent) -Force | Out-Null
      Copy-Item -LiteralPath (Join-Path $srcRoot $rel) -Destination (Join-Path $dstRoot $rel)
    }
    if ($tamper -eq 'functions') { $f = Join-Path $evc 'm1-stg-functions-state-final-rev8.json'; [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f, $Utf8NoBom).Replace($exp.functions[0].revision, ($exp.functions[0].revision + 'x'))), $Utf8NoBom) }
    else { $f = Join-Path $evc 'm1-stg-rules-state-final-rev8.jsonl'; [IO.File]::WriteAllText($f, ([IO.File]::ReadAllText($f, $Utf8NoBom).Replace('cbfcc160', 'cbfcc161')), $Utf8NoBom) }
    $c = Run-Case $name $name 'stub' $null $evc $runc $null
    Expect $c 'SAFE_STOP' 'step0' $true {
      param($r, $inv, $ev)
      Record "$($name): tampered COPY of the rev8 evidence -> STOP at provenance; no cloud read, no readiness, no export, no deploy, no smoke" ($r.stop.reason -eq 'prior evidence provenance' -and -not $r.state.priorProvenanceVerified -and (CountLike $inv 'functionsCheck-*') -eq 0 -and (CountKey $inv 'readiness') -eq 0 -and (CountLike $inv 'gcloud-*') -eq 0 -and (CountLike $inv 'firebase-*') -eq 0 -and (NoSmoke $inv) -and -not (Test-Path (Join-Path $ev 'run'))) $r.stop.reason
    }
  }

  # ---------------------------------------------------------------- step 1 - exact state, fresh backup
  foreach ($case in @(@('state-functions-check-fails', 'functions state check'), @('state-functions-missing', 'functions state differs from the pinned state'), @('state-functions-extra', 'functions state differs from the pinned state'), @('state-baseline-fn-changed', 'functions state differs from the pinned state'), @('state-m1-fn-changed', 'functions state differs from the pinned state'), @('state-caps-changed', 'functions state differs from the pinned state'), @('state-rules-target', 'rules state check'), @('state-rules-other', 'rules state check'), @('state-rules-ruleset-drift', 'rules state differs from the pinned pre-release Rules'), @('state-rules-raw-drift', 'rules state differs from the pinned pre-release Rules'), @('state-rules-bytes-drift', 'rules state differs from the pinned pre-release Rules'), @('backup-rules-fails', 'rules backup'), @('backup-verify-fails', 'rules backup verify'))) {
    $name = $case[0]; $reason = $case[1]
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step1' $true {
      param($r, $inv, $ev)
      Record "$($name): STOP before readiness, export and deploy ($reason); no run dir, no cleanup, no rollback" ($r.stop.reason -eq $reason -and (CountKey $inv 'readiness') -eq 0 -and (NoSmoke $inv) -and (CountLike $inv 'gcloud-*') -eq 0 -and (CountLike $inv 'firebase-*') -eq 0 -and -not (Test-Path (Join-Path $ev 'run')) -and $r.cleanup -eq $null -and -not $r.smoke.seedAttempted -and -not $r.rules.rollbackAttempted -and $r.rules.deploy -eq $null) $r.stop.reason
    }
  }

  # ---------------------------------------------------------------- step 2 - readiness gate
  $verdictOf = @{ 'platform-401' = 'platform-denied'; 'platform-403' = 'platform-denied'; 'html' = 'platform-denied'; 'http-204' = 'http-2xx'; 'http-200' = 'http-2xx'; 'http-500' = 'http-5xx'; 'malformed-json' = 'malformed-json'; 'wrong-app-code' = 'wrong-app-code'; 'wrong-status' = 'wrong-status'; 'timeout' = 'timeout'; 'network' = 'network-error' }
  foreach ($kind in @('platform-401', 'platform-403', 'html', 'http-204', 'http-200', 'http-500', 'malformed-json', 'wrong-app-code', 'wrong-status', 'timeout', 'network')) {
    $c = Run-Case "readiness-$kind" "readiness-$kind" 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step2' $true {
      param($r, $inv, $ev)
      $att = Attempts $ev
      $last = @($att | Where-Object { $_.fn -eq 'listCompanyMembers' }) | Select-Object -Last 1
      Record "readiness-$($kind): NOT_READY at the deadline; no preflight, no export, no deploy, no seed, no Auth user, no run dir, no cleanup" ($r.readiness.status -eq 'NOT_READY' -and -not $r.readiness.verified -and $r.readiness.toolExit -eq 2 -and $r.stop.reason -like 'readiness gate not satisfied*' -and (NoSmoke $inv) -and (CountLike $inv 'gcloud-*') -eq 0 -and (CountLike $inv 'firebase-*') -eq 0 -and -not (Test-Path (Join-Path $ev 'run')) -and $r.cleanup -eq $null -and -not $r.smoke.seedAttempted -and $r.final -eq $null -and $r.export -eq $null) "status=$($r.readiness.status) verified=$($r.readiness.verified)"
      Record "readiness-$($kind): every attempt classified '$($verdictOf[$kind])' and none accepted; evidence sanitised" ($att.Count -ge 5 -and @($att | Where-Object { $_.ready }).Count -eq 0 -and $last.verdict -eq $verdictOf[$kind] -and (ReadinessSanitised $ev)) "attempts=$($att.Count) last=$($last.verdict)"
    }
  }
  foreach ($fn in $M1) {
    $c = Run-Case "readiness-not-ready-$fn" "readiness-not-ready-$fn" 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step2' $true {
      param($r, $inv, $ev)
      $att = Attempts $ev
      $others = @($att | Where-Object { $_.fn -ne $fn })
      $mine = @($att | Where-Object { $_.fn -eq $fn })
      Record "readiness-not-ready-$($fn): four callables ready but $fn is not -> readiness NOT_READY, no seed, no deploy (partial readiness is refused)" ($r.readiness.status -eq 'NOT_READY' -and $others.Count -gt 0 -and @($others | Where-Object { -not $_.ready }).Count -eq 0 -and $mine.Count -gt 0 -and @($mine | Where-Object { $_.ready }).Count -eq 0 -and (NoSmoke $inv) -and (CountLike $inv 'firebase-*') -eq 0 -and -not (Test-Path (Join-Path $ev 'run'))) "others=$($others.Count) mine=$($mine.Count)"
    }
  }
  $c = Run-Case 'readiness-late-ready' 'readiness-late-ready' 'stub' $null $null $null $null
  Expect $c 'STAGE_PASS' $null $true {
    param($r, $inv, $ev)
    $att = Attempts $ev
    Record 'readiness-late-ready: platform 401 for three rounds, then application layer -> READY in round 4, then the run continues to STAGE_PASS' ($r.readiness.status -eq 'READY' -and $r.readiness.rounds -eq 4 -and @($att | Where-Object { $_.round -le 3 -and -not $_.ready }).Count -eq 15 -and @($att | Where-Object { $_.round -eq 4 -and $_.ready }).Count -eq 5 -and (CountKey $inv 'smoke-seed') -eq 1) "rounds=$($r.readiness.rounds)"
  }

  # ---------------------------------------------------------------- step 3 - smoke preflight
  $c = Run-Case 'smoke-preflight-fail' 'smoke-preflight-fail' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step3' $true {
    param($r, $inv, $ev)
    Record 'smoke-preflight-fail: STOP after readiness, before the export, the deploy and any seed; cleanup untouched; no rollback' ($r.readiness.verified -and (CountKey $inv 'smoke-seed') -eq 0 -and (CountLike $inv 'gcloud-*') -eq 0 -and (CountLike $inv 'firebase-*') -eq 0 -and $r.cleanup.rulesStatus -eq 'untouched' -and -not $r.rules.rollbackAttempted) $null
  }

  # ---------------------------------------------------------------- step 4 - fresh Firestore export
  foreach ($kind in @('exit-1', 'op-failed', 'bad-json', 'not-done', 'wrong-prefix', 'no-metadata', 'list-fail', 'poll-failed', 'poll-forever', 'poll-describe-exit1', 'poll-bad-json', 'poll-wrong-name', 'poll-wrong-prefix', 'poll-unknown-state', 'poll-success-no-metadata', 'poll-old-operation', 'poll-slow-export', 'poll-slow-describe')) {
    $name = "export-$kind"
    # the poll scenarios shorten the polling through M1_STUB_* variables (only the rehearsal profile honours them), for this one case
    if ($kind -like 'poll-*') {
      $env:M1_STUB_EXPORT_POLL_MS = '30'
      $env:M1_STUB_EXPORT_DEADLINE_MS = if ($kind -eq 'poll-forever') { '2500' } elseif ($kind -like 'poll-slow-*') { '1500' } else { '20000' }
      if ($kind -like 'poll-slow-*') { $env:M1_STUB_EXPORT_DELAY_MS = '6000' }
    }
    try { $c = Run-Case $name $name 'stub' $null $null $null $null } finally { Remove-Item Env:M1_STUB_EXPORT_POLL_MS, Env:M1_STUB_EXPORT_DEADLINE_MS, Env:M1_STUB_EXPORT_DELAY_MS -ErrorAction SilentlyContinue }
    Expect $c 'SAFE_STOP' 'step4' $true {
      param($r, $inv, $ev)
      Record "$($name): the export is not provable -> STOP before ANY Rules deploy; no seed, no rollback (nothing was changed); cleanup untouched; one export attempt only" ($r.stop.reason -like 'fresh Firestore export not verified*' -and $r.export.status -ne 'EXPORT_VERIFIED' -and (CountKey $inv 'gcloud-export') -eq 1 -and (CountLike $inv 'firebase-*') -eq 0 -and (NoSeed $inv) -and -not $r.rules.rollbackAttempted -and $r.rules.deploy -eq $null -and $r.cleanup.rulesStatus -eq 'untouched' -and -not (Test-Path (Join-Path $ev 'deploy-rules'))) "exit=$($r.export.exitCode) status=$($r.export.status)"
    }
  }

  # v5: the first export answer is PROCESSING (as on the real staging run); the orchestrator must still get EXPORT_VERIFIED from the polled operation
  $env:M1_STUB_EXPORT_POLL_MS = '30'; $env:M1_STUB_EXPORT_DEADLINE_MS = '20000'
  try { $c = Run-Case 'pass-export-poll' 'pass-export-poll' 'stub' $null $null $null $null } finally { Remove-Item Env:M1_STUB_EXPORT_POLL_MS, Env:M1_STUB_EXPORT_DEADLINE_MS -ErrorAction SilentlyContinue }
  Expect $c 'STAGE_PASS' $null $true {
    param($r, $inv, $ev)
    $ex = Read-Json (Join-Path $ev 'm1-stg-firestore-export-r3\export-result.json')
    Record 'pass-export-poll: the export command printed PROCESSING, the polled operation became SUCCESSFUL -> EXPORT_VERIFIED, Rules deployed once, STAGE_PASS; ONE export, 2 describes, one listing' ((@($r.completed) -join ',') -eq 'step0,step1,step2,step3,step4,step5,step6,step7,step8' -and $r.export.status -eq 'EXPORT_VERIFIED' -and $ex.status -eq 'EXPORT_VERIFIED' -and $ex.polls -eq 2 -and [bool]$ex.freshnessAnchor -and [bool]$ex.operationStartTime -and (CountKey $inv 'gcloud-export') -eq 1 -and (CountKey $inv 'gcloud-describe') -eq 2 -and (CountKey $inv 'gcloud-list') -eq 1 -and (CountKey $inv 'firebase-deploy-rules') -eq 1 -and -not $r.rules.rollbackAttempted) (@($r.completed) -join ',')
  }

  # ---------------------------------------------------------------- step 5 - Rules deploy
  foreach ($case in @(@('deploy-fail', 'deploy exit 1, the live Rules never changed'), @('deploy-noop', 'deploy exit 0 but nothing was published'))) {
    $name = $case[0]; $what = $case[1]
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step5' $true {
      param($r, $inv, $ev)
      Record "$($name): $what -> STOP; the live Rules are re-verified as the unchanged pre-release ruleset, so NO rollback is owed (and none is run); no seed; cleanup untouched" ($r.stop.reason -eq 'rules deploy not confirmed; the live Rules are verified unchanged (no rollback needed)' -and $r.rules.deploy.outcome -eq 'not-deployed-pre-release-unchanged' -and -not $r.rules.deploy.confirmed -and -not $r.rules.targetVerified -and (CountKey $inv 'firebase-deploy-rules') -eq 1 -and (CountKey $inv 'firebase-rollback') -eq 0 -and (CountKey $inv 'stagingResources-verify-current-rules-m1-stg-rules-state-reverify-r3.jsonl') -eq 1 -and -not $r.rules.rollbackAttempted -and (NoSeed $inv) -and $r.cleanup.rulesStatus -eq 'untouched' -and $r.final -eq $null) "outcome=$($r.rules.deploy.outcome) deployExit=$($r.rules.deploy.deployExit)"
    }
  }
  foreach ($name in @('deploy-fail-applied', 'deploy-target-raw-drift', 'deploy-target-bytes-drift', 'deploy-target-same-ruleset', 'deploy-postverify-fails')) {
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step5' $true {
      param($r, $inv, $ev)
      $sa = SmokeArgs $ev 'cleanup'
      Record "$($name): the deploy is not confirmed and the live Rules are NOT the pre-release ones -> exactly one conservative rollback (trigger e), confirmed; no seed; cleanup rolled-back with exit 0 and fresh pre-release evidence" ($r.stop.reason -eq 'rules deploy not confirmed; one conservative rollback attempted' -and $r.rules.deploy.outcome -eq 'unconfirmed-rollback' -and (CountKey $inv 'firebase-deploy-rules') -eq 1 -and (CountKey $inv 'firebase-rollback') -eq 1 -and $r.rules.rollbackConfirmed -and (NoSeed $inv) -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '0' -and $sa.rulesEvidence -eq 'm1-stg-rules-rollback-verify-r3.jsonl' -and $r.final -eq $null) "outcome=$($r.rules.deploy.outcome) deployExit=$($r.rules.deploy.deployExit) verifyExit=$($r.rules.deploy.verifyExit) checkExit=$($r.rules.deploy.checkExit)"
    }
  }
  $c = Run-Case 'deploy-fail-applied-rollback-fails' 'deploy-fail-applied-rollback-fails' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step5' $true {
    param($r, $inv, $ev)
    $sa = SmokeArgs $ev 'cleanup'
    $recovery = @(Get-ChildItem -LiteralPath (Join-Path $ev 'run') -Filter 'recovery-manifest-*.json' -ErrorAction SilentlyContinue)
    Record 'deploy-fail-applied-rollback-fails: the single rollback fails -> not confirmed; cleanup exit 3 with a recovery manifest and no deletes; no repeat of the rollback' ((CountKey $inv 'firebase-rollback') -eq 1 -and -not $r.rules.rollbackConfirmed -and $r.rules.rollbackExit -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '1' -and $r.cleanup.exitCode -eq 3 -and $r.cleanup.branch -eq 'CLEANUP_REFUSED' -and $recovery.Count -eq 1 -and (CountKey $inv 'smoke-inventory') -eq 0 -and (NoSeed $inv)) "cleanupExit=$($r.cleanup.exitCode)"
  }

  # ---------------------------------------------------------------- step 6 - smoke branches, rollback rules
  $c = Run-Case 'smoke-seed-fail' 'smoke-seed-fail' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $insp = Read-Json (Join-Path $ev 'run-inspect-seed.json')
    Record 'smoke-seed-fail: confirmed non-Rules failure -> no rollback; cleanup verified-new' ($insp.classification -eq 'confirmed-non-rules-failure' -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-rollback') -eq 0 -and $r.cleanup.rulesStatus -eq 'verified-new' -and (CountKey $inv 'smoke-ui') -eq 0) $insp.classification
  }
  foreach ($case in @(@('smoke-ui-assertion', 'assertion'), @('smoke-ui-flow', 'ui-flow'))) {
    $name = $case[0]; $kind = $case[1]
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step6' $true {
      param($r, $inv, $ev)
      $insp = Read-Json (Join-Path $ev 'run-inspect-ui.json')
      $sa = SmokeArgs $ev 'cleanup'
      Record "$($name): ordinary application/UI failure ($kind) -> confirmed non-Rules failure, rollback count 0, no API run, cleanup verified-new, no final checks" ($insp.classification -eq 'confirmed-non-rules-failure' -and $insp.trustedTerminal.kind -eq $kind -and -not $r.smoke.rulesProbeFailure -and -not $r.smoke.indeterminate -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-rollback') -eq 0 -and (CountKey $inv 'smoke-api') -eq 0 -and $sa.rulesStatus -eq 'verified-new' -and (CountLike $inv 'functionsCheck-final') -eq 0 -and $r.final -eq $null) $insp.classification
    }
  }
  $c = Run-Case 'smoke-api-assertion' 'smoke-api-assertion' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
    Record 'smoke-api-assertion: confirmed non-Rules failure -> no rollback at all; cleanup verified-new; ui-r3 never starts' ($insp.classification -eq 'confirmed-non-rules-failure' -and -not $r.smoke.indeterminate -and -not $r.smoke.rulesProbeFailure -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-rollback') -eq 0 -and $r.cleanup.rulesStatus -eq 'verified-new' -and (CountKey $inv 'smoke-api') -eq 1 -and (CountKey $inv 'smoke-ui-r3') -eq 0) $insp.classification
  }
  foreach ($case in @(@('smoke-r3-rollback', '^R3\.'), @('smoke-r6-rollback', '^R6\.'))) {
    $name = $case[0]; $probe = $case[1]
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step6' $true {
      param($r, $inv, $ev)
      $sa = SmokeArgs $ev 'cleanup'
      $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
      Record "$($name): confirmed Rules probe failure ($probe) -> rollback (trigger c) exactly once and confirmed; cleanup rolled-back with exit 0 and the fresh pre-release evidence" ($r.smoke.rulesProbeFailure -and -not $r.smoke.indeterminate -and $r.smoke.inspect.classification -eq 'confirmed-rules-failure' -and $insp.classification -eq 'confirmed-rules-failure' -and $insp.trustedTerminal.reason -match $probe -and $r.rules.rollbackConfirmed -and (CountKey $inv 'firebase-rollback') -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '0' -and $sa.rulesEvidence -eq 'm1-stg-rules-rollback-verify-r3.jsonl') $insp.classification
    }
  }
  $c = Run-Case 'smoke-r3-rollback-fails' 'smoke-r3-rollback-fails' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $sa = SmokeArgs $ev 'cleanup'
    $recovery = @(Get-ChildItem -LiteralPath (Join-Path $ev 'run') -Filter 'recovery-manifest-*.json' -ErrorAction SilentlyContinue)
    Record 'smoke-r3-rollback-fails: confirmed Rules failure, the single rollback fails -> cleanup exit 3, recovery manifest, no deletes, no repeat' ($r.smoke.rulesProbeFailure -and (CountKey $inv 'firebase-rollback') -eq 1 -and -not $r.rules.rollbackConfirmed -and $r.rules.rollbackExit -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '1' -and $r.cleanup.exitCode -eq 3 -and $r.cleanup.branch -eq 'CLEANUP_REFUSED' -and $recovery.Count -eq 1 -and (CountKey $inv 'smoke-cleanup') -eq 1 -and (CountKey $inv 'smoke-inventory') -eq 0) "cleanupExit=$($r.cleanup.exitCode)"
  }
  # Indeterminate API outcomes: the orchestrator may not conclude anything from the journal and
  # owes exactly one conservative Rules rollback from the fresh verified backup.
  $c = Run-Case 'smoke-api-nostop' 'smoke-api-nostop' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $sa = SmokeArgs $ev 'cleanup'
    $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
    $problems = (@($insp.problems) -join '; ')
    Record 'smoke-api-nostop: MODE_START without a terminal event -> indeterminate, exactly one rollback, pre-release Rules confirmed, cleanup rolled-back' ($insp.classification -eq 'indeterminate' -and $insp.rulesFailure -eq $false -and $problems -like '*api has no terminal event*' -and $r.smoke.indeterminate -and $r.smoke.inspect.inspectExit -eq 2 -and -not $r.smoke.rulesProbeFailure -and $r.rules.rollbackAttempted -and $r.rules.rollbackConfirmed -and (CountKey $inv 'firebase-rollback') -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '0' -and $sa.rulesEvidence -eq 'm1-stg-rules-rollback-verify-r3.jsonl') $problems
  }
  $c = Run-Case 'smoke-api-corrupt' 'smoke-api-corrupt' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $sa = SmokeArgs $ev 'cleanup'
    $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
    $problems = (@($insp.problems) -join '; ')
    Record 'smoke-api-corrupt: damaged journal line after the API failure -> fail-closed indeterminate, exactly one rollback, cleanup rolled-back' ($insp.classification -eq 'indeterminate' -and $insp.journalReadable -eq $false -and $problems -like '*is not valid JSON*' -and $r.smoke.indeterminate -and -not $r.smoke.rulesProbeFailure -and $r.rules.rollbackConfirmed -and (CountKey $inv 'firebase-rollback') -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '0') $problems
  }
  $c = Run-Case 'smoke-api-corrupt-rollback-fails' 'smoke-api-corrupt-rollback-fails' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $sa = SmokeArgs $ev 'cleanup'
    $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
    $recovery = @(Get-ChildItem -LiteralPath (Join-Path $ev 'run') -Filter 'recovery-manifest-*.json' -ErrorAction SilentlyContinue)
    Record 'smoke-api-corrupt-rollback-fails: same indeterminate failure with an unconfirmed rollback -> cleanup exit 3, recovery manifest, no deletes, no repeats' ($insp.classification -eq 'indeterminate' -and $r.smoke.indeterminate -and (CountKey $inv 'firebase-rollback') -eq 1 -and -not $r.rules.rollbackConfirmed -and $r.rules.rollbackExit -eq 1 -and $sa.rulesStatus -eq 'rolled-back' -and $sa.rollbackExit -eq '1' -and $r.cleanup.exitCode -eq 3 -and $r.cleanup.branch -eq 'CLEANUP_REFUSED' -and $recovery.Count -eq 1 -and (CountKey $inv 'smoke-cleanup') -eq 1 -and (CountKey $inv 'smoke-inventory') -eq 0) "cleanupExit=$($r.cleanup.exitCode) recovery=$($recovery.Count)"
  }
  foreach ($case in @(@('smoke-uir3-assertion', 'assertion'), @('smoke-uir3-flow', 'ui-flow'))) {
    $name = $case[0]; $kind = $case[1]
    $c = Run-Case $name $name 'stub' $null $null $null $null
    Expect $c 'SAFE_STOP' 'step6' $true {
      param($r, $inv, $ev)
      $insp = Read-Json (Join-Path $ev 'run-inspect-ui-r3.json')
      $sa = SmokeArgs $ev 'cleanup'
      Record "$($name): the round-3 UI flow fails ($kind) after a passed API mode -> confirmed non-Rules failure, rollback count 0, cleanup verified-new, no final checks" ($insp.classification -eq 'confirmed-non-rules-failure' -and $insp.trustedTerminal.mode -eq 'ui-r3' -and $insp.trustedTerminal.kind -eq $kind -and $r.smoke.inspect.mode -eq 'ui-r3' -and -not $r.smoke.rulesProbeFailure -and -not $r.smoke.indeterminate -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-rollback') -eq 0 -and (CountKey $inv 'smoke-api') -eq 1 -and $sa.rulesStatus -eq 'verified-new' -and (CountLike $inv 'functionsCheck-final') -eq 0 -and $r.final -eq $null) $insp.classification
    }
  }

  # ---------------------------------------------------------------- steps 7 and 8
  foreach ($case in @(@('cleanup-exit-2', 'CLEANUP_STOPPED_BEFORE_DELETES', 1), @('cleanup-exit-3', 'CLEANUP_REFUSED', 0), @('cleanup-exit-4', 'CLEANUP_PARTIAL', 1), @('verify-clean-remainder', 'VERIFY_CLEAN_REMAINDER', 1))) {
    $c = Run-Case $case[0] $case[0] 'stub' $null $null $null $null
    $name = $case[0]; $branch = $case[1]; $inventoryRuns = $case[2]
    Expect $c 'SAFE_STOP' 'step7' $true {
      param($r, $inv, $ev)
      Record "$($name): branch $branch, inventory runs $inventoryRuns, no final checks" ($r.cleanup.branch -eq $branch -and (CountKey $inv 'smoke-inventory') -eq $inventoryRuns -and (CountKey $inv 'functionsCheck-final') -eq 0 -and $r.final -eq $null) "branch=$($r.cleanup.branch)"
    }
  }
  $c = Run-Case 'final-functions-fail' 'final-functions-fail' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step8' $true { param($r, $inv, $ev); Record 'final-functions-fail: cleanup completed before the failed final read' ($r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED' -and $r.final.functionsExit -ne 0) $null }
  $c = Run-Case 'final-functions-drift' 'final-functions-drift' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step8' $true { param($r, $inv, $ev); Record 'final-functions-drift: live tool exit 0 but the independent check finds drift -> step 8 STOP' ($r.final.functionsExit -eq 0 -and $r.final.functionsCheckExit -eq 2) $null }
  $c = Run-Case 'final-rules-fail' 'final-rules-fail' 'stub' $null $null $null $null
  Expect $c 'SAFE_STOP' 'step8' $true { param($r, $inv, $ev); Record 'final-rules-fail: final Rules read failed -> step 8 STOP after a verified cleanup' ($r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED' -and $r.final.rulesExit -ne 0) $null }
}

if ($Set -eq 'emulator') {
  $auditLog = Join-Path $Base ('net-audit-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.jsonl')
  $env:M1_NET_AUDIT_LOG = $auditLog
  $nodeOptions = '--require ' + ((Join-Path $Pkg 'tests\net-audit.cjs') -replace '\\', '/')
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $reviewed = Join-Path $Repo 'firestore.rules'
  $round2 = Join-Path $Pkg 'rules\r2-8526a791-firestore.rules'
  $baselineRules = 'D:\projects\finapp\.runtime\m1-baseline-main-6d713fe\firestore.rules'

  $c = Run-Case 'pass-emulator' 'pass-emulator' 'emulator' $null $null $null $nodeOptions
  Expect $c 'STAGE_PASS' $null $true {
    param($r, $inv, $ev)
    $att = Attempts $ev
    Record 'pass-emulator: REAL readiness gate against the Functions emulator (five application-layer 401 answers), real seed/UI/API/UI-R3/cleanup/verify-clean' ($r.readiness.status -eq 'READY' -and $r.readiness.verified -and $att.Count -ge 5 -and @($att | Select-Object -Last 5 | Where-Object { $_.ready -and $_.verdict -eq 'ready' }).Count -eq 5 -and (ReadinessSanitised $ev) -and $r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED') "attempts=$($att.Count)"
    $runJournal = Get-Content -LiteralPath (Join-Path $ev 'run\journal.jsonl') -Raw
    Record 'pass-emulator: real smoke modes passed (preflight, seed, ui, api, ui-r3, cleanup, verify-clean) with a fresh run id' (($runJournal -match '"mode":"seed","target":"emulator","status":"PASS"') -and ($runJournal -match '"mode":"ui","target":"emulator","status":"PASS"') -and ($runJournal -match '"mode":"api","target":"emulator","status":"PASS"') -and ($runJournal -match '"mode":"ui-r3","target":"emulator","status":"PASS"') -and ($runJournal -match 'VERIFY_CLEAN_OK') -and -not ($runJournal -match 'bbb573d8') -and -not ($runJournal -match 'acf785fd')) $null
    $iR = Journal-Index $ev 'readiness'; $iP = Journal-Index $ev 'smoke-preflight'; $iS = Journal-Index $ev 'smoke-seed'
    Record 'pass-emulator: readiness ran before preflight and seed' ($iR -ge 0 -and $iR -lt $iP -and $iP -lt $iS) "readiness=$iR preflight=$iP seed=$iS"
    Record 'pass-emulator: Node 24 CLI root and Node 22 functions build recorded' (Node-Versions $ev) $null
  }
  # Real application failure: the pre-M1 baseline Rules (main) make the NEW frontend fail on the emulator
  # (new client + old Rules = no access). That is an ORDINARY failure (a ui-flow STOP, not an R1-R9 probe): no rollback may follow.
  & $node (Join-Path $Pkg 'tests\load-emulator-rules.mjs') --file $baselineRules | Out-Host
  try {
    $c = Run-Case 'ui-failure-no-rollback' 'pass-emulator' 'emulator' $null $null $null $nodeOptions
  } finally { & $node (Join-Path $Pkg 'tests\load-emulator-rules.mjs') --file $reviewed | Out-Host }
  Expect $c 'SAFE_STOP' 'step6' $true {
    param($r, $inv, $ev)
    $insp = Read-Json (Join-Path $ev 'run-inspect-ui.json')
    Record 'ui-failure-no-rollback: REAL ui-flow failure on the emulator (new frontend under the pre-M1 Rules) -> confirmed non-Rules failure, rollback count 0, no API run, real cleanup verified-new complete' ($insp.classification -eq 'confirmed-non-rules-failure' -and $insp.trustedTerminal.mode -eq 'ui' -and (@('assertion', 'ui-flow') -contains $insp.trustedTerminal.kind) -and -not $r.rules.rollbackAttempted -and (CountKey $inv 'firebase-rollback') -eq 0 -and $r.cleanup.rulesStatus -eq 'verified-new' -and $r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED' -and $r.final -eq $null) $insp.trustedTerminal.reason
  }
  # Real Rules failures. The API smoke must catch BOTH the previous (round-2) Rules and a round-3 Rules with the ownerId branch
  # restored; neither file is ever deployed anywhere - they are only loaded into the LOCAL emulator.
  $defective = Join-Path $Base ('defective-owner-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') + '.rules')
  & $node (Join-Path $Pkg 'tests\make-defective-rules.mjs') --out $defective | Out-Host
  foreach ($case in @(@('rules-failure-round2-rollback-ok', 'confirmed', $round2, '^R5\.'), @('rules-failure-owner-rollback-ok', 'confirmed', $defective, '^R6\.'), @('rules-failure-round2-rollback-fails', 'refused', $round2, '^R5\.'))) {
    $name = $case[0]; $mode = $case[1]; $rulesFile = $case[2]; $probe = $case[3]
    $scenarioName = if ($mode -eq 'confirmed') { 'smoke-r3-rollback' } else { 'smoke-r3-rollback-fails' }
    & $node (Join-Path $Pkg 'tests\load-emulator-rules.mjs') --file $rulesFile | Out-Host
    try {
      $c = Run-Case $name $scenarioName 'emulator' $null $null $null $nodeOptions
    } finally { & $node (Join-Path $Pkg 'tests\load-emulator-rules.mjs') --file $reviewed | Out-Host }
    Expect $c 'SAFE_STOP' 'step6' $true {
      param($r, $inv, $ev)
      $insp = Read-Json (Join-Path $ev 'run-inspect-api.json')
      $recovery = @(Get-ChildItem -LiteralPath (Join-Path $ev 'run') -Filter 'recovery-manifest-*.json' -ErrorAction SilentlyContinue)
      if ($mode -eq 'confirmed') {
        Record "$($name): REAL probe failure on the emulator ($probe) -> confirmed-rules-failure, one rollback (stub CLI) confirmed, REAL cleanup gate accepted rolled-back and deleted everything" ($insp.classification -eq 'confirmed-rules-failure' -and $insp.trustedTerminal.reason -match $probe -and $r.rules.rollbackConfirmed -and (CountKey $inv 'firebase-rollback') -eq 1 -and $r.cleanup.rulesStatus -eq 'rolled-back' -and $r.cleanup.exitCode -eq 0 -and $r.cleanup.branch -eq 'CLEANUP_COMPLETE_VERIFIED') $insp.trustedTerminal.reason
      } else {
        Record "$($name): REAL probe failure, the single rollback fails -> REAL cleanup gate refused (exit 3) with a recovery manifest and no deletes, no retry" ($insp.classification -eq 'confirmed-rules-failure' -and -not $r.rules.rollbackConfirmed -and $r.rules.rollbackExit -eq 1 -and $r.cleanup.exitCode -eq 3 -and $r.cleanup.branch -eq 'CLEANUP_REFUSED' -and $recovery.Count -eq 1 -and (CountKey $inv 'firebase-rollback') -eq 1) $insp.classification
      }
    }
  }
  Remove-Item Env:M1_NET_AUDIT_LOG
  # Network audit: every socket destination of every node process of the emulator rehearsals was loopback.
  $audit = Read-Lines $auditLog
  $external = @($audit | Where-Object { $_.kind -eq 'connect' -and $_.target -notmatch '^(127\.0\.0\.1|localhost|::1|\[::1\]):\d+$' -and $_.target -ne 'pipe:local' })
  $dnsExternal = @($audit | Where-Object { $_.kind -eq 'dns' -and @('localhost', '127.0.0.1', '::1') -notcontains $_.target })
  $tcp = @($audit | Where-Object { $_.kind -eq 'connect' -and $_.target -ne 'pipe:local' })
  Record 'emulator rehearsals: network audit recorded connections and every destination is loopback (no staging, production, GitHub or other host)' ($tcp.Count -gt 50 -and $external.Count -eq 0 -and $dnsExternal.Count -eq 0) "tcpConnections=$($tcp.Count) other=$(@($audit).Count - $tcp.Count) external=$($external.Count) dnsExternal=$($dnsExternal.Count)"
}

if ($Set -eq 'helpers') {
  $dir = Join-Path $Base ('helpers-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff'))
  New-Item -ItemType Directory -Path $dir | Out-Null
  $node = (Get-Command node -CommandType Application | Select-Object -First 1).Source
  $expectedFile = Join-Path $Pkg 'expected-state-r3.json'
  $exp = Read-Json $expectedFile

  # Local provenance / independent state checks (real rev8 evidence, read-only).
  & $node (Join-Path $Pkg 'm1-state-check.mjs') --mode provenance --expected $expectedFile --evidence-root $PriorEv --run-root $PriorRun --out (Join-Path $dir 'prov.json') | Out-Host
  Record 'state-check provenance: the real rev8 evidence, pinned functions and pre-release Rules all verify' ($LASTEXITCODE -eq 0 -and (Read-Json (Join-Path $dir 'prov.json')).status -eq 'OK') $null
  & $node (Join-Path $Pkg 'm1-state-check.mjs') --mode functions --expected $expectedFile --evidence (Join-Path $PriorEv 'm1-stg-functions-state-final-rev8.json') --out (Join-Path $dir 'fx.json') | Out-Host
  Record 'state-check functions: the rev8 report (another head) is not accepted as an R3 exact-state report' ($LASTEXITCODE -eq 2) $null
  & $node (Join-Path $Pkg 'm1-state-check.mjs') --mode rules --expected $expectedFile --evidence (Join-Path $PriorEv 'm1-stg-rules-state-final-rev8.jsonl') --canonical $PRE --out (Join-Path $dir 'rules.json') | Out-Host
  Record 'state-check rules: the rev8 Rules journal (another head) is not accepted as R3 evidence' ($LASTEXITCODE -eq 2) $null
  & $node (Join-Path $Pkg 'm1-state-check.mjs') --mode local-rules --expected $expectedFile --repo $Repo --out (Join-Path $dir 'local.json') | Out-Host
  Record 'state-check local-rules: the release clone holds the pinned LF round-3 Rules and the shipped round-2 reference CRLF-converts to the pinned live bytes' ($LASTEXITCODE -eq 0) $null

  # Functions/config unchanged between 8526a79 and 714d0f91 (the git mechanism the orchestrator uses in step 0).
  Push-Location -LiteralPath $Repo
  & git diff --quiet 8526a791ce3f62dee5a64aa239b795c609a39226 $H -- functions firebase.json firestore.indexes.json .firebaserc
  $unchanged = $LASTEXITCODE
  & git diff --quiet 8526a791ce3f62dee5a64aa239b795c609a39226 $H -- firestore.rules
  $rulesChanged = $LASTEXITCODE
  & git diff --quiet 8526a791ce3f62dee5a64aa239b795c609a39226 $H -- src
  $srcChanged = $LASTEXITCODE
  Pop-Location
  Record 'git: functions, firebase.json, firestore.indexes.json and .firebaserc are byte-identical between 8526a79 and 714d0f91 (exit 0) while firestore.rules and src differ (exit 1) - the check can tell them apart' ($unchanged -eq 0 -and $rulesChanged -eq 1 -and $srcChanged -eq 1) "functions=$unchanged rules=$rulesChanged src=$srcChanged"

  # Rollback preparation from a synthetic fresh backup of the live pre-release Rules (CRLF form of the round-2 file).
  $blob = Join-Path $Pkg ($exp.rollback.blobFile -replace '/', '\')
  & $node (Join-Path $Pkg 'tests\make-synthetic-backup.mjs') --out (Join-Path $dir 'backup.json') | Out-Host
  $prep = Join-Path $dir 'rollback-ok'
  $prepArgs = @((Join-Path $Pkg 'm1-rules-rollback-prepare.mjs'), '--backup', (Join-Path $dir 'backup.json'), '--expected-rules-hash', $exp.rollback.canonicalSha256, '--expected-raw-sha256', $exp.rulesPre.rawSha256, '--expected-bytes', ([string]$exp.rulesPre.sourceBytes), '--compare-rules', $blob, '--out-dir', $prep)
  & $node @prepArgs | Out-Host
  $okPrep = ($LASTEXITCODE -eq 0)
  $sameBytes = (Test-Path (Join-Path $prep 'firestore.rules')) -and ((Get-FileHash -LiteralPath (Join-Path $prep 'firestore.rules') -Algorithm SHA256).Hash.ToLower() -eq $exp.rulesPre.rawSha256)
  Record 'rollback-prepare: the backup of the live pre-release Rules is verified byte-for-byte (raw f8b4cae2..., 23936 bytes) and the rollback dir is written' ($okPrep -and $sameBytes -and (Get-Item (Join-Path $prep 'firestore.rules')).Length -eq 23936) $null

  # Deploy wrapper in rehearsal profile: the forward Rules deploy and the rollback, nothing else.
  $env:M1_STUB_STATE = Join-Path $dir 'stub-state'
  $env:M1_STUB_NETWORK_LOG = Join-Path $dir 'stub-state\network-attempts.jsonl'
  $env:M1_STUB_SCENARIO = Join-Path $Pkg 'stubs\scenarios\pass-emulator.json'
  New-Item -ItemType Directory -Path $env:M1_STUB_STATE | Out-Null
  $wrapper = Join-Path $Pkg 'm1-deploy-wrapper.mjs'
  $evDir = Join-Path $dir 'evidence-like'
  New-Item -ItemType Directory -Path $evDir | Out-Null
  Copy-Item -LiteralPath $prep -Destination (Join-Path $evDir 'm1-stg-rules-rollback-r3') -Recurse
  $cfg = Join-Path $evDir 'm1-stg-rules-rollback-r3\firebase.json'
  foreach ($kind in @('functions', 'indexes', 'hosting')) {
    & $node $wrapper --profile rehearsal --kind $kind --expected-head $H --out-dir (Join-Path $evDir "deploy-$kind") | Out-Host
    Record "wrapper: kind $kind refused (the R3 release deploys only Rules), no out-dir, no spawn" ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $evDir "deploy-$kind"))) $null
  }
  & $node $wrapper --profile rehearsal --kind rules --expected-head $H --out-dir (Join-Path $evDir 'deploy-with-config') --rollback-config $cfg | Out-Host
  Record 'wrapper: the forward kind refuses a --rollback-config, the rollback kind needs one' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $evDir 'deploy-with-config'))) $null
  & $node $wrapper --profile rehearsal --kind rules-rollback --expected-head $H --out-dir (Join-Path $evDir 'deploy-no-config') | Out-Host
  Record 'wrapper: rules-rollback without --rollback-config is refused' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $evDir 'deploy-no-config'))) $null
  & $node $wrapper --profile rehearsal --kind rules-rollback --expected-head '8526a791ce3f62dee5a64aa239b795c609a39226' --out-dir (Join-Path $evDir 'deploy-head') --rollback-config $cfg | Out-Host
  Record 'wrapper: a wrong expected head is refused before anything is created' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $evDir 'deploy-head'))) $null
  & $node $wrapper --profile rehearsal --kind rules-rollback --expected-head $H --out-dir (Join-Path $evDir 'deploy-elsewhere') --rollback-config (Join-Path $dir 'rollback-ok\firebase.json') | Out-Host
  Record 'wrapper: rollback config outside the R3 evidence naming -> refused' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $evDir 'deploy-elsewhere'))) $null
  & $node $wrapper --profile rehearsal --kind rules --expected-head $H --out-dir (Join-Path $evDir 'deploy-rules') | Out-Host
  $fwd = Read-Json (Join-Path $evDir 'deploy-rules\exit.json')
  Record 'wrapper: the forward deploy recorded the exact child exit code 0 with the exact argv (firestore:rules only, finapp-staging, no --config)' ($LASTEXITCODE -eq 0 -and $fwd.exitCode -eq 0 -and ($fwd.argv -join ' ') -like '*deploy --project finapp-staging --only firestore:rules --non-interactive') ($fwd.argv -join ' ')
  & $node $wrapper --profile rehearsal --kind rules-rollback --expected-head $H --out-dir (Join-Path $evDir 'deploy-rules-rollback') --rollback-config $cfg | Out-Host
  $exitRec = Read-Json (Join-Path $evDir 'deploy-rules-rollback\exit.json')
  Record 'wrapper: rollback recorded the exact child exit code 0 with the exact argv (firestore:rules only, finapp-staging, --config)' ($LASTEXITCODE -eq 0 -and $exitRec.exitCode -eq 0 -and ($exitRec.argv -join ' ') -like '*deploy --project finapp-staging --config firebase.json --only firestore:rules --non-interactive') ($exitRec.argv -join ' ')
  $bytes = [IO.File]::ReadAllBytes((Join-Path $evDir 'deploy-rules-rollback\stdout.log'))
  Record 'wrapper: stdout.log has no BOM' (-not ($bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB)) $null
  & $node $wrapper --profile rehearsal --kind rules --expected-head $H --out-dir (Join-Path $evDir 'deploy-rules') | Out-Host
  Record 'wrapper: a repeated forward deploy into the same out-dir -> STOP' ($LASTEXITCODE -eq 2) $null
  & $node $wrapper --profile rehearsal --kind rules-rollback --expected-head $H --out-dir (Join-Path $evDir 'deploy-rules-rollback') --rollback-config $cfg | Out-Host
  Record 'wrapper: a repeated rollback into the same out-dir -> STOP' ($LASTEXITCODE -eq 2) $null
  $inv = Read-Lines (Join-Path $dir 'stub-state\invocations.jsonl')
  Record 'wrapper: stub Firebase CLI ran exactly twice (one forward deploy, one rollback) and refused nothing' ((CountKey $inv 'firebase-deploy-rules') -eq 1 -and (CountKey $inv 'firebase-rollback') -eq 1 -and @($inv | Where-Object { $_.refused }).Count -eq 0) $null
  Record 'wrapper: no network attempts' (-not (Test-Path $env:M1_STUB_NETWORK_LOG)) $null
  Remove-Item Env:M1_STUB_STATE, Env:M1_STUB_NETWORK_LOG, Env:M1_STUB_SCENARIO

  # Export helper CLI: argument validation (nothing is sent in these calls).
  $exportTool = Join-Path $Pkg 'm1-export.mjs'
  $goodUri = 'gs://my-backups/finapp/staging'
  foreach ($case in @(@('wrong-project', @('--profile', 'rehearsal', '--project', 'finapp-prod-10a83', '--uri', $goodUri, '--expected-head', $H)), @('wrong-head', @('--profile', 'rehearsal', '--project', 'finapp-staging', '--uri', $goodUri, '--expected-head', '8526a791ce3f62dee5a64aa239b795c609a39226')), @('bad-uri', @('--profile', 'rehearsal', '--project', 'finapp-staging', '--uri', 'gs://my-backups/a b', '--expected-head', $H)))) {
    $o = Join-Path $dir ('export-' + $case[0])
    & $node $exportTool @($case[1]) --out-dir $o | Out-Host
    Record "export CLI: $($case[0]) refused (exit 2) before anything is created or sent" ($LASTEXITCODE -eq 2 -and -not (Test-Path $o)) $null
  }
  $o = Join-Path $dir 'export-no-stub'
  & $node $exportTool --profile rehearsal --project finapp-staging --uri $goodUri --expected-head $H --out-dir $o | Out-Host
  Record 'export CLI: the rehearsal profile without the stub environment is refused (exit 2); no out-dir' ($LASTEXITCODE -eq 2 -and -not (Test-Path $o)) $null
  $env:M1_STUB_STATE = Join-Path $dir 'stub-state2'
  $env:M1_STUB_NETWORK_LOG = Join-Path $dir 'stub-state2\network-attempts.jsonl'
  $env:M1_STUB_SCENARIO = Join-Path $Pkg 'stubs\scenarios\pass-emulator.json'
  New-Item -ItemType Directory -Path $env:M1_STUB_STATE | Out-Null
  $o = Join-Path $dir 'export-ok'
  & $node $exportTool --profile rehearsal --project finapp-staging --uri $goodUri --expected-head $H --out-dir $o | Out-Host
  $er = Read-Json (Join-Path $o 'export-result.json')
  Record 'export CLI: the stub export is verified (operation SUCCESSFUL + metadata object listed) and the plan was written first' ($LASTEXITCODE -eq 0 -and $er.status -eq 'EXPORT_VERIFIED' -and (Test-Path (Join-Path $o 'plan.json'))) $er.prefix
  & $node $exportTool --profile rehearsal --project finapp-staging --uri $goodUri --expected-head $H --out-dir $o | Out-Host
  Record 'export CLI: a second export into the same out-dir is refused (run-once)' ($LASTEXITCODE -eq 2) $null
  Remove-Item Env:M1_STUB_STATE, Env:M1_STUB_NETWORK_LOG, Env:M1_STUB_SCENARIO

  # Readiness CLI: argument validation only (no request is ever made in these calls).
  $rd = Join-Path $Pkg 'm1-readiness.mjs'
  foreach ($extra in @(@('--deadline-ms', '1000'), @('--interval-ms', '10'), @('--request-timeout-ms', '10'), @('--base-url', 'http://127.0.0.1:1'))) {
    $o = Join-Path $dir ('rd-' + ($extra[0] -replace '--', ''))
    & $node $rd --target staging --expected-head $H --out-dir $o @extra | Out-Host
    Record "readiness CLI: staging refuses the override $($extra[0]) (fixed endpoint and limits), no out-dir, no request" ($LASTEXITCODE -eq 2 -and -not (Test-Path $o)) $null
  }
  & $node $rd --target emulator --expected-head $H --out-dir (Join-Path $dir 'rd-remote') --base-url 'https://example.com/x' | Out-Host
  Record 'readiness CLI: a non-loopback base URL is refused' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $dir 'rd-remote'))) $null
  & $node $rd --target staging --expected-head '8526a791ce3f62dee5a64aa239b795c609a39226' --out-dir (Join-Path $dir 'rd-head') | Out-Host
  Record 'readiness CLI: wrong expected head refused before any request' ($LASTEXITCODE -eq 2 -and -not (Test-Path (Join-Path $dir 'rd-head'))) $null

  # Staging profile refusals. Each call also carries a relative -WebConfig, which is refused
  # by a second, independent init guard, so no staging code path can be reached by these tests.
  $orch = Join-Path $Pkg 'm1-orchestrator.ps1'
  $gsUri = 'gs://my-backups/finapp/staging'
  $o1 = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile staging -WebConfig 'relative.env' -Node22Dir 'relative' -ExportUri $gsUri -Scenario (Join-Path $Pkg 'stubs\scenarios\pass-stub-clean.json')
  Record 'orchestrator staging: -Scenario refused at init (exit 3), nothing executed' ($LASTEXITCODE -eq 3 -and ($o1 -join ' ') -match 'INIT_REFUSED') ($o1 -join ' ')
  $o1b = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile staging -WebConfig 'relative.env' -Node22Dir 'relative' -ExportUri $gsUri -PriorEvidenceRoot $PriorEv
  Record 'orchestrator staging: a -PriorEvidenceRoot override is refused at init (exit 3)' ($LASTEXITCODE -eq 3 -and ($o1b -join ' ') -match 'INIT_REFUSED') ($o1b -join ' ')
  $env:M1_STUB_SCENARIO = 'x'
  $o2 = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile staging -WebConfig 'relative.env' -Node22Dir 'relative' -ExportUri $gsUri
  Remove-Item Env:M1_STUB_SCENARIO
  Record 'orchestrator staging: stub environment refused at init (exit 3), nothing executed' ($LASTEXITCODE -eq 3 -and ($o2 -join ' ') -match 'stub environment') ($o2 -join ' ')
  foreach ($bad in @('gs://bucket-only', 'gs://my-backups/a/', 'gs://my-backups/../x', 'gs://my-backups/a b', 'https://my-backups/a', 'gs://My-Backups/a')) {
    $o5 = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile staging -WebConfig 'relative.env' -Node22Dir 'relative' -ExportUri $bad
    Record "orchestrator staging: ExportUri '$bad' refused at init (exit 3)" ($LASTEXITCODE -eq 3 -and ($o5 -join ' ') -match 'ExportUri') ($o5 -join ' ')
  }
  Record 'orchestrator staging: no R3 staging evidence or run directory was created' ((-not (Test-Path -LiteralPath 'D:\projects\finapp\.runtime\m1-stg-r4-714d0f91')) -and (-not (Test-Path -LiteralPath 'D:\projects\finapp\.runtime\m1-staging-run-714d0f91-v6'))) $null
  $o3 = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile rehearsal -WebConfig 'D:\projects\finapp\finapp\.env.staging.local' -Node22Dir 'C:\x' -ExportUri $gsUri -EvidenceRoot 'D:\projects\finapp\.runtime\elsewhere' -Scenario (Join-Path $Pkg 'stubs\scenarios\pass-stub-clean.json')
  Record 'orchestrator rehearsal: evidence root outside rehearsal base refused (exit 3)' ($LASTEXITCODE -eq 3) ($o3 -join ' ')
  $o4 = & powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $orch -RunProfile rehearsal -WebConfig 'D:\projects\finapp\finapp\.env.staging.local' -Node22Dir 'C:\x' -ExportUri $gsUri -EvidenceRoot (Join-Path $Base 'never-created') -Scenario (Join-Path $Pkg 'stubs\scenarios\pass-stub-clean.json') -PriorEvidenceRoot 'D:\projects\finapp\.runtime' -PriorRunRoot $PriorRun
  Record 'orchestrator rehearsal: a Prior root that is neither the real rev8 directory nor a copy under the rehearsal base is refused (exit 3)' ($LASTEXITCODE -eq 3 -and -not (Test-Path (Join-Path $Base 'never-created'))) ($o4 -join ' ')
}

$failed = @($script:Cases | Where-Object { -not $_.pass }).Count
$summary = [ordered]@{ set = $Set; total = $script:Cases.Count; failed = $failed; cases = $script:Cases; at = (Get-Date).ToUniversalTime().ToString('o') }
[IO.File]::WriteAllText((Join-Path $ResultsDir "ps51-orchestrator-tests-$Set.json"), ($summary | ConvertTo-Json -Depth 6), $Utf8NoBom)
[Console]::Out.WriteLine("PS51_ORCHESTRATOR_TESTS set=$Set $(if ($failed) { 'FAIL' } else { 'PASS' }) $($script:Cases.Count - $failed)/$($script:Cases.Count)")
if ($failed) { exit 1 } else { exit 0 }
