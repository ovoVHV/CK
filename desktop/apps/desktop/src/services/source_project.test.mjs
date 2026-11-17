import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
const compile = text => `data:text/javascript;base64,${Buffer.from(ts.transpileModule(text, { compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 } }).outputText).toString('base64')}`;
const load = async (file, imports = {}) => {
    let text = await readFile(new URL(file, import.meta.url), 'utf8');
    for (const [name, url] of Object.entries(imports)) text = text.replaceAll(`'${name}'`, JSON.stringify(url));
    return compile(text);
};
const fqbn = await load('./board_fqbn.ts');
const target = await load('./project_build_target.ts', { './board_fqbn': fqbn });
const identity = await load('./project_identity.ts');
const { sourceDocument, sourceExport, sourceProjectIdentity, sourceDiagnostics, appendSourceLog } = await import(await load('./source_project.ts', { './project_build_target': target, './project_identity': identity }));
const { captureProjectBuildTarget } = await import(target);
const selected = captureProjectBuildTarget({ board: 'esp32:esp32:esp32s3', boardPackageId: 'ck:s3', coreVersion: '3.3.6-cn', options: { FlashSize: '8M' }, effectiveOptions: { FlashSize: '8M' }, resolved: true }, null);

test('pure source is never regenerated; export pins the complete target independently', () => {
    const code = '#include <WiFi.h>\nvoid setup() { Serial.println("中文"); }\nvoid loop() {}\n';
    const document = sourceDocument(code, selected);
    assert.equal(document.code, code);
    const exported = sourceExport(document).split('\n');
    assert.equal(exported.slice(3).join('\n'), code);
    assert.deepEqual(JSON.parse(exported[1].slice(3)), selected);
    assert.throws(() => sourceDocument(code, { ...selected, fqbn: 'arduino:avr:uno' }));
});
test('saved source keeps stable Windows project identity across editor instances', () => {
    assert.equal(sourceProjectIdentity('E:\\中文\\Blink.cksrc', 'one'), sourceProjectIdentity('e:/中文/blink.cksrc', 'two'));
    assert.notEqual(sourceProjectIdentity('', 'one'), sourceProjectIdentity('', 'two'));
});
test('diagnostics map original sketch lines only, deduplicate, and reject generated/library lines', () => {
    const code = 'void setup() {\n  bad();\n}\nvoid loop() {}';
    const log = 'E:\\build\\sketch.ino:2:3: error: bad not declared\nE:/build/sketch.ino:2:3: error: bad not declared\nE:/lib/Other.cpp:2:3: error: library\nE:/build/sketch.ino.cpp:2:3: error: generated\nE:/build/sketch.ino:90:1: error: wrong line';
    assert.deepEqual(sourceDiagnostics(log, code), [{ line: 2, column: 3, severity: 'error', message: 'bad not declared' }]);
});
test('oversize or binary source is rejected while normal UTF-8 is preserved', () => {
    assert.throws(() => sourceDocument('中'.repeat(400000), null));
    assert.throws(() => sourceDocument('a\0b', null));
    assert.equal(sourceDocument('', null).code, '');
});
test('long-running output stays bounded and preserves the final failure', () => {
    const result = appendSourceLog('old log\n'.repeat(30000), '\nerror: final failure\n');
    assert.ok(result.length < 141000);
    assert.ok(result.endsWith('error: final failure\n'));
});
