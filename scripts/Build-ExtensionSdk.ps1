[CmdletBinding()]
param(
    [string]$Root = '',
    [string]$Version = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$Root = [System.IO.Path]::GetFullPath($Root).TrimEnd('\', '/')
$packageJsonPath = Join-Path $Root 'docs\extension-sdk\package.json'
$ckpkgSourcePath = Join-Path $Root 'scripts\ckpkg.mjs'
if (-not (Test-Path -LiteralPath $packageJsonPath -PathType Leaf)) {
    throw "SDK package.json not found: $packageJsonPath"
}
if (-not (Test-Path -LiteralPath $ckpkgSourcePath -PathType Leaf)) {
    throw "ckpkg source not found: $ckpkgSourcePath"
}
$packageJson = Get-Content -LiteralPath $packageJsonPath -Raw | ConvertFrom-Json
$embeddedPackageVersion = [string]$packageJson.version
$ckpkgSource = Get-Content -LiteralPath $ckpkgSourcePath -Raw
$ckpkgVersionMatch = [regex]::Match(
    $ckpkgSource,
    "export\s+const\s+CKPKG_VERSION\s*=\s*'(?<version>[^']+)'"
)
if (-not $ckpkgVersionMatch.Success) {
    throw 'ckpkg source does not expose a static CKPKG_VERSION'
}
$embeddedCliVersion = $ckpkgVersionMatch.Groups['version'].Value
$semverPattern = '^(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)\.(0|[1-9][0-9]*)(?:-[0-9A-Za-z.-]+)?(?:\+[0-9A-Za-z.-]+)?$'
if ($embeddedPackageVersion -notmatch $semverPattern) {
    throw "SDK package.json version must be SemVer: $embeddedPackageVersion"
}
if ($embeddedCliVersion -cne $embeddedPackageVersion) {
    throw "SDK embedded version mismatch: package.json=$embeddedPackageVersion ckpkg=$embeddedCliVersion"
}
if ([string]::IsNullOrWhiteSpace($Version)) {
    $Version = $embeddedPackageVersion
}
if ($Version -notmatch $semverPattern) {
    throw "SDK version must be SemVer: $Version"
}
if ($Version -cne $embeddedPackageVersion) {
    throw "Requested SDK version $Version does not match embedded tool version $embeddedPackageVersion"
}
$sdkRootName = "CK-Extension-SDK-$Version"
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root "artifacts\release\$sdkRootName.zip"
}
$OutputPath = [System.IO.Path]::GetFullPath($OutputPath)
if ([System.IO.Path]::GetFileName($OutputPath) -cne "$sdkRootName.zip") {
    throw "SDK output filename must be $sdkRootName.zip so archive and release metadata identities cannot diverge"
}

Add-Type -AssemblyName System.IO.Compression
Add-Type -AssemblyName System.IO.Compression.FileSystem

$documentation = @(
    'docs/blockly-library-package-standard.md',
    'docs/block-package-migration-v1.md',
    'docs/extension-sdk/ckpkg.md',
    'docs/extension-sdk/sensor-library-tutorial.md',
    'docs/package-quality-gates.md',
    'docs/third-party-board-passport.md'
)
$sdkRootFiles = @(
    'docs/extension-sdk/LICENSE',
    'docs/extension-sdk/NOTICE',
    'docs/extension-sdk/release-channel.json'
)
$schemas = @(
    'docs/schemas/ck-blocks.schema.json',
    'docs/schemas/ck-blocks-v2.schema.json',
    'docs/schemas/ck-board.schema.json',
    'docs/schemas/ck-board-lock.schema.json',
    'docs/schemas/ck-extension-sdk-release-artifact.schema.json',
    'docs/schemas/ck-extension-sdk-release-channel.schema.json',
    'docs/schemas/ck-generator.schema.json',
    'docs/schemas/ck-library.schema.json',
    'docs/schemas/ck-migrations.schema.json',
    'docs/schemas/ck-package-quality-report.schema.json'
)
$validationScripts = @(
    'scripts/ckpkg.mjs',
    'scripts/ckpkg.test.mjs',
    'scripts/JsonSchemaValidator.mjs',
    'scripts/Validate-BoardPackage.mjs',
    'scripts/Validate-ImportablePackage.mjs',
    'scripts/Validate-PackageSchemas.test.mjs',
    'scripts/Verify-ExtensionSdk.ps1'
)
$exampleSupportFiles = @(
    'docs/extension-sdk/ckpkg-github-actions.yml',
    'docs/extension-sdk/ckpkg-trusted-github-actions.yml',
    'docs/extension-sdk/package.json',
    'examples/importable-packages/Build-Examples.ps1',
    'examples/importable-packages/README.md'
)
$exampleDirectories = @(
    'ck_example_nano_board',
    'ck_example_c6_board',
    'ck_example_serial_blocks',
    'ck_example_i2c_sensor_v2',
    'ck_example_native_deep'
)
$exampleArchives = @($exampleDirectories | ForEach-Object { "$_.zip" })

function Test-SafeSdkRelativePath {
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

function Test-ForbiddenSdkSourcePath {
    param([string]$Value)
    $segments = @($Value -split '/')
    $forbiddenDirectories = @(
        '.git', '.svn', '.hg', 'node_modules', 'target', 'cache', 'caches',
        'tmp', 'temp', 'out', 'dist', '__pycache__', 'negative-fixtures',
        'negative_fixtures', 'malicious-fixtures', 'malicious_fixtures'
    )
    if ($segments | Where-Object { $_.ToLowerInvariant() -in $forbiddenDirectories }) {
        return $true
    }
    $leaf = $segments[$segments.Count - 1].ToLowerInvariant()
    if ($leaf -in @(
        '.ds_store', 'thumbs.db', 'desktop.ini', '.ck-quality-report.json',
        '.ck-installed.json', '.ck-install.json'
    )) {
        return $true
    }
    return $leaf -match '\.(tmp|temp|log|bak|swp|swo|pyc)$'
}

function Get-OrdinalFiles {
    param(
        [string]$BasePath,
        [switch]$RejectDevelopmentArtifacts
    )
    $resolvedBase = [System.IO.Path]::GetFullPath($BasePath).TrimEnd('\', '/')
    if (-not (Test-Path -LiteralPath $resolvedBase -PathType Container)) {
        throw "Source directory not found: $resolvedBase"
    }
    $prefix = $resolvedBase + [System.IO.Path]::DirectorySeparatorChar
    $caseMap = @{}
    $files = [System.Collections.Generic.List[object]]::new()
    foreach ($item in @(Get-ChildItem -LiteralPath $resolvedBase -Recurse -Force)) {
        if (($item.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Symbolic links and junctions are forbidden in SDK sources: $($item.FullName)"
        }
        if ($item.PSIsContainer) { continue }
        $fullPath = [System.IO.Path]::GetFullPath($item.FullName)
        if (-not $fullPath.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
            throw "SDK source escapes its root: $fullPath"
        }
        $relativePath = $fullPath.Substring($prefix.Length).Replace('\', '/')
        if (-not (Test-SafeSdkRelativePath $relativePath)) {
            throw "Unsafe SDK source path: $relativePath"
        }
        if ($RejectDevelopmentArtifacts -and (Test-ForbiddenSdkSourcePath $relativePath)) {
            throw "Temporary, cached, or negative fixture content must not enter the SDK: $relativePath"
        }
        $caseKey = $relativePath.ToLowerInvariant()
        if ($caseMap.ContainsKey($caseKey)) {
            throw "Case-insensitive duplicate SDK source path: $relativePath"
        }
        $caseMap[$caseKey] = $relativePath
        $files.Add([pscustomobject]@{ RelativePath = $relativePath; FullPath = $fullPath })
    }
    $array = [object[]]$files.ToArray()
    [System.Array]::Sort(
        $array,
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
    return $array
}

function Copy-SdkFile {
    param(
        [string]$SourcePath,
        [string]$DestinationRoot,
        [string]$RelativePath,
        [string]$AllowedSourceRoot = $Root
    )
    if (-not (Test-SafeSdkRelativePath $RelativePath)) {
        throw "Unsafe SDK destination path: $RelativePath"
    }
    $resolvedSource = [System.IO.Path]::GetFullPath($SourcePath)
    if (-not (Test-Path -LiteralPath $resolvedSource -PathType Leaf)) {
        throw "Required SDK source file not found: $resolvedSource"
    }
    $allowedRootResolved = [System.IO.Path]::GetFullPath($AllowedSourceRoot).TrimEnd('\', '/')
    $rootPrefix = $allowedRootResolved + [System.IO.Path]::DirectorySeparatorChar
    if (-not $resolvedSource.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw "SDK source file escapes its approved root: $resolvedSource"
    }
    $cursor = Get-Item -LiteralPath $resolvedSource -Force
    while ($null -ne $cursor) {
        if (($cursor.Attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
            throw "Symbolic links and junctions are forbidden in SDK sources: $($cursor.FullName)"
        }
        if ([string]::Equals($cursor.FullName.TrimEnd('\', '/'), $allowedRootResolved, [System.StringComparison]::OrdinalIgnoreCase)) {
            break
        }
        $parentPath = Split-Path -Parent $cursor.FullName
        if ([string]::IsNullOrWhiteSpace($parentPath) -or $parentPath -ceq $cursor.FullName) {
            throw "SDK source ancestry did not reach its approved root: $resolvedSource"
        }
        $cursor = Get-Item -LiteralPath $parentPath -Force
    }
    $destination = Join-Path $DestinationRoot ($RelativePath.Replace('/', '\'))
    $parent = Split-Path -Parent $destination
    if ($parent) { New-Item -ItemType Directory -Path $parent -Force | Out-Null }
    [System.IO.File]::Copy($resolvedSource, $destination, $true)
}

function Copy-SdkTree {
    param(
        [string]$SourceRoot,
        [string]$DestinationRoot,
        [string]$DestinationPrefix
    )
    foreach ($file in @(Get-OrdinalFiles -BasePath $SourceRoot -RejectDevelopmentArtifacts)) {
        Copy-SdkFile `
            -SourcePath $file.FullPath `
            -DestinationRoot $DestinationRoot `
            -RelativePath "$DestinationPrefix/$($file.RelativePath)"
    }
}

function Write-Utf8NoBom {
    param([string]$Path, [string]$Content)
    $encoding = [System.Text.UTF8Encoding]::new($false)
    [System.IO.File]::WriteAllText($Path, $Content, $encoding)
}

function Write-ReleaseMetadata {
    param(
        [string]$ArchivePath,
        [string]$Sha256
    )
    $archive = Get-Item -LiteralPath $ArchivePath
    $metadataPath = Join-Path $archive.DirectoryName (
        [System.IO.Path]::GetFileNameWithoutExtension($archive.Name) + '.release.json'
    )
    $releaseChannelHash = (Get-FileHash `
        -LiteralPath (Join-Path $Root 'docs\extension-sdk\release-channel.json') `
        -Algorithm SHA256).Hash.ToLowerInvariant()
    $metadata = [ordered]@{
        schema_version = 1
        channel = 'stable'
        sdk_version = $Version
        license = 'Apache-2.0'
        artifact_file = $archive.Name
        bytes = [int64]$archive.Length
        sha256 = $Sha256
        public_url = $null
        publication_status = 'local-artifact-ready'
        release_channel_sha256 = $releaseChannelHash
        integrity_boundary = 'SHA-256 proves artifact integrity, not publisher identity or CK certification.'
    }
    $json = ($metadata | ConvertTo-Json -Depth 5).Replace("`r`n", "`n") + "`n"
    $temporaryPath = "$metadataPath.$([Guid]::NewGuid().ToString('N')).tmp"
    Write-Utf8NoBom -Path $temporaryPath -Content $json
    if (Test-Path -LiteralPath $metadataPath -PathType Leaf) {
        Remove-Item -LiteralPath $metadataPath -Force
    }
    Move-Item -LiteralPath $temporaryPath -Destination $metadataPath
    return $metadataPath
}

function Write-SdkManifest {
    param([string]$StagingRoot)
    $files = @(Get-OrdinalFiles -BasePath $StagingRoot)
    $manifestFiles = [System.Collections.Generic.List[object]]::new()
    foreach ($file in $files) {
        if ([string]$file.RelativePath -ceq 'manifest.json') { continue }
        $item = Get-Item -LiteralPath $file.FullPath
        $manifestFiles.Add([ordered]@{
            path = [string]$file.RelativePath
            bytes = [int64]$item.Length
            sha256 = (Get-FileHash -LiteralPath $file.FullPath -Algorithm SHA256).Hash.ToLowerInvariant()
        })
    }
    $manifest = [ordered]@{
        schema_version = 1
        sdk_version = $Version
        archive_root = $sdkRootName
        reproducible_timestamp = '1980-01-01T00:00:00Z'
        manifest_scope = 'all archive files except manifest.json'
        files = @($manifestFiles)
        certification_boundary = @(
            'File hashes prove payload integrity only; they are not publisher signatures or source authentication.',
            'Local static quality checks are not CK official certification or physical-board validation.',
            'License declaration checks are not a legal compatibility opinion; publishers remain responsible for permissions.',
            'The SDK aggregate is licensed under Apache-2.0; bundled examples and third-party dependencies retain their own licenses.'
        )
    }
    $json = $manifest | ConvertTo-Json -Depth 8
    $json = $json.Replace("`r`n", "`n") + "`n"
    Write-Utf8NoBom -Path (Join-Path $StagingRoot 'manifest.json') -Content $json
}

function New-DeterministicSdkArchive {
    param([string]$StagingRoot, [string]$ArchivePath)
    $temporaryPath = "$ArchivePath.tmp"
    if (Test-Path -LiteralPath $temporaryPath -PathType Leaf) {
        Remove-Item -LiteralPath $temporaryPath -Force
    }
    $files = @(Get-OrdinalFiles -BasePath $StagingRoot)
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
        foreach ($file in $files) {
            $entry = $archive.CreateEntry(
                "$sdkRootName/$($file.RelativePath)",
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
}

function New-SdkBuild {
    param([string]$RunRoot, [string]$ArchivePath)
    $stageRoot = Join-Path $RunRoot $sdkRootName
    $generatedExamples = Join-Path $RunRoot 'generated-example-zips'
    New-Item -ItemType Directory -Path $stageRoot -Force | Out-Null
    New-Item -ItemType Directory -Path $generatedExamples -Force | Out-Null

    $exampleRoot = Join-Path $Root 'examples\importable-packages'
    foreach ($directory in $exampleDirectories) {
        [void](Get-OrdinalFiles -BasePath (Join-Path $exampleRoot $directory) -RejectDevelopmentArtifacts)
    }

    & powershell -NoProfile -ExecutionPolicy Bypass -File `
        (Join-Path $exampleRoot 'Build-Examples.ps1') `
        -OutputDirectory $generatedExamples
    if ($LASTEXITCODE -ne 0) { throw "Build-Examples.ps1 exited with code $LASTEXITCODE" }

    $readme = Get-Content -LiteralPath (Join-Path $Root 'docs\extension-sdk\README.md') -Raw -Encoding UTF8
    # The source README lives beside these documents, while the archive moves
    # README.md to its root and keeps authoring docs under docs/.
    $readme = $readme.Replace('](ckpkg.md)', '](docs/ckpkg.md)')
    $readme = $readme.Replace('](sensor-library-tutorial.md)', '](docs/sensor-library-tutorial.md)')
    Write-Utf8NoBom -Path (Join-Path $stageRoot 'README.md') -Content $readme
    foreach ($relativePath in $sdkRootFiles) {
        Copy-SdkFile `
            -SourcePath (Join-Path $Root ($relativePath.Replace('/', '\'))) `
            -DestinationRoot $stageRoot `
            -RelativePath ([System.IO.Path]::GetFileName($relativePath))
    }
    foreach ($relativePath in @($documentation + $schemas + $validationScripts + $exampleSupportFiles)) {
        $destinationPath = if ($relativePath -ceq 'docs/extension-sdk/ckpkg.md') {
            'docs/ckpkg.md'
        }
        elseif ($relativePath -ceq 'docs/extension-sdk/sensor-library-tutorial.md') {
            'docs/sensor-library-tutorial.md'
        }
        elseif ($relativePath -ceq 'docs/extension-sdk/ckpkg-github-actions.yml') {
            'ci/github-actions-ckpkg.yml'
        }
        elseif ($relativePath -ceq 'docs/extension-sdk/ckpkg-trusted-github-actions.yml') {
            'ci/github-actions-ckpkg-trusted.yml'
        }
        elseif ($relativePath -ceq 'docs/extension-sdk/package.json') {
            'package.json'
        }
        else {
            $relativePath
        }
        Copy-SdkFile `
            -SourcePath (Join-Path $Root ($relativePath.Replace('/', '\'))) `
            -DestinationRoot $stageRoot `
            -RelativePath $destinationPath
    }
    foreach ($directory in $exampleDirectories) {
        Copy-SdkTree `
            -SourceRoot (Join-Path $exampleRoot $directory) `
            -DestinationRoot $stageRoot `
            -DestinationPrefix "examples/importable-packages/$directory"
    }
    foreach ($archiveName in $exampleArchives) {
        Copy-SdkFile `
            -SourcePath (Join-Path $generatedExamples $archiveName) `
            -DestinationRoot $stageRoot `
            -RelativePath "examples/importable-packages/$archiveName" `
            -AllowedSourceRoot $generatedExamples
    }

    $machineVersionText = & node (Join-Path $stageRoot 'scripts\ckpkg.mjs') --version --json
    if ($LASTEXITCODE -ne 0) { throw "staged ckpkg --version exited with code $LASTEXITCODE" }
    $machineVersion = $machineVersionText | ConvertFrom-Json
    if ([string]$machineVersion.tool -cne 'ckpkg' -or
        [string]$machineVersion.tool_version -cne $Version) {
        throw "Staged ckpkg machine version does not match SDK version $Version"
    }

    Write-SdkManifest -StagingRoot $stageRoot
    New-DeterministicSdkArchive -StagingRoot $stageRoot -ArchivePath $ArchivePath
}

$temporaryRoot = Join-Path ([System.IO.Path]::GetTempPath()) ("ck-extension-sdk-" + [Guid]::NewGuid().ToString('N'))
try {
    $runOne = Join-Path $temporaryRoot 'run-1'
    $runTwo = Join-Path $temporaryRoot 'run-2'
    New-Item -ItemType Directory -Path $runOne -Force | Out-Null
    New-Item -ItemType Directory -Path $runTwo -Force | Out-Null
    $archiveOne = Join-Path $runOne "$sdkRootName.zip"
    $archiveTwo = Join-Path $runTwo "$sdkRootName.zip"
    New-SdkBuild -RunRoot $runOne -ArchivePath $archiveOne
    New-SdkBuild -RunRoot $runTwo -ArchivePath $archiveTwo

    $hashOne = (Get-FileHash -LiteralPath $archiveOne -Algorithm SHA256).Hash.ToLowerInvariant()
    $hashTwo = (Get-FileHash -LiteralPath $archiveTwo -Algorithm SHA256).Hash.ToLowerInvariant()
    if ($hashOne -cne $hashTwo) {
        throw "Extension SDK is not reproducible: first=$hashOne second=$hashTwo"
    }
    $bytesOne = [System.IO.File]::ReadAllBytes($archiveOne)
    $bytesTwo = [System.IO.File]::ReadAllBytes($archiveTwo)
    if (-not [System.Collections.StructuralComparisons]::StructuralEqualityComparer.Equals(
        $bytesOne,
        $bytesTwo
    )) {
        throw 'Extension SDK builds have different bytes despite matching hash output'
    }

    $outputParent = Split-Path -Parent $OutputPath
    if ($outputParent) { New-Item -ItemType Directory -Path $outputParent -Force | Out-Null }
    $temporaryOutput = "$OutputPath.$([Guid]::NewGuid().ToString('N')).tmp"
    [System.IO.File]::Copy($archiveOne, $temporaryOutput, $true)
    if (Test-Path -LiteralPath $OutputPath -PathType Leaf) {
        Remove-Item -LiteralPath $OutputPath -Force
    }
    Move-Item -LiteralPath $temporaryOutput -Destination $OutputPath

    & (Join-Path $Root 'scripts\Verify-ExtensionSdk.ps1') -ArchivePath $OutputPath
    $releaseMetadataPath = Write-ReleaseMetadata -ArchivePath $OutputPath -Sha256 $hashOne
    Write-Host "Built $OutputPath (sha256=$hashOne; two independent builds are byte-identical; metadata=$releaseMetadataPath)"
}
finally {
    if (Test-Path -LiteralPath $temporaryRoot -PathType Container) {
        Remove-Item -LiteralPath $temporaryRoot -Recurse -Force
    }
}
