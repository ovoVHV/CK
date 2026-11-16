import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./project_submission.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'project_submission.ts',
    reportDiagnostics: true,
});

test('project submission service remains valid TypeScript', () => {
    assert.deepEqual(
        (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
        [],
    );
});

const executable = transpiled.outputText
    .replace("import { invoke } from '@tauri-apps/api/core';", 'const invoke = (...args) => globalThis.__CK_PROJECT_SUBMISSION_INVOKE__(...args);');
const submission = await import(`data:text/javascript;base64,${Buffer.from(executable).toString('base64')}`);

const summary = () => ({
    projectName: 'C6 温度项目',
    blockCount: 3,
    workspaceSha256: 'a'.repeat(64),
    generatedCodeSha256: 'b'.repeat(64),
    boardName: 'ESP32-C6',
    boardId: 'esp32c6',
    boardPackageId: 'builtin-c6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    coreId: 'esp32:esp32',
    coreVersion: '3.3.6',
    compileState: 'passed',
    compileRecordedAt: '2026-07-16T00:00:00Z',
    flashUsedBytes: 100,
    flashTotalBytes: 1000,
    ramUsedBytes: 20,
    ramTotalBytes: 200,
    dependencyLockAvailable: false,
    dependencyLockSha256: null,
    dependencyCount: 0,
    dependenciesAllVersioned: false,
    hardwareState: 'verified',
    hardwareChip: 'ESP32-C6',
    hardwareFlashBytes: 16777216,
    hardwarePsramBytes: null,
    checkpointCount: 2,
    healthSummary: '当前检查项未发现确定问题',
    healthPassCount: 4,
    healthWarningCount: 0,
    healthErrorCount: 0,
    healthInfoCount: 1,
});

const shared = () => ({
    packageFileName: 'weather-station.ckpkg',
    packageSha256: 'd'.repeat(64),
    schemaVersion: 1,
    includedFiles: 3,
    sourceScope: 'no_source',
    hasDependencyLock: false,
    hasBuildEvidence: true,
    summary: summary(),
    integrityVerified: true,
    publisherIdentityVerified: false,
    authenticityMessage: '完整性已校验，但该本地容器未包含发布者身份签名。',
    networkUsed: false,
    uploadPerformed: false,
});

test('normalizes read-only inspection and preserves integrity versus identity boundary', () => {
    const inspected = submission.normalizeProjectSubmissionInspection({
        valid: true,
        ...shared(),
        format: 'ck-project-package',
        kind: 'project-submission',
        generatedBy: { product: 'CK Desktop', version: '1.0.0', component: 'project-submission-exporter' },
        generatedAt: '2026-07-16T00:00:00Z',
        sourceDisclosureAcknowledged: false,
    });
    assert.equal(inspected.valid, true);
    assert.equal(inspected.integrityVerified, true);
    assert.equal(inspected.publisherIdentityVerified, false);
    assert.equal(inspected.summary.fqbn, 'esp32:esp32:esp32c6:FlashSize=16M');
    assert.match(inspected.authenticityMessage, /未包含发布者身份签名/);
});

test('rejects unknown schema, network/upload claims and forged identity verification', () => {
    const base = {
        valid: true,
        ...shared(),
        format: 'ck-project-package',
        kind: 'project-submission',
        generatedBy: { product: 'CK Desktop', version: '1.0.0', component: 'project-submission-exporter' },
        generatedAt: '2026-07-16T00:00:00Z',
        sourceDisclosureAcknowledged: false,
    };
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, schemaVersion: 2 }), /schemaVersion/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, networkUsed: true }), /networkUsed/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, uploadPerformed: true }), /uploadPerformed/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, publisherIdentityVerified: true }), /publisherIdentityVerified/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, packageSha256: 'A'.repeat(64) }), /小写 SHA-256/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, packageFileName: '../hidden.ckpkg' }), /packageFileName/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, sourceDisclosureAcknowledged: true }), /源码范围与披露确认/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({ ...base, includedFiles: 4 }), /实际载荷标志/);
    assert.throws(() => submission.normalizeProjectSubmissionInspection({
        ...base,
        hasDependencyLock: true,
        includedFiles: 4,
        summary: { ...base.summary, dependencyLockAvailable: false },
    }), /依赖锁不可用/);
});

test('uses only the two local Tauri commands and requires explicit source acknowledgement', async () => {
    const calls = [];
    globalThis.__CK_PROJECT_SUBMISSION_INVOKE__ = async (command, args) => {
        calls.push({ command, args });
        if (command === 'export_project_submission') {
            return { outputPath: args.request.outputPath, ...shared() };
        }
        return {
            valid: true,
            ...shared(),
            format: 'ck-project-package',
            kind: 'project-submission',
            generatedBy: { product: 'CK Desktop', version: '1.0.0', component: 'project-submission-exporter' },
            generatedAt: '2026-07-16T00:00:00Z',
            sourceDisclosureAcknowledged: false,
        };
    };
    try {
        await assert.rejects(
            () => submission.exportProjectSubmission({
                outputPath: 'C:\\tmp\\project', sourceScope: 'generated_source',
                sourceDisclosureAcknowledged: false, report: {}, includeBuildEvidence: false,
            }),
            /确认敏感信息/,
        );
        const exported = await submission.exportProjectSubmission({
            outputPath: 'C:\\tmp\\project', sourceScope: 'no_source',
            sourceDisclosureAcknowledged: false, report: {}, includeBuildEvidence: true,
        });
        assert.equal(exported.outputPath, 'C:\\tmp\\project.ckpkg');
        assert.equal(calls[0].command, 'export_project_submission');
        assert.deepEqual(Object.keys(calls[0].args), ['request']);

        const inspected = await submission.inspectProjectSubmission('C:\\tmp\\project.ckpkg');
        assert.equal(inspected.valid, true);
        assert.deepEqual(calls[1], {
            command: 'inspect_project_submission',
            args: { path: 'C:\\tmp\\project.ckpkg' },
        });
        assert.equal(calls.some(call => /http|network|upload/i.test(call.command)), false);
    } finally {
        delete globalThis.__CK_PROJECT_SUBMISSION_INVOKE__;
    }
});

test('does not accept a normal ZIP name as a project submission', () => {
    assert.equal(submission.ensureProjectSubmissionPath('C:\\tmp\\project'), 'C:\\tmp\\project.ckpkg');
    assert.throws(() => submission.ensureProjectSubmissionPath('C:\\tmp\\project.zip'), /不是普通 ZIP/);
});
