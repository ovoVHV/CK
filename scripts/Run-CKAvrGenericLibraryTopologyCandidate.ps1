param(
    [Parameter(Mandatory = $true)]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [ValidatePattern('^[0-9a-f]{64}$')]
    [string]$ExpectedExecutableSha256,

    [ValidatePattern('^[a-z0-9][a-z0-9_-]*$')]
    [string]$Target = 'uno',

    [ValidateRange(1, 5)]
    [int]$Trials = 1,

    [ValidateRange(1024, 65535)]
    [int]$DebugPort = 9223,

    [ValidateRange(8, 100)]
    [int]$MinFreeGiB = 12,

    [ValidateRange(0, 60)]
    [int]$StartupQuietDelaySeconds = 10,

    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$executable = Join-Path $root 'target\release\appsdesktop.exe'
$runner = Join-Path $root 'scripts\Run-CKAvrGenericLibraryTopologyRegression.cjs'
$fixtureTool = Join-Path $root 'scripts\CKAvrGenericLibraryTopologyFixtures.cjs'
$librariesRoot = Join-Path $root 'sketchbook\libraries'
$outputPath = [System.IO.Path]::GetFullPath($Output)
$artifactsRoot = [System.IO.Path]::GetFullPath((Join-Path $root 'artifacts\benchmarks'))
$fixtureNames = @('CKTopoA17', 'CKTopoB29', 'CKTopoC43', 'CKTopoD61')

function Get-FixtureRemnants {
    return @($fixtureNames | Where-Object {
        Test-Path -LiteralPath (Join-Path $librariesRoot $_)
    })
}

function Invoke-OwnedFixtureRecovery {
    $before = @(Get-FixtureRemnants)
    if ($before.Count -eq 0) {
        return
    }
    $recoveryText = (& node $fixtureTool --cleanup-owned $librariesRoot | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Marker-owned fixture recovery failed with exit code $LASTEXITCODE."
    }
    $recovery = $recoveryText | ConvertFrom-Json
    if ($recovery.recovered -ne $true -or @($recovery.remaining).Count -ne 0) {
        throw 'Marker-owned fixture recovery did not remove every owned directory.'
    }
}

if (-not $outputPath.StartsWith(
        $artifactsRoot + [System.IO.Path]::DirectorySeparatorChar,
        [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Generic-topology output must stay below $artifactsRoot."
}
if ([System.IO.Path]::GetExtension($outputPath) -cne '.json') {
    throw 'Generic-topology output must be a JSON file.'
}
if (Test-Path -LiteralPath $outputPath) {
    throw "Refusing to overwrite generic-topology evidence: $outputPath"
}
foreach ($file in @($executable, $runner, $fixtureTool)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required candidate input is missing: $file"
    }
}
if (-not (Test-Path -LiteralPath $librariesRoot -PathType Container)) {
    throw "Managed sketchbook libraries root is missing: $librariesRoot"
}
$actualExecutableSha = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($actualExecutableSha -cne $ExpectedExecutableSha256) {
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

# A previous interrupted instance may leave only marker-owned deterministic
# fixtures. Recover those before enforcing the no-clobber precondition. Any
# unmarked or altered fixed-name directory makes recovery fail closed.
Invoke-OwnedFixtureRecovery
if (@(Get-FixtureRemnants).Count -ne 0) {
    throw 'Generic-topology fixture destinations are not clean before launch.'
}

$saved = @{
    CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    CK_CDP_LIST_URL = $env:CK_CDP_LIST_URL
    CK_PROCESS_ID = $env:CK_PROCESS_ID
    CK_RESPECT_MAX_JOBS = $env:CK_RESPECT_MAX_JOBS
}
$app = $null
$terminalError = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()

try {
    # This is a normal production-route regression, not a hidden qualification
    # probe. The owned app process must not inherit a qualification token.
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
        throw 'Production tauri.localhost CDP page was not ready in 60 seconds.'
    }

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
        --allow-fixture-install `
        --target $Target `
        --trials $Trials `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB `
        --output $outputPath
    $runnerExit = $LASTEXITCODE
    if ($runnerExit -ne 0) {
        throw "Generic-topology runner failed with exit code $runnerExit."
    }
    if (-not (Test-Path -LiteralPath $outputPath -PathType Leaf)) {
        throw 'Generic-topology runner did not leave its no-clobber report.'
    }
    $report = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    if ($report.status -cne 'passed' `
            -or $report.fixtureLifecycle.cleaned -ne $true `
            -or @($report.failures).Count -ne 0) {
        throw 'Generic-topology report did not pass its route/equivalence/cleanup gates.'
    }
    if ($report.productionExecutable.before.executableSha256 -cne $ExpectedExecutableSha256 `
            -or $report.productionExecutable.unchanged -ne $true) {
        throw 'Generic-topology report is not bound to the expected unchanged EXE.'
    }
} catch {
    $terminalError = $_
} finally {
    if ($app) {
        try {
            $app.Refresh()
            if (-not $app.HasExited) {
                & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null
            }
        } catch {
            $cleanupFailures.Add("owned app process tree cleanup failed: $($_.Exception.Message)")
        }
    }
    try {
        Get-Process -Name appsdesktop, arduino-cli -ErrorAction SilentlyContinue |
            Stop-Process -Force -ErrorAction Stop
    } catch {
        $cleanupFailures.Add("owned residual process cleanup failed: $($_.Exception.Message)")
    }

    try {
        Invoke-OwnedFixtureRecovery
        $remaining = @(Get-FixtureRemnants)
        if ($remaining.Count -ne 0) {
            throw "fixture remnants remain: $($remaining -join ', ')"
        }
    } catch {
        $cleanupFailures.Add("fixture cleanup failed closed: $($_.Exception.Message)")
    }

    foreach ($name in $saved.Keys) {
        [System.Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
    }

    $portReleased = $false
    for ($attempt = 0; $attempt -lt 40; $attempt++) {
        if (@(Get-NetTCPConnection -LocalPort $DebugPort -State Listen `
                    -ErrorAction SilentlyContinue).Count -eq 0) {
            $portReleased = $true
            break
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $portReleased) {
        $cleanupFailures.Add("debug port $DebugPort remains occupied")
    }
    if (@(Get-Process -Name appsdesktop, arduino-cli -ErrorAction SilentlyContinue).Count -ne 0) {
        $cleanupFailures.Add('appsdesktop or arduino-cli remains active')
    }
    if ((Get-PSDrive C).Free -lt ($MinFreeGiB * 1GB)) {
        $cleanupFailures.Add("C: fell below $MinFreeGiB GiB free")
    }
}

if ($cleanupFailures.Count -ne 0) {
    $message = $cleanupFailures -join '; '
    if ($terminalError) {
        throw "$($terminalError.Exception.Message); cleanup: $message"
    }
    throw "Candidate cleanup failed: $message"
}
if ($terminalError) {
    throw $terminalError
}

Write-Output "GENERIC-TOPOLOGY-VERIFIED $outputPath"
