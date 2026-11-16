import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_log_digest.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_log_digest.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
);

const { extractCompileLogDigest } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('extracts the exact compiler error group and removes CK source markers from its source preview', () => {
    const log = [
        '[INFO] Compile target: arduino:avr:mega',
        "C:\\Temp\\sketch.ino: In function 'void loop()':",
        "C:\\Temp\\sketch.ino:9:3: error: 'variable' was not declared in this scope",
        '  variable = 0; /* @ck-source-begin:v1:abcdef */ /* @ck-source-end:v1:abcd */ /* @ck:v1:deadbeef */',
        '  ^~~~~~~~',
        "C:\\Temp\\sketch.ino:9:3: note: suggested alternative: 'Serial3'",
        'exit status 1',
    ].join('\n');

    const digest = extractCompileLogDigest(log);
    assert.equal(digest.errorCount, 1);
    assert.equal(digest.lines[0].kind, 'context');
    assert.match(digest.lines[1].text, /variable.*not declared/);
    assert.equal(digest.lines[2].text.trim(), 'variable = 0;');
    assert.equal(digest.lines[3].kind, 'caret');
    assert.equal(digest.lines[4].kind, 'note');
    assert.doesNotMatch(digest.lines.map(line => line.text).join('\n'), /@ck-source|@ck:v1/);
    assert.ok(digest.omittedLineCount > 0);
});

test('deduplicates wrapper repeats without hiding distinct compiler errors', () => {
    const first = "sketch.ino:4:2: error: expected ';' before '}' token";
    const second = "sketch.ino:8:1: error: 'missing' was not declared in this scope";
    const digest = extractCompileLogDigest([first, first, second].join('\n'));
    assert.equal(digest.errorCount, 2);
    assert.deepEqual(
        digest.lines.filter(line => line.kind === 'error').map(line => line.text),
        [first, second],
    );
});

test('does not promote ordinary timing and info noise into the key-error view', () => {
    const digest = extractCompileLogDigest('[INFO] compiling\n[Timing] 4.2s\nSketch uses 728 bytes');
    assert.equal(digest.errorCount, 0);
    assert.deepEqual(digest.lines, []);
});
