import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import ts from 'typescript';

const sourceUrl = new URL('./block_runtime_activation.ts', import.meta.url);
const source = readFileSync(sourceUrl, 'utf8');
const declarativeSource = readFileSync(new URL('./declarative_block_runtime.ts', import.meta.url), 'utf8');
const declarativeCompiled = ts.transpileModule(declarativeSource, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText;
const declarativeUrl = `data:text/javascript;base64,${Buffer.from(declarativeCompiled).toString('base64')}`;
const compiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ES2022, target: ts.ScriptTarget.ES2022 },
}).outputText.replace(
    /from ['"]\.\/declarative_block_runtime['"]/,
    `from ${JSON.stringify(declarativeUrl)}`,
);
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const runtime = await import(moduleUrl);

const approval = (state, extra = {}) => ({
    state,
    executablePresent: true,
    packageId: 'com.example.sensor',
    contentSha256: 'a'.repeat(64),
    approvedAt: null,
    reason: 'test',
    ...extra,
});

const declarativeEntrypoints = {
    blocks: 'C:/CK/lib/blocks/blocks.json',
    generator: 'C:/CK/lib/blocks/ck-generator.json',
    toolbox: 'C:/CK/lib/blocks/toolbox.json',
};

test('only a complete declarative runtime can activate', () => {
    assert.equal(runtime.libraryCanExecuteBlockRuntime({
        id: 'com.example.sensor', has_blocks: true, has_toolbox: true, has_generator: true,
        block_entrypoints: declarativeEntrypoints,
        runtime_activation: approval('declarative-safe', { executablePresent: false }),
    }), true);
    assert.equal(runtime.libraryCanExecuteBlockRuntime({
        id: 'com.example.sensor', has_blocks: true, has_toolbox: true, has_generator: true,
        block_entrypoints: { ...declarativeEntrypoints, generator: 'C:/CK/lib/blocks/generator.js' },
        runtime_activation: approval('approved'),
    }), false);
    assert.equal(runtime.libraryCanExecuteBlockRuntime({
        id: 'com.example.sensor', has_blocks: true, has_toolbox: false, has_generator: true,
        block_entrypoints: declarativeEntrypoints,
        runtime_activation: approval('declarative-safe', { executablePresent: false }),
    }), false);
});

test('missing activation metadata fails closed for executable libraries', () => {
    const activation = runtime.blockRuntimeActivation({
        id: 'com.example.legacy', has_blocks: true, has_toolbox: true,
    });
    assert.equal(activation.state, 'quality-blocked');
    assert.equal(runtime.libraryCanExecuteBlockRuntime({
        id: 'com.example.legacy', has_blocks: true, has_toolbox: true,
    }), false);
});

test('preserved legacy workspace libraries remain visible but cannot activate', () => {
    const manifest = JSON.parse(readFileSync(
        new URL('../../../../libraries/arduino_avr_nano/arduino_bme280/ck-blocks.json', import.meta.url),
        'utf8',
    ));
    assert.match(manifest.entrypoints.blocks, /\.js$/);
    assert.match(manifest.entrypoints.generator, /\.js$/);
    const library = {
        id: 'arduino_bme280',
        has_blocks: true,
        has_toolbox: true,
        has_generator: true,
        block_entrypoints: manifest.entrypoints,
        runtime_activation: approval('legacy-disabled'),
    };
    assert.equal(runtime.libraryCanExecuteBlockRuntime(library), false);
    assert.equal(runtime.runtimeActivationLabel(library), 'Legacy JavaScript 已禁用');
});

test('exact-hash approval never grants main-WebView execution', () => {
    assert.equal(runtime.libraryCanRequestRuntimeApproval({
        runtime_activation: approval('approval-required'),
    }), false);
    assert.equal(runtime.libraryCanRequestRuntimeApproval({
        runtime_activation: approval('approved'),
    }), false);
    assert.equal(runtime.libraryCanRequestRuntimeApproval({
        runtime_activation: approval('ck-allowlisted'),
    }), false);
});

test('runtime cache identity changes with certified package content', () => {
    const first = { runtime_activation: approval('approved', { contentSha256: 'a'.repeat(64) }) };
    const second = { runtime_activation: approval('approved', { contentSha256: 'b'.repeat(64) }) };
    assert.notEqual(runtime.runtimeContentHashKey(first), runtime.runtimeContentHashKey(second));
    assert.equal(runtime.runtimeContentHashKey({}), 'no-certified-hash');
});
