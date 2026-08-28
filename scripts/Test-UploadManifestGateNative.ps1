param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM11',
    [string]$ProjectName = 'c5_n16r8',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32c5:FlashSize=16M,PSRAM=enabled,PartitionScheme=app3M_fat9M_16MB',
    [string]$WrongPartitionScheme = 'fatflash',
    [int]$TimeoutSeconds = 1200,
    [string]$OutputPath = '',
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
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root 'artifacts\benchmarks\esp32c5-n16r8-manifest-gate.json'
}

Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
Initialize-NativeEvidenceReportPath -Path $OutputPath
$binding = New-NativeEvidenceBinding -Root $Root -DebugPort $DebugPort -ExecutablePath $ExecutablePath `
    -CkProcessId $CkProcessId -SourceManifestPath $SourceManifestPath `
    -SourceFreezeRecordPath $SourceFreezeRecordPath -GateReportPath $GateReportPath
$environmentNames = @(
    'CK_CDP_URL', 'CK_NATIVE_CDP_VIEWPORT_GUARD', 'CK_DESKTOP_NODE_MODULES',
    'CK_MANIFEST_GATE_PORT', 'CK_MANIFEST_GATE_PROJECT', 'CK_MANIFEST_GATE_FQBN',
    'CK_MANIFEST_GATE_WRONG_PARTITION', 'CK_MANIFEST_GATE_TIMEOUT_MS',
    'CK_MANIFEST_GATE_OUTPUT'
)
$environmentSnapshot = Save-NativeEvidenceEnvironment -Names $environmentNames
$runError = $null
$completedEvidence = $null

try {
$env:CK_CDP_URL = [string]$binding.cdp_binding.web_socket_debugger_url
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_DESKTOP_NODE_MODULES = Join-Path $Root 'apps/desktop/node_modules'
$env:CK_MANIFEST_GATE_PORT = $Port
$env:CK_MANIFEST_GATE_PROJECT = $ProjectName
$env:CK_MANIFEST_GATE_FQBN = $ExpectedFqbn
$env:CK_MANIFEST_GATE_WRONG_PARTITION = $WrongPartitionScheme
$env:CK_MANIFEST_GATE_TIMEOUT_MS = [string]($TimeoutSeconds * 1000)
$env:CK_MANIFEST_GATE_OUTPUT = $OutputPath

$nodeScript = @'
const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD || './native-cdp-viewport-guard.cjs');

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

async function invoke(command, args) {
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

function canonicalizeFqbn(rawFqbn) {
  const parts = String(rawFqbn || '').trim().split(':');
  if (parts.length < 3 || parts.slice(0, 3).some((item) => !item.trim())) {
    throw new Error(`Malformed FQBN: ${rawFqbn}`);
  }
  const base = parts.slice(0, 3).map((item) => item.trim()).join(':');
  const rawOptions = parts.slice(3).join(':').trim();
  if (!rawOptions) return base;
  const options = new Map();
  for (const rawOption of rawOptions.split(',')) {
    const separator = rawOption.indexOf('=');
    if (separator <= 0 || separator === rawOption.length - 1) {
      throw new Error(`Malformed FQBN option: ${rawOption}`);
    }
    const key = rawOption.slice(0, separator).trim();
    const value = rawOption.slice(separator + 1).trim();
    if (!key || !value || options.has(key)) {
      throw new Error(`Invalid or duplicate FQBN option: ${rawOption}`);
    }
    options.set(key, value);
  }
  const encoded = [...options.entries()]
    // Rust's BTreeMap canonicalizer uses byte/code-point ordering. Do not use
    // localeCompare here: it places "PartitionScheme" before "PSRAM" on some
    // Windows locales and would disagree with the backend manifest contract.
    .sort(([left], [right]) => (left < right ? -1 : left > right ? 1 : 0))
    .map(([key, value]) => `${key}=${value}`)
    .join(',');
  return `${base}:${encoded}`;
}

function replaceFqbnOption(fqbn, key, value) {
  const canonical = canonicalizeFqbn(fqbn);
  const parts = canonical.split(':');
  if (parts.length < 4) throw new Error(`FQBN has no configurable options: ${canonical}`);
  const options = new Map(parts.slice(3).join(':').split(',').map((item) => item.split('=')));
  if (!options.has(key)) throw new Error(`FQBN does not contain required option ${key}: ${canonical}`);
  if (options.get(key) === value) throw new Error(`${key} is already ${value}; no mismatch would be tested.`);
  options.set(key, value);
  return canonicalizeFqbn(`${parts.slice(0, 3).join(':')}:${[...options.entries()]
    .map(([optionKey, optionValue]) => `${optionKey}=${optionValue}`)
    .join(',')}`);
}

function fqbnBase(fqbn) {
  return canonicalizeFqbn(fqbn).split(':').slice(0, 3).join(':');
}

function acceptedProjectNames(projectName) {
  return [projectName, `${projectName}.maker`, `${projectName}.ck`];
}

function pageBlocklyContextPrelude() {
  const projectName = process.env.CK_MANIFEST_GATE_PROJECT;
  const expectedNames = acceptedProjectNames(projectName);
  return `
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    const currentProject = identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
    const expectedProjects = ${JSON.stringify(expectedNames)};
    if (!expectedProjects.includes(currentProject)) {
      throw new Error('Manifest-gate workspace mismatch before the reversible cache-prime edit.');
    }
    const bridge = globalThis.CK_NATIVE_REGRESSION;
    const context = bridge?.schemaVersion === 1 && typeof bridge.getCurrent === 'function'
      ? bridge.getCurrent()
      : null;
    const workspace = context?.workspace || globalThis.Blockly?.getMainWorkspace?.() || null;
  `;
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
    const field = workspace?.getBlockById(edit.fieldBlockId)?.getField(edit.fieldName);
    if (!field) return false;
    field.setValue(edit.originalValue);
    return String(field.getValue()) === edit.originalValue;
  })()`);
}

async function currentWorkspaceProject() {
  return waitFor(`(() => {
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    return identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
  })()`, 10000, 'workspace project identity');
}

async function ensureWorkspace() {
  const projectName = process.env.CK_MANIFEST_GATE_PROJECT;
  const expectedNames = acceptedProjectNames(projectName);
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const currentProject = await currentWorkspaceProject();
    if (!expectedNames.includes(currentProject)) {
      throw new Error(`Refusing to test the wrong open project. Expected ${projectName}, found ${currentProject || 'unknown'}.`);
    }
    return currentProject;
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
  const currentProject = await currentWorkspaceProject();
  if (!expectedNames.includes(currentProject)) {
    throw new Error(`Opened workspace identity mismatch. Expected ${projectName}, found ${currentProject || 'unknown'}.`);
  }
  return currentProject;
}

async function waitForExactBoard() {
  const expectedFqbn = canonicalizeFqbn(process.env.CK_MANIFEST_GATE_FQBN);
  let lastTitle = '';
  const deadline = Date.now() + 60000;
  while (Date.now() < deadline) {
    const title = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="board-config-button"]');
      if (!button || button.disabled) return false;
      const status = button.dataset.ckBoardOptionsStatus || '';
      const compatible = button.dataset.ckBoardOptionsCompatible || '';
      if (!['resolved', 'core-default'].includes(status) || compatible === 'false') return false;
      return button.title || false;
    })()`);
    if (title) {
      lastTitle = String(title);
      const actualFqbn = canonicalizeFqbn(lastTitle
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) || '');
      if (actualFqbn === expectedFqbn) return actualFqbn;
    }
    await wait(150);
  }
  let actualFqbn = '';
  try {
    actualFqbn = canonicalizeFqbn(lastTitle
      .split(/\r?\n/)
      .map((line) => line.trim())
      .filter(Boolean)
      .at(-1) || '');
  } catch {}
  throw new Error(`Board mismatch after waiting for project configuration. Expected exact FQBN ${expectedFqbn}; UI reports ${actualFqbn || lastTitle || 'unavailable'}.`);
}

async function selectAndVerifyPort() {
  const port = process.env.CK_MANIFEST_GATE_PORT;
  await waitFor(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
    return Boolean(refresh && toggle);
  })()`, 10000, 'serial refresh and selector controls');
  const refreshed = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    if (!refresh || refresh.disabled) return false;
    refresh.click();
    return true;
  })()`);
  if (!refreshed) throw new Error('Serial refresh action could not be used.');
  await waitFor(`(async () => {
    try {
      const ports = await window.__TAURI_INTERNALS__.invoke('list_serial_ports');
      return Array.isArray(ports) && ports.some((item) => (
        (item?.port_name || item?.portName || '').trim() === ${JSON.stringify(port)}
      ));
    } catch {
      return false;
    }
  })()`, 15000, `${port} discovery after refresh`, 250);

  const selectedAlready = await evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(port)})`);
  if (!selectedAlready) {
    const opened = await evaluate(`(() => {
      const refresh = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
      const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
      if (!toggle || toggle.disabled) return false;
      toggle.click();
      return true;
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
      if (!item || item.disabled) return false;
      item.click();
      return true;
    })()`);
    if (!selected) throw new Error(`Port could not be selected: ${port}`);
  }
  await waitFor(
    `[...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .some((button) => button.title === ${JSON.stringify(port)})`,
    10000,
    `${port} exact selection`,
  );
  return port;
}

async function assertUiTargetUnchanged(project, expectedFqbn, port) {
  const currentProject = await currentWorkspaceProject();
  if (!acceptedProjectNames(process.env.CK_MANIFEST_GATE_PROJECT).includes(currentProject)
    || currentProject !== project) {
    throw new Error(`Workspace changed during manifest-gate preflight: ${currentProject || 'unknown'}.`);
  }
  const currentFqbn = await waitForExactBoard();
  if (currentFqbn !== expectedFqbn) throw new Error('Board configuration changed during manifest-gate preflight.');
  const selectedPort = await evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(port)})`);
  if (!selectedPort) throw new Error('Serial port selection changed during manifest-gate preflight.');
  return true;
}

const WORKSPACE_IDENTITY_FIELDS = Object.freeze([
  'project',
  'codeFingerprint',
  'includeSignature',
  'projectDirty',
  'fqbn',
  'port',
]);

async function readStableWorkspaceIdentity(expectedFqbn, port, timeoutMs = 30000) {
  const canonicalExpected = canonicalizeFqbn(expectedFqbn);
  const expectedProjects = acceptedProjectNames(process.env.CK_MANIFEST_GATE_PROJECT);
  const deadline = Date.now() + timeoutMs;
  let previousKey = '';
  let stableSamples = 0;
  let last = null;
  while (Date.now() < deadline) {
    const raw = await evaluate(`(() => {
      const project = document.querySelector('[data-ck-role="workspace-project-identity"]');
      const board = document.querySelector('[data-ck-role="board-config-button"]');
      const boardLines = (board?.title || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      const selectedPort = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
        .find((button) => button.title === ${JSON.stringify(port)})?.title || '';
      return {
        project: project?.dataset.ckProjectName || project?.textContent?.trim() || '',
        fingerprintAttributePresent: Boolean(project?.hasAttribute('data-ck-code-fingerprint')),
        codeFingerprint: project?.getAttribute('data-ck-code-fingerprint') || '',
        includeSignatureAttributePresent: Boolean(project?.hasAttribute('data-ck-include-signature')),
        includeSignature: project?.getAttribute('data-ck-include-signature') || '',
        dirtyAttributePresent: Boolean(project?.hasAttribute('data-ck-project-dirty')),
        projectDirty: project?.getAttribute('data-ck-project-dirty') || '',
        fqbn: boardLines.at(-1) || '',
        port: selectedPort,
      };
    })()`);
    let fqbn = '';
    try { fqbn = canonicalizeFqbn(raw?.fqbn || ''); } catch {}
    last = {
      project: String(raw?.project || ''),
      codeFingerprint: String(raw?.codeFingerprint || ''),
      includeSignature: String(raw?.includeSignature || ''),
      projectDirty: String(raw?.projectDirty || ''),
      fqbn,
      port: String(raw?.port || ''),
    };
    const valid = expectedProjects.includes(last.project)
      && raw?.fingerprintAttributePresent === true
      && last.codeFingerprint.length > 0
      && raw?.includeSignatureAttributePresent === true
      && raw?.dirtyAttributePresent === true
      && ['true', 'false'].includes(last.projectDirty)
      && last.fqbn === canonicalExpected
      && last.port === port;
    const key = JSON.stringify(last);
    if (valid) {
      stableSamples = key === previousKey ? stableSamples + 1 : 1;
      previousKey = key;
      if (stableSamples >= 2) return last;
    } else {
      previousKey = '';
      stableSamples = 0;
    }
    await wait(250);
  }
  throw new Error(`Workspace source identity did not become stable; last fields: ${JSON.stringify({
    project: last?.project || '',
    hasFingerprint: Boolean(last?.codeFingerprint),
    fqbn: last?.fqbn || '',
    port: last?.port || '',
  })}`);
}

async function waitForSourceIdentityState(baseline, mode, timeoutMs = 30000) {
  const expectedFqbn = canonicalizeFqbn(process.env.CK_MANIFEST_GATE_FQBN);
  const expectedPort = process.env.CK_MANIFEST_GATE_PORT;
  const deadline = Date.now() + timeoutMs;
  let last = null;
  let lastError = null;
  while (Date.now() < deadline) {
    try {
      last = await readStableWorkspaceIdentity(expectedFqbn, expectedPort, 5000);
      lastError = null;
    } catch (error) {
      lastError = error;
      await wait(250);
      continue;
    }
    const sameFingerprint = last.codeFingerprint === baseline.codeFingerprint;
    const sameIncludes = last.includeSignature === baseline.includeSignature;
    const sameTarget = last.project === baseline.project
      && last.fqbn === baseline.fqbn
      && last.port === baseline.port;
    const dirtyExpected = mode === 'changed'
      ? last.projectDirty === 'true'
      : last.projectDirty === baseline.projectDirty;
    if (sameTarget && sameIncludes && dirtyExpected
      && ((mode === 'changed' && !sameFingerprint) || (mode === 'restored' && sameFingerprint))) {
      return last;
    }
    await wait(250);
  }
  throw new Error(`Reversible cache-prime edit did not reach ${mode} source identity: ${JSON.stringify({
    baselineFingerprint: baseline.codeFingerprint,
    lastFingerprint: last?.codeFingerprint || '',
    baselineIncludes: baseline.includeSignature,
    lastIncludes: last?.includeSignature || '',
    baselineDirty: baseline.projectDirty,
    lastDirty: last?.projectDirty || '',
    lastError: lastError ? String(lastError) : '',
  })}`);
}

function assertWorkspaceIdentityUnchanged(before, after, phase) {
  if (!before || !after || !String(before.codeFingerprint || '')) {
    throw new Error(`Workspace identity proof is incomplete at ${phase}.`);
  }
  for (const field of WORKSPACE_IDENTITY_FIELDS) {
    if (String(before[field] ?? '') !== String(after[field] ?? '')) {
      throw new Error(`Workspace identity changed at ${phase}: ${field}.`);
    }
  }
  return true;
}

function analyzeOperationLogIdentity(log, expectedFqbn, kind) {
  const targets = [...String(log || '').matchAll(/^\s*\[INFO\]\s+Target Board:\s*([^\r\n]+)$/gim)]
    .map((match) => canonicalizeFqbn(match[1].trim()));
  if (!targets.length || targets.some((target) => target !== expectedFqbn)) {
    throw new Error(`${kind} output did not contain only the exact expected FQBN.`);
  }
  return {
    targetLogCount: targets.length,
    allTargetFqbnsExact: true,
  };
}

function summarizeOperationEvidence(operations, beforeIdentity, summary) {
  const records = Array.isArray(operations) ? operations : [];
  const compileRecords = records.filter((item) => item.kind === 'compile');
  const uploadRecords = records.filter((item) => item.kind === 'upload');
  if (!String(beforeIdentity?.codeFingerprint || '') || compileRecords.length < 4 || uploadRecords.length !== 2) {
    throw new Error('Visible operation evidence does not cover both independent compile/upload gate phases.');
  }
  const reportedRunIds = records.map((item) => item.buildRunId);
  if (new Set(reportedRunIds).size !== records.length) {
    throw new Error('Visible operation evidence reused a foreground build UUID.');
  }
  for (const record of records) {
    if (!record.readyBefore || !record.activeObserved || !record.readyAfter || !record.overlayAbsentAfter) {
      throw new Error(`Visible ${record.kind || 'build'} operation did not complete an idle-active-ready UI transition.`);
    }
    if (record.sourceScope === 'transient-cache-prime') {
      assertWorkspaceIdentityUnchanged(record.identityBefore, record.identityAfter, `${record.kind}-transient-operation`);
      if (record.identityBefore.codeFingerprint === beforeIdentity.codeFingerprint
        || record.identityBefore.includeSignature !== beforeIdentity.includeSignature
        || record.identityBefore.projectDirty !== 'true'
        || record.identityBefore.project !== beforeIdentity.project
        || record.identityBefore.fqbn !== beforeIdentity.fqbn
        || record.identityBefore.port !== beforeIdentity.port) {
        throw new Error('Transient cache-prime operation changed more than the reversible source fingerprint.');
      }
    } else {
      assertWorkspaceIdentityUnchanged(beforeIdentity, record.identityBefore, `${record.kind}-operation-before`);
      assertWorkspaceIdentityUnchanged(beforeIdentity, record.identityAfter, `${record.kind}-operation-after`);
    }
    if (!record.allTargetFqbnsExact || record.selectedPortBefore !== beforeIdentity.port
      || record.selectedPortAfter !== beforeIdentity.port) {
      throw new Error(`Visible ${record.kind || 'build'} operation changed the exact FQBN or selected port.`);
    }
    if (record.buildEvidenceSchema !== 1 || !isUuid(record.buildRunId)
      || record.frozenWorkspaceFingerprint !== record.identityBefore.codeFingerprint) {
      throw new Error(`Visible ${record.kind || 'build'} operation lacks exact frozen build evidence.`);
    }
  }
  const diskChainComplete = summary?.hashMutation?.onlyManifestModified === true
    && summary?.hashMutation?.firmwareArtifactsModified === false
    && summary?.mutation?.onlyManifestModified === true
    && summary?.mutation?.firmwareArtifactsModified === false
    && summary?.hashProtectedFiles?.unchanged === true
    && summary?.protectedFiles?.unchanged === true
    && summary?.hashRestoration?.completed === true
    && summary?.restoration?.completed === true;
  const transportChainComplete = summary?.hashGate?.transportBlockedUntilHashRejection === true
    && summary?.hashGate?.transportRevalidated === true
    && summary?.hashGate?.ordinaryUploadSucceeded === true
    && summary?.gate?.transportBlockedUntilRejection === true
    && summary?.gate?.transportRevalidated === true
    && summary?.gate?.ordinaryUploadSucceeded === true;
  if (!diskChainComplete || !transportChainComplete) {
    throw new Error('Visible operation evidence is not backed by the complete manifest/SHA/disk/transport chain.');
  }
  return {
    source: 'visible-ui-log-disk-and-transport-chain',
    operationCount: records.length,
    compileOperationCount: compileRecords.length,
    uploadOperationCount: uploadRecords.length,
    activeReadyTransitionsComplete: true,
    workspaceIdentityUnchanged: true,
    allTargetFqbnsExact: true,
    exactPortSelectedThroughout: true,
    diskManifestShaChainComplete: true,
    transportChainComplete: true,
    operations: records.slice(-12).map((item, index) => ({
      sequence: index + 1,
      kind: item.kind,
      sourceScope: item.sourceScope,
      startedAt: item.startedAt,
      endedAt: item.endedAt,
      readyBefore: item.readyBefore,
      activeObserved: item.activeObserved,
      readyAfter: item.readyAfter,
      overlayAbsentAfter: item.overlayAbsentAfter,
      targetLogCount: item.targetLogCount,
      allTargetFqbnsExact: item.allTargetFqbnsExact,
      selectedPortBefore: item.selectedPortBefore,
      selectedPortAfter: item.selectedPortAfter,
      sourceFingerprintBefore: item.identityBefore.codeFingerprint,
      sourceFingerprintAfter: item.identityAfter.codeFingerprint,
      frozenSourceFingerprint: item.frozenWorkspaceFingerprint,
      buildRunId: item.buildRunId,
    })),
  };
}

const operationEvidenceRecords = [];
const observedBuildRunIds = new Set();

function isUuid(value) {
  return /^[0-9a-f]{8}-[0-9a-f]{4}-[1-5][0-9a-f]{3}-[89ab][0-9a-f]{3}-[0-9a-f]{12}$/i.test(String(value || ''));
}

function validateBuildEvidence(evidence, kind, identity, expectedFqbn, expectedPort) {
  if (!evidence || evidence.schema !== '1' || evidence.kind !== kind
    || !isUuid(evidence.runId)
    || canonicalizeFqbn(evidence.fqbn) !== expectedFqbn
    || evidence.port !== expectedPort
    || evidence.workspaceFingerprint !== identity.codeFingerprint) {
    throw new Error(`Visible ${kind} build evidence did not freeze the exact source/FQBN/port identity.`);
  }
  if (observedBuildRunIds.has(evidence.runId)) {
    throw new Error(`Visible ${kind} build evidence reused a foreground run UUID.`);
  }
  observedBuildRunIds.add(evidence.runId);
  return evidence;
}

async function captureCompileLog() {
  const opened = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.replace(/\\s+/g, '') === '\u8f93\u51fa\u65e5\u5fd7');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) throw new Error('Output log tab could not be opened.');
  await wait(150);
  return evaluate(`document.querySelector('.ck-console-panel')?.innerText || ''`);
}

async function runOperation(kind, sourceScope = 'baseline') {
  const isUpload = kind === 'upload';
  const expectedFqbn = canonicalizeFqbn(process.env.CK_MANIFEST_GATE_FQBN);
  const expectedPort = process.env.CK_MANIFEST_GATE_PORT;
  const identityBefore = await readStableWorkspaceIdentity(expectedFqbn, expectedPort);
  const readyBefore = await evaluate(`(() => {
    const button = ${isUpload
      ? `document.querySelector('[data-ck-role="build-normal-upload-action"]')`
      : `document.querySelector('[data-ck-role="build-compile-action"]')`};
    return Boolean(button && !button.disabled && button.getClientRects().length > 0
      && !document.querySelector('[data-ck-role="compile-progress-overlay"]'));
  })()`);
  if (!readyBefore) throw new Error(`${kind} UI was not idle and ready before the operation.`);
  const startedAt = Date.now();
  let frozenBuildEvidence = null;
  const trackerKey = `__ckManifestGate_${kind}_${startedAt}`;
  const clicked = await evaluate(`(() => {
    const button = ${isUpload
      ? `document.querySelector('[data-ck-role="build-normal-upload-action"]')`
      : `document.querySelector('[data-ck-role="build-compile-action"]')`};
    if (!button || button.disabled || button.getClientRects().length === 0) return false;
    const tracker = { seenActive: false, observer: null };
    const sample = () => {
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const compile = document.querySelector('[data-ck-role="build-compile-action"]');
      if (overlay || (compile && compile.disabled)) tracker.seenActive = true;
    };
    tracker.observer = new MutationObserver(sample);
    tracker.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    window[${JSON.stringify(trackerKey)}] = tracker;
    button.click();
    sample();
    return true;
  })()`);
  try {
    if (!clicked) throw new Error(`${kind} button is unavailable.`);
    await waitFor(`Boolean(window[${JSON.stringify(trackerKey)}]?.seenActive)`, 10000, `${kind} start`);
    const timeoutMs = Number(process.env.CK_MANIFEST_GATE_TIMEOUT_MS || 1200000);
    let nextHeartbeat = 15000;
    while (Date.now() - startedAt < timeoutMs) {
      const state = await evaluate(`(() => {
        const tracker = window[${JSON.stringify(trackerKey)}];
        const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
        const compile = document.querySelector('[data-ck-role="build-compile-action"]');
        const active = Boolean(overlay) || Boolean(compile && compile.disabled);
        if (active && tracker) tracker.seenActive = true;
        return {
          seenActive: Boolean(tracker?.seenActive),
          active,
          ready: Boolean(compile && !compile.disabled),
          stage: overlay?.dataset.ckProgressStage || '',
          message: document.querySelector('[data-ck-role="compile-progress-message"]')?.textContent?.trim() || '',
          percentage: document.querySelector('[data-ck-role="compile-progress-percentage"]')?.textContent?.trim() || '',
          buildEvidence: overlay ? {
            schema: overlay.getAttribute('data-ck-build-evidence-schema') || '',
            runId: overlay.getAttribute('data-ck-build-run-id') || '',
            kind: overlay.getAttribute('data-ck-build-kind') || '',
            fqbn: overlay.getAttribute('data-ck-build-fqbn') || '',
            port: overlay.getAttribute('data-ck-build-port') || '',
            workspaceFingerprint: overlay.getAttribute('data-ck-build-workspace-fingerprint') || '',
          } : null,
        };
      })()`);
      if (state.buildEvidence && !frozenBuildEvidence) {
        frozenBuildEvidence = validateBuildEvidence(
          state.buildEvidence,
          kind,
          identityBefore,
          expectedFqbn,
          expectedPort,
        );
      } else if (state.buildEvidence && frozenBuildEvidence
        && state.buildEvidence.runId !== frozenBuildEvidence.runId) {
        throw new Error(`${kind} progress overlay changed foreground run UUID mid-operation.`);
      }
      const elapsed = Date.now() - startedAt;
      if (elapsed >= nextHeartbeat) {
        console.log(`[manifest-gate] ${kind} ${Math.round(elapsed / 1000)}s stage=${state.stage || '-'} progress=${state.percentage || '-'} ${state.message || ''}`);
        nextHeartbeat += 15000;
      }
      if (state.seenActive && !state.active && state.ready) {
        await wait(350);
        const log = await captureCompileLog();
        const success = isUpload
          ? /\u666e\u901a(?:\u56fa\u4ef6)?\u4e0a\u4f20\u6210\u529f/.test(log)
          : /\u7f16\u8bd1\u6210\u529f/.test(log);
        if (!success) {
          throw new Error(`${kind} ended without a success marker: ${redactAndBound(log, 2500)}`);
        }
        if (!frozenBuildEvidence) {
          throw new Error(`${kind} completed without read-only foreground build evidence.`);
        }
        const identityAfter = await readStableWorkspaceIdentity(expectedFqbn, expectedPort);
        assertWorkspaceIdentityUnchanged(identityBefore, identityAfter, `${kind}-visible-operation`);
        const logIdentity = analyzeOperationLogIdentity(log, expectedFqbn, kind);
        const operationEvidence = {
          kind,
          sourceScope,
          startedAt,
          endedAt: Date.now(),
          readyBefore: true,
          activeObserved: Boolean(state.seenActive),
          readyAfter: Boolean(state.ready),
          overlayAbsentAfter: !state.active,
          selectedPortBefore: identityBefore.port,
          selectedPortAfter: identityAfter.port,
          identityBefore,
          identityAfter,
          buildRunId: frozenBuildEvidence.runId,
          buildEvidenceSchema: Number(frozenBuildEvidence.schema),
          frozenWorkspaceFingerprint: frozenBuildEvidence.workspaceFingerprint,
          ...logIdentity,
        };
        operationEvidenceRecords.push(operationEvidence);
        return { kind, startedAt, endedAt: operationEvidence.endedAt, log, operationEvidence };
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

function parseBuildDirectory(log) {
  const matches = [...String(log || '').matchAll(/^\s*\[INFO\]\s+Build Directory:\s*([^\r\n]+)$/gim)];
  return matches.at(-1)?.[1]?.trim() || '';
}

function assertQuickFastBuildPath(rawBuildPath) {
  if (!rawBuildPath) throw new Error('Compile log did not report a build directory.');
  const buildPath = fs.realpathSync.native(path.resolve(rawBuildPath));
  const cacheRoot = fs.realpathSync.native(path.join(os.tmpdir(), 'CK_Builds'));
  const relative = path.relative(cacheRoot, buildPath);
  if (!relative || relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Refusing build path outside CK_Builds: ${buildPath}`);
  }
  if (path.basename(buildPath).toLowerCase() !== 'build'
    || !path.basename(path.dirname(buildPath)).toLowerCase().endsWith('_qfast2')) {
    throw new Error(`Refusing non-QuickFast build directory: ${buildPath}`);
  }
  return buildPath;
}

function sha256Bytes(bytes) {
  return crypto.createHash('sha256').update(bytes).digest('hex');
}

function sha256File(filePath) {
  return sha256Bytes(fs.readFileSync(filePath));
}

function requireRegularFile(filePath, label) {
  const stat = fs.lstatSync(filePath);
  if (!stat.isFile() || stat.isSymbolicLink()) {
    throw new Error(`${label} is not a regular file: ${filePath}`);
  }
  return stat;
}

function resolveManifestArtifact(buildPath, storedPath) {
  const value = String(storedPath || '').trim();
  if (!value) throw new Error('Manifest contains an empty artifact path.');
  if (path.isAbsolute(value)) return path.normalize(value);
  const resolved = path.resolve(buildPath, value);
  const relative = path.relative(buildPath, resolved);
  if (relative.startsWith('..') || path.isAbsolute(relative)) {
    throw new Error(`Relative manifest artifact escapes the build directory: ${value}`);
  }
  return resolved;
}

function readJsonFile(filePath, label) {
  requireRegularFile(filePath, label);
  try {
    return JSON.parse(fs.readFileSync(filePath, 'utf8'));
  } catch (error) {
    throw new Error(`${label} is not valid JSON: ${error.message}`);
  }
}

function validateManifestAgainstFiles(buildPath, expectedFqbn) {
  const canonicalExpected = canonicalizeFqbn(expectedFqbn);
  const manifestPath = path.join(buildPath, '.ck-upload-artifacts.json');
  const manifest = readJsonFile(manifestPath, 'Upload artifact manifest');
  if (manifest.schemaVersion !== 1) throw new Error(`Unsupported manifest schema: ${manifest.schemaVersion}`);
  if (manifest.canonicalFqbn !== canonicalExpected) {
    throw new Error(`Manifest FQBN is ${manifest.canonicalFqbn}, expected ${canonicalExpected}.`);
  }
  if (!/^[0-9a-f]{64}$/i.test(String(manifest.buildSignature || ''))) {
    throw new Error('Manifest build signature is missing or malformed.');
  }
  const options = readJsonFile(path.join(buildPath, 'build.options.json'), 'Arduino build options');
  if (canonicalizeFqbn(options.fqbn) !== canonicalExpected) {
    throw new Error(`build.options.json FQBN is ${options.fqbn}, expected ${canonicalExpected}.`);
  }
  if (manifest.partitionDefinition?.path !== 'partitions.csv'
    || !/^[0-9a-f]{64}$/i.test(String(manifest.partitionDefinition?.sha256 || ''))) {
    throw new Error('Manifest partition definition is missing or malformed.');
  }
  const partitionPath = path.join(buildPath, 'partitions.csv');
  requireRegularFile(partitionPath, 'Selected partition definition');
  if (sha256File(partitionPath) !== manifest.partitionDefinition.sha256) {
    throw new Error('Manifest partition definition hash does not match partitions.csv.');
  }
  const requiredRoles = new Set([
    'esp32-application',
    'esp32-boot-app0',
    'esp32-bootloader',
    'esp32-flash-arguments',
    'esp32-partition-table',
  ]);
  if (!Array.isArray(manifest.artifacts) || manifest.artifacts.length !== requiredRoles.size) {
    throw new Error('Manifest must contain exactly the five ESP32 upload artifact roles.');
  }
  const protectedFiles = new Map();
  const addProtected = (label, filePath) => {
    const resolved = fs.realpathSync.native(filePath);
    const stat = requireRegularFile(resolved, label);
    protectedFiles.set(resolved.toLowerCase(), {
      label,
      filePath: resolved,
      size: stat.size,
      sha256: sha256File(resolved),
    });
  };
  addProtected('build-options', path.join(buildPath, 'build.options.json'));
  addProtected('partition-definition', partitionPath);
  for (const artifact of manifest.artifacts) {
    if (!requiredRoles.delete(artifact.role)) throw new Error(`Duplicate or unknown artifact role: ${artifact.role}`);
    if (!Number.isSafeInteger(artifact.size) || artifact.size <= 0
      || !/^[0-9a-f]{64}$/i.test(String(artifact.sha256 || ''))) {
      throw new Error(`Artifact metadata is malformed for ${artifact.role}.`);
    }
    const artifactPath = resolveManifestArtifact(buildPath, artifact.path);
    const stat = requireRegularFile(artifactPath, artifact.role);
    const actualHash = sha256File(artifactPath);
    if (stat.size !== artifact.size || actualHash !== artifact.sha256) {
      throw new Error(`Artifact bytes do not match manifest for ${artifact.role}.`);
    }
    addProtected(artifact.role, artifactPath);
  }
  if (requiredRoles.size) throw new Error(`Manifest is missing roles: ${[...requiredRoles].join(', ')}`);
  return {
    manifestPath,
    manifest,
    manifestBytes: fs.readFileSync(manifestPath),
    manifestHash: sha256File(manifestPath),
    protectedFiles: [...protectedFiles.values()],
  };
}

function compareProtectedSnapshots(before, after) {
  const normalize = (items) => new Map(items.map((item) => [item.label, `${item.size}:${item.sha256}`]));
  const left = normalize(before);
  const right = normalize(after);
  if (left.size !== right.size) throw new Error('Protected upload file set changed during the gate test.');
  for (const [label, identity] of left) {
    if (right.get(label) !== identity) throw new Error(`Protected upload file changed during the gate test: ${label}`);
  }
  return true;
}

function assertOnlyCanonicalFqbnChanged(original, mutated, wrongFqbn) {
  if (mutated.canonicalFqbn !== wrongFqbn) throw new Error('Tampered manifest did not receive the intended FQBN.');
  const left = { ...original, canonicalFqbn: null };
  const right = { ...mutated, canonicalFqbn: null };
  if (JSON.stringify(left) !== JSON.stringify(right)) {
    throw new Error('Refusing manifest mutation: a field other than canonicalFqbn changed.');
  }
}

function installTamperedManifest(verified, mutated) {
  const token = `${Date.now()}-${crypto.randomUUID()}`;
  const backupRoot = path.join(os.tmpdir(), 'CK_ManifestGateBackups');
  fs.mkdirSync(backupRoot, { recursive: true });
  const backupPath = path.join(backupRoot, `${token}.json`);
  const holdPath = `${verified.manifestPath}.gate-original-${token}`;
  const temporaryPath = `${verified.manifestPath}.gate-tmp-${token}`;
  const tamperedBytes = Buffer.from(`${JSON.stringify(mutated, null, 2)}\n`, 'utf8');

  fs.writeFileSync(backupPath, verified.manifestBytes, { flag: 'wx' });
  if (sha256File(backupPath) !== verified.manifestHash) throw new Error('External manifest backup verification failed.');
  fs.writeFileSync(temporaryPath, tamperedBytes, { flag: 'wx' });
  try {
    fs.renameSync(verified.manifestPath, holdPath);
    fs.renameSync(temporaryPath, verified.manifestPath);
    requireRegularFile(verified.manifestPath, 'Tampered upload artifact manifest');
    if (sha256File(verified.manifestPath) !== sha256Bytes(tamperedBytes)) {
      throw new Error('Tampered manifest installation verification failed.');
    }
    return {
      buildPath: path.dirname(verified.manifestPath),
      manifestPath: verified.manifestPath,
      backupPath,
      holdPath,
      temporaryPath,
      originalHash: verified.manifestHash,
      tamperedHash: sha256Bytes(tamperedBytes),
    };
  } catch (error) {
    // installTamperedManifest has not returned yet, so the caller cannot own the
    // recovery state. Restore locally for every failure after the first rename.
    if (fs.existsSync(holdPath)) {
      if (fs.existsSync(verified.manifestPath)) fs.rmSync(verified.manifestPath, { force: true });
      fs.renameSync(holdPath, verified.manifestPath);
    }
    if (fs.existsSync(temporaryPath)) fs.rmSync(temporaryPath, { force: true });
    if (fs.existsSync(backupPath)) fs.rmSync(backupPath, { force: true });
    throw error;
  }
}

function stageTamperedManifest(verified, wrongFqbn) {
  const original = verified.manifest;
  const mutated = JSON.parse(JSON.stringify(original));
  mutated.canonicalFqbn = wrongFqbn;
  assertOnlyCanonicalFqbnChanged(original, mutated, wrongFqbn);
  return installTamperedManifest(verified, mutated);
}

function stageHashTamperedManifest(verified) {
  const original = verified.manifest;
  const mutated = JSON.parse(JSON.stringify(original));
  const target = mutated.artifacts?.find((artifact) => artifact.role === 'esp32-application');
  const originalTarget = original.artifacts?.find((artifact) => artifact.role === 'esp32-application');
  if (!target || !originalTarget || !/^[0-9a-f]{64}$/i.test(String(originalTarget.sha256 || ''))) {
    throw new Error('Cannot stage artifact-hash mismatch without a valid ESP32 application entry.');
  }
  const replacement = String(originalTarget.sha256).toLowerCase() === '0'.repeat(64)
    ? '1'.repeat(64)
    : '0'.repeat(64);
  target.sha256 = replacement;
  const originalWithoutHash = JSON.parse(JSON.stringify(original));
  const mutatedWithoutHash = JSON.parse(JSON.stringify(mutated));
  originalWithoutHash.artifacts.find((artifact) => artifact.role === 'esp32-application').sha256 = null;
  mutatedWithoutHash.artifacts.find((artifact) => artifact.role === 'esp32-application').sha256 = null;
  if (JSON.stringify(originalWithoutHash) !== JSON.stringify(mutatedWithoutHash)) {
    throw new Error('Refusing manifest mutation: a field other than the ESP32 application SHA-256 changed.');
  }
  return {
    ...installTamperedManifest(verified, mutated),
    artifactRole: 'esp32-application',
    originalArtifactSha256: String(originalTarget.sha256).toLowerCase(),
    tamperedArtifactSha256: replacement,
  };
}

function restoreOrPreserveManifest(state, expectedFqbn) {
  let preservedRebuilt = false;
  let currentValid = false;
  if (fs.existsSync(state.manifestPath)) {
    try {
      validateManifestAgainstFiles(state.buildPath, expectedFqbn);
      currentValid = sha256File(state.manifestPath) !== state.tamperedHash;
      preservedRebuilt = currentValid;
    } catch {
      currentValid = false;
    }
  }

  if (!currentValid) {
    if (fs.existsSync(state.manifestPath)) fs.rmSync(state.manifestPath, { force: true });
    if (fs.existsSync(state.holdPath)) {
      fs.renameSync(state.holdPath, state.manifestPath);
    } else {
      const restoreTemporary = `${state.manifestPath}.gate-restore-${crypto.randomUUID()}`;
      fs.copyFileSync(state.backupPath, restoreTemporary, fs.constants.COPYFILE_EXCL);
      fs.renameSync(restoreTemporary, state.manifestPath);
    }
  }

  if (fs.existsSync(state.holdPath)) fs.rmSync(state.holdPath, { force: true });
  if (fs.existsSync(state.temporaryPath)) fs.rmSync(state.temporaryPath, { force: true });
  const verified = validateManifestAgainstFiles(state.buildPath, expectedFqbn);
  if (!preservedRebuilt && verified.manifestHash !== state.originalHash) {
    throw new Error('Original manifest hash was not restored.');
  }
  if (fs.existsSync(state.backupPath)) fs.rmSync(state.backupPath, { force: true });
  return {
    action: preservedRebuilt ? 'preserved-correct-rebuilt-manifest' : 'restored-original-manifest',
    valid: true,
    originalHashRestored: !preservedRebuilt,
    backupRemoved: !fs.existsSync(state.backupPath),
    residueRemoved: !fs.existsSync(state.holdPath) && !fs.existsSync(state.temporaryPath),
  };
}

function discoverSharedFastManifests(expectedFqbn) {
  const root = path.join(os.tmpdir(), 'CK_Builds');
  if (!fs.existsSync(root)) return [];
  const expected = canonicalizeFqbn(expectedFqbn);
  const found = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !entry.name.toLowerCase().endsWith('_sfast2')) continue;
    const buildPath = path.join(root, entry.name, 'build');
    const optionsPath = path.join(buildPath, 'build.options.json');
    const manifestPath = path.join(buildPath, '.ck-upload-artifacts.json');
    if (!fs.existsSync(optionsPath) || !fs.existsSync(manifestPath)) continue;
    try {
      const options = readJsonFile(optionsPath, 'SharedFast build options');
      if (canonicalizeFqbn(options.fqbn) !== expected) continue;
      const verified = validateManifestAgainstFiles(buildPath, expected);
      found.push({
        buildPath,
        cacheDirectoryName: entry.name,
        manifestHash: verified.manifestHash,
        modifiedMs: fs.statSync(manifestPath).mtimeMs,
      });
    } catch {
      // An invalid cache is not evidence of a sealed recovery manifest.
    }
  }
  return found;
}

function findFreshSharedFastManifest(before, after, uploadStartedAt) {
  const previous = new Map(before.map((item) => [item.buildPath.toLowerCase(), item]));
  const candidates = after.filter((item) => {
    const old = previous.get(item.buildPath.toLowerCase());
    const rewritten = !old || item.modifiedMs > old.modifiedMs + 1 || item.manifestHash !== old.manifestHash;
    return rewritten && item.modifiedMs >= uploadStartedAt - 2000;
  }).sort((left, right) => right.modifiedMs - left.modifiedMs);
  if (!candidates.length) {
    throw new Error('No freshly sealed SharedFast manifest was found for the exact expected FQBN.');
  }
  return candidates[0];
}

function escapeRegex(value) {
  return String(value).replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
}

const fullMacPatterns = [
  /(^|[^0-9a-f])((?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2})(?![0-9a-f])/gi,
  /(^|[^0-9a-f])([0-9a-f]{4}\.[0-9a-f]{4}\.[0-9a-f]{4})(?![0-9a-f])/gi,
  /\b(?:base\s+)?mac(?:\s+address)?\s*[:=]\s*[0-9a-f]{12}\b/gi,
];

function containsFullMac(text) {
  return fullMacPatterns.some((pattern) => {
    pattern.lastIndex = 0;
    return pattern.test(String(text || ''));
  });
}

function redactMacs(text) {
  let safe = String(text || '');
  safe = safe.replace(fullMacPatterns[0], '$1[REDACTED_MAC]');
  safe = safe.replace(fullMacPatterns[1], '$1[REDACTED_MAC]');
  safe = safe.replace(fullMacPatterns[2], 'MAC: [REDACTED_MAC]');
  return safe;
}

function redactAbsolutePaths(text) {
  return String(text || '').replace(
    /(?:file:\/\/\/)?[a-z]:[\\/][^\r\n]*/gi,
    '[REDACTED_ABSOLUTE_PATH]',
  );
}

function redactAndBound(text, limit = 2000) {
  const safe = redactAbsolutePaths(redactMacs(text)).replace(/\s+$/g, '');
  return safe.length > limit ? `${safe.slice(0, limit)}\n...[truncated]` : safe;
}

function analyzeRecoveryUploadLog(log, expectedFqbn, warningIndex, warningPattern, rejectionLabel) {
  const text = String(log || '');
  // Upload logs use the cached size-summary marker for the QuickFast exact
  // path; the standalone preflight compile above has already required the
  // stronger `Cached build (Exact Match)` + validated-manifest markers.
  const exactIndex = text.search(/Cached build \(Exact Match\)|Reusing cached memory\/size summary:/i);
  if (exactIndex < 0 || warningIndex <= exactIndex) {
    throw new Error(`QuickFast did not reject the ${rejectionLabel} manifest after an Exact Match cache hit.`);
  }
  const transportPattern = /Connecting\.\.\.|Chip is ESP32|Writing at\s+0x|Hash of data verified|Upload transport phase:/gi;
  const firstTransport = transportPattern.exec(text);
  if (firstTransport && firstTransport.index < warningIndex) {
    throw new Error('Transport began before the stale QuickFast manifest was rejected.');
  }

  const recoveryText = text.slice(warningIndex);
  if (/Cached build \(Exact Match\)/i.test(recoveryText)) {
    throw new Error('SharedFast recovery reused an Exact Match instead of rebuilding and sealing artifacts.');
  }
  const sharedCompileIndex = text.indexOf('Compile Profile: shared-fast', warningIndex);
  const freshBuildRelative = recoveryText.search(/Full Build:|Sketch file updated \(content changed\)|Fast Relink path: sketch-only compile \+ direct link/i);
  const sharedVerifiedIndex = text.indexOf('Upload Profile: shared-fast (artifact manifest verified)', warningIndex);
  const revalidatedIndex = text.indexOf('Upload artifact manifest revalidated before transport.', warningIndex);
  if (sharedCompileIndex < 0 || freshBuildRelative < 0 || sharedVerifiedIndex <= sharedCompileIndex) {
    throw new Error('SharedFast did not perform a fresh correct-FQBN build and verify its artifact manifest.');
  }
  if (revalidatedIndex <= sharedVerifiedIndex) {
    throw new Error('The sealed SharedFast manifest was not revalidated immediately before transport.');
  }
  transportPattern.lastIndex = 0;
  const observedTransport = [...text.matchAll(transportPattern)].find((match) => match.index >= warningIndex);
  if (!observedTransport || observedTransport.index <= revalidatedIndex) {
    throw new Error('No transport evidence appeared after manifest revalidation.');
  }
  const transportTimingIndex = text.indexOf('Upload transport phase:', observedTransport.index);
  const successMatch = /\u666e\u901a(?:\u56fa\u4ef6)?\u4e0a\u4f20\u6210\u529f/.exec(text);
  if (transportTimingIndex < 0 || !successMatch || successMatch.index <= transportTimingIndex) {
    throw new Error('Ordinary upload success was not reported after the transport phase.');
  }
  if (/Upload Profile:\s*quick-fast|Upload Profile:\s*release|Falling back to release/i.test(text)) {
    throw new Error('Upload did not recover specifically through SharedFast.');
  }
  const targets = [...text.matchAll(/^\s*\[INFO\]\s+Target Board:\s*([^\r\n]+)$/gim)]
    .map((match) => canonicalizeFqbn(match[1].trim()));
  if (!targets.length || targets.some((target) => target !== expectedFqbn)) {
    throw new Error(`One or more compile tiers used a target other than ${expectedFqbn}.`);
  }
  const gateWarningPresent = text.split(/\r?\n/).some((line) => {
    if (!/Quick-fast upload artifact gate rejected this cache:/i.test(line)) return false;
    warningPattern.lastIndex = 0;
    return warningPattern.test(line);
  });
  if (!gateWarningPresent) {
    throw new Error('The expected QuickFast artifact-gate warning was not present.');
  }

  const evidence = text.split(/\r?\n/)
    .filter((line) => /Target Board:|Compile Profile:|Cached build \(Exact Match\)|Quick-fast upload artifact gate rejected|Full Build:|Sketch file updated|Fast Relink path:|Upload Profile:|manifest revalidated before transport|Upload transport phase:|\u666e\u901a(?:\u56fa\u4ef6)?\u4e0a\u4f20\u6210\u529f/i.test(line))
    .map((line) => redactAndBound(line, 800))
    .slice(-60);
  if (containsFullMac(JSON.stringify(evidence))) throw new Error('Privacy failure: evidence contains a complete MAC address.');
  return {
    exactMatchBeforeRejection: true,
    transportBlockedUntilRejection: true,
    sharedFastFreshBuild: true,
    sharedFastManifestVerified: true,
    transportRevalidated: true,
    transportObservedAfterRevalidation: true,
    ordinaryUploadSucceeded: true,
    allTargetFqbnsExact: true,
    evidence,
  };
}

function analyzeUploadLog(log, expectedFqbn, wrongFqbn) {
  const text = String(log || '');
  const warningNeedle = `Upload blocked: artifact manifest FQBN mismatch (built for '${wrongFqbn}', selected '${expectedFqbn}')`;
  const warningIndex = text.indexOf(warningNeedle);
  if (warningIndex < 0) throw new Error('The expected FQBN manifest mismatch was not reported.');
  const common = analyzeRecoveryUploadLog(
    text,
    expectedFqbn,
    warningIndex,
    new RegExp(escapeRegex(warningNeedle), 'i'),
    'wrong-FQBN',
  );
  return { ...common, fqbnMismatchRejected: true };
}

function analyzeHashUploadLog(log, expectedFqbn, staged) {
  const text = String(log || '');
  const warningPattern = new RegExp(
    `Upload blocked: artifact SHA-256 mismatch for [^\\r\\n]+ \\(${escapeRegex(staged.artifactRole)}\\) `
      + `\\(manifest ${escapeRegex(staged.tamperedArtifactSha256)}, current ${escapeRegex(staged.originalArtifactSha256)}\\)`,
    'i',
  );
  const warning = warningPattern.exec(text);
  if (!warning) throw new Error('The expected artifact SHA-256 manifest mismatch was not reported.');
  const common = analyzeRecoveryUploadLog(
    text,
    expectedFqbn,
    warning.index,
    warningPattern,
    'artifact-SHA-256',
  );
  return {
    ...common,
    artifactHashMismatchRejected: true,
    transportBlockedUntilHashRejection: true,
    artifactRole: staged.artifactRole,
  };
}

async function primeQuickFast(expectedFqbn) {
  const port = process.env.CK_MANIFEST_GATE_PORT;
  const baseline = await readStableWorkspaceIdentity(expectedFqbn, port);
  if (baseline.projectDirty !== 'false') {
    throw new Error('Manifest-gate cache priming requires a clean project before reversible source edits.');
  }
  const firstCompile = await runOperation('compile');
  if (/Cached build \(Exact Match\)/i.test(firstCompile.log)
    || !/Full Build:/i.test(firstCompile.log)) {
    throw new Error('Exact-FQBN cache clear did not produce a real cold QuickFast full build.');
  }
  const manifestReady = /Upload artifact manifest:\s*(?:sealed upload-ready artifacts|validated existing exact-match manifest)/i.test(firstCompile.log);
  if (!manifestReady) {
    if (!/Upload artifact manifest deferred:[^\r\n]*(?:missing|unreadable)/i.test(firstCompile.log)) {
      throw new Error('Cold QuickFast manifest was deferred for a reason other than missing upload artifacts.');
    }
    let edit = null;
    let editError = null;
    let editedVerified = null;
    try {
      edit = await mutateDelay(1);
      if (!edit) throw new Error('No supported delay field is available for the reversible QuickFast cache-prime edit.');
      await waitForSourceIdentityState(baseline, 'changed');
      const editedCompile = await runOperation('compile', 'transient-cache-prime');
      if (!/Fast Relink path: sketch-only compile \+ direct link/i.test(editedCompile.log)
        || !/Upload artifact manifest:\s*sealed upload-ready artifacts/i.test(editedCompile.log)) {
        throw new Error('Reversible edited compile did not create a sealed QuickFast upload manifest.');
      }
      const editedBuildPath = assertQuickFastBuildPath(parseBuildDirectory(editedCompile.log));
      editedVerified = validateManifestAgainstFiles(editedBuildPath, expectedFqbn);
    } catch (error) {
      editError = error;
    } finally {
      if (edit) {
        const restored = await restoreDelay(edit).catch(() => false);
        if (!restored) throw new Error('The reversible QuickFast cache-prime edit could not be restored.');
        await waitForSourceIdentityState(baseline, 'restored');
      }
    }
    if (editError) throw editError;
    const restoredCompile = await runOperation('compile');
    if (!/Fast Relink path: sketch-only compile \+ direct link/i.test(restoredCompile.log)
      || !/Upload artifact manifest:\s*sealed upload-ready artifacts/i.test(restoredCompile.log)) {
      throw new Error('Restored source did not reseal a QuickFast upload manifest for the baseline fingerprint.');
    }
    const restoredBuildPath = assertQuickFastBuildPath(parseBuildDirectory(restoredCompile.log));
    const restoredVerified = validateManifestAgainstFiles(restoredBuildPath, expectedFqbn);
    if (!editedVerified || path.resolve(editedVerified.manifestPath) !== path.resolve(restoredVerified.manifestPath)) {
      throw new Error('Edited and restored QuickFast compiles did not reseal the same isolated cache path.');
    }
    const applicationSha = (verified) => verified.manifest.artifacts
      .find((item) => item.role === 'esp32-application')?.sha256 || '';
    if (!applicationSha(editedVerified) || applicationSha(editedVerified) === applicationSha(restoredVerified)) {
      throw new Error('Restored QuickFast application artifact did not replace the edited source artifact.');
    }
  }
  const exactCompile = await runOperation('compile');
  if (!/Cached build \(Exact Match\)/i.test(exactCompile.log)) {
    throw new Error('QuickFast preflight did not reach an Exact Match cache hit.');
  }
  if (!/Upload artifact manifest:\s*validated existing exact-match manifest/i.test(exactCompile.log)) {
    throw new Error('QuickFast preflight did not validate its existing manifest.');
  }
  const buildPath = assertQuickFastBuildPath(parseBuildDirectory(exactCompile.log));
  const verified = validateManifestAgainstFiles(buildPath, expectedFqbn);
  if (path.resolve(verified.manifestPath) !== path.resolve(path.join(buildPath, '.ck-upload-artifacts.json'))) {
    throw new Error('Exact Match manifest verification escaped the QuickFast build path.');
  }
  const sharedFastBefore = discoverSharedFastManifests(expectedFqbn);
  if (sharedFastBefore.length) {
    throw new Error('A valid SharedFast cache already exists for this exact FQBN. Clear this FQBN cache before running a fresh-rebuild gate phase.');
  }
  return { verified, sharedFastBefore };
}

function snapshotProtectedFiles(items) {
  return items.map((item) => {
    const stat = requireRegularFile(item.filePath, item.label);
    return { ...item, size: stat.size, sha256: sha256File(item.filePath) };
  });
}

function summarizeProtectedFiles(items) {
  return {
    count: items.length,
    unchanged: true,
    labels: items.map((item) => item.label).sort(),
  };
}

function summarizeRecoveryManifest(before, upload, expectedFqbn) {
  const after = discoverSharedFastManifests(expectedFqbn);
  const recovery = findFreshSharedFastManifest(before, after, upload.startedAt);
  return {
    profile: 'shared-fast',
    cacheDirectoryName: recovery.cacheDirectoryName,
    exactFqbn: true,
    freshlySealed: true,
    manifestHash: recovery.manifestHash,
  };
}

function assertBetweenPhaseCacheClear(report, expectedFqbn) {
  if (!report || canonicalizeFqbn(report.fqbn) !== expectedFqbn
    || report.reset_scope !== 'exact-full-fqbn'
    || report.force_rebuild_pending !== true
    || report.force_ccache_recache !== true
    || report.prebuilt_core_preserved !== false) {
    throw new Error(`Exact-FQBN cache clear did not provide the required reset proof: ${JSON.stringify(report)}`);
  }
  return {
    fqbn: expectedFqbn,
    resetScope: report.reset_scope,
    removedEntries: Number(report.removed_entries || 0),
    removedBytes: Number(report.removed_bytes || 0),
    forceRebuildPending: true,
    forceCcacheRecache: true,
    prebuiltCorePreserved: false,
  };
}

function writeSummary(summary) {
  const outputPath = path.resolve(process.env.CK_MANIFEST_GATE_OUTPUT);
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  let encoded = `${JSON.stringify(summary, null, 2)}\n`;
  encoded = redactMacs(encoded);
  if (containsFullMac(encoded)) throw new Error('Privacy failure: result JSON still contains a complete MAC address.');
  if (/(?:file:\/\/\/)?[a-z]:[\\/]/i.test(encoded)) {
    throw new Error('Privacy failure: result JSON contains a Windows absolute path.');
  }
  const temporaryPath = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporaryPath, encoded, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporaryPath, outputPath);
  } finally {
    try { fs.unlinkSync(temporaryPath); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
  return { outputPath, encoded };
}

function buildManifestGateOutcomeChecks(summary) {
  return [
    {
      id: 'artifact-hash-rejection-and-recovery-complete',
      passed: summary?.hashGate?.artifactHashMismatchRejected === true
        && summary?.hashGate?.transportBlockedUntilHashRejection === true
        && summary?.hashGate?.ordinaryUploadSucceeded === true,
    },
    {
      id: 'full-fqbn-rejection-and-recovery-complete',
      passed: summary?.gate?.fqbnMismatchRejected === true
        && summary?.gate?.transportBlockedUntilRejection === true
        && summary?.gate?.ordinaryUploadSucceeded === true,
    },
    {
      id: 'protected-firmware-bytes-unchanged',
      passed: summary?.hashProtectedFiles?.unchanged === true
        && summary?.protectedFiles?.unchanged === true
        && summary?.hashMutation?.firmwareArtifactsModified === false
        && summary?.mutation?.firmwareArtifactsModified === false,
    },
    {
      id: 'manifests-restored-and-residue-removed',
      passed: summary?.hashRestoration?.completed === true
        && summary?.hashRestoration?.valid === true
        && summary?.hashRestoration?.backupRemoved === true
        && summary?.hashRestoration?.residueRemoved === true
        && summary?.restoration?.completed === true
        && summary?.restoration?.valid === true,
    },
    {
      id: 'source-target-identity-unchanged',
      passed: summary?.identity?.unchanged === true
        && Boolean(summary?.identity?.before)
        && Boolean(summary?.identity?.after),
    },
    {
      id: 'visible-operation-chain-complete',
      passed: summary?.operationEvidence?.activeReadyTransitionsComplete === true
        && summary?.operationEvidence?.diskManifestShaChainComplete === true
        && summary?.operationEvidence?.transportChainComplete === true,
    },
  ];
}

async function main() {
  const expectedFqbn = canonicalizeFqbn(process.env.CK_MANIFEST_GATE_FQBN);
  const wrongFqbn = replaceFqbnOption(
    expectedFqbn,
    'PartitionScheme',
    process.env.CK_MANIFEST_GATE_WRONG_PARTITION,
  );
  if (fqbnBase(wrongFqbn) !== fqbnBase(expectedFqbn)) {
    throw new Error('Wrong-config manifest must remain on the same board.');
  }
  const expectedOptions = expectedFqbn.split(':').slice(3).join(':').split(',');
  const wrongOptions = wrongFqbn.split(':').slice(3).join(':').split(',');
  const optionDelta = expectedOptions.filter((item) => !wrongOptions.includes(item))
    .concat(wrongOptions.filter((item) => !expectedOptions.includes(item)));
  if (optionDelta.length !== 2 || !optionDelta.every((item) => item.startsWith('PartitionScheme='))) {
    throw new Error('The stale FQBN must differ only by PartitionScheme.');
  }

  let stagedHashManifest = null;
  let stagedFqbnManifest = null;
  let hashProtectedBefore = null;
  let fqbnProtectedBefore = null;
  let summary = {
    schemaId: 'ck.native-upload-manifest-gate',
    schemaVersion: 2,
    capturedAt: new Date().toISOString(),
    status: 'running',
    checks: [],
    failures: [],
    project: null,
    fqbn: expectedFqbn,
    wrongManifestFqbn: wrongFqbn,
    port: process.env.CK_MANIFEST_GATE_PORT,
    hashMutation: {
      field: 'artifacts[esp32-application].sha256',
      artifactRole: 'esp32-application',
      onlyManifestModified: false,
      firmwareArtifactsModified: null,
    },
    hashGate: null,
    hashRecoveryManifest: null,
    hashProtectedFiles: null,
    hashRestoration: { requested: false, completed: false },
    initialCacheClear: null,
    betweenPhaseCacheClear: null,
    mutation: {
      field: 'canonicalFqbn',
      onlyManifestModified: false,
      firmwareArtifactsModified: null,
    },
    gate: null,
    recoveryManifest: null,
    protectedFiles: null,
    restoration: { requested: false, completed: false },
    identity: {
      before: null,
      checkpoints: [],
      after: null,
      unchanged: false,
    },
    operationEvidence: null,
    privacy: {
      completeMacRecorded: false,
      windowsAbsolutePathRecorded: false,
      sourceCodeRecorded: false,
      rawWorkspaceRecorded: false,
    },
  };
  let primaryError = null;
  try {
    summary.project = await ensureWorkspace();
    const activeFqbn = await waitForExactBoard();
    const activePort = await selectAndVerifyPort();
    if (activeFqbn !== expectedFqbn || activePort !== process.env.CK_MANIFEST_GATE_PORT) {
      throw new Error('Project/FQBN/port preflight changed unexpectedly.');
    }
    summary.identity.before = await readStableWorkspaceIdentity(expectedFqbn, activePort);
    if (summary.identity.before.project !== summary.project) {
      throw new Error('Workspace project identity changed before the first cache-clear/build phase.');
    }
    const initialCacheClear = await invoke('clear_board_compile_cache', { fqbn: expectedFqbn });
    summary.initialCacheClear = assertBetweenPhaseCacheClear(initialCacheClear, expectedFqbn);
    await wait(250);
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);

    const hashPrime = await primeQuickFast(expectedFqbn);
    hashProtectedBefore = hashPrime.verified.protectedFiles;
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);

    stagedHashManifest = stageHashTamperedManifest(hashPrime.verified);
    summary.hashRestoration.requested = true;
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);
    const hashUpload = await runOperation('upload');
    summary.hashGate = analyzeHashUploadLog(hashUpload.log, expectedFqbn, stagedHashManifest);
    summary.hashRecoveryManifest = summarizeRecoveryManifest(
      hashPrime.sharedFastBefore,
      hashUpload,
      expectedFqbn,
    );
    const hashProtectedAfter = snapshotProtectedFiles(hashProtectedBefore);
    compareProtectedSnapshots(hashProtectedBefore, hashProtectedAfter);
    summary.hashProtectedFiles = summarizeProtectedFiles(hashProtectedBefore);
    summary.hashMutation.onlyManifestModified = true;
    summary.hashMutation.firmwareArtifactsModified = false;
    summary.hashRestoration = {
      requested: true,
      completed: true,
      ...restoreOrPreserveManifest(stagedHashManifest, expectedFqbn),
    };
    const restoredHashPhase = validateManifestAgainstFiles(stagedHashManifest.buildPath, expectedFqbn);
    compareProtectedSnapshots(hashProtectedBefore, restoredHashPhase.protectedFiles);
    stagedHashManifest = null;
    const afterHashIdentity = await readStableWorkspaceIdentity(expectedFqbn, activePort);
    assertWorkspaceIdentityUnchanged(summary.identity.before, afterHashIdentity, 'after-hash-restoration');
    summary.identity.checkpoints.push({ phase: 'after-hash-restoration', ...afterHashIdentity });

    const cacheClear = await invoke('clear_board_compile_cache', { fqbn: expectedFqbn });
    summary.betweenPhaseCacheClear = assertBetweenPhaseCacheClear(cacheClear, expectedFqbn);
    await wait(250);
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);

    const fqbnPrime = await primeQuickFast(expectedFqbn);
    fqbnProtectedBefore = fqbnPrime.verified.protectedFiles;
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);

    stagedFqbnManifest = stageTamperedManifest(fqbnPrime.verified, wrongFqbn);
    summary.restoration.requested = true;
    await assertUiTargetUnchanged(summary.project, expectedFqbn, activePort);
    const upload = await runOperation('upload');
    summary.gate = analyzeUploadLog(upload.log, expectedFqbn, wrongFqbn);
    summary.recoveryManifest = summarizeRecoveryManifest(
      fqbnPrime.sharedFastBefore,
      upload,
      expectedFqbn,
    );
    // The qfast manifest is intentionally stale here. Snapshot the protected
    // bytes from their original paths without trusting that stale manifest.
    const protectedAfterRaw = snapshotProtectedFiles(fqbnProtectedBefore);
    compareProtectedSnapshots(fqbnProtectedBefore, protectedAfterRaw);
    summary.protectedFiles = summarizeProtectedFiles(fqbnProtectedBefore);
    summary.mutation.onlyManifestModified = true;
    summary.mutation.firmwareArtifactsModified = false;
    const afterFqbnIdentity = await readStableWorkspaceIdentity(expectedFqbn, activePort);
    assertWorkspaceIdentityUnchanged(summary.identity.before, afterFqbnIdentity, 'after-fqbn-phase');
    summary.identity.checkpoints.push({ phase: 'after-fqbn-phase', ...afterFqbnIdentity });
    summary.status = 'passed';
  } catch (error) {
    primaryError = error;
    summary.status = 'failed';
    summary.error = redactAndBound(error?.stack || String(error), 2500);
  } finally {
    if (stagedHashManifest) {
      try {
        summary.hashRestoration = {
          requested: true,
          completed: true,
          ...restoreOrPreserveManifest(stagedHashManifest, expectedFqbn),
        };
        const finalHashVerified = validateManifestAgainstFiles(stagedHashManifest.buildPath, expectedFqbn);
        if (hashProtectedBefore) {
          compareProtectedSnapshots(hashProtectedBefore, finalHashVerified.protectedFiles);
          summary.hashProtectedFiles = summarizeProtectedFiles(hashProtectedBefore);
          summary.hashMutation.onlyManifestModified = true;
          summary.hashMutation.firmwareArtifactsModified = false;
        }
      } catch (restoreError) {
        summary.status = 'failed';
        summary.hashRestoration = {
          requested: true,
          completed: false,
          error: redactAndBound(restoreError?.stack || String(restoreError), 1800),
          externalBackupRetained: Boolean(stagedHashManifest?.backupPath && fs.existsSync(stagedHashManifest.backupPath)),
        };
        if (!primaryError) primaryError = restoreError;
      }
    }
    if (stagedFqbnManifest) {
      try {
        summary.restoration = {
          requested: true,
          completed: true,
          ...restoreOrPreserveManifest(stagedFqbnManifest, expectedFqbn),
        };
        const finalVerified = validateManifestAgainstFiles(stagedFqbnManifest.buildPath, expectedFqbn);
        if (fqbnProtectedBefore) {
          compareProtectedSnapshots(fqbnProtectedBefore, finalVerified.protectedFiles);
          summary.protectedFiles = summarizeProtectedFiles(fqbnProtectedBefore);
          summary.mutation.onlyManifestModified = true;
          summary.mutation.firmwareArtifactsModified = false;
        }
      } catch (restoreError) {
        summary.status = 'failed';
        summary.restoration = {
          requested: true,
          completed: false,
          error: redactAndBound(restoreError?.stack || String(restoreError), 1800),
          externalBackupRetained: Boolean(stagedFqbnManifest?.backupPath && fs.existsSync(stagedFqbnManifest.backupPath)),
        };
        if (!primaryError) primaryError = restoreError;
      }
    }
    if (summary.identity.before) {
      try {
        const finalIdentity = await readStableWorkspaceIdentity(
          expectedFqbn,
          process.env.CK_MANIFEST_GATE_PORT,
        );
        assertWorkspaceIdentityUnchanged(summary.identity.before, finalIdentity, 'after-all-restoration');
        summary.identity.checkpoints.push({ phase: 'after-all-restoration', ...finalIdentity });
        summary.identity.after = finalIdentity;
        summary.identity.unchanged = true;
      } catch (identityError) {
        summary.status = 'failed';
        summary.identity.unchanged = false;
        if (!primaryError) primaryError = identityError;
      }
    }
    if (!primaryError && summary.status === 'passed') {
      try {
        summary.operationEvidence = summarizeOperationEvidence(
          operationEvidenceRecords,
          summary.identity.before,
          summary,
        );
      } catch (operationEvidenceError) {
        summary.status = 'failed';
        if (!primaryError) primaryError = operationEvidenceError;
      }
    }
    summary.checks = buildManifestGateOutcomeChecks(summary);
    summary.failures = summary.checks
      .filter((check) => check.passed !== true)
      .map((check) => check.id);
    if (summary.failures.length > 0) {
      summary.status = 'failed';
      if (!primaryError) {
        primaryError = new Error(`Manifest-gate outcome checks failed: ${summary.failures.join(', ')}`);
      }
    }
    summary.completedAt = new Date().toISOString();
    try {
      const written = writeSummary(summary);
      console.log(`CK_UPLOAD_MANIFEST_GATE_RESULT=${JSON.stringify(JSON.parse(written.encoded))}`);
    } catch (writeError) {
      console.error(redactAndBound(writeError?.stack || String(writeError), 1800));
      if (!primaryError) primaryError = writeError;
    }
  }
  if (primaryError || summary.status !== 'passed') throw primaryError || new Error('Manifest gate test failed.');
  return summary;
}

socket.on('open', async () => {
  let exitCode = 0;
  try {
    await restoreNativeViewport(call);
    await main();
  } catch (error) {
    console.error(redactAndBound(error?.stack || String(error), 2500));
    exitCode = 1;
  } finally {
    socket.close();
    process.exitCode = exitCode;
  }
});

socket.on('error', (error) => {
  console.error(`CDP WebSocket failed: ${redactAndBound(error.message, 800)}`);
  process.exitCode = 1;
});
'@

$nodeScript | node -
if ($LASTEXITCODE -ne 0) {
    throw "Native upload manifest gate test failed with exit code $LASTEXITCODE."
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
        else { $runError = $_ }
    }
    Restore-NativeEvidenceEnvironment -Snapshot $environmentSnapshot
}
if ($null -ne $runError) {
    Initialize-NativeEvidenceReportPath -Path $OutputPath
    throw $runError
}
try {
    Add-NativeEvidenceBindingToReport -Path $OutputPath -Evidence $completedEvidence
}
catch {
    Initialize-NativeEvidenceReportPath -Path $OutputPath
    throw
}
