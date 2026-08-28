[CmdletBinding()]
param(
    [Parameter(Mandatory = $true)]
    [string]$ArchivePath
)

$ErrorActionPreference = 'Stop'

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$MaxEntryCount = 4096
$MaxEntryBytes = 32MB
$MaxTotalBytes = 256MB
$MaxCompressionRatio = 500.0

function Test-SafeSdkPath {
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

function Read-ZipEntryUtf8 {
    param(
        [System.IO.Compression.ZipArchive]$Archive,
        [string]$EntryPath
    )
    $entry = $Archive.GetEntry($EntryPath)
    if ($null -eq $entry) { throw "Required SDK entry is missing: $EntryPath" }
    $reader = $null
    try {
        $reader = [System.IO.StreamReader]::new(
            $entry.Open(),
            [System.Text.Encoding]::UTF8,
            $true
        )
        return $reader.ReadToEnd().TrimStart([char]0xFEFF)
    }
    finally {
        if ($null -ne $reader) { $reader.Dispose() }
    }
}

$resolvedArchive = [System.IO.Path]::GetFullPath($ArchivePath)
if (-not (Test-Path -LiteralPath $resolvedArchive -PathType Leaf)) {
    throw "SDK archive not found: $resolvedArchive"
}

$stream = $null
$archive = $null
$sha = $null
try {
    $stream = [System.IO.File]::OpenRead($resolvedArchive)
    $archive = [System.IO.Compression.ZipArchive]::new(
        $stream,
        [System.IO.Compression.ZipArchiveMode]::Read,
        $false,
        [System.Text.Encoding]::UTF8
    )
    $allEntries = @($archive.Entries)
    if ($allEntries.Count -gt $MaxEntryCount) {
        throw "SDK archive contains too many entries: $($allEntries.Count) > $MaxEntryCount"
    }
    if ($allEntries | Where-Object { [string]::IsNullOrEmpty($_.Name) }) {
        throw 'SDK archive must not contain standalone directory entries'
    }
    $entries = @($allEntries)
    if ($entries.Count -eq 0) { throw 'SDK archive contains no files' }

    $casePaths = @{}
    $roots = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $previousEntryPath = $null
    [int64]$totalUncompressedBytes = 0
    foreach ($entry in $entries) {
        if ([int64]$entry.Length -gt $MaxEntryBytes) {
            throw "SDK archive entry exceeds the $MaxEntryBytes byte limit: $($entry.FullName)"
        }
        $totalUncompressedBytes += [int64]$entry.Length
        if ($totalUncompressedBytes -gt $MaxTotalBytes) {
            throw "SDK archive exceeds the $MaxTotalBytes byte uncompressed limit"
        }
        if ([int64]$entry.Length -gt 1MB -and [int64]$entry.CompressedLength -gt 0) {
            $ratio = [double]$entry.Length / [double]$entry.CompressedLength
            if ($ratio -gt $MaxCompressionRatio) {
                throw "SDK archive entry has a suspicious compression ratio: $($entry.FullName) = $ratio"
            }
        }
        $externalAttributes = ([int64]$entry.ExternalAttributes -band 0xffffffffL)
        $unixType = (($externalAttributes -shr 16) -band 0xF000)
        if ($unixType -eq 0xA000) {
            throw "SDK archive must not contain symbolic links: $($entry.FullName)"
        }
        if ($unixType -ne 0 -and $unixType -ne 0x8000) {
            throw "SDK archive contains a non-regular file entry: $($entry.FullName)"
        }
        if (-not (Test-SafeSdkPath $entry.FullName)) {
            throw "Unsafe SDK archive path: $($entry.FullName)"
        }
        $root = ($entry.FullName -split '/', 2)[0]
        [void]$roots.Add($root)
        $caseKey = $entry.FullName.ToLowerInvariant()
        if ($casePaths.ContainsKey($caseKey)) {
            throw "Case-insensitive duplicate SDK path: $($entry.FullName)"
        }
        $casePaths[$caseKey] = $entry.FullName
        if ($null -ne $previousEntryPath -and
            [System.StringComparer]::Ordinal.Compare($previousEntryPath, $entry.FullName) -ge 0) {
            throw "SDK archive entries are not in strict ordinal order: $previousEntryPath / $($entry.FullName)"
        }
        $previousEntryPath = $entry.FullName
        # ZIP stores a DOS wall-clock timestamp without a timezone. Compare its
        # calendar fields directly instead of converting the reader's local offset.
        $timestamp = $entry.LastWriteTime
        if ($timestamp.Year -ne 1980 -or $timestamp.Month -ne 1 -or $timestamp.Day -ne 1 -or
            $timestamp.Hour -ne 0 -or $timestamp.Minute -ne 0 -or $timestamp.Second -ne 0) {
            throw "Non-deterministic ZIP timestamp: $($entry.FullName) = $timestamp"
        }
    }
    if ($roots.Count -ne 1) { throw 'SDK archive must contain exactly one root directory' }
    $rootName = @($roots)[0]
    $rootMatch = [regex]::Match(
        $rootName,
        '^CK-Extension-SDK-(?<version>[0-9]+\.[0-9]+\.[0-9]+(?:[-+][0-9A-Za-z.-]+)?)$'
    )
    if (-not $rootMatch.Success) {
        throw "Unexpected SDK root directory: $rootName"
    }
    $rootVersion = $rootMatch.Groups['version'].Value

    $manifestText = Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/manifest.json"
    $manifest = $manifestText | ConvertFrom-Json
    if ([int]$manifest.schema_version -ne 1) { throw 'Unsupported SDK manifest schema_version' }
    if ([string]$manifest.archive_root -cne $rootName) { throw 'SDK manifest archive_root mismatch' }
    if ([string]$manifest.sdk_version -cne $rootVersion) {
        throw "SDK version mismatch: root=$rootVersion manifest=$($manifest.sdk_version)"
    }
    if ([string]$manifest.manifest_scope -cne 'all archive files except manifest.json') {
        throw 'SDK manifest_scope is missing or unsupported'
    }

    $packageJsonText = Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/package.json"
    $packageJson = $packageJsonText | ConvertFrom-Json
    if ([string]$packageJson.version -cne $rootVersion) {
        throw "SDK version mismatch: root=$rootVersion package.json=$($packageJson.version)"
    }
    if ([string]$packageJson.bin.ckpkg -cne 'scripts/ckpkg.mjs') {
        throw 'SDK package.json does not expose scripts/ckpkg.mjs as the ckpkg bin'
    }
    if ([string]$packageJson.license -cne 'Apache-2.0') {
        throw 'SDK package.json license must be Apache-2.0'
    }
    $licenseText = Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/LICENSE"
    if ($licenseText -notmatch 'Apache License\s+Version 2\.0') {
        throw 'SDK root LICENSE is missing the Apache License 2.0 text'
    }
    [void](Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/NOTICE")
    $releaseChannelText = Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/release-channel.json"
    $releaseChannel = $releaseChannelText | ConvertFrom-Json
    if ([int]$releaseChannel.schema_version -ne 1 -or
        [string]$releaseChannel.sdk_version -cne $rootVersion -or
        [string]$releaseChannel.license -cne 'Apache-2.0') {
        throw 'SDK release-channel metadata does not match the archive version and license'
    }
    if ([string]$releaseChannel.artifact_file -cne "$rootName.zip" -or
        [string]$releaseChannel.integrity_metadata_file -cne "$rootName.release.json") {
        throw 'SDK release-channel artifact and sidecar filenames must match the archive identity'
    }
    $publicationStatus = [string]$releaseChannel.publication_status
    if ($publicationStatus -ceq 'local-artifact-ready') {
        if ($null -ne $releaseChannel.public_url) {
            throw 'A local-artifact-ready SDK release must not claim a public URL'
        }
    }
    elseif ($publicationStatus -ceq 'published') {
        $publicUri = $null
        if (-not [System.Uri]::TryCreate([string]$releaseChannel.public_url, [System.UriKind]::Absolute, [ref]$publicUri) -or
            $publicUri.Scheme -cne 'https') {
            throw 'A published SDK release requires an absolute HTTPS public_url'
        }
    }
    else {
        throw "Unsupported SDK publication_status: $publicationStatus"
    }
    $ckpkgSource = Read-ZipEntryUtf8 -Archive $archive -EntryPath "$rootName/scripts/ckpkg.mjs"
    $ckpkgVersionMatch = [regex]::Match(
        $ckpkgSource,
        "export\s+const\s+CKPKG_VERSION\s*=\s*'(?<version>[^']+)'"
    )
    if (-not $ckpkgVersionMatch.Success) {
        throw 'SDK ckpkg source does not expose a static CKPKG_VERSION'
    }
    $ckpkgVersion = $ckpkgVersionMatch.Groups['version'].Value
    if ($ckpkgVersion -cne $rootVersion) {
        throw "SDK version mismatch: root=$rootVersion ckpkg=$ckpkgVersion"
    }

    $manifestPaths = @{}
    $sha = [System.Security.Cryptography.SHA256]::Create()
    $previousManifestPath = $null
    foreach ($file in @($manifest.files)) {
        $relativePath = [string]$file.path
        if (-not (Test-SafeSdkPath $relativePath)) {
            throw "Unsafe path in SDK manifest: $relativePath"
        }
        $caseKey = $relativePath.ToLowerInvariant()
        if ($manifestPaths.ContainsKey($caseKey)) {
            throw "Case-insensitive duplicate manifest path: $relativePath"
        }
        if ($null -ne $previousManifestPath -and
            [System.StringComparer]::Ordinal.Compare($previousManifestPath, $relativePath) -ge 0) {
            throw "SDK manifest paths are not in strict ordinal order: $previousManifestPath / $relativePath"
        }
        $previousManifestPath = $relativePath
        $manifestPaths[$caseKey] = $relativePath
        $entry = $archive.GetEntry("$rootName/$relativePath")
        if ($null -eq $entry) { throw "Manifest file is missing from archive: $relativePath" }
        if ([int64]$file.bytes -ne [int64]$entry.Length) {
            throw "Manifest size mismatch: $relativePath"
        }
        $entryStream = $null
        try {
            $entryStream = $entry.Open()
            $actualHash = ([System.BitConverter]::ToString(
                $sha.ComputeHash($entryStream)
            )).Replace('-', '').ToLowerInvariant()
        }
        finally {
            if ($null -ne $entryStream) { $entryStream.Dispose() }
        }
        if ($actualHash -cne ([string]$file.sha256).ToLowerInvariant()) {
            throw "Manifest SHA-256 mismatch: $relativePath"
        }
    }

    $payloadEntries = @($entries | Where-Object { $_.FullName -cne "$rootName/manifest.json" })
    if ($payloadEntries.Count -ne $manifestPaths.Count) {
        throw 'SDK manifest does not cover every payload file'
    }
    foreach ($entry in $payloadEntries) {
        $relativePath = $entry.FullName.Substring($rootName.Length + 1)
        if (-not $manifestPaths.ContainsKey($relativePath.ToLowerInvariant())) {
            throw "Unmanifested SDK payload: $relativePath"
        }
    }

    Write-Host "Verified $resolvedArchive ($($entries.Count) files, root=$rootName)"
}
finally {
    if ($null -ne $sha) { $sha.Dispose() }
    if ($null -ne $archive) { $archive.Dispose() }
    if ($null -ne $stream) { $stream.Dispose() }
}
