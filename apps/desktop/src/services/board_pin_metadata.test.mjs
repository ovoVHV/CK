import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./board_manager.ts', import.meta.url), 'utf8');
const pinTokenSource = await readFile(new URL('./pin_code_token.ts', import.meta.url), 'utf8');
const start = source.indexOf('type UnknownRecord');
const end = source.indexOf('export class BoardManager');
assert.ok(start >= 0 && end > start, 'pin normalizer source should be discoverable');

const isolatedSource = `${pinTokenSource}\n${source
    .slice(start, end)
    .replace('const normalizePins =', 'export const normalizePins =')}`;
const transpiled = ts.transpileModule(isolatedSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'board_pin_normalizer.ts',
    reportDiagnostics: true,
});
const errors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(errors, [], 'isolated pin normalizer should transpile');
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`;
const { normalizePins, normalizeUserBoard } = await import(moduleUrl);

const pinTokenModuleOutput = ts.transpileModule(pinTokenSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
}).outputText;
const pinTokenModuleUrl = `data:text/javascript;base64,${Buffer.from(pinTokenModuleOutput).toString('base64')}`;
const preflightSource = (await readFile(new URL('./pin_preflight.ts', import.meta.url), 'utf8'))
    .replace("'./pin_code_token'", `'${pinTokenModuleUrl}'`);
const preflightTranspiled = ts.transpileModule(preflightSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'pin_preflight.ts',
    reportDiagnostics: true,
});
const preflightErrors = (preflightTranspiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(preflightErrors, [], 'pin preflight should transpile');
const { analyzePinPreflight } = await import(
    `data:text/javascript;base64,${Buffer.from(preflightTranspiled.outputText).toString('base64')}`
);
const builtinBoards = JSON.parse(await readFile(
    new URL('../config/boards.json', import.meta.url),
    'utf8',
));

test('custom board normalization preserves precise pin metadata', () => {
    const [pin] = normalizePins([{
        label: 'D12 / USB D-',
        value: '12',
        aliases: ['GPIO12', 'IO12'],
        capabilities: ['digital', 'usb'],
        risks: [{
            code: 'usb-jtag-active',
            severity: 'warning',
            title: 'USB/JTAG is using this pin',
            detail: 'Choose another output while integrated USB/JTAG is enabled.',
            roles: ['digital-output'],
            when: { options: { JTAGAdapter: ['builtin'] } },
        }],
        reserved_by: 'native-usb',
        sharing: 'exclusive',
        connector: { id: 'J1', side: 'left', position: 7.5 },
        source: 'publisher-declaration',
        evidence: [{
            kind: 'board-definition',
            reference: 'board.json#pins/6',
            locator: 'J1.7',
            sha256: 'a'.repeat(64),
        }],
    }]);

    assert.deepEqual(pin, {
        label: 'D12 / USB D-',
        value: '12',
        aliases: ['GPIO12', 'IO12'],
        capabilities: ['digital', 'usb'],
        risks: [{
            code: 'usb-jtag-active',
            severity: 'warning',
            title: 'USB/JTAG is using this pin',
            detail: 'Choose another output while integrated USB/JTAG is enabled.',
            roles: ['digital-output'],
            when: { options: { JTAGAdapter: ['builtin'] } },
        }],
        reserved_by: 'native-usb',
        sharing: 'exclusive',
        connector: { id: 'J1', side: 'left', position: 7.5 },
        source: 'publisher-declaration',
        evidence: [{
            kind: 'board-definition',
            reference: 'board.json#pins/6',
            locator: 'J1.7',
            sha256: 'a'.repeat(64),
        }],
    });
});

test('legacy label/value and tuple pins remain loadable', () => {
    assert.deepEqual(normalizePins([
        { label: 'D13', value: '13' },
        ['A0', 'A0'],
    ]), [
        {
            label: 'D13',
            value: '13',
            aliases: undefined,
            capabilities: undefined,
            risks: undefined,
            reserved_by: undefined,
            sharing: undefined,
            connector: undefined,
            source: undefined,
            evidence: undefined,
        },
        { label: 'A0', value: 'A0' },
    ]);
});

test('reservation arrays and the camelCase compatibility alias are preserved and deduplicated', () => {
    const [snakeCasePin, camelCasePin] = normalizePins([
        {
            label: 'D12',
            value: '12',
            reserved_by: ['native-usb', ' native-usb ', 'integrated-jtag'],
        },
        {
            label: 'D13',
            value: '13',
            reservedBy: ['onboard-display', 'onboard-radio'],
        },
    ]);

    assert.deepEqual(snakeCasePin.reserved_by, ['native-usb', 'integrated-jtag']);
    assert.deepEqual(camelCasePin.reserved_by, ['onboard-display', 'onboard-radio']);
});

test('normalization drops pin values that are not one safe C/C++ token', () => {
    assert.deepEqual(normalizePins([
        { label: 'Injected', value: '13); injected(); //' },
        { label: 'Expression', value: 'PIN+1' },
        { label: 'Negative', value: '-1' },
        { label: 'Ambiguous octal', value: '013' },
        { label: 'Safe decimal', value: '13' },
        { label: 'Safe identifier', value: 'LED_BUILTIN' },
        ['Safe tuple', 12],
    ]), [
        {
            label: 'Safe decimal',
            value: '13',
            aliases: undefined,
            capabilities: undefined,
            risks: undefined,
            reserved_by: undefined,
            sharing: undefined,
            connector: undefined,
            source: undefined,
            evidence: undefined,
        },
        {
            label: 'Safe identifier',
            value: 'LED_BUILTIN',
            aliases: undefined,
            capabilities: undefined,
            risks: undefined,
            reserved_by: undefined,
            sharing: undefined,
            connector: undefined,
            source: undefined,
            evidence: undefined,
        },
        { label: 'Safe tuple', value: '12' },
    ]);
});

test('normalized third-party metadata reaches pin preflight without losing facts', () => {
    const rawPin = {
        displayName: 'D12 / USB D-',
        pin: '12',
        aliases: ['GPIO12', 'IO12'],
        capabilities: ['digital', 'usb'],
        risks: [{
            code: 'usb-jtag-active',
            severity: 'warning',
            title: 'USB/JTAG is using this pin',
            detail: 'Choose another output while integrated USB/JTAG is enabled.',
            roles: ['digital-output'],
            when: { options: { JTAGAdapter: ['builtin'] } },
        }],
        reservedBy: ['native-usb', 'integrated-jtag'],
        sharing: 'exclusive',
        connector: { id: 'J1', side: 'left', position: 7.5 },
        source: 'publisher-declaration',
        evidence: [{
            kind: 'board-definition',
            reference: 'board.json#pins/6',
            locator: 'J1.7',
            sha256: 'a'.repeat(64),
        }],
    };
    const board = normalizeUserBoard({
        id: 'vendor-board-package',
        name: 'Vendor Board',
        version: '1.0.0',
        fqbn_base: 'vendor:arch:board',
        pins: [rawPin],
    });
    const pins = board.pins;
    const report = analyzePinPreflight({
        workspace: { getAllBlocks: () => [] },
        boardFqbn: 'vendor:arch:board:USBMode=builtin',
        boardPackageId: 'vendor-board-package',
        boardOptions: { JTAGAdapter: 'builtin' },
        officialBoards: [{
            name: board.name,
            fqbn: board.fqbn,
            packageId: board.id,
            isCustom: board.is_custom,
            pinEvidenceLevel: 'publisher',
            pins,
        }],
    });

    assert.equal(report.status, 'ready');
    assert.equal(report.catalog.length, 1);
    assert.deepEqual(report.catalog[0], {
        ...pins[0],
        aliases: ['GPIO12', 'IO12'],
        capabilities: ['digital', 'usb'],
        risks: pins[0].risks,
        activeRisks: pins[0].risks,
        reservedBy: ['native-usb', 'integrated-jtag'],
        sharing: 'exclusive',
        usages: [],
        evidenceLevel: 'publisher',
    });
});

test('built-in board pins declare digital capability evidence for the preflight map', () => {
    assert.ok(builtinBoards.length > 0);
    for (const board of builtinBoards) {
        assert.ok(board.pins.length > 0, `${board.fqbn} must have pins`);
        for (const pin of board.pins) {
            assert.ok(pin.capabilities.includes('digital'), `${board.fqbn} ${pin.value} lacks digital`);
            assert.ok(pin.capabilities.includes('digital-input'), `${board.fqbn} ${pin.value} lacks digital-input`);
            if (!/input[ -]?only/i.test(pin.label)) {
                assert.ok(pin.capabilities.includes('digital-output'), `${board.fqbn} ${pin.value} lacks digital-output`);
            }
        }
    }
});

test('Duemilanove TX no longer produces false unknown capability notices', () => {
    const board = builtinBoards.find(item => item.fqbn === 'arduino:avr:diecimila');
    const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '1' : null };
    const block = type => ({
        id: type,
        type,
        isInFlyout: false,
        getInputTargetBlock: name => name === 'PIN' ? number : null,
    });
    const report = analyzePinPreflight({
        workspace: { getAllBlocks: () => [block('set_pin_mode'), block('io_digital_write')] },
        boardFqbn: board.fqbn,
        officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
    });
    assert.equal(report.warnings.some(issue => issue.code === 'pin-capability-mismatch'), false);
    assert.equal(report.notices.some(issue => issue.code === 'pin-capability-unknown'), false);
    assert.equal(report.warnings.some(issue => issue.code === 'pin-risk'), true);
    assert.equal(report.usages.every(usage => usage.resolution === 'known'), true);
});

test('every built-in board resolves a declared digital output pin without capability notices', () => {
    for (const board of builtinBoards) {
        const outputPin = board.pins.find(pin => pin.capabilities.includes('digital-output'));
        assert.ok(outputPin, `${board.fqbn} must expose an output-capable pin`);
        const number = {
            type: 'math_number',
            getFieldValue: name => name === 'NUM' ? outputPin.value : null,
        };
        const report = analyzePinPreflight({
            workspace: {
                getAllBlocks: () => [{
                    id: `${board.fqbn}:digital-output`,
                    type: 'io_digital_write',
                    isInFlyout: false,
                    getInputTargetBlock: name => name === 'PIN' ? number : null,
                }],
            },
            boardFqbn: board.fqbn,
            officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
        });
        assert.equal(
            report.issues.some(issue => issue.code === 'pin-capability-unknown' || issue.code === 'pin-capability-mismatch'),
            false,
            `${board.fqbn} ${outputPin.value} should satisfy digital-output`,
        );
    }
});

test('UART0 upload risks are declared for every built-in serial upload target', () => {
    const expected = new Map([
        ['arduino:avr:uno', ['0', '1']],
        ['arduino:avr:diecimila', ['0', '1']],
        ['arduino:avr:nano', ['0', '1']],
        ['arduino:avr:mega', ['0', '1']],
        ['esp32:esp32:esp32', ['1', '3']],
        ['esp32:esp32:esp32c3', ['20', '21']],
        ['esp32:esp32:esp32c5', ['11', '12']],
        ['esp32:esp32:esp32c6', ['16', '17']],
        ['esp32:esp32:esp32s2', ['43', '44']],
        ['esp32:esp32:esp32s3', ['43', '44']],
    ]);
    for (const [fqbn, values] of expected) {
        const board = builtinBoards.find(item => item.fqbn === fqbn);
        assert.ok(board, `${fqbn} must be present`);
        for (const value of values) {
            const pin = board.pins.find(item => item.value === value);
            assert.ok(pin, `${fqbn} must expose UART0 pin ${value}`);
            assert.ok(pin.risks?.some(risk => /serial0-.*upload-conflict/.test(risk.code)), `${fqbn} ${value} must declare upload risk`);
        }
    }
});

test('S2/S3 UART0 upload risk follows the selected upload transport', () => {
    for (const fqbn of ['esp32:esp32:esp32s2', 'esp32:esp32:esp32s3']) {
        const board = builtinBoards.find(item => item.fqbn === fqbn);
        const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '43' : null };
        const block = {
            id: `${fqbn}:uart0-risk`,
            type: 'io_digital_write',
            isInFlyout: false,
            getInputTargetBlock: name => name === 'PIN' ? number : null,
        };
        const base = {
            workspace: { getAllBlocks: () => [block] },
            boardFqbn: fqbn,
            officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
        };
        assert.equal(
            analyzePinPreflight({ ...base, boardOptions: { UploadMode: 'default' } }).warnings.some(issue => issue.code === 'pin-risk'),
            true,
            `${fqbn} default UART0 upload should warn`,
        );
        assert.equal(
            analyzePinPreflight({ ...base, boardOptions: { UploadMode: 'cdc' } }).warnings.some(issue => issue.code === 'pin-risk'),
            false,
            `${fqbn} USB CDC upload should not warn about UART0 upload`,
        );
    }
});

test('S3 OPI Flash and PSRAM modes expose warnings without blocking output', () => {
    const board = builtinBoards.find(item => item.fqbn === 'esp32:esp32:esp32s3');
    const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '35' : null };
    const block = {
        id: 's3-opi-risk',
        type: 'io_digital_write',
        isInFlyout: false,
        getInputTargetBlock: name => name === 'PIN' ? number : null,
    };
    const base = {
        workspace: { getAllBlocks: () => [block] },
        boardFqbn: board.fqbn,
        officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
    };
    const flash = analyzePinPreflight({ ...base, boardOptions: { FlashMode: 'opi', PSRAM: 'disabled' } });
    const psram = analyzePinPreflight({ ...base, boardOptions: { FlashMode: 'dio', PSRAM: 'opi' } });
    assert.equal(flash.canCompile, true);
    assert.equal(psram.canCompile, true);
    assert.equal(flash.warnings.some(issue => issue.code === 'pin-risk'), true);
    assert.equal(psram.warnings.some(issue => issue.code === 'pin-risk'), true);
});

test('classic ESP32 ADC2 risk is active only when a WiFi block is present', () => {
    const board = builtinBoards.find(item => item.fqbn === 'esp32:esp32:esp32');
    const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '4' : null };
    const block = {
        id: 'analog-read',
        type: 'io_analog_read',
        isInFlyout: false,
        getInputTargetBlock: name => name === 'PIN' ? number : null,
    };
    const analyze = blocks => analyzePinPreflight({
        workspace: { getAllBlocks: () => blocks },
        boardFqbn: board.fqbn,
        officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
    });
    assert.equal(analyze([block]).issues.some(issue => issue.code === 'pin-risk'), false);
    assert.equal(analyze([block, { id: 'wifi', type: 'wifi_connect', isInFlyout: false }]).warnings.some(issue => issue.code === 'pin-risk'), true);
});

test('classic ESP32 ADC2 risk also follows a WiFi source override', () => {
    const board = builtinBoards.find(item => item.fqbn === 'esp32:esp32:esp32');
    const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '4' : null };
    const block = {
        id: 'analog-read-source',
        type: 'io_analog_read',
        isInFlyout: false,
        getInputTargetBlock: name => name === 'PIN' ? number : null,
    };
    const report = analyzePinPreflight({
        workspace: { getAllBlocks: () => [block] },
        boardFqbn: board.fqbn,
        code: '#include <WiFi.h>\nvoid setup() {}',
        officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
    });
    assert.equal(report.warnings.some(issue => issue.code === 'pin-risk'), true);
});

test('USB risks respect the active board menu and stay warnings', () => {
    const board = builtinBoards.find(item => item.fqbn === 'esp32:esp32:esp32c6');
    const number = { type: 'math_number', getFieldValue: name => name === 'NUM' ? '12' : null };
    const block = {
        id: 'usb-pin',
        type: 'io_digital_write',
        isInFlyout: false,
        getInputTargetBlock: name => name === 'PIN' ? number : null,
    };
    const base = {
        workspace: { getAllBlocks: () => [block] },
        boardFqbn: board.fqbn,
        officialBoards: [{ ...board, pinEvidenceLevel: 'basic' }],
    };
    assert.equal(analyzePinPreflight({ ...base, boardOptions: { CDCOnBoot: 'default', JTAGAdapter: 'default' } }).warnings.some(issue => issue.code === 'pin-risk'), false);
    assert.equal(analyzePinPreflight({ ...base, boardOptions: { CDCOnBoot: 'cdc', JTAGAdapter: 'default' } }).warnings.some(issue => issue.code === 'pin-risk'), true);
});
