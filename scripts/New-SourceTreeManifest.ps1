param(
    [ValidateSet('Create', 'Verify')]
    [string]$Mode = 'Create',
    [string]$Root = '',
    [string]$ManifestPath = '',
    [string]$FreezeRecordPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$policyId = 'ck-source-tree-v1'
$includedDirectories = @(
    '.cargo',
    'apps/desktop',
    'crates',
    'docs',
    'examples',
    'scripts'
)
$includedFiles = @(
    'Cargo.lock',
    'Cargo.toml',
    'README.md',
    'tools/ccache.exe'
)
$excludedDirectoryNames = @(
    '.git',
    '.idea',
    '.turbo',
    '.vite',
    '.vscode',
    'artifacts',
    'cache',
    'coverage',
    'dist',
    'node_modules',
    'packages',
    'prebuilt_cores',
    'state',
    'target',
    'target-ui-fix',
    'tmp'
)
$excludedFileNames = @('.DS_Store', 'Thumbs.db')
$excludedFileExtensions = @('.bak', '.log', '.swo', '.swp', '.tmp')

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Get-RelativePathSafe {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $base = Get-FullPath -Path $BasePath
    $candidate = [System.IO.Path]::GetFullPath($Path)
    $prefix = "$base$([System.IO.Path]::DirectorySeparatorChar)"
    if (-not $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "path escapes source root: $candidate"
    }
    return $candidate.Substring($prefix.Length).Replace('\', '/')
}

function Test-PathWithin {
    param(
        [Parameter(Mandatory = $true)][string]$Parent,
        [Parameter(Mandatory = $true)][string]$Child
    )

    $parentFull = Get-FullPath -Path $Parent
    $childFull = [System.IO.Path]::GetFullPath($Child)
    $prefix = "$parentFull$([System.IO.Path]::DirectorySeparatorChar)"
    return $childFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Get-Sha256HexFromBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)

    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally {
        $sha.Dispose()
    }
}

function Get-Sha256HexFromFile {
    param([Parameter(Mandatory = $true)][string]$Path)

    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            $hash = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
            return [ordered]@{
                bytes = [int64]$stream.Length
                sha256 = $hash
            }
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Test-ExcludedDirectoryName {
    param([Parameter(Mandatory = $true)][string]$Name)

    return $excludedDirectoryNames -contains $Name
}

function Test-ExcludedFile {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$RelativePath
    )

    if ($excludedFileNames -contains $File.Name) { return $true }
    if ($excludedFileExtensions -contains $File.Extension.ToLowerInvariant()) { return $true }
    # Build-Examples.ps1 deterministically regenerates these five archives.
    # They are release outputs, while the sibling directories are the inputs.
    if ($RelativePath.StartsWith('examples/importable-packages/', [System.StringComparison]::OrdinalIgnoreCase) -and
        $File.Extension.Equals('.zip', [System.StringComparison]::OrdinalIgnoreCase)) {
        return $true
    }
    return $false
}

function Add-IncludedDirectoryFiles {
    param(
        [Parameter(Mandatory = $true)][string]$Directory,
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][System.Collections.Generic.List[string]]$Paths
    )

    $directoryInfo = Get-Item -LiteralPath $Directory -Force
    if (($directoryInfo.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
        throw "included directory must not be a reparse point: $($directoryInfo.FullName)"
    }
    foreach ($entry in @(Get-ChildItem -LiteralPath $directoryInfo.FullName -Force)) {
        if (($entry.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "source tree contains a reparse point: $($entry.FullName)"
        }
        if ($entry.PSIsContainer) {
            if (-not (Test-ExcludedDirectoryName -Name $entry.Name)) {
                Add-IncludedDirectoryFiles -Directory $entry.FullName -Paths $Paths
            }
            continue
        }
        $relative = Get-RelativePathSafe -BasePath $script:rootFull -Path $entry.FullName
        if (-not (Test-ExcludedFile -File $entry -RelativePath $relative)) {
            $Paths.Add($entry.FullName)
        }
    }
}

function Get-SourceTreeInventory {
    $absolutePaths = [System.Collections.Generic.List[string]]::new()
    foreach ($relativeDirectory in $includedDirectories) {
        $directory = Join-Path $script:rootFull $relativeDirectory
        if (-not (Test-Path -LiteralPath $directory -PathType Container)) {
            throw "required source directory is missing: $relativeDirectory"
        }
        Add-IncludedDirectoryFiles -Directory $directory -Paths $absolutePaths
    }
    foreach ($relativeFile in $includedFiles) {
        $file = Join-Path $script:rootFull $relativeFile
        if (-not (Test-Path -LiteralPath $file -PathType Leaf)) {
            throw "required release input is missing: $relativeFile"
        }
        $item = Get-Item -LiteralPath $file -Force
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "release input must not be a reparse point: $($item.FullName)"
        }
        $absolutePaths.Add($item.FullName)
    }

    $recordsByPath = @{}
    $caseInsensitivePaths = [System.Collections.Generic.HashSet[string]]::new(
        [System.StringComparer]::OrdinalIgnoreCase
    )
    foreach ($absolutePath in $absolutePaths) {
        $relativePath = Get-RelativePathSafe -BasePath $script:rootFull -Path $absolutePath
        if ($relativePath.IndexOfAny([char[]]@(0, 9, 10, 13)) -ge 0) {
            throw "source path contains a forbidden control character: $relativePath"
        }
        if (-not $caseInsensitivePaths.Add($relativePath)) {
            throw "duplicate or case-colliding source path: $relativePath"
        }
        $digest = Get-Sha256HexFromFile -Path $absolutePath
        $recordsByPath[$relativePath] = [ordered]@{
            path = $relativePath
            bytes = [int64]$digest.bytes
            sha256 = [string]$digest.sha256
        }
    }

    $sortedPaths = [string[]]@($recordsByPath.Keys)
    [System.Array]::Sort($sortedPaths, [System.StringComparer]::Ordinal)
    $records = [System.Collections.Generic.List[object]]::new()
    $treeRows = [System.Text.StringBuilder]::new()
    $totalBytes = [int64]0
    foreach ($relativePath in $sortedPaths) {
        $record = $recordsByPath[$relativePath]
        $records.Add($record)
        $totalBytes += [int64]$record.bytes
        [void]$treeRows.Append($record.path)
        [void]$treeRows.Append("`t")
        [void]$treeRows.Append(([int64]$record.bytes).ToString([System.Globalization.CultureInfo]::InvariantCulture))
        [void]$treeRows.Append("`t")
        [void]$treeRows.Append($record.sha256)
        [void]$treeRows.Append("`n")
    }
    $utf8 = [System.Text.UTF8Encoding]::new($false)
    $treeSha256 = Get-Sha256HexFromBytes -Bytes $utf8.GetBytes($treeRows.ToString())
    return [ordered]@{
        records = $records.ToArray()
        file_count = $records.Count
        total_bytes = $totalBytes
        tree_sha256 = $treeSha256
    }
}

function New-CanonicalManifest {
    param([Parameter(Mandatory = $true)]$Inventory)

    $manifest = [ordered]@{
        schema_version = 1
        policy_id = $policyId
        hash_algorithm = 'sha256'
        tree_hash_encoding = 'utf-8-without-bom'
        tree_hash_record_format = 'relative_path<TAB>bytes<TAB>sha256<LF>'
        source_control = [ordered]@{
            kind = 'none'
            commit = $null
        }
        selection = [ordered]@{
            included_directories = $includedDirectories
            included_files = $includedFiles
            excluded_directory_names = $excludedDirectoryNames
            excluded_file_names = $excludedFileNames
            excluded_file_extensions = $excludedFileExtensions
            excluded_path_rules = @('examples/importable-packages/*.zip')
            excluded_workspace_classes = @(
                'build outputs and release evidence',
                'dependency and board-core caches',
                'temporary files',
                'user projects, installed libraries and mutable application state'
            )
        }
        file_count = [int]$Inventory.file_count
        total_bytes = [int64]$Inventory.total_bytes
        tree_sha256 = [string]$Inventory.tree_sha256
        files = $Inventory.records
    }
    # frozen_at deliberately does not belong here. The returned bytes are a
    # deterministic function of the selected paths and their contents.
    return (($manifest | ConvertTo-Json -Depth 8 -Compress) + "`n")
}

function Write-Utf8NoBomAtomic {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Content
    )

    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    $temporary = "$Path.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, $Content, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $Path -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function Get-InventoryDifferenceSummary {
    param(
        [Parameter(Mandatory = $true)]$Expected,
        [Parameter(Mandatory = $true)]$Actual
    )

    $expectedMap = @{}
    foreach ($file in @($Expected.files)) { $expectedMap[[string]$file.path] = $file }
    $actualMap = @{}
    foreach ($file in @($Actual.files)) { $actualMap[[string]$file.path] = $file }
    $added = @($actualMap.Keys | Where-Object { -not $expectedMap.ContainsKey($_) } | Sort-Object)
    $removed = @($expectedMap.Keys | Where-Object { -not $actualMap.ContainsKey($_) } | Sort-Object)
    $changed = @($actualMap.Keys | Where-Object {
            $expectedMap.ContainsKey($_) -and
            [string]$expectedMap[$_].sha256 -cne [string]$actualMap[$_].sha256
        } | Sort-Object)
    $parts = @()
    if ($added.Count -gt 0) { $parts += "added=$($added[0..([Math]::Min(4, $added.Count - 1))] -join ',')" }
    if ($removed.Count -gt 0) { $parts += "removed=$($removed[0..([Math]::Min(4, $removed.Count - 1))] -join ',')" }
    if ($changed.Count -gt 0) { $parts += "changed=$($changed[0..([Math]::Min(4, $changed.Count - 1))] -join ',')" }
    if ($parts.Count -eq 0) { return 'canonical manifest metadata differs' }
    return ($parts -join '; ')
}

$rootFull = Get-FullPath -Path $Root
if (Test-Path -LiteralPath (Join-Path $rootFull '.git')) {
    throw 'this tool is only for a workspace without Git metadata; do not replace a real commit with a synthetic identity'
}
if ([string]::IsNullOrWhiteSpace($ManifestPath)) {
    $ManifestPath = Join-Path $rootFull 'artifacts\release\source-tree-manifest.json'
}
if ([string]::IsNullOrWhiteSpace($FreezeRecordPath)) {
    $FreezeRecordPath = Join-Path $rootFull 'artifacts\release\source-tree-freeze.json'
}
$manifestFull = [System.IO.Path]::GetFullPath($ManifestPath)
$freezeFull = [System.IO.Path]::GetFullPath($FreezeRecordPath)
if ($manifestFull.Equals($freezeFull, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw 'manifest and freeze record must use different paths'
}
foreach ($output in @($manifestFull, $freezeFull)) {
    if (-not (Test-PathWithin -Parent $rootFull -Child $output)) {
        throw "freeze output must stay inside the workspace root: $output"
    }
    foreach ($includedDirectory in $includedDirectories) {
        if (Test-PathWithin -Parent (Join-Path $rootFull $includedDirectory) -Child $output) {
            throw "freeze output must not be written inside a hashed source directory: $output"
        }
    }
    foreach ($includedFile in $includedFiles) {
        if ($output.Equals([System.IO.Path]::GetFullPath((Join-Path $rootFull $includedFile)), [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "freeze output conflicts with a hashed release input: $output"
        }
    }
}

# Two consecutive passes make additions, deletions and in-place changes during
# capture fail closed instead of silently producing a mixed-time snapshot.
$firstInventory = Get-SourceTreeInventory
$secondInventory = Get-SourceTreeInventory
$firstCanonical = New-CanonicalManifest -Inventory $firstInventory
$canonicalManifest = New-CanonicalManifest -Inventory $secondInventory
if ($firstCanonical -cne $canonicalManifest) {
    throw 'source tree changed while the manifest was being calculated; stop writers and retry'
}

if ($Mode -eq 'Create') {
    Write-Utf8NoBomAtomic -Path $manifestFull -Content $canonicalManifest
    $manifestDigest = Get-Sha256HexFromFile -Path $manifestFull
    $freezeRecord = [ordered]@{
        schema_version = 1
        policy_id = $policyId
        frozen_at = [DateTimeOffset]::UtcNow.ToString('o')
        source_control = [ordered]@{
            kind = 'none'
            commit = $null
        }
        manifest_path = Get-RelativePathSafe -BasePath $rootFull -Path $manifestFull
        manifest_sha256 = [string]$manifestDigest.sha256
        tree_sha256 = [string]$secondInventory.tree_sha256
        file_count = [int]$secondInventory.file_count
        total_bytes = [int64]$secondInventory.total_bytes
    }
    Write-Utf8NoBomAtomic -Path $freezeFull -Content (($freezeRecord | ConvertTo-Json -Depth 5 -Compress) + "`n")
    Write-Host "Source tree manifest: $manifestFull"
    Write-Host "Source tree manifest SHA-256: $($manifestDigest.sha256)"
    Write-Host "Source tree SHA-256: $($secondInventory.tree_sha256)"
    Write-Host "Freeze record: $freezeFull"
    exit 0
}

if (-not (Test-Path -LiteralPath $manifestFull -PathType Leaf)) {
    throw "source tree manifest is missing: $manifestFull"
}
if (-not (Test-Path -LiteralPath $freezeFull -PathType Leaf)) {
    throw "source tree freeze record is missing: $freezeFull"
}
$storedManifestText = [System.IO.File]::ReadAllText($manifestFull, [System.Text.UTF8Encoding]::new($false))
$storedManifest = $storedManifestText | ConvertFrom-Json
if ($null -ne $storedManifest.frozen_at) {
    throw 'frozen_at must be stored only in the separate freeze record'
}
if ($storedManifestText -cne $canonicalManifest) {
    $actual = $canonicalManifest | ConvertFrom-Json
    $summary = Get-InventoryDifferenceSummary -Expected $storedManifest -Actual $actual
    throw "source tree no longer matches frozen manifest: $summary"
}
$manifestDigest = Get-Sha256HexFromFile -Path $manifestFull
$freeze = ([System.IO.File]::ReadAllText($freezeFull, [System.Text.UTF8Encoding]::new($false))) | ConvertFrom-Json
if ([string]$freeze.policy_id -cne $policyId) { throw 'freeze record policy_id does not match the current policy' }
if ([string]$freeze.source_control.kind -cne 'none' -or $null -ne $freeze.source_control.commit) {
    throw 'freeze record must not claim a Git commit for this no-Git workspace'
}
if ([string]::IsNullOrWhiteSpace([string]$freeze.frozen_at)) { throw 'freeze record is missing frozen_at' }
if ([string]$freeze.manifest_sha256 -cne [string]$manifestDigest.sha256) {
    throw 'freeze record manifest_sha256 does not match the manifest bytes'
}
if ([string]$freeze.tree_sha256 -cne [string]$secondInventory.tree_sha256) {
    throw 'freeze record tree_sha256 does not match the current source tree'
}
if ([int]$freeze.file_count -ne [int]$secondInventory.file_count -or
    [int64]$freeze.total_bytes -ne [int64]$secondInventory.total_bytes) {
    throw 'freeze record file count or byte count does not match the current source tree'
}
Write-Host "Source tree freeze verified: $manifestFull"
Write-Host "Source tree manifest SHA-256: $($manifestDigest.sha256)"
Write-Host "Source tree SHA-256: $($secondInventory.tree_sha256)"
