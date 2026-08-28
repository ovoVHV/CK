import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./serial_trigger_recorder.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
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

const recorderModule = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
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

test('normalizes labels and clamps recording windows to the safe limit', () => {
    assert.deepEqual(normalizeSerialTriggerConfig({
        channel: '  温度  ',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: -100,
        postWindowMs: 99_000,
    }), {
        channel: '温度',
        comparator: 'gt',
        threshold: 60,
        preWindowMs: 0,
        postWindowMs: 30_000,
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
