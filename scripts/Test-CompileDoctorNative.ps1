param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Fqbn = 'esp32:esp32:esp32c5',
    [string]$ProjectName = 'espc5',
    [int]$MaxLockWaitMs = 5000,
    [switch]$SkipWarmup,
    [switch]$ForceCodeChange,
    [ValidateSet('None', 'FirstBuild', 'Rebuild')]
    [string]$ProgressScenario = 'None',
    [ValidateRange(30000, 1800000)]
    [int]$ProgressCompileTimeoutMs = 900000
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$desktop = Join-Path $Root 'apps/desktop'
$targets = @(Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list")
$target = $targets | Where-Object { $_.type -eq 'page' } | Select-Object -First 1
if (-not $target.webSocketDebuggerUrl) {
    throw "No debuggable CK window was found on port $DebugPort. Start 'npm run tauri dev' first."
}

$env:CK_CDP_URL = $target.webSocketDebuggerUrl
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_TEST_FQBN = $Fqbn
$env:CK_TEST_PROJECT = $ProjectName
$env:CK_MAX_LOCK_WAIT_MS = [string]$MaxLockWaitMs
$env:CK_SKIP_WARMUP = if ($SkipWarmup) { '1' } else { '0' }
$env:CK_FORCE_CODE_CHANGE = if ($ForceCodeChange) { '1' } else { '0' }
$env:CK_PROGRESS_SCENARIO = $ProgressScenario
$env:CK_PROGRESS_COMPILE_TIMEOUT_MS = [string]$ProgressCompileTimeoutMs

Push-Location $desktop
try {
    node (Join-Path $PSScriptRoot 'Test-CompileDoctorNative.js')
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
