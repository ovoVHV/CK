param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM12',
    [string]$ProjectName = 'c6_regression',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
    [int]$TimeoutSeconds = 900,
    [int]$CkProcessId = 0,
    [string]$ExecutablePath = '',
    [string]$SourceManifestPath = '',
    [string]$SourceFreezeRecordPath = '',
    [string]$GateReportPath = '',
    [string]$OutputPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($Port)) { throw '-Port must not be empty.' }
if ([string]::IsNullOrWhiteSpace($ProjectName)) { throw '-ProjectName must not be empty.' }
if ($ExpectedFqbn -notmatch '^esp32:esp32:esp32c6(?::|$)') {
    throw '-ExpectedFqbn must identify an ESP32-C6 target.'
}
if ($TimeoutSeconds -lt 60 -or $TimeoutSeconds -gt 1800) {
    throw '-TimeoutSeconds must be between 60 and 1800.'
}

$rootFull = [System.IO.Path]::GetFullPath($Root).TrimEnd([char[]]@('\', '/'))
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $rootFull 'artifacts\release\v1-c6-safe-cancel.json'
}
$outputFull = [System.IO.Path]::GetFullPath($OutputPath)

Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
Initialize-NativeEvidenceReportPath -Path $outputFull
$binding = New-NativeEvidenceBinding -Root $rootFull -DebugPort $DebugPort -ExecutablePath $ExecutablePath `
    -CkProcessId $CkProcessId -SourceManifestPath $SourceManifestPath `
    -SourceFreezeRecordPath $SourceFreezeRecordPath -GateReportPath $GateReportPath

$environmentNames = @(
    'CK_CDP_URL', 'CK_NATIVE_CDP_VIEWPORT_GUARD', 'CK_DESKTOP_NODE_MODULES',
    'CK_SAFE_CANCEL_PORT', 'CK_SAFE_CANCEL_PROJECT', 'CK_SAFE_CANCEL_FQBN',
    'CK_SAFE_CANCEL_TIMEOUT_MS', 'CK_SAFE_CANCEL_OUTPUT', 'CK_SAFE_CANCEL_ROOT',
    'CK_SAFE_CANCEL_ROOT_PID'
)
$environmentSnapshot = Save-NativeEvidenceEnvironment -Names $environmentNames
$runError = $null
$completedEvidence = $null

try {
    $env:CK_CDP_URL = [string]$binding.cdp_binding.web_socket_debugger_url
    $env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
    $env:CK_DESKTOP_NODE_MODULES = Join-Path $rootFull 'apps\desktop\node_modules'
    $env:CK_SAFE_CANCEL_PORT = $Port
    $env:CK_SAFE_CANCEL_PROJECT = $ProjectName
    $env:CK_SAFE_CANCEL_FQBN = $ExpectedFqbn
    $env:CK_SAFE_CANCEL_TIMEOUT_MS = [string]($TimeoutSeconds * 1000)
    $env:CK_SAFE_CANCEL_OUTPUT = $outputFull
    $env:CK_SAFE_CANCEL_ROOT = $rootFull
    $env:CK_SAFE_CANCEL_ROOT_PID = [string]$binding.executable.process_id

$nodeScript = @'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawn } = require('node:child_process');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD);

const timeoutMs = Number(process.env.CK_SAFE_CANCEL_TIMEOUT_MS || 900000);
const expectedFqbn = String(process.env.CK_SAFE_CANCEL_FQBN || '');
const expectedPort = String(process.env.CK_SAFE_CANCEL_PORT || '');
const expectedProject = String(process.env.CK_SAFE_CANCEL_PROJECT || '');
const ckRootPid = Number(process.env.CK_SAFE_CANCEL_ROOT_PID);

function writeJsonAtomic(outputPath, value) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
}

function sanitizeEvidenceValue(value) {
  const roots = [
    [path.join(os.tmpdir(), 'CK_Builds'), '<CK_BUILDS>'],
    [path.resolve(process.env.CK_SAFE_CANCEL_ROOT), '<CK_ROOT>'],
    [os.homedir(), '<USER_HOME>'],
  ];
  const sanitize = (input) => {
    let safe = String(input || '');
    for (const [candidate, token] of roots) {
      for (const form of [candidate, candidate.replaceAll('\\', '/')]) {
        safe = safe.replaceAll(form, token);
      }
    }
    return safe
      .replace(/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/gi, '[REDACTED_MAC]')
      .replace(/\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/gi, 'MAC: [REDACTED_MAC]')
      .replace(/(?:file:\/\/\/)?[a-z]:[\\/][^\r\n]*/gi, '[REDACTED_ABSOLUTE_PATH]');
  };
  return JSON.parse(JSON.stringify(value, (_key, item) => (
    typeof item === 'string' ? sanitize(item) : item
  )));
}

const socket = new WebSocket(process.env.CK_CDP_URL);
const pending = new Map();
let nextId = 0;

socket.on('message', (raw) => {
  const message = JSON.parse(raw);
  if (!message.id || !pending.has(message.id)) return;
  const request = pending.get(message.id);
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

function call(method, params = {}) {
  return new Promise((resolve, reject) => {
    const id = ++nextId;
    pending.set(id, { resolve, reject });
    socket.send(JSON.stringify({ id, method, params }));
  });
}

async function evaluate(expression) {
  const result = await call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  });
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(`${detail}\nExpression:\n${expression}`);
  }
  return result.result.value;
}

const wait = (milliseconds) => new Promise((resolve) => setTimeout(resolve, milliseconds));

async function waitFor(probe, timeout, label, intervalMs = 150) {
  const deadline = Date.now() + timeout;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function invoke(command, args) {
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

async function ensureWorkspace() {
  const names = [expectedProject, `${expectedProject}.maker`, `${expectedProject}.ck`];
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const current = await evaluate(`(() => {
      const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
      return identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
    })()`);
    if (!names.includes(current)) {
      throw new Error(`Refusing to test the wrong open project. Expected ${expectedProject}, found ${current || 'unknown'}.`);
    }
    return;
  }
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('h3[title]')].some((item) => item.title === ${JSON.stringify(expectedProject)})`),
    30000,
    `${expectedProject} project card`,
  );
  const opened = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3[title]')]
      .find((item) => item.title === ${JSON.stringify(expectedProject)});
    const card = heading?.closest('[class*="cursor-pointer"]') || heading?.parentElement?.parentElement;
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return Boolean(card);
  })()`);
  if (!opened) throw new Error(`Project could not be opened: ${expectedProject}`);
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`),
    30000,
    `${expectedProject} workspace`,
  );
}

async function waitForExactBoard() {
  return waitFor(async () => {
    const state = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="board-config-button"]');
      const title = button?.title || '';
      const lines = title.split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      return {
        disabled: Boolean(button?.disabled),
        status: button?.dataset.ckBoardOptionsStatus || '',
        compatible: button?.dataset.ckBoardOptionsCompatible || '',
        fqbn: lines.at(-1) || '',
      };
    })()`);
    return !state.disabled
      && ['resolved', 'core-default'].includes(state.status)
      && state.compatible !== 'false'
      && state.fqbn === expectedFqbn
      ? state.fqbn
      : false;
  }, 60000, `exact FQBN ${expectedFqbn}`);
}

async function selectPort() {
  const isSelected = () => evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(expectedPort)})`);
  if (await isSelected()) return;
  await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')].find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    refresh?.click();
    return Boolean(refresh);
  })()`);
  await wait(800);
  const opened = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')].find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
    toggle?.click();
    return Boolean(toggle);
  })()`);
  if (!opened) throw new Error('Port selector could not be opened.');
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('[role="menu"] button')]
      .some((item) => item.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(expectedPort)})`),
    10000,
    `${expectedPort} in port menu`,
  );
  const selected = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menu"] button')]
      .find((button) => button.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(expectedPort)});
    item?.click();
    return Boolean(item);
  })()`);
  if (!selected) throw new Error(`Port could not be selected: ${expectedPort}`);
  await waitFor(isSelected, 10000, `${expectedPort} selection`);
}

async function readStableWorkspaceIdentity() {
  let previousKey = '';
  let stable = 0;
  return waitFor(async () => {
    const identity = await evaluate(`(() => {
      const project = document.querySelector('[data-ck-role="workspace-project-identity"]');
      const board = document.querySelector('[data-ck-role="board-config-button"]');
      const boardLines = (board?.title || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      const selectedPort = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
        .find((button) => button.title === ${JSON.stringify(expectedPort)})?.title || '';
      return {
        project: project?.dataset.ckProjectName || project?.textContent?.trim() || '',
        sourceFingerprint: project?.dataset.ckCodeFingerprint || null,
        includeSignature: project?.dataset.ckIncludeSignature || '',
        fqbn: boardLines.at(-1) || '',
        port: selectedPort,
      };
    })()`);
    const key = JSON.stringify(identity);
    const valid = identity.sourceFingerprint
      && [expectedProject, `${expectedProject}.maker`, `${expectedProject}.ck`].includes(identity.project)
      && identity.fqbn === expectedFqbn
      && identity.port === expectedPort;
    if (!valid) {
      previousKey = '';
      stable = 0;
      return false;
    }
    stable = key === previousKey ? stable + 1 : 1;
    previousKey = key;
    return stable >= 2 ? identity : false;
  }, 30000, 'stable project/source/FQBN/port identity', 300);
}

async function captureCompileLog() {
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.replace(/\\s+/g, '') === '\u8f93\u51fa\u65e5\u5fd7');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) throw new Error('Output log tab could not be opened.');
  await wait(120);
  return evaluate(`document.querySelector('.ck-console-panel')?.innerText || ''`);
}

async function readBuildEvidence() {
  return evaluate(`(() => {
    const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
    if (!overlay) return null;
    return {
      schema: overlay.getAttribute('data-ck-build-evidence-schema') || '',
      runId: overlay.getAttribute('data-ck-build-run-id') || '',
      kind: overlay.getAttribute('data-ck-build-kind') || '',
      fqbn: overlay.getAttribute('data-ck-build-fqbn') || '',
      port: overlay.getAttribute('data-ck-build-port') || '',
      workspaceFingerprint: overlay.getAttribute('data-ck-build-workspace-fingerprint') || '',
    };
  })()`);
}

async function waitForExactBuildEvidence(kind, identity, distinctFromRunId = '') {
  return waitFor(async () => {
    const evidence = await readBuildEvidence();
    if (!evidence) return false;
    return evidence.schema === '1'
      && evidence.kind === kind
      && isUuid(evidence.runId)
      && (!distinctFromRunId || evidence.runId !== distinctFromRunId)
      && evidence.fqbn === expectedFqbn
      && evidence.port === expectedPort
      && evidence.workspaceFingerprint === identity.sourceFingerprint
      ? evidence
      : false;
  }, 30000, `${kind} read-only DOM build evidence`);
}

function parseBackendCancellation(log, expectedRunId) {
  const pattern = /build run\s+([0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12})\s+cancelled;\s*(\d+)\s+active process tree\(s\) terminated and waited/gi;
  const matches = [...String(log || '').matchAll(pattern)].map((match) => ({
    runId: String(match[1] || ''),
    terminatedProcessTreeCount: Number(match[2] || 0),
  }));
  return matches.reverse().find((item) => (
    item.runId.toLowerCase() === String(expectedRunId || '').toLowerCase()
  )) || null;
}

// BEGIN SAFE-CANCEL-PROCESS-CLASSIFIER
const PROCESS_MONITOR_SCRIPT = String.raw`
$ErrorActionPreference = 'Stop'
$rootId = [uint32]$env:CK_SAFE_CANCEL_ROOT_PID
$rootPath = [System.IO.Path]::GetFullPath($env:CK_SAFE_CANCEL_ROOT).TrimEnd([char[]]@('\', '/'))
$expectedPort = [string]$env:CK_SAFE_CANCEL_PORT

function Get-TextSha256Lower {
  param([string]$Text)
  if ([string]::IsNullOrEmpty($Text)) { return $null }
  $sha = [System.Security.Cryptography.SHA256]::Create()
  try {
    return ([BitConverter]::ToString($sha.ComputeHash([Text.Encoding]::UTF8.GetBytes($Text)))).Replace('-', '').ToLowerInvariant()
  }
  finally { $sha.Dispose() }
}

function Test-SafeCancelKnownToolchainProcess {
  param($Item)
  $name = [string]$Item.Name
  $commandLine = [string]$Item.CommandLine
  if ($name -match '(?i)^(arduino-cli|ccache|esptool|avrdude|openocd|ninja|cmake|make)\.exe$') { return $true }
  if ($name -match '(?i)(?:^|-)(?:gcc|g\+\+|cc1|cc1plus|collect2|ld|ar)\.exe$') { return $true }
  return $name -match '(?i)^(python|python3|py)\.exe$' -and $commandLine -match '(?i)(?:esptool|elf2image)'
}

function Test-SafeCancelArduinoOrGccStage {
  param($Item)
  $name = [string]$Item.Name
  return $name -match '(?i)^arduino-cli\.exe$' -or
    $name -match '(?i)(?:^|-)(?:gcc|g\+\+|cc1|cc1plus|collect2|ld|ar)\.exe$'
}

function Get-SafeCancelFlashTransportReason {
  param($Item)
  $name = [string]$Item.Name
  $commandLine = [string]$Item.CommandLine
  if ($name -match '(?i)^avrdude\.exe$') { return 'avrdude-transport' }
  $esptool = $name -match '(?i)^(?:esptool|python|python3|py)\.exe$' -or $commandLine -match '(?i)\besptool(?:\.py)?\b'
  if (-not $esptool) { return '' }
  if ($commandLine -match '(?i)(?:^|\s)write_flash(?:\s|$)') { return 'esptool-write-flash' }
  if ($commandLine -match '(?i)(?:^|\s)--port(?:=|\s+)\S+') { return 'esptool-port-transport' }
  if (-not [string]::IsNullOrWhiteSpace($expectedPort) -and
      $commandLine.IndexOf($expectedPort, [System.StringComparison]::OrdinalIgnoreCase) -ge 0) {
    return 'esptool-selected-port-transport'
  }
  return ''
}

function Test-ReferencesCkRoot {
  param([string]$Text)
  return -not [string]::IsNullOrWhiteSpace($Text) -and
    $Text.IndexOf($rootPath, [System.StringComparison]::OrdinalIgnoreCase) -ge 0
}

function Test-ReferencesCkBuilds {
  param([string]$Text)
  return -not [string]::IsNullOrWhiteSpace($Text) -and $Text -match '(?i)[\\/]CK_Builds[\\/]'
}

function New-SafeCancelProcessRecord {
  param($Item, [string]$Lineage)
  $command = [string]$Item.CommandLine
  $transportReason = Get-SafeCancelFlashTransportReason -Item $Item
  $createdAt = $null
  try { $createdAt = (Get-Process -Id ([int]$Item.ProcessId) -ErrorAction Stop).StartTime.ToUniversalTime().ToString('o') } catch {}
  return [ordered]@{
    process_id = [int]$Item.ProcessId
    parent_process_id = [int]$Item.ParentProcessId
    name = [string]$Item.Name
    lineage = $Lineage
    creation_time_utc = $createdAt
    command_sha256 = Get-TextSha256Lower -Text $command
    arduino_or_gcc_stage = [bool](Test-SafeCancelArduinoOrGccStage -Item $Item)
    flash_transport = -not [string]::IsNullOrWhiteSpace($transportReason)
    flash_transport_reason = if ($transportReason) { $transportReason } else { $null }
  }
}

while ($true) {
  try {
    $all = @(Get-CimInstance Win32_Process)
    $ids = [System.Collections.Generic.HashSet[uint32]]::new()
    [void]$ids.Add($rootId)
    do {
      $added = $false
      foreach ($item in $all) {
        if ($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $added = $true }
      }
    } while ($added)

    $treeTools = [System.Collections.Generic.List[object]]::new()
    $globalOrphans = [System.Collections.Generic.List[object]]::new()
    foreach ($item in $all) {
      if (-not (Test-SafeCancelKnownToolchainProcess -Item $item)) { continue }
      if ($ids.Contains([uint32]$item.ProcessId)) {
        $treeTools.Add((New-SafeCancelProcessRecord -Item $item -Lineage 'ck-descendant')) | Out-Null
        continue
      }
      $related = (Test-ReferencesCkRoot -Text ([string]$item.CommandLine)) -or
        (Test-ReferencesCkRoot -Text ([string]$item.ExecutablePath)) -or
        (Test-ReferencesCkBuilds -Text ([string]$item.CommandLine)) -or
        (Test-ReferencesCkBuilds -Text ([string]$item.ExecutablePath))
      if ($related) {
        $globalOrphans.Add((New-SafeCancelProcessRecord -Item $item -Lineage 'global-ck-related-orphan-candidate')) | Out-Null
      }
    }
    $combined = @($treeTools.ToArray()) + @($globalOrphans.ToArray())
    [ordered]@{
      captured_at = [DateTimeOffset]::UtcNow.ToString('o')
      root_process_id = [int]$rootId
      tool_tree_count = [int]$treeTools.Count
      global_orphan_count = [int]$globalOrphans.Count
      arduino_or_gcc = @($combined | Where-Object { $_.arduino_or_gcc_stage })
      flash_transports = @($combined | Where-Object { $_.flash_transport })
      tools = $combined
    } | ConvertTo-Json -Depth 5 -Compress
  }
  catch {
    [ordered]@{ captured_at = [DateTimeOffset]::UtcNow.ToString('o'); monitor_error = $_.Exception.Message } |
      ConvertTo-Json -Compress
  }
  Start-Sleep -Milliseconds 100
}
`;
// END SAFE-CANCEL-PROCESS-CLASSIFIER

function startProcessMonitor() {
  const child = spawn(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', PROCESS_MONITOR_SCRIPT],
    { windowsHide: true, stdio: ['ignore', 'pipe', 'pipe'], env: process.env },
  );
  const state = {
    child,
    latest: null,
    snapshots: [],
    stageObservations: [],
    flashTransports: [],
    stderr: '',
    parseErrors: [],
  };
  let buffer = '';
  const acceptLine = (line) => {
    if (!line.trim()) return;
    try {
      const snapshot = JSON.parse(line);
      if (snapshot.monitor_error) throw new Error(snapshot.monitor_error);
      state.latest = snapshot;
      if (state.snapshots.length >= 256) state.snapshots.shift();
      state.snapshots.push({
        capturedAt: snapshot.captured_at,
        toolTreeCount: Number(snapshot.tool_tree_count || 0),
        globalOrphanCount: Number(snapshot.global_orphan_count || 0),
      });
      for (const item of snapshot.arduino_or_gcc || []) {
        const key = `${item.process_id}:${item.command_sha256}`;
        if (!state.stageObservations.some((entry) => entry.key === key)) {
          state.stageObservations.push({ key, capturedAt: snapshot.captured_at, process: item });
        }
      }
      for (const item of snapshot.flash_transports || []) {
        const key = `${item.process_id}:${item.command_sha256}:${item.flash_transport_reason}`;
        if (!state.flashTransports.some((entry) => entry.key === key)) {
          state.flashTransports.push({ key, capturedAt: snapshot.captured_at, process: item });
        }
      }
    } catch (error) {
      if (state.parseErrors.length < 8) state.parseErrors.push(String(error));
    }
  };
  child.stdout.setEncoding('utf8');
  child.stdout.on('data', (chunk) => {
    buffer += chunk;
    const lines = buffer.split(/\r?\n/);
    buffer = lines.pop() || '';
    for (const line of lines) acceptLine(line);
  });
  child.stderr.setEncoding('utf8');
  child.stderr.on('data', (chunk) => { state.stderr = `${state.stderr}${chunk}`.slice(-2000); });
  child.on('error', (error) => { state.parseErrors.push(String(error)); });
  return state;
}

async function stopProcessMonitor(monitor) {
  if (!monitor?.child || monitor.child.exitCode != null) return;
  monitor.child.kill();
  await Promise.race([
    new Promise((resolve) => monitor.child.once('exit', resolve)),
    wait(3000),
  ]);
  if (monitor.child.exitCode == null) monitor.child.kill('SIGKILL');
}

function assertProcessMonitorHealthy(monitor) {
  if (monitor.parseErrors.length) {
    throw new Error(`Process monitor failed: ${monitor.parseErrors.join(' | ')}`);
  }
  if (!monitor.latest || monitor.latest.root_process_id !== ckRootPid) {
    throw new Error('Process monitor has not produced a snapshot for the exact CK root PID.');
  }
}

async function waitForProcessQuiescence(monitor, consecutiveRequired, timeout, phase) {
  const deadline = Date.now() + timeout;
  let seenCapture = '';
  let consecutive = 0;
  const samples = [];
  while (Date.now() < deadline) {
    assertProcessMonitorHealthy(monitor);
    const snapshot = monitor.latest;
    if (snapshot.captured_at === seenCapture) {
      await wait(50);
      continue;
    }
    seenCapture = snapshot.captured_at;
    const sample = {
      capturedAt: snapshot.captured_at,
      toolTreeCount: Number(snapshot.tool_tree_count || 0),
      globalOrphanCount: Number(snapshot.global_orphan_count || 0),
    };
    if (samples.length >= 32) samples.shift();
    samples.push(sample);
    if (sample.toolTreeCount === 0 && sample.globalOrphanCount === 0) consecutive += 1;
    else consecutive = 0;
    if (consecutive >= consecutiveRequired) {
      return { phase, requiredConsecutiveCleanPolls: consecutiveRequired, observedConsecutiveCleanPolls: consecutive, samples };
    }
    await wait(50);
  }
  throw new Error(`${phase} did not reach ${consecutiveRequired} consecutive zero tool-tree/global-orphan samples.`);
}

async function clickBuildAction(role) {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('[data-ck-role=${JSON.stringify(role)}]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${role} is unavailable.`);
}

async function clickCancel() {
  const clicked = await evaluate(`(() => {
    const button = document.querySelector('[data-ck-role="build-cancel-action"]');
    if (!button || button.disabled
        || button.getAttribute('aria-label') !== '\u53d6\u6d88\u7f16\u8bd1\u6216\u4e0a\u4f20') return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error('The foreground cancel action was unavailable at the real compiler stage.');
}

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function parseCompileLockSeconds(log) {
  const matches = [...String(log || '').matchAll(/(?:Upload )?compile lock wait(?:\s*\([^)]*\))?:\s*([0-9.]+)s/gi)];
  return matches.length ? Number(matches.at(-1)[1]) : Number.NaN;
}

function makeChecks(facts) {
  return [
    ['normal-upload-button-started', facts.operation.startAction === 'build-normal-upload-action'
      && facts.operation.buildEvidenceSchema === 1 && facts.operation.buildKind === 'upload'],
    ['real-arduino-cli-or-gcc-stage-observed', Boolean(facts.operation.stageObservation?.process?.arduino_or_gcc_stage)],
    ['cancel-command-matched-upload-run-id', facts.runIds.uploadSketch === facts.runIds.cancelCommand && isUuid(facts.runIds.uploadSketch)],
    ['backend-terminated-and-waited-owned-process-tree', facts.cancellation.backendConfirmedWait === true && facts.cancellation.terminatedProcessTreeCount >= 1],
    ['no-flash-transport-before-cancel', facts.flashTransport.observed === false],
    ['ck-tool-tree-and-global-orphans-continuously-zero', facts.quiescence.afterCancel.observedConsecutiveCleanPolls >= 3 && facts.quiescence.afterRecovery.observedConsecutiveCleanPolls >= 3],
    ['recovery-compile-new-run-id-succeeded', facts.recoveryCompile.success === true
      && facts.recoveryCompile.buildEvidenceSchema === 1 && facts.recoveryCompile.buildKind === 'compile'
      && isUuid(facts.runIds.recoveryCompile) && facts.runIds.recoveryCompile !== facts.runIds.uploadSketch],
    ['compile-lock-released-within-5-seconds', Number.isFinite(facts.recoveryCompile.compileLockWaitSeconds) && facts.recoveryCompile.compileLockWaitSeconds <= 5],
    ['source-fqbn-and-port-unchanged', JSON.stringify(facts.identity.before) === JSON.stringify(facts.identity.after)
      && facts.operation.workspaceFingerprint === facts.identity.before.sourceFingerprint
      && facts.recoveryCompile.workspaceFingerprint === facts.identity.before.sourceFingerprint],
  ].map(([id, passed]) => ({ id, passed: Boolean(passed) }));
}

socket.on('open', async () => {
  let exitCode = 0;
  let monitor = null;
  let foregroundMayBeActive = false;
  try {
    await restoreNativeViewport(call);
    await ensureWorkspace();
    await waitForExactBoard();
    await selectPort();
    const beforeIdentity = await readStableWorkspaceIdentity();

    monitor = startProcessMonitor();
    await waitFor(() => Promise.resolve(monitor.latest && !monitor.parseErrors.length), 30000, 'Windows process monitor');
    const preflightQuiescence = await waitForProcessQuiescence(monitor, 2, timeoutMs, 'preflight');

    // A cold board cache makes the normal-upload operation enter a real,
    // cancellable Arduino CLI/GCC process instead of jumping from Exact cache
    // directly to transport.
    await invoke('clear_board_compile_cache', { fqbn: expectedFqbn });
    const afterCacheClearQuiescence = await waitForProcessQuiescence(monitor, 2, timeoutMs, 'after-cache-clear');
    const identityAfterCacheClear = await readStableWorkspaceIdentity();
    if (JSON.stringify(identityAfterCacheClear) !== JSON.stringify(beforeIdentity)) {
      throw new Error('Clearing the board cache changed source/FQBN/port identity.');
    }
    // Preflight/cache-clear observations are not evidence about the operation
    // under test. From this boundary onward every compiler or transport row
    // was created after a clean, exact-identity start.
    monitor.stageObservations.length = 0;
    monitor.flashTransports.length = 0;
    monitor.snapshots.length = 0;

    const uploadStartedAt = new Date().toISOString();
    await clickBuildAction('build-normal-upload-action');
    foregroundMayBeActive = true;
    const uploadCall = await waitForExactBuildEvidence('upload', beforeIdentity);

    const stageObservation = await waitFor(() => {
      assertProcessMonitorHealthy(monitor);
      if (monitor.flashTransports.length) {
        throw new Error('Flash transport started before cancellation could be requested.');
      }
      return Promise.resolve(monitor.stageObservations[0] || false);
    }, timeoutMs, 'a real Arduino CLI/GCC process owned by CK', 50);

    const cancelRequestedAt = new Date().toISOString();
    await clickCancel();

    await waitFor(
      () => evaluate(`(() => {
        const compile = document.querySelector('[data-ck-role="build-compile-action"]');
        const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
        return Boolean(compile && !compile.disabled && !overlay);
      })()`),
      30000,
      'frontend cancellation cleanup',
    );
    const afterCancelQuiescence = await waitForProcessQuiescence(monitor, 3, 60000, 'after-cancel');
    const cancellationCompletedAt = new Date().toISOString();
    const cancellationEvidence = await waitFor(async () => {
      const log = await captureCompileLog();
      const parsed = parseBackendCancellation(log, uploadCall.runId);
      return parsed && parsed.terminatedProcessTreeCount >= 1 ? parsed : false;
    }, 30000, `backend cancellation log for build run ${uploadCall.runId}`, 200);
    foregroundMayBeActive = false;
    if (cancellationEvidence.runId !== uploadCall.runId) {
      throw new Error('Cancellation log runId does not match the normal upload runId.');
    }
    const terminatedProcessTreeCount = cancellationEvidence.terminatedProcessTreeCount;
    if (monitor.flashTransports.length) {
      throw new Error('A write/port Flash transport or avrdude process was observed before cancellation completed.');
    }

    const recoveryStartedAt = new Date().toISOString();
    await clickBuildAction('build-compile-action');
    foregroundMayBeActive = true;
    const recoveryCall = await waitForExactBuildEvidence('compile', beforeIdentity, uploadCall.runId);
    await waitFor(async () => {
      if (monitor.flashTransports.length) {
        throw new Error('A Flash transport was observed during compile-only recovery.');
      }
      const ready = await evaluate(`(() => {
        const button = document.querySelector('[data-ck-role="build-compile-action"]');
        return Boolean(button && !button.disabled && !document.querySelector('[data-ck-role="compile-progress-overlay"]'));
      })()`);
      return ready;
    }, timeoutMs, 'successful recovery compile', 100);
    foregroundMayBeActive = false;

    const recoveryLog = await captureCompileLog();
    if (!/\u7f16\u8bd1\u6210\u529f/.test(recoveryLog)) {
      throw new Error('Recovery compile log is missing the success marker.');
    }
    const compileLockWaitSeconds = parseCompileLockSeconds(recoveryLog);
    if (!Number.isFinite(compileLockWaitSeconds) || compileLockWaitSeconds > 5) {
      throw new Error(`Recovery compile lock wait must be reported and <=5s; found ${compileLockWaitSeconds}.`);
    }
    const recoveryCompletedAt = new Date().toISOString();
    const afterRecoveryQuiescence = await waitForProcessQuiescence(monitor, 3, 60000, 'after-recovery');
    if (monitor.flashTransports.length) {
      throw new Error('A write/port Flash transport or avrdude process was observed in this compile-only recovery run.');
    }
    const afterIdentity = await readStableWorkspaceIdentity();
    if (JSON.stringify(afterIdentity) !== JSON.stringify(beforeIdentity)) {
      throw new Error('Source fingerprint, exact FQBN, project, include signature, or port changed during safe-cancel recovery.');
    }

    const facts = {
      runIds: {
        uploadSketch: uploadCall.runId,
        cancelCommand: cancellationEvidence.runId,
        recoveryCompile: recoveryCall.runId,
      },
      operation: {
        startAction: 'build-normal-upload-action',
        backendCommand: 'upload_sketch',
        startedAt: uploadStartedAt,
        buildEvidenceSchema: Number(uploadCall.schema),
        buildKind: uploadCall.kind,
        workspaceFingerprint: uploadCall.workspaceFingerprint,
        stageObservation,
      },
      cancellation: {
        command: 'cancel_foreground_build',
        requestedAt: cancelRequestedAt,
        resolvedAt: cancellationCompletedAt,
        uploadRejectedAt: cancellationCompletedAt,
        uploadRejected: true,
        completionEvidence: 'matching-backend-cancellation-log-and-frontend-overlay-cleanup',
        backendConfirmedWait: true,
        terminatedProcessTreeCount,
      },
      flashTransport: {
        observed: monitor.flashTransports.length > 0,
        observationCount: monitor.flashTransports.length,
        observations: monitor.flashTransports.slice(0, 16),
        policy: 'esptool elf2image packaging is allowed; avrdude, esptool write_flash, and esptool selected-port transport are forbidden',
      },
      quiescence: {
        preflight: preflightQuiescence,
        afterCacheClear: afterCacheClearQuiescence,
        afterCancel: afterCancelQuiescence,
        afterRecovery: afterRecoveryQuiescence,
      },
      recoveryCompile: {
        command: 'compile_sketch',
        startedAt: recoveryStartedAt,
        completedAt: recoveryCompletedAt,
        buildEvidenceSchema: Number(recoveryCall.schema),
        buildKind: recoveryCall.kind,
        workspaceFingerprint: recoveryCall.workspaceFingerprint,
        success: true,
        successMarker: true,
        compileLockWaitSeconds,
      },
      identity: { before: beforeIdentity, after: afterIdentity },
    };
    const checks = makeChecks(facts);
    const failures = checks.filter((item) => !item.passed).map((item) => item.id);
    if (failures.length) throw new Error(`Safe-cancel checks failed: ${failures.join(', ')}`);

    const report = {
      schemaVersion: 1,
      test_id: 'ck-production-safe-cancel-c6-v1',
      evidenceScope: 'production-exe-normal-upload-cancel-at-real-compiler-stage-and-recovery-compile',
      status: 'passed',
      capturedAt: new Date().toISOString(),
      completedAt: new Date().toISOString(),
      project: expectedProject,
      fqbn: expectedFqbn,
      port: expectedPort,
      ...facts,
      checks,
      failures: [],
      privacy: {
        containsFullMac: false,
        containsWindowsAbsolutePath: false,
        rawCommandLinesRecorded: false,
        rawCompileLogRecorded: false,
      },
    };
    writeJsonAtomic(process.env.CK_SAFE_CANCEL_OUTPUT, sanitizeEvidenceValue(report));
    console.log(`CK_SAFE_CANCEL_RESULT=${JSON.stringify({ status: report.status, checks: report.checks.length })}`);
  } catch (error) {
    if (foregroundMayBeActive) {
      try { await clickCancel(); } catch {}
      try { await wait(1000); } catch {}
    }
    console.error(sanitizeEvidenceValue(error?.stack || String(error)));
    exitCode = 1;
  } finally {
    await stopProcessMonitor(monitor);
    socket.close();
    process.exitCode = exitCode;
  }
});
'@

    $nodeScript | node -
    if ($LASTEXITCODE -ne 0) {
        throw "Production safe-cancel native regression failed with exit code $LASTEXITCODE."
    }
}
catch {
    $runError = $_
}
finally {
    try {
        $completedEvidence = Complete-NativeEvidenceBinding -Binding $binding
    }
    catch {
        if ($null -ne $runError) {
            $runError = [System.InvalidOperationException]::new(
                "Safe-cancel run failed and its post-run evidence binding also failed. Run: $($runError.Exception.Message) Binding: $($_.Exception.Message)",
                $runError.Exception
            )
        }
        else {
            $runError = $_
        }
    }
    Restore-NativeEvidenceEnvironment -Snapshot $environmentSnapshot
}

if ($null -ne $runError) {
    Initialize-NativeEvidenceReportPath -Path $outputFull
    throw $runError
}

try {
    Add-NativeEvidenceBindingToReport -Path $outputFull -Evidence $completedEvidence
}
catch {
    Initialize-NativeEvidenceReportPath -Path $outputFull
    throw
}

Write-Host "Safe-cancel native evidence: $outputFull"
