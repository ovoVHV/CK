import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, rm, writeFile } from 'node:fs/promises';
import os from 'node:os';
import path from 'node:path';

import {
  ARTIFACT_GATE_SCHEMA_ID,
  BENCHMARK_SCHEMA_ID,
  OPERATION_SCHEMA_ID,
  SUMMARY_SCHEMA_ID,
  UPLOAD_PROGRESS_SCHEMA_ID,
  buildSummary,
  canonicalizeFqbn,
  extractColdCacheReset,
  renderConsole,
  renderMarkdown,
  scanEvidenceDirectory,
  targetIdFromFqbn,
} from './Summarize-CompileRegression.mjs';

const fqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB';
const capturedAt = '2026-07-12T12:00:00.000Z';
const runId = 'native-verified-c6';
const codeFingerprint = '2043:72fa818c';
const includeSignature = 'wifi.h';

function record(relativePath, document) {
  return { relativePath, absolutePath: relativePath, document };
}

function binding(overrides = {}) {
  return {
    source_tree: {
      manifest_sha256: '1'.repeat(64),
      freeze_record_sha256: '2'.repeat(64),
      tree_sha256: '3'.repeat(64),
    },
    gate_run: {
      status: 'passed',
      run_id: 'release-gate-run',
      report_sha256: '4'.repeat(64),
    },
    executable: {
      sha256: '5'.repeat(64),
      bytes: 123456,
      process_id: 4321,
      process_started_at: '2026-07-12T11:50:00.000Z',
    },
    cdp_binding: {
      bound: true,
      process_id: 4321,
      browser_process_id: 5432,
      target_id: 'verified-page',
      executable_sha256: '5'.repeat(64),
    },
    binding_verification: {
      schema_version: 1,
      verified_before_at: '2026-07-12T11:59:00.000Z',
      verified_after_at: '2026-07-12T12:31:00.000Z',
      unchanged: true,
    },
    ...overrides,
  };
}

function operation(kind, overrides = {}) {
  return {
    schemaId: OPERATION_SCHEMA_ID,
    schemaVersion: 1,
    kind,
    success: true,
    wallSeconds: 1,
    ...overrides,
  };
}

function gateIdentity(
  targetFqbn = fqbn,
  project = 'c6_regression.maker',
  fingerprint = codeFingerprint,
) {
  return {
    before: {
      project,
      codeFingerprint: fingerprint,
      includeSignature,
      fqbn: targetFqbn,
      port: 'COM12',
    },
    after: {
      project,
      codeFingerprint: fingerprint,
      includeSignature,
      fqbn: targetFqbn,
      port: 'COM12',
    },
    unchanged: true,
  };
}

function passingCycles() {
  return {
    cold: operation('compile', {
      wallSeconds: 100,
      reportedSeconds: 99.8,
      fullBuild: true,
      exactMatch: false,
    }),
    exact: operation('compile', {
      wallSeconds: 1,
      exactMatch: true,
      fullBuild: false,
    }),
    hotEdit: operation('compile', {
      wallSeconds: 12,
      exactMatch: false,
      codeChanged: true,
      fastRelink: true,
    }),
    upload: operation('upload', {
      wallSeconds: 20,
      uploadTransportSeconds: 18,
    }),
  };
}

function passingGate(overrides = {}) {
  return {
    schemaId: ARTIFACT_GATE_SCHEMA_ID,
    schemaVersion: 2,
    capturedAt: '2026-07-12T12:30:00.000Z',
    status: 'passed',
    project: 'c6_regression',
    fqbn,
    port: 'COM12',
    gate: {
      exactMatchBeforeRejection: true,
      fqbnMismatchRejected: true,
      transportBlockedUntilRejection: true,
      sharedFastFreshBuild: true,
      sharedFastManifestVerified: true,
      transportRevalidated: true,
      transportObservedAfterRevalidation: true,
      ordinaryUploadSucceeded: true,
      allTargetFqbnsExact: true,
    },
    hashGate: {
      exactMatchBeforeRejection: true,
      artifactHashMismatchRejected: true,
      transportBlockedUntilHashRejection: true,
      sharedFastFreshBuild: true,
      sharedFastManifestVerified: true,
      transportRevalidated: true,
      transportObservedAfterRevalidation: true,
      ordinaryUploadSucceeded: true,
      allTargetFqbnsExact: true,
      artifactRole: 'esp32-application',
    },
    restoration: {
      requested: true,
      completed: true,
      valid: true,
      originalHashRestored: true,
      backupRemoved: true,
      residueRemoved: true,
    },
    hashRestoration: {
      requested: true,
      completed: true,
      valid: true,
      originalHashRestored: true,
      backupRemoved: true,
      residueRemoved: true,
    },
    identity: gateIdentity(),
    ...binding(),
    ...overrides,
  };
}

function passingBenchmark(overrides = {}) {
  return {
    schemaId: BENCHMARK_SCHEMA_ID,
    schemaVersion: 1,
    status: 'passed',
    runId,
    evidenceScope: 'single-native-session',
    capturedAt,
    project: 'c6_regression',
    fqbn,
    port: 'COM12',
    sourceGate: {
      initial: { codeFingerprint, includeSignature },
      restored: { codeFingerprint, includeSignature },
    },
    cycles: passingCycles(),
    ...binding(),
    ...overrides,
  };
}

function passingProgress(overrides = {}) {
  const samples = [{ percentage: 42 }, { percentage: 100 }];
  return {
    schemaId: UPLOAD_PROGRESS_SCHEMA_ID,
    schemaVersion: 1,
    status: 'passed',
    benchmarkRunId: runId,
    capturedAt: '2026-07-12T12:20:00.000Z',
    project: 'c6_regression',
    fqbn,
    port: 'COM12',
    success: true,
    sampleCount: samples.length,
    valuesBounded: true,
    integerPercentages: true,
    monotonic: true,
    hasTwoDigitPercentage: true,
    finalPercentageIs100: true,
    percentageTextComplete: true,
    percentageTextFits: true,
    failures: [],
    samples,
    ...binding(),
    ...overrides,
  };
}

test('canonicalizes option order and identifies the requested target families', () => {
  assert.equal(
    canonicalizeFqbn('esp32:esp32:esp32c6:PartitionScheme=default,FlashSize=8M'),
    canonicalizeFqbn('ESP32:ESP32:ESP32C6:FlashSize=8M,PartitionScheme=default'),
  );
  assert.equal(targetIdFromFqbn(fqbn), 'esp32-c6');
  assert.equal(targetIdFromFqbn('arduino:avr:nano:cpu=atmega328old'), 'avr');
  assert.equal(targetIdFromFqbn('esp8266:esp8266:nodemcuv2'), null);
  assert.equal(canonicalizeFqbn('esp32:esp32:esp32c6:FlashSize=4M,FlashSize=16M'), '');
  assert.equal(targetIdFromFqbn('arduino:avr::cpu=atmega328'), null);
  assert.equal(targetIdFromFqbn('arduino:avr:nano:cpu='), null);
});

test('keeps cold cache-reset scope explicit and leaves unsupported old evidence unknown', () => {
  const oldEvidence = extractColdCacheReset({
    fqbn,
    cacheClear: {
      fqbn,
      removed_entries: 7,
      removed_bytes: 1024,
      force_rebuild_pending: true,
    },
  }, { evidence: [] });
  assert.deepEqual(oldEvidence, {
    scope: 'exact-full-fqbn',
    requested: true,
    targetFqbn: fqbn,
    removedEntries: 7,
    removedBytes: 1024,
    forceRebuildPending: true,
    ccacheStore: 'unknown',
    prebuiltCore: 'unknown',
    forceCcacheRecache: 'unknown',
    prebuiltCoreReusedAfterReset: 'unknown',
    evidence: ['cache-clear report targets the exact full FQBN'],
  });

  const explicitEvidence = extractColdCacheReset({
    fqbn,
    cacheReset: {
      fqbn,
      reset_scope: 'exact-full-fqbn',
      ccache_store_preserved: true,
      prebuilt_core_preserved: false,
      force_ccache_recache: true,
    },
  }, { evidence: [] });
  assert.equal(explicitEvidence.ccacheStore, 'preserved');
  assert.equal(explicitEvidence.prebuiltCore, 'cleared');
  assert.equal(explicitEvidence.forceCcacheRecache, 'enabled');
});

test('aggregates a single-session compile report and exact-FQBN supplements without claiming a current run', () => {
  const records = [
    record('c6-final.json', passingBenchmark()),
    record('c6-upload.json', passingProgress()),
    record('c6-gate.json', passingGate()),
  ];
  const summary = buildSummary(records, { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = summary.targets.find((target) => target.id === 'esp32-c6');
  const s3 = summary.targets.find((target) => target.id === 'esp32-s3');

  assert.equal(summary.currentRunExecuted, false);
  assert.equal(summary.generationMode, 'evidence-only');
  assert.equal(c6.status, 'complete');
  assert.deepEqual(Object.values(c6.stages).map((stage) => stage.status), Array(5).fill('passed'));
  assert.equal(c6.stages.hotEdit.details.improvementPercent, 88);
  assert.equal(c6.stages.cold.source.sameInvocationAsSummary, false);
  assert.equal(c6.stages.cold.source.evidenceMode, 'imported-evidence');
  assert.equal(c6.evidence.artifactGateReport.path, 'c6-gate.json');
  assert.equal(c6.stages.cold.details.cacheReset.scope, 'unknown');
  assert.equal(c6.stages.cold.details.cacheReset.ccacheStore, 'unknown');
  assert.equal(s3.status, 'incomplete');
  assert.deepEqual(Object.values(s3.stages).map((stage) => stage.status), Array(5).fill('missing'));

  const markdown = renderMarkdown(summary);
  assert.match(markdown, /本命令没有执行编译、上传、串口或真机操作/);
  assert.match(markdown, /“通过\*”均为带捕获时间与来源路径的导入证据/);
  assert.match(markdown, /冷编译缓存口径：scope=unknown；ccache store=unknown；prebuilt core=unknown；force recache=unknown/);
  assert.match(renderConsole(summary), /仅汇总证据；本命令未运行编译\/上传\/串口/);
});

test('keeps skipped, failed, and missing distinct', () => {
  const cycles = passingCycles();
  delete cycles.cold;
  cycles.hotEdit.exactMatch = true;
  const summary = buildSummary([
    record('c6-partial.json', passingBenchmark({
      skippedStages: [{ stage: 'cold', reason: 'operator requested -SkipCold' }],
      cycles,
    })),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = summary.targets.find((target) => target.id === 'esp32-c6');

  assert.equal(c6.stages.cold.status, 'skipped');
  assert.equal(c6.stages.hotEdit.status, 'failed');
  assert.equal(c6.stages.artifactGate.status, 'missing');
  assert.equal(summary.overallStatus, 'failed');
});

test('does not merge artifact-gate evidence from a different full FQBN', () => {
  const otherFqbn = 'esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=default_8MB';
  const summary = buildSummary([
    record('c6-final.json', passingBenchmark()),
    record('c6-other-config-gate.json', passingGate({
      fqbn: otherFqbn,
      identity: gateIdentity(otherFqbn),
    })),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = summary.targets.find((target) => target.id === 'esp32-c6');

  assert.equal(c6.stages.artifactGate.status, 'missing');
  assert.deepEqual(c6.evidence.ignoredConfigurationEvidence, [{
    path: 'c6-other-config-gate.json',
    fqbn: otherFqbn,
    reason: 'different full FQBN; not merged into this row',
  }]);
});

test('rejects the schema-less 25-of-25 forged evidence attack and loose JSON numbers', () => {
  const targetFqbns = [
    'esp32:esp32:esp32c3:FlashSize=4M',
    'esp32:esp32:esp32c5:FlashSize=16M',
    fqbn,
    'esp32:esp32:esp32s3:FlashSize=16M',
    'arduino:avr:uno',
  ];
  const forged = targetFqbns.map((targetFqbn, index) => record(`forged-${index}.json`, {
    fqbn: targetFqbn,
    cycles: {
      cold: { kind: 'compile', wallSeconds: '0', fullBuild: true },
      exact: { kind: 'compile', wallSeconds: false, exactMatch: true },
      hotEdit: { kind: 'compile', wallSeconds: [], codeChanged: true },
      upload: { kind: 'upload', wallSeconds: null },
    },
    artifactGate: { passed: true },
  }));
  const summary = buildSummary(forged, { now: new Date('2026-07-13T12:00:00.000Z') });
  assert.equal(summary.overallStatus, 'incomplete');
  assert.equal(summary.counts.passed, 0);
  assert.equal(summary.counts.missing, 25);
  assert.ok(summary.targets.every((target) => target.evidence.ignoredLegacyEvidence.length === 1));

  const malformedCycles = passingCycles();
  malformedCycles.cold.wallSeconds = '100';
  malformedCycles.exact.fullBuild = undefined;
  malformedCycles.hotEdit.exactMatch = undefined;
  malformedCycles.upload.success = 'true';
  const typed = buildSummary([
    record('typed-main.json', passingBenchmark({ cycles: malformedCycles })),
    record('typed-gate.json', passingGate()),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = typed.targets.find((target) => target.id === 'esp32-c6');
  assert.deepEqual(
    ['cold', 'exact', 'hotEdit', 'upload'].map((stage) => c6.stages[stage].status),
    ['failed', 'failed', 'failed', 'failed'],
  );
});

test('does not splice gate or upload progress across source, executable, process, or run bindings', () => {
  const otherBinding = binding({
    source_tree: {
      manifest_sha256: 'a'.repeat(64),
      freeze_record_sha256: 'b'.repeat(64),
      tree_sha256: 'c'.repeat(64),
    },
    executable: {
      sha256: 'd'.repeat(64),
      bytes: 123456,
      process_id: 9876,
      process_started_at: '2026-07-12T11:50:00.000Z',
    },
    cdp_binding: {
      bound: true,
      process_id: 9876,
      browser_process_id: 6789,
      target_id: 'other-page',
      executable_sha256: 'd'.repeat(64),
    },
  });
  const summary = buildSummary([
    record('candidate-a.json', passingBenchmark()),
    record('candidate-b-progress.json', passingProgress({ ...otherBinding })),
    record('candidate-b-gate.json', passingGate({ ...otherBinding })),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = summary.targets.find((target) => target.id === 'esp32-c6');
  assert.equal(c6.stages.upload.status, 'passed', 'the upload cycle remains part of the trusted main report');
  assert.equal(c6.stages.upload.details.dedicatedProgressReport, 'missing');
  assert.equal(c6.stages.artifactGate.status, 'missing');
  assert.equal(c6.status, 'incomplete');
  assert.ok(c6.evidence.ignoredConfigurationEvidence.every((entry) => (
    entry.reason === 'different source/gate/executable/process binding; not merged into this row'
  )));
});

test('does not reuse a same-process gate captured for a different project source', () => {
  const summary = buildSummary([
    record('candidate-main.json', passingBenchmark()),
    record('other-project-gate.json', passingGate({
      project: 'other_project',
      identity: gateIdentity(fqbn, 'other_project.maker', '999:other-source'),
    })),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  const c6 = summary.targets.find((target) => target.id === 'esp32-c6');
  assert.equal(c6.stages.artifactGate.status, 'missing');
  assert.equal(
    c6.evidence.ignoredConfigurationEvidence[0].reason,
    'different project/source/include identity; not merged into this row',
  );
});

test('requires valid non-future timestamps and makes stale evidence fail only in Strict mode', () => {
  const staleRecords = [
    record('stale-main.json', passingBenchmark()),
    record('stale-gate.json', passingGate()),
  ];
  const ordinary = buildSummary(staleRecords, {
    now: new Date('2026-08-01T12:00:00.000Z'),
    maxAgeHours: 1,
  });
  const ordinaryC6 = ordinary.targets.find((target) => target.id === 'esp32-c6');
  assert.equal(ordinaryC6.stages.cold.status, 'passed');
  assert.equal(ordinaryC6.evidence.cycleReport.freshness, 'stale');
  assert.equal(ordinary.sourceErrors.length, 0);

  const strict = buildSummary(staleRecords, {
    now: new Date('2026-08-01T12:00:00.000Z'),
    maxAgeHours: 1,
    strictFreshness: true,
  });
  assert.equal(strict.overallStatus, 'failed');
  assert.ok(strict.sourceErrors.every((error) => /stale in Strict mode/.test(error.error)));

  for (const captured of ['not-a-date', '2099-01-01T00:00:00.000Z']) {
    const invalid = buildSummary([
      record('invalid-time.json', passingBenchmark({ capturedAt: captured })),
    ], { now: new Date('2026-07-13T12:00:00.000Z') });
    assert.equal(invalid.overallStatus, 'failed');
    assert.equal(invalid.counts.passed, 0);
  }
});

test('requires the recognized manifest gate schema and every deterministic gate boolean', () => {
  const generic = buildSummary([
    record('main.json', passingBenchmark()),
    record('generic.json', {
      capturedAt: '2026-07-12T12:30:00.000Z',
      fqbn,
      artifactGate: { status: 'failed', passed: true },
      ...binding(),
    }),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  assert.equal(generic.targets.find((target) => target.id === 'esp32-c6').stages.artifactGate.status, 'missing');

  const brokenGate = passingGate();
  brokenGate.hashGate.transportBlockedUntilHashRejection = false;
  const broken = buildSummary([
    record('main.json', passingBenchmark()),
    record('broken-gate.json', brokenGate),
  ], { now: new Date('2026-07-13T12:00:00.000Z') });
  assert.equal(broken.overallStatus, 'failed');
  assert.match(broken.sourceErrors[0].error, /artifact-gate schema or deterministic gate assertions/);
});

test('scanner reports malformed evidence and ignores its own prior summary', async () => {
  const directory = await mkdtemp(path.join(os.tmpdir(), 'ck-regression-summary-'));
  try {
    await writeFile(path.join(directory, 'valid.json'), JSON.stringify(passingBenchmark()));
    await writeFile(path.join(directory, 'invalid.json'), '{not-json');
    await writeFile(path.join(directory, 'previous-summary.json'), JSON.stringify({ schemaId: SUMMARY_SCHEMA_ID }));
    const scanned = await scanEvidenceDirectory(directory);
    assert.deepEqual(scanned.records.map((item) => item.relativePath), ['valid.json']);
    assert.equal(scanned.errors.length, 1);
    assert.equal(scanned.errors[0].path, 'invalid.json');
  } finally {
    await rm(directory, { recursive: true, force: true });
  }
});
