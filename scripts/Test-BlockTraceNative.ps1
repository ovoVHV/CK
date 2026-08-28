param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Port = 'COM5'
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
$env:CK_NATIVE_PORT = $Port

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
      types: workspace?.getAllBlocks(false).map((block) => block.type) || [],
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
    workspace?.clear();
    if (workspace) Blockly.svgResize(workspace);
  })()`);
  await wait(400);
}

async function clickButtonByTitle(title) {
  return evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find((item) => item.title === ${JSON.stringify(title)} && !item.disabled);
    button?.click();
    return Boolean(button);
  })()`);
}

async function waitForOperationStart(label) {
  await waitFor(
    `(() => {
      const compile = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1');
      return Boolean(compile?.disabled || document.querySelector('[data-ck-role="compile-progress-overlay"]'));
    })()`,
    10000,
    `${label} start`,
  );
}

async function waitForOperationEnd(label) {
  await waitFor(
    `(() => {
      const compile = [...document.querySelectorAll('button')]
        .find((item) => item.title === '\u7f16\u8bd1');
      return Boolean(compile && !compile.disabled && !document.querySelector('[data-ck-role="compile-progress-overlay"]'));
    })()`,
    300000,
    `${label} completion`,
  );
}

async function closeSerialAndConsole() {
  await evaluate(`(() => {
    const closeMonitor = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668');
    closeMonitor?.click();
    return Boolean(closeMonitor);
  })()`);
  await wait(350);
  await evaluate(`document.querySelector('button[title="\u6536\u8d77\u63a7\u5236\u53f0"]')?.click()`);
}

socket.on('open', async () => {
  let report;
  let traceWasStarted = false;
  let normalFirmwareRestored = false;
  try {
    await restoreNativeViewport(call);
    const port = process.env.CK_NATIVE_PORT || 'COM5';
    const nativeState = await evaluate(`(() => {
      const boardButton = [...document.querySelectorAll('button')]
        .find((item) => item.title?.startsWith('\u677f\u5361\u8bbe\u7f6e\u4e0e\u7f16\u8bd1\u7f13\u5b58'));
      return {
        tauri: Boolean(window.__TAURI_INTERNALS__?.invoke),
        boardTitle: boardButton?.title || '',
        portSelected: [...document.querySelectorAll('button')]
          .some((item) => item.title === ${JSON.stringify(port)}),
        viewport: [innerWidth, innerHeight],
        overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
      };
    })()`);
    if (!nativeState.tauri) throw new Error('The editor is not running in native Tauri.');
    if (!nativeState.boardTitle.includes('arduino:avr:nano')) {
      throw new Error(`This regression requires the already selected Arduino Nano, got: ${nativeState.boardTitle}`);
    }
    if (!nativeState.portSelected) throw new Error(`${port} is not selected.`);

    const initialWorkspace = await workspaceSummary();
    if (!initialWorkspace.exists) throw new Error('Blockly main workspace is unavailable.');
    if (initialWorkspace.blockCount !== 0) {
      throw new Error(`Expected an empty workspace, found ${initialWorkspace.blockCount} block(s).`);
    }
    await closeSerialAndConsole();

    const fixture = await evaluate(`(async () => {
      const blocklyUrl = performance.getEntriesByType('resource')
        .map((entry) => entry.name)
        .find((name) => /\\/deps\\/blockly\\.js/.test(name));
      const Blockly = await import(blocklyUrl);
      const workspace = Blockly.getMainWorkspace();
      workspace.clear();

      const loop = workspace.newBlock('controls_loop_custom');
      const first = workspace.newBlock('delay_ms');
      const second = workspace.newBlock('delay_ms');
      first.setFieldValue('120', 'MS');
      second.setFieldValue('180', 'MS');
      for (const block of [loop, first, second]) {
        block.initSvg();
        block.render();
      }
      loop.getInput('DO').connection.connect(first.previousConnection);
      first.nextConnection.connect(second.previousConnection);
      loop.moveBy(150, 90);
      Blockly.svgResize(workspace);
      return {
        ids: [first.id, second.id],
        count: workspace.getAllBlocks(false).length,
        types: workspace.getAllBlocks(false).map((block) => block.type),
      };
    })()`);
    if (fixture.count !== 3) throw new Error(`Trace fixture creation failed: ${JSON.stringify(fixture)}`);
    await wait(700);

    const viewOpened = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.replace(/\\s+/g, ' ').trim().startsWith('\u89c6\u56fe'));
      button?.click();
      return Boolean(button);
    })()`);
    if (!viewOpened) throw new Error('The view menu could not be opened.');
    await waitFor(
      `[...document.querySelectorAll('[role="menuitem"]')]
        .some((item) => item.textContent.includes('\u8fd0\u884c\u8f68\u8ff9'))`,
      3000,
      'trace menu entry',
    );
    const traceClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('[role="menuitem"]')]
        .find((item) => item.textContent.includes('\u8fd0\u884c\u8f68\u8ff9') && !item.disabled);
      button?.click();
      return Boolean(button);
    })()`);
    if (!traceClicked) throw new Error('The run-trace menu entry could not be clicked.');
    traceWasStarted = true;
    await waitForOperationStart('trace upload');

    await waitFor(
      `document.querySelector('[data-ck-role="block-trace-panel"]')?.dataset.ckTracePhase === 'running'`,
      300000,
      'running native trace panel',
    );
    await waitFor(
      `Number(document.querySelector('[aria-label="\u79ef\u6728\u91c7\u6837\u8986\u76d6\u7387"]')?.getAttribute('aria-valuenow') || 0) >= 100`,
      10000,
      '100% sampled coverage for two delay blocks',
    );

    const liveTrace = await evaluate(`(() => {
      const panel = document.querySelector('[data-ck-role="block-trace-panel"]');
      const roots = [...document.querySelectorAll('.blocklyDraggable')];
      const panelRect = panel?.getBoundingClientRect();
      return {
        phase: panel?.dataset.ckTracePhase || '',
        text: panel?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        coverage: Number(document.querySelector('[aria-label="\u79ef\u6728\u91c7\u6837\u8986\u76d6\u7387"]')?.getAttribute('aria-valuenow') || 0),
        coveredIds: roots.filter((root) => root.classList.contains('ck-block-trace-covered')).map((root) => root.getAttribute('data-id') || ''),
        pendingCount: roots.filter((root) => root.classList.contains('ck-block-trace-pending')).length,
        traceHits: roots.filter((root) => root.hasAttribute('data-ck-trace-hits')).map((root) => ({
          hits: Number(root.getAttribute('data-ck-trace-hits') || 0),
          label: root.getAttribute('data-ck-trace-label') || '',
        })),
        viewport: [innerWidth, innerHeight],
        panelRect: panelRect ? {
          top: Math.round(panelRect.top),
          bottom: Math.round(panelRect.bottom),
          width: Math.round(panelRect.width),
          height: Math.round(panelRect.height),
        } : null,
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        panelOverflow: panel ? panel.scrollWidth - panel.clientWidth : null,
      };
    })()`);
    if (liveTrace.coveredIds.length < 2 || liveTrace.traceHits.filter((item) => item.hits > 0).length < 2) {
      throw new Error(`Trace visuals did not cover both executable blocks: ${JSON.stringify(liveTrace)}`);
    }
    if (!liveTrace.text.includes('\u91c7\u6837\u547d\u4e2d') || !liveTrace.text.includes('\u4e0d\u662f\u7cbe\u786e\u6267\u884c\u6b21\u6570')) {
      throw new Error('The trace panel did not explain sampled-hit semantics.');
    }
    if (liveTrace.documentOverflow > 1 || liveTrace.panelOverflow > 1) {
      throw new Error(`Trace panel overflowed the native viewport: ${JSON.stringify(liveTrace)}`);
    }
    if (
      !liveTrace.panelRect
      || liveTrace.panelRect.top < 0
      || liveTrace.panelRect.bottom > liveTrace.viewport[1] + 1
    ) {
      throw new Error(`Trace panel was vertically clipped: ${JSON.stringify(liveTrace)}`);
    }

    const stopClicked = await evaluate(`(() => {
      const panel = document.querySelector('[data-ck-role="block-trace-panel"]');
      const button = [...(panel?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.includes('\u7ed3\u675f\u8f68\u8ff9'));
      button?.click();
      return Boolean(button);
    })()`);
    if (!stopClicked) throw new Error('End-trace button was not found.');
    await waitFor(
      `!document.querySelector('[data-ck-role="block-trace-panel"]')`,
      10000,
      'trace STOP acknowledgement',
    );

    await clearWorkspace();
    const uploadClicked = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.replace(/\\s+/g, ' ').trim() === '\u666e\u901a\u4e0a\u4f20' && !item.disabled);
      button?.click();
      return Boolean(button);
    })()`);
    if (!uploadClicked) throw new Error('Normal-upload button was not available for firmware restoration.');
    await waitForOperationStart('normal firmware upload');
    await waitForOperationEnd('normal firmware upload');
    await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.trim() === '\u8f93\u51fa\u65e5\u5fd7');
      button?.click();
      return Boolean(button);
    })()`);
    await wait(150);
    await waitFor(
      `document.body.textContent.includes('\u666e\u901a\u56fa\u4ef6\u4e0a\u4f20\u6210\u529f')`,
      5000,
      'normal firmware upload success message',
    );
    normalFirmwareRestored = true;
    await closeSerialAndConsole();

    const finalWorkspace = await workspaceSummary();
    const finalUi = await evaluate(`(() => ({
      tracePanel: Boolean(document.querySelector('[data-ck-role="block-trace-panel"]')),
      serialOpen: Boolean([...document.querySelectorAll('button')]
        .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668')),
      consoleExpanded: Boolean(document.querySelector('button[title="\u6536\u8d77\u63a7\u5236\u53f0"]')),
      overflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))()`);
    if (finalWorkspace.blockCount !== 0 || finalUi.tracePanel || finalUi.serialOpen) {
      throw new Error(`Native cleanup was incomplete: ${JSON.stringify({ finalWorkspace, finalUi })}`);
    }

    report = {
      nativeState,
      fixture,
      liveTrace,
      normalFirmwareRestored,
      finalWorkspace,
      finalUi,
    };
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    try {
      const panelPresent = await evaluate(`Boolean(document.querySelector('[data-ck-role="block-trace-panel"]'))`);
      if (panelPresent) {
        await evaluate(`(() => {
          const panel = document.querySelector('[data-ck-role="block-trace-panel"]');
          [...(panel?.querySelectorAll('button') || [])]
            .find((item) => item.textContent.includes('\u7ed3\u675f\u8f68\u8ff9'))?.click();
        })()`);
        await wait(700);
      }
      await clearWorkspace();
      await closeSerialAndConsole();
    } catch (cleanupError) {
      process.stderr.write(`Cleanup warning: ${cleanupError.stack || cleanupError}\n`);
      process.exitCode = 1;
    }
    if (traceWasStarted && !normalFirmwareRestored) {
      process.stderr.write('WARNING: trace upload started but normal firmware restoration was not confirmed.\n');
    }
    if (report) process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    socket.close();
  }
});
'@

$nodeScript | node
if ($LASTEXITCODE -ne 0) {
    throw "Native block-trace regression failed with exit code $LASTEXITCODE."
}
