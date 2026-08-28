param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM10',
    [string]$ProjectName = 'c3',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32c3',
    [int]$TimeoutSeconds = 90,
    [switch]$VerifySerialRestore,
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
Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
Initialize-NativeEvidenceReportPath -Path $OutputPath
$binding = New-NativeEvidenceBinding -Root $Root -DebugPort $DebugPort -ExecutablePath $ExecutablePath `
    -CkProcessId $CkProcessId -SourceManifestPath $SourceManifestPath `
    -SourceFreezeRecordPath $SourceFreezeRecordPath -GateReportPath $GateReportPath
$environmentNames = @(
    'CK_CDP_URL', 'CK_NATIVE_CDP_VIEWPORT_GUARD', 'CK_DESKTOP_NODE_MODULES',
    'CK_DEVICE_HEALTH_PORT', 'CK_DEVICE_HEALTH_PROJECT', 'CK_DEVICE_HEALTH_FQBN',
    'CK_DEVICE_HEALTH_TIMEOUT_MS', 'CK_DEVICE_HEALTH_VERIFY_SERIAL_RESTORE',
    'CK_DEVICE_HEALTH_OUTPUT'
)
$environmentSnapshot = Save-NativeEvidenceEnvironment -Names $environmentNames
$runError = $null
$completedEvidence = $null

try {
$env:CK_CDP_URL = [string]$binding.cdp_binding.web_socket_debugger_url
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_DESKTOP_NODE_MODULES = Join-Path $Root 'apps/desktop/node_modules'
$env:CK_DEVICE_HEALTH_PORT = $Port
$env:CK_DEVICE_HEALTH_PROJECT = $ProjectName
$env:CK_DEVICE_HEALTH_FQBN = $ExpectedFqbn
$env:CK_DEVICE_HEALTH_TIMEOUT_MS = [string]($TimeoutSeconds * 1000)
$env:CK_DEVICE_HEALTH_VERIFY_SERIAL_RESTORE = if ($VerifySerialRestore) { 'true' } else { 'false' }
$env:CK_DEVICE_HEALTH_OUTPUT = $OutputPath

$nodeScript = @'
const fs = require('node:fs');
const path = require('node:path');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD || './native-cdp-viewport-guard.cjs');

function writeJsonAtomic(outputPath, encoded) {
  const resolved = path.resolve(outputPath);
  fs.mkdirSync(path.dirname(resolved), { recursive: true });
  const temporary = `${resolved}.${process.pid}.${Date.now()}.tmp`;
  try {
    fs.writeFileSync(temporary, encoded, { encoding: 'utf8', flag: 'wx' });
    fs.renameSync(temporary, resolved);
  } finally {
    try { fs.unlinkSync(temporary); } catch (error) {
      if (error?.code !== 'ENOENT') throw error;
    }
  }
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

function acceptedProjectNames(projectName) {
  return [projectName, `${projectName}.maker`, `${projectName}.ck`];
}

async function currentWorkspaceProject() {
  return waitFor(`(() => {
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    return identity?.dataset.ckProjectName || identity?.textContent?.trim() || '';
  })()`, 10000, 'workspace project identity');
}

async function ensureWorkspace() {
  const projectName = process.env.CK_DEVICE_HEALTH_PROJECT;
  const expectedNames = acceptedProjectNames(projectName);
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const currentProject = await currentWorkspaceProject();
    if (!expectedNames.includes(currentProject)) {
      throw new Error(`Refusing to inspect the wrong open project. Expected ${projectName}, found ${currentProject || 'unknown'}.`);
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
  const expectedFqbn = process.env.CK_DEVICE_HEALTH_FQBN;
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
      const actualFqbn = lastTitle
        .split(/\r?\n/)
        .map((line) => line.trim())
        .filter(Boolean)
        .at(-1) || '';
      if (actualFqbn === expectedFqbn) return actualFqbn;
    }
    await wait(150);
  }
  const actualFqbn = lastTitle
    .split(/\r?\n/)
    .map((line) => line.trim())
    .filter(Boolean)
    .at(-1) || '';
  throw new Error(`Board mismatch after waiting for project configuration. Expected exact FQBN ${expectedFqbn}; UI reports ${actualFqbn || lastTitle || 'unavailable'}.`);
}

async function selectPort() {
  const port = process.env.CK_DEVICE_HEALTH_PORT;
  await waitFor(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
    return Boolean(refresh && toggle);
  })()`, 10000, 'serial refresh and selector controls');
  if (await evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(port)})`)) return;
  const refreshed = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    refresh?.click();
    return Boolean(refresh);
  })()`);
  if (!refreshed) throw new Error('Serial refresh action could not be found.');
  await waitFor(`(async () => {
    if (typeof window.__TAURI_INTERNALS__?.invoke !== 'function') return false;
    try {
      const ports = await window.__TAURI_INTERNALS__.invoke('list_serial_ports');
      return Array.isArray(ports) && ports.some((item) => (
        (item?.port_name || item?.portName || '').trim() === ${JSON.stringify(port)}
      ));
    } catch {
      return false;
    }
  })()`, 15000, `${port} discovery after refresh`, 250);
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

async function serialMonitorOpenState() {
  return evaluate(`(() => {
    const closeAction = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668');
    return Boolean(closeAction && !closeAction.disabled);
  })()`);
}

async function ensureSerialMonitorOpen() {
  const wasOpen = await serialMonitorOpenState();
  if (wasOpen) return { wasOpen: true, openedByTest: false };

  let opened = await evaluate(`(() => {
    const action = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u6253\u5f00\u4e32\u53e3\u76d1\u89c6\u5668' && item.getClientRects().length > 0);
    if (!action || action.disabled) return false;
    action.click();
    return true;
  })()`);
  if (!opened) {
    const viewMenuOpened = await evaluate(`(() => {
      const action = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
        .find((item) => item.textContent.replace(/\\s+/g, '') === '\u89c6\u56fe');
      if (!action || action.disabled) return false;
      action.click();
      return true;
    })()`);
    if (!viewMenuOpened) throw new Error('Could not open the view menu to enable the serial monitor.');
    await waitFor(`(() => {
      const action = [...document.querySelectorAll('[role="menu"] button')]
        .find((item) => item.textContent.replace(/\\s+/g, '') === '\u6253\u5f00\u4e32\u53e3\u76d1\u89c6');
      return Boolean(action && !action.disabled);
    })()`, 5000, 'open serial monitor menu action');
    opened = await evaluate(`(() => {
      const action = [...document.querySelectorAll('[role="menu"] button')]
        .find((item) => item.textContent.replace(/\\s+/g, '') === '\u6253\u5f00\u4e32\u53e3\u76d1\u89c6');
      if (!action || action.disabled) return false;
      action.click();
      return true;
    })()`);
  }
  if (!opened) throw new Error('Serial monitor open action was unavailable.');
  await waitFor(`(() => {
    const action = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668');
    return Boolean(action && !action.disabled);
  })()`, 15000, 'serial monitor open state');
  return { wasOpen: false, openedByTest: true };
}

async function verifySerialMonitorRestored() {
  await waitFor(`(() => {
    const action = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668');
    return Boolean(action && !action.disabled);
  })()`, 15000, 'serial monitor restoration after device health');
  return true;
}

async function startHealthCheck(trackerKey) {
  await evaluate(`(() => {
    const tracker = { seenActive: false, observer: null };
    const sample = () => {
      const wide = document.querySelector('[data-ck-role="device-health-button"]');
      const panel = document.querySelector('[data-ck-role="device-health-panel"]');
      if (wide?.disabled || /\u6b63\u5728(?:\u91cd\u65b0)?\u4f53\u68c0|\u6b63\u5728\u4e0e ESP32/.test(panel?.textContent || '')) {
        tracker.seenActive = true;
      }
    };
    tracker.observer = new MutationObserver(sample);
    tracker.observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    window[${JSON.stringify(trackerKey)}] = tracker;
    sample();
    return true;
  })()`);

  let action = await evaluate(`(() => {
    const button = document.querySelector('[data-ck-role="device-health-button"]');
    if (!button || button.disabled || button.getClientRects().length === 0) return null;
    const label = button.textContent.replace(/\\s+/g, ' ').trim();
    if (!label.includes('\u771f\u673a\u4f53\u68c0')) return { error: 'wide action has no text label', label };
    button.click();
    return { clicked: true, source: 'wide', label };
  })()`);
  if (action?.error) throw new Error(action.error);

  if (!action?.clicked) {
    const menuOpened = await evaluate(`(() => {
      const refresh = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
      const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
      toggle?.click();
      return Boolean(toggle);
    })()`);
    if (!menuOpened) throw new Error('Could not open the narrow port menu for the labeled health action.');
    await waitFor(
      `Boolean(document.querySelector('[data-ck-role="device-health-menu-action"]'))`,
      5000,
      'labeled narrow health action',
    );
    action = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="device-health-menu-action"]');
      if (!button || button.disabled) return null;
      const label = button.textContent.replace(/\\s+/g, ' ').trim();
      if (!label.includes('\u771f\u673a\u4f53\u68c0')) return { error: 'narrow action has no text label', label };
      button.click();
      return { clicked: true, source: 'narrow-menu', label };
    })()`);
    if (action?.error) throw new Error(action.error);
  }
  if (!action?.clicked) throw new Error('A labeled and enabled device-health action was not available.');
  return action;
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

function redactAndBound(text, limit = 3000) {
  let safe = String(text || '').replace(/\s+$/g, '');
  safe = safe.replace(fullMacPatterns[0], '$1[REDACTED_MAC]');
  safe = safe.replace(fullMacPatterns[1], '$1[REDACTED_MAC]');
  safe = safe.replace(fullMacPatterns[2], 'MAC: [REDACTED_MAC]');
  return safe.length > limit ? `${safe.slice(0, limit)}\n…[truncated]` : safe;
}

function parseOptionalPositiveCapacity(value, label) {
  const text = String(value ?? '').trim();
  if (!text) return null;
  const number = Number(text);
  if (!Number.isSafeInteger(number) || number <= 0) {
    throw new Error(`Device-health ${label} is not a positive integer: ${text}`);
  }
  return number;
}

socket.on('open', async () => {
  let trackerKey = '';
  let exitCode = 0;
  try {
    await restoreNativeViewport(call);
    const project = await ensureWorkspace();
    const fqbn = await waitForExactBoard();
    await selectPort();
    const verifySerialRestore = process.env.CK_DEVICE_HEALTH_VERIFY_SERIAL_RESTORE === 'true';
    const serialRestore = verifySerialRestore
      ? await ensureSerialMonitorOpen()
      : { wasOpen: await serialMonitorOpenState(), openedByTest: false };

    trackerKey = `__ckDeviceHealthNative_${Date.now()}`;
    const action = await startHealthCheck(trackerKey);
    await waitFor(
      `Boolean(window[${JSON.stringify(trackerKey)}]?.seenActive)`,
      10000,
      'device-health operation start',
    );
    const timeoutMs = Number(process.env.CK_DEVICE_HEALTH_TIMEOUT_MS || 90000);
    const result = await waitFor(`(() => {
      const tracker = window[${JSON.stringify(trackerKey)}];
      const wide = document.querySelector('[data-ck-role="device-health-button"]');
      const panel = document.querySelector('[data-ck-role="device-health-panel"]');
      const panelText = panel?.textContent || '';
      const active = Boolean(wide?.disabled)
        || /\u6b63\u5728(?:\u91cd\u65b0)?\u4f53\u68c0|\u6b63\u5728\u4e0e ESP32/.test(panelText);
      const status = panel?.dataset.ckDeviceHealthStatus || '';
      if (!tracker?.seenActive || active || !status) return false;
      return {
        status,
        chipModel: panel?.dataset.ckDeviceChipModel || '',
        flashBytes: Number(panel?.dataset.ckDeviceFlashBytes || 0),
        configuredFlashBytes: panel?.dataset.ckDeviceConfiguredFlashBytes ?? '',
        psramBytes: panel?.dataset.ckDevicePsramBytes ?? '',
        psramCheckState: panel?.dataset.ckDevicePsramCheckState || '',
        resolvedFqbn: panel?.dataset.ckDeviceFqbn || '',
        panelText: panel.innerText || panelText,
        outputText: document.querySelector('.ck-console-panel')?.innerText || '',
        pageText: document.body.innerText || '',
      };
    })()`, timeoutMs, 'completed device-health result');

    if (!['healthy', 'attention'].includes(result.status)) {
      throw new Error(`Device health returned ${result.status}: ${redactAndBound(result.panelText, 1200)}`);
    }
    if (!containsFullMac(result.panelText)) throw new Error('Device-health panel did not expose the complete local MAC.');
    if (containsFullMac(result.outputText)) throw new Error('Privacy failure: full MAC appeared in the output panel.');
    if (!containsFullMac(result.pageText)) throw new Error('Visible CK page did not contain the complete local MAC shown by device health.');
    const configuredFlashBytes = parseOptionalPositiveCapacity(
      result.configuredFlashBytes,
      'configured Flash capacity',
    );
    const psramBytes = parseOptionalPositiveCapacity(result.psramBytes, 'physical PSRAM capacity');
    const psramCheckState = String(result.psramCheckState || '').trim();
    if (!['pass', 'warning', 'error', 'unknown'].includes(psramCheckState)) {
      throw new Error(`Device-health PSRAM check state is invalid: ${psramCheckState || '(missing)'}`);
    }
    const serialRestoreVerified = verifySerialRestore
      ? await verifySerialMonitorRestored()
      : null;
    const structuredChecks = [
      { id: 'chip-family-confirmed', passed: /^ESP32-C6(?:\b|$)/i.test(result.chipModel) },
      { id: 'physical-flash-confirmed', passed: Number.isSafeInteger(result.flashBytes) && result.flashBytes > 0 },
      { id: 'full-fqbn-visible', passed: result.resolvedFqbn === fqbn },
      { id: 'local-mac-output-redacted', passed: containsFullMac(result.panelText) && !containsFullMac(result.outputText) },
      { id: 'serial-monitor-restored', passed: verifySerialRestore && serialRestoreVerified === true },
    ];
    const failures = structuredChecks
      .filter((check) => check.passed !== true)
      .map((check) => check.id);

    const summary = {
      schemaVersion: 1,
      capturedAt: new Date().toISOString(),
      project,
      fqbn,
      port: process.env.CK_DEVICE_HEALTH_PORT,
      action: { source: action.source, label: action.label },
      status: result.status,
      checks: structuredChecks,
      failures,
      hardwareEvidence: {
        chipModel: result.chipModel,
        flashBytes: result.flashBytes,
        configuredFlashBytes,
        psramBytes,
        psramEvidenceState: psramBytes == null ? 'unknown' : 'reported',
        psramCheckState,
        resolvedFqbn: result.resolvedFqbn,
      },
      privacy: {
        panelContainsFullMac: true,
        outputContainsFullMac: false,
        pageContainsFullMac: true,
        exportedPanelTextRedacted: true,
      },
      serialRestore: {
        requested: verifySerialRestore,
        wasOpen: serialRestore.wasOpen,
        openedByTest: serialRestore.openedByTest,
        verified: serialRestoreVerified,
      },
      panelText: redactAndBound(result.panelText),
    };
    const encoded = JSON.stringify(summary, null, 2) + '\n';
    const outputPath = String(process.env.CK_DEVICE_HEALTH_OUTPUT || '').trim();
    if (outputPath) {
      writeJsonAtomic(outputPath, encoded);
    }
    console.log(`CK_DEVICE_HEALTH_RESULT=${JSON.stringify(summary)}`);
    if (failures.length > 0) {
      throw new Error(`Device-health outcome checks failed: ${failures.join(', ')}`);
    }
  } catch (error) {
    console.error(error?.stack || String(error));
    exitCode = 1;
  } finally {
    if (trackerKey) {
      await evaluate(`(() => {
        const tracker = window[${JSON.stringify(trackerKey)}];
        tracker?.observer?.disconnect();
        delete window[${JSON.stringify(trackerKey)}];
        return true;
      })()`).catch(() => undefined);
    }
    socket.close();
    process.exitCode = exitCode;
  }
});

socket.on('error', (error) => {
  console.error(`CDP WebSocket failed: ${error.message}`);
  process.exitCode = 1;
});
'@

$nodeScript | node -
if ($LASTEXITCODE -ne 0) {
    throw "Native device-health test failed with exit code $LASTEXITCODE."
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
if (-not [string]::IsNullOrWhiteSpace($OutputPath)) {
    try {
        Add-NativeEvidenceBindingToReport -Path $OutputPath -Evidence $completedEvidence
    }
    catch {
        Initialize-NativeEvidenceReportPath -Path $OutputPath
        throw
    }
}
