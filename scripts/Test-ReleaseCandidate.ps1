param(
    [string]$Root = '',
    [string]$ExpectedVersion = '1.0.0',
    [string]$OutputPath = '',
    [string]$SourceTreeManifestPath = '',
    [string]$SourceTreeFreezePath = '',
    [switch]$SkipProductionBuild,
    [switch]$SkipDesktopBundle
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root 'artifacts\release\v1-release-gates.json'
}
if ([string]::IsNullOrWhiteSpace($SourceTreeManifestPath)) {
    $SourceTreeManifestPath = Join-Path $Root 'artifacts\release\source-tree-manifest.json'
}
if ([string]::IsNullOrWhiteSpace($SourceTreeFreezePath)) {
    $SourceTreeFreezePath = Join-Path $Root 'artifacts\release\source-tree-freeze.json'
}
$compatibilityAuditPath = Join-Path $Root 'artifacts\release\builtin-block-generator-audit.json'
$compatibilityReportPath = Join-Path $Root 'artifacts\release\core-compatibility-results.json'
$compatibilityFixtureRoot = Join-Path $Root 'tmp\release-builtin-block-compatibility'

# A new release run must never leave a previous successful report visible while
# its gates are still running.  The final report is published atomically in the
# finally block; if this process is interrupted before then, the absence of an
# output report is the fail-closed result.
if (Test-Path -LiteralPath $OutputPath) {
    Remove-Item -LiteralPath $OutputPath -Force
}
foreach ($staleCompatibilityReport in @($compatibilityAuditPath, $compatibilityReportPath)) {
    if (Test-Path -LiteralPath $staleCompatibilityReport -PathType Leaf) {
        Remove-Item -LiteralPath $staleCompatibilityReport -Force
    }
}

$results = [System.Collections.Generic.List[object]]::new()
$startedAt = [DateTimeOffset]::UtcNow
$runId = "$($startedAt.ToString('yyyyMMddTHHmmssfffZ'))-$([Guid]::NewGuid().ToString('N').Substring(0, 8))"
$bundleRoot = Join-Path $Root 'target\release\bundle'
$bundleState = [ordered]@{
    requested = -not $SkipDesktopBundle
    build_started_at = $null
    preparation = $null
    executable = $null
    evidence = @()
}
$sourceTreeState = [ordered]@{
    preflight = $null
    postflight = $null
}
$script:compatibilityReports = @()

Import-Module (Join-Path $PSScriptRoot 'ReleaseBundleGate.psm1') -Force

function Invoke-ReleaseGate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][scriptblock]$Action
    )
    $started = [DateTimeOffset]::UtcNow
    try {
        & $Action
        $results.Add([ordered]@{
            name = $Name
            status = 'passed'
            duration_ms = [int64]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds
        })
    }
    catch {
        $results.Add([ordered]@{
            name = $Name
            status = 'failed'
            duration_ms = [int64]([DateTimeOffset]::UtcNow - $started).TotalMilliseconds
            error = [string]$_
        })
        throw
    }
}

function Add-SkippedReleaseGate {
    param(
        [Parameter(Mandatory = $true)][string]$Name,
        [Parameter(Mandatory = $true)][string]$Reason
    )
    $results.Add([ordered]@{
        name = $Name
        status = 'skipped'
        duration_ms = 0
        reason = $Reason
    })
}

function Assert-LastProcessSucceeded {
    param([Parameter(Mandatory = $true)][string]$Operation)
    $exitCode = $LASTEXITCODE
    if ($exitCode -ne 0) {
        throw "$Operation exited with code $exitCode"
    }
}

function Write-Utf8NoBomAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    # Keep the staging file beside the destination so the final rename stays
    # on one volume. Windows PowerShell 5.1's `-Encoding utf8` emits a BOM,
    # which is not valid input for consumers that call JSON.parse directly.
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    $backup = "$Path.$([Guid]::NewGuid().ToString('N')).replace-backup"
    try {
        [System.IO.File]::WriteAllText($temporary, $Content, [System.Text.UTF8Encoding]::new($false))
        if (Test-Path -LiteralPath $Path -PathType Leaf) {
            [System.IO.File]::Replace($temporary, $Path, $backup, $true)
        }
        else {
            [System.IO.File]::Move($temporary, $Path)
        }
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
        if (Test-Path -LiteralPath $backup) { Remove-Item -LiteralPath $backup -Force }
    }
}

function Get-VerifiedSourceTreeFreeze {
    $freezeTool = Join-Path $PSScriptRoot 'New-SourceTreeManifest.ps1'
    if (-not (Test-Path -LiteralPath $freezeTool -PathType Leaf)) {
        throw "source tree freeze tool is missing: $freezeTool"
    }
    if (-not (Test-Path -LiteralPath $SourceTreeManifestPath -PathType Leaf)) {
        throw "source tree manifest is missing; freeze source before running the release gate: $SourceTreeManifestPath"
    }
    if (-not (Test-Path -LiteralPath $SourceTreeFreezePath -PathType Leaf)) {
        throw "source tree freeze record is missing; freeze source before running the release gate: $SourceTreeFreezePath"
    }
    $verificationOutput = @(& powershell -NoProfile -ExecutionPolicy Bypass -File $freezeTool `
        -Mode Verify `
        -Root $Root `
        -ManifestPath $SourceTreeManifestPath `
        -FreezeRecordPath $SourceTreeFreezePath 2>&1)
    $verificationExitCode = $LASTEXITCODE
    if ($verificationExitCode -ne 0) {
        $details = ($verificationOutput | ForEach-Object { [string]$_ }) -join [Environment]::NewLine
        throw "source tree freeze verification exited with code $verificationExitCode`n$details"
    }

    $manifest = Get-Content -LiteralPath $SourceTreeManifestPath -Raw | ConvertFrom-Json
    $freeze = Get-Content -LiteralPath $SourceTreeFreezePath -Raw | ConvertFrom-Json
    if ([string]$manifest.source_control.kind -cne 'none' -or $null -ne $manifest.source_control.commit) {
        throw 'no-Git source manifest must record kind=none and commit=null'
    }
    if ([string]$freeze.source_control.kind -cne 'none' -or $null -ne $freeze.source_control.commit) {
        throw 'no-Git freeze record must not claim a Git commit'
    }
    $manifestSha256 = (Get-FileHash -LiteralPath $SourceTreeManifestPath -Algorithm SHA256).Hash.ToLowerInvariant()
    if ([string]$freeze.manifest_sha256 -cne $manifestSha256) {
        throw 'freeze record manifest_sha256 changed after verification'
    }
    return [ordered]@{
        policy_id = [string]$manifest.policy_id
        source_control = [ordered]@{ kind = 'none'; commit = $null }
        manifest_path = Get-RelativeEvidencePath -BasePath $Root -Path $SourceTreeManifestPath
        freeze_record_path = Get-RelativeEvidencePath -BasePath $Root -Path $SourceTreeFreezePath
        manifest_sha256 = $manifestSha256
        tree_sha256 = [string]$manifest.tree_sha256
        frozen_at = [string]$freeze.frozen_at
        file_count = [int]$manifest.file_count
        total_bytes = [int64]$manifest.total_bytes
    }
}

function Assert-ReleaseVersions {
    $package = Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\package.json') -Raw | ConvertFrom-Json
    $tauri = Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\src-tauri\tauri.conf.json') -Raw | ConvertFrom-Json
    $cargoText = Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\src-tauri\Cargo.toml') -Raw
    $packageLockText = Get-Content -LiteralPath (Join-Path $Root 'apps\desktop\package-lock.json') -Raw
    $cargoLockText = Get-Content -LiteralPath (Join-Path $Root 'Cargo.lock') -Raw
    $cargoMatch = [regex]::Match($cargoText, '(?ms)^\[package\].*?^version\s*=\s*"([^"]+)"')
    if (-not $cargoMatch.Success) {
        throw 'desktop Cargo package version is missing'
    }
    # Windows PowerShell 5 treats package-lock dependency names as
    # case-insensitive JSON properties and cannot always ConvertFrom-Json the
    # complete npm lock. Match npm's deterministic root-package record instead.
    $packageLockMatch = [regex]::Match(
        $packageLockText,
        '(?s)"packages"\s*:\s*\{\s*""\s*:\s*\{\s*"name"\s*:\s*"[^"]+"\s*,\s*"version"\s*:\s*"([^"]+)"'
    )
    if (-not $packageLockMatch.Success) {
        throw 'desktop package-lock root package version is missing'
    }
    $cargoLockMatch = [regex]::Match(
        $cargoLockText,
        '(?ms)^\[\[package\]\]\s*\r?\nname\s*=\s*"appsdesktop"\s*\r?\nversion\s*=\s*"([^"]+)"'
    )
    if (-not $cargoLockMatch.Success) {
        throw 'Cargo.lock appsdesktop package version is missing'
    }
    $versions = [ordered]@{
        package_json = [string]$package.version
        package_lock_root = [string]$packageLockMatch.Groups[1].Value
        tauri = [string]$tauri.version
        cargo = [string]$cargoMatch.Groups[1].Value
        cargo_lock_appsdesktop = [string]$cargoLockMatch.Groups[1].Value
    }
    foreach ($entry in $versions.GetEnumerator()) {
        if ($entry.Value -ne $ExpectedVersion) {
            throw "version mismatch: $($entry.Key)=$($entry.Value), expected $ExpectedVersion"
        }
    }
}

function Test-JsonProperty {
    param(
        [AllowNull()][object]$Object,
        [Parameter(Mandatory = $true)][string]$Name
    )
    return $null -ne $Object -and $null -ne $Object.PSObject.Properties[$Name]
}

function Get-ValidatedCompatibilityReportEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$AuditPath,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        [Parameter(Mandatory = $true)][DateTimeOffset]$NotBeforeUtc
    )

    foreach ($path in @($AuditPath, $ReportPath)) {
        if (-not (Test-Path -LiteralPath $path -PathType Leaf)) {
            throw "built-in compatibility report is missing: $path"
        }
        $item = Get-Item -LiteralPath $path
        if ($item.Length -le 0) {
            throw "built-in compatibility report is empty: $path"
        }
        if ([DateTimeOffset]$item.LastWriteTimeUtc -lt $NotBeforeUtc) {
            throw "built-in compatibility report is older than the current release gate: $path"
        }
    }

    $audit = Get-Content -LiteralPath $AuditPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$audit.schema -cne 'ck-builtin-block-generator-audit' -or
        -not (Test-JsonProperty $audit 'version') -or [int]$audit.version -ne 1 -or
        -not (Test-JsonProperty $audit 'hardwareTested') -or $audit.hardwareTested -ne $false -or
        $null -eq $audit.counts) {
        throw 'built-in generator audit schema/version/hardware boundary is invalid'
    }
    foreach ($requiredCount in @('toolboxTypes', 'targetRuns', 'passed', 'failed')) {
        if (-not (Test-JsonProperty $audit.counts $requiredCount)) {
            throw "built-in generator audit is missing counts.$requiredCount"
        }
    }
    if ([int]$audit.counts.toolboxTypes -ne 147 -or
        [int]$audit.counts.targetRuns -ne 294 -or
        [int]$audit.counts.passed -ne 294 -or
        [int]$audit.counts.failed -ne 0) {
        throw 'built-in generator audit count contract is invalid'
    }

    $compatibility = Get-Content -LiteralPath $ReportPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]$compatibility.schema -cne 'ck-core-compatibility-results' -or
        -not (Test-JsonProperty $compatibility 'version') -or [int]$compatibility.version -ne 1 -or
        -not (Test-JsonProperty $compatibility 'hardwareTested') -or $compatibility.hardwareTested -ne $false -or
        -not (Test-JsonProperty $compatibility 'generatorOnly') -or $compatibility.generatorOnly -ne $true -or
        $null -eq $compatibility.blockEvidenceCounts) {
        throw 'core compatibility schema/version/generator-only/hardware boundary is invalid'
    }
    foreach ($requiredCount in @('blocks', 'targetCells', 'staticGenerationPass')) {
        if (-not (Test-JsonProperty $compatibility.blockEvidenceCounts $requiredCount)) {
            throw "core compatibility report is missing blockEvidenceCounts.$requiredCount"
        }
    }
    if ([int]$compatibility.blockEvidenceCounts.blocks -ne 147 -or
        [int]$compatibility.blockEvidenceCounts.targetCells -ne 294 -or
        [int]$compatibility.blockEvidenceCounts.staticGenerationPass -ne 294) {
        throw 'core compatibility block evidence count contract is invalid'
    }

    $generatedResults = @($compatibility.results)
    if ($generatedResults.Count -ne 7) {
        throw "core compatibility report must contain exactly 7 generated compile-only results; found $($generatedResults.Count)"
    }
    $invalidResult = @($generatedResults | Where-Object {
            -not (Test-JsonProperty $_ 'Passed') -or $_.Passed -ne $true -or
            [string]$_.Evidence -cne 'compile-only' -or
            [string]$_.Source -cne 'built-in-generator' -or
            -not (Test-JsonProperty $_ 'HardwareTested') -or $_.HardwareTested -ne $false
        })
    if ($invalidResult.Count -gt 0) {
        throw 'all 7 generated compatibility results must be passed compile-only built-in-generator evidence with hardwareTested=false'
    }

    $auditItem = Get-Item -LiteralPath $AuditPath
    $compatibilityItem = Get-Item -LiteralPath $ReportPath
    return @(
        [ordered]@{
            role = 'builtin-block-generator-audit'
            path = Get-RelativeEvidencePath -BasePath $Root -Path $auditItem.FullName
            bytes = [int64]$auditItem.Length
            sha256 = (Get-FileHash -LiteralPath $auditItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            generated_at = ([DateTimeOffset]$auditItem.LastWriteTimeUtc).ToString('o')
            schema = [string]$audit.schema
            version = [int]$audit.version
            hardware_tested = $false
            counts = [ordered]@{
                toolbox_types = [int]$audit.counts.toolboxTypes
                target_runs = [int]$audit.counts.targetRuns
                passed = [int]$audit.counts.passed
                failed = [int]$audit.counts.failed
            }
        },
        [ordered]@{
            role = 'core-compatibility-results'
            path = Get-RelativeEvidencePath -BasePath $Root -Path $compatibilityItem.FullName
            bytes = [int64]$compatibilityItem.Length
            sha256 = (Get-FileHash -LiteralPath $compatibilityItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            generated_at = ([DateTimeOffset]$compatibilityItem.LastWriteTimeUtc).ToString('o')
            schema = [string]$compatibility.schema
            version = [int]$compatibility.version
            hardware_tested = $false
            generator_only = $true
            evidence = 'compile-only'
            counts = [ordered]@{
                blocks = [int]$compatibility.blockEvidenceCounts.blocks
                target_cells = [int]$compatibility.blockEvidenceCounts.targetCells
                static_generation_pass = [int]$compatibility.blockEvidenceCounts.staticGenerationPass
                generated_results = [int]$generatedResults.Count
                passed = [int](@($generatedResults | Where-Object { $_.Passed -eq $true }).Count)
            }
        }
    )
}

Push-Location $Root
try {
    Invoke-ReleaseGate 'source-tree-freeze-preflight' {
        $sourceTreeState.preflight = Get-VerifiedSourceTreeFreeze
    }
    Invoke-ReleaseGate 'version-consistency' { Assert-ReleaseVersions }
    Invoke-ReleaseGate 'bundled-resource-contract' {
        Assert-BundledResourceContract -Root $Root
    }
    Invoke-ReleaseGate 'rustfmt' {
        & cargo fmt --all -- --check
        Assert-LastProcessSucceeded 'cargo fmt'
    }

    $frontendTests = Get-ChildItem -LiteralPath (Join-Path $Root 'apps\desktop\src') -Recurse -File -Filter '*.test.mjs' |
        Sort-Object FullName |
        ForEach-Object FullName
    if ($frontendTests.Count -eq 0) { throw 'no frontend tests discovered' }
    Invoke-ReleaseGate 'desktop-frontend-tests' {
        & node --test @frontendTests
        Assert-LastProcessSucceeded 'desktop frontend tests'
    }

    $scriptTests = Get-ChildItem -LiteralPath (Join-Path $Root 'scripts') -File -Filter '*.test.mjs' |
        Sort-Object FullName |
        ForEach-Object FullName
    if ($scriptTests.Count -eq 0) { throw 'no script tests discovered' }
    Invoke-ReleaseGate 'release-and-package-script-tests' {
        # These suites repeatedly spawn PowerShell, archive and compiler helpers.
        # Running all files concurrently is nondeterministic on Windows and can
        # terminate an otherwise passing gate under process/memory pressure.
        & node --test --test-concurrency=1 @scriptTests
        Assert-LastProcessSucceeded 'release and package script tests'
    }

    Invoke-ReleaseGate 'ck-core-tests' {
        & cargo test -p ck_core --all-targets
        Assert-LastProcessSucceeded 'ck_core tests'
    }
    Invoke-ReleaseGate 'arduino-rust-tests' {
        & cargo test -p arduino --all-targets
        Assert-LastProcessSucceeded 'Arduino client Rust tests'
    }
    Invoke-ReleaseGate 'desktop-rust-tests' {
        & cargo test -p appsdesktop --lib
        Assert-LastProcessSucceeded 'desktop Rust tests'
    }
    Invoke-ReleaseGate 'deterministic-example-packages' {
        & powershell -NoProfile -ExecutionPolicy Bypass -File (Join-Path $Root 'examples\importable-packages\Build-Examples.ps1')
        Assert-LastProcessSucceeded 'deterministic example package build'
        if (Test-Path -LiteralPath $compatibilityFixtureRoot -PathType Container) {
            Remove-Item -LiteralPath $compatibilityFixtureRoot -Recurse -Force
        }
        & powershell -NoProfile -ExecutionPolicy Bypass -File `
            (Join-Path $Root 'scripts\Test-CoreCompatibility.ps1') `
            -Root $Root `
            -GeneratorOnly `
            -JsonPath 'artifacts/release/core-compatibility-results.json' `
            -GeneratorAuditPath 'artifacts/release/builtin-block-generator-audit.json' `
            -GeneratedFixtureRoot 'tmp/release-builtin-block-compatibility'
        Assert-LastProcessSucceeded 'built-in generator compile-only compatibility'
        $script:compatibilityReports = @(Get-ValidatedCompatibilityReportEvidence `
                -AuditPath $compatibilityAuditPath `
                -ReportPath $compatibilityReportPath `
                -NotBeforeUtc $startedAt)
    }
    Invoke-ReleaseGate 'extension-sdk' {
        & powershell -NoProfile -ExecutionPolicy Bypass -File `
            (Join-Path $Root 'scripts\Build-ExtensionSdk.ps1') `
            -Version $ExpectedVersion
        Assert-LastProcessSucceeded 'CK Extension SDK build and verification'
        $sdkGatePath = Join-Path $Root "artifacts\release\CK-Extension-SDK-$ExpectedVersion.zip"
        if (-not (Test-Path -LiteralPath $sdkGatePath -PathType Leaf)) {
            throw 'extension SDK gate did not produce the expected ZIP'
        }
        if ([DateTimeOffset](Get-Item -LiteralPath $sdkGatePath).LastWriteTimeUtc -lt $startedAt) {
            throw 'extension SDK ZIP is older than the current release gate'
        }
    }
    if (-not $SkipProductionBuild) {
        Invoke-ReleaseGate 'desktop-production-build' {
            & npm --prefix (Join-Path $Root 'apps\desktop') run build
            Assert-LastProcessSucceeded 'desktop production build'
        }
    } else {
        Add-SkippedReleaseGate 'desktop-production-build' 'SkipProductionBuild was explicitly requested'
    }
    if (-not $SkipDesktopBundle) {
        Invoke-ReleaseGate 'desktop-installers' {
            $bundleState.preparation = Move-PreexistingReleaseBundleRoot `
                -BundleRoot $bundleRoot `
                -QuarantineRoot (Join-Path $Root 'artifacts\release\preexisting-bundles') `
                -RunId $runId
            $bundleState.build_started_at = [DateTimeOffset]::UtcNow
            & npm --prefix (Join-Path $Root 'apps\desktop') run tauri -- build
            Assert-LastProcessSucceeded 'Tauri desktop bundle'
            $productionExecutablePath = Join-Path $Root 'target\release\appsdesktop.exe'
            if (-not (Test-Path -LiteralPath $productionExecutablePath -PathType Leaf)) {
                throw 'Tauri desktop bundle did not produce target/release/appsdesktop.exe'
            }
            $productionExecutableItem = Get-Item -LiteralPath $productionExecutablePath
            if ([DateTimeOffset]$productionExecutableItem.LastWriteTimeUtc -lt $bundleState.build_started_at) {
                throw 'production executable is older than the current desktop bundle build'
            }
            $bundleState.executable = [ordered]@{
                role = 'portable-executable'
                path = Get-RelativeEvidencePath -BasePath $Root -Path $productionExecutableItem.FullName
                bytes = [int64]$productionExecutableItem.Length
                sha256 = (Get-FileHash -LiteralPath $productionExecutableItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                generated_at = ([DateTimeOffset]$productionExecutableItem.LastWriteTimeUtc).ToString('o')
                version = [string]$productionExecutableItem.VersionInfo.ProductVersion
            }
            Assert-ReleaseInstallerResourceLayout -Root $Root -BundleRoot $bundleRoot
            $bundleState.evidence = @(Get-FreshReleaseBundleEvidence `
                    -BundleRoot $bundleRoot `
                    -ExpectedVersion $ExpectedVersion `
                    -NotBeforeUtc $bundleState.build_started_at `
                    -ReportRoot $Root)
            if ($bundleState.evidence.Count -eq 0) {
                throw 'desktop installer gate produced no accepted current-run installer evidence'
            }
        }
    } else {
        Add-SkippedReleaseGate 'desktop-installers' 'SkipDesktopBundle was explicitly requested; no installer evidence was accepted'
    }
    Invoke-ReleaseGate 'source-tree-freeze-postflight' {
        $sourceTreeState.postflight = Get-VerifiedSourceTreeFreeze
        if ([string]$sourceTreeState.postflight.manifest_sha256 -cne [string]$sourceTreeState.preflight.manifest_sha256 -or
            [string]$sourceTreeState.postflight.tree_sha256 -cne [string]$sourceTreeState.preflight.tree_sha256) {
            throw 'source tree identity changed during the release gate'
        }
    }
}
finally {
    Pop-Location
    $zipEvidence = Get-ChildItem -LiteralPath (Join-Path $Root 'examples\importable-packages') -File -Filter '*.zip' |
        Sort-Object Name |
        ForEach-Object {
            [ordered]@{
                name = $_.Name
                bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        }
    $failed = @($results | Where-Object status -eq 'failed').Count
    $skipped = @($results | Where-Object status -eq 'skipped').Count
    $coverage = if ($failed -gt 0) { 'failed' } elseif ($skipped -gt 0) { 'partial' } else { 'complete' }
    $bundlePreparationEvidence = if ($null -eq $bundleState.preparation) {
        [ordered]@{
            quarantined = $false
            file_count = 0
            installer_count = 0
            quarantine_path = $null
            inventory_manifest = $null
        }
    } else {
        [ordered]@{
            quarantined = [bool]$bundleState.preparation.quarantined
            file_count = [int]$bundleState.preparation.file_count
            installer_count = [int]$bundleState.preparation.installer_count
            quarantine_path = if ($bundleState.preparation.quarantine_path) {
                Get-RelativeEvidencePath -BasePath $Root -Path ([string]$bundleState.preparation.quarantine_path)
            } else { $null }
            inventory_manifest = if ($bundleState.preparation.inventory_manifest) {
                Get-RelativeEvidencePath -BasePath $Root -Path ([string]$bundleState.preparation.inventory_manifest)
            } else { $null }
        }
    }
    $sdkPath = Join-Path $Root "artifacts\release\CK-Extension-SDK-$ExpectedVersion.zip"
    $releaseAssets = @()
    if ($null -ne $bundleState.executable) {
        $releaseAssets += $bundleState.executable
    }
    if (Test-Path -LiteralPath $sdkPath -PathType Leaf) {
        $sdkItem = Get-Item -LiteralPath $sdkPath
        $releaseAssets += [ordered]@{
            role = 'extension-sdk'
            # Path.GetRelativePath is unavailable in Windows PowerShell 5.1's
            # .NET Framework runtime. The shared evidence helper normalizes
            # full paths and checks a directory-boundary prefix before taking
            # a substring, so it is both PS 5.1-compatible and resistant to
            # sibling paths that merely share the root's text prefix.
            path = Get-RelativeEvidencePath -BasePath $Root -Path $sdkItem.FullName
            bytes = $sdkItem.Length
            sha256 = (Get-FileHash -LiteralPath $sdkItem.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            generated_at = ([DateTimeOffset]$sdkItem.LastWriteTimeUtc).ToString('o')
        }
    }
    $report = [ordered]@{
        schema_version = 2
        expected_version = $ExpectedVersion
        run_id = $runId
        started_at = $startedAt.ToString('o')
        finished_at = [DateTimeOffset]::UtcNow.ToString('o')
        status = if ($failed -gt 0) { 'failed' } elseif ($skipped -gt 0) { 'partial' } else { 'passed' }
        coverage = [ordered]@{
            automated_release_gates = $coverage
            skipped_gate_count = $skipped
            desktop_bundle_gate = if ($SkipDesktopBundle) { 'skipped' } elseif ($failed -gt 0 -and $bundleState.evidence.Count -eq 0) { 'failed-or-not-reached' } else { 'complete' }
        }
        gates = $results
        source_tree = [ordered]@{
            required = $true
            verified_before_gate = ($null -ne $sourceTreeState.preflight)
            verified_after_gate = ($null -ne $sourceTreeState.postflight)
            identity = $sourceTreeState.preflight
        }
        example_packages = $zipEvidence
        compatibility_reports = @($script:compatibilityReports)
        release_assets = $releaseAssets
        bundle_preparation = $bundlePreparationEvidence
        desktop_bundles = @($bundleState.evidence)
        notes = @(
            'Only desktop installers isolated from pre-existing outputs and accepted as fresh, expected-version artifacts from this run are listed above.',
            'A partial report contains explicitly skipped automated gates and must not be presented as a complete release pass.',
            'The release gate is valid only when the same no-Git source-tree manifest is verified before and after all build gates.',
            'Native desktop interaction and physical-board evidence are recorded separately and must not be inferred from this file.'
        )
    }
    $reportJson = ($report | ConvertTo-Json -Depth 8) + "`n"
    Write-Utf8NoBomAtomic -Path $OutputPath -Content $reportJson
    Write-Host "Release gate report: $OutputPath"
}
