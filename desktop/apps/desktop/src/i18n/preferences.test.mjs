import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./preferences.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'preferences.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
    'preferences.ts should transpile without syntax errors',
);
const preferences = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const memoryStorage = entries => {
    const values = new Map(entries);
    return {
        values,
        getItem(key) {
            return values.get(key) ?? null;
        },
        setItem(key, value) {
            values.set(key, value);
        },
    };
};

test('locale resolution follows persisted choice, supported system locale, then zh-CN', () => {
    const stored = memoryStorage([
        [preferences.UI_LOCALE_STORAGE_KEY, 'zh-CN'],
        [preferences.BLOCK_LOCALE_STORAGE_KEY, 'en-US'],
    ]);
    assert.deepEqual(preferences.readLocalePreferences(stored, ['en-US']), {
        uiLocale: 'zh-CN',
        blockLocale: 'en-US',
    });

    assert.deepEqual(preferences.readLocalePreferences(memoryStorage([]), ['fr-FR', 'en-GB']), {
        uiLocale: 'en-US',
        blockLocale: 'follow-ui',
    });
    assert.equal(
        preferences.readLocalePreferences(memoryStorage([]), ['fr-FR']).uiLocale,
        'zh-CN',
    );
});

test('locale persistence uses only dedicated presentation keys', () => {
    const storage = memoryStorage([]);
    preferences.persistUiLocale('en-US', storage);
    preferences.persistBlockLocalePreference('zh-CN', storage);
    assert.deepEqual(Array.from(storage.values.entries()), [
        ['ck.i18n.uiLocale', 'en-US'],
        ['ck.i18n.blockLocale', 'zh-CN'],
    ]);
    assert.equal(preferences.resolveBlockLocale('follow-ui', 'en-US'), 'en-US');
    assert.equal(preferences.resolveBlockLocale('zh-CN', 'en-US'), 'zh-CN');
});

test('invalid preferences and denied storage fail safely', () => {
    const deniedStorage = {
        getItem() {
            throw new Error('denied');
        },
        setItem() {
            throw new Error('denied');
        },
    };
    assert.deepEqual(preferences.readLocalePreferences(deniedStorage, []), {
        uiLocale: 'zh-CN',
        blockLocale: 'follow-ui',
    });
    assert.doesNotThrow(() => preferences.persistUiLocale('en-US', deniedStorage));
    assert.doesNotThrow(() => preferences.persistBlockLocalePreference('en-US', deniedStorage));
    assert.equal(preferences.normalizeUiLocale('de-DE'), null);
    assert.equal(preferences.normalizeBlockLocalePreference('English'), 'follow-ui');
});

