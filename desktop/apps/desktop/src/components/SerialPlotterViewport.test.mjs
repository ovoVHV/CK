import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./SerialPlotter.tsx', import.meta.url), 'utf8');
const helperStart = source.indexOf('const MAX_POINTS_PER_CHANNEL');
const helperEnd = source.indexOf('const COLORS');
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'viewport helper section must exist');

const helperSource = `${source.slice(helperStart, helperEnd)
    .replace('export const resolveSerialChartViewport', 'const resolveSerialChartViewport')
    .replace('export const collectStableFieldPoints', 'const collectStableFieldPoints')}
globalThis.__serialViewportHelpers = {
    resolveSerialChartViewport,
    normalizeVisiblePoints,
    collectStableFieldPoints,
    MIN_VISIBLE_POINTS,
    DEFAULT_VISIBLE_POINTS,
    MAX_POINTS_PER_CHANNEL,
};`;
const helperJavascript = ts.transpileModule(helperSource, {
    compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2020,
    },
}).outputText;
const scope = {};
Function('globalThis', helperJavascript)(scope);
const {
    resolveSerialChartViewport,
    normalizeVisiblePoints,
    collectStableFieldPoints,
    MIN_VISIBLE_POINTS,
    DEFAULT_VISIBLE_POINTS,
    MAX_POINTS_PER_CHANNEL,
} = scope.__serialViewportHelpers;

test('following viewport stays attached to newest samples without changing receive history', () => {
    const first = resolveSerialChartViewport({
        visiblePoints: DEFAULT_VISIBLE_POINTS,
        endSequence: null,
    }, 500);
    assert.deepEqual(first, {
        minimum: 200,
        maximum: 499,
        latest: 499,
        followingLatest: true,
    });

    const afterMoreData = resolveSerialChartViewport({
        visiblePoints: DEFAULT_VISIBLE_POINTS,
        endSequence: null,
    }, 620);
    assert.equal(afterMoreData.minimum, 320);
    assert.equal(afterMoreData.maximum, 619);
    assert.equal(afterMoreData.followingLatest, true);
});

test('historical viewport remains stable while new samples continue arriving', () => {
    const historical = resolveSerialChartViewport({
        visiblePoints: 120,
        endSequence: 400,
    }, 500);
    const afterMoreData = resolveSerialChartViewport({
        visiblePoints: 120,
        endSequence: 400,
    }, 650);

    assert.deepEqual(
        { minimum: historical.minimum, maximum: historical.maximum, followingLatest: historical.followingLatest },
        { minimum: 281, maximum: 400, followingLatest: false },
    );
    assert.deepEqual(
        { minimum: afterMoreData.minimum, maximum: afterMoreData.maximum, followingLatest: afterMoreData.followingLatest },
        { minimum: 281, maximum: 400, followingLatest: false },
    );
    assert.equal(afterMoreData.latest, 649);
});

test('zoom range and retained history are clamped to safe bounds', () => {
    assert.equal(normalizeVisiblePoints(1), MIN_VISIBLE_POINTS);
    assert.equal(normalizeVisiblePoints(99999), MAX_POINTS_PER_CHANNEL);

    const expiredHistory = resolveSerialChartViewport({
        visiblePoints: 60,
        endSequence: 10,
    }, MAX_POINTS_PER_CHANNEL + 500);
    assert.equal(expiredHistory.minimum, 500);
    assert.equal(expiredHistory.maximum, 501);
    assert.equal(expiredHistory.followingLatest, false);
});

test('component exposes wheel zoom, pointer pan, follow latest and clear reset controls', () => {
    assert.match(source, /onWheel=\{handleChartWheel\}/);
    assert.match(source, /onPointerMove=\{handleChartPointerMove\}/);
    assert.match(source, /t\('plot\.followLatest'\)/);
    assert.match(source, /viewportRef\.current = \{\s*visiblePoints: DEFAULT_VISIBLE_POINTS,\s*endSequence: null/);
    assert.match(source, /t\('plot\.interactionHint'\)/);
});

test('stable-field backfill preserves original receive sequence and skips unrelated records', () => {
    const fieldId = 'serial.source.73-68-69-64-75';
    assert.deepEqual(collectStableFieldPoints([
        { sequence: 7, values: { [fieldId]: 20 } },
        { sequence: 8, values: { 'serial.source.6e-6f-69-73-65': 999 } },
        { sequence: 9, values: { [fieldId]: 21 } },
        { sequence: 11, values: { [fieldId]: 22 } },
    ], fieldId), [
        { x: 7, y: 20 },
        { x: 9, y: 21 },
        { x: 11, y: 22 },
    ]);
    assert.match(source, /fieldStabilityRef\.current\.observe\(record\)/);
    assert.match(source, /collectStableFieldPoints\(historyRef\.current, fieldId\)/);
});
