import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./board_fqbn.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const hardwareContextSource = await readFile(new URL('../contexts/HardwareContext.tsx', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
const boardSelectorSource = await readFile(new URL('../components/BoardSelector.tsx', import.meta.url), 'utf8');
const boardConfigSource = await readFile(new URL('../components/BoardConfigModal.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'board_fqbn.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'board_fqbn.ts should transpile without syntax errors');

const fqbn = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    baseBoardFqbn,
    boardOptionSchemaCacheKey,
    boardOptionsFallbackStatus,
    composeBoardFqbn,
    createBoardOptionSwitchState,
    extractSelectedBoardOptionDefaults,
    mergeBoardConfigOptions,
    mergeBoardOptionSchemas,
    parseBoardFqbnOptions,
    resolveBoardOptionsWithDiagnostics,
    updateExplicitBoardOption,
} = fqbn;

test('only permits core-default fallback when no explicit project options exist', () => {
    assert.equal(boardOptionsFallbackStatus({}), 'core-default');
    assert.equal(boardOptionsFallbackStatus({ FlashSize: '16M' }), 'unverified');
    assert.equal(boardOptionsFallbackStatus({ 'bad key': 'ignored' }), 'core-default');
});

test('core/board cache invalidation reloads the active schema and unverified options block compile', () => {
    assert.match(
        hardwareContextSource,
        /void loadDefaults\(\);\s*\}, \[activeBoard, activeBoardPackageId, boardOptionsReloadSeq\]\);/,
    );
    assert.match(hardwareContextSource, /cachedBoardOptionSchema\(requestedBoard, requestedPackageId\)/);
    assert.match(hardwareContextSource, /activeBoardPackageIdRef\.current !== requestedPackageId/);
    assert.match(workspaceSource, /if \(boardOptionsStatus === 'unverified'\)/);
    assert.match(workspaceSource, /为避免静默改用默认配置，已阻止编译\/上传/);
    assert.match(workspaceSource, /configOptions=\{activeBoardPackage\?\.config_options\}/);
    assert.match(boardConfigSource, /mergeBoardConfigOptions\(coreConfigs, configOptions\)/);
    assert.match(
        hardwareContextSource,
        /if \(versionsChanged \|\| options\.invalidateBoardSchemas === true\) \{\s*invalidateCurrentBoardOptionSchema\(\);/,
        'an explicit core refresh must invalidate schemas after a same-version reinstall',
    );
    assert.match(
        boardSelectorSource,
        /refreshInstalledCores\(\{ invalidateBoardSchemas: true \}\)/,
        'known install/uninstall flows must request same-version schema invalidation',
    );
});

const esp32Options = [
    {
        option: 'FlashSize',
        values: [
            { value: '4M', selected: true },
            { value: '8M' },
            { value: '16M' },
        ],
    },
    {
        option: 'PartitionScheme',
        values: [
            { value: 'default', selected: true },
            { value: 'app3M_fat9M_16MB' },
        ],
    },
    {
        option: 'PSRAM',
        values: [
            { value: 'disabled', selected: true },
            { value: 'qspi' },
            { value: 'opi' },
        ],
    },
    {
        option: 'Module',
        values: [
            { value: 'N8R8', selected: true },
            { value: 'N16R8' },
            { value: 'N32R16' },
        ],
    },
];

test('composes a deterministic full FQBN and strips existing option suffixes', () => {
    assert.equal(
        composeBoardFqbn('esp32:esp32:esp32s3:Old=stale', {
            PSRAM: 'opi',
            PartitionScheme: 'app3M_fat9M_16MB',
            FlashSize: '16M',
        }),
        'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,PartitionScheme=app3M_fat9M_16MB',
    );
    assert.equal(baseBoardFqbn('esp32:esp32:esp32s3:FlashSize=16M'), 'esp32:esp32:esp32s3');
    assert.equal(composeBoardFqbn('esp32:esp32:esp32s3:FlashSize=16M', {}), 'esp32:esp32:esp32s3');
    assert.deepEqual(parseBoardFqbnOptions(
        'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi',
    ), { FlashSize: '16M', PSRAM: 'opi' });
});

test('completes legacy AVR defaults without overriding an explicit processor choice', () => {
    assert.equal(
        composeBoardFqbn('arduino:avr:diecimila', {}),
        'arduino:avr:diecimila:cpu=atmega328',
    );
    assert.equal(
        composeBoardFqbn('arduino:avr:nano', {}),
        'arduino:avr:nano:cpu=atmega328',
    );
    assert.equal(
        composeBoardFqbn('arduino:avr:mega', {}),
        'arduino:avr:mega:cpu=atmega2560',
    );
    assert.equal(
        composeBoardFqbn('arduino:avr:diecimila', { cpu: 'atmega168' }),
        'arduino:avr:diecimila:cpu=atmega168',
    );
});

test('extracts every selected core default and its exact allowed value set', () => {
    const schema = extractSelectedBoardOptionDefaults(esp32Options);
    assert.deepEqual(schema.defaults, {
        FlashSize: '4M',
        PartitionScheme: 'default',
        PSRAM: 'disabled',
        Module: 'N8R8',
    });
    assert.deepEqual([...schema.allowedValues.get('FlashSize')], ['4M', '8M', '16M']);
    assert.equal(schema.allowedValues.get('PSRAM').has('opi'), true);
});

test('same-FQBN board packages have isolated option-schema cache identities', () => {
    assert.notEqual(
        boardOptionSchemaCacheKey('esp32:esp32:esp32c6', 'carrier-a'),
        boardOptionSchemaCacheKey('esp32:esp32:esp32c6', 'carrier-b'),
    );
    assert.equal(
        boardOptionSchemaCacheKey('esp32:esp32:esp32c6:FlashSize=8M', 'carrier-a'),
        'esp32:esp32:esp32c6::carrier-a',
    );
});

test('package menus conservatively narrow Core choices and own their default', () => {
    const packageOptions = [{
        option: 'FlashSize',
        option_label: 'Carrier Flash',
        values: [
            { value: '8M', value_label: '8 MB' },
            { value: '16M', value_label: '16 MB', selected: true },
        ],
    }];
    const merged = mergeBoardConfigOptions(esp32Options, packageOptions);
    const flash = merged.find(option => option.option === 'FlashSize');
    assert.deepEqual(flash.values.map(value => value.value), ['8M', '16M']);
    assert.equal(flash.values.find(value => value.selected)?.value, '16M');
    assert.equal(merged.find(option => option.option === 'PSRAM').values.length, 3);

    const schema = mergeBoardOptionSchemas(esp32Options, packageOptions);
    assert.equal(schema.defaults.FlashSize, '16M');
    assert.deepEqual([...schema.allowedValues.get('FlashSize')], ['8M', '16M']);
});

test('package menus cannot silently invent Core keys, values, or remove a default', () => {
    assert.throws(
        () => mergeBoardConfigOptions(esp32Options, [{
            option: 'UnknownMenu',
            values: [{ value: 'enabled', selected: true }],
        }]),
        /does not provide it/,
    );
    assert.throws(
        () => mergeBoardConfigOptions(esp32Options, [{
            option: 'FlashSize',
            values: [{ value: '64M', selected: true }],
        }]),
        /unsupported Core value 64M/,
    );
    assert.throws(
        () => mergeBoardConfigOptions(esp32Options, [{
            option: 'FlashSize',
            values: [{ value: '8M' }, { value: '16M' }],
        }]),
        /excludes the Core default without declaring a replacement/,
    );
});

test('board switches synchronously drop old options and use cached defaults for display only', () => {
    const schema = extractSelectedBoardOptionDefaults(esp32Options);
    assert.deepEqual(createBoardOptionSwitchState(null), {
        projectOptions: {},
        compileOptions: {},
        displayOptions: {},
        dropped: {},
        status: 'loading',
    });
    const cached = createBoardOptionSwitchState(schema);
    assert.deepEqual(cached.projectOptions, {});
    assert.deepEqual(cached.compileOptions, {}, 'core defaults must not create a cold compile FQBN');
    assert.equal(cached.displayOptions.FlashSize, '4M');
    assert.equal(cached.displayOptions.PSRAM, 'disabled');
    assert.equal(cached.status, 'resolved');

    const migrated = createBoardOptionSwitchState(schema, { FlashSize: '16M', PSRAM: 'opi' });
    assert.deepEqual(migrated.compileOptions, { FlashSize: '16M', PSRAM: 'opi' });
    assert.equal(migrated.displayOptions.PartitionScheme, 'default');
});

test('switching default to custom and back removes the explicit FQBN override', () => {
    const defaults = { FlashSize: '4M', PartitionScheme: 'default', PSRAM: 'disabled' };
    const base = 'esp32:esp32:esp32s3';
    const custom = updateExplicitBoardOption({}, 'FlashSize', '16M', defaults);
    assert.equal(composeBoardFqbn(base, custom), 'esp32:esp32:esp32s3:FlashSize=16M');
    const restored = updateExplicitBoardOption(custom, 'FlashSize', '4M', defaults);
    assert.deepEqual(restored, {});
    assert.equal(composeBoardFqbn(base, restored), base);
});

test('keeps valid N/R-related choices and rejects unsupported keys and values', () => {
    const schema = extractSelectedBoardOptionDefaults(esp32Options);
    const valid = resolveBoardOptionsWithDiagnostics(
        schema.defaults,
        { FlashSize: '16M', PSRAM: 'opi', Module: 'N16R8' },
        schema.allowedKeys,
        schema.allowedValues,
    );
    assert.equal(valid.options.FlashSize, '16M');
    assert.equal(valid.options.PSRAM, 'opi');
    assert.equal(valid.options.Module, 'N16R8');
    assert.deepEqual(valid.dropped, {});

    const invalid = resolveBoardOptionsWithDiagnostics(
        schema.defaults,
        { FlashSize: '64M', PSRAM: 'foo', OldBoardOnly: 'enabled' },
        schema.allowedKeys,
        schema.allowedValues,
    );
    assert.equal(invalid.options.FlashSize, '4M', 'invalid Flash falls back to the core default');
    assert.equal(invalid.options.PSRAM, 'disabled', 'invalid PSRAM falls back to the core default');
    assert.deepEqual(invalid.dropped, {
        FlashSize: '64M',
        PSRAM: 'foo',
        OldBoardOnly: 'enabled',
    });
});
