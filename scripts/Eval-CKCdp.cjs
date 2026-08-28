const WebSocket = require('../apps/desktop/node_modules/ws');

const cdpUrl = process.env.CK_CDP_URL;
const expression = process.env.CK_CDP_EXPRESSION;
if (!cdpUrl || !expression) throw new Error('CK_CDP_URL and CK_CDP_EXPRESSION are required');

const socket = new WebSocket(cdpUrl);
socket.on('open', () => socket.send(JSON.stringify({
  id: 1,
  method: 'Runtime.evaluate',
  params: { expression, awaitPromise: true, returnByValue: true },
})));
socket.on('message', raw => {
  const message = JSON.parse(raw);
  if (message.error || message.result?.exceptionDetails) {
    process.stderr.write(`${JSON.stringify(message.error || message.result.exceptionDetails, null, 2)}\n`);
    process.exitCode = 1;
  } else {
    const value = message.result?.result?.value;
    process.stdout.write(`${typeof value === 'string' ? value : JSON.stringify(value, null, 2)}\n`);
  }
  socket.close();
});
