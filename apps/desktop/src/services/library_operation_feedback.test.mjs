import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./library_operation_feedback.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'library_operation_feedback.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const api = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('normalizes multi-selection and removes duplicate Windows paths case-insensitively', () => {
    assert.deepEqual(api.selectedLibraryImportPaths([
        'C:\\Libs\\One.zip',
        'c:\\libs\\one.zip',
        'C:\\Libs\\Two.zip',
    ]), ['C:\\Libs\\One.zip', 'C:\\Libs\\Two.zip']);
});

test('creates a deterministic sequential queue with readable filenames', () => {
    const queue = api.createLibraryImportQueue(['C:\\Libs\\Sensor.zip', 'C:\\Libs\\library.json'], 'block-package');
    assert.deepEqual(queue.map(item => [item.label, item.status]), [
        ['Sensor.zip', 'pending'],
        ['library.json', 'pending'],
    ]);
    assert.notEqual(queue[0].id, queue[1].id);
});

test('retains backend quality-gate reasons and structured details', () => {
    const feedback = api.describeLibraryOperationError(new Error([
        'Error: 包质量门禁拒绝安装',
        '缺少 LICENSE 或 SPDX 许可证声明',
        'ck-blocks.json 与 generator 定义不一致',
    ].join('\n')));
    assert.equal(feedback.summary, '包质量门禁拒绝安装');
    assert.deepEqual(feedback.details, [
        '缺少 LICENSE 或 SPDX 许可证声明',
        'ck-blocks.json 与 generator 定义不一致',
    ]);
    assert.match(feedback.raw, /LICENSE/);
});

