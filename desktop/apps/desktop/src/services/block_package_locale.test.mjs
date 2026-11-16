import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./block_package_locale.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'block_package_locale.ts',
});
const locale = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

const manifest = {
    schema_version: 2,
    id: 'demo_sensor',
    display_name: '演示传感器',
    description: '读取传感器数据。',
    keywords: ['传感器'],
    blocks: [{
        type: 'demo_read',
        display_name: '读取传感器',
        description: '读取传感器数值。',
        category: 'sensor',
        fields: [{
            name: 'AXIS',
            description: '轴',
            options: [
                { label: 'X轴', value: 'x' },
                { label: 'Y轴', value: 'y' },
            ],
        }],
    }],
};

const zh = locale.parseBlockPackageLocaleDocument(JSON.stringify({
    locale: 'zh-CN',
    package: { displayName: '演示传感器', description: '读取传感器数据。', keywords: ['传感器'] },
    categories: { sensor: '传感器' },
    blocks: {
        demo_read: {
            displayName: '读取传感器',
            tooltip: '读取传感器数值。',
            fields: { AXIS: { label: '轴', options: { x: 'X轴', y: 'Y轴' } } },
        },
    },
}));
const en = locale.parseBlockPackageLocaleDocument(JSON.stringify({
    locale: 'en-US',
    package: { displayName: 'Demo Sensor', description: 'Read sensor data.', keywords: ['sensor'] },
    categories: { sensor: 'Sensors' },
    blocks: {
        demo_read: {
            displayName: 'Read sensor',
            tooltip: 'Read a sensor value.',
            category: 'Sensors',
            fields: { AXIS: { label: 'Axis', options: { x: 'X axis', y: 'Y axis' } } },
        },
    },
}));

test('discovers locale files without an author-maintained list', () => {
    assert.deepEqual(locale.discoverPackageLocales([
        'zh-CN.json', 'en-US.json', 'README.md', 'nested/ja-JP.json', 'bad name.json', 'ZH-cn.json',
    ]), ['en-US', 'zh-CN']);
});

test('creates zh-only, en-only and bilingual bundles with deterministic default', () => {
    const zhOnly = locale.createBlockPackageLocaleBundle([zh], 'zh-CN');
    assert.equal(zhOnly.defaultLocale, 'zh-CN');
    assert.equal(locale.resolveBlockPackagePresentation(manifest, zhOnly, 'en-US').source, 'default');

    const enOnly = locale.createBlockPackageLocaleBundle([en], 'en-US');
    assert.equal(enOnly.defaultLocale, 'en-US');
    assert.equal(locale.resolveBlockPackagePresentation(manifest, enOnly, 'zh-CN').package.displayName, 'Demo Sensor');

    const bilingual = locale.createBlockPackageLocaleBundle([zh, en], 'zh-CN');
    assert.equal(locale.resolveBlockPackagePresentation(manifest, bilingual, 'en-US').locale, 'en-US');
});

test('fallback is requested locale, then package default, then raw machine presentation', () => {
    const bundle = locale.createBlockPackageLocaleBundle([zh], 'zh-CN');
    const resolved = locale.resolveBlockPackagePresentation(manifest, bundle, 'en-US');
    assert.equal(resolved.source, 'default');
    assert.equal(resolved.blocks.demo_read.displayName, '读取传感器');
    assert.equal(resolved.blocks.demo_read.category, '传感器');

    const raw = locale.resolveBlockPackagePresentation(manifest, null, 'en-US');
    assert.equal(raw.source, 'raw');
    assert.equal(raw.blocks.demo_read.displayName, '读取传感器');
});

test('locale labels never replace dropdown values or machine field names', () => {
    const bundle = locale.createBlockPackageLocaleBundle([en], 'en-US');
    const resolved = locale.resolveBlockPackagePresentation(manifest, bundle, 'en-US');
    const field = resolved.blocks.demo_read.fields[0];
    assert.equal(field.name, 'AXIS');
    assert.deepEqual(field.options, [
        { label: 'X axis', value: 'x' },
        { label: 'Y axis', value: 'y' },
    ]);
    assert.equal(manifest.blocks[0].fields[0].options[0].label, 'X轴');
    assert.equal(manifest.blocks[0].fields[0].options[0].value, 'x');
});

test('numeric and hardware-like option values remain valid stable identities', () => {
    const document = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: { demo_read: { fields: { PIN: { options: { '13': 'GPIO 13', 'A5': 'Analog A5' } } } } },
    }));
    assert.deepEqual(document.blocks.demo_read.fields.PIN.options, {
        '13': 'GPIO 13',
        A5: 'Analog A5',
    });
});

test('legacy unicode category lookup keys remain presentation-only and bounded', () => {
    const document = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'zh-CN',
        categories: { '模拟传感': '模拟传感' },
        blocks: { demo_read: { category: '模拟传感' } },
    }));
    assert.equal(document.categories['模拟传感'], '模拟传感');
    const bundle = locale.createBlockPackageLocaleBundle([document], 'zh-CN');
    const resolved = locale.resolveBlockPackagePresentation({
        ...manifest,
        blocks: [{ ...manifest.blocks[0], category: '模拟传感' }],
    }, bundle, 'zh-CN');
    assert.equal(resolved.blocks.demo_read.category, '模拟传感');
    assert.throws(() => locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'zh-CN',
        categories: { 'bad\nkey': '标签' },
    })), /invalid key/);
});

test('runtime view detaches machine package and leaves canonical manifest untouched', () => {
    const bundle = locale.createBlockPackageLocaleBundle([en], 'en-US');
    const before = structuredClone(manifest);
    const view = locale.createBlockPackageRuntimeView(manifest, bundle, 'en-US');
    assert.deepEqual(manifest, before);
    assert.notEqual(view.machinePackage, manifest);
    assert.equal(view.machinePackage.id, 'demo_sensor');
    assert.equal(view.presentation.blocks.demo_read.type, 'demo_read');
});

test('legacy package adapter exposes raw single-locale presentation', () => {
    const bundle = locale.adaptLegacyPackageLocale(manifest);
    const resolved = locale.resolveBlockPackagePresentation(manifest, bundle, 'en-US');
    assert.equal(bundle.legacy, true);
    assert.equal(resolved.source, 'raw');
    assert.equal(resolved.package.displayName, '演示传感器');
});

test('parser rejects machine identity fields and invalid locale documents', () => {
    assert.throws(() => locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: { demo_read: { type: 'changed', displayName: 'Read' } },
    })), /unsupported fields/);
    assert.throws(() => locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: { demo_read: { fields: { AXIS: { options: { x: '' } } } } },
    })), /must not be empty/);
    assert.throws(() => locale.createBlockPackageLocaleBundle([en], 'zh-CN'), /has no locale document/);
    assert.throws(() => locale.createBlockPackageLocaleBundle([en], undefined), /must declare defaultLocale/);
});

test('defaultLocale is presentation metadata only', () => {
    const bundle = locale.createBlockPackageLocaleBundle([zh, en], 'en-US');
    const resolved = locale.resolveBlockPackagePresentation({ ...manifest, defaultLocale: 'en-US' }, bundle, 'en-US');
    assert.equal(resolved.package.displayName, 'Demo Sensor');
    assert.equal(resolved.blocks.demo_read.fields[0].options[0].value, 'x');
});

test('declarative runtime overlay changes presentation only', () => {
    const runtimeLocale = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: {
            demo_read: {
                message: 'Read sensor value %1',
                tooltip: 'Read a sensor value.',
                fields: {
                    AXIS: { options: { x: 'X axis', y: 'Y axis' } },
                    LABEL: { label: 'Axis label' },
                },
            },
        },
    }));
    const bundle = locale.createBlockPackageLocaleBundle([runtimeLocale], 'en-US');
    const defs = [{
        type: 'demo_read',
        message0: '读取传感器值 %1',
        tooltip: '原始提示',
        args0: [
            { type: 'field_dropdown', name: 'AXIS', options: [['X轴', 'x'], ['Y轴', 'y']] },
            { type: 'field_label', name: 'LABEL', text: '原始标签' },
            { type: 'field_input', name: 'DEFAULT', text: '机器默认值' },
        ],
    }];
    const before = structuredClone(defs);
    const localized = locale.localizeDeclarativeBlockDefinitions(defs, manifest, bundle, 'en-US');
    assert.deepEqual(defs, before);
    assert.equal(localized[0].type, 'demo_read');
    assert.equal(localized[0].message0, 'Read sensor value %1');
    assert.equal(localized[0].tooltip, 'Read a sensor value.');
    assert.deepEqual(localized[0].args0[0].options, [['X axis', 'x'], ['Y axis', 'y']]);
    assert.equal(localized[0].args0[1].text, 'Axis label');
    assert.equal(localized[0].args0[2].text, '机器默认值');
});

test('runtime overlay keeps connection layout when translated placeholders differ', () => {
    const runtimeLocale = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: { demo_read: { message: 'Read sensor value' } },
    }));
    const bundle = locale.createBlockPackageLocaleBundle([runtimeLocale], 'en-US');
    const defs = [{ type: 'demo_read', message0: '读取传感器值 %1', args0: [] }];
    const localized = locale.localizeDeclarativeBlockDefinitions(defs, manifest, bundle, 'en-US');
    assert.equal(localized[0].message0, '读取传感器值 %1');
});

test('declarative locale reapplication round-trips presentation without changing machine fields', () => {
    const zhRuntime = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'zh-CN',
        blocks: {
            demo_read: {
                message: '读取传感器值 %1',
                tooltip: '读取传感器数值。',
                fields: {
                    AXIS: { options: { x: 'X轴', y: 'Y轴' } },
                    LABEL: { label: '轴' },
                },
            },
        },
    }));
    const enRuntime = locale.parseBlockPackageLocaleDocument(JSON.stringify({
        locale: 'en-US',
        blocks: {
            demo_read: {
                message: 'Read sensor value %1',
                tooltip: 'Read a sensor value.',
                fields: {
                    AXIS: { options: { x: 'X axis', y: 'Y axis' } },
                    LABEL: { label: 'Axis' },
                },
            },
        },
    }));
    const bundle = locale.createBlockPackageLocaleBundle([zhRuntime, enRuntime], 'zh-CN');
    const defs = [{
        type: 'demo_read',
        message0: '读取传感器值 %1',
        tooltip: '原始提示',
        args0: [
            { type: 'field_dropdown', name: 'AXIS', options: [['X轴', 'x'], ['Y轴', 'y']] },
            { type: 'field_label', name: 'LABEL', text: '原始标签' },
            { type: 'field_input', name: 'DEFAULT', text: '机器默认值' },
        ],
    }];
    const before = structuredClone(defs);
    const machineProjection = value => value.map(def => ({
        type: def.type,
        args0: (def.args0 || []).map(arg => {
            const projected = { type: arg.type, name: arg.name };
            if (Array.isArray(arg.options)) {
                projected.optionValues = arg.options.map(option => (
                    Array.isArray(option) ? option[1] : option
                ));
            }
            if (arg.type === 'field_input') projected.text = arg.text;
            return projected;
        }),
    }));
    const baselineMachine = machineProjection(defs);

    const zhApplied = locale.localizeDeclarativeBlockDefinitions(defs, manifest, bundle, 'zh-CN');
    const enApplied = locale.localizeDeclarativeBlockDefinitions(defs, manifest, bundle, 'en-US');
    const zhRoundTrip = locale.localizeDeclarativeBlockDefinitions(enApplied, manifest, bundle, 'zh-CN');

    assert.equal(zhApplied[0].message0, '读取传感器值 %1');
    assert.equal(zhApplied[0].tooltip, '读取传感器数值。');
    assert.deepEqual(zhApplied[0].args0[0].options, [['X轴', 'x'], ['Y轴', 'y']]);
    assert.equal(zhApplied[0].args0[1].text, '轴');

    assert.equal(enApplied[0].message0, 'Read sensor value %1');
    assert.equal(enApplied[0].tooltip, 'Read a sensor value.');
    assert.deepEqual(enApplied[0].args0[0].options, [['X axis', 'x'], ['Y axis', 'y']]);
    assert.equal(enApplied[0].args0[1].text, 'Axis');

    assert.equal(zhRoundTrip[0].message0, '读取传感器值 %1');
    assert.equal(zhRoundTrip[0].tooltip, '读取传感器数值。');
    assert.deepEqual(zhRoundTrip[0].args0[0].options, [['X轴', 'x'], ['Y轴', 'y']]);
    assert.equal(zhRoundTrip[0].args0[1].text, '轴');

    assert.deepEqual(machineProjection(zhApplied), baselineMachine);
    assert.deepEqual(machineProjection(enApplied), baselineMachine);
    assert.deepEqual(machineProjection(zhRoundTrip), baselineMachine);
    assert.equal(enApplied[0].args0[2].text, '机器默认值');
    assert.equal(zhRoundTrip[0].args0[2].text, '机器默认值');
    assert.deepEqual(defs, before);
});
