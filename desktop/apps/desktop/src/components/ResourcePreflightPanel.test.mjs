import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./ResourcePreflightPanel.tsx', import.meta.url), 'utf8');
const typesSource = await readFile(new URL('../services/resource_preflight.ts', import.meta.url), 'utf8');
const healthSource = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');

test('resource preflight panel is a read-only status surface with all four result states', () => {
    assert.match(source, /data-ck-role="resource-preflight-panel"/);
    assert.match(source, /data-preflight-status=\{report\.status\}/);
    assert.match(source, /pass.*warning.*conflict.*unavailable/s);
    assert.match(source, /resourcePreflight\.status\./);
    assert.match(source, /resourcePreflight\.phase\./);
    assert.match(source, /unavailableReason/);
    assert.doesNotMatch(source, /allocate|autoAssign|setPin|mutateWorkspace|invoke\(/i);
});

test('each preflight check explains claims, blocks, bindings, evidence and supports block location', () => {
    assert.match(source, /check\.claimIds/);
    assert.match(source, /check\.blockReferences/);
    assert.match(source, /check\.bindings/);
    assert.match(source, /check\.evidence/);
    assert.match(source, /explanationFor/);
    assert.match(source, /resourceInspector\.conflictDetails/);
    assert.match(source, /data-ck-role="resource-preflight-locate"/);
    assert.match(source, /data-block-id=\{blockId\}/);
    assert.match(source, /onClick=\{\(\) => onLocateBlock\(blockId\)\}/);
});

test('preflight presentation contract contains no board-specific identity or analysis fields', () => {
    assert.match(typesSource, /ResourcePreflightReport/);
    assert.match(typesSource, /ResourcePreflightCheck/);
    assert.match(typesSource, /status: ResourcePreflightStatus/);
    assert.match(typesSource, /phase: ResourcePreflightPhase/);
    assert.match(typesSource, /blockReferences: string\[\]/);
    assert.match(typesSource, /bindings: InspectorBindingTrace\[\]/);
    assert.doesNotMatch(typesSource, /Uno|Nano|Mega|ESP32|FQBN|generator|compile_sketch/i);
});

test('engineering health renders preflight beside existing presentation-only health panels', () => {
    assert.match(healthSource, /ResourcePreflightPanel/);
    assert.match(healthSource, /resourcePreflightReport\?: ResourcePreflightReport/);
    assert.match(healthSource, /<ResourcePreflightPanel/);
    assert.match(healthSource, /onLocateBlock=\{onLocateBlock\}/);
});

test('ResourcePreflightPanel.tsx transpiles without syntax errors', () => {
    const result = ts.transpileModule(source, {
        compilerOptions: {
            jsx: ts.JsxEmit.ReactJSX,
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
            moduleResolution: ts.ModuleResolutionKind.Bundler,
        },
        fileName: 'ResourcePreflightPanel.tsx',
        reportDiagnostics: true,
    });
    const diagnostics = (result.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error);
    assert.deepEqual(diagnostics, [], 'ResourcePreflightPanel.tsx should transpile without syntax errors');
});
