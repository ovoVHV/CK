import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readFile } from 'node:fs/promises';
import ts from '../apps/desktop/node_modules/typescript/lib/typescript.js';

const require = createRequire(import.meta.url);
const WebSocket = require('../apps/desktop/node_modules/ws');
const { restoreNativeViewport } = require(process.env.CK_NATIVE_CDP_VIEWPORT_GUARD || './native-cdp-viewport-guard.cjs');

const transpile = (source, fileName) => ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName,
    reportDiagnostics: true,
});

const markerServicePath = new URL('../apps/desktop/src/services/block_markers.ts', import.meta.url);
const markerServiceSource = await readFile(markerServicePath, 'utf8');
const markerTranspiled = transpile(markerServiceSource, 'block_markers.ts');
const markerSyntaxErrors = (markerTranspiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(markerSyntaxErrors, [], 'block_markers.ts should transpile without syntax errors');
const markerModuleUrl = `data:text/javascript;base64,${Buffer.from(markerTranspiled.outputText).toString('base64')}`;
const markerService = await import(markerModuleUrl);
const marker = blockId => markerService.createBlockMarkerComment(blockId);

const servicePath = new URL('../apps/desktop/src/services/block_debugger.ts', import.meta.url);
const serviceSource = await readFile(servicePath, 'utf8');
const transpiled = transpile(serviceSource, 'block_debugger.ts');
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);
const debuggerOutput = transpiled.outputText.replace(
    /from ['"]\.\/block_markers['"];/,
    `from '${markerModuleUrl}';`,
);
assert.notEqual(
    debuggerOutput,
    transpiled.outputText,
    'block marker import should be rewritten for the native test loader',
);
const debuggerService = await import(
    `data:text/javascript;base64,${Buffer.from(debuggerOutput).toString('base64')}`
);

const sourceCode = `void helper() {
  delay(1); ${marker('helper-delay')}
}

void setup() {
}

void loop() {
  helper();
  delay(10); ${marker('native-delay')}
}`;
const debugSketch = debuggerService.createDebugSketch(
    sourceCode,
    new Set(['helper-delay', 'native-delay']),
    'native_debug_v2',
);
assert.equal(debugSketch.missingBreakpointIds.length, 0);
assert.equal(debugSketch.instrumentedBlockIds.has('helper-delay'), true);
assert.equal(debugSketch.instrumentedBlockIds.has('native-delay'), true);
const runtimeCheckpointIndex = debugSketch.code.indexOf('static void __ck_debug_checkpoint(');
const helperFunctionIndex = debugSketch.code.indexOf('void helper()');
assert.notEqual(runtimeCheckpointIndex, -1, 'debug runtime should declare its checkpoint function');
assert.notEqual(helperFunctionIndex, -1, 'debug sketch should preserve the user helper function');
assert.ok(
    runtimeCheckpointIndex < helperFunctionIndex,
    'debug runtime checkpoint must be declared before a user function can call it',
);

const socket = new WebSocket(process.env.CK_CDP_URL);
const pending = new Map();
let nextId = 0;

function call(method, params = {}) {
    return new Promise((resolve, reject) => {
        const id = ++nextId;
        pending.set(id, { resolve, reject });
        socket.send(JSON.stringify({ id, method, params }));
    });
}

socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
});

socket.on('open', async () => {
    try {
        await restoreNativeViewport(call);
        const fqbn = process.env.CK_TEST_FQBN || 'esp32:esp32:esp32s3';
        const expression = `(async () => {
          const invoke = window.__TAURI_INTERNALS__?.invoke;
          if (typeof invoke !== 'function') throw new Error('Tauri invoke is unavailable');
          const started = performance.now();
          const raw = await invoke('compile_sketch', {
            code: ${JSON.stringify(debugSketch.code)},
            fqbn: ${JSON.stringify(fqbn)},
            workspaceFingerprint: 'native-block-debugger-v2',
          });
          return { raw, elapsedMs: performance.now() - started };
        })()`;
        const evaluated = await call('Runtime.evaluate', {
            expression,
            awaitPromise: true,
            returnByValue: true,
        });
        if (evaluated.exceptionDetails) {
            throw new Error(evaluated.exceptionDetails.exception?.description || evaluated.exceptionDetails.text);
        }
        const compileResult = evaluated.result.value;
        const parsed = JSON.parse(compileResult.raw);
        assert.ok(parsed.path, 'debug sketch should return a build path');
        const report = {
            fqbn,
            elapsedMs: Math.round(compileResult.elapsedMs),
            buildPath: parsed.path,
            diagnostics: parsed.diagnostics || null,
            debug: {
                baudRate: debugSketch.baudRate,
                instrumentedBlocks: debugSketch.instrumentedBlockIds.size,
                instrumentedBlockIds: [...debugSketch.instrumentedBlockIds].sort(),
                runtimeBytes: Buffer.byteLength(debugSketch.code, 'utf8'),
            },
        };
        process.stdout.write(`${JSON.stringify(report, null, 2)}\n`);
    } catch (error) {
        process.stderr.write(`${error.stack || error}\n`);
        process.exitCode = 1;
    } finally {
        socket.close();
    }
});
