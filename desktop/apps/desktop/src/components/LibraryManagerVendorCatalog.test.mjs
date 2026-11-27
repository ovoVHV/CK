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
    bundle: true,
    platform: 'node',
    format: 'cjs',
    packages: 'external',
    write: false,
    jsx: 'automatic',
    plugins: [{
        name: 'library-vendor-test-boundaries',
        setup(pluginBuild) {
            const mocks = {
                '../contexts/HardwareContext': 'export const useHardware = () => globalThis.__vendorTest.hardware;',
                '../contexts/DialogContext': 'export const useDialog = () => ({ confirm: async () => true });',
                '@tauri-apps/api/core': 'export const invoke = (...args) => globalThis.__vendorTest.invoke(...args); export const convertFileSrc = (path) => `asset://local/${path}`;',
                '@tauri-apps/plugin-dialog': 'export const open = async () => null;',
                '../services/block_package_migration_transaction': 'export const cancelPreparedBlockLibraryMigration = () => {}; export const commitPreparedBlockLibraryMigration = () => {}; export const formatBlockLibraryMigrationPreview = () => {}; export const prepareBlockLibraryMigration = () => {}; export const previewPreparedBlockLibraryMigration = () => {};',
            };
            pluginBuild.onResolve({ filter: /.*/ }, (args) => (
                Object.hasOwn(mocks, args.path) ? { path: args.path, namespace: 'library-vendor-mock' } : undefined
            ));
            pluginBuild.onLoad({ filter: /.*/, namespace: 'library-vendor-mock' }, (args) => ({
                contents: mocks[args.path],
                loader: 'js',
            }));
        },
    }],
});
const mod = { exports: {} };
new Function('require', 'module', 'exports', bundle.outputFiles[0].text)(require, mod, mod.exports);
const { LibraryManagerModal } = mod.exports;

const zhLibraries = JSON.parse(
    await readFile(new URL('../locales/zh-CN/libraries.json', import.meta.url), 'utf8'),
);

test('LibraryManagerModal groups General vs vendor categories and shows thumbnails only on branded libraries', async () => {
    const dom = new JSDOM('<div id="root"></div>', { url: 'http://localhost/' });
    globalThis.window = dom.window;
    globalThis.document = dom.window.document;
    globalThis.localStorage = dom.window.localStorage;
    globalThis.IS_REACT_ACT_ENVIRONMENT = true;

    const i18n = i18next.createInstance();
    await i18n.init({
        lng: 'zh-CN',
        resources: { 'zh-CN': { libraries: zhLibraries } },
        interpolation: { escapeValue: false },
    });

    const installed = [
        {
            id: 'dht_universal',
            entry_key: 'dht_universal',
            folder_name: 'dht_universal',
            name: 'DHT_Universal',
            version: '1.0.0',
            location: 'Global',
            path: 'C:/libs/dht_universal',
            user_installed: true,
        },
        {
            id: 'emakefun_ble',
            entry_key: 'emakefun_ble',
            folder_name: 'emakefun_ble',
            name: 'Emakefun BLE 模块',
            version: '1.1.0',
            vendor: 'Emakefun',
            vendor_logo_path: 'C:/libs/emakefun_ble/assets/emakefun.png',
            icon_path: 'C:/libs/emakefun_ble/assets/ble_card.png',
            location: 'Board',
            path: 'C:/libs/emakefun_ble',
            user_installed: true,
        },
    ];

    const cloud = [
        {
            id: 'ck_74hc595',
            name: 'CK 74HC595 移位寄存器',
            version: '0.2.0',
            author: 'CK Project',
            url: 'gitee-raw://manong1234/makerlib/master#ck_74hc595',
            architectures: ['*'],
        },
        {
            id: 'emakefun_rf24',
            name: 'Emakefun 2.4G 无线模块',
            version: '1.1.0',
            author: 'Emakefun',
            vendor: 'Emakefun',
            vendor_logo_url: 'https://raw.githubusercontent.com/org/repo/main/emakefun_rf24/assets/logo.png',
            icon_url: 'https://raw.githubusercontent.com/org/repo/main/emakefun_rf24/assets/rf24.png',
            description: '支持 RF-Nano 板载 2.4G 通信',
            url: 'https://api.github.com/repos/org/repo/zipball/main#subdir=emakefun_rf24',
            architectures: ['avr'],
        },
    ];

    globalThis.__vendorTest = {
        hardware: {
            availableLibraries: installed,
            availableBoards: [],
            activeBoard: 'arduino:avr:uno',
            activeBoardPackageId: 'arduino:avr:uno',
            reloadLibraries: async () => installed,
        },
        invoke: async (command) => {
            if (command === 'list_arduino_libraries') return '{}';
            if (command === 'fetch_custom_registry') return JSON.stringify({ libraries: cloud });
            throw new Error(`Unexpected command ${command}`);
        },
    };

    const host = document.getElementById('root');
    const root = createRoot(host);
    const props = { isOpen: true, onClose() {}, showToast() {}, projectPath: '' };
    const render = () => root.render(
        React.createElement(I18nextProvider, { i18n }, React.createElement(LibraryManagerModal, props)),
    );

    try {
        await act(async () => render());

        // Installed tab has All, General, and Emakefun tabs.
        const installedTabs = [...host.querySelectorAll('[data-ck-role="library-category-bar"] button')];
        assert.deepEqual(
            installedTabs.map((b) => b.getAttribute('data-ck-category-id')),
            ['all', 'general', 'vendor:emakefun'],
        );
        // Only Emakefun library renders a thumbnail + vendor badge.
        assert.equal(host.querySelectorAll('[data-ck-role="library-brand-thumbnail"]').length, 1);
        assert.equal(
            host.querySelector('[data-ck-role="library-brand-thumbnail"] img')?.getAttribute('src'),
            'asset://local/C:/libs/emakefun_ble/assets/ble_card.png',
        );
        assert.equal(host.querySelectorAll('[data-ck-role="library-vendor-badge"]').length, 1);

        // Filter installed by Emakefun.
        await act(async () => {
            host.querySelector('button[data-ck-category-id="vendor:emakefun"]').click();
        });
        assert.ok(host.textContent.includes('Emakefun BLE 模块'));
        assert.equal(host.textContent.includes('DHT_Universal'), false);

        // Filter installed by General.
        await act(async () => {
            host.querySelector('button[data-ck-category-id="general"]').click();
        });
        assert.ok(host.textContent.includes('DHT_Universal'));
        assert.equal(host.textContent.includes('Emakefun BLE 模块'), false);

        // Switch to Discover -> CK 积木库 and verify online vendor tabs + thumbnails.
        const discoverTab = [...host.querySelectorAll('button')].find((b) => b.textContent.includes('在线获取'));
        assert.ok(discoverTab);
        await act(async () => discoverTab.click());

        const cloudTabs = [...host.querySelectorAll('[data-ck-role="library-category-bar"] button')];
        assert.deepEqual(
            cloudTabs.map((b) => b.getAttribute('data-ck-category-id')),
            ['all', 'general', 'vendor:emakefun'],
        );
        assert.equal(host.querySelectorAll('[data-ck-role="library-brand-thumbnail"]').length, 1);
        assert.equal(
            host.querySelector('[data-ck-role="library-brand-thumbnail"] img')?.getAttribute('src'),
            'https://raw.githubusercontent.com/org/repo/main/emakefun_rf24/assets/rf24.png',
        );

        await act(async () => {
            host.querySelector('button[data-ck-category-id="vendor:emakefun"]').click();
        });
        assert.ok(host.textContent.includes('Emakefun 2.4G 无线模块'));
        assert.equal(host.textContent.includes('CK 74HC595 移位寄存器'), false);
    } finally {
        await act(async () => root.unmount());
        dom.window.close();
        delete globalThis.__vendorTest;
    }
});
