param(
    [string]$Root = '',
    [switch]$GeneratorOnly,
    [string]$JsonPath = 'tmp/core_compatibility_results.json',
    [string]$GeneratorAuditPath = 'tmp/builtin_block_generator_audit.json',
    [string]$GeneratedFixtureRoot = 'tmp/builtin_block_compatibility'
)

Set-StrictMode -Version Latest
$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$Root = (Resolve-Path $Root).Path
$cli = Join-Path $Root 'bin/arduino-cli.exe'
$config = Join-Path $Root 'arduino-cli.yaml'
$jsonFile = Join-Path $Root $JsonPath
$auditFile = Join-Path $Root $GeneratorAuditPath
$fixtureRoot = Join-Path $Root $GeneratedFixtureRoot
$auditScript = Join-Path $Root 'scripts/Audit-BuiltinBlockCompatibility.mjs'
$catalogFile = Join-Path $Root 'docs/compatibility/builtin-block-compatibility.json'

function Get-RootRelativeEvidencePath {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd([char[]]@('\', '/'))
    $full = [System.IO.Path]::GetFullPath($Path)
    $prefix = "$rootFull$([System.IO.Path]::DirectorySeparatorChar)"
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Compatibility evidence path must stay inside the CK root'
    }
    return $full.Substring($prefix.Length).Replace('\', '/')
}

function Resolve-RootContainedRelativePath {
    param(
        [Parameter(Mandatory = $true)][string]$RootPath,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )
    if ([string]::IsNullOrWhiteSpace($RelativePath) -or [System.IO.Path]::IsPathRooted($RelativePath)) {
        throw 'Generated compatibility fixture must use a CK-root-relative path'
    }
    $rootFull = [System.IO.Path]::GetFullPath($RootPath).TrimEnd([char[]]@('\', '/'))
    $candidate = [System.IO.Path]::GetFullPath((Join-Path $rootFull $RelativePath))
    $prefix = "$rootFull$([System.IO.Path]::DirectorySeparatorChar)"
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'Generated compatibility fixture escapes the CK root'
    }
    return $candidate
}

function Assert-PublishedCompatibilityReportPrivacy {
    param([Parameter(Mandatory = $true)][string]$Json)
    $forbiddenPatterns = @(
        '(?i)[a-z]:[\\/]',
        '(?i)\\\\[^\\\s"]+[\\/]',
        '(?i)\bfile:/+',
        '(?i)\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b',
        '(?i)\b[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}\b',
        '(?i)\bmac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b'
    )
    foreach ($pattern in $forbiddenPatterns) {
        if ($Json -match $pattern) {
            throw 'Compatibility evidence contains a sensitive absolute path, file URI, or full MAC'
        }
    }
}

function Write-Utf8NoBomAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
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

if (-not (Test-Path -LiteralPath $cli)) {
    throw "arduino-cli not found: $cli"
}

$toolBins = Get-ChildItem (Join-Path $Root 'packages') -Recurse -File |
    Where-Object { $_.Name -like '*g++.exe' } |
    ForEach-Object { $_.DirectoryName } |
    Sort-Object -Unique
$env:CCACHE_PATH = $toolBins -join [IO.Path]::PathSeparator
$env:CCACHE_DIR = Join-Path $Root 'cache/ccache'
$env:CCACHE_NOHASHDIR = 'true'

$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $jsonFile)
$null = New-Item -ItemType Directory -Force -Path (Split-Path -Parent $auditFile)
$null = New-Item -ItemType Directory -Force -Path $fixtureRoot

Write-Host '[generator-audit] Enumerating the built-in toolbox and emitting compile-only fixtures...'
& node $auditScript --out $auditFile --emit-fixtures $fixtureRoot
if ($LASTEXITCODE -ne 0) {
    throw 'Built-in block generator audit failed'
}
$audit = Get-Content -LiteralPath $auditFile -Raw | ConvertFrom-Json
$catalog = Get-Content -LiteralPath $catalogFile -Raw | ConvertFrom-Json

$manualTargets = @(
    @{ Name = 'AVR Nano core smoke'; TargetId = 'avr-nano'; Fqbn = 'arduino:avr:nano'; CoreVersion = '1.8.6'; Sketch = 'examples/core_compat_smoke/avr_nano'; Suite = 'hand-authored-core-smoke'; Source = 'hand-authored' },
    @{ Name = 'AVR Mega core smoke'; TargetId = 'avr-mega'; Fqbn = 'arduino:avr:mega'; CoreVersion = '1.8.6'; Sketch = 'examples/core_compat_smoke/avr_mega'; Suite = 'hand-authored-core-smoke'; Source = 'hand-authored' },
    @{ Name = 'ESP32-C5 core smoke'; TargetId = 'esp32-c5'; Fqbn = 'esp32:esp32:esp32c5'; CoreVersion = '3.3.6'; Sketch = 'examples/core_compat_smoke/esp32_c5'; Suite = 'hand-authored-core-smoke'; Source = 'hand-authored' },
    @{ Name = 'ESP32-C6 core smoke'; TargetId = 'esp32-c6'; Fqbn = 'esp32:esp32:esp32c6'; CoreVersion = '3.3.6'; Sketch = 'examples/core_compat_smoke/esp32_c6'; Suite = 'hand-authored-core-smoke'; Source = 'hand-authored' },
    @{ Name = 'ESP8266 core smoke'; TargetId = 'esp8266'; Fqbn = 'esp8266:esp8266:nodemcuv2'; CoreVersion = '3.1.2'; Sketch = 'examples/core_compat_smoke/esp8266'; Suite = 'hand-authored-core-smoke'; Source = 'hand-authored' }
)

$generatedTargets = @($audit.fixtures | ForEach-Object {
    @{
        Name = ("{0} [{1}] generated" -f $_.suite, $_.target)
        TargetId = [string]$_.target
        Fqbn = [string]$_.fqbn
        CoreVersion = [string]$_.coreVersion
        Sketch = [string]$_.directory
        Suite = [string]$_.suite
        Source = 'built-in-generator'
        SourceSha256 = [string]$_.codeSha256
    }
})

$targets = if ($GeneratorOnly) { $generatedTargets } else { @($manualTargets + $generatedTargets) }

$results = foreach ($target in $targets) {
    $sketchPath = Resolve-RootContainedRelativePath -RootPath $Root -RelativePath ([string]$target.Sketch)
    Write-Host ("[compile-only] {0} ({1})" -f $target.Name, $target.Fqbn)
    $watch = [System.Diagnostics.Stopwatch]::StartNew()
    $previousErrorAction = $ErrorActionPreference
    $ErrorActionPreference = 'Continue'
    $compileOutput = & $cli --config-file $config compile --fqbn $target.Fqbn $sketchPath 2>&1
    $exitCode = $LASTEXITCODE
    $compileOutput | ForEach-Object { $_.ToString() } | Out-Host
    $ErrorActionPreference = $previousErrorAction
    $watch.Stop()
    [pscustomobject]@{
        Target = $target.Name
        TargetId = $target.TargetId
        FQBN = $target.Fqbn
        CoreVersion = $target.CoreVersion
        Suite = $target.Suite
        Source = $target.Source
        SourceSha256 = if ($target.ContainsKey('SourceSha256')) { $target.SourceSha256 } else { $null }
        Evidence = 'compile-only'
        HardwareTested = $false
        Passed = $exitCode -eq 0
        ExitCode = $exitCode
        Seconds = [math]::Round($watch.Elapsed.TotalSeconds, 2)
    }
}

$blockMatrix = foreach ($blockType in $catalog.blocks) {
    $architectureRule = @($catalog.architectureRules | Where-Object {
        @($_.types) -contains $blockType
    } | Select-Object -First 1)
    $classification = if ($architectureRule.Count -gt 0) {
        [string]$architectureRule[0].classification
    } else {
        [string]$catalog.defaultRule.classification
    }
    $supportedTargets = if ($architectureRule.Count -gt 0) {
        @($architectureRule[0].supportedTargets)
    } else {
        @($catalog.defaultRule.supportedTargets)
    }

    $targetEvidence = foreach ($catalogTarget in $catalog.targets) {
        $targetId = [string]$catalogTarget.id
        $architectureAvailability = if ($supportedTargets -contains $targetId) { 'supported' } else { 'unsupported' }
        $generationResult = @($audit.results | Where-Object {
            $_.target -eq $targetId -and $_.type -eq $blockType
        } | Select-Object -First 1)
        $coveringSuites = @($catalog.representativeCompileSuites | Where-Object {
            @($_.targets) -contains $targetId -and @($_.blocks) -contains $blockType
        } | ForEach-Object { [string]$_.id })
        $suiteResults = @($results | Where-Object {
            $_.TargetId -eq $targetId -and
            $_.Source -eq 'built-in-generator' -and
            $coveringSuites -contains $_.Suite
        })

        $compileStatus = if ($architectureAvailability -eq 'unsupported') {
            'not-applicable'
        } elseif ($coveringSuites.Count -eq 0) {
            'no-compile-evidence'
        } elseif ($suiteResults.Count -lt $coveringSuites.Count) {
            'not-run'
        } elseif (@($suiteResults | Where-Object { -not $_.Passed }).Count -gt 0) {
            'fail'
        } else {
            'pass'
        }

        [pscustomobject]@{
            TargetId = $targetId
            FQBN = [string]$catalogTarget.fqbn
            CoreVersion = [string]$catalogTarget.coreVersion
            ArchitectureAvailability = $architectureAvailability
            StaticGeneration = if ($generationResult.Count -gt 0) { [string]$generationResult[0].status } else { 'not-run' }
            StaticGenerationSha256 = if ($generationResult.Count -gt 0 -and $generationResult[0].status -eq 'pass') { [string]$generationResult[0].codeSha256 } else { $null }
            CompileOnly = $compileStatus
            CompileSuites = $coveringSuites
            HardwareTested = $false
        }
    }

    [pscustomobject]@{
        Type = [string]$blockType
        Classification = $classification
        Targets = @($targetEvidence)
    }
}

$flatBlockEvidence = @($blockMatrix | ForEach-Object { $_.Targets })
$blockEvidenceCounts = [ordered]@{
    blocks = @($blockMatrix).Count
    targetCells = $flatBlockEvidence.Count
    staticGenerationPass = @($flatBlockEvidence | Where-Object { $_.StaticGeneration -eq 'pass' }).Count
    compileOnlyPass = @($flatBlockEvidence | Where-Object { $_.CompileOnly -eq 'pass' }).Count
    noCompileEvidence = @($flatBlockEvidence | Where-Object { $_.CompileOnly -eq 'no-compile-evidence' }).Count
    architectureUnsupported = @($flatBlockEvidence | Where-Object { $_.ArchitectureAvailability -eq 'unsupported' }).Count
}

$document = [ordered]@{
    schema = 'ck-core-compatibility-results'
    version = 1
    evidence = 'compile-only'
    hardwareTested = $false
    hardwareStatement = 'Compilation does not prove upload, boot, peripheral wiring, timing, radio association, or physical-board behavior.'
    catalog = 'docs/compatibility/builtin-block-compatibility.json'
    generatorAudit = [ordered]@{
        path = Get-RootRelativeEvidencePath -RootPath $Root -Path $auditFile
        toolboxTypes = $audit.counts.toolboxTypes
        targetRuns = $audit.counts.targetRuns
        passed = $audit.counts.passed
        failed = $audit.counts.failed
    }
    generatorOnly = [bool]$GeneratorOnly
    blockEvidenceCounts = $blockEvidenceCounts
    blocks = @($blockMatrix)
    results = @($results)
}

$serializedDocument = ($document | ConvertTo-Json -Depth 8) + "`n"
Assert-PublishedCompatibilityReportPrivacy -Json $serializedDocument
Write-Utf8NoBomAtomic -Path $jsonFile -Content $serializedDocument
$results | Format-Table TargetId, Suite, Source, Passed, Seconds -AutoSize
Write-Host ("compile_only_report={0}" -f $jsonFile)
Write-Host 'hardware_tested=false'

if ($results.Passed -contains $false) {
    exit 1
}
