param(
    [string]$Root = '',
    [Parameter(Mandatory = $true)]
    [string]$Output,
    [string]$Fqbn = 'esp32:esp32:esp32c6',
    [ValidateRange(5, 25)]
    [int]$Trials = 5,
    [string]$ExpectedExecutableSha256 = '',
    [int]$DebugPort = 9223,
    [ValidateRange(8, 100)]
    [int]$MinFreeGiB = 8,
    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 15,
    [switch]$Certify,
    [string]$QualificationRoot = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$rootPath = [System.IO.Path]::GetFullPath($Root)
$executablePath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'target\release\appsdesktop.exe')
)
$runnerPath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'scripts\Run-CKForgeNativeAB.cjs')
)
$evaluatorPath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'scripts\Evaluate-CKForgePerformanceGate.cjs')
)
$outputPath = [System.IO.Path]::GetFullPath($Output)
if ([string]::IsNullOrWhiteSpace($QualificationRoot)) {
    $QualificationRoot = Join-Path $rootPath 'state\qualifications'
}
$qualificationRootPath = [System.IO.Path]::GetFullPath($QualificationRoot)

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Production executable does not exist: $executablePath"
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Native A/B runner does not exist: $runnerPath"
}

$executableSha256 = (Get-FileHash -LiteralPath $executablePath -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedExecutableSha256 -and
    -not $executableSha256.Equals(
        $ExpectedExecutableSha256,
        [System.StringComparison]::OrdinalIgnoreCase
    )) {
    throw "Production executable SHA-256 mismatch: $executableSha256"
}

$tokenBytes = New-Object byte[] 32
$generator = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $generator.GetBytes($tokenBytes)
}
finally {
    $generator.Dispose()
}
$qualificationToken = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
$cdpListUrl = "http://127.0.0.1:$DebugPort/json/list"

$savedToken = $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN
$savedBrowserArguments = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
$savedCdpListUrl = $env:CK_CDP_LIST_URL
$savedSourceDateEpoch = $env:SOURCE_DATE_EPOCH
$savedTimeZone = $env:TZ
$qualificationProcess = $null

try {
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $qualificationToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:CK_CDP_LIST_URL = $cdpListUrl
    # ESP32 application images embed esp_app_desc compile date/time strings.
    # Both lanes must build under the same frozen reproducibility environment
    # or byte-level application equivalence can never hold.
    $env:SOURCE_DATE_EPOCH = [string][int64]1704067200
    $env:TZ = 'UTC'

    $qualificationProcess = Start-Process `
        -FilePath $executablePath `
        -WindowStyle Hidden `
        -PassThru

    $ready = $false
    for ($attempt = 0; $attempt -lt 240; $attempt++) {
        if ($qualificationProcess.HasExited) {
            throw "Qualification CK process exited early with code $($qualificationProcess.ExitCode)."
        }
        try {
            $targets = @(Invoke-RestMethod -Uri $cdpListUrl -TimeoutSec 2)
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
        throw 'Qualification CK CDP page did not become ready within 60 seconds.'
    }

    Write-Output (
        "[ESP32-RELINK] Candidate ready: pid={0}, exeSha256={1}" -f
        $qualificationProcess.Id,
        $executableSha256
    )

    & node $runnerPath `
        --execute `
        --allow-cache-reset `
        --fqbn $Fqbn `
        --sequence portable-edit `
        --trials $Trials `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB `
        --require-ck-mode native-relink-compile-only `
        --output $outputPath
    $runnerExit = $LASTEXITCODE
    if ($runnerExit -ne 0) {
        throw "ESP32 NativeRelink A/B runner failed with exit code $runnerExit."
    }

    if ($Certify) {
        & node $evaluatorPath `
            --certify-native-relink `
            --input $outputPath `
            --qualification-root $qualificationRootPath
        $certifyExit = $LASTEXITCODE
        if ($certifyExit -ne 0) {
            throw "ESP32 NativeRelink certification failed with exit code $certifyExit."
        }
    }

    Write-Output "[ESP32-RELINK] Completed: $outputPath"
}
finally {
    if ($qualificationProcess -and -not $qualificationProcess.HasExited) {
        Stop-Process -Id $qualificationProcess.Id -Force -ErrorAction SilentlyContinue
        $qualificationProcess.WaitForExit(5000) | Out-Null
    }
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $savedToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $savedBrowserArguments
    $env:CK_CDP_LIST_URL = $savedCdpListUrl
    $env:SOURCE_DATE_EPOCH = $savedSourceDateEpoch
    $env:TZ = $savedTimeZone
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    $qualificationToken = $null
}
