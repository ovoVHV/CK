import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const plotterStart = source.indexOf('<SerialPlotter');
const plotterEnd = source.indexOf('/>', plotterStart);
const plotterProps = source.slice(plotterStart, plotterEnd);
const openStart = source.indexOf('const openSerialMonitorWithSettings = useCallback');
const openEnd = source.indexOf('// Keep the backend endpoint synchronized', openStart);
const openHandler = source.slice(openStart, openEnd);

test('serial plotter and trigger CSV use the backend-confirmed monitor endpoint', () => {
    assert.ok(plotterStart >= 0 && plotterEnd > plotterStart);
    assert.match(plotterProps, /port=\{monitorPort\}/);
    assert.match(plotterProps, /baudRate=\{monitorBaudRate\}/);
    assert.doesNotMatch(plotterProps, /port=\{activePort\}/);
    assert.doesNotMatch(plotterProps, /baudRate=\{baudRate\}/);
});

test('monitor endpoint state is published only after the backend open succeeds', () => {
    assert.ok(openStart >= 0 && openEnd > openStart);
    const backendOpen = openHandler.indexOf("await invoke('open_serial_monitor'");
    const publishPort = openHandler.indexOf('setMonitorPort(portName)');
    const publishBaud = openHandler.indexOf('setMonitorBaudRate(targetBaud)');
    assert.ok(backendOpen >= 0);
    assert.ok(publishPort > backendOpen);
    assert.ok(publishBaud > backendOpen);
});
