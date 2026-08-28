param(
    [string]$Root = '',
    [string[]]$InputPath = @(),
    [string]$InputDirectory = '',
    [string]$OutputPath = '',
    [switch]$Strict
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$hasInputPath = @($InputPath | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }).Count -gt 0
$hasInputDirectory = -not [string]::IsNullOrWhiteSpace($InputDirectory)
if (-not $hasInputPath -and -not $hasInputDirectory) {
    throw 'At least one -InputPath or -InputDirectory is required.'
}

if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root 'artifacts\release\first-compile-performance-summary.json'
}

$arguments = @(
    (Join-Path $Root 'scripts\Summarize-FirstCompilePerformance.mjs'),
    '--root', $Root,
    '--output', $OutputPath
)

foreach ($path in $InputPath) {
    if (-not [string]::IsNullOrWhiteSpace($path)) {
        $arguments += @('--input', $path)
    }
}
if ($hasInputDirectory) {
    $arguments += @('--input-dir', $InputDirectory)
}
if ($Strict) {
    $arguments += '--strict'
}

& node @arguments
$nodeExitCode = $LASTEXITCODE
exit $nodeExitCode
