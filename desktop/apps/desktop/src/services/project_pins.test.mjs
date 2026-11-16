import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./project_pins.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'project_pins.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const pins = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('normalizes duplicate Windows paths without changing the first spelling', () => {
    assert.deepEqual(
        pins.normalizePinnedProjectPaths([
            'C:/Projects/Demo.ck',
            'c:\\projects\\demo.ck',
            '',
            null,
            'E:/Projects/Other.ck',
        ]),
        ['C:/Projects/Demo.ck', 'E:/Projects/Other.ck'],
    );
});

test('reads and writes preferences while tolerating storage failures', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    const written = pins.writePinnedProjectPaths(['C:/a.ck'], storage);
    assert.deepEqual(written, ['C:/a.ck']);
    assert.deepEqual(pins.readPinnedProjectPaths(storage), ['C:/a.ck']);
    assert.deepEqual(pins.readPinnedProjectPaths({ getItem: () => '{broken' }), []);
    assert.doesNotThrow(() => pins.writePinnedProjectPaths(['C:/a.ck'], { setItem: () => { throw new Error('denied'); } }));
});

test('toggle puts newly pinned projects first and removes them on second click', () => {
    const once = pins.togglePinnedProjectPath(['C:/old.ck'], 'C:/new.ck');
    assert.deepEqual(once, ['C:/new.ck', 'C:/old.ck']);
    assert.deepEqual(pins.togglePinnedProjectPath(once, 'c:\\NEW.ck'), ['C:/old.ck']);
});

test('prunes pins for projects that no longer exist', () => {
    assert.deepEqual(
        pins.prunePinnedProjectPaths(['C:/a.ck', 'C:/missing.ck'], [{ path: 'c:\\A.ck' }]),
        ['C:/a.ck'],
    );
});
