param(
    [string]$Root = (Join-Path $PSScriptRoot ".."),
    [switch]$Generate,
    [switch]$Clean,
    [switch]$MutationSample,
    [int]$MutationStride = 10,
    [string]$ManifestPath = "tmp\dce_suite_manifest.json",
    [string]$BenchPath = "target\debug\bench_dce.exe",
    [string]$CsvPath = "tmp\dce_suite_results.csv",
    [string]$JsonPath = "tmp\dce_suite_results.json",
    [string]$SummaryPath = "tmp\dce_suite_summary.txt"
)

Set-StrictMode -Version Latest
$ErrorActionPreference = "Stop"

$sysroot = (Resolve-Path $Root).Path
$benchExe = Join-Path $sysroot $BenchPath
$manifestFile = Join-Path $sysroot $ManifestPath
$csvFile = Join-Path $sysroot $CsvPath
$jsonFile = Join-Path $sysroot $JsonPath
$summaryFile = Join-Path $sysroot $SummaryPath
$failureDir = Join-Path $sysroot "tmp\dce_suite_failures"
$script:Utf8NoBom = New-Object System.Text.UTF8Encoding($false)
$null = New-Item -ItemType Directory -Force -Path $failureDir

function Write-Utf8NoBom {
    param(
        [string]$Path,
        [string]$Content
    )
    [System.IO.File]::WriteAllText($Path, $Content, $script:Utf8NoBom)
}

function Parse-RunText {
    param([string]$Text)
    $total = $null
    $compiled = $null
    $upToDate = $null
    if ($Text -match 'Total:\s+([0-9.]+)s') {
        $total = [double]$Matches[1]
    } elseif ($Text -match '\[DCE\] TOTAL:\s+([0-9.]+)s') {
        $total = [double]$Matches[1]
    }
    if ($Text -match 'Phase 5: Compiling (\d+) files \((\d+) up-to-date') {
        $compiled = [int]$Matches[1]
        $upToDate = [int]$Matches[2]
    }
    return [pscustomobject]@{
        total = $total
        compiled = $compiled
        upToDate = $upToDate
    }
}

function Invoke-Bench {
    param(
        [string]$Bench,
        [string]$Sketch,
        [string]$Fqbn,
        [string]$Mode
    )
    $output = & $Bench --sketch $Sketch --fqbn $Fqbn ("--" + $Mode) 2>&1
    $exitCode = $LASTEXITCODE
    $text = ($output | Out-String)
    $parsed = Parse-RunText -Text $text
    return [pscustomobject]@{
        exitCode = $exitCode
        text = $text
        total = $parsed.total
        compiled = $parsed.compiled
        upToDate = $parsed.upToDate
    }
}

if ($Generate -or -not (Test-Path $manifestFile)) {
    $generatorArgs = @("-ExecutionPolicy", "Bypass", "-File", (Join-Path $sysroot "scripts\generate_dce_suite.ps1"))
    if ($Clean) { $generatorArgs += "-Clean" }
    & powershell.exe @generatorArgs
    if ($LASTEXITCODE -ne 0) {
        throw "Failed to generate test suite"
    }
}

if (-not (Test-Path $benchExe)) {
    Push-Location $sysroot
    try {
        cargo build -p ck_core --bin bench_dce
        if ($LASTEXITCODE -ne 0) {
            throw "Failed to build bench_dce"
        }
    }
    finally {
        Pop-Location
    }
}

$manifest = Get-Content -Path $manifestFile -Raw | ConvertFrom-Json
$results = New-Object System.Collections.Generic.List[object]

foreach ($item in $manifest) {
    Write-Host (("[{0}/60] {1} [{2}] clean..." -f $item.level, $item.name, $item.board))
    $cleanRun = Invoke-Bench -Bench $benchExe -Sketch $item.name -Fqbn $item.fqbn -Mode "compile"
    if ($cleanRun.exitCode -ne 0) {
        Set-Content -Path (Join-Path $failureDir ($item.name + ".clean.log")) -Value $cleanRun.text -Encoding UTF8
    }

    Write-Host (("[{0}/60] {1} [{2}] incremental..." -f $item.level, $item.name, $item.board))
    $incrRun = Invoke-Bench -Bench $benchExe -Sketch $item.name -Fqbn $item.fqbn -Mode "incremental"
    if ($incrRun.exitCode -ne 0) {
        Set-Content -Path (Join-Path $failureDir ($item.name + ".incr.log")) -Value $incrRun.text -Encoding UTF8
    }

    $mutateRun = $null
    $recoverRun = $null
    $mutated = $false
    if ($MutationSample -and ((($item.level - 1) % $MutationStride) -eq 0)) {
        $sourceFile = Join-Path $sysroot ("tmp_sketch\{0}\{0}.ino" -f $item.name)
        $original = Get-Content -Path $sourceFile -Raw
        $updated = [regex]::Replace($original, 'const uint32_t SUITE_LEVEL = \d+UL;', ("const uint32_t SUITE_LEVEL = {0}UL;" -f ($item.level + 1000)), 1)
        if ($updated -ne $original) {
            Write-Utf8NoBom -Path $sourceFile -Content $updated
            $mutated = $true
            Write-Host (("[{0}/60] {1} [{2}] mutation sample..." -f $item.level, $item.name, $item.board))
            $mutateRun = Invoke-Bench -Bench $benchExe -Sketch $item.name -Fqbn $item.fqbn -Mode "incremental"
            if ($mutateRun.exitCode -ne 0) {
                Set-Content -Path (Join-Path $failureDir ($item.name + ".mutate.log")) -Value $mutateRun.text -Encoding UTF8
            }
            Write-Utf8NoBom -Path $sourceFile -Content $original
            $recoverRun = Invoke-Bench -Bench $benchExe -Sketch $item.name -Fqbn $item.fqbn -Mode "incremental"
            if ($recoverRun.exitCode -ne 0) {
                Set-Content -Path (Join-Path $failureDir ($item.name + ".recover.log")) -Value $recoverRun.text -Encoding UTF8
            }
        }
    }

    $status = if ($cleanRun.exitCode -eq 0 -and $incrRun.exitCode -eq 0 -and (($mutateRun -eq $null) -or ($mutateRun.exitCode -eq 0 -and $recoverRun.exitCode -eq 0))) { "ok" } else { "fail" }
    $results.Add([pscustomobject]@{
        level = $item.level
        board = $item.board
        name = $item.name
        fqbn = $item.fqbn
        fileCount = $item.fileCount
        features = (($item.features) -join ",")
        cleanExit = $cleanRun.exitCode
        cleanTotal = $cleanRun.total
        cleanCompiled = $cleanRun.compiled
        incrExit = $incrRun.exitCode
        incrTotal = $incrRun.total
        incrCompiled = $incrRun.compiled
        mutationSampled = $mutated
        mutateExit = if ($mutateRun) { $mutateRun.exitCode } else { $null }
        mutateTotal = if ($mutateRun) { $mutateRun.total } else { $null }
        mutateCompiled = if ($mutateRun) { $mutateRun.compiled } else { $null }
        recoverExit = if ($recoverRun) { $recoverRun.exitCode } else { $null }
        recoverTotal = if ($recoverRun) { $recoverRun.total } else { $null }
        recoverCompiled = if ($recoverRun) { $recoverRun.compiled } else { $null }
        evidence = "compile-only-stress"
        builtinBlockGeneratorCoverage = $false
        hardwareTested = $false
        status = $status
    })
}

$results | Export-Csv -Path $csvFile -NoTypeInformation -Encoding UTF8
$results | ConvertTo-Json -Depth 6 | Set-Content -Path $jsonFile -Encoding UTF8

$allOk = @($results | Where-Object { $_.status -eq 'ok' }).Count
$allFail = @($results | Where-Object { $_.status -eq 'fail' }).Count
$uno = @($results | Where-Object { $_.board -eq 'uno' })
$esp32 = @($results | Where-Object { $_.board -eq 'esp32s3' })
$mutatedCount = @($results | Where-Object { $_.mutationSampled }).Count
$bestIncr = $results | Where-Object { $_.incrTotal -ne $null } | Sort-Object incrTotal | Select-Object -First 1
$worstClean = $results | Where-Object { $_.cleanTotal -ne $null } | Sort-Object cleanTotal -Descending | Select-Object -First 1

$summary = @(
    ("evidence=compile-only-stress"),
    ("builtin_block_generator_coverage=false"),
    ("hardware_tested=false"),
    ("suite_count={0}" -f $results.Count),
    ("ok={0}" -f $allOk),
    ("fail={0}" -f $allFail),
    ("uno_count={0}" -f $uno.Count),
    ("esp32_count={0}" -f $esp32.Count),
    ("mutation_sampled={0}" -f $mutatedCount),
    ("best_incremental={0}:{1}s" -f $bestIncr.name, $bestIncr.incrTotal),
    ("worst_clean={0}:{1}s" -f $worstClean.name, $worstClean.cleanTotal),
    ("csv={0}" -f $csvFile),
    ("json={0}" -f $jsonFile),
    ("failures={0}" -f $failureDir)
)
$summary | Set-Content -Path $summaryFile -Encoding UTF8
$summary | ForEach-Object { Write-Host $_ }

if ($allFail -gt 0) {
    exit 1
}
