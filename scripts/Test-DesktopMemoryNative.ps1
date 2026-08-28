param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$ProjectName = 'c6_regression',
    [int]$Cycles = 10,
    [int]$BaselineCycle = 2,
    [int]$SettleMilliseconds = 700,
    [int]$CkProcessId = 0,
    [string]$ExecutablePath = '',
    [string]$SourceManifestPath = '',
    [string]$SourceFreezePath = '',
    [string]$GateReportPath = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}

if ($Cycles -lt 10) { throw '-Cycles must be at least 10 for the CK 1.0 release regression.' }
if ($BaselineCycle -lt 2 -or $BaselineCycle -ge $Cycles) {
    throw '-BaselineCycle must be at least 2 and lower than -Cycles.'
}
if (($Cycles - $BaselineCycle + 1) -lt 9) {
    throw 'The stable comparison window must contain at least 9 samples.'
}
if ($SettleMilliseconds -lt 250 -or $SettleMilliseconds -gt 10000) {
    throw '-SettleMilliseconds must be between 250 and 10000.'
}
if ([string]::IsNullOrWhiteSpace($ProjectName)) { throw '-ProjectName must not be empty.' }

function Get-FullPath {
    param([Parameter(Mandatory = $true)][string]$Path)
    return [System.IO.Path]::GetFullPath($Path).TrimEnd([char[]]@('\', '/'))
}

function Get-RelativePathOrFileName {
    param(
        [Parameter(Mandatory = $true)][string]$BasePath,
        [Parameter(Mandatory = $true)][string]$Path
    )
    $base = Get-FullPath -Path $BasePath
    $candidate = [System.IO.Path]::GetFullPath($Path)
    $prefix = "$base$([System.IO.Path]::DirectorySeparatorChar)"
    if ($candidate.StartsWith($prefix, [System.StringComparison]::OrdinalIgnoreCase)) {
        return $candidate.Substring($prefix.Length).Replace('\', '/')
    }
    return [System.IO.Path]::GetFileName($candidate)
}

function Get-Sha256Lower {
    param([Parameter(Mandatory = $true)][string]$Path)
    return (Get-FileHash -LiteralPath $Path -Algorithm SHA256).Hash.ToLowerInvariant()
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

# BEGIN SELECT-CK-WEBVIEW-DEBUG-HOST
function Select-CkWebViewDebugHost {
    param(
        [Parameter(Mandatory = $true)][object[]]$Processes,
        [Parameter(Mandatory = $true)][uint32]$CkProcessId,
        [Parameter(Mandatory = $true)][int]$DebugPort,
        [Parameter(Mandatory = $true)][System.Collections.Generic.HashSet[uint32]]$CkTreeIds
    )

    $debugPortPattern = "(?:^|\s)--remote-debugging-port=$([regex]::Escape([string]$DebugPort))(?:\s|$)"
    $debugBrowserHosts = @($Processes | Where-Object {
            $processId = [uint32]$_.ProcessId
            $processName = [string]$_.Name
            if ([string]::IsNullOrWhiteSpace($processName) -and $_.ExecutablePath) {
                $processName = [System.IO.Path]::GetFileName([string]$_.ExecutablePath)
            }

            $CkTreeIds.Contains($processId) -and
            [uint32]$_.ParentProcessId -eq $CkProcessId -and
            $processName.Equals('msedgewebview2.exe', [System.StringComparison]::OrdinalIgnoreCase) -and
            $_.CommandLine -and
            $_.CommandLine -match $debugPortPattern -and
            $_.CommandLine -notmatch '(?:^|\s)--type(?:=|\s)'
        })

    if ($debugBrowserHosts.Count -ne 1) {
        throw "The selected CK process must contain exactly one direct WebView2 browser host for CDP port $DebugPort."
    }

    $debugHost = $debugBrowserHosts[0]
    if (-not $CkTreeIds.Contains([uint32]$debugHost.ProcessId) -or
        [uint32]$debugHost.ParentProcessId -ne $CkProcessId) {
        throw 'The selected WebView2 browser host does not belong to the exact CK process tree.'
    }
    return $debugHost
}
# END SELECT-CK-WEBVIEW-DEBUG-HOST

$rootFull = Get-FullPath -Path $Root
if ([string]::IsNullOrWhiteSpace($ExecutablePath)) {
    $ExecutablePath = Join-Path $rootFull 'target\release\appsdesktop.exe'
}
if ([string]::IsNullOrWhiteSpace($SourceManifestPath)) {
    $SourceManifestPath = Join-Path $rootFull 'artifacts\release\source-tree-manifest.json'
}
if ([string]::IsNullOrWhiteSpace($SourceFreezePath)) {
    $SourceFreezePath = Join-Path $rootFull 'artifacts\release\source-tree-freeze.json'
}
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $rootFull 'artifacts\release\desktop-memory-regression.json'
}
if ([string]::IsNullOrWhiteSpace($GateReportPath)) {
    $GateReportPath = Join-Path $rootFull 'artifacts\release\v1-release-gates.json'
}

$executableFull = [System.IO.Path]::GetFullPath($ExecutablePath)
$manifestFull = [System.IO.Path]::GetFullPath($SourceManifestPath)
$freezeFull = [System.IO.Path]::GetFullPath($SourceFreezePath)
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)
$stagingFull = "$outputFull.pending"
$sourceVerifier = Join-Path $PSScriptRoot 'New-SourceTreeManifest.ps1'

Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
Initialize-NativeEvidenceReportPath -Path $outputFull
$sharedEvidenceBinding = New-NativeEvidenceBinding -Root $rootFull -DebugPort $DebugPort `
    -ExecutablePath $executableFull -CkProcessId $CkProcessId -SourceManifestPath $manifestFull `
    -SourceFreezeRecordPath $freezeFull -GateReportPath $GateReportPath

foreach ($required in @($executableFull, $manifestFull, $freezeFull, $sourceVerifier)) {
    if (-not (Test-Path -LiteralPath $required -PathType Leaf)) {
        throw "Required release input is missing: $required"
    }
}

function Assert-SourceTreeFreeze {
    & $sourceVerifier `
        -Mode Verify `
        -Root $rootFull `
        -ManifestPath $manifestFull `
        -FreezeRecordPath $freezeFull
}

# The memory evidence is meaningful only for a source tree that remains frozen
# before and after the native lifecycle run.
Assert-SourceTreeFreeze

$manifest = [System.IO.File]::ReadAllText($manifestFull, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$freeze = [System.IO.File]::ReadAllText($freezeFull, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$manifestSha256 = Get-Sha256Lower -Path $manifestFull
if ([string]$freeze.manifest_sha256 -cne $manifestSha256) {
    throw 'Source freeze manifest_sha256 does not match the source manifest bytes.'
}
if ([string]$freeze.tree_sha256 -cne [string]$manifest.tree_sha256) {
    throw 'Source freeze tree_sha256 does not match the source manifest.'
}
if ([string]$freeze.source_control.kind -cne 'none' -or $null -ne $freeze.source_control.commit) {
    throw 'This no-Git release workspace must keep source_control.kind=none and commit=null.'
}

$expectedExecutable = Get-FullPath -Path $executableFull
$candidateProcesses = @()
if ($CkProcessId -gt 0) {
    $candidateProcesses = @(Get-CimInstance Win32_Process -Filter "ProcessId = $CkProcessId")
}
else {
    $candidateProcesses = @(Get-CimInstance Win32_Process | Where-Object {
            $_.ExecutablePath -and
            (Get-FullPath -Path $_.ExecutablePath).Equals(
                $expectedExecutable,
                [System.StringComparison]::OrdinalIgnoreCase
            )
        })
}
if ($candidateProcesses.Count -eq 0) {
    throw "The production CK executable is not running: $expectedExecutable"
}
if ($candidateProcesses.Count -gt 1) {
    throw 'More than one matching CK process is running; pass -CkProcessId explicitly.'
}
$ckProcess = $candidateProcesses[0]
if (-not $ckProcess.ExecutablePath) { throw 'The CK process did not expose its executable path.' }
$actualExecutable = Get-FullPath -Path $ckProcess.ExecutablePath
if (-not $actualExecutable.Equals($expectedExecutable, [System.StringComparison]::OrdinalIgnoreCase)) {
    throw "The selected CK process does not run the requested production executable: $actualExecutable"
}

# Bind the CDP endpoint to this exact CK process tree. WebView2 propagates its
# remote-debugging-port switch to renderer descendants, so only the direct,
# browser child without a --type switch is the endpoint host. A different
# WebView or development CK instance must not produce this evidence.
$allNativeProcesses = @(Get-CimInstance Win32_Process)
$ckTreeIds = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ckTreeIds.Add([uint32]$ckProcess.ProcessId)
do {
    $treeChanged = $false
    foreach ($processRecord in $allNativeProcesses) {
        if ($ckTreeIds.Contains([uint32]$processRecord.ParentProcessId) -and
            $ckTreeIds.Add([uint32]$processRecord.ProcessId)) {
            $treeChanged = $true
        }
    }
} while ($treeChanged)
$debugHost = Select-CkWebViewDebugHost `
    -Processes $allNativeProcesses `
    -CkProcessId ([uint32]$ckProcess.ProcessId) `
    -DebugPort $DebugPort `
    -CkTreeIds $ckTreeIds
$debugHostProcessId = [int]$debugHost.ProcessId

# A WebView2 process can retain --remote-debugging-port in its command line
# even when another process already owns that port. Bind the evidence to the
# operating-system listener, not just to a command-line argument.
$debugListeners = @(Get-NetTCPConnection -State Listen -LocalPort $DebugPort -ErrorAction Stop)
$debugListenerOwners = @($debugListeners | Select-Object -ExpandProperty OwningProcess -Unique)
if ($debugListenerOwners.Count -ne 1 -or [int]$debugListenerOwners[0] -ne $debugHostProcessId) {
    $ownerText = if ($debugListenerOwners.Count) { $debugListenerOwners -join ', ' } else { '(none)' }
    throw "CDP port $DebugPort is not owned exclusively by CK WebView2 browser host PID $debugHostProcessId; listener owner(s): $ownerText"
}
$debugListenerBindings = @($debugListeners | ForEach-Object {
        [ordered]@{
            local_address = [string]$_.LocalAddress
            local_port = [int]$_.LocalPort
            owning_process_id = [int]$_.OwningProcess
        }
    })

$targets = (Invoke-WebRequest -UseBasicParsing -TimeoutSec 15 "http://127.0.0.1:$DebugPort/json/list").Content | ConvertFrom-Json
$target = $targets |
    Where-Object {
        $_.type -eq 'page' -and
        $_.webSocketDebuggerUrl -and
        $_.url -notmatch '[?&]console=detached(?:&|$)'
    } |
    Select-Object -First 1
if (-not $target.webSocketDebuggerUrl) {
    throw "No debuggable production CK window was found on port $DebugPort."
}

$executableItem = Get-Item -LiteralPath $actualExecutable
$sourceIdentity = [ordered]@{
    policy_id = [string]$freeze.policy_id
    manifest_path = Get-RelativePathOrFileName -BasePath $rootFull -Path $manifestFull
    freeze_path = Get-RelativePathOrFileName -BasePath $rootFull -Path $freezeFull
    manifest_sha256 = $manifestSha256
    tree_sha256 = [string]$freeze.tree_sha256
    frozen_at = [string]$freeze.frozen_at
    file_count = [int]$freeze.file_count
    total_bytes = [int64]$freeze.total_bytes
    source_control = [ordered]@{
        kind = 'none'
        commit = $null
    }
}
$executableIdentity = [ordered]@{
    path = Get-RelativePathOrFileName -BasePath $rootFull -Path $actualExecutable
    sha256 = Get-Sha256Lower -Path $actualExecutable
    bytes = [int64]$executableItem.Length
    file_version = [string]$executableItem.VersionInfo.FileVersion
    product_version = [string]$executableItem.VersionInfo.ProductVersion
    process_id = [int]$ckProcess.ProcessId
}
$hostIdentity = [ordered]@{
    os = [System.Environment]::OSVersion.VersionString
    os_architecture = [System.Runtime.InteropServices.RuntimeInformation]::OSArchitecture.ToString()
    process_architecture = [System.Runtime.InteropServices.RuntimeInformation]::ProcessArchitecture.ToString()
}

function ConvertTo-Base64Json {
    param([Parameter(Mandatory = $true)]$Value)
    $json = ConvertTo-Json -InputObject $Value -Depth 8 -Compress
    return [Convert]::ToBase64String([System.Text.Encoding]::UTF8.GetBytes($json))
}

$memoryEnvironmentNames = @(
    'CK_CDP_URL',
    'CK_NATIVE_CDP_VIEWPORT_GUARD',
    'CK_DESKTOP_NODE_MODULES',
    'CK_MEMORY_PROJECT',
    'CK_MEMORY_CYCLES',
    'CK_MEMORY_BASELINE_CYCLE',
    'CK_MEMORY_SETTLE_MS',
    'CK_MEMORY_ROOT_PID',
    'CK_MEMORY_ROOT_PATH',
    'CK_MEMORY_DEBUG_PORT',
    'CK_MEMORY_DEBUG_HOST_PID',
    'CK_MEMORY_TARGET_ID',
    'CK_MEMORY_TARGET_URL',
    'CK_MEMORY_LISTENER_BINDINGS_B64',
    'CK_MEMORY_SOURCE_IDENTITY_B64',
    'CK_MEMORY_EXECUTABLE_IDENTITY_B64',
    'CK_MEMORY_HOST_IDENTITY_B64',
    'CK_MEMORY_STAGING_OUTPUT'
)
$previousMemoryEnvironment = @{}
foreach ($environmentName in $memoryEnvironmentNames) {
    $previousMemoryEnvironment[$environmentName] = [Environment]::GetEnvironmentVariable(
        $environmentName,
        [EnvironmentVariableTarget]::Process
    )
}

try {
    if (Test-Path -LiteralPath $stagingFull) { Remove-Item -LiteralPath $stagingFull -Force }
    $env:CK_CDP_URL = [string]$target.webSocketDebuggerUrl
    $env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
    $env:CK_DESKTOP_NODE_MODULES = Join-Path $rootFull 'apps/desktop/node_modules'
    $env:CK_MEMORY_PROJECT = $ProjectName
    $env:CK_MEMORY_CYCLES = [string]$Cycles
    $env:CK_MEMORY_BASELINE_CYCLE = [string]$BaselineCycle
    $env:CK_MEMORY_SETTLE_MS = [string]$SettleMilliseconds
    $env:CK_MEMORY_ROOT_PID = [string]$ckProcess.ProcessId
    $env:CK_MEMORY_ROOT_PATH = $rootFull
    $env:CK_MEMORY_DEBUG_PORT = [string]$DebugPort
    $env:CK_MEMORY_DEBUG_HOST_PID = [string]$debugHostProcessId
    $env:CK_MEMORY_TARGET_ID = [string]$target.id
    $env:CK_MEMORY_TARGET_URL = [string]$target.url
    $env:CK_MEMORY_LISTENER_BINDINGS_B64 = ConvertTo-Base64Json -Value $debugListenerBindings
    $env:CK_MEMORY_SOURCE_IDENTITY_B64 = ConvertTo-Base64Json -Value $sourceIdentity
    $env:CK_MEMORY_EXECUTABLE_IDENTITY_B64 = ConvertTo-Base64Json -Value $executableIdentity
    $env:CK_MEMORY_HOST_IDENTITY_B64 = ConvertTo-Base64Json -Value $hostIdentity
    $env:CK_MEMORY_STAGING_OUTPUT = $stagingFull

$nodeScript = @'
const fs = require('node:fs');
const path = require('node:path');
const { execFileSync } = require('node:child_process');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD);

const MiB = 1024 * 1024;
const thresholds = Object.freeze({
  baseline_cycle: Number(process.env.CK_MEMORY_BASELINE_CYCLE || 2),
  final_cycle: Number(process.env.CK_MEMORY_CYCLES || 10),
  renderer_heap_delta_bytes_max: 5 * MiB,
  dom_node_delta_max: 1500,
  dom_document_delta_max: 1,
  dom_event_listener_delta_max: 3,
  resident_process_tree_private_delta_bytes_max: 32 * MiB,
  blockly_workspace_delta_max: 0,
  linear_trend: {
    minimum_positive_steps: 7,
    minimum_r_squared: 0.8,
    renderer_heap_noise_floor_bytes: 1 * MiB,
    dom_node_noise_floor: 250,
    dom_document_noise_floor: 1,
    dom_event_listener_noise_floor: 3,
    resident_process_tree_private_noise_floor_bytes: 8 * MiB,
  },
});

function parseBase64Json(value, label) {
  try {
    return JSON.parse(Buffer.from(String(value || ''), 'base64').toString('utf8'));
  } catch (error) {
    throw new Error(`Invalid ${label} identity: ${error.message}`);
  }
}

const report = {
  schema_version: 1,
  test_id: 'ck-desktop-memory-lifecycle-v1',
  evidence_scope: 'production-exe-native-memory-lifecycle-no-hardware',
  status: 'running',
  started_at: new Date().toISOString(),
  completed_at: null,
  source_tree: parseBase64Json(process.env.CK_MEMORY_SOURCE_IDENTITY_B64, 'source-tree'),
  executable: parseBase64Json(process.env.CK_MEMORY_EXECUTABLE_IDENTITY_B64, 'executable'),
  host: parseBase64Json(process.env.CK_MEMORY_HOST_IDENTITY_B64, 'host'),
  cdp_target: {
    debug_port: Number(process.env.CK_MEMORY_DEBUG_PORT),
    debug_host_process_id: Number(process.env.CK_MEMORY_DEBUG_HOST_PID),
    target_id: process.env.CK_MEMORY_TARGET_ID || null,
    url: process.env.CK_MEMORY_TARGET_URL || null,
    listener_bindings: parseBase64Json(process.env.CK_MEMORY_LISTENER_BINDINGS_B64, 'CDP-listener'),
  },
  project: {
    requested_name: process.env.CK_MEMORY_PROJECT,
    accepted_names: [
      process.env.CK_MEMORY_PROJECT,
      `${process.env.CK_MEMORY_PROJECT}.maker`,
      `${process.env.CK_MEMORY_PROJECT}.ck`,
    ],
    code_fingerprint: null,
    fqbn: null,
  },
  method: {
    cycles: Number(process.env.CK_MEMORY_CYCLES || 10),
    settle_milliseconds: Number(process.env.CK_MEMORY_SETTLE_MS || 700),
    forced_gc_before_each_route_sample: true,
    route_order_per_cycle: ['dashboard', 'workspace'],
    process_scope: 'resident threshold covers CK plus WebView2; all other descendants and global CK-path/CK_Builds tool candidates are pollution and must be absent for a published sample',
    quiescence_rule: 'two clean one-second polls before collection plus an immediate clean post-collection verification; contaminated metric groups are discarded and retried',
  },
  thresholds,
  cycles: [],
  comparison: null,
  checks: [],
  failures: [],
  result_kind: 'pending',
  contamination: {
    status: 'clean',
    observed_poll_count: 0,
    discarded_metric_groups: 0,
    observations: [],
  },
};

const outputPath = path.resolve(process.env.CK_MEMORY_STAGING_OUTPUT);
function writeReport() {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, 'utf8');
  fs.renameSync(temporary, outputPath);
}

const PROCESS_TREE_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rootId = [uint32]$env:CK_MEMORY_ROOT_PID
$rootPath = [System.IO.Path]::GetFullPath($env:CK_MEMORY_ROOT_PATH).TrimEnd([char[]]@('\', '/'))
$all = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add($rootId)
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) {
      $added = $true
    }
  }
} while ($added)

function Get-TextSha256Lower {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
  }
  finally { $sha.Dispose() }
}

function Test-KnownToolchainProcess {
  param($Item)
  $name = [string]$Item.Name
  $commandLine = [string]$Item.CommandLine
  if ($name -match '(?i)^(arduino-cli|ccache|esptool|avrdude|openocd|ninja|cmake|make)\.exe$') { return $true }
  if ($name -match '(?i)(?:^|-)(?:gcc|g\+\+|cc1|cc1plus|collect2|ld|ar)\.exe$') { return $true }
  return $name -match '(?i)^(python|python3|py)\.exe$' -and $commandLine -match '(?i)(?:esptool|elf2image)'
}

function Test-TextReferencesRoot {
  param([string]$Text)
  return -not [string]::IsNullOrWhiteSpace($Text) -and
    $Text.IndexOf($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-TextReferencesCkBuilds {
  param([string]$Text)
  return -not [string]::IsNullOrWhiteSpace($Text) -and $Text -match '(?i)[\\/]CK_Builds[\\/]'
}

function New-ProcessEvidenceRecord {
  param(
    $Item,
    $Process,
    [string]$Role,
    [string]$Lineage
  )
  $commandLine = [string]$Item.CommandLine
  $executablePath = [string]$Item.ExecutablePath
  $referencesRoot = (Test-TextReferencesRoot -Text $commandLine) -or (Test-TextReferencesRoot -Text $executablePath)
  $referencesBuilds = (Test-TextReferencesCkBuilds -Text $commandLine) -or (Test-TextReferencesCkBuilds -Text $executablePath)
  $origin = if (Test-TextReferencesRoot -Text $executablePath) {
    'ck_workspace'
  } elseif (Test-TextReferencesCkBuilds -Text $executablePath) {
    'ck_builds'
  } elseif ([string]::IsNullOrWhiteSpace($executablePath)) {
    'unavailable'
  } else {
    'external'
  }
  $version = ''
  if ($executablePath -and (Test-Path -LiteralPath $executablePath -PathType Leaf)) {
    try { $version = [string](Get-Item -LiteralPath $executablePath).VersionInfo.ProductVersion } catch {}
  }
  $creationTime = $null
  try { $creationTime = $Process.StartTime.ToUniversalTime().ToString('o') } catch {}
  return [ordered]@{
    process_id = [int]$Item.ProcessId
    parent_process_id = [int]$Item.ParentProcessId
    name = [string]$Item.Name
    role = $Role
    lineage = $Lineage
    working_set_bytes = [int64]$Process.WorkingSet64
    private_bytes = [int64]$Process.PrivateMemorySize64
    handles = [int]$Process.HandleCount
    threads = [int]$Process.Threads.Count
    product_version = $version
    creation_time_utc = $creationTime
    executable_origin = $origin
    command_sha256 = Get-TextSha256Lower -Text $commandLine
    command_references_ck_root = [bool]$referencesRoot
    command_references_ck_builds = [bool]$referencesBuilds
  }
}

$records = [System.Collections.Generic.List[object]]::new()
$pollutionRecords = [System.Collections.Generic.List[object]]::new()
$globalCkRelatedRecords = [System.Collections.Generic.List[object]]::new()
$working = [int64]0
$private = [int64]0
$handles = [int64]0
$threads = [int64]0
$residentWorking = [int64]0
$residentPrivate = [int64]0
$residentHandles = [int64]0
$residentThreads = [int64]0
$residentCount = 0
foreach ($item in $all) {
  if (-not $ids.Contains([uint32]$item.ProcessId)) { continue }
  try { $process = Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop } catch { continue }
  $isRoot = [uint32]$item.ProcessId -eq $rootId
  $isWebView = ([string]$item.Name).Equals('msedgewebview2.exe', [System.StringComparison]::OrdinalIgnoreCase)
  $isKnownToolchain = Test-KnownToolchainProcess -Item $item
  $role = if ($isRoot) { 'root' } elseif ($isWebView) { 'resident_webview' } elseif ($isKnownToolchain) { 'known_toolchain' } else { 'unknown_descendant' }
  $lineage = if ($isRoot) { 'ck_root' } elseif ($isWebView) { 'ck_descendant' } elseif ($isKnownToolchain) { 'ck_descendant' } else { 'ck_descendant_unclassified' }
  $working += [int64]$process.WorkingSet64
  $private += [int64]$process.PrivateMemorySize64
  $handles += [int64]$process.HandleCount
  $threads += [int64]$process.Threads.Count
  $record = New-ProcessEvidenceRecord -Item $item -Process $process -Role $role -Lineage $lineage
  $records.Add($record)
  $isResident = $isRoot -or $isWebView
  if ($isResident) {
    $residentCount += 1
    $residentWorking += [int64]$process.WorkingSet64
    $residentPrivate += [int64]$process.PrivateMemorySize64
    $residentHandles += [int64]$process.HandleCount
    $residentThreads += [int64]$process.Threads.Count
  }
  else {
    $pollutionRecords.Add($record)
  }
}

# A compiler may outlive an intermediate arduino-cli parent. Such a process is
# no longer reachable from a current-only parent walk, so scan global known
# tool names and retain only candidates tied to this CK root or CK_Builds.
foreach ($item in $all) {
  if ($ids.Contains([uint32]$item.ProcessId)) { continue }
  if (-not (Test-KnownToolchainProcess -Item $item)) { continue }
  $referencesCk = (Test-TextReferencesRoot -Text ([string]$item.CommandLine)) -or
    (Test-TextReferencesRoot -Text ([string]$item.ExecutablePath)) -or
    (Test-TextReferencesCkBuilds -Text ([string]$item.CommandLine)) -or
    (Test-TextReferencesCkBuilds -Text ([string]$item.ExecutablePath))
  if (-not $referencesCk) { continue }
  try { $process = Get-Process -Id ([int]$item.ProcessId) -ErrorAction Stop } catch { continue }
  $record = New-ProcessEvidenceRecord -Item $item -Process $process -Role 'known_toolchain' -Lineage 'global_ck_related_orphan_candidate'
  $globalCkRelatedRecords.Add($record)
  $pollutionRecords.Add($record)
}
if (-not ($records | Where-Object { $_.process_id -eq $rootId })) { throw 'CK root process left the process tree.' }
[ordered]@{
  root_process_id = [int]$rootId
  process_count = [int]$records.Count
  total_working_set_bytes = $working
  total_private_bytes = $private
  total_handles = $handles
  total_threads = $threads
  resident_process_count = [int]$residentCount
  resident_working_set_bytes = $residentWorking
  resident_private_bytes = $residentPrivate
  resident_handles = $residentHandles
  resident_threads = $residentThreads
  pollution_process_count = [int]$pollutionRecords.Count
  pollution_processes = $pollutionRecords.ToArray()
  known_toolchain_process_count = [int]@($pollutionRecords | Where-Object { $_.role -eq 'known_toolchain' }).Count
  unknown_descendant_process_count = [int]@($pollutionRecords | Where-Object { $_.role -eq 'unknown_descendant' }).Count
  global_ck_related_process_count = [int]$globalCkRelatedRecords.Count
  global_ck_related_processes = $globalCkRelatedRecords.ToArray()
  toolchain_process_count = [int]$pollutionRecords.Count
  toolchain_processes = $pollutionRecords.ToArray()
  processes = $records.ToArray()
} | ConvertTo-Json -Depth 6 -Compress
`;

function readProcessTree() {
  const raw = execFileSync(
    'powershell.exe',
    ['-NoProfile', '-NonInteractive', '-Command', PROCESS_TREE_SCRIPT],
    { encoding: 'utf8', windowsHide: true, maxBuffer: 4 * MiB, timeout: 60000, env: process.env },
  ).trim();
  const tree = JSON.parse(raw);
  if (tree.root_process_id !== Number(process.env.CK_MEMORY_ROOT_PID)) {
    throw new Error('Native process-tree sample returned the wrong CK root process.');
  }
  if (!Array.isArray(tree.processes) || tree.processes.length === 0) {
    throw new Error('Native process-tree sample was empty.');
  }
  if (!tree.processes.some((item) => item.process_id === Number(process.env.CK_MEMORY_DEBUG_HOST_PID))) {
    throw new Error('The WebView2 process hosting the selected CDP endpoint left the CK process tree.');
  }
  if (!Number.isFinite(Number(tree.resident_private_bytes)) || !Array.isArray(tree.pollution_processes)) {
    throw new Error('Native process-tree sample omitted resident/toolchain classification.');
  }
  if (!Number.isFinite(Number(tree.pollution_process_count))
      || !Number.isFinite(Number(tree.global_ck_related_process_count))) {
    throw new Error('Native process-tree sample omitted pollution counters.');
  }
  return tree;
}

const socket = new WebSocket(process.env.CK_CDP_URL);
const pending = new Map();
let nextId = 0;
const CDP_CALL_TIMEOUT_MS = 30000;

socket.on('message', (raw) => {
  const message = JSON.parse(raw);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  clearTimeout(request.timer);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    const timer = setTimeout(() => {
      pending.delete(id);
      reject(new Error(`CDP call timed out after ${CDP_CALL_TIMEOUT_MS}ms: ${method}`));
    }, CDP_CALL_TIMEOUT_MS);
    pending.set(id, { resolve, reject, timer, method });
    try {
      socket.send(JSON.stringify({ id, method, params }));
    } catch (error) {
      clearTimeout(timer);
      pending.delete(id);
      reject(error);
    }
  });
}

function rejectPendingCdp(error) {
  for (const request of pending.values()) {
    clearTimeout(request.timer);
    request.reject(error);
  }
  pending.clear();
}

async function evaluate(expression) {
  const response = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (response.exceptionDetails) {
    const detail = response.exceptionDetails.exception?.description || response.exceptionDetails.text;
    throw new Error(`${detail}\nExpression:\n${expression}`);
  }
  return response.result.value;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

class MemoryEvidenceInconclusiveError extends Error {
  constructor(message) {
    super(message);
    this.name = 'MemoryEvidenceInconclusiveError';
    this.code = 'CK_MEMORY_EVIDENCE_INCONCLUSIVE';
  }
}

function pollutionCount(tree) {
  return Number(tree?.pollution_process_count || 0);
}

function summarizePollution(tree) {
  return (tree?.pollution_processes || []).map((item) => ({
    process_id: item.process_id,
    parent_process_id: item.parent_process_id,
    name: item.name,
    role: item.role,
    lineage: item.lineage,
    creation_time_utc: item.creation_time_utc,
    executable_origin: item.executable_origin,
    command_sha256: item.command_sha256,
    command_references_ck_root: item.command_references_ck_root,
    command_references_ck_builds: item.command_references_ck_builds,
  }));
}

function recordPollution(tree, context) {
  report.contamination.observed_poll_count += 1;
  if (report.contamination.status === 'clean') report.contamination.status = 'transient_observed';
  if (report.contamination.observations.length < 256) {
    report.contamination.observations.push({
      captured_at: new Date().toISOString(),
      ...context,
      processes: summarizePollution(tree),
    });
  }
}

async function waitForUiProcessTreeQuiescent(context, timeoutMs = 15 * 60 * 1000) {
  const startedAt = Date.now();
  const deadline = Date.now() + timeoutMs;
  let stableSamples = 0;
  let pollCount = 0;
  let lastTree = null;
  while (Date.now() < deadline) {
    lastTree = readProcessTree();
    pollCount += 1;
    if (pollutionCount(lastTree) === 0) {
      stableSamples += 1;
      if (stableSamples >= 2) {
        return {
          tree: lastTree,
          waited_milliseconds: Date.now() - startedAt,
          poll_count: pollCount,
          clean_poll_count: stableSamples,
        };
      }
    } else {
      stableSamples = 0;
      recordPollution(lastTree, { ...context, phase: 'pre_sample_wait' });
    }
    await wait(1000);
  }
  const remaining = (lastTree?.pollution_processes || [])
    .map((item) => `${item.name}#${item.process_id}`)
    .join(', ');
  report.contamination.status = 'inconclusive';
  throw new MemoryEvidenceInconclusiveError(
    `Build-tool process pollution did not return to zero before memory sampling: ${remaining || 'unknown'}`,
  );
}

async function waitFor(expression, timeoutMs, label, intervalMs = 150) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(expression);
    if (lastValue) return lastValue;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

function expectedNames() {
  const name = process.env.CK_MEMORY_PROJECT;
  return [name, `${name}.maker`, `${name}.ck`];
}

async function waitForWorkspace() {
  const names = expectedNames();
  const identity = await waitFor(`(() => {
    const element = document.querySelector('[data-ck-role="workspace-project-identity"]');
    const name = element?.dataset.ckProjectName || element?.textContent?.trim() || '';
    const bridge = globalThis.CK_NATIVE_REGRESSION;
    const active = bridge?.schemaVersion === 1 && Boolean(bridge.getCurrent?.()?.workspace);
    return ${JSON.stringify(names)}.includes(name)
      && Boolean(document.querySelector('[data-ck-role="global-block-search"]'))
      && active
      ? {
          name,
          codeFingerprint: element?.dataset.ckCodeFingerprint || null,
          boardTitle: document.querySelector('[data-ck-role="board-config-button"]')?.title || '',
        }
      : false;
  })()`, 30000, `${process.env.CK_MEMORY_PROJECT} workspace`);
  const fqbn = String(identity.boardTitle || '')
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || null;
  return { name: identity.name, code_fingerprint: identity.codeFingerprint, fqbn };
}

async function retainBlocklyModuleOnly() {
  const retained = await evaluate(`(() => {
    const bridge = globalThis.CK_NATIVE_REGRESSION;
    const context = bridge?.schemaVersion === 1 ? bridge.getCurrent?.() : null;
    if (!context?.Blockly || !context?.workspace) return false;
    Object.defineProperty(globalThis, '__CK_MEMORY_REGRESSION_BLOCKLY', {
      configurable: true,
      enumerable: false,
      writable: true,
      value: context.Blockly,
    });
    return true;
  })()`);
  if (!retained) throw new Error('The narrow CK native regression bridge did not expose Blockly.');
}

async function releaseBlocklySoundPreloadListeners() {
  const point = await evaluate(`(() => ({
    x: Math.max(1, Math.min(window.innerWidth - 1, Math.floor(window.innerWidth / 2))),
    y: Math.max(1, Math.min(window.innerHeight - 1, Math.floor(window.innerHeight / 2))),
  }))()`);
  if (!Number.isFinite(Number(point?.x)) || !Number.isFinite(Number(point?.y))) {
    throw new Error('Failed to select a finite point for the Blockly sound-preload pointer event.');
  }
  await call('Input.dispatchMouseEvent', {
    type: 'mouseMoved',
    x: Number(point.x),
    y: Number(point.y),
    button: 'none',
    buttons: 0,
    pointerType: 'mouse',
  });
}

async function ensureWorkspace() {
  const names = expectedNames();
  const current = await evaluate(`(() => {
    const element = document.querySelector('[data-ck-role="workspace-project-identity"]');
    return element?.dataset.ckProjectName || element?.textContent?.trim() || '';
  })()`);
  if (current) {
    if (!names.includes(current)) {
      throw new Error(`Refusing to measure the wrong open project. Expected ${process.env.CK_MEMORY_PROJECT}, found ${current}.`);
    }
    return waitForWorkspace();
  }
  await openProjectFromDashboard();
  return waitForWorkspace();
}

async function openProjectFromDashboard() {
  const name = process.env.CK_MEMORY_PROJECT;
  await waitFor(
    `[...document.querySelectorAll('h3[title]')].some((heading) => heading.title === ${JSON.stringify(name)})`,
    30000,
    `${name} project card`,
  );
  const opened = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3[title]')]
      .find((item) => item.title === ${JSON.stringify(name)});
    const card = heading?.closest('[class*="cursor-pointer"]') || heading?.parentElement?.parentElement;
    if (!card) return false;
    card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  if (!opened) throw new Error(`Project could not be opened: ${name}`);
}

async function returnToDashboard() {
  const clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u8fd4\u56de\u9879\u76ee\u5217\u8868');
    if (!button || button.disabled) return false;
    button.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true, view: window }));
    return true;
  })()`);
  if (!clicked) throw new Error('The labeled return-to-project-list action was unavailable.');

  const name = process.env.CK_MEMORY_PROJECT;
  const deadline = Date.now() + 30000;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => ({
      unsaved: Boolean(document.querySelector('[data-ck-role="unsaved-changes-dialog"]')),
      dashboard: [...document.querySelectorAll('h3[title]')]
        .some((heading) => heading.title === ${JSON.stringify(name)}),
      workspace: Boolean(document.querySelector('[data-ck-role="workspace-project-identity"]')),
    }))()`);
    if (state.unsaved) {
      await evaluate(`(() => {
        const dialog = document.querySelector('[data-ck-role="unsaved-changes-dialog"]');
        const cancel = [...(dialog?.querySelectorAll('button') || [])]
          .find((item) => item.textContent.trim() === '\u53d6\u6d88');
        cancel?.click();
        return Boolean(cancel);
      })()`);
      throw new Error('The selected project has unsaved changes; the memory runner refused to discard them.');
    }
    if (state.dashboard && !state.workspace) return;
    await wait(150);
  }
  throw new Error(`Timed out waiting for ${name} on the dashboard.`);
}

const BLOCKLY_SNAPSHOT_EXPRESSION = `(() => {
  const bridge = globalThis.CK_NATIVE_REGRESSION;
  const bridgeContext = bridge?.schemaVersion === 1 ? bridge.getCurrent?.() : null;
  const Blockly = globalThis.__CK_MEMORY_REGRESSION_BLOCKLY || bridgeContext?.Blockly || null;
  const all = typeof Blockly?.Workspace?.getAll === 'function' ? Blockly.Workspace.getAll() : [];
  const registered = new Set(all);
  const main = typeof Blockly?.getMainWorkspace === 'function' ? Blockly.getMainWorkspace() : null;

  const describe = (workspace) => {
    let svgRoot = null;
    try { svgRoot = workspace?.getParentSvg?.() || workspace?.getSvgGroup?.() || null; } catch {}
    const classText = [
      svgRoot?.getAttribute?.('class') || '',
      svgRoot?.parentElement?.getAttribute?.('class') || '',
    ].join(' ');
    const target = workspace?.targetWorkspace || null;
    const parent = workspace?.options?.parentWorkspace || null;
    let ownedByTrashcan = false;
    try { ownedByTrashcan = target?.trashcan?.flyout?.getWorkspace?.() === workspace; } catch {}
    const trashcanFlyout = Boolean(workspace?.isFlyout) && (
      ownedByTrashcan
      || Boolean(svgRoot?.closest?.('.blocklyTrashcanFlyout'))
      || classText.includes('blocklyTrashcanFlyout')
    );
    const targetRegistered = target ? registered.has(target) : null;
    const targetDisposed = target ? target.rendered === false || !targetRegistered : false;
    return {
      id: String(workspace?.id || ''),
      rendered: Boolean(workspace?.rendered),
      is_flyout: Boolean(workspace?.isFlyout),
      is_mutator: Boolean(workspace?.isMutator),
      is_trashcan_flyout: trashcanFlyout,
      parent_id: parent?.id || null,
      target_id: target?.id || null,
      target_registered: targetRegistered,
      target_disposed: targetDisposed,
      block_count: Number(workspace?.getAllBlocks?.(false)?.length || 0),
    };
  };

  const belongsToMain = (workspace) => {
    if (!main) return false;
    let current = workspace;
    const seen = new Set();
    for (let depth = 0; current && depth < 12 && !seen.has(current); depth += 1) {
      if (current === main) return true;
      seen.add(current);
      current = current.options?.parentWorkspace || current.targetWorkspace || null;
    }
    return false;
  };

  const details = all.slice(0, 64).map(describe);
  return {
    active_bridge: Boolean(bridgeContext?.workspace),
    bridge_workspace_matches_main: Boolean(main && bridgeContext?.workspace === main),
    main_workspace_present: Boolean(main),
    main_workspace_id: main?.id || null,
    main_workspace_registered: main ? registered.has(main) : false,
    workspace_count: all.length,
    flyout_count: details.filter((item) => item.is_flyout).length,
    trashcan_flyout_count: details.filter((item) => item.is_trashcan_flyout).length,
    stale_target_count: details.filter((item) => item.target_disposed).length,
    stale_trashcan_flyout_count: details.filter((item) => item.is_trashcan_flyout && item.target_disposed).length,
    unexpected_workspace_count: main ? all.filter((workspace) => !belongsToMain(workspace)).length : 0,
    details,
  };
})()`;

function requireFiniteMetric(value, label) {
  const numeric = Number(value);
  if (!Number.isFinite(numeric)) throw new Error(`Memory sample omitted finite metric: ${label}`);
  return numeric;
}

function optionalFiniteMetric(value) {
  if (value === null || value === undefined) return null;
  const numeric = Number(value);
  return Number.isFinite(numeric) ? numeric : null;
}

async function measureRoute(expectedRoute, cycle) {
  const routeDeadline = Date.now() + 15 * 60 * 1000;
  let attempt = 0;
  while (Date.now() < routeDeadline) {
    attempt += 1;
    const remaining = Math.max(1000, routeDeadline - Date.now());
    const before = await waitForUiProcessTreeQuiescent(
      { cycle, route: expectedRoute, attempt },
      remaining,
    );
    await call('HeapProfiler.collectGarbage');
    await wait(150);
    const heap = await call('Runtime.getHeapUsage');
    const dom = await call('Memory.getDOMCounters');
    const page = await evaluate(`(() => {
      const workspaceIdentity = document.querySelector('[data-ck-role="workspace-project-identity"]');
      const projectName = workspaceIdentity?.dataset.ckProjectName || workspaceIdentity?.textContent?.trim() || null;
      const boardTitle = document.querySelector('[data-ck-role="board-config-button"]')?.title || '';
      const fqbn = boardTitle.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean).at(-1) || null;
      return {
        route: workspaceIdentity ? 'workspace' : 'dashboard',
        project_name: projectName,
        code_fingerprint: workspaceIdentity?.dataset.ckCodeFingerprint || null,
        fqbn,
        inner_width: window.innerWidth,
        inner_height: window.innerHeight,
        device_pixel_ratio: window.devicePixelRatio,
        blockly: ${BLOCKLY_SNAPSHOT_EXPRESSION},
      };
    })()`);
    const metricsCapturedAt = new Date().toISOString();
    const processTree = readProcessTree();
    if (pollutionCount(processTree) > 0) {
      report.contamination.discarded_metric_groups += 1;
      recordPollution(processTree, { cycle, route: expectedRoute, attempt, phase: 'immediate_post_metrics' });
      await wait(250);
      continue;
    }
    await wait(250);
    const postVerificationTree = readProcessTree();
    if (pollutionCount(postVerificationTree) > 0) {
      report.contamination.discarded_metric_groups += 1;
      recordPollution(postVerificationTree, { cycle, route: expectedRoute, attempt, phase: 'post_metrics_verification' });
      continue;
    }

    const usedSize = requireFiniteMetric(heap.usedSize, 'Runtime.getHeapUsage.usedSize');
    const totalSize = requireFiniteMetric(heap.totalSize, 'Runtime.getHeapUsage.totalSize');
    const documents = requireFiniteMetric(dom.documents, 'Memory.getDOMCounters.documents');
    const nodes = requireFiniteMetric(dom.nodes, 'Memory.getDOMCounters.nodes');
    const listeners = requireFiniteMetric(dom.jsEventListeners, 'Memory.getDOMCounters.jsEventListeners');
    requireFiniteMetric(processTree.resident_private_bytes, 'process_tree.resident_private_bytes');
    requireFiniteMetric(page?.blockly?.workspace_count, 'blockly.workspace_count');
    const innerWidth = requireFiniteMetric(page.inner_width, 'viewport.inner_width');
    const innerHeight = requireFiniteMetric(page.inner_height, 'viewport.inner_height');
    const devicePixelRatio = requireFiniteMetric(page.device_pixel_ratio, 'viewport.device_pixel_ratio');

    return {
      captured_at: metricsCapturedAt,
      expected_route: expectedRoute,
      actual_route: page.route,
      quiescence: {
        attempt,
        pre_sample_wait_milliseconds: before.waited_milliseconds,
        pre_sample_poll_count: before.poll_count,
        clean_poll_count: before.clean_poll_count,
        post_metrics_verification_milliseconds: 250,
        post_verification_resident_process_count: postVerificationTree.resident_process_count,
      },
      viewport: {
        inner_width: innerWidth,
        inner_height: innerHeight,
        device_pixel_ratio: devicePixelRatio,
      },
      project_name: page.project_name,
      code_fingerprint: page.code_fingerprint,
      fqbn: page.fqbn,
      javascript_heap: {
        used_size_bytes: usedSize,
        total_size_bytes: totalSize,
        embedder_heap_used_size_bytes: optionalFiniteMetric(heap.embedderHeapUsedSize),
        backing_storage_size_bytes: optionalFiniteMetric(heap.backingStorageSize),
      },
      dom: {
        documents,
        nodes,
        javascript_event_listeners: listeners,
      },
      blockly: page.blockly,
      process_tree: processTree,
    };
  }
  report.contamination.status = 'inconclusive';
  throw new MemoryEvidenceInconclusiveError(
    `Could not capture an uncontaminated ${expectedRoute} metric group within 15 minutes.`,
  );
}

function linearTrend(values, noiseFloor) {
  const clean = values.map(Number);
  const n = clean.length;
  if (n < 9) throw new Error(`A memory trend requires at least 9 finite samples; received ${n}.`);
  if (!clean.every(Number.isFinite) || !Number.isFinite(Number(noiseFloor))) {
    throw new Error('A memory trend received a non-finite value or noise floor.');
  }
  const meanX = (n - 1) / 2;
  const meanY = clean.reduce((sum, value) => sum + value, 0) / n;
  let covariance = 0;
  let varianceX = 0;
  let totalVariance = 0;
  let residual = 0;
  for (let index = 0; index < n; index += 1) {
    covariance += (index - meanX) * (clean[index] - meanY);
    varianceX += (index - meanX) ** 2;
    totalVariance += (clean[index] - meanY) ** 2;
  }
  const slope = varianceX ? covariance / varianceX : 0;
  const intercept = meanY - slope * meanX;
  for (let index = 0; index < n; index += 1) {
    residual += (clean[index] - (intercept + slope * index)) ** 2;
  }
  const rSquared = totalVariance > 0 ? Math.max(0, 1 - residual / totalVariance) : 0;
  const positiveSteps = clean.slice(1).filter((value, index) => value > clean[index]).length;
  const delta = clean.at(-1) - clean[0];
  const persistent = delta > noiseFloor
    && positiveSteps >= thresholds.linear_trend.minimum_positive_steps
    && rSquared >= thresholds.linear_trend.minimum_r_squared
    && slope > 0;
  return {
    sample_count: n,
    first: clean[0],
    last: clean.at(-1),
    delta,
    slope_per_cycle: slope,
    r_squared: rSquared,
    positive_steps: positiveSteps,
    noise_floor: noiseFloor,
    persistent_linear_growth: persistent,
  };
}

function addCheck(id, passed, evidence) {
  report.checks.push({ id, passed: Boolean(passed), evidence });
  if (!passed) report.failures.push(id);
}

function finalizeChecks() {
  const stableCycles = report.cycles.filter((item) => item.cycle >= thresholds.baseline_cycle);
  if (stableCycles.length < 9) {
    throw new Error(`The stable memory comparison window requires at least 9 samples; received ${stableCycles.length}.`);
  }

  const analyzeRoute = (route) => {
    const baseline = report.cycles.find((item) => item.cycle === thresholds.baseline_cycle)?.[route];
    const final = report.cycles.find((item) => item.cycle === thresholds.final_cycle)?.[route];
    if (!baseline || !final) throw new Error(`Baseline or final ${route} sample is missing.`);
    const delta = {
      renderer_heap_bytes: final.javascript_heap.used_size_bytes - baseline.javascript_heap.used_size_bytes,
      dom_nodes: final.dom.nodes - baseline.dom.nodes,
      dom_documents: final.dom.documents - baseline.dom.documents,
      dom_event_listeners:
        final.dom.javascript_event_listeners - baseline.dom.javascript_event_listeners,
      resident_process_tree_private_bytes:
        final.process_tree.resident_private_bytes - baseline.process_tree.resident_private_bytes,
      blockly_workspaces: final.blockly.workspace_count - baseline.blockly.workspace_count,
    };
    if (!Object.values(delta).every(Number.isFinite)) {
      throw new Error(`${route} comparison produced a non-finite delta.`);
    }
    const trends = {
      renderer_heap: linearTrend(
        stableCycles.map((item) => item[route].javascript_heap.used_size_bytes),
        thresholds.linear_trend.renderer_heap_noise_floor_bytes,
      ),
      dom_nodes: linearTrend(
        stableCycles.map((item) => item[route].dom.nodes),
        thresholds.linear_trend.dom_node_noise_floor,
      ),
      dom_documents: linearTrend(
        stableCycles.map((item) => item[route].dom.documents),
        thresholds.linear_trend.dom_document_noise_floor,
      ),
      dom_event_listeners: linearTrend(
        stableCycles.map((item) => item[route].dom.javascript_event_listeners),
        thresholds.linear_trend.dom_event_listener_noise_floor,
      ),
      resident_process_tree_private: linearTrend(
        stableCycles.map((item) => item[route].process_tree.resident_private_bytes),
        thresholds.linear_trend.resident_process_tree_private_noise_floor_bytes,
      ),
    };
    return { delta, trends };
  };

  const routes = {
    dashboard: analyzeRoute('dashboard'),
    workspace: analyzeRoute('workspace'),
  };
  report.comparison = {
    baseline_cycle: thresholds.baseline_cycle,
    final_cycle: thresholds.final_cycle,
    sample_count: stableCycles.length,
    routes,
    // Preserve the v1 top-level workspace view for existing evidence readers.
    delta: routes.workspace.delta,
    trends: routes.workspace.trends,
  };

  for (const route of ['dashboard', 'workspace']) {
    const { delta, trends } = routes[route];
    const prefix = route === 'workspace' ? '' : `${route}-`;
    addCheck(
      `${prefix}renderer-heap-delta-within-5-mib`,
      delta.renderer_heap_bytes <= thresholds.renderer_heap_delta_bytes_max,
      { route, actual: delta.renderer_heap_bytes, maximum: thresholds.renderer_heap_delta_bytes_max },
    );
    addCheck(
      `${prefix}dom-node-delta-within-1500`,
      delta.dom_nodes <= thresholds.dom_node_delta_max,
      { route, actual: delta.dom_nodes, maximum: thresholds.dom_node_delta_max },
    );
    addCheck(
      `${prefix}dom-document-delta-within-1`,
      delta.dom_documents <= thresholds.dom_document_delta_max,
      { route, actual: delta.dom_documents, maximum: thresholds.dom_document_delta_max },
    );
    addCheck(
      `${prefix}dom-event-listener-delta-within-3`,
      delta.dom_event_listeners <= thresholds.dom_event_listener_delta_max,
      { route, actual: delta.dom_event_listeners, maximum: thresholds.dom_event_listener_delta_max },
    );
    addCheck(
      `${prefix}resident-process-tree-private-delta-within-32-mib`,
      delta.resident_process_tree_private_bytes <= thresholds.resident_process_tree_private_delta_bytes_max,
      {
        route,
        actual: delta.resident_process_tree_private_bytes,
        maximum: thresholds.resident_process_tree_private_delta_bytes_max,
      },
    );
    addCheck(
      `${prefix}blockly-workspace-registry-does-not-grow`,
      delta.blockly_workspaces <= thresholds.blockly_workspace_delta_max,
      { route, actual: delta.blockly_workspaces, maximum: thresholds.blockly_workspace_delta_max },
    );
    for (const [name, trend] of Object.entries(trends)) {
      addCheck(`${prefix}${name}-has-no-persistent-linear-growth`, !trend.persistent_linear_growth, { route, ...trend });
    }
  }

  const dashboardFailures = report.cycles.flatMap((item) => {
    const failures = [];
    if (item.dashboard.actual_route !== 'dashboard') failures.push('route');
    if (item.dashboard.blockly.active_bridge) failures.push('active_bridge');
    if (item.dashboard.blockly.main_workspace_present) failures.push('main_workspace');
    if (item.dashboard.blockly.workspace_count !== 0) failures.push('workspace_registry_not_empty');
    if (item.dashboard.blockly.stale_target_count) failures.push('stale_target');
    if (item.dashboard.blockly.stale_trashcan_flyout_count) failures.push('stale_trashcan_flyout');
    return failures.map((failure) => ({ cycle: item.cycle, failure }));
  });
  addCheck('dashboard-releases-current-blockly-workspace-every-cycle', dashboardFailures.length === 0, dashboardFailures);

  const workspaceFailures = report.cycles.flatMap((item) => {
    const failures = [];
    if (item.workspace.actual_route !== 'workspace') failures.push('route');
    if (!item.workspace.blockly.active_bridge) failures.push('active_bridge');
    if (!item.workspace.blockly.main_workspace_present) failures.push('main_workspace');
    if (!item.workspace.blockly.main_workspace_registered) failures.push('main_not_registered');
    if (!item.workspace.blockly.bridge_workspace_matches_main) failures.push('bridge_mismatch');
    if (item.workspace.blockly.stale_target_count) failures.push('stale_target');
    if (item.workspace.blockly.stale_trashcan_flyout_count) failures.push('stale_trashcan_flyout');
    if (item.workspace.blockly.unexpected_workspace_count) failures.push('unexpected_workspace');
    return failures.map((failure) => ({ cycle: item.cycle, failure }));
  });
  addCheck('workspace-owns-only-current-blockly-tree-every-cycle', workspaceFailures.length === 0, workspaceFailures);

  const publishedSamplePollution = report.cycles.flatMap((item) => ['dashboard', 'workspace'].flatMap((route) => {
    const tree = item[route].process_tree;
    if (Number(tree.pollution_process_count || 0) === 0) return [];
    return [{
      cycle: item.cycle,
      route,
      processes: (tree.pollution_processes || []).map((process) => ({
        process_id: process.process_id,
        name: process.name,
        role: process.role,
        lineage: process.lineage,
      })),
    }];
  }));
  addCheck(
    'published-route-samples-have-zero-process-pollution',
    publishedSamplePollution.length === 0,
    publishedSamplePollution,
  );

  const fingerprints = report.cycles.map((item) => item.workspace.code_fingerprint).filter(Boolean);
  addCheck(
    'project-code-fingerprint-remains-stable',
    fingerprints.length === report.cycles.length && new Set(fingerprints).size === 1,
    { sample_count: fingerprints.length, distinct: [...new Set(fingerprints)] },
  );
}

socket.on('open', async () => {
  try {
    const geometry = await restoreNativeViewport(call);
    report.host.native_viewport = geometry;
    await call('HeapProfiler.enable');
    const identity = await ensureWorkspace();
    await retainBlocklyModuleOnly();
    await releaseBlocklySoundPreloadListeners();
    report.project.opened_name = identity.name;
    report.project.code_fingerprint = identity.code_fingerprint;
    report.project.fqbn = identity.fqbn;

    const cycles = Number(process.env.CK_MEMORY_CYCLES || 10);
    const settleMs = Number(process.env.CK_MEMORY_SETTLE_MS || 700);
    for (let cycle = 1; cycle <= cycles; cycle += 1) {
      await returnToDashboard();
      await wait(settleMs);
      const dashboard = await measureRoute('dashboard', cycle);

      await openProjectFromDashboard();
      const opened = await waitForWorkspace();
      await retainBlocklyModuleOnly();
      await releaseBlocklySoundPreloadListeners();
      await wait(settleMs);
      const workspace = await measureRoute('workspace', cycle);
      if (!report.project.code_fingerprint) report.project.code_fingerprint = opened.code_fingerprint;
      if (!report.project.fqbn) report.project.fqbn = opened.fqbn;

      report.cycles.push({ cycle, dashboard, workspace });
      writeReport();
    }

    finalizeChecks();
    const webViewVersions = new Set();
    for (const cycle of report.cycles) {
      for (const route of [cycle.dashboard, cycle.workspace]) {
        for (const processInfo of route.process_tree.processes) {
          if (String(processInfo.name).toLowerCase() === 'msedgewebview2.exe' && processInfo.product_version) {
            webViewVersions.add(processInfo.product_version);
          }
        }
      }
    }
    report.host.webview2_product_versions = [...webViewVersions].sort();
    report.result_kind = 'conclusive';
    report.status = report.failures.length ? 'failed' : 'passed';
    report.completed_at = new Date().toISOString();
    writeReport();
    console.log(`CK_DESKTOP_MEMORY_RESULT=${JSON.stringify({
      status: report.status,
      cycles: report.cycles.length,
      comparison: report.comparison,
      failures: report.failures,
    })}`);
    if (report.status !== 'passed') process.exitCode = 1;
  } catch (error) {
    report.status = 'failed';
    report.result_kind = error?.code === 'CK_MEMORY_EVIDENCE_INCONCLUSIVE'
      ? 'inconclusive'
      : 'runner_error';
    if (report.result_kind === 'inconclusive') report.contamination.status = 'inconclusive';
    report.completed_at = new Date().toISOString();
    const failurePrefix = report.result_kind === 'inconclusive' ? 'runner-inconclusive' : 'runner-error';
    report.failures.push(`${failurePrefix}: ${String(error?.message || error).slice(0, 2000)}`);
    writeReport();
    console.error(error?.stack || String(error));
    process.exitCode = 1;
  } finally {
    await evaluate(`(() => {
      Reflect.deleteProperty(globalThis, '__CK_MEMORY_REGRESSION_BLOCKLY');
      return true;
    })()`).catch(() => undefined);
    socket.close();
  }
});

socket.on('error', (error) => {
  rejectPendingCdp(error);
  report.status = 'failed';
  report.result_kind = 'runner_error';
  report.completed_at = new Date().toISOString();
  report.failures.push(`cdp-websocket-error: ${String(error.message || error).slice(0, 1000)}`);
  writeReport();
  console.error(`CDP WebSocket failed: ${error.message}`);
  process.exitCode = 1;
});

socket.on('close', () => {
  rejectPendingCdp(new Error('CDP WebSocket closed before pending calls completed.'));
});
'@

$nodeScript | node -
$nodeExitCode = $LASTEXITCODE
$postflightVerified = $false
$postflightError = $null
try {
    Assert-SourceTreeFreeze
    $postflightVerified = $true
}
catch {
    $postflightError = $_.Exception.Message
}

if (-not (Test-Path -LiteralPath $stagingFull -PathType Leaf)) {
    throw "The native memory runner did not create its staging evidence: $stagingFull"
}
$finalReport = [System.IO.File]::ReadAllText($stagingFull, [System.Text.UTF8Encoding]::new($false)) | ConvertFrom-Json
$finalReport | Add-Member -NotePropertyName node_exit_code -NotePropertyValue ([int]$nodeExitCode) -Force
if ($nodeExitCode -ne 0) {
    $finalReport.status = 'failed'
    if ([string]$finalReport.result_kind -eq 'pending') { $finalReport.result_kind = 'runner_error' }
    $nodeFailure = "node-process-exit-code: $nodeExitCode"
    if (@($finalReport.failures) -notcontains $nodeFailure) {
        $finalReport.failures = @($finalReport.failures) + $nodeFailure
    }
}
$verification = [ordered]@{
    preflight = $true
    postflight = $postflightVerified
}
$finalReport.source_tree | Add-Member -NotePropertyName verification -NotePropertyValue $verification -Force
if (-not $postflightVerified) {
    $finalReport.status = 'failed'
    $finalReport.failures = @($finalReport.failures) + "source-tree-postflight: $postflightError"
}
$finalReport | Add-Member -NotePropertyName evidence_finalized_at -NotePropertyValue ([DateTimeOffset]::UtcNow.ToString('o')) -Force
$sharedEvidence = $null
try {
    $sharedEvidence = Complete-NativeEvidenceBinding -Binding $sharedEvidenceBinding
    $finalReport | Add-Member -NotePropertyName gate_run -NotePropertyValue $sharedEvidence.gate_run -Force
    $finalReport | Add-Member -NotePropertyName cdp_binding -NotePropertyValue $sharedEvidence.cdp_binding -Force
    $finalReport | Add-Member -NotePropertyName binding_verification -NotePropertyValue $sharedEvidence.binding_verification -Force
}
catch {
    $finalReport.status = 'failed'
    $finalReport.failures = @($finalReport.failures) + "shared-native-evidence-binding: $($_.Exception.Message)"
}
$finalJson = ($finalReport | ConvertTo-Json -Depth 24) + "`n"
Write-Utf8NoBomAtomic -Path $outputFull -Content $finalJson
if ($null -ne $sharedEvidence) {
    try {
        Add-NativeEvidenceBindingToReport -Path $outputFull -Evidence $sharedEvidence
    }
    catch {
        Initialize-NativeEvidenceReportPath -Path $outputFull
        throw
    }
}
Remove-Item -LiteralPath $stagingFull -Force

Write-Host "Desktop memory regression evidence: $outputFull"
Write-Host "Production EXE SHA-256: $($executableIdentity.sha256)"
Write-Host "Source tree SHA-256: $($sourceIdentity.tree_sha256)"

if (-not $postflightVerified) { throw "Source-tree postflight verification failed: $postflightError" }
if ($nodeExitCode -ne 0 -or [string]$finalReport.status -ne 'passed') {
    throw "Native desktop memory regression failed; inspect $outputFull"
}
}
finally {
    foreach ($environmentName in $memoryEnvironmentNames) {
        $previousValue = $previousMemoryEnvironment[$environmentName]
        if ($null -eq $previousValue) {
            [Environment]::SetEnvironmentVariable(
                $environmentName,
                $null,
                [EnvironmentVariableTarget]::Process
            )
        }
        else {
            [Environment]::SetEnvironmentVariable(
                $environmentName,
                [string]$previousValue,
                [EnvironmentVariableTarget]::Process
            )
        }
    }
}
