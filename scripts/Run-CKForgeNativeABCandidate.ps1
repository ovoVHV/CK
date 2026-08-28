param(
    [Parameter(Mandatory = $true)]
    [string]$Output,

    [Parameter(Mandatory = $true)]
    [string]$CandidateOutput,

    [Alias('CandidateArtifactBundle')]
    [string]$ArtifactBundle = '',

    [string]$FailureLogDirectory = '',

    [string]$Fqbn = 'esp32:esp32:esp32c6',

    [ValidateRange(5, 25)]
    [int]$Trials = 5,

    [ValidateSet('compile', 'upload-ready')]
    [string]$Operation = 'compile',

    [ValidateSet('portable-fast', 'quick-fast', 'shared-fast')]
    [string]$Profile = 'quick-fast',

    [ValidateRange(1, 100)]
    [int]$MinFreeGiB = 8,

    [ValidateRange(1, 60)]
    [int]$TimeoutMinutes = 20,

    [ValidatePattern('^(?:[0-9a-fA-F]{64})?$')]
    [string]$ExpectedProductionExecutableSha256 = '',

    [ValidateRange(1024, 65535)]
    [int]$DebugPort = 9223
)

$ErrorActionPreference = 'Stop'
$reproducibilityPolicyId = 'source-date-epoch-utc-v1'
$sourceDateEpoch = [int64]1704067200
$timeZone = 'UTC'

$root = (Resolve-Path -LiteralPath (Join-Path $PSScriptRoot '..')).Path
$executable = Join-Path $root 'target\release\appsdesktop.exe'
$runner = Join-Path $root 'scripts\Run-CKForgeNativeAB.cjs'
$outputPath = [System.IO.Path]::GetFullPath($Output)
$candidateOutputPath = [System.IO.Path]::GetFullPath($CandidateOutput)
$artifactBundlePath = if ([string]::IsNullOrWhiteSpace($ArtifactBundle)) {
    $null
} else {
    [System.IO.Path]::GetFullPath($ArtifactBundle)
}
$failureLogDirectoryPath = if ([string]::IsNullOrWhiteSpace($FailureLogDirectory)) {
    Join-Path ([System.IO.Path]::GetDirectoryName($outputPath)) `
        (([System.IO.Path]::GetFileNameWithoutExtension($outputPath)) + '-failure-logs')
} else {
    [System.IO.Path]::GetFullPath($FailureLogDirectory)
}

function Test-PathWithinText {
    param(
        [Parameter(Mandatory = $true)][string]$Candidate,
        [Parameter(Mandatory = $true)][string]$Parent
    )
    $separator = [string][System.IO.Path]::DirectorySeparatorChar
    $alternate = [string][System.IO.Path]::AltDirectorySeparatorChar
    $candidatePath = [System.IO.Path]::GetFullPath($Candidate).Replace($alternate, $separator)
    $parentPath = [System.IO.Path]::GetFullPath($Parent).Replace($alternate, $separator)
    if ($candidatePath.Equals($parentPath, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    if (-not $parentPath.EndsWith($separator, [System.StringComparison]::Ordinal)) {
        $parentPath += $separator
    }
    return $candidatePath.StartsWith($parentPath, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-OwnedProcessIds {
    param([Parameter(Mandatory = $true)][int]$RootProcessId)

    $allProcesses = @(Get-CimInstance Win32_Process -ErrorAction Stop)
    $owned = [System.Collections.Generic.HashSet[int]]::new()
    $pending = [System.Collections.Generic.Queue[int]]::new()
    [void]$owned.Add($RootProcessId)
    $pending.Enqueue($RootProcessId)
    while ($pending.Count -gt 0) {
        $parentId = $pending.Dequeue()
        foreach ($process in $allProcesses) {
            $childId = [int]$process.ProcessId
            if ([int]$process.ParentProcessId -eq $parentId -and $owned.Add($childId)) {
                $pending.Enqueue($childId)
            }
        }
    }
    return @($owned)
}

function Test-ProcessExists {
    param([Parameter(Mandatory = $true)][int]$ProcessId)
    return $null -ne (Get-Process -Id $ProcessId -ErrorAction SilentlyContinue)
}

function Assert-ArtifactBundle {
    param([Parameter(Mandatory = $true)][string]$BundlePath)

    if (-not (Test-Path -LiteralPath $BundlePath -PathType Container)) {
        throw 'Native A/B runner did not leave its no-clobber artifact bundle.'
    }
    $bundleFile = Join-Path $BundlePath 'bundle.json'
    $manifestFile = Join-Path $BundlePath 'artifact-manifest.json'
    foreach ($file in @($bundleFile, $manifestFile)) {
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "Artifact bundle is missing required metadata: $file"
        }
    }
    $bundle = Get-Content -LiteralPath $bundleFile -Raw | ConvertFrom-Json
    $manifest = Get-Content -LiteralPath $manifestFile -Raw | ConvertFrom-Json
    if ($bundle.schemaId -cne 'ck.forge.performance-artifact-bundle' -or
        [int]$bundle.schemaVersion -ne 1 -or
        $manifest.schemaId -cne 'ck.forge.qualification-artifact-set' -or
        [int]$manifest.schemaVersion -ne 1) {
        throw 'Artifact bundle metadata has an unsupported schema identity.'
    }
    $candidateSha = (Get-FileHash -LiteralPath $candidateOutputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $reportSha = (Get-FileHash -LiteralPath $outputPath -Algorithm SHA256).Hash.ToLowerInvariant()
    $manifestSha = (Get-FileHash -LiteralPath $manifestFile -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($bundle.candidateSha256 -cne $candidateSha -or
        $bundle.captureReportSha256 -cne $reportSha -or
        $bundle.artifactManifestSha256 -cne $manifestSha) {
        throw 'Artifact bundle is not hash-bound to the candidate, report, and manifest.'
    }
    $entries = @($manifest.artifacts)
    if ($entries.Count -eq 0 -or $entries.Count -gt 64) {
        throw 'Artifact bundle contains no bounded representative artifact set.'
    }
    foreach ($entry in $entries) {
        $relative = [string]$entry.path
        if ([string]::IsNullOrWhiteSpace($relative) -or
            [System.IO.Path]::IsPathRooted($relative) -or
            $relative -match '(^|[\\/])\.\.([\\/]|$)') {
            throw 'Artifact bundle manifest contains an unsafe relative path.'
        }
        $artifactPath = [System.IO.Path]::GetFullPath((Join-Path $BundlePath $relative))
        if (-not (Test-PathWithinText -Candidate $artifactPath -Parent $BundlePath) -or
            -not (Test-Path -LiteralPath $artifactPath -PathType Leaf)) {
            throw "Artifact bundle entry is missing or escaped its root: $relative"
        }
        $item = Get-Item -LiteralPath $artifactPath -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0 -or
            [int64]$item.Length -ne [int64]$entry.size -or
            (Get-FileHash -LiteralPath $artifactPath -Algorithm SHA256).Hash.ToLowerInvariant() -cne
                [string]$entry.sha256) {
            throw "Artifact bundle entry failed size/hash validation: $relative"
        }
    }
}

if ([System.IO.Path]::GetExtension($outputPath) -ine '.json' -or
    [System.IO.Path]::GetExtension($candidateOutputPath) -ine '.json') {
    throw 'Output and CandidateOutput must both use the .json extension.'
}
if ($outputPath.Equals($candidateOutputPath, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'Output and CandidateOutput must be different no-clobber files.'
}
foreach ($path in @($outputPath, $candidateOutputPath, $artifactBundlePath, $failureLogDirectoryPath)) {
    if ($path -and (Test-Path -LiteralPath $path)) {
        throw "Refusing to overwrite Native A/B evidence: $path"
    }
}
if ($artifactBundlePath -and (
        $artifactBundlePath.Equals($outputPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        $artifactBundlePath.Equals($candidateOutputPath, [System.StringComparison]::OrdinalIgnoreCase) -or
        (Test-PathWithinText -Candidate $outputPath -Parent $artifactBundlePath) -or
        (Test-PathWithinText -Candidate $candidateOutputPath -Parent $artifactBundlePath))) {
    throw 'ArtifactBundle must be separate from both JSON evidence paths.'
}
foreach ($path in @($outputPath, $candidateOutputPath, $artifactBundlePath)) {
    if ($path -and (
            (Test-PathWithinText -Candidate $path -Parent $failureLogDirectoryPath) -or
            (Test-PathWithinText -Candidate $failureLogDirectoryPath -Parent $path))) {
        throw 'FailureLogDirectory must be separate from JSON evidence and ArtifactBundle paths.'
    }
}
if ([string]::IsNullOrWhiteSpace($Fqbn) -or $Fqbn.Split(':').Count -lt 3) {
    throw 'Fqbn must be a complete Arduino FQBN.'
}
if ($Operation -eq 'compile' -and $Profile -notin @('portable-fast', 'quick-fast')) {
    throw 'The compile operation can probe only the portable-fast or quick-fast profile.'
}
if ($Operation -eq 'upload-ready' -and $Profile -eq 'portable-fast') {
    throw 'The portable-fast profile is compile-only and cannot probe upload-ready.'
}
foreach ($file in @($executable, $runner)) {
    if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
        throw "Required Native A/B input is missing: $file"
    }
}
$executableSha256 = (Get-FileHash -LiteralPath $executable -Algorithm SHA256).Hash.ToLowerInvariant()
if ($ExpectedProductionExecutableSha256 -and
    $executableSha256 -cne $ExpectedProductionExecutableSha256.ToLowerInvariant()) {
    throw "Production executable SHA-256 mismatch: $executableSha256"
}
if (@(Get-Process -Name appsdesktop, arduino-cli -ErrorAction SilentlyContinue).Count -ne 0) {
    throw 'An appsdesktop or arduino-cli process is already active.'
}
if (@(Get-NetTCPConnection -LocalPort $DebugPort -State Listen -ErrorAction SilentlyContinue).Count -ne 0) {
    throw "CDP debug port $DebugPort is already occupied."
}
$existingCdp = @(Get-CimInstance Win32_Process -Filter "Name = 'msedgewebview2.exe'" -ErrorAction Stop |
    Where-Object { [string]$_.CommandLine -match '--remote-debugging-port(?:=|\s)' })
if ($existingCdp.Count -ne 0) {
    throw 'A WebView2 CDP process is already active.'
}
if ((Get-PSDrive C -ErrorAction Stop).Free -lt ($MinFreeGiB * 1GB)) {
    throw "C: has less than $MinFreeGiB GiB free."
}

$tokenBytes = New-Object byte[] 32
$random = [System.Security.Cryptography.RandomNumberGenerator]::Create()
try {
    $random.GetBytes($tokenBytes)
} finally {
    $random.Dispose()
}
$qualificationToken = ([BitConverter]::ToString($tokenBytes)).Replace('-', '').ToLowerInvariant()
$saved = @{
    CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN
    WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS
    CK_CDP_LIST_URL = $env:CK_CDP_LIST_URL
    CK_PROCESS_ID = $env:CK_PROCESS_ID
    CK_RESPECT_MAX_JOBS = $env:CK_RESPECT_MAX_JOBS
    SOURCE_DATE_EPOCH = $env:SOURCE_DATE_EPOCH
    TZ = $env:TZ
}
$app = $null
$ownedProcessIds = [System.Collections.Generic.HashSet[int]]::new()
$terminalError = $null
$terminalExit = 0
$completionMessage = $null
$cleanupFailures = [System.Collections.Generic.List[string]]::new()

try {
    $env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $qualificationToken
    $env:WEBVIEW2_ADDITIONAL_BROWSER_ARGUMENTS = "--remote-debugging-port=$DebugPort"
    $env:CK_CDP_LIST_URL = "http://127.0.0.1:$DebugPort/json/list"
    $env:CK_RESPECT_MAX_JOBS = '1'
    $env:SOURCE_DATE_EPOCH = $sourceDateEpoch
    $env:TZ = $timeZone

    $app = Start-Process -FilePath $executable -WorkingDirectory $root `
        -WindowStyle Hidden -PassThru
    [void]$ownedProcessIds.Add([int]$app.Id)
    $env:CK_PROCESS_ID = [string]$app.Id

    $ready = $false
    for ($attempt = 0; $attempt -lt 240; $attempt++) {
        $app.Refresh()
        if ($app.HasExited) {
            throw "Production app exited before CDP readiness: $($app.ExitCode)"
        }
        try {
            $targets = @(Invoke-RestMethod -Uri $env:CK_CDP_LIST_URL -TimeoutSec 2)
            $pages = @($targets | Where-Object {
                $_.type -eq 'page' -and $_.url -eq 'http://tauri.localhost/'
            })
            if ($pages.Count -gt 1) {
                throw 'More than one tauri.localhost CDP page is active.'
            }
            if ($pages.Count -eq 1) {
                $ready = $true
                break
            }
        } catch {
            if ($_.Exception.Message -eq 'More than one tauri.localhost CDP page is active.') {
                throw
            }
        }
        Start-Sleep -Milliseconds 250
    }
    if (-not $ready) {
        throw 'Exactly one production tauri.localhost CDP page was not ready in 60 seconds.'
    }

    $runnerArguments = @(
        $runner,
        '--execute',
        '--allow-cache-reset',
        '--sequence', 'portable-edit',
        '--fqbn', $Fqbn,
        '--trials', [string]$Trials,
        '--qualification-operation', $Operation,
        '--qualification-profile', $Profile,
        '--timeout-minutes', [string]$TimeoutMinutes,
        '--min-free-gib', [string]$MinFreeGiB,
        '--output', $outputPath,
        '--candidate-output', $candidateOutputPath,
        '--failure-log-dir', $failureLogDirectoryPath
    )
    if ($artifactBundlePath) {
        $runnerArguments += @('--candidate-artifact-bundle', $artifactBundlePath)
    }
    & node @runnerArguments
    $runnerExit = $LASTEXITCODE
    if ($runnerExit -notin @(0, 2)) {
        throw "Native A/B runner failed with exit code $runnerExit."
    }

    foreach ($path in @($outputPath, $candidateOutputPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "Native A/B runner exit $runnerExit did not leave required evidence: $path"
        }
    }
    $report = Get-Content -LiteralPath $outputPath -Raw | ConvertFrom-Json
    $candidate = Get-Content -LiteralPath $candidateOutputPath -Raw | ConvertFrom-Json
    if ($report.schemaId -cne 'ck.forge.native-ab-run' -or
        $report.measurementStatus -cne 'passed' -or
        $report.status -cne 'passed' -or
        $report.productionExecutable.unchanged -ne $true -or
        $report.productionExecutable.before.executableSha256 -cne $executableSha256 -or
        $report.productionExecutable.after.executableSha256 -cne $executableSha256) {
        throw 'Native A/B report failed its measurement or production-EXE binding checks.'
    }
    $reproducibility = $report.controls.reproducibleBuildEnvironment
    if ($reproducibility.policyId -cne $reproducibilityPolicyId -or
        $reproducibility.sourceDateEpoch -cne $sourceDateEpoch -or
        $reproducibility.timeZone -cne $timeZone -or
        $reproducibility.passed -ne $true) {
        throw 'Native A/B report is missing the fixed reproducible-build environment binding.'
    }
    if ($candidate.schemaId -cne 'ck.forge.performance-ab-candidate' -or
        [int]$candidate.schemaVersion -ne 4 -or
        $candidate.operation -cne $Operation -or
        $candidate.candidateProfile -cne $Profile -or
        $candidate.measurementSequence -cne 'portable-edit' -or
        $candidate.lanes.ck.identity.fqbn -cne $report.identity.fqbn -or
        $candidate.lanes.native.identity.fqbn -cne $report.identity.fqbn -or
        $candidate.lanes.ck.identity.productionExecutableSha256 -cne $executableSha256 -or
        $candidate.lanes.native.identity.productionExecutableSha256 -cne $executableSha256 -or
        $candidate.controls.reproducibleBuildEnvironment.policyId -cne $reproducibilityPolicyId -or
        $candidate.controls.reproducibleBuildEnvironment.sourceDateEpoch -cne $sourceDateEpoch -or
        $candidate.controls.reproducibleBuildEnvironment.timeZone -cne $timeZone -or
        $candidate.controls.reproducibleBuildEnvironment.passed -ne $true) {
        throw 'Native A/B candidate is not bound to the requested probe and report identity.'
    }
    if (@($candidate.lanes.ck.trials).Count -ne $Trials -or
        @($candidate.lanes.native.trials).Count -ne $Trials) {
        throw 'Native A/B candidate does not contain the requested paired trial count.'
    }
    if (($runnerExit -eq 0 -and $report.qualificationStatus -cne 'qualified') -or
        ($runnerExit -eq 2 -and $report.qualificationStatus -cne 'not-qualified')) {
        throw "Native A/B report status is inconsistent with runner exit $runnerExit."
    }
    if ($artifactBundlePath) {
        Assert-ArtifactBundle -BundlePath $artifactBundlePath
    }

    $terminalExit = $runnerExit
    if ($runnerExit -eq 0) {
        $completionMessage = "CK-FORGE-NATIVE-AB-QUALIFIED $outputPath"
    } else {
        $completionMessage = "CK-FORGE-NATIVE-AB-TARGET-NOT-MET $outputPath"
    }
} catch {
    $terminalError = $_
} finally {
    if ($app) {
        try {
            foreach ($processId in @(Get-OwnedProcessIds -RootProcessId ([int]$app.Id))) {
                [void]$ownedProcessIds.Add([int]$processId)
            }
        } catch {
            $cleanupFailures.Add("owned process-tree inventory failed: $($_.Exception.Message)")
        }
        try {
            if (Test-ProcessExists -ProcessId ([int]$app.Id)) {
                & taskkill.exe /PID $app.Id /T /F 2>$null | Out-Null
            }
        } catch {
            $cleanupFailures.Add("owned app process-tree cleanup failed: $($_.Exception.Message)")
        }
        Start-Sleep -Milliseconds 250
        foreach ($processId in @($ownedProcessIds)) {
            if (Test-ProcessExists -ProcessId $processId) {
                try {
                    & taskkill.exe /PID $processId /T /F 2>$null | Out-Null
                } catch {
                    $cleanupFailures.Add("owned PID $processId cleanup failed: $($_.Exception.Message)")
                }
            }
        }
    }

    foreach ($name in $saved.Keys) {
        try {
            [System.Environment]::SetEnvironmentVariable($name, $saved[$name], 'Process')
        } catch {
            $cleanupFailures.Add("environment restoration failed for ${name}: $($_.Exception.Message)")
        }
    }
    [Array]::Clear($tokenBytes, 0, $tokenBytes.Length)
    $qualificationToken = $null

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
        $cleanupFailures.Add("CDP debug port $DebugPort remains occupied")
    }
    $remainingOwned = @($ownedProcessIds | Where-Object {
        Test-ProcessExists -ProcessId ([int]$_)
    })
    if ($remainingOwned.Count -ne 0) {
        $cleanupFailures.Add("owned process IDs remain active: $($remainingOwned -join ', ')")
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
    throw "Native A/B cleanup failed: $cleanupMessage"
}
if ($terminalError) {
    throw $terminalError
}
Write-Output $completionMessage
if ($terminalExit -eq 2) {
    exit 2
}
