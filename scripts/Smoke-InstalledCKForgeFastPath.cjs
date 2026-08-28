const WebSocket = require('../apps/desktop/node_modules/ws');

const cdpUrl = process.env.CK_CDP_URL;
const fqbn = process.env.CK_TEST_FQBN || 'arduino:avr:diecimila:cpu=atmega328';
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
    const result = await evaluate(`(async () => {
      const invoke = window.__TAURI_INTERNALS__?.invoke;
      if (typeof invoke !== 'function') throw new Error('Tauri invoke is unavailable');
      const fqbn = ${JSON.stringify(fqbn)};
      const compile = async (level) => {
        const code = '#include <Arduino.h>\\nvoid setup(){pinMode(13, OUTPUT);}\\nvoid loop(){digitalWrite(13, ' + level + ');delay(1);}';
        const started = performance.now();
        const raw = await invoke('compile_sketch', {
          code,
          fqbn,
          runId: crypto.randomUUID(),
        });
        const parsed = JSON.parse(raw);
        return {
          wallMs: Math.round(performance.now() - started),
          path: parsed.path || '',
          log: parsed.log || '',
          diagnostics: parsed.diagnostics || {},
        };
      };
      return {
        first: await compile('HIGH'),
        edited: await compile('LOW'),
      };
    })()`);

    const summarize = run => ({
      wallMs: run.wallMs,
      buildMode: run.diagnostics?.buildMode || '',
      coreVersion: run.diagnostics?.engine?.coreVersion || '',
      fqbn: run.diagnostics?.fqbn || '',
      certificateMatched: /NativeRelinkCompileOnly certificate matched/i.test(run.log),
      fastRelink: /native-relink-compile-only/i.test(run.diagnostics?.buildMode || ''),
      path: run.path,
    });
    const report = { fqbn, first: summarize(result.first), edited: summarize(result.edited) };
    report.passed = report.edited.fastRelink
      && report.edited.coreVersion === '1.8.8'
      && report.edited.fqbn === fqbn
      && Boolean(report.edited.path);
    process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    process.exitCode = report.passed ? 0 : 2;
  } catch (error) {
    process.stderr.write(`${error.stack || error}\n`);
    process.exitCode = 1;
  } finally {
    socket.close();
  }
});
