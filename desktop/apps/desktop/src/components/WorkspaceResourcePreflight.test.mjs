import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('resource preflight is scheduled for every committed Blockly content event', () => {
    assert.match(source, /resourcePreflightRevision/);
    assert.match(source, /setResourcePreflightRevision\(previous => previous \+ 1\)/);
    assert.match(source, /resourcePreflightRevision,\s*\n\s*\]\);/);
});

test('edit and compile preflight reuse the existing evaluator without changing build input', () => {
    assert.match(source, /evaluateResourcePreflight\(\{[\s\S]*phase: 'edit'/);
    assert.match(source, /evaluateResourcePreflight\(\{[\s\S]*phase: 'compile'/);
    const compileInvocation = source.indexOf("invoke('compile_sketch'");
    assert.ok(compileInvocation > 0, 'compile invocation should remain present');
    const preflightBeforeCompile = source.lastIndexOf("phase: 'compile'", compileInvocation);
    assert.ok(preflightBeforeCompile > 0, 'compile preflight should run before compile invocation');
    const compileSlice = source.slice(compileInvocation, compileInvocation + 1200);
    assert.doesNotMatch(compileSlice, /resourcePreflight|resourceAnalysis|autoAssign|setPin/i);
});

test('preflight integration stays read-only and never allocates or mutates workspace resources', () => {
    const preflightSlice = source.match(/\/\/ Resource preflight is advisory:[\s\S]*?const isForceRebuild/s)?.[0] || '';
    assert.ok(preflightSlice.length > 0, 'compile preflight section should be present');
    assert.doesNotMatch(preflightSlice, /allocate|autoAssign|setPin|mutateWorkspace|Blockly\.serialization\.workspaces\.load/i);
});
