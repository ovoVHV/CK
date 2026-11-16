import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_trace.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_trace.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'block_trace.ts should transpile without syntax errors');

const { BlockTraceAggregator, selectChronologicalTraceWindow } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const tracked = [
    { blockId: 'a', label: '开始' },
    { blockId: 'b', label: '读取温度' },
    { blockId: 'c', label: '打开风扇' },
];

test('firmware omissions remain visible and a new run clears old coverage', () => {
    const aggregator = new BlockTraceAggregator(tracked, {omittedTrackedBlockCount: 6});
    aggregator.ingest({blockId:'a',deviceMicros:42,firstHit:true});
    assert.equal(aggregator.snapshot().omittedTrackedBlockCount, 6);
    aggregator.resetRun();
    const snapshot = aggregator.snapshot();
    assert.equal(snapshot.runNumber, 2);
    assert.equal(snapshot.omittedTrackedBlockCount, 6);
    assert.equal(snapshot.coveredBlockCount, 0);
    assert.equal(snapshot.totalSampledHits, 0);
    assert.equal(snapshot.recent.length, 0);
});

test('aggregates sampled hits, coverage and device-side transition time', () => {
    const aggregator = new BlockTraceAggregator(tracked, { maxEventsPerSecond: 10 });
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 100, firstHit: true, receivedAtMs: 10 }), true);
    assert.equal(aggregator.ingest({ blockId: 'b', deviceMicros: 2600, firstHit: true, receivedAtMs: 20 }), true);
    assert.equal(aggregator.ingest({ blockId: 'b', deviceMicros: 3100, firstHit: false, receivedAtMs: 30 }), true);

    const snapshot = aggregator.snapshot(40);
    assert.equal(snapshot.coveredBlockCount, 2);
    assert.ok(Math.abs(snapshot.coveragePercent - (200 / 3)) < 1e-9);
    assert.equal(snapshot.totalSampledHits, 3);
    const b = snapshot.stats.find(stat => stat.blockId === 'b');
    assert.equal(b.sampledHits, 2);
    assert.equal(b.lastTransitionUs, 500);
    assert.equal(b.firstHitFrameSeen, true);
    assert.deepEqual(snapshot.recent.map(item => item.transitionUs), [null, 2500, 500]);
    assert.deepEqual(snapshot.recent.map(item => item.sequenceNumber), [1, 2, 3]);
});

test('preserves A, B, C receive order from top to bottom with an explicit monotonic sequence', () => {
    const aggregator = new BlockTraceAggregator(tracked, { maxEventsPerSecond: 10 });
    aggregator.ingest({ blockId: 'a', deviceMicros: 100, firstHit: true, receivedAtMs: 10 });
    aggregator.ingest({ blockId: 'b', deviceMicros: 200, firstHit: true, receivedAtMs: 10 });
    aggregator.ingest({ blockId: 'c', deviceMicros: 300, firstHit: true, receivedAtMs: 10 });

    const recent = aggregator.snapshot().recent;
    assert.deepEqual(recent.map(item => item.blockId), ['a', 'b', 'c']);
    assert.deepEqual(recent.map(item => item.sequenceNumber), [1, 2, 3]);
    assert.deepEqual(recent.map(item => item.previousBlockId), [null, 'a', 'b']);
    assert.deepEqual(recent.map(item => item.transitionUs), [null, 100, 100]);
    assert.deepEqual(
        selectChronologicalTraceWindow(aggregator.snapshot(), 2).map(item => item.blockId),
        ['b', 'c'],
        'the panel window must stay oldest-to-newest instead of reversing newest first',
    );
});

test('handles the 32-bit micros rollover', () => {
    const aggregator = new BlockTraceAggregator(tracked);
    aggregator.ingest({ blockId: 'a', deviceMicros: 0xFFFFFFF0, firstHit: true, receivedAtMs: 10 });
    aggregator.ingest({ blockId: 'b', deviceMicros: 0x20, firstHit: true, receivedAtMs: 20 });
    assert.equal(aggregator.snapshot().recent[1].transitionUs, 48);
});

test('caps tracked blocks and recent history', () => {
    const aggregator = new BlockTraceAggregator(tracked, {
        maxTrackedBlocks: 2,
        recentLimit: 2,
    });
    aggregator.ingest({ blockId: 'a', deviceMicros: 1, firstHit: true, receivedAtMs: 1 });
    aggregator.ingest({ blockId: 'b', deviceMicros: 2, firstHit: true, receivedAtMs: 2 });
    aggregator.ingest({ blockId: 'a', deviceMicros: 3, firstHit: false, receivedAtMs: 3 });

    const snapshot = aggregator.snapshot();
    assert.equal(snapshot.trackedBlockCount, 2);
    assert.equal(snapshot.omittedTrackedBlockCount, 1);
    assert.deepEqual(snapshot.recent.map(item => item.blockId), ['b', 'a']);
});

test('rate limits incoming frames independently of firmware', () => {
    const aggregator = new BlockTraceAggregator(tracked, { maxEventsPerSecond: 2 });
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 1, firstHit: true, receivedAtMs: 100 }), true);
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 2, firstHit: false, receivedAtMs: 101 }), true);
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 3, firstHit: false, receivedAtMs: 102 }), false);
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 4, firstHit: false, receivedAtMs: 1100 }), true);
    assert.equal(aggregator.snapshot().droppedRateLimitedEvents, 1);
});

test('keeps bounded first-hit coverage evidence even when steady-state rate limit is full', () => {
    const aggregator = new BlockTraceAggregator(tracked, { maxEventsPerSecond: 1 });
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 1, firstHit: true, receivedAtMs: 100 }), true);
    assert.equal(aggregator.ingest({ blockId: 'b', deviceMicros: 2, firstHit: true, receivedAtMs: 101 }), true);
    assert.equal(aggregator.ingest({ blockId: 'c', deviceMicros: 3, firstHit: true, receivedAtMs: 102 }), true);
    assert.equal(aggregator.ingest({ blockId: 'a', deviceMicros: 4, firstHit: true, receivedAtMs: 103 }), false);

    const snapshot = aggregator.snapshot();
    assert.deepEqual(snapshot.recent.map(item => item.blockId), ['a', 'b', 'c']);
    assert.equal(snapshot.coveredBlockCount, 3);
    assert.equal(snapshot.droppedRateLimitedEvents, 1);
});

test('resetTiming makes the first accepted frame after reconnect the new segment start', () => {
    const aggregator = new BlockTraceAggregator(tracked, { maxEventsPerSecond: 1 });
    aggregator.ingest({ blockId: 'a', deviceMicros: 100, firstHit: true, receivedAtMs: 100 });
    aggregator.resetTiming();

    assert.equal(aggregator.ingest({ blockId: 'b', deviceMicros: 900, firstHit: false, receivedAtMs: 101 }), true);
    const latest = aggregator.snapshot().recent.at(-1);
    assert.equal(latest.sequenceNumber, 2);
    assert.equal(latest.blockId, 'b');
    assert.equal(latest.previousBlockId, null);
    assert.equal(latest.transitionUs, null);
});

test('drops unknown blocks and throttles UI publication to five times per second by default', () => {
    const aggregator = new BlockTraceAggregator(tracked);
    assert.equal(aggregator.ingest({ blockId: 'unknown', deviceMicros: 1, firstHit: true, receivedAtMs: 1 }), false);
    assert.equal(aggregator.shouldPublish(100), true);
    assert.equal(aggregator.shouldPublish(250), false);
    assert.equal(aggregator.shouldPublish(300), true);
    assert.equal(aggregator.shouldPublish(301, true), true);
    assert.equal(aggregator.snapshot().droppedUnknownBlockEvents, 1);
});
