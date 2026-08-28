param(
    [Parameter(Mandatory = $true)]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedExecutableSha256,

    [ValidateRange(1024, 65535)]
    [int]$DebugPort = 9223,

    [ValidateRange(1, 100)]
    [int]$MinFreeGiB = 12,

    [ValidateRange(0, 60)]
    [int]$StartupQuietDelaySeconds = 18,

    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$executable = Join-Path $root 'target\release\appsdesktop.exe'
$runner = Join-Path $root 'scripts\Run-CKAvrRegressionMatrix.cjs'
$verifier = Join-Path $root 'scripts\Verify-CKAvrRegressionMatrix.cjs'
$outputPath = [System.IO.Path]::GetFullPath($Output)
$artifactsRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'artifacts\benchmarks'))

if (-not $outputPath.StartsWith($artifactsRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Matrix output must stay below $artifactsRoot."
}
if ([System.IO.Path]::GetExtension($outputPath) -cne '.json') {
    throw 'Matrix output must be a JSON file.'
}
if (Test-Path -LiteralPath $outputPath) {
    throw "Refusing to overwrite matrix evidence: $outputPath"
}
if (-not (Test-Path -LiteralPath $executable -PathType Leaf)) {
    throw "Production executable is missing: $executable"
}
if ((Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant() `
        -cne $ExpectedExecutableSha256) {
    throw 'Production executable SHA-256 does not match the expected candidate.'
}
if (@(Get-Process -Name appsdesktop, arduino-cli -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'A desktop or Arduino CLI process is already active.'
}
if (@(Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "Debug port $DebugPort is already occupied."
}
if ((Get-PSDrive C).Free -lt ($MinFreeGiB * 1GB)) {
    throw "C: has less than $MinFreeGiB GiB free."
}

$saved = @{
    CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    CK_CDP_LIST_URL = $env:CK_CDP_LIST_URL
    CK_PROCESS_ID = $env:CK_PROCESS_ID
    CK_RESPECT_MAX_JOBS = $env:CK_RESPECT_MAX_JOBS
}
$app = $null

try {
    [System.Environment]::SetEnvironmentVariable(
        'CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN', $null, 'Process')
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:CK_CDP_LIST_URL = "http://127.0.0.1:$DebugPort/json/list"
    $env:CK_RESPECT_MAX_JOBS = '1'

    $app = Start-Process -FilePath $executable -WorkingDirectory $root `
        -WindowStyle Hidden -PassThru
    $env:CK_PROCESS_ID = [string]$app.Id

    $ready = $false
    for ($attempt = 0; $attempt -lt 240; $attempt++) {
        $app.Refresh()
        if ($app.HasExited) {
            throw "Production app exited before CDP readiness: $($app.ExitCode)"
        }
        try {
            $pages = @(
                Invoke-RestMethod -Uri $env:CK_CDP_LIST_URL -TimeoutSec 2 |
                    Where-Object { $_.type -eq 'page' -and $_.url -eq 'http://tauri.localhost/' }
            )
            if ($pages.Count -eq 1) {
                $ready = $true
                break
            }
        } catch {}
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw 'Production CDP page was not ready in 60 seconds.'
    }

    # The normal UI performs read-only `board listall/details` metadata work
    # roughly 15 seconds after startup. Keep it outside benchmark time, then
    # require a complete two-second zero-process window before starting Node.
    if ($StartupQuietDelaySeconds -gt 0) {
        Start-Sleep -Seconds $StartupQuietDelaySeconds
    }
    $idleSince = $null
    $idleDeadline = (Get-Date).AddSeconds(60)
    while ($true) {
        $count = @(Get-CimInstance Win32_Process `
            -Filter "Name = 'arduino-cli.exe'" -ErrorAction Stop).Count
        $now = Get-Date
        if ($count -eq 0) {
            if ($null -eq $idleSince) {
                $idleSince = $now
            }
            if (($now - $idleSince).TotalMilliseconds -ge 2000) {
                break
            }
        } else {
            $idleSince = $null
        }
        if ($now -ge $idleDeadline) {
            throw 'Startup Arduino CLI metadata work did not settle in 60 seconds.'
        }
        Start-Sleep -Milliseconds 200
    }

    & node $runner `
        --execute `
        --allow-cache-reset `
        --target all `
        --workload all `
        --trials 1 `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB `
        --output $outputPath
    $matrixExit = $LASTEXITCODE
    if ($matrixExit -ne 0) {
        throw "Full AVR matrix failed with exit code $matrixExit."
    }
    & node $verifier `
        --input $outputPath `
        --expected-executable $executable
    $verificationExit = $LASTEXITCODE
    if ($verificationExit -ne 0) {
        throw "Independent AVR matrix verification failed with exit code $verificationExit."
    }
    Write-Output "MATRIX-VERIFIED $outputPath"
    Write-Output "MATRIX-COMPLETE $outputPath"
} finally {
    if ($app -and -not $app.HasExited) {
        Stop-Process -Id $app.Id -Force -ErrorAction SilentlyContinue
        $app.WaitForExit(5000) | Out-Null
    }
    foreach ($name in $saved.Keys) {
        [System.Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }
}
