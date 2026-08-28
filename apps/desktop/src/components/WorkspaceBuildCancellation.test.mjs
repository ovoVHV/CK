import assert from 'node:assert/strict';
import fs from 'node:fs';
import test from 'node:test';

const workspaceSource = fs.readFileSync(
    new URL('./Workspace.tsx', import.meta.url),
    'utf8',
);

test('foreground compile and upload share a UUID-scoped backend cancellation run', () => {
    assert.match(workspaceSource, /const buildEvidence: ForegroundBuildEvidence = Object\.freeze\(\{[\s\S]{0,420}?runId: createForegroundBuildRunId\(\)/);
    assert.match(
        workspaceSource,
        /invoke\('upload_sketch',[\s\S]{0,420}?runId:\s*buildEvidence\.runId/,
    );
    assert.match(
        workspaceSource,
        /invoke\('compile_sketch',[\s\S]{0,320}?runId:\s*buildEvidence\.runId/,
    );
});

test('visible build evidence and backend invocations reuse one frozen identity', () => {
    const evidenceStart = workspaceSource.indexOf('const buildEvidence: ForegroundBuildEvidence = Object.freeze');
    const operationEnd = workspaceSource.indexOf('const handleCompileIssueAction', evidenceStart);
    assert.ok(evidenceStart >= 0 && operationEnd > evidenceStart);
    const operation = workspaceSource.slice(evidenceStart, operationEnd);

    assert.match(operation, /fqbn: effectiveCompileFqbn/);
    assert.match(operation, /port: activePort \|\| ''/);
    assert.match(operation, /workspaceFingerprint: compileEnvironment\.codeFingerprint/);
    for (const command of ['upload_sketch', 'compile_sketch']) {
        const invokeAt = operation.indexOf(`invoke('${command}'`);
        assert.ok(invokeAt >= 0, `${command} must remain present`);
        const invokeBody = operation.slice(invokeAt, invokeAt + 700);
        assert.match(invokeBody, /fqbn: buildEvidence\.fqbn/);
        assert.match(invokeBody, /runId: buildEvidence\.runId/);
        assert.match(invokeBody, /workspaceFingerprint: buildEvidence\.workspaceFingerprint/);
    }
    assert.match(operation, /setForegroundBuildEvidence\(buildEvidence\)[\s\S]{0,120}?setIsCompiling\(true\)/);
    assert.match(operation, /setForegroundBuildEvidence\(null\)[\s\S]{0,120}?setIsCompiling\(false\)/);
    assert.match(workspaceSource, /isCompiling && foregroundBuildEvidence && \([\s\S]{0,240}?buildEvidence=\{foregroundBuildEvidence\}/);
});

test('cancel waits for backend process-tree completion before unlocking the UI', () => {
    const start = workspaceSource.indexOf('const handleCancel = async () =>');
    const end = workspaceSource.indexOf('const handleCompileAndUpload', start);
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

test('cancelled upload still restores the serial monitor before UI unlock', () => {
    const operationStart = workspaceSource.indexOf('const handleCompileAndUpload = async');
    const finallyStart = workspaceSource.indexOf('} finally {', operationStart);
    const operationEnd = workspaceSource.indexOf('const handleCompileIssueAction', finallyStart);
    assert.ok(finallyStart > operationStart && operationEnd > finallyStart);
    const cleanup = workspaceSource.slice(finallyStart, operationEnd);
    const restore = cleanup.indexOf('await openSerialMonitorWithSettings(');
    const unlock = cleanup.lastIndexOf('isCompilingRef.current = false');
    assert.ok(restore >= 0, 'serial restore must stay in the cancellation cleanup path');
    assert.ok(unlock > restore, 'UI must unlock only after serial restoration has completed');
    assert.match(
        workspaceSource.slice(operationStart, finallyStart),
        /cancelRequestedBuildRunIdsRef\.current\.has\(buildRunId\)[\s\S]{0,260}?后端已确认本次构建取消/,
    );
});

test('component teardown cancels its exact active run instead of abandoning it', () => {
    assert.match(
        workspaceSource,
        /const foregroundBuildRunId = foregroundBuildRunIdRef\.current;[\s\S]{0,900}?await invoke\('cancel_foreground_build', \{ runId: foregroundBuildRunId \}\)/,
    );
});
