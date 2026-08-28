import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('exposes project acceptance as an on-demand modal from the existing file menu', () => {
    assert.match(source, /<ProjectAcceptanceReportModal/);
    assert.match(source, /submissionMaterialProvider=\{createProjectSubmissionMaterial\}/);
    assert.match(source, /getCurrentLastWorkingVersionState\(\)/);
    assert.match(source, /ckLock:\s*lastWorking\?\.lock\.content \|\| null/);
    assert.match(source, /reportProvider=\{createAcceptanceReportData\}/);
    assert.match(source, /项目验收报告/);
    assert.match(source, /setIsProjectAcceptanceReportOpen\(true\); setIsFileMenuOpen\(false\)/);
    assert.doesNotMatch(source, /ProjectAcceptanceReportDock|project-acceptance-rail/);
});

test('keeps package identity separate from the backend-resolved complete FQBN', () => {
    const start = source.indexOf('const createAcceptanceReportData');
    const end = source.indexOf('const updateBlockDebugSession', start);
    const provider = source.slice(start, end);
    assert.match(provider, /activeBoardPackage as any\)\?\.fqbn_base/);
    assert.match(provider, /composeBoardFqbn\(resolvedBaseFqbn, resolvedBoardOptions\)/);
    assert.match(provider, /boardPackageId: activeBoardPackageId/);
    assert.match(provider, /fqbn: resolvedFqbn/);
});

test('switching boards cannot let stale compile or resource evidence select the report target', () => {
    const start = source.indexOf('const createAcceptanceReportData');
    const end = source.indexOf('const updateBlockDebugSession', start);
    const provider = source.slice(start, end);
    const targetStart = provider.indexOf('const resolvedBaseFqbn');
    const targetEnd = provider.indexOf('const resolvedCoreId', targetStart);
    const targetSelection = provider.slice(targetStart, targetEnd);

    assert.match(targetSelection, /fqbn_base/);
    assert.match(targetSelection, /composeBoardFqbn\(resolvedBaseFqbn, resolvedBoardOptions\)/);
    assert.doesNotMatch(targetSelection, /compileResourceReport|compileDoctorReport|deviceHealthPublication/);
});

test('an edit during a slow build cannot publish old health or overwrite its resource baseline', () => {
    assert.match(source, /sha256Hex/);
    assert.match(source, /const computeCodeFingerprint = useCallback\(\(code: string\): string => \{\s*return sha256Hex/);
    assert.match(source, /workspaceFingerprintAtRunStart = workspaceEvidenceFingerprint\(\)/);
    assert.match(source, /workspaceEvidenceFingerprint\(\) === workspaceFingerprintAtRunStart/);
    assert.match(source, /编译期间工程已编辑；本次日志与产物保留，但不会覆盖当前工程的体检、资源或错误定位证据/);

    const resourcesStart = source.indexOf('const publishCompileResources = (');
    const resourcesEnd = source.indexOf('const publishCompileIssues = (', resourcesStart);
    const resources = source.slice(resourcesStart, resourcesEnd);
    const identityGate = resources.indexOf('isSameCompileResourceTarget(resourceTargetIdentity, currentTargetIdentity)');
    const save = resources.indexOf('saveCompileResourceSnapshot(resourceTargetIdentity.projectPath, nextSnapshot)');
    assert.ok(identityGate >= 0 && save > identityGate, 'identity gate must run before baseline persistence');
});

test('acceptance compile and resource evidence reuse the same frozen foreground run identity', () => {
    const evidenceStart = source.indexOf('const buildEvidence: ForegroundBuildEvidence');
    const evidenceEnd = source.indexOf('const buildRunId = buildEvidence.runId', evidenceStart);
    const evidence = source.slice(evidenceStart, evidenceEnd);
    for (const field of [
        'runId', 'boardPackageId', 'fqbn', 'coreId', 'coreVersion',
        'workspaceSha256', 'generatedCodeSha256',
    ]) assert.match(evidence, new RegExp(`${field}:`));

    const doctorStart = source.indexOf('const publishCompileDoctor = (');
    const doctorEnd = source.indexOf('const publishCompileResources = (', doctorStart);
    assert.match(source.slice(doctorStart, doctorEnd), /bindProjectBuildEvidence\(diagnosed, buildEvidence, diagnosed\.recordedAt\)/);

    const resourcesStart = source.indexOf('const publishCompileResources = (');
    const resourcesEnd = source.indexOf('const publishCompileIssues = (', resourcesStart);
    assert.match(source.slice(resourcesStart, resourcesEnd), /bindProjectBuildEvidence\(createCompileResourceReport\([\s\S]*\), buildEvidence, capturedAt\)/);
    assert.doesNotMatch(source, /acceptanceEvidenceIdentityRef|projectBuildEvidenceRef/);
});

test('instrumented and code-override runs never replace ordinary project health evidence', () => {
    const guardStart = source.indexOf('const runEvidenceIsCurrent = () =>');
    const guardEnd = source.indexOf('let staleEvidenceNoticeWritten', guardStart);
    const guard = source.slice(guardStart, guardEnd);
    assert.match(guard, /options\.codeOverride === undefined/);
    assert.match(guard, /!isInstrumentedUpload/);
});
