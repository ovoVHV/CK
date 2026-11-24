import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workspaceSource = fs.readFileSync(
    new URL('./Workspace.tsx', import.meta.url),
    'utf8',
);

const native = fs.readFileSync(new URL('../services/foreground_build_native.ts', import.meta.url), 'utf8');

test('both native commands use the visible frozen identity', () => {
    assert.match(workspaceSource, /const buildEvidence: ForegroundBuildEvidence = Object\.freeze\(\{[\s\S]{0,420}?runId: createForegroundBuildRunId\(\)/);
    assert.match(workspaceSource, /setForegroundBuildEvidence\(buildEvidence\)/);
    assert.match(workspaceSource, /createNativeBuildRequest\(buildEvidence,/);
    for (const field of ['fqbn', 'boardPackageId', 'runId', 'workspaceFingerprint']) assert(native.includes(`${field}: buildEvidence.${field}`));
    for (const command of ['upload_sketch', 'compile_sketch']) assert(native.includes(`invoke<string>('${command}', {...request`));
    assert.match(workspaceSource, /uploadProject\(input\.request, \{port: buildEvidence\.port/);
    assert.match(workspaceSource, /isCompiling && foregroundBuildEvidence && \([\s\S]{0,240}?buildEvidence=\{foregroundBuildEvidence\}/);
});

test('cancel waits for backend process-tree completion before unlocking the UI', () => {
    const start = workspaceSource.indexOf('const handleCancel = async () =>');
    const end = workspaceSource.indexOf('cancelDebugBuildRef.current = handleCancel', start);
    assert.ok(start >= 0 && end > start);
    const handler = workspaceSource.slice(start, end);
    const cancelInvoke = handler.indexOf("await invoke<string>('cancel_foreground_build'");
    assert.ok(cancelInvoke >= 0, 'cancel command must be awaited');
    assert.doesNotMatch(
        handler,
        /isCompilingRef\.current = false/,
        'the cancel click handler must leave cleanup to the operation finally block',
    );
    assert.doesNotMatch(handler, /compileSessionRef\.current \+= 1/);
    assert.doesNotMatch(handler, /后台任务可能仍在运行/);
});

test('component teardown cancels its exact active run instead of abandoning it', () => {
    assert.match(
        workspaceSource,
        /const foregroundBuildRunId = foregroundBuildRunIdRef\.current;[\s\S]{0,900}?await invoke\('cancel_foreground_build', \{ runId: foregroundBuildRunId \}\)/,
    );
});
