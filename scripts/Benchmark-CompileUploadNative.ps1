param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM10',
    [string]$ProjectName = 'c3',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32c3',
    [int]$TimeoutSeconds = 900,
    [switch]$SkipCold,
    [switch]$FirstProjectCold,
    [switch]$ReadyInstallCold,
    [switch]$SkipUpload,
    [string]$OutputPath = '',
    [string]$ProgressOutputPath = '',
    [switch]$RequireUploadProgress,
    [string]$ExecutablePath = '',
    [int]$CkProcessId = 0,
    [string]$SourceManifestPath = '',
    [string]$SourceFreezeRecordPath = '',
    [string]$GateReportPath = ''
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if ($SkipUpload -and ($RequireUploadProgress -or -not [string]::IsNullOrWhiteSpace($ProgressOutputPath))) {
    throw 'Upload progress capture cannot be requested together with -SkipUpload.'
}
if ($SkipCold -and ($FirstProjectCold -or $ReadyInstallCold)) {
    throw 'A cold benchmark mode cannot be requested together with -SkipCold.'
}
if ($FirstProjectCold -and $ReadyInstallCold) {
    throw '-FirstProjectCold and -ReadyInstallCold are mutually exclusive.'
}
if (-not [string]::IsNullOrWhiteSpace($OutputPath) -and
    -not [string]::IsNullOrWhiteSpace($ProgressOutputPath) -and
    [System.IO.Path]::GetFullPath($OutputPath) -eq [System.IO.Path]::GetFullPath($ProgressOutputPath)) {
    throw '-OutputPath and -ProgressOutputPath must refer to different files.'
}
Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
function Initialize-NativeBenchmarkReportPaths {
    param([string[]]$Paths)

    foreach ($path in $Paths) {
        if (-not [string]::IsNullOrWhiteSpace($path)) {
            Initialize-NativeEvidenceReportPath -Path $path
        }
    }
}
Initialize-NativeBenchmarkReportPaths -Paths @($OutputPath, $ProgressOutputPath)
$binding = New-NativeEvidenceBinding -Root $Root -DebugPort $DebugPort -ExecutablePath $ExecutablePath `
    -CkProcessId $CkProcessId -SourceManifestPath $SourceManifestPath `
    -SourceFreezeRecordPath $SourceFreezeRecordPath -GateReportPath $GateReportPath
$environmentNames = @(
    'CK_CDP_URL', 'CK_NATIVE_CDP_VIEWPORT_GUARD', 'CK_DESKTOP_NODE_MODULES',
    'CK_BENCHMARK_PORT', 'CK_BENCHMARK_PROJECT', 'CK_BENCHMARK_FQBN',
    'CK_BENCHMARK_TIMEOUT_MS', 'CK_BENCHMARK_SKIP_COLD',
    'CK_BENCHMARK_FIRST_PROJECT_COLD', 'CK_BENCHMARK_READY_INSTALL_COLD', 'CK_BENCHMARK_SKIP_UPLOAD',
    'CK_BENCHMARK_OUTPUT', 'CK_BENCHMARK_PROGRESS_OUTPUT',
    'CK_BENCHMARK_REQUIRE_UPLOAD_PROGRESS', 'CK_BENCHMARK_ROOT'
)
$environmentSnapshot = Save-NativeEvidenceEnvironment -Names $environmentNames
$runError = $null
$completedEvidence = $null

try {
$env:CK_CDP_URL = [string]$binding.cdp_binding.web_socket_debugger_url
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_DESKTOP_NODE_MODULES = Join-Path $Root 'apps/desktop/node_modules'
$env:CK_BENCHMARK_PORT = $Port
$env:CK_BENCHMARK_PROJECT = $ProjectName
$env:CK_BENCHMARK_FQBN = $ExpectedFqbn
$env:CK_BENCHMARK_TIMEOUT_MS = [string]($TimeoutSeconds * 1000)
$env:CK_BENCHMARK_SKIP_COLD = if ($SkipCold) { 'true' } else { 'false' }
$env:CK_BENCHMARK_FIRST_PROJECT_COLD = if ($FirstProjectCold) { 'true' } else { 'false' }
$env:CK_BENCHMARK_READY_INSTALL_COLD = if ($ReadyInstallCold) { 'true' } else { 'false' }
$env:CK_BENCHMARK_SKIP_UPLOAD = if ($SkipUpload) { 'true' } else { 'false' }
$env:CK_BENCHMARK_OUTPUT = $OutputPath
$env:CK_BENCHMARK_PROGRESS_OUTPUT = $ProgressOutputPath
$env:CK_BENCHMARK_REQUIRE_UPLOAD_PROGRESS = if ($RequireUploadProgress) { 'true' } else { 'false' }
$env:CK_BENCHMARK_ROOT = [System.IO.Path]::GetFullPath($Root)

$nodeScript = @'
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD || './native-cdp-viewport-guard.cjs');

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
    [path.resolve(process.env.CK_BENCHMARK_ROOT), '<CK_ROOT>'],
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

function normalizeHeaderList(headers) {
  return [...new Set((headers || [])
    .map((header) => String(header || '').trim().toLowerCase())
    .filter(Boolean))]
    .sort();
}

function headersFromSignature(signature) {
  return normalizeHeaderList(String(signature || '').split('|'));
}

function sameHeaderList(left, right) {
  return JSON.stringify(normalizeHeaderList(left)) === JSON.stringify(normalizeHeaderList(right));
}

function pageBlocklyContextPrelude() {
  const projectName = process.env.CK_BENCHMARK_PROJECT;
  const expectedNames = [projectName, `${projectName}.maker`, `${projectName}.ck`];
  return `
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    const currentProject = identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
    const expectedProjects = ${JSON.stringify(expectedNames)};
    if (!expectedProjects.includes(currentProject)) {
      throw new Error('Native regression workspace mismatch. Expected ' + ${JSON.stringify(String(projectName))} + ', found ' + (currentProject || 'unknown') + '.');
    }

    // The release build deliberately does not publish Blockly as a complete
    // global. CK's narrow page-local bridge is authoritative when available.
    const nativeRegressionBridge = globalThis.CK_NATIVE_REGRESSION;
    const nativeRegressionContext = nativeRegressionBridge?.schemaVersion === 1
      && typeof nativeRegressionBridge.getCurrent === 'function'
      ? nativeRegressionBridge.getCurrent()
      : null;
    let Blockly = nativeRegressionContext?.Blockly || globalThis.Blockly;
    let workspace = nativeRegressionContext?.workspace || null;

    // Keep the Vite/dev compatibility path, including pages where
    // globalThis.Blockly only contains Msg and cannot find the main workspace.
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    if (typeof Blockly?.getMainWorkspace !== 'function' && blocklyUrl) {
      const imported = await import(blocklyUrl);
      Blockly = typeof imported.getMainWorkspace === 'function' ? imported : imported.default;
    }
    workspace ||= Blockly?.getMainWorkspace?.() || globalThis.Mixly?.Editor?.blockEditor || null;
  `;
}

async function readGeneratedSourceIdentity() {
  return evaluate(`(async () => {
    ${pageBlocklyContextPrelude()}
    const blockTypes = workspace?.getAllBlocks(false).map((block) => block.type) || [];
    return {
      identityPresent: Boolean(identity),
      fingerprintAttributePresent: Boolean(identity?.hasAttribute('data-ck-code-fingerprint')),
      includeSignatureAttributePresent: Boolean(identity?.hasAttribute('data-ck-include-signature')),
      codeFingerprint: identity?.getAttribute('data-ck-code-fingerprint') ?? null,
      includeSignature: identity?.getAttribute('data-ck-include-signature') ?? null,
      hasWifiConnect: blockTypes.includes('wifi_connect'),
      blockCount: blockTypes.length,
    };
  })()`);
}

async function waitForStableGeneratedSource(
  timeoutMs = 30000,
  intervalMs = 300,
  expectedFingerprint = '',
  rejectedFingerprint = '',
) {
  const deadline = Date.now() + timeoutMs;
  let previousKey = '';
  let consecutiveStableSamples = 0;
  let lastState = null;
  let lastReason = 'no source identity sample';
  while (Date.now() < deadline) {
    const state = await readGeneratedSourceIdentity();
    lastState = state;
    const includeHeaders = headersFromSignature(state?.includeSignature);
    if (!state?.identityPresent) {
      lastReason = 'workspace project identity is missing';
    } else if (!state.fingerprintAttributePresent || !state.includeSignatureAttributePresent) {
      lastReason = 'workspace identity must expose data-ck-code-fingerprint and data-ck-include-signature';
    } else if (!state.codeFingerprint) {
      lastReason = 'generated code fingerprint is empty';
    } else if (expectedFingerprint && state.codeFingerprint !== expectedFingerprint) {
      lastReason = `waiting for generated code fingerprint ${expectedFingerprint}`;
    } else if (rejectedFingerprint && state.codeFingerprint === rejectedFingerprint) {
      lastReason = `waiting for generated code fingerprint to change from ${rejectedFingerprint}`;
    } else if (state.hasWifiConnect && !includeHeaders.includes('wifi.h')) {
      lastReason = 'wifi_connect is present but the generated include signature does not contain wifi.h';
    } else {
      const key = JSON.stringify({
        codeFingerprint: state.codeFingerprint,
        includeHeaders,
        hasWifiConnect: state.hasWifiConnect,
        blockCount: state.blockCount,
      });
      consecutiveStableSamples = key === previousKey ? consecutiveStableSamples + 1 : 1;
      previousKey = key;
      if (consecutiveStableSamples >= 2) {
        return {
          codeFingerprint: state.codeFingerprint,
          includeSignature: includeHeaders.join('|'),
          includeHeaders,
          hasWifiConnect: state.hasWifiConnect,
          blockCount: state.blockCount,
          consecutiveStableSamples,
        };
      }
      lastReason = 'waiting for a second consecutive identical source sample';
    }
    if (lastReason !== 'waiting for a second consecutive identical source sample') {
      previousKey = '';
      consecutiveStableSamples = 0;
    }
    await wait(intervalMs);
  }
  throw new Error(`Generated source did not become stable: ${lastReason}; last state: ${JSON.stringify(lastState)}`);
}

async function ensureWorkspace() {
  const projectName = process.env.CK_BENCHMARK_PROJECT;
  const expectedNames = [projectName, `${projectName}.maker`, `${projectName}.ck`];
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const currentProject = await evaluate(`(() => {
      const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
      return identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
    })()`);
    if (!expectedNames.includes(currentProject)) {
      throw new Error(`Refusing to benchmark the wrong open project. Expected ${projectName}, found ${currentProject || 'unknown'}.`);
    }
    return;
  }
  await waitFor(
    `[...document.querySelectorAll('h3[title]')]
      .some((heading) => heading.title === ${JSON.stringify(projectName)})`,
    30000,
    `${projectName} project card`,
  );
  const opened = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3[title]')]
      .find((item) => item.title === ${JSON.stringify(projectName)});
    const card = heading?.closest('[class*="cursor-pointer"]') || heading?.parentElement?.parentElement;
    card?.click();
    return Boolean(card);
  })()`);
  if (!opened) throw new Error(`Project could not be opened: ${projectName}`);
  await waitFor(
    `Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`,
    30000,
    `${projectName} workspace`,
  );
  const currentProject = await evaluate(`(() => {
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    return identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
  })()`);
  if (!expectedNames.includes(currentProject)) {
    throw new Error(`Opened workspace identity mismatch. Expected ${projectName}, found ${currentProject || 'unknown'}.`);
  }
}

async function waitForExactBoard() {
  const expectedFqbn = process.env.CK_BENCHMARK_FQBN;
  let lastTitle = '';
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const title = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="board-config-button"]');
      if (!button) return false;
      const status = button.dataset.ckBoardOptionsStatus || '';
      const compatible = button.dataset.ckBoardOptionsCompatible || '';
      if (status === 'unverified' || compatible === 'false') return false;
      return ['resolved', 'core-default'].includes(status) && !button.disabled ? button.title : false;
    })()`);
    if (title) {
      lastTitle = String(title);
      const activeFqbn = lastTitle
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) || '';
      if (activeFqbn === expectedFqbn) return activeFqbn;
    }
    await wait(150);
  }
  const activeFqbn = lastTitle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || '';
  throw new Error(`Board mismatch after waiting for project configuration. Expected exact FQBN ${expectedFqbn}; UI reports ${activeFqbn || lastTitle || 'unavailable'}`);
}

async function selectPort() {
  const port = process.env.CK_BENCHMARK_PORT;
  if (await evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(port)})`)) return;
  await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    refresh?.click();
    return Boolean(refresh);
  })()`);
  await wait(800);
  const opened = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
    toggle?.click();
    return Boolean(toggle);
  })()`);
  if (!opened) throw new Error('Port selector could not be opened.');
  await waitFor(
    `[...document.querySelectorAll('[role="menu"] button')]
      .some((item) => item.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(port)})`,
    10000,
    `${port} in port menu`,
  );
  const selected = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menu"] button')]
      .find((button) => button.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(port)});
    item?.click();
    return Boolean(item);
  })()`);
  if (!selected) throw new Error(`Port could not be selected: ${port}`);
  await waitFor(
    `[...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .some((button) => button.title === ${JSON.stringify(port)})`,
    10000,
    `${port} selection`,
  );
}

async function invoke(command, args) {
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

function requireEvidenceText(value, label) {
  const text = typeof value === 'string' ? value.trim() : '';
  if (!text) throw new Error(`Verified baseline is missing ${label}.`);
  return text;
}

function requireEvidenceSha256(value, label) {
  const digest = requireEvidenceText(value, label).toLowerCase();
  if (!/^[0-9a-f]{64}$/.test(digest)) {
    throw new Error(`Verified baseline ${label} is not a valid SHA-256 digest.`);
  }
  return digest;
}

function requireEvidenceTimestamp(value, label) {
  const timestamp = requireEvidenceText(value, label);
  if (!Number.isFinite(Date.parse(timestamp))) {
    throw new Error(`Verified baseline ${label} is not a valid timestamp.`);
  }
  return timestamp;
}

function requirePositiveSafeInteger(value, label) {
  const number = Number(value);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Verified baseline ${label} must be a positive safe integer.`);
  }
  return number;
}

function normalizeNullableText(value) {
  if (value == null) return null;
  const text = String(value).trim();
  return text || null;
}

function normalizeNullableResourceInteger(value, label, allowZero = true) {
  if (value == null) return null;
  if (typeof value !== 'number'
    || !Number.isSafeInteger(value)
    || value < (allowZero ? 0 : 1)) {
    throw new Error(`Verified baseline ${label} is invalid.`);
  }
  return value;
}

function assertEvidenceContainsNoSensitiveValues(value, label) {
  const serialized = JSON.stringify(value);
  if (/(?:file:\/\/\/)?[a-z]:[\\/]/i.test(serialized)) {
    throw new Error(`${label} contains an absolute filesystem path.`);
  }
  if (/\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i.test(serialized)
    || /\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/i.test(serialized)) {
    throw new Error(`${label} contains a complete MAC address.`);
  }
}

function buildVerifiedBaseline(version, expectedFqbn, uploadStartedAt, previousBaselineId = null) {
  if (!version || typeof version !== 'object') {
    throw new Error('The successful upload did not create an available verified baseline.');
  }
  const minimumTimestamp = requireEvidenceTimestamp(uploadStartedAt, 'uploadStartedAt');
  const minimumTimestampMs = Date.parse(minimumTimestamp);
  const createdAt = requireEvidenceTimestamp(version.createdAt, 'createdAt');
  const verifiedAt = requireEvidenceTimestamp(version.verifiedAt, 'verifiedAt');
  if (Date.parse(createdAt) < minimumTimestampMs || Date.parse(verifiedAt) < minimumTimestampMs) {
    throw new Error('Verified baseline predates this upload operation; refusing to reuse a stale successful version.');
  }
  const baselineId = requireEvidenceText(version.id, 'id');
  if (previousBaselineId != null && baselineId === String(previousBaselineId).trim()) {
    throw new Error('Verified baseline identity did not change during this upload operation.');
  }
  const environment = version.environment || {};
  const fqbn = requireEvidenceText(environment.fqbn, 'environment.fqbn');
  if (fqbn !== expectedFqbn) {
    throw new Error(`Verified baseline FQBN mismatch. Expected ${expectedFqbn}, found ${fqbn}.`);
  }

  const rawArtifacts = Array.isArray(version.firmware?.artifacts)
    ? version.firmware.artifacts
    : [];
  const addressedArtifacts = rawArtifacts.filter((artifact) => (
    artifact?.flashAddress != null && String(artifact.flashAddress).trim() !== ''
  ));
  if (addressedArtifacts.length === 0) {
    throw new Error('Verified ESP32 baseline has no addressed firmware segments.');
  }
  const seenAddresses = new Set();
  const artifacts = addressedArtifacts.map((artifact, index) => {
    const role = requireEvidenceText(artifact.role, `firmware.artifacts[${index}].role`);
    const flashAddress = requireEvidenceText(
      artifact.flashAddress,
      `firmware.artifacts[${index}].flashAddress`,
    ).toLowerCase();
    if (!/^0x[0-9a-f]+$/.test(flashAddress)) {
      throw new Error(`Verified baseline firmware.artifacts[${index}].flashAddress is invalid.`);
    }
    if (seenAddresses.has(flashAddress)) {
      throw new Error(`Verified baseline contains duplicate flash address ${flashAddress}.`);
    }
    seenAddresses.add(flashAddress);
    return {
      role,
      flashAddress,
      size: requirePositiveSafeInteger(artifact.size, `firmware.artifacts[${index}].size`),
      sha256: requireEvidenceSha256(artifact.sha256, `firmware.artifacts[${index}].sha256`),
    };
  });

  const device = version.device || {};
  const psramBytes = device.psramBytes == null
    ? null
    : requirePositiveSafeInteger(device.psramBytes, 'device.psramBytes');
  const resources = version.resources || {};
  const flashUsedBytes = normalizeNullableResourceInteger(resources.flashUsedBytes, 'resources.flashUsedBytes');
  const flashMaxBytes = normalizeNullableResourceInteger(resources.flashMaxBytes, 'resources.flashMaxBytes', false);
  const ramUsedBytes = normalizeNullableResourceInteger(resources.ramUsedBytes, 'resources.ramUsedBytes');
  const ramMaxBytes = normalizeNullableResourceInteger(resources.ramMaxBytes, 'resources.ramMaxBytes', false);
  for (const [label, value] of [
    ['resources.flashUsedBytes', flashUsedBytes],
    ['resources.flashMaxBytes', flashMaxBytes],
    ['resources.ramUsedBytes', ramUsedBytes],
    ['resources.ramMaxBytes', ramMaxBytes],
  ]) {
    if (value == null) {
      throw new Error(`Verified baseline ${label} is missing; refusing to publish unmeasured resource evidence.`);
    }
  }
  if (flashUsedBytes != null && flashMaxBytes != null && flashUsedBytes > flashMaxBytes) {
    throw new Error('Verified baseline Flash usage exceeds its reported maximum.');
  }
  if (ramUsedBytes != null && ramMaxBytes != null && ramUsedBytes > ramMaxBytes) {
    throw new Error('Verified baseline RAM usage exceeds its reported maximum.');
  }

  const baseline = {
    createdAt,
    verifiedAt,
    environment: {
      fqbn,
      coreId: requireEvidenceText(environment.coreId, 'environment.coreId'),
      coreVersion: requireEvidenceText(environment.coreVersion, 'environment.coreVersion'),
      arduinoCliVersion: requireEvidenceText(
        environment.arduinoCliVersion,
        'environment.arduinoCliVersion',
      ),
      toolchainKey: requireEvidenceText(environment.toolchainKey, 'environment.toolchainKey'),
      buildSignature: requireEvidenceText(environment.buildSignature, 'environment.buildSignature'),
      compileProfile: requireEvidenceText(environment.compileProfile, 'environment.compileProfile'),
      optimization: requireEvidenceText(environment.optimization, 'environment.optimization'),
    },
    firmware: {
      manifestSha256: requireEvidenceSha256(
        version.firmware?.manifestSha256,
        'firmware.manifestSha256',
      ),
      partitionSha256: requireEvidenceSha256(
        version.firmware?.partition?.sha256,
        'firmware.partitionSha256',
      ),
      artifacts,
    },
    device: {
      chip: requireEvidenceText(device.chip, 'device.chip'),
      revision: normalizeNullableText(device.revision),
      flashBytes: requirePositiveSafeInteger(device.flashBytes, 'device.flashBytes'),
      psramBytes,
    },
    resources: {
      flashUsedBytes,
      flashMaxBytes,
      ramUsedBytes,
      ramMaxBytes,
      warningCount: normalizeNullableResourceInteger(
        resources.warningCount,
        'resources.warningCount',
      ),
    },
  };
  if (baseline.resources.warningCount == null) {
    throw new Error('Verified baseline resources.warningCount is missing.');
  }
  assertEvidenceContainsNoSensitiveValues(baseline, 'Verified baseline');
  return baseline;
}

async function readLastWorkingVersion(projectName) {
  const projects = await invoke('list_projects', {});
  if (!Array.isArray(projects)) {
    throw new Error('Project inventory was unavailable after the successful upload.');
  }
  const matches = projects.filter((project) => String(project?.name || '') === projectName);
  if (matches.length !== 1) {
    throw new Error(`Expected exactly one project named ${projectName}; found ${matches.length}.`);
  }
  return invoke('get_last_working_version', { projectPath: matches[0].path });
}

async function captureVerifiedBaseline(
  projectName,
  expectedFqbn,
  uploadStartedAt,
  previousBaselineId,
) {
  const version = await readLastWorkingVersion(projectName);
  return buildVerifiedBaseline(version, expectedFqbn, uploadStartedAt, previousBaselineId);
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

function parseReportedIncludeHeaders(log) {
  const markers = [...log.matchAll(/\[INFO\]\s+Sketch include headers(?:\s*\(\d+\))?:[^\r\n]*/gi)];
  const marker = markers.at(-1);
  if (!marker) return { reported: false, headers: [] };
  const tail = log.slice((marker.index || 0) + marker[0].length);
  const headers = [...tail.matchAll(/^\s*\[INFO\]\s+Include Header:\s*([^\r\n]+)$/gim)]
    .map((match) => match[1]);
  return { reported: true, headers: normalizeHeaderList(headers) };
}

function parseIncludeHeaderDelta(log) {
  const matches = [
    ...log.matchAll(/include headers delta:\s*added=\[([^\]]*)\]\s*removed=\[([^\]]*)\]/gi),
    ...log.matchAll(/include delta\s*\(\s*added=\[([^\]]*)\]\s*,\s*removed=\[([^\]]*)\]\s*\)/gi),
  ].sort((left, right) => (left.index || 0) - (right.index || 0));
  const match = matches.at(-1);
  const parseSide = (value) => {
    const normalized = String(value || '').trim();
    if (!normalized || /^\(none\)$/i.test(normalized)) return [];
    return normalizeHeaderList(normalized.split(','));
  };
  return match
    ? { reported: true, added: parseSide(match[1]), removed: parseSide(match[2]) }
    : { reported: false, added: [], removed: [] };
}

function parseMetrics(log) {
  const pickLast = (regex) => {
    const matches = [...log.matchAll(regex)];
    return Number(matches.at(-1)?.[1] || 0);
  };
  const sum = (regex) => Number([...log.matchAll(regex)]
    .reduce((total, match) => total + Number(match[1] || 0), 0)
    .toFixed(3));
  const pickLastText = (regex) => [...log.matchAll(regex)].at(-1)?.[1]?.trim() || '';
  const includeReport = parseReportedIncludeHeaders(log);
  const includeDelta = parseIncludeHeaderDelta(log);
  const compileLockMatches = [...log.matchAll(/^\s*\[Timing\]\s+Compile lock wait:\s*([0-9]+(?:\.[0-9]+)?)s\s*$/gim)];
  const uploadCompileLockMatches = [
    ...log.matchAll(/^\s*\[Timing\]\s+Upload compile lock wait(?:\s*\([^\r\n)]*\))?:\s*([0-9]+(?:\.[0-9]+)?)s\s*$/gim),
  ];
  const allCompileLockMatches = [...compileLockMatches, ...uploadCompileLockMatches];
  return {
    reportedSeconds: pickLast(/(?:\u7f16\u8bd1\u6210\u529f|\u4e0a\u4f20\u6210\u529f)[^\n]*?([0-9.]+)\s*\u79d2/gi),
    cliCompileSeconds: sum(/(?:Upload )?CLI compile phase(?:\s*\([^)]*\))?:\s*([0-9.]+)s/gi),
    compileLockWaitReported: allCompileLockMatches.length > 0,
    compileLockSeconds: Number(allCompileLockMatches
      .reduce((total, match) => total + Number(match[1] || 0), 0)
      .toFixed(3)),
    uploadCompileLockWaitReported: uploadCompileLockMatches.length > 0,
    uploadCompileLockSeconds: Number(uploadCompileLockMatches
      .reduce((total, match) => total + Number(match[1] || 0), 0)
      .toFixed(3)),
    fastRelinkSeconds: pickLast(/Fast Relink completed in\s*([0-9.]+)s/gi),
    uploadTransportSeconds: pickLast(/Upload transport phase:\s*([0-9.]+)s/gi),
    exactMatch: /Cached build \(Exact Match\)|Stellar Speed: Code unchanged \(Exact Match\)|Exact Match:|Exact-match cache HIT/i.test(log),
    fullBuild: /\[INFO\] Full Build:/i.test(log),
    fastRelink: /Fast Relink path: sketch-only compile \+ direct link/i.test(log),
    codeChanged: /Sketch file updated \(content changed\)|Exact-match cache MISS:[^\r\n]*\bcode_changed\b/i.test(log),
    includeHeadersReported: includeReport.reported,
    includeHeaders: includeReport.headers,
    includeSignature: includeReport.headers.join('|'),
    includeHeadersChanged: /\binclude_headers_changed\b/i.test(log),
    includeHeadersDelta: includeDelta,
    profile: pickLastText(/Compile Profile:\s*([^\r\n]+)/gi),
    buildDirectory: pickLastText(/Build Directory:\s*([^\r\n]+)/gi),
    forcedRebuildObserved: /\[INFO\] Forced rebuild(?: requested|:)/i.test(log),
    forceCcacheRecacheObserved: /ccache will be refreshed|bypassing existing ccache hits/i.test(log),
    prebuiltCoreInjected: /Core cache injected directly from prebuilt_cores repository/i.test(log),
    syntheticCcdbPrepared: /^\s*\[Timing DIAG\]\s+fast_relink_ccdb_prepare\s+method=synthetic\s+duration_ms=[0-9]+\s+status=success\s*$/im.test(log),
    arduinoCliCcdbRefreshObserved: /^\s*\[Timing DIAG\]\s+fast_relink_ccdb_prepare\s+method=arduino-cli-only-compilation-database\b[^\r\n]*$/im.test(log),
    matchingWarmupWaitObserved: /waited for matching warmup window/i.test(log),
    compatibleWarmupReuseObserved: /Reusing compatible same-board warmup|Upload is reusing compatible same-board warmup/i.test(log),
  };
}

function analyzeUploadCompileLock(metrics, maxAllowedSeconds = 5) {
  const failures = [];
  const reported = metrics?.uploadCompileLockWaitReported === true;
  const seconds = Number(metrics?.uploadCompileLockSeconds);
  const bounded = Number.isFinite(seconds) && seconds >= 0 && seconds <= maxAllowedSeconds;
  const matchingWarmupWaitObserved = metrics?.matchingWarmupWaitObserved === true;
  const compatibleWarmupReuseObserved = metrics?.compatibleWarmupReuseObserved === true;
  if (!reported) failures.push('Upload compile-lock wait telemetry was not reported.');
  if (!bounded) failures.push(`Upload compile-lock wait exceeded ${maxAllowedSeconds}s or was invalid.`);
  if (matchingWarmupWaitObserved) failures.push('Upload waited for a matching background warmup.');
  if (compatibleWarmupReuseObserved) failures.push('Upload reused a compatible background warmup instead of prioritizing foreground work.');
  return {
    status: failures.length === 0 ? 'passed' : 'failed',
    reported,
    seconds: Number.isFinite(seconds) ? seconds : null,
    maxAllowedSeconds,
    matchingWarmupWaitObserved,
    compatibleWarmupReuseObserved,
    failures,
  };
}

function recordUploadProgressSample(samples, seenKeys, rawSample) {
  if (!rawSample || rawSample.percentage === '' || rawSample.percentage == null) return false;
  const percentage = Number(rawSample.percentage);
  if (!Number.isFinite(percentage)) return false;
  const sample = {
    elapsedMs: Math.max(0, Math.round(Number(rawSample.elapsedMs) || 0)),
    stage: String(rawSample.stage || '').slice(0, 80),
    message: String(rawSample.message || '').slice(0, 240),
    visiblePercentageText: String(rawSample.visiblePercentageText || '').trim().slice(0, 16),
    percentage,
    textClientWidth: Math.max(0, Number(rawSample.textClientWidth) || 0),
    textScrollWidth: Math.max(0, Number(rawSample.textScrollWidth) || 0),
  };
  sample.textFits = sample.textClientWidth > 0
    && sample.textScrollWidth <= sample.textClientWidth + 1;
  const key = JSON.stringify({
    stage: sample.stage,
    message: sample.message,
    visiblePercentageText: sample.visiblePercentageText,
    percentage: sample.percentage,
    textFits: sample.textFits,
  });
  if (seenKeys.has(key)) return false;
  seenKeys.add(key);
  samples.push(sample);
  return true;
}

function analyzeUploadProgress(samples) {
  const captured = Array.isArray(samples) ? samples : [];
  const percentages = captured.map((sample) => Number(sample?.percentage));
  const valuesFinite = percentages.every(Number.isFinite);
  const valuesBounded = valuesFinite
    && percentages.every((percentage) => percentage >= 0 && percentage <= 100);
  const integerPercentages = valuesFinite && percentages.every(Number.isInteger);
  const monotonic = valuesFinite && percentages.every((percentage, index) => (
    index === 0 || percentage >= percentages[index - 1]
  ));
  const hasTwoDigitPercentage = percentages.some((percentage) => percentage >= 10 && percentage <= 99);
  const finalPercentageIs100 = percentages.length > 0 && percentages.at(-1) === 100;
  const percentageTextComplete = captured.every((sample) => (
    String(sample?.visiblePercentageText || '').trim() === `${Math.round(Number(sample?.percentage))}%`
  ));
  const percentageTextFits = captured.every((sample) => sample?.textFits === true);
  const failures = [];
  if (captured.length === 0) failures.push('No upload progress samples were captured.');
  if (!valuesFinite) failures.push('Upload progress contains a non-finite percentage.');
  if (!valuesBounded) failures.push('Upload progress escaped the 0..100 range.');
  if (!integerPercentages) failures.push('Upload progress data attribute must contain an integer percentage.');
  if (!monotonic) failures.push('Aggregate upload progress moved backwards.');
  if (!hasTwoDigitPercentage) failures.push('No two-digit upload percentage was observed.');
  if (!finalPercentageIs100) failures.push('The final captured upload percentage was not 100%.');
  if (!percentageTextComplete) failures.push('Visible upload percentage text did not match the complete numeric value.');
  if (!percentageTextFits) failures.push('Visible upload percentage text was clipped by its layout box.');
  return {
    success: failures.length === 0,
    sampleCount: captured.length,
    minPercent: valuesFinite && percentages.length ? Math.min(...percentages) : null,
    maxPercent: valuesFinite && percentages.length ? Math.max(...percentages) : null,
    valuesBounded,
    integerPercentages,
    monotonic,
    hasTwoDigitPercentage,
    finalPercentageIs100,
    percentageTextComplete,
    percentageTextFits,
    failures,
    samples: captured,
  };
}

function assertCompileIncludeConsistency(cycles, initialSource, hotSource) {
  const expectedHeaders = normalizeHeaderList(initialSource?.includeHeaders);
  if (!sameHeaderList(expectedHeaders, hotSource?.includeHeaders)) {
    throw new Error(`Delay-only source edit changed the generated include signature: before=[${expectedHeaders.join(', ')}] after=[${normalizeHeaderList(hotSource?.includeHeaders).join(', ')}].`);
  }
  const compileCycles = [
    ['cold', cycles.cold],
    ['exactPriming', cycles.exactPriming],
    ['exact', cycles.exact],
    ['hotEdit', cycles.hotEdit],
  ].filter(([, cycle]) => Boolean(cycle));
  for (const [name, cycle] of compileCycles) {
    if (!cycle.includeHeadersReported) {
      throw new Error(`${name} cycle did not report its sketch include headers; refusing to compare inconsistent metrics.`);
    }
    if (!sameHeaderList(cycle.includeHeaders, expectedHeaders)) {
      throw new Error(`${name} cycle include headers differ from the stable generated source: expected=[${expectedHeaders.join(', ')}] reported=[${normalizeHeaderList(cycle.includeHeaders).join(', ')}].`);
    }
  }
  const hotDelta = cycles.hotEdit?.includeHeadersDelta;
  if (cycles.hotEdit?.includeHeadersChanged
    || Boolean(hotDelta?.added?.length)
    || Boolean(hotDelta?.removed?.length)) {
    throw new Error(`Delay-only hot edit reported a non-empty include delta: added=[${hotDelta?.added?.join(', ') || '(none)'}] removed=[${hotDelta?.removed?.join(', ') || '(none)'}].`);
  }
  return {
    expectedHeaders,
    expectedSignature: expectedHeaders.join('|'),
    comparedCycles: compileCycles.map(([name]) => name),
    delayOnlyHotDeltaVerifiedEmpty: true,
  };
}

function evaluateCacheClearIdentity(coldMode, cacheClear, expectedFqbn) {
  const expectedByMode = {
    firstProjectCold: {
      reset_scope: 'first-project-full-fqbn',
      ccache_store_preserved: true,
      prebuilt_core_preserved: false,
      prebuilt_core_validated: false,
      force_rebuild_pending: false,
      force_ccache_recache: false,
    },
    readyInstallCold: {
      reset_scope: 'ready-install-project-full-fqbn',
      ccache_store_preserved: true,
      prebuilt_core_preserved: true,
      prebuilt_core_validated: true,
      force_rebuild_pending: false,
      force_ccache_recache: false,
    },
  };
  const expected = expectedByMode[String(coldMode || '')];
  if (!expected) return { required: false, passed: true, failures: [] };

  const failures = [];
  if (typeof expectedFqbn !== 'string' || expectedFqbn.length === 0
    || cacheClear?.fqbn !== expectedFqbn) {
    failures.push('fqbn');
  }
  for (const [field, expectedValue] of Object.entries(expected)) {
    if (cacheClear?.[field] !== expectedValue) failures.push(field);
  }
  return {
    required: true,
    passed: failures.length === 0,
    failures,
  };
}

function buildBenchmarkOutcomeChecks(result) {
  const skippedStages = new Set(
    (Array.isArray(result?.skippedStages) ? result.skippedStages : [])
      .map((item) => String(item?.stage || '')),
  );
  const initial = result?.sourceGate?.initial;
  const hotEdit = result?.sourceGate?.hotEdit;
  const restored = result?.sourceGate?.restored;
  const cold = result?.cycles?.cold;
  const coldMode = String(result?.coldMode || '');
  const uploadProgressRequired = result?.requireUploadProgress === true;
  const cacheClearIdentity = evaluateCacheClearIdentity(
    coldMode,
    result?.cacheClear,
    result?.fqbn,
  );
  const coldVerified = skippedStages.has('cold') || (
    coldMode === 'readyInstallCold'
      ? cold?.exactMatch === false
        && cold?.fastRelink === true
        && cold?.fullBuild === false
        && cold?.prebuiltCoreInjected === true
        && cold?.syntheticCcdbPrepared === true
        && cold?.arduinoCliCcdbRefreshObserved === false
        && result?.cacheClear?.prebuilt_core_preserved === true
        && result?.cacheClear?.prebuilt_core_validated === true
        && cacheClearIdentity.passed === true
      : cold?.fullBuild === true
        && cold?.exactMatch === false
        && (coldMode !== 'firstProjectCold' || cacheClearIdentity.passed === true)
  );
  const uploadVerified = skippedStages.has('upload') || (
    Boolean(result?.cycles?.upload)
    && result?.uploadCompileLock?.status === 'passed'
    && Array.isArray(result?.uploadCompileLock?.failures)
    && result.uploadCompileLock.failures.length === 0
    && (!uploadProgressRequired || (
      result?.uploadProgress?.status === 'passed'
      && Array.isArray(result?.uploadProgress?.failures)
      && result.uploadProgress.failures.length === 0
    ))
    && Boolean(result?.verified_baseline)
  );
  return [
    { id: 'cold-stage-verified-or-explicitly-skipped', passed: coldVerified === true },
    { id: 'exact-cache-hit-confirmed', passed: result?.cycles?.exact?.exactMatch === true },
    {
      id: 'hot-edit-code-change-confirmed',
      passed: result?.cycles?.hotEdit?.exactMatch === false
        && result?.cycles?.hotEdit?.codeChanged === true,
    },
    {
      id: 'generated-source-restored',
      passed: Boolean(initial?.codeFingerprint)
        && initial.codeFingerprint === restored?.codeFingerprint
        && initial.codeFingerprint !== hotEdit?.codeFingerprint
        && sameHeaderList(initial?.includeHeaders, restored?.includeHeaders),
    },
    { id: 'upload-stage-verified-or-explicitly-skipped', passed: uploadVerified === true },
  ];
}

async function runOperation(kind) {
  const isUpload = kind === 'upload';
  const startedAt = Date.now();
  const uploadProgressSamples = [];
  const uploadProgressSeenKeys = new Set();
  const trackerKey = `__ckBenchmarkOperation_${kind}_${startedAt}`;
  const clicked = await evaluate(`(() => {
    const button = ${isUpload
      ? `document.querySelector('[data-ck-role="build-normal-upload-action"]')`
      : `document.querySelector('[data-ck-role="build-compile-action"]')`};
    if (!button || button.disabled) return false;
    const tracker = {
      seenActive: false,
      observer: null,
      progressSamples: [],
      progressSeenKeys: new Set(),
    };
    const captureProgress = () => {
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const message = document.querySelector('[data-ck-role="compile-progress-message"]');
      const percentage = document.querySelector('[data-ck-role="compile-progress-percentage"]');
      if (overlay?.dataset.ckProgressMode !== 'upload' || !percentage) return;
      const progressSample = {
        elapsedMs: Math.max(0, Date.now() - ${startedAt}),
        stage: overlay.dataset.ckProgressStage || '',
        message: message?.innerText?.trim() || message?.textContent?.trim() || '',
        visiblePercentageText: percentage.innerText?.trim() || percentage.textContent?.trim() || '',
        percentage: overlay.dataset.ckProgressPercentage || '',
        textClientWidth: percentage.clientWidth,
        textScrollWidth: percentage.scrollWidth,
      };
      const progressKey = JSON.stringify({
        stage: progressSample.stage,
        message: progressSample.message,
        visiblePercentageText: progressSample.visiblePercentageText,
        percentage: progressSample.percentage,
        textClientWidth: progressSample.textClientWidth,
        textScrollWidth: progressSample.textScrollWidth,
      });
      if (tracker.progressSeenKeys.has(progressKey)) return;
      tracker.progressSeenKeys.add(progressKey);
      tracker.progressSamples.push(progressSample);
    };
    const sample = () => {
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const compile = document.querySelector('[data-ck-role="build-compile-action"]');
      if (overlay || (compile && compile.disabled)) tracker.seenActive = true;
      captureProgress();
    };
    tracker.observer = new MutationObserver((records) => {
      if (records.some((record) => (
        record.type === 'attributes'
        && record.attributeName === 'disabled'
        && record.oldValue === null
      ))) tracker.seenActive = true;
      if (records.some((record) => [...record.addedNodes]
        .some((node) => node.nodeType === Node.ELEMENT_NODE && (
          node.matches?.('[data-ck-role="compile-progress-overlay"]')
          || node.querySelector?.('[data-ck-role="compile-progress-overlay"]')
        )))) tracker.seenActive = true;
      sample();
    });
    tracker.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      characterData: true,
      attributeFilter: [
        'disabled',
        'data-ck-progress-mode',
        'data-ck-progress-stage',
        'data-ck-progress-percentage',
      ],
      attributeOldValue: true,
    });
    window[${JSON.stringify(trackerKey)}] = tracker;
    button.click();
    sample();
    return true;
  })()`);
  try {
    if (!clicked) throw new Error(`${kind} button is unavailable.`);
    await waitFor(
      `Boolean(window[${JSON.stringify(trackerKey)}]?.seenActive)`,
      10000,
      `${kind} start`,
    );
    const timeoutMs = Number(process.env.CK_BENCHMARK_TIMEOUT_MS || 900000);
    let nextHeartbeat = 15000;
    while (Date.now() - startedAt < timeoutMs) {
      const state = await evaluate(`(() => {
        const tracker = window[${JSON.stringify(trackerKey)}];
        const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
        const message = document.querySelector('[data-ck-role="compile-progress-message"]');
        const percentage = document.querySelector('[data-ck-role="compile-progress-percentage"]');
        const compile = document.querySelector('[data-ck-role="build-compile-action"]');
        const active = Boolean(overlay) || Boolean(compile && compile.disabled);
        if (active && tracker) tracker.seenActive = true;
        const bufferedProgressSamples = Array.isArray(tracker?.progressSamples)
          ? tracker.progressSamples.splice(0)
          : [];
        return {
          seenActive: Boolean(tracker?.seenActive),
          active,
          ready: Boolean(compile && !compile.disabled),
          stage: overlay?.dataset.ckProgressStage || '',
          message: message?.textContent?.trim() || '',
          percentage: percentage?.textContent?.trim() || '',
          bufferedProgressSamples,
          progressSample: overlay?.dataset.ckProgressMode === 'upload' && percentage ? {
            elapsedMs: Math.max(0, Date.now() - ${startedAt}),
            stage: overlay.dataset.ckProgressStage || '',
            message: message?.innerText?.trim() || message?.textContent?.trim() || '',
            visiblePercentageText: percentage.innerText?.trim() || percentage.textContent?.trim() || '',
            percentage: overlay.dataset.ckProgressPercentage || '',
            textClientWidth: percentage.clientWidth,
            textScrollWidth: percentage.scrollWidth,
          } : null,
        };
      })()`);
      const elapsed = Date.now() - startedAt;
      if (isUpload) {
        for (const progressSample of state.bufferedProgressSamples || []) {
          recordUploadProgressSample(uploadProgressSamples, uploadProgressSeenKeys, progressSample);
        }
      }
      if (isUpload && state.progressSample) {
        recordUploadProgressSample(uploadProgressSamples, uploadProgressSeenKeys, state.progressSample);
      }
      if (elapsed >= nextHeartbeat) {
        console.log(`[benchmark] ${kind} ${Math.round(elapsed / 1000)}s stage=${state.stage || '-'} progress=${state.percentage || '-'} ${state.message || ''}`);
        nextHeartbeat += 15000;
      }
      if (state.seenActive && !state.active && state.ready) {
        await wait(300);
        const log = await captureCompileLog();
        const success = isUpload
          ? /\u666e\u901a(?:\u56fa\u4ef6)?\u4e0a\u4f20\u6210\u529f/.test(log)
          : /\u7f16\u8bd1\u6210\u529f/.test(log);
        if (!success) throw new Error(`${kind} ended without a success marker.\n${log.slice(-5000)}`);
        return {
          schemaId: 'ck.native-compile-upload-operation',
          schemaVersion: 1,
          kind,
          success: true,
          wallSeconds: Number((elapsed / 1000).toFixed(3)),
          ...parseMetrics(log),
          progressSamples: isUpload ? uploadProgressSamples : undefined,
          evidence: log.split(/\r?\n/)
            .filter((line) => /Target Board:|Compile Profile:|Exact Match|Fast Relink|Full Build:|Forced rebuild|ccache will be refreshed|bypassing existing ccache hits|Core cache injected directly|fast_relink_ccdb_prepare|Sketch file updated|Sketch include headers|Include Header:|include headers delta|include_headers_changed|CLI compile phase|compile lock wait|matching warmup|Reusing compatible same-board warmup|Upload transport phase|Build Directory:|\u7f16\u8bd1\u6210\u529f|\u4e0a\u4f20\u6210\u529f/i.test(line))
            .slice(-60),
        };
      }
      await wait(200);
    }
    throw new Error(`${kind} exceeded ${timeoutMs}ms.`);
  } finally {
    await evaluate(`(() => {
      const tracker = window[${JSON.stringify(trackerKey)}];
      tracker?.observer?.disconnect();
      delete window[${JSON.stringify(trackerKey)}];
      return true;
    })()`).catch(() => undefined);
  }
}

async function mutateDelay(delta) {
  return evaluate(`(async () => {
    ${pageBlocklyContextPrelude()}
    if (!workspace) return null;
    const delaySpecs = [
      { type: 'control_delay', inputNames: ['TIME'] },
      { type: 'controls_delay', inputNames: ['DELAY_TIME', 'TIME'] },
      { type: 'io_delay_us', inputNames: ['US'] },
      { type: 'delay_ms', fieldName: 'MS', inputNames: [] },
    ];
    const allBlocks = workspace.getAllBlocks(false);
    for (const spec of delaySpecs) {
      for (const delayBlock of allBlocks.filter((block) => block.type === spec.type)) {
        let fieldBlock = delayBlock;
        let fieldName = spec.fieldName || '';
        let field = fieldName ? delayBlock.getField(fieldName) : null;
        if (!field) {
          for (const inputName of spec.inputNames) {
            const candidate = delayBlock.getInput(inputName)?.connection?.targetBlock();
            const candidateField = candidate?.getField('NUM');
            if (candidate && candidateField) {
              fieldBlock = candidate;
              fieldName = 'NUM';
              field = candidateField;
              break;
            }
          }
        }
        if (!field || !fieldName) continue;
        const originalValue = String(field.getValue());
        const originalNumber = Number(originalValue);
        if (!Number.isFinite(originalNumber)) continue;
        const editedValue = String(originalNumber + ${Number(delta)});
        field.setValue(editedValue);
        if (String(field.getValue()) !== editedValue) {
          field.setValue(originalValue);
          continue;
        }
        return {
          delayBlockId: delayBlock.id,
          delayBlockType: delayBlock.type,
          fieldBlockId: fieldBlock.id,
          fieldName,
          originalValue,
          editedValue,
        };
      }
    }
    return null;
  })()`);
}

async function restoreDelay(edit) {
  if (!edit?.fieldBlockId || !edit?.fieldName || typeof edit.originalValue !== 'string') return false;
  return evaluate(`(async () => {
    ${pageBlocklyContextPrelude()}
    const edit = ${JSON.stringify(edit)};
    const fieldBlock = workspace?.getBlockById(edit.fieldBlockId);
    const field = fieldBlock?.getField(edit.fieldName);
    if (!field) return false;
    field.setValue(edit.originalValue);
    return String(field.getValue()) === edit.originalValue;
  })()`);
}

async function saveProject() {
  const dispatched = await evaluate(`(() => {
    const close = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u63d0\u793a');
    close?.click();
    window.dispatchEvent(new KeyboardEvent('keydown', {
      key: 's',
      code: 'KeyS',
      ctrlKey: true,
      bubbles: true,
      cancelable: true,
    }));
    return true;
  })()`);
  if (!dispatched) return false;
  const status = await waitFor(`(() => {
    const close = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u63d0\u793a');
    const text = close?.parentElement?.querySelector('span')?.textContent?.trim() || '';
    return /^\u4fdd\u5b58(?:\u6210\u529f|\u5931\u8d25)/.test(text) ? text : false;
  })()`, 30000, 'project save result');
  if (/\u5931\u8d25/.test(status)) throw new Error(`Project save failed: ${status}`);
  return true;
}

socket.on('open', async () => {
  let exitCode = 0;
  let delayEdit = null;
  try {
    await restoreNativeViewport(call);
    await ensureWorkspace();
    const activeFqbn = await waitForExactBoard();
    await selectPort();

    // Refuse before clearing caches or compiling when the intended hot-edit
    // target is not actually present. This also catches a temporarily empty
    // Blockly workspace after a development hot reload.
    const delayPreflight = await mutateDelay(0);
    if (delayPreflight == null || delayPreflight.originalValue !== delayPreflight.editedValue) {
      throw new Error('A supported delay block with a stable numeric literal is required before the benchmark can start.');
    }
    const initialSource = await waitForStableGeneratedSource();

    const result = {
      schemaId: 'ck.native-compile-upload-benchmark',
      schemaVersion: 1,
      status: 'running',
      runId: `native-${Date.now()}-${process.pid}`,
      evidenceScope: 'single-native-session',
      capturedAt: new Date().toISOString(),
      project: process.env.CK_BENCHMARK_PROJECT,
      fqbn: activeFqbn,
      port: process.env.CK_BENCHMARK_PORT,
      requireUploadProgress: process.env.CK_BENCHMARK_REQUIRE_UPLOAD_PROGRESS === 'true',
      coldMode: process.env.CK_BENCHMARK_SKIP_COLD === 'true'
        ? 'skipped'
        : process.env.CK_BENCHMARK_READY_INSTALL_COLD === 'true'
          ? 'readyInstallCold'
        : process.env.CK_BENCHMARK_FIRST_PROJECT_COLD === 'true'
          ? 'firstProjectCold'
          : 'hardRefreshCold',
      sourceGate: {
        initial: initialSource,
      },
      cycles: {},
      skippedStages: [],
      checks: [],
      failures: [],
    };

    if (process.env.CK_BENCHMARK_SKIP_COLD !== 'true') {
      const cacheClearCommand = process.env.CK_BENCHMARK_FIRST_PROJECT_COLD === 'true'
        ? 'clear_board_first_project_compile_cache'
        : process.env.CK_BENCHMARK_READY_INSTALL_COLD === 'true'
          ? 'clear_board_ready_install_project_compile_cache'
        : 'clear_board_compile_cache';
      result.cacheClear = await invoke(cacheClearCommand, { fqbn: activeFqbn });
      const cacheClearIdentity = evaluateCacheClearIdentity(
        result.coldMode,
        result.cacheClear,
        activeFqbn,
      );
      if (cacheClearIdentity.required && !cacheClearIdentity.passed) {
        throw new Error(`Cache-clear identity contract failed for ${result.coldMode}: ${cacheClearIdentity.failures.join(', ')}.`);
      }
      await wait(250);
      result.cycles.cold = await runOperation('compile');
      if (process.env.CK_BENCHMARK_READY_INSTALL_COLD === 'true') {
        if (result.cycles.cold.exactMatch !== false
          || result.cycles.cold.fastRelink !== true
          || result.cycles.cold.fullBuild !== false
          || result.cycles.cold.prebuiltCoreInjected !== true
          || result.cycles.cold.syntheticCcdbPrepared !== true
          || result.cycles.cold.arduinoCliCcdbRefreshObserved !== false
          || result.cacheClear?.prebuilt_core_preserved !== true
          || result.cacheClear?.prebuilt_core_validated !== true) {
          throw new Error('Ready-install cold cycle was not a synthetic-CCDB, non-Exact Fast Relink using a validated exact-target prebuilt Core without Arduino CLI CCDB fallback.');
        }
      } else if (!result.cycles.cold.fullBuild || result.cycles.cold.exactMatch) {
        throw new Error('Cold cycle was not a verified full build after clearing the exact active FQBN cache.');
      }
    } else {
      result.skippedStages.push({ stage: 'cold', reason: 'requested by -SkipCold' });
    }

    const exactCandidate = await runOperation('compile');
    if (exactCandidate.exactMatch) {
      result.cycles.exact = exactCandidate;
    } else {
      result.cycles.exactPriming = exactCandidate;
      result.cycles.exact = await runOperation('compile');
    }
    if (!result.cycles.exact.exactMatch) {
      throw new Error('Exact cycle did not report an exact-match cache hit; refusing to mislabel the metric.');
    }

    delayEdit = await mutateDelay(1);
    if (delayEdit == null) throw new Error('A supported delay block with a numeric literal is required for the hot-edit cycle.');
    const hotSource = await waitForStableGeneratedSource(
      30000,
      300,
      '',
      initialSource.codeFingerprint,
    );
    result.sourceGate.hotEdit = hotSource;
    result.cycles.hotEdit = await runOperation('compile');
    if (result.cycles.hotEdit.exactMatch || !result.cycles.hotEdit.codeChanged) {
      throw new Error('Hot-edit cycle did not report a real code change; refusing to publish a false hot-edit metric.');
    }
    result.includeConsistency = assertCompileIncludeConsistency(
      result.cycles,
      initialSource,
      hotSource,
    );
    if (process.env.CK_BENCHMARK_SKIP_UPLOAD !== 'true') {
      const previousBaseline = await readLastWorkingVersion(process.env.CK_BENCHMARK_PROJECT);
      const previousBaselineId = previousBaseline?.id == null
        ? null
        : requireEvidenceText(previousBaseline.id, 'previousBaseline.id');
      const uploadStartedAt = new Date().toISOString();
      const uploadCycle = await runOperation('upload');
      const { progressSamples = [], ...uploadMetrics } = uploadCycle;
      result.cycles.upload = uploadMetrics;
      result.uploadCompileLock = analyzeUploadCompileLock(uploadMetrics, 5);
      if (result.uploadCompileLock.status !== 'passed') {
        throw new Error(`Upload compile-lock evidence failed: ${result.uploadCompileLock.failures.join(' ')}`);
      }
      const progressAnalysis = analyzeUploadProgress(progressSamples);
      result.uploadProgress = {
        schemaId: 'ck.native-upload-progress',
        schemaVersion: 1,
        status: progressAnalysis.success ? 'passed' : 'failed',
        benchmarkRunId: result.runId,
        capturedAt: new Date().toISOString(),
        project: process.env.CK_BENCHMARK_PROJECT,
        fqbn: activeFqbn,
        port: process.env.CK_BENCHMARK_PORT,
        operationWallSeconds: uploadMetrics.wallSeconds,
        ...progressAnalysis,
      };
      const progressOutputPath = String(process.env.CK_BENCHMARK_PROGRESS_OUTPUT || '').trim();
      if (progressOutputPath) {
        writeJsonAtomic(progressOutputPath, sanitizeEvidenceValue(result.uploadProgress));
      }
      if (process.env.CK_BENCHMARK_REQUIRE_UPLOAD_PROGRESS === 'true'
        && !result.uploadProgress.success) {
        throw new Error(`Upload progress evidence failed: ${result.uploadProgress.failures.join(' ')}`);
      }
      result.verified_baseline = await captureVerifiedBaseline(
        process.env.CK_BENCHMARK_PROJECT,
        activeFqbn,
        uploadStartedAt,
        previousBaselineId,
      );
    } else {
      result.skippedStages.push({ stage: 'upload', reason: 'requested by -SkipUpload' });
    }

    if (result.cycles.cold) {
      result.hotEditImprovementPercent = Number((
        (result.cycles.cold.wallSeconds - result.cycles.hotEdit.wallSeconds)
        / result.cycles.cold.wallSeconds * 100
      ).toFixed(1));
      result.hotEditTarget30PercentMet = result.hotEditImprovementPercent >= 30;
      result.hotEditTarget40PercentMet = result.hotEditImprovementPercent >= 40;
    }

    if (!await restoreDelay(delayEdit)) throw new Error('The edited delay field could not be restored.');
    const restoredSource = await waitForStableGeneratedSource(
      30000,
      300,
      initialSource.codeFingerprint,
    );
    if (!sameHeaderList(restoredSource.includeHeaders, initialSource.includeHeaders)) {
      throw new Error('Restored source include signature differs from the initial stable source.');
    }
    result.sourceGate.restored = restoredSource;
    if (!await saveProject()) throw new Error('The restored project could not be saved.');
    delayEdit = null;
    result.checks = buildBenchmarkOutcomeChecks(result);
    result.failures = result.checks
      .filter((check) => check.passed !== true)
      .map((check) => check.id);
    result.status = result.failures.length === 0 ? 'passed' : 'failed';

    const outputPath = String(process.env.CK_BENCHMARK_OUTPUT || '').trim();
    const safeResult = sanitizeEvidenceValue(result);
    if (outputPath) {
      writeJsonAtomic(outputPath, safeResult);
    }
    console.log(`CK_BENCHMARK_RESULT=${JSON.stringify(safeResult)}`);
    if (result.failures.length > 0) {
      throw new Error(`Benchmark outcome checks failed: ${result.failures.join(', ')}`);
    }
  } catch (error) {
    console.error(sanitizeEvidenceValue(error?.stack || String(error)));
    exitCode = 1;
  } finally {
    if (delayEdit != null) {
      try {
        if (!await restoreDelay(delayEdit)) throw new Error('Delay field restoration returned false.');
        await wait(300);
        if (!await saveProject()) throw new Error('Saving the restored project returned false.');
        delayEdit = null;
      } catch (restoreError) {
        console.error(sanitizeEvidenceValue(`Failed to restore benchmark edit: ${restoreError}`));
        exitCode = 1;
      }
    }
    socket.close();
    process.exitCode = exitCode;
  }
});
'@

$nodeScript | node -
if ($LASTEXITCODE -ne 0) {
    throw "Native compile/upload benchmark failed with exit code $LASTEXITCODE."
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
                "Native run failed and its post-run evidence binding also failed. Run: $($runError.Exception.Message) Binding: $($_.Exception.Message)",
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
    Initialize-NativeBenchmarkReportPaths -Paths @($OutputPath, $ProgressOutputPath)
    throw $runError
}
try {
    if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
        Add-NativeEvidenceBindingToReport -Path $OutputPath -Evidence $completedEvidence
    }
    if (-not [string]::IsNullOrWhiteSpace($ProgressOutputPath)) {
        Add-NativeEvidenceBindingToReport -Path $ProgressOutputPath -Evidence $completedEvidence
    }
}
catch {
    Initialize-NativeBenchmarkReportPaths -Paths @($OutputPath, $ProgressOutputPath)
    throw
}
