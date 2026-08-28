import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const compile = (source, fileName) => {
    const output = ts.transpileModule(source, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2021,
        },
        fileName,
        reportDiagnostics: true,
    });
    assert.deepEqual(
        (output.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
        [],
    );
    return output.outputText;
};

const growthSource = await readFile(new URL('./resource_growth.ts', import.meta.url), 'utf8');
const growthUrl = `data:text/javascript;base64,${Buffer.from(compile(growthSource, 'resource_growth.ts')).toString('base64')}`;
const reportSource = (await readFile(new URL('./project_acceptance_report.ts', import.meta.url), 'utf8'))
    .replace("from './resource_growth';", `from '${growthUrl}';`);
const reportModule = await import(
    `data:text/javascript;base64,${Buffer.from(compile(reportSource, 'project_acceptance_report.ts')).toString('base64')}`
);

const {
    createBoardPassportHealthCheck,
    createProjectAcceptanceReport,
    createProjectHealthChecklist,
    projectAcceptanceReportToHtml,
} = reportModule;

const hash = async value => {
    const digest = await crypto.subtle.digest('SHA-256', new TextEncoder().encode(value));
    return Buffer.from(digest).toString('hex');
};
const workspaceJson = '{"blocks":{"blocks":[{"type":"controls_repeat_ext","next":{"block":{"type":"io_digital_write"}}}]}}';
const generatedCode = 'const char* password = "secret";';
const workspaceSha256 = await hash(workspaceJson);
const generatedCodeSha256 = await hash(generatedCode);

const projectBuildEvidence = {
    schemaVersion: 1,
    runId: 'compile-run-current',
    kind: 'compile',
    boardPackageId: 'builtin:esp32c6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    coreId: 'esp32:esp32',
    coreVersion: '3.3.6',
    workspaceSha256,
    generatedCodeSha256,
    recordedAt: '2026-07-16T01:00:00Z',
};

const compileDoctor = {
    success: true,
    status: 'healthy',
    summary: '编译链路正常',
    profile: 'quick-fast',
    totalMs: 1234,
    recordedAt: '2026-07-16T01:00:00Z',
    diagnostics: {
        fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
        resources: { warningCount: 1, evidenceComplete: true },
    },
    projectBuildEvidence,
};

const resources = {
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    recordedAt: '2026-07-16T01:00:00Z',
    flash: {
        usedBytes: 400000, totalBytes: 1000000, freeBytes: 600000, percent: 40,
        reportedPercent: 40, level: 'normal', deltaBytes: 12000,
        deltaPercentagePoints: 1.2, baselineCapacityChanged: false,
    },
    ram: {
        usedBytes: 50000, totalBytes: 320000, freeBytes: 270000, percent: 15.625,
        reportedPercent: 15, level: 'normal', deltaBytes: 200,
        deltaPercentagePoints: 0.0625, baselineCapacityChanged: false,
    },
    uploaderMemory: null,
    projectBuildEvidence,
};

const lastWorking = {
    id: 'baseline-1',
    verifiedAt: '2026-07-16T00:30:00Z',
    environment: {
        fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
        coreId: 'esp32:esp32',
        coreVersion: '3.3.6',
    },
    project: {
        board: 'esp32:esp32:esp32c6',
        boardPackageId: 'builtin:esp32c6',
        workspaceSha256,
        generatedCodeSha256,
    },
    lock: {
        sha256: 'a'.repeat(64),
        dependencies: [{
            name: 'FastLED', version: '3.9.0', contentSha256: 'b'.repeat(64),
        }],
    },
    resources: { warningCount: 2 },
};

const baseInput = {
    projectName: '<天气站>',
    projectPath: 'C:/Users/Alice/secret.maker',
    workspaceJson,
    generatedCode,
    currentWorkspaceSha256: workspaceSha256,
    currentGeneratedCodeSha256: generatedCodeSha256,
    blockCount: 12,
    boardName: 'ESP32-C6',
    boardId: 'esp32c6',
    boardPackageId: 'builtin:esp32c6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
    coreId: 'esp32:esp32',
    coreVersion: '3.3.6',
    boardPackage: {
        id: 'builtin:esp32c6',
        fqbn: 'esp32:esp32:esp32c6',
        fqbn_base: 'esp32:esp32:esp32c6',
        passport: {
            generated_at: '2026-07-16T00:00:00Z',
            source_package_sha256: 'c'.repeat(64),
            source_content_sha256: 'd'.repeat(64),
            installed_content_sha256: 'e'.repeat(64),
            menu_schema_sha256: 'f'.repeat(64),
            certification_status: 'compile_certified',
            invalidated_reasons: [],
            board: { id: 'builtin:esp32c6', fqbn_base: 'esp32:esp32:esp32c6' },
            core: { package: 'esp32:esp32', installed_version: '3.3.6', usable: true },
            profiles: [{
                fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
                status: 'compile_passed',
                checked_at: '2026-07-16T00:10:00Z',
                core_version: '3.3.6',
                toolchain_key: 'toolchain-current',
                installed_content_sha256: 'e'.repeat(64),
                evidence: {
                    kind: 'compile-result',
                    stage: 'compile',
                    canonical_fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
                },
            }],
        },
    },
    compileDoctorReport: compileDoctor,
    compileResourceReport: resources,
    deviceHealthReport: null,
    pinPreflightReport: {
        status: 'ready', boardFqbn: 'esp32:esp32:esp32c6:FlashSize=16M', canCompile: true,
        usages: [], blockers: [], warnings: [],
    },
    lastWorkingVersion: lastWorking,
    checkpoints: [{ id: 'cp1', createdAt: '2026-07-16T00:40:00Z' }],
};

test('board passport exposes four exact-target stages without inventing device verification', () => {
    const check = createBoardPassportHealthCheck(baseInput, '2026-07-16T02:00:00Z');
    assert.equal(check.id, 'board-passport');
    assert.equal(check.state, 'info');
    assert.deepEqual(check.stages.map(stage => [stage.id, stage.state]), [
        ['structure', 'pass'],
        ['environment', 'pass'],
        ['compile', 'pass'],
        ['device', 'info'],
    ]);
    assert.match(check.stages.find(stage => stage.id === 'device').detail, /不会自动冒充|不会.*真板认证/);
});

test('a dedicated device-result may complete the passport but does not claim per-block hardware testing', () => {
    const profile = baseInput.boardPackage.passport.profiles[0];
    const check = createBoardPassportHealthCheck({
        ...baseInput,
        boardPackage: {
            ...baseInput.boardPackage,
            passport: {
                ...baseInput.boardPackage.passport,
                certification_status: 'device_verified',
                profiles: [{
                    ...profile,
                    status: 'device_verified',
                    evidence: {
                        kind: 'device-result',
                        stage: 'device',
                        canonical_fqbn: baseInput.fqbn,
                    },
                }],
            },
        },
    }, '2026-07-16T02:00:00Z');
    assert.equal(check.state, 'pass');
    assert.equal(check.stages.every(stage => stage.state === 'pass'), true);
    assert.match(check.stages.find(stage => stage.id === 'device').detail, /不扩展为积木或外设逐项真机验证/);
});

test('package, complete FQBN, Core version and validity changes invalidate every green passport stage', () => {
    const variants = [
        { boardPackageId: 'another-package' },
        { fqbn: 'esp32:esp32:esp32c6:FlashSize=8M' },
        { coreVersion: '3.3.7' },
        {
            boardPackage: {
                ...baseInput.boardPackage,
                passport: {
                    ...baseInput.boardPackage.passport,
                    certification_status: 'expired',
                    invalidated_reasons: ['toolchain_changed'],
                },
            },
        },
        {
            boardPackage: {
                ...baseInput.boardPackage,
                passport: {
                    ...baseInput.boardPackage.passport,
                    valid_until: '2026-07-16T01:00:00Z',
                },
            },
        },
    ];
    for (const change of variants) {
        const check = createBoardPassportHealthCheck({ ...baseInput, ...change }, '2026-07-16T02:00:00Z');
        assert.notEqual(check.state, 'pass');
        assert.equal(check.stages.some(stage => stage.state === 'pass'), false);
    }
});

test('profile Core mismatch or future-dated evidence cannot certify compile or device stages', () => {
    for (const profileChange of [
        { core_version: '3.3.5' },
        { checked_at: '2099-01-01T00:00:00Z' },
    ]) {
        const check = createBoardPassportHealthCheck({
            ...baseInput,
            boardPackage: {
                ...baseInput.boardPackage,
                passport: {
                    ...baseInput.boardPackage.passport,
                    profiles: [{
                        ...baseInput.boardPackage.passport.profiles[0],
                        ...profileChange,
                    }],
                },
            },
        }, '2026-07-16T02:00:00Z');
        assert.notEqual(check.stages.find(stage => stage.id === 'compile').state, 'pass');
        assert.notEqual(check.stages.find(stage => stage.id === 'device').state, 'pass');
    }
});

test('missing passport stays pending at all four levels', () => {
    const check = createBoardPassportHealthCheck({
        ...baseInput,
        boardPackage: { ...baseInput.boardPackage, passport: undefined },
    }, '2026-07-16T02:00:00Z');
    assert.equal(check.state, 'info');
    assert.equal(check.evidence, null);
    assert.equal(check.stages.length, 4);
    assert.equal(check.stages.every(stage => stage.state === 'info'), true);
});

test('health checklist uses explicit items and never produces a numeric score', () => {
    const checklist = createProjectHealthChecklist(baseInput);
    assert.ok(checklist.checks.length >= 8);
    assert.equal(checklist.counts.error, 0);
    assert.equal(checklist.counts.pass > 0, true);
    assert.doesNotMatch(JSON.stringify(checklist), /score|得分|\b\d{1,3}\s*分\b/i);
    assert.match(
        checklist.checks.find(item => item.id === 'project-checkpoints').detail,
        /不是修改次数/,
    );
    assert.equal(
        checklist.checks.find(item => item.id === 'device-health').state,
        'info',
        'missing hardware evidence must not become a pass',
    );
});

test('report is structured, content-addressed, private by default, and honest about history', async () => {
    const report = await createProjectAcceptanceReport(baseInput, '2026-07-16T02:00:00Z');
    assert.equal(report.schemaVersion, 1);
    assert.equal(report.kind, 'ck-project-acceptance-report');
    assert.match(report.project.workspaceSha256, /^[0-9a-f]{64}$/);
    assert.match(report.project.generatedCodeSha256, /^[0-9a-f]{64}$/);
    assert.equal(report.project.pathIncluded, false);
    assert.equal(report.hardware.identityIncluded, false);
    assert.equal(report.history.modificationCount, null);
    assert.equal(report.dependencies.lockAvailable, true);
    assert.equal(report.dependencies.allVersioned, true);
    assert.equal(report.build.warningCount, 1);
    assert.equal(report.build.resourceGrowth.status, 'total-only');

    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /C:\/Users\/Alice|password|secret\.maker/);
    assert.match(serialized, /未启用逐操作审计历史/);
    assert.equal(report.project.structure.topLevelFlowCount, 1);
    assert.deepEqual(report.project.structure.blockTypes, [
        { type: 'controls_repeat_ext', count: 1 },
        { type: 'io_digital_write', count: 1 },
    ]);
});

test('after switching boards, old compile/resource evidence cannot redefine the new report target', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        fqbn: 'esp32:esp32:esp32s3:FlashSize=8M',
        boardPackageId: 'builtin:esp32s3',
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.target.fqbn, 'esp32:esp32:esp32s3:FlashSize=8M');
    assert.equal(report.target.boardPackageId, 'builtin:esp32s3');
    assert.equal(report.build.state, 'unverified-target');
    assert.equal(report.build.flashUsedBytes, null);
    assert.equal(report.build.warningCount, null);
    assert.equal(report.dependencies.lockAvailable, false);
    assert.deepEqual(report.dependencies.entries, []);
    assert.equal(report.health.checks.find(item => item.id === 'compile-result').state, 'warning');
    assert.equal(report.health.checks.find(item => item.id === 'resource-budget').state, 'info');
});

test('a changed workspace invalidates the last-working dependency lock', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        workspaceJson: '{"blocks":{"blocks":[]}}',
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.dependencies.lockAvailable, false);
    assert.equal(report.build.state, 'unverified-target');
    assert.equal(report.build.flashUsedBytes, null);
    assert.equal(report.build.ramUsedBytes, null);
    assert.equal(report.health.checks.find(item => item.id === 'compile-result').state, 'warning');
    assert.equal(report.health.checks.find(item => item.id === 'resource-budget').state, 'info');
    assert.equal(report.health.checks.find(item => item.id === 'last-working-version').state, 'warning');
});

test('same FQBN cannot reuse compile or resources after Core changes', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        coreVersion: '3.3.7',
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.build.state, 'unverified-target');
    assert.equal(report.build.flashUsedBytes, null);
    assert.equal(report.build.ramUsedBytes, null);
    assert.equal(report.health.checks.find(item => item.id === 'compile-result').state, 'warning');
    assert.equal(report.health.checks.find(item => item.id === 'resource-budget').state, 'info');
});

test('resource evidence from a different async run is rejected even for identical source and target', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        compileResourceReport: {
            ...resources,
            projectBuildEvidence: {
                ...projectBuildEvidence,
                runId: 'expired-async-run',
            },
        },
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.build.state, 'passed');
    assert.equal(report.build.flashUsedBytes, null);
    assert.equal(report.build.ramUsedBytes, null);
    assert.equal(report.health.checks.find(item => item.id === 'resource-budget').state, 'info');
});

test('a matching lock with zero third-party dependencies is a valid complete empty set', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        lastWorkingVersion: {
            ...lastWorking,
            lock: { ...lastWorking.lock, dependencies: [] },
        },
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.dependencies.lockAvailable, true);
    assert.equal(report.dependencies.allVersioned, true);
    assert.equal(report.health.checks.find(item => item.id === 'dependency-lock').state, 'pass');
});

test('sanitizes optional circuit and test notes before JSON and HTML export', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        notes: {
            circuitDescription: '原理图 C:\\Users\\Alice\\secret\\board.png，MAC AA:BB:CC:DD:EE:FF',
            testRecords: 'SSID: MyLab; password=12345678 测试通过',
        },
    }, '2026-07-16T02:00:00Z');
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /Alice|AA:BB|MyLab|12345678/);
    assert.match(serialized, /本机路径已隐藏/);
    assert.match(serialized, /口令已隐藏/);
});

test('sanitizes Unix, UNC and file URLs plus common identity and token forms', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        notes: {
            circuitDescription: [
                '/Users/alice/private/board.png',
                '/home/bob/secret/wiring.svg',
                String.raw`\\lab-server\private\diagram.pdf`,
                'file:///C:/Users/Carol/private.txt',
                'file:///Users/dave/notes.txt',
            ].join('\n'),
            testRecords: [
                'MAC aabb.ccdd.eeff',
                'raw AABBCCDDEEFF',
                'mail alice@example.com',
                'api_key=sk-live-secret',
                'Authorization: Bearer abc.def-123',
            ].join('\n'),
        },
    }, '2026-07-16T02:00:00Z');
    const serialized = JSON.stringify(report);
    assert.doesNotMatch(serialized, /alice|bob|Carol|dave|lab-server|aabb|AABB|example\.com|sk-live|abc\.def/i);
    assert.match(serialized, /本机路径已隐藏/);
    assert.match(serialized, /MAC 已隐藏/);
    assert.match(serialized, /邮箱已隐藏/);
    assert.match(serialized, /令牌已隐藏/);
});

test('hardware evidence from another complete FQBN is excluded and called out', async () => {
    const oldDevice = {
        schemaVersion: 1,
        requestId: 9,
        outcome: 'complete',
        observedAt: '2026-07-16T01:30:00Z',
        durationMs: 100,
        target: {
            requestedFqbn: 'esp32:esp32:esp32c6:FlashSize=8M',
            resolvedFqbn: 'esp32:esp32:esp32c6:FlashSize=8M',
        },
        device: { chip: 'ESP32-C6', revision: 'v0.1', identitySource: 'chip-mac' },
        memory: { flashBytes: 8 * 1024 * 1024, psramBytes: null },
        checks: [{ id: 'flash', state: 'pass', certainty: 'certain', title: 'Flash 匹配' }],
    };
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        deviceHealthReport: oldDevice,
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.hardware.state, 'not-checked');
    assert.equal(report.hardware.chip, null);
    assert.equal(report.hardware.flashBytes, null);
    assert.equal(report.health.checks.find(item => item.id === 'device-health').state, 'warning');
    assert.match(report.health.checks.find(item => item.id === 'device-health').title, /其他完整 FQBN/);
    assert.equal(report.limitations.some(item => item.includes('esp32c6:FlashSize=8M')), true);
});

test('ordinary device health never upgrades the passport device stage', async () => {
    const report = await createProjectAcceptanceReport({
        ...baseInput,
        deviceHealthReport: {
            schemaVersion: 1,
            requestId: 10,
            outcome: 'complete',
            observedAt: '2026-07-16T01:30:00Z',
            durationMs: 100,
            target: {
                requestedFqbn: baseInput.fqbn,
                resolvedFqbn: baseInput.fqbn,
            },
            device: { chip: 'ESP32-C6', revision: 'v0.1', identitySource: 'chip-mac' },
            memory: { flashBytes: 16 * 1024 * 1024, psramBytes: null },
            checks: [{ id: 'flash', state: 'pass', certainty: 'certain', title: 'Flash 匹配' }],
        },
    }, '2026-07-16T02:00:00Z');
    assert.equal(report.hardware.state, 'verified');
    const passport = report.health.checks.find(item => item.id === 'board-passport');
    assert.equal(passport.stages.find(stage => stage.id === 'device').state, 'info');
    assert.match(passport.stages.find(stage => stage.id === 'device').detail, /不会自动冒充/);
});

test('printable HTML escapes user content and carries report boundaries', async () => {
    const report = await createProjectAcceptanceReport(baseInput, '2026-07-16T02:00:00Z');
    const html = projectAcceptanceReportToHtml(report);
    assert.match(html, /^<!doctype html>/);
    assert.match(html, /@media print/);
    assert.match(html, /&lt;天气站&gt;/);
    assert.doesNotMatch(html, /<天气站>/);
    assert.match(html, /本报告不计算综合分数/);
    assert.match(html, /修改次数：未启用审计/);
    assert.doesNotMatch(html, /password|C:\/Users\/Alice/);
});

test('failed compile and pin blockers stay explicit errors', () => {
    const checklist = createProjectHealthChecklist({
        ...baseInput,
        compileDoctorReport: { ...compileDoctor, success: false, status: 'problem', summary: '编译失败' },
        pinPreflightReport: {
            ...baseInput.pinPreflightReport,
            canCompile: false,
            blockers: [{ id: 'pin-conflict' }],
        },
    });
    assert.equal(checklist.checks.find(item => item.id === 'compile-result').state, 'error');
    assert.equal(checklist.checks.find(item => item.id === 'pin-preflight').state, 'error');
    assert.equal(checklist.counts.error, 2);
});
