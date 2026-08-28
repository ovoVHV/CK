import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdir,
  mkdtemp,
  readFile,
  readdir,
  rm,
  writeFile,
} from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

import {
  SUMMARY_SCHEMA_ID,
  buildFirstCompileSummary,
  calculateStatistics,
  canonicalizeFqbn,
  loadBenchmarkRecords,
  writeJsonAtomic,
} from './Summarize-FirstCompilePerformance.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const scriptPath = path.join(scriptDirectory, 'Summarize-FirstCompilePerformance.mjs');
const wrapperPath = path.join(scriptDirectory, 'Summarize-FirstCompilePerformance.ps1');
const FULL_FQBN = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB';
const TEST_NOW = new Date();
const FROZEN_AT = new Date(TEST_NOW.getTime() - 180 * 60_000).toISOString();
const GATE_FINISHED_AT = new Date(TEST_NOW.getTime() - 100 * 60_000).toISOString();
const EXECUTABLE_STARTED_AT = new Date(TEST_NOW.getTime() - 90 * 60_000).toISOString();
const BATCH_STARTED_AT = TEST_NOW.getTime() - 60 * 60_000;

function temporalEnvelope(slot) {
  const verifiedBefore = BATCH_STARTED_AT + slot * 8 * 60_000;
  return {
    capturedAt: new Date(verifiedBefore + 60_000).toISOString(),
    baselineCreatedAt: new Date(verifiedBefore + 2 * 60_000).toISOString(),
    baselineVerifiedAt: new Date(verifiedBefore + 3 * 60_000).toISOString(),
    bindingVerification: {
      schema_version: 1,
      verified_before_at: new Date(verifiedBefore).toISOString(),
      verified_after_at: new Date(verifiedBefore + 5 * 60_000).toISOString(),
      unchanged: true,
    },
  };
}

function applyTemporalEnvelope(document, temporal) {
  document.capturedAt = temporal.capturedAt;
  document.binding_verification = temporal.bindingVerification;
  document.verified_baseline.createdAt = temporal.baselineCreatedAt;
  document.verified_baseline.verifiedAt = temporal.baselineVerifiedAt;
}

function sha(character) {
  return character.repeat(64);
}

function digest(value) {
  return createHash('sha256').update(value).digest('hex');
}

async function fileDigest(filePath) {
  return digest(await readFile(filePath));
}

async function writeJson(filePath, value) {
  await mkdir(path.dirname(filePath), { recursive: true });
  await writeFile(filePath, `${JSON.stringify(value)}\n`, 'utf8');
}

function expectedUploadProfile(mode) {
  return mode === 'readyInstallCold' ? 'shared-fast' : 'quick-fast';
}

function verifiedBaseline(fqbn = FULL_FQBN, compileProfile = 'quick-fast', temporal = temporalEnvelope(0)) {
  return {
    createdAt: temporal.baselineCreatedAt,
    verifiedAt: temporal.baselineVerifiedAt,
    environment: {
      fqbn,
      coreId: 'esp32:esp32',
      coreVersion: '3.3.6',
      arduinoCliVersion: '1.3.1',
      toolchainKey: 'riscv32-esp-elf-14.2.0',
      buildSignature: 'build-signature-v5',
      compileProfile,
      optimization: '-O1',
    },
    firmware: {
      manifestSha256: sha('1'),
      partitionSha256: sha('2'),
      artifacts: [{
        role: 'application',
        flashAddress: '0x10000',
        size: 4096,
        sha256: sha('3'),
      }],
    },
    device: {
      chip: 'ESP32-C6',
      revision: 'v0.1',
      flashBytes: 16 * 1024 * 1024,
      psramBytes: null,
    },
    resources: {
      flashUsedBytes: 900000,
      flashMaxBytes: 3145728,
      ramUsedBytes: 40000,
      ramMaxBytes: 327680,
      warningCount: 0,
    },
  };
}

function benchmarkFixture({
  mode,
  runId,
  seconds,
  fqbn = FULL_FQBN,
  codeFingerprint = 'private-generated-source-fingerprint-v1',
  readyOverrides = {},
  coldOverrides = {},
  documentOverrides = {},
  temporalSlot = 0,
}) {
  const temporal = temporalEnvelope(temporalSlot);
  const cold = mode === 'readyInstallCold'
    ? {
      kind: 'compile',
      wallSeconds: seconds,
      compileLockWaitReported: true,
      compileLockSeconds: 0.5,
      matchingWarmupWaitObserved: false,
      compatibleWarmupReuseObserved: false,
      fullBuild: false,
      exactMatch: false,
      fastRelink: true,
      prebuiltCoreInjected: true,
      syntheticCcdbPrepared: true,
      arduinoCliCcdbRefreshObserved: false,
      ...readyOverrides,
      ...coldOverrides,
    }
    : {
      kind: 'compile',
      success: true,
      wallSeconds: seconds,
      compileLockWaitReported: true,
      compileLockSeconds: 0.5,
      matchingWarmupWaitObserved: false,
      compatibleWarmupReuseObserved: false,
      fullBuild: true,
      exactMatch: false,
      fastRelink: false,
      ...coldOverrides,
    };
  const fixture = {
    schemaId: 'ck.native-compile-upload-benchmark',
    schemaVersion: 1,
    status: 'passed',
    runId,
    evidenceScope: 'single-native-session',
    capturedAt: temporal.capturedAt,
    project: 'c6_regression',
    fqbn,
    port: 'COM12',
    coldMode: mode,
    sourceGate: {
      initial: {
        codeFingerprint,
        includeSignature: 'wifi.h|wire.h',
        includeHeaders: ['Wire.h', 'WiFi.h'],
      },
    },
    cycles: {
      cold: {
        ...cold,
        schemaId: 'ck.native-compile-upload-operation',
        schemaVersion: 1,
        success: true,
        profile: 'quick-fast (fast local loop, skip packaging/prebuild-heavy steps)',
      },
      upload: {
        schemaId: 'ck.native-compile-upload-operation',
        schemaVersion: 1,
        kind: 'upload',
        success: true,
        wallSeconds: 2,
        profile: `${expectedUploadProfile(mode)} (verified upload stage)`,
      },
      exact: {
        schemaId: 'ck.native-compile-upload-operation',
        schemaVersion: 1,
        kind: 'compile',
        success: true,
        wallSeconds: 1.5,
        profile: 'quick-fast (exact cache)',
        exactMatch: true,
        codeChanged: false,
      },
      hotEdit: {
        schemaId: 'ck.native-compile-upload-operation',
        schemaVersion: 1,
        kind: 'compile',
        success: true,
        wallSeconds: 2.5,
        profile: 'quick-fast (hot edit)',
        exactMatch: false,
        codeChanged: true,
      },
    },
    verified_baseline: verifiedBaseline(fqbn, expectedUploadProfile(mode), temporal),
    binding_verification: temporal.bindingVerification,
    skippedStages: [],
    failures: [],
    checks: [
      'cold-stage-verified-or-explicitly-skipped',
      'exact-cache-hit-confirmed',
      'hot-edit-code-change-confirmed',
      'generated-source-restored',
      'upload-stage-verified-or-explicitly-skipped',
    ].map((id) => ({ id, passed: true })),
    ...documentOverrides,
  };
  fixture.cacheClear = {
    fqbn,
    reset_scope: mode === 'readyInstallCold'
      ? 'ready-install-project-full-fqbn'
      : 'first-project-full-fqbn',
    ccache_store_preserved: true,
    prebuilt_core_preserved: mode === 'readyInstallCold',
    prebuilt_core_validated: mode === 'readyInstallCold',
    force_rebuild_pending: false,
    force_ccache_recache: false,
  };
  return fixture;
}

function passingDocuments() {
  return [
    ...[100, 110, 120].map((seconds, index) => benchmarkFixture({
      mode: 'firstProjectCold',
      runId: `first-private-${index + 1}`,
      seconds,
      temporalSlot: index * 2,
    })),
    ...[60, 70, 80].map((seconds, index) => benchmarkFixture({
      mode: 'readyInstallCold',
      runId: `ready-private-${index + 1}`,
      seconds,
      temporalSlot: index * 2 + 1,
    })),
  ];
}

async function createEvidenceWorkspace(documents, options = {}) {
  const root = await mkdtemp(path.join(os.tmpdir(), 'ck-first-compile-evidence-'));
  const paths = {
    root,
    source: path.join(root, 'src', 'source.txt'),
    manifest: path.join(root, 'artifacts', 'release', 'source-tree-manifest.json'),
    freeze: path.join(root, 'artifacts', 'release', 'source-tree-freeze.json'),
    gate: path.join(root, 'artifacts', 'release', 'v1-release-gates.json'),
    executable: path.join(root, 'target', 'release', 'appsdesktop.exe'),
    reports: path.join(root, 'evidence'),
  };
  await mkdir(path.dirname(paths.source), { recursive: true });
  await mkdir(path.dirname(paths.executable), { recursive: true });
  await mkdir(paths.reports, { recursive: true });
  const sourceBytes = Buffer.from('frozen source\n', 'utf8');
  await writeFile(paths.source, sourceBytes);
  const sourceSha = digest(sourceBytes);
  const treeSha = digest(`src/source.txt\t${sourceBytes.length}\t${sourceSha}\n`);
  const manifest = {
    schema_version: 1,
    policy_id: 'ck-source-tree-v1',
    hash_algorithm: 'sha256',
    tree_hash_encoding: 'utf-8-without-bom',
    tree_hash_record_format: 'relative_path<TAB>bytes<TAB>sha256<LF>',
    source_control: { kind: 'none', commit: null },
    file_count: 1,
    total_bytes: sourceBytes.length,
    tree_sha256: treeSha,
    files: [{ path: 'src/source.txt', bytes: sourceBytes.length, sha256: sourceSha }],
  };
  await writeJson(paths.manifest, manifest);
  let manifestSha = await fileDigest(paths.manifest);
  const freeze = {
    schema_version: 1,
    policy_id: 'ck-source-tree-v1',
    frozen_at: FROZEN_AT,
    source_control: { kind: 'none', commit: null },
    manifest_path: 'artifacts/release/source-tree-manifest.json',
    manifest_sha256: manifestSha,
    tree_sha256: treeSha,
    file_count: 1,
    total_bytes: sourceBytes.length,
  };
  await writeJson(paths.freeze, freeze);
  let freezeSha = await fileDigest(paths.freeze);
  const gate = {
    status: 'passed',
    run_id: 'release-gate-shared-private',
    finished_at: GATE_FINISHED_AT,
    source_tree: {
      verified_before_gate: true,
      verified_after_gate: true,
      identity: {
        manifest_path: 'artifacts/release/source-tree-manifest.json',
        freeze_record_path: 'artifacts/release/source-tree-freeze.json',
        manifest_sha256: manifestSha,
        tree_sha256: treeSha,
        frozen_at: FROZEN_AT,
      },
    },
  };
  await writeJson(paths.gate, gate);
  let gateSha = await fileDigest(paths.gate);
  const executableBytes = Buffer.from('production-executable-fixture', 'utf8');
  await writeFile(paths.executable, executableBytes);
  const executableSha = digest(executableBytes);

  const context = {
    root,
    paths,
    manifest,
    freeze,
    gate,
    sourceSha,
    treeSha,
    manifestSha,
    freezeSha,
    gateSha,
    executableBytes,
    executableSha,
  };
  const bindDocuments = () => {
    for (const document of documents) {
      document.source_tree = {
        policy_id: 'ck-source-tree-v1',
        manifest_path: 'artifacts/release/source-tree-manifest.json',
        manifest_sha256: context.manifestSha,
        freeze_record_path: 'artifacts/release/source-tree-freeze.json',
        freeze_record_sha256: context.freezeSha,
        tree_sha256: context.treeSha,
      };
      document.gate_run = {
        run_id: context.gate.run_id,
        finished_at: context.gate.finished_at,
        report_path: 'artifacts/release/v1-release-gates.json',
        report_sha256: context.gateSha,
        status: 'passed',
      };
      document.executable = {
        path: 'target/release/appsdesktop.exe',
        sha256: context.executableSha,
        bytes: context.executableBytes.length,
        process_id: 4242,
        process_started_at: EXECUTABLE_STARTED_AT,
      };
      document.cdp_binding = {
        bound: true,
        executable_sha256: context.executableSha,
        process_id: 4242,
      };
    }
  };
  bindDocuments();
  context.bindDocuments = bindDocuments;
  if (options.afterBind) await options.afterBind(context, documents);
  const reportPaths = [];
  for (const [index, document] of documents.entries()) {
    const reportPath = path.join(paths.reports, `${String(index + 1).padStart(2, '0')}.json`);
    await writeJson(reportPath, document);
    reportPaths.push(reportPath);
  }
  const loaded = await loadBenchmarkRecords({
    inputPaths: options.inputPaths || reportPaths,
    inputDirectory: options.inputDirectory || '',
    root,
  });
  return {
    root,
    paths,
    context,
    reportPaths,
    loaded,
    cleanup: () => rm(root, { recursive: true, force: true }),
  };
}

async function loadPassing(t, mutate, workspaceOptions = {}) {
  const documents = passingDocuments();
  if (mutate) mutate(documents);
  const workspace = await createEvidenceWorkspace(documents, workspaceOptions);
  t.after(workspace.cleanup);
  return workspace;
}

test('canonicalizes valid full FQBNs and rejects ambiguous option syntax', () => {
  assert.equal(
    canonicalizeFqbn('ESP32:ESP32:ESP32C6:PartitionScheme=app3M,FlashSize=16M'),
    'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M',
  );
  for (const invalid of [
    'esp32:esp32',
    'esp32:esp32:esp32c6:',
    'esp32:esp32:esp32c6:FlashSize=',
    'esp32:esp32:esp32c6:=16M',
    'esp32:esp32:esp32c6:Flash Size=16M',
    'esp32:esp32:esp32c6:FlashSize=16M,flashsize=8M',
    'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme',
    'esp32:esp32:esp32c6:FlashSize=16M:extra',
  ]) assert.equal(canonicalizeFqbn(invalid), '', invalid);
});

test('calculates strict numeric median, max, and nearest-rank p95', () => {
  assert.deepEqual(calculateStatistics([3, 1, 2]), {
    count: 3,
    medianSeconds: 2,
    maxSeconds: 3,
    p95Seconds: 3,
  });
  assert.deepEqual(calculateStatistics([4, 2, 1, 3]), {
    count: 4,
    medianSeconds: 2.5,
    maxSeconds: 4,
    p95Seconds: 4,
  });
  assert.equal(calculateStatistics([1, '2', 3]), null);
  assert.equal(calculateStatistics([1, 0, 2]), null);
});

test('passes 3+3 directly verified samples and publishes no raw source/run metadata', async (t) => {
  const workspace = await loadPassing(t);
  assert.deepEqual(workspace.loaded.errors, []);
  const summary = buildFirstCompileSummary(workspace.loaded.records, {
    now: TEST_NOW,
  });
  assert.equal(summary.status, 'passed');
  assert.equal(summary.generatedAt, TEST_NOW.toISOString());
  assert.equal(summary.evidenceMode, 'direct-local-file-verification-no-build-executed');
  assert.equal(summary.attestationBoundary, 'same-source-files-directly-verified-not-a-cryptographic-signer');
  assert.deepEqual(summary.statistics.firstProjectCold, {
    count: 3,
    medianSeconds: 110,
    maxSeconds: 120,
    p95Seconds: 120,
  });
  assert.deepEqual(summary.statistics.readyInstallCold, {
    count: 3,
    medianSeconds: 70,
    maxSeconds: 80,
    p95Seconds: 80,
  });
  assert.deepEqual(summary.improvementPercent, {
    median: 36.36,
    p95: 33.33,
    medianTargetMet: true,
    p95TargetMet: true,
  });
  assert.equal(summary.binding.fqbn, FULL_FQBN);
  assert.equal(summary.binding.project, 'c6_regression');
  assert.equal(summary.binding.port, 'COM12');
  assert.deepEqual(summary.binding.device, {
    chip: 'ESP32-C6',
    revision: 'v0.1',
    flashBytes: 16 * 1024 * 1024,
    psramBytes: null,
  });
  assert.equal(summary.binding.executable.processId, 4242);
  assert.equal(summary.binding.environment.compileProfile, 'quick-fast');
  assert.deepEqual(summary.policy.compileProfilesByColdMode, {
    firstProjectCold: { cold: 'quick-fast', upload: 'quick-fast' },
    readyInstallCold: { cold: 'quick-fast', upload: 'shared-fast' },
  });
  assert.deepEqual(summary.policy.cacheClearByColdMode, {
    firstProjectCold: {
      reset_scope: 'first-project-full-fqbn',
      ccache_store_preserved: true,
      prebuilt_core_preserved: false,
      prebuilt_core_validated: false,
      force_rebuild_pending: false,
      force_ccache_recache: false,
    },
    readyInstallCold: {
      reset_scope: 'ready-install-project-full-fqbn',
      ccache_store_preserved: true,
      prebuilt_core_preserved: true,
      prebuilt_core_validated: true,
      force_rebuild_pending: false,
      force_ccache_recache: false,
    },
  });
  assert.deepEqual(summary.policy.requiredTemporalSequence, [
    'firstProjectCold',
    'readyInstallCold',
    'firstProjectCold',
    'readyInstallCold',
    'firstProjectCold',
    'readyInstallCold',
  ]);
  assert.equal(summary.policy.requireNonOverlappingSamples, true);
  assert.equal(summary.policy.requireGateExecutableSampleOrder, true);
  assert.equal(summary.policy.maximumBatchSpanHours, 2);
  assert.equal(summary.policy.maximumEvidenceAgeHours, 72);
  assert.equal(summary.policy.futureTimestampToleranceMinutes, 5);
  assert.deepEqual(summary.batch, {
    spanSeconds: 45 * 60,
    expiresAt: new Date(BATCH_STARTED_AT + 72 * 60 * 60_000).toISOString(),
  });
  assert.equal(summary.failures.length, 0);
  const serialized = JSON.stringify(summary);
  assert.doesNotMatch(serialized, /first-private|ready-private|private-generated-source-fingerprint/);
  assert.doesNotMatch(serialized, /includeHeaders|codeFingerprint|runId|capturedAt|verified_before_at|verified_after_at|process_started_at|finished_at/);
  assert.match(summary.samples.firstProjectCold[0].sampleId, /^firstProjectCold-01-[0-9a-f]{12}$/);
});

test('the 3+3 and 30 percent policy cannot be overridden through the public API', async (t) => {
  const workspace = await loadPassing(t);
  for (const options of [
    { minimumSamples: 0 },
    { targetPercent: -1 },
    { now: '2026-07-15T00:00:00Z' },
    [],
  ]) assert.throws(() => buildFirstCompileSummary(workspace.loaded.records, options), TypeError);
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.policy.minimumSamplesPerMode, 3);
  assert.equal(summary.policy.requireExactSamplesPerMode, true);
  assert.equal(summary.policy.targetImprovementPercent, 30);
});

test('public environment binding stays anchored to firstProjectCold when ready samples load first', async (t) => {
  const documents = passingDocuments();
  const readyFirst = [...documents.slice(3), ...documents.slice(0, 3)];
  const workspace = await createEvidenceWorkspace(readyFirst);
  t.after(workspace.cleanup);
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.status, 'passed');
  assert.equal(summary.binding.environment.compileProfile, 'quick-fast');
});

test('rejects malformed benchmark schema, status, CDP, and strict process types', async (t) => {
  const cases = [
    ['wrong schema ID', (document) => { document.schemaId = 'ck.other'; }, 'invalid-benchmark-schema-or-scope'],
    ['wrong schema', (document) => { document.schemaVersion = 2; }, 'invalid-benchmark-schema-or-scope'],
    ['wrong scope', (document) => { document.evidenceScope = 'assembled'; }, 'invalid-benchmark-schema-or-scope'],
    ['failed status', (document) => { document.status = 'failed'; }, 'benchmark-status-not-passed'],
    ['CDP not bound', (document) => { document.cdp_binding.bound = false; }, 'invalid-native-production-session-binding'],
    ['different CDP hash', (document) => { document.cdp_binding.executable_sha256 = sha('f'); }, 'invalid-native-production-session-binding'],
    ['process string', (document) => { document.executable.process_id = '4242'; document.cdp_binding.process_id = '4242'; }, 'invalid-production-executable-binding'],
    ['binding changed', (document) => { document.binding_verification.unchanged = false; }, 'native-binding-not-verified-unchanged'],
  ];
  for (const [name, mutate, expected] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, null, {
        afterBind: async (_context, documents) => mutate(documents[0]),
      });
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === expected));
    });
  }
});

test('requires a complete ordered native time envelope for every sample', async (t) => {
  const cases = [
    [
      'binding schema missing',
      (document) => { delete document.binding_verification.schema_version; },
    ],
    [
      'capturedAt malformed',
      (document) => { document.capturedAt = 'not-a-time'; },
    ],
    [
      'executable starts after verification begins',
      (document) => { document.executable.process_started_at = new Date(BATCH_STARTED_AT + 60_000).toISOString(); },
    ],
    [
      'capture precedes verification',
      (document) => {
        document.capturedAt = new Date(Date.parse(document.binding_verification.verified_before_at) - 1).toISOString();
      },
    ],
    [
      'capture follows final verification',
      (document) => {
        document.capturedAt = new Date(Date.parse(document.binding_verification.verified_after_at) + 1).toISOString();
      },
    ],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, null, {
        afterBind: async (_context, documents) => mutate(documents[0]),
      });
      const summary = buildFirstCompileSummary(workspace.loaded.records, { now: TEST_NOW });
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-native-time-envelope'));
    });
  }
});

test('fails closed on wrong alternation, overlap, excessive span, stale age, and future evidence', async (t) => {
  await t.test('wrong temporal alternation', async (child) => {
    const workspace = await loadPassing(child, (documents) => {
      const firstTwo = {
        capturedAt: documents[1].capturedAt,
        binding: documents[1].binding_verification,
        baselineCreatedAt: documents[1].verified_baseline.createdAt,
        baselineVerifiedAt: documents[1].verified_baseline.verifiedAt,
      };
      documents[1].capturedAt = documents[3].capturedAt;
      documents[1].binding_verification = documents[3].binding_verification;
      documents[1].verified_baseline.createdAt = documents[3].verified_baseline.createdAt;
      documents[1].verified_baseline.verifiedAt = documents[3].verified_baseline.verifiedAt;
      documents[3].capturedAt = firstTwo.capturedAt;
      documents[3].binding_verification = firstTwo.binding;
      documents[3].verified_baseline.createdAt = firstTwo.baselineCreatedAt;
      documents[3].verified_baseline.verifiedAt = firstTwo.baselineVerifiedAt;
    });
    const summary = buildFirstCompileSummary(workspace.loaded.records, { now: TEST_NOW });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'invalid-temporal-sample-sequence'));
  });

  await t.test('overlapping verification windows', async (child) => {
    const workspace = await loadPassing(child, (documents) => {
      const firstAfter = Date.parse(documents[0].binding_verification.verified_after_at);
      documents[3].binding_verification.verified_before_at = new Date(firstAfter - 60_000).toISOString();
      documents[3].capturedAt = new Date(firstAfter).toISOString();
      documents[3].verified_baseline.createdAt = new Date(firstAfter + 30_000).toISOString();
      documents[3].verified_baseline.verifiedAt = new Date(firstAfter + 60_000).toISOString();
      documents[3].binding_verification.verified_after_at = new Date(firstAfter + 2 * 60_000).toISOString();
    });
    const summary = buildFirstCompileSummary(workspace.loaded.records, { now: TEST_NOW });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'overlapping-temporal-samples'));
  });

  await t.test('batch exceeds two hours', async (child) => {
    const workspace = await loadPassing(child, (documents) => {
      const late = temporalEnvelope(15);
      applyTemporalEnvelope(documents[5], late);
    });
    const summary = buildFirstCompileSummary(workspace.loaded.records, { now: TEST_NOW });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'temporal-batch-span-exceeded'));
  });

  await t.test('batch is older than 72 hours', async (child) => {
    const workspace = await loadPassing(child);
    const summary = buildFirstCompileSummary(workspace.loaded.records, {
      now: new Date(TEST_NOW.getTime() + 73 * 60 * 60_000),
    });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'temporal-batch-stale'));
    assert.equal(
      summary.batch.expiresAt,
      new Date(BATCH_STARTED_AT + 72 * 60 * 60_000).toISOString(),
    );
  });

  await t.test('batch is over five minutes in the future', async (child) => {
    const workspace = await loadPassing(child);
    const summary = buildFirstCompileSummary(workspace.loaded.records, {
      now: new Date(TEST_NOW.getTime() - 20 * 60_000 - 1),
    });
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'temporal-batch-from-future'));
  });
});

test('gate and executable timestamps are stable across the native batch', async (t) => {
  const workspace = await loadPassing(t, null, {
    afterBind: async (_context, documents) => {
      documents[4].executable.process_started_at = new Date(
        Date.parse(EXECUTABLE_STARTED_AT) + 60_000,
      ).toISOString();
    },
  });
  const summary = buildFirstCompileSummary(workspace.loaded.records, { now: TEST_NOW });
  assert.equal(summary.status, 'failed');
  assert.ok(summary.failures.some((failure) => failure.id === 'cross-sample-binding-mismatch'));
});

test('requires an unskipped failure-free benchmark with exactly the fixed passed checks', async (t) => {
  const cases = [
    ['skipped stage', (document) => { document.skippedStages.push({ stage: 'upload' }); }],
    ['missing skippedStages array', (document) => { delete document.skippedStages; }],
    ['reported failure', (document) => { document.failures.push('upload-stage'); }],
    ['null failures', (document) => { document.failures = null; }],
    ['failed check', (document) => { document.checks[0].passed = false; }],
    ['missing check', (document) => { document.checks.pop(); }],
    ['unknown extra check', (document) => { document.checks.push({ id: 'extra', passed: true }); }],
    ['duplicate check', (document) => { document.checks[1].id = document.checks[0].id; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[0]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-benchmark-outcome-envelope'));
    });
  }
});

test('a duplicate-menu FQBN is rejected by the full sample pipeline', async (t) => {
  const duplicateFqbn = 'esp32:esp32:esp32c6:FlashSize=16M,flashsize=8M';
  const workspace = await loadPassing(t, (documents) => {
    documents[0].fqbn = duplicateFqbn;
    documents[0].verified_baseline.environment.fqbn = duplicateFqbn;
  });
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.status, 'failed');
  assert.ok(summary.failures.some((failure) => failure.id === 'missing-full-fqbn'));
  assert.equal(summary.samples.firstProjectCold.length, 2);
});

test('direct callers cannot forge loader verification and verified records cannot be mutated', async (t) => {
  const raw = passingDocuments().map((document, index) => ({
    relativePath: `evidence/raw-${index}.json`, document,
  }));
  const unverified = buildFirstCompileSummary(raw);
  assert.equal(unverified.status, 'failed');
  assert.equal(unverified.samples.firstProjectCold.length, 0);
  assert.ok(unverified.failures.some((failure) => failure.id === 'record-not-loader-verified'));

  const workspace = await loadPassing(t);
  workspace.loaded.records[0].document.cycles.cold.wallSeconds = 1;
  const mutated = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(mutated.status, 'failed');
  assert.ok(mutated.failures.some((failure) => failure.id === 'verified-record-mutated'));
  assert.equal(mutated.samples.firstProjectCold.length, 2);
});

test('fails when median passes but nearest-rank p95 misses 30 percent', async (t) => {
  const documents = [
    ...[100, 100, 200].map((seconds, index) => benchmarkFixture({
      mode: 'firstProjectCold', runId: `first-p95-${index}`, seconds,
    })),
    ...[60, 60, 150].map((seconds, index) => benchmarkFixture({
      mode: 'readyInstallCold', runId: `ready-p95-${index}`, seconds,
    })),
  ];
  const workspace = await createEvidenceWorkspace(documents);
  t.after(workspace.cleanup);
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.status, 'failed');
  assert.equal(summary.improvementPercent.median, 40);
  assert.equal(summary.improvementPercent.p95, 25);
  assert.ok(summary.failures.some((failure) => failure.id === 'p95-improvement-target-missed'));
});

test('rejects every cold lock and warmup bypass, including string numbers', async (t) => {
  const cases = [
    ['lock report missing', (cold) => { delete cold.compileLockWaitReported; }],
    ['lock report false', (cold) => { cold.compileLockWaitReported = false; }],
    ['lock is string', (cold) => { cold.compileLockSeconds = '0.5'; }],
    ['lock is negative', (cold) => { cold.compileLockSeconds = -0.1; }],
    ['lock exceeds bound', (cold) => { cold.compileLockSeconds = 5.001; }],
    ['warmup wait missing', (cold) => { delete cold.matchingWarmupWaitObserved; }],
    ['warmup wait true', (cold) => { cold.matchingWarmupWaitObserved = true; }],
    ['warmup reuse missing', (cold) => { delete cold.compatibleWarmupReuseObserved; }],
    ['warmup reuse true', (cold) => { cold.compatibleWarmupReuseObserved = true; }],
  ];
  for (const [name, mutate] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[0].cycles.cold));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-cold-lock-or-warmup-evidence'));
      assert.equal(summary.samples.firstProjectCold.length, 2);
    });
  }
});

test('requires exactly 3+3 successful cold samples', async (t) => {
  await t.test('a cold compile without literal success is rejected', async (child) => {
    const workspace = await loadPassing(child, (documents) => {
      delete documents[0].cycles.cold.success;
    });
    const summary = buildFirstCompileSummary(workspace.loaded.records);
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'invalid-cold-cycle'));
    assert.ok(summary.failures.some((failure) => failure.id === 'invalid-sample-count'));
  });

  await t.test('a fourth otherwise valid sample is rejected', async (child) => {
    const documents = passingDocuments();
    documents.push(benchmarkFixture({
      mode: 'readyInstallCold',
      runId: 'ready-private-extra',
      seconds: 65,
    }));
    const workspace = await createEvidenceWorkspace(documents);
    child.after(workspace.cleanup);
    const summary = buildFirstCompileSummary(workspace.loaded.records);
    assert.equal(summary.samples.readyInstallCold.length, 4);
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'invalid-sample-count'));
  });
});

test('checks every first-project and ready-install cold-build invariant', async (t) => {
  const cases = [
    ['cold schema ID missing', 0, (document) => { delete document.cycles.cold.schemaId; }, 'invalid-cold-cycle'],
    ['cold schema ID wrong', 0, (document) => { document.cycles.cold.schemaId = 'ck.other'; }, 'invalid-cold-cycle'],
    ['cold schema version string', 0, (document) => { document.cycles.cold.schemaVersion = '1'; }, 'invalid-cold-cycle'],
    ['wallSeconds string', 0, (document) => { document.cycles.cold.wallSeconds = '100'; }, 'invalid-cold-cycle'],
    ['first must be Full Build', 0, (document) => { document.cycles.cold.fullBuild = false; }, 'invalid-first-project-cold'],
    ['first must be non-Exact', 0, (document) => { document.cycles.cold.exactMatch = true; }, 'invalid-first-project-cold'],
    ['ready must Fast Relink', 3, (document) => { document.cycles.cold.fastRelink = false; }, 'invalid-ready-install-cold'],
    ['ready must be non-Full', 3, (document) => { document.cycles.cold.fullBuild = true; }, 'invalid-ready-install-cold'],
    ['ready must be non-Exact', 3, (document) => { document.cycles.cold.exactMatch = true; }, 'invalid-ready-install-cold'],
    ['ready must inject Core', 3, (document) => { document.cycles.cold.prebuiltCoreInjected = false; }, 'invalid-ready-install-cold'],
    ['ready must prepare synthetic CCDB', 3, (document) => { document.cycles.cold.syntheticCcdbPrepared = false; }, 'invalid-ready-install-cold'],
    ['ready must report synthetic CCDB', 3, (document) => { delete document.cycles.cold.syntheticCcdbPrepared; }, 'invalid-ready-install-cold'],
    ['ready must not refresh CLI CCDB', 3, (document) => { document.cycles.cold.arduinoCliCcdbRefreshObserved = true; }, 'invalid-ready-install-cold'],
    ['ready must report CLI CCDB evidence', 3, (document) => { delete document.cycles.cold.arduinoCliCcdbRefreshObserved; }, 'invalid-ready-install-cold'],
    ['ready must preserve Core', 3, (document) => { document.cacheClear.prebuilt_core_preserved = false; }, 'invalid-cache-clear-identity'],
    ['ready must validate Core', 3, (document) => { document.cacheClear.prebuilt_core_validated = false; }, 'invalid-cache-clear-identity'],
    ['ready cache target must match full FQBN', 3, (document) => { document.cacheClear.fqbn = 'esp32:esp32:esp32c6'; }, 'invalid-cache-clear-identity'],
  ];
  for (const [name, index, mutate, expectedFailure] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[index]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === expectedFailure));
    });
  }
});

test('cacheClear identity is exact, mode-specific, snake_case, and literal-boolean', async (t) => {
  const booleanFields = [
    'ccache_store_preserved',
    'prebuilt_core_preserved',
    'prebuilt_core_validated',
    'force_rebuild_pending',
    'force_ccache_recache',
  ];
  for (const [mode, index] of [['firstProjectCold', 0], ['readyInstallCold', 3]]) {
    await t.test(`${mode} rejects a missing cacheClear`, async (child) => {
      const workspace = await loadPassing(child, (documents) => { delete documents[index].cacheClear; });
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-cache-clear-identity'));
    });
    for (const [name, mutate] of [
      ['missing FQBN', (cache) => { delete cache.fqbn; }],
      ['base-only FQBN', (cache) => { cache.fqbn = 'esp32:esp32:esp32c6'; }],
      ['wrong reset scope', (cache) => { cache.reset_scope = 'wrong-scope'; }],
      ['missing reset scope', (cache) => { delete cache.reset_scope; }],
      ['camel reset scope alias', (cache) => { delete cache.reset_scope; cache.resetScope = mode; }],
    ]) {
      await t.test(`${mode} ${name}`, async (child) => {
        const workspace = await loadPassing(child, (documents) => mutate(documents[index].cacheClear));
        const summary = buildFirstCompileSummary(workspace.loaded.records);
        assert.ok(summary.failures.some((failure) => failure.id === 'invalid-cache-clear-identity'));
      });
    }
    for (const field of booleanFields) {
      for (const [kind, mutate] of [
        ['missing', (cache) => { delete cache[field]; }],
        ['string', (cache) => { cache[field] = String(cache[field]); }],
        ['wrong', (cache) => { cache[field] = !cache[field]; }],
      ]) {
        await t.test(`${mode} ${field} ${kind}`, async (child) => {
          const workspace = await loadPassing(child, (documents) => mutate(documents[index].cacheClear));
          const summary = buildFirstCompileSummary(workspace.loaded.records);
          assert.ok(summary.failures.some((failure) => failure.id === 'invalid-cache-clear-identity'));
        });
      }
    }
  }
});

test('requires a complete upload-created verified baseline with strict resource numbers', async (t) => {
  const cases = [
    ['baseline missing', (document) => { delete document.verified_baseline; }, 'missing-verified-upload-baseline'],
    ['environment missing', (document) => { document.verified_baseline.environment.toolchainKey = ''; }, 'incomplete-verified-upload-baseline'],
    ['firmware missing', (document) => { document.verified_baseline.firmware.artifacts = []; }, 'incomplete-verified-upload-baseline'],
    ['device string bytes', (document) => { document.verified_baseline.device.flashBytes = '16777216'; }, 'incomplete-verified-upload-baseline'],
    ['resource string', (document) => { document.verified_baseline.resources.flashUsedBytes = '900000'; }, 'incomplete-verified-upload-baseline'],
    ['resource overflow', (document) => { document.verified_baseline.resources.ramUsedBytes = 400000; }, 'incomplete-verified-upload-baseline'],
    ['baseline FQBN mismatch', (document) => { document.verified_baseline.environment.fqbn = 'esp32:esp32:esp32c5'; }, 'incomplete-verified-upload-baseline'],
  ];
  for (const [name, mutate, failureId] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[0]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === failureId));
      assert.equal(summary.samples.firstProjectCold.length, 2);
    });
  }
});

test('verified baseline timestamps are timezone-qualified and enclosed by native verification', async (t) => {
  const timestampCases = [
    ['createdAt missing', (document) => { delete document.verified_baseline.createdAt; }],
    ['verifiedAt missing', (document) => { delete document.verified_baseline.verifiedAt; }],
    ['createdAt missing timezone', (document) => { document.verified_baseline.createdAt = '2026-07-16T01:02:03'; }],
    ['verifiedAt missing timezone', (document) => { document.verified_baseline.verifiedAt = '2026-07-16T01:02:03.000'; }],
    ['createdAt malformed', (document) => { document.verified_baseline.createdAt = 'not-a-time'; }],
    ['verifiedAt invalid offset', (document) => { document.verified_baseline.verifiedAt = '2026-07-16T01:02:03+99:00'; }],
  ];
  for (const [name, mutate] of timestampCases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[0]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-verified-baseline-timestamps'));
    });
  }

  const envelopeCases = [
    ['createdAt precedes capturedAt', (document) => {
      document.verified_baseline.createdAt = new Date(Date.parse(document.capturedAt) - 1).toISOString();
    }],
    ['verifiedAt precedes createdAt', (document) => {
      document.verified_baseline.verifiedAt = new Date(Date.parse(document.verified_baseline.createdAt) - 1).toISOString();
    }],
    ['verifiedAt exceeds verified_after', (document) => {
      document.verified_baseline.verifiedAt = new Date(
        Date.parse(document.binding_verification.verified_after_at) + 1,
      ).toISOString();
    }],
  ];
  for (const [name, mutate] of envelopeCases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[0]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-verified-baseline-time-envelope'));
    });
  }
});

test('binds mode-scoped compile profiles to the cold cycle, real upload stage, and baseline', async (t) => {
  const cases = [
    [
      'first baseline cannot claim the ready upload profile',
      (documents) => { documents[0].verified_baseline.environment.compileProfile = 'shared-fast'; },
      'verified-upload-profile-mode-mismatch',
    ],
    [
      'ready baseline cannot claim the first-project upload profile',
      (documents) => { documents[3].verified_baseline.environment.compileProfile = 'quick-fast'; },
      'verified-upload-profile-mode-mismatch',
    ],
    [
      'upload profile must be reported by the real upload stage',
      (documents) => { delete documents[0].cycles.upload.profile; },
      'verified-upload-profile-mode-mismatch',
    ],
    [
      'upload stage must be successful',
      (documents) => { documents[3].cycles.upload.success = false; },
      'invalid-upload-cycle',
    ],
    [
      'upload schema ID is mandatory',
      (documents) => { delete documents[0].cycles.upload.schemaId; },
      'invalid-upload-cycle',
    ],
    [
      'upload schema ID must match',
      (documents) => { documents[0].cycles.upload.schemaId = 'ck.other'; },
      'invalid-upload-cycle',
    ],
    [
      'upload schema version cannot be a string',
      (documents) => { documents[0].cycles.upload.schemaVersion = '1'; },
      'invalid-upload-cycle',
    ],
    [
      'upload wallSeconds cannot be a string',
      (documents) => { documents[0].cycles.upload.wallSeconds = '2'; },
      'invalid-upload-cycle',
    ],
    [
      'upload wallSeconds must be positive',
      (documents) => { documents[0].cycles.upload.wallSeconds = 0; },
      'invalid-upload-cycle',
    ],
    [
      'first upload cannot use shared-fast',
      (documents) => {
        documents[0].cycles.upload.profile = 'shared-fast';
        documents[0].verified_baseline.environment.compileProfile = 'shared-fast';
      },
      'verified-upload-profile-mode-mismatch',
    ],
    [
      'profile prefixes are not accepted',
      (documents) => {
        documents[3].cycles.upload.profile = 'shared-fast-forged';
        documents[3].verified_baseline.environment.compileProfile = 'shared-fast-forged';
      },
      'verified-upload-profile-mode-mismatch',
    ],
    [
      'cold compile profile is mandatory',
      (documents) => { delete documents[0].cycles.cold.profile; },
      'cold-compile-profile-mode-mismatch',
    ],
    [
      'ready cold compilation remains quick-fast',
      (documents) => { documents[3].cycles.cold.profile = 'shared-fast'; },
      'cold-compile-profile-mode-mismatch',
    ],
  ];
  for (const [name, mutate, expectedFailure] of cases) {
    await t.test(name, async (child) => {
      const workspace = await loadPassing(child, mutate);
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === expectedFailure));
    });
  }
});

test('exact, hot-edit, and optional priming cycles are independently verified native operations', async (t) => {
  const baseOperationCases = [
    ['schema ID missing', (cycle) => { delete cycle.schemaId; }],
    ['schema ID wrong', (cycle) => { cycle.schemaId = 'ck.other'; }],
    ['schema version string', (cycle) => { cycle.schemaVersion = '1'; }],
    ['kind wrong', (cycle) => { cycle.kind = 'upload'; }],
    ['success missing', (cycle) => { delete cycle.success; }],
    ['success string', (cycle) => { cycle.success = 'true'; }],
    ['wallSeconds string', (cycle) => { cycle.wallSeconds = '2'; }],
    ['wallSeconds zero', (cycle) => { cycle.wallSeconds = 0; }],
    ['profile wrong', (cycle) => { cycle.profile = 'shared-fast'; }],
  ];
  for (const [cycleName, failureId, specificCases] of [
    ['exact', 'invalid-exact-cycle', [
      ['exactMatch missing', (cycle) => { delete cycle.exactMatch; }],
      ['exactMatch false', (cycle) => { cycle.exactMatch = false; }],
      ['codeChanged missing', (cycle) => { delete cycle.codeChanged; }],
      ['codeChanged true', (cycle) => { cycle.codeChanged = true; }],
      ['codeChanged string', (cycle) => { cycle.codeChanged = 'false'; }],
    ]],
    ['hotEdit', 'invalid-hot-edit-cycle', [
      ['exactMatch missing', (cycle) => { delete cycle.exactMatch; }],
      ['exactMatch true', (cycle) => { cycle.exactMatch = true; }],
      ['codeChanged missing', (cycle) => { delete cycle.codeChanged; }],
      ['codeChanged false', (cycle) => { cycle.codeChanged = false; }],
      ['exactMatch string', (cycle) => { cycle.exactMatch = 'false'; }],
    ]],
  ]) {
    for (const [name, mutate] of [...baseOperationCases, ...specificCases]) {
      await t.test(`${cycleName} ${name}`, async (child) => {
        const workspace = await loadPassing(child, (documents) => mutate(documents[0].cycles[cycleName]));
        const summary = buildFirstCompileSummary(workspace.loaded.records);
        assert.ok(summary.failures.some((failure) => failure.id === failureId));
      });
    }
  }

  const validPriming = {
    schemaId: 'ck.native-compile-upload-operation',
    schemaVersion: 1,
    kind: 'compile',
    success: true,
    wallSeconds: 3,
    profile: 'quick-fast (exact priming)',
  };
  await t.test('valid exactPriming remains optional and accepted', async (child) => {
    const workspace = await loadPassing(child, (documents) => {
      documents[0].cycles.exactPriming = { ...validPriming };
    });
    assert.equal(buildFirstCompileSummary(workspace.loaded.records).status, 'passed');
  });
  for (const [name, mutate] of baseOperationCases) {
    await t.test(`exactPriming ${name}`, async (child) => {
      const workspace = await loadPassing(child, (documents) => {
        documents[0].cycles.exactPriming = { ...validPriming };
        mutate(documents[0].cycles.exactPriming);
      });
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.ok(summary.failures.some((failure) => failure.id === 'invalid-exact-priming-cycle'));
    });
  }
});

test('rejects mixed production process and every mode-independent environment identity field', async (t) => {
  const fields = [
    'coreId',
    'coreVersion',
    'arduinoCliVersion',
    'toolchainKey',
    'buildSignature',
    'optimization',
  ];
  for (const field of fields) {
    await t.test(`mixed ${field}`, async (child) => {
      const workspace = await loadPassing(child, (documents) => {
        documents[4].verified_baseline.environment[field] += '-drift';
      });
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === 'cross-sample-binding-mismatch'));
    });
  }
  await t.test('mixed processId', async (child) => {
    const workspace = await loadPassing(child, null, {
      afterBind: async (_context, documents) => {
        documents[4].executable.process_id = 5252;
        documents[4].cdp_binding.process_id = 5252;
      },
    });
    const summary = buildFirstCompileSummary(workspace.loaded.records);
    assert.equal(summary.status, 'failed');
    assert.ok(summary.failures.some((failure) => failure.id === 'cross-sample-binding-mismatch'));
  });
  for (const [name, mutate] of [
    ['project', (document) => { document.project = 'different-project'; }],
    ['port', (document) => { document.port = 'COM13'; }],
    ['chip', (document) => { document.verified_baseline.device.chip = 'ESP32-C5'; }],
    ['revision', (document) => { document.verified_baseline.device.revision = 'v9.9'; }],
    ['Flash', (document) => { document.verified_baseline.device.flashBytes = 8 * 1024 * 1024; }],
    ['PSRAM', (document) => { document.verified_baseline.device.psramBytes = 8 * 1024 * 1024; }],
  ]) {
    await t.test(`mixed ${name}`, async (child) => {
      const workspace = await loadPassing(child, (documents) => mutate(documents[4]));
      const summary = buildFirstCompileSummary(workspace.loaded.records);
      assert.equal(summary.status, 'failed');
      assert.ok(summary.failures.some((failure) => failure.id === 'cross-sample-binding-mismatch'));
    });
  }
});

test('duplicate run IDs cannot inflate a mode sample count', async (t) => {
  const workspace = await loadPassing(t, (documents) => {
    documents[5].runId = documents[4].runId;
  });
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.status, 'failed');
  assert.ok(summary.failures.some((failure) => failure.id === 'duplicate-run-id'));
  assert.equal(summary.samples.readyInstallCold.length, 2);
});

test('loader refuses external inputs and reference path traversal without reading them', async (t) => {
  const documents = passingDocuments();
  const workspace = await createEvidenceWorkspace(documents);
  t.after(workspace.cleanup);
  const outside = await mkdtemp(path.join(os.tmpdir(), 'ck-first-compile-outside-'));
  t.after(() => rm(outside, { recursive: true, force: true }));
  const outsideReport = path.join(outside, 'outside.json');
  await writeJson(outsideReport, documents[0]);
  const external = await loadBenchmarkRecords({ inputPaths: [outsideReport], root: workspace.root });
  assert.equal(external.records.length, 0);
  assert.ok(external.errors.some((error) => error.id === 'input-path-escape'));
  assert.doesNotMatch(JSON.stringify(external), new RegExp(outside.replace(/[.*+?^${}()|[\]\\]/g, '\\$&'), 'i'));

  const escapedDocuments = passingDocuments();
  const escaped = await createEvidenceWorkspace(escapedDocuments, {
    afterBind: async (_context, values) => {
      values[0].source_tree.manifest_path = '../outside.json';
    },
  });
  t.after(escaped.cleanup);
  assert.equal(escaped.loaded.records.length, 5);
  assert.ok(escaped.loaded.errors.some((error) => error.id === 'reference-path-escape'));
});

test('loader rejects forged or stale manifest, freeze, gate, and executable identities', async (t) => {
  const cases = [
    ['manifest claim', async (_context, documents) => { documents[0].source_tree.manifest_sha256 = sha('f'); }, 'source-manifest-sha-mismatch'],
    ['freeze claim', async (_context, documents) => { documents[0].source_tree.freeze_record_sha256 = sha('f'); }, 'source-freeze-sha-mismatch'],
    ['gate claim', async (_context, documents) => { documents[0].gate_run.report_sha256 = sha('f'); }, 'gate-report-sha-mismatch'],
    ['gate finished time claim', async (_context, documents) => {
      documents[0].gate_run.finished_at = new Date(Date.parse(GATE_FINISHED_AT) + 1).toISOString();
    }, 'gate-report-finished-at-mismatch'],
    ['executable claim', async (_context, documents) => { documents[0].executable.sha256 = sha('f'); }, 'production-executable-binding-mismatch'],
    ['executable size string', async (_context, documents) => { documents[0].executable.bytes = '29'; }, 'production-executable-binding-mismatch'],
    ['stale source file', async (context) => { await writeFile(context.paths.source, 'changed source\n'); }, 'source-file-binding-mismatch', 0],
  ];
  for (const [name, afterBind, expected, expectedValid = 5] of cases) {
    await t.test(name, async (child) => {
      const workspace = await createEvidenceWorkspace(passingDocuments(), { afterBind });
      child.after(workspace.cleanup);
      assert.equal(workspace.loaded.records.length, expectedValid);
      assert.ok(workspace.loaded.errors.some((error) => error.id === expected));
    });
  }
});

test('loader verification errors cannot be hidden while retaining enough valid samples', async (t) => {
  const documents = passingDocuments();
  documents.push(benchmarkFixture({
    mode: 'firstProjectCold',
    runId: 'forged-extra-private',
    seconds: 105,
  }));
  const workspace = await createEvidenceWorkspace(documents, {
    afterBind: async (_context, values) => {
      values.at(-1).source_tree.manifest_sha256 = sha('f');
    },
  });
  t.after(workspace.cleanup);
  assert.equal(workspace.loaded.records.length, 6);
  assert.equal(workspace.loaded.errors.length, 1);
  const summary = buildFirstCompileSummary(workspace.loaded.records);
  assert.equal(summary.statistics.firstProjectCold.count, 3);
  assert.equal(summary.statistics.readyInstallCold.count, 3);
  assert.equal(summary.status, 'failed');
  assert.ok(summary.failures.some((failure) => failure.id === 'source-manifest-sha-mismatch'));
});

test('a self-consistent-looking forged manifest tree is recomputed and rejected', async (t) => {
  const forgedTree = sha('f');
  const workspace = await createEvidenceWorkspace(passingDocuments(), {
    afterBind: async (context, documents) => {
      context.manifest.tree_sha256 = forgedTree;
      await writeJson(context.paths.manifest, context.manifest);
      context.manifestSha = await fileDigest(context.paths.manifest);
      context.freeze.manifest_sha256 = context.manifestSha;
      context.freeze.tree_sha256 = forgedTree;
      await writeJson(context.paths.freeze, context.freeze);
      context.freezeSha = await fileDigest(context.paths.freeze);
      context.gate.source_tree.identity.manifest_sha256 = context.manifestSha;
      context.gate.source_tree.identity.tree_sha256 = forgedTree;
      await writeJson(context.paths.gate, context.gate);
      context.gateSha = await fileDigest(context.paths.gate);
      context.treeSha = forgedTree;
      context.bindDocuments();
    },
  });
  t.after(workspace.cleanup);
  assert.equal(workspace.loaded.records.length, 0);
  assert.equal(workspace.loaded.errors.length, 6);
  assert.ok(workspace.loaded.errors.every((error) => error.id === 'source-manifest-tree-mismatch'));
});

test('a failed gate cannot pass by updating only its reported hash', async (t) => {
  const workspace = await createEvidenceWorkspace(passingDocuments(), {
    afterBind: async (context, documents) => {
      context.gate.status = 'failed';
      await writeJson(context.paths.gate, context.gate);
      context.gateSha = await fileDigest(context.paths.gate);
      for (const document of documents) document.gate_run.report_sha256 = context.gateSha;
    },
  });
  t.after(workspace.cleanup);
  assert.equal(workspace.loaded.records.length, 0);
  assert.ok(workspace.loaded.errors.every((error) => error.id === 'gate-report-binding-mismatch'));
});

test('input directory loads root-contained reports and ignores a prior summary', async (t) => {
  const documents = passingDocuments();
  const workspace = await createEvidenceWorkspace(documents);
  t.after(workspace.cleanup);
  await writeJson(path.join(workspace.paths.reports, 'summary.json'), { schemaId: SUMMARY_SCHEMA_ID });
  const loaded = await loadBenchmarkRecords({
    inputDirectory: 'evidence',
    root: workspace.root,
  });
  assert.equal(loaded.records.length, 6);
  assert.deepEqual(loaded.errors, []);
});

test('writes reports atomically and replaces an existing destination', async (t) => {
  const temporary = await mkdtemp(path.join(os.tmpdir(), 'ck-first-compile-write-'));
  t.after(() => rm(temporary, { recursive: true, force: true }));
  const output = path.join(temporary, 'nested', 'summary.json');
  await writeJsonAtomic(output, { version: 1 });
  await writeJsonAtomic(output, { version: 2 });
  assert.deepEqual(JSON.parse(await readFile(output, 'utf8')), { version: 2 });
  const entries = await readdir(path.dirname(output));
  assert.deepEqual(entries, ['summary.json']);
});

test('strict CLI writes a failed report and exits nonzero without compiling', async (t) => {
  const documents = passingDocuments();
  documents[5].cycles.cold.wallSeconds = 110;
  const workspace = await createEvidenceWorkspace(documents);
  t.after(workspace.cleanup);
  const output = path.join(workspace.root, 'artifacts', 'summary.json');
  const result = spawnSync(process.execPath, [
    scriptPath,
    '--input-dir', 'evidence',
    '--root', workspace.root,
    '--output', output,
    '--strict',
  ], { encoding: 'utf8' });
  assert.equal(result.status, 1, result.stderr || result.stdout);
  const summary = JSON.parse(await readFile(output, 'utf8'));
  assert.equal(summary.status, 'failed');
  assert.ok(summary.failures.some((failure) => failure.id === 'p95-improvement-target-missed'));
});

test('aggregator source has no compiler, upload, or process-launch path', async () => {
  const source = await readFile(scriptPath, 'utf8');
  assert.doesNotMatch(source, /node:child_process|spawn\s*\(|exec(?:File|Sync)?\s*\(/);
  assert.doesNotMatch(source, /arduino-cli|compile_sketch|upload_sketch|Benchmark-CompileUploadNative/i);
});

test('PowerShell wrapper parses cleanly under Windows PowerShell 5.1', async () => {
  const escaped = wrapperPath.replaceAll("'", "''");
  const command = [
    '$tokens = $null',
    '$errors = $null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}', [ref]$tokens, [ref]$errors) | Out-Null`,
    'if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }',
  ].join('; ');
  const shell = process.platform === 'win32' ? 'powershell.exe' : 'pwsh';
  const result = spawnSync(shell, [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { encoding: 'utf8' });
  assert.equal(result.status, 0, result.stderr || result.stdout);
});
