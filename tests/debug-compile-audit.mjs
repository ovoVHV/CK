// Compiler qualification for the shipped debug/trace sketch transformer.
// No serial port is opened and no device is flashed.
import fs from 'node:fs';
import path from 'node:path';
import { createRequire } from 'node:module';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { spawn } from 'node:child_process';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'desktop/apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = require('esbuild');
const config = JSON.parse(fs.readFileSync(process.argv[2] || path.join(root, 'local/engine.json'), 'utf8').replace(/^\uFEFF/, ''));
const out = path.resolve(process.argv[3] || 'C:/CKLocalPerf/debug-compile-review');
fs.mkdirSync(out, { recursive: true });
const bundle = path.join(out, 'debugger.mjs');
await build({ entryPoints: [path.join(desktop, 'src/services/block_debugger.ts')], bundle: true,
  format: 'esm', platform: 'node', outfile: bundle, logLevel: 'silent' });
const { createDebugSketch, createTraceSketch } = await import(pathToFileURL(bundle).href);
const body = 'void setup() {\n  Serial.begin(115200); /* @ck:setup-serial */\n}\nvoid loop() {\n  delay(10); /* @ck:delay */\n}\n';
const targets = JSON.parse(process.env.CK_DEBUG_AUDIT_TARGETS || '["arduino:avr:uno","esp32:esp32:esp32s3"]');
const report = { status: 'RUNNING', boundary: 'Actual installed Arduino compiler pipelines; no hardware upload, desktop UI, or runtime qualification', runs: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
save();
function run(command, args, log) {
  return new Promise((resolve, reject) => {
    const fd = fs.openSync(log, 'w');
    const child = spawn(command, args, { stdio: ['ignore', fd, fd], windowsHide: true });
    child.once('error', error => { fs.closeSync(fd); reject(error); });
    child.once('exit', (code, signal) => { fs.closeSync(fd); resolve({ code, signal }); });
  });
}
for (const fqbn of targets) for (const includeArduino of [false, true]) for (const mode of ['debug', 'trace']) {
  const name = `${fqbn.split(':')[2]}-${includeArduino ? 'explicit-header' : 'implicit-header'}-${mode}`;
  const sketchDir = path.join(out, name);
  fs.mkdirSync(sketchDir, { recursive: true });
  const source = (includeArduino ? '#include <Arduino.h>\n' : '') + body;
  const transformed = mode === 'debug' ? createDebugSketch(source, new Set(['delay']), 'audit') : createTraceSketch(source, 'audit');
  const sketch = path.join(sketchDir, name + '.ino');
  fs.writeFileSync(sketch, transformed.code);
  const args = ['compile', '--config-file', config.paths.cliConfig, '--fqbn', fqbn, '--build-path', path.join(out, `build-${name}`), '--jobs', '8', sketchDir];
  console.log('START ' + name);
  const started = Date.now();
  const result = await run(config.paths.cli, args, path.join(out, name + '.log'));
  const row = { name, fqbn, includeArduino, mode, code: result.code, signal: result.signal, wallMs: Date.now() - started,
    sourceSha256: createHash('sha256').update(transformed.code).digest('hex'), command: [config.paths.cli, ...args], log: name + '.log' };
  report.runs.push(row); save(); console.log(JSON.stringify(row));
}
report.status = report.runs.some(r => r.code !== 0) ? 'FINDINGS' : 'PASS'; save();
console.log('REPORT ' + path.join(out, 'report.json'));
