import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const source = readFileSync(new URL('./declarative_block_runtime.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const runtime = await import(moduleUrl);

test('ck-generator v1 renders only declared placeholders and artifacts', () => {
    const document = runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
        schema: 'ck-generator',
        version: 1,
        rules: [{
            type: 'safe_write',
            kind: 'statement',
            template: 'digitalWrite({{field:PIN}}, {{value:VALUE}});\n{{statement:DO}}',
            includes: { arduino: '#include <Arduino.h>' },
            declarations: { state: 'int pin_{{field:PIN}} = 0;' },
            setup: { pin: 'pinMode({{field:PIN}}, OUTPUT);' },
        }],
    }));
    const emitted = { includes: [], declarations: [], setup: [] };
    const generator = {
        valueToCode: (_block, name) => name === 'VALUE' ? 'HIGH' : '',
        statementToCode: (_block, name) => name === 'DO' ? '  tick();\n' : '',
        addInclude: (key, value) => emitted.includes.push([key, value]),
        addDeclaration: (key, value) => emitted.declarations.push([key, value]),
        addSetup: (key, value) => emitted.setup.push([key, value]),
    };
    const generate = runtime.bindDeclarativeGeneratorFunction(document.rules[0], generator);
    const code = generate({ getFieldValue: name => name === 'PIN' ? '13' : '' });

    assert.equal(code, 'digitalWrite(13, HIGH);\n  tick();\n');
    assert.deepEqual(emitted.includes, [['ck_decl_safe_write_arduino', '#include <Arduino.h>']]);
    assert.deepEqual(emitted.declarations, [['ck_decl_safe_write_state', 'int pin_13 = 0;']]);
    assert.deepEqual(emitted.setup, [['ck_decl_safe_write_pin', 'pinMode(13, OUTPUT);']]);
});

test('script input and script-looking JSON text never execute or pollute globals', () => {
    const previous = {
        window: globalThis.window,
        document: globalThis.document,
        fetch: globalThis.fetch,
        marker: globalThis.__ckRuntimeIsolationMarker,
    };
    let networkCalls = 0;
    const fakeWindow = { clean: true };
    const fakeDocument = { clean: true };
    globalThis.window = fakeWindow;
    globalThis.document = fakeDocument;
    globalThis.fetch = () => { networkCalls += 1; };
    globalThis.__ckRuntimeIsolationMarker = 0;

    try {
        const malicious = [
            'globalThis.__ckRuntimeIsolationMarker = 1',
            'window.polluted = true',
            'document.polluted = true',
            "fetch('https://attacker.invalid')",
        ].join('; ');
        assert.throws(
            () => runtime.parseDeclarativeGeneratorDocument(malicious),
            /strict JSON/,
        );
        assert.equal(globalThis.__ckRuntimeIsolationMarker, 0);
        assert.equal(fakeWindow.polluted, undefined);
        assert.equal(fakeDocument.polluted, undefined);
        assert.equal(networkCalls, 0);

        const document = runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
            schema: 'ck-generator',
            version: 1,
            rules: [{ type: 'text_only', kind: 'statement', template: malicious }],
        }));
        const generate = runtime.bindDeclarativeGeneratorFunction(document.rules[0], {});
        assert.equal(generate({}), malicious);
        assert.equal(globalThis.__ckRuntimeIsolationMarker, 0);
        assert.equal(fakeWindow.polluted, undefined);
        assert.equal(fakeDocument.polluted, undefined);
        assert.equal(networkCalls, 0);
    } finally {
        if (previous.window === undefined) delete globalThis.window;
        else globalThis.window = previous.window;
        if (previous.document === undefined) delete globalThis.document;
        else globalThis.document = previous.document;
        if (previous.fetch === undefined) delete globalThis.fetch;
        else globalThis.fetch = previous.fetch;
        if (previous.marker === undefined) delete globalThis.__ckRuntimeIsolationMarker;
        else globalThis.__ckRuntimeIsolationMarker = previous.marker;
    }
});

test('declarative entrypoint policy rejects every JavaScript extension', () => {
    for (const extension of ['js', 'mjs', 'cjs']) {
        assert.equal(runtime.isSafeDeclarativeEntrypoint(`blocks/blocks.${extension}`, 'blocks'), false);
        assert.equal(runtime.isSafeDeclarativeEntrypoint(`blocks/generator.${extension}`, 'generator'), false);
    }
    assert.equal(runtime.isCompleteDeclarativeRuntime({
        blocks: 'blocks/blocks.json',
        generator: 'blocks/ck-generator.json',
        toolbox: 'blocks/toolbox.xml',
    }), true);
});

test('block and toolbox data reject remote, inline, and file resources', () => {
    for (const src of [
        'https://attacker.invalid/pixel.png',
        'data:image/svg+xml,<svg/>',
        'file:///etc/passwd',
        '//attacker.invalid/pixel.png',
    ]) {
        assert.throws(() => runtime.parseDeclarativeBlockDocument(JSON.stringify([{
            type: 'remote_image',
            message0: '%1',
            args0: [{ type: 'field_image', src, width: 16, height: 16 }],
        }])), /field_image|resource/);
        assert.throws(() => runtime.parseDeclarativeToolboxDocument(JSON.stringify({
            kind: 'categoryToolbox',
            contents: [{ kind: 'label', src }],
        })), /resource/);
    }
    assert.throws(
        () => runtime.validateDeclarativeToolboxXml(
            '<category name="Remote"><image src="https://attacker.invalid/pixel.png" /></category>',
        ),
        /resource/,
    );
});

test('one generator invocation has a hard rendered-output budget', () => {
    const document = runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
        schema: 'ck-generator',
        version: 1,
        rules: [{ type: 'bounded_output', kind: 'statement', template: '{{field:TEXT}}' }],
    }));
    const generate = runtime.bindDeclarativeGeneratorFunction(document.rules[0], {});
    assert.throws(
        () => generate({ getFieldValue: () => 'x'.repeat(64 * 1024 + 1) }),
        /64 KiB limit/,
    );
    assert.throws(
        () => generate({ getFieldValue: () => '😀'.repeat(20 * 1024) }),
        /64 KiB limit/,
    );
});

test('CK distributed serial package loads its toolbox and generates code declaratively', () => {
    const packageRoot = new URL(
        '../../../../examples/importable-packages/ck_example_serial_blocks/',
        import.meta.url,
    );
    const blocks = runtime.parseDeclarativeBlockDocument(
        readFileSync(new URL('blocks/blocks.json', packageRoot), 'utf8'),
    );
    assert.equal(blocks.length, 1);
    const toolbox = runtime.validateDeclarativeToolboxXml(
        readFileSync(new URL('blocks/toolbox.xml', packageRoot), 'utf8'),
    );
    assert.match(toolbox, /ck_example_serial_message/);

    const generatorDocument = runtime.parseDeclarativeGeneratorDocument(
        readFileSync(new URL('blocks/ck-generator.json', packageRoot), 'utf8'),
    );
    const rule = generatorDocument.rules.find(item => item.type === 'ck_example_serial_message');
    const setups = [];
    const generate = runtime.bindDeclarativeGeneratorFunction(rule, {
        addSetup: (key, value) => setups.push([key, value]),
    });
    assert.equal(
        generate({ getFieldValue: name => name === 'MESSAGE' ? 'Hello CK' : '' }),
        'Serial.println("Hello CK");\n',
    );
    assert.deepEqual(setups, [[
        'ck_decl_ck_example_serial_message_serial_begin',
        'Serial.begin(115200);',
    ]]);
});

test('ck-generator schema is strict and bounded', () => {
    assert.throws(() => runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
        schema: 'ck-generator', version: 1, rules: [],
    })), /non-empty bounded array/);
    assert.throws(() => runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
        schema: 'ck-generator', version: 1, rules: [{
            type: 'bad_rule', kind: 'statement', template: 'ok', execute: 'window.polluted = true',
        }],
    })), /unsupported fields/);
    assert.throws(() => runtime.parseDeclarativeGeneratorDocument(JSON.stringify({
        schema: 'ck-generator', version: 1, rules: [{
            type: 'bad_token', kind: 'statement', template: '{{eval:PAYLOAD}}',
        }],
    })), /invalid placeholder/);
});
