import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('ordinary compile and upload regenerate source from the visible Blockly workspace', () => {
    const compileStart = source.indexOf('const handleCompileAndUpload = async');
    const compileEnd = source.indexOf('const uploadLabel =', compileStart);
    assert.ok(compileStart >= 0 && compileEnd > compileStart, 'compile source selection should exist');

    const selection = source.slice(compileStart, compileEnd);
    assert.match(selection, /resolveCompileSource\(\s*options\.codeOverride,\s*workspaceRef\.current,/s);
    assert.match(selection, /workspace => arduinoGenerator\.workspaceToCode\(workspace\)/);
    assert.match(selection, /generatedCodeRef\.current = compileCode/);
    assert.doesNotMatch(selection, /options\.codeOverride \|\| generatedCode/);
});

test('trusted pin preflight blocks unsafe workspaces before C++ generation', () => {
    const compileStart = source.indexOf('const handleCompileAndUpload = async');
    const compileEnd = source.indexOf('const uploadLabel =', compileStart);
    const selection = source.slice(compileStart, compileEnd);
    const preflightAt = selection.indexOf('const nextPinPreflight = analyzePinPreflight');
    const generatorAt = selection.indexOf('compileCode = resolveCompileSource');

    assert.ok(preflightAt >= 0, 'compile path should run pin preflight');
    assert.ok(generatorAt > preflightAt, 'pin preflight must run before code generation');
    assert.match(selection.slice(preflightAt, generatorAt), /if \(!nextPinPreflight\.canCompile\)[\s\S]*?return false;/);
});

test('project loading explicitly synchronizes generated source after deserialization', () => {
    const loadStart = source.indexOf('// Load Project');
    const synchronizeStart = source.indexOf(
        '// Blockly deserialization may emit only `finished_loading`',
        loadStart,
    );
    const projectLoaded = source.indexOf('projectLoadedKeyRef.current = loadKey;', synchronizeStart);
    assert.ok(
        loadStart >= 0 && synchronizeStart > loadStart && projectLoaded > synchronizeStart,
        'normal project load synchronization should exist after protected early-return branches',
    );

    const loadSection = source.slice(synchronizeStart, projectLoaded);
    const generateAt = loadSection.indexOf(
        'const loadedCode = arduinoGenerator.workspaceToCode(workspaceRef.current);',
    );
    const refAt = loadSection.indexOf('generatedCodeRef.current = loadedCode;', generateAt);
    const stateAt = loadSection.indexOf('setGeneratedCode(loadedCode);', refAt);
    assert.ok(generateAt >= 0, 'loaded workspace should be regenerated explicitly');
    assert.ok(refAt > generateAt, 'synchronous source ref should receive loaded code');
    assert.ok(stateAt > refAt, 'code preview state should receive the same loaded code');
});

test('workspace identity publishes stable source and include signatures for native gates', () => {
    const identityAt = source.indexOf('data-ck-role="workspace-project-identity"');
    assert.ok(identityAt >= 0, 'workspace identity should exist');
    const identity = source.slice(identityAt, identityAt + 600);

    assert.match(
        identity,
        /data-ck-code-fingerprint=\{computeCodeFingerprint\(generatedCode\)\}/,
    );
    assert.match(
        identity,
        /data-ck-include-signature=\{computeIncludeSignature\(generatedCode\)\}/,
    );
    assert.match(identity, /data-ck-project-dirty=\{String\(isProjectDirty\)\}/);
});
