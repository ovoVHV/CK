param(
    [string]$Root = '',
    [int]$DebugPort = 9223
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$targets = @(Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list")
$target = $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
if (-not $target.webSocketDebuggerUrl) {
    throw "No debuggable CK window was found on port $DebugPort. Start the native Tauri app first."
}

$env:CK_CDP_URL = $target.webSocketDebuggerUrl
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_DESKTOP_NODE_MODULES = Join-Path $Root 'apps/desktop/node_modules'

$nodeScript = @'
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

async function waitFor(expression, timeoutMs, label) {
  const deadline = Date.now() + timeoutMs;
  let lastValue;
  while (Date.now() < deadline) {
    lastValue = await evaluate(expression);
    if (lastValue) return lastValue;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}; last value: ${JSON.stringify(lastValue)}`);
}

const projectPathExpression = `[...document.querySelectorAll('[title]')]
  .map((item) => item.getAttribute('title'))
  .find((value) => value && /\\.maker$/i.test(value)) || ''`;

async function listCheckpoints() {
  return evaluate(`(async () => {
    const projectPath = ${projectPathExpression};
    if (!projectPath) throw new Error('Current .maker project path was not found.');
    return window.__TAURI_INTERNALS__.invoke('list_project_checkpoints', { projectPath });
  })()`);
}

async function workspaceSummary() {
  return evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const workspace = Blockly.getMainWorkspace();
    return {
      exists: Boolean(workspace),
      blockCount: workspace?.getAllBlocks(false).length || 0,
      blockTypes: workspace?.getAllBlocks(false).map((block) => block.type) || [],
    };
  })()`);
}

async function clearWorkspace() {
  await evaluate(`(async () => {
    const blocklyUrl = performance.getEntriesByType('resource')
      .map((entry) => entry.name)
      .find((name) => /\\/deps\\/blockly\\.js/.test(name));
    const Blockly = await import(blocklyUrl);
    const workspace = Blockly.getMainWorkspace();
    if (workspace) {
      workspace.clear();
      Blockly.svgResize(workspace);
    }
  })()`);
}

async function cleanup() {
  await evaluate(`(() => {
    document.querySelector('button[aria-label="\u5173\u95ed\u5de5\u7a0b\u68c0\u67e5\u70b9"]')?.click();
    document.querySelector('button[title="\u6536\u8d77\u63a7\u5236\u53f0"]')?.click();
  })()`);
  const summary = await workspaceSummary();
  if (summary.blockCount > 0) await clearWorkspace();
}

socket.on('open', async () => {
  let report;
  try {
    await restoreNativeViewport(call);
    const nativeState = await evaluate(`(() => ({
      tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
      projectPath: ${projectPathExpression},
      compileReady: Boolean([...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1' && !item.disabled)),
      viewport: [innerWidth, innerHeight],
    }))()`);
    if (!nativeState.tauri) throw new Error('The editor is not running in native Tauri.');
    if (!nativeState.projectPath) throw new Error('No current .maker project path is visible.');
    if (!nativeState.compileReady) throw new Error('The native editor is not ready to compile.');

    const initialWorkspace = await workspaceSummary();
    if (!initialWorkspace.exists) throw new Error('Blockly main workspace is unavailable.');
    if (initialWorkspace.blockCount !== 0) {
      throw new Error(`Expected the regression project to start empty, found ${initialWorkspace.blockCount} block(s).`);
    }

    const beforeCompile = await listCheckpoints();
    const compileClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1' && !item.disabled);
      button?.click();
      return Boolean(button);
    })()`);
    if (!compileClicked) throw new Error('Compile button could not be clicked.');

    await waitFor(
      `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.title === '\u7f16\u8bd1');
        return Boolean(button?.disabled || document.querySelector('[data-ck-role="compile-progress-overlay"]'));
      })()`,
      10000,
      'native compile start',
    );
    await waitFor(
      `(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.title === '\u7f16\u8bd1');
        return Boolean(button && !button.disabled && !document.querySelector('[data-ck-role="compile-progress-overlay"]'));
      })()`,
      300000,
      'native compile completion',
    );

    const afterCompile = await listCheckpoints();
    const compileCheckpoint = afterCompile.find((item) => (
      item.reason === 'before_compile'
      && !beforeCompile.some((previous) => previous.id === item.id)
    ));
    if (!compileCheckpoint) {
      throw new Error(`No new before_compile checkpoint was created: ${JSON.stringify(afterCompile)}`);
    }
    if (compileCheckpoint.blockCount !== 0) {
      throw new Error(`Empty-workspace checkpoint recorded ${compileCheckpoint.blockCount} block(s).`);
    }

    const invalidBlock = await evaluate(`(async () => {
      const blocklyUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\\/deps\\/blockly\\.js/.test(name));
      const Blockly = await import(blocklyUrl);
      const workspace = Blockly.getMainWorkspace();
      workspace.clear();

      const shift = workspace.newBlock('io_shift_out');
      shift.initSvg();
      shift.render();
      const makeNumber = (value) => {
        const block = workspace.newBlock('math_number');
        block.setFieldValue(String(value), 'NUM');
        block.initSvg();
        block.render();
        return block;
      };
      const dataPin = makeNumber(5);
      const clockPin = makeNumber(5);
      const value = makeNumber(1);
      shift.getInput('DATA_PIN').connection.connect(dataPin.outputConnection);
      shift.getInput('CLOCK_PIN').connection.connect(clockPin.outputConnection);
      shift.getInput('VALUE').connection.connect(value.outputConnection);
      shift.moveBy(120, 100);
      Blockly.svgResize(workspace);
      return {
        id: shift.id,
        count: workspace.getAllBlocks(false).length,
        types: workspace.getAllBlocks(false).map((block) => block.type),
      };
    })()`);
    if (invalidBlock.count !== 4) {
      throw new Error(`Invalid-pin fixture did not create four blocks: ${JSON.stringify(invalidBlock)}`);
    }
    await wait(500);

    const beforeBlockedCompile = await listCheckpoints();
    const blockedClick = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1' && !item.disabled);
      button?.click();
      return Boolean(button);
    })()`);
    if (!blockedClick) throw new Error('Compile button was not available for the pin-preflight check.');

    await waitFor(
      `Boolean(document.querySelector('section[aria-label="\u5f15\u811a\u5360\u7528\u4e0e\u7f16\u8bd1\u524d\u4f53\u68c0"]'))`,
      5000,
      'pin-preflight panel',
    );
    const blockedState = await evaluate(`(() => {
      const panel = document.querySelector('section[aria-label="\u5f15\u811a\u5360\u7528\u4e0e\u7f16\u8bd1\u524d\u4f53\u68c0"]');
      const compile = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1');
      return {
        text: panel?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        compileDisabled: Boolean(compile?.disabled),
        progressVisible: Boolean(document.querySelector('[data-ck-role="compile-progress-overlay"]')),
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
      };
    })()`);
    if (!blockedState.text.includes('ShiftOut\u5185\u90e8\u5f15\u811a\u91cd\u590d')) {
      throw new Error(`Deterministic ShiftOut conflict was not shown: ${JSON.stringify(blockedState)}`);
    }
    if (blockedState.compileDisabled || blockedState.progressVisible) {
      throw new Error('Pin preflight did not stop the compile before backend execution.');
    }
    const afterBlockedCompile = await listCheckpoints();
    if (afterBlockedCompile.length !== beforeBlockedCompile.length) {
      throw new Error('A blocked compile unexpectedly created a before_compile checkpoint.');
    }

    const modalOpened = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u5de5\u7a0b\u68c0\u67e5\u70b9');
      button?.click();
      return Boolean(button);
    })()`);
    if (!modalOpened) throw new Error('Project-checkpoint entry was not found.');
    await waitFor(
      `Boolean(document.querySelector('[role="dialog"]'))`,
      5000,
      'project-checkpoint dialog',
    );
    await waitFor(
      `[...document.querySelectorAll('[role="dialog"] article')]
        .some((article) => article.textContent.includes('\u7f16\u8bd1\u524d'))`,
      5000,
      'before-compile checkpoint row',
    );
    const restoreClicked = await evaluate(`(() => {
      const article = [...document.querySelectorAll('[role="dialog"] article')]
        .find((item) => item.textContent.includes('\u7f16\u8bd1\u524d'));
      const button = [...(article?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.trim() === '\u6062\u590d');
      button?.click();
      return Boolean(button);
    })()`);
    if (!restoreClicked) throw new Error('Restore button for the empty before_compile checkpoint was not found.');

    await waitFor(
      `!document.querySelector('[role="dialog"]')`,
      10000,
      'checkpoint restore completion',
    );
    await waitFor(
      `(async () => {
        const blocklyUrl = performance.getEntriesByType('resource')
          .map((entry) => entry.name)
          .find((name) => /\\/deps\\/blockly\\.js/.test(name));
        const Blockly = await import(blocklyUrl);
        return Blockly.getMainWorkspace()?.getAllBlocks(false).length === 0;
      })()`,
      10000,
      'empty workspace after restore',
    );

    const afterRestore = await listCheckpoints();
    const restoreProtection = afterRestore.find((item) => (
      item.reason === 'before_restore'
      && !afterBlockedCompile.some((previous) => previous.id === item.id)
    ));
    if (!restoreProtection) {
      throw new Error(`No before_restore protection checkpoint was created: ${JSON.stringify(afterRestore)}`);
    }
    if (restoreProtection.blockCount !== invalidBlock.count) {
      throw new Error(`Restore protection captured ${restoreProtection.blockCount} blocks instead of ${invalidBlock.count}.`);
    }

    const finalWorkspace = await workspaceSummary();
    report = {
      nativeState,
      compileCheckpoint,
      invalidBlock,
      blockedState,
      restoreProtection,
      finalWorkspace,
      checkpointCount: afterRestore.length,
    };
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await cleanup();
    } catch (cleanupError) {
      process.stderr.write(`Cleanup warning: ${cleanupError.stack || cleanupError}\n`);
      process.exitCode = 1;
    }
    if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    socket.close();
  }
});
'@

$nodeScript | node
if ($LASTEXITCODE -ne 0) {
    throw "Native checkpoint/preflight regression failed with exit code $LASTEXITCODE."
}
