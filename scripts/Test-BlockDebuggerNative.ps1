param(
    [int]$DebugPort = 9223,
    [string]$Fqbn = 'esp32:esp32:esp32s3'
)

$ErrorActionPreference = 'Stop'
$targets = @(Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list")
$target = $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
if (-not $target) {
    throw "No native Tauri CDP page found on port $DebugPort."
}

$env:CK_CDP_URL = $target.webSocketDebuggerUrl
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_TEST_FQBN = $Fqbn
node (Join-Path $PSScriptRoot 'Test-BlockDebuggerNative.mjs')
if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
