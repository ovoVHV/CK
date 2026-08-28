param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$ProjectName = 'c6_regression',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
    [string]$Port = 'COM12',
    [string]$Query = 'control delay',
    [string]$ExpectedSource = '',
    [string]$ExamplePackageDirectory = '',
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
$desktop = Join-Path $Root 'apps/desktop'
if ([string]::IsNullOrWhiteSpace($OutputPath)) {
    $OutputPath = Join-Path $Root 'artifacts\release\v1-native-smoke.json'
}
if ([string]::IsNullOrWhiteSpace($ExamplePackageDirectory)) {
    $ExamplePackageDirectory = Join-Path $Root 'examples\importable-packages\ck_example_serial_blocks'
}
if (-not [System.IO.Directory]::Exists($ExamplePackageDirectory)) {
    throw "The declarative example package directory is missing."
}

Import-Module (Join-Path $PSScriptRoot 'NativeEvidenceBinding.psm1') -Force
Initialize-NativeEvidenceReportPath -Path $OutputPath
$binding = New-NativeEvidenceBinding -Root $Root -DebugPort $DebugPort -ExecutablePath $ExecutablePath `
    -CkProcessId $CkProcessId -SourceManifestPath $SourceManifestPath `
    -SourceFreezeRecordPath $SourceFreezeRecordPath -GateReportPath $GateReportPath
$environmentNames = @(
    'CK_CDP_URL', 'CK_NATIVE_CDP_VIEWPORT_GUARD', 'CK_SEARCH_QUERY',
    'CK_EXPECTED_SOURCE', 'CK_EXPECTED_PROJECT', 'CK_EXPECTED_FQBN',
    'CK_EXPECTED_PORT', 'CK_EXAMPLE_PACKAGE_DIR', 'CK_NATIVE_EDITOR_OUTPUT', 'CK_DESKTOP_NODE_MODULES',
    'CK_NATIVE_ROOT_PID'
)
$environmentSnapshot = Save-NativeEvidenceEnvironment -Names $environmentNames
$runError = $null
$completedEvidence = $null

try {
    $env:CK_CDP_URL = [string]$binding.cdp_binding.web_socket_debugger_url
    $env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
    $env:CK_DESKTOP_NODE_MODULES = Join-Path $desktop 'node_modules'
    $env:CK_SEARCH_QUERY = $Query
    $env:CK_EXPECTED_SOURCE = $ExpectedSource
    $env:CK_EXPECTED_PROJECT = $ProjectName
    $env:CK_EXPECTED_FQBN = $ExpectedFqbn
    $env:CK_EXPECTED_PORT = $Port
    $env:CK_EXAMPLE_PACKAGE_DIR = [System.IO.Path]::GetFullPath($ExamplePackageDirectory)
    $env:CK_NATIVE_EDITOR_OUTPUT = $OutputPath
    $env:CK_NATIVE_ROOT_PID = [string]$binding.executable.process_id

    $nodeScript = @'
const crypto = require('node:crypto');
const { execFileSync } = require('node:child_process');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD || './native-cdp-viewport-guard.cjs');

const expectedProject = String(process.env.CK_EXPECTED_PROJECT || 'c6_regression');
const expectedFqbn = String(process.env.CK_EXPECTED_FQBN || '');
const expectedPort = String(process.env.CK_EXPECTED_PORT || 'COM12');
const ckRootPid = Number(process.env.CK_NATIVE_ROOT_PID || 0);
const expectedBaseFqbn = expectedFqbn.split(':').slice(0, 3).join(':');
const expectedBoardPackageId = expectedBaseFqbn;
const builtinQuery = String(process.env.CK_SEARCH_QUERY || 'control delay');
const expectedBuiltinSource = String(process.env.CK_EXPECTED_SOURCE || '');
const examplePackageDirectory = path.resolve(process.env.CK_EXAMPLE_PACKAGE_DIR || '');
const outputPath = path.resolve(process.env.CK_NATIVE_EDITOR_OUTPUT || 'v1-native-smoke.json');
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

async function waitFor(probe, timeoutMs, label, intervalMs = 120) {
  const deadline = Date.now() + timeoutMs;
  let lastValue = null;
  while (Date.now() < deadline) {
    lastValue = await probe();
    if (lastValue) return lastValue;
    await wait(intervalMs);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

async function invoke(command, args = {}) {
  return evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)}, ${JSON.stringify(args)})`);
}

const sha256 = (bytes) => crypto.createHash('sha256').update(bytes).digest('hex');
const visible = (element) => Boolean(element && element.getClientRects().length && getComputedStyle(element).display !== 'none' && getComputedStyle(element).visibility !== 'hidden');

let maximumHorizontalOverflow = 0;
async function captureHorizontalOverflow(label) {
  const state = await evaluate(`(() => {
    const documentOverflow = Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth);
    const app = document.querySelector('.app-root');
    const appOverflow = app ? Math.max(0, app.scrollWidth - app.clientWidth) : 0;
    return { documentOverflow, appOverflow };
  })()`);
  maximumHorizontalOverflow = Math.max(maximumHorizontalOverflow, state.documentOverflow, state.appOverflow);
  if (state.documentOverflow > 1 || state.appOverflow > 1) {
    throw new Error(`${label} has horizontal overflow: ${JSON.stringify(state)}`);
  }
  return state;
}

function projectNames(name) {
  return [name, `${name}.maker`, `${name}.ck`];
}

async function currentWorkspaceIdentity() {
  return evaluate(`(() => {
    const identity = document.querySelector('[data-ck-role="workspace-project-identity"]');
    const board = document.querySelector('[data-ck-role="board-config-button"]');
    const lines = String(board?.title || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
    return {
      name: identity?.dataset.ckProjectName || identity?.textContent?.trim() || '',
      path: identity?.title || '',
      fqbn: lines.at(-1) || '',
    };
  })()`);
}

async function ensureDashboard() {
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const clicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u8fd4\u56de\u9879\u76ee\u5217\u8868' && (${visible.toString()})(item));
      button?.click();
      return Boolean(button);
    })()`);
    if (!clicked) throw new Error('The native workspace back action is unavailable.');
    const result = await waitFor(async () => {
      const state = await evaluate(`(() => ({
        dashboard: Boolean(document.querySelector('button[aria-label="\u6253\u5f00\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e"]')),
        unsaved: Boolean(document.querySelector('[data-ck-role="unsaved-changes-dialog"]')),
      }))()`);
      if (state.unsaved) throw new Error('The expected regression project has unsaved changes; native smoke will not discard or overwrite them.');
      return state.dashboard;
    }, 15000, 'dashboard after native back action');
    if (!result) throw new Error('Dashboard did not open.');
  }
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('button[aria-label="\u6253\u5f00\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e"]'))`),
    15000,
    'native dashboard',
  );
}

async function openProject(name) {
  await ensureDashboard();
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('h3[title]')].some((item) => item.title === ${JSON.stringify(name)})`),
    30000,
    `${name} project card`,
  );
  const opened = await evaluate(`(() => {
    const heading = [...document.querySelectorAll('h3[title]')].find((item) => item.title === ${JSON.stringify(name)});
    const card = heading?.closest('[class*="cursor-pointer"]') || heading?.parentElement?.parentElement;
    card?.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
    return Boolean(card);
  })()`);
  if (!opened) throw new Error(`Project card could not be opened: ${name}`);
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-ck-role="workspace-project-identity"]'))`),
    30000,
    `${name} workspace identity`,
  );
  const identity = await waitFor(async () => {
    const current = await currentWorkspaceIdentity();
    return projectNames(name).includes(current.name) ? current : false;
  }, 30000, `${name} exact workspace identity`);
  return identity;
}

async function ensureExpectedWorkspace() {
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) {
    const current = await currentWorkspaceIdentity();
    if (!projectNames(expectedProject).includes(current.name)) {
      await ensureDashboard();
      return openProject(expectedProject);
    }
    return current;
  }
  return openProject(expectedProject);
}

async function selectThemeMode(mode) {
  const labels = { light: '\u6d45\u8272', dark: '\u6df1\u8272', system: '\u8ddf\u968f\u7cfb\u7edf' };
  const label = labels[mode];
  if (!label) throw new Error(`Unsupported theme mode: ${mode}`);
  const selected = await evaluate(`(() => document.querySelector('.app-root')?.dataset.themeMode || '')()`);
  if (selected === mode) return;

  let clicked = await evaluate(`(() => {
    const root = document.querySelector('[data-ck-role="theme-mode-control"]');
    const trigger = root?.querySelector('button');
    if (!(trigger && (${visible.toString()})(trigger))) return false;
    trigger.click();
    return true;
  })()`);
  if (clicked) {
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[data-ck-role="theme-mode-menu"]'))`),
      3000,
      'theme mode menu',
    );
    clicked = await evaluate(`(() => {
      const label = ${JSON.stringify(label)};
      const button = [...document.querySelectorAll('[data-ck-role="theme-mode-menu"] [role="menuitemradio"]')]
        .find((item) => item.textContent.includes(label));
      button?.click();
      return Boolean(button);
    })()`);
  } else {
    clicked = await evaluate(`(() => {
      const header = document.querySelector('.ck-workspace-header');
      const viewButton = [...(header?.querySelectorAll('button[aria-haspopup="menu"]') || [])]
        .find((item) => item.textContent.includes('\u89c6\u56fe') && (${visible.toString()})(item));
      viewButton?.click();
      return Boolean(viewButton);
    })()`);
    if (!clicked) throw new Error('No visible theme selector is available.');
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('[role="menuitemradio"]')]
        .some((item) => item.textContent.includes(${JSON.stringify(label)}) && (${visible.toString()})(item))`),
      3000,
      'workspace theme menu',
    );
    clicked = await evaluate(`(() => {
      const item = [...document.querySelectorAll('[role="menuitemradio"]')]
        .find((button) => button.textContent.includes(${JSON.stringify(label)}) && (${visible.toString()})(button));
      item?.click();
      return Boolean(item);
    })()`);
  }
  if (!clicked) throw new Error(`Theme option could not be clicked: ${mode}`);
  await waitFor(async () => {
    const state = await evaluate(`(() => ({
      mode: document.querySelector('.app-root')?.dataset.themeMode || '',
      resolved: document.querySelector('.app-root')?.dataset.themeResolved || '',
      darkClass: document.documentElement.classList.contains('dark'),
    }))()`);
    if (state.mode !== mode) return false;
    if (mode === 'light') return state.resolved === 'light' && !state.darkClass ? state : false;
    if (mode === 'dark') return state.resolved === 'dark' && state.darkClass ? state : false;
    return state;
  }, 5000, `${mode} theme application`);
}

async function exerciseThemes(originalMode) {
  await selectThemeMode('light');
  const light = await evaluate(`(() => ({
    mode: document.querySelector('.app-root')?.dataset.themeMode,
    resolved: document.querySelector('.app-root')?.dataset.themeResolved,
    darkClass: document.documentElement.classList.contains('dark'),
  }))()`);
  await selectThemeMode('dark');
  const dark = await evaluate(`(() => ({
    mode: document.querySelector('.app-root')?.dataset.themeMode,
    resolved: document.querySelector('.app-root')?.dataset.themeResolved,
    darkClass: document.documentElement.classList.contains('dark'),
  }))()`);
  await selectThemeMode(originalMode);
  const restored = await evaluate(`document.querySelector('.app-root')?.dataset.themeMode || ''`);
  if (light.mode !== 'light' || light.resolved !== 'light' || light.darkClass) throw new Error('Light theme did not apply deterministically.');
  if (dark.mode !== 'dark' || dark.resolved !== 'dark' || !dark.darkClass) throw new Error('Dark theme did not apply deterministically.');
  if (restored !== originalMode) throw new Error('Theme mode was not restored.');
  return { light: true, dark: true, restored: true };
}

async function inspectSystemPaths() {
  await ensureDashboard();
  const opened = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="\u6253\u5f00\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e"]');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) throw new Error('Project storage entry is missing.');
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-ck-role="project-storage-dialog"]'))`),
    5000,
    'project storage dialog',
  );
  const expectedProjectRoots = await invoke('get_project_roots');
  if (!Array.isArray(expectedProjectRoots) || expectedProjectRoots.length === 0) {
    throw new Error('Project storage initialization returned no configured project roots.');
  }
  let lastStorageSignature = '';
  let stableStorageReadCount = 0;
  await waitFor(async () => {
    const state = await evaluate(`(() => {
      const expectedRoots = ${JSON.stringify(expectedProjectRoots)};
      const dialog = document.querySelector('[data-ck-role="project-storage-dialog"]');
      const title = dialog?.querySelector('#ck-project-storage-title')?.textContent?.trim() || '';
      const loading = Boolean(dialog?.textContent.includes('\u6b63\u5728\u8bfb\u53d6\u5de5\u7a0b\u76ee\u5f55'));
      const diagnosticsButton = [...(dialog?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.includes('\u9ad8\u7ea7\u8bca\u65ad'));
      const rootButtons = [...(dialog?.querySelectorAll('button[title]') || [])];
      const renderedRootCount = expectedRoots.filter((root) => rootButtons.some((button) => (
        button.title === '\u5728\u8d44\u6e90\u7ba1\u7406\u5668\u4e2d\u6253\u5f00\uff1a' + root
        && button.textContent.includes(root)
      ))).length;
      const ready = title === '\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e'
        && !loading
        && renderedRootCount === expectedRoots.length
        && Boolean(diagnosticsButton && !diagnosticsButton.disabled && diagnosticsButton.getClientRects().length);
      return {
        ready,
        signature: JSON.stringify({ title, loading, renderedRootCount, expectedRootCount: expectedRoots.length }),
      };
    })()`);
    if (!state.ready) {
      lastStorageSignature = '';
      stableStorageReadCount = 0;
      return false;
    }
    if (state.signature !== lastStorageSignature) {
      lastStorageSignature = state.signature;
      stableStorageReadCount = 1;
      return false;
    }
    stableStorageReadCount += 1;
    return stableStorageReadCount >= 2 ? state : false;
  }, 10000, 'stable project storage initialization', 120);
  const diagnosticsClicked = await evaluate(`(() => {
    const dialog = document.querySelector('[data-ck-role="project-storage-dialog"]');
    const button = [...(dialog?.querySelectorAll('button') || [])]
      .find((item) => item.textContent.includes('\u9ad8\u7ea7\u8bca\u65ad'));
    button?.click();
    return Boolean(button);
  })()`);
  if (!diagnosticsClicked) throw new Error('Advanced diagnostics entry is missing.');
  await waitFor(
    () => evaluate(`(() => {
      const dialog = document.querySelector('[data-ck-role="project-storage-dialog"]');
      const title = dialog?.querySelector('#ck-project-storage-title')?.textContent?.trim() || '';
      const returnButton = [...(dialog?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.includes('\u8fd4\u56de\u5b58\u50a8\u4f4d\u7f6e'));
      return title === '\u9ad8\u7ea7\u8bca\u65ad'
        && Boolean(dialog?.textContent.includes('\u5173\u952e\u8fd0\u884c\u8def\u5f84'))
        && Boolean(returnButton)
        ? { title, diagnostics: true }
        : false;
    })()`),
    5000,
    'advanced diagnostics view after stable storage initialization',
  );
  const expectedSystemPaths = await invoke('get_system_paths');
  if (!Array.isArray(expectedSystemPaths) || expectedSystemPaths.length === 0) {
    throw new Error('System path diagnostics returned no rows.');
  }
  const result = await waitFor(
    () => evaluate(`(() => {
      const expected = ${JSON.stringify(expectedSystemPaths)};
      const dialog = document.querySelector('[data-ck-role="project-storage-dialog"]');
      if (!dialog?.textContent.includes('\u5173\u952e\u8fd0\u884c\u8def\u5f84')) return false;
      const buttons = [...dialog.querySelectorAll('button[title]')];
      const rows = (Array.isArray(expected) ? expected : []).map(([label, systemPath, exists]) => {
        const title = (exists ? '\u70b9\u51fb\u6253\u5f00' : '\u8def\u5f84\u4e0d\u5b58\u5728') + '\uff1a' + systemPath;
        const button = buttons.find((item) => item.title === title);
        const pathText = [...(button?.querySelectorAll('span') || [])]
          .some((item) => item.textContent === systemPath);
        return { label: Boolean(button?.textContent.includes(label)), path: pathText, title: Boolean(button), exists: Boolean(exists) };
      });
      return expected.length > 0 && rows.length === expected.length && rows.every((item) => item.label && item.path && item.title)
        ? { count: rows.length, existingCount: rows.filter((item) => item.exists).length, completeCount: rows.filter((item) => item.label && item.path && item.title).length }
        : false;
    })()`),
    10000,
    'complete system path rows',
    250,
  );
  await captureHorizontalOverflow('advanced diagnostics');
  await evaluate(`document.querySelector('button[aria-label="\u5173\u95ed\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e"]')?.click()`);
  await waitFor(
    () => evaluate(`!document.querySelector('[data-ck-role="project-storage-dialog"]')`),
    3000,
    'advanced diagnostics close',
  );
  return result;
}

async function waitForExactBoard() {
  return waitFor(async () => {
    const state = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="board-config-button"]');
      const lines = String(button?.title || '').split(/\\r?\\n/).map((line) => line.trim()).filter(Boolean);
      return {
        disabled: Boolean(button?.disabled),
        status: button?.dataset.ckBoardOptionsStatus || '',
        compatible: button?.dataset.ckBoardOptionsCompatible || '',
        fqbn: lines.at(-1) || '',
      };
    })()`);
    return !state.disabled && ['resolved', 'core-default'].includes(state.status)
      && state.compatible !== 'false' && state.fqbn === expectedFqbn ? state : false;
  }, 60000, `exact FQBN ${expectedFqbn}`);
}

async function expectedPortIsSelected() {
  return evaluate(`[...document.querySelectorAll('button[aria-haspopup="menu"]')]
    .some((button) => button.title === ${JSON.stringify(expectedPort)})`);
}

async function selectExpectedPort() {
  if (!expectedPort) throw new Error('The native productization smoke requires an exact serial port.');
  if (await expectedPortIsSelected()) return { selected: true };
  const refreshClicked = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    refresh?.click();
    return Boolean(refresh);
  })()`);
  if (!refreshClicked) throw new Error('Serial-port refresh action is unavailable.');
  await wait(800);
  const menuOpened = await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    const toggle = refresh?.parentElement?.querySelector('button[aria-haspopup="menu"]');
    toggle?.click();
    return Boolean(toggle);
  })()`);
  if (!menuOpened) throw new Error('Serial-port menu could not be opened.');
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('[role="menu"] button')]
      .some((item) => item.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(expectedPort)})`),
    10000,
    'expected serial port in native menu',
  );
  const selected = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menu"] button')]
      .find((button) => button.querySelector('span.font-mono')?.textContent?.trim() === ${JSON.stringify(expectedPort)});
    item?.click();
    return Boolean(item);
  })()`);
  if (!selected) throw new Error('Expected serial port could not be selected.');
  await waitFor(expectedPortIsSelected, 10000, 'exact serial-port selection');
  return { selected: true };
}

async function inspectBoardConfig() {
  await waitForExactBoard();
  const opened = await evaluate(`(() => {
    const button = document.querySelector('[data-ck-role="board-config-button"]');
    button?.click();
    return Boolean(button);
  })()`);
  if (!opened) throw new Error('Board configuration button is missing.');
  const state = await waitFor(
    () => evaluate(`(() => {
      const dialog = document.querySelector('[data-ck-role="board-config-dialog"]');
      const code = document.querySelector('[data-ck-role="board-config-effective-fqbn"]');
      if (!dialog || !code) return false;
      const style = getComputedStyle(code);
      return {
        textExact: code.textContent.trim() === ${JSON.stringify(expectedFqbn)},
        titleExact: code.title === ${JSON.stringify(expectedFqbn)},
        wraps: style.whiteSpace !== 'nowrap' && ['break-all', 'break-word'].includes(style.wordBreak) || style.overflowWrap === 'anywhere',
        codeOverflow: Math.max(0, code.scrollWidth - code.clientWidth),
        dialogOverflow: Math.max(0, dialog.scrollWidth - dialog.clientWidth),
      };
    })()`),
    5000,
    'full FQBN in board configuration',
  );
  if (!state.textExact || !state.titleExact) throw new Error('Board configuration did not show the exact full FQBN.');
  if (!state.wraps || state.codeOverflow > 1 || state.dialogOverflow > 1) throw new Error(`Full FQBN is not safely wrappable: ${JSON.stringify(state)}`);
  await captureHorizontalOverflow('board configuration');
  await evaluate(`document.querySelector('button[aria-label="\u5173\u95ed\u677f\u5361\u8bbe\u7f6e"]')?.click()`);
  await waitFor(() => evaluate(`!document.querySelector('[data-ck-role="board-config-dialog"]')`), 3000, 'board configuration close');
  return state;
}

async function compileForHealthEvidence() {
  const trackerKey = `__ckNativeCompileEvidence_${Date.now()}_${crypto.randomUUID().replace(/-/g, '')}`;
  const trackerInstalled = await evaluate(`(() => {
    const key = ${JSON.stringify(trackerKey)};
    const button = document.querySelector('[data-ck-role="build-compile-action"]');
    if (!button || button.disabled || window[key]) return false;
    const readLog = () => document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText
      || document.querySelector('.ck-console-panel')?.innerText
      || '';
    const summarizeLog = (value) => ({
      length: value.length,
      head: value.slice(0, 160),
      tail: value.slice(-160),
    });
    const tracker = {
      observer: null,
      seenActive: false,
      seenOverlay: false,
      seenCompileDisabled: false,
      seenFreshTargetLog: false,
      baselineLog: summarizeLog(readLog()),
      startedAt: Date.now(),
    };
    const sample = () => {
      const currentButton = document.querySelector('[data-ck-role="build-compile-action"]');
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      if (overlay) {
        tracker.seenOverlay = true;
        tracker.seenActive = true;
      }
      if (currentButton?.disabled) {
        tracker.seenCompileDisabled = true;
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
    window[key] = tracker;
    button.click();
    sample();
    return true;
  })()`);
  if (!trackerInstalled) throw new Error('Compile action is not ready for resource-layout evidence.');
  try {
    await waitFor(
      () => evaluate(`Boolean(window[${JSON.stringify(trackerKey)}]?.seenActive)`),
      15000,
      'new compile UI active transition',
    );

    const freshTarget = await waitFor(
      () => evaluate(`(() => {
        const tracker = window[${JSON.stringify(trackerKey)}];
        if (!tracker?.seenActive) return false;
        const log = document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText
          || document.querySelector('.ck-console-panel')?.innerText
          || '';
        const current = { length: log.length, head: log.slice(0, 160), tail: log.slice(-160) };
        const baseline = tracker.baselineLog;
        const changed = current.length !== baseline.length
          || current.head !== baseline.head
          || current.tail !== baseline.tail;
        const exactTargetReported = log.includes(${JSON.stringify(expectedFqbn)});
        if (!changed || !exactTargetReported) return false;
        tracker.seenFreshTargetLog = true;
        return { changed: true, exactTargetReported: true };
      })()`),
      60000,
      'fresh compile target log',
      150,
    );

    await waitFor(
      () => evaluate(`(() => {
        const tracker = window[${JSON.stringify(trackerKey)}];
        const button = document.querySelector('[data-ck-role="build-compile-action"]');
        const active = Boolean(document.querySelector('[data-ck-role="compile-progress-overlay"]'))
          || Boolean(button?.disabled);
        return Boolean(tracker?.seenActive && tracker?.seenFreshTargetLog && button && !active);
      })()`),
      600000,
      'new compile completion and UI recovery',
      250,
    );

    await wait(250);
    const result = await evaluate(`(() => {
      const tracker = window[${JSON.stringify(trackerKey)}];
      const button = document.querySelector('[data-ck-role="build-compile-action"]');
      const log = document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText
        || document.querySelector('.ck-console-panel')?.innerText
        || '';
      const successIndex = log.lastIndexOf('\\u7f16\\u8bd1\\u6210\\u529f');
      const failureIndex = log.lastIndexOf('\\n\\u5931\\u8d25:');
      return {
        seenActive: Boolean(tracker?.seenActive),
        seenOverlay: Boolean(tracker?.seenOverlay),
        seenCompileDisabled: Boolean(tracker?.seenCompileDisabled),
        seenFreshTargetLog: Boolean(tracker?.seenFreshTargetLog),
        ready: Boolean(button && !button.disabled),
        overlayAbsent: !document.querySelector('[data-ck-role="compile-progress-overlay"]'),
        exactTargetReported: log.includes(${JSON.stringify(expectedFqbn)}),
        flashUsageReported: /Sketch uses\\s+\\d+\\s+bytes/i.test(log),
        ramUsageReported: /Global variables use\\s+\\d+\\s+bytes/i.test(log),
        successMarkerIsFinal: successIndex >= 0 && successIndex > failureIndex,
        elapsedMs: Math.max(0, Date.now() - Number(tracker?.startedAt || Date.now())),
      };
    })()`);
    const complete = result.seenActive
      && (result.seenOverlay || result.seenCompileDisabled)
      && result.seenFreshTargetLog
      && result.ready
      && result.overlayAbsent
      && result.exactTargetReported
      && result.flashUsageReported
      && result.ramUsageReported
      && result.successMarkerIsFinal;
    if (!complete) {
      throw new Error(`The fresh native compile did not produce complete success evidence: ${JSON.stringify(result)}`);
    }
    return {
      started: true,
      completed: true,
      exactTargetReported: result.exactTargetReported,
      freshLogObserved: freshTarget.changed,
      resourcesReported: result.flashUsageReported && result.ramUsageReported,
      successMarkerObserved: result.successMarkerIsFinal,
      elapsedMs: result.elapsedMs,
    };
  } finally {
    await evaluate(`(() => {
      const key = ${JSON.stringify(trackerKey)};
      window[key]?.observer?.disconnect();
      delete window[key];
      return true;
    })()`);
  }
}

async function openEngineeringHealth() {
  const clicked = await evaluate(`(() => {
    const direct = document.querySelector('[data-ck-role="engineering-health-button"]');
    if (direct && (${visible.toString()})(direct)) { direct.click(); return true; }
    const header = document.querySelector('.ck-workspace-header');
    const view = [...(header?.querySelectorAll('button[aria-haspopup="menu"]') || [])]
      .find((item) => item.textContent.includes('\u89c6\u56fe') && (${visible.toString()})(item));
    view?.click();
    return Boolean(view);
  })()`);
  if (!clicked) throw new Error('Engineering health entry is missing.');
  if (!(await evaluate(`Boolean(document.querySelector('[data-ck-role="engineering-health-dock"]'))`))) {
    await waitFor(
      () => evaluate(`Boolean(document.querySelector('[data-ck-role="engineering-health-menu-action"]'))`),
      3000,
      'engineering health menu action',
    );
    await evaluate(`document.querySelector('[data-ck-role="engineering-health-menu-action"]')?.click()`);
  }
  await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-ck-role="engineering-health-dock"]'))`),
    5000,
    'engineering health dock',
  );
}

async function inspectEngineeringHealth() {
  await openEngineeringHealth();
  const layout = await evaluate(`(() => {
    const dock = document.querySelector('[data-ck-role="engineering-health-dock"]');
    const view = document.querySelector('[data-ck-role="engineering-health-view"]');
    const resource = document.querySelector('[data-ck-role="resource-budget-panel"]');
    const rect = dock?.getBoundingClientRect();
    const workspace = document.querySelector('.ck-workspace-stage');
    const workspaceRect = workspace?.getBoundingClientRect();
    const children = [...(view?.children || [])].filter((item) => (${visible.toString()})(item));
    const overlaps = [];
    for (let left = 0; left < children.length; left += 1) {
      const a = children[left].getBoundingClientRect();
      for (let right = left + 1; right < children.length; right += 1) {
        const b = children[right].getBoundingClientRect();
        const x = Math.min(a.right, b.right) - Math.max(a.left, b.left);
        const y = Math.min(a.bottom, b.bottom) - Math.max(a.top, b.top);
        if (x > 1 && y > 1) overlaps.push([left, right]);
      }
    }
    return {
      dockVisible: (${visible.toString()})(dock),
      inViewport: Boolean(rect && rect.left >= -1 && rect.right <= innerWidth + 1 && rect.width >= 279 && rect.width <= Math.min(641, innerWidth * 0.45 + 1)),
      dockOverflow: dock ? Math.max(0, dock.scrollWidth - dock.clientWidth) : null,
      viewOverflow: view ? Math.max(0, view.scrollWidth - view.clientWidth) : null,
      resourcePresent: Boolean(resource),
      resourceOverflow: resource ? Math.max(0, resource.scrollWidth - resource.clientWidth) : null,
      overlappingPanelCount: overlaps.length,
      workspaceDockOverlap: Boolean(rect && workspaceRect && Math.min(rect.right, workspaceRect.right) - Math.max(rect.left, workspaceRect.left) > 1),
    };
  })()`);
  if (!layout.dockVisible || !layout.inViewport || layout.dockOverflow > 1 || layout.viewOverflow > 1
      || !layout.resourcePresent || layout.resourceOverflow > 1 || layout.overlappingPanelCount !== 0 || layout.workspaceDockOverlap) {
    throw new Error(`Engineering health layout is invalid: ${JSON.stringify(layout)}`);
  }
  await captureHorizontalOverflow('engineering health dock');

  const collapsed = await evaluate(`(() => {
    const button = document.querySelector('button[aria-label="\u6536\u8d77\u5de5\u7a0b\u4f53\u68c0\u4fa7\u680f"]');
    button?.click();
    return Boolean(button);
  })()`);
  if (!collapsed) throw new Error('Engineering health collapse action is missing.');
  await waitFor(() => evaluate(`!document.querySelector('[data-ck-role="engineering-health-dock"]')`), 3000, 'engineering health collapse');
  await openEngineeringHealth();
  const reopened = await evaluate(`Boolean(
    document.querySelector('[data-ck-role="engineering-health-dock"]')
    && document.querySelector('[data-ck-role="resource-budget-panel"]')
  )`);
  if (!reopened) throw new Error('Engineering health did not reopen.');
  await evaluate(`document.querySelector('button[aria-label="\u6536\u8d77\u5de5\u7a0b\u4f53\u68c0\u4fa7\u680f"]')?.click()`);
  await waitFor(() => evaluate(`!document.querySelector('[data-ck-role="engineering-health-dock"]')`), 3000, 'engineering health final collapse');
  return { ...layout, collapsed: true, reopened: true };
}

async function searchBlocks(query, expectedSource = '') {
  await waitFor(async () => {
    const ready = await evaluate(`(() => ({
      input: Boolean(document.querySelector('[data-ck-role="global-block-search"]')),
      catalogCount: window.CK_BLOCK_CATALOG?.blockCount || 0,
    }))()`);
    return ready.input && ready.catalogCount > 0 ? ready : false;
  }, 15000, 'block catalog and global search');
  await evaluate(`(() => {
    const input = document.querySelector('[data-ck-role="global-block-search"]');
    input.focus();
    input.select();
  })()`);
  await call('Input.insertText', { text: query });
  const state = await waitFor(async () => {
    const result = await evaluate(`(() => {
      const input = document.querySelector('[data-ck-role="global-block-search"]');
      const flyout = document.querySelector('.blocklyToolboxFlyout');
      return {
        tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
        catalogCount: window.CK_BLOCK_CATALOG?.blockCount || 0,
        query: input?.value || '',
        resultCount: Number(document.querySelector('.ck-toolbox-search-result-count')?.textContent || 0),
        flyoutVisible: Boolean(flyout) && getComputedStyle(flyout).display !== 'none',
        sourceLabels: [...document.querySelectorAll('.blocklyToolboxFlyout .ck-search-source-label')]
          .map((element) => element.textContent?.trim() || ''),
      };
    })()`);
    return result.query === query && result.resultCount > 0 && result.flyoutVisible && result.sourceLabels.length > 0 ? result : false;
  }, 8000, `global block search for ${query}`);
  if (expectedSource && !state.sourceLabels.includes(expectedSource)) {
    throw new Error('The expected block source label was not rendered.');
  }
  await captureHorizontalOverflow('global block search');
  await evaluate(`document.querySelector('.ck-toolbox-search-clear')?.click()`);
  const cleanup = await waitFor(async () => {
    const value = await evaluate(`(() => {
      const input = document.querySelector('[data-ck-role="global-block-search"]');
      const flyout = document.querySelector('.blocklyToolboxFlyout');
      return { query: input?.value || '', flyoutVisible: Boolean(flyout) && getComputedStyle(flyout).display !== 'none' };
    })()`);
    return !value.query && !value.flyoutVisible ? value : false;
  }, 3000, 'global block search cleanup');
  return { state, cleanup };
}

async function openWorkspaceEntry(title, menuText, dialogSelector) {
  let clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button[title=${JSON.stringify(title)}]')]
      .find((item) => (${visible.toString()})(item));
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) {
    clicked = await evaluate(`(() => {
      const header = document.querySelector('.ck-workspace-header');
      const menu = [...(header?.querySelectorAll('button[aria-haspopup="menu"]') || [])]
        .find((item) => ['\u6587\u4ef6', '\u66f4\u591a'].some((label) => item.textContent.includes(label)) && (${visible.toString()})(item));
      menu?.click();
      return Boolean(menu);
    })()`);
    if (!clicked) throw new Error(`Workspace menu for ${title} is unavailable.`);
    await waitFor(
      () => evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .some((item) => item.textContent.includes(${JSON.stringify(menuText)}) && (${visible.toString()})(item))`),
      3000,
      `${title} menu item`,
    );
    clicked = await evaluate(`(() => {
      const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
        .find((button) => button.textContent.includes(${JSON.stringify(menuText)}) && (${visible.toString()})(button));
      item?.click();
      return Boolean(item);
    })()`);
  }
  if (!clicked) throw new Error(`Workspace entry could not be opened: ${title}`);
  await waitFor(() => evaluate(`Boolean(document.querySelector(${JSON.stringify(dialogSelector)}))`), 8000, `${title} dialog`);
}

async function clickWorkspaceFileAction(title, menuText) {
  let clicked = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button[title=${JSON.stringify(title)}]')]
      .find((item) => (${visible.toString()})(item));
    button?.click();
    return Boolean(button);
  })()`);
  if (clicked) return true;
  const menuOpened = await evaluate(`(() => {
    const header = document.querySelector('.ck-workspace-header');
    const menu = [...(header?.querySelectorAll('button[aria-haspopup="menu"]') || [])]
      .find((item) => ['\u6587\u4ef6', '\u66f4\u591a'].some((label) => item.textContent.includes(label)) && (${visible.toString()})(item));
    menu?.click();
    return Boolean(menu);
  })()`);
  if (!menuOpened) return false;
  await waitFor(
    () => evaluate(`[...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
      .some((item) => item.textContent.includes(${JSON.stringify(menuText)}) && (${visible.toString()})(item))`),
    3000,
    `${title} file action`,
  );
  clicked = await evaluate(`(() => {
    const item = [...document.querySelectorAll('[role="menu"] [role="menuitem"]')]
      .find((button) => button.textContent.includes(${JSON.stringify(menuText)}) && (${visible.toString()})(button));
    item?.click();
    return Boolean(item);
  })()`);
  return clicked;
}

async function closeDialogWhenReady(dialogSelector, closeAriaLabel, label) {
  await waitFor(
    () => evaluate(`(() => {
      const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
      const button = [...document.querySelectorAll('button[aria-label]')]
        .find((item) => dialog?.contains(item)
          && item.getAttribute('aria-label') === ${JSON.stringify(closeAriaLabel)});
      return Boolean(dialog && button && !button.disabled && (${visible.toString()})(button));
    })()`),
    30000,
    `${label} enabled close action`,
  );
  const clicked = await evaluate(`(() => {
    const dialog = document.querySelector(${JSON.stringify(dialogSelector)});
    const button = [...document.querySelectorAll('button[aria-label]')]
      .find((item) => dialog?.contains(item)
        && item.getAttribute('aria-label') === ${JSON.stringify(closeAriaLabel)});
    if (!dialog || !button || button.disabled || !(${visible.toString()})(button)) return false;
    button.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`${label} close action became unavailable before it could be clicked.`);
  await waitFor(
    () => evaluate(`!document.querySelector(${JSON.stringify(dialogSelector)})`),
    5000,
    `${label} close`,
  );
}

async function inspectRecoveryEntries() {
  await openWorkspaceEntry('\u5de5\u7a0b\u68c0\u67e5\u70b9', '\u5de5\u7a0b\u68c0\u67e5\u70b9', '[aria-labelledby="project-checkpoints-title"]');
  const checkpoints = await evaluate(`Boolean(document.querySelector('#project-checkpoints-title'))`);
  await closeDialogWhenReady(
    '[aria-labelledby="project-checkpoints-title"]',
    '\u5173\u95ed\u5de5\u7a0b\u68c0\u67e5\u70b9',
    'checkpoint dialog',
  );

  await openWorkspaceEntry('\u4e0a\u4e00\u4e2a\u53ef\u7528\u7248\u672c', '\u4e0a\u4e00\u4e2a\u53ef\u7528\u7248\u672c', '[aria-labelledby="last-working-version-title"]');
  const lastWorking = await evaluate(`Boolean(document.querySelector('#last-working-version-title'))`);
  await closeDialogWhenReady(
    '[aria-labelledby="last-working-version-title"]',
    '\u5173\u95ed\u4e0a\u4e00\u4e2a\u53ef\u7528\u7248\u672c',
    'last working version dialog',
  );
  if (!checkpoints || !lastWorking) throw new Error('Recovery entries did not open their native dialogs.');
  return { checkpoints, lastWorking };
}

async function createAndOpenRecoveryDraft(cleanup) {
  const identity = await currentWorkspaceIdentity();
  if (!identity.path) throw new Error('Current project path is unavailable for recovery-draft evidence.');
  const project = await invoke('load_project', { path: identity.path });
  const baseline = await invoke('get_project_recovery_baseline', { projectPath: identity.path, projectId: null });
  const sourceMarker = `// ck-native-recovery-${crypto.randomUUID()}`;
  const draft = await invoke('save_recovery_draft', {
    input: {
      projectPath: identity.path,
      projectId: null,
      diskBaselineHash: baseline.sha256,
      diskBaselineModifiedAt: baseline.modifiedAt || null,
      workspaceJson: String(project.xml || '{}'),
      sourceCode: sourceMarker,
      board: String(project.board || expectedBaseFqbn),
      fqbn: expectedFqbn,
      boardPackageId: String(project.board_package_id || expectedBoardPackageId),
      options: String(project.options || '{}'),
      expectedFullStateHash: null,
    },
  });
  if (!draft?.id) throw new Error('Unique recovery draft was not created.');
  cleanup.recoveryDraft = { projectPath: identity.path, id: draft.id };
  await ensureDashboard();
  await openProject(expectedProject);
  const opened = await waitFor(
    () => evaluate(`Boolean(document.querySelector('[data-ck-role="recovery-draft-dialog"]'))`),
    30000,
    'rolling recovery draft dialog',
  );
  const textVerified = await evaluate(`(() => {
    const dialog = document.querySelector('[data-ck-role="recovery-draft-dialog"]');
    return Boolean(dialog?.textContent.includes('\u53d1\u73b0\u672a\u4fdd\u5b58\u6062\u590d\u7a3f') && dialog.textContent.includes('\u72ec\u7acb\u6eda\u52a8\u6062\u590d\u7a3f'));
  })()`);
  if (!opened || !textVerified) throw new Error('The unique rolling recovery draft was not presented accurately.');
  await evaluate(`document.querySelector('button[aria-label="\u6682\u4e0d\u5904\u7406\u6062\u590d\u7a3f"]')?.click()`);
  await waitFor(() => evaluate(`!document.querySelector('[data-ck-role="recovery-draft-dialog"]')`), 3000, 'recovery draft dialog close');
  return { opened: true, uniqueDraft: true };
}

function writeJson(filePath, value) {
  fs.writeFileSync(filePath, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createDeclarativeFixture(tempRoot) {
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const packageId = `ck_native_smoke_${token}`;
  const blockType = `ck_native_smoke_block_${token}`;
  const query = `native_smoke_${token}`;
  const category = `NativeSmoke-${token}`;
  const displayName = `CK Native Smoke ${token}`;
  const packageRoot = path.join(tempRoot, packageId);
  fs.cpSync(examplePackageDirectory, packageRoot, { recursive: true, errorOnExist: true });

  const library = JSON.parse(fs.readFileSync(path.join(packageRoot, 'library.json'), 'utf8'));
  library.id = packageId;
  library.name = displayName;
  library.description = 'Deterministic production native smoke package.';
  writeJson(path.join(packageRoot, 'library.json'), library);

  const manifest = JSON.parse(fs.readFileSync(path.join(packageRoot, 'ck-blocks.json'), 'utf8'));
  manifest.id = packageId;
  manifest.display_name = displayName;
  manifest.keywords = [...new Set([...(manifest.keywords || []), query])];
  manifest.blocks[0].type = blockType;
  manifest.blocks[0].display_name = query;
  manifest.blocks[0].category = category;
  manifest.blocks[0].keywords = [...new Set([...(manifest.blocks[0].keywords || []), query])];
  writeJson(path.join(packageRoot, 'ck-blocks.json'), manifest);

  const blocks = JSON.parse(fs.readFileSync(path.join(packageRoot, 'blocks', 'blocks.json'), 'utf8'));
  blocks[0].type = blockType;
  blocks[0].message0 = `${query} %1`;
  writeJson(path.join(packageRoot, 'blocks', 'blocks.json'), blocks);

  const generator = JSON.parse(fs.readFileSync(path.join(packageRoot, 'blocks', 'ck-generator.json'), 'utf8'));
  generator.rules[0].type = blockType;
  writeJson(path.join(packageRoot, 'blocks', 'ck-generator.json'), generator);
  fs.writeFileSync(path.join(packageRoot, 'blocks', 'toolbox.xml'), `<category name="${category}" colour="#E05263"><block type="${blockType}"></block></category>\n`, 'utf8');
  return { packageId, blockType, query, category, displayName, packageRoot };
}

function createLegacyFixture(tempRoot) {
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const packageId = `ck_native_legacy_${token}`;
  const blockType = `ck_native_legacy_block_${token}`;
  const packageRoot = path.join(tempRoot, packageId);
  fs.mkdirSync(path.join(packageRoot, 'blocks'), { recursive: true });
  writeJson(path.join(packageRoot, 'library.json'), {
    id: packageId,
    name: `CK Native Legacy ${token}`,
    version: '1.0.0',
    description: 'Must be rejected by the production import gate.',
    author: 'CK Native Smoke',
    architectures: ['*'],
  });
  writeJson(path.join(packageRoot, 'ck-blocks.json'), {
    schema_version: 1,
    id: packageId,
    display_name: `CK Native Legacy ${token}`,
    description: 'Executable JavaScript must remain disabled.',
    compatibility: { boards: ['*'], architectures: ['*'] },
    entrypoints: { blocks: 'blocks/blocks.js', generator: 'blocks/generator.js', toolbox: 'blocks/toolbox.xml' },
    blocks: [{ type: blockType, display_name: 'Legacy sentinel', description: 'Never executes.', category: 'Legacy' }],
  });
  const sentinel = `__ckNativeLegacySentinel_${token}`;
  fs.writeFileSync(path.join(packageRoot, 'blocks', 'blocks.js'), `globalThis.${sentinel} = 'executed';\n`, 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'blocks', 'generator.js'), `globalThis.${sentinel} = 'generator-executed';\n`, 'utf8');
  fs.writeFileSync(path.join(packageRoot, 'blocks', 'toolbox.xml'), `<category name="Legacy"><block type="${blockType}"></block></category>\n`, 'utf8');
  return { packageId, packageRoot, sentinel };
}

function qualityReportComplete(library, expectedId) {
  const report = library?.quality_report;
  const activation = library?.runtime_activation;
  const consumers = Array.isArray(report?.validated_consumers) ? report.validated_consumers : [];
  return Boolean(
    report && report.schema_version === 2 && report.package_kind === 'block-library'
      && report.package_id === expectedId && ['passed', 'passed_with_warnings'].includes(report.status)
      && report.error_count === 0 && /^[0-9a-f]{64}$/i.test(String(report.source_content_sha256 || ''))
      && Array.isArray(report.checks) && report.checks.length >= 8
      && typeof report.validator_id === 'string' && report.validator_id.length > 0
      && typeof report.validator_version === 'string' && report.validator_version.length > 0
      && typeof report.ruleset_version === 'string' && report.ruleset_version.length > 0
      && /^[0-9a-f]{64}$/i.test(String(report.contract_sha256 || ''))
      && ['import-gate', 'runtime-loader', 'block-catalog'].every((item) => consumers.includes(item))
      && activation?.state === 'declarative-safe' && activation?.executablePresent === false
  );
}

async function openLibraryManager() {
  await openWorkspaceEntry('\u5e93\u7ba1\u7406\u5668', '\u5e93\u7ba1\u7406\u5668', '[aria-labelledby="library-manager-title"]');
}

async function closeLibraryManager() {
  await evaluate(`document.querySelector('button[aria-label="\u5173\u95ed\u5e93\u7ba1\u7406\u5668"]')?.click()`);
  await waitFor(() => evaluate(`!document.querySelector('[aria-labelledby="library-manager-title"]')`), 3000, 'library manager close');
}

async function triggerLibraryManagerRefresh() {
  const refreshed = await evaluate(`(() => {
    const dialog = document.querySelector('[aria-labelledby="library-manager-title"]');
    const button = [...(dialog?.querySelectorAll('button') || [])].find((item) => item.textContent.trim() === '\u5237\u65b0');
    button?.click();
    return Boolean(button);
  })()`);
  if (!refreshed) throw new Error('Library manager refresh action is unavailable.');
}

async function refreshLibraryContextAndAssertPresent(packageInfo) {
  await ensureExpectedWorkspace();
  await openLibraryManager();
  await waitFor(
    () => evaluate(`document.querySelector('[aria-labelledby="library-manager-title"]')?.textContent.includes(${JSON.stringify(packageInfo.displayName)})`),
    12000,
    'imported declarative package in library manager',
    250,
  );
  await triggerLibraryManagerRefresh();
  await waitFor(
    () => evaluate(`Boolean(window.CK_BLOCK_CATALOG?.blocks?.some((item) => item.type === ${JSON.stringify(packageInfo.blockType)}))`),
    12000,
    'imported declarative block in catalog after explicit library refresh',
    250,
  );
  await closeLibraryManager();
}

async function exerciseThirdPartyPackages(cleanup) {
  const safe = createDeclarativeFixture(cleanup.tempRoot);
  const legacy = createLegacyFixture(cleanup.tempRoot);
  cleanup.safePackageId = safe.packageId;
  cleanup.legacyPackageId = legacy.packageId;
  await evaluate(`delete globalThis[${JSON.stringify(legacy.sentinel)}]`);

  const importedId = await invoke('import_extension', {
    path: safe.packageRoot,
    fqbn: expectedFqbn,
    boardPackageId: expectedBoardPackageId,
  });
  if (importedId !== safe.packageId) throw new Error('Declarative package import returned the wrong identity.');
  const libraries = await invoke('get_all_libraries', { board: expectedFqbn, boardPackageId: expectedBoardPackageId });
  const installed = libraries.find((item) => item.id === safe.packageId);
  if (!installed || !qualityReportComplete(installed, safe.packageId)) {
    throw new Error('Declarative package does not have a complete trusted quality/runtime report.');
  }
  cleanup.safeInstalledPath = installed.path;
  const qualityCheckCount = installed.quality_report.checks.length;

  await refreshLibraryContextAndAssertPresent(safe);
  const importedSearch = await searchBlocks(safe.query, `\u6765\u6e90 \u00b7 ${safe.category}`);

  let legacyError = '';
  try {
    await invoke('import_extension', {
      path: legacy.packageRoot,
      fqbn: expectedFqbn,
      boardPackageId: expectedBoardPackageId,
    });
  } catch (error) {
    legacyError = String(error || '');
  }
  if (!legacyError || !/(legacy|javascript|executable|disabled)/i.test(legacyError)) {
    throw new Error('Legacy JavaScript package was not rejected by the import quality gate.');
  }
  const afterLegacy = await invoke('get_all_libraries', { board: expectedFqbn, boardPackageId: expectedBoardPackageId });
  const legacyPresent = afterLegacy.some((item) => item.id === legacy.packageId);
  const sentinelExecuted = await evaluate(`globalThis[${JSON.stringify(legacy.sentinel)}] != null`);
  if (legacyPresent || sentinelExecuted) throw new Error('Legacy JavaScript package escaped fail-closed isolation.');

  return {
    qualityCheckCount,
    runtimeSafe: installed.runtime_activation.state === 'declarative-safe',
    importedSearchResultCount: importedSearch.state.resultCount,
    importedSourceMatched: true,
    legacyRejected: true,
    legacyAbsent: !legacyPresent,
    sentinelNotExecuted: !sentinelExecuted,
  };
}

function readCkToolProcessSnapshot() {
  if (!Number.isInteger(ckRootPid) || ckRootPid <= 0) {
    throw new Error('The unknown-block guard requires the exact CK root process ID.');
  }
  const script = String.raw`
$ErrorActionPreference = 'Stop'
$rootId = [uint32]${ckRootPid}
$all = @(Get-CimInstance Win32_Process)
$ids = [System.Collections.Generic.HashSet[uint32]]::new()
[void]$ids.Add($rootId)
do {
  $added = $false
  foreach ($item in $all) {
    if ($ids.Contains([uint32]$item.ParentProcessId) -and $ids.Add([uint32]$item.ProcessId)) { $added = $true }
  }
} while ($added)
$tools = @($all | Where-Object {
  $ids.Contains([uint32]$_.ProcessId) -and (
    [string]$_.Name -match '(?i)^(arduino-cli|ccache|esptool|avrdude|openocd|ninja|cmake|make)\.exe$' -or
    [string]$_.Name -match '(?i)(?:^|-)(?:gcc|g\+\+|cc1|cc1plus|collect2|ld|ar)\.exe$' -or
    ([string]$_.Name -match '(?i)^(python|python3|py)\.exe$' -and [string]$_.CommandLine -match '(?i)(?:esptool|elf2image)')
  )
} | ForEach-Object { [ordered]@{ processId = [int]$_.ProcessId; name = [string]$_.Name } })
[ordered]@{ capturedAt = [DateTimeOffset]::UtcNow.ToString('o'); tools = @($tools) } |
  ConvertTo-Json -Depth 3 -Compress
`;
  const raw = execFileSync(
    'powershell.exe',
    ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script],
    { encoding: 'utf8', windowsHide: true, timeout: 20000 },
  ).trim();
  const snapshot = JSON.parse(raw || '{}');
  return {
    capturedAt: String(snapshot.capturedAt || ''),
    tools: Array.isArray(snapshot.tools) ? snapshot.tools : [],
  };
}

async function waitForCkToolProcessQuiescence() {
  return waitFor(
    () => {
      const snapshot = readCkToolProcessSnapshot();
      return snapshot.tools.length === 0 ? snapshot : false;
    },
    180000,
    'CK toolchain process quiescence before protected actions',
    500,
  );
}

async function installUnknownGuardUiTracker() {
  const installed = await evaluate(`(() => {
    if (window.__ckUnknownGuardUiTracker) return false;
    const state = {
      overlayObserved: false,
      compileBusyObserved: false,
      uploadBusyObserved: false,
      cancelObserved: false,
    };
    const sample = () => {
      state.overlayObserved ||= Boolean(document.querySelector('[data-ck-role="compile-progress-overlay"]'));
      state.compileBusyObserved ||= Boolean(document.querySelector('[data-ck-role="build-compile-action"]')?.disabled);
      state.uploadBusyObserved ||= Boolean(document.querySelector('[data-ck-role="build-normal-upload-action"]')?.disabled);
      state.cancelObserved ||= Boolean(document.querySelector('[data-ck-role="build-cancel-action"]'));
    };
    const observer = new MutationObserver(sample);
    observer.observe(document.documentElement, {
      subtree: true,
      childList: true,
      attributes: true,
      attributeFilter: ['disabled'],
    });
    window.__ckUnknownGuardUiTracker = { state, observer };
    sample();
    return true;
  })()`);
  if (!installed) throw new Error('Unknown-block UI guard tracker could not be installed.');
}

async function readAndRemoveUnknownGuardUiTracker() {
  return evaluate(`(() => {
    const tracker = window.__ckUnknownGuardUiTracker;
    if (!tracker) return null;
    tracker.observer.disconnect();
    const result = { ...tracker.state };
    delete window.__ckUnknownGuardUiTracker;
    return result;
  })()`);
}

async function assertProtectedBuildUiIdle(phase) {
  const state = await evaluate(`(() => ({
    overlayPresent: Boolean(document.querySelector('[data-ck-role="compile-progress-overlay"]')),
    compileBusy: Boolean(document.querySelector('[data-ck-role="build-compile-action"]')?.disabled),
    uploadBusy: Boolean(document.querySelector('[data-ck-role="build-normal-upload-action"]')?.disabled),
    cancelPresent: Boolean(document.querySelector('[data-ck-role="build-cancel-action"]')),
  }))()`);
  if (state.overlayPresent || state.compileBusy || state.uploadBusy || state.cancelPresent) {
    throw new Error(`Unknown-block protected action entered build UI state at ${phase}: ${JSON.stringify(state)}`);
  }
  return state;
}

async function createUnknownProject(cleanup) {
  const roots = await invoke('get_project_roots');
  const root = (Array.isArray(roots) ? roots : []).find((item) => typeof item === 'string' && fs.existsSync(item) && fs.statSync(item).isDirectory());
  if (!root) throw new Error('No writable project root is available for the unknown-block fixture.');
  const token = crypto.randomUUID().replaceAll('-', '').slice(0, 16);
  const name = `ck_native_unknown_${token}`;
  const projectPath = path.join(root, `${name}.maker`);
  const unknownType = `ck_native_unknown_block_${token}`;
  const workspace = JSON.stringify({
    blocks: {
      languageVersion: 0,
      blocks: [{ type: unknownType, id: `unknown_${token}`, x: 40, y: 40 }],
    },
  });
  await invoke('save_project_as', {
    targetPath: projectPath,
    sourcePath: null,
    xml: workspace,
    code: `// protected-${token}\n`,
    board: expectedBaseFqbn,
    options: JSON.stringify({ FlashSize: '16M', PartitionScheme: 'app3M_fat9M_16MB' }),
    boardPackageId: expectedBoardPackageId,
    blockPackageInventory: null,
  });
  cleanup.unknownProject = { name, path: projectPath };
  const beforeBytes = fs.readFileSync(projectPath);
  const beforeHash = sha256(beforeBytes);
  await ensureDashboard();
  await openProject(name);
  if (!(await expectedPortIsSelected())) {
    throw new Error('The exact serial port was not preserved before the protected normal-upload check.');
  }
  const protection = await waitFor(
    () => evaluate(`(() => {
      const panel = document.querySelector('[data-ck-role="unknown-block-protection"]');
      if (!panel) return false;
      return panel.textContent.includes('\u53ea\u8bfb\u4fdd\u62a4\u6a21\u5f0f') && panel.textContent.includes(${JSON.stringify(unknownType)})
        ? { unknownCount: Number(panel.querySelector('.text-2xl')?.textContent || 0), textVerified: true }
        : false;
    })()`),
    30000,
    'unknown-block read-only protection',
  );
  const processSnapshots = [await waitForCkToolProcessQuiescence()];
  await assertProtectedBuildUiIdle('before-actions');
  await installUnknownGuardUiTracker();
  let savePrompt = false;
  let compilePrompt = false;
  let uploadPrompt = false;
  let uiGuardEvidence = null;
  try {
    const saveClicked = await clickWorkspaceFileAction('\u4fdd\u5b58\u9879\u76ee', '\u4fdd\u5b58\u9879\u76ee');
    if (!saveClicked) throw new Error('Save action is unavailable in the protected workspace.');
    savePrompt = await waitFor(
      () => evaluate(`document.querySelector('[data-ck-role="message-dialog"]')?.textContent.includes('\u5f53\u524d\u5de5\u7a0b\u5904\u4e8e\u4fdd\u62a4\u6a21\u5f0f')`),
      5000,
      'protected save warning',
    );
    await evaluate(`document.querySelector('[data-ck-action="submit-dialog"]')?.click()`);
    await waitFor(() => evaluate(`!document.querySelector('[data-ck-role="message-dialog"]')`), 3000, 'protected save warning close');
    await assertProtectedBuildUiIdle('after-save');
    processSnapshots.push(readCkToolProcessSnapshot());

    const compileClicked = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="build-compile-action"]');
      button?.click();
      return Boolean(button);
    })()`);
    if (!compileClicked) throw new Error('Compile action is unavailable in the protected workspace.');
    compilePrompt = await waitFor(
      () => evaluate(`document.body.textContent.includes('\u5de5\u7a0b\u5904\u4e8e\u53ea\u8bfb\u4fdd\u62a4\u6a21\u5f0f\uff0c\u5df2\u963b\u6b62\u7f16\u8bd1\u548c\u4e0a\u4f20')`),
      3000,
      'protected compile warning',
    );
    await evaluate(`document.querySelector('button[aria-label="\u5173\u95ed\u63d0\u793a"]')?.click()`);
    await waitFor(
      () => evaluate(`!document.body.textContent.includes('\u5de5\u7a0b\u5904\u4e8e\u53ea\u8bfb\u4fdd\u62a4\u6a21\u5f0f\uff0c\u5df2\u963b\u6b62\u7f16\u8bd1\u548c\u4e0a\u4f20')`),
      3000,
      'protected compile warning dismissal',
    );
    await assertProtectedBuildUiIdle('after-compile');
    processSnapshots.push(readCkToolProcessSnapshot());
    const uploadClicked = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="build-normal-upload-action"]');
      button?.click();
      return Boolean(button);
    })()`);
    if (!uploadClicked) throw new Error('Normal upload action is unavailable in the protected workspace.');
    uploadPrompt = await waitFor(
      () => evaluate(`document.body.textContent.includes('\u5de5\u7a0b\u5904\u4e8e\u53ea\u8bfb\u4fdd\u62a4\u6a21\u5f0f\uff0c\u5df2\u963b\u6b62\u7f16\u8bd1\u548c\u4e0a\u4f20')`),
      3000,
      'protected upload warning',
    );
    await assertProtectedBuildUiIdle('after-upload');
    processSnapshots.push(readCkToolProcessSnapshot());
    uiGuardEvidence = await readAndRemoveUnknownGuardUiTracker();
    const observedTools = processSnapshots.flatMap((snapshot) => snapshot.tools || []);
    if (!savePrompt || !compilePrompt || !uploadPrompt
      || !uiGuardEvidence
      || uiGuardEvidence.overlayObserved
      || uiGuardEvidence.compileBusyObserved
      || uiGuardEvidence.uploadBusyObserved
      || uiGuardEvidence.cancelObserved
      || observedTools.length !== 0) {
      throw new Error(`Unknown-block action guard evidence failed: ${JSON.stringify({
        savePrompt: Boolean(savePrompt),
        compilePrompt: Boolean(compilePrompt),
        uploadPrompt: Boolean(uploadPrompt),
        uiGuardEvidence,
        observedToolProcessCount: observedTools.length,
      })}`);
    }
  } finally {
    if (!uiGuardEvidence) await readAndRemoveUnknownGuardUiTracker().catch(() => undefined);
  }
  const afterBytes = fs.readFileSync(projectPath);
  const afterHash = sha256(afterBytes);
  if (!beforeBytes.equals(afterBytes) || beforeHash !== afterHash) {
    throw new Error('Unknown-block project bytes changed after protected actions.');
  }
  await captureHorizontalOverflow('unknown-block protection');
  return {
    unknownCount: protection.unknownCount || 1,
    savePrompt: Boolean(savePrompt),
    compilePrompt: Boolean(compilePrompt),
    uploadPrompt: Boolean(uploadPrompt),
    protectionPromptCount: [savePrompt, compilePrompt, uploadPrompt].filter(Boolean).length,
    buildUiBusyObserved: false,
    compileProgressOverlayObserved: false,
    observedToolProcessCount: 0,
    byteSize: beforeBytes.length,
    bytesPreserved: true,
  };
}

async function refreshLibraryContextAndAssertAbsent(packageIds) {
  await ensureExpectedWorkspace();
  await openLibraryManager();
  await triggerLibraryManagerRefresh();
  await waitFor(
    () => evaluate(`!window.CK_BLOCK_CATALOG?.blocks?.some((item) => ${JSON.stringify(packageIds)}.some((id) => item.library_id === id))`),
    12000,
    'removed packages absent from block catalog',
    250,
  );
  await closeLibraryManager();
}

async function cleanupNativeFixtures(cleanup, originalThemeMode) {
  const failures = [];
  const attempt = async (label, action) => {
    try { await action(); } catch (error) { failures.push(`${label}: ${String(error)}`); }
  };
  await attempt('close native dialogs', async () => {
    await evaluate(`(() => {
      document.querySelector('[data-ck-action="submit-dialog"]')?.click();
      document.querySelector('button[aria-label="\u6682\u4e0d\u5904\u7406\u6062\u590d\u7a3f"]')?.click();
      document.querySelector('button[aria-label="\u5173\u95ed\u5de5\u7a0b\u68c0\u67e5\u70b9"]')?.click();
      document.querySelector('button[aria-label="\u5173\u95ed\u4e0a\u4e00\u4e2a\u53ef\u7528\u7248\u672c"]')?.click();
      document.querySelector('button[aria-label="\u5173\u95ed\u5e93\u7ba1\u7406\u5668"]')?.click();
      document.querySelector('button[aria-label="\u5173\u95ed\u677f\u5361\u8bbe\u7f6e"]')?.click();
      document.querySelector('button[aria-label="\u5173\u95ed\u5de5\u7a0b\u5b58\u50a8\u4f4d\u7f6e"]')?.click();
      document.querySelector('.ck-toolbox-search-clear')?.click();
    })()`);
  });
  if (cleanup.recoveryDraft) {
    await attempt('delete unique recovery draft', () => invoke('delete_recovery_draft', {
      projectPath: cleanup.recoveryDraft.projectPath,
      draftId: cleanup.recoveryDraft.id,
    }));
  }
  await attempt('return to dashboard before fixture deletion', ensureDashboard);
  if (cleanup.unknownProject) {
    await attempt('delete unique unknown-block project', () => invoke('delete_project', { path: cleanup.unknownProject.path }));
  }
  const installed = await invoke('get_all_libraries', { board: expectedFqbn, boardPackageId: expectedBoardPackageId }).catch((error) => {
    failures.push(`list cleanup libraries: ${String(error)}`);
    return [];
  });
  for (const id of [cleanup.safePackageId, cleanup.legacyPackageId].filter(Boolean)) {
    const library = installed.find((item) => item.id === id);
    if (!library) continue;
    await attempt(`delete package ${id}`, () => invoke('delete_library', {
      id,
      board: expectedBaseFqbn,
      path: library.path,
    }));
  }
  if (cleanup.tempRoot) {
    await attempt('remove temporary package sources', async () => fs.rmSync(cleanup.tempRoot, { recursive: true, force: true }));
  }
  await attempt('restore original theme', async () => {
    await ensureDashboard();
    await selectThemeMode(originalThemeMode);
  });
  await attempt('restore expected workspace', ensureExpectedWorkspace);
  if (cleanup.safePackageId || cleanup.legacyPackageId) {
    await attempt('refresh package catalog after cleanup', () => refreshLibraryContextAndAssertAbsent(
      [cleanup.safePackageId, cleanup.legacyPackageId].filter(Boolean),
    ));
  }
  await attempt('verify fixture absence', async () => {
    const libraries = await invoke('get_all_libraries', { board: expectedFqbn, boardPackageId: expectedBoardPackageId });
    if ([cleanup.safePackageId, cleanup.legacyPackageId].filter(Boolean).some((id) => libraries.some((item) => item.id === id))) {
      throw new Error('A temporary package remains installed.');
    }
    if (cleanup.recoveryDraft) {
      const drafts = await invoke('list_recovery_drafts', { projectPath: cleanup.recoveryDraft.projectPath });
      if (drafts.some((item) => item.id === cleanup.recoveryDraft.id)) throw new Error('The unique recovery draft remains.');
    }
    if (cleanup.unknownProject && fs.existsSync(cleanup.unknownProject.path)) throw new Error('The unknown-block fixture project remains.');
    if (cleanup.tempRoot && fs.existsSync(cleanup.tempRoot)) throw new Error('Temporary package source directory remains.');
    const identity = await currentWorkspaceIdentity();
    if (!projectNames(expectedProject).includes(identity.name)) throw new Error('Final workspace is not the expected C6 project.');
  });
  await attempt('final horizontal overflow check', () => captureHorizontalOverflow('final restored workspace'));
  if (failures.length) throw new Error(`Native smoke cleanup failed: ${failures.join(' | ')}`);
  return {
    themeRestored: true,
    declarativePackageRemoved: true,
    legacyPackageAbsent: true,
    recoveryDraftRemoved: true,
    unknownProjectRemoved: true,
    temporarySourcesRemoved: true,
    finalProjectRestored: true,
  };
}

function passedCheck(id) {
  return { id, passed: true };
}

socket.on('open', async () => {
  let runFailure = null;
  let measurements = null;
  let cleanupResult = null;
  const cleanup = {
    tempRoot: fs.mkdtempSync(path.join(os.tmpdir(), 'ck-native-product-smoke-')),
    safePackageId: '',
    legacyPackageId: '',
    safeInstalledPath: '',
    recoveryDraft: null,
    unknownProject: null,
  };
  let originalThemeMode = 'system';
  try {
    await restoreNativeViewport(call);
    const runtime = await evaluate(`(() => ({
      tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
      viewport: { width: innerWidth, height: innerHeight },
      emulationMarker: Boolean(window.__ckNativeViewportEmulation),
    }))()`);
    if (!runtime.tauri) throw new Error('The page is not running inside native Tauri.');
    if (runtime.emulationMarker) throw new Error('Viewport emulation is forbidden for production native evidence.');
    originalThemeMode = await evaluate(`document.querySelector('.app-root')?.dataset.themeMode || 'system'`);

    await ensureDashboard();
    await captureHorizontalOverflow('dashboard');
    const systemPaths = await inspectSystemPaths();
    const themes = await exerciseThemes(originalThemeMode);
    const firstWorkspace = await openProject(expectedProject);
    await ensureDashboard();
    const secondWorkspace = await openProject(expectedProject);
    const roundtrip = projectNames(expectedProject).includes(firstWorkspace.name)
      && projectNames(expectedProject).includes(secondWorkspace.name);
    if (!roundtrip) throw new Error('Dashboard/workspace roundtrip did not preserve the exact project identity.');

    const portSelection = await selectExpectedPort();
    const board = await inspectBoardConfig();
    const healthCompile = await compileForHealthEvidence();
    const health = await inspectEngineeringHealth();
    const builtinSearch = await searchBlocks(builtinQuery, expectedBuiltinSource);
    const entries = await inspectRecoveryEntries();
    const recoveryDraft = await createAndOpenRecoveryDraft(cleanup);
    const packages = await exerciseThirdPartyPackages(cleanup);
    const unknown = await createUnknownProject(cleanup);

    measurements = {
      runtime,
      systemPaths,
      themes,
      roundtrip,
      portSelection,
      board,
      healthCompile,
      health,
      builtinSearch,
      entries,
      recoveryDraft,
      packages,
      unknown,
    };
  } catch (error) {
    runFailure = error;
  }

  try {
    cleanupResult = await cleanupNativeFixtures(cleanup, originalThemeMode);
  } catch (error) {
    if (runFailure) {
      runFailure = new Error(`Native smoke failed: ${String(runFailure)}; cleanup also failed: ${String(error)}`);
    } else {
      runFailure = error;
    }
  }

  try {
    if (runFailure) throw runFailure;
    const checks = [
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
      'no-horizontal-overflow',
      'cleanup-restored-final-state',
    ].map(passedCheck);
    const report = {
      schemaVersion: 3,
      test_id: 'ck-production-native-editor-smoke-v1',
      status: 'passed',
      capturedAt: new Date().toISOString(),
      project: {
        requested_name: expectedProject,
        fqbn: expectedFqbn,
      },
      checks,
      failures: [],
      metrics: {
        system_path_count: measurements.systemPaths.count,
        existing_system_path_count: measurements.systemPaths.existingCount,
        system_path_complete_count: measurements.systemPaths.completeCount,
        catalog_count: measurements.builtinSearch.state.catalogCount,
        builtin_search_result_count: measurements.builtinSearch.state.resultCount,
        builtin_source_label_count: measurements.builtinSearch.state.sourceLabels.length,
        package_quality_check_count: measurements.packages.qualityCheckCount,
        imported_search_result_count: measurements.packages.importedSearchResultCount,
        unknown_block_count: measurements.unknown.unknownCount,
        protected_project_bytes: measurements.unknown.byteSize,
        resource_panel_present: measurements.health.resourcePresent,
        expected_port_selected: measurements.portSelection.selected,
        maximum_horizontal_overflow: maximumHorizontalOverflow,
      },
      cleanup: cleanupResult,
    };
    const serialized = JSON.stringify(report);
    if (/(?:file:\/\/\/)?[a-z]:[\\/]/i.test(serialized)
        || /\b(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}\b/i.test(serialized)
        || /\b[0-9a-f]{12}\b/i.test(serialized)) {
      throw new Error('Native smoke report contains an absolute path or complete MAC address.');
    }
    fs.mkdirSync(path.dirname(outputPath), { recursive: true });
    const temporary = `${outputPath}.${process.pid}.${Date.now()}.tmp`;
    try {
      fs.writeFileSync(temporary, `${JSON.stringify(report, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
      fs.renameSync(temporary, outputPath);
    } finally {
      try { fs.unlinkSync(temporary); } catch (error) {
        if (error?.code !== 'ENOENT') throw error;
      }
    }
    process.stdout.write(`${JSON.stringify({ status: report.status, checkCount: checks.length, metrics: report.metrics }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
'@

    $nodeScriptPath = Join-Path ([System.IO.Path]::GetTempPath()) (
        'ck-native-editor-{0}.js' -f ([Guid]::NewGuid().ToString('N'))
    )
    try {
        $nodeScriptBytes = [System.Text.UTF8Encoding]::new($false).GetBytes($nodeScript)
        $nodeScriptStream = [System.IO.File]::Open(
            $nodeScriptPath,
            [System.IO.FileMode]::CreateNew,
            [System.IO.FileAccess]::Write,
            [System.IO.FileShare]::None
        )
        try {
            $nodeScriptStream.Write($nodeScriptBytes, 0, $nodeScriptBytes.Length)
        }
        finally {
            $nodeScriptStream.Dispose()
        }
        Push-Location $desktop
        try {
            & node $nodeScriptPath
            $nodeExitCode = $LASTEXITCODE
        }
        finally {
            Pop-Location
        }
        if ($nodeExitCode -ne 0) { throw "Production native editor smoke failed with exit code $nodeExitCode." }
    }
    finally {
        if ($nodeScriptPath -and [System.IO.File]::Exists($nodeScriptPath)) {
            [System.IO.File]::Delete($nodeScriptPath)
        }
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
