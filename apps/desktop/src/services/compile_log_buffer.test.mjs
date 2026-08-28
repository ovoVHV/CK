import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_log_buffer.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_log_buffer.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);

const {
    appendCompileLogBounded,
    appendCompileLogBufferBounded,
    createCompileLogBuffer,
    COMPILE_LOG_TRUNCATION_NOTICE,
} = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('preserves ordinary streamed output exactly below the memory ceiling', () => {
    assert.equal(appendCompileLogBounded('first\n', 'second\n', 128), 'first\nsecond\n');
});

test('drops oldest lines and retains newest compiler evidence at the ceiling', () => {
    const current = Array.from({ length: 20 }, (_, index) => `old-${index}\n`).join('');
    const chunk = 'error: newest diagnostic\nSketch uses 123 bytes\n';
    const result = appendCompileLogBounded(current, chunk, 112);
    assert.ok(result.length <= 112);
    assert.ok(result.startsWith(COMPILE_LOG_TRUNCATION_NOTICE));
    assert.match(result, /error: newest diagnostic/);
    assert.match(result, /Sketch uses 123 bytes/);
    assert.doesNotMatch(result, /old-0\n/);
});

test('bounds one oversized chunk and never multiplies the truncation notice', () => {
    const huge = `${'x'.repeat(500)}\nfinal artifact.elf\n`;
    const once = appendCompileLogBounded('', huge, 96);
    const twice = appendCompileLogBounded(once, '\ndone\n', 96);
    assert.ok(once.length <= 96);
    assert.ok(twice.length <= 96);
    assert.match(twice, /done/);
    assert.equal(twice.split(COMPILE_LOG_TRUNCATION_NOTICE).length - 1, 1);
});

test('enforces a hard line ceiling in state while retaining the latest lines', () => {
    const manyLines = Array.from({ length: 80 }, (_, index) => `line-${index}`).join('\n');
    const result = appendCompileLogBounded('', manyLines, 20_000, 12);
    const lines = result.split('\n');
    assert.ok(lines.length <= 12);
    assert.equal(lines[0], COMPILE_LOG_TRUNCATION_NOTICE.trimEnd());
    assert.match(result, /line-79$/);
    assert.doesNotMatch(result, /line-0(?:\n|$)/);
});

test('incremental buffer metadata stays bounded without recounting retained history', () => {
    let buffer = createCompileLogBuffer();
    for (let index = 0; index < 100; index += 1) {
        buffer = appendCompileLogBufferBounded(buffer, `event-${index}\n`, 20_000, 16);
    }
    assert.ok(buffer.text.split('\n').length <= 16);
    assert.equal(buffer.newlineCount, (buffer.text.match(/\n/g) || []).length);
    assert.equal(buffer.text.split(COMPILE_LOG_TRUNCATION_NOTICE).length - 1, 1);
    assert.match(buffer.text, /event-99/);
    assert.doesNotMatch(buffer.text, /event-0\n/);
});
