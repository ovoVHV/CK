import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as Blockly from 'blockly';
import ts from 'typescript';

const sourcePath = new URL('./unknown_block_guard.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'unknown_block_guard.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'unknown_block_guard.ts should transpile without syntax errors');

const guard = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    inspectBlocklyJsonWorkspace,
    inspectBlocklyXmlWorkspace,
    inspectSerializedBlocklyWorkspace,
    sha256WorkspaceText,
} = guard;

const parseBlocklyXml = serialized => Blockly.utils.xml.textToDom(serialized);

test('finds an unknown JSON root without changing the exact serialized workspace', () => {
    const raw = `{
  "blocks": {
    "languageVersion": 0,
    "blocks": [{ "type": "vendor/root-block", "id": "root-1" }]
  }
}`;

    const result = inspectSerializedBlocklyWorkspace(raw, new Set(['controls_if']));

    assert.equal(result.format, 'json');
    assert.equal(result.loadDecision, 'read-only-protection');
    assert.equal(result.canDeserializeIntoBlockly, false);
    assert.equal(result.canOverwriteSource, false);
    assert.equal(result.unknownBlockCount, 1);
    assert.deepEqual(result.unknownTypeNames, ['vendor/root-block']);
    assert.deepEqual(result.occurrences, [{
        type: 'vendor/root-block',
        path: '$.blocks.blocks[0]',
        source: 'root',
        nodeKind: 'block',
    }]);
    assert.equal(result.rawWorkspace.serialized, raw);
    assert.equal(result.rawWorkspace.sha256, sha256WorkspaceText(raw));
    assert.equal(result.rawWorkspace.sha256.length, 64);
    assert.equal(result.rawWorkspace.utf8ByteLength, Buffer.byteLength(raw, 'utf8'));
    assert.equal(Object.isFrozen(result.rawWorkspace), true);
    assert.equal(Object.isFrozen(result.occurrences), true);
});

test('scans nested JSON inputs, next chains and shadows and groups repeated types', () => {
    const state = {
        blocks: {
            languageVersion: 0,
            blocks: [{
                type: 'known.root',
                inputs: {
                    CONDITION: {
                        block: {
                            type: 'vendor/repeated',
                            inputs: {
                                FALLBACK: { shadow: { type: 'vendor/shadow' } },
                            },
                        },
                    },
                    VALUE: { shadow: { type: 'known.number' } },
                },
                next: {
                    block: {
                        type: 'known.root',
                        next: { block: { type: 'vendor/repeated' } },
                    },
                    shadow: { type: 'vendor/next-shadow' },
                },
            }],
        },
    };
    const before = structuredClone(state);

    const result = inspectBlocklyJsonWorkspace(
        state,
        new Set(['known.root', 'known.number']),
    );

    assert.deepEqual(state, before, 'inspection must not mutate the caller workspace');
    assert.equal(result.unknownBlockCount, 4);
    assert.deepEqual(result.occurrences.map(item => [item.type, item.source, item.nodeKind]), [
        ['vendor/repeated', 'input', 'block'],
        ['vendor/shadow', 'shadow', 'shadow'],
        ['vendor/repeated', 'next', 'block'],
        ['vendor/next-shadow', 'shadow', 'shadow'],
    ]);
    assert.deepEqual(result.unknownTypes, [{
        type: 'vendor/repeated',
        count: 2,
        paths: [
            '$.blocks.blocks[0].inputs.CONDITION.block',
            '$.blocks.blocks[0].next.block.next.block',
        ],
        sources: ['input', 'next'],
    }, {
        type: 'vendor/shadow',
        count: 1,
        paths: ['$.blocks.blocks[0].inputs.CONDITION.block.inputs.FALLBACK.shadow'],
        sources: ['shadow'],
    }, {
        type: 'vendor/next-shadow',
        count: 1,
        paths: ['$.blocks.blocks[0].next.shadow'],
        sources: ['shadow'],
    }]);
});

test('scans conservative raw block nodes retained in JSON extraState and mutation', () => {
    const state = {
        blocks: {
            blocks: [{
                type: 'known.dynamic',
                extraState: {
                    originalSubtree: {
                        type: '供应商/动态🌡️',
                        inputs: {
                            RAW: { shadow: { type: 'vendor/raw-shadow' } },
                        },
                    },
                },
                mutation: {
                    entries: [
                        { block: { type: 'legacy.mutator/item' } },
                        { type: 'legacy.mutator/direct' },
                    ],
                },
            }],
        },
    };

    const result = inspectBlocklyJsonWorkspace(state, new Set(['known.dynamic']));

    assert.deepEqual(result.occurrences.map(item => ({
        type: item.type,
        source: item.source,
        nodeKind: item.nodeKind,
    })), [
        { type: '供应商/动态🌡️', source: 'extraState', nodeKind: 'block' },
        { type: 'vendor/raw-shadow', source: 'extraState', nodeKind: 'shadow' },
        { type: 'legacy.mutator/item', source: 'mutation', nodeKind: 'block' },
        { type: 'legacy.mutator/direct', source: 'mutation', nodeKind: 'block' },
    ]);
    assert.match(result.occurrences[0].path, /\.extraState\.originalSubtree$/);
    assert.match(result.occurrences[2].path, /\.mutation\.entries\[0\]\.block$/);
    assert.match(result.occurrences[3].path, /\.mutation\.entries\[1\]$/);
    assert.equal(
        JSON.parse(result.rawWorkspace.serialized).blocks.blocks[0].extraState.originalSubtree.type,
        '供应商/动态🌡️',
    );
});

test('scans XML roots, nested inputs, next, shadows and raw extraState/mutation subtrees', () => {
    const raw = `
<xml xmlns="https://developers.google.com/blockly/xml">
  <block type="known.root" id="root">
    <value name="VALUE"><block type="供应商/温度🌡️" /></value>
    <statement name="DO"><shadow type="third_party.shadow" /></statement>
    <next>
      <block type="known.root">
        <next><block type="third_party.next" /></next>
      </block>
    </next>
    <mutation><entry><block type="legacy/raw-mutation" /></entry></mutation>
    <extraState><blocks><shadow type="vendor/raw-extra-shadow" /></blocks></extraState>
  </block>
  <block type="third.party.root" />
</xml>`;

    const result = inspectBlocklyXmlWorkspace(
        raw,
        new Set(['known.root']),
        { parseXml: parseBlocklyXml },
    );

    assert.equal(result.loadDecision, 'read-only-protection');
    assert.deepEqual(result.occurrences.map(item => [item.type, item.source, item.nodeKind]), [
        ['供应商/温度🌡️', 'input', 'block'],
        ['third_party.shadow', 'shadow', 'shadow'],
        ['third_party.next', 'next', 'block'],
        ['legacy/raw-mutation', 'mutation', 'block'],
        ['vendor/raw-extra-shadow', 'extraState', 'shadow'],
        ['third.party.root', 'root', 'block'],
    ]);
    assert.match(result.occurrences[0].path, /^\/xml\[1\]\/block\[1\]\/value\[1\]\/block\[1\]$/);
    assert.match(result.occurrences[2].path, /\/next\[1\]\/block\[1\]\/next\[1\]\/block\[1\]$/);
    assert.match(result.occurrences[3].path, /\/mutation\[1\]\/entry\[1\]\/block\[1\]$/);
    assert.match(result.occurrences[4].path, /\/extrastate\[1\]\/blocks\[1\]\/shadow\[1\]$/);
    assert.equal(result.rawWorkspace.serialized, raw);
    assert.equal(result.rawWorkspace.utf8ByteLength, Buffer.byteLength(raw, 'utf8'));
});

test('preserves Unicode and third-party type identities exactly', () => {
    const type = '第三方.example/传感器-µ-🌡️';
    const raw = JSON.stringify({ blocks: { blocks: [{ type }] } });
    const result = inspectBlocklyJsonWorkspace(raw, new Set());

    assert.equal(result.unknownTypeNames[0], type);
    assert.equal(result.unknownTypes[0].type, type);
    assert.equal(result.occurrences[0].type, type);
    assert.equal(JSON.parse(result.rawWorkspace.serialized).blocks.blocks[0].type, type);
});

test('returns a normal decision when JSON and XML contain no unknown blocks', () => {
    const known = new Set(['controls_if', 'math_number', 'text']);
    const json = inspectBlocklyJsonWorkspace({
        blocks: {
            blocks: [{
                type: 'controls_if',
                inputs: {
                    CONDITION: { block: { type: 'text' } },
                    VALUE: { shadow: { type: 'math_number' } },
                },
            }],
        },
    }, known);
    const xml = inspectSerializedBlocklyWorkspace(
        '<xml><block type="controls_if"><value><shadow type="math_number" /></value></block></xml>',
        known,
        { parseXml: parseBlocklyXml },
    );

    for (const result of [json, xml]) {
        assert.equal(result.loadDecision, 'normal');
        assert.equal(result.canDeserializeIntoBlockly, true);
        assert.equal(result.canOverwriteSource, true);
        assert.equal(result.unknownBlockCount, 0);
        assert.deepEqual(result.unknownTypeNames, []);
        assert.deepEqual(result.unknownTypes, []);
        assert.deepEqual(result.occurrences, []);
    }
});

test('creates canonical immutable JSON snapshots and stable SHA-256 identities', () => {
    const left = { z: 1, blocks: { blocks: [{ id: 'x', type: 'known' }] }, a: 2 };
    const right = { a: 2, blocks: { blocks: [{ type: 'known', id: 'x' }] }, z: 1 };
    const leftResult = inspectBlocklyJsonWorkspace(left, new Set(['known']));
    const rightResult = inspectBlocklyJsonWorkspace(right, new Set(['known']));
    const captured = leftResult.rawWorkspace.serialized;

    left.blocks.blocks[0].type = 'changed-after-inspection';

    assert.equal(leftResult.rawWorkspace.serialized, captured);
    assert.equal(leftResult.rawWorkspace.serialized, rightResult.rawWorkspace.serialized);
    assert.equal(leftResult.rawWorkspace.sha256, rightResult.rawWorkspace.sha256);
    assert.equal(
        sha256WorkspaceText('abc'),
        'ba7816bf8f01cfea414140de5dae2223b00361a396177a9cb410ff61f20015ad',
    );
    assert.notEqual(sha256WorkspaceText('abc'), sha256WorkspaceText('abc '));
    const unicode = '第三方.example/传感器-µ-🌡️';
    assert.equal(
        sha256WorkspaceText(unicode),
        createHash('sha256').update(unicode, 'utf8').digest('hex'),
    );
});

test('accepts a JSON BOM without weakening the exact raw recovery snapshot', () => {
    const raw = '\uFEFF{\n  "blocks": {"blocks": [{"type": "vendor/bom"}]}\n}';
    const result = inspectSerializedBlocklyWorkspace(raw, new Set());

    assert.equal(result.format, 'json');
    assert.equal(result.loadDecision, 'read-only-protection');
    assert.deepEqual(result.unknownTypeNames, ['vendor/bom']);
    assert.equal(result.rawWorkspace.serialized, raw);
    assert.equal(
        result.rawWorkspace.sha256,
        createHash('sha256').update(raw, 'utf8').digest('hex'),
    );
    assert.equal(result.rawWorkspace.utf8ByteLength, Buffer.byteLength(raw, 'utf8'));
});

test('does not treat inherited registry properties as installed block types', () => {
    const raw = JSON.stringify({ blocks: { blocks: [{ type: 'toString' }] } });
    const result = inspectBlocklyJsonWorkspace(raw, {});

    assert.equal(result.loadDecision, 'read-only-protection');
    assert.deepEqual(result.unknownTypeNames, ['toString']);
});
