const WebSocket = require('../apps/desktop/node_modules/ws');

const cdpUrl = process.env.CK_CDP_URL;
if (!cdpUrl) throw new Error('CK_CDP_URL is required');

const socket = new WebSocket(cdpUrl);
const pending = new Map();
let nextId = 0;

socket.on('message', raw => {
  const message = JSON.parse(raw);
  const request = pending.get(message.id);
  if (!request) return;
  pending.delete(message.id);
  if (message.error) request.reject(new Error(message.error.message));
  else request.resolve(message.result);
});

const call = (method, params = {}) => new Promise((resolve, reject) => {
  const id = ++nextId;
  pending.set(id, { resolve, reject });
  socket.send(JSON.stringify({ id, method, params }));
});

const evaluate = expression => call('Runtime.evaluate', {
  expression,
  awaitPromise: true,
  returnByValue: true,
}).then(result => {
  if (result.exceptionDetails) {
    const detail = result.exceptionDetails.exception?.description || result.exceptionDetails.text;
    throw new Error(detail);
  }
  return result.result.value;
});

const mouseClick = async ({ x, y }) => {
  await call('Input.dispatchMouseEvent', { type: 'mouseMoved', x, y });
  await call('Input.dispatchMouseEvent', {
    type: 'mousePressed', x, y, button: 'left', buttons: 1, clickCount: 1,
  });
  await call('Input.dispatchMouseEvent', {
    type: 'mouseReleased', x, y, button: 'left', buttons: 0, clickCount: 1,
  });
};

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

const rectCenter = selector => evaluate(`(() => {
  const element = document.querySelector(${JSON.stringify(selector)});
  if (!element) throw new Error('Element not found: ' + ${JSON.stringify(selector)});
  const rect = element.getBoundingClientRect();
  return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2 };
})()`);

const compileOnce = async () => {
  const before = await evaluate(`(() => {
    const button = [...document.querySelectorAll('button')]
      .find(element => element.getClientRects().length && element.title === '仅编译，不上传');
    if (!button) throw new Error('Compile button not found');
    const rect = button.getBoundingClientRect();
    return { x: rect.x + rect.width / 2, y: rect.y + rect.height / 2,
      body: document.body.innerText || '' };
  })()`);
  const started = Date.now();
  await mouseClick(before);
  let sawDisabled = false;
  for (let attempt = 0; attempt < 600; attempt += 1) {
    const state = await evaluate(`(() => {
      const button = [...document.querySelectorAll('button')]
        .find(element => element.getClientRects().length && element.title === '仅编译，不上传');
      const body = document.body.innerText || '';
      const toasts = [...document.querySelectorAll('*')]
        .filter(element => element.getClientRects().length
          && /^编译成功 \\([0-9.]+s\\)$/.test((element.textContent || '').trim()))
        .map(element => (element.textContent || '').trim());
      return { disabled: Boolean(button?.disabled), body, toasts };
    })()`);
    sawDisabled ||= state.disabled;
    const matches = [...state.body.matchAll(/编译成功，用时\s+([0-9.]+)\s+秒。/g)];
    if (sawDisabled && !state.disabled && state.body !== before.body
      && (state.toasts.length || matches.length)) {
      const log = state.body.slice(-14000);
      const native = log.match(/NativeRelink eligibility=([^\n]+)/)?.[1] || '';
      const rejected = log.match(/NativeRelink not eligible \(([^)]+)\): ([^\n]+)/);
      return {
        wallMs: Date.now() - started,
        toast: state.toasts.at(-1) || '',
        reportedSeconds: matches.at(-1)?.[1] || '',
        nativeRelink: native,
        rejected: rejected ? { code: rejected[1], reason: rejected[2] } : null,
        logTail: log,
      };
    }
    await sleep(50);
  }
  throw new Error('Compile completion was not observed');
};

socket.on('open', async () => {
  try {
    const arrayCategory = await rectCenter('.category-array');
    await mouseClick(arrayCategory);
    await sleep(250);

    const source = await rectCenter(
      '.blocklyFlyout .array_declare_1d_empty_custom.blocklyDraggable',
    );
    const destination = await evaluate(`(() => {
      const svg = document.querySelector('svg.blocklySvg');
      const rect = svg.getBoundingClientRect();
      return { x: Math.min(rect.right - 160, rect.x + rect.width * 0.72),
        y: Math.min(rect.bottom - 140, rect.y + rect.height * 0.48) };
    })()`);
    await call('Input.dispatchMouseEvent', { type: 'mouseMoved', ...source });
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed', ...source, button: 'left', buttons: 1, clickCount: 1,
    });
    for (let step = 1; step <= 6; step += 1) {
      const ratio = step / 6;
      await call('Input.dispatchMouseEvent', {
        type: 'mouseMoved',
        x: source.x + (destination.x - source.x) * ratio,
        y: source.y + (destination.y - source.y) * ratio,
        button: 'left',
        buttons: 1,
      });
      await sleep(40);
    }
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', ...destination, button: 'left', buttons: 0, clickCount: 1,
    });
    await sleep(350);

    const nameField = await rectCenter(
      '.blocklyBlockCanvas:not(.blocklyFlyout .blocklyBlockCanvas) .blocklyTextInputField',
    );
    await mouseClick(nameField);
    await sleep(100);
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17, modifiers: 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'a', code: 'KeyA', windowsVirtualKeyCode: 65,
      nativeVirtualKeyCode: 65, modifiers: 2,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Control', code: 'ControlLeft', windowsVirtualKeyCode: 17,
      nativeVirtualKeyCode: 17,
    });
    await call('Input.insertText', { text: `arr_ui_${Date.now()}` });
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
      nativeVirtualKeyCode: 13,
    });
    await sleep(250);

    const workspaceText = await evaluate(`document.querySelector(
      '.blocklyBlockCanvas:not(.blocklyFlyout .blocklyBlockCanvas)'
    )?.textContent || ''`);
    const result = await compileOnce();
    process.stdout.write(`${JSON.stringify({ workspaceText, ...result }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
