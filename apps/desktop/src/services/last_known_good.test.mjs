import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./last_known_good.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'last_known_good.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'last_known_good.ts should transpile without syntax errors');

const domain = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    LAST_KNOWN_GOOD_SCHEMA_ID,
    LAST_KNOWN_GOOD_SCHEMA_VERSION,
    LAST_KNOWN_GOOD_UPLOAD_GATE,
    calculateLastKnownGoodRestorePlan,
    captureLastKnownGoodFromExistingEvidence,
    comparableStateFromLastKnownGood,
    createLastKnownGoodDiffReport,
    migrateLastKnownGoodSnapshot,
    serializeLastKnownGoodSnapshot,
    validateLastKnownGoodSnapshot,
} = domain;

const H = {
    workspace: '1'.repeat(64),
    source: '2'.repeat(64),
    ckLock: '3'.repeat(64),
    partition: '4'.repeat(64),
    bootloader: '5'.repeat(64),
    table: '6'.repeat(64),
    bootApp: '7'.repeat(64),
    app: '8'.repeat(64),
    filesystem: '9'.repeat(64),
    device: 'a'.repeat(64),
    changed: 'b'.repeat(64),
};

const FQBN = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled';
const CREATED_AT = '2026-07-13T01:00:00.000Z';
const UPLOADED_AT = '2026-07-13T01:02:00.000Z';
const CONFIRMED_AT = '2026-07-13T01:03:00.000Z';

const metric = (usedBytes, totalBytes) => ({
    usedBytes,
    totalBytes,
    freeBytes: totalBytes - usedBytes,
    percent: (usedBytes / totalBytes) * 100,
    reportedPercent: Math.floor((usedBytes / totalBytes) * 100),
    level: 'normal',
});

const manifestArtifacts = () => [
    { role: 'esp32-bootloader', relativePath: 'demo.ino.bootloader.bin', address: '0x0', sizeBytes: 20_224, sha256: H.bootloader },
    { role: 'esp32-partition-table', relativePath: 'demo.ino.partitions.bin', address: '0x8000', sizeBytes: 3_072, sha256: H.table },
    { role: 'esp32-boot-app', relativePath: 'boot_app0.bin', address: '0xe000', sizeBytes: 8_192, sha256: H.bootApp },
    { role: 'esp32-application', relativePath: 'demo.ino.bin', address: '0x10000', sizeBytes: 930_748, sha256: H.app },
    { role: 'esp32-filesystem', relativePath: 'demo.ino.fatfs.bin', address: '0x410000', sizeBytes: 65_536, sha256: H.filesystem },
];

const captureInput = () => ({
    recordId: 'lkg-c6-demo-001',
    createdAt: CREATED_AT,
    checkpoint: {
        projectPath: 'C:/Projects/c6-demo.maker',
        projectName: 'c6-demo',
        workspaceJson: '{"blocks":{"blocks":[{"type":"serial_println"}]}}',
        code: '#include <WiFi.h>\nvoid setup() {}\nvoid loop() {}\n',
        blockCount: 1,
    },
    workspaceSha256: H.workspace,
    sourceSha256: H.source,
    ckLock: {
        state: 'captured',
        schemaVersion: 1,
        content: '{"schema_version":1,"certification_status":"device_verified"}',
        sha256: H.ckLock,
    },
    compileEnvironment: {
        schemaVersion: 1,
        capturedAt: CREATED_AT,
        fqbn: FQBN,
        coreId: 'esp32:esp32',
        coreVersion: '3.3.6',
        codeFingerprint: H.source,
        includeHeaders: ['wifi.h'],
        profile: 'quick-fast',
        buildSignature: 'build-signature-c6-o1',
        cliVersion: 'arduino-cli 0.35.0',
        toolchainKey: 'esp32-3.3.6-riscv32-esp-elf-gcc-14.2.0',
    },
    optimization: {
        profile: 'quick-fast',
        level: '-O1',
        compilerFlags: ['-O1', '-g0', '-fno-lto'],
        debugLevel: '-g0',
        lto: false,
        contract: 'ck-fast-build-contract-v6:O1-final-g0-no-lto-expanded-ccdb-core-deps',
    },
    uploadManifest: {
        schemaVersion: 1,
        canonicalFqbn: FQBN,
        buildSignature: 'build-signature-c6-o1',
        partitionDefinition: { relativePath: 'partitions.csv', sha256: H.partition },
        artifacts: manifestArtifacts(),
    },
    deviceHealth: {
        schemaVersion: 1,
        requestId: 12,
        outcome: 'complete',
        observedAt: '2026-07-13T01:01:00.000Z',
        durationMs: 814,
        target: {
            requestedFqbn: FQBN,
            resolvedFqbn: FQBN,
            buildMcu: 'esp32c6',
            configuredFlashBytes: 16 * 1024 * 1024,
            partitionScheme: 'app3M_fat9M_16MB',
            psramMode: 'enabled',
        },
        device: {
            deviceId: H.device,
            identitySource: 'chip-mac',
            chip: 'ESP32-C6',
            revision: 'v0.1',
            macSuffix: 'A1B2C3',
            portBefore: 'COM12',
            portAfter: 'COM12',
            usb: null,
        },
        memory: { flashBytes: 16 * 1024 * 1024, psramBytes: 8 * 1024 * 1024 },
        checks: [{ id: 'handshake', state: 'pass', certainty: 'certain', title: '握手通过' }],
    },
    resources: {
        schemaVersion: 1,
        fqbn: FQBN,
        requestedFqbn: FQBN,
        capturedAt: CREATED_AT,
        flash: metric(930_748, 3_145_728),
        ram: metric(47_856, 327_680),
        uploaderMemory: null,
    },
    warningCount: 0,
    uploadedAt: UPLOADED_AT,
    usableConfirmedAt: CONFIRMED_AT,
    qualificationEvidence: 'user-confirmed',
});

const makeSnapshot = () => captureLastKnownGoodFromExistingEvidence(captureInput());

test('captures project, ck.lock, complete build/upload identity, hardware, and resources', () => {
    const snapshot = makeSnapshot();
    assert.equal(snapshot.schema, LAST_KNOWN_GOOD_SCHEMA_ID);
    assert.equal(snapshot.schemaVersion, LAST_KNOWN_GOOD_SCHEMA_VERSION);
    assert.equal(snapshot.project.workspace.content.includes('serial_println'), true);
    assert.equal(snapshot.project.generatedSource.sha256, H.source);
    assert.equal(snapshot.ckLock.state, 'captured');
    assert.equal(snapshot.ckLock.sha256, H.ckLock);
    assert.deepEqual(snapshot.build.core, { package: 'esp32:esp32', version: '3.3.6' });
    assert.equal(snapshot.build.canonicalFqbn, FQBN);
    assert.equal(snapshot.build.fqbnOptionsComplete, true);
    assert.equal(snapshot.build.optimization.level, '-O1');
    assert.equal(snapshot.build.partition.sha256, H.partition);
    assert.equal(snapshot.build.firmware.complete, true);
    assert.deepEqual(snapshot.build.firmware.segments.map(item => item.address), [
        '0x0', '0x8000', '0xe000', '0x10000', '0x410000',
    ]);
    assert.equal(snapshot.build.firmware.segments.every(item => item.sha256.length === 64), true);
    assert.equal(snapshot.hardware.chip.value, 'ESP32-C6');
    assert.equal(snapshot.hardware.flashBytes.value, 16 * 1024 * 1024);
    assert.equal(snapshot.hardware.psramBytes.value, 8 * 1024 * 1024);
    assert.equal(snapshot.resources.flash.usedBytes, 930_748);
    assert.equal(snapshot.resources.warningCount, 0);
    assert.equal(snapshot.qualification.evidence, 'user-confirmed');
});

test('captures measured resource usage when the Core exposes no trustworthy capacity', () => {
    const input = captureInput();
    input.resources.flash = {
        usedBytes: 267_569,
        totalBytes: 0,
        freeBytes: 0,
        percent: 0,
        reportedPercent: null,
        level: 'normal',
        capacityKnown: false,
    };

    const snapshot = captureLastKnownGoodFromExistingEvidence(input);
    assert.equal(snapshot.resources.flash.state, 'reported');
    assert.equal(snapshot.resources.flash.usedBytes, 267_569);
    assert.equal(snapshot.resources.flash.totalBytes, null);
    assert.equal(validateLastKnownGoodSnapshot(snapshot).valid, true);
});

test('capture rejects evidence from another FQBN or build signature', () => {
    const wrongFqbn = captureInput();
    wrongFqbn.resources.fqbn = 'esp32:esp32:esp32c6:FlashSize=8M';
    assert.throws(() => captureLastKnownGoodFromExistingEvidence(wrongFqbn), /资源统计来自其他构建目标/);

    const wrongSignature = captureInput();
    wrongSignature.uploadManifest.buildSignature = 'other-signature';
    assert.throws(() => captureLastKnownGoodFromExistingEvidence(wrongSignature), /构建签名与上传产物清单不一致/);
});

test('strict validation rejects incomplete options, partial segments, duplicate addresses, and missing ESP32 partition', () => {
    const damaged = structuredClone(makeSnapshot());
    damaged.build.fqbnOptionsComplete = false;
    damaged.build.firmware.complete = false;
    damaged.build.firmware.segments[1].address = '0x0';
    damaged.build.partition = { state: 'not-applicable', reason: 'removed' };
    const result = validateLastKnownGoodSnapshot(damaged);
    assert.equal(result.valid, false);
    const codes = new Set(result.issues.map(item => item.code));
    assert.equal(codes.has('incomplete-fqbn-options'), true);
    assert.equal(codes.has('partial-firmware-set'), true);
    assert.equal(codes.has('duplicate-segment-address'), true);
    assert.equal(codes.has('esp32-partition-required'), true);
});

test('validation preserves explicit unknown PSRAM without guessing a zero capacity', () => {
    const snapshot = structuredClone(makeSnapshot());
    snapshot.hardware.psramBytes = { state: 'not-reported' };
    const result = validateLastKnownGoodSnapshot(snapshot);
    assert.equal(result.valid, true);
    assert.deepEqual(result.snapshot.hardware.psramBytes, { state: 'not-reported' });
});

test('migrates the bounded v0 contract and canonicalizes numeric segment addresses', () => {
    const current = makeSnapshot();
    const legacy = {
        schemaVersion: 0,
        recordId: current.recordId,
        createdAt: current.createdAt,
        projectPath: current.project.path,
        projectName: current.project.name,
        workspaceJson: current.project.workspace.content,
        workspaceSha256: current.project.workspace.sha256,
        code: current.project.generatedSource.content,
        sourceSha256: current.project.generatedSource.sha256,
        blockCount: current.project.blockCount,
        ckLockJson: current.ckLock.content,
        ckLockSchemaVersion: current.ckLock.schemaVersion,
        ckLockSha256: current.ckLock.sha256,
        coreId: current.build.core.package,
        coreVersion: current.build.core.version,
        cliVersion: current.build.cliVersion,
        toolchainKey: current.build.toolchainKey,
        fqbn: current.build.canonicalFqbn,
        fqbnOptionsComplete: true,
        optimization: current.build.optimization,
        partitionPath: current.build.partition.relativePath,
        partitionSha256: current.build.partition.sha256,
        buildSignature: current.build.buildSignature,
        artifactSetComplete: true,
        manifestSchemaVersion: current.build.firmware.manifestSchemaVersion,
        artifacts: current.build.firmware.segments.map(item => ({
            ...item,
            path: item.relativePath,
            relativePath: undefined,
            address: Number.parseInt(item.address.slice(2), 16),
        })),
        hardware: {
            observedAt: current.hardware.observedAt,
            deviceIdSha256: current.hardware.deviceIdSha256,
            chip: current.hardware.chip.value,
            flashBytes: current.hardware.flashBytes.value,
            psramBytes: current.hardware.psramBytes.value,
        },
        resources: {
            flash: current.resources.flash,
            ram: current.resources.ram,
            warningCount: current.resources.warningCount,
            measuredAt: current.resources.measuredAt,
        },
        uploadedAt: current.qualification.uploadedAt,
        usableConfirmedAt: current.qualification.usableConfirmedAt,
        qualificationEvidence: current.qualification.evidence,
    };
    const migrated = migrateLastKnownGoodSnapshot(legacy);
    assert.equal(migrated.valid, true);
    assert.equal(migrated.migratedFromVersion, 0);
    assert.equal(migrated.snapshot.schemaVersion, 1);
    assert.equal(migrated.snapshot.build.firmware.segments[3].address, '0x10000');
});

test('rejects unknown future schemas instead of attempting a lossy downgrade', () => {
    const future = { ...makeSnapshot(), schemaVersion: 99 };
    const result = validateLastKnownGoodSnapshot(future);
    assert.equal(result.valid, false);
    assert.equal(result.issues[0].code, 'unsupported-schema-version');
});

test('stable serialization is deterministic and round-trips through validation', () => {
    const snapshot = makeSnapshot();
    const first = serializeLastKnownGoodSnapshot(snapshot);
    const unordered = Object.fromEntries(Object.entries(snapshot).reverse());
    const second = serializeLastKnownGoodSnapshot(unordered);
    assert.equal(first, second);
    assert.equal(first.endsWith('\n'), true);
    const parsed = validateLastKnownGoodSnapshot(first);
    assert.equal(parsed.valid, true);
    assert.deepEqual(parsed.snapshot, snapshot);
});

test('Chinese diff covers project/source, ck.lock, build, every firmware segment, hardware, resources, and warnings', () => {
    const snapshot = makeSnapshot();
    const current = comparableStateFromLastKnownGood(snapshot);
    current.project.workspaceSha256 = H.changed;
    current.project.sourceSha256 = H.changed;
    current.ckLock.sha256 = H.changed;
    current.build.core.version = '3.4.0';
    current.build.cliVersion = 'arduino-cli 1.2.0';
    current.build.toolchainKey = 'different-toolchain';
    current.build.canonicalFqbn = 'esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=default';
    current.build.optimization.level = '-Os';
    current.build.optimization.compilerFlags = ['-Os'];
    current.build.partition.sha256 = H.changed;
    current.build.buildSignature = 'different-build-signature';
    current.artifacts.segments[3].sha256 = H.changed;
    current.hardware.chip = { state: 'reported', value: 'ESP32-C5' };
    current.hardware.flashBytes = { state: 'reported', value: 8 * 1024 * 1024 };
    current.hardware.psramBytes = { state: 'not-reported' };
    current.resources.flash.usedBytes += 4096;
    current.resources.ram.usedBytes += 512;
    current.resources.warningCount = 3;

    const report = createLastKnownGoodDiffReport(snapshot, current);
    assert.equal(report.identical, false);
    const fields = new Set(report.changes.map(item => item.field));
    for (const field of [
        'workspace', 'source', 'ck-lock', 'core', 'cli-version', 'toolchain', 'fqbn',
        'optimization', 'partition', 'build-signature', 'artifact-set',
        'hardware-chip-placeholder',
    ]) {
        if (field === 'hardware-chip-placeholder') continue;
        assert.equal(fields.has(field), true, `missing diff field ${field}`);
    }
    assert.equal(fields.has('chip'), true);
    assert.equal(fields.has('flash'), true);
    assert.equal(fields.has('psram'), true);
    assert.equal(fields.has('flash-usage'), true);
    assert.equal(fields.has('ram-usage'), true);
    assert.equal(fields.has('warning-count'), true);
    assert.equal(report.changes.some(item => item.field === 'segment:esp32-application@0x10000'), true);
    assert.match(report.lines.join('\n'), /积木工程内容已变化/);
    assert.match(report.lines.join('\n'), /构建签名已变化/);
    assert.equal(report.lines.join('\n').includes(snapshot.project.workspace.content), false, 'diff must not echo project secrets/content');
});

test('firmware restore plan is ready only through the existing upload gate', () => {
    const snapshot = makeSnapshot();
    const current = comparableStateFromLastKnownGood(snapshot);
    const plan = calculateLastKnownGoodRestorePlan(snapshot, {
        current,
        stagedArtifacts: structuredClone(snapshot.build.firmware),
        existingUploadGateAvailable: true,
        canCreateSafetyCheckpoint: true,
    }, 'firmware');
    assert.equal(plan.canProceed, true);
    assert.equal(plan.uploadPolicy.required, true);
    assert.equal(plan.uploadPolicy.gate, LAST_KNOWN_GOOD_UPLOAD_GATE);
    assert.equal(plan.uploadPolicy.allowDirectArtifactWrite, false);
    assert.equal(plan.uploadPolicy.requireArtifactManifestValidation, true);
    const gate = plan.steps.find(step => step.id === 'existing-upload-gate');
    assert.ok(gate);
    assert.equal(gate.required, true);
    assert.match(gate.description, /禁止直接调用烧录工具或写 Flash/);
});

test('firmware restore blocks a missing gate, stale artifact, and hardware mismatch', () => {
    const snapshot = makeSnapshot();
    const current = comparableStateFromLastKnownGood(snapshot);
    current.hardware.flashBytes = { state: 'reported', value: 8 * 1024 * 1024 };
    const staged = structuredClone(snapshot.build.firmware);
    staged.segments[0].sha256 = H.changed;
    const plan = calculateLastKnownGoodRestorePlan(snapshot, {
        current,
        stagedArtifacts: staged,
        existingUploadGateAvailable: false,
        canCreateSafetyCheckpoint: true,
    }, 'firmware');
    assert.equal(plan.canProceed, false);
    assert.equal(plan.blockers.some(item => item.includes('上传门禁不可用')), true);
    assert.equal(plan.blockers.some(item => item.includes('烧录段地址、大小或 SHA-256 不一致')), true);
    assert.equal(plan.blockers.some(item => item.includes('实体 Flash 与上一个可用版本不一致')), true);
    assert.equal(plan.steps.find(step => step.id === 'existing-upload-gate').blocked, true);
});

test('project-only restore requires a safety checkpoint but never requires upload', () => {
    const snapshot = makeSnapshot();
    const current = {};
    const ready = calculateLastKnownGoodRestorePlan(snapshot, {
        current,
        stagedArtifacts: null,
        existingUploadGateAvailable: false,
        canCreateSafetyCheckpoint: true,
    }, 'project');
    assert.equal(ready.canProceed, true);
    assert.equal(ready.uploadPolicy.required, false);
    assert.equal(ready.uploadPolicy.allowDirectArtifactWrite, false);
    assert.equal(ready.steps.some(step => step.id === 'existing-upload-gate'), false);

    const blocked = calculateLastKnownGoodRestorePlan(snapshot, {
        current,
        stagedArtifacts: null,
        existingUploadGateAvailable: false,
        canCreateSafetyCheckpoint: false,
    }, 'project');
    assert.equal(blocked.canProceed, false);
    assert.equal(blocked.blockers.some(item => item.includes('恢复前保护检查点')), true);
});

test('complete restore combines project protection with the mandatory gated firmware path', () => {
    const snapshot = makeSnapshot();
    const current = comparableStateFromLastKnownGood(snapshot);
    const plan = calculateLastKnownGoodRestorePlan(snapshot, {
        current,
        stagedArtifacts: structuredClone(snapshot.build.firmware),
        existingUploadGateAvailable: true,
        canCreateSafetyCheckpoint: true,
    }, 'complete');
    assert.equal(plan.canProceed, true);
    assert.equal(plan.steps.some(step => step.id === 'create-safety-checkpoint'), true);
    assert.equal(plan.steps.some(step => step.id === 'restore-project-content'), true);
    assert.equal(plan.steps.some(step => step.id === 'revalidate-hardware'), true);
    assert.equal(plan.steps.some(step => step.id === 'existing-upload-gate'), true);
    assert.equal(plan.uploadPolicy.required, true);
});
