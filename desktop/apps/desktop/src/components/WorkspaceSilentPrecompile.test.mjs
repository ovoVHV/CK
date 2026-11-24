import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const buildStart = source.indexOf('const prepareBuild =');
const buildEnd = source.indexOf('const handleCompileIssueAction', buildStart);
assert.ok(buildStart >= 0 && buildEnd > buildStart, 'foreground build function must remain discoverable');
const build = source.slice(buildStart, buildEnd);

test('foreground build and edit warmup share one complete request constructor', () => {
    assert.equal(
        source.match(/createSilentPrecompileRequest\(/g)?.length,
        2,
        'only the foreground snapshot and edit effect should construct warmup identities',
    );
    assert.match(build, /const foregroundWarmupRequest = createSilentPrecompileRequest\(\s*effectiveCompileFqbn,\s*extensionsReloadSeq,/);
    assert.match(build, /computeIncludeSignature\(compileCode\)[\s\S]{0,120}computeCodeFingerprint\(compileCode\)[\s\S]{0,120}compileCode/);
});

test('only successful compile and upload satisfy the exact pending request', () => {
    assert.equal(
        [...build.matchAll(/operationResultCode = completedBuildOperationResult\((?:'compile'|'upload')\);/g)].length,
        2,
        'compile and upload success must both set the authoritative result',
    );
    assert.match(build, /if \(isBuildOperationSuccessful\(operationResultCode\)\) \{[\s\S]{0,360}cancelSatisfied\(foregroundWarmupRequest\);[\s\S]{0,120}\}\s*isCompilingRef\.current = false;/);
    assert.equal([...build.matchAll(/cancelSatisfied\(foregroundWarmupRequest\)/g)].length, 1);
    assert.doesNotMatch(build, /cancelPending\(\)/, 'foreground completion must never discard a newer request');

    const finalUnblock = build.lastIndexOf('isCompilingRef.current = false;');
    const lastConfirmation = build.lastIndexOf('cancelSatisfied(foregroundWarmupRequest)');
    assert.ok(lastConfirmation >= 0 && lastConfirmation < finalUnblock,
        'the exact pending request must be consumed before the scheduler is unblocked');
});

test('failure and cancellation paths preserve pending newer work', () => {
    const catchStart = build.indexOf('const reportBuildFailure =');
    const finallyStart = build.indexOf('const unlockBuild =', catchStart);
    assert.ok(catchStart >= 0 && finallyStart > catchStart, 'catch/finally boundary must remain discoverable');
    assert.doesNotMatch(build.slice(catchStart, finallyStart), /cancelSatisfied|cancelPending/);
});
