import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const source = await readFile(new URL('./HardwareResourceInspector.tsx', import.meta.url), 'utf8');
const healthViewSource = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');

const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'HardwareResourceInspector.tsx',
    reportDiagnostics: true,
});

test('HardwareResourceInspector exposes an evidence-backed conflict card', () => {
    assert.match(source, /view\.conflictTraces/);
    assert.match(source, /data-ck-role="hardware-resource-conflicts"/);
    assert.match(source, /data-ck-role="hardware-resource-conflict-card"/);
    assert.match(source, /data-resource-id=/);
    assert.match(source, /trace\.conflict\.code/);
    assert.match(source, /trace\.claims/);
    assert.match(source, /trace\.bindings/);
    assert.match(source, /trace\.evidence/);
    assert.match(source, /resource-conflict-explanation/);
    assert.match(source, /conflictDetail\(trace\.conflict\.code, 'reason'/);
    assert.match(source, /conflictDetail\(trace\.conflict\.code, 'impact'/);
    assert.match(source, /conflictDetail\(trace\.conflict\.code, 'suggestion'/);
});

test('conflict cards expose a source-block locate callback without inventing block ids', () => {
    assert.match(source, /onLocateBlock\?: \(blockId: string\) => void/);
    assert.match(source, /data-ck-role=\{role\}/);
    assert.match(source, /role = 'resource-conflict-locate'/);
    assert.match(source, /data-block-id=/);
    assert.match(source, /onLocateBlock\(/);
    assert.match(source, /trace\.blockReferences/);
    assert.match(source, /onClick=\{[^}]*onLocateBlock/);
    assert.match(source, /if \(!normalized \|\| !onLocateBlock\) return null/);
});

test('resource trace UI shows a stable resource-to-claim-to-evidence path', () => {
    assert.match(source, /view\.resourceTraces/);
    assert.match(source, /<details[^>]*data-ck-role="hardware-resource-trace"/);
    assert.match(source, /data-resource-id=/);
    assert.match(source, /data-ck-role="resource-trace-node"/);
    assert.match(source, /trace\.resourceId/);
    assert.match(source, /trace\.currentUsage/);
    assert.match(source, /trace\.claims/);
    assert.match(source, /trace\.bindings/);
    assert.match(source, /trace\.evidence/);
});

test('bus cards provide an expandable relation view without flattening devices into pin usage', () => {
    assert.match(source, /view\.buses/);
    assert.match(source, /data-ck-role="hardware-resource-bus"/);
    assert.match(source, /data-ck-role="hardware-resource-bus-details"/);
    assert.match(source, /bus\.signals/);
    assert.match(source, /bus\.devices/);
    assert.match(source, /device\.address/);
    assert.match(source, /device\.signals/);
    assert.match(source, /bus\.status/);
});

test('third-party resources use the same generic data projection and do not branch on board names', () => {
    assert.match(source, /resourceInspector\./);
    assert.doesNotMatch(source, /Arduino|Uno|Nano|Mega|ESP32|esp32c3|esp32c6|C3|C6/);
    assert.match(source, /visiblePins\.map/);
    assert.match(source, /view\.buses\.map/);
    assert.match(source, /view\.timers\.map/);
    assert.match(source, /visibleTraces\.map/);
});

test('EngineeringHealthView keeps inspector callback wiring presentation-only', () => {
    assert.match(healthViewSource, /<HardwareResourceInspector/);
    assert.match(healthViewSource, /view=\{hardwareResourceInspector\}/);
    assert.match(healthViewSource, /onLocateBlock=\{onLocateBlock\}/);
});

test('HardwareResourceInspector.tsx transpiles without syntax errors', () => {
    const errors = (transpiled.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(errors, []);
});
