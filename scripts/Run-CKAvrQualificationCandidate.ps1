param(
    [string]$Root = '',
    [Parameter(Mandatory = $true)]
    [string]$StateRoot,
    [string]$ExpectedExecutableSha256 = '',
    [int]$DebugPort = 9223,
    [ValidateRange(8, 100)]
    [int]$MinFreeGiB = 12,
    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 10
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

function Get-LowerSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
}

function Assert-BatchTargetCompleted {
    param(
        [Parameter(Mandatory = $true)][string]$StateDirectory,
        [Parameter(Mandatory = $true)][string]$TargetId
    )
    $summaryDirectory = Join-Path $StateDirectory 'summaries'
    $summaryFile = Get-ChildItem -LiteralPath $summaryDirectory -Filter 'summary-*.json' -File |
        Sort-Object Name |
        Select-Object -Last 1
    if (-not $summaryFile) { throw "Qualification batch produced no summary for $TargetId." }
    $summary = Get-Content -LiteralPath $summaryFile.FullName -Raw | ConvertFrom-Json
    $target = @($summary.targets | Where-Object { $_.id -eq $TargetId }) | Select-Object -First 1
    if (-not $target -or $target.qualification -ne 'passed' -or $target.coverage -ne 'passed') {
        throw "Qualification target $TargetId is not complete in $($summaryFile.Name)."
    }
    return $target
}

function Assert-BatchHasNoFailedTargets {
    param([Parameter(Mandatory = $true)][string]$StateDirectory)
    $summaryDirectory = Join-Path $StateDirectory 'summaries'
    $summaryFile = Get-ChildItem -LiteralPath $summaryDirectory -Filter 'summary-*.json' -File |
        Sort-Object Name |
        Select-Object -Last 1
    if (-not $summaryFile) { throw 'Qualification batch produced no final summary.' }
    $summary = Get-Content -LiteralPath $summaryFile.FullName -Raw | ConvertFrom-Json
    if ([int]$summary.failedCount -ne 0) {
        throw "Qualification batch has $($summary.failedCount) failed target(s) in $($summaryFile.Name)."
    }
    return $summary
}

$rootPath = [System.IO.Path]::GetFullPath($Root)
$executablePath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'target\release\appsdesktop.exe')
)
$statePath = [System.IO.Path]::GetFullPath($StateRoot)
$qualificationRoot = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'state\qualifications')
)
$runnerPath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'scripts\Run-CKAvrFullQualificationBatch.cjs')
)
$verifierPath = [System.IO.Path]::GetFullPath(
    (Join-Path $rootPath 'scripts\Verify-CKAvrFullQualificationBatch.cjs')
)

if (-not (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    throw "Production executable does not exist: $executablePath"
}
if (-not (Test-Path -LiteralPath $runnerPath -PathType Leaf)) {
    throw "Qualification runner does not exist: $runnerPath"
}
if (-not (Test-Path -LiteralPath $verifierPath -PathType Leaf)) {
    throw "Qualification verifier does not exist: $verifierPath"
}
if ($statePath.Equals($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -or
    $statePath.Equals($qualificationRoot, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'StateRoot must be a dedicated resumable evidence directory.'
}

$executableSha256 = Get-LowerSha256 -Path $executablePath
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
$qualificationProcess = $null

try {
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $qualificationToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:CK_CDP_LIST_URL = $cdpListUrl

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
            # WebView2 is still starting. The bounded loop below remains the timeout.
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw 'Qualification CK CDP page did not become ready within 60 seconds.'
    }

    Write-Output (
        "[QUAL] Candidate ready: pid={0}, exeSha256={1}, state={2}" -f
        $qualificationProcess.Id,
        $executableSha256,
        $statePath
    )

    & node $runnerPath `
        --execute `
        --state-root $statePath `
        --allow-cache-reset `
        --retry-failed `
        --max-targets 1 `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB
    $foreguardExit = $LASTEXITCODE
    # This deliberately bounded foreguard leaves 37 targets pending, so the
    # batch returns 2 even after Yun itself is complete. Accept only 0/2 here,
    # then prove the exact foreguard row from the immutable summary.
    if ($foreguardExit -notin @(0, 2)) {
        throw "Qualification foreguard target failed with exit code $foreguardExit."
    }
    Assert-BatchTargetCompleted -StateDirectory $statePath -TargetId 'yun' | Out-Null

    Write-Output '[QUAL] Foreguard target passed; continuing all remaining targets.'
    & node $runnerPath `
        --execute `
        --state-root $statePath `
        --allow-cache-reset `
        --retry-failed `
        --all-remaining `
        --continue-on-failure `
        --timeout-minutes $TimeoutMinutes `
        --min-free-gib $MinFreeGiB
    $batchExit = $LASTEXITCODE
    # --all-remaining is the terminal run. Exit 2 means the journal is still
    # incomplete and must never be promoted merely because failedCount is 0.
    if ($batchExit -ne 0) {
        throw "Qualification batch failed with exit code $batchExit."
    }
    Assert-BatchHasNoFailedTargets -StateDirectory $statePath | Out-Null

    # Re-read every immutable input through a separate, read-only verifier.
    # The verifier hard-requires all 38 exact FQBN rows and replays certificate,
    # runner, production-EXE, coverage-plan, route and artifact-equivalence
    # bindings. It creates no summary, certificate or directory.
    & node $verifierPath `
        --state-root $statePath `
        --expected-executable $executablePath `
        --qualification-root $qualificationRoot
    $verificationExit = $LASTEXITCODE
    if ($verificationExit -ne 0) {
        throw "Independent read-only qualification verification failed with exit code $verificationExit."
    }

    Write-Output "[QUAL] All AVR targets completed: $statePath"
}
finally {
    if ($qualificationProcess -and -not $qualificationProcess.HasExited) {
        Stop-Process -Id $qualificationProcess.Id -Force -ErrorAction SilentlyContinue
        $qualificationProcess.WaitForExit(5000) | Out-Null
    }
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $savedToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $savedBrowserArguments
    $env:CK_CDP_LIST_URL = $savedCdpListUrl
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    $qualificationToken = $null
}
