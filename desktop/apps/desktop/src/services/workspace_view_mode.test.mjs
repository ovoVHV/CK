import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./workspace_view_mode.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'workspace_view_mode.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const service = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('defaults invalid or unavailable display preferences to the simple view', () => {
    assert.equal(service.normalizeWorkspaceViewMode(undefined), 'simple');
    assert.equal(service.normalizeWorkspaceViewMode('unexpected'), 'simple');
    assert.equal(service.normalizeWorkspaceViewMode('engineering'), 'engineering');
    assert.equal(service.readWorkspaceViewMode(null), 'simple');
    assert.equal(service.readWorkspaceViewMode({ getItem: () => { throw new Error('denied'); } }), 'simple');
});

test('persists only the display preference and tolerates storage denial', () => {
    const values = new Map();
    const storage = {
        getItem: key => values.get(key) ?? null,
        setItem: (key, value) => values.set(key, value),
    };
    assert.equal(service.persistWorkspaceViewMode('engineering', storage), 'engineering');
    assert.equal(values.get(service.WORKSPACE_VIEW_MODE_STORAGE_KEY), 'engineering');
    assert.equal(service.readWorkspaceViewMode(storage), 'engineering');
    assert.doesNotThrow(() => service.persistWorkspaceViewMode('simple', {
        setItem: () => { throw new Error('denied'); },
    }));
});

