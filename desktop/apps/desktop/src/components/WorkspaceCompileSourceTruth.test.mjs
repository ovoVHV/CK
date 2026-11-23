import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createHash } from 'node:crypto';
import ts from 'typescript';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('ordinary compile and upload regenerate source from the visible Blockly workspace', () => {
    const compileStart = source.indexOf('const handleCompileAndUpload = async');
    const compileEnd = source.indexOf('const uploadLabel =', compileStart);
    assert.ok(compileStart >= 0 && compileEnd > compileStart, 'compile source selection should exist');

    const selection = source.slice(compileStart, compileEnd);
    assert.match(selection, /resolveCompileSource\(\s*sourceBuild \? workspaceSourceRef\.current!\.code : options\.codeOverride,\s*workspaceRef\.current,/s);
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
        'const loadedCode = preview.code ?? arduinoGenerator.workspaceToCode(loadedWorkspace);',
    );
    const refAt = loadSection.indexOf('generatedCodeRef.current = loadedCode;', generateAt);
    const stateAt = loadSection.indexOf('setGeneratedCode(loadedCode);', refAt);
    assert.ok(generateAt >= 0, 'loaded workspace should be regenerated explicitly');
    assert.ok(refAt > generateAt, 'synchronous source ref should receive loaded code');
    assert.ok(stateAt > refAt, 'code preview state should receive the same loaded code');
    assert.match(loadSection, /initialPreview\.request\(loadedWorkspace, targetBoard, blocklyLocaleRef\.current, loadedWorkspaceState\)/);
    assert.match(loadSection, /loadController\.signal\.aborted/);
});

test('large project loading gates mutation and source publication until the current session completes', () => {
    assert.match(source, /isCompilingRef\.current \|\| projectLoadingRef\.current/);
    assert.match(source, /projectLoadingRef\.current \|\| !workspaceRef\.current \|\| !formalSaveSession/);
    assert.match(source, /projectLoadingRef\.current \|\| !workspaceRef\.current \|\| !saveAsSession/);
    assert.match(source, /await loadBlocklyWorkspaceProgressively\(state, workspace/);
    assert.match(source, /signal: loadController\.signal/);
    assert.match(source, /isCurrent: \(\) => isCurrentLoad\(\) && workspaceRef\.current === workspace/);
    assert.match(source, /if \(!isCurrentLoad\(\) \|\| workspaceRef\.current !== loadedWorkspace\) return/);
    assert.match(source, /loadController\.abort\(\);\s*loadingViewport\?\.endBulkLoad\(\)/);
    assert.match(source, /data-ck-role="project-load-progress"/);
    assert.match(source, /window\.addEventListener\('keydown', preventWorkspaceKey, true\)/);
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

test('presentation identity caching is keyed by the complete exact source, not a weaker identity', () => {
    const start = source.indexOf('const computeIncludeSignature = useCallback');
    const end = source.indexOf('const getCurrentCompileEnvironment =', start);
    const functions = source.slice(start, end);
    assert.match(functions, /includeSignatureCacheRef\.current\?\.source === source/);
    assert.match(functions, /codeFingerprintCacheRef\.current\?\.source === source/);
    assert.match(functions, /const value = sha256Hex\(source\)/);
    assert.match(functions, /codeFingerprintCacheRef\.current = \{ source, value \}/);
    assert.match(functions, /includeSignatureCacheRef\.current = \{ source, value \}/);
});

test('cached code identity exactly matches uncached SHA-256 and include parsing after every edit', () => {
    const start = source.indexOf('const computeIncludeSignature = useCallback');
    const end = source.indexOf('const getCurrentCompileEnvironment =', start);
    const js = ts.transpileModule(source.slice(start, end), {
        compilerOptions: { target: ts.ScriptTarget.ES2022 },
    }).outputText;
    let hashCalls = 0;
    const hash = code => createHash('sha256').update(code).digest('hex');
    const api = new Function('useCallback', 'includeSignatureCacheRef', 'codeFingerprintCacheRef', 'sha256Hex',
        `${js}; return {computeIncludeSignature, computeCodeFingerprint};`)(
        fn => fn, {current:null}, {current:null}, code => {hashCalls++;return hash(code);},
    );
    const before = '#include <Wire.h>\r\n#include "SPI.h"\nvoid setup() {} // 中文\n';
    const after = before.replace('{}', '{ pinMode(13, OUTPUT); }');
    for (const [code, expectedCalls] of [[before,1],[before,1],[after,2],[after,2],[before,3],['',4],['',4]]) {
        assert.equal(api.computeCodeFingerprint(code), hash(code));
        assert.equal(hashCalls, expectedCalls);
        assert.equal(api.computeIncludeSignature(code), code ? 'spi.h|wire.h' : '');
    }
});
