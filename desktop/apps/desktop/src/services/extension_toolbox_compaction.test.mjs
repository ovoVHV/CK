import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./extension_toolbox_compaction.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'extension_toolbox_compaction.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const { compactExtensionToolboxXml } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('wraps many package categories behind one collapsed top-level extension entry', () => {
    const packages = Array.from(
        { length: 50 },
        (_, index) => `<category name="Sensor ${index + 1}" colour="#123456"><block type="sensor_${index + 1}" /></category>`,
    ).join('\n');
    const compacted = compactExtensionToolboxXml(packages);
    assert.match(compacted, /^<category name="扩展库"/);
    assert.match(compacted, /expanded="false"/);
    assert.equal((compacted.match(/<category /g) || []).length, 51);
    assert.match(compacted, /type="sensor_50"/);
});

test('does not add an empty extension category', () => {
    assert.equal(compactExtensionToolboxXml('  '), '');
});

