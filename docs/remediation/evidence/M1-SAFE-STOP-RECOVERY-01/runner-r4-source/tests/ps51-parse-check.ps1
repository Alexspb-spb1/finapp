<#
Parses every .ps1 of the package with the Windows PowerShell 5.1 parser, and checks that
each file starts with a UTF-8 BOM and is ASCII after the BOM. Run via powershell.exe -File.
#>
$Pkg = Split-Path $PSScriptRoot -Parent
$failed = 0
$files = @(Get-ChildItem -LiteralPath $Pkg -Recurse -Filter '*.ps1' | Where-Object { $_.FullName -notlike '*\results\*' })
foreach ($f in $files) {
  $bytes = [IO.File]::ReadAllBytes($f.FullName)
  $bom = $bytes.Length -ge 3 -and $bytes[0] -eq 0xEF -and $bytes[1] -eq 0xBB -and $bytes[2] -eq 0xBF
  $nonAscii = @($bytes[3..($bytes.Length - 1)] | Where-Object { $_ -gt 0x7F }).Count
  $tokens = $null; $errors = $null
  [void][System.Management.Automation.Language.Parser]::ParseFile($f.FullName, [ref]$tokens, [ref]$errors)
  $ok = $bom -and $nonAscii -eq 0 -and $errors.Count -eq 0
  if (-not $ok) { $failed++ }
  $rel = $f.FullName.Substring($Pkg.Length + 1)
  [Console]::Out.WriteLine("$(if ($ok) { 'PASS' } else { 'FAIL' }) $rel bom=$bom nonAscii=$nonAscii parseErrors=$($errors.Count)")
}
[Console]::Out.WriteLine("PS51_PARSE_CHECK psVersion=$($PSVersionTable.PSVersion) files=$($files.Count) failed=$failed")
if ($failed) { exit 1 } else { exit 0 }
