import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./DiagnosticBundleModal.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
    },
    fileName: 'DiagnosticBundleModal.tsx',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'DiagnosticBundleModal.tsx should transpile without syntax errors');

test('modal exposes all source levels and four independent privacy controls', () => {
    for (const value of ['full_project', 'generated_source_only', 'no_source']) {
        assert.match(source, new RegExp(`value: '${value}'`));
    }
    for (const key of ['redactWifi', 'redactUsername', 'redactPaths', 'redactSerialContent']) {
        assert.match(source, new RegExp(`key: '${key}'`));
    }
    assert.match(
        source,
        /useState<DiagnosticContentLevel>\('no_source'\)/,
        'the privacy-first default must exclude generated source and its source map',
    );
    assert.match(source, /默认不带源码/);
});

test('local import summary shows every requested diagnosis field', () => {
    for (const label of ['板卡', 'Core', '完整 FQBN', 'Flash', 'Core 状态', '失败阶段']) {
        assert.ok(source.includes(label), `missing summary field ${label}`);
    }
    assert.match(source, /summary\.sourceIncluded/);
    assert.match(source, /deriveDiagnosticCoreAvailability/);
    assert.match(source, /currentCoreVersions/);
});

test('UI explicitly guarantees local-only behavior and uses no network API', () => {
    assert.match(source, /只在本机处理/);
    assert.match(source, /不联网/);
    assert.match(source, /不自动上传/);
    assert.match(source, /inspectDiagnosticBundle\(selected\)/);
    assert.doesNotMatch(source, /\bfetch\s*\(/);
    assert.doesNotMatch(source, /axios|XMLHttpRequest|WebSocket/);
    assert.match(source, /dark:bg-/);
});
