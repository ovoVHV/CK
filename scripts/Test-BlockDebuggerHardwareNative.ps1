param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM8',
    [string]$ProjectName = 's3',
    [string]$ProjectPath = '',
    [string]$ExpectedFqbn = 'esp32:esp32:esp32s3',
    [string]$ExpectedCompileFqbn = '',
    [string]$BoardOptionsJson = '',
    [string]$BoardFlashSize = '',
    [string]$BoardPartitionScheme = '',
    [string]$BoardPsram = '',
    [string]$ExpectedFlashSize = '4M',
    [string]$ExpectedPartitionScheme = 'default',
    [string]$ExpectedPsram = 'disabled',
    [string]$ExpectedProgramLimit = '1.25 MB',
    [ValidateSet('smaller', 'match', 'larger', 'none')]
    [string]$ExpectedFlashAssessment = 'smaller',
    [switch]$AllowColdFirstCycle,
    [string]$BreakpointId = 'QhB.58W$:+PyX|=cf#ad'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
if ([string]::IsNullOrWhiteSpace($ProjectPath)) {
    throw 'Pass -ProjectPath with a local CK project to run the native hardware test.'
}
$targets = @(Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list")
$target = $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
if (-not $target.webSocketDebuggerUrl) {
    throw "No debuggable native CK window was found on port $DebugPort."
}

$env:CK_CDP_URL = $target.webSocketDebuggerUrl
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_DESKTOP_NODE_MODULES = Join-Path $Root 'apps/desktop/node_modules'
$env:CK_NATIVE_PORT = $Port
$env:CK_NATIVE_PROJECT_NAME = $ProjectName
$env:CK_NATIVE_PROJECT_PATH = $ProjectPath
$env:CK_NATIVE_FQBN = $ExpectedFqbn
$env:CK_NATIVE_COMPILE_FQBN = $ExpectedCompileFqbn
$requestedBoardOptions = [ordered]@{}
if ($BoardFlashSize) { $requestedBoardOptions.FlashSize = $BoardFlashSize }
if ($BoardPartitionScheme) { $requestedBoardOptions.PartitionScheme = $BoardPartitionScheme }
if ($BoardPsram) { $requestedBoardOptions.PSRAM = $BoardPsram }
$env:CK_NATIVE_BOARD_OPTIONS = if ($BoardOptionsJson) {
    $BoardOptionsJson
} elseif ($requestedBoardOptions.Count -gt 0) {
    $requestedBoardOptions | ConvertTo-Json -Compress
} else {
    ''
}
$env:CK_EXPECTED_FLASH_SIZE = $ExpectedFlashSize
$env:CK_EXPECTED_PARTITION = $ExpectedPartitionScheme
$env:CK_EXPECTED_PSRAM = $ExpectedPsram
$env:CK_EXPECTED_PROGRAM_LIMIT = $ExpectedProgramLimit
$env:CK_EXPECTED_FLASH_ASSESSMENT = $ExpectedFlashAssessment
$env:CK_ALLOW_COLD_FIRST_CYCLE = if ($AllowColdFirstCycle) { 'true' } else { 'false' }
$env:CK_NATIVE_BREAKPOINT_ID = $BreakpointId

$nodeScript = @'
const path = require('node:path');
const fs = require('node:fs');
const os = require('node:os');
const crypto = require('node:crypto');
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

const normalizedButtonExpression = (text, enabledOnly = true) => `(() => {
  const target = ${JSON.stringify(text)};
  const button = [...document.querySelectorAll('button')].find((item) =>
    item.textContent.replace(/\\s+/g, '') === target && ${enabledOnly ? '!item.disabled' : 'true'}
  );
  return Boolean(button);
})()`;

async function clickButton(text) {
  const clicked = await evaluate(`(() => {
    const target = ${JSON.stringify(text)};
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent.replace(/\\s+/g, '') === target && !item.disabled
    );
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) throw new Error(`Enabled button was not found: ${text}`);
}

async function clickButtonStartingWith(text) {
  const clicked = await evaluate(`(() => {
    const target = ${JSON.stringify(text)};
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent.replace(/\\s+/g, '').startsWith(target) && !item.disabled
    );
    button?.click();
    return Boolean(button);
  })()`);
  if (!clicked) throw new Error(`Enabled button was not found: ${text}`);
}

async function dismissChangelog() {
  await evaluate(`(() => {
    const modal = document.querySelector('[data-ck-role="changelog-modal"]');
    if (!modal) return false;
    const button = [...modal.querySelectorAll('button')].find((item) =>
      item.title === '\u5173\u95ed\u66f4\u65b0\u65e5\u5fd7' || item.textContent.includes('\u6211\u77e5\u9053\u4e86')
    );
    button?.click();
    return Boolean(button);
  })()`);
}

async function ensureWorkspace() {
  if (await evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`)) return;
  await dismissChangelog();
  const projectName = process.env.CK_NATIVE_PROJECT_NAME || 's3';
  const projectPath = process.env.CK_NATIVE_PROJECT_PATH || '';
  await waitFor(`(() => {
    const byPath = [...document.querySelectorAll('[title]')]
      .find((item) => item.getAttribute('title')?.toLowerCase() === ${JSON.stringify(projectPath.toLowerCase())});
    const byName = [...document.querySelectorAll('h3[title]')]
      .find((item) => item.getAttribute('title') === ${JSON.stringify(projectName)});
    return Boolean(byPath || byName);
  })()`, 30000, 'S3 project on the native dashboard');
  const opened = await evaluate(`(() => {
    const byPath = [...document.querySelectorAll('[title]')]
      .find((item) => item.getAttribute('title')?.toLowerCase() === ${JSON.stringify(projectPath.toLowerCase())});
    const byName = [...document.querySelectorAll('h3[title]')]
      .find((item) => item.getAttribute('title') === ${JSON.stringify(projectName)});
    const source = byPath || byName;
    const target = source?.closest('[class*="cursor-pointer"]') || source?.parentElement?.parentElement;
    target?.click();
    return Boolean(target);
  })()`);
  if (!opened) throw new Error('The S3 project card could not be opened.');
  await waitFor(
    `Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`,
    30000,
    'native S3 workspace',
  );
}

async function inspectWorkspace() {
  const expectedFqbn = process.env.CK_NATIVE_FQBN;
  const breakpointId = process.env.CK_NATIVE_BREAKPOINT_ID;
  return evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const workspace = Blockly.getMainWorkspace();
    const block = workspace?.getBlockById(${JSON.stringify(breakpointId)});
    const boardButton = [...document.querySelectorAll('button')]
      .find((item) => item.title?.includes(${JSON.stringify(expectedFqbn)}));
    return {
      tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
      boardTitle: boardButton?.title || '',
      blockCount: workspace?.getAllBlocks(false).length || 0,
      breakpointBlockType: block?.type || '',
      breakpointVisible: Boolean(block?.getSvgRoot()?.classList.contains('ck-block-has-breakpoint')),
      viewport: [innerWidth, innerHeight],
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    };
  })()`);
}

async function selectPort() {
  const port = process.env.CK_NATIVE_PORT || 'COM8';
  if (await evaluate(`Boolean(document.querySelector('button[aria-haspopup="menu"][title=${JSON.stringify(port)}]'))`)) return;

  await evaluate(`(() => {
    const refresh = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5237\u65b0\u4e32\u53e3');
    refresh?.click();
    return Boolean(refresh);
  })()`);
  await wait(700);
  const opened = await evaluate(`(() => {
    const toggle = [...document.querySelectorAll('button[aria-haspopup="menu"]')]
      .find((item) => item.title === '\u9009\u62e9\u4e32\u53e3' || /^COM\\d+$/i.test(item.title));
    toggle?.click();
    return Boolean(toggle);
  })()`);
  if (!opened) throw new Error('The native port selector could not be opened.');
  await waitFor(
    `[...document.querySelectorAll('[role="menu"] button')]
      .some((item) => item.textContent.includes(${JSON.stringify(port)}))`,
    10000,
    `${port} in the native port menu`,
  );
  const selected = await evaluate(`(() => {
    const button = [...document.querySelectorAll('[role="menu"] button')]
      .find((item) => item.textContent.includes(${JSON.stringify(port)}));
    button?.click();
    return Boolean(button);
  })()`);
  if (!selected) throw new Error(`${port} could not be selected.`);
  await waitFor(
    `Boolean(document.querySelector('button[aria-haspopup="menu"][title=${JSON.stringify(port)}]'))`,
    10000,
    `${port} selection acknowledgement`,
  );
}

async function waitForBoardConfiguration() {
  const deadline = Date.now() + 60000;
  let lastState = null;
  while (Date.now() < deadline) {
    lastState = await evaluate(`(() => {
      const button = document.querySelector('[data-ck-role="board-config-button"]');
      return button ? {
        status: button.dataset.ckBoardOptionsStatus || '',
        compatible: button.dataset.ckBoardOptionsCompatible || '',
      } : null;
    })()`);
    if (lastState?.status === 'unverified') {
      throw new Error('Board option schema is unverified; refusing to start hardware compilation.');
    }
    if (lastState?.compatible === 'false') {
      throw new Error('Saved board options are incompatible; refusing to start hardware compilation.');
    }
    if (lastState && ['resolved', 'core-default'].includes(lastState.status)) return lastState;
    await wait(150);
  }
  throw new Error(`Timed out waiting for verified board configuration: ${JSON.stringify(lastState)}`);
}

async function applyRequestedBoardOptions() {
  const raw = process.env.CK_NATIVE_BOARD_OPTIONS || '';
  if (!raw.trim()) return { applied: {}, boardTitle: '' };
  const requested = JSON.parse(raw);
  if (!requested || typeof requested !== 'object' || Array.isArray(requested)) {
    throw new Error('CK_NATIVE_BOARD_OPTIONS must be a JSON object.');
  }

  const opened = await evaluate(`(() => {
    const button = document.querySelector('[data-ck-role="board-config-button"]');
    if (!button || button.disabled) return false;
    button.click();
    return true;
  })()`);
  if (!opened) throw new Error('Board configuration dialog could not be opened.');
  await waitFor(
    `Boolean(document.querySelector('[data-ck-role="board-config-dialog"]'))`,
    5000,
    'board configuration dialog',
  );

  for (const [key, value] of Object.entries(requested)) {
    const result = await evaluate(`(() => {
      const key = ${JSON.stringify(key)};
      const value = ${JSON.stringify(String(value))};
      const dialog = document.querySelector('[data-ck-role="board-config-dialog"]');
      const rows = [...(dialog?.querySelectorAll('select') || [])].map((select) => ({
        select,
        row: select.parentElement,
      }));
      const match = rows.find(({ row }) => [...(row?.querySelectorAll('span') || [])]
        .some((span) => span.textContent.trim() === key));
      if (!match) return { ok: false, reason: 'missing option', key, value };
      if (![...match.select.options].some((option) => option.value === value)) {
        return { ok: false, reason: 'missing value', key, value };
      }
      match.select.value = value;
      match.select.dispatchEvent(new Event('change', { bubbles: true }));
      return { ok: true, key, value };
    })()`);
    if (!result.ok) throw new Error(`Board option could not be applied: ${JSON.stringify(result)}`);
    await wait(100);
  }

  const closed = await evaluate(`(() => {
    const dialog = document.querySelector('[data-ck-role="board-config-dialog"]');
    const button = [...(dialog?.querySelectorAll('button') || [])]
      .find((item) => item.textContent.replace(/\\s+/g, '') === '\u5b8c\u6210' && !item.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  if (!closed) throw new Error('Board configuration dialog could not be closed.');
  await waitFor(
    `!document.querySelector('[data-ck-role="board-config-dialog"]')`,
    5000,
    'board configuration dialog close',
  );
  const boardTitle = await evaluate(
    `document.querySelector('[data-ck-role="board-config-button"]')?.title || ''`,
  );
  return { applied: requested, boardTitle };
}

async function ensureBreakpoint() {
  const breakpointId = process.env.CK_NATIVE_BREAKPOINT_ID;
  const result = await evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const workspace = Blockly.getMainWorkspace();
    const block = workspace?.getBlockById(${JSON.stringify(breakpointId)});
    if (!workspace || !block) return { found: false };
    const initiallyEnabled = block.getSvgRoot()?.classList.contains('ck-block-has-breakpoint') || false;
    let enabled = initiallyEnabled;
    if (!enabled) {
      const item = Blockly.ContextMenuRegistry.registry.getItem('ckBlockBreakpoint');
      if (!item?.callback) return { found: true, enabled: false, initiallyEnabled, menu: false, type: block.type };
      item.callback({ block });
      enabled = true;
    }
    return { found: true, enabled, initiallyEnabled, menu: true, type: block.type };
  })()`);
  if (!result.found) throw new Error(`Breakpoint block is missing: ${breakpointId}`);
  if (!result.enabled || !result.menu) throw new Error(`Breakpoint could not be enabled: ${JSON.stringify(result)}`);
  await waitFor(`(() => {
    const button = [...document.querySelectorAll('button')].find((item) =>
      item.textContent.replace(/\\s+/g, '').startsWith('\u8c03\u8bd5\u4e0a\u4f20') && !item.disabled
    );
    return Boolean(button);
  })()`, 5000, 'enabled debug-upload button');
  return result;
}

async function restoreBreakpointState(initiallyEnabled) {
  const breakpointId = process.env.CK_NATIVE_BREAKPOINT_ID;
  return evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const block = Blockly.getMainWorkspace()?.getBlockById(${JSON.stringify(breakpointId)});
    if (!block) return false;
    const enabled = block.getSvgRoot()?.classList.contains('ck-block-has-breakpoint') || false;
    if (enabled !== ${Boolean(initiallyEnabled)}) {
      const item = Blockly.ContextMenuRegistry.registry.getItem('ckBlockBreakpoint');
      if (!item?.callback) return false;
      item.callback({ block });
    }
    return Boolean(block.getSvgRoot()?.classList.contains('ck-block-has-breakpoint')) === ${Boolean(initiallyEnabled)};
  })()`);
}

async function waitForOperationStart(label) {
  await waitFor(
    `Boolean(document.querySelector('[data-ck-role="compile-progress-overlay"]'))`,
    10000,
    `${label} start`,
  );
}

async function waitForOperationEnd(label, timeoutMs = 720000) {
  await waitFor(
    `(() => {
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const compile = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1');
      return Boolean(!overlay && compile && !compile.disabled);
    })()`,
    timeoutMs,
    `${label} completion`,
    250,
  );
}

async function waitForDebugPhase(phase, timeoutMs, label) {
  return waitFor(
    `document.querySelector('[data-ck-role="block-debug-controls"]')?.dataset.ckDebugPhase === ${JSON.stringify(phase)}`,
    timeoutMs,
    label,
    100,
  );
}

async function waitForFirstDebugPause(cycle, timeoutMs = 720000) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    const state = await evaluate(`(() => {
      const controls = document.querySelector('[data-ck-role="block-debug-controls"]');
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const debugButton = [...document.querySelectorAll('button')].find((item) =>
        item.textContent.replace(/\\s+/g, '').startsWith('\u8c03\u8bd5\u4e0a\u4f20')
      );
      const log = document.querySelector('.ck-console-panel')?.innerText || '';
      return {
        phase: controls?.dataset.ckDebugPhase || '',
        overlay: Boolean(overlay),
        debugReady: Boolean(debugButton && !debugButton.disabled),
        logTail: log.slice(-3000),
      };
    })()`);
    if (state.phase === 'paused') return state;
    if (!state.overlay && !state.phase && state.debugReady) {
      throw new Error(`Debug cycle ${cycle} ended before PAUSED. Log tail:\n${state.logTail}`);
    }
    await wait(200);
  }
  throw new Error(`Timed out waiting for debug cycle ${cycle} first PAUSED.`);
}

async function captureCompileLog() {
  await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.textContent.replace(/\\s+/g, '') === '\u8f93\u51fa\u65e5\u5fd7');
    button?.click();
    return Boolean(button);
  })()`);
  await wait(150);
  return evaluate(`(() => {
    const panel = document.querySelector('.ck-console-panel');
    const text = panel?.innerText || '';
    return text.slice(-50000);
  })()`);
}

function inspectLatestQfastArtifacts() {
  const buildsRoot = path.join(os.tmpdir(), 'CK_Builds');
  const prefix = 'sketch_esp32_esp32_esp32s3';
  const candidates = fs.readdirSync(buildsRoot, { withFileTypes: true })
    .filter((entry) => entry.isDirectory() && entry.name.startsWith(prefix) && entry.name.endsWith('_qfast2'))
    .map((entry) => {
      const fullPath = path.join(buildsRoot, entry.name);
      return { name: entry.name, fullPath, modifiedMs: fs.statSync(fullPath).mtimeMs };
    })
    .sort((left, right) => right.modifiedMs - left.modifiedMs);
  const current = candidates[0];
  if (!current) return { found: false };

  const sourcePath = path.join(current.fullPath, `${current.name}.ino`);
  const source = fs.existsSync(sourcePath) ? fs.readFileSync(sourcePath, 'utf8') : '';
  const buildPath = path.join(current.fullPath, 'build');
  const binaryName = `${current.name}.ino.bin`;
  const binaryPath = path.join(buildPath, binaryName);
  const binary = fs.existsSync(binaryPath) ? fs.readFileSync(binaryPath) : null;
  return {
    found: true,
    buildRoot: current.fullPath,
    sourceBytes: Buffer.byteLength(source),
    sourceHasDebugRuntime: source.includes('__CK_DEBUG_ATTACH_TIMEOUT_MS = 12000UL'),
    sourceSessionIds: [...source.matchAll(/@@CKDBG\|([a-zA-Z0-9_-]{1,40})\|/g)]
      .map((match) => match[1])
      .filter((value, index, values) => values.indexOf(value) === index),
    binaryBytes: binary?.length || 0,
    binarySha256: binary ? crypto.createHash('sha256').update(binary).digest('hex') : '',
    flashArgs: fs.existsSync(path.join(buildPath, 'flash_args'))
      ? fs.readFileSync(path.join(buildPath, 'flash_args'), 'utf8').trim()
      : '',
  };
}

async function inspectResourceBudget() {
  return evaluate(`(() => {
    const panel = document.querySelector('[aria-label="\u7a0b\u5e8f\u7a7a\u95f4\u548c\u5185\u90e8 RAM \u8d44\u6e90\u9884\u7b97"]');
    if (!panel) return null;
    return {
      ariaLabel: panel.getAttribute('aria-label') || '',
      text: panel.innerText || '',
      titles: [...panel.querySelectorAll('[title]')].map((item) => item.getAttribute('title') || ''),
    };
  })()`);
}

function assertFastRelinkLog(log, cycle) {
  const failures = [];
  const acceptedColdShared = cycle === 1
    && process.env.CK_ALLOW_COLD_FIRST_CYCLE === 'true'
    && /Upload:\s*QuickFast cache cold/i.test(log)
    && /Upload Profile:\s*shared-fast \(artifacts verified\)/i.test(log);
  if (!acceptedColdShared) {
    if (!log.includes('Fast Relink path: sketch-only compile + direct link')) {
      failures.push('sketch-only Fast Relink path was not reported');
    }
    if (!/Fast Relink artifact recipes: resolved(?: and gated)? full ESP32 platform recipes/i.test(log)) {
      failures.push('full ESP32 artifact recipes were not used');
    }
  } else if (/Falling back to release|release-fallback|Build failed/i.test(log)) {
    failures.push('cold shared-fast upload unexpectedly fell back or reported a build failure');
  }
  if (/Trying shared-fast/i.test(log)) failures.push('unexpected shared-fast fallback occurred');
  if (/fatal error:.*avr[\\/]pgmspace\.h/i.test(log)) failures.push('AVR header leaked into ESP32 compilation');
  if (!acceptedColdShared && /Full Build:/i.test(log)) failures.push('unexpected full dependency rebuild occurred');
  if (/artifact command failed|Fast Relink raw failure/i.test(log)) failures.push('artifact generation failed');
  if (failures.length) {
    const evidence = log.split(/\r?\n/)
      .filter((line) => /Fast Relink|shared-fast|artifact|raw failure|recipe|Target Board|Compile Profile/i.test(line))
      .slice(-80)
      .join('\n');
    throw new Error(`Debug cycle ${cycle}: ${failures.join('; ')}\nRelevant build evidence:\n${evidence}`);
  }
}

async function emitRealBlocklySelection() {
  const breakpointId = process.env.CK_NATIVE_BREAKPOINT_ID;
  return evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const block = Blockly.getMainWorkspace()?.getBlockById(${JSON.stringify(breakpointId)});
    if (!block) return false;
    Blockly.common.setSelected(block);
    return true;
  })()`);
}

async function runDebugCycle(cycle) {
  const startedAt = Date.now();
  await clickButtonStartingWith('\u8c03\u8bd5\u4e0a\u4f20');
  await waitForOperationStart(`debug cycle ${cycle}`);
  try {
    await waitForFirstDebugPause(cycle);
  } catch (error) {
    const failedLog = await captureCompileLog();
    const evidence = failedLog.split(/\r?\n/)
      .filter((line) => /Fast Relink|shared-fast|artifact|raw failure|recipe|Target Board|Compile Profile|upload|serial|READY|ATTACHED|PAUSED|Sketch uses|Global variables|Exact Match|code hash|Compressed|Build Directory/i.test(line))
      .slice(-120)
      .join('\n');
    const artifacts = inspectLatestQfastArtifacts();
    throw new Error(`${error.stack || error}\nRelevant failed-cycle evidence:\n${evidence}\nFailed-cycle artifact inspection:\n${JSON.stringify(artifacts, null, 2)}`);
  }
  const firstPausedMs = Date.now() - startedAt;
  const log = await captureCompileLog();
  assertFastRelinkLog(log, cycle);

  if (!await emitRealBlocklySelection()) throw new Error('Blockly selection event could not be emitted.');
  await wait(1600);
  const phaseAfterSelection = await evaluate(
    `document.querySelector('[data-ck-role="block-debug-controls"]')?.dataset.ckDebugPhase || ''`,
  );
  if (phaseAfterSelection !== 'paused') {
    throw new Error(`Blockly UI selection terminated debug cycle ${cycle}: ${phaseAfterSelection || 'controls missing'}`);
  }

  await clickButton('\u7ee7\u7eed');
  await waitForDebugPhase('running', 3000, `debug cycle ${cycle} CONTINUE acknowledgement`);
  await waitForDebugPhase('paused', 10000, `debug cycle ${cycle} PAUSED after CONTINUE`);

  await clickButton('\u5355\u6b65');
  await waitForDebugPhase('running', 3000, `debug cycle ${cycle} STEP acknowledgement`);
  await waitForDebugPhase('paused', 10000, `debug cycle ${cycle} PAUSED after STEP`);

  await clickButton('\u7ed3\u675f\u8c03\u8bd5');
  await waitFor(
    `!document.querySelector('[data-ck-role="block-debug-controls"]')`,
    10000,
    `debug cycle ${cycle} STOPPED acknowledgement`,
  );

  return {
    cycle,
    firstPausedMs,
    fastRelinkSeconds: Number(log.match(/Fast Relink completed in ([0-9.]+)s/i)?.[1] || 0),
    compileLockSeconds: Number(log.match(/Compile lock wait:\s*([0-9.]+)s/i)?.[1] || 0),
    dependencyCacheObjects: Number(log.match(/Fast Relink: (?:staged|restored) (\d+) dependency/i)?.[1] || 0),
    selectionGuardPassed: true,
    continuePassed: true,
    stepPassed: true,
    stopPassed: true,
    logTail: log.slice(-5000),
  };
}

async function stopDebugIfNeeded() {
  const present = await evaluate(`Boolean(document.querySelector('[data-ck-role="block-debug-controls"]'))`);
  if (!present) return true;
  await evaluate(`(() => {
    const panel = document.querySelector('[data-ck-role="block-debug-controls"]');
    const button = [...(panel?.querySelectorAll('button') || [])]
      .find((item) => item.textContent.replace(/\\s+/g, '') === '\u7ed3\u675f\u8c03\u8bd5' && !item.disabled);
    button?.click();
    return Boolean(button);
  })()`);
  try {
    await waitFor(
      `!document.querySelector('[data-ck-role="block-debug-controls"]')`,
      10000,
      'cleanup STOPPED acknowledgement',
    );
    return true;
  } catch {
    return false;
  }
}

async function restoreNormalFirmware() {
  if (!await stopDebugIfNeeded()) {
    await evaluate(`location.reload()`);
    await wait(1200);
    await ensureWorkspace();
    await selectPort();
  }
  await waitFor(normalizedButtonExpression('\u666e\u901a\u4e0a\u4f20'), 15000, 'normal-upload button');
  await clickButton('\u666e\u901a\u4e0a\u4f20');
  await waitForOperationStart('normal firmware restoration');
  await waitForOperationEnd('normal firmware restoration');
  const log = await captureCompileLog();
  if (!log.includes('\u666e\u901a\u56fa\u4ef6\u4e0a\u4f20\u6210\u529f')) {
    throw new Error(`Normal firmware restoration was not confirmed. Log tail:\n${log.slice(-3000)}`);
  }
  return log;
}

socket.on('open', async () => {
  const report = {
    fqbn: process.env.CK_NATIVE_FQBN,
    port: process.env.CK_NATIVE_PORT,
    projectPath: process.env.CK_NATIVE_PROJECT_PATH,
    cycles: [],
    normalFirmwareRestored: false,
  };
  let instrumentedUploadStarted = false;
  try {
    await restoreNativeViewport(call);
    await ensureWorkspace();
    await dismissChangelog();
    await selectPort();
    report.boardConfiguration = await waitForBoardConfiguration();
    report.appliedBoardOptions = await applyRequestedBoardOptions();
    const workspace = await inspectWorkspace();
    if (!workspace.tauri) throw new Error('The test is not running inside native Tauri.');
    if (!workspace.boardTitle.includes(process.env.CK_NATIVE_FQBN)) {
      throw new Error(`Unexpected selected board: ${workspace.boardTitle}`);
    }
    if (
      process.env.CK_NATIVE_COMPILE_FQBN
      && !workspace.boardTitle.includes(process.env.CK_NATIVE_COMPILE_FQBN)
    ) {
      throw new Error(`Unexpected configured target: ${workspace.boardTitle}`);
    }
    if (workspace.breakpointBlockType !== 'control_delay') {
      throw new Error(`Unexpected breakpoint fixture: ${JSON.stringify(workspace)}`);
    }
    if (workspace.overflow > 1) throw new Error(`Native workspace has horizontal overflow: ${workspace.overflow}`);
    report.workspace = workspace;
    report.breakpoint = await ensureBreakpoint();

    instrumentedUploadStarted = true;
    report.cycles.push(await runDebugCycle(1));
    report.cycles.push(await runDebugCycle(2));
    report.normalLogTail = (await restoreNormalFirmware()).slice(-5000);
    report.normalFirmwareRestored = true;
    report.resourceBudget = await inspectResourceBudget();
    const resourceEvidence = [
      report.resourceBudget?.ariaLabel || '',
      report.resourceBudget?.text || '',
      ...(report.resourceBudget?.titles || []),
    ].join('\n');
    if (!resourceEvidence.includes('\u7a0b\u5e8f\u7a7a\u95f4') || !resourceEvidence.includes('\u5185\u90e8 RAM')) {
      throw new Error(`Resource budget did not distinguish APP program space and internal RAM: ${resourceEvidence}`);
    }
    const expectedConfiguration = [
      `FlashSize=${process.env.CK_EXPECTED_FLASH_SIZE}`,
      `PartitionScheme=${process.env.CK_EXPECTED_PARTITION}`,
      `PSRAM=${process.env.CK_EXPECTED_PSRAM}`,
    ];
    if (expectedConfiguration.some((item) => !resourceEvidence.includes(item))) {
      throw new Error(`Resource budget did not show the expected memory configuration ${expectedConfiguration.join(', ')}: ${resourceEvidence}`);
    }
    if (!/Flash=16\.0 MB/.test(resourceEvidence)) {
      throw new Error(`Uploader-observed 16MB physical Flash was not shown: ${resourceEvidence}`);
    }
    if (!resourceEvidence.includes(process.env.CK_EXPECTED_PROGRAM_LIMIT)
      || !resourceEvidence.includes('APP \u5206\u533a')) {
      throw new Error(`The expected APP partition limit was not kept separate from physical Flash: ${resourceEvidence}`);
    }
    const assessmentText = {
      smaller: '\u914d\u7f6e\u5bb9\u91cf\u5c0f\u4e8e\u5b9e\u4f53 Flash',
      match: '\u914d\u7f6e Flash \u4e0e\u5b9e\u4f53\u5bb9\u91cf\u5339\u914d',
      larger: '\u914d\u7f6e\u5bb9\u91cf\u5927\u4e8e\u5b9e\u4f53 Flash',
      none: '',
    }[process.env.CK_EXPECTED_FLASH_ASSESSMENT || 'none'];
    if (assessmentText && !resourceEvidence.includes(assessmentText)) {
      throw new Error(`The expected configured Flash assessment was not shown: ${resourceEvidence}`);
    }

    if (report.cycles[1].dependencyCacheObjects <= 0) {
      throw new Error('Second debug cycle did not report dependency-cache reuse.');
    }
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    if (instrumentedUploadStarted && !report.normalFirmwareRestored) {
      try {
        report.normalLogTail = (await restoreNormalFirmware()).slice(-5000);
        report.normalFirmwareRestored = true;
      } catch (cleanupError) {
        process.stderr.write(`CRITICAL cleanup warning: ${cleanupError.stack || cleanupError}\n`);
        process.exitCode = 1;
      }
    }
    if (report.breakpoint) {
      try {
        report.breakpointStateRestored = await restoreBreakpointState(
          Boolean(report.breakpoint.initiallyEnabled),
        );
      } catch (cleanupError) {
        report.breakpointStateRestored = false;
        process.stderr.write(`Breakpoint cleanup warning: ${cleanupError.stack || cleanupError}\n`);
        process.exitCode = 1;
      }
    }
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    socket.close();
  }
});
'@

Push-Location (Join-Path $Root 'apps/desktop')
try {
    $nodeScript | node
    if ($LASTEXITCODE -ne 0) { exit $LASTEXITCODE }
} finally {
    Pop-Location
}
