const WebSocket = require('../apps/desktop/node_modules/ws');

const cdpUrl = process.env.CK_CDP_URL;
const nextValue = process.env.CK_TEST_FIELD_VALUE || '4';
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
    throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
  }
  return result.result.value;
});

const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));

socket.on('open', async () => {
  try {
    const field = await evaluate(`(() => {
      const candidates = [...document.querySelectorAll('g.blocklyNumberField')]
        .filter(element => element.getBoundingClientRect().width > 0);
      const element = candidates.at(-1);
      if (!element) throw new Error('No visible Blockly number field');
      const rect = element.getBoundingClientRect();
      return {
        x: rect.x + rect.width / 2,
        y: rect.y + rect.height / 2,
        before: (element.textContent || '').trim(),
      };
    })()`);
    await call('Input.dispatchMouseEvent', {
      type: 'mousePressed', x: field.x, y: field.y, button: 'left', clickCount: 1,
    });
    await call('Input.dispatchMouseEvent', {
      type: 'mouseReleased', x: field.x, y: field.y, button: 'left', clickCount: 1,
    });
    await sleep(150);
    const editorOpened = await evaluate(`(() => {
      const input = document.querySelector('input.blocklyHtmlInput');
      if (!input) return false;
      input.focus();
      input.select();
      return true;
    })()`);
    if (!editorOpened) throw new Error('Blockly field editor did not open');
    await call('Input.insertText', { text: nextValue });
    await call('Input.dispatchKeyEvent', {
      type: 'keyDown', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await call('Input.dispatchKeyEvent', {
      type: 'keyUp', key: 'Enter', code: 'Enter', windowsVirtualKeyCode: 13,
    });
    await sleep(200);

    const report = await evaluate(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const visible = element => Boolean(element && element.getClientRects().length > 0);
      const text = element => (element?.textContent || '').trim();
      const field = [...document.querySelectorAll('g.blocklyNumberField')]
        .filter(element => element.getBoundingClientRect().width > 0).at(-1);
      const compileButton = [...document.querySelectorAll('button')]
        .find(button => visible(button) && button.title === '仅编译，不上传');
      if (!compileButton) throw new Error('Compile button not found');
      const successPattern = /编译成功，用时\\s+([0-9.]+)\\s+秒/g;
      const beforeMatches = [...(document.body.innerText || '').matchAll(successPattern)].length;
      const started = performance.now();
      compileButton.click();
      let observedBusy = false;
      for (let attempt = 0; attempt < 900; attempt += 1) {
        observedBusy ||= compileButton.disabled;
        const body = document.body.innerText || '';
        const matches = [...body.matchAll(successPattern)];
        const toast = [...document.querySelectorAll('*')]
          .find(element => visible(element) && /^编译成功 \\([0-9.]+s\\)$/.test(text(element)));
        if (!compileButton.disabled && (observedBusy || performance.now() - started > 300)
          && (matches.length > beforeMatches || toast)) {
          return {
            wallMs: Math.round(performance.now() - started),
            toast: text(toast) || matches.at(-1)?.[0] || '',
            fieldAfter: (field?.textContent || '').trim(),
            logTail: body.slice(-7000),
          };
        }
        await sleep(50);
      }
      throw new Error('Compile result was not observed');
    })()`);
    process.stdout.write(`${JSON.stringify({ fieldBefore: field.before, requested: nextValue, ...report }, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
