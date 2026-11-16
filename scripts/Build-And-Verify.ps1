param(
 [Parameter(Mandatory=$true)][string]$TargetRoot,
 [Parameter(Mandatory=$true)][string]$OutputDir,
 [Parameter(Mandatory=$true)][string]$NodePath,
 [string]$EngineConfig,
 [switch]$DesktopSmoke
)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskEvidence=Join-Path $OutputDir 'build-evidence'
New-Item -ItemType Directory -Path $taskEvidence -Force | Out-Null
& (Join-Path $PSScriptRoot 'Build-Native.ps1') -TargetDir (Join-Path $TargetRoot 'native') *> (Join-Path $taskEvidence 'native-build.log')
& (Join-Path $PSScriptRoot 'Test.ps1') -NodePath $NodePath -EvidenceDir $taskEvidence
$taskPrevious=$env:CARGO_TARGET_DIR
try {
 $env:CARGO_TARGET_DIR=Join-Path $TargetRoot 'contracts'
 & cargo test --locked --offline --manifest-path (Join-Path $taskRoot 'host-contract-tests\Cargo.toml') --jobs 2 *> (Join-Path $taskEvidence 'host-contract.log')
 if($LASTEXITCODE -ne 0){throw 'Host protocol regression failed'}
} finally {$env:CARGO_TARGET_DIR=$taskPrevious}
& (Join-Path $PSScriptRoot 'Build-Desktop.ps1') -TargetDir (Join-Path $TargetRoot 'desktop') -OutputDir $OutputDir *> (Join-Path $taskEvidence 'desktop-build.log')
if($DesktopSmoke){
 if(-not $EngineConfig){throw 'Desktop smoke requires an explicit local engine configuration'}
 & (Join-Path $PSScriptRoot 'Start-Preview.ps1') -EngineConfig $EngineConfig -PreviewExe (Join-Path $OutputDir 'CK-V9-Preview.exe') -Harness (Join-Path $taskRoot 'tests\desktop.mjs') -CdpPort 9234
}
Write-Output "V9 foundation build verified. Evidence: $taskEvidence"
