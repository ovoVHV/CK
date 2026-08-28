param(
    [string]$Root = '',
    [string]$ExecutablePath = '',
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [string]$Fqbn = 'esp32:esp32:esp32c6',
    [ValidateRange(1, 5)]
    [int]$Trials = 5,
    [string]$ExpectedExecutableSha256 = '',
    [ValidateRange(1024, 65535)]
    [int]$DebugPort = 9223,
    [ValidateRange(8, 100)]
    [int]$MinFreeGiB = 8,
    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 15
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$rootPath = [System.IO.Path]::GetFullPath($Root)
if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $executablePath = [System.IO.Path]::GetFullPath(
        (Join-Path $rootPath 'target\release\appsdesktop.exe')
    )
}
else {
    $executablePath = [System.IO.Path]::GetFullPath($ExecutablePath)
}
$runnerPath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'scripts\Run-CKEsp32LibraryEditRegression.cjs')
)
$outputPath = [System.IO.Path]::GetFullPath($Output)
$managedCommandTelemetryPath = "$outputPath.managed-commands.jsonl"
$librariesRoot = Join-Path $rootPath 'sketchbook\libraries'

function Invoke-OwnedFixtureRecovery {
    $recoveryText = (& node $runnerPath --cleanup-owned-fixture | Out-String).Trim()
    if ($LASTEXITCODE -ne 0) {
        throw "Marker-owned ESP32 fixture recovery failed with exit code $LASTEXITCODE."
    }
    $recovery = $recoveryText | ConvertFrom-Json
    if ($recovery.remaining -eq $true) {
        throw 'Marker-owned ESP32 fixture recovery left a remnant.'
    }
}

foreach ($file in @($executablePath, $runnerPath)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required file does not exist: $file"
    }
}
if (Test-Path -LiteralPath $outputPath) {
    throw "Refusing to overwrite report: $outputPath"
}
if (Test-Path -LiteralPath $managedCommandTelemetryPath) {
    throw "Refusing to overwrite managed-command telemetry: $managedCommandTelemetryPath"
}
if ([System.IO.Path]::GetExtension($outputPath) -cne '.json') {
    throw 'ESP32 library-edit evidence output must be a JSON file.'
}
if (-not $Fqbn.StartsWith('esp32:esp32:', [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "Library edit candidate requires an esp32:esp32:* FQBN."
}

$executableSha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedExecutableSha256 -and
    -not $executableSha256.Equals(
        $ExpectedExecutableSha256,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Production executable SHA-256 mismatch: $executableSha256"
}

$listeners = @(Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue)
if ($listeners.Count -ne 0) {
    throw "Debug port $DebugPort is already in use; refusing to attach to an uncontrolled process."
}
if (@(Get-Process -Name appsdesktop, arduino-cli -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'An appsdesktop or Arduino CLI process is already active.'
}
if ((Get-PSDrive C -ErrorAction Stop).Free -lt ($MinFreeGiB * 1GB)) {
    throw "C: has less than $MinFreeGiB GiB free."
}
if (-not (Test-Path -LiteralPath $librariesRoot -PathType Container)) {
    throw "Managed sketchbook libraries root is missing: $librariesRoot"
}
Invoke-OwnedFixtureRecovery

$cdpListUrl = "http://127.0.0.1:$DebugPort/json/list"
$tokenBytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $generator.GetBytes($tokenBytes)
}
finally {
    $generator.Dispose()
}
$qualificationToken = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
$savedQualificationToken = $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN
$savedBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$savedCdpListUrl = $env:CK_CDP_LIST_URL
$savedSourceDateEpoch = $env:SOURCE_DATE_EPOCH
$savedTimeZone = $env:TZ
$savedProcessId = $env:CK_PROCESS_ID
$savedProductionExecutablePath = $env:CK_FORGE_PRODUCTION_EXECUTABLE_PATH
$savedProductionExecutableSha256 = $env:CK_FORGE_PRODUCTION_EXECUTABLE_SHA256
$savedManagedCommandTelemetryPath = $env:CK_FLFE_MANAGED_COMMAND_TELEMETRY_PATH
$candidateProcess = $null
$terminalError = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()

try {
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $qualificationToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:CK_CDP_LIST_URL = $cdpListUrl
    $env:SOURCE_DATE_EPOCH = '1704067200'
    $env:TZ = 'UTC'
    $env:CK_FORGE_PRODUCTION_EXECUTABLE_PATH = $executablePath
    $env:CK_FORGE_PRODUCTION_EXECUTABLE_SHA256 = $executableSha256
    # The Rust child-process sink is qualification-only and writes beside the
    # immutable JSON report.  It is diagnostic evidence; write failures never
    # change the compile route or the performance gate.
    $env:CK_FLFE_MANAGED_COMMAND_TELEMETRY_PATH = $managedCommandTelemetryPath

    $candidateProcess = Start-Process `
        -FilePath $executablePath `
        -WorkingDirectory $rootPath `
        -WindowStyle Hidden `
        -PassThru
    $env:CK_PROCESS_ID = [string]$candidateProcess.Id

    $ready = $false
    # Keep the documented startup bound real: Invoke-RestMethod can consume
    # its whole timeout on every attempt, so an attempt-count loop would turn
    # 60 seconds into several minutes when WebView2 never opens CDP.
    $readyDeadline = [DateTime]::UtcNow.AddSeconds(60)
    while ([DateTime]::UtcNow -lt $readyDeadline) {
        if ($candidateProcess.HasExited) {
            throw "CK candidate exited early with code $($candidateProcess.ExitCode)."
        }
        try {
            $targets = @(Invoke-RestMethod -Uri $cdpListUrl -TimeoutSec 1)
            $pages = @($targets | Where-Object {
                $_.type -eq 'page' -and $_.url -eq 'http://tauri.localhost/'
            })
            if ($pages.Count -eq 1) {
                $ready = $true
                break
            }
        }
        catch {
            # WebView2 is still starting; the bounded loop is the timeout.
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw 'CK candidate CDP page did not become ready within 60 seconds.'
    }

    Write-Output (
        "[ESP32-LIBRARY-EDIT] Candidate ready: pid={0}, exeSha256={1}" -f
        $candidateProcess.Id,
        $executableSha256
    )

    & node $runnerPath `
        --execute `
        --allow-cache-reset `
        --allow-fixture-install `
        --fqbn $Fqbn `
        --trials $Trials `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB `
        --output $outputPath
    if ($LASTEXITCODE -ne 0) {
        throw "ESP32 library edit A/B runner did not qualify; inspect $outputPath."
    }

    Write-Output "[ESP32-LIBRARY-EDIT] Qualified: $outputPath"
    if (Test-Path -LiteralPath $managedCommandTelemetryPath -PathType Leaf) {
        Write-Output "[ESP32-LIBRARY-EDIT] Managed-command telemetry: $managedCommandTelemetryPath"
    }
}
catch {
    $terminalError = $_
}
finally {
    if ($candidateProcess) {
        try {
            $candidateProcess.Refresh()
            if (-not $candidateProcess.HasExited) {
                & taskkill.exe /PID $candidateProcess.Id /T /F 2>$null | Out-Null
            }
        }
        catch {
            $cleanupFailures.Add("owned candidate process-tree cleanup failed: $($_.Exception.Message)")
        }
    }
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $savedQualificationToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $savedBrowserArguments
    $env:CK_CDP_LIST_URL = $savedCdpListUrl
    $env:SOURCE_DATE_EPOCH = $savedSourceDateEpoch
    $env:TZ = $savedTimeZone
    $env:CK_PROCESS_ID = $savedProcessId
    $env:CK_FORGE_PRODUCTION_EXECUTABLE_PATH = $savedProductionExecutablePath
    $env:CK_FORGE_PRODUCTION_EXECUTABLE_SHA256 = $savedProductionExecutableSha256
    $env:CK_FLFE_MANAGED_COMMAND_TELEMETRY_PATH = $savedManagedCommandTelemetryPath
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    $qualificationToken = $null

    try {
        Invoke-OwnedFixtureRecovery
    }
    catch {
        $cleanupFailures.Add("fixture recovery failed: $($_.Exception.Message)")
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
        $cleanupFailures.Add('appsdesktop or Arduino CLI remains active')
    }
    if ((Get-PSDrive C -ErrorAction Stop).Free -lt ($MinFreeGiB * 1GB)) {
        $cleanupFailures.Add("C: fell below $MinFreeGiB GiB free")
    }
}

if ($cleanupFailures.Count -ne 0) {
    $cleanupMessage = $cleanupFailures -join '; '
    if ($terminalError) {
        throw "$($terminalError.Exception.Message); cleanup: $cleanupMessage"
    }
    throw "Candidate cleanup failed: $cleanupMessage"
}
if ($terminalError) {
    throw $terminalError
}
