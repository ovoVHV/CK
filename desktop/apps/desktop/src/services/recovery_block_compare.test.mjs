import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./recovery_block_compare.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'recovery_block_compare.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const compare = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const workspace = blocks => JSON.stringify({ blocks: { languageVersion: 0, blocks } });

test('compares serialized blocks by stable ids and ignores canvas position only', () => {
    const current = workspace([
        { type: 'logic_boolean', id: 'same', x: 10, y: 20, fields: { BOOL: 'TRUE' } },
        { type: 'math_number', id: 'changed', fields: { NUM: 1 } },
        { type: 'text', id: 'removed', fields: { TEXT: 'old' } },
    ]);
    const draft = workspace([
        { type: 'logic_boolean', id: 'same', x: 400, y: 500, fields: { BOOL: 'TRUE' } },
        { type: 'math_number', id: 'changed', fields: { NUM: 2 } },
        { type: 'controls_repeat_ext', id: 'added' },
    ]);

    const result = compare.createRecoveryBlockComparison(current, draft);
    assert.equal(result.parseError, null);
    assert.deepEqual(
        [result.addedCount, result.removedCount, result.changedCount, result.unchangedCount],
        [1, 1, 1, 1],
    );
    assert.equal(result.currentKinds.same, 'same');
    assert.equal(result.currentKinds.changed, 'changed');
    assert.equal(result.currentKinds.removed, 'removed');
    assert.equal(result.draftKinds.added, 'added');
});

test('counts nested input and next blocks instead of treating serializer metadata as blocks', () => {
    const raw = workspace([{
        type: 'controls_if',
        id: 'root',
        extraState: { type: 'metadata-not-a-block' },
        inputs: {
            IF0: { block: { type: 'logic_boolean', id: 'condition' } },
            DO0: { block: { type: 'text_print', id: 'body' } },
        },
        next: { block: { type: 'variables_set', id: 'next' } },
    }]);
    const result = compare.createRecoveryBlockComparison(raw, raw);
    assert.equal(result.currentBlockCount, 4);
    assert.equal(result.unchangedCount, 4);
});

test('preview omits unknown third-party blocks without changing the original payload', () => {
    const raw = workspace([{
        type: 'vendor_missing',
        id: 'missing',
        next: { block: { type: 'logic_boolean', id: 'kept', fields: { BOOL: 'TRUE' } } },
    }]);
    const result = compare.createRecoveryPreviewWorkspace(raw, type => type === 'logic_boolean');
    assert.equal(result.parseError, null);
    assert.equal(result.unknownBlockCount, 1);
    assert.deepEqual(result.unknownTypeNames, ['vendor_missing']);
    assert.equal(result.blockCount, 1);
    assert.equal(result.state.blocks.blocks[0].id, 'kept');
    assert.match(raw, /vendor_missing/);
});

test('malformed recovery JSON becomes a readable preview error', () => {
    const result = compare.createRecoveryPreviewWorkspace('{broken', () => true);
    assert.equal(result.state, null);
    assert.equal(typeof result.parseError, 'string');
    assert.ok(result.parseError.length > 0);
});

test('comparison and preview keep hundreds of blocks available for the interactive canvas', () => {
    const currentBlocks = Array.from({ length: 600 }, (_, index) => ({
        type: 'math_number',
        id: `block-${index}`,
        x: (index % 20) * 120,
        y: Math.floor(index / 20) * 54,
        fields: { NUM: index },
    }));
    const draftBlocks = currentBlocks.slice(10).map((block, index) => (
        index < 50 ? { ...block, fields: { NUM: index + 1000 } } : block
    ));
    draftBlocks.push(...Array.from({ length: 20 }, (_, index) => ({
        type: 'logic_boolean',
        id: `added-${index}`,
        fields: { BOOL: 'TRUE' },
    })));

    const current = workspace(currentBlocks);
    const draft = workspace(draftBlocks);
    const result = compare.createRecoveryBlockComparison(current, draft);
    const preview = compare.createRecoveryPreviewWorkspace(draft, () => true);

    assert.equal(result.parseError, null);
    assert.equal(result.currentBlockCount, 600);
    assert.equal(result.draftBlockCount, 610);
    assert.equal(result.removedCount, 10);
    assert.equal(result.changedCount, 50);
    assert.equal(result.addedCount, 20);
    assert.equal(preview.blockCount, 610);
    assert.equal(preview.unknownBlockCount, 0);
});
