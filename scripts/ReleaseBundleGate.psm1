$script:ReleaseInstallerExtensions = @('.exe', '.msi', '.dmg', '.appimage', '.deb', '.rpm')
$script:RequiredBundledResources = [ordered]@{
    'bin/arduino-cli.exe' = 'bin/arduino-cli.exe'
    'bin/GPL-3.0.txt' = 'licenses/GPL-3.0.txt'
    '../../../tools/ccache.exe' = 'bin/ccache.exe'
    'THIRD_PARTY_NOTICES.md' = 'THIRD_PARTY_NOTICES.md'
}
$script:RequiredInstalledResourcePaths = @(
    'bin/arduino-cli.exe',
    'bin/ccache.exe',
    'licenses/GPL-3.0.txt',
    'THIRD_PARTY_NOTICES.md'
)

function ConvertTo-NormalizedBundlePath {
    param([Parameter(Mandatory = $true)][string]$Path)

    return $Path.Replace('\', '/').TrimStart('/')
}

function Assert-ExpectedInstalledResourcePaths {
    param(
        [Parameter(Mandatory = $true)][AllowEmptyCollection()][string[]]$ActualPaths,
        [Parameter(Mandatory = $true)][string]$Context
    )

    $normalized = @($ActualPaths | ForEach-Object {
            (ConvertTo-NormalizedBundlePath -Path $_).ToLowerInvariant()
        })
    if ($normalized -contains 'licenses/license.txt') {
        throw "$Context contains legacy licenses/LICENSE.txt; CK 1.0 requires licenses/GPL-3.0.txt"
    }
    foreach ($required in $script:RequiredInstalledResourcePaths) {
        if ($normalized -notcontains $required.ToLowerInvariant()) {
            throw "$Context is missing required bundled resource: $required"
        }
    }
}

function Assert-BundledResourceContract {
    param([Parameter(Mandatory = $true)][string]$Root)

    $tauriRoot = Join-Path $Root 'apps\desktop\src-tauri'
    $configPath = Join-Path $tauriRoot 'tauri.conf.json'
    if (-not (Test-Path -LiteralPath $configPath -PathType Leaf)) {
        throw "Tauri configuration is missing: $configPath"
    }
    $config = Get-Content -LiteralPath $configPath -Raw | ConvertFrom-Json
    $resources = $config.bundle.resources
    if ($null -eq $resources) {
        throw 'Tauri bundle.resources is missing'
    }

    $legacySource = Join-Path $tauriRoot 'bin\LICENSE.txt'
    if (Test-Path -LiteralPath $legacySource) {
        throw "legacy bundled license source must not exist: $legacySource"
    }
    foreach ($property in $resources.PSObject.Properties) {
        $sourceName = ConvertTo-NormalizedBundlePath -Path ([string]$property.Name)
        $destination = ConvertTo-NormalizedBundlePath -Path ([string]$property.Value)
        if ($sourceName.ToLowerInvariant() -eq 'bin/license.txt' -or
            $destination.ToLowerInvariant() -eq 'licenses/license.txt') {
            throw 'Tauri bundled license must use GPL-3.0.txt as both source and installed filename'
        }
    }

    foreach ($entry in $script:RequiredBundledResources.GetEnumerator()) {
        $property = $resources.PSObject.Properties[[string]$entry.Key]
        if ($null -eq $property) {
            throw "Tauri bundle.resources is missing source entry: $($entry.Key)"
        }
        $actualDestination = ConvertTo-NormalizedBundlePath -Path ([string]$property.Value)
        $expectedDestination = ConvertTo-NormalizedBundlePath -Path ([string]$entry.Value)
        if ($actualDestination -cne $expectedDestination) {
            throw "Tauri resource destination mismatch for $($entry.Key): $actualDestination (expected $expectedDestination)"
        }
        $sourcePath = [System.IO.Path]::GetFullPath((Join-Path $tauriRoot ([string]$entry.Key)))
        if (-not (Test-Path -LiteralPath $sourcePath -PathType Leaf)) {
            throw "Tauri bundled resource source is missing: $sourcePath"
        }
    }

    $noticePath = Join-Path $tauriRoot 'THIRD_PARTY_NOTICES.md'
    $noticeText = Get-Content -LiteralPath $noticePath -Raw
    if ($noticeText -notmatch [regex]::Escape('licenses/GPL-3.0.txt')) {
        throw 'THIRD_PARTY_NOTICES.md does not reference licenses/GPL-3.0.txt'
    }
}

function Get-MsiQueryRows {
    param(
        [Parameter(Mandatory = $true)]$Database,
        [Parameter(Mandatory = $true)][string]$Sql,
        [Parameter(Mandatory = $true)][int]$ColumnCount
    )

    $view = $Database.GetType().InvokeMember('OpenView', 'InvokeMethod', $null, $Database, @($Sql))
    try {
        $view.GetType().InvokeMember('Execute', 'InvokeMethod', $null, $view, $null) | Out-Null
        $rows = @()
        while ($true) {
            $record = $view.GetType().InvokeMember('Fetch', 'InvokeMethod', $null, $view, $null)
            if ($null -eq $record) { break }
            $values = @()
            for ($index = 1; $index -le $ColumnCount; $index++) {
                $values += [string]$record.GetType().InvokeMember(
                    'StringData', 'GetProperty', $null, $record, $index
                )
            }
            $rows += , $values
        }
        return $rows
    }
    finally {
        $view.GetType().InvokeMember('Close', 'InvokeMethod', $null, $view, $null) | Out-Null
    }
}

function Get-MsiLongName {
    param([Parameter(Mandatory = $true)][string]$Name)

    $parts = $Name.Split('|')
    return $parts[$parts.Length - 1]
}

function Get-MsiInstalledPaths {
    param([Parameter(Mandatory = $true)][string]$MsiPath)

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        throw 'MSI resource-layout verification requires Windows Installer on Windows'
    }
    $installer = New-Object -ComObject WindowsInstaller.Installer
    $database = $installer.GetType().InvokeMember(
        'OpenDatabase', 'InvokeMethod', $null, $installer,
        @([System.IO.Path]::GetFullPath($MsiPath), 0)
    )
    $fileRows = Get-MsiQueryRows -Database $database `
        -Sql 'SELECT `File`, `Component_`, `FileName` FROM `File`' -ColumnCount 3
    $componentRows = Get-MsiQueryRows -Database $database `
        -Sql 'SELECT `Component`, `Directory_` FROM `Component`' -ColumnCount 2
    $directoryRows = Get-MsiQueryRows -Database $database `
        -Sql 'SELECT `Directory`, `Directory_Parent`, `DefaultDir` FROM `Directory`' -ColumnCount 3

    $components = @{}
    foreach ($row in $componentRows) { $components[$row[0]] = $row[1] }
    $directories = @{}
    foreach ($row in $directoryRows) {
        $directories[$row[0]] = [ordered]@{ parent = $row[1]; name = $row[2] }
    }

    $paths = @()
    foreach ($row in $fileRows) {
        $directoryId = [string]$components[$row[1]]
        $segments = [System.Collections.Generic.List[string]]::new()
        $seen = [System.Collections.Generic.HashSet[string]]::new(
            [System.StringComparer]::OrdinalIgnoreCase
        )
        while (-not [string]::IsNullOrWhiteSpace($directoryId) -and $directoryId -ne 'INSTALLDIR') {
            if (-not $seen.Add($directoryId)) {
                throw "MSI directory cycle detected in $MsiPath at $directoryId"
            }
            $directory = $directories[$directoryId]
            if ($null -eq $directory) { break }
            $name = Get-MsiLongName -Name ([string]$directory.name)
            if (-not [string]::IsNullOrWhiteSpace($name) -and $name -ne '.') {
                $segments.Insert(0, $name)
            }
            $directoryId = [string]$directory.parent
        }
        if ($directoryId -ne 'INSTALLDIR') { continue }
        $segments.Add((Get-MsiLongName -Name ([string]$row[2])))
        $paths += ($segments -join '/')
    }
    return $paths
}

function Assert-ReleaseInstallerResourceLayout {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$BundleRoot
    )

    $releaseRoot = Split-Path -Parent ([System.IO.Path]::GetFullPath($BundleRoot))
    $stagedPaths = @(Get-ChildItem -LiteralPath $releaseRoot -Recurse -File | ForEach-Object {
            Get-RelativeEvidencePath -BasePath $releaseRoot -Path $_.FullName
        })
    Assert-ExpectedInstalledResourcePaths -ActualPaths $stagedPaths -Context 'Tauri staged application layout'

    if ([System.Environment]::OSVersion.Platform -ne [System.PlatformID]::Win32NT) {
        return
    }
    $nsisInstallers = @(Get-ChildItem -LiteralPath (Join-Path $BundleRoot 'nsis') -File -Filter '*.exe' -ErrorAction SilentlyContinue)
    $msiInstallers = @(Get-ChildItem -LiteralPath (Join-Path $BundleRoot 'msi') -File -Filter '*.msi' -ErrorAction SilentlyContinue)
    if ($nsisInstallers.Count -eq 0 -or $msiInstallers.Count -eq 0) {
        throw 'Windows release must contain both NSIS and MSI installers before resource layout can pass'
    }

    $nsisSpecs = @(Get-ChildItem -LiteralPath (Join-Path $releaseRoot 'nsis') -Recurse -File `
            -Filter 'installer.nsi' -ErrorAction SilentlyContinue)
    if ($nsisSpecs.Count -eq 0) {
        throw 'NSIS installer script is missing; bundled resource layout cannot be verified'
    }
    foreach ($spec in $nsisSpecs) {
        $text = Get-Content -LiteralPath $spec.FullName -Raw
        $paths = @([regex]::Matches($text, '(?im)^\s*File\s+/a\s+"/oname=([^"]+)"') |
                ForEach-Object { $_.Groups[1].Value })
        Assert-ExpectedInstalledResourcePaths -ActualPaths $paths -Context "NSIS layout $($spec.FullName)"
    }

    foreach ($msi in $msiInstallers) {
        $paths = @(Get-MsiInstalledPaths -MsiPath $msi.FullName)
        Assert-ExpectedInstalledResourcePaths -ActualPaths $paths -Context "MSI layout $($msi.FullName)"
    }
}

function Get-ReleaseInstallerFiles {
    param([Parameter(Mandatory = $true)][string]$BundleRoot)

    if (-not (Test-Path -LiteralPath $BundleRoot -PathType Container)) {
        return @()
    }

    return @(Get-ChildItem -LiteralPath $BundleRoot -Recurse -File | Where-Object {
            $script:ReleaseInstallerExtensions -contains $_.Extension.ToLowerInvariant()
        } | Sort-Object FullName)
}

function Get-RelativeEvidencePath {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$Path
    )

    $baseFull = [System.IO.Path]::GetFullPath($BasePath).TrimEnd([char[]]@('\', '/'))
    $pathFull = [System.IO.Path]::GetFullPath($Path)
    $prefix = "$baseFull$([System.IO.Path]::DirectorySeparatorChar)"
    if ($pathFull.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $pathFull.Substring($prefix.Length).Replace('\', '/')
    }
    return $pathFull.Replace('\', '/')
}

function Get-InstallerVersionIdentity {
    param(
        [Parameter(Mandatory = $true)][System.IO.FileInfo]$File,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion
    )

    $versionPattern = "(^|[^0-9])$([regex]::Escape($ExpectedVersion))([^0-9]|$)"
    if ($File.Name -match $versionPattern) {
        return [ordered]@{ source = 'filename'; value = $ExpectedVersion }
    }

    # Windows installers may carry their release identity only in VERSIONINFO.
    # Invalid/non-PE fixtures simply expose empty fields, so this remains safe on
    # every supported host.
    $versionInfo = $File.VersionInfo
    foreach ($field in @('ProductVersion', 'FileVersion')) {
        $value = [string]$versionInfo.$field
        if (-not [string]::IsNullOrWhiteSpace($value) -and $value -match $versionPattern) {
            return [ordered]@{ source = $field.ToLowerInvariant(); value = $value }
        }
    }

    return $null
}

function Move-PreexistingReleaseBundleRoot {
    param(
        [Parameter(Mandatory = $true)][string]$BundleRoot,
        [Parameter(Mandatory = $true)][string]$QuarantineRoot,
        [Parameter(Mandatory = $true)][string]$RunId
    )

    if (-not (Test-Path -LiteralPath $BundleRoot -PathType Container)) {
        return [ordered]@{
            quarantined = $false
            file_count = 0
            installer_count = 0
            quarantine_path = $null
            inventory_manifest = $null
        }
    }

    New-Item -ItemType Directory -Force -Path $QuarantineRoot | Out-Null
    $destination = Join-Path $QuarantineRoot "prebuild-$RunId"
    if (Test-Path -LiteralPath $destination) {
        throw "bundle quarantine destination already exists: $destination"
    }

    Move-Item -LiteralPath $BundleRoot -Destination $destination
    $allFiles = @(Get-ChildItem -LiteralPath $destination -Recurse -File | Sort-Object FullName)
    $installerCount = @(Get-ReleaseInstallerFiles -BundleRoot $destination).Count
    $inventory = @($allFiles | ForEach-Object {
            [ordered]@{
                path = Get-RelativeEvidencePath -BasePath $destination -Path $_.FullName
                bytes = $_.Length
                sha256 = (Get-FileHash -LiteralPath $_.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
            }
        })
    $manifestPath = Join-Path $destination '.prebuild-inventory.json'
    [ordered]@{
        schema_version = 1
        excluded_from_release_run = $true
        run_id = $RunId
        files = $inventory
    } | ConvertTo-Json -Depth 6 | Set-Content -LiteralPath $manifestPath -Encoding utf8

    return [ordered]@{
        quarantined = $true
        file_count = $allFiles.Count
        installer_count = $installerCount
        quarantine_path = $destination
        inventory_manifest = $manifestPath
    }
}

function Get-FreshReleaseBundleEvidence {
    param(
        [Parameter(Mandatory = $true)][string]$BundleRoot,
        [Parameter(Mandatory = $true)][string]$ExpectedVersion,
        [Parameter(Mandatory = $true)][DateTimeOffset]$NotBeforeUtc,
        [Parameter(Mandatory = $true)][string]$ReportRoot
    )

    $files = @(Get-ReleaseInstallerFiles -BundleRoot $BundleRoot)
    if ($files.Count -eq 0) {
        throw 'Tauri completed without producing a desktop installer for this release run'
    }

    $evidence = [System.Collections.Generic.List[object]]::new()
    # FAT/exFAT and some archive/extraction tools round timestamps. Isolation of
    # the complete bundle root is the primary freshness proof; this two-second
    # tolerance only avoids rejecting a genuinely new file on such filesystems.
    $freshnessFloor = $NotBeforeUtc.UtcDateTime.AddSeconds(-2)
    foreach ($file in $files) {
        if ($file.LastWriteTimeUtc -lt $freshnessFloor) {
            throw "desktop installer is not fresh for this release run: $($file.FullName)"
        }
        $identity = Get-InstallerVersionIdentity -File $file -ExpectedVersion $ExpectedVersion
        if ($null -eq $identity) {
            throw "desktop installer does not identify expected version $ExpectedVersion in its filename or installer metadata: $($file.Name)"
        }
        $evidence.Add([ordered]@{
                path = Get-RelativeEvidencePath -BasePath $ReportRoot -Path $file.FullName
                bytes = $file.Length
                sha256 = (Get-FileHash -LiteralPath $file.FullName -Algorithm SHA256).Hash.ToLowerInvariant()
                generated_at = ([DateTimeOffset]$file.LastWriteTimeUtc).ToString('o')
                version = $ExpectedVersion
                version_evidence = $identity
            })
    }

    return @($evidence)
}

Export-ModuleMember -Function @(
    'Assert-ExpectedInstalledResourcePaths',
    'Assert-BundledResourceContract',
    'Assert-ReleaseInstallerResourceLayout',
    'Get-ReleaseInstallerFiles',
    'Get-RelativeEvidencePath',
    'Get-InstallerVersionIdentity',
    'Move-PreexistingReleaseBundleRoot',
    'Get-FreshReleaseBundleEvidence'
)
