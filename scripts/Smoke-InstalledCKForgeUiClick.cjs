const WebSocket = require('../apps/desktop/node_modules/ws');

const cdpUrl = process.env.CK_CDP_URL;
const projectName = process.env.CK_TEST_PROJECT || 'ove';
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

socket.on('open', async () => {
  try {
    const report = await evaluate(`(async () => {
      const sleep = ms => new Promise(resolve => setTimeout(resolve, ms));
      const text = element => (element?.textContent || '').trim();
      const visible = element => Boolean(element && element.getClientRects().length > 0);
      const clickText = (selector, expected) => {
        const element = [...document.querySelectorAll(selector)]
          .find(candidate => visible(candidate) && text(candidate) === expected);
        if (!element) throw new Error('Visible element not found: ' + selector + ' / ' + expected);
        element.click();
        return element;
      };
      let compileButton = [...document.querySelectorAll('button')]
        .find(button => visible(button) && button.title === '仅编译，不上传');
      if (!compileButton) {
        clickText('h1,h2,h3,h4,h5,h6,[role="heading"]', ${JSON.stringify(projectName)});
      }
      for (let attempt = 0; attempt < 120; attempt += 1) {
        if ([...document.querySelectorAll('button')]
          .some(button => visible(button) && button.title === '仅编译，不上传')) break;
        await sleep(100);
      }
      compileButton = [...document.querySelectorAll('button')]
        .find(button => visible(button) && button.title === '仅编译，不上传');
      if (!compileButton) throw new Error('Compile button did not appear after opening project');
      const run = async () => {
        const successPattern = /编译成功，用时\\s+([0-9.]+)\\s+秒/g;
        const consoleToggle = [...document.querySelectorAll('button')]
          .find(button => visible(button) && text(button) === '打开控制台');
        if (consoleToggle) {
          consoleToggle.click();
          await sleep(100);
        }
        const started = performance.now();
        compileButton.click();
        for (let attempt = 0; attempt < 600; attempt += 1) {
          const currentButton = [...document.querySelectorAll('button')]
            .find(button => visible(button) && button.title === '仅编译，不上传');
          const toast = [...document.querySelectorAll('*')]
            .find(element => visible(element) && /^编译成功 \\([0-9.]+s\\)$/.test(text(element)));
          const currentText = document.body.innerText || '';
          const successMatches = [...currentText.matchAll(successPattern)];
          if (!currentButton?.disabled
            && performance.now() - started >= 250
            && (toast || successMatches.length > 0)) {
            return {
              wallMs: Math.round(performance.now() - started),
              toast: text(toast) || successMatches.at(-1)?.[0] || '',
              visibleTextTail: currentText.slice(-5000),
            };
          }
          await sleep(50);
        }
        throw new Error('Compile success toast was not observed; buttonDisabled='
          + String(compileButton.disabled)
          + '; visibleTextTail=' + (document.body.innerText || '').slice(-3000));
      };
      const first = await run();
      await sleep(250);
      const workspace = globalThis.Blockly?.getMainWorkspace?.()
        || globalThis.Blockly?.Workspace?.getAll?.()?.[0]
        || null;
      const allFields = workspace?.getAllBlocks?.(false)
        ?.flatMap(block => block.inputList.flatMap(input => input.fieldRow)) || [];
      const mutableField = allFields.find(field => typeof field.getValue === 'function'
        && typeof field.setValue === 'function'
        && /^-?[0-9]+(?:\\.[0-9]+)?$/.test(String(field.getValue())))
        || allFields.find(field => typeof field.getValue === 'function'
          && typeof field.setValue === 'function'
          && typeof field.getValue() === 'string');
      if (mutableField) {
        const original = String(mutableField.getValue());
        const current = Number(original);
        mutableField.setValue(Number.isFinite(current) ? String(current + 1) : original + 'x');
        await sleep(150);
      }
      const edited = await run();
      return {
        projectName: ${JSON.stringify(projectName)},
        first,
        edited,
        editedWorkspace: Boolean(mutableField),
      };
    })()`);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
