param([Parameter(Mandatory=$true)][string]$TargetDir)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
$taskTarget=[IO.Path]::GetFullPath($TargetDir)
$taskPrevious=$env:CARGO_TARGET_DIR
try {
 $env:CARGO_TARGET_DIR=$taskTarget
 & cargo build --locked --offline --release --manifest-path (Join-Path $taskRoot 'native\Cargo.toml') --bin assets --bin job --bin launcher --bin text-codec --bin update-helper
 if($LASTEXITCODE -ne 0){throw 'V9 native build failed'}
 New-Item -ItemType Directory -Path (Join-Path $taskRoot 'bin') -Force | Out-Null
 foreach($name in @('assets.exe','job.exe','launcher.exe','text-codec.exe','update-helper.exe')){Copy-Item -LiteralPath (Join-Path $taskTarget "release\$name") -Destination (Join-Path $taskRoot "bin\$name") -Force}
} finally {$env:CARGO_TARGET_DIR=$taskPrevious}
