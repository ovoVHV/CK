param([Parameter(Mandatory=$true)][string]$NodePath,[Parameter(Mandatory=$true)][string]$EvidenceDir)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
New-Item -ItemType Directory -Path $EvidenceDir -Force | Out-Null
& $NodePath (Join-Path $taskRoot 'scripts\check.mjs')
if($LASTEXITCODE -ne 0){throw 'Runtime dependency/syntax check failed'}
$taskTests=@(Get-ChildItem -LiteralPath (Join-Path $taskRoot 'tests') -Filter '*.test.mjs' | ForEach-Object {$_.FullName})
& $NodePath --test --test-reporter=tap $taskTests | Tee-Object -FilePath (Join-Path $EvidenceDir 'unit-regression.tap')
if($LASTEXITCODE -ne 0){throw 'Regression failed'}
