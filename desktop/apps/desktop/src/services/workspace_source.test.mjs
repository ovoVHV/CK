import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
const output = new URL(`./.workspace-source-test-${process.pid}.mjs`, import.meta.url);
await build({ entryPoints: [fileURLToPath(new URL('./workspace_source.ts', import.meta.url))], outfile: fileURLToPath(output), bundle: true, packages: 'external', platform: 'node', format: 'esm', logLevel: 'silent' });
const { selectSourceMode, getWorkspaceSource, setWorkspaceSource, subscribeWorkspaceSource, workspaceCompileCode, readWorkspaceSource } = await import(output.href);
await fs.unlink(output);
const original = 'void setup() {}\nvoid loop() {}';
const manual = 'void setup() { Serial.begin(115200); }\nvoid loop() {}';

test('real workspace serialization keeps source, active mode and generated baseline through clone/recovery', () => {
    const a = new Blockly.Workspace(), b = new Blockly.Workspace();
    try {
        const source = { ...selectSourceMode(null, original), code: manual };
        setWorkspaceSource(a, source);
        const saved = Blockly.serialization.workspaces.save(a);
        assert.deepEqual(saved.ckSource, source);
        Blockly.serialization.workspaces.load(JSON.parse(JSON.stringify(saved)), b);
        assert.deepEqual(getWorkspaceSource(b), source);
        assert.equal(workspaceCompileCode(b, () => { throw Error('Source mode must not generate blocks'); }), manual);
        setWorkspaceSource(b, { ...source, mode: 'blocks' });
        assert.equal(workspaceCompileCode(b, () => original), original);
        assert.equal(getWorkspaceSource(b).code, manual);
        assert.equal(selectSourceMode(getWorkspaceSource(b), 'changed blocks').code, manual);
    } finally { a.dispose(); b.dispose(); }
});
test('untouched generated source follows changed blocks; manual source is never overwritten on a switch', () => {
    const first = selectSourceMode(null, original);
    assert.equal(selectSourceMode(first, 'new generated code').code, 'new generated code');
    assert.equal(selectSourceMode({ ...first, code: '' }, 'new generated code').code, '');
    assert.equal(selectSourceMode({ ...first, code: manual }, 'new generated code').generatedBase, original);
});
test('opening an old project clears previous source without leaking between projects', () => {
    const workspace = new Blockly.Workspace(); const observed = [];
    const unsubscribe = subscribeWorkspaceSource(workspace, value => observed.push(value));
    try {
        setWorkspaceSource(workspace, selectSourceMode(null, manual));
        Blockly.serialization.workspaces.load({}, workspace);
        assert.equal(getWorkspaceSource(workspace), null);
        assert.equal(observed.at(-1), null);
    } finally { unsubscribe(); workspace.dispose(); }
});
test('invalid/future source metadata refuses load instead of silently discarding manual code', () => {
    const workspace = new Blockly.Workspace();
    try {
        for (const state of [{ version: 2 }, { ...selectSourceMode(null, original), code: '\0' }, { ...selectSourceMode(null, original), code: '中'.repeat(400000) }]) {
            assert.throws(() => readWorkspaceSource(state), /源码编辑数据/);
            assert.throws(() => Blockly.serialization.workspaces.load({ ckSource: state }, workspace), /源码编辑数据/);
        }
    } finally { workspace.dispose(); }
});
