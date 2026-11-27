import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import i18next from 'i18next';

const require = createRequire(import.meta.url);
const { I18nextProvider } = require('react-i18next');
const bundle = await build({
    entryPoints: [fileURLToPath(new URL('./LibraryManagerModal.tsx', import.meta.url))],
    bundle: true, platform: 'node', format: 'cjs', packages: 'external', write: false, jsx: 'automatic',
    plugins: [{ name: 'library-test-boundaries', setup(build) {
        const mocks = {
            '../contexts/HardwareContext': 'export const useHardware = () => globalThis.__cloudTest.hardware;',
            '../contexts/DialogContext': 'export const useDialog = () => ({});',
            '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__cloudTest.invoke(...args); export const convertFileSrc = (path) => path;',
            '@tauri-apps/plugin-dialog': 'export const open = async () => null;',
            '../services/block_package_migration_transaction': 'export const cancelPreparedBlockLibraryMigration = () => {}; export const commitPreparedBlockLibraryMigration = () => {}; export const formatBlockLibraryMigrationPreview = () => {}; export const prepareBlockLibraryMigration = () => {}; export const previewPreparedBlockLibraryMigration = () => {};',
        };
        build.onResolve({ filter: /.*/ }, args => Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'library-mock' } : undefined);
        build.onLoad({ filter: /.*/, namespace: 'library-mock' }, args => ({ contents: mocks[args.path], loader: 'js' }));
    } }],
});
const module = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, module, module.exports);
const { LibraryManagerModal } = module.exports;
const resources = {};
for (const locale of ['en-US', 'zh-CN']) {
    resources[locale] = { libraries: JSON.parse(await readFile(new URL(`../locales/${locale}/libraries.json`, import.meta.url), 'utf8')) };
}

for (const locale of ['en-US', 'zh-CN']) {
    for (const outcome of ['installed', 'failed', 'unconfirmed', 'repair']) {
        test(`actual library dialog retains ${outcome} result after progress ends (${locale})`, async () => {
            const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
            globalThis.window = dom.window;
            globalThis.document = dom.window.document;
            globalThis.localStorage = dom.window.localStorage;
            globalThis.IS_REACT_ACT_ENVIRONMENT = true;
            const i18n = i18next.createInstance();
            await i18n.init({ lng: locale, resources, interpolation: { escapeValue: false } });
            const t = (key, options) => i18n.t(key, { ns: 'libraries', ...options });
            const toasts = [];
            let finishInstall;
            let refreshes = 0;
            globalThis.__cloudTest = {
                hardware: {
                    availableLibraries: outcome === 'repair' ? [{
                        id: 'test_sensor', entry_key: 'test_sensor', name: 'Test Sensor', version: '1.0.0',
                        location: 'Board', path: 'test', user_installed: true, runtime_activation: { state: 'quality-blocked' },
                    }] : [],
                    availableBoards: [], activeBoard: 'arduino:avr:uno', activeBoardPackageId: 'arduino:avr:uno',
                    reloadLibraries: async () => {
                        refreshes++;
                        return outcome === 'unconfirmed' ? undefined : [{ id: 'test_sensor', user_installed: true }];
                    },
                },
                invoke: async command => {
                    if (command === 'list_arduino_libraries') return '{}';
                    if (command === 'fetch_custom_registry') return JSON.stringify({ libraries: [{ id: 'test_sensor', name: 'Test Sensor', version: '1.0.0', architectures: ['avr'], url: 'gitee-raw://owner/repo/master#test_sensor' }] });
                    if (command === 'install_library_from_url') return new Promise((resolve, reject) => {
                        finishInstall = () => outcome === 'failed' ? reject('HTTP 503: registry unavailable') : resolve('test_sensor');
                    });
                    throw new Error(`Unexpected command ${command}`);
                },
            };
            const host = document.getElementById('root');
            const root = createRoot(host);
            const props = { isOpen: true, onClose() {}, showToast: (...args) => toasts.push(args), projectPath: '' };
            const render = () => root.render(React.createElement(I18nextProvider, { i18n }, React.createElement(LibraryManagerModal, props)));
            const clickText = async text => {
                const button = [...host.querySelectorAll('button')].find(button => button.textContent.trim() === text);
                assert.ok(button, `Missing button: ${text}`);
                await act(async () => button.click());
            };
            try {
                await act(async () => render());
                await clickText(t('manager.tabs.discover'));
                await clickText(t(outcome === 'repair' ? 'manager.cloud.reinstall' : 'manager.install'));
                assert.ok(host.querySelector('[role="status"]'), 'progress is visible while installer is running');
                await act(async () => finishInstall());
                assert.equal(host.querySelector('[role="status"]'), null, 'progress ends');
                const status = outcome === 'repair' ? 'installed' : outcome;
                assert.ok(host.textContent.includes(t(`manager.cloud.resultStatus.${status}`)));
                assert.ok(host.textContent.includes('Test Sensor'));
                assert.equal(toasts.at(-1)[1], status === 'installed' ? 'success' : 'error');
                if (outcome === 'failed') assert.match(host.querySelector('details pre').textContent, /HTTP 503/);
                if (outcome === 'unconfirmed') assert.ok(host.textContent.includes(t('manager.cloud.refreshFailed')));
                assert.equal(refreshes, outcome === 'failed' ? 1 : 2);
                await clickText(t('manager.tabs.installed'));
                assert.ok(host.textContent.includes(t(`manager.cloud.resultStatus.${status}`)), 'tab changes do not erase result');
                await clickText(t('manager.import.clearResults'));
                assert.equal(host.textContent.includes(t('manager.cloud.results')), false);
            } finally {
                await act(async () => root.unmount());
                dom.window.close();
                delete globalThis.__cloudTest;
            }
        });
    }
}
