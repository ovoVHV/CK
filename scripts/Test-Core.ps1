param([Parameter(Mandatory=$true)][string]$TargetDir)
$ErrorActionPreference='Stop'
$taskRoot=Split-Path $PSScriptRoot -Parent
# The inherited Windows tests expect an executable CLI at workspace/bin.
New-Item -ItemType Directory -Path (Join-Path $taskRoot 'desktop/bin') -Force | Out-Null
Copy-Item -LiteralPath (Join-Path $taskRoot 'desktop/apps/desktop/src-tauri/bin/arduino-cli.exe') -Destination (Join-Path $taskRoot 'desktop/bin/arduino-cli.exe') -Force
$taskVars=@('CARGO_TARGET_DIR','CARGO_PROFILE_TEST_DEBUG','CARGO_INCREMENTAL','TEMP','TMP')
$taskSaved=@{};foreach($taskName in $taskVars){$taskSaved[$taskName]=[Environment]::GetEnvironmentVariable($taskName,'Process')}
try {
 $env:CARGO_TARGET_DIR=[IO.Path]::GetFullPath($TargetDir)
 $env:CARGO_PROFILE_TEST_DEBUG='0';$env:CARGO_INCREMENTAL='0'
 $env:TEMP=Join-Path $env:CARGO_TARGET_DIR 'tmp';$env:TMP=$env:TEMP
 New-Item -ItemType Directory -Path $env:TEMP -Force | Out-Null
 # Some inherited tests temporarily change process environment used in host
 # authorization bindings. Serialize the full suite, never skip assertions.
 & cargo test --locked --offline --jobs 1 --manifest-path (Join-Path $taskRoot 'desktop/Cargo.toml') -p ck_core -- --test-threads=1
 if($LASTEXITCODE -ne 0){throw 'ck_core tests failed'}
} finally {foreach($taskName in $taskVars){[Environment]::SetEnvironmentVariable($taskName,$taskSaved[$taskName],'Process')}}
