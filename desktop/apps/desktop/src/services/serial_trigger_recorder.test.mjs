import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./serial_trigger_recorder.ts', import.meta.url);
const identitySourcePath = new URL('./serial_field_identity.ts', import.meta.url);
const csvSourcePath = new URL('./serial_csv.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const identitySource = await readFile(identitySourcePath, 'utf8');
const csvSource = await readFile(csvSourcePath, 'utf8');
const identityTranspiled = ts.transpileModule(identitySource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'serial_field_identity.ts',
    reportDiagnostics: true,
});
const csvTranspiled = ts.transpileModule(csvSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'serial_csv.ts',
    reportDiagnostics: true,
});
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'serial_trigger_recorder.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'serial_trigger_recorder.ts should transpile without syntax errors');
assert.deepEqual(
    (identityTranspiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
    'serial_field_identity.ts should transpile without syntax errors',
);
assert.deepEqual(
    (csvTranspiled.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    ),
    [],
    'serial_csv.ts should transpile without syntax errors',
);

const identityModuleUrl = `data:text/javascript;base64,${Buffer.from(identityTranspiled.outputText).toString('base64')}`;
const recorderOutput = transpiled.outputText.replaceAll('./serial_field_identity', identityModuleUrl);
const csvModuleUrl = `data:text/javascript;base64,${Buffer.from(csvTranspiled.outputText).toString('base64')}`;
const recorderOutputWithCsv = recorderOutput.replaceAll('./serial_csv', csvModuleUrl);

const recorderModule = await import(
    `data:text/javascript;base64,${Buffer.from(recorderOutputWithCsv).toString('base64')}`
);

const {
    SerialTriggerRecorder,
    buildSerialTriggerCsv,
    normalizeSerialTriggerConfig,
    serialTriggerMatches,
} = recorderModule;

const record = (timestamp, sequence, values) => ({ timestamp, sequence, values, format: 'json' });

test('supports all deterministic numeric comparators', () => {
    assert.equal(serialTriggerMatches(10, 'gt', 9), true);
    assert.equal(serialTriggerMatches(10, 'gte', 10), true);
    assert.equal(serialTriggerMatches(10, 'lt', 11), true);
    assert.equal(serialTriggerMatches(10, 'lte', 10), true);
    assert.equal(serialTriggerMatches(10, 'eq', 10), true);
    assert.equal(serialTriggerMatches(10, 'neq', 11), true);
    assert.equal(serialTriggerMatches(Number.NaN, 'gt', 0), false);
});

test('normalizes legacy channel input and clamps recording windows to the safe limit', () => {
    assert.deepEqual(normalizeSerialTriggerConfig({
        channel: '  温度  ',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: -100,
        postWindowMs: 99_000,
    }), {
        channelId: 'serial.source.6e29-5ea6',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 0,
        postWindowMs: 30_000,
        legacyChannel: '温度',
    });
});

test('uses stable channelId without retaining a presentation label', () => {
    assert.deepEqual(normalizeSerialTriggerConfig({
        channelId: 'serial.generated.1',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 100,
        postWindowMs: 200,
    }), {
        channelId: 'serial.generated.1',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 100,
        postWindowMs: 200,
    });
});

test('keeps the time-bounded pre-window and freezes after the post-window', () => {
    const recorder = new SerialTriggerRecorder(20);
    recorder.arm({
        channel: '温度',
        comparator: 'gte',
        threshold: 60,
        preWindowMs: 2_000,
        postWindowMs: 1_000,
    });

    recorder.ingest(record(0, 0, { 温度: 20 }));
    recorder.ingest(record(1_000, 1, { 温度: 30 }));
    recorder.ingest(record(2_500, 2, { 温度: 40 }));
    assert.equal(recorder.ingest(record(3_000, 3, { 温度: 60, 湿度: 50 })), 'triggered');
    assert.equal(recorder.getSummary().state, 'capturing');
    recorder.ingest(record(3_500, 4, { 湿度: 51 }));
    assert.equal(recorder.ingest(record(4_000, 5, { 温度: 58 })), 'frozen');

    const capture = recorder.getCapture();
    assert.ok(capture);
    assert.deepEqual(capture.records.map(item => item.sequence), [1, 2, 3, 4, 5]);
    assert.equal(capture.triggerIndex, 2);
    assert.equal(capture.triggerValue, 60);
    assert.equal(capture.freezeReason, 'window_complete');
    assert.equal(capture.truncated, false);
});

test('records every structured row after trigger even when the watched channel is absent', () => {
    const recorder = new SerialTriggerRecorder(10);
    recorder.arm({
        channel: '压力',
        comparator: 'gt',
        threshold: 100,
        preWindowMs: 100,
        postWindowMs: 100,
    });
    recorder.ingest(record(0, 0, { 压力: 90 }));
    recorder.ingest(record(10, 1, { 压力: 101 }));
    recorder.ingest(record(50, 2, { 温度: 25 }));
    recorder.ingest(record(110, 3, { 压力: 99 }));

    const capture = recorder.getCapture();
    assert.ok(capture);
    assert.deepEqual(capture.records.map(item => item.sequence), [0, 1, 2, 3]);
});

test('freezes at the fixed record limit instead of allowing unbounded memory use', () => {
    const recorder = new SerialTriggerRecorder(4);
    recorder.arm({
        channel: '值',
        comparator: 'gt',
        threshold: 0,
        preWindowMs: 5_000,
        postWindowMs: 30_000,
    });
    assert.equal(recorder.ingest(record(0, 0, { 值: 1 })), 'triggered');
    recorder.ingest(record(1, 1, { 值: 1 }));
    recorder.ingest(record(2, 2, { 值: 1 }));
    assert.equal(recorder.ingest(record(3, 3, { 值: 1 })), 'frozen');

    const capture = recorder.getCapture();
    assert.ok(capture);
    assert.equal(capture.records.length, 4);
    assert.equal(capture.freezeReason, 'record_limit');
    assert.equal(capture.truncated, true);
});

test('supports manually freezing an in-progress capture and resetting it', () => {
    const recorder = new SerialTriggerRecorder();
    recorder.arm({
        channel: '温度',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 5_000,
        postWindowMs: 5_000,
    });
    recorder.ingest(record(100, 1, { 温度: 61 }));
    const frozen = recorder.freeze();
    assert.equal(frozen.state, 'frozen');
    assert.equal(frozen.freezeReason, 'manual');
    assert.equal(recorder.getCapture().records.length, 1);
    assert.equal(recorder.reset().state, 'idle');
    assert.equal(recorder.getCapture(), null);
});

test('exports trigger metadata, connection context and captured channels', () => {
    const recorder = new SerialTriggerRecorder();
    recorder.arm({
        channel: '温度,室内',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 1_000,
        postWindowMs: 0,
    });
    recorder.ingest(record(1_000, 7, { '温度,室内': 61, 湿度: 50 }));
    const csv = buildSerialTriggerCsv(recorder.getCapture(), {
        port: 'COM5',
        baudRate: 115200,
        droppedRecords: 3,
    });
    const lines = csv.split('\r\n');
    const headerIndex = lines.findIndex(line => line.includes('相对触发时间(ms)'));

    assert.match(csv, /"触发规则","温度,室内 > 60"/);
    assert.match(csv, /"实际触发值","61"/);
    assert.match(csv, /"触发前窗口\(ms\)","1000"/);
    assert.match(csv, /"达到录制上限并截断","否"/);
    assert.match(csv, /"录制期间输入积压丢弃\(条\)","3"/);
    assert.match(csv, /"串口端口","COM5"/);
    assert.match(csv, /"波特率","115200"/);
    assert.ok(headerIndex > 0);
    assert.match(lines[headerIndex], /"温度,室内"/);
    assert.match(lines[headerIndex + 1], /,0,7,"是",61,50$/);
});

test('locale-specific labels cannot change trigger binding or captured channel identity', () => {
    const recorder = new SerialTriggerRecorder();
    const channelId = 'serial.generated.1';
    recorder.arm({
        channelId,
        comparator: 'gte',
        threshold: 7,
        preWindowMs: 0,
        postWindowMs: 0,
    });
    recorder.ingest(record(2_000, 9, { [channelId]: 7 }));

    const capture = recorder.getCapture();
    assert.ok(capture);
    const before = structuredClone(capture);
    const zhCsv = buildSerialTriggerCsv(capture, {
        channelLabels: { [channelId]: '数据 1' },
    });
    const enCsv = buildSerialTriggerCsv(capture, {
        channelLabels: { [channelId]: 'Data 1' },
    });

    assert.match(zhCsv, /"触发规则","数据 1 ≥ 7"/);
    assert.match(enCsv, /"触发规则","Data 1 ≥ 7"/);
    assert.match(zhCsv, /"触发点","数据 1"/);
    assert.match(enCsv, /"触发点","Data 1"/);
    assert.match(zhCsv, /,0,9,"是",7$/);
    assert.match(enCsv, /,0,9,"是",7$/);
    assert.equal(capture.config.channelId, channelId);
    assert.deepEqual(capture, before, 'export presentation must not rewrite capture identity');
});

test('stable CSV headers remain locale-independent while localized headers are opt-in', () => {
    const recorder = new SerialTriggerRecorder();
    const channelId = 'serial.generated.1';
    recorder.arm({ channelId, comparator: 'gte', threshold: 7, preWindowMs: 0, postWindowMs: 0 });
    recorder.ingest(record(2_000, 9, { [channelId]: 7 }));
    const capture = recorder.getCapture();
    assert.ok(capture);
    const stable = buildSerialTriggerCsv(capture, { headerMode: 'stable', channelLabels: { [channelId]: '数据 1' } });
    const localized = buildSerialTriggerCsv(capture, { headerMode: 'localized', channelLabels: { [channelId]: 'Data 1' }, localizedLabels: {
        timestamp: 'Time', triggerTime: 'Trigger time', sampleIndex: 'Sample index', relativeTriggerTime: 'Relative trigger time (ms)', triggerPoint: 'Trigger point', triggerRule: 'Trigger rule', actualTriggerValue: 'Actual trigger value', preWindow: 'Pre-window (ms)', postWindow: 'Post-window (ms)', windowClock: 'Window clock', freezeReason: 'Freeze reason', truncated: 'Truncated', droppedRecords: 'Dropped records', serialPort: 'Serial port', baudRate: 'Baud rate', captureTitle: 'CK serial trigger capture', receivedAt: 'CK received time', yes: 'true', no: 'false', notRecorded: 'not_recorded', freezeReasons: { window_complete: 'window_complete', record_limit: 'record_limit', manual: 'manual' },
    } });
    assert.match(stable, /"trigger_rule","serial\.generated\.1/);
    assert.match(stable, /"timestamp","relative_trigger_time_ms","sample_index","trigger_point","serial\.generated\.1"/);
    assert.match(localized, /"Trigger rule","Data 1/);
    assert.match(localized, /"Time","Relative trigger time \(ms\)","Sample index","Trigger point","Data 1"/);
    assert.equal(capture.config.channelId, channelId);
});

test('legacy generated-label trigger reads an old in-memory record through a stable id adapter', () => {
    const recorder = new SerialTriggerRecorder();
    recorder.arm({
        channel: '数据 1',
        comparator: 'eq',
        threshold: 42,
        preWindowMs: 0,
        postWindowMs: 0,
    });
    assert.equal(recorder.ingest(record(0, 0, { '数据 1': 42 })), 'frozen');
    assert.equal(recorder.getCapture().config.channelId, 'serial.generated.1');
});

test('legacy named-channel config triggers a new stable-id record', () => {
    const recorder = new SerialTriggerRecorder();
    const channelId = 'serial.source.6e29-5ea6';
    recorder.arm({
        channel: '温度',
        comparator: 'gte',
        threshold: 24,
        preWindowMs: 0,
        postWindowMs: 0,
    });
    assert.equal(recorder.ingest(record(0, 0, { [channelId]: 24 })), 'frozen');
    assert.equal(recorder.getCapture().config.channelId, channelId);
});

test('new channelId input rejects presentation text', () => {
    assert.throws(() => normalizeSerialTriggerConfig({
        channelId: '数据 1',
        comparator: 'gt',
        threshold: 0,
        preWindowMs: 0,
        postWindowMs: 0,
    }), /stable serial field identity/);
});
