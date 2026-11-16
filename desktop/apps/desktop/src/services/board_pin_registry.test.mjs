import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./board_pin_registry.ts', import.meta.url), 'utf8');
const pinTokenSource = await readFile(new URL('./pin_code_token.ts', import.meta.url), 'utf8');
const isolatedSource = `${pinTokenSource}\n${source.replace(
    /import\s*\{[\s\S]*?\}\s*from '\.\/pin_code_token';/,
    '',
)}`;
const transpiled = ts.transpileModule(isolatedSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'board_pin_registry.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const pins = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const fqbn = 'esp32:esp32:esp32c6';

test('keeps two custom pin catalogs separate when they share one FQBN', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    registry.register(
        { fqbn, packageId: 'acme-c6-a', isCustom: true },
        [{ label: 'A-SDA', value: 6 }],
    );
    registry.register(
        { fqbn, packageId: 'acme-c6-b', isCustom: true },
        [{ label: 'B-SDA', value: 18 }],
    );

    registry.activate({ fqbn, packageId: 'acme-c6-a', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [['A-SDA', '6']]);
    registry.activate({ fqbn, packageId: 'acme-c6-b', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [['B-SDA', '18']]);
});

test('custom package without pins never borrows the built-in FQBN catalog', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    registry.register({ fqbn, packageId: 'headless-c6', isCustom: true }, []);
    registry.activate({ fqbn, packageId: 'headless-c6', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [pins.UNDECLARED_BOARD_PIN]);

    registry.activate({ fqbn, packageId: 'not-loaded-yet', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [pins.UNDECLARED_BOARD_PIN]);
    assert.notEqual(registry.resolve([['GPIO 0', '0']])[0][1], '0');
});

test('built-in package retains its static pin fallback', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    registry.activate({ fqbn, packageId: fqbn, isCustom: false });
    assert.deepEqual(
        registry.resolve([['GPIO 0', '0'], ['GPIO 1', '1']]),
        [['GPIO 0', '0'], ['GPIO 1', '1']],
    );
});

test('runtime registry refuses unsafe values from an old dirty package', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    registry.register(
        { fqbn, packageId: 'dirty-c6', isCustom: true },
        [
            { label: 'Injected', value: '13); injected(); //' },
            { label: 'Expression', value: 'PIN+1' },
            { label: 'Ambiguous octal', value: '013' },
            { label: 'Internal sentinel', value: '__CK_PIN_UNDECLARED__' },
            { label: 'Safe', value: 'LED_BUILTIN' },
        ],
    );
    registry.activate({ fqbn, packageId: 'dirty-c6', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [['Safe', 'LED_BUILTIN']]);

    registry.register(
        { fqbn, packageId: 'only-unsafe-c6', isCustom: true },
        [{ label: 'Injected', value: '13); injected(); //' }],
    );
    registry.activate({ fqbn, packageId: 'only-unsafe-c6', isCustom: true });
    assert.deepEqual(registry.resolve([['GPIO 0', '0']]), [pins.UNDECLARED_BOARD_PIN]);
});

test('the board pin generator rejects the UI sentinel and unsafe code tokens', async () => {
    const generatorSource = await readFile(
        new URL('../components/arduino_generator.ts', import.meta.url),
        'utf8',
    );
    assert.match(generatorSource, /normalizePinCodeToken\(rawPin\)/);
    assert.match(generatorSource, /if \(!pin\) \{/);
    assert.doesNotMatch(generatorSource, /return \[block\.getFieldValue\('PIN'\)/);
});

test('capability templates resolve only the exact custom package catalog', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    registry.register(
        { fqbn, packageId: 'capability-a', isCustom: true },
        [
            { label: 'A digital', value: '2', capabilities: ['digital'] },
            { label: 'A analog', value: '3', capabilities: ['adc'] },
            { label: 'A PWM', value: '4', capabilities: ['analog_output'] },
            { label: 'A unknown', value: '5' },
        ],
    );
    registry.register(
        { fqbn, packageId: 'capability-b', isCustom: true },
        [{ label: 'B digital', value: '18', capabilities: ['gpio'] }],
    );

    const identityA = { fqbn, packageId: 'capability-a', isCustom: true };
    assert.deepEqual(registry.resolveCapability(identityA, 'digital'), [['A digital', '2']]);
    assert.deepEqual(registry.resolveCapability(identityA, 'analog'), [['A analog', '3']]);
    assert.deepEqual(registry.resolveCapability(identityA, 'pwm'), [['A PWM', '4']]);
    assert.deepEqual(
        registry.resolveCapability({ fqbn, packageId: 'capability-b', isCustom: true }, 'digital'),
        [['B digital', '18']],
    );
});

test('capability-free catalogs stay visible but are explicitly marked unknown', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    const identity = { fqbn, packageId: 'legacy-catalog', isCustom: true };
    registry.register(identity, [
        { label: 'D2', value: '2' },
        { label: 'A0', value: 'A0' },
    ]);

    assert.deepEqual(registry.resolveCapability(identity, 'analog'), [
        ['D2（能力未声明）', '2'],
        ['A0（能力未声明）', 'A0'],
    ]);
});

test('missing custom capability catalogs never fall back to built-in static pins', () => {
    const registry = new pins.BoardPinDropdownRegistry();
    const staticPins = [['Uno D13', '13']];
    assert.deepEqual(
        registry.resolveCapability(
            { fqbn, packageId: 'missing-custom', isCustom: true },
            'digital',
            staticPins,
        ),
        [pins.UNDECLARED_BOARD_PIN],
    );
});
