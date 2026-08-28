Set-StrictMode -Version 2.0

function Get-NativeEvidenceFullPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$BasePath
    )

    if ([System.IO.Path]::IsPathRooted($Path)) {
        return [System.IO.Path]::GetFullPath($Path)
    }
    return [System.IO.Path]::GetFullPath((Join-Path $BasePath $Path))
}

function Get-NativeEvidenceSha256 {
    param([Parameter(Mandatory = $true)][string]$Path)

    if (-not (Test-Path -LiteralPath $Path -PathType Leaf)) {
        throw "Required evidence file is missing: $Path"
    }
    $stream = [System.IO.File]::Open(
        $Path,
        [System.IO.FileMode]::Open,
        [System.IO.FileAccess]::Read,
        [System.IO.FileShare]::Read
    )
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
        }
        finally {
            $sha.Dispose()
        }
    }
    finally {
        $stream.Dispose()
    }
}

function Get-NativeEvidenceReportPath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $full = [System.IO.Path]::GetFullPath($Path)
    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    $prefix = "$rootFull$([System.IO.Path]::DirectorySeparatorChar)"
    if ($full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $full.Substring($prefix.Length).Replace('\', '/')
    }
    return "<EXTERNAL>/$([System.IO.Path]::GetFileName($full))"
}

function Invoke-SourceFreezeVerification {
    param(
        [Parameter(Mandatory = $true)][string]$Root,
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$FreezeRecordPath
    )

    if (Test-Path -LiteralPath (Join-Path $Root '.git')) {
        throw 'Native release evidence requires the no-Git source manifest policy in this workspace; Git metadata was found.'
    }
    $verifier = Join-Path $Root 'scripts\New-SourceTreeManifest.ps1'
    if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        throw "Source freeze verifier is missing: $verifier"
    }
    $powershell = (Get-Process -Id $PID -ErrorAction Stop).Path
    $output = & $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier `
        -Mode Verify -Root $Root -ManifestPath $ManifestPath -FreezeRecordPath $FreezeRecordPath 2>&1
    if ($LASTEXITCODE -ne 0) {
        throw "Source freeze verification failed (exit $LASTEXITCODE): $($output -join [Environment]::NewLine)"
    }

    $manifestText = [System.IO.File]::ReadAllText($ManifestPath, [System.Text.UTF8Encoding]::new($false))
    $freezeText = [System.IO.File]::ReadAllText($FreezeRecordPath, [System.Text.UTF8Encoding]::new($false))
    $manifest = $manifestText | ConvertFrom-Json
    $freeze = $freezeText | ConvertFrom-Json
    if ([string]$manifest.policy_id -cne 'ck-source-tree-v1') { throw 'Unexpected source manifest policy_id.' }
    if ([string]$manifest.source_control.kind -cne 'none' -or $null -ne $manifest.source_control.commit) {
        throw 'Source manifest must identify this as a no-Git freeze.'
    }
    if ([string]$freeze.policy_id -cne 'ck-source-tree-v1') { throw 'Unexpected source freeze policy_id.' }
    if ([string]$freeze.source_control.kind -cne 'none' -or $null -ne $freeze.source_control.commit) {
        throw 'Source freeze record must identify this as a no-Git freeze.'
    }
    $manifestSha = Get-NativeEvidenceSha256 -Path $ManifestPath
    if ([string]$freeze.manifest_sha256 -cne $manifestSha) {
        throw 'Source freeze record does not bind the current manifest bytes.'
    }
    if ([string]$freeze.tree_sha256 -cne [string]$manifest.tree_sha256) {
        throw 'Source manifest and freeze record tree hashes differ.'
    }

    return [ordered]@{
        policy_id = [string]$manifest.policy_id
        source_control = [ordered]@{ kind = 'none'; commit = $null }
        manifest_path = Get-NativeEvidenceReportPath -Path $ManifestPath -Root $Root
        manifest_sha256 = $manifestSha
        freeze_record_path = Get-NativeEvidenceReportPath -Path $FreezeRecordPath -Root $Root
        freeze_record_sha256 = Get-NativeEvidenceSha256 -Path $FreezeRecordPath
        frozen_at = [string]$freeze.frozen_at
        tree_sha256 = [string]$manifest.tree_sha256
        file_count = [int]$manifest.file_count
        total_bytes = [int64]$manifest.total_bytes
    }
}

function Get-NativeEvidenceProcessRows {
    param([string]$Filter = '')

    if ([string]::IsNullOrWhiteSpace($Filter)) {
        return @(Get-CimInstance -ClassName Win32_Process -ErrorAction Stop)
    }
    return @(Get-CimInstance -ClassName Win32_Process -Filter $Filter -ErrorAction Stop)
}

function Get-DebugPortOwnerIds {
    param([Parameter(Mandatory = $true)][int]$DebugPort)

    $ownerIds = @()
    $command = Get-Command Get-NetTCPConnection -ErrorAction SilentlyContinue
    if ($null -ne $command) {
        $ownerIds = @(Get-NetTCPConnection -State Listen -LocalPort $DebugPort -ErrorAction SilentlyContinue |
            Select-Object -ExpandProperty OwningProcess -Unique)
    }
    if ($ownerIds.Count -eq 0) {
        foreach ($line in @(& netstat.exe -ano -p TCP 2>$null)) {
            if ($line -match '^\s*TCP\s+\S+:(\d+)\s+\S+\s+LISTENING\s+(\d+)\s*$' -and
                [int]$matches[1] -eq $DebugPort) {
                $ownerIds += [int]$matches[2]
            }
        }
        $ownerIds = @($ownerIds | Sort-Object -Unique)
    }
    return @($ownerIds)
}

function Get-NativeCdpTarget {
    param([Parameter(Mandatory = $true)][int]$DebugPort)

    try {
        $targets = @((Invoke-RestMethod -UseBasicParsing -Uri "http://127.0.0.1:$DebugPort/json/list" -TimeoutSec 5))
    }
    catch {
        throw "CDP target discovery failed on port ${DebugPort}: $($_.Exception.Message)"
    }
    $mainTargets = @($targets | Where-Object {
            $_.type -eq 'page' -and
            -not [string]::IsNullOrWhiteSpace([string]$_.webSocketDebuggerUrl) -and
            [string]$_.url -notmatch '[?&]console=detached(?:&|$)'
        })
    if ($mainTargets.Count -ne 1) {
        throw "Expected exactly one main CK CDP page on port $DebugPort; found $($mainTargets.Count)."
    }
    $target = $mainTargets[0]
    $productionUrl = 'http://tauri.localhost/'
    if ([string]$target.url -cne $productionUrl) {
        throw "Native release evidence requires the exact CK production Tauri URL '$productionUrl'; found '$([string]$target.url)'."
    }
    $webSocketUri = [Uri]([string]$target.webSocketDebuggerUrl)
    if ($webSocketUri.Port -ne $DebugPort -or $webSocketUri.Host -notin @('127.0.0.1', 'localhost', '::1')) {
        throw 'The selected CDP target WebSocket is not bound to the requested local debug port.'
    }
    return $target
}

function Get-NativeRuntimeBinding {
    param(
        [Parameter(Mandatory = $true)][string]$ExecutablePath,
        [Parameter(Mandatory = $true)][int]$DebugPort,
        [Parameter(Mandatory = $true)][string]$Root,
        [int]$CkProcessId = 0
    )

    $exeFull = [System.IO.Path]::GetFullPath($ExecutablePath)
    if (-not (Test-Path -LiteralPath $exeFull -PathType Leaf)) {
        throw "Production executable is missing: $exeFull"
    }
    $matching = @(Get-NativeEvidenceProcessRows | Where-Object {
            -not [string]::IsNullOrWhiteSpace([string]$_.ExecutablePath) -and
            [System.IO.Path]::GetFullPath([string]$_.ExecutablePath).Equals($exeFull, [System.StringComparison]::OrdinalIgnoreCase)
        })
    if ($matching.Count -ne 1) {
        throw "Expected exactly one running CK process for '$exeFull'; found $($matching.Count)."
    }
    $ck = $matching[0]
    if ($CkProcessId -gt 0 -and [int]$ck.ProcessId -ne $CkProcessId) {
        throw "The unique CK process PID $($ck.ProcessId) does not match requested PID $CkProcessId."
    }

    $children = @(Get-NativeEvidenceProcessRows -Filter "ParentProcessId = $([int]$ck.ProcessId)")
    $browserHosts = @($children | Where-Object {
            [string]$_.Name -ieq 'msedgewebview2.exe' -and
            [string]$_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)' -and
            [string]$_.CommandLine -match "(?:^|\s)--remote-debugging-port(?:=|\s+)$DebugPort(?:\s|$)"
        })
    if ($browserHosts.Count -ne 1) {
        throw "Expected exactly one direct WebView2 browser host for CK PID $($ck.ProcessId) and debug port $DebugPort; found $($browserHosts.Count)."
    }
    $browser = $browserHosts[0]
    $owners = @(Get-DebugPortOwnerIds -DebugPort $DebugPort)
    if ($owners.Count -ne 1 -or [int]$owners[0] -ne [int]$browser.ProcessId) {
        throw "Debug port $DebugPort is not owned exclusively by direct WebView2 browser PID $($browser.ProcessId); owners: $($owners -join ',')."
    }
    $target = Get-NativeCdpTarget -DebugPort $DebugPort
    $ckProcess = Get-Process -Id ([int]$ck.ProcessId) -ErrorAction Stop
    $browserProcess = Get-Process -Id ([int]$browser.ProcessId) -ErrorAction Stop

    return [ordered]@{
        executable = [ordered]@{
            path = Get-NativeEvidenceReportPath -Path $exeFull -Root $Root
            sha256 = Get-NativeEvidenceSha256 -Path $exeFull
            bytes = [int64](Get-Item -LiteralPath $exeFull).Length
            process_id = [int]$ck.ProcessId
            process_started_at = $ckProcess.StartTime.ToUniversalTime().ToString('o')
        }
        cdp_binding = [ordered]@{
            bound = $true
            debug_port = $DebugPort
            process_id = [int]$ck.ProcessId
            browser_process_id = [int]$browser.ProcessId
            browser_host_process_id = [int]$browser.ProcessId
            browser_host_path = [System.IO.Path]::GetFileName([string]$browser.ExecutablePath)
            browser_host_started_at = $browserProcess.StartTime.ToUniversalTime().ToString('o')
            listener_owning_process_id = [int]$owners[0]
            target_id = [string]$target.id
            target_type = [string]$target.type
            target_url = [string]$target.url
            web_socket_debugger_url = [string]$target.webSocketDebuggerUrl
            executable_sha256 = Get-NativeEvidenceSha256 -Path $exeFull
        }
    }
}

function Get-NativeGateRunBinding {
    param(
        [Parameter(Mandatory = $true)][string]$GateReportPath,
        [Parameter(Mandatory = $true)]$SourceTree,
        [Parameter(Mandatory = $true)][string]$Root
    )

    $gateFull = [System.IO.Path]::GetFullPath($GateReportPath)
    if (-not (Test-Path -LiteralPath $gateFull -PathType Leaf)) {
        throw "Passed release gate report is missing: $gateFull"
    }
    $gate = [System.IO.File]::ReadAllText($gateFull, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    if ([string]$gate.status -cne 'passed') { throw 'Native evidence requires a release gate report with status=passed.' }
    if ([string]::IsNullOrWhiteSpace([string]$gate.run_id) -or
        [string]::IsNullOrWhiteSpace([string]$gate.finished_at)) {
        throw 'Release gate report is missing run_id or finished_at.'
    }
    $sourceIdentities = @($gate.source_tree.identity | Where-Object {
            $property = if ($null -ne $_) { $_.PSObject.Properties['manifest_sha256'] } else { $null }
            $null -ne $property -and -not [string]::IsNullOrWhiteSpace([string]$property.Value)
        })
    if ($sourceIdentities.Count -ne 1) {
        throw "Release gate report must contain exactly one structured source-tree identity; found $($sourceIdentities.Count)."
    }
    $gateSource = $sourceIdentities[0]
    foreach ($field in @('manifest_sha256', 'tree_sha256', 'frozen_at')) {
        if ([string]$gateSource.$field -cne [string]$SourceTree[$field]) {
            throw "Release gate report is not bound to the current source freeze: $field."
        }
    }
    return [ordered]@{
        run_id = [string]$gate.run_id
        finished_at = [string]$gate.finished_at
        report_path = Get-NativeEvidenceReportPath -Path $gateFull -Root $Root
        report_sha256 = Get-NativeEvidenceSha256 -Path $gateFull
        status = 'passed'
    }
}

function New-NativeEvidenceBinding {
    [CmdletBinding()]
    param(
        [string]$Root = (Split-Path -Parent $PSScriptRoot),
        [int]$DebugPort = 9223,
        [string]$ExecutablePath = '',
        [int]$CkProcessId = 0,
        [string]$SourceManifestPath = '',
        [string]$SourceFreezeRecordPath = '',
        [string]$GateReportPath = ''
    )

    $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
    if ([string]::IsNullOrWhiteSpace($ExecutablePath)) { $ExecutablePath = 'target\release\appsdesktop.exe' }
    if ([string]::IsNullOrWhiteSpace($SourceManifestPath)) { $SourceManifestPath = 'artifacts\release\source-tree-manifest.json' }
    if ([string]::IsNullOrWhiteSpace($SourceFreezeRecordPath)) { $SourceFreezeRecordPath = 'artifacts\release\source-tree-freeze.json' }
    if ([string]::IsNullOrWhiteSpace($GateReportPath)) { $GateReportPath = 'artifacts\release\v1-release-gates.json' }
    $exeFull = Get-NativeEvidenceFullPath -Path $ExecutablePath -BasePath $rootFull
    $manifestFull = Get-NativeEvidenceFullPath -Path $SourceManifestPath -BasePath $rootFull
    $freezeFull = Get-NativeEvidenceFullPath -Path $SourceFreezeRecordPath -BasePath $rootFull
    $gateFull = Get-NativeEvidenceFullPath -Path $GateReportPath -BasePath $rootFull

    $sourceTree = Invoke-SourceFreezeVerification -Root $rootFull -ManifestPath $manifestFull -FreezeRecordPath $freezeFull
    $gateRun = Get-NativeGateRunBinding -GateReportPath $gateFull -SourceTree $sourceTree -Root $rootFull
    $runtime = Get-NativeRuntimeBinding -ExecutablePath $exeFull -DebugPort $DebugPort -Root $rootFull -CkProcessId $CkProcessId
    return [pscustomobject][ordered]@{
        schema_version = 1
        root = $rootFull
        source_manifest_full_path = $manifestFull
        source_freeze_full_path = $freezeFull
        executable_full_path = $exeFull
        gate_report_full_path = $gateFull
        requested_process_id = $CkProcessId
        source_tree = $sourceTree
        gate_run = $gateRun
        executable = $runtime.executable
        cdp_binding = $runtime.cdp_binding
        verified_before_at = [DateTimeOffset]::UtcNow.ToString('o')
    }
}

function Complete-NativeEvidenceBinding {
    [CmdletBinding()]
    param([Parameter(Mandatory = $true)]$Binding)

    $sourceTree = Invoke-SourceFreezeVerification `
        -Root ([string]$Binding.root) `
        -ManifestPath ([string]$Binding.source_manifest_full_path) `
        -FreezeRecordPath ([string]$Binding.source_freeze_full_path)
    $runtime = Get-NativeRuntimeBinding `
        -ExecutablePath ([string]$Binding.executable_full_path) `
        -DebugPort ([int]$Binding.cdp_binding.debug_port) `
        -Root ([string]$Binding.root) `
        -CkProcessId ([int]$Binding.executable.process_id)
    $gateRun = Get-NativeGateRunBinding -GateReportPath ([string]$Binding.gate_report_full_path) -SourceTree $sourceTree -Root ([string]$Binding.root)

    foreach ($field in @('manifest_sha256', 'freeze_record_sha256', 'tree_sha256')) {
        if ([string]$sourceTree[$field] -cne [string]$Binding.source_tree[$field]) {
            throw "Source evidence changed during the native run: $field."
        }
    }
    foreach ($field in @('path', 'sha256', 'bytes', 'process_id', 'process_started_at')) {
        if ([string]$runtime.executable[$field] -cne [string]$Binding.executable[$field]) {
            throw "Executable binding changed during the native run: $field."
        }
    }
    foreach ($field in @('browser_host_process_id', 'browser_host_path', 'browser_host_started_at', 'listener_owning_process_id', 'target_id', 'target_url', 'web_socket_debugger_url')) {
        if ([string]$runtime.cdp_binding[$field] -cne [string]$Binding.cdp_binding[$field]) {
            throw "CDP binding changed during the native run: $field."
        }
    }
    foreach ($field in @('run_id', 'finished_at', 'report_path', 'report_sha256')) {
        if ([string]$gateRun[$field] -cne [string]$Binding.gate_run[$field]) {
            throw "Release gate binding changed during the native run: $field."
        }
    }

    return [ordered]@{
        source_tree = $sourceTree
        gate_run = $gateRun
        executable = $runtime.executable
        cdp_binding = $runtime.cdp_binding
        binding_verification = [ordered]@{
            schema_version = 1
            verified_before_at = [string]$Binding.verified_before_at
            verified_after_at = [DateTimeOffset]::UtcNow.ToString('o')
            unchanged = $true
        }
    }
}

function Add-NativeEvidenceBindingToReport {
    [CmdletBinding()]
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [Parameter(Mandatory = $true)]$Evidence
    )

    $fullPath = [System.IO.Path]::GetFullPath($Path)
    if (-not (Test-Path -LiteralPath $fullPath -PathType Leaf)) {
        throw "Native report was not created, so evidence cannot be bound: $fullPath"
    }
    $report = [System.IO.File]::ReadAllText($fullPath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
    foreach ($name in @('source_tree', 'gate_run', 'executable', 'cdp_binding', 'binding_verification')) {
        $report | Add-Member -NotePropertyName $name -NotePropertyValue $Evidence[$name] -Force
    }
    $safeReport = ConvertTo-NativeEvidenceSafeValue -Value $report -Root ([string](Split-Path -Parent $PSScriptRoot))
    $encoded = ($safeReport | ConvertTo-Json -Depth 100) + "`n"
    if ($encoded -match '(?i)\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b' -or
        $encoded -match '(?i)\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b' -or
        $encoded -match '(?i)[A-Z]:[\\/]Users[\\/]') {
        throw 'Native evidence privacy scrub failed; refusing to write a report containing a full MAC or user path.'
    }
    $temporary = "$fullPath.$([Guid]::NewGuid().ToString('N')).tmp"
    try {
        [System.IO.File]::WriteAllText($temporary, $encoded, [System.Text.UTF8Encoding]::new($false))
        Move-Item -LiteralPath $temporary -Destination $fullPath -Force
    }
    finally {
        if (Test-Path -LiteralPath $temporary) { Remove-Item -LiteralPath $temporary -Force }
    }
}

function ConvertTo-NativeEvidenceSafeValue {
    param(
        [AllowNull()]$Value,
        [Parameter(Mandatory = $true)][string]$Root
    )

    if ($null -eq $Value) { return $null }
    if ($Value -is [string]) {
        $safe = [string]$Value
        $rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
        $buildRoot = Join-Path ([System.IO.Path]::GetTempPath()) 'CK_Builds'
        $home = [Environment]::GetFolderPath([Environment+SpecialFolder]::UserProfile)
        foreach ($replacement in @(
                [pscustomobject]@{ value = $buildRoot; token = '<CK_BUILDS>' },
                [pscustomobject]@{ value = $rootFull; token = '<CK_ROOT>' },
                [pscustomobject]@{ value = $home; token = '<USER_HOME>' }
            )) {
            if (-not [string]::IsNullOrWhiteSpace([string]$replacement.value)) {
                $safe = [regex]::Replace(
                    $safe,
                    [regex]::Escape([string]$replacement.value),
                    [string]$replacement.token,
                    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
                )
                $forwardValue = ([string]$replacement.value).Replace('\', '/')
                $safe = [regex]::Replace(
                    $safe,
                    [regex]::Escape($forwardValue),
                    [string]$replacement.token,
                    [System.Text.RegularExpressions.RegexOptions]::IgnoreCase
                )
            }
        }
        $safe = [regex]::Replace($safe, '(?i)\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b', '[REDACTED_MAC]')
        $safe = [regex]::Replace($safe, '(?i)\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b', 'MAC: [REDACTED_MAC]')
        $safe = [regex]::Replace($safe, '(?i)\b[A-Z]:[\\/]Users[\\/][^\\/\s"'']+', '<USER_HOME>')
        return $safe
    }
    if ($Value -is [System.Collections.IDictionary]) {
        $copy = [ordered]@{}
        foreach ($key in $Value.Keys) {
            $copy[[string]$key] = ConvertTo-NativeEvidenceSafeValue -Value $Value[$key] -Root $Root
        }
        return $copy
    }
    if ($Value -is [System.Collections.IEnumerable] -and $Value -isnot [pscustomobject]) {
        $items = @($Value | ForEach-Object { ConvertTo-NativeEvidenceSafeValue -Value $_ -Root $Root })
        # PowerShell 5.1 represents a function that emits an empty array as
        # AutomationNull.Value. ConvertTo-Json serializes that sentinel as `{}`,
        # changing the evidence schema. The unary comma returns the collection
        # itself as one pipeline value, preserving both empty and one-item JSON
        # arrays through the recursive privacy scrub.
        return ,$items
    }
    if ($Value -is [pscustomobject]) {
        $copy = [ordered]@{}
        foreach ($property in $Value.PSObject.Properties) {
            $copy[$property.Name] = ConvertTo-NativeEvidenceSafeValue -Value $property.Value -Root $Root
        }
        return [pscustomobject]$copy
    }
    return $Value
}

function Initialize-NativeEvidenceReportPath {
    param([Parameter(Mandatory = $true)][string]$Path)

    if ([string]::IsNullOrWhiteSpace($Path)) { return }
    $fullPath = [System.IO.Path]::GetFullPath($Path)
    $parent = Split-Path -Parent $fullPath
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    if (Test-Path -LiteralPath $fullPath) {
        Remove-Item -LiteralPath $fullPath -Force
    }
    foreach ($temporary in @(Get-ChildItem -LiteralPath $parent -Filter "$([System.IO.Path]::GetFileName($fullPath)).*.tmp" -File -ErrorAction SilentlyContinue)) {
        Remove-Item -LiteralPath $temporary.FullName -Force
    }
}

function Save-NativeEvidenceEnvironment {
    param([Parameter(Mandatory = $true)][string[]]$Names)

    $snapshot = @{}
    foreach ($name in $Names) {
        $value = [Environment]::GetEnvironmentVariable($name, 'Process')
        $snapshot[$name] = [pscustomobject]@{ existed = $null -ne $value; value = $value }
    }
    return $snapshot
}

function Restore-NativeEvidenceEnvironment {
    param([Parameter(Mandatory = $true)][hashtable]$Snapshot)

    foreach ($name in $Snapshot.Keys) {
        $entry = $Snapshot[$name]
        if ($entry.existed) {
            [Environment]::SetEnvironmentVariable($name, [string]$entry.value, 'Process')
        }
        else {
            [Environment]::SetEnvironmentVariable($name, $null, 'Process')
        }
    }
}

Export-ModuleMember -Function @(
    'New-NativeEvidenceBinding',
    'Complete-NativeEvidenceBinding',
    'Add-NativeEvidenceBindingToReport',
    'Save-NativeEvidenceEnvironment',
    'Restore-NativeEvidenceEnvironment',
    'Get-NativeEvidenceSha256',
    'Initialize-NativeEvidenceReportPath'
)
