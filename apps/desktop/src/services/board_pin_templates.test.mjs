import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./board_pin_templates.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'board_pin_templates.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const { bindDynamicBoardPinTemplates } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('binds each exact options placeholder to its own dynamic capability provider', () => {
    const calls = [];
    const bound = bindDynamicBoardPinTemplates({
        args0: [
            { type: 'field_dropdown', name: 'D', options: '${board.digitalPins}' },
            { type: 'field_dropdown', name: 'A', options: '${board.analogPins}' },
            { type: 'field_dropdown', name: 'P', options: '${board.pwmPins}' },
        ],
    }, capability => {
        calls.push(capability);
        return [[capability, capability.toUpperCase()]];
    });

    assert.equal(typeof bound.args0[0].options, 'function');
    assert.deepEqual(bound.args0[0].options(), [['digital', 'DIGITAL']]);
    assert.deepEqual(bound.args0[1].options(), [['analog', 'ANALOG']]);
    assert.deepEqual(bound.args0[2].options(), [['pwm', 'PWM']]);
    assert.deepEqual(calls, ['digital', 'analog', 'pwm']);
});

test('dynamic providers observe A to B board switches without re-registering blocks', () => {
    let current = [['A-D2', '2']];
    const bound = bindDynamicBoardPinTemplates({
        options: '${board.digitalPins}',
    }, () => current);

    const provider = bound.options;
    assert.deepEqual(provider(), [['A-D2', '2']]);
    current = [['B-D18', '18']];
    assert.deepEqual(provider(), [['B-D18', '18']]);
});

test('does not bind partial text, other properties or unknown placeholders', () => {
    const input = {
        message0: 'prefix ${board.digitalPins}',
        tooltip: '${board.digitalPins}',
        args0: [{ options: '${board.unknownPins}' }],
    };
    assert.deepEqual(bindDynamicBoardPinTemplates(input, () => [['D2', '2']]), input);
});

test('extension loading uses dynamic providers instead of a baked template catalog', async () => {
    const loaderSource = await readFile(new URL('./extension_loader.ts', import.meta.url), 'utf8');
    assert.match(loaderSource, /bindDynamicBoardPinTemplates/);
    assert.match(loaderSource, /resolveCapability\(/);
    assert.match(loaderSource, /boardIdentity\?: BoardPinDropdownIdentity/);
    assert.doesNotMatch(loaderSource, /const defaultPinsStr/);
});
