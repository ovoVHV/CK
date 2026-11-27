import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const identitySource = await readFile(new URL('./library_catalog_identity.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(identitySource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'library_catalog_identity.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter((item) => item.category === ts.DiagnosticCategory.Error),
    [],
);
const {
    filterLibrariesByCategory,
    libraryCatalogCategories,
    libraryCategoryId,
    libraryHasBrandVisual,
    libraryRowImageSource,
    resolveActiveLibraryCategory,
} = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('libraries without vendor stay in General even when author is declared', () => {
    const libs = [
        { id: 'dht', name: 'DHT_Universal', author: 'CK' },
        { id: 'neopixel', name: 'NeoPixel_RGB', author: 'Adafruit' },
        { id: 'wifi_mgr', name: 'WiFi_Manager', author: 'tzapu' },
    ];

    for (const lib of libs) {
        assert.equal(libraryCategoryId(lib), 'general');
        assert.equal(libraryHasBrandVisual(lib), false);
    }

    const categories = libraryCatalogCategories(libs);
    assert.deepEqual(
        categories.map((c) => [c.id, c.count]),
        [['all', 3], ['general', 3]],
    );
});

test('branded libraries merge vendor tabs by NFKC case-insensitive key with deterministic logo choice', () => {
    const emakefunB = {
        id: 'emakefun_b_sensor',
        name: 'Emakefun Sensor B',
        vendor: 'emakefun',
        vendor_logo_path: 'C:/libs/b/logo_b.png',
        icon_path: 'C:/libs/b/sensor_b.png',
    };
    const emakefunA = {
        id: 'emakefun_a_ble',
        name: 'Emakefun BLE A',
        vendor: 'Emakefun',
        vendor_logo_path: 'C:/libs/a/logo_a.png',
    };
    const emakefunFullwidth = {
        id: 'emakefun_c_motor',
        name: 'Emakefun Motor C',
        vendor: 'Ｅｍａｋｅｆｕｎ',
    };
    const generic = { id: 'ck_74hc595', name: 'CK 74HC595' };

    const forward = libraryCatalogCategories([emakefunB, generic, emakefunFullwidth, emakefunA]);
    const reversed = libraryCatalogCategories([emakefunA, emakefunFullwidth, generic, emakefunB]);

    assert.deepEqual(forward, reversed);
    assert.deepEqual(
        forward.map((c) => ({ id: c.id, name: c.name, count: c.count, logoPath: c.logoPath })),
        [
            { id: 'all', name: undefined, count: 4, logoPath: undefined },
            { id: 'general', name: undefined, count: 1, logoPath: undefined },
            { id: 'vendor:emakefun', name: 'Emakefun', count: 3, logoPath: 'C:/libs/a/logo_a.png' },
        ],
    );

    assert.deepEqual(
        filterLibrariesByCategory([emakefunB, generic, emakefunA], 'vendor:emakefun').map((l) => l.id),
        ['emakefun_b_sensor', 'emakefun_a_ble'],
    );
    assert.deepEqual(
        filterLibrariesByCategory([emakefunB, generic, emakefunA], 'general').map((l) => l.id),
        ['ck_74hc595'],
    );
});

test('active category falls back to all when last library of a vendor is removed', () => {
    const before = libraryCatalogCategories([
        { id: 'generic_1', name: 'Generic' },
        { id: 'emakefun_ble', name: 'Emakefun BLE', vendor: 'Emakefun' },
    ]);
    assert.equal(resolveActiveLibraryCategory(before, 'vendor:emakefun'), 'vendor:emakefun');

    const afterDelete = libraryCatalogCategories([{ id: 'generic_1', name: 'Generic' }]);
    assert.equal(resolveActiveLibraryCategory(afterDelete, 'vendor:emakefun'), 'all');
});

test('row image resolution prefers icon over vendor logo and blocks unsafe remote URLs', () => {
    assert.deepEqual(
        libraryRowImageSource({
            icon_path: 'C:/libs/sensor/icon.png',
            vendor_logo_path: 'C:/libs/sensor/vendor.png',
        }),
        { kind: 'local', value: 'C:/libs/sensor/icon.png' },
    );
    assert.deepEqual(
        libraryRowImageSource({
            vendor: 'Emakefun',
            vendor_logo_url: 'https://raw.githubusercontent.com/org/repo/main/emakefun/logo.png',
        }),
        { kind: 'remote', value: 'https://raw.githubusercontent.com/org/repo/main/emakefun/logo.png' },
    );
    assert.equal(
        libraryRowImageSource({
            icon_url: 'http://insecure.example/a.png',
            vendor_logo_url: 'javascript:alert(1)',
            icon: 'data:image/svg+xml,<svg/>',
        }),
        null,
    );
    assert.equal(libraryHasBrandVisual({ vendor: 'Emakefun' }), true);
});

test('zh-CN and en-US libraries locale keys stay in exact parity', async () => {
    const flatten = (value, prefix = '') => Object.entries(value).flatMap(([key, child]) => {
        const path = prefix ? `${prefix}.${key}` : key;
        return child && typeof child === 'object' && !Array.isArray(child) ? flatten(child, path) : [path];
    });
    const zh = JSON.parse(await readFile(new URL('../locales/zh-CN/libraries.json', import.meta.url), 'utf8'));
    const en = JSON.parse(await readFile(new URL('../locales/en-US/libraries.json', import.meta.url), 'utf8'));
    assert.deepEqual(flatten(en).sort(), flatten(zh).sort());
});
