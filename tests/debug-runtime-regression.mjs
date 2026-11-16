// Reproduce the shipped debugger/trace behavior without changing product code.
// Host C++ execution substitutes clocks/Serial; it is not hardware qualification.
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';

const root = fileURLToPath(new URL('../', import.meta.url));
const desktop = path.join(root, 'desktop/apps/desktop');
const require = createRequire(path.join(desktop, 'package.json'));
const { build } = require('esbuild');
const out = path.resolve(process.argv[2] || 'C:/CKLocalPerf/debug-fix-runtime');
fs.mkdirSync(out, { recursive: true });
const bundle = path.join(desktop, `.debug-runtime-audit-${process.pid}.mjs`);
await build({
  stdin: { contents: `export * from './src/services/block_debugger';
    export * from './src/services/block_markers';
    export { arduinoGenerator } from './src/components/arduino_generator';
    export * as Blockly from 'blockly';`, resolveDir: desktop, loader: 'ts' },
  bundle: true, format: 'esm', platform: 'node', packages: 'external',
  outfile: bundle, logLevel: 'silent',
});
let api;
try { api = await import(pathToFileURL(bundle).href); }
finally { fs.unlinkSync(bundle); }
const { Blockly, arduinoGenerator: generator, createDebugSketch, createTraceSketch,
  createBlockMarkerComment: marker } = api;

Blockly.defineBlocksWithJsonArray([
  { type: 'audit_guard', message0: 'guard %1', args0: [{ type: 'input_statement', name: 'DO' }],
    previousStatement: null, nextStatement: null, colour: 210 },
  { type: 'audit_increment', message0: 'increment %1', args0: [{ type: 'field_number', name: 'N', value: 1 }],
    previousStatement: null, nextStatement: null, colour: 210 },
  { type: 'wifi_wait_until_ready', message0: 'wait for WiFi', previousStatement: null, nextStatement: null, colour: 210 },
]);
generator.forBlock.audit_guard = block => `if (false)\n${generator.statementToCode(block, 'DO')}`;
generator.forBlock.audit_increment = block => {
  generator.addDeclaration('auditCount', 'int auditCount = 0;');
  return `auditCount += ${block.getFieldValue('N')};\n`;
};
const ws = new Blockly.Workspace();
const guard = ws.newBlock('audit_guard', 'guard');
const child = ws.newBlock('audit_increment', 'child');
const tail = ws.newBlock('audit_increment', 'tail');
tail.setFieldValue(10, 'N');
guard.getInput('DO').connection.connect(child.previousConnection);
guard.nextConnection.connect(tail.previousConnection);
const generated = generator.workspaceToCode(ws);
ws.dispose();
const debug = createDebugSketch(generated, new Set(['child']), 'audit');
const trace = createTraceSketch(generated, 'audit');
for (const [name, source] of Object.entries({ normal: generated, debug: debug.code, trace: trace.code })) {
  fs.writeFileSync(path.join(out, `${name}-unbraced.ino`), source);
}

const waitWs = new Blockly.Workspace();
waitWs.newBlock('wifi_wait_until_ready', 'wifi-wait');
const waitSource = generator.workspaceToCode(waitWs);
waitWs.dispose();
const waitTrace = createTraceSketch(waitSource, 'audit');
fs.writeFileSync(path.join(out, 'builtin-wifi-wait.ino'), waitTrace.code);
const waitStart = waitTrace.code.indexOf('while (WiFi.status()');
assert(waitStart >= 0, 'Use the actual built-in wait generator');
const waitBody = waitTrace.code.slice(waitStart, waitTrace.code.indexOf('}', waitStart));

const sampleSource = `void setup() {}\nvoid loop() {\n  tick(); ${marker('a')}\n  tick(); ${marker('b')}\n  tick(); ${marker('c')}\n}`;
const sample = createTraceSketch(sampleSource, 'audit');
const largeSource = `void setup() {}\nvoid loop() {\n${Array.from({ length: 70 }, (_, i) => `  tick(); ${marker('block-' + i)}`).join('\n')}\n}`;
const large = createTraceSketch(largeSource, 'audit');
const paused = createDebugSketch(`void setup() {}\nvoid loop() {\n tick(); ${marker('pause')}\n}`, new Set(['pause']), 'audit');
const variableBaud = createTraceSketch(`const unsigned long USER_BAUD = 9600;\nvoid setup() {\n Serial.begin(USER_BAUD); ${marker('baud')}\n}\nvoid loop() {\n tick(); ${marker('baud-tick')}\n}`, 'audit');

const controlFlowSource = `int result = 0;
// void setup() { fake hook }
struct Item { int n; };
struct Timer { void delay(int) {} };
void setup(void) {}
void loop() {
  Item items[] = {
    {3}, {4}
  };
  Timer timer; Timer* pointer = &timer;
  pointer->delay(1); ${marker('member-delay')}
  if (false)
    if (true)
      result += 100; ${marker('nested-child')}
    else
      result += 1000; ${marker('else-child')}
  if (false)
    label: result += 10000; ${marker('labeled-child')}
  for (int i=0; i<2; ++i)
    result += items[i].n; ${marker('for-child')}
  int n = 0;
  do { ${marker('do-start')}
    result += 2; ${marker('do-body')}
    n++;
  }
  while (n < 2); ${marker('do-condition')}
  switch(n) {
    case 2: result += 4; ${marker('case')}
      break;
    default: result += 1000; ${marker('default')}
  }
  result += 10; ${marker('tail')}
}`;
const controlFlowDebug = createDebugSketch(controlFlowSource, new Set(), 'audit');
const controlFlowTrace = createTraceSketch(controlFlowSource, 'audit');

const header = `#pragma once
#include <cstdint>
#include <cstddef>
#include <string>
#include <sstream>
#include <iostream>
#include <stdexcept>
#include <functional>
static unsigned long clockUs = 100000;
static std::function<void()> idleHook;
static bool wifiReady = false;
static const int WL_CONNECTED = 3;
struct WiFiMock { int status() { return wifiReady ? WL_CONNECTED : 0; } } WiFi;
static unsigned long micros() { return clockUs; }
static unsigned long millis() { return clockUs / 1000; }
static void yield() {}
static void delay(unsigned long ms) { clockUs += ms * 1000; if (idleHook) idleHook(); }
static void tick() { clockUs += 1000; }
struct SerialMock {
  std::string rx, tx;
  unsigned long baud = 0;
  void begin(unsigned long value) { baud = value; }
  int available() { return (int)rx.size(); }
  int read() { if (rx.empty()) return -1; char c = rx.front(); rx.erase(0,1); return (unsigned char)c; }
  void write(uint8_t c) { tx += (char)c; }
  template<class T> void print(T value) { std::ostringstream s; s << value; tx += s.str(); }
  template<class T> void println(T value) { print(value); tx += "\\n"; }
  void println() { tx += "\\n"; }
} Serial;
`;
fs.writeFileSync(path.join(out, 'Arduino.h'), header);
fs.writeFileSync(path.join(out, 'WiFi.h'), '#pragma once\n');
const harness = `#include "Arduino.h"
namespace normal {
${generated}
}
namespace debug {
${debug.code}
}
namespace trace {
${trace.code}
}
namespace sampled {
${sample.code}
}
namespace paused {
${paused.code}
}
namespace waiting {
${waitTrace.code}
}
namespace baudcase {
${variableBaud.code}
}
namespace controlsNormal {
${controlFlowSource}
}
namespace controlsDebug {
${controlFlowDebug.code}
}
namespace controlsTrace {
${controlFlowTrace.code}
}
int main() {
  controlsNormal::loop(); controlsDebug::loop(); controlsTrace::loop();
  std::cout << "control_flow " << controlsNormal::result << " " << controlsDebug::result << " " << controlsTrace::result << "\\n";
  controlsDebug::result = 0; controlsTrace::result = 0;
  controlsDebug::__ck_debug_enabled = true; controlsTrace::__ck_debug_enabled = true;
  controlsDebug::loop(); controlsTrace::loop();
  std::cout << "control_flow_attached " << controlsDebug::result << " " << controlsTrace::result << "\\n";
  normal::loop(); debug::loop(); trace::loop();
  std::cout << "unbraced " << normal::auditCount << " " << debug::auditCount << " " << trace::auditCount << "\\n";
  Serial.tx.clear(); sampled::__ck_debug_enabled = true;
  sampled::loop(); Serial.tx.clear();
  for (int i = 0; i < 60; ++i) { clockUs += 50000; sampled::loop(); }
  int hits[3] = {0};
  for (int i = 0; i < 3; ++i) {
    const std::string needle = "|TRACE|" + std::to_string(i) + "|";
    for (size_t pos = 0; (pos = Serial.tx.find(needle, pos)) != std::string::npos; pos += needle.size()) hits[i]++;
  }
  std::cout << "samples " << hits[0] << " " << hits[1] << " " << hits[2] << "\\n";
  Serial.rx = "user payload\\n";
  const size_t applicationInputBefore = Serial.rx.size();
  sampled::loop();
  std::cout << "non_protocol_input " << applicationInputBefore << " " << Serial.rx.size() << "\\n";
  Serial.rx = "@@CKDBG|audit|CMD|ATTACH\\n";
  baudcase::setup();
  std::cout << "variable_baud " << ${variableBaud.baudRate} << " " << Serial.baud << "\\n";
  // A bounded mock timeout prevents a broken firmware loop from hanging the audit.
  Serial.rx = "@@CKDBG|audit|CMD|STEP\\n"; Serial.tx.clear();
  unsigned long entered = millis();
  idleHook = [&] { if (millis() - entered > 1500) throw std::runtime_error("bounded mock timeout"); };
  try { sampled::loop(); } catch (const std::exception&) {}
  std::cout << "trace_step_paused " << (Serial.tx.find("|PAUSED|") != std::string::npos) << "\\n";
  idleHook = nullptr; Serial.rx.clear(); Serial.tx.clear();
  paused::__ck_debug_enabled = true; entered = millis();
  idleHook = [&] { if (millis() - entered > 15000) throw std::runtime_error("bounded mock timeout"); };
  bool returned = false;
  try { paused::loop(); returned = true; } catch (const std::exception&) {}
  std::cout << "paused_without_host " << returned << " " << paused::__ck_debug_enabled << " " << millis()-entered << "\\n";
  idleHook = nullptr; Serial.rx = "@@CKDBG|audit|CMD|STOP\\n";
  paused::loop();
  std::cout << "stop_at_checkpoint " << paused::__ck_debug_enabled << " " << (Serial.tx.find("|STOPPED") != std::string::npos) << "\\n";
  Serial.rx.clear(); Serial.tx.clear(); waiting::__ck_debug_enabled = true; entered = millis();
  bool queued = false;
  idleHook = [&] {
    if (!queued) { Serial.rx = "@@CKDBG|audit|CMD|STOP\\n"; queued = true; }
    if (millis() - entered > 15000) throw std::runtime_error("bounded mock timeout");
  };
  try { waiting::loop(); } catch (const std::exception&) {}
  std::cout << "stop_in_wait " << waiting::__ck_debug_enabled << " " << (Serial.rx.size() > 0) << " " << (Serial.tx.find("|STOPPED") != std::string::npos) << "\\n";
  idleHook = nullptr;
  Serial.rx = "@@CKDBG|audit|CMD|ATTACH|9\\n";
  bool fresh = sampled::__ck_debug_poll_command() == sampled::__CK_DEBUG_ATTACH;
  Serial.rx = "@@CKDBG|audit|CMD|STEP|9\\n";
  bool duplicate = sampled::__ck_debug_poll_command() == sampled::__CK_DEBUG_NONE;
  Serial.rx = "@@CKDBG|audit|CMD|STOP|7\\n";
  bool stale = sampled::__ck_debug_poll_command() == sampled::__CK_DEBUG_NONE;
  Serial.rx = "@@CKDBG|audit|CMD|STOP|4294967296\\n";
  bool invalid = sampled::__ck_debug_poll_command() == sampled::__CK_DEBUG_NONE;
  Serial.rx = "@@CKDBG|audit|CMD|STOP|10\\n";
  bool next = sampled::__ck_debug_poll_command() == sampled::__CK_DEBUG_STOP;
  std::cout << "command_sequence " << fresh << " " << duplicate << " " << stale << " " << invalid << " " << next << " " << sampled::__ck_debug_sequence << "\\n";
}
`;
fs.writeFileSync(path.join(out, 'runtime-audit.cpp'), harness);
const vswhere = 'C:/Program Files (x86)/Microsoft Visual Studio/Installer/vswhere.exe';
const vs = spawnSync(vswhere, ['-latest', '-products', '*', '-requires', 'Microsoft.VisualStudio.Component.VC.Tools.x86.x64', '-property', 'installationPath'], { encoding: 'utf8' });
assert.equal(vs.status, 0, vs.stderr);
const dev = path.join(vs.stdout.trim(), 'Common7/Tools/VsDevCmd.bat');
assert(fs.existsSync(dev), 'MSVC build environment is required for executable audit');
fs.writeFileSync(path.join(out, 'build-host.cmd'), `@echo off\r\ncall "${dev}" -arch=x64 -host_arch=x64 >nul\r\nif errorlevel 1 exit /b 1\r\ncl /nologo /EHsc /std:c++17 /utf-8 /W0 /I. /Fe:runtime-audit.exe runtime-audit.cpp\r\n`);
const compile = spawnSync('cmd.exe', ['/d', '/c', 'build-host.cmd'], { cwd: out, encoding: 'utf8', timeout: 60000 });
fs.writeFileSync(path.join(out, 'host-compile.log'), compile.stdout + compile.stderr);
assert.equal(compile.status, 0, compile.stdout + compile.stderr);
const run = spawnSync(path.join(out, 'runtime-audit.exe'), [], { cwd: out, encoding: 'utf8', timeout: 10000 });
fs.writeFileSync(path.join(out, 'host-run.log'), run.stdout + run.stderr);
assert.equal(run.status, 0, run.stdout + run.stderr);
const rows = Object.fromEntries(run.stdout.trim().split(/\r?\n/).map(line => { const [name, ...values] = line.split(' '); return [name, values.map(Number)]; }));
// Shared Serial RX is explicitly unsupported, including aliases and all
// built-in read methods. Ordinary non-instrumented code is unaffected.
for (const expression of ['Serial.readStringUntil(10)', 'Serial.readBytes(buf, 2)', 'auto& serial = Serial']) {
  assert.throws(() => createTraceSketch(`void setup() {}\nvoid loop() {\n ${expression}; ${marker('serial')}\n}`, 'audit'), /Serial/);
}
assert.deepEqual(rows.unbraced, [10, 10, 10]);
assert.deepEqual(rows.control_flow, [25, 25, 25]);
assert.deepEqual(rows.control_flow_attached, [25, 25]);
assert.deepEqual(rows.command_sequence, [1, 1, 1, 1, 1, 10]);
assert( debug.unsupportedBlockIds.includes('child') );
assert.equal(rows.trace_step_paused[0], 0);
assert.deepEqual(rows.variable_baud, [9600, 9600]);
assert.deepEqual(rows.stop_in_wait, [0, 0, 1]);
assert.deepEqual(rows.stop_at_checkpoint, [0, 1]);
assert(rows.samples.every(n => n > 0));
const report = { createdAt: new Date().toISOString(), status: 'PASS',
  boundary: 'Host runtime regression. Paused-without-host and exclusive-Serial ownership are retained contracts, not claimed fixed by auto-resume. No hardware qualification.',
  sourceCommit: spawnSync('git', ['rev-parse', 'HEAD'], { cwd: root, encoding: 'utf8' }).stdout.trim(),
  generatorSha256: createHash('sha256').update(fs.readFileSync(path.join(desktop, 'src/services/block_debugger.ts'))).digest('hex'),
  checks: { controlFlowPreserved: true, unsafeCheckpointExcluded: true, traceCannotPause: true,
    constantBaudResolved: true, builtinWaitStopAcknowledged: true, serialReadersRejected: true,
    checkpointStopWorks: true, allSamplePointsObserved: true,
    nestedControlFlowPreserved: true, duplicateStaleMalformedCommandsRejected: true },
  retainedContracts: { pausedUntilExplicitCommand: rows.paused_without_host[0] === 0,
    serialRxOwnedByProtocol: true, crossLibrarySerialUseNotQualified: true }, raw: rows };
fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
console.log(JSON.stringify(report, null, 2));
