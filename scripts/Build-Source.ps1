#Requires -Version 7.0
param([string]$TargetRoot, [string]$OutputDirectory)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
if(-not $TargetRoot){$TargetRoot=Join-Path $taskRoot 'local/targets'}
if(-not $OutputDirectory){$OutputDirectory=Join-Path $taskRoot 'local/preview'}
$taskTarget=[IO.Path]::GetFullPath($TargetRoot)
$taskOutput=[IO.Path]::GetFullPath($OutputDirectory)
Push-Location $taskRoot
try {
  & node scripts/prepare-source.mjs
  if($LASTEXITCODE -ne 0){throw 'Tool preparation failed'}
  & npm.cmd ci --prefix desktop/apps/desktop
  if($LASTEXITCODE -ne 0){throw 'Frontend dependency installation failed'}
  foreach($taskManifest in @('native/Cargo.toml','desktop/Cargo.toml','host-contract-tests/Cargo.toml')){
    & cargo fetch --locked --manifest-path $taskManifest
    if($LASTEXITCODE -ne 0){throw "Cargo dependency download failed: $taskManifest"}
  }
  & (Join-Path $PSScriptRoot 'Build-Native.ps1') -TargetDir (Join-Path $taskTarget 'native')
  & npm.cmd --prefix desktop/apps/desktop run build:web
  if($LASTEXITCODE -ne 0){throw 'Frontend build failed'}
  & (Join-Path $PSScriptRoot 'Build-Desktop.ps1') -TargetDir (Join-Path $taskTarget 'desktop') -OutputDir $taskOutput
  Write-Output "Built preview: $(Join-Path $taskOutput 'CK-V9-Preview.exe')"
  Write-Output 'See docs/BUILDING.md to configure V9 or produce an installer.'
} finally {Pop-Location}
