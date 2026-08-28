const WebSocket = require('../apps/desktop/node_modules/ws');
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

function evaluate(expression) {
  return call('Runtime.evaluate', {
    expression,
    awaitPromise: true,
    returnByValue: true,
  }).then((result) => {
    if (result.exceptionDetails) {
      const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
      throw new Error(`${detail}\nExpression:\n${expression}`);
    }
    return result.result.value;
  });
}

const wait = (ms) => new Promise((resolve) => setTimeout(resolve, ms));
const progressScenario = String(process.env.CK_PROGRESS_SCENARIO || 'None').toLowerCase();
const progressEnabled = progressScenario !== 'none';
const progressCompileTimeoutMs = Number(process.env.CK_PROGRESS_COMPILE_TIMEOUT_MS || 900000);

async function waitForUiCompileStart(timeoutMs = 15000) {
  const deadline = Date.now() + timeoutMs;
  let state = null;
  while (Date.now() < deadline) {
    state = await evaluate(`(() => {
      const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
      const compileButton = [...document.querySelectorAll('button')]
        .find((item) => item.textContent?.trim() === '编译');
      const overlayRect = overlay?.getBoundingClientRect();
      const topElement = overlayRect
        ? document.elementFromPoint(
            overlayRect.left + overlayRect.width / 2,
            overlayRect.top + overlayRect.height / 2,
          )
        : null;
      return {
        overlayVisible: Boolean(overlay && topElement && overlay.contains(topElement)),
        compileDisabled: Boolean(compileButton?.disabled),
        overlayStage: overlay?.getAttribute('data-ck-progress-stage') || '',
        overlayText: overlay?.textContent?.replace(/\\s+/g, ' ').trim() || '',
        askIntercepts: Number(window.__CK_NATIVE_TEST_ASK_COUNT__ || 0),
      };
    })()`);
    if (state.overlayVisible) return { started: true, ...state };
    await wait(100);
  }
  return { started: false, ...(state || {}) };
}

function createProgressAudit() {
  return {
    scenario: progressScenario,
    overlaySeen: false,
    indeterminateSeen: false,
    stagesSeen: false,
    quietHintSeen: false,
    expectedBuildLabelSeen: false,
    fixed95SeenDuringIndeterminate: false,
    elapsedValues: new Set(),
    maxDocumentOverflow: 0,
    maxOverlayOverflow: 0,
    samples: 0,
  };
}

function recordProgressSample(audit, sample) {
  if (!sample?.visible) return;
  audit.overlaySeen = true;
  audit.samples += 1;
  audit.indeterminateSeen ||= sample.indeterminate;
  audit.stagesSeen ||= sample.stageLabels.length === 4;
  audit.quietHintSeen ||= sample.quietHint;
  audit.expectedBuildLabelSeen ||= sample.expectedBuildLabel;
  audit.fixed95SeenDuringIndeterminate ||= sample.indeterminate && sample.fixed95;
  if (sample.elapsed) audit.elapsedValues.add(sample.elapsed);
  audit.maxDocumentOverflow = Math.max(audit.maxDocumentOverflow, sample.documentOverflow);
  audit.maxOverlayOverflow = Math.max(audit.maxOverlayOverflow, sample.overlayOverflow);
}

function serializableProgressAudit(audit) {
  if (!audit) return null;
  return {
    ...audit,
    elapsedValues: [...audit.elapsedValues],
  };
}

socket.on('open', async () => {
  try {
    await restoreNativeViewport(call);
    const fqbn = process.env.CK_TEST_FQBN || 'esp32:esp32:esp32c5';
    const initialUi = await evaluate(`(() => ({
      title: document.title,
      bodyText: (document.body.textContent || '').replace(/\\s+/g, ' ').trim().slice(0, 800),
      buttons: [...document.querySelectorAll('button')]
        .map((item) => item.textContent?.replace(/\\s+/g, ' ').trim() || '')
        .filter(Boolean)
        .slice(0, 40),
      headings: [...document.querySelectorAll('h3')]
        .map((item) => ({ text: item.textContent?.trim() || '', title: item.getAttribute('title') || '' }))
        .slice(0, 20),
    }))()`);
    process.stdout.write(`${JSON.stringify({ stage: 'ui-state', initialUi }, null, 2)}\n`);

    let editorReady = initialUi.buttons.includes('编译');
    if (!editorReady) {
      const projectName = process.env.CK_TEST_PROJECT || 'espc5';
      const opened = await evaluate(`(() => {
        const targetName = ${JSON.stringify(projectName)};
        const heading = [...document.querySelectorAll('h3')]
          .find((item) => item.textContent?.trim() === targetName);
        const card = heading?.closest('.cursor-pointer');
        if (!card) return false;
        card.dispatchEvent(new MouseEvent('click', { bubbles: true, cancelable: true }));
        return true;
      })()`);
      if (opened) {
        const deadline = Date.now() + 20000;
        while (Date.now() < deadline) {
          editorReady = await evaluate(`[...document.querySelectorAll('button')]
            .some((item) => item.textContent?.trim() === '编译')`);
          if (editorReady) break;
          await wait(200);
        }
      }
    }

    const staleCode = '#include <WiFi.h>\n#include <EEPROM.h>\n#include <SPI.h>\n#include <Wire.h>\nvoid setup(){ Wire.begin(); }\nvoid loop(){}';
    const password = process.env.CK_FORCE_CODE_CHANGE === '1' ? '12345679' : '12345678';
    const workspaceFingerprint = process.env.CK_FORCE_CODE_CHANGE === '1'
      ? 'native-wifi-c5-regression-v2'
      : 'native-wifi-c5-regression-v1';
    const wifiCode = `#include <WiFi.h>\n\nvoid setup() {\n  WiFi.begin("MyWiFi", "${password}");\n  WiFi.mode(WIFI_STA);\n}\n\nvoid loop() {\n  // Wi-Fi connection initiated in setup\n}`;
    const backendResult = await evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') throw new Error('Tauri invoke is unavailable');
      if (${JSON.stringify(process.env.CK_SKIP_WARMUP !== '1')}) {
        await invoke('warmup_board', {
          fqbn: ${JSON.stringify(fqbn)},
          code: ${JSON.stringify(staleCode)},
        });
        await new Promise((resolve) => setTimeout(resolve, 700));
      }
      const started = performance.now();
      const raw = await invoke('compile_sketch', {
        code: ${JSON.stringify(wifiCode)},
        fqbn: ${JSON.stringify(fqbn)},
        workspaceFingerprint: ${JSON.stringify(workspaceFingerprint)},
      });
      return { raw, wallMs: performance.now() - started };
    })()`);

    const parsed = JSON.parse(backendResult.raw);
    const diagnostics = parsed.diagnostics || {};
    const lockWaitMs = Number(diagnostics.timing?.lockWaitMs ?? Number.POSITIVE_INFINITY);
    const maxLockWaitMs = Number(process.env.CK_MAX_LOCK_WAIT_MS || 5000);
    const failures = [];
    if (!parsed.path) failures.push('Native compile did not return a build directory.');
    if (!Number.isFinite(lockWaitMs)) failures.push('Structured lock-wait diagnostics are missing.');
    if (lockWaitMs > maxLockWaitMs) {
      failures.push(`Foreground compile waited ${lockWaitMs}ms for the warmup lock (limit ${maxLockWaitMs}ms).`);
    }
    process.stdout.write(`${JSON.stringify({ stage: 'backend', wallMs: Math.round(backendResult.wallMs), diagnostics }, null, 2)}\n`);

    const uiBoardTitle = editorReady
      ? await evaluate(`(() => [...document.querySelectorAll('button')]
          .find((item) => item.title?.startsWith('板卡设置与编译缓存'))?.title || '')()`)
      : '';
    const progressBoardMatches = !progressEnabled || uiBoardTitle.includes(fqbn);
    if (!progressBoardMatches) {
      failures.push(`The open editor board does not match ${fqbn}; refusing to clear a different board cache.`);
    }
    const canStartUiCompile = editorReady && progressBoardMatches;

    let progressPreparation = null;
    let uiCompileStarted = false;

    if (canStartUiCompile && progressScenario === 'firstbuild') {
      progressPreparation = await evaluate(`(async () => {
        const invoke = window.__TAURI_INTERNALS__?.invoke;
        if (typeof invoke !== 'function') throw new Error('Tauri invoke is unavailable');
        return await invoke('clear_board_compile_cache', { fqbn: ${JSON.stringify(fqbn)} });
      })()`);
      await evaluate(`(() => {
        const closeButton = [...document.querySelectorAll('button')]
          .find((item) => item.textContent?.trim() === '完成');
        closeButton?.click();
        return Boolean(closeButton);
      })()`);
      await wait(100);
    }

    if (canStartUiCompile && progressScenario === 'rebuild') {
      const settingsOpened = await evaluate(`(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (!internals || typeof internals.invoke !== 'function') return false;
        if (!window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__) {
          window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__ = internals.invoke;
          window.__CK_NATIVE_TEST_ASK_COUNT__ = 0;
          internals.invoke = function(command, args, options) {
            if (command === 'plugin:dialog|ask') {
              window.__CK_NATIVE_TEST_ASK_COUNT__ += 1;
              return Promise.resolve(true);
            }
            return window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__.call(this, command, args, options);
          };
        }
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.title?.startsWith('板卡设置与编译缓存') || item.textContent?.includes('板卡设置'));
        if (!button) return false;
        button.click();
        return true;
      })()`);

      let rebuildButtonReady = false;
      if (settingsOpened) {
        const rebuildButtonDeadline = Date.now() + 10000;
        while (Date.now() < rebuildButtonDeadline) {
          rebuildButtonReady = await evaluate(`[...document.querySelectorAll('button')]
            .some((item) => item.textContent?.trim() === '重新编译' && !item.disabled)`);
          if (rebuildButtonReady) break;
          await wait(100);
        }
      }

      if (rebuildButtonReady) {
        uiCompileStarted = await evaluate(`(() => {
          const button = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.trim() === '重新编译' && !item.disabled);
          if (!button) return false;
          button.click();
          return true;
        })()`);
        await wait(100);
      }

      progressPreparation = { settingsOpened, rebuildButtonReady };
    } else if (canStartUiCompile) {
      uiCompileStarted = await evaluate(`(() => {
        const button = [...document.querySelectorAll('button')]
          .find((item) => item.textContent?.trim() === '编译' && !item.disabled);
        if (!button) return false;
        button.click();
        return true;
      })()`);
    }

    let compileStartState = null;
    if (uiCompileStarted) {
      compileStartState = await waitForUiCompileStart();
      uiCompileStarted = compileStartState.started;
      if (!uiCompileStarted) {
        failures.push('The native compile action was clicked but never entered a running state.');
      }
    }

    if (progressScenario === 'rebuild') {
      await evaluate(`(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (internals && window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__) {
          internals.invoke = window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__;
          delete window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__;
        }
      })()`);
      progressPreparation = { ...(progressPreparation || {}), compileStartState };
    } else if (progressPreparation) {
      progressPreparation = { ...progressPreparation, compileStartState };
    }

    let ui = null;
    const progressAudit = progressEnabled ? createProgressAudit() : null;
    if (uiCompileStarted) {
      const deadline = Date.now() + (progressEnabled ? progressCompileTimeoutMs : 120000);
      while (Date.now() < deadline) {
        ui = await evaluate(`(() => {
          const doctor = document.querySelector('[aria-label="构建体检"]');
          const compileButton = [...document.querySelectorAll('button')]
            .find((item) => item.textContent?.trim() === '编译');
          const overlay = document.querySelector('[data-ck-role="compile-progress-overlay"]');
          const overlayText = overlay?.textContent?.replace(/\\s+/g, ' ').trim() || '';
          const elapsedText = overlay?.querySelector('[data-ck-role="compile-progress-elapsed"]')
            ?.textContent?.replace(/\\s+/g, ' ').trim() || '';
          const explanationText = overlay?.querySelector('[data-ck-role="compile-progress-explanation"]')
            ?.textContent?.replace(/\\s+/g, ' ').trim() || '';
          const overlayRect = overlay?.getBoundingClientRect();
          const topElement = overlayRect
            ? document.elementFromPoint(
                overlayRect.left + overlayRect.width / 2,
                overlayRect.top + overlayRect.height / 2,
              )
            : null;
          const stageLabels = ['准备', '编译', '链接', '产物']
            .filter((label) => overlayText.includes(label));
          const expectedBuildLabels = ${JSON.stringify(progressScenario)} === 'rebuild'
            ? ['正在重建当前配置']
            : ['正在执行首次完整构建', '正在重建当前配置'];
          return {
            doctorVisible: Boolean(doctor),
            doctorText: doctor?.textContent?.replace(/\\s+/g, ' ').trim() || '',
            compileFinished: Boolean(compileButton) && !compileButton.disabled,
            snapshotCount: Object.keys(localStorage)
              .filter((key) => key.startsWith('ck.compile.environment.v1.')).length,
            progress: {
              visible: Boolean(overlay && topElement && overlay.contains(topElement)),
              text: overlayText,
              indeterminate: overlay?.getAttribute('data-ck-progress-indeterminate') === 'true',
              stageLabels,
              elapsed: elapsedText.match(/(?:\\d+:)?\\d{2}:\\d{2}/)?.[0] || '',
              quietHint: explanationText.includes('ESP32 核心编译期间出现静默属于正常现象'),
              expectedBuildLabel: expectedBuildLabels.some((label) => overlayText.includes(label)),
              fixed95: /95(?:\\.0+)?%/.test(elapsedText),
              documentOverflow: Math.max(0, document.documentElement.scrollWidth - document.documentElement.clientWidth),
              overlayOverflow: overlayRect
                ? Math.max(
                    0,
                    -overlayRect.left,
                    overlayRect.right - window.innerWidth,
                    overlay.scrollWidth - overlay.clientWidth,
                  )
                : 0,
            },
          };
        })()`);
        if (progressAudit) recordProgressSample(progressAudit, ui.progress);
        if (ui.doctorVisible && ui.compileFinished) break;
        await wait(250);
      }
      if (!ui?.doctorVisible) failures.push('Build Health card did not appear after a UI compile.');
      if (!ui?.snapshotCount) failures.push('The last successful compile environment snapshot was not stored.');
      if (!ui?.compileFinished) failures.push('The native UI compile did not finish before the timeout.');
    } else if (!compileStartState) {
      failures.push('The native Compile button was not available.');
    }

    if (progressAudit) {
      if (!progressAudit.overlaySeen) failures.push('The compile progress overlay never appeared.');
      if (!progressAudit.indeterminateSeen) failures.push('The first/rebuild compile did not use indeterminate progress.');
      if (!progressAudit.stagesSeen) failures.push('The progress overlay did not show all four build stages.');
      if (progressAudit.elapsedValues.size < 2) failures.push('The elapsed-time display did not visibly advance.');
      if (!progressAudit.quietHintSeen) failures.push('The normal ESP32 quiet-build hint did not appear after 20 seconds.');
      if (!progressAudit.expectedBuildLabelSeen) {
        failures.push(`The ${progressScenario} build label did not appear in the progress overlay.`);
      }
      if (progressAudit.fixed95SeenDuringIndeterminate) {
        failures.push('The indeterminate first/rebuild progress displayed a misleading fixed 95%.');
      }
      if (progressAudit.maxDocumentOverflow > 0 || progressAudit.maxOverlayOverflow > 1) {
        failures.push('The compile progress overlay caused horizontal overflow.');
      }
    }

    await evaluate(`(() => {
      const serialTab = [...document.querySelectorAll('button')]
        .find((item) => item.textContent?.trim() === '串口监视器');
      serialTab?.click();
      return Boolean(serialTab);
    })()`);
    await wait(100);
    const serialView = await evaluate(`(() => {
      const dataButton = [...document.querySelectorAll('button')]
        .find((item) => item.textContent?.trim() === '数据');
      dataButton?.click();
      return { dataButtonVisible: Boolean(dataButton) };
    })()`);
    await wait(100);
    Object.assign(serialView, await evaluate(`(() => ({
      dataViewText: document.body.textContent?.includes('JSON · CSV · key=value') || false,
      horizontalOverflow: document.documentElement.scrollWidth - document.documentElement.clientWidth,
    }))()`));
    if (!serialView.dataButtonVisible || !serialView.dataViewText) {
      failures.push('The structured serial data view is not reachable from the native console.');
    }
    if (serialView.horizontalOverflow > 0) failures.push('The native editor has horizontal overflow.');

    const report = {
      fqbn,
      wallMs: Math.round(backendResult.wallMs),
      diagnostics,
      uiBoardTitle,
      ui,
      progressPreparation,
      progressAudit: serializableProgressAudit(progressAudit),
      serialView,
    };
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    if (failures.length) throw new Error(failures.join(' '));
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    try {
      await evaluate(`(() => {
        const internals = window.__TAURI_INTERNALS__;
        if (internals && window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__) {
          internals.invoke = window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__;
          delete window.__CK_NATIVE_TEST_ORIGINAL_INVOKE__;
        }
      })()`);
    } catch {
      // The inspected window may have closed while the native regression was running.
    }
    socket.close();
  }
});
