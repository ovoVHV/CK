param([Parameter(Mandatory=$true)][string]$TargetDir,[Parameter(Mandatory=$true)][string]$OutputDir,[string]$TemporaryDirectory)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskSource=Join-Path $taskRoot 'desktop'
$taskTarget=[IO.Path]::GetFullPath($TargetDir)
$taskOut=[IO.Path]::GetFullPath($OutputDir)
if($taskTarget -eq 'E:\CK_FLFE_TARGET' -or $taskOut.StartsWith('C:\Users\AI\Documents\CK\',[StringComparison]::OrdinalIgnoreCase)){throw 'Refuse production output'}
$taskSaved=$env:CARGO_TARGET_DIR
$taskTempSaved=$env:TEMP;$taskTmpSaved=$env:TMP
try {
 $env:CARGO_TARGET_DIR=$taskTarget
 $taskTemp=if($TemporaryDirectory){[IO.Path]::GetFullPath($TemporaryDirectory)}else{Join-Path $taskTarget 'tmp'};New-Item -ItemType Directory -Path $taskTemp -Force | Out-Null;$env:TEMP=$taskTemp;$env:TMP=$taskTemp
 & cargo build --locked --offline --release --jobs 2 --features custom-protocol --manifest-path (Join-Path $taskSource 'Cargo.toml') -p appsdesktop
 if($LASTEXITCODE -ne 0){throw 'Preview desktop build failed'}
 New-Item -ItemType Directory -Path $taskOut -Force | Out-Null
 Copy-Item -LiteralPath (Join-Path $taskTarget 'release\appsdesktop.exe') -Destination (Join-Path $taskOut 'CK-V9-Preview.exe') -Force
 $taskTauri=Join-Path $taskSource 'apps\desktop\src-tauri'
 $taskResources=(Get-Content -LiteralPath (Join-Path $taskTauri 'tauri.conf.json') -Raw | ConvertFrom-Json).bundle.resources
 foreach($taskEntry in $taskResources.PSObject.Properties){
  $taskFrom=[IO.Path]::GetFullPath((Join-Path $taskTauri $taskEntry.Name))
  $taskTo=[IO.Path]::GetFullPath((Join-Path $taskOut $taskEntry.Value))
  if(-not $taskTo.StartsWith($taskOut+[IO.Path]::DirectorySeparatorChar,[StringComparison]::OrdinalIgnoreCase)){throw 'Resource output escapes preview directory'}
  if((Get-Item -LiteralPath $taskFrom).PSIsContainer){
   foreach($taskFile in Get-ChildItem -LiteralPath $taskFrom -File -Recurse){$taskDest=Join-Path $taskTo ([IO.Path]::GetRelativePath($taskFrom,$taskFile.FullName));New-Item -ItemType Directory -Path (Split-Path $taskDest -Parent) -Force | Out-Null;Copy-Item -LiteralPath $taskFile.FullName -Destination $taskDest -Force}
  }else{New-Item -ItemType Directory -Path (Split-Path $taskTo -Parent) -Force | Out-Null;Copy-Item -LiteralPath $taskFrom -Destination $taskTo -Force}
 }
 Get-FileHash -LiteralPath (Join-Path $taskOut 'CK-V9-Preview.exe') -Algorithm SHA256
} finally {$env:CARGO_TARGET_DIR=$taskSaved;$env:TEMP=$taskTempSaved;$env:TMP=$taskTmpSaved}
