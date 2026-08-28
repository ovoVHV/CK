param(
    [string]$Root = '',
    [string]$EvidenceDirectory = '',
    [string]$JsonOutputPath = '',
    [string]$MarkdownOutputPath = '',
    [double]$MaxAgeHours = 168,
    [switch]$NoWrite,
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

if ([string]::IsNullOrWhiteSpace($EvidenceDirectory)) {
    $EvidenceDirectory = Join-Path $Root 'artifacts\benchmarks'
}
if ([string]::IsNullOrWhiteSpace($JsonOutputPath)) {
    $JsonOutputPath = Join-Path $Root 'artifacts\benchmarks\compile-regression-summary.json'
}
if ([string]::IsNullOrWhiteSpace($MarkdownOutputPath)) {
    $MarkdownOutputPath = Join-Path $Root 'artifacts\benchmarks\compile-regression-summary.md'
}

$arguments = @(
    (Join-Path $Root 'scripts\Summarize-CompileRegression.mjs'),
    '--evidence-dir', $EvidenceDirectory,
    '--json', $JsonOutputPath,
    '--markdown', $MarkdownOutputPath,
    '--max-age-hours', ([string]$MaxAgeHours)
)
if ($NoWrite) { $arguments += '--no-write' }
if ($Strict) { $arguments += '--strict' }

& node @arguments
if ($LASTEXITCODE -ne 0) {
    exit $LASTEXITCODE
}
