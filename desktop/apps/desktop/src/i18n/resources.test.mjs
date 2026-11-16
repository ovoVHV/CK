import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createInstance } from 'i18next';

const readJson = async relativePath => JSON.parse(
    await readFile(new URL(relativePath, import.meta.url), 'utf8'),
);
const namespaces = ['common', 'libraries', 'serial', 'build', 'health', 'recovery', 'editor'];
const localeResources = Object.fromEntries(await Promise.all(
    ['zh-CN', 'en-US'].map(async locale => [
        locale,
        Object.fromEntries(await Promise.all(namespaces.map(async namespace => [
            namespace,
            await readJson(`../locales/${locale}/${namespace}.json`),
        ]))),
    ]),
));
const zhCN = localeResources['zh-CN'].common;
const enUS = localeResources['en-US'].common;

const flattenLeafKeys = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
    const path = prefix ? `${prefix}.${key}` : key;
    if (child && typeof child === 'object' && !Array.isArray(child)) {
        return flattenLeafKeys(child, path);
    }
    return [path];
});

test('zh-CN and en-US common resources have exact key parity', () => {
    assert.deepEqual(flattenLeafKeys(enUS).sort(), flattenLeafKeys(zhCN).sort());
});

test('every Phase 2C namespace has exact zh-CN/en-US key parity', () => {
    for (const namespace of namespaces) {
        assert.deepEqual(
            flattenLeafKeys(localeResources['en-US'][namespace]).sort(),
            flattenLeafKeys(localeResources['zh-CN'][namespace]).sort(),
            `${namespace} resource keys must stay in parity`,
        );
    }
});

test('interpolation and English plural forms are resolved by i18next', async () => {
    const instance = createInstance();
    await instance.init({
        resources: {
            'zh-CN': { common: zhCN },
            'en-US': { common: enUS },
        },
        lng: 'en-US',
        fallbackLng: ['zh-CN'],
        defaultNS: 'common',
        initAsync: false,
    });
    assert.equal(instance.t('i18nTest.welcome', { name: 'CK' }), 'Welcome, CK');
    assert.equal(instance.t('i18nTest.projectCount', { count: 1 }), '1 project');
    assert.equal(instance.t('i18nTest.projectCount', { count: 3 }), '3 projects');
});

test('module namespaces resolve interpolation and plural forms without touching identity values', async () => {
    const instance = createInstance();
    await instance.init({
        resources: localeResources,
        lng: 'en-US',
        fallbackLng: ['zh-CN'],
        defaultNS: 'common',
        ns: namespaces,
        initAsync: false,
    });
    assert.equal(
        instance.t('build:result.compileSuccessToast', { duration: '1.2' }),
        'Compilation succeeded (1.2s)',
    );
    assert.equal(
        instance.t('build:toolbar.debugUploadWithBreakpoints', { count: 1 }),
        'Upload debug firmware with 1 breakpoint',
    );
    assert.equal(
        instance.t('build:toolbar.debugUploadWithBreakpoints', { count: 3 }),
        'Upload debug firmware with 3 breakpoints',
    );
    assert.equal(
        instance.t('build:explanation.compile.diagnostic.undeclared_symbol.title', { symbol: 'sensorValue' }),
        'Name sensorValue has not been declared',
    );
});

test('missing keys fall back to zh-CN and finally to the key', async () => {
    const instance = createInstance();
    const enWithoutLoading = structuredClone(enUS);
    delete enWithoutLoading.common.status.loading;
    await instance.init({
        resources: {
            'zh-CN': { common: zhCN },
            'en-US': { common: enWithoutLoading },
        },
        lng: 'en-US',
        fallbackLng: ['zh-CN'],
        defaultNS: 'common',
        initAsync: false,
    });
    assert.equal(instance.t('common.status.loading'), '加载中…');
    assert.equal(instance.t('missing.contract.key'), 'missing.contract.key');
});
