import assert from 'node:assert/strict';
import test from 'node:test';
import { createHash, randomUUID } from 'node:crypto';
import {
    mkdtempSync,
    readFileSync,
    rmSync,
    writeFileSync,
} from 'node:fs';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';

const source = await readFile(new URL('./Test-UploadManifestGateNative.ps1', import.meta.url), 'utf8');
const bindingSource = await readFile(new URL('./NativeEvidenceBinding.psm1', import.meta.url), 'utf8');
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];
const harnessNode = embeddedNode.replace(
    /const WebSocket = require\([^\r\n]+\);/,
    'class WebSocket { on() {} send() {} close() {} }',
);
const helpers = new Function(
    'require',
    `${harnessNode}\nreturn { canonicalizeFqbn, replaceFqbnOption, analyzeUploadLog, analyzeHashUploadLog, analyzeOperationLogIdentity, summarizeOperationEvidence, containsFullMac, redactMacs, redactAbsolutePaths, validateManifestAgainstFiles, stageTamperedManifest, stageHashTamperedManifest, restoreOrPreserveManifest, assertBetweenPhaseCacheClear, assertWorkspaceIdentityUnchanged, writeSummary, buildManifestGateOutcomeChecks };`,
)(createRequire(import.meta.url));

const expected = 'esp32:esp32:esp32c5:FlashSize=16M,PSRAM=enabled,PartitionScheme=app3M_fat9M_16MB';
const wrong = 'esp32:esp32:esp32c5:FlashSize=16M,PSRAM=enabled,PartitionScheme=fatflash';

function passingLog() {
    return [
        `[INFO] Target Board: ${expected}`,
        '[INFO] Compile Profile: quick-fast (fast local loop)',
        '[INFO] Reusing cached memory/size summary:',
        `[WARN] Quick-fast upload artifact gate rejected this cache: Upload blocked: artifact manifest FQBN mismatch (built for '${wrong}', selected '${expected}'). Trying shared-fast.`,
        `[INFO] Target Board: ${expected}`,
        '[INFO] Compile Profile: shared-fast (upload-ready artifacts)',
        '[INFO] Full Build: First-time compilation, building all dependencies...',
        '[INFO] Upload Profile: shared-fast (artifact manifest verified)',
        '[INFO] Upload artifact manifest revalidated before transport.',
        'Connecting...',
        '[Timing] Upload transport phase: 21.3s',
        '普通固件上传成功，用时 22.7 秒。',
    ].join('\n');
}

function passingHashLog(staged) {
    return [
        `[INFO] Target Board: ${expected}`,
        '[INFO] Compile Profile: quick-fast (fast local loop)',
        '[INFO] Reusing cached memory/size summary:',
        `[WARN] Quick-fast upload artifact gate rejected this cache: Upload blocked: artifact SHA-256 mismatch for fixture.ino.bin (${staged.artifactRole}) (manifest ${staged.tamperedArtifactSha256}, current ${staged.originalArtifactSha256}). Trying shared-fast.`,
        `[INFO] Target Board: ${expected}`,
        '[INFO] Compile Profile: shared-fast (upload-ready artifacts)',
        '[INFO] Full Build: First-time compilation, building all dependencies...',
        '[INFO] Upload Profile: shared-fast (artifact manifest verified)',
        '[INFO] Upload artifact manifest revalidated before transport.',
        'Connecting...',
        '[Timing] Upload transport phase: 21.3s',
        '普通固件上传成功，用时 22.7 秒。',
    ].join('\n');
}

function sha256(bytes) {
    return createHash('sha256').update(bytes).digest('hex');
}

function createManifestFixture() {
    const buildPath = mkdtempSync(path.join(tmpdir(), `ck-manifest-gate-test-${randomUUID()}-`));
    const files = [
        ['esp32-application', 'fixture.ino.bin', '0x10000', Buffer.from('application')],
        ['esp32-boot-app0', 'boot_app0.bin', '0xe000', Buffer.from('boot-app0')],
        ['esp32-bootloader', 'fixture.ino.bootloader.bin', '0x2000', Buffer.from('bootloader')],
        ['esp32-flash-arguments', 'flash_args', null, Buffer.from('0x2000 fixture.ino.bootloader.bin')],
        ['esp32-partition-table', 'fixture.ino.partitions.bin', '0x8000', Buffer.from('partition-table')],
    ];
    const partitionBytes = Buffer.from('nvs,data,nvs,0x9000,0x5000\n');
    writeFileSync(path.join(buildPath, 'partitions.csv'), partitionBytes);
    writeFileSync(path.join(buildPath, 'build.options.json'), JSON.stringify({ fqbn: expected }));
    const artifacts = files.map(([role, relativePath, flashAddress, bytes]) => {
        writeFileSync(path.join(buildPath, relativePath), bytes);
        return {
            path: relativePath,
            role,
            flashAddress,
            size: bytes.length,
            sha256: sha256(bytes),
        };
    });
    const manifest = {
        schemaVersion: 1,
        canonicalFqbn: expected,
        buildSignature: 'a'.repeat(64),
        partitionDefinition: { path: 'partitions.csv', sha256: sha256(partitionBytes) },
        artifacts,
    };
    const manifestPath = path.join(buildPath, '.ck-upload-artifacts.json');
    writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`);
    return { buildPath, manifestPath, manifest };
}

test('PowerShell embeds valid JavaScript and targets the main Tauri page on 9223', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
    assert.match(embeddedNode, /schemaId: 'ck\.native-upload-manifest-gate'/);
    assert.match(source, /\[int\]\$DebugPort = 9223/);
    assert.match(bindingSource, /console=detached/);
    assert.match(source, /CK_CDP_URL/);
});

test('publishes a fail-closed top-level outcome contract for the manifest gate', () => {
    const passing = {
        hashGate: {
            artifactHashMismatchRejected: true,
            transportBlockedUntilHashRejection: true,
            ordinaryUploadSucceeded: true,
        },
        gate: {
            fqbnMismatchRejected: true,
            transportBlockedUntilRejection: true,
            ordinaryUploadSucceeded: true,
        },
        hashProtectedFiles: { unchanged: true },
        protectedFiles: { unchanged: true },
        hashMutation: { firmwareArtifactsModified: false },
        mutation: { firmwareArtifactsModified: false },
        hashRestoration: { completed: true, valid: true, backupRemoved: true, residueRemoved: true },
        restoration: { completed: true, valid: true },
        identity: { unchanged: true, before: {}, after: {} },
        operationEvidence: {
            activeReadyTransitionsComplete: true,
            diskManifestShaChainComplete: true,
            transportChainComplete: true,
        },
    };
    const checks = helpers.buildManifestGateOutcomeChecks(passing);
    assert.equal(checks.length, 6);
    assert.ok(checks.every((check) => check.passed === true));
    assert.ok(helpers.buildManifestGateOutcomeChecks({ ...passing, gate: null })
        .some((check) => check.passed === false));
    assert.match(embeddedNode, /checks:\s*\[\],\s*\n\s*failures:\s*\[\]/);
    assert.match(embeddedNode, /summary\.failures = summary\.checks/);
    assert.match(embeddedNode, /Manifest-gate outcome checks failed/);
});

test('streams the long embedded program over stdin without putting it on the Windows command line', () => {
    assert.match(source, /\$nodeScript\s*\|\s*node\s+-/);
    assert.doesNotMatch(source, /(?:^|\s)node(?:\.exe)?\s+-e\b/im);
    assert.doesNotMatch(source, /WriteAllText\([^\r\n]*\$nodeScript/);
    assert.equal((source.match(/\$nodeScript\s*\|\s*node\s+-/g) || []).length, 1);
});

test('defaults to the exact C5 N16R8 configuration and an explicit JSON artifact', () => {
    assert.match(source, /\[string\]\$Port = 'COM11'/);
    assert.ok(source.includes(`[string]$ExpectedFqbn = '${expected}'`));
    assert.match(source, /\[string\]\$WrongPartitionScheme = 'fatflash'/);
    assert.match(source, /esp32c5-n16r8-manifest-gate\.json/);
});

test('constructs a canonical same-board FQBN that changes only PartitionScheme', () => {
    assert.equal(helpers.canonicalizeFqbn(
        'esp32:esp32:esp32c5:PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled,FlashSize=16M',
    ), expected);
    assert.equal(helpers.replaceFqbnOption(expected, 'PartitionScheme', 'fatflash'), wrong);
    assert.throws(() => helpers.replaceFqbnOption(expected, 'Missing', 'x'), /required option/);
    assert.match(embeddedNode, /optionDelta\.length !== 2/);
    assert.match(embeddedNode, /optionDelta\.every\(\(item\) => item\.startsWith\('PartitionScheme='\)\)/);
});

test('verifies project, exact resolved FQBN, and exact discovered port before compiling or mutation', () => {
    assert.match(embeddedNode, /Refusing to test the wrong open project/);
    assert.match(embeddedNode, /if \(actualFqbn === expectedFqbn\) return actualFqbn/);
    assert.match(embeddedNode, /Board mismatch after waiting for project configuration/);
    assert.match(embeddedNode, /list_serial_ports/);
    assert.match(embeddedNode, /button\.title === \$\{JSON\.stringify\(port\)\}/);
    const projectIndex = embeddedNode.indexOf('summary.project = await ensureWorkspace()');
    const boardIndex = embeddedNode.indexOf('const activeFqbn = await waitForExactBoard()');
    const portIndex = embeddedNode.indexOf('const activePort = await selectAndVerifyPort()');
    const hashStageIndex = embeddedNode.indexOf('stagedHashManifest = stageHashTamperedManifest');
    const fqbnStageIndex = embeddedNode.indexOf('stagedFqbnManifest = stageTamperedManifest');
    assert.ok(projectIndex >= 0 && projectIndex < boardIndex && boardIndex < portIndex && portIndex < hashStageIndex);
    assert.ok(hashStageIndex < fqbnStageIndex, 'hash rejection must complete before the independent FQBN rejection phase');
    assert.match(embeddedNode, /assertUiTargetUnchanged\(summary\.project, expectedFqbn, activePort\)/);
    assert.equal(
        [...embeddedNode.matchAll(/await assertUiTargetUnchanged\(summary\.project, expectedFqbn, activePort\)/g)].length,
        6,
        'target should be rechecked around the two cache resets and both independent manifest mutations',
    );
});

test('captures a stable nonempty source identity before every cache clear or build', () => {
    assert.match(embeddedNode, /data-ck-code-fingerprint/);
    assert.match(embeddedNode, /data-ck-include-signature/);
    assert.match(embeddedNode, /fingerprintAttributePresent/);
    assert.match(embeddedNode, /includeSignatureAttributePresent/);
    assert.match(embeddedNode, /stableSamples >= 2/);
    assert.match(embeddedNode, /summary\.identity\.before = await readStableWorkspaceIdentity/);
    const identityIndex = embeddedNode.indexOf('summary.identity.before = await readStableWorkspaceIdentity');
    const firstCacheClearIndex = embeddedNode.indexOf("invoke('clear_board_compile_cache'");
    const firstBuildIndex = embeddedNode.indexOf('const hashPrime = await primeQuickFast');
    assert.ok(identityIndex >= 0 && identityIndex < firstCacheClearIndex && firstCacheClearIndex < firstBuildIndex);
    assert.match(embeddedNode, /phase: 'after-hash-restoration'/);
    assert.match(embeddedNode, /phase: 'after-fqbn-phase'/);
    assert.match(embeddedNode, /phase: 'after-all-restoration'/);
    assert.match(embeddedNode, /summary\.identity\.after = finalIdentity/);
    assert.match(embeddedNode, /summary\.identity\.unchanged = true/);
});

test('source identity comparison rejects changed source, project, FQBN, port, or include signature', () => {
    const before = {
        project: 'c5_n16r8',
        codeFingerprint: 'fingerprint-a',
        includeSignature: 'wifi.h',
        projectDirty: 'false',
        fqbn: expected,
        port: 'COM11',
    };
    assert.equal(helpers.assertWorkspaceIdentityUnchanged(before, { ...before }, 'fixture'), true);
    for (const [field, value] of [
        ['project', 'another_project'],
        ['codeFingerprint', 'fingerprint-b'],
        ['includeSignature', 'wire.h'],
        ['fqbn', wrong],
        ['port', 'COM12'],
    ]) {
        assert.throws(
            () => helpers.assertWorkspaceIdentityUnchanged(before, { ...before, [field]: value }, 'fixture'),
            new RegExp(`Workspace identity changed at fixture: ${field}`),
        );
    }
    assert.throws(
        () => helpers.assertWorkspaceIdentityUnchanged({ ...before, codeFingerprint: '' }, before, 'fixture'),
        /identity proof is incomplete/,
    );
});

test('published operation evidence requires complete visible transitions and the full disk/transport chain', () => {
    const before = {
        project: 'c5_n16r8',
        codeFingerprint: 'fingerprint-a',
        includeSignature: 'wifi.h',
        fqbn: expected,
        port: 'COM11',
    };
    const operations = [
        'compile', 'compile', 'upload', 'compile', 'compile', 'upload',
    ].map((kind, index) => ({
        kind,
        sourceScope: 'baseline',
        buildRunId: `00000000-0000-4000-8000-${String(index + 1).padStart(12, '0')}`,
        buildEvidenceSchema: 1,
        frozenWorkspaceFingerprint: before.codeFingerprint,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        readyBefore: true,
        activeObserved: true,
        readyAfter: true,
        overlayAbsentAfter: true,
        targetLogCount: 1,
        allTargetFqbnsExact: true,
        selectedPortBefore: before.port,
        selectedPortAfter: before.port,
        identityBefore: { ...before },
        identityAfter: { ...before },
    }));
    const backing = {
        hashMutation: { onlyManifestModified: true, firmwareArtifactsModified: false },
        mutation: { onlyManifestModified: true, firmwareArtifactsModified: false },
        hashProtectedFiles: { unchanged: true },
        protectedFiles: { unchanged: true },
        hashRestoration: { completed: true },
        restoration: { completed: true },
        hashGate: {
            transportBlockedUntilHashRejection: true,
            transportRevalidated: true,
            ordinaryUploadSucceeded: true,
        },
        gate: {
            transportBlockedUntilRejection: true,
            transportRevalidated: true,
            ordinaryUploadSucceeded: true,
        },
    };
    const summary = helpers.summarizeOperationEvidence(operations, before, backing);
    assert.equal(summary.operationCount, 6);
    assert.equal(summary.compileOperationCount, 4);
    assert.equal(summary.uploadOperationCount, 2);
    assert.equal(summary.diskManifestShaChainComplete, true);
    assert.equal(summary.transportChainComplete, true);
    assert.equal(Object.hasOwn(summary.operations[0], 'code'), false);
    assert.throws(
        () => helpers.summarizeOperationEvidence(
            operations.map((item, index) => (index === 1 ? { ...item, activeObserved: false } : item)),
            before,
            backing,
        ),
        /idle-active-ready UI transition/,
    );
    assert.throws(
        () => helpers.summarizeOperationEvidence(operations, before, {
            ...backing,
            gate: { ...backing.gate, transportRevalidated: false },
        }),
        /manifest\/SHA\/disk\/transport chain/,
    );
    assert.doesNotMatch(embeddedNode, /__ckManifestGateInvokeProbe/);
    assert.doesNotMatch(embeddedNode, /__TAURI_INTERNALS__\?*\.invoke\s*=/);
});

test('requires a validated QuickFast Exact Match build inside CK_Builds', () => {
    assert.match(embeddedNode, /Cached build \\\(Exact Match\\\)/);
    assert.match(embeddedNode, /validated existing exact-match manifest/);
    assert.match(embeddedNode, /Refusing build path outside CK_Builds/);
    assert.match(embeddedNode, /endsWith\('_qfast2'\)/);
    assert.match(embeddedNode, /validateManifestAgainstFiles\(buildPath, expectedFqbn\)/);
});

test('cold QuickFast priming uses one reversible delay-only relink and restores source identity', () => {
    const primeStart = embeddedNode.indexOf('async function primeQuickFast');
    const primeEnd = embeddedNode.indexOf('function snapshotProtectedFiles', primeStart);
    assert.ok(primeStart >= 0 && primeEnd > primeStart);
    const prime = embeddedNode.slice(primeStart, primeEnd);

    assert.match(prime, /mutateDelay\(1\)/);
    assert.match(prime, /!\/Full Build:/);
    assert.match(prime, /manifest was deferred for a reason other than missing upload artifacts/);
    assert.match(prime, /waitForSourceIdentityState\(baseline, 'changed'\)/);
    assert.match(prime, /runOperation\('compile', 'transient-cache-prime'\)/);
    assert.match(prime, /Fast Relink path: sketch-only compile/);
    assert.match(prime, /sealed upload-ready artifacts/);
    assert.match(prime, /validateManifestAgainstFiles\(editedBuildPath, expectedFqbn\)/);
    assert.match(prime, /validateManifestAgainstFiles\(restoredBuildPath, expectedFqbn\)/);
    assert.match(prime, /applicationSha\(editedVerified\) === applicationSha\(restoredVerified\)/);
    assert.match(prime, /finally\s*\{[\s\S]*?restoreDelay\(edit\)[\s\S]*?waitForSourceIdentityState\(baseline, 'restored'\)/);
    assert.ok(
        prime.indexOf("waitForSourceIdentityState(baseline, 'restored')")
          < prime.lastIndexOf("runOperation('compile')"),
        'the exact baseline compile must happen only after restoring the source fingerprint',
    );
    assert.match(embeddedNode, /CK_NATIVE_REGRESSION/);
    assert.match(embeddedNode, /data-ck-project-dirty/);
    assert.doesNotMatch(prime, /save_project|save_project_as/);
});

test('every visible build is bound to one unique overlay UUID and frozen source identity', () => {
    for (const attribute of [
        'data-ck-build-evidence-schema',
        'data-ck-build-run-id',
        'data-ck-build-kind',
        'data-ck-build-fqbn',
        'data-ck-build-port',
        'data-ck-build-workspace-fingerprint',
    ]) {
        assert.match(embeddedNode, new RegExp(attribute));
    }
    assert.match(embeddedNode, /validateBuildEvidence\(/);
    assert.match(embeddedNode, /workspaceFingerprint !== identity\.codeFingerprint/);
    assert.match(embeddedNode, /observedBuildRunIds\.has\(evidence\.runId\)/);
    assert.match(embeddedNode, /frozenWorkspaceFingerprint: frozenBuildEvidence\.workspaceFingerprint/);
});

test('operation summary records but strictly bounds the transient cache-prime source edit', () => {
    const before = {
        project: 'c5_n16r8.maker',
        codeFingerprint: 'baseline',
        includeSignature: 'wifi.h',
        projectDirty: 'false',
        fqbn: expected,
        port: 'COM11',
    };
    const makeOperation = (index, kind = 'compile', identity = before, sourceScope = 'baseline') => ({
        kind,
        sourceScope,
        buildRunId: `00000000-0000-4000-8000-${String(index).padStart(12, '0')}`,
        buildEvidenceSchema: 1,
        frozenWorkspaceFingerprint: identity.codeFingerprint,
        startedAt: new Date().toISOString(),
        endedAt: new Date().toISOString(),
        readyBefore: true,
        activeObserved: true,
        readyAfter: true,
        overlayAbsentAfter: true,
        targetLogCount: 1,
        allTargetFqbnsExact: true,
        selectedPortBefore: before.port,
        selectedPortAfter: before.port,
        identityBefore: { ...identity },
        identityAfter: { ...identity },
    });
    const transientIdentity = { ...before, codeFingerprint: 'edited', projectDirty: 'true' };
    const operations = [
        makeOperation(1),
        makeOperation(2, 'compile', transientIdentity, 'transient-cache-prime'),
        makeOperation(3),
        makeOperation(4, 'upload'),
        makeOperation(5),
        makeOperation(6, 'upload'),
    ];
    const backing = {
        hashMutation: { onlyManifestModified: true, firmwareArtifactsModified: false },
        mutation: { onlyManifestModified: true, firmwareArtifactsModified: false },
        hashProtectedFiles: { unchanged: true },
        protectedFiles: { unchanged: true },
        hashRestoration: { completed: true },
        restoration: { completed: true },
        hashGate: { transportBlockedUntilHashRejection: true, transportRevalidated: true, ordinaryUploadSucceeded: true },
        gate: { transportBlockedUntilRejection: true, transportRevalidated: true, ordinaryUploadSucceeded: true },
    };
    const summary = helpers.summarizeOperationEvidence(operations, before, backing);
    assert.equal(summary.operations[1].sourceScope, 'transient-cache-prime');
    assert.throws(
        () => helpers.summarizeOperationEvidence(
            operations.map((item, index) => index === 1
                ? { ...item, identityBefore: { ...transientIdentity, includeSignature: 'spi.h' }, identityAfter: { ...transientIdentity, includeSignature: 'spi.h' } }
                : item),
            before,
            backing,
        ),
        /changed more than the reversible source fingerprint/,
    );
});

test('changes only the intended manifest field and snapshots every protected upload file', () => {
    assert.match(embeddedNode, /mutated\.canonicalFqbn = wrongFqbn/);
    assert.match(embeddedNode, /assertOnlyCanonicalFqbnChanged\(original, mutated, wrongFqbn\)/);
    assert.match(embeddedNode, /a field other than canonicalFqbn changed/);
    assert.match(embeddedNode, /esp32-flash-arguments/);
    assert.match(embeddedNode, /stageHashTamperedManifest/);
    assert.match(embeddedNode, /a field other than the ESP32 application SHA-256 changed/);
    assert.match(embeddedNode, /compareProtectedSnapshots\(hashProtectedBefore, hashProtectedAfter\)/);
    assert.match(embeddedNode, /compareProtectedSnapshots\(fqbnProtectedBefore, protectedAfterRaw\)/);
    assert.doesNotMatch(embeddedNode, /writeFileSync\([^\r\n]*(?:flash_args|partitions\.csv|\.bin)/i);
});

test('uses an external verified backup and always restores or preserves a valid rebuilt manifest', () => {
    assert.match(embeddedNode, /CK_ManifestGateBackups/);
    assert.match(embeddedNode, /External manifest backup verification failed/);
    assert.match(embeddedNode, /installTamperedManifest has not returned yet/);
    assert.match(embeddedNode, /function restoreOrPreserveManifest/);
    assert.match(embeddedNode, /preserved-correct-rebuilt-manifest/);
    assert.match(embeddedNode, /restored-original-manifest/);
    assert.match(embeddedNode, /finally \{\s*if \(stagedHashManifest\)/);
    assert.match(embeddedNode, /if \(stagedFqbnManifest\)/);
    assert.match(embeddedNode, /externalBackupRetained/);
});

test('filesystem fixture restores stale manifest and preserves a separately rebuilt valid manifest', () => {
    const fixture = createManifestFixture();
    try {
        const verified = helpers.validateManifestAgainstFiles(fixture.buildPath, expected);
        const originalHash = verified.manifestHash;
        const staged = helpers.stageTamperedManifest(verified, wrong);
        assert.equal(JSON.parse(readFileSync(fixture.manifestPath, 'utf8')).canonicalFqbn, wrong);
        const restored = helpers.restoreOrPreserveManifest(staged, expected);
        assert.equal(restored.action, 'restored-original-manifest');
        assert.equal(helpers.validateManifestAgainstFiles(fixture.buildPath, expected).manifestHash, originalHash);
        assert.equal(restored.backupRemoved, true);
        assert.equal(restored.residueRemoved, true);

        const hashVerified = helpers.validateManifestAgainstFiles(fixture.buildPath, expected);
        const hashStage = helpers.stageHashTamperedManifest(hashVerified);
        const hashManifest = JSON.parse(readFileSync(fixture.manifestPath, 'utf8'));
        const application = hashManifest.artifacts.find((artifact) => artifact.role === 'esp32-application');
        assert.equal(application.sha256, hashStage.tamperedArtifactSha256);
        assert.notEqual(hashStage.tamperedArtifactSha256, hashStage.originalArtifactSha256);
        const hashRestored = helpers.restoreOrPreserveManifest(hashStage, expected);
        assert.equal(hashRestored.action, 'restored-original-manifest');
        assert.equal(
            helpers.validateManifestAgainstFiles(fixture.buildPath, expected).manifestHash,
            originalHash,
        );

        const secondVerified = helpers.validateManifestAgainstFiles(fixture.buildPath, expected);
        const secondStage = helpers.stageTamperedManifest(secondVerified, wrong);
        writeFileSync(fixture.manifestPath, JSON.stringify(fixture.manifest));
        const preserved = helpers.restoreOrPreserveManifest(secondStage, expected);
        assert.equal(preserved.action, 'preserved-correct-rebuilt-manifest');
        assert.equal(helpers.validateManifestAgainstFiles(fixture.buildPath, expected).manifest.canonicalFqbn, expected);
        assert.notEqual(sha256(readFileSync(fixture.manifestPath)), secondStage.tamperedHash);
    } finally {
        rmSync(fixture.buildPath, { recursive: true, force: true });
    }
});

test('exception cleanup restores the original manifest without mutating Tauri invoke', () => {
    const fixture = createManifestFixture();
    let staged = null;
    let caught = null;
    try {
        const verified = helpers.validateManifestAgainstFiles(fixture.buildPath, expected);
        staged = helpers.stageHashTamperedManifest(verified);
        throw new Error('fixture failure after manifest mutation');
    } catch (error) {
        caught = error;
    } finally {
        if (staged) helpers.restoreOrPreserveManifest(staged, expected);
    }
    try {
        assert.match(String(caught), /fixture failure/);
        assert.equal(helpers.validateManifestAgainstFiles(fixture.buildPath, expected).manifest.canonicalFqbn, expected);
        assert.match(embeddedNode, /finally \{\s*if \(stagedHashManifest\)/);
        assert.doesNotMatch(embeddedNode, /restoreInvokeProbe/);
        assert.match(embeddedNode, /socket\.close\(\)/);
    } finally {
        rmSync(fixture.buildPath, { recursive: true, force: true });
    }
});

test('proves a real artifact SHA-256 mismatch is rejected before recovery transport', () => {
    const staged = {
        artifactRole: 'esp32-application',
        originalArtifactSha256: 'a'.repeat(64),
        tamperedArtifactSha256: '0'.repeat(64),
    };
    const result = helpers.analyzeHashUploadLog(passingHashLog(staged), expected, staged);
    assert.equal(result.artifactHashMismatchRejected, true);
    assert.equal(result.transportBlockedUntilHashRejection, true);
    assert.equal(result.sharedFastManifestVerified, true);
    assert.equal(result.ordinaryUploadSucceeded, true);
    assert.throws(
        () => helpers.analyzeHashUploadLog(
            passingHashLog(staged).replace(staged.tamperedArtifactSha256, '1'.repeat(64)),
            expected,
            staged,
        ),
        /expected artifact SHA-256 manifest mismatch/,
    );
});

test('accepts only rejection before transport, fresh SharedFast sealing, revalidation, then success', () => {
    const result = helpers.analyzeUploadLog(passingLog(), expected, wrong);
    assert.deepEqual({
        exact: result.exactMatchBeforeRejection,
        rejected: result.fqbnMismatchRejected,
        blocked: result.transportBlockedUntilRejection,
        rebuilt: result.sharedFastFreshBuild,
        sealed: result.sharedFastManifestVerified,
        revalidated: result.transportRevalidated,
        uploaded: result.ordinaryUploadSucceeded,
    }, {
        exact: true,
        rejected: true,
        blocked: true,
        rebuilt: true,
        sealed: true,
        revalidated: true,
        uploaded: true,
    });
    assert.throws(() => helpers.analyzeUploadLog(
        `Connecting...\n${passingLog()}`,
        expected,
        wrong,
    ), /Transport began|No transport evidence|QuickFast/);
});

test('rejects Exact Match or Release in the SharedFast recovery segment', () => {
    assert.throws(() => helpers.analyzeUploadLog(
        passingLog().replace('[INFO] Full Build:', 'Cached build (Exact Match)\n[INFO] Full Build:'),
        expected,
        wrong,
    ), /SharedFast recovery reused an Exact Match/);
    assert.throws(() => helpers.analyzeUploadLog(
        passingLog().replace('[INFO] Upload Profile: shared-fast', '[INFO] Falling back to release\n[INFO] Upload Profile: shared-fast'),
        expected,
        wrong,
    ), /specifically through SharedFast/);
});

test('requires a freshly rewritten correct-FQBN SharedFast manifest as sealing evidence', () => {
    assert.match(embeddedNode, /if \(sharedFastBefore\.length\)/);
    assert.match(embeddedNode, /A valid SharedFast cache already exists/);
    assert.match(embeddedNode, /discoverSharedFastManifests\(expectedFqbn\)/);
    assert.match(embeddedNode, /findFreshSharedFastManifest\(before, after, upload\.startedAt\)/);
    assert.match(embeddedNode, /modifiedMs >= uploadStartedAt - 2000/);
    assert.match(embeddedNode, /freshlySealed: true/);
});

test('clears the exact FQBN between independent hash and configuration rejection phases', () => {
    const report = {
        fqbn: expected,
        reset_scope: 'exact-full-fqbn',
        removed_entries: 3,
        removed_bytes: 4096,
        force_rebuild_pending: true,
        ccache_store_preserved: true,
        prebuilt_core_preserved: false,
        force_ccache_recache: true,
    };
    assert.equal(helpers.assertBetweenPhaseCacheClear(report, expected).resetScope, 'exact-full-fqbn');
    assert.throws(
        () => helpers.assertBetweenPhaseCacheClear({ ...report, reset_scope: 'first-project-full-fqbn' }, expected),
        /required reset proof/,
    );
    const hashUploadIndex = embeddedNode.indexOf("const hashUpload = await runOperation('upload')");
    const clearIndexes = [...embeddedNode.matchAll(/invoke\('clear_board_compile_cache'/g)].map((match) => match.index);
    const fqbnStageIndex = embeddedNode.indexOf('stagedFqbnManifest = stageTamperedManifest');
    const firstPrimeIndex = embeddedNode.indexOf('const hashPrime = await primeQuickFast');
    assert.equal(clearIndexes.length, 2, 'each independent gate phase owns an exact-FQBN cache reset');
    assert.ok(clearIndexes[0] < firstPrimeIndex);
    assert.ok(hashUploadIndex >= 0 && hashUploadIndex < clearIndexes[1] && clearIndexes[1] < fqbnStageIndex);
});

test('selects compile and normal upload actions through stable product roles', () => {
    assert.match(embeddedNode, /data-ck-role="build-compile-action"/);
    assert.match(embeddedNode, /data-ck-role="build-normal-upload-action"/);
    assert.doesNotMatch(embeddedNode, /item\.title === '\\u7f16\\u8bd1'/);
    assert.doesNotMatch(embeddedNode, /item\.title\.startsWith\('\\u666e\\u901a\\u4e0a\\u4f20'\)/);
});

test('records bounded evidence and never records a complete MAC or raw upload log', () => {
    const fullMac = 'Device MAC: AA:BB:CC:DD:EE:FF';
    assert.equal(helpers.containsFullMac(fullMac), true);
    assert.equal(helpers.containsFullMac(helpers.redactMacs(fullMac)), false);
    assert.equal(
        helpers.redactAbsolutePaths('failed at C:\\Users\\Alice\\AppData\\Local\\Temp\\CK_Builds\\x'),
        'failed at [REDACTED_ABSOLUTE_PATH]',
    );
    assert.match(embeddedNode, /Privacy failure: evidence contains a complete MAC address/);
    assert.match(embeddedNode, /Privacy failure: result JSON still contains a complete MAC address/);
    assert.match(embeddedNode, /Privacy failure: result JSON contains a Windows absolute path/);
    assert.doesNotMatch(embeddedNode, /summary\.(?:log|rawLog|uploadLog)\s*=/);
    assert.doesNotMatch(embeddedNode, /summary\.identity\.(?:source|code|workspaceJson)\s*=/i);
    assert.match(embeddedNode, /operations: records\.slice\(-12\)\.map/);
    assert.match(embeddedNode, /source: 'visible-ui-log-disk-and-transport-chain'/);
    assert.match(embeddedNode, /diskManifestShaChainComplete: true/);
    assert.match(embeddedNode, /transportChainComplete: true/);
    assert.match(embeddedNode, /REDACTED_ABSOLUTE_PATH/);
    assert.match(embeddedNode, /sourceCodeRecorded: false/);
    assert.match(embeddedNode, /rawWorkspaceRecorded: false/);
    assert.match(embeddedNode, /CK_UPLOAD_MANIFEST_GATE_RESULT=/);

    const directory = mkdtempSync(path.join(tmpdir(), 'ck-manifest-privacy-'));
    const outputPath = path.join(directory, 'report.json');
    const previousOutput = process.env.CK_MANIFEST_GATE_OUTPUT;
    process.env.CK_MANIFEST_GATE_OUTPUT = outputPath;
    try {
        assert.throws(
            () => helpers.writeSummary({ status: 'passed', leakedPath: 'C:\\Users\\Alice\\secret.maker' }),
            /Windows absolute path/,
        );
        assert.equal(readFileSync(outputPath, { flag: 'a+' }).length, 0);
    } finally {
        if (previousOutput === undefined) delete process.env.CK_MANIFEST_GATE_OUTPUT;
        else process.env.CK_MANIFEST_GATE_OUTPUT = previousOutput;
        rmSync(directory, { recursive: true, force: true });
    }
});
