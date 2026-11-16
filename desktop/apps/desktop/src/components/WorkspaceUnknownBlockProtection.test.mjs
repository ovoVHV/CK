import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('project load inspects unknown blocks before clearing or deserializing Blockly', () => {
    const inspectAt = source.indexOf('const inspection = inspectSerializedBlocklyWorkspace(');
    const clearAt = source.indexOf('workspaceRef.current.clear();', inspectAt);
    const loadAt = source.indexOf('Blockly.serialization.workspaces.load(state', inspectAt);
    assert.ok(inspectAt >= 0);
    assert.ok(clearAt > inspectAt);
    assert.ok(loadAt > inspectAt);
    assert.match(source.slice(inspectAt, loadAt), /if \(!inspection\.canDeserializeIntoBlockly \|\| !inspection\.canOverwriteSource\)/);
    assert.match(source.slice(inspectAt, loadAt), /setUnknownBlockProtection/);
    assert.match(source.slice(inspectAt, loadAt), /return;/);
});

test('destructive unknown-block sanitizers are no longer present', () => {
    assert.doesNotMatch(source, /sanitizeSerializedBlockTree/);
    assert.doesNotMatch(source, /sanitizeSerializedWorkspaceState/);
    assert.doesNotMatch(source, /sanitizeWorkspaceXmlDom/);
    assert.doesNotMatch(source, /已忽略 .*非内置积木/);
});

test('save compile and checkpoint restore all fail closed in protection mode', () => {
    assert.match(source, /if \(unknownBlockProtection \|\| projectLoadSafetyError \|\| rendererRecoveryFailure\)/);
    assert.match(source, /工程处于只读保护模式，已阻止编译和上传/);
    assert.match(source, /检查点包含 .*当前未注册积木/);
    assert.match(source, /原始检查点已保留/);
});
