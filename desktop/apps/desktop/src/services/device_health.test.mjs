import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./device_health.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'device_health.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'device_health.ts should transpile without syntax errors');

const health = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const fallback = {
    requestId: 7,
    fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi',
    port: 'COM8',
};

test('P0 support is restricted to resolved ESP32 core targets', () => {
    assert.equal(health.isEsp32DeviceHealthTarget('esp32:esp32:esp32s3'), true);
    assert.equal(health.isEsp32DeviceHealthTarget('ESP32:ESP32:esp32c5:FlashSize=8M'), true);
    assert.equal(health.isEsp32DeviceHealthTarget('arduino:avr:uno'), false);
    assert.equal(health.isEsp32DeviceHealthTarget('my-custom-esp32-board'), false);
});

test('publishes only to the exact request, port, and effective FQBN', () => {
    assert.equal(health.isSameDeviceHealthTarget(fallback, { ...fallback }), true);
    assert.equal(health.isSameDeviceHealthTarget(fallback, { ...fallback, requestId: 8 }), false);
    assert.equal(health.isSameDeviceHealthTarget(fallback, { ...fallback, port: 'COM9' }), false);
    assert.equal(health.isSameDeviceHealthTarget(fallback, {
        ...fallback,
        fqbn: 'esp32:esp32:esp32s3:FlashSize=8M,PSRAM=opi',
    }), false);
});

test('normalizes structured camelCase facts without inventing missing hardware', () => {
    const report = health.normalizeDeviceHealthReport({
        schemaVersion: 1,
        requestId: 7,
        outcome: 'complete',
        observedAt: '2026-07-12T10:00:00.000Z',
        durationMs: 812,
        target: {
            requestedFqbn: fallback.fqbn,
            resolvedFqbn: fallback.fqbn,
            buildMcu: 'esp32s3',
            configuredFlashBytes: 16 * 1024 * 1024,
            partitionScheme: 'app3M_fat9M_16MB',
            psramMode: 'opi',
        },
        device: {
            deviceId: 'a'.repeat(64),
            identitySource: 'chip-mac',
            chip: 'ESP32-S3',
            revision: 'v0.2',
            mac: '10:20:30:a1:b2:c3',
            macSuffix: 'A1B2C3',
            portBefore: 'COM8',
            portAfter: 'COM8',
            usb: { vid: 0x303a, pid: 0x1001, serialId: null },
        },
        memory: { flashBytes: 16 * 1024 * 1024, psramBytes: null },
        checks: [{ id: 'flash', state: 'pass', certainty: 'certain', title: 'Flash 匹配' }],
    }, fallback);

    assert.ok(report);
    assert.equal(report.memory.flashBytes, 16 * 1024 * 1024);
    assert.equal(report.memory.psramBytes, null, 'missing PSRAM must remain unknown');
    assert.equal(report.device.mac, '10:20:30:A1:B2:C3');
    assert.equal(report.device.macSuffix, 'A1B2C3');
    assert.equal(report.device.usb.vid, 0x303a);
    assert.equal(report.checks[0].state, 'pass');
});

test('accepts Rust snake_case JSON and bounds unsafe or unsupported fields', () => {
    const report = health.normalizeDeviceHealthReport(JSON.stringify({
        schema_version: 1,
        request_id: 7,
        outcome: 'partial',
        observed_at: '2026-07-12T10:00:00.000Z',
        duration_ms: 1200,
        target: {
            requested_fqbn: fallback.fqbn,
            resolved_fqbn: fallback.fqbn,
            build_mcu: 'esp32s3',
            configured_flash_bytes: 16 * 1024 * 1024,
            partition_scheme: 'default',
            psram_mode: 'disabled',
        },
        device: {
            device_id: 'b'.repeat(64),
            identity_source: 'chip-mac',
            chip: 'ESP32-S3',
            mac: '1020300012ab',
            mac_suffix: '0012ab',
            port_before: 'COM8',
            port_after: null,
            usb: null,
        },
        memory: { flash_bytes: 16 * 1024 * 1024, psram_bytes: 8 * 1024 * 1024 },
        checks: [
            { id: 'psram', state: 'warn', certainty: 'certain', title: '配置未启用 PSRAM', action: 'open_board_config' },
            { id: 'untrusted', state: 'mystery', certainty: 'guess', title: '未知项', action: 'run_arbitrary_command' },
        ],
    }), fallback);

    assert.ok(report);
    assert.equal(report.device.portBefore, 'COM8');
    assert.equal(report.device.mac, '10:20:30:00:12:AB');
    assert.equal(report.checks[0].state, 'warning');
    assert.equal(report.checks[1].state, 'unknown');
    assert.equal(report.checks[1].certainty, 'hint');
    assert.equal(report.checks[1].action, undefined);
});

test('derives a deterministic, severity-sorted presentation', () => {
    const report = health.normalizeDeviceHealthReport({
        schemaVersion: 1,
        requestId: 7,
        outcome: 'partial',
        observedAt: '2026-07-12T10:00:00.000Z',
        durationMs: 100,
        target: { requestedFqbn: fallback.fqbn, resolvedFqbn: fallback.fqbn },
        device: { identitySource: 'session-port', portBefore: 'COM8' },
        memory: { flashBytes: 16 * 1024 * 1024 },
        checks: [
            { id: 'ok', state: 'pass', certainty: 'certain', title: '握手成功' },
            { id: 'warn', state: 'warning', certainty: 'certain', title: '只使用部分 Flash' },
            { id: 'unknown', state: 'unknown', certainty: 'hint', title: 'PSRAM 未报告' },
        ],
    }, fallback);
    const presentation = health.deriveDeviceHealthPresentation(report);

    assert.equal(presentation.status, 'attention');
    assert.deepEqual(presentation.orderedChecks.map(check => check.id), ['warn', 'unknown', 'ok']);
    assert.equal(presentation.flashLabel, '16 MB');
    assert.equal(presentation.psramLabel, '未明确报告');
    assert.match(presentation.explanation, /未报告的硬件不会被推断为不存在/);
});

test('rejects responses that omit or contradict the v1 request identity', () => {
    const base = {
        schemaVersion: 1,
        requestId: 7,
        outcome: 'complete',
        target: { requestedFqbn: fallback.fqbn, resolvedFqbn: fallback.fqbn },
        device: { identitySource: 'session-port', portBefore: fallback.port },
        memory: {},
        checks: [{ id: 'handshake', state: 'pass', certainty: 'certain', title: '握手成功' }],
    };
    assert.equal(health.normalizeDeviceHealthReport({ ...base, schemaVersion: undefined }, fallback), null);
    assert.equal(health.normalizeDeviceHealthReport({ ...base, requestId: 8 }, fallback), null);
    assert.equal(health.normalizeDeviceHealthReport({
        ...base,
        target: { ...base.target, requestedFqbn: 'esp32:esp32:esp32s3' },
    }, fallback), null);
    assert.equal(health.normalizeDeviceHealthReport({
        ...base,
        device: { ...base.device, portBefore: 'COM9' },
    }, fallback), null);
    assert.equal(health.normalizeDeviceHealthReport({ ...base, checks: [] }, fallback), null);
});

test('keeps local device MAC separate while redacting it from check text', () => {
    const report = health.normalizeDeviceHealthReport({
        schemaVersion: 1,
        requestId: 7,
        outcome: 'complete',
        target: { requestedFqbn: fallback.fqbn, resolvedFqbn: fallback.fqbn },
        device: {
            identitySource: 'chip-mac',
            portBefore: fallback.port,
            mac: 'AA:BB:CC:DD:EE:FF',
            macSuffix: 'AA:BB:CC:DD:EE:FF',
        },
        memory: {},
        checks: [{
            id: 'unknown',
            state: 'unknown',
            certainty: 'hint',
            title: 'MAC AA:BB:CC:DD:EE:FF 未明确',
            evidence: 'BASE MAC: AABBCCDDEEFF',
        }],
    }, fallback);
    assert.ok(report);
    assert.equal(report.device.mac, 'AA:BB:CC:DD:EE:FF');
    assert.equal(report.device.macSuffix, null);
    assert.doesNotMatch(report.checks[0].title, /AA:BB:CC:DD:EE:FF/i);
    assert.doesNotMatch(report.checks[0].evidence, /AABBCCDDEEFF/i);
    assert.equal(health.deriveDeviceHealthPresentation(report).status, 'attention');

    const failure = health.createFailedDeviceHealthReport(
        fallback,
        new Error('probe failed for 11:22:33:44:55:66'),
    );
    assert.doesNotMatch(failure.checks[0].evidence, /11:22:33:44:55:66/i);
});

test('turns invocation rejection into a bounded, actionable failure report', () => {
    const report = health.createFailedDeviceHealthReport(fallback, new Error('port busy'));
    assert.equal(report.outcome, 'failed');
    assert.equal(report.requestId, 7);
    assert.equal(report.device.portBefore, 'COM8');
    assert.equal(report.checks[0].state, 'error');
    assert.equal(report.checks[0].action, 'show_boot_help');
    assert.equal(health.deriveDeviceHealthPresentation(report).status, 'problem');
});
