import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { resourceModuleUrl } from './resource_test_loader.mjs';

const sourcePath = new URL('./pin_preflight.ts', import.meta.url);
const pinTokenSource = await readFile(new URL('./pin_code_token.ts', import.meta.url), 'utf8');
const pinTokenOutput = ts.transpileModule(pinTokenSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const pinTokenUrl = `data:text/javascript;base64,${Buffer.from(pinTokenOutput).toString('base64')}`;
const source = (await readFile(sourcePath, 'utf8'))
    .replace("'./blockly_compat_analysis'", `'${await resourceModuleUrl(new URL('./blockly_compat_analysis.ts', import.meta.url))}'`)
    .replace("'./pin_code_token'", `'${pinTokenUrl}'`);
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'pin_preflight.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'pin_preflight.ts should transpile without syntax errors');

const { analyzePinPreflight, filterPinCatalog, pinBlockRulesFromCatalog, summarizePinReferences } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const officialBoards = [{
    name: 'Arduino Nano',
    fqbn: 'arduino:avr:nano',
    pins: [
        { label: 'D2', value: '2' },
        { label: 'D3', value: '3' },
        { label: 'A0', value: 'A0' },
    ],
}];

const literal = (id, type, field, value) => ({
    id,
    type,
    getFieldValue(name) {
        return name === field ? value : null;
    },
});

const pinSelector = (id, value) => literal(id, 'board_pin_selector', 'PIN', value);
const numberLiteral = (id, value) => literal(id, 'math_number', 'NUM', value);
const variable = (id) => literal(id, 'variables_get', 'VAR', 'pinVar');

const block = (id, type, inputs = {}) => ({
    id,
    type,
    getInputTargetBlock(name) {
        return inputs[name] || null;
    },
});

const workspace = (...blocks) => ({
    getAllBlocks() {
        return blocks;
    },
});

test('Blink groups mode and repeated writes into one role and retains every block', () => {
    const mode = block('mode', 'set_pin_mode', { PIN: pinSelector('p0', '2') });
    mode.getFieldValue = () => 'OUTPUT';
    const writes = ['w1', 'w2', 'w3'].map(id => block(id, 'io_digital_write', { PIN: pinSelector(id + 'p', '2') }));
    const report = analyzePinPreflight({ workspace: workspace(mode, ...writes), boardFqbn: 'arduino:avr:nano', officialBoards });
    const summary = summarizePinReferences(report.usages);
    assert.equal(summary.roleCount, 1);
    assert.equal(summary.referenceCount, 4);
    assert.equal(summary.conflictCount, 0);
    assert.deepEqual(summary.roles[0].references.map(r => r.blockId), ['mode', 'w1', 'w2', 'w3']);
    assert.equal(summarizePinReferences(report.usages.slice(1)).roleCount, 1);
    assert.equal(summarizePinReferences(report.usages.map(usage => ({ ...usage, sharing: 'exclusive' }))).conflictCount, 0);
    const read = analyzePinPreflight({ workspace: workspace(block('read', 'io_digital_read', { PIN: pinSelector('rp', '2') })), boardFqbn: 'arduino:avr:nano', officialBoards });
    const mixed = summarizePinReferences([...report.usages, ...read.usages]);
    assert.equal(mixed.roleCount, 2);
    assert.equal(mixed.conflictCount, 1);
    mode.getFieldValue = () => 'INPUT';
    const inputs = analyzePinPreflight({ workspace: workspace(mode, block('read', 'io_digital_read', { PIN: pinSelector('rp', '2') })), boardFqbn: 'arduino:avr:nano', officialBoards });
    assert.equal(summarizePinReferences(inputs.usages).roleCount, 1);
});

test('lists cross-block reuse without guessing that it is a conflict', () => {
    const report = analyzePinPreflight({
        workspace: workspace(
            block('write', 'io_digital_write', { PIN: pinSelector('p1', '2') }),
            block('read', 'io_digital_read', { PIN: numberLiteral('p2', 2) }),
        ),
        boardFqbn: 'arduino:avr:nano:cpu=atmega328old',
        officialBoards,
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.boardBaseFqbn, 'arduino:avr:nano');
    assert.equal(report.canCompile, true);
    assert.equal(report.blockers.length, 0);
    assert.equal(report.groups.length, 1);
    assert.equal(report.groups[0].value, '2');
    assert.equal(report.groups[0].boardLabel, 'D2');
    assert.deepEqual(report.groups[0].usages.map(usage => usage.blockId), ['write', 'read']);
});

test('blocks only a registered same-block data/clock collision', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('shift', 'io_shift_out', {
            DATA_PIN: pinSelector('data', '3'),
            CLOCK_PIN: numberLiteral('clock', 3),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.canCompile, false);
    assert.equal(report.blockers.length, 1);
    assert.equal(report.blockers[0].code, 'same-block-pin-collision');
    assert.equal(report.blockers[0].blockId, 'shift');
});

test('blocks a registered same-block RX/TX collision', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('serial', 'serial_setup_with_pins', {
            RX: numberLiteral('rx', 2),
            TX: numberLiteral('tx', 2),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.canCompile, false);
    assert.equal(report.blockers[0].code, 'same-block-pin-collision');
});

test('marks variables and missing inputs as unknown without blocking', () => {
    const report = analyzePinPreflight({
        workspace: workspace(
            block('dynamic', 'io_digital_read', { PIN: variable('var') }),
            block('missing', 'write_servo'),
        ),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.canCompile, true);
    assert.deepEqual(report.usages.map(usage => usage.resolution), ['unknown', 'unknown']);
    assert.deepEqual(report.issues.map(issue => issue.code), [
        'dynamic-pin-expression',
        'missing-pin-input',
    ]);
});

test('does not inspect unregistered third-party PIN fields', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('third-party', 'vendor_motor_driver', {
            PIN: numberLiteral('vendor-pin', 2),
            DATA_PIN: numberLiteral('vendor-data', 2),
            CLOCK_PIN: numberLiteral('vendor-clock', 2),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.analyzedBlockCount, 0);
    assert.equal(report.ignoredBlockCount, 1);
    assert.deepEqual(report.usages, []);
    assert.deepEqual(report.issues, []);
});

test('inspects third-party pins only through an explicit quality-gated rule', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('third-party', 'vendor_motor_driver', {
            DATA_PIN: numberLiteral('vendor-data', 2),
            CLOCK_PIN: numberLiteral('vendor-clock', 2),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
        blockRules: {
            vendor_motor_driver: {
                label: '第三方电机驱动',
                pins: [
                    { inputName: 'DATA_PIN', label: '数据管脚' },
                    { inputName: 'CLOCK_PIN', label: '时钟管脚' },
                ],
                distinct: [{
                    inputs: ['DATA_PIN', 'CLOCK_PIN'],
                    message: '数据管脚和时钟管脚不能相同。',
                }],
            },
        },
    });

    assert.equal(report.analyzedBlockCount, 1);
    assert.equal(report.canCompile, false);
    assert.equal(report.blockers[0].code, 'same-block-pin-collision');
    assert.match(report.blockers[0].title, /第三方电机驱动/);
});

test('a package rule cannot override a built-in block safety contract', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('shift', 'io_shift_out', {
            DATA_PIN: numberLiteral('data', 2),
            CLOCK_PIN: numberLiteral('clock', 2),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
        blockRules: {
            io_shift_out: {
                label: '恶意覆盖',
                pins: [],
            },
        },
    });

    assert.equal(report.canCompile, false);
    assert.equal(report.blockers[0].code, 'same-block-pin-collision');
    assert.doesNotMatch(report.blockers[0].title, /恶意覆盖/);
});

test('derives third-party pin rules only from explicit v2 hardware metadata', () => {
    const rules = pinBlockRulesFromCatalog([
        {
            type: 'vendor_motor_driver',
            display_name: '电机驱动',
            keywords: [],
            source: 'manifest',
            metadata_source: 'v2',
            hardware: {
                resources: [
                    {
                        kind: 'gpio',
                        source: { kind: 'input', name: 'SIGNAL' },
                        description: '信号管脚',
                    },
                    {
                        kind: 'pwm',
                        source: { kind: 'field', name: 'ENABLE_PIN' },
                        description: '使能管脚',
                    },
                    {
                        kind: 'i2c',
                        source: { kind: 'board-default' },
                        description: '默认总线不应伪装成显式引脚',
                    },
                ],
            },
        },
        {
            type: 'legacy_pin_block',
            keywords: [],
            source: 'manifest',
            metadata_source: 'v1-adapted',
            hardware: {
                resources: [{
                    kind: 'gpio',
                    source: { kind: 'input', name: 'PIN' },
                    description: '旧数据不能成为证明',
                }],
            },
        },
    ]);

    assert.deepEqual(rules.vendor_motor_driver.pins, [
        {
            inputName: 'SIGNAL',
            label: '信号管脚',
            kind: 'gpio',
            access: undefined,
            sharing: undefined,
            capabilities: undefined,
        },
        {
            fieldName: 'ENABLE_PIN',
            label: '使能管脚',
            kind: 'pwm',
            access: undefined,
            sharing: undefined,
            capabilities: undefined,
        },
    ]);
    assert.equal(rules.legacy_pin_block, undefined);
});

test('analyzes a v2 pin declared directly by a third-party block field', () => {
    const report = analyzePinPreflight({
        workspace: workspace({
            id: 'vendor',
            type: 'vendor_field_pin',
            getFieldValue(name) {
                return name === 'PIN' ? '3' : null;
            },
        }),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
        blockRules: {
            vendor_field_pin: {
                label: '字段引脚积木',
                pins: [{ fieldName: 'PIN', label: '输出引脚' }],
            },
        },
    });

    assert.equal(report.usages[0].literalSource, 'block_field');
    assert.equal(report.usages[0].value, '3');
    assert.equal(report.usages[0].resolution, 'known');
});

test('keeps the complete board catalog and resolves symbolic aliases without guessing', () => {
    const boardWithAliases = {
        name: 'Vendor MCU Board',
        fqbn: 'vendor:mcu:board',
        packageId: 'vendor-board-package',
        isCustom: true,
        pinEvidenceLevel: 'publisher',
        pins: [
            { label: 'GPIO 2', value: '2', aliases: ['D2', 'GPIO2'], capabilities: ['digital'] },
            { label: 'Port A 5', value: 'PA5', aliases: ['SCK'], capabilities: ['digital-output'] },
            { label: 'User LED', value: 'LED_BUILTIN', aliases: ['LED'], capabilities: ['digital-output'] },
        ],
    };
    const report = analyzePinPreflight({
        workspace: workspace(
            block('d2', 'io_digital_write', { PIN: literal('d2-text', 'text', 'TEXT', 'D2') }),
            block('pa5', 'io_digital_write', { PIN: literal('pa5-text', 'text', 'TEXT', 'PA5') }),
        ),
        boardFqbn: 'vendor:mcu:board',
        boardPackageId: 'vendor-board-package',
        officialBoards: [boardWithAliases],
    });

    assert.equal(report.catalog.length, 3, 'unused pins remain searchable');
    assert.deepEqual(report.usages.map(usage => usage.value), ['2', 'PA5']);
    assert.equal(report.usages.every(usage => usage.resolution === 'known'), true);
});

test('selects the concrete custom package when it shares an FQBN with a built-in board', () => {
    const builtIn = {
        name: 'Generic ESP32-C6',
        fqbn: 'esp32:esp32:esp32c6',
        packageId: 'esp32:esp32:esp32c6',
        pins: [{ label: 'Generic GPIO2', value: '2' }],
    };
    const custom = {
        name: 'My C6 Carrier',
        fqbn: 'esp32:esp32:esp32c6',
        packageId: 'my-c6-carrier',
        isCustom: true,
        pins: [{ label: 'Carrier D7', value: '7', aliases: ['STATUS_LED'] }],
    };
    const report = analyzePinPreflight({
        workspace: workspace(block('read', 'io_digital_read', {
            PIN: literal('alias', 'text', 'TEXT', 'STATUS_LED'),
        })),
        boardFqbn: 'esp32:esp32:esp32c6',
        boardPackageId: 'my-c6-carrier',
        officialBoards: [builtIn, custom],
    });

    assert.equal(report.boardName, 'My C6 Carrier');
    assert.equal(report.usages[0].value, '7');
    assert.equal(report.catalog.some(pin => pin.value === '2'), false);
});

test('applies option-scoped risks and does not let publisher-only evidence hard block', () => {
    const boardWithRisk = {
        name: 'USB Carrier',
        fqbn: 'vendor:usb:carrier',
        packageId: 'usb-carrier',
        isCustom: true,
        pinEvidenceLevel: 'publisher',
        pins: [{
            label: 'USB D-',
            value: '12',
            capabilities: ['digital-output'],
            risks: [{
                code: 'usb-conflict',
                severity: 'blocker',
                title: '当前配置保留给 USB',
                roles: ['write'],
                when: { options: { USBMode: ['hwcdc'] } },
            }],
        }],
    };
    const createReport = (USBMode) => analyzePinPreflight({
        workspace: workspace(block('write', 'io_digital_write', { PIN: numberLiteral('pin12', 12) })),
        boardFqbn: boardWithRisk.fqbn,
        boardPackageId: boardWithRisk.packageId,
        boardOptions: { USBMode },
        officialBoards: [boardWithRisk],
    });

    const active = createReport('hwcdc');
    assert.equal(active.canCompile, true);
    assert.equal(active.warnings.some(issue => issue.code === 'pin-risk'), true);
    assert.equal(active.catalog[0].activeRisks.length, 1);
    const inactive = createReport('disabled');
    assert.equal(inactive.issues.some(issue => issue.code === 'pin-risk'), false);
    assert.equal(inactive.catalog[0].activeRisks.length, 0);
});

test('searches own pin values aliases capabilities risks reservations and using blocks', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('servo', 'write_servo', { PIN: numberLiteral('pin3', 3) })),
        boardFqbn: 'vendor:mcu:board',
        officialBoards: [{
            name: 'Search Board',
            fqbn: 'vendor:mcu:board',
            pins: [
                { label: 'D3', value: '3', aliases: ['PWM_A'], capabilities: ['pwm'] },
                { label: 'D8', value: '8', reserved_by: 'onboard-rgb', risks: [{ code: 'boot', severity: 'warning', title: '启动绑带' }] },
            ],
        }],
    });

    assert.deepEqual(filterPinCatalog(report.catalog, { query: 'PWM_A' }).map(pin => pin.value), ['3']);
    assert.deepEqual(filterPinCatalog(report.catalog, { query: '舵机' }).map(pin => pin.value), ['3']);
    assert.deepEqual(filterPinCatalog(report.catalog, { query: '启动绑带' }).map(pin => pin.value), ['8']);
    assert.deepEqual(filterPinCatalog(report.catalog, { filter: 'used' }).map(pin => pin.value), ['3']);
    assert.deepEqual(filterPinCatalog(report.catalog, { filter: 'risk' }).map(pin => pin.value), ['8']);
});

test('keeps board-level risks informational when the pin is unused', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('write', 'io_digital_write', { PIN: numberLiteral('pin3', 3) })),
        boardFqbn: 'vendor:mcu:unused-risk',
        officialBoards: [{
            name: 'Unused Risk Board',
            fqbn: 'vendor:mcu:unused-risk',
            pins: [
                { label: 'UART RX', value: '0', capabilities: ['digital', 'digital-input'], risks: [{
                    code: 'serial0-rx-upload-conflict',
                    severity: 'warning',
                    title: 'UART0/USB 串口复用，可能影响上传',
                }] },
                { label: 'D3', value: '3', capabilities: ['digital', 'digital-output'] },
            ],
        }],
    });

    assert.equal(report.issues.some(issue => issue.code === 'pin-risk'), false);
    assert.equal(report.catalog.find(pin => pin.value === '0')?.usages.length, 0);
    assert.equal(report.catalog.find(pin => pin.value === '0')?.activeRisks.length, 1);
});

test('warns but does not block when a literal is outside official board data', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('read', 'io_analog_read', {
            PIN: numberLiteral('pin99', 99),
        })),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.canCompile, true);
    assert.equal(report.usages[0].resolution, 'invalid');
    assert.equal(report.warnings[0].code, 'pin-not-on-board');
});

test('accepts an analog pin text literal but rejects an empty number field', () => {
    const report = analyzePinPreflight({
        workspace: workspace(
            block('analog', 'io_analog_read', {
                PIN: literal('a0', 'text', 'TEXT', 'a0'),
            }),
            block('empty', 'io_digital_read', {
                PIN: literal('empty-number', 'math_number', 'OTHER', ''),
            }),
        ),
        boardFqbn: 'arduino:avr:nano',
        officialBoards,
    });

    assert.equal(report.usages[0].value, 'A0');
    assert.equal(report.usages[0].resolution, 'known');
    assert.equal(report.usages[1].resolution, 'unknown');
    assert.equal(report.usages[1].unknownReason, 'invalid_literal');
});

test('skips custom boards instead of borrowing another board pin map', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('read', 'io_digital_read', {
            PIN: pinSelector('p1', '2'),
        })),
        boardFqbn: 'vendor:family:custom',
        officialBoards,
    });

    assert.equal(report.status, 'unsupported-board');
    assert.equal(report.canCompile, false);
    assert.equal(report.analyzedBlockCount, 0);
    assert.equal(report.notices[0].code, 'unsupported-board');
    assert.equal(report.blockers[0].code, 'missing-trusted-pin-catalog');
    assert.equal(report.blockers[0].blockId, 'read');
});

test('allows a no-pin workspace to remain viewable and compilable without a trusted catalog', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('delay', 'control_delay', {})),
        boardFqbn: 'vendor:family:custom',
        officialBoards,
    });

    assert.equal(report.status, 'unsupported-board');
    assert.equal(report.canCompile, true);
    assert.equal(report.blockers.length, 0);
    assert.equal(report.notices[0].code, 'unsupported-board');
});

test('blocks the undeclared-pin sentinel even inside an unregistered legacy extension block', () => {
    const legacyBlock = {
        id: 'legacy-pin',
        type: 'vendor_unknown_pin_block',
        inputList: [{
            fieldRow: [{ getValue: () => '__CK_PIN_UNDECLARED__' }],
        }],
    };
    const report = analyzePinPreflight({
        workspace: workspace(legacyBlock),
        boardFqbn: 'vendor:family:no-pins',
        boardPackageId: 'vendor-no-pins',
        officialBoards: [],
    });

    assert.equal(report.canCompile, false);
    assert.equal(report.blockers.some(issue => issue.code === 'undeclared-pin-sentinel'), true);
    assert.equal(report.blockers[0].blockId, 'legacy-pin');
});

test('keeps missing capability evidence unknown and never infers interrupt support from generic GPIO', () => {
    const unknown = analyzePinPreflight({
        workspace: workspace(block('write', 'io_digital_write', {
            PIN: numberLiteral('pin2', 2),
        })),
        boardFqbn: 'vendor:mcu:unknown-capability',
        officialBoards: [{
            name: 'Unknown Capability Board',
            fqbn: 'vendor:mcu:unknown-capability',
            pins: [{ label: 'GPIO 2', value: '2' }],
        }],
    });
    assert.equal(unknown.notices.some(issue => issue.code === 'pin-capability-unknown'), true);
    assert.equal(unknown.canCompile, true);

    const interrupt = analyzePinPreflight({
        workspace: workspace(block('irq', 'io_hardware_interrupt_event', {
            PIN: numberLiteral('irq-pin', 2),
        })),
        boardFqbn: 'vendor:mcu:no-interrupt-proof',
        officialBoards: [{
            name: 'Digital-only Board',
            fqbn: 'vendor:mcu:no-interrupt-proof',
            pins: [{ label: 'GPIO 2', value: '2', capabilities: ['digital', 'gpio'] }],
        }],
    });
    assert.equal(interrupt.warnings.some(issue => issue.code === 'pin-capability-mismatch'), true);
});

test('uses an imported board only when its own explicit pin catalog is supplied', () => {
    const importedBoard = {
        name: 'Vendor Sensor Board',
        fqbn: 'vendor:family:custom',
        pins: [{ label: 'D9 / GPIO9', value: '9' }],
    };
    const report = analyzePinPreflight({
        workspace: workspace(block('read', 'io_digital_read', {
            PIN: pinSelector('p9', '9'),
        })),
        boardFqbn: 'vendor:family:custom:FlashSize=8M',
        officialBoards: [...officialBoards, importedBoard],
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.boardName, 'Vendor Sensor Board');
    assert.equal(report.usages[0].boardLabel, 'D9 / GPIO9');
    assert.equal(report.usages[0].resolution, 'known');
});

test('available filter means only unused and does not claim missing or risky metadata is safe', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('used', 'io_digital_write', {
            PIN: numberLiteral('pin1', 1),
        })),
        boardFqbn: 'vendor:mcu:filters',
        officialBoards: [{
            name: 'Filter Board',
            fqbn: 'vendor:mcu:filters',
            pins: [
                { label: 'Used', value: '1' },
                { label: 'Risk', value: '2', risks: [{ code: 'usb', severity: 'warning', title: 'USB' }] },
                { label: 'Reserved', value: '3', reserved_by: ['display'] },
                { label: 'Exclusive but free', value: '4', sharing: 'exclusive' },
            ],
        }],
    });

    assert.deepEqual(filterPinCatalog(report.catalog, { filter: 'available' }).map(pin => pin.value), ['2', '3', '4']);
});

test('an exact package id never selects a package for a different compiler target', () => {
    const report = analyzePinPreflight({
        workspace: workspace(),
        boardFqbn: 'esp32:esp32:esp32c6',
        boardPackageId: 'vendor-c5',
        officialBoards: [{
            name: 'Vendor C5',
            fqbn: 'esp32:esp32:esp32c5',
            packageId: 'vendor-c5',
            isCustom: true,
            pins: [{ label: 'GPIO 1', value: '1' }],
        }],
    });

    assert.equal(report.status, 'unsupported-board');
});

test('a removed custom package never borrows built-in pins from the same FQBN', () => {
    const report = analyzePinPreflight({
        workspace: workspace(block('write', 'io_digital_write', {
            PIN: numberLiteral('pin0', 0),
        })),
        boardFqbn: 'esp32:esp32:esp32c6',
        boardPackageId: 'removed-c6-carrier',
        officialBoards: [{
            name: 'Built-in ESP32-C6',
            fqbn: 'esp32:esp32:esp32c6',
            pins: [{ label: 'GPIO 0', value: '0' }],
        }],
    });

    assert.equal(report.status, 'unsupported-board');
    assert.equal(report.canCompile, false);
    assert.equal(report.blockers[0].code, 'missing-trusted-pin-catalog');
    assert.equal(report.boardName, null);
    assert.deepEqual(report.catalog, []);
    assert.deepEqual(report.usages, []);
});

test('orders declared connectors by connector, side and physical position', () => {
    const report = analyzePinPreflight({
        workspace: workspace(),
        boardFqbn: 'vendor:mcu:layout',
        officialBoards: [{
            name: 'Layout Board',
            fqbn: 'vendor:mcu:layout',
            pins: [
                { label: 'J2 left 1', value: '7', connector: { id: 'J2', side: 'left', position: 1 } },
                { label: 'J1 right 1', value: '3', connector: { id: 'J1', side: 'right', position: 1 } },
                { label: 'No connector', value: '0' },
                { label: 'J1 left 2', value: '2', connector: { id: 'J1', side: 'left', position: 2 } },
                { label: 'J1 left 1', value: '1', connector: { id: 'J1', side: 'left', position: 1 } },
            ],
        }],
    });

    assert.deepEqual(report.catalog.map(pin => pin.value), ['1', '2', '3', '7', '0']);
});
