param(
    [string]$Root = '',
    [int]$DebugPort = 9223,
    [string]$Project = 'nano',
    [string]$Port = 'COM5'
)

$ErrorActionPreference = 'Stop'

if ([string]::IsNullOrWhiteSpace($Root)) {
    $Root = Split-Path -Parent $PSScriptRoot
}
$OutputEncoding = [System.Text.UTF8Encoding]::new()
[Console]::OutputEncoding = [System.Text.UTF8Encoding]::new()
$targets = @(Invoke-RestMethod "http://127.0.0.1:$DebugPort/json/list")
$target = $targets | Where-Object { $_.type -eq 'page' -and $_.webSocketDebuggerUrl } | Select-Object -First 1
if (-not $target.webSocketDebuggerUrl) {
    throw "No debuggable CK window was found on port $DebugPort. Start the native Tauri app first."
}

$env:CK_CDP_URL = $target.webSocketDebuggerUrl
$env:CK_NATIVE_CDP_VIEWPORT_GUARD = Join-Path $PSScriptRoot 'native-cdp-viewport-guard.cjs'
$env:CK_NATIVE_PROJECT = $Project
$env:CK_NATIVE_PORT = $Port
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

async function waitFor(expression, timeoutMs = 10000, label = expression) {
  const deadline = Date.now() + timeoutMs;
  while (Date.now() < deadline) {
    if (await evaluate(expression)) return;
    await wait(100);
  }
  throw new Error(`Timed out waiting for ${label}`);
}

async function emitSerialData(payload) {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', ${JSON.stringify({
    event: 'serial-data',
    payload,
  })})`);
}

async function setField(selector, value) {
  const updated = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    const prototype = element instanceof HTMLSelectElement
      ? HTMLSelectElement.prototype
      : HTMLInputElement.prototype;
    const setter = Object.getOwnPropertyDescriptor(prototype, 'value')?.set;
    setter?.call(element, ${JSON.stringify(value)});
    element.dispatchEvent(new Event('input', { bubbles: true }));
    element.dispatchEvent(new Event('change', { bubbles: true }));
    return true;
  })()`);
  if (!updated) throw new Error(`Field is missing: ${selector}`);
}

async function click(selector) {
  const clicked = await evaluate(`(() => {
    const element = document.querySelector(${JSON.stringify(selector)});
    if (!element) return false;
    element.click();
    return true;
  })()`);
  if (!clicked) throw new Error(`Clickable element is missing: ${selector}`);
}

async function setWindowSize() {
  await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', {
    label: 'main',
    value: { Logical: { width: 1280, height: 800 } },
  }).catch(() => undefined)`);
  await wait(200);
}

async function cleanup() {
  await evaluate(`(async () => {
    document.querySelector('[data-ck-action="finish-serial-trigger"]')?.click();
    const closeMonitor = [...document.querySelectorAll('button')]
      .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668');
    closeMonitor?.click();
    await new Promise((resolve) => setTimeout(resolve, 300));
    document.querySelector('button[title="\u6536\u8d77\u63a7\u5236\u53f0"]')?.click();
    await window.__TAURI_INTERNALS__.invoke('plugin:window|set_size', {
      label: 'main',
      value: { Logical: { width: 1280, height: 800 } },
    }).catch(() => undefined);
  })()`);
}

socket.on('open', async () => {
  let output;
  try {
    await restoreNativeViewport(call);
    await setWindowSize();
    const project = process.env.CK_NATIVE_PROJECT || 'nano';
    const port = process.env.CK_NATIVE_PORT || 'COM5';

    if (!(await evaluate(`[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === '\u7f16\u8bd1')`))) {
      const opened = await evaluate(`(() => {
        const heading = [...document.querySelectorAll('h3')]
          .find((item) => item.textContent.trim() === ${JSON.stringify(project)});
        const card = heading?.closest('.cursor-pointer');
        card?.click();
        return Boolean(card);
      })()`);
      if (!opened) throw new Error(`Project card was not found: ${project}`);
      await waitFor(
        `[...document.querySelectorAll('button')].some((item) => item.textContent.trim() === '\u7f16\u8bd1')`,
        15000,
        'workspace',
      );
    }

    const selectedPort = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find((item) => item.textContent.includes('\u4e32\u53e3') && item.textContent.includes(${JSON.stringify(port)}));
      return Boolean(button);
    })()`);
    if (!selectedPort) {
      const opened = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.title === '\u9009\u62e9\u4e32\u53e3' || item.textContent.includes('\u4e32\u53e3\u672a\u9009'));
        button?.click();
        return Boolean(button);
      })()`);
      if (!opened) throw new Error('Serial-port selector was not found.');
      await waitFor(
        `[...document.querySelectorAll('button')].some((item) => item.textContent.trim().startsWith(${JSON.stringify(port)}))`,
        5000,
        `${port} option`,
      );
      const chosePort = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.textContent.trim().startsWith(${JSON.stringify(port)}));
        button?.click();
        return Boolean(button);
      })()`);
      if (!chosePort) throw new Error(`Unable to select ${port}.`);
      await wait(300);
    }

    const monitorAlreadyOpen = await evaluate(
      `[...document.querySelectorAll('button')].some((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668')`,
    );
    if (!monitorAlreadyOpen) {
      const opened = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.title === '\u6253\u5f00\u4e32\u53e3\u76d1\u89c6\u5668');
        button?.click();
        return Boolean(button);
      })()`);
      if (!opened) throw new Error('Open-serial-monitor button was not found.');
    }

    await waitFor(`document.querySelector('button[title="\u7ed3\u6784\u5316\u4e32\u53e3\u6570\u636e"]') !== null`, 10000, 'serial data mode');
    await evaluate(`(() => {
      const resume = document.querySelector('button[title="\u7ee7\u7eed\u63a5\u6536\u663e\u793a"]');
      resume?.click();
      return Boolean(resume);
    })()`);
    await click('button[title="\u7ed3\u6784\u5316\u4e32\u53e3\u6570\u636e"]');
    await waitFor(`document.querySelector('[data-ck-role="serial-plotter"]') !== null`, 5000, 'serial plotter');
    // The plotter DOM mounts before its async Tauri event listener promise resolves.
    // Give listen('serial-data') a short deterministic registration window.
    await wait(350);

    const clearButton = await evaluate(`(() => {
      const plotter = document.querySelector('[data-ck-role="serial-plotter"]');
      const button = [...(plotter?.querySelectorAll('button') || [])]
        .find((item) => item.textContent.trim() === '\u6e05\u7a7a');
      if (button && !button.disabled) button.click();
      return Boolean(button);
    })()`);

    let seriesReady = false;
    for (let attempt = 0; attempt < 5 && !seriesReady; attempt++) {
      await emitSerialData('\u6e29\u5ea6=20 \u6e7f\u5ea6=40\n\u6e29\u5ea6=21 \u6e7f\u5ea6=41\n');
      await wait(250);
      seriesReady = await evaluate(
        `[...document.querySelectorAll('[aria-label="\u6700\u65b0\u4e32\u53e3\u6570\u503c"] > div')]
          .some((item) => item.textContent.includes('\u6e29\u5ea6'))`,
      );
    }
    if (!seriesReady) {
      const diagnostic = await evaluate(`(() => ({
        plotter: Boolean(document.querySelector('[data-ck-role="serial-plotter"]')),
        recorder: Boolean(document.querySelector('[data-ck-role="serial-trigger-recorder"]')),
        paused: Boolean(document.querySelector('button[title="\u7ee7\u7eed\u63a5\u6536\u663e\u793a"]')),
        running: Boolean(document.querySelector('button[title="\u6682\u505c\u63a5\u6536\u663e\u793a"]')),
        options: [...document.querySelectorAll('[data-ck-field="trigger-channel"] option')]
          .map((item) => item.value),
        plotterText: document.querySelector('[data-ck-role="serial-plotter"]')
          ?.textContent?.replace(/\s+/g, ' ').trim().slice(0, 500) || '',
      }))()`);
      throw new Error(`Temperature data series was not created: ${JSON.stringify(diagnostic)}`);
    }

    await click('[data-ck-action="toggle-serial-trigger-recorder"]');
    await waitFor(
      `document.querySelector('[data-ck-field="trigger-channel"] option[value="\u6e29\u5ea6"]') !== null`,
      3000,
      'temperature trigger option',
    );
    await setField('[data-ck-field="trigger-channel"]', '\u6e29\u5ea6');
    await setField('[data-ck-field="trigger-comparator"]', 'gt');
    await setField('[data-ck-field="trigger-threshold"]', '25');
    await setField('[data-ck-field="trigger-pre-seconds"]', '1');
    await setField('[data-ck-field="trigger-post-seconds"]', '0.5');
    await waitFor(
      `Boolean(document.querySelector('[data-ck-action="arm-serial-trigger"]:not(:disabled)'))`,
      3000,
      'valid trigger form',
    );
    await click('[data-ck-action="arm-serial-trigger"]');
    await waitFor(
      `document.querySelector('[data-ck-role="serial-trigger-recorder"]')?.dataset.ckTriggerState === 'armed'`,
      3000,
      'armed trigger',
    );

    await emitSerialData('\u6e29\u5ea6=24 \u6e7f\u5ea6=42\n');
    await wait(120);
    await emitSerialData('\u6e29\u5ea6=26 \u6e7f\u5ea6=43\n');
    await waitFor(
      `document.querySelector('[data-ck-role="serial-trigger-recorder"]')?.dataset.ckTriggerState === 'capturing'`,
      3000,
      'triggered capture',
    );
    await emitSerialData('\u6e29\u5ea6=27 \u6e7f\u5ea6=44\n');
    await wait(600);
    await emitSerialData('\u6e29\u5ea6=28 \u6e7f\u5ea6=45\n');
    await waitFor(
      `document.querySelector('[data-ck-role="serial-trigger-recorder"]')?.dataset.ckTriggerState === 'frozen'`,
      3000,
      'automatic freeze',
    );

    const automaticCapture = await evaluate(`(() => {
      const section = document.querySelector('[data-ck-role="serial-trigger-recorder"]');
      const temperatureCard = [...document.querySelectorAll('[aria-label="\u6700\u65b0\u4e32\u53e3\u6570\u503c"] > div')]
        .find((item) => item.textContent.includes('\u6e29\u5ea6'));
      return {
        state: section?.dataset.ckTriggerState || '',
        text: section?.textContent?.replace(/\s+/g, ' ').trim() || '',
        temperatureCard: temperatureCard?.textContent?.replace(/\s+/g, ' ').trim() || '',
      };
    })()`);

    await emitSerialData('\u6e29\u5ea6=99 \u6e7f\u5ea6=60\n');
    await wait(350);
    const afterFrozen = await evaluate(`(() => {
      const section = document.querySelector('[data-ck-role="serial-trigger-recorder"]');
      const temperatureCard = [...document.querySelectorAll('[aria-label="\u6700\u65b0\u4e32\u53e3\u6570\u503c"] > div')]
        .find((item) => item.textContent.includes('\u6e29\u5ea6'));
      return {
        state: section?.dataset.ckTriggerState || '',
        temperatureCard: temperatureCard?.textContent?.replace(/\s+/g, ' ').trim() || '',
        receiveStillRunning: Boolean(document.querySelector('button[title="\u6682\u505c\u63a5\u6536\u663e\u793a"]')),
        monitorStillOpen: Boolean([...document.querySelectorAll('button')]
          .find((item) => item.title === '\u5173\u95ed\u4e32\u53e3\u76d1\u89c6\u5668')),
      };
    })()`);
    if (!afterFrozen.temperatureCard.includes('99')) {
      throw new Error('Live serial card did not continue updating after the capture froze.');
    }
    if (!afterFrozen.receiveStillRunning || !afterFrozen.monitorStillOpen) {
      throw new Error('Freezing the capture unexpectedly paused serial reception or closed the monitor.');
    }

    await click('[data-ck-action="rearm-serial-trigger"]');
    await emitSerialData('\u6e29\u5ea6=70 \u6e7f\u5ea6=46\n');
    await waitFor(
      `document.querySelector('[data-ck-role="serial-trigger-recorder"]')?.dataset.ckTriggerState === 'capturing'`,
      3000,
      'second triggered capture',
    );
    const manualFreezeVisible = await evaluate(
      `document.querySelector('[data-ck-action="freeze-serial-trigger"]') !== null`,
    );
    await click('[data-ck-action="freeze-serial-trigger"]');
    await waitFor(
      `document.querySelector('[data-ck-role="serial-trigger-recorder"]')?.dataset.ckTriggerState === 'frozen'`,
      3000,
      'manual freeze',
    );

    const layout = await evaluate(`(() => {
      const plotter = document.querySelector('[data-ck-role="serial-plotter"]');
      const recorder = document.querySelector('[data-ck-role="serial-trigger-recorder"]');
      return {
        innerSize: [innerWidth, innerHeight],
        documentOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
        plotterOverflow: plotter ? plotter.scrollWidth - plotter.clientWidth : null,
        recorderOverflow: recorder ? recorder.scrollWidth - recorder.clientWidth : null,
      };
    })()`);
    if (layout.documentOverflow > 1 || layout.plotterOverflow > 1 || layout.recorderOverflow > 1) {
      throw new Error(`Unexpected horizontal overflow: ${JSON.stringify(layout)}`);
    }

    output = {
      automaticCapture,
      afterFrozen,
      manualFreezeVisible,
      layout,
      clearButtonFound: clearButton,
      eventPath: "Tauri plugin:event|emit -> listen('serial-data')",
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
    if (output) process.stdout.write(`${JSON.stringify(output, null, 2)}\n`);
    socket.close();
  }
});
'@

$nodeScript | node
if ($LASTEXITCODE -ne 0) {
    throw "Native serial-trigger regression failed with exit code $LASTEXITCODE."
}
