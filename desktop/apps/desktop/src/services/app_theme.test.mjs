import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./app_theme.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'app_theme.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'app_theme.ts should transpile without syntax errors');

const theme = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('normalizes invalid stored modes to system', () => {
    assert.equal(theme.normalizeThemeMode('dark'), 'dark');
    assert.equal(theme.normalizeThemeMode('sepia'), 'system');
    assert.equal(theme.readPersistedThemeMode({ getItem: () => 'light' }), 'light');
    assert.equal(theme.readPersistedThemeMode({ getItem: () => 'invalid' }), 'system');
    assert.equal(theme.readPersistedThemeMode({ getItem: () => { throw new Error('denied'); } }), 'system');
});

test('resolves system mode without changing explicit choices', () => {
    assert.equal(theme.resolveThemeMode('system', true), 'dark');
    assert.equal(theme.resolveThemeMode('system', false), 'light');
    assert.equal(theme.resolveThemeMode('light', true), 'light');
    assert.equal(theme.resolveThemeMode('dark', false), 'dark');
});

test('persists the compatible app_theme value and tolerates storage denial', () => {
    const values = new Map();
    theme.persistThemeMode('dark', {
        setItem(key, value) {
            values.set(key, value);
        },
    });
    assert.equal(values.get('app_theme'), 'dark');
    assert.doesNotThrow(() => theme.persistThemeMode('light', {
        setItem() {
            throw new Error('denied');
        },
    }));
});

test('applies mode and resolved theme to a document-like root', () => {
    const classes = new Set();
    const root = {
        classList: {
            toggle(name, enabled) {
                if (enabled) classes.add(name);
                else classes.delete(name);
            },
        },
        dataset: {},
        style: {},
    };
    theme.applyThemeToDocument('system', 'dark', root);
    assert.deepEqual(Array.from(classes), ['dark']);
    assert.equal(root.dataset.themeMode, 'system');
    assert.equal(root.dataset.theme, 'dark');
    assert.equal(root.style.colorScheme, 'dark');

    theme.applyThemeToDocument('light', 'light', root);
    assert.deepEqual(Array.from(classes), ['light']);
});

