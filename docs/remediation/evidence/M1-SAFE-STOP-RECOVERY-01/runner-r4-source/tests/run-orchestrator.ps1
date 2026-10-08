<#
Test helper: runs the R3 orchestrator exactly as documented, through a new
powershell.exe -NoProfile -NonInteractive -ExecutionPolicy Bypass -File process,
for one rehearsal scenario. Prints the orchestrator exit code as the last line.
ASCII only, saved with BOM.
#>
param(
  [Parameter(Mandatory = $true)][string]$Name,
  [Parameter(Mandatory = $true)][string]$ScenarioName,
  [Parameter(Mandatory = $true)][ValidateSet('emulator', 'stub')][string]$SmokeMode,
  [string]$PackageDir,
  [string]$EvidenceRoot,
  [string]$PriorEvidenceRoot,
  [string]$PriorRunRoot,
  [string]$NodeOptions
)
$Pkg = if ($PackageDir) { $PackageDir } else { Split-Path $PSScriptRoot -Parent }
$Node22 = 'D:\projects\finapp\.runtime\node22-portable\node-v22.23.3-win-x64'
$Base = 'D:\projects\finapp\.runtime\m1-r4-rehearsal'
if (-not (Test-Path -LiteralPath $Base)) { New-Item -ItemType Directory -Path $Base | Out-Null }
if (-not $EvidenceRoot) { $EvidenceRoot = $Base + '\' + $Name + '-' + (Get-Date -Format 'yyyyMMdd-HHmmss-fff') }
$logDir = Join-Path $Base '_console'
if (-not (Test-Path -LiteralPath $logDir)) { New-Item -ItemType Directory -Path $logDir | Out-Null }
$stamp = Split-Path $EvidenceRoot -Leaf
$out = Join-Path $logDir "$stamp.stdout.txt"
$err = Join-Path $logDir "$stamp.stderr.txt"
$argList = @('-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', (Join-Path $Pkg 'm1-orchestrator.ps1'),
  '-RunProfile', 'rehearsal', '-WebConfig', 'D:\projects\finapp\finapp\.env.staging.local', '-Node22Dir', $Node22, '-ExportUri', 'gs://m1-rehearsal-bucket/exports',
  '-EvidenceRoot', $EvidenceRoot, '-Scenario', (Join-Path $Pkg "stubs\scenarios\$ScenarioName.json"), '-SmokeMode', $SmokeMode)
if ($PriorEvidenceRoot) { $argList += @('-PriorEvidenceRoot', $PriorEvidenceRoot) }
if ($PriorRunRoot) { $argList += @('-PriorRunRoot', $PriorRunRoot) }
# Test-only: a network audit preload for the emulator set (records every socket destination).
if ($NodeOptions) { $env:NODE_OPTIONS = $NodeOptions }
$p = Start-Process -FilePath 'powershell.exe' -ArgumentList $argList -NoNewWindow -Wait -PassThru -RedirectStandardOutput $out -RedirectStandardError $err
if ($NodeOptions) { Remove-Item Env:NODE_OPTIONS }
[Console]::Out.WriteLine("EVIDENCE=$EvidenceRoot")
[Console]::Out.WriteLine("STDOUT=$out")
[Console]::Out.WriteLine("EXIT=$($p.ExitCode)")
