param(
    [string]$Root = '',
    [string]$OutputPath = '',
    [string]$SourceManifestPath = '',
    [string]$SourceFreezePath = '',
    [string]$GateReportPath = '',
    [string]$ExecutablePath = '',
    [string]$NativeSmokePath = '',
    [string]$MemoryReportPath = '',
    [string]$C6BenchmarkPath = '',
    [string]$FirstCompilePerformancePath = '',
    [string]$C6DeviceHealthPath = '',
    [string]$C6UploadProgressPath = '',
    [string]$C6UploadManifestGatePath = '',
    [string]$C6SafeCancelPath = '',
    [string]$BuiltinGeneratorAuditPath = '',
    [string]$CoreCompatibilityReportPath = '',
    [string]$ExampleDirectory = '',
    [string]$ExpectedVersion = '1.0.0',
    [ValidateRange(1, 72)][int]$MaximumEvidenceAgeHours = 72
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

$releaseClass = 'local-machine-and-closed-test-candidate-only'
$requiredProductionTargetUrl = 'http://tauri.localhost/'
$requiredC6ProjectName = 'c6_regression'
$requiredC6Fqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB'
$requiredC6Port = 'COM12'
$requiredC6PhysicalFlashBytes = [int64](16 * 1024 * 1024)
$maximumJsonEvidenceBytes = [int64](16 * 1024 * 1024)
$requiredGateNames = @(
    'source-tree-freeze-preflight',
    'version-consistency',
    'bundled-resource-contract',
    'rustfmt',
    'desktop-frontend-tests',
    'release-and-package-script-tests',
    'ck-core-tests',
    'arduino-rust-tests',
    'desktop-rust-tests',
    'deterministic-example-packages',
    'extension-sdk',
    'desktop-production-build',
    'desktop-installers',
    'source-tree-freeze-postflight'
)
$requiredExamplePackageNames = @(
    'ck_example_c6_board.zip',
    'ck_example_i2c_sensor_v2.zip',
    'ck_example_nano_board.zip',
    'ck_example_native_deep.zip',
    'ck_example_serial_blocks.zip'
)
$requiredNativeSmokeCheckNames = @(
    'tauri-runtime',
    'dashboard-workspace-roundtrip',
    'expected-port-selected-for-protection',
    'theme-light-dark-restored',
    'system-paths-complete',
    'exact-full-fqbn-visible',
    'exact-full-fqbn-wrappable',
    'engineering-health-dock-layout',
    'health-resource-layout-no-overlap',
    'engineering-health-collapse-reopen',
    'block-catalog-ready',
    'search-result-present',
    'flyout-visible-during-search',
    'source-label-visible',
    'expected-source-visible',
    'no-horizontal-overflow',
    'search-cleanup-restored-idle',
    'project-checkpoints-entry-opened',
    'recovery-draft-entry-opened',
    'last-working-version-entry-opened',
    'declarative-package-quality-complete',
    'declarative-package-runtime-safe',
    'declarative-package-search-source-visible',
    'legacy-javascript-import-fail-closed',
    'unknown-block-read-only-protection',
    'unknown-block-actions-blocked',
    'unknown-project-bytes-preserved',
    'cleanup-restored-final-state'
)
$requiredMemoryCheckNames = @(
    'renderer-heap-delta-within-5-mib',
    'dom-node-delta-within-1500',
    'dom-document-delta-within-1',
    'dom-event-listener-delta-within-3',
    'resident-process-tree-private-delta-within-32-mib',
    'blockly-workspace-registry-does-not-grow',
    'renderer_heap-has-no-persistent-linear-growth',
    'dom_nodes-has-no-persistent-linear-growth',
    'dom_documents-has-no-persistent-linear-growth',
    'dom_event_listeners-has-no-persistent-linear-growth',
    'resident_process_tree_private-has-no-persistent-linear-growth',
    'dashboard-renderer-heap-delta-within-5-mib',
    'dashboard-dom-node-delta-within-1500',
    'dashboard-dom-document-delta-within-1',
    'dashboard-dom-event-listener-delta-within-3',
    'dashboard-resident-process-tree-private-delta-within-32-mib',
    'dashboard-blockly-workspace-registry-does-not-grow',
    'dashboard-renderer_heap-has-no-persistent-linear-growth',
    'dashboard-dom_nodes-has-no-persistent-linear-growth',
    'dashboard-dom_documents-has-no-persistent-linear-growth',
    'dashboard-dom_event_listeners-has-no-persistent-linear-growth',
    'dashboard-resident_process_tree_private-has-no-persistent-linear-growth',
    'dashboard-releases-current-blockly-workspace-every-cycle',
    'workspace-owns-only-current-blockly-tree-every-cycle',
    'published-route-samples-have-zero-process-pollution',
    'project-code-fingerprint-remains-stable'
)
$requiredDeviceHealthCheckNames = @(
    'chip-family-confirmed',
    'physical-flash-confirmed',
    'full-fqbn-visible',
    'local-mac-output-redacted',
    'serial-monitor-restored'
)
$requiredSafeCancelCheckNames = @(
    'normal-upload-button-started',
    'real-arduino-cli-or-gcc-stage-observed',
    'cancel-command-matched-upload-run-id',
    'backend-terminated-and-waited-owned-process-tree',
    'no-flash-transport-before-cancel',
    'ck-tool-tree-and-global-orphans-continuously-zero',
    'recovery-compile-new-run-id-succeeded',
    'compile-lock-released-within-5-seconds',
    'source-fqbn-and-port-unchanged'
)
if (-not ('CkEvidenceCanonicalPath' -as [type])) {
    Add-Type -TypeDefinition @'
using System;
using System.ComponentModel;
using System.IO;
using System.Runtime.InteropServices;
using System.Text;
using Microsoft.Win32.SafeHandles;

public static class CkEvidenceCanonicalPath
{
    private const uint ShareRead = 0x00000001;
    private const uint ShareWrite = 0x00000002;
    private const uint ShareDelete = 0x00000004;
    private const uint OpenExisting = 3;
    private const uint BackupSemantics = 0x02000000;

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern SafeFileHandle CreateFile(
        string name, uint access, uint share, IntPtr security,
        uint creation, uint flags, IntPtr template);

    [DllImport("kernel32.dll", CharSet = CharSet.Unicode, SetLastError = true)]
    private static extern uint GetFinalPathNameByHandle(
        SafeFileHandle handle, StringBuilder path, uint length, uint flags);

    public static string Resolve(string path)
    {
        using (SafeFileHandle handle = CreateFile(
            path, 0, ShareRead | ShareWrite | ShareDelete, IntPtr.Zero,
            OpenExisting, BackupSemantics, IntPtr.Zero))
        {
            if (handle.IsInvalid) throw new Win32Exception(Marshal.GetLastWin32Error());
            StringBuilder buffer = new StringBuilder(32768);
            uint length = GetFinalPathNameByHandle(handle, buffer, (uint)buffer.Capacity, 0);
            if (length == 0 || length >= buffer.Capacity) {
                throw new Win32Exception(Marshal.GetLastWin32Error());
            }
            string value = buffer.ToString();
            if (value.StartsWith(@"\\?\UNC\", StringComparison.OrdinalIgnoreCase)) {
                value = @"\\" + value.Substring(8);
            } else if (value.StartsWith(@"\\?\", StringComparison.OrdinalIgnoreCase)) {
                value = value.Substring(4);
            }
            string full = Path.GetFullPath(value);
            string root = Path.GetPathRoot(full);
            return full.Equals(root, StringComparison.OrdinalIgnoreCase)
                ? root
                : full.TrimEnd(Path.DirectorySeparatorChar, Path.AltDirectorySeparatorChar);
        }
    }
}
'@
}

function Get-NormalizedFullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = [System.IO.Path]::GetFullPath($Path)
    $pathRoot = [System.IO.Path]::GetPathRoot($full)
    if ($full.Equals($pathRoot, [System.StringComparison]::OrdinalIgnoreCase)) { return $pathRoot }
    return $full.TrimEnd([char[]]@('\', '/'))
}

$script:rootFull = Get-NormalizedFullPath $Root
if (-not (Test-Path -LiteralPath $script:rootFull -PathType Container)) {
    throw 'workspace root must be an existing directory'
}
$script:rootCanonical = [CkEvidenceCanonicalPath]::Resolve($script:rootFull)
$script:references = [System.Collections.Generic.List[object]]::new()
$script:referenceRoles = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
$script:staleIssues = [System.Collections.Generic.List[object]]::new()
$script:failedIssues = [System.Collections.Generic.List[object]]::new()
$script:privacyFullMacObservations = 0
$script:privacyUserPathObservations = 0
$script:c6SessionIdentity = $null
$script:nativeRuntimeIdentity = $null
$script:nativeReports = @{}

function Get-ChildPathPrefix {
    param([Parameter(Mandatory = $true)][string]$Path)
    if ($Path.EndsWith([string][System.IO.Path]::DirectorySeparatorChar, [System.StringComparison]::Ordinal) -or
        $Path.EndsWith([string][System.IO.Path]::AltDirectorySeparatorChar, [System.StringComparison]::Ordinal)) {
        return $Path
    }
    return "$Path$([System.IO.Path]::DirectorySeparatorChar)"
}

function Test-CanonicalPathWithinRoot {
    param([Parameter(Mandatory = $true)][string]$CanonicalPath)
    $candidate = Get-NormalizedFullPath $CanonicalPath
    if ($candidate.Equals($script:rootCanonical, [System.StringComparison]::OrdinalIgnoreCase)) { return $true }
    $prefix = Get-ChildPathPrefix $script:rootCanonical
    return $candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)
}

function Assert-SafeWorkspacePath {
    param(
        [Parameter(Mandatory = $true)][string]$Path,
        [ValidateSet('Candidate', 'InputFile', 'InputDirectory', 'OutputFile')][string]$Kind = 'Candidate'
    )
    $full = Get-NormalizedFullPath $Path
    $rootPrefix = Get-ChildPathPrefix $script:rootFull
    if (-not $full.Equals($script:rootFull, [System.StringComparison]::OrdinalIgnoreCase) -and
        -not $full.StartsWith($rootPrefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'workspace path escapes the lexical root'
    }

    $relative = $full.Substring($script:rootFull.Length).TrimStart([char[]]@('\', '/'))
    $current = $script:rootFull
    $nearestExisting = $script:rootFull
    if (-not [string]::IsNullOrWhiteSpace($relative)) {
        foreach ($component in $relative.Split([char[]]@('\', '/'), [System.StringSplitOptions]::RemoveEmptyEntries)) {
            $current = Join-Path $current $component
            $attributes = $null
            try { $attributes = [System.IO.File]::GetAttributes($current) } catch { break }
            if (($attributes -band [System.IO.FileAttributes]::ReparsePoint) -ne 0) {
                throw 'workspace path contains a reparse-point component'
            }
            $nearestExisting = $current
        }
    }
    $nearestCanonical = [CkEvidenceCanonicalPath]::Resolve($nearestExisting)
    if (-not (Test-CanonicalPathWithinRoot -CanonicalPath $nearestCanonical)) {
        throw 'workspace path canonical parent escapes the canonical root'
    }

    $exists = Test-Path -LiteralPath $full
    if ($exists) {
        $finalCanonical = [CkEvidenceCanonicalPath]::Resolve($full)
        if (-not (Test-CanonicalPathWithinRoot -CanonicalPath $finalCanonical)) {
            throw 'workspace path canonical target escapes the canonical root'
        }
    }
    if ($Kind -eq 'InputFile' -and -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw 'workspace input must be an existing regular file'
    }
    if ($Kind -eq 'InputDirectory' -and -not (Test-Path -LiteralPath $full -PathType Container)) {
        throw 'workspace input must be an existing directory'
    }
    if ($Kind -eq 'OutputFile' -and $exists -and -not (Test-Path -LiteralPath $full -PathType Leaf)) {
        throw 'workspace output must be a file path'
    }
    return $full
}

function Resolve-DefaultPath {
    param(
        [string]$Value,
        [Parameter(Mandatory = $true)][string]$DefaultRelative,
        [ValidateSet('Candidate', 'InputFile', 'InputDirectory', 'OutputFile')][string]$Kind = 'Candidate'
    )
    $resolved = if ([string]::IsNullOrWhiteSpace($Value)) {
        Join-Path $script:rootFull $DefaultRelative
    } elseif ([System.IO.Path]::IsPathRooted($Value)) {
        [System.IO.Path]::GetFullPath($Value)
    } else {
        [System.IO.Path]::GetFullPath((Join-Path $script:rootFull $Value))
    }
    return Assert-SafeWorkspacePath -Path $resolved -Kind $Kind
}

function Get-RelativePathSafe {
    param([Parameter(Mandatory = $true)][string]$Path)
    $full = Assert-SafeWorkspacePath -Path $Path -Kind Candidate
    $prefix = Get-ChildPathPrefix $script:rootFull
    if (-not $full.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        throw 'evidence path escapes the workspace root'
    }
    return $full.Substring($prefix.Length).Replace('\', '/')
}

function Get-Sha256FromBytes {
    param([Parameter(Mandatory = $true)][byte[]]$Bytes)
    $sha = [System.Security.Cryptography.SHA256]::Create()
    try {
        return ([System.BitConverter]::ToString($sha.ComputeHash($Bytes))).Replace('-', '').ToLowerInvariant()
    }
    finally { $sha.Dispose() }
}

function Get-FileIdentity {
    param([Parameter(Mandatory = $true)][string]$Path)
    $stream = [System.IO.File]::Open($Path, 'Open', 'Read', 'Read')
    try {
        $sha = [System.Security.Cryptography.SHA256]::Create()
        try {
            return [ordered]@{
                bytes = [int64]$stream.Length
                sha256 = ([System.BitConverter]::ToString($sha.ComputeHash($stream))).Replace('-', '').ToLowerInvariant()
            }
        }
        finally { $sha.Dispose() }
    }
    finally { $stream.Dispose() }
}

function Add-Issue {
    param(
        [ValidateSet('stale', 'failed')][string]$Kind,
        [Parameter(Mandatory = $true)][string]$Id,
        [Parameter(Mandatory = $true)][string]$Role
    )
    if ($Kind -eq 'failed') {
        if (@($script:failedIssues | Where-Object { $_.id -ceq $Id -and $_.evidenceRole -ceq $Role }).Count -eq 0) {
            $script:failedIssues.Add([ordered]@{ id = $Id; evidenceRole = $Role }) | Out-Null
        }
    }
    else {
        if (@($script:staleIssues | Where-Object { $_.id -ceq $Id -and $_.evidenceRole -ceq $Role }).Count -eq 0) {
            $script:staleIssues.Add([ordered]@{ id = $Id; evidenceRole = $Role }) | Out-Null
        }
    }
}

function Add-Reference {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)][string]$Path
    )
    if (-not $script:referenceRoles.Add($Role)) {
        Add-Issue -Kind stale -Id 'duplicate-reference-role' -Role $Role
        return $null
    }
    try { $candidatePath = Assert-SafeWorkspacePath -Path $Path -Kind Candidate }
    catch {
        Add-Issue -Kind stale -Id 'reference-outside-workspace' -Role $Role
        return $null
    }
    if (-not (Test-Path -LiteralPath $candidatePath -PathType Leaf)) {
        Add-Issue -Kind stale -Id 'required-reference-missing' -Role $Role
        return $null
    }
    try {
        $safePath = Assert-SafeWorkspacePath -Path $candidatePath -Kind InputFile
        $relative = Get-RelativePathSafe -Path $safePath
    }
    catch {
        Add-Issue -Kind stale -Id 'reference-outside-workspace' -Role $Role
        return $null
    }
    $identity = Get-FileIdentity -Path $safePath
    $record = [ordered]@{
        role = $Role
        path = $relative
        bytes = [int64]$identity.bytes
        sha256 = [string]$identity.sha256
    }
    $script:references.Add($record) | Out-Null
    return $record
}

function Get-PropertyValue {
    param($Object, [Parameter(Mandatory = $true)][string[]]$Names)
    if ($null -eq $Object) { return $null }
    foreach ($name in $Names) {
        $property = $Object.PSObject.Properties[$name]
        if ($null -ne $property) {
            # PowerShell functions enumerate array outputs by default, which
            # collapses [] to $null and makes an explicit empty JSON array
            # indistinguishable from a missing/null property. Preserve the
            # exact JSON container shape for fail-closed schema validation.
            Write-Output -NoEnumerate $property.Value
            return
        }
    }
    return $null
}

function Test-BooleanTrue {
    param($Value)
    return $Value -is [bool] -and $Value -eq $true
}

function Test-BooleanFalse {
    param($Value)
    return $Value -is [bool] -and $Value -eq $false
}

function Test-NumericValue {
    param($Value)
    if ($Value -is [bool] -or $null -eq $Value) { return $false }
    if ($Value -isnot [byte] -and $Value -isnot [sbyte] -and
        $Value -isnot [int16] -and $Value -isnot [uint16] -and
        $Value -isnot [int32] -and $Value -isnot [uint32] -and
        $Value -isnot [int64] -and $Value -isnot [uint64] -and
        $Value -isnot [single] -and $Value -isnot [double] -and
        $Value -isnot [decimal]) { return $false }
    try {
        $number = [double]$Value
        return -not [double]::IsNaN($number) -and -not [double]::IsInfinity($number)
    }
    catch { return $false }
}

function Test-IntegralNumericValue {
    param($Value)
    if (-not (Test-NumericValue $Value)) { return $false }
    $number = [double]$Value
    return [math]::Floor($number) -eq $number
}

function Test-IntegralNumberEqual {
    param($Value, [Parameter(Mandatory = $true)][int64]$Expected)
    return (Test-IntegralNumericValue $Value) -and [decimal]$Value -eq [decimal]$Expected
}

function Test-IntegralNumberAtLeast {
    param($Value, [Parameter(Mandatory = $true)][int64]$Minimum)
    return (Test-IntegralNumericValue $Value) -and [decimal]$Value -ge [decimal]$Minimum
}

function Test-JsonArray {
    param($Value)
    return $Value -is [System.Array]
}

function Get-PropertyPresence {
    param($Object, [Parameter(Mandatory = $true)][string[]]$Names)
    if ($null -ne $Object) {
        foreach ($name in $Names) {
            $property = $Object.PSObject.Properties[$name]
            if ($null -ne $property) {
                return [ordered]@{ exists = $true; value = $property.Value }
            }
        }
    }
    return [ordered]@{ exists = $false; value = $null }
}

function Get-SensitiveObservationCounts {
    param([Parameter(Mandatory = $true)][string]$Text)
    $macPatterns = @(
        '(?i)(?<![0-9a-f])(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}(?![0-9a-f])',
        # A label makes an all-numeric raw MAC unambiguous. Keep this separate
        # from the bare-token rule so decimal measurements such as
        # 64723.333333333336 cannot be mistaken for a twelve-digit MAC.
        '(?i)(?<![a-z0-9])(?:(?:base|device|diagnostic|full)[\s_-]*)?mac(?:[\s_-]*address)?(?![a-z0-9])["'']?\s*[:=]\s*["'']?\s*[0-9a-f]{12}(?![0-9a-f])',
        # An unlabeled raw token is only considered a MAC when it contains at
        # least one hexadecimal A-F character. Pure decimal runs are common in
        # timing and memory-regression evidence and are not device identifiers.
        '(?i)(?<![0-9a-f-])(?=[0-9a-f]{0,11}[a-f])[0-9a-f]{12}(?![0-9a-f-])',
        '(?i)(?<![0-9a-f])[0-9a-f]{4}(?:\.[0-9a-f]{4}){2}(?![0-9a-f])'
    )
    $pathPatterns = @(
        '(?i)(?<![a-z0-9])[a-z]:(?:\\\\|[\\/])',
        '(?i)(?:\\\\){2,}[a-z0-9._$-]+(?:\\\\|/)[a-z0-9._$-]+',
        '(?i)file:(?:\\?/){3}'
    )
    $macCount = 0
    foreach ($pattern in $macPatterns) { $macCount += [regex]::Matches($Text, $pattern).Count }
    $pathCount = 0
    foreach ($pattern in $pathPatterns) { $pathCount += [regex]::Matches($Text, $pattern).Count }
    return [ordered]@{ mac = [int]$macCount; path = [int]$pathCount }
}

function Read-JsonReference {
    param([Parameter(Mandatory = $true)][string]$Role, [Parameter(Mandatory = $true)][string]$Path)
    $reference = Add-Reference -Role $Role -Path $Path
    if ($null -eq $reference) { return $null }
    try {
        $safePath = Assert-SafeWorkspacePath -Path $Path -Kind InputFile
        $length = [int64](Get-Item -LiteralPath $safePath -ErrorAction Stop).Length
        if ($length -gt $maximumJsonEvidenceBytes) {
            Add-Issue -Kind failed -Id 'evidence-json-exceeds-16-mib' -Role $Role
            return $null
        }
        $raw = [System.IO.File]::ReadAllText($safePath, [System.Text.UTF8Encoding]::new($false))
        $sensitive = Get-SensitiveObservationCounts -Text $raw
        $script:privacyFullMacObservations += [int]$sensitive.mac
        $script:privacyUserPathObservations += [int]$sensitive.path
        if ([int]$sensitive.mac -gt 0 -or [int]$sensitive.path -gt 0) {
            Add-Issue -Kind failed -Id 'evidence-report-contains-sensitive-value' -Role $Role
        }
        return ($raw | ConvertFrom-Json)
    }
    catch {
        Add-Issue -Kind stale -Id 'invalid-json-reference' -Role $Role
        return $null
    }
}

function Resolve-RecordedPath {
    param([string]$Value)
    if ([string]::IsNullOrWhiteSpace($Value)) { return $null }
    try {
        if ([System.IO.Path]::IsPathRooted($Value)) {
            $full = [System.IO.Path]::GetFullPath($Value)
        }
        else { $full = [System.IO.Path]::GetFullPath((Join-Path $script:rootFull $Value)) }
        return Assert-SafeWorkspacePath -Path $full -Kind InputFile
    }
    catch { return $null }
}

function Test-ExpectedDigest {
    param($Record, [Parameter(Mandatory = $true)]$Actual, [Parameter(Mandatory = $true)][string]$Role)
    $expectedBytes = Get-PropertyValue -Object $Record -Names @('bytes')
    $expectedHash = [string](Get-PropertyValue -Object $Record -Names @('sha256'))
    if (-not (Test-IntegralNumericValue $expectedBytes) -or [decimal]$expectedBytes -lt 0 -or
        [decimal]$expectedBytes -ne [decimal]$Actual.bytes -or
        $expectedHash.ToLowerInvariant() -cne ([string]$Actual.sha256).ToLowerInvariant()) {
        Add-Issue -Kind stale -Id 'recorded-hash-or-size-mismatch' -Role $Role
        return $false
    }
    return $true
}

function Convert-ToDateTimeOffset {
    param($Value)
    if ([string]::IsNullOrWhiteSpace([string]$Value)) { return $null }
    $parsed = [DateTimeOffset]::MinValue
    if ([DateTimeOffset]::TryParse(
            [string]$Value,
            [System.Globalization.CultureInfo]::InvariantCulture,
            [System.Globalization.DateTimeStyles]::RoundtripKind,
            [ref]$parsed
        )) { return $parsed }
    return $null
}

function Test-StrictEvidenceTimestamp {
    param($Value)
    $text = [string]$Value
    return $text -match '^\d{4}-\d{2}-\d{2}T\d{2}:\d{2}:\d{2}(?:\.\d{1,9})?(?:Z|[+-]\d{2}:\d{2})$' -and
        $null -ne (Convert-ToDateTimeOffset $text)
}

function Test-QuickFastCompileOperation {
    param($Operation)
    $schemaVersion = Get-PropertyValue $Operation @('schemaVersion')
    $success = Get-PropertyValue $Operation @('success')
    $wallSeconds = Get-PropertyValue $Operation @('wallSeconds')
    return $null -ne $Operation -and
        [string](Get-PropertyValue $Operation @('schemaId')) -ceq 'ck.native-compile-upload-operation' -and
        (Test-IntegralNumericValue $schemaVersion) -and [int64]$schemaVersion -eq 1 -and
        [string](Get-PropertyValue $Operation @('kind')) -ceq 'compile' -and
        $success -is [bool] -and $success -eq $true -and
        (Test-NumericValue $wallSeconds) -and [double]$wallSeconds -gt 0 -and
        [string](Get-PropertyValue $Operation @('profile')) -match '^quick-fast(?:\s+\([^\r\n]*\))?$'
}

function Get-AuthenticodeState {
    param([Parameter(Mandatory = $true)][string]$Path)
    try {
        $signature = Get-AuthenticodeSignature -LiteralPath $Path
        return [ordered]@{
            status = [string]$signature.Status
            signed = ([string]$signature.Status -eq 'Valid')
            timestampVerified = ([string]$signature.Status -eq 'Valid' -and $null -ne $signature.TimeStamperCertificate)
        }
    }
    catch {
        return [ordered]@{ status = 'Unavailable'; signed = $false; timestampVerified = $false }
    }
}

function Test-SourceManifest {
    param($Manifest, $Freeze, $ManifestReference, $FreezeReference)
    $role = 'source-tree'
    if ($null -eq $Manifest -or $null -eq $Freeze -or $null -eq $ManifestReference -or $null -eq $FreezeReference) { return $null }
    $manifestSchema = Get-PropertyValue $Manifest @('schema_version', 'schemaVersion')
    $freezeSchema = Get-PropertyValue $Freeze @('schema_version', 'schemaVersion')
    $manifestControl = Get-PropertyValue $Manifest @('source_control', 'sourceControl')
    $freezeControl = Get-PropertyValue $Freeze @('source_control', 'sourceControl')
    if (-not (Test-IntegralNumberEqual $manifestSchema 1) -or
        -not (Test-IntegralNumberEqual $freezeSchema 1) -or
        [string](Get-PropertyValue $Manifest @('policy_id', 'policyId')) -cne 'ck-source-tree-v1' -or
        [string](Get-PropertyValue $Freeze @('policy_id', 'policyId')) -cne 'ck-source-tree-v1' -or
        [string](Get-PropertyValue $Manifest @('hash_algorithm', 'hashAlgorithm')) -cne 'sha256') {
        Add-Issue -Kind stale -Id 'source-manifest-or-freeze-schema-invalid' -Role $role
    }
    if ([string](Get-PropertyValue $manifestControl @('kind')) -cne 'none' -or
        $null -ne (Get-PropertyValue $manifestControl @('commit')) -or
        [string](Get-PropertyValue $freezeControl @('kind')) -cne 'none' -or
        $null -ne (Get-PropertyValue $freezeControl @('commit'))) {
        Add-Issue -Kind stale -Id 'source-control-no-git-contract-invalid' -Role $role
    }
    $recordsValue = Get-PropertyValue $Manifest @('files')
    $records = if (Test-JsonArray $recordsValue) { @($recordsValue) } else { @() }
    if (-not (Test-JsonArray $recordsValue) -or $records.Count -eq 0) {
        Add-Issue -Kind stale -Id 'source-manifest-has-no-files' -Role $role
        return $null
    }
    $paths = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    $recordsByPath = @{}
    $rows = [System.Text.StringBuilder]::new()
    $totalBytes = [int64]0
    foreach ($record in $records) {
        $relative = ([string](Get-PropertyValue $record @('path'))).Replace('\', '/')
        if ([string]::IsNullOrWhiteSpace($relative) -or [System.IO.Path]::IsPathRooted($relative) -or
            $relative -match '(^|/)\.\.(/|$)' -or -not $paths.Add($relative)) {
            Add-Issue -Kind stale -Id 'unsafe-or-duplicate-source-path' -Role $role
            continue
        }
        $recordsByPath[$relative] = $record
    }
    $sortedPaths = [string[]]@($recordsByPath.Keys)
    [System.Array]::Sort($sortedPaths, [System.StringComparer]::Ordinal)
    foreach ($relative in $sortedPaths) {
        $record = $recordsByPath[$relative]
        $full = Resolve-RecordedPath -Value $relative
        if ($null -eq $full -or -not (Test-Path -LiteralPath $full -PathType Leaf)) {
            Add-Issue -Kind stale -Id 'source-file-missing' -Role $role
            continue
        }
        $actual = Get-FileIdentity -Path $full
        [void](Test-ExpectedDigest -Record $record -Actual $actual -Role $role)
        $totalBytes += [int64]$actual.bytes
        [void]$rows.Append($relative)
        [void]$rows.Append("`t")
        [void]$rows.Append(([int64]$actual.bytes).ToString([System.Globalization.CultureInfo]::InvariantCulture))
        [void]$rows.Append("`t")
        [void]$rows.Append([string]$actual.sha256)
        [void]$rows.Append("`n")
    }
    $treeHash = Get-Sha256FromBytes -Bytes ([System.Text.UTF8Encoding]::new($false)).GetBytes($rows.ToString())
    $recordedTree = [string](Get-PropertyValue $Manifest @('tree_sha256', 'treeSha256'))
    if ($paths.Count -ne $records.Count -or $treeHash -cne $recordedTree.ToLowerInvariant()) {
        Add-Issue -Kind stale -Id 'source-tree-hash-mismatch' -Role $role
    }
    if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Manifest @('file_count', 'fileCount')) $records.Count) -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Manifest @('total_bytes', 'totalBytes')) $totalBytes)) {
        Add-Issue -Kind stale -Id 'source-tree-count-or-size-mismatch' -Role $role
    }
    if ([string](Get-PropertyValue $Freeze @('manifest_sha256', 'manifestSha256')) -cne [string]$ManifestReference.sha256 -or
        [string](Get-PropertyValue $Freeze @('tree_sha256', 'treeSha256')) -cne $recordedTree) {
        Add-Issue -Kind stale -Id 'source-freeze-binding-mismatch' -Role $role
    }
    if ([string](Get-PropertyValue $Freeze @('policy_id', 'policyId')) -cne 'ck-source-tree-v1' -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Freeze @('file_count', 'fileCount')) $records.Count) -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Freeze @('total_bytes', 'totalBytes')) $totalBytes)) {
        Add-Issue -Kind stale -Id 'source-freeze-metadata-mismatch' -Role $role
    }
    $freezePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $Freeze @('manifest_path', 'manifestPath')))
    if ($null -eq $freezePath -or (Get-RelativePathSafe $freezePath) -cne [string]$ManifestReference.path) {
        Add-Issue -Kind stale -Id 'source-freeze-manifest-path-mismatch' -Role $role
    }
    $frozenAt = Convert-ToDateTimeOffset (Get-PropertyValue $Freeze @('frozen_at', 'frozenAt'))
    if ($null -eq $frozenAt) { Add-Issue -Kind stale -Id 'source-freeze-time-missing' -Role $role }
    elseif ($frozenAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
        Add-Issue -Kind stale -Id 'source-freeze-time-is-in-the-future' -Role $role
    }
    return [ordered]@{
        policyId = 'ck-source-tree-v1'
        manifestPath = [string]$ManifestReference.path
        manifestSha256 = [string]$ManifestReference.sha256
        freezeRecordPath = [string]$FreezeReference.path
        freezeRecordSha256 = [string]$FreezeReference.sha256
        treeSha256 = $recordedTree
        frozenAt = if ($null -ne $frozenAt) { $frozenAt.ToUniversalTime().ToString('o') } else { $null }
        fileCount = $records.Count
        totalBytes = $totalBytes
    }
}

function Get-GateSourceIdentity {
    param($Gate)
    $source = Get-PropertyValue $Gate @('source_tree', 'sourceTree')
    $identity = Get-PropertyValue $source @('identity')
    if ($null -eq $identity) { return $null }
    $candidates = @($identity | Where-Object {
            $_ -isnot [string] -and $null -ne (Get-PropertyValue $_ @('tree_sha256', 'treeSha256'))
        })
    if ($candidates.Count -ne 1) { return $null }
    return $candidates[0]
}

function Test-GateReport {
    param($Gate, $GateReference, $SourceIdentity)
    $role = 'automated-release-gate'
    if ($null -eq $Gate -or $null -eq $GateReference -or $null -eq $SourceIdentity) { return $null }
    if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Gate @('schema_version', 'schemaVersion')) 2)) {
        Add-Issue -Kind stale -Id 'automated-release-gate-schema-invalid' -Role $role
    }
    $status = [string](Get-PropertyValue $Gate @('status'))
    if ($status -eq 'failed') { Add-Issue -Kind failed -Id 'automated-release-gate-failed' -Role $role }
    elseif ($status -cne 'passed') { Add-Issue -Kind stale -Id 'automated-release-gate-not-passed' -Role $role }
    $gateResultsValue = Get-PropertyValue $Gate @('gates')
    $gateResults = if (Test-JsonArray $gateResultsValue) { @($gateResultsValue) } else { @() }
    $gateNames = @($gateResults | ForEach-Object { [string](Get-PropertyValue $_ @('name')) })
    $uniqueGateNames = @($gateNames | Sort-Object -Unique)
    $missingGateNames = @($requiredGateNames | Where-Object { $gateNames -cnotcontains $_ })
    $unexpectedGateNames = @($gateNames | Where-Object { $requiredGateNames -cnotcontains $_ })
    if (-not (Test-JsonArray $gateResultsValue) -or $gateResults.Count -ne $requiredGateNames.Count -or $uniqueGateNames.Count -ne $requiredGateNames.Count -or
        $missingGateNames.Count -gt 0 -or $unexpectedGateNames.Count -gt 0) {
        Add-Issue -Kind stale -Id 'automated-release-gate-required-set-invalid' -Role $role
    }
    if ($gateResults.Count -eq 0 -or @($gateResults | Where-Object { [string]$_.status -cne 'passed' }).Count -gt 0) {
        Add-Issue -Kind failed -Id 'automated-release-gate-check-failed' -Role $role
    }
    $coverage = Get-PropertyValue $Gate @('coverage')
    if (-not (Test-IntegralNumberEqual (Get-PropertyValue $coverage @('skipped_gate_count', 'skippedGateCount')) 0) -or
        [string](Get-PropertyValue $coverage @('automated_release_gates', 'automatedReleaseGates')) -cne 'complete' -or
        [string](Get-PropertyValue $coverage @('desktop_bundle_gate', 'desktopBundleGate')) -cne 'complete') {
        Add-Issue -Kind stale -Id 'automated-release-gate-coverage-incomplete' -Role $role
    }
    if ([string](Get-PropertyValue $Gate @('expected_version', 'expectedVersion')) -cne $ExpectedVersion) {
        Add-Issue -Kind stale -Id 'release-version-mismatch' -Role $role
    }
    $gateSource = Get-GateSourceIdentity -Gate $Gate
    if ($null -eq $gateSource) {
        Add-Issue -Kind stale -Id 'gate-source-tree-identity-count-invalid' -Role $role
    }
    if ($null -eq $gateSource -or
        [string](Get-PropertyValue $gateSource @('manifest_sha256', 'manifestSha256')) -cne [string]$SourceIdentity.manifestSha256 -or
        [string](Get-PropertyValue $gateSource @('tree_sha256', 'treeSha256')) -cne [string]$SourceIdentity.treeSha256) {
        Add-Issue -Kind stale -Id 'gate-source-tree-binding-mismatch' -Role $role
    }
    $gateManifestPath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $gateSource @('manifest_path', 'manifestPath')))
    $gateFreezePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $gateSource @('freeze_record_path', 'freezeRecordPath')))
    $gateFrozenAt = Convert-ToDateTimeOffset (Get-PropertyValue $gateSource @('frozen_at', 'frozenAt'))
    $sourceFrozenAt = Convert-ToDateTimeOffset $SourceIdentity.frozenAt
    $gateSourceControl = Get-PropertyValue $gateSource @('source_control', 'sourceControl')
    if ($null -eq $gateManifestPath -or (Get-RelativePathSafe $gateManifestPath) -cne [string]$SourceIdentity.manifestPath -or
        $null -eq $gateFreezePath -or (Get-RelativePathSafe $gateFreezePath) -cne [string]$SourceIdentity.freezeRecordPath -or
        $null -eq $gateFrozenAt -or $null -eq $sourceFrozenAt -or
        $gateFrozenAt.ToUniversalTime() -ne $sourceFrozenAt.ToUniversalTime()) {
        Add-Issue -Kind stale -Id 'gate-source-tree-path-or-freeze-time-mismatch' -Role $role
    }
    if ([string](Get-PropertyValue $gateSourceControl @('kind')) -cne 'none' -or
        $null -ne (Get-PropertyValue $gateSourceControl @('commit'))) {
        Add-Issue -Kind stale -Id 'gate-source-control-no-git-contract-invalid' -Role $role
    }
    $sourceState = Get-PropertyValue $Gate @('source_tree', 'sourceTree')
    if (-not (Test-BooleanTrue (Get-PropertyValue $sourceState @('verified_before_gate', 'verifiedBeforeGate'))) -or
        -not (Test-BooleanTrue (Get-PropertyValue $sourceState @('verified_after_gate', 'verifiedAfterGate')))) {
        Add-Issue -Kind stale -Id 'gate-source-tree-not-verified-before-and-after' -Role $role
    }
    $startedAt = Convert-ToDateTimeOffset (Get-PropertyValue $Gate @('started_at', 'startedAt'))
    $finishedAt = Convert-ToDateTimeOffset (Get-PropertyValue $Gate @('finished_at', 'finishedAt'))
    $frozenAt = $sourceFrozenAt
    $now = [DateTimeOffset]::UtcNow
    if ($null -eq $startedAt -or $null -eq $finishedAt -or $finishedAt -lt $startedAt -or
        $startedAt -gt $now.AddMinutes(5) -or $finishedAt -gt $now.AddMinutes(5) -or
        ($null -ne $frozenAt -and $startedAt -lt $frozenAt)) {
        Add-Issue -Kind stale -Id 'gate-time-window-invalid' -Role $role
    }
    if ($null -ne $finishedAt -and ([DateTimeOffset]::UtcNow - $finishedAt).TotalHours -gt $MaximumEvidenceAgeHours) {
        Add-Issue -Kind stale -Id 'automated-release-gate-is-historical' -Role $role
    }
    $runId = [string](Get-PropertyValue $Gate @('run_id', 'runId'))
    if ([string]::IsNullOrWhiteSpace($runId)) { Add-Issue -Kind stale -Id 'gate-run-id-missing' -Role $role }
    return [ordered]@{
        runId = $runId
        startedAt = if ($null -ne $startedAt) { $startedAt.ToUniversalTime().ToString('o') } else { $null }
        finishedAt = if ($null -ne $finishedAt) { $finishedAt.ToUniversalTime().ToString('o') } else { $null }
        reportPath = [string]$GateReference.path
        reportSha256 = [string]$GateReference.sha256
        gateCount = $gateResults.Count
        passedGateCount = @($gateResults | Where-Object { [string]$_.status -ceq 'passed' }).Count
    }
}

function Add-GateRecordedFile {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)]$Record,
        [string]$OverridePath = ''
    )
    $recordedPath = if ([string]::IsNullOrWhiteSpace($OverridePath)) {
        [string](Get-PropertyValue $Record @('path'))
    }
    else { $OverridePath }
    $full = Resolve-RecordedPath -Value $recordedPath
    if ($null -eq $full) {
        Add-Issue -Kind stale -Id 'gate-recorded-path-invalid' -Role $Role
        return $null
    }
    $reference = Add-Reference -Role $Role -Path $full
    if ($null -ne $reference) { [void](Test-ExpectedDigest -Record $Record -Actual $reference -Role $Role) }
    return $reference
}

function Test-CompatibilityReports {
    param($Gate, $GateIdentity)
    $recordsValue = Get-PropertyValue $Gate @('compatibility_reports', 'compatibilityReports')
    $records = if (Test-JsonArray $recordsValue) { @($recordsValue) } else { @() }
    $expected = @(
        [ordered]@{
            role = 'builtin-block-generator-audit'
            path = 'artifacts/release/builtin-block-generator-audit.json'
            fullPath = $BuiltinGeneratorAuditPath
        },
        [ordered]@{
            role = 'core-compatibility-results'
            path = 'artifacts/release/core-compatibility-results.json'
            fullPath = $CoreCompatibilityReportPath
        }
    )
    $roles = @($records | ForEach-Object { [string](Get-PropertyValue $_ @('role')) })
    $paths = @($records | ForEach-Object { [string](Get-PropertyValue $_ @('path')) })
    if (-not (Test-JsonArray $recordsValue) -or $records.Count -ne 2 -or @($roles | Sort-Object -Unique).Count -ne 2 -or
        @($paths | Sort-Object -Unique).Count -ne 2 -or
        @($roles | Where-Object { $_ -notin @('builtin-block-generator-audit', 'core-compatibility-results') }).Count -gt 0) {
        Add-Issue -Kind stale -Id 'compatibility-report-set-invalid' -Role 'compatibility-reports'
    }
    $gateStarted = if ($null -ne $GateIdentity) { Convert-ToDateTimeOffset $GateIdentity.startedAt } else { $null }
    foreach ($spec in $expected) {
        $matching = @($records | Where-Object { [string](Get-PropertyValue $_ @('role')) -ceq [string]$spec.role })
        $record = if ($matching.Count -eq 1) { $matching[0] } else { $null }
        if ($null -eq $record -or [string](Get-PropertyValue $record @('path')) -cne [string]$spec.path) {
            Add-Issue -Kind stale -Id 'compatibility-report-set-invalid' -Role ([string]$spec.role)
        }
        $report = Read-JsonReference -Role ([string]$spec.role) -Path ([string]$spec.fullPath)
        $reference = @($script:references | Where-Object { $_.role -ceq [string]$spec.role }) | Select-Object -First 1
        if ($null -ne $record -and $null -ne $reference) {
            [void](Test-ExpectedDigest -Record $record -Actual $reference -Role ([string]$spec.role))
        }
        $item = if (Test-Path -LiteralPath ([string]$spec.fullPath) -PathType Leaf) { Get-Item -LiteralPath ([string]$spec.fullPath) } else { $null }
        $generatedAt = if ($null -ne $record) { Convert-ToDateTimeOffset (Get-PropertyValue $record @('generated_at', 'generatedAt')) } else { $null }
        $mtime = if ($null -ne $item) { [DateTimeOffset]$item.LastWriteTimeUtc } else { $null }
        if ($null -eq $gateStarted -or $null -eq $generatedAt -or $null -eq $mtime -or
            $generatedAt.ToUniversalTime() -ne $mtime.ToUniversalTime() -or
            $generatedAt -lt $gateStarted -or $mtime -lt $gateStarted) {
            Add-Issue -Kind stale -Id 'compatibility-report-digest-or-freshness-invalid' -Role ([string]$spec.role)
        }
        if ($null -eq $report) { continue }

        if ([string]$spec.role -ceq 'builtin-block-generator-audit') {
            $hardware = Get-PropertyPresence $report @('hardwareTested', 'hardware_tested')
            $gateHardware = Get-PropertyPresence $record @('hardware_tested', 'hardwareTested')
            $counts = Get-PropertyValue $report @('counts')
            $gateCounts = Get-PropertyValue $record @('counts')
            $auditCountsPresent = $true
            foreach ($field in @('toolboxTypes', 'targetRuns', 'passed', 'failed')) {
                if (-not (Get-PropertyPresence $counts @($field)).exists) { $auditCountsPresent = $false }
            }
            $gateAuditCountsPresent =
                (Get-PropertyPresence $gateCounts @('toolbox_types', 'toolboxTypes')).exists -and
                (Get-PropertyPresence $gateCounts @('target_runs', 'targetRuns')).exists -and
                (Get-PropertyPresence $gateCounts @('passed')).exists -and
                (Get-PropertyPresence $gateCounts @('failed')).exists
            if (-not $hardware.exists -or -not (Test-BooleanFalse $hardware.value) -or
                -not $gateHardware.exists -or -not (Test-BooleanFalse $gateHardware.value)) {
                Add-Issue -Kind failed -Id 'compatibility-hardware-boundary-violated' -Role ([string]$spec.role)
            }
            if ([string](Get-PropertyValue $report @('schema')) -cne 'ck-builtin-block-generator-audit' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $report @('version')) 1) -or
                -not $auditCountsPresent -or -not $gateAuditCountsPresent -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('toolboxTypes')) 147) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('targetRuns')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('passed')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('failed')) 0) -or
                [string](Get-PropertyValue $record @('schema')) -cne 'ck-builtin-block-generator-audit' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $record @('version')) 1) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('toolbox_types', 'toolboxTypes')) 147) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('target_runs', 'targetRuns')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('passed')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('failed')) 0)) {
                Add-Issue -Kind stale -Id 'builtin-generator-audit-invalid' -Role ([string]$spec.role)
            }
        }
        else {
            $hardware = Get-PropertyPresence $report @('hardwareTested', 'hardware_tested')
            $gateHardware = Get-PropertyPresence $record @('hardware_tested', 'hardwareTested')
            $generatorOnly = Get-PropertyPresence $report @('generatorOnly', 'generator_only')
            $gateGeneratorOnly = Get-PropertyPresence $record @('generator_only', 'generatorOnly')
            $counts = Get-PropertyValue $report @('blockEvidenceCounts', 'block_evidence_counts')
            $gateCounts = Get-PropertyValue $record @('counts')
            $resultValue = Get-PropertyValue $report @('results')
            $results = if (Test-JsonArray $resultValue) { @($resultValue) } else { @() }
            $hardwareResultViolations = @($results | Where-Object {
                    $tested = Get-PropertyPresence $_ @('HardwareTested', 'hardwareTested', 'hardware_tested')
                    -not $tested.exists -or -not (Test-BooleanFalse $tested.value)
                })
            $invalidResults = @($results | Where-Object {
                    $passed = Get-PropertyPresence $_ @('Passed', 'passed')
                    $tested = Get-PropertyPresence $_ @('HardwareTested', 'hardwareTested', 'hardware_tested')
                    -not $passed.exists -or -not (Test-BooleanTrue $passed.value) -or
                    [string](Get-PropertyValue $_ @('Evidence', 'evidence')) -cne 'compile-only' -or
                    [string](Get-PropertyValue $_ @('Source', 'source')) -cne 'built-in-generator' -or
                    -not $tested.exists -or -not (Test-BooleanFalse $tested.value)
                })
            if (-not $hardware.exists -or -not (Test-BooleanFalse $hardware.value) -or
                -not $gateHardware.exists -or -not (Test-BooleanFalse $gateHardware.value) -or
                $hardwareResultViolations.Count -gt 0) {
                Add-Issue -Kind failed -Id 'compatibility-hardware-boundary-violated' -Role ([string]$spec.role)
            }
            if ([string](Get-PropertyValue $report @('schema')) -cne 'ck-core-compatibility-results' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $report @('version')) 1) -or
                -not $generatorOnly.exists -or -not (Test-BooleanTrue $generatorOnly.value) -or
                [string](Get-PropertyValue $report @('evidence')) -cne 'compile-only' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('blocks')) 147) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('targetCells', 'target_cells')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $counts @('staticGenerationPass', 'static_generation_pass')) 294) -or
                -not (Test-JsonArray $resultValue) -or $results.Count -ne 7 -or $invalidResults.Count -gt 0 -or
                [string](Get-PropertyValue $record @('schema')) -cne 'ck-core-compatibility-results' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $record @('version')) 1) -or
                -not $gateGeneratorOnly.exists -or -not (Test-BooleanTrue $gateGeneratorOnly.value) -or
                [string](Get-PropertyValue $record @('evidence')) -cne 'compile-only' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('blocks')) 147) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('target_cells', 'targetCells')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('static_generation_pass', 'staticGenerationPass')) 294) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('generated_results', 'generatedResults')) 7) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $gateCounts @('passed')) 7)) {
                Add-Issue -Kind stale -Id 'core-compatibility-report-invalid' -Role ([string]$spec.role)
            }
        }
    }
}

function Test-DeliveryAssets {
    param($Gate, $GateIdentity)
    if ($null -eq $Gate -or $null -eq $GateIdentity) { return @() }
    $assets = [System.Collections.Generic.List[object]]::new()
    $exampleRecordsValue = Get-PropertyValue $Gate @('example_packages', 'examplePackages')
    $exampleRecords = if (Test-JsonArray $exampleRecordsValue) { @($exampleRecordsValue) } else { @() }
    $diskZips = if (Test-Path -LiteralPath $ExampleDirectory -PathType Container) {
        @(Get-ChildItem -LiteralPath $ExampleDirectory -File -Filter '*.zip')
    }
    else { @() }
    if (-not (Test-JsonArray $exampleRecordsValue) -or $exampleRecords.Count -ne 5 -or $diskZips.Count -ne 5) {
        Add-Issue -Kind stale -Id 'example-package-count-is-not-exactly-five' -Role 'example-packages'
    }
    $recordedExampleNames = @($exampleRecords | ForEach-Object {
            $value = [string](Get-PropertyValue $_ @('name'))
            if ([string]::IsNullOrWhiteSpace($value)) { Split-Path -Leaf ([string](Get-PropertyValue $_ @('path'))) } else { $value }
        })
    $diskExampleNames = @($diskZips | ForEach-Object Name)
    if (@($requiredExamplePackageNames | Where-Object { $recordedExampleNames -cnotcontains $_ }).Count -gt 0 -or
        @($recordedExampleNames | Where-Object { $requiredExamplePackageNames -cnotcontains $_ }).Count -gt 0 -or
        @($requiredExamplePackageNames | Where-Object { $diskExampleNames -cnotcontains $_ }).Count -gt 0 -or
        @($diskExampleNames | Where-Object { $requiredExamplePackageNames -cnotcontains $_ }).Count -gt 0) {
        Add-Issue -Kind stale -Id 'example-package-canonical-name-set-invalid' -Role 'example-packages'
    }
    $exampleGateStart = Convert-ToDateTimeOffset $GateIdentity.startedAt
    $recordNames = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($record in $exampleRecords) {
        $name = [string](Get-PropertyValue $record @('name'))
        if ([string]::IsNullOrWhiteSpace($name)) { $name = Split-Path -Leaf ([string](Get-PropertyValue $record @('path'))) }
        if ([string]::IsNullOrWhiteSpace($name) -or -not $recordNames.Add($name)) {
            Add-Issue -Kind stale -Id 'example-package-name-invalid-or-duplicate' -Role 'example-packages'
            continue
        }
        $full = Join-Path $ExampleDirectory $name
        if (Test-Path -LiteralPath $full -PathType Leaf) {
            $zipItem = Get-Item -LiteralPath $full
            $zipWrittenAt = [DateTimeOffset]$zipItem.LastWriteTimeUtc
            if ($null -eq $exampleGateStart -or $zipWrittenAt -lt $exampleGateStart -or
                $zipWrittenAt -gt [DateTimeOffset]::UtcNow.AddMinutes(5)) {
                Add-Issue -Kind stale -Id 'example-package-not-fresh-for-gate-run' -Role "example-package:$name"
            }
        }
        $reference = Add-GateRecordedFile -Role "example-package:$name" -Record $record -OverridePath $full
        if ($null -ne $reference) { $assets.Add([ordered]@{ role = $reference.role; kind = 'example-package' }) | Out-Null }
    }
    foreach ($zip in $diskZips) {
        if (-not $recordNames.Contains($zip.Name)) {
            Add-Issue -Kind stale -Id 'unrecorded-example-package-present' -Role 'example-packages'
        }
    }

    $releaseAssetsValue = Get-PropertyValue $Gate @('release_assets', 'releaseAssets')
    $releaseAssets = if (Test-JsonArray $releaseAssetsValue) { @($releaseAssetsValue) } else { @() }
    if (-not (Test-JsonArray $releaseAssetsValue)) {
        Add-Issue -Kind stale -Id 'release-asset-set-invalid' -Role 'delivery-assets'
    }
    $sdkRecords = @($releaseAssets | Where-Object {
            [string](Get-PropertyValue $_ @('role')) -ceq 'extension-sdk'
        })
    if ($sdkRecords.Count -ne 1) { Add-Issue -Kind stale -Id 'extension-sdk-gate-record-count-invalid' -Role 'extension-sdk' }
    else {
        $sdkGeneratedAt = Convert-ToDateTimeOffset (Get-PropertyValue $sdkRecords[0] @('generated_at', 'generatedAt'))
        $gateStart = Convert-ToDateTimeOffset $GateIdentity.startedAt
        $gateFinish = Convert-ToDateTimeOffset $GateIdentity.finishedAt
        if ($null -eq $sdkGeneratedAt -or $null -eq $gateStart -or $null -eq $gateFinish -or
            $sdkGeneratedAt -lt $gateStart -or $sdkGeneratedAt -gt $gateFinish.AddMinutes(5)) {
            Add-Issue -Kind stale -Id 'extension-sdk-not-fresh-for-gate-run' -Role 'extension-sdk'
        }
        $sdk = Add-GateRecordedFile -Role 'extension-sdk' -Record $sdkRecords[0]
        if ($null -ne $sdk) { $assets.Add([ordered]@{ role = $sdk.role; kind = 'extension-sdk' }) | Out-Null }
    }

    $bundlesValue = Get-PropertyValue $Gate @('desktop_bundles', 'desktopBundles')
    $bundles = if (Test-JsonArray $bundlesValue) { @($bundlesValue) } else { @() }
    if (-not (Test-JsonArray $bundlesValue)) {
        Add-Issue -Kind stale -Id 'installer-gate-record-count-invalid' -Role 'desktop-installers'
    }
    $msiRecords = @($bundles | Where-Object { ([string](Get-PropertyValue $_ @('path'))) -match '(?i)\.msi$' })
    $nsisRecords = @($bundles | Where-Object { ([string](Get-PropertyValue $_ @('path'))) -match '(?i)-setup\.exe$' })
    foreach ($pair in @(@('msi-installer', $msiRecords), @('nsis-installer', $nsisRecords))) {
        $roleName = [string]$pair[0]
        $recordsForRole = @($pair[1])
        if ($recordsForRole.Count -ne 1) {
            Add-Issue -Kind stale -Id 'installer-gate-record-count-invalid' -Role $roleName
            continue
        }
        $generatedAt = Convert-ToDateTimeOffset (Get-PropertyValue $recordsForRole[0] @('generated_at', 'generatedAt'))
        $gateStart = Convert-ToDateTimeOffset $GateIdentity.startedAt
        $gateFinish = Convert-ToDateTimeOffset $GateIdentity.finishedAt
        if ($null -eq $generatedAt -or $null -eq $gateStart -or $null -eq $gateFinish -or
            $generatedAt -lt $gateStart -or $generatedAt -gt $gateFinish.AddMinutes(5)) {
            Add-Issue -Kind stale -Id 'installer-not-fresh-for-gate-run' -Role $roleName
        }
        $installer = Add-GateRecordedFile -Role $roleName -Record $recordsForRole[0]
        if ($null -ne $installer) { $assets.Add([ordered]@{ role = $installer.role; kind = $roleName }) | Out-Null }
    }
    return $assets.ToArray()
}

function Test-ReportOutcome {
    param([Parameter(Mandatory = $true)][string]$Role, $Report)
    if ($null -eq $Report) { return }
    $status = [string](Get-PropertyValue $Report @('status'))
    $failurePresence = Get-PropertyPresence $Report @('failures')
    $checkPresence = Get-PropertyPresence $Report @('checks')
    $failures = if ($failurePresence.exists -and (Test-JsonArray $failurePresence.value)) { @($failurePresence.value) } else { @() }
    $checks = if ($checkPresence.exists -and (Test-JsonArray $checkPresence.value)) { @($checkPresence.value) } else { @() }
    $checksRequired = $Role -notin @('c6-upload-progress', 'c6-upload-manifest-gate')
    $checkShapeInvalid = ($checksRequired -and (-not $checkPresence.exists -or -not (Test-JsonArray $checkPresence.value))) -or
        ($checkPresence.exists -and -not (Test-JsonArray $checkPresence.value))
    if (-not $failurePresence.exists -or -not (Test-JsonArray $failurePresence.value) -or $checkShapeInvalid -or
        $status -eq 'failed' -or $failures.Count -gt 0 -or
        @($checks | Where-Object { -not (Test-BooleanTrue (Get-PropertyValue $_ @('passed'))) }).Count -gt 0) {
        Add-Issue -Kind failed -Id 'evidence-report-has-failed-checks' -Role $Role
        return
    }
    switch ($Role) {
        'native-smoke' {
            $nativeMetrics = Get-PropertyValue $Report @('metrics')
            $systemPathCount = Get-PropertyValue $nativeMetrics @('system_path_count', 'systemPathCount')
            $systemPathCompleteCount = Get-PropertyValue $nativeMetrics @('system_path_complete_count', 'systemPathCompleteCount')
            $maximumHorizontalOverflow = Get-PropertyValue $nativeMetrics @('maximum_horizontal_overflow', 'maximumHorizontalOverflow')
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 3) -or
                [string](Get-PropertyValue $Report @('test_id', 'testId')) -cne 'ck-production-native-editor-smoke-v1' -or
                $status -cne 'passed' -or
                [string](Get-PropertyValue (Get-PropertyValue $Report @('project')) @('requested_name', 'requestedName')) -cne $requiredC6ProjectName -or
                [string](Get-PropertyValue (Get-PropertyValue $Report @('project')) @('fqbn')) -cne $requiredC6Fqbn -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('themeRestored', 'theme_restored'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('declarativePackageRemoved', 'declarative_package_removed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('legacyPackageAbsent', 'legacy_package_absent'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('recoveryDraftRemoved', 'recovery_draft_removed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('unknownProjectRemoved', 'unknown_project_removed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('temporarySourcesRemoved', 'temporary_sources_removed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $Report @('cleanup')) @('finalProjectRestored', 'final_project_restored'))) -or
                -not (Test-IntegralNumberAtLeast $systemPathCount 1) -or
                -not (Test-IntegralNumericValue $systemPathCompleteCount) -or [int64]$systemPathCompleteCount -ne [int64]$systemPathCount -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('catalog_count', 'catalogCount')) 1) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('builtin_search_result_count', 'builtinSearchResultCount')) 1) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('builtin_source_label_count', 'builtinSourceLabelCount')) 1) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('package_quality_check_count', 'packageQualityCheckCount')) 8) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('imported_search_result_count', 'importedSearchResultCount')) 1) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('unknown_block_count', 'unknownBlockCount')) 1) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $nativeMetrics @('protected_project_bytes', 'protectedProjectBytes')) 1) -or
                -not (Test-BooleanTrue (Get-PropertyValue $nativeMetrics @('resource_panel_present', 'resourcePanelPresent'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $nativeMetrics @('expected_port_selected', 'expectedPortSelected'))) -or
                -not (Test-IntegralNumericValue $maximumHorizontalOverflow) -or [int64]$maximumHorizontalOverflow -gt 1 -or [int64]$maximumHorizontalOverflow -lt 0) {
                Add-Issue -Kind stale -Id 'native-smoke-schema-or-status-invalid' -Role $Role
            }
            Test-RequiredPassedChecks -Role $Role -Report $Report -RequiredIds $requiredNativeSmokeCheckNames -RequireExactSet
        }
        'desktop-memory-regression' {
            $method = Get-PropertyValue $Report @('method')
            $memoryProject = Get-PropertyValue $Report @('project')
            $cycleValue = Get-PropertyValue $Report @('cycles')
            $cycles = if (Test-JsonArray $cycleValue) { @($cycleValue) } else { @() }
            $cycleNumbersValid = @($cycles | Where-Object { -not (Test-IntegralNumericValue (Get-PropertyValue $_ @('cycle'))) }).Count -eq 0
            $cycleNumbers = if ($cycleNumbersValid) { @($cycles | ForEach-Object { [int64](Get-PropertyValue $_ @('cycle')) }) } else { @() }
            $contamination = Get-PropertyValue $Report @('contamination')
            $observationsValue = Get-PropertyValue $contamination @('observations')
            $observations = if (Test-JsonArray $observationsValue) { @($observationsValue) } else { @() }
            $comparison = Get-PropertyValue $Report @('comparison')
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schema_version', 'schemaVersion')) 1) -or
                [string](Get-PropertyValue $Report @('test_id', 'testId')) -cne 'ck-desktop-memory-lifecycle-v1' -or
                $status -cne 'passed' -or [string](Get-PropertyValue $Report @('result_kind', 'resultKind')) -cne 'conclusive' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $method @('cycles')) 10) -or
                -not (Test-JsonArray $cycleValue) -or -not $cycleNumbersValid -or $cycles.Count -ne 10 -or
                @((1..10) | Where-Object { $cycleNumbers -notcontains $_ }).Count -gt 0 -or
                [string](Get-PropertyValue $contamination @('status')) -cne 'clean' -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $contamination @('observed_poll_count', 'observedPollCount')) 0) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $contamination @('discarded_metric_groups', 'discardedMetricGroups')) 0) -or
                -not (Test-JsonArray $observationsValue) -or $observations.Count -ne 0 -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $comparison @('baseline_cycle', 'baselineCycle')) 2) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $comparison @('final_cycle', 'finalCycle')) 10) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $comparison @('sample_count', 'sampleCount')) 9) -or
                [string](Get-PropertyValue $memoryProject @('requested_name', 'requestedName')) -cne $requiredC6ProjectName -or
                [string]::IsNullOrWhiteSpace([string](Get-PropertyValue $memoryProject @('code_fingerprint', 'codeFingerprint'))) -or
                [string](Get-PropertyValue $memoryProject @('fqbn')) -cne $requiredC6Fqbn) {
                Add-Issue -Kind stale -Id 'memory-report-not-conclusive-pass' -Role $Role
            }
            Test-RequiredPassedChecks -Role $Role -Report $Report -RequiredIds $requiredMemoryCheckNames
        }
        'c6-compile-upload-benchmark' {
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 1) -or $status -cne 'passed') {
                Add-Issue -Kind stale -Id 'benchmark-schema-or-status-invalid' -Role $Role
            }
            $skippedValue = Get-PropertyValue $Report @('skippedStages', 'skipped_stages')
            $skipped = if (Test-JsonArray $skippedValue) { @($skippedValue) } else { @() }
            $cycles = Get-PropertyValue $Report @('cycles')
            $cold = Get-PropertyValue $cycles @('cold')
            $exact = Get-PropertyValue $cycles @('exact')
            $hot = Get-PropertyValue $cycles @('hotEdit', 'hot_edit')
            $upload = Get-PropertyValue $cycles @('upload')
            if (-not (Test-JsonArray $skippedValue) -or $skipped.Count -gt 0 -or $null -eq $cold -or $null -eq $exact -or $null -eq $hot -or $null -eq $upload -or
                -not (Test-BooleanTrue (Get-PropertyValue $cold @('fullBuild', 'full_build'))) -or
                -not (Test-BooleanFalse (Get-PropertyValue $cold @('exactMatch', 'exact_match'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $exact @('exactMatch', 'exact_match'))) -or
                -not (Test-BooleanFalse (Get-PropertyValue $exact @('codeChanged', 'code_changed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hot @('codeChanged', 'code_changed'))) -or
                -not (Test-BooleanFalse (Get-PropertyValue $hot @('exactMatch', 'exact_match'))) -or
                [string](Get-PropertyValue $upload @('kind')) -cne 'upload') {
                Add-Issue -Kind stale -Id 'benchmark-required-cold-exact-hot-upload-stage-missing' -Role $Role
            }
            $uploadCompileLock = Get-PropertyValue $Report @('uploadCompileLock', 'upload_compile_lock')
            $lockSeconds = Get-PropertyValue $uploadCompileLock @('seconds')
            $cycleLockSeconds = Get-PropertyValue $upload @('uploadCompileLockSeconds', 'upload_compile_lock_seconds')
            $summaryReported = Get-PropertyPresence $uploadCompileLock @('reported')
            $cycleReported = Get-PropertyPresence $upload @('uploadCompileLockWaitReported', 'upload_compile_lock_wait_reported')
            $summaryMatching = Get-PropertyPresence $uploadCompileLock @('matchingWarmupWaitObserved', 'matching_warmup_wait_observed')
            $summaryReuse = Get-PropertyPresence $uploadCompileLock @('compatibleWarmupReuseObserved', 'compatible_warmup_reuse_observed')
            $cycleMatching = Get-PropertyPresence $upload @('matchingWarmupWaitObserved', 'matching_warmup_wait_observed')
            $cycleReuse = Get-PropertyPresence $upload @('compatibleWarmupReuseObserved', 'compatible_warmup_reuse_observed')
            $failuresPresence = Get-PropertyPresence $uploadCompileLock @('failures')
            $evidencePresence = Get-PropertyPresence $upload @('evidence')
            $evidenceLines = if (-not $evidencePresence.exists -or $null -eq $evidencePresence.value) { @() } else { @($evidencePresence.value) }
            $rawUploadLockSeconds = 0.0
            $rawUploadLockCount = 0
            $rawUploadLockMentionCount = 0
            $rawWarmupMarkerCount = 0
            foreach ($line in $evidenceLines) {
                $text = [string]$line
                if ($text -match '(?i)Upload compile lock wait') {
                    $rawUploadLockMentionCount += 1
                }
                if ($text -match '^\s*\[Timing\]\s+Upload compile lock wait(?:\s*\([^\r\n)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)s\s*$') {
                    $rawUploadLockSeconds += [double]::Parse(
                        $Matches[1],
                        [System.Globalization.CultureInfo]::InvariantCulture
                    )
                    $rawUploadLockCount += 1
                }
                if ($text -match '(?i)waited for matching warmup window|Reusing compatible same-board warmup|Upload is reusing compatible same-board warmup') {
                    $rawWarmupMarkerCount += 1
                }
            }
            if ($null -eq $uploadCompileLock -or
                [string](Get-PropertyValue $uploadCompileLock @('status')) -cne 'passed' -or
                -not $summaryReported.exists -or -not ($summaryReported.value -is [bool]) -or -not ([bool]$summaryReported.value) -or
                -not (Test-NumericValue $lockSeconds) -or [double]$lockSeconds -lt 0 -or [double]$lockSeconds -gt 5 -or
                -not (Test-NumericValue (Get-PropertyValue $uploadCompileLock @('maxAllowedSeconds', 'max_allowed_seconds'))) -or
                [double](Get-PropertyValue $uploadCompileLock @('maxAllowedSeconds', 'max_allowed_seconds')) -ne 5 -or
                -not $summaryMatching.exists -or -not (Test-BooleanFalse $summaryMatching.value) -or
                -not $summaryReuse.exists -or -not (Test-BooleanFalse $summaryReuse.value) -or
                -not $cycleMatching.exists -or -not (Test-BooleanFalse $cycleMatching.value) -or
                -not $cycleReuse.exists -or -not (Test-BooleanFalse $cycleReuse.value) -or
                -not $failuresPresence.exists -or -not ($failuresPresence.value -is [System.Array]) -or @($failuresPresence.value).Count -ne 0 -or
                -not $evidencePresence.exists -or -not ($evidencePresence.value -is [System.Array]) -or
                -not $cycleReported.exists -or -not ($cycleReported.value -is [bool]) -or -not ([bool]$cycleReported.value) -or
                -not (Test-NumericValue $cycleLockSeconds) -or
                $rawUploadLockCount -lt 1 -or $rawUploadLockMentionCount -ne $rawUploadLockCount -or $rawWarmupMarkerCount -ne 0 -or
                [math]::Abs(([double]$cycleLockSeconds - [double]$lockSeconds)) -gt 0.001 -or
                [math]::Abs(($rawUploadLockSeconds - [double]$lockSeconds)) -gt 0.001) {
                Add-Issue -Kind stale -Id 'benchmark-upload-compile-lock-proof-invalid' -Role $Role
            }
            $sourceGate = Get-PropertyValue $Report @('sourceGate', 'source_gate')
            $initial = Get-PropertyValue $sourceGate @('initial')
            $hotSource = Get-PropertyValue $sourceGate @('hotEdit', 'hot_edit')
            $restored = Get-PropertyValue $sourceGate @('restored')
            $initialFingerprint = [string](Get-PropertyValue $initial @('codeFingerprint', 'code_fingerprint'))
            if ([string]::IsNullOrWhiteSpace($initialFingerprint) -or
                $initialFingerprint -cne [string](Get-PropertyValue $restored @('codeFingerprint', 'code_fingerprint')) -or
                $initialFingerprint -ceq [string](Get-PropertyValue $hotSource @('codeFingerprint', 'code_fingerprint'))) {
                Add-Issue -Kind stale -Id 'benchmark-source-edit-and-restore-proof-invalid' -Role $Role
            }
            Test-BenchmarkVerifiedBaseline -Role $Role -Report $Report
        }
        'c6-device-health' {
            $privacy = Get-PropertyValue $Report @('privacy')
            $serial = Get-PropertyValue $Report @('serialRestore', 'serial_restore')
            $hardware = Get-PropertyValue $Report @('hardwareEvidence', 'hardware_evidence')
            $healthFlashBytes = Get-PropertyValue $hardware @('flashBytes', 'flash_bytes')
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 1) -or
                $status -notin @('healthy', 'attention') -or
                -not (Test-BooleanTrue (Get-PropertyValue $privacy @('panelContainsFullMac'))) -or
                -not (Test-BooleanFalse (Get-PropertyValue $privacy @('outputContainsFullMac'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $privacy @('pageContainsFullMac'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $privacy @('exportedPanelTextRedacted'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $serial @('requested'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $serial @('verified'))) -or
                [string](Get-PropertyValue $hardware @('chipModel', 'chip_model')) -notmatch '^ESP32-C6(?:\b|$)' -or
                -not (Test-IntegralNumberAtLeast $healthFlashBytes 1) -or
                [string](Get-PropertyValue $hardware @('resolvedFqbn', 'resolved_fqbn')) -cne [string](Get-PropertyValue $Report @('fqbn'))) {
                Add-Issue -Kind stale -Id 'device-health-status-not-acceptable' -Role $Role
            }
            Test-RequiredPassedChecks -Role $Role -Report $Report -RequiredIds $requiredDeviceHealthCheckNames -RequireExactSet
        }
        'c6-upload-progress' {
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 1) -or $status -cne 'passed') {
                Add-Issue -Kind stale -Id 'upload-progress-schema-or-status-invalid' -Role $Role
            }
            $required = @('success', 'valuesBounded', 'integerPercentages', 'monotonic', 'hasTwoDigitPercentage', 'finalPercentageIs100', 'percentageTextComplete', 'percentageTextFits')
            foreach ($field in $required) {
                if (-not (Test-BooleanTrue (Get-PropertyValue $Report @($field)))) {
                    Add-Issue -Kind failed -Id 'upload-progress-check-failed' -Role $Role
                    break
                }
            }
        }
        'c6-upload-manifest-gate' {
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 2) -or $status -cne 'passed') {
                Add-Issue -Kind stale -Id 'upload-manifest-gate-schema-or-status-invalid' -Role $Role
            }
            $gate = Get-PropertyValue $Report @('gate')
            foreach ($field in @('exactMatchBeforeRejection', 'fqbnMismatchRejected', 'transportBlockedUntilRejection', 'sharedFastFreshBuild', 'sharedFastManifestVerified', 'transportRevalidated', 'transportObservedAfterRevalidation', 'ordinaryUploadSucceeded', 'allTargetFqbnsExact')) {
                if (-not (Test-BooleanTrue (Get-PropertyValue $gate @($field)))) {
                    Add-Issue -Kind failed -Id 'upload-manifest-gate-check-failed' -Role $Role
                    break
                }
            }
            $mutation = Get-PropertyValue $Report @('mutation')
            $protected = Get-PropertyValue $Report @('protectedFiles', 'protected_files')
            $restoration = Get-PropertyValue $Report @('restoration')
            $privacy = Get-PropertyValue $Report @('privacy')
            $firmwareModified = Get-PropertyValue $mutation @('firmwareArtifactsModified')
            $completeMacRecorded = Get-PropertyValue $privacy @('completeMacRecorded')
            if (-not (Test-BooleanTrue (Get-PropertyValue $mutation @('onlyManifestModified'))) -or
                -not (Test-BooleanFalse $firmwareModified) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $protected @('count')) 1) -or
                -not (Test-BooleanTrue (Get-PropertyValue $protected @('unchanged'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $restoration @('requested'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $restoration @('completed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $restoration @('valid'))) -or
                -not (Test-BooleanFalse $completeMacRecorded)) {
                Add-Issue -Kind stale -Id 'upload-manifest-gate-supporting-proof-invalid' -Role $Role
            }

            $hashGate = Get-PropertyValue $Report @('hashGate', 'hash_gate')
            foreach ($field in @('exactMatchBeforeRejection', 'artifactHashMismatchRejected', 'transportBlockedUntilRejection', 'transportBlockedUntilHashRejection', 'sharedFastFreshBuild', 'sharedFastManifestVerified', 'transportRevalidated', 'transportObservedAfterRevalidation', 'ordinaryUploadSucceeded', 'allTargetFqbnsExact')) {
                if (-not (Test-BooleanTrue (Get-PropertyValue $hashGate @($field)))) {
                    Add-Issue -Kind failed -Id 'upload-manifest-hash-gate-check-failed' -Role $Role
                    break
                }
            }
            if ([string](Get-PropertyValue $hashGate @('artifactRole', 'artifact_role')) -cne 'esp32-application') {
                Add-Issue -Kind stale -Id 'upload-manifest-hash-gate-artifact-role-invalid' -Role $Role
            }

            $hashMutation = Get-PropertyValue $Report @('hashMutation', 'hash_mutation')
            $hashFirmwareModified = Get-PropertyValue $hashMutation @('firmwareArtifactsModified', 'firmware_artifacts_modified')
            if ([string](Get-PropertyValue $hashMutation @('field')) -cne 'artifacts[esp32-application].sha256' -or
                [string](Get-PropertyValue $hashMutation @('artifactRole', 'artifact_role')) -cne 'esp32-application' -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashMutation @('onlyManifestModified', 'only_manifest_modified'))) -or
                -not (Test-BooleanFalse $hashFirmwareModified)) {
                Add-Issue -Kind stale -Id 'upload-manifest-hash-mutation-proof-invalid' -Role $Role
            }

            $hashRecovery = Get-PropertyValue $Report @('hashRecoveryManifest', 'hash_recovery_manifest')
            if ([string](Get-PropertyValue $hashRecovery @('profile')) -cne 'shared-fast' -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRecovery @('exactFqbn', 'exact_fqbn'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRecovery @('freshlySealed', 'freshly_sealed'))) -or
                [string](Get-PropertyValue $hashRecovery @('manifestHash', 'manifest_hash')) -notmatch '^[0-9a-fA-F]{64}$') {
                Add-Issue -Kind stale -Id 'upload-manifest-hash-recovery-manifest-invalid' -Role $Role
            }

            $recovery = Get-PropertyValue $Report @('recoveryManifest', 'recovery_manifest')
            if ([string](Get-PropertyValue $recovery @('profile')) -cne 'shared-fast' -or
                -not (Test-BooleanTrue (Get-PropertyValue $recovery @('exactFqbn', 'exact_fqbn'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $recovery @('freshlySealed', 'freshly_sealed'))) -or
                [string](Get-PropertyValue $recovery @('manifestHash', 'manifest_hash')) -notmatch '^[0-9a-fA-F]{64}$') {
                Add-Issue -Kind stale -Id 'upload-manifest-recovery-manifest-invalid' -Role $Role
            }

            $hashProtected = Get-PropertyValue $Report @('hashProtectedFiles', 'hash_protected_files')
            $hashRestoration = Get-PropertyValue $Report @('hashRestoration', 'hash_restoration')
            $hashOriginalRestored = if ($null -ne $hashRestoration) {
                $hashRestoration.PSObject.Properties['originalHashRestored']
            }
            else { $null }
            if (-not (Test-IntegralNumberAtLeast (Get-PropertyValue $hashProtected @('count')) 1) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashProtected @('unchanged'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRestoration @('requested'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRestoration @('completed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRestoration @('valid'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRestoration @('backupRemoved', 'backup_removed'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $hashRestoration @('residueRemoved', 'residue_removed'))) -or
                [string](Get-PropertyValue $hashRestoration @('action')) -notin @('restored-original-manifest', 'preserved-correct-rebuilt-manifest') -or
                $null -eq $hashOriginalRestored) {
                Add-Issue -Kind stale -Id 'upload-manifest-hash-protection-or-restoration-invalid' -Role $Role
            }

            foreach ($cacheField in @('initialCacheClear', 'betweenPhaseCacheClear')) {
                $cacheClear = Get-PropertyValue $Report @($cacheField, ($cacheField -creplace '([a-z])([A-Z])', '$1_$2').ToLowerInvariant())
                if ([string](Get-PropertyValue $cacheClear @('fqbn')) -cne $requiredC6Fqbn -or
                    [string](Get-PropertyValue $cacheClear @('resetScope', 'reset_scope')) -cne 'exact-full-fqbn' -or
                    -not (Test-BooleanTrue (Get-PropertyValue $cacheClear @('forceRebuildPending', 'force_rebuild_pending'))) -or
                    -not (Test-BooleanTrue (Get-PropertyValue $cacheClear @('forceCcacheRecache', 'force_ccache_recache'))) -or
                    $null -eq (Get-PropertyValue $cacheClear @('prebuiltCorePreserved', 'prebuilt_core_preserved')) -or
                    -not (Test-BooleanFalse (Get-PropertyValue $cacheClear @('prebuiltCorePreserved', 'prebuilt_core_preserved')))) {
                    Add-Issue -Kind stale -Id 'upload-manifest-between-phase-cache-clear-invalid' -Role $Role
                    break
                }
            }

            $identity = Get-PropertyValue $Report @('identity')
            $before = Get-PropertyValue $identity @('before')
            $after = Get-PropertyValue $identity @('after')
            $identityInvalid = $null -eq $before -or $null -eq $after -or
                -not (Test-BooleanTrue (Get-PropertyValue $identity @('unchanged')))
            foreach ($field in @('project', 'codeFingerprint', 'includeSignature', 'fqbn', 'port')) {
                $aliases = @($field, ($field -creplace '([a-z])([A-Z])', '$1_$2').ToLowerInvariant())
                $beforeValue = [string](Get-PropertyValue $before $aliases)
                $afterValue = [string](Get-PropertyValue $after $aliases)
                if ([string]::IsNullOrWhiteSpace($beforeValue) -or $beforeValue -cne $afterValue) {
                    $identityInvalid = $true
                }
            }
            if (([string](Get-PropertyValue $before @('project')) -replace '(?i)\.(?:maker|ck)$', '') -cne $requiredC6ProjectName -or
                [string](Get-PropertyValue $before @('fqbn')) -cne $requiredC6Fqbn -or
                -not ([string](Get-PropertyValue $before @('port'))).Equals($requiredC6Port, [System.StringComparison]::OrdinalIgnoreCase)) {
                $identityInvalid = $true
            }
            if ($identityInvalid) {
                Add-Issue -Kind stale -Id 'upload-manifest-source-target-identity-invalid' -Role $Role
            }
        }
        'c6-safe-cancel' {
            if (-not (Test-IntegralNumberEqual (Get-PropertyValue $Report @('schemaVersion', 'schema_version')) 1) -or
                [string](Get-PropertyValue $Report @('test_id', 'testId')) -cne 'ck-production-safe-cancel-c6-v1' -or
                $status -cne 'passed') {
                Add-Issue -Kind stale -Id 'safe-cancel-schema-or-status-invalid' -Role $Role
            }
            if (([string](Get-PropertyValue $Report @('project')) -replace '(?i)\.(?:maker|ck)$', '') -cne $requiredC6ProjectName -or
                [string](Get-PropertyValue $Report @('fqbn')) -cne $requiredC6Fqbn) {
                Add-Issue -Kind stale -Id 'safe-cancel-c6-identity-invalid' -Role $Role
            }
            Test-RequiredPassedChecks -Role $Role -Report $Report -RequiredIds $requiredSafeCancelCheckNames -RequireExactSet

            $runIds = Get-PropertyValue $Report @('runIds', 'run_ids')
            $uploadRunId = [string](Get-PropertyValue $runIds @('uploadSketch', 'upload_sketch'))
            $cancelRunId = [string](Get-PropertyValue $runIds @('cancelCommand', 'cancel_command'))
            $recoveryRunId = [string](Get-PropertyValue $runIds @('recoveryCompile', 'recovery_compile'))
            $uuidPattern = '^[0-9a-fA-F]{8}-[0-9a-fA-F]{4}-[1-5][0-9a-fA-F]{3}-[89abAB][0-9a-fA-F]{3}-[0-9a-fA-F]{12}$'
            if ($uploadRunId -notmatch $uuidPattern -or $cancelRunId -cne $uploadRunId -or
                $recoveryRunId -notmatch $uuidPattern -or $recoveryRunId -ceq $uploadRunId) {
                Add-Issue -Kind stale -Id 'safe-cancel-run-id-chain-invalid' -Role $Role
            }

            $operation = Get-PropertyValue $Report @('operation')
            $stageObservation = Get-PropertyValue $operation @('stageObservation', 'stage_observation')
            $stageProcess = Get-PropertyValue $stageObservation @('process')
            $cancellation = Get-PropertyValue $Report @('cancellation')
            if ([string](Get-PropertyValue $operation @('startAction', 'start_action')) -cne 'build-normal-upload-action' -or
                [string](Get-PropertyValue $operation @('backendCommand', 'backend_command')) -cne 'upload_sketch' -or
                -not (Test-BooleanTrue (Get-PropertyValue $stageProcess @('arduino_or_gcc_stage', 'arduinoOrGccStage'))) -or
                [string](Get-PropertyValue $cancellation @('command')) -cne 'cancel_foreground_build' -or
                -not (Test-BooleanTrue (Get-PropertyValue $cancellation @('uploadRejected', 'upload_rejected'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $cancellation @('backendConfirmedWait', 'backend_confirmed_wait'))) -or
                -not (Test-IntegralNumberAtLeast (Get-PropertyValue $cancellation @('terminatedProcessTreeCount', 'terminated_process_tree_count')) 1)) {
                Add-Issue -Kind stale -Id 'safe-cancel-owned-process-wait-proof-invalid' -Role $Role
            }

            $flash = Get-PropertyValue $Report @('flashTransport', 'flash_transport')
            $flashObserved = Get-PropertyValue $flash @('observed')
            $flashObservationsValue = Get-PropertyValue $flash @('observations')
            $flashObservations = if (Test-JsonArray $flashObservationsValue) { @($flashObservationsValue) } else { @() }
            if (-not (Test-BooleanFalse $flashObserved) -or
                -not (Test-IntegralNumberEqual (Get-PropertyValue $flash @('observationCount', 'observation_count')) 0) -or
                -not (Test-JsonArray $flashObservationsValue) -or $flashObservations.Count -ne 0) {
                Add-Issue -Kind failed -Id 'safe-cancel-flash-transport-observed' -Role $Role
            }

            $quiescence = Get-PropertyValue $Report @('quiescence')
            foreach ($phaseName in @('afterCancel', 'afterRecovery')) {
                $phase = Get-PropertyValue $quiescence @($phaseName, ($phaseName -creplace '([a-z])([A-Z])', '$1_$2').ToLowerInvariant())
                $samplesValue = Get-PropertyValue $phase @('samples')
                $samples = if (Test-JsonArray $samplesValue) { @($samplesValue) } else { @() }
                $tail = @($samples | Select-Object -Last 3)
                if (-not (Test-IntegralNumberEqual (Get-PropertyValue $phase @('requiredConsecutiveCleanPolls', 'required_consecutive_clean_polls')) 3) -or
                    -not (Test-IntegralNumberAtLeast (Get-PropertyValue $phase @('observedConsecutiveCleanPolls', 'observed_consecutive_clean_polls')) 3) -or
                    -not (Test-JsonArray $samplesValue) -or $tail.Count -ne 3 -or
                    @($tail | Where-Object {
                            -not (Test-IntegralNumberEqual (Get-PropertyValue $_ @('toolTreeCount', 'tool_tree_count')) 0) -or
                            -not (Test-IntegralNumberEqual (Get-PropertyValue $_ @('globalOrphanCount', 'global_orphan_count')) 0)
                        }).Count -gt 0) {
                    Add-Issue -Kind stale -Id 'safe-cancel-quiescence-proof-invalid' -Role $Role
                    break
                }
            }

            $recovery = Get-PropertyValue $Report @('recoveryCompile', 'recovery_compile')
            $lockWait = Get-PropertyValue $recovery @('compileLockWaitSeconds', 'compile_lock_wait_seconds')
            if ([string](Get-PropertyValue $recovery @('command')) -cne 'compile_sketch' -or
                -not (Test-BooleanTrue (Get-PropertyValue $recovery @('success'))) -or
                -not (Test-BooleanTrue (Get-PropertyValue $recovery @('successMarker', 'success_marker'))) -or
                -not (Test-NumericValue $lockWait) -or [double]$lockWait -lt 0 -or [double]$lockWait -gt 5) {
                Add-Issue -Kind stale -Id 'safe-cancel-recovery-compile-or-lock-proof-invalid' -Role $Role
            }

            $identity = Get-PropertyValue $Report @('identity')
            $before = Get-PropertyValue $identity @('before')
            $after = Get-PropertyValue $identity @('after')
            foreach ($field in @('project', 'sourceFingerprint', 'includeSignature', 'fqbn', 'port')) {
                $aliases = @($field, ($field -creplace '([a-z])([A-Z])', '$1_$2').ToLowerInvariant())
                if ([string](Get-PropertyValue $before $aliases) -cne [string](Get-PropertyValue $after $aliases)) {
                    Add-Issue -Kind stale -Id 'safe-cancel-source-target-identity-changed' -Role $Role
                    break
                }
            }
            $beforeSourceFingerprint = [string](Get-PropertyValue $before @('sourceFingerprint', 'source_fingerprint'))
            if ([string](Get-PropertyValue $operation @('workspaceFingerprint', 'workspace_fingerprint')) -cne $beforeSourceFingerprint -or
                [string](Get-PropertyValue $recovery @('workspaceFingerprint', 'workspace_fingerprint')) -cne $beforeSourceFingerprint) {
                Add-Issue -Kind stale -Id 'safe-cancel-invoked-source-fingerprint-mismatch' -Role $Role
            }
            if ([string](Get-PropertyValue $before @('project')) -replace '(?i)\.(?:maker|ck)$', '' -cne
                    ([string](Get-PropertyValue $Report @('project')) -replace '(?i)\.(?:maker|ck)$', '') -or
                [string](Get-PropertyValue $before @('fqbn')) -cne [string](Get-PropertyValue $Report @('fqbn')) -or
                -not ([string](Get-PropertyValue $before @('port'))).Equals(
                    [string](Get-PropertyValue $Report @('port')),
                    [System.StringComparison]::OrdinalIgnoreCase
                ) -or [string]::IsNullOrWhiteSpace($beforeSourceFingerprint)) {
                Add-Issue -Kind stale -Id 'safe-cancel-top-level-identity-mismatch' -Role $Role
            }
        }
    }
}

function Test-BenchmarkVerifiedBaseline {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)]$Report
    )
    $baseline = Get-PropertyValue $Report @('verified_baseline', 'verifiedBaseline')
    $environment = Get-PropertyValue $baseline @('environment')
    $firmware = Get-PropertyValue $baseline @('firmware')
    $device = Get-PropertyValue $baseline @('device')
    $resources = Get-PropertyValue $baseline @('resources')
    $artifactsValue = Get-PropertyValue $firmware @('artifacts')
    $artifacts = if (Test-JsonArray $artifactsValue) { @($artifactsValue) } else { @() }
    $invalid = $null -eq $baseline -or
        -not (Test-JsonArray $artifactsValue) -or
        [string](Get-PropertyValue $environment @('fqbn')) -cne [string](Get-PropertyValue $Report @('fqbn'))
    foreach ($field in @('coreId', 'coreVersion', 'arduinoCliVersion', 'toolchainKey', 'buildSignature', 'compileProfile', 'optimization')) {
        if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue $environment @($field)))) { $invalid = $true }
    }
    foreach ($hash in @(
            [string](Get-PropertyValue $firmware @('manifestSha256', 'manifest_sha256')),
            [string](Get-PropertyValue $firmware @('partitionSha256', 'partition_sha256'))
        )) {
        if ($hash -notmatch '^[0-9a-fA-F]{64}$') { $invalid = $true }
    }
    if ($artifacts.Count -eq 0) { $invalid = $true }
    $addresses = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::OrdinalIgnoreCase)
    foreach ($artifact in $artifacts) {
        $roleText = [string](Get-PropertyValue $artifact @('role'))
        $address = [string](Get-PropertyValue $artifact @('flashAddress', 'flash_address'))
        $sizeValue = Get-PropertyValue $artifact @('size')
        $hash = [string](Get-PropertyValue $artifact @('sha256'))
        if ([string]::IsNullOrWhiteSpace($roleText) -or $address -notmatch '^0x[0-9a-fA-F]+$' -or
            -not $addresses.Add($address) -or -not (Test-IntegralNumberAtLeast $sizeValue 1) -or
            $hash -notmatch '^[0-9a-fA-F]{64}$') {
            $invalid = $true
        }
    }
    $psramProperty = if ($null -ne $device) { $device.PSObject.Properties['psramBytes'] } else { $null }
    $deviceFlashBytes = Get-PropertyValue $device @('flashBytes', 'flash_bytes')
    if ([string]::IsNullOrWhiteSpace([string](Get-PropertyValue $device @('chip'))) -or
        -not (Test-IntegralNumberAtLeast $deviceFlashBytes 1) -or $null -eq $psramProperty -or
        ($null -ne $psramProperty -and $null -ne $psramProperty.Value -and
            -not (Test-IntegralNumberAtLeast $psramProperty.Value 1))) {
        $invalid = $true
    }
    $resourceValues = @{}
    foreach ($field in @('flashUsedBytes', 'flashMaxBytes', 'ramUsedBytes', 'ramMaxBytes', 'warningCount')) {
        $value = Get-PropertyValue $resources @($field)
        if ($null -eq $value) { $invalid = $true; continue }
        if (-not (Test-IntegralNumericValue $value)) { $invalid = $true; continue }
        $number = [int64]$value
        if ($number -lt 0 -or ($field -in @('flashMaxBytes', 'ramMaxBytes') -and $number -le 0)) { $invalid = $true }
        $resourceValues[$field] = $number
    }
    if ($resourceValues.ContainsKey('flashUsedBytes') -and $resourceValues.ContainsKey('flashMaxBytes') -and
        $resourceValues.flashUsedBytes -gt $resourceValues.flashMaxBytes) { $invalid = $true }
    if ($resourceValues.ContainsKey('ramUsedBytes') -and $resourceValues.ContainsKey('ramMaxBytes') -and
        $resourceValues.ramUsedBytes -gt $resourceValues.ramMaxBytes) { $invalid = $true }
    if ($invalid) { Add-Issue -Kind stale -Id 'benchmark-verified-baseline-invalid' -Role $Role }
}

function Test-RequiredPassedChecks {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        [Parameter(Mandatory = $true)]$Report,
        [Parameter(Mandatory = $true)][string[]]$RequiredIds,
        [switch]$RequireExactSet
    )
    $checkValue = Get-PropertyValue $Report @('checks')
    $checks = if (Test-JsonArray $checkValue) { @($checkValue) } else { @() }
    $ids = @($checks | ForEach-Object { [string](Get-PropertyValue $_ @('id')) })
    $uniqueIds = @($ids | Sort-Object -Unique)
    $missing = @($RequiredIds | Where-Object { $ids -cnotcontains $_ })
    $unexpected = if ($RequireExactSet) { @($ids | Where-Object { $RequiredIds -cnotcontains $_ }) } else { @() }
    if (-not (Test-JsonArray $checkValue) -or $ids.Count -lt $RequiredIds.Count -or $uniqueIds.Count -ne $ids.Count -or
        $missing.Count -gt 0 -or $unexpected.Count -gt 0 -or
        @($checks | Where-Object { -not (Test-BooleanTrue (Get-PropertyValue $_ @('passed'))) }).Count -gt 0) {
        Add-Issue -Kind stale -Id 'native-report-required-check-set-invalid' -Role $Role
    }
}

function Test-C6SessionIdentity {
    param([Parameter(Mandatory = $true)][string]$Role, $Report)
    if ($Role -notlike 'c6-*' -or $null -eq $Report) { return }
    $fqbn = [string](Get-PropertyValue $Report @('fqbn'))
    $port = [string](Get-PropertyValue $Report @('port'))
    $project = [string](Get-PropertyValue $Report @('project'))
    $project = $project -replace '(?i)\.(?:maker|ck)$', ''
    if ($fqbn -cne $requiredC6Fqbn -or
        -not $port.Equals($requiredC6Port, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $project.Equals($requiredC6ProjectName, [System.StringComparison]::OrdinalIgnoreCase)) {
        Add-Issue -Kind stale -Id 'c6-report-exact-session-identity-invalid' -Role $Role
    }
    if ($null -eq $script:c6SessionIdentity) {
        $script:c6SessionIdentity = [ordered]@{ fqbn = $fqbn; port = $port; project = $project }
        return
    }
    if ($fqbn -cne [string]$script:c6SessionIdentity.fqbn -or
        -not $port.Equals([string]$script:c6SessionIdentity.port, [System.StringComparison]::OrdinalIgnoreCase) -or
        -not $project.Equals([string]$script:c6SessionIdentity.project, [System.StringComparison]::OrdinalIgnoreCase)) {
        Add-Issue -Kind stale -Id 'c6-report-session-identity-mismatch' -Role $Role
    }
}

function Get-NormalizedEsp32Chip {
    param($Value)
    $token = ([string]$Value -replace '[^A-Za-z0-9]', '').ToUpperInvariant()
    if ($token.StartsWith('ESP32C6', [System.StringComparison]::Ordinal)) { return 'ESP32-C6' }
    return ''
}

function Test-FqbnExplicitPsramEnabled {
    param([string]$Fqbn)
    $match = [regex]::Match($Fqbn, '(?i)(?:^|:)PSRAM=([^:,]+)')
    if (-not $match.Success) { return $false }
    $mode = $match.Groups[1].Value.Trim().ToLowerInvariant()
    return $mode -notin @('', 'disabled', 'disable', 'off', 'none', 'false', 'no')
}

function Get-ProgressSnapshot {
    param([Parameter(Mandatory = $true)][string]$Role, $Progress)
    if ($null -eq $Progress) {
        Add-Issue -Kind stale -Id 'c6-upload-progress-samples-invalid' -Role $Role
        return $null
    }
    $sampleValue = Get-PropertyValue $Progress @('samples')
    $samples = if (Test-JsonArray $sampleValue) { @($sampleValue) } else { @() }
    $normalized = [System.Collections.Generic.List[object]]::new()
    $invalid = -not (Test-JsonArray $sampleValue) -or $samples.Count -eq 0
    $previousPercentage = -1
    $previousElapsed = -1.0
    $hasIntermediate = $false
    $minimum = 101
    $maximum = -1
    foreach ($sample in $samples) {
        $percentageValue = Get-PropertyValue $sample @('percentage')
        $elapsedValue = Get-PropertyValue $sample @('elapsedMs', 'elapsed_ms')
        $clientWidthValue = Get-PropertyValue $sample @('textClientWidth', 'text_client_width')
        $scrollWidthValue = Get-PropertyValue $sample @('textScrollWidth', 'text_scroll_width')
        $textFitsValue = Get-PropertyValue $sample @('textFits', 'text_fits')
        if (-not (Test-IntegralNumericValue $percentageValue) -or
            -not (Test-NumericValue $elapsedValue) -or
            -not (Test-NumericValue $clientWidthValue) -or
            -not (Test-NumericValue $scrollWidthValue) -or
            -not (Test-BooleanTrue $textFitsValue)) {
            $invalid = $true
            continue
        }
        $percentage = [int64]$percentageValue
        $elapsed = [double]$elapsedValue
        $clientWidth = [double]$clientWidthValue
        $scrollWidth = [double]$scrollWidthValue
        $visibleText = [string](Get-PropertyValue $sample @('visiblePercentageText', 'visible_percentage_text'))
        if ($percentage -lt 0 -or $percentage -gt 100 -or $percentage -lt $previousPercentage -or
            $elapsed -lt 0 -or $elapsed -lt $previousElapsed -or
            $clientWidth -lt 0 -or $scrollWidth -lt 0 -or $scrollWidth -gt ($clientWidth + 1.0) -or
            $visibleText -cne "$percentage%") {
            $invalid = $true
        }
        if ($percentage -ge 10 -and $percentage -le 99) { $hasIntermediate = $true }
        $minimum = [math]::Min($minimum, $percentage)
        $maximum = [math]::Max($maximum, $percentage)
        $previousPercentage = $percentage
        $previousElapsed = $elapsed
        $normalized.Add([ordered]@{
                elapsedMs = $elapsed
                stage = [string](Get-PropertyValue $sample @('stage'))
                message = [string](Get-PropertyValue $sample @('message'))
                visiblePercentageText = $visibleText
                percentage = $percentage
                textClientWidth = $clientWidth
                textScrollWidth = $scrollWidth
                textFits = $true
            }) | Out-Null
    }
    if ($normalized.Count -ne $samples.Count -or -not $hasIntermediate -or
        $normalized.Count -eq 0 -or [int64]$normalized[$normalized.Count - 1].percentage -ne 100 -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Progress @('sampleCount', 'sample_count')) $samples.Count) -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Progress @('minPercent', 'min_percent')) $minimum) -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $Progress @('maxPercent', 'max_percent')) $maximum)) {
        $invalid = $true
    }
    if ($invalid) { Add-Issue -Kind stale -Id 'c6-upload-progress-samples-invalid' -Role $Role }
    return [ordered]@{
        benchmarkRunId = [string](Get-PropertyValue $Progress @('benchmarkRunId', 'benchmark_run_id'))
        operationWallSeconds = Get-PropertyValue $Progress @('operationWallSeconds', 'operation_wall_seconds')
        success = Test-BooleanTrue (Get-PropertyValue $Progress @('success'))
        sampleCount = $samples.Count
        minPercent = $minimum
        maxPercent = $maximum
        samples = $normalized.ToArray()
    }
}

function Test-C6CrossReportEvidence {
    $benchmark = $script:nativeReports['c6-compile-upload-benchmark']
    $deviceHealth = $script:nativeReports['c6-device-health']
    $standaloneProgress = $script:nativeReports['c6-upload-progress']
    $memory = $script:nativeReports['desktop-memory-regression']
    $safeCancel = $script:nativeReports['c6-safe-cancel']
    $manifestGate = $script:nativeReports['c6-upload-manifest-gate']
    if ($null -eq $benchmark -or $null -eq $deviceHealth -or $null -eq $standaloneProgress -or
        $null -eq $memory -or $null -eq $safeCancel -or $null -eq $manifestGate) { return }

    $baseline = Get-PropertyValue $benchmark @('verified_baseline', 'verifiedBaseline')
    $baselineDevice = Get-PropertyValue $baseline @('device')
    $resources = Get-PropertyValue $baseline @('resources')
    $healthHardware = Get-PropertyValue $deviceHealth @('hardwareEvidence', 'hardware_evidence')
    $benchmarkFlash = Get-PropertyValue $baselineDevice @('flashBytes', 'flash_bytes')
    $healthFlash = Get-PropertyValue $healthHardware @('flashBytes', 'flash_bytes')
    $configuredFlash = Get-PropertyValue $healthHardware @('configuredFlashBytes', 'configured_flash_bytes')
    $flashMax = Get-PropertyValue $resources @('flashMaxBytes', 'flash_max_bytes')
    if ((Get-NormalizedEsp32Chip (Get-PropertyValue $baselineDevice @('chip'))) -cne 'ESP32-C6' -or
        (Get-NormalizedEsp32Chip (Get-PropertyValue $healthHardware @('chipModel', 'chip_model'))) -cne 'ESP32-C6' -or
        -not (Test-IntegralNumericValue $benchmarkFlash) -or -not (Test-IntegralNumericValue $healthFlash) -or
        -not (Test-IntegralNumericValue $configuredFlash) -or -not (Test-IntegralNumericValue $flashMax) -or
        [int64]$benchmarkFlash -ne $requiredC6PhysicalFlashBytes -or
        [int64]$healthFlash -ne $requiredC6PhysicalFlashBytes -or
        [int64]$configuredFlash -ne $requiredC6PhysicalFlashBytes -or
        [int64]$configuredFlash -gt [int64]$healthFlash -or [int64]$flashMax -gt [int64]$configuredFlash) {
        Add-Issue -Kind stale -Id 'c6-hardware-cross-report-invalid' -Role 'c6-hardware-cross-report'
    }

    $artifactsValue = Get-PropertyValue (Get-PropertyValue $baseline @('firmware')) @('artifacts')
    $artifacts = if (Test-JsonArray $artifactsValue) { @($artifactsValue) } else { @() }
    $segments = [System.Collections.Generic.List[object]]::new()
    $layoutInvalid = -not (Test-JsonArray $artifactsValue) -or $artifacts.Count -eq 0
    foreach ($artifact in $artifacts) {
        $addressText = [string](Get-PropertyValue $artifact @('flashAddress', 'flash_address'))
        $sizeValue = Get-PropertyValue $artifact @('size')
        try {
            if ($addressText -notmatch '^0x[0-9a-fA-F]+$' -or -not (Test-IntegralNumericValue $sizeValue) -or [int64]$sizeValue -le 0) { throw 'invalid segment' }
            $address = [Convert]::ToInt64($addressText.Substring(2), 16)
            $size = [int64]$sizeValue
            if ($address -lt 0 -or $address -gt $requiredC6PhysicalFlashBytes -or
                $size -gt ($requiredC6PhysicalFlashBytes - $address)) { throw 'segment outside flash' }
            $segments.Add([ordered]@{ start = $address; end = $address + $size }) | Out-Null
        }
        catch { $layoutInvalid = $true }
    }
    $orderedSegments = @($segments.ToArray() | Sort-Object { [int64]$_['start'] })
    for ($index = 1; $index -lt $orderedSegments.Count; $index++) {
        if ([int64]$orderedSegments[$index].start -lt [int64]$orderedSegments[$index - 1].end) { $layoutInvalid = $true }
    }
    if ($layoutInvalid) {
        Add-Issue -Kind stale -Id 'c6-firmware-layout-out-of-bounds-or-overlapping' -Role 'c6-hardware-cross-report'
    }

    $benchmarkPsram = Get-PropertyPresence $baselineDevice @('psramBytes', 'psram_bytes')
    $healthPsram = Get-PropertyPresence $healthHardware @('psramBytes', 'psram_bytes')
    $psramState = [string](Get-PropertyValue $healthHardware @('psramEvidenceState', 'psram_evidence_state'))
    $psramCheckState = [string](Get-PropertyValue $healthHardware @('psramCheckState', 'psram_check_state'))
    $psramInvalid = -not $benchmarkPsram.exists -or -not $healthPsram.exists
    if (-not $psramInvalid) {
        $benchmarkNull = $null -eq $benchmarkPsram.value
        $healthNull = $null -eq $healthPsram.value
        if ($benchmarkNull -xor $healthNull) { $psramInvalid = $true }
        elseif ($benchmarkNull -and $healthNull) {
            if ($psramState -cne 'unknown' -or $psramCheckState -cne 'unknown' -or
                (Test-FqbnExplicitPsramEnabled ([string](Get-PropertyValue $benchmark @('fqbn'))))) { $psramInvalid = $true }
        }
        elseif (-not (Test-IntegralNumericValue $benchmarkPsram.value) -or
            -not (Test-IntegralNumericValue $healthPsram.value) -or
            [int64]$benchmarkPsram.value -le 0 -or [int64]$benchmarkPsram.value -ne [int64]$healthPsram.value -or
            $psramState -cne 'reported' -or $psramCheckState -notin @('pass', 'warning', 'unknown')) {
            $psramInvalid = $true
        }
    }
    if ($psramInvalid) { Add-Issue -Kind stale -Id 'c6-psram-evidence-inconsistent' -Role 'c6-hardware-cross-report' }

    $embeddedProgress = Get-PropertyValue $benchmark @('uploadProgress', 'upload_progress')
    $embeddedSnapshot = Get-ProgressSnapshot -Role 'c6-compile-upload-benchmark' -Progress $embeddedProgress
    $standaloneSnapshot = Get-ProgressSnapshot -Role 'c6-upload-progress' -Progress $standaloneProgress
    $benchmarkRunId = [string](Get-PropertyValue $benchmark @('runId', 'run_id'))
    if ([string]::IsNullOrWhiteSpace($benchmarkRunId) -or $null -eq $embeddedSnapshot -or $null -eq $standaloneSnapshot -or
        $benchmarkRunId -cne [string]$embeddedSnapshot.benchmarkRunId -or
        $benchmarkRunId -cne [string]$standaloneSnapshot.benchmarkRunId) {
        Add-Issue -Kind stale -Id 'c6-upload-progress-run-id-mismatch' -Role 'c6-upload-progress-cross-report'
    }
    if ($null -ne $embeddedSnapshot -and $null -ne $standaloneSnapshot) {
        $embeddedJson = $embeddedSnapshot | ConvertTo-Json -Depth 8 -Compress
        $standaloneJson = $standaloneSnapshot | ConvertTo-Json -Depth 8 -Compress
        if ($embeddedJson -cne $standaloneJson) {
            Add-Issue -Kind stale -Id 'c6-upload-progress-cross-report-mismatch' -Role 'c6-upload-progress-cross-report'
        }
        $uploadWall = Get-PropertyValue (Get-PropertyValue $benchmark @('cycles')) @('upload')
        $uploadWall = Get-PropertyValue $uploadWall @('wallSeconds', 'wall_seconds')
        if (-not (Test-NumericValue $uploadWall) -or -not (Test-NumericValue $standaloneSnapshot.operationWallSeconds) -or
            [math]::Abs(([double]$uploadWall - [double]$standaloneSnapshot.operationWallSeconds)) -gt 0.001) {
            Add-Issue -Kind stale -Id 'c6-upload-progress-wall-time-mismatch' -Role 'c6-upload-progress-cross-report'
        }
    }

    $memoryFingerprint = [string](Get-PropertyValue (Get-PropertyValue $memory @('project')) @('code_fingerprint', 'codeFingerprint'))
    $sourceGate = Get-PropertyValue $benchmark @('sourceGate', 'source_gate')
    $benchmarkInitial = Get-PropertyValue $sourceGate @('initial')
    $benchmarkRestored = Get-PropertyValue $sourceGate @('restored')
    $safeIdentity = Get-PropertyValue $safeCancel @('identity')
    $manifestIdentity = Get-PropertyValue $manifestGate @('identity')
    $fingerprints = @(
        $memoryFingerprint,
        [string](Get-PropertyValue $benchmarkInitial @('codeFingerprint', 'code_fingerprint')),
        [string](Get-PropertyValue $benchmarkRestored @('codeFingerprint', 'code_fingerprint')),
        [string](Get-PropertyValue (Get-PropertyValue $safeIdentity @('before')) @('sourceFingerprint', 'source_fingerprint', 'codeFingerprint', 'code_fingerprint')),
        [string](Get-PropertyValue (Get-PropertyValue $safeIdentity @('after')) @('sourceFingerprint', 'source_fingerprint', 'codeFingerprint', 'code_fingerprint')),
        [string](Get-PropertyValue (Get-PropertyValue $manifestIdentity @('before')) @('sourceFingerprint', 'source_fingerprint', 'codeFingerprint', 'code_fingerprint')),
        [string](Get-PropertyValue (Get-PropertyValue $manifestIdentity @('after')) @('sourceFingerprint', 'source_fingerprint', 'codeFingerprint', 'code_fingerprint'))
    )
    if (@($fingerprints | Where-Object { [string]::IsNullOrWhiteSpace($_) }).Count -gt 0 -or
        @($fingerprints | Sort-Object -Unique).Count -ne 1) {
        Add-Issue -Kind stale -Id 'c6-source-fingerprint-cross-report-mismatch' -Role 'c6-source-identity-cross-report'
    }
    $includeSignatures = @(
        [string](Get-PropertyValue $benchmarkInitial @('includeSignature', 'include_signature')),
        [string](Get-PropertyValue $benchmarkRestored @('includeSignature', 'include_signature')),
        [string](Get-PropertyValue (Get-PropertyValue $safeIdentity @('before')) @('includeSignature', 'include_signature')),
        [string](Get-PropertyValue (Get-PropertyValue $safeIdentity @('after')) @('includeSignature', 'include_signature')),
        [string](Get-PropertyValue (Get-PropertyValue $manifestIdentity @('before')) @('includeSignature', 'include_signature')),
        [string](Get-PropertyValue (Get-PropertyValue $manifestIdentity @('after')) @('includeSignature', 'include_signature'))
    ) | Where-Object { -not [string]::IsNullOrWhiteSpace($_) }
    if (@($includeSignatures).Count -gt 1 -and @($includeSignatures | Sort-Object -Unique).Count -ne 1) {
        Add-Issue -Kind stale -Id 'c6-include-signature-cross-report-mismatch' -Role 'c6-source-identity-cross-report'
    }
}

function Test-NativeEvidenceBinding {
    param(
        [Parameter(Mandatory = $true)][string]$Role,
        $Report,
        $SourceIdentity,
        $ExecutableReference,
        $GateIdentity
    )
    if ($null -eq $Report -or $null -eq $SourceIdentity -or $null -eq $ExecutableReference -or $null -eq $GateIdentity) { return }
    Test-ReportOutcome -Role $Role -Report $Report
    $source = Get-PropertyValue $Report @('source_tree', 'sourceTree')
    if ($null -eq $source -or
        [string](Get-PropertyValue $source @('manifest_sha256', 'manifestSha256')) -cne [string]$SourceIdentity.manifestSha256 -or
        [string](Get-PropertyValue $source @('freeze_record_sha256', 'freezeRecordSha256')) -cne [string]$SourceIdentity.freezeRecordSha256 -or
        [string](Get-PropertyValue $source @('tree_sha256', 'treeSha256')) -cne [string]$SourceIdentity.treeSha256) {
        Add-Issue -Kind stale -Id 'native-report-source-binding-mismatch' -Role $Role
    }
    $sourcePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $source @('manifest_path', 'manifestPath')))
    if ($null -eq $sourcePath -or (Get-RelativePathSafe $sourcePath) -cne [string]$SourceIdentity.manifestPath) {
        Add-Issue -Kind stale -Id 'native-report-source-path-mismatch' -Role $Role
    }
    $freezePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $source @('freeze_record_path', 'freezeRecordPath')))
    $reportFrozenAt = Convert-ToDateTimeOffset (Get-PropertyValue $source @('frozen_at', 'frozenAt'))
    $sourceFrozenAt = Convert-ToDateTimeOffset $SourceIdentity.frozenAt
    if ($null -eq $freezePath -or (Get-RelativePathSafe $freezePath) -cne [string]$SourceIdentity.freezeRecordPath -or
        $null -eq $reportFrozenAt -or $null -eq $sourceFrozenAt -or
        $reportFrozenAt.ToUniversalTime() -ne $sourceFrozenAt.ToUniversalTime()) {
        Add-Issue -Kind stale -Id 'native-report-freeze-binding-mismatch' -Role $Role
    }
    $executable = Get-PropertyValue $Report @('executable')
    $executableBytesValue = Get-PropertyValue $executable @('bytes')
    if ($null -eq $executable -or
        [string](Get-PropertyValue $executable @('sha256')) -cne [string]$ExecutableReference.sha256 -or
        -not (Test-IntegralNumericValue $executableBytesValue) -or
        [decimal]$executableBytesValue -ne [decimal]$ExecutableReference.bytes) {
        Add-Issue -Kind stale -Id 'native-report-executable-binding-mismatch' -Role $Role
    }
    $executablePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $executable @('path')))
    if ($null -eq $executablePath -or (Get-RelativePathSafe $executablePath) -cne [string]$ExecutableReference.path) {
        Add-Issue -Kind stale -Id 'native-report-executable-path-mismatch' -Role $Role
    }
    $cdp = Get-PropertyValue $Report @('cdp_binding', 'cdpBinding')
    $cdpHash = [string](Get-PropertyValue $cdp @('executable_sha256', 'executableSha256', 'production_executable_sha256', 'productionExecutableSha256'))
    $executableProcessIdValue = Get-PropertyValue $executable @('process_id', 'processId')
    $executableProcessId = if (Test-IntegralNumericValue $executableProcessIdValue) { [int64]$executableProcessIdValue } else { 0 }
    $executableStartedAt = Convert-ToDateTimeOffset (Get-PropertyValue $executable @('process_started_at', 'processStartedAt'))
    $cdpProcessIdValue = Get-PropertyValue $cdp @('process_id', 'processId')
    $browserProcessIdValue = Get-PropertyValue $cdp @('browser_process_id', 'browserProcessId')
    $browserHostProcessIdValue = Get-PropertyValue $cdp @('browser_host_process_id', 'browserHostProcessId')
    $cdpProcessId = if (Test-IntegralNumericValue $cdpProcessIdValue) { [int64]$cdpProcessIdValue } else { 0 }
    $browserProcessId = if (Test-IntegralNumericValue $browserProcessIdValue) { [int64]$browserProcessIdValue } else { 0 }
    $browserHostProcessId = if (Test-IntegralNumericValue $browserHostProcessIdValue) { [int64]$browserHostProcessIdValue } else { 0 }
    $browserHostPath = [string](Get-PropertyValue $cdp @('browser_host_path', 'browserHostPath'))
    $browserHostStartedAt = Convert-ToDateTimeOffset (Get-PropertyValue $cdp @('browser_host_started_at', 'browserHostStartedAt'))
    $listenerOwnerIdValue = Get-PropertyValue $cdp @('listener_owning_process_id', 'listenerOwningProcessId')
    $debugPortValue = Get-PropertyValue $cdp @('debug_port', 'debugPort')
    $listenerOwnerId = if (Test-IntegralNumericValue $listenerOwnerIdValue) { [int64]$listenerOwnerIdValue } else { 0 }
    $debugPort = if (Test-IntegralNumericValue $debugPortValue) { [int64]$debugPortValue } else { 0 }
    $targetId = [string](Get-PropertyValue $cdp @('target_id', 'targetId'))
    $targetType = [string](Get-PropertyValue $cdp @('target_type', 'targetType'))
    $targetUrl = [string](Get-PropertyValue $cdp @('target_url', 'targetUrl'))
    $webSocketUrl = [string](Get-PropertyValue $cdp @('web_socket_debugger_url', 'webSocketDebuggerUrl'))
    $webSocketUri = $null
    try { $webSocketUri = [Uri]$webSocketUrl } catch {}
    if ($targetUrl -cne $requiredProductionTargetUrl) {
        Add-Issue -Kind stale -Id 'native-report-production-target-url-mismatch' -Role $Role
    }
    if ($null -eq $cdp -or -not (Test-BooleanTrue (Get-PropertyValue $cdp @('bound'))) -or
        $cdpHash -cne [string]$ExecutableReference.sha256 -or
        -not (Test-IntegralNumericValue $executableProcessIdValue) -or
        -not (Test-IntegralNumericValue $cdpProcessIdValue) -or
        -not (Test-IntegralNumericValue $browserProcessIdValue) -or
        -not (Test-IntegralNumericValue $browserHostProcessIdValue) -or
        -not (Test-IntegralNumericValue $listenerOwnerIdValue) -or
        -not (Test-IntegralNumericValue $debugPortValue) -or
        $executableProcessId -le 0 -or $cdpProcessId -ne $executableProcessId -or
        $browserProcessId -le 0 -or $browserHostProcessId -ne $browserProcessId -or
        $listenerOwnerId -ne $browserProcessId -or $debugPort -le 0 -or
        $browserHostPath -cne 'msedgewebview2.exe' -or
        [string]::IsNullOrWhiteSpace($targetId) -or $targetType -cne 'page' -or
        $null -eq $webSocketUri -or
        $webSocketUri.Port -ne $debugPort -or $webSocketUri.Host -notin @('127.0.0.1', 'localhost', '::1') -or
        -not $webSocketUri.AbsolutePath.EndsWith("/$targetId", [System.StringComparison]::Ordinal)) {
        Add-Issue -Kind stale -Id 'native-report-cdp-binding-mismatch' -Role $Role
    }
    $gateRun = Get-PropertyValue $Report @('gate_run', 'gateRun')
    if ($null -eq $gateRun -or [string](Get-PropertyValue $gateRun @('status')) -cne 'passed' -or
        [string](Get-PropertyValue $gateRun @('run_id', 'runId')) -cne [string]$GateIdentity.runId -or
        [string](Get-PropertyValue $gateRun @('report_sha256', 'reportSha256')) -cne [string]$GateIdentity.reportSha256) {
        Add-Issue -Kind stale -Id 'native-report-gate-run-binding-mismatch' -Role $Role
    }
    $gatePath = Resolve-RecordedPath -Value ([string](Get-PropertyValue $gateRun @('report_path', 'reportPath')))
    if ($null -eq $gatePath -or (Get-RelativePathSafe $gatePath) -cne [string]$GateIdentity.reportPath) {
        Add-Issue -Kind stale -Id 'native-report-gate-path-mismatch' -Role $Role
    }
    $boundFinished = Convert-ToDateTimeOffset (Get-PropertyValue $gateRun @('finished_at', 'finishedAt'))
    $gateFinished = Convert-ToDateTimeOffset $GateIdentity.finishedAt
    if ($null -eq $boundFinished -or $null -eq $gateFinished -or $boundFinished.ToUniversalTime() -ne $gateFinished.ToUniversalTime()) {
        Add-Issue -Kind stale -Id 'native-report-gate-time-mismatch' -Role $Role
    }
    $bindingVerification = Get-PropertyValue $Report @('binding_verification', 'bindingVerification')
    $verifiedBefore = Convert-ToDateTimeOffset (Get-PropertyValue $bindingVerification @('verified_before_at', 'verifiedBeforeAt'))
    $verifiedAfter = Convert-ToDateTimeOffset (Get-PropertyValue $bindingVerification @('verified_after_at', 'verifiedAfterAt'))
    if ($null -eq $bindingVerification -or
        -not (Test-IntegralNumberEqual (Get-PropertyValue $bindingVerification @('schema_version', 'schemaVersion')) 1) -or
        -not (Test-BooleanTrue (Get-PropertyValue $bindingVerification @('unchanged'))) -or
        $null -eq $verifiedBefore -or $null -eq $verifiedAfter -or $verifiedAfter -lt $verifiedBefore) {
        Add-Issue -Kind stale -Id 'native-report-binding-not-verified-before-and-after' -Role $Role
    }
    if ($Role -ceq 'c6-compile-upload-benchmark') {
        $verifiedBaseline = Get-PropertyValue $Report @('verified_baseline', 'verifiedBaseline')
        $baselineCreatedAt = Convert-ToDateTimeOffset (Get-PropertyValue $verifiedBaseline @('createdAt', 'created_at'))
        $baselineVerifiedAt = Convert-ToDateTimeOffset (Get-PropertyValue $verifiedBaseline @('verifiedAt', 'verified_at'))
        if ($null -eq $baselineCreatedAt -or $null -eq $baselineVerifiedAt -or
            $null -eq $verifiedBefore -or $null -eq $verifiedAfter -or
            $baselineCreatedAt -lt $verifiedBefore -or $baselineVerifiedAt -lt $baselineCreatedAt -or
            $baselineVerifiedAt -gt $verifiedAfter) {
            Add-Issue -Kind stale -Id 'benchmark-verified-baseline-time-invalid' -Role $Role
        }
    }
    $captured = $null
    foreach ($field in @('evidence_finalized_at', 'evidenceFinalizedAt', 'completedAt', 'capturedAt', 'generatedAt')) {
        $captured = Convert-ToDateTimeOffset (Get-PropertyValue $Report @($field))
        if ($null -ne $captured) { break }
    }
    $now = [DateTimeOffset]::UtcNow
    if ($null -eq $captured -or $null -eq $gateFinished -or
        $null -eq $verifiedBefore -or $null -eq $verifiedAfter -or
        $null -eq $executableStartedAt -or $null -eq $browserHostStartedAt -or
        $gateFinished -gt $executableStartedAt -or $executableStartedAt -gt $verifiedBefore -or
        $gateFinished -gt $browserHostStartedAt -or $browserHostStartedAt -gt $verifiedBefore -or
        $gateFinished -gt $verifiedBefore -or $verifiedBefore -gt $captured -or
        $captured -gt $verifiedAfter -or $verifiedAfter -gt $now.AddMinutes(5) -or
        ($now - $captured).TotalHours -gt $MaximumEvidenceAgeHours) {
        Add-Issue -Kind stale -Id 'native-report-is-missing-fresh-post-gate-time' -Role $Role
    }

    $runtimeIdentity = [ordered]@{
        executableProcessId = $executableProcessId
        executableStartedAt = if ($null -ne $executableStartedAt) { $executableStartedAt.ToUniversalTime().ToString('o') } else { '' }
        cdpProcessId = $cdpProcessId
        browserProcessId = $browserProcessId
        browserHostProcessId = $browserHostProcessId
        browserHostStartedAt = if ($null -ne $browserHostStartedAt) { $browserHostStartedAt.ToUniversalTime().ToString('o') } else { '' }
        listenerOwnerId = $listenerOwnerId
        debugPort = $debugPort
        targetId = $targetId
        targetType = $targetType
        targetUrl = $targetUrl
        webSocketUrl = $webSocketUrl
        executableSha256 = [string]$ExecutableReference.sha256
        gateRunId = [string]$GateIdentity.runId
        gateReportSha256 = [string]$GateIdentity.reportSha256
    }
    if ($null -eq $script:nativeRuntimeIdentity) {
        $script:nativeRuntimeIdentity = $runtimeIdentity
    }
    else {
        foreach ($field in $runtimeIdentity.Keys) {
            if ([string]$runtimeIdentity[$field] -cne [string]$script:nativeRuntimeIdentity[$field]) {
                Add-Issue -Kind stale -Id 'native-reports-do-not-share-one-runtime-binding' -Role $Role
                break
            }
        }
    }
}

function Test-FirstCompilePerformanceEvidence {
    param(
        $Report,
        [Parameter(Mandatory = $true)][string]$ReportPath,
        $SourceIdentity,
        $GateIdentity,
        $ExecutableReference,
        $C6Benchmark,
        $NativeRuntimeIdentity
    )
    $role = 'first-compile-performance'
    if ($null -eq $Report -or $null -eq $SourceIdentity -or $null -eq $GateIdentity -or
        $null -eq $ExecutableReference -or $null -eq $C6Benchmark -or $null -eq $NativeRuntimeIdentity) { return }

    $schemaVersion = Get-PropertyValue $Report @('schemaVersion')
    if ([string](Get-PropertyValue $Report @('schemaId')) -cne 'ck.first-compile-performance-summary' -or
        -not (Test-IntegralNumericValue $schemaVersion) -or [int64]$schemaVersion -ne 1) {
        Add-Issue -Kind stale -Id 'first-compile-performance-schema-invalid' -Role $role
    }
    if ([string](Get-PropertyValue $Report @('status')) -cne 'passed') {
        Add-Issue -Kind failed -Id 'first-compile-performance-not-passed' -Role $role
    }
    if ([string](Get-PropertyValue $Report @('evidenceMode')) -cne 'direct-local-file-verification-no-build-executed' -or
        [string](Get-PropertyValue $Report @('attestationBoundary')) -cne 'same-source-files-directly-verified-not-a-cryptographic-signer') {
        Add-Issue -Kind stale -Id 'first-compile-performance-evidence-boundary-invalid' -Role $role
    }

    $policy = Get-PropertyValue $Report @('policy')
    $minimumSamples = Get-PropertyValue $policy @('minimumSamplesPerMode')
    $maximumLock = Get-PropertyValue $policy @('maximumCompileLockSeconds')
    $targetImprovement = Get-PropertyValue $policy @('targetImprovementPercent')
    $requireMedian = Get-PropertyValue $policy @('requireMedianAndP95')
    $requireBaseline = Get-PropertyValue $policy @('requireSuccessfulUploadBaseline')
    $requireExactSamples = Get-PropertyValue $policy @('requireExactSamplesPerMode')
    $requireNonOverlappingSamples = Get-PropertyValue $policy @('requireNonOverlappingSamples')
    $requireGateExecutableSampleOrder = Get-PropertyValue $policy @('requireGateExecutableSampleOrder')
    $maximumBatchSpanHours = Get-PropertyValue $policy @('maximumBatchSpanHours')
    $maximumPerformanceEvidenceAgeHours = Get-PropertyValue $policy @('maximumEvidenceAgeHours')
    $futureTimestampToleranceMinutes = Get-PropertyValue $policy @('futureTimestampToleranceMinutes')
    $requiredTemporalSequenceValue = Get-PropertyValue $policy @('requiredTemporalSequence')
    $requiredTemporalSequence = if (Test-JsonArray $requiredTemporalSequenceValue) { @($requiredTemporalSequenceValue) } else { @() }
    $expectedTemporalSequence = @(
        'firstProjectCold',
        'readyInstallCold',
        'firstProjectCold',
        'readyInstallCold',
        'firstProjectCold',
        'readyInstallCold'
    )
    $temporalSequenceInvalid = $requiredTemporalSequence.Count -ne $expectedTemporalSequence.Count
    if (-not $temporalSequenceInvalid) {
        for ($index = 0; $index -lt $expectedTemporalSequence.Count; $index++) {
            if ([string]$requiredTemporalSequence[$index] -cne $expectedTemporalSequence[$index]) {
                $temporalSequenceInvalid = $true
                break
            }
        }
    }
    $compileProfiles = Get-PropertyValue $policy @('compileProfilesByColdMode')
    $compileProfileModeNames = if ($null -ne $compileProfiles) { @($compileProfiles.PSObject.Properties.Name) } else { @() }
    $firstProfiles = Get-PropertyValue $compileProfiles @('firstProjectCold')
    $readyProfiles = Get-PropertyValue $compileProfiles @('readyInstallCold')
    $firstProfileNames = if ($null -ne $firstProfiles) { @($firstProfiles.PSObject.Properties.Name) } else { @() }
    $readyProfileNames = if ($null -ne $readyProfiles) { @($readyProfiles.PSObject.Properties.Name) } else { @() }
    $cacheClearPolicy = Get-PropertyValue $policy @('cacheClearByColdMode')
    $cacheModeNames = if ($null -ne $cacheClearPolicy) { @($cacheClearPolicy.PSObject.Properties.Name) } else { @() }
    $expectedCachePolicies = [ordered]@{
        firstProjectCold = [ordered]@{
            reset_scope = 'first-project-full-fqbn'; ccache_store_preserved = $true
            prebuilt_core_preserved = $false; prebuilt_core_validated = $false
            force_rebuild_pending = $false; force_ccache_recache = $false
        }
        readyInstallCold = [ordered]@{
            reset_scope = 'ready-install-project-full-fqbn'; ccache_store_preserved = $true
            prebuilt_core_preserved = $true; prebuilt_core_validated = $true
            force_rebuild_pending = $false; force_ccache_recache = $false
        }
    }
    $cacheClearPolicyInvalid = $cacheModeNames.Count -ne 2 -or
        $cacheModeNames -cnotcontains 'firstProjectCold' -or $cacheModeNames -cnotcontains 'readyInstallCold'
    foreach ($modeName in @('firstProjectCold', 'readyInstallCold')) {
        $actualModePolicy = Get-PropertyValue $cacheClearPolicy @($modeName)
        $actualNames = if ($null -ne $actualModePolicy) { @($actualModePolicy.PSObject.Properties.Name) } else { @() }
        if ($actualNames.Count -ne 6) { $cacheClearPolicyInvalid = $true; continue }
        foreach ($field in $expectedCachePolicies[$modeName].Keys) {
            if ($actualNames -cnotcontains $field) { $cacheClearPolicyInvalid = $true; continue }
            $actualValue = Get-PropertyValue $actualModePolicy @($field)
            $expectedValue = $expectedCachePolicies[$modeName][$field]
            if ($expectedValue -is [bool]) {
                if ($actualValue -isnot [bool] -or $actualValue -ne $expectedValue) { $cacheClearPolicyInvalid = $true }
            }
            elseif ([string]$actualValue -cne [string]$expectedValue) { $cacheClearPolicyInvalid = $true }
        }
    }
    if ($null -eq $policy -or
        -not (Test-IntegralNumericValue $minimumSamples) -or [int64]$minimumSamples -ne 3 -or
        -not (Test-NumericValue $maximumLock) -or [double]$maximumLock -ne 5 -or
        -not (Test-NumericValue $targetImprovement) -or [double]$targetImprovement -ne 30 -or
        [string](Get-PropertyValue $policy @('percentileMethod')) -cne 'nearest-rank' -or
        $requireMedian -isnot [bool] -or $requireMedian -ne $true -or
        $requireBaseline -isnot [bool] -or $requireBaseline -ne $true -or
        $requireExactSamples -isnot [bool] -or $requireExactSamples -ne $true -or
        $requireNonOverlappingSamples -isnot [bool] -or $requireNonOverlappingSamples -ne $true -or
        $requireGateExecutableSampleOrder -isnot [bool] -or $requireGateExecutableSampleOrder -ne $true -or
        -not (Test-NumericValue $maximumBatchSpanHours) -or [double]$maximumBatchSpanHours -ne 2 -or
        -not (Test-NumericValue $maximumPerformanceEvidenceAgeHours) -or [double]$maximumPerformanceEvidenceAgeHours -ne 72 -or
        -not (Test-NumericValue $futureTimestampToleranceMinutes) -or [double]$futureTimestampToleranceMinutes -ne 5 -or
        $temporalSequenceInvalid -or
        $compileProfileModeNames.Count -ne 2 -or
        $compileProfileModeNames -cnotcontains 'firstProjectCold' -or
        $compileProfileModeNames -cnotcontains 'readyInstallCold' -or
        $firstProfileNames.Count -ne 2 -or $firstProfileNames -cnotcontains 'cold' -or $firstProfileNames -cnotcontains 'upload' -or
        $readyProfileNames.Count -ne 2 -or $readyProfileNames -cnotcontains 'cold' -or $readyProfileNames -cnotcontains 'upload' -or
        [string](Get-PropertyValue $firstProfiles @('cold')) -cne 'quick-fast' -or
        [string](Get-PropertyValue $firstProfiles @('upload')) -cne 'quick-fast' -or
        [string](Get-PropertyValue $readyProfiles @('cold')) -cne 'quick-fast' -or
        [string](Get-PropertyValue $readyProfiles @('upload')) -cne 'shared-fast' -or
        $cacheClearPolicyInvalid) {
        Add-Issue -Kind failed -Id 'first-compile-performance-policy-invalid' -Role $role
    }

    $batch = Get-PropertyValue $Report @('batch')
    $batchProperties = if ($null -ne $batch) { @($batch.PSObject.Properties.Name) } else { @() }
    $batchSpanSeconds = Get-PropertyValue $batch @('spanSeconds')
    $batchExpiresAt = Convert-ToDateTimeOffset (Get-PropertyValue $batch @('expiresAt'))
    if ($null -eq $batch -or $batchProperties.Count -ne 2 -or
        $batchProperties -cnotcontains 'spanSeconds' -or $batchProperties -cnotcontains 'expiresAt' -or
        -not (Test-NumericValue $batchSpanSeconds) -or [double]$batchSpanSeconds -le 0 -or
        [double]$batchSpanSeconds -gt (2 * 60 * 60) -or $null -eq $batchExpiresAt) {
        Add-Issue -Kind failed -Id 'first-compile-performance-temporal-batch-invalid' -Role $role
    }

    $failuresPresence = Get-PropertyPresence $Report @('failures')
    if (-not $failuresPresence.exists -or -not (Test-JsonArray $failuresPresence.value) -or @($failuresPresence.value).Count -ne 0) {
        Add-Issue -Kind failed -Id 'first-compile-performance-contains-failures' -Role $role
    }

    $samples = Get-PropertyValue $Report @('samples')
    $statistics = Get-PropertyValue $Report @('statistics')
    $modeNames = @('firstProjectCold', 'readyInstallCold')
    $sampleProperties = if ($null -ne $samples) { @($samples.PSObject.Properties.Name) } else { @() }
    if ($sampleProperties.Count -ne 2 -or @($modeNames | Where-Object { $sampleProperties -cnotcontains $_ }).Count -gt 0) {
        Add-Issue -Kind failed -Id 'first-compile-performance-sample-set-invalid' -Role $role
    }
    $sampleIds = [System.Collections.Generic.HashSet[string]]::new([System.StringComparer]::Ordinal)
    $calculatedStatistics = @{}
    foreach ($mode in $modeNames) {
        $modeSamplesValue = Get-PropertyValue $samples @($mode)
        $modeSamples = if (Test-JsonArray $modeSamplesValue) { @($modeSamplesValue) } else { @() }
        $seconds = [System.Collections.Generic.List[double]]::new()
        $modeInvalid = -not (Test-JsonArray $modeSamplesValue) -or $modeSamples.Count -ne 3
        foreach ($sample in $modeSamples) {
            $sampleId = [string](Get-PropertyValue $sample @('sampleId'))
            $secondsValue = Get-PropertyValue $sample @('seconds')
            if ($sampleId -notmatch "^$mode-[0-9]{2,}-[0-9a-f]{12}$" -or -not $sampleIds.Add($sampleId) -or
                -not (Test-NumericValue $secondsValue) -or [double]$secondsValue -le 0) {
                $modeInvalid = $true
                continue
            }
            $seconds.Add([double]$secondsValue) | Out-Null
        }
        if ($modeInvalid -or $seconds.Count -ne $modeSamples.Count) {
            Add-Issue -Kind failed -Id 'first-compile-performance-sample-set-invalid' -Role $role
            continue
        }
        $sorted = [double[]]$seconds.ToArray()
        [System.Array]::Sort($sorted)
        $middle = [int][math]::Floor($sorted.Length / 2)
        $median = if (($sorted.Length % 2) -eq 0) {
            ($sorted[$middle - 1] + $sorted[$middle]) / 2
        } else { $sorted[$middle] }
        $p95Index = [math]::Max(0, [math]::Ceiling(0.95 * $sorted.Length) - 1)
        $calculatedStatistics[$mode] = [ordered]@{
            count = $sorted.Length
            median = [math]::Round($median, 3)
            maximum = [math]::Round($sorted[$sorted.Length - 1], 3)
            p95 = [math]::Round($sorted[[int]$p95Index], 3)
        }

        $reported = Get-PropertyValue $statistics @($mode)
        $reportedCount = Get-PropertyValue $reported @('count')
        $reportedMedian = Get-PropertyValue $reported @('medianSeconds')
        $reportedMaximum = Get-PropertyValue $reported @('maxSeconds')
        $reportedP95 = Get-PropertyValue $reported @('p95Seconds')
        if ($null -eq $reported -or
            -not (Test-IntegralNumericValue $reportedCount) -or [int64]$reportedCount -ne $sorted.Length -or
            -not (Test-NumericValue $reportedMedian) -or -not (Test-NumericValue $reportedMaximum) -or
            -not (Test-NumericValue $reportedP95) -or
            [math]::Abs([double]$reportedMedian - [double]$calculatedStatistics[$mode].median) -gt 0.001 -or
            [math]::Abs([double]$reportedMaximum - [double]$calculatedStatistics[$mode].maximum) -gt 0.001 -or
            [math]::Abs([double]$reportedP95 - [double]$calculatedStatistics[$mode].p95) -gt 0.001) {
            Add-Issue -Kind failed -Id 'first-compile-performance-statistics-invalid' -Role $role
        }
    }

    $improvement = Get-PropertyValue $Report @('improvementPercent')
    $medianImprovement = Get-PropertyValue $improvement @('median')
    $p95Improvement = Get-PropertyValue $improvement @('p95')
    $medianTargetMet = Get-PropertyValue $improvement @('medianTargetMet')
    $p95TargetMet = Get-PropertyValue $improvement @('p95TargetMet')
    $firstCalculated = $calculatedStatistics['firstProjectCold']
    $readyCalculated = $calculatedStatistics['readyInstallCold']
    $improvementInvalid = $null -eq $firstCalculated -or $null -eq $readyCalculated -or
        -not (Test-NumericValue $medianImprovement) -or -not (Test-NumericValue $p95Improvement) -or
        [double]$medianImprovement -lt 30 -or [double]$p95Improvement -lt 30 -or
        $medianTargetMet -isnot [bool] -or $medianTargetMet -ne $true -or
        $p95TargetMet -isnot [bool] -or $p95TargetMet -ne $true
    if (-not $improvementInvalid) {
        $expectedMedianImprovement = (($firstCalculated.median - $readyCalculated.median) / $firstCalculated.median) * 100
        $expectedP95Improvement = (($firstCalculated.p95 - $readyCalculated.p95) / $firstCalculated.p95) * 100
        if ([math]::Abs([double]$medianImprovement - $expectedMedianImprovement) -gt 0.011 -or
            [math]::Abs([double]$p95Improvement - $expectedP95Improvement) -gt 0.011) {
            $improvementInvalid = $true
        }
    }
    if ($improvementInvalid) {
        Add-Issue -Kind failed -Id 'first-compile-performance-target-invalid' -Role $role
    }

    $binding = Get-PropertyValue $Report @('binding')
    $boundSource = Get-PropertyValue $binding @('sourceTree')
    if ($null -eq $boundSource -or
        [string](Get-PropertyValue $boundSource @('manifestSha256')) -cne [string]$SourceIdentity.manifestSha256 -or
        [string](Get-PropertyValue $boundSource @('freezeRecordSha256')) -cne [string]$SourceIdentity.freezeRecordSha256 -or
        [string](Get-PropertyValue $boundSource @('treeSha256')) -cne [string]$SourceIdentity.treeSha256) {
        Add-Issue -Kind stale -Id 'first-compile-performance-source-binding-mismatch' -Role $role
    }
    $boundGate = Get-PropertyValue $binding @('gateRun')
    if ($null -eq $boundGate -or [string](Get-PropertyValue $boundGate @('status')) -cne 'passed' -or
        [string](Get-PropertyValue $boundGate @('reportSha256')) -cne [string]$GateIdentity.reportSha256) {
        Add-Issue -Kind stale -Id 'first-compile-performance-gate-binding-mismatch' -Role $role
    }
    $boundExecutable = Get-PropertyValue $binding @('executable')
    $boundExecutableBytes = Get-PropertyValue $boundExecutable @('bytes')
    $boundProcessId = Get-PropertyValue $boundExecutable @('processId')
    if ($null -eq $boundExecutable -or
        [string](Get-PropertyValue $boundExecutable @('sha256')) -cne [string]$ExecutableReference.sha256 -or
        -not (Test-IntegralNumericValue $boundExecutableBytes) -or [int64]$boundExecutableBytes -ne [int64]$ExecutableReference.bytes) {
        Add-Issue -Kind stale -Id 'first-compile-performance-executable-binding-mismatch' -Role $role
    }
    $benchmarkExecutable = Get-PropertyValue $C6Benchmark @('executable')
    $benchmarkProcessId = Get-PropertyValue $benchmarkExecutable @('process_id', 'processId')
    if (-not (Test-IntegralNumericValue $boundProcessId) -or [int64]$boundProcessId -le 0 -or
        -not (Test-IntegralNumericValue $benchmarkProcessId) -or
        [int64]$boundProcessId -ne [int64]$benchmarkProcessId -or
        [int64]$boundProcessId -ne [int64]$NativeRuntimeIdentity.executableProcessId) {
        Add-Issue -Kind stale -Id 'first-compile-performance-process-binding-mismatch' -Role $role
    }

    $boundFqbn = [string](Get-PropertyValue $binding @('fqbn'))
    $benchmarkFqbn = [string](Get-PropertyValue $C6Benchmark @('fqbn'))
    if ($boundFqbn -cne $requiredC6Fqbn -or $boundFqbn -cne $benchmarkFqbn) {
        Add-Issue -Kind stale -Id 'first-compile-performance-fqbn-mismatch' -Role $role
    }
    $boundEnvironment = Get-PropertyValue $binding @('environment')
    $benchmarkBaseline = Get-PropertyValue $C6Benchmark @('verified_baseline', 'verifiedBaseline')
    $benchmarkEnvironment = Get-PropertyValue $benchmarkBaseline @('environment')
    $benchmarkCycles = Get-PropertyValue $C6Benchmark @('cycles')
    $benchmarkCold = Get-PropertyValue $benchmarkCycles @('cold')
    $benchmarkExact = Get-PropertyValue $benchmarkCycles @('exact')
    $benchmarkHotEdit = Get-PropertyValue $benchmarkCycles @('hotEdit')
    $benchmarkUpload = Get-PropertyValue $benchmarkCycles @('upload')
    $benchmarkColdProfile = [string](Get-PropertyValue $benchmarkCold @('profile'))
    $benchmarkUploadProfile = [string](Get-PropertyValue $benchmarkUpload @('profile'))
    $benchmarkUploadWallSeconds = Get-PropertyValue $benchmarkUpload @('wallSeconds', 'wall_seconds')
    if ([string](Get-PropertyValue $C6Benchmark @('coldMode')) -cne 'firstProjectCold' -or
        [string](Get-PropertyValue $benchmarkCold @('schemaId')) -cne 'ck.native-compile-upload-operation' -or
        -not (Test-IntegralNumericValue (Get-PropertyValue $benchmarkCold @('schemaVersion'))) -or
        [int64](Get-PropertyValue $benchmarkCold @('schemaVersion')) -ne 1 -or
        (Get-PropertyValue $benchmarkCold @('success')) -isnot [bool] -or
        (Get-PropertyValue $benchmarkCold @('success')) -ne $true -or
        $benchmarkColdProfile -notmatch '^quick-fast(?:\s+\([^\r\n]*\))?$' -or
        [string](Get-PropertyValue $benchmarkUpload @('schemaId')) -cne 'ck.native-compile-upload-operation' -or
        -not (Test-IntegralNumericValue (Get-PropertyValue $benchmarkUpload @('schemaVersion'))) -or
        [int64](Get-PropertyValue $benchmarkUpload @('schemaVersion')) -ne 1 -or
        [string](Get-PropertyValue $benchmarkUpload @('kind')) -cne 'upload' -or
        (Get-PropertyValue $benchmarkUpload @('success')) -isnot [bool] -or
        (Get-PropertyValue $benchmarkUpload @('success')) -ne $true -or
        -not (Test-NumericValue $benchmarkUploadWallSeconds) -or [double]$benchmarkUploadWallSeconds -le 0 -or
        $benchmarkUploadProfile -notmatch '^quick-fast(?:\s+\([^\r\n]*\))?$' -or
        [string](Get-PropertyValue $benchmarkEnvironment @('compileProfile')) -cne 'quick-fast') {
        Add-Issue -Kind stale -Id 'first-compile-performance-primary-benchmark-mode-invalid' -Role $role
    }
    $exactValid = (Test-QuickFastCompileOperation $benchmarkExact) -and
        (Get-PropertyValue $benchmarkExact @('exactMatch')) -is [bool] -and
        (Get-PropertyValue $benchmarkExact @('exactMatch')) -eq $true -and
        (Get-PropertyValue $benchmarkExact @('codeChanged')) -is [bool] -and
        (Get-PropertyValue $benchmarkExact @('codeChanged')) -eq $false
    $hotEditValid = (Test-QuickFastCompileOperation $benchmarkHotEdit) -and
        (Get-PropertyValue $benchmarkHotEdit @('exactMatch')) -is [bool] -and
        (Get-PropertyValue $benchmarkHotEdit @('exactMatch')) -eq $false -and
        (Get-PropertyValue $benchmarkHotEdit @('codeChanged')) -is [bool] -and
        (Get-PropertyValue $benchmarkHotEdit @('codeChanged')) -eq $true
    $primingPresence = Get-PropertyPresence $benchmarkCycles @('exactPriming')
    if (-not $exactValid -or -not $hotEditValid -or
        ($primingPresence.exists -and -not (Test-QuickFastCompileOperation $primingPresence.value))) {
        Add-Issue -Kind stale -Id 'first-compile-performance-primary-benchmark-cycle-invalid' -Role $role
    }

    $benchmarkCacheClear = Get-PropertyValue $C6Benchmark @('cacheClear')
    $cacheBooleanExpectations = [ordered]@{
        ccache_store_preserved = $true; prebuilt_core_preserved = $false
        prebuilt_core_validated = $false; force_rebuild_pending = $false; force_ccache_recache = $false
    }
    $benchmarkCacheInvalid = $null -eq $benchmarkCacheClear -or
        [string](Get-PropertyValue $benchmarkCacheClear @('fqbn')) -cne $requiredC6Fqbn -or
        [string](Get-PropertyValue $benchmarkCacheClear @('reset_scope')) -cne 'first-project-full-fqbn'
    foreach ($field in $cacheBooleanExpectations.Keys) {
        $value = Get-PropertyValue $benchmarkCacheClear @($field)
        if ($value -isnot [bool] -or $value -ne $cacheBooleanExpectations[$field]) { $benchmarkCacheInvalid = $true }
    }
    if ($benchmarkCacheInvalid) {
        Add-Issue -Kind stale -Id 'first-compile-performance-primary-benchmark-cache-clear-invalid' -Role $role
    }

    $benchmarkBindingVerification = Get-PropertyValue $C6Benchmark @('binding_verification')
    $benchmarkCapturedText = Get-PropertyValue $C6Benchmark @('capturedAt')
    $benchmarkBeforeText = Get-PropertyValue $benchmarkBindingVerification @('verified_before_at')
    $benchmarkAfterText = Get-PropertyValue $benchmarkBindingVerification @('verified_after_at')
    $baselineCreatedText = Get-PropertyValue $benchmarkBaseline @('createdAt')
    $baselineVerifiedText = Get-PropertyValue $benchmarkBaseline @('verifiedAt')
    $timeTexts = @($benchmarkBeforeText, $benchmarkCapturedText, $baselineCreatedText, $baselineVerifiedText, $benchmarkAfterText)
    $primaryTimeInvalid = @($timeTexts | Where-Object { -not (Test-StrictEvidenceTimestamp $_) }).Count -gt 0
    if (-not $primaryTimeInvalid) {
        $benchmarkBefore = Convert-ToDateTimeOffset $benchmarkBeforeText
        $benchmarkCaptured = Convert-ToDateTimeOffset $benchmarkCapturedText
        $baselineCreated = Convert-ToDateTimeOffset $baselineCreatedText
        $baselineVerified = Convert-ToDateTimeOffset $baselineVerifiedText
        $benchmarkAfter = Convert-ToDateTimeOffset $benchmarkAfterText
        $primaryTimeInvalid = $benchmarkBefore -gt $benchmarkCaptured -or
            $benchmarkCaptured -gt $baselineCreated -or $baselineCreated -gt $baselineVerified -or
            $baselineVerified -gt $benchmarkAfter
    }
    if ($primaryTimeInvalid) {
        Add-Issue -Kind stale -Id 'first-compile-performance-primary-benchmark-time-invalid' -Role $role
    }
    foreach ($field in @('fqbn', 'coreId', 'coreVersion', 'arduinoCliVersion', 'toolchainKey', 'buildSignature', 'compileProfile', 'optimization')) {
        $boundValue = [string](Get-PropertyValue $boundEnvironment @($field))
        $benchmarkValue = [string](Get-PropertyValue $benchmarkEnvironment @($field))
        if ([string]::IsNullOrWhiteSpace($boundValue) -or $boundValue -cne $benchmarkValue) {
            Add-Issue -Kind stale -Id 'first-compile-performance-environment-binding-mismatch' -Role $role
            break
        }
    }
    if ([string](Get-PropertyValue $boundEnvironment @('fqbn')) -cne $boundFqbn) {
        Add-Issue -Kind stale -Id 'first-compile-performance-environment-binding-mismatch' -Role $role
    }

    $boundProject = [string](Get-PropertyValue $binding @('project'))
    $boundPort = [string](Get-PropertyValue $binding @('port'))
    $benchmarkProject = [string](Get-PropertyValue $C6Benchmark @('project'))
    $benchmarkPort = [string](Get-PropertyValue $C6Benchmark @('port'))
    $boundDevice = Get-PropertyValue $binding @('device')
    $benchmarkDevice = Get-PropertyValue $benchmarkBaseline @('device')
    $boundFlash = Get-PropertyValue $boundDevice @('flashBytes')
    $benchmarkFlash = Get-PropertyValue $benchmarkDevice @('flashBytes')
    $boundPsram = Get-PropertyValue $boundDevice @('psramBytes')
    $benchmarkPsram = Get-PropertyValue $benchmarkDevice @('psramBytes')
    $psramMatches = ($null -eq $boundPsram -and $null -eq $benchmarkPsram) -or
        ((Test-IntegralNumericValue $boundPsram) -and (Test-IntegralNumericValue $benchmarkPsram) -and
            [int64]$boundPsram -eq [int64]$benchmarkPsram)
    if ([string]::IsNullOrWhiteSpace($boundProject) -or $boundProject -cne $benchmarkProject -or
        [string]::IsNullOrWhiteSpace($boundPort) -or
        -not $boundPort.Equals($benchmarkPort, [System.StringComparison]::OrdinalIgnoreCase) -or
        $null -eq $boundDevice -or
        [string](Get-PropertyValue $boundDevice @('chip')) -cne [string](Get-PropertyValue $benchmarkDevice @('chip')) -or
        [string](Get-PropertyValue $boundDevice @('revision')) -cne [string](Get-PropertyValue $benchmarkDevice @('revision')) -or
        -not (Test-IntegralNumericValue $boundFlash) -or -not (Test-IntegralNumericValue $benchmarkFlash) -or
        [int64]$boundFlash -ne [int64]$benchmarkFlash -or -not $psramMatches) {
        Add-Issue -Kind stale -Id 'first-compile-performance-common-binding-mismatch' -Role $role
    }

    $boundInitial = Get-PropertyValue $binding @('initialSource')
    $benchmarkInitial = Get-PropertyValue (Get-PropertyValue $C6Benchmark @('sourceGate', 'source_gate')) @('initial')
    $benchmarkFingerprint = [string](Get-PropertyValue $benchmarkInitial @('codeFingerprint', 'code_fingerprint'))
    $fingerprintSha = if ([string]::IsNullOrWhiteSpace($benchmarkFingerprint)) { '' } else {
        Get-Sha256FromBytes -Bytes ([System.Text.UTF8Encoding]::new($false)).GetBytes($benchmarkFingerprint)
    }
    if ([string](Get-PropertyValue $boundInitial @('sourceFingerprintBindingSha256')) -cne $fingerprintSha -or
        [string](Get-PropertyValue $boundInitial @('includeSignature')) -cne [string](Get-PropertyValue $benchmarkInitial @('includeSignature', 'include_signature'))) {
        Add-Issue -Kind stale -Id 'first-compile-performance-source-signature-mismatch' -Role $role
    }

    $generatedAt = Convert-ToDateTimeOffset (Get-PropertyValue $Report @('generatedAt'))
    $gateFinished = Convert-ToDateTimeOffset $GateIdentity.finishedAt
    $benchmarkVerifiedBefore = Convert-ToDateTimeOffset (Get-PropertyValue (Get-PropertyValue $C6Benchmark @('binding_verification', 'bindingVerification')) @('verified_before_at', 'verifiedBeforeAt'))
    $benchmarkVerifiedAfter = Convert-ToDateTimeOffset (Get-PropertyValue (Get-PropertyValue $C6Benchmark @('binding_verification', 'bindingVerification')) @('verified_after_at', 'verifiedAfterAt'))
    $reportItem = if (Test-Path -LiteralPath $ReportPath -PathType Leaf) { Get-Item -LiteralPath $ReportPath } else { $null }
    $reportMtime = if ($null -ne $reportItem) { [DateTimeOffset]$reportItem.LastWriteTimeUtc } else { $null }
    $now = [DateTimeOffset]::UtcNow
    $expectedBatchExpiresAt = if ($null -ne $benchmarkVerifiedBefore) {
        [DateTimeOffset]::FromUnixTimeMilliseconds($benchmarkVerifiedBefore.ToUnixTimeMilliseconds()).AddHours(72)
    } else { $null }
    if ($null -eq $batchExpiresAt -or $null -eq $expectedBatchExpiresAt -or $null -eq $generatedAt -or
        $batchExpiresAt.ToUniversalTime() -ne $expectedBatchExpiresAt.ToUniversalTime() -or
        $generatedAt -gt $batchExpiresAt -or $batchExpiresAt -gt $generatedAt.AddHours(72)) {
        Add-Issue -Kind failed -Id 'first-compile-performance-temporal-batch-invalid' -Role $role
    }
    if ($null -ne $batchExpiresAt -and $now -gt $batchExpiresAt) {
        Add-Issue -Kind stale -Id 'first-compile-performance-batch-expired' -Role $role
    }
    if ($null -eq $generatedAt -or $null -eq $gateFinished -or $null -eq $benchmarkVerifiedAfter -or $null -eq $reportMtime -or
        $generatedAt -lt $gateFinished -or $generatedAt -lt $benchmarkVerifiedAfter -or
        $generatedAt -gt $now.AddMinutes(5) -or ($now - $generatedAt).TotalHours -gt $MaximumEvidenceAgeHours -or
        [math]::Abs(($reportMtime - $generatedAt).TotalMinutes) -gt 5) {
        Add-Issue -Kind stale -Id 'first-compile-performance-freshness-invalid' -Role $role
    }
}

function Write-Utf8NoBomAtomic {
    param([Parameter(Mandatory = $true)][string]$Path, [Parameter(Mandatory = $true)][string]$Content)
    $Path = Assert-SafeWorkspacePath -Path $Path -Kind OutputFile
    $parent = Split-Path -Parent $Path
    if ($parent) { New-Item -ItemType Directory -Force -Path $parent | Out-Null }
    # Validate again after materializing a previously absent parent. This also
    # ensures an output parent cannot be swapped for a junction between path
    # resolution and the first write without being noticed here.
    $Path = Assert-SafeWorkspacePath -Path $Path -Kind OutputFile
    $temporary = Assert-SafeWorkspacePath -Path "$Path.$([Guid]::NewGuid().ToString('N')).tmp" -Kind OutputFile
    $backup = Assert-SafeWorkspacePath -Path "$Path.$([Guid]::NewGuid().ToString('N')).replace-backup" -Kind OutputFile
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

function Write-InvalidatedOutput {
    param([Parameter(Mandatory = $true)][string]$Path)
    $Path = Assert-SafeWorkspacePath -Path $Path -Kind OutputFile
    $invalid = [ordered]@{
        schemaVersion = 3
        product = 'CK'
        version = $ExpectedVersion
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        status = 'candidate_evidence_stale'
        releaseClass = $releaseClass
        publicFormalRelease = $false
        invalidated = $true
        reason = 'evidence-manifest-generation-in-progress-or-aborted'
        privacy = [ordered]@{
            containsFullMac = $false
            containsWindowsAbsolutePath = $false
        }
    }
    try {
        Write-Utf8NoBomAtomic -Path $Path -Content (($invalid | ConvertTo-Json -Depth 5) + "`n")
    }
    catch {
        # Never intentionally leave a historical passed decision behind when
        # atomic replacement cannot complete.
        try {
            $safePath = Assert-SafeWorkspacePath -Path $Path -Kind OutputFile
            if (Test-Path -LiteralPath $safePath -PathType Leaf) { Remove-Item -LiteralPath $safePath -Force }
        }
        catch {}
        throw
    }
}

function Invoke-AuthoritativeSourceTreeVerify {
    param(
        [Parameter(Mandatory = $true)][string]$ManifestPath,
        [Parameter(Mandatory = $true)][string]$FreezePath
    )
    $verifier = Join-Path $PSScriptRoot 'New-SourceTreeManifest.ps1'
    if (-not (Test-Path -LiteralPath $verifier -PathType Leaf)) {
        Add-Issue -Kind stale -Id 'authoritative-source-tree-verifier-missing' -Role 'source-tree'
        return
    }
    $verifyExit = $null
    $previousErrorActionPreference = $ErrorActionPreference
    try {
        $ErrorActionPreference = 'Continue'
        $powershell = (Get-Process -Id $PID -ErrorAction Stop).Path
        $verifyOutput = @(& $powershell -NoLogo -NoProfile -NonInteractive -ExecutionPolicy Bypass -File $verifier `
                -Mode Verify -Root $script:rootFull -ManifestPath $ManifestPath -FreezeRecordPath $FreezePath 2>&1)
        $verifyExit = $LASTEXITCODE
    }
    catch {
        Add-Issue -Kind stale -Id 'authoritative-source-tree-verification-error' -Role 'source-tree'
    }
    finally { $ErrorActionPreference = $previousErrorActionPreference }
    if ($null -ne $verifyExit -and $verifyExit -ne 0) {
        Add-Issue -Kind stale -Id 'authoritative-source-tree-inventory-mismatch' -Role 'source-tree'
    }
}

function Test-ReferenceSetUnchanged {
    foreach ($reference in @($script:references)) {
        $full = Resolve-RecordedPath -Value ([string]$reference.path)
        if ($null -eq $full -or -not (Test-Path -LiteralPath $full -PathType Leaf)) { return $false }
        $actual = Get-FileIdentity -Path $full
        if ([int64]$actual.bytes -ne [int64]$reference.bytes -or [string]$actual.sha256 -cne [string]$reference.sha256) {
            return $false
        }
    }
    return $true
}

function New-ManifestObject {
    param($SourceIdentity, $GateIdentity, $ExecutableReference, $DeliveryAssets, $NativeReports)
    $status = if ($script:failedIssues.Count -gt 0) { 'failed' } elseif ($script:staleIssues.Count -gt 0) { 'candidate_evidence_stale' } else { 'passed' }
    $signatures = [System.Collections.Generic.List[object]]::new()
    foreach ($reference in @($script:references | Where-Object { $_.role -in @('production-executable', 'msi-installer', 'nsis-installer', 'extension-sdk') })) {
        $full = Resolve-RecordedPath -Value ([string]$reference.path)
        if ($null -ne $full) {
            $state = Get-AuthenticodeState -Path $full
            $signatures.Add([ordered]@{
                    referenceRole = [string]$reference.role
                    status = [string]$state.status
                    signed = [bool]$state.signed
                    timestampVerified = [bool]$state.timestampVerified
                }) | Out-Null
        }
    }
    return [ordered]@{
        schemaVersion = 3
        product = 'CK'
        version = $ExpectedVersion
        generatedAt = [DateTimeOffset]::UtcNow.ToString('o')
        status = $status
        releaseClass = $releaseClass
        publicFormalRelease = $false
        claimScope = [ordered]@{
            localMachineValidationOnly = $true
            closedTestingOnly = $true
            publicFormalRelease = $false
            unsignedAssetsNeverElevatePublicRelease = $true
        }
        sourceTree = $SourceIdentity
        automatedReleaseGate = $GateIdentity
        productionExecutable = if ($null -ne $ExecutableReference) {
            [ordered]@{ referenceRole = 'production-executable'; sha256 = [string]$ExecutableReference.sha256; bytes = [int64]$ExecutableReference.bytes }
        } else { $null }
        deliveryAssets = @($DeliveryAssets)
        nativeEvidence = @($NativeReports)
        references = @($script:references | Sort-Object role)
        authenticode = [ordered]@{
            publicFormalRelease = $false
            assets = $signatures.ToArray()
        }
        issues = [ordered]@{
            failed = $script:failedIssues.ToArray()
            stale = $script:staleIssues.ToArray()
        }
        privacy = [ordered]@{
            containsFullMac = $false
            containsUserAbsolutePath = $false
            containsWindowsAbsolutePath = $false
            referencedReportsMayContainSensitiveValues = (($script:privacyFullMacObservations + $script:privacyUserPathObservations) -gt 0)
            observedFullMacValueCount = [int]$script:privacyFullMacObservations
            observedUserAbsolutePathCount = [int]$script:privacyUserPathObservations
            sensitiveValuesCopiedIntoManifest = $false
        }
    }
}

$OutputPath = Resolve-DefaultPath -Value $OutputPath -DefaultRelative 'artifacts\release\v1-release-evidence-manifest.json' -Kind OutputFile
try { [void](Get-RelativePathSafe -Path $OutputPath) }
catch { throw 'evidence manifest output must stay inside the workspace root' }
Write-InvalidatedOutput -Path $OutputPath

try {
$SourceManifestPath = Resolve-DefaultPath -Value $SourceManifestPath -DefaultRelative 'artifacts\release\source-tree-manifest.json' -Kind InputFile
$SourceFreezePath = Resolve-DefaultPath -Value $SourceFreezePath -DefaultRelative 'artifacts\release\source-tree-freeze.json' -Kind InputFile
$GateReportPath = Resolve-DefaultPath -Value $GateReportPath -DefaultRelative 'artifacts\release\v1-release-gates.json'
$ExecutablePath = Resolve-DefaultPath -Value $ExecutablePath -DefaultRelative 'target\release\appsdesktop.exe'
$NativeSmokePath = Resolve-DefaultPath -Value $NativeSmokePath -DefaultRelative 'artifacts\release\v1-native-smoke.json'
$MemoryReportPath = Resolve-DefaultPath -Value $MemoryReportPath -DefaultRelative 'artifacts\release\desktop-memory-regression.json'
$C6BenchmarkPath = Resolve-DefaultPath -Value $C6BenchmarkPath -DefaultRelative 'artifacts\release\v1-c6-hardware-regression.json'
$FirstCompilePerformancePath = Resolve-DefaultPath -Value $FirstCompilePerformancePath -DefaultRelative 'artifacts\release\first-compile-performance-summary.json'
$C6DeviceHealthPath = Resolve-DefaultPath -Value $C6DeviceHealthPath -DefaultRelative 'artifacts\release\v1-c6-device-health.json'
$C6UploadProgressPath = Resolve-DefaultPath -Value $C6UploadProgressPath -DefaultRelative 'artifacts\release\v1-c6-upload-progress.json'
$C6UploadManifestGatePath = Resolve-DefaultPath -Value $C6UploadManifestGatePath -DefaultRelative 'artifacts\release\v1-c6-manifest-gate.json'
$C6SafeCancelPath = Resolve-DefaultPath -Value $C6SafeCancelPath -DefaultRelative 'artifacts\release\v1-c6-safe-cancel.json'
$BuiltinGeneratorAuditPath = Resolve-DefaultPath -Value $BuiltinGeneratorAuditPath -DefaultRelative 'artifacts\release\builtin-block-generator-audit.json'
$CoreCompatibilityReportPath = Resolve-DefaultPath -Value $CoreCompatibilityReportPath -DefaultRelative 'artifacts\release\core-compatibility-results.json'
$ExampleDirectory = Resolve-DefaultPath -Value $ExampleDirectory -DefaultRelative 'examples\importable-packages' -Kind InputDirectory

Invoke-AuthoritativeSourceTreeVerify -ManifestPath $SourceManifestPath -FreezePath $SourceFreezePath

$sourceManifest = Read-JsonReference -Role 'source-tree-manifest' -Path $SourceManifestPath
$sourceManifestReference = @($script:references | Where-Object { $_.role -ceq 'source-tree-manifest' }) | Select-Object -First 1
$sourceFreeze = Read-JsonReference -Role 'source-tree-freeze' -Path $SourceFreezePath
$sourceFreezeReference = @($script:references | Where-Object { $_.role -ceq 'source-tree-freeze' }) | Select-Object -First 1
$sourceIdentity = Test-SourceManifest -Manifest $sourceManifest -Freeze $sourceFreeze -ManifestReference $sourceManifestReference -FreezeReference $sourceFreezeReference

$gate = Read-JsonReference -Role 'automated-release-gate' -Path $GateReportPath
$gateReference = @($script:references | Where-Object { $_.role -ceq 'automated-release-gate' }) | Select-Object -First 1
$gateIdentity = Test-GateReport -Gate $gate -GateReference $gateReference -SourceIdentity $sourceIdentity
$compatibilityEvidence = Test-CompatibilityReports -Gate $gate -GateIdentity $gateIdentity
$deliveryAssets = Test-DeliveryAssets -Gate $gate -GateIdentity $gateIdentity

$executableReference = Add-Reference -Role 'production-executable' -Path $ExecutablePath
$gateExecutableRecords = @((Get-PropertyValue $gate @('release_assets', 'releaseAssets')) | Where-Object {
        [string](Get-PropertyValue $_ @('role')) -ceq 'portable-executable'
    })
if ($gateExecutableRecords.Count -eq 1 -and $null -ne $executableReference) {
    [void](Test-ExpectedDigest -Record $gateExecutableRecords[0] -Actual $executableReference -Role 'production-executable')
    $executableGeneratedAt = Convert-ToDateTimeOffset (Get-PropertyValue $gateExecutableRecords[0] @('generated_at', 'generatedAt'))
    $gateStart = Convert-ToDateTimeOffset $gateIdentity.startedAt
    $gateFinish = Convert-ToDateTimeOffset $gateIdentity.finishedAt
    if ($null -eq $executableGeneratedAt -or $null -eq $gateStart -or $null -eq $gateFinish -or
        $executableGeneratedAt -lt $gateStart -or $executableGeneratedAt -gt $gateFinish.AddMinutes(5)) {
        Add-Issue -Kind stale -Id 'production-executable-not-fresh-for-gate-run' -Role 'production-executable'
    }
}
else {
    Add-Issue -Kind stale -Id 'production-executable-gate-record-count-invalid' -Role 'production-executable'
}

$nativeSpecs = @(
    [ordered]@{ role = 'native-smoke'; path = $NativeSmokePath },
    [ordered]@{ role = 'desktop-memory-regression'; path = $MemoryReportPath },
    [ordered]@{ role = 'c6-compile-upload-benchmark'; path = $C6BenchmarkPath },
    [ordered]@{ role = 'c6-device-health'; path = $C6DeviceHealthPath },
    [ordered]@{ role = 'c6-upload-progress'; path = $C6UploadProgressPath },
    [ordered]@{ role = 'c6-upload-manifest-gate'; path = $C6UploadManifestGatePath },
    [ordered]@{ role = 'c6-safe-cancel'; path = $C6SafeCancelPath }
)
$nativeSummaries = [System.Collections.Generic.List[object]]::new()
foreach ($spec in $nativeSpecs) {
    $report = Read-JsonReference -Role $spec.role -Path $spec.path
    $script:nativeReports[$spec.role] = $report
    Test-NativeEvidenceBinding -Role $spec.role -Report $report -SourceIdentity $sourceIdentity -ExecutableReference $executableReference -GateIdentity $gateIdentity
    Test-C6SessionIdentity -Role $spec.role -Report $report
    $nativeSummaries.Add([ordered]@{
            referenceRole = $spec.role
            status = if ($null -ne $report) { [string](Get-PropertyValue $report @('status')) } else { 'missing' }
            sourceTreeBound = ($null -ne $report -and $null -ne (Get-PropertyValue $report @('source_tree', 'sourceTree')))
            executableBound = ($null -ne $report -and $null -ne (Get-PropertyValue $report @('executable')))
            cdpBound = ($null -ne $report -and (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $report @('cdp_binding', 'cdpBinding')) @('bound'))))
            gateRunBound = ($null -ne $report -and $null -ne (Get-PropertyValue $report @('gate_run', 'gateRun')))
            bindingUnchanged = ($null -ne $report -and (Test-BooleanTrue (Get-PropertyValue (Get-PropertyValue $report @('binding_verification', 'bindingVerification')) @('unchanged'))))
        }) | Out-Null
}
Test-C6CrossReportEvidence

$firstCompilePerformance = Read-JsonReference -Role 'first-compile-performance' -Path $FirstCompilePerformancePath
Test-FirstCompilePerformanceEvidence `
    -Report $firstCompilePerformance `
    -ReportPath $FirstCompilePerformancePath `
    -SourceIdentity $sourceIdentity `
    -GateIdentity $gateIdentity `
    -ExecutableReference $executableReference `
    -C6Benchmark $script:nativeReports['c6-compile-upload-benchmark'] `
    -NativeRuntimeIdentity $script:nativeRuntimeIdentity

# The initial verification protects evidence collection. Re-run the authoritative
# inventory immediately before materializing the decision so a source edit made
# while the reports were being inspected cannot inherit a passed candidate.
Invoke-AuthoritativeSourceTreeVerify -ManifestPath $SourceManifestPath -FreezePath $SourceFreezePath
if (-not (Test-ReferenceSetUnchanged)) {
    Add-Issue -Kind stale -Id 'evidence-reference-changed-during-capture' -Role 'manifest-finalization'
}
$manifest = New-ManifestObject -SourceIdentity $sourceIdentity -GateIdentity $gateIdentity -ExecutableReference $executableReference -DeliveryAssets $deliveryAssets -NativeReports $nativeSummaries.ToArray()
$json = ($manifest | ConvertTo-Json -Depth 24) + "`n"
$manifestSensitive = Get-SensitiveObservationCounts -Text $json
if ([int]$manifestSensitive.mac -gt 0 -or [int]$manifestSensitive.path -gt 0) {
    throw 'privacy invariant failed: the generated manifest contains a full MAC or user absolute path'
}
Write-Utf8NoBomAtomic -Path $OutputPath -Content $json

# Re-open the exact bytes and re-hash every referenced file after the atomic
# replace. A concurrent writer cannot inherit a pass from an earlier digest.
$written = [System.IO.File]::ReadAllText($OutputPath, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
if ([string]$written.releaseClass -cne $releaseClass -or -not (Test-BooleanFalse $written.publicFormalRelease)) {
    throw 'written evidence manifest changed the fixed release-class boundary'
}
$staleIssueCountBeforePostWriteVerify = $script:staleIssues.Count
Invoke-AuthoritativeSourceTreeVerify -ManifestPath $SourceManifestPath -FreezePath $SourceFreezePath
$sourceChangedAfterWrite = $script:staleIssues.Count -gt $staleIssueCountBeforePostWriteVerify
$referenceChangedAfterWrite = -not (Test-ReferenceSetUnchanged)
if ($sourceChangedAfterWrite -or $referenceChangedAfterWrite) {
    if ($referenceChangedAfterWrite) {
    Add-Issue -Kind stale -Id 'evidence-reference-changed-after-write' -Role 'manifest-finalization'
    }
    $manifest = New-ManifestObject -SourceIdentity $sourceIdentity -GateIdentity $gateIdentity -ExecutableReference $executableReference -DeliveryAssets $deliveryAssets -NativeReports $nativeSummaries.ToArray()
    $json = ($manifest | ConvertTo-Json -Depth 24) + "`n"
    Write-Utf8NoBomAtomic -Path $OutputPath -Content $json
}
$finalRaw = [System.IO.File]::ReadAllText($OutputPath, [System.Text.UTF8Encoding]::new($false))
$final = $finalRaw | ConvertFrom-Json
$finalSensitive = Get-SensitiveObservationCounts -Text $finalRaw
if ([int]$finalSensitive.mac -gt 0 -or [int]$finalSensitive.path -gt 0) {
    throw 'privacy invariant failed after atomic write'
}
$staleIssueCountBeforeFinalVerify = $script:staleIssues.Count
Invoke-AuthoritativeSourceTreeVerify -ManifestPath $SourceManifestPath -FreezePath $SourceFreezePath
if ($script:staleIssues.Count -gt $staleIssueCountBeforeFinalVerify -or -not (Test-ReferenceSetUnchanged)) {
    throw 'source tree or referenced evidence changed after final evidence write'
}

Write-Host "Release evidence manifest: $(Get-RelativePathSafe -Path $OutputPath)"
Write-Host "Status: $($final.status)"
Write-Host "Release class: $($final.releaseClass)"
if ([string]$final.status -eq 'passed') { exit 0 }
if ([string]$final.status -eq 'failed') { exit 1 }
exit 2
}
catch {
    try { Write-InvalidatedOutput -Path $OutputPath }
    catch {
        try {
            $safeOutputPath = Assert-SafeWorkspacePath -Path $OutputPath -Kind OutputFile
            if (Test-Path -LiteralPath $safeOutputPath -PathType Leaf) { Remove-Item -LiteralPath $safeOutputPath -Force }
        }
        catch {}
    }
    throw
}
