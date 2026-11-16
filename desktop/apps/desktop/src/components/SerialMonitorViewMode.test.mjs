import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./SerialMonitor.tsx', import.meta.url), 'utf8');

const helperStart = source.indexOf('export const formatSerialBytesForDisplay');
const helperEnd = source.indexOf('\n};', helperStart);
assert.ok(helperStart >= 0 && helperEnd > helperStart, 'serial display formatter must exist');

const helperSource = `${source
    .slice(helperStart, helperEnd + 3)
    .replace('export const formatSerialBytesForDisplay', 'const formatSerialBytesForDisplay')}
globalThis.__serialDisplayFormatter = formatSerialBytesForDisplay;`;
const helperJavascript = ts.transpileModule(helperSource, {
    compilerOptions: {
        module: ts.ModuleKind.None,
        target: ts.ScriptTarget.ES2020,
    },
}).outputText;
const scope = {};
Function('globalThis', helperJavascript)(scope);
const formatSerialBytesForDisplay = scope.__serialDisplayFormatter;

test('HEX display formatter is deterministic and preserves line delimiters', () => {
    assert.equal(
        formatSerialBytesForDisplay(new Uint8Array([0x41, 0x20, 0x0a, 0xff])),
        '41 20 0A \r\nFF ',
    );
    assert.equal(formatSerialBytesForDisplay(new Uint8Array()), '');
});

test('changing text/HEX mode repaints the existing capture without waiting for serial-data', () => {
    assert.match(source, /const redrawCurrentMode = \(\) =>/);
    assert.match(source, /redrawForModeRef\.current = redrawCurrentMode/);
    assert.match(source, /previousViewModeRef\.current === viewMode/);
    assert.match(source, /setTerminalGeneration\(\(generation\) => generation \+ 1\)/);
    assert.match(source, /useEffect\(\(\) => \{[\s\S]{0,180}redrawForModeRef\.current\(\);\s*\}, \[terminalGeneration, viewMode\]\)/);
    assert.match(source, /const content = viewModeRef\.current === 'hex'[\s\S]{0,180}captureAsDisplayHex\(\)[\s\S]{0,120}captureTextRef\.current/);
});

test('mode repaint drops stale formatted pending data before clearing xterm', () => {
    const repaintStart = source.indexOf('const redrawCurrentMode = () =>');
    const repaintEnd = source.indexOf('\n        };', repaintStart);
    assert.ok(repaintStart >= 0 && repaintEnd > repaintStart, 'mode repaint implementation must exist');
    const repaint = source.slice(repaintStart, repaintEnd);
    assert.match(repaint, /cancelPendingFlush\(\)/);
    assert.ok(repaint.indexOf('cancelPendingFlush()') < repaint.indexOf('terminal.clear()'));
    assert.match(source, /captureByteChunksRef\.current\.length - 1/);
    assert.match(source, /formatSerialBytesForDisplay\(bytes\)/);
    assert.match(source, /SERIAL_MODE_SWITCH_REPAINT_BYTES = 32 \* 1024/);
    assert.match(source, /SERIAL_MODE_SWITCH_REPAINT_TEXT = 96 \* 1024/);
});
