[CmdletBinding()]
param(
    [string]$OutputDirectory = '',
    [string[]]$Package = @()
)

$ErrorActionPreference = 'Stop'
$root = [System.IO.Path]::GetFullPath($PSScriptRoot)
$repoRoot = [System.IO.Path]::GetFullPath((Join-Path $root '..\..'))
$packageValidator = Join-Path $repoRoot 'scripts\Validate-ImportablePackage.mjs'
$boardValidator = Join-Path $repoRoot 'scripts\Validate-BoardPackage.mjs'
if ([string]::IsNullOrWhiteSpace($OutputDirectory)) {
    $OutputDirectory = $root
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

function Test-SafePackageRelativePath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value) -or
        [System.IO.Path]::IsPathRooted($Value) -or
        $Value.Contains('\') -or
        $Value -match '[:*?"<>|\x00-\x1f\x7f]') {
        return $false
    }
    $segments = @($Value -split '/')
    return $segments.Count -gt 0 -and -not ($segments | Where-Object {
        [string]::IsNullOrEmpty($_) -or $_ -in @('.', '..')
    })
}

function Get-DeterministicPackageFiles {
    param([string]$PackagePath)

    $resolvedPackage = [System.IO.Path]::GetFullPath($PackagePath).TrimEnd('\', '/')
    $prefix = $resolvedPackage + [System.IO.Path]::DirectorySeparatorChar
    $fileMap = @{}
    foreach ($item in @(Get-ChildItem -LiteralPath $resolvedPackage -Recurse -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Symbolic links and junctions are forbidden: $($item.FullName)"
        }
        if ($item.PSIsContainer) { continue }
        $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
        if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "Package file escapes source root: $fullPath"
        }
        $relativePath = $fullPath.Substring($prefix.Length).Replace('\', '/')
        if (-not (Test-SafePackageRelativePath $relativePath)) {
            throw "Unsafe package path: $relativePath"
        }
        $caseKey = $relativePath.ToLowerInvariant()
        if ($fileMap.ContainsKey($caseKey)) {
            throw "Case-insensitive duplicate package path: $relativePath"
        }
        $fileMap[$caseKey] = [pscustomobject]@{
            RelativePath = $relativePath
            FullPath = $fullPath
        }
    }
    $files = @($fileMap.Values)
    [System.Array]::Sort(
        $files,
        [System.Collections.Generic.Comparer[object]]::Create(
            [System.Comparison[object]]{
                param($left, $right)
                return [System.StringComparer]::Ordinal.Compare(
                    [string]$left.RelativePath,
                    [string]$right.RelativePath
                )
            }
        )
    )
    return $files
}

function New-DeterministicPackageArchive {
    param(
        [string]$PackagePath,
        [string]$PackageName,
        [string]$ArchivePath,
        [object[]]$Files
    )

    $temporaryPath = $ArchivePath + '.tmp'
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }

    $archiveStream = $null
    $archive = $null
    try {
        $archiveStream = [System.IO.File]::Open(
            $temporaryPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::ReadWrite,
            [System.IO.FileShare]::None
        )
        $archive = [System.IO.Compression.ZipArchive]::new(
            $archiveStream,
            [System.IO.Compression.ZipArchiveMode]::Create,
            $false,
            [System.Text.Encoding]::UTF8
        )
        $fixedTimestamp = [System.DateTimeOffset]::new(
            1980, 1, 1, 0, 0, 0, [System.TimeSpan]::Zero
        )
        foreach ($file in $Files) {
            $entryName = "$PackageName/$($file.RelativePath)"
            $entry = $archive.CreateEntry(
                $entryName,
                [System.IO.Compression.CompressionLevel]::Optimal
            )
            $entry.LastWriteTime = $fixedTimestamp
            $input = $null
            $output = $null
            try {
                $input = [System.IO.File]::OpenRead([string]$file.FullPath)
                $output = $entry.Open()
                $input.CopyTo($output)
            }
            finally {
                if ($null -ne $output) { $output.Dispose() }
                if ($null -ne $input) { $input.Dispose() }
            }
        }
    }
    finally {
        if ($null -ne $archive) { $archive.Dispose() }
        if ($null -ne $archiveStream) { $archiveStream.Dispose() }
    }

    if (Test-Path -LiteralPath $ArchivePath -PathType Leaf) {
        Remove-Item -LiteralPath $ArchivePath -Force
    }
    Move-Item -LiteralPath $temporaryPath -Destination $ArchivePath

    $expectedEntries = [string[]]@($Files | ForEach-Object {
        "$PackageName/$($_.RelativePath)"
    })
    $readStream = $null
    $readArchive = $null
    try {
        $readStream = [System.IO.File]::OpenRead($ArchivePath)
        $readArchive = [System.IO.Compression.ZipArchive]::new(
            $readStream,
            [System.IO.Compression.ZipArchiveMode]::Read,
            $false,
            [System.Text.Encoding]::UTF8
        )
        $actualEntries = [string[]]@($readArchive.Entries | ForEach-Object { $_.FullName })
        if ($actualEntries.Count -ne $expectedEntries.Count) {
            throw "Archive entry count mismatch for $PackageName"
        }
        for ($index = 0; $index -lt $expectedEntries.Count; $index += 1) {
            if ($actualEntries[$index] -cne $expectedEntries[$index]) {
                throw "Archive entry mismatch for $PackageName at ${index}: '$($actualEntries[$index])'"
            }
        }
    }
    finally {
        if ($null -ne $readArchive) { $readArchive.Dispose() }
        if ($null -ne $readStream) { $readStream.Dispose() }
    }
}

$packages = @(
    [pscustomobject]@{
        Directory = 'ck_example_nano_board'
        Kind = 'Board'
        Manifest = 'board.json'
        Archive = 'ck_example_nano_board.zip'
        CoreVersion = '1.8.6'
        RequiredFiles = @('board.json', 'README.md', 'assets/board.webp', 'LICENSE')
    },
    [pscustomobject]@{
        Directory = 'ck_example_c6_board'
        Kind = 'Board'
        Manifest = 'board.json'
        Archive = 'ck_example_c6_board.zip'
        CoreVersion = '3.3.6'
        RequiredFiles = @(
            'board.json',
            'README.md',
            'assets/board.svg',
            'smoke/wifi_compile/wifi_compile.ino',
            'smoke/zigbee_compile/zigbee_compile.ino',
            'libraries/ck_example_c6_native/library.json',
            'libraries/ck_example_c6_native/library.properties',
            'libraries/ck_example_c6_native/src/CKExampleC6Native.h',
            'libraries/ck_example_c6_native/src/CKExampleC6Native.c',
            'libraries/ck_example_c6_native/src/vendor/protocol/codec.h',
            'libraries/ck_example_c6_native/src/vendor/protocol/codec.c',
            'libraries/ck_example_c6_native/LICENSE',
            'LICENSE'
        )
    },
    [pscustomobject]@{
        Directory = 'ck_example_serial_blocks'
        Kind = 'Block'
        Manifest = 'library.json'
        Archive = 'ck_example_serial_blocks.zip'
        RequiredFiles = @(
            'library.json',
            'ck-blocks.json',
            'README.md',
            'blocks/blocks.json',
            'blocks/ck-generator.json',
            'blocks/toolbox.xml',
            'LICENSE'
        )
    },
    [pscustomobject]@{
        Directory = 'ck_example_i2c_sensor_v2'
        Kind = 'Block'
        Manifest = 'library.json'
        Archive = 'ck_example_i2c_sensor_v2.zip'
        RequiredFiles = @(
            'library.json',
            'library.properties',
            'ck-blocks.json',
            'ck-migrations.json',
            'README.md',
            'blocks/blocks.json',
            'blocks/ck-generator.json',
            'blocks/toolbox.xml',
            'src/CKExampleSensor.h',
            'src/CKExampleSensor.cpp',
            'src/CKExampleSensorMath.c',
            'src/internal/CKExampleSensorCodec.h',
            'src/internal/CKExampleSensorCodec.c',
            'examples/serial_temperature/serial_temperature.ino',
            'migration-fixtures/legacy-1.5.0.workspace.json',
            'LICENSE'
        )
    },
    [pscustomobject]@{
        Directory = 'ck_example_native_deep'
        Kind = 'Native'
        Manifest = 'library.json'
        Archive = 'ck_example_native_deep.zip'
        RequiredFiles = @(
            'library.json',
            'library.properties',
            'README.md',
            'LICENSE',
            'src/CKNativeDeep.h',
            'src/foo.c',
            'src/driver/CKNativeDriver.h',
            'src/driver/foo.cpp',
            'src/vendor/deep/codec.h',
            'src/vendor/deep/foo.c',
            'examples/native_deep_smoke/native_deep_smoke.ino'
        )
    }
)

$selectedNames = @($Package | ForEach-Object { $_ -split ',' } | Where-Object {
    -not [string]::IsNullOrWhiteSpace($_)
})
if ($selectedNames.Count -gt 0) {
    foreach ($selectedName in $selectedNames) {
        if ($selectedName -notin @($packages.Directory)) {
            throw "Unknown example package selection: $selectedName"
        }
    }
    $packages = @($packages | Where-Object { $_.Directory -in $selectedNames })
}

if (-not (Test-Path -LiteralPath $OutputDirectory -PathType Container)) {
    New-Item -ItemType Directory -Path $OutputDirectory -Force | Out-Null
}
$resolvedOutput = [System.IO.Path]::GetFullPath((Resolve-Path -LiteralPath $OutputDirectory).Path)

foreach ($descriptor in $packages) {
    $packagePath = [System.IO.Path]::GetFullPath((Join-Path $root $descriptor.Directory))
    if (-not (Test-Path -LiteralPath $packagePath -PathType Container)) {
        throw "Package directory not found: $packagePath"
    }
    $packagePrefix = $packagePath.TrimEnd('\', '/') + [System.IO.Path]::DirectorySeparatorChar
    if ($resolvedOutput.StartsWith($packagePrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "Output directory must not be inside package source: $resolvedOutput"
    }

    $files = @(Get-DeterministicPackageFiles $packagePath)
    $fileNames = @($files | ForEach-Object { [string]$_.RelativePath })
    foreach ($relativePath in $descriptor.RequiredFiles) {
        if (-not (Test-SafePackageRelativePath $relativePath)) {
            throw "Unsafe required package path: $relativePath"
        }
        if ($relativePath -cnotin $fileNames) {
            throw "Required package file not found: $($descriptor.Directory)/$relativePath"
        }
    }

    $manifestPath = Join-Path $packagePath $descriptor.Manifest
    $manifest = Get-Content -LiteralPath $manifestPath -Raw -Encoding UTF8 | ConvertFrom-Json
    if ([string]::IsNullOrWhiteSpace([string]$manifest.id)) {
        throw "$($descriptor.Manifest) must contain a non-empty id: $manifestPath"
    }
    if ([string]$manifest.id -cne $descriptor.Directory) {
        throw "Manifest id '$($manifest.id)' must match directory '$($descriptor.Directory)'"
    }

    if ($descriptor.Kind -eq 'Board') {
        & node $boardValidator $packagePath --core-version $descriptor.CoreVersion
        if ($LASTEXITCODE -ne 0) {
            throw "Board package declaration validation failed: $packagePath"
        }
    }
    else {
        $validatorKind = $descriptor.Kind.ToLowerInvariant()
        & node $packageValidator $packagePath --kind $validatorKind
        if ($LASTEXITCODE -ne 0) {
            throw "$($descriptor.Kind) package declaration validation failed: $packagePath"
        }
    }

    $archivePath = Join-Path $resolvedOutput $descriptor.Archive
    New-DeterministicPackageArchive `
        -PackagePath $packagePath `
        -PackageName $descriptor.Directory `
        -ArchivePath $archivePath `
        -Files $files
    $hash = (Get-FileHash -LiteralPath $archivePath -Algorithm SHA256).Hash.ToLowerInvariant()
    Write-Host "Built $($descriptor.Archive) ($($files.Count) files, sha256=$hash)"
}
