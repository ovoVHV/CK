import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { build } from 'esbuild';

const storageValues = new Map([
    ['ck.i18n.uiLocale', 'en-US'],
    ['ck.i18n.blockLocale', 'follow-ui'],
]);
const blockLocaleEvents = [];
const localStorage = {
    getItem(key) {
        return storageValues.get(key) ?? null;
    },
    setItem(key, value) {
        storageValues.set(key, value);
    },
};
const documentElement = { lang: '', dataset: {} };
globalThis.CustomEvent = class CustomEvent {
    constructor(type, init = {}) {
        this.type = type;
        this.detail = init.detail;
    }
};
globalThis.window = {
    localStorage,
    dispatchEvent(event) {
        blockLocaleEvents.push(event);
        return true;
    },
};
Object.defineProperty(globalThis, 'navigator', {
    configurable: true,
    value: { languages: ['zh-CN'], language: 'zh-CN' },
});
globalThis.document = { documentElement };

const bundle = await build({
    entryPoints: [new URL('./index.ts', import.meta.url).pathname.replace(/^\/(.:)/, '$1')],
    bundle: true,
    format: 'esm',
    platform: 'browser',
    write: false,
    define: {
        'import.meta.env.DEV': 'false',
    },
});
const runtime = await import(
    `data:text/javascript;base64,${Buffer.from(bundle.outputFiles[0].text).toString('base64')}`
);

test('initialization honors persistence and sets html lang before UI use', async () => {
    const instance = await runtime.initializeI18n();
    assert.equal(instance.language, 'en-US');
    assert.equal(instance.t('common.actions.save'), 'Save');
    assert.equal(documentElement.lang, 'en-US');
    assert.equal(documentElement.dataset.uiLocale, 'en-US');
});

test('hot switch updates translation, html lang, and only the locale preference', async () => {
    const unrelatedBusinessState = '{"projectId":"stable-project"}';
    storageValues.set('ck.project.state', unrelatedBusinessState);
    await runtime.changeUiLocale('zh-CN');
    assert.equal(runtime.default.t('common.actions.save'), '保存');
    assert.equal(documentElement.lang, 'zh-CN');
    assert.equal(storageValues.get('ck.i18n.uiLocale'), 'zh-CN');
    assert.equal(storageValues.get('ck.project.state'), unrelatedBusinessState);
});

test('block locale selector persists independently and emits a presentation event', () => {
    const businessStateBefore = storageValues.get('ck.project.state');
    runtime.changeBlockLocalePreference('en-US');
    assert.equal(storageValues.get('ck.i18n.blockLocale'), 'en-US');
    assert.equal(blockLocaleEvents.at(-1)?.type, 'ck:i18n:block-locale-changed');
    assert.equal(blockLocaleEvents.at(-1)?.detail?.locale, 'en-US');

    runtime.changeBlockLocalePreference('follow-ui');
    assert.equal(storageValues.get('ck.i18n.blockLocale'), 'follow-ui');
    assert.equal(blockLocaleEvents.at(-1)?.detail?.locale, 'follow-ui');
    assert.equal(storageValues.get('ck.project.state'), businessStateBefore);
});

test('main entry awaits i18n initialization before createRoot render', async () => {
    const mainSource = await readFile(new URL('../main.tsx', import.meta.url), 'utf8');
    const initializeIndex = mainSource.indexOf('await initializeI18n()');
    const renderIndex = mainSource.indexOf('ReactDOM.createRoot');
    assert.ok(initializeIndex >= 0, 'main.tsx must await i18n initialization');
    assert.ok(renderIndex > initializeIndex, 'React must render after i18n is initialized');
});
