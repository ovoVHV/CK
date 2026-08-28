import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./core_pin_aliases.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'core_pin_aliases.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const executable = transpiled.outputText
    .replace(
        "import { baseBoardFqbn, composeBoardFqbn, parseBoardFqbnOptions } from './board_fqbn';",
        `const baseBoardFqbn = fqbn => String(fqbn || '').split(':').slice(0, 3).join(':');
         const parseBoardFqbnOptions = fqbn => Object.fromEntries(String(fqbn || '').split(':').slice(3).join(':').split(',').filter(Boolean).map(token => token.split('=')));
         const composeBoardFqbn = (fqbn, options) => { const entries = Object.entries(options).sort(([a], [b]) => a.localeCompare(b)); return entries.length ? baseBoardFqbn(fqbn) + ':' + entries.map(([key, value]) => key + '=' + value).join(',') : baseBoardFqbn(fqbn); };`,
    )
    .replace(
        "await import('@tauri-apps/api/core')",
        'globalThis.__CK_CORE_PIN_ALIAS_TEST_API__',
    );
const aliases = await import(
    `data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`
);

const sha256 = 'a'.repeat(64);
const details = {
    ck_pin_alias_catalog: {
        schema_version: 1,
        pins: [
            { value: '0', aliases: ['A0'] },
            { value: '22', aliases: ['SCL'] },
            { value: '23', aliases: ['SDA', 'SDA'] },
        ],
        source: {
            kind: 'installed-arduino-core-variant',
            fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
            package: 'esp32',
            architecture: 'esp32',
            core_version: '3.3.6',
            variant: 'esp32c6',
            file: 'pins_arduino.h',
            sha256,
        },
    },
};

test('accepts a matching versioned installed-Core alias snapshot', () => {
    const catalog = aliases.installedCorePinAliasesFromDetails(
        details,
        'esp32:esp32:esp32c6:FlashSize=16M',
    );
    assert.ok(catalog);
    assert.deepEqual(catalog.pins.get('23'), ['SDA']);
    assert.equal(catalog.source.coreVersion, '3.3.6');
    assert.equal(catalog.source.sha256, sha256);
});

test('rejects aliases from another board target or an unverifiable hash', () => {
    assert.equal(
        aliases.installedCorePinAliasesFromDetails(details, 'esp32:esp32:esp32c3'),
        null,
    );
    const invalid = structuredClone(details);
    invalid.ck_pin_alias_catalog.source.sha256 = 'not-a-hash';
    assert.equal(
        aliases.installedCorePinAliasesFromDetails(
            invalid,
            'esp32:esp32:esp32c6:FlashSize=16M',
        ),
        null,
    );
});

test('rejects a same-base snapshot produced for different board options', () => {
    assert.equal(
        aliases.installedCorePinAliasesFromDetails(
            details,
            'esp32:esp32:esp32c6:FlashSize=8M',
        ),
        null,
    );
});

test('merges aliases and provenance without inventing capabilities or risks', () => {
    const catalog = aliases.installedCorePinAliasesFromDetails(
        details,
        'esp32:esp32:esp32c6:FlashSize=16M',
    );
    const board = {
        name: 'ESP32-C6',
        fqbn: 'esp32:esp32:esp32c6',
        pins: [{ label: 'GPIO 23', value: '23', aliases: ['IO23'], capabilities: ['digital'] }],
    };
    const merged = aliases.mergeInstalledCorePinAliases(board, catalog);
    assert.deepEqual(merged.pins[0].aliases, ['IO23', 'SDA']);
    assert.deepEqual(merged.pins[0].capabilities, ['digital']);
    assert.equal(merged.pins[0].risks, undefined);
    assert.match(merged.pins[0].source, /3\.3\.6/);
    assert.equal(merged.pins[0].evidence[0].sha256, sha256);
});

test('never overlays a custom board even when its compiler FQBN matches', () => {
    const catalog = aliases.installedCorePinAliasesFromDetails(
        details,
        'esp32:esp32:esp32c6:FlashSize=16M',
    );
    const custom = {
        name: 'ACME C6',
        fqbn: 'esp32:esp32:esp32c6',
        packageId: 'acme-c6',
        isCustom: true,
        pins: [{ label: 'J1-1', value: '23', aliases: ['ACME_SDA'] }],
    };
    assert.equal(aliases.mergeInstalledCorePinAliases(custom, catalog), custom);
});

test('maps symbolic AVR board values back to one numeric Core pin without guessing', () => {
    const catalog = {
        schemaVersion: 1,
        pins: new Map([
            ['14', ['A0', 'PIN_A0']],
            ['15', ['A1', 'SHARED_ANALOG']],
            ['16', ['A2', 'SHARED_ANALOG']],
        ]),
        source: {
            kind: 'installed-arduino-core-variant',
            fqbn: 'arduino:avr:uno:cpu=atmega328',
            package: 'arduino',
            architecture: 'avr',
            coreVersion: '1.8.6',
            variant: 'standard',
            file: 'pins_arduino.h',
            sha256,
        },
    };
    const board = {
        name: 'Uno',
        fqbn: 'arduino:avr:uno',
        pins: [
            { label: 'Analog 0', value: 'A0' },
            { label: 'Ambiguous', value: 'SHARED_ANALOG' },
        ],
    };
    const merged = aliases.mergeInstalledCorePinAliases(board, catalog);
    assert.deepEqual(merged.pins[0].aliases, ['A0', 'PIN_A0', '14']);
    assert.equal(merged.pins[1], board.pins[1], 'ambiguous reverse aliases must remain untouched');
});

test('cache keys requests by the full resolved FQBN, not only the base board', async () => {
    const calls = [];
    globalThis.__CK_CORE_PIN_ALIAS_TEST_API__ = {
        async invoke(command, args) {
            calls.push({ command, args });
            return JSON.stringify({
                ...details.ck_pin_alias_catalog,
                source: { ...details.ck_pin_alias_catalog.source, fqbn: args.fqbn },
            });
        },
    };
    try {
        aliases.clearInstalledCorePinAliasCache();
        await aliases.getInstalledCorePinAliasesCached(
            'esp32:esp32:esp32c6:FlashSize=16M,PSRAM=opi',
        );
        await aliases.getInstalledCorePinAliasesCached(
            'esp32:esp32:esp32c6:PSRAM=opi,FlashSize=16M',
        );
        await aliases.getInstalledCorePinAliasesCached(
            'esp32:esp32:esp32c6:FlashSize=8M,PSRAM=opi',
        );
        assert.equal(calls.length, 2, 'option order is canonical, option values stay isolated');
        assert.equal(calls[0].command, 'get_installed_core_pin_aliases');
        assert.notEqual(calls[0].args.fqbn, calls[1].args.fqbn);
    } finally {
        delete globalThis.__CK_CORE_PIN_ALIAS_TEST_API__;
        aliases.clearInstalledCorePinAliasCache();
    }
});
