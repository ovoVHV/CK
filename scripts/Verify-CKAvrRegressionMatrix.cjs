#!/usr/bin/env node
'use strict';

// Independent, read-only terminal verifier for a complete AVR regression
// matrix. It never starts CK/Arduino, clears caches, writes evidence or trusts
// the report's own aggregate pass flags without recomputing them.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORT_SCHEMA_ID = 'ck.avr.compile-regression-report';
const VERIFICATION_SCHEMA_ID = 'ck.avr.compile-regression-verification';
const REPORT_SCHEMA_VERSION = 1;
const EXPECTED_TARGET_COUNT = 38;
const EXPECTED_WORKLOAD_COUNT = 3;
const EXPECTED_CELL_COUNT = 114;
const EXPECTED_APPLICABLE_CELL_COUNT = 112;
const EXPECTED_SKIP_CELL_COUNT = 2;
const EXPECTED_STAGE_PAIR_COUNT = 448;
const EXPECTED_COMPILE_CALL_COUNT = 896;
const SHA256_RE = /^[0-9a-f]{64}$/u;

function fail(message) {
  throw new Error(message);
}

function assert(condition, message) {
  if (!condition) fail(message);
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function assertSha(value, label) {
  assert(typeof value === 'string' && SHA256_RE.test(value), `${label} is not a SHA-256 digest`);
}

function regularFile(file, label, maximumBytes = 128 * 1024 * 1024) {
  const resolved = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail(`${label} is missing: ${resolved}`); }
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert(stat.size > 0 && stat.size <= maximumBytes, `${label} size is outside 1..${maximumBytes}`);
  return { file: resolved, stat };
}

function readJson(file, label) {
  const regular = regularFile(file, label);
  const bytes = fs.readFileSync(regular.file);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
  return { ...regular, bytes, value };
}

function parseArgs(argv) {
  const options = { input: null, expectedExecutable: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--input') {
      options.input = argv[++index];
      if (!options.input) throw new Error('--input requires a JSON file');
    } else if (argument === '--expected-executable') {
      options.expectedExecutable = argv[++index];
      if (!options.expectedExecutable) throw new Error('--expected-executable requires a file');
    }
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (!options.help && !options.input) throw new Error('--input <full-matrix.json> is required');
  return options;
}

function usage() {
  return `Read-only verification of a complete CK AVR regression matrix

Usage:
  node scripts/Verify-CKAvrRegressionMatrix.cjs --input <report.json> [options]

Options:
  --expected-executable <file>  Production appsdesktop.exe; defaults to target/release/appsdesktop.exe

The verifier performs no compile, upload, cache reset or evidence write.
`;
}

function expectedFullPlan() {
  const plan = matrix.planFor(matrix.parseArgs(['--plan']));
  assert(plan.targets.length === EXPECTED_TARGET_COUNT, 'current runner does not define exactly 38 AVR targets');
  assert(plan.workloads.length === EXPECTED_WORKLOAD_COUNT, 'current runner does not define exactly three workloads');
  assert(plan.cellCount === EXPECTED_CELL_COUNT
    && plan.applicableCellCount === EXPECTED_APPLICABLE_CELL_COUNT
    && plan.expectedSkipCellCount === EXPECTED_SKIP_CELL_COUNT
    && plan.totalCompileCount === EXPECTED_COMPILE_CALL_COUNT,
  'current runner full-plan counts differ from the fixed AVR matrix contract');
  return plan;
}

function artifactSetSha256(artifacts) {
  return forge.digestObject(artifacts.map(({ name, bytes, sha256, primaryApplication, role }) => ({
    name, bytes, sha256, primaryApplication, role,
  })));
}

function validateArtifacts(artifacts, label) {
  assert(Array.isArray(artifacts) && artifacts.length > 0, `${label} has no artifacts`);
  const names = new Set();
  for (const [index, artifact] of artifacts.entries()) {
    assert(artifact && typeof artifact === 'object', `${label} artifact ${index} is invalid`);
    assert(typeof artifact.name === 'string' && artifact.name.length > 0 && !names.has(artifact.name),
      `${label} artifact ${index} has an empty or duplicate name`);
    names.add(artifact.name);
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, `${label} artifact ${artifact.name} has invalid bytes`);
    assertSha(artifact.sha256, `${label} artifact ${artifact.name}`);
    assert(typeof artifact.primaryApplication === 'boolean', `${label} artifact ${artifact.name} has invalid primary flag`);
    assert(typeof artifact.role === 'string' && artifact.role.length > 0, `${label} artifact ${artifact.name} has no role`);
  }
}

function expectedRunEvidenceSha256(run, lane) {
  const { evidenceSha256, ...unsigned } = run;
  if (unsigned.integritySchemaVersion === 2) {
    delete unsigned.wallMs;
    unsigned.rawTiming = unsigned.rawTiming && typeof unsigned.rawTiming === 'object'
      ? { runnerWallNs: unsigned.rawTiming.runnerWallNs }
      : null;
  } else {
    assert(lane === 'ck' && unsigned.integritySchemaVersion == null,
      `${lane} run uses an unsupported integrity schema`);
    // Matrix schema v1 CK evidence intentionally retained the key with an
    // undefined value in its canonical projection.
    unsigned.wallMs = undefined;
  }
  return forge.digestObject(unsigned);
}

function validateResources(resources, label) {
  assert(resources?.evidenceComplete === true, `${label} resource evidence is incomplete`);
  assert(Number.isSafeInteger(resources.flashUsedBytes) && resources.flashUsedBytes >= 0,
    `${label} Flash usage is invalid`);
  assert(Number.isSafeInteger(resources.ramUsedBytes) && resources.ramUsedBytes >= 0,
    `${label} RAM usage is invalid`);
}

function validateRun(run, context) {
  const { lane, stageId, trialId, fqbn, sourceSha256, targetIdentity, jobs } = context;
  const label = `${context.cellId} ${trialId} ${lane} ${stageId}`;
  assert(run && typeof run === 'object', `${label} run is missing`);
  assert(run.trialId === trialId && run.phase === stageId, `${label} trial/stage binding differs`);
  assert(run.success === true && run.compileOnly === true && run.uploadPerformed === false,
    `${label} is not a successful compile-only run`);
  assert(run.exactUsed === false, `${label} used Exact instead of a compiler invocation`);
  assert(Number.isFinite(run.wallMs) && run.wallMs > 0, `${label} wall time is invalid`);
  assert(typeof run.rawTiming?.runnerWallNs === 'string' && /^[1-9]\d*$/u.test(run.rawTiming.runnerWallNs),
    `${label} runner wall clock is missing`);
  assert(Math.abs(Number(BigInt(run.rawTiming.runnerWallNs)) / 1e6 - run.wallMs) < 0.001,
    `${label} wall time differs from its monotonic runner clock`);
  assert(run.profile === 'release', `${label} is not a Release compile`);
  assert(run.jobs === jobs && Number.isSafeInteger(run.jobs) && run.jobs > 0, `${label} jobs differ across lanes`);
  assert(run.fqbn === fqbn, `${label} complete FQBN differs`);
  assert(run.codeSha256 === sourceSha256, `${label} source SHA differs from the immutable plan`);
  validateResources(run.resources, label);
  validateArtifacts(run.artifacts, label);
  assertSha(run.artifactSetSha256, `${label} artifact set`);
  assert(run.artifactSetSha256 === artifactSetSha256(run.artifacts), `${label} artifact-set SHA does not reproduce`);
  assertSha(run.evidenceSha256, `${label} evidence`);
  assert(run.evidenceSha256 === expectedRunEvidenceSha256(run, lane), `${label} evidence SHA does not reproduce`);

  if (lane === 'ck') {
    assert(run.fallback?.used === false, `${label} used a fallback route`);
    assert(run.cache?.exactMatch === false, `${label} cache evidence claims Exact`);
    assert(Array.isArray(run.cache?.nativeRelinkDiagnostics), `${label} NativeRelink diagnostics are missing`);
    assert(typeof run.toolchainKey === 'string' && run.toolchainKey.length > 0, `${label} toolchain key is missing`);
    assert(run.cliVersion === targetIdentity.cliVersion, `${label} CLI identity differs from target preflight`);
    assert(run.route?.id === 'ck-forge' && run.route?.coreVersion === targetIdentity.coreVersion,
      `${label} CK Forge/Core route identity differs`);
    assertSha(run.responseSha256, `${label} response`);
    if (stageId === 'simple') {
      assert(run.buildMode === 'full-build', `${label} is not the authenticated baseline build`);
      assert(run.cache.nativeRelinkDiagnostics.some((line) => (
        typeof line === 'string' && line.includes('NativeRelink AVR Release baseline committed (authorization=certified)')
      )), `${label} did not commit the certified AVR baseline`);
    } else {
      assert(run.buildMode === 'native-relink-compile-only', `${label} did not use NativeRelinkCompileOnly`);
      assert(run.cache.nativeRelinkDiagnostics.some((line) => (
        typeof line === 'string' && line.includes('NativeRelinkCompileOnly path:')
      )), `${label} has no NativeRelink path evidence`);
      assert(!run.artifacts.some((artifact) => artifact.role === 'avr-with-bootloader'),
        `${label} retained a stale with-bootloader artifact`);
    }
    assert(run.cache.nativeRelinkDiagnostics.some((line) => (
      typeof line === 'string' && line.includes('NativeRelinkCompileOnly certificate matched')
    )), `${label} has no exact certificate-match evidence`);
  } else {
    const expectedMode = stageId === 'simple' ? 'native-fresh-build' : 'native-incremental-edit';
    assert(run.buildMode === expectedMode, `${label} native build mode differs`);
    assert(run.artifactsVerified === true && run.integritySchemaVersion === 2,
      `${label} native artifact integrity was not verified`);
    assertSha(run.buildPathIdentitySha256, `${label} build-path identity`);
    assertSha(run.stdoutSha256, `${label} stdout`);
    assertSha(run.stderrSha256, `${label} stderr`);
    const expectedCommand = [
      '<BUNDLED_CLI>', '--config-file', '<CK_ROOT>/arduino-cli.yaml', 'compile',
      '--jobs', String(jobs), '--discovery-timeout', '100ms', '-b', fqbn,
      '--build-path', '<AB_WORKDIR>/build/<project>', '--no-color', '<AB_WORKDIR>/<project>',
    ];
    assert(canonicalJson(run.command) === canonicalJson(expectedCommand),
      `${label} native command is not the exact bundled compile-only command`);
  }
}

function validateTargetRows(reportTargets, planTargets) {
  assert(Array.isArray(reportTargets) && reportTargets.length === EXPECTED_TARGET_COUNT,
    'report does not contain exactly 38 target rows');
  const seenFqbns = new Set();
  const identities = new Map();
  const cliExecutableDigests = new Set();
  const cliConfigDigests = new Set();
  for (const [index, expected] of planTargets.entries()) {
    const row = reportTargets[index];
    assert(row?.status === 'ready', `target ${expected.id} was not ready`);
    const { identity, status, ...staticRow } = row;
    assert(status === 'ready' && canonicalJson(staticRow) === canonicalJson(expected),
      `target row ${index + 1} differs from the current exact target plan`);
    assert(identity?.fqbn === expected.fqbn && String(identity.coreArchitecture).toLowerCase() === 'avr',
      `${expected.id} target identity is not exact AVR FQBN evidence`);
    assert(identity.coreVersion === '1.8.6', `${expected.id} did not use Arduino AVR Core 1.8.6`);
    assert(identity.corePackage === 'Arduino AVR Boards', `${expected.id} Core package identity differs`);
    assert(typeof identity.cliVersion === 'string' && identity.cliVersion.length > 0,
      `${expected.id} CLI version is missing`);
    assertSha(identity.cliExecutableSha256, `${expected.id} CLI executable`);
    assertSha(identity.cliConfigSha256, `${expected.id} CLI config`);
    cliExecutableDigests.add(identity.cliExecutableSha256);
    cliConfigDigests.add(identity.cliConfigSha256);
    assert(!seenFqbns.has(expected.fqbn), `duplicate report FQBN: ${expected.fqbn}`);
    seenFqbns.add(expected.fqbn);
    identities.set(expected.id, identity);
  }
  assert(cliExecutableDigests.size === 1 && cliConfigDigests.size === 1,
    'target preflights did not use one bundled CLI/config identity');
  return identities;
}

function expectedSkipResult() {
  return {
    measurementPassed: true,
    measurementStatus: 'expected-skip',
    artifactAndResourceEquivalent: null,
    stageByStageArtifactAndResourceEquivalent: null,
    simpleReturnRestorationEquivalent: null,
    noExactCompilerBypass: null,
    stages: {},
    performanceTarget: {
      policy: matrix.PERFORMANCE_POLICY,
      status: 'not-applicable',
      passed: null,
      qualificationClaimed: false,
    },
  };
}

function validateCleanup(report) {
  const disk = report.disk;
  assert(disk && Number.isSafeInteger(disk.minimumFreeGiB) && disk.minimumFreeGiB >= 8,
    'disk minimum-free policy is missing');
  const minimumBytes = disk.minimumFreeGiB * 1024 ** 3;
  for (const field of ['freeBytesBefore', 'freeBytesAfterCapture', 'freeBytesAfterCleanup']) {
    assert(Number.isSafeInteger(disk[field]) && disk[field] >= minimumBytes,
      `disk ${field} did not satisfy the declared free-space gate`);
  }
  const cleanup = disk.cleanup;
  assert(cleanup && cleanup.removed === true, 'runner-owned work directory was not removed');
  assert(canonicalJson(cleanup.removedPaths) === canonicalJson(['<TEMP>/CKAB/<run-token>']),
    'cleanup removed-path proof is not the bounded runner-owned root');
  for (const field of ['measuredFileBytes', 'regularFileCount', 'directoryCount', 'otherEntryCount']) {
    assert(Number.isSafeInteger(cleanup[field]) && cleanup[field] >= 0, `cleanup ${field} is invalid`);
  }
  assert(cleanup.otherEntryCount === 0, 'cleanup encountered unsupported filesystem entries');
}

function validateProductionExecutable(binding, executable, executableStat) {
  assert(binding?.unchanged === true, 'production executable/process was not stable throughout the matrix');
  assert(canonicalJson(binding.before) === canonicalJson(binding.after),
    'production executable before/after identities differ');
  const identity = binding.before;
  assert(Number.isSafeInteger(identity?.appProcessId) && identity.appProcessId > 0,
    'production app process ID is invalid');
  assert(Number.isSafeInteger(identity.cdpListenerProcessId) && identity.cdpListenerProcessId > 0,
    'production CDP listener process ID is invalid');
  assert(identity.executableFileName.toLowerCase() === path.basename(executable).toLowerCase(),
    'production executable filename differs from the supplied candidate');
  assert(identity.executableBytes === executableStat.size, 'production executable byte size differs');
  assert(identity.executableSha256 === sha256File(executable), 'production executable SHA-256 differs');
}

function validateStartupStability(value) {
  assert(value?.policyId === 'arduino-cli-startup-idle-window-v1'
    && value.idleWindowMs === 2_000
    && value.timeoutMs === 60_000
    && value.pollIntervalMs === 200,
  'startup Arduino CLI idle policy differs');
  assert(Number.isSafeInteger(value.waitedMs) && value.waitedMs >= 2_000 && value.waitedMs <= 60_000,
    'startup idle wait did not prove a bounded two-second window');
  assert(Number.isSafeInteger(value.polls) && value.polls >= 2,
    'startup idle wait has fewer than two boundary samples');
}

function verifyReport(report, { executable, executableStat, reportSha256 = null } = {}) {
  assert(report?.schemaId === REPORT_SCHEMA_ID && report.schemaVersion === REPORT_SCHEMA_VERSION,
    'unsupported AVR matrix report schema');
  assert(report.status === 'passed' && report.measurementStatus === 'passed',
    'matrix measurement did not pass');
  assert(report.performanceTargetStatus === 'target-met', 'matrix performance target did not pass');
  assert(report.qualificationClaimed === false, 'matrix incorrectly claims a NativeRelink qualification');
  assert(Array.isArray(report.failures) && report.failures.length === 0, 'matrix report contains failures');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
    && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'matrix timestamps are invalid');

  const controls = report.controls;
  assert(controls?.compileOnly === true
    && controls.uploadPerformed === false
    && controls.physicalFlashWritten === false
    && controls.serialPortAccessed === false,
  'matrix does not prove compile-only/no-write operation');
  assert(controls.ckQualificationMode === false && controls.exactAllowed === false,
    'matrix used qualification mode or permits Exact');
  assert(controls.sameBundledCli === true
    && controls.sameCliConfig === true
    && controls.sameCompleteFqbn === true
    && controls.sameSourceBytesPerStage === true
    && controls.sameJobs === true
    && controls.sequentialNoConcurrentCompiles === true,
  'matrix lane-equivalence controls are incomplete');
  assert(canonicalJson(controls.performancePolicy) === canonicalJson(matrix.PERFORMANCE_POLICY),
    'matrix performance policy differs');
  assert(canonicalJson(controls.simpleReturnRestorationPolicy) === canonicalJson(matrix.SIMPLE_RETURN_RESTORATION_POLICY),
    'matrix restoration policy differs');
  assert(canonicalJson(controls.laneBoundaryIdlePolicy) === canonicalJson(matrix.LANE_BOUNDARY_IDLE_POLICY),
    'matrix lane idle policy differs');
  validateStartupStability(report.startupStability);
  assertSha(report.compileSettingsSha256, 'compile settings');

  const plan = expectedFullPlan();
  assert(report.planSha256 === forge.digestObject(plan), 'matrix plan SHA does not reproduce from current sources');
  assert(report.trialsPerCell === 1
    && report.plannedCellCount === EXPECTED_CELL_COUNT
    && report.applicableCellCount === EXPECTED_APPLICABLE_CELL_COUNT
    && report.expectedSkipCellCount === EXPECTED_SKIP_CELL_COUNT
    && report.plannedCompileCount === EXPECTED_COMPILE_CALL_COUNT,
  'matrix top-level counts differ from 38x3/112-applicable/896-call contract');

  const identities = validateTargetRows(report.targets, plan.targets);
  assert(Array.isArray(report.cells) && report.cells.length === EXPECTED_CELL_COUNT,
    'matrix does not contain exactly 114 cells');
  const seenCellIds = new Set();
  const toolchainByTarget = new Map();
  let applicableOrdinal = 0;
  let applicableCount = 0;
  let skipCount = 0;
  let stagePairCount = 0;
  let compileCallCount = 0;
  let cacheResetCount = 0;

  for (const [cellIndex, expectedCell] of plan.cells.entries()) {
    const cell = report.cells[cellIndex];
    const cellId = `${expectedCell.targetId}__${expectedCell.workloadId}`;
    assert(cell?.id === cellId
      && cell.targetId === expectedCell.targetId
      && cell.fqbn === expectedCell.fqbn
      && cell.workloadId === expectedCell.workloadId,
    `cell ${cellIndex + 1} is not the expected target/workload Cartesian row`);
    assert(!seenCellIds.has(cell.id), `duplicate matrix cell: ${cell.id}`);
    seenCellIds.add(cell.id);
    assert(canonicalJson(cell.applicability) === canonicalJson(expectedCell.applicability),
      `${cell.id} applicability differs from the current plan`);
    const workload = matrix.AVR_WORKLOADS.find((candidate) => candidate.id === cell.workloadId);
    assert(cell.workloadLabel === workload.label, `${cell.id} workload label differs from current source`);
    const expectedSourceSequence = workload.stages.map((stage) => ({
      id: stage.id,
      sha256: matrix.sha256Bytes(stage.code),
      bytes: Buffer.byteLength(stage.code, 'utf8'),
    }));
    assert(canonicalJson(cell.sourceSequence) === canonicalJson(expectedSourceSequence),
      `${cell.id} source sequence differs from current immutable workload bytes`);
    assert(Array.isArray(cell.failures) && cell.failures.length === 0, `${cell.id} contains failures`);

    if (!expectedCell.applicability.applicable) {
      skipCount += 1;
      assert(cell.trials?.length === 0, `${cell.id} expected-skip unexpectedly ran compiles`);
      assert(canonicalJson(cell.result) === canonicalJson(expectedSkipResult()),
        `${cell.id} expected-skip result was tampered`);
      continue;
    }

    applicableCount += 1;
    assert(Array.isArray(cell.trials) && cell.trials.length === 1, `${cell.id} must contain exactly one trial`);
    const trial = cell.trials[0];
    const expectedOrder = applicableOrdinal % 2 === 0 ? 'ck-native' : 'native-ck';
    applicableOrdinal += 1;
    assert(trial.id === 'trial-001' && trial.order === expectedOrder,
      `${cell.id} trial order does not match deterministic lane alternation`);
    const cacheValidation = forge.validateCacheClear(trial.cacheReset, cell.fqbn);
    assert(cacheValidation.passed, `${cell.id} cache reset is invalid: ${cacheValidation.failures.join('; ')}`);
    cacheResetCount += 1;
    assert(matrix.laneBoundaryIdleEvidencePassed(trial), `${cell.id} lane-boundary idle evidence is invalid`);
    assert(canonicalJson(trial.laneBoundaryIdle.map((entry) => entry.lane))
      === canonicalJson(expectedOrder.split('-')), `${cell.id} lane idle order differs`);
    assert(canonicalJson(Object.keys(trial.ck).sort()) === canonicalJson([...matrix.STAGE_IDS].sort())
      && canonicalJson(Object.keys(trial.native).sort()) === canonicalJson([...matrix.STAGE_IDS].sort())
      && canonicalJson(Object.keys(trial.equivalence).sort()) === canonicalJson([...matrix.STAGE_IDS].sort()),
    `${cell.id} stage maps are incomplete or contain extras`);

    const jobs = trial.ck.simple.jobs;
    const targetIdentity = identities.get(cell.targetId);
    for (const stage of workload.stages) {
      const context = {
        cellId: cell.id,
        trialId: trial.id,
        stageId: stage.id,
        fqbn: cell.fqbn,
        sourceSha256: matrix.sha256Bytes(stage.code),
        targetIdentity,
        jobs,
      };
      validateRun(trial.ck[stage.id], { ...context, lane: 'ck' });
      validateRun(trial.native[stage.id], { ...context, lane: 'native' });
      const ck = trial.ck[stage.id];
      const native = trial.native[stage.id];
      const equivalence = {
        source: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === context.sourceSha256,
        resources: forge.resourcesEquivalent(ck.resources, native.resources),
        artifacts: forge.compareAvrArtifactRoles(ck.artifacts, native.artifacts),
      };
      assert(canonicalJson(trial.equivalence[stage.id]) === canonicalJson(equivalence),
        `${cell.id} ${stage.id} equivalence does not reproduce`);
      assert(equivalence.source && equivalence.resources && equivalence.artifacts.passed,
        `${cell.id} ${stage.id} CK/native outputs are not equivalent`);
      stagePairCount += 1;
      compileCallCount += 2;
      const previousToolchain = toolchainByTarget.get(cell.targetId);
      if (previousToolchain) assert(previousToolchain === ck.toolchainKey, `${cell.id} toolchain identity drifted`);
      else toolchainByTarget.set(cell.targetId, ck.toolchainKey);
    }
    const restoration = matrix.evaluateSimpleReturnRestoration(trial);
    assert(canonicalJson(trial.simpleReturnRestoration) === canonicalJson(restoration)
      && restoration.passed === true, `${cell.id} simple-return restoration does not reproduce`);
    const result = matrix.evaluateCell(cell);
    assert(canonicalJson(cell.result) === canonicalJson(result), `${cell.id} aggregate result does not reproduce`);
    assert(result.measurementPassed === true && result.nativeRelinkRoutePassed === true
      && result.artifactAndResourceEquivalent === true
      && result.performanceTarget.passed === true,
    `${cell.id} did not pass route/equivalence/performance gates`);
  }

  assert(applicableCount === EXPECTED_APPLICABLE_CELL_COUNT && skipCount === EXPECTED_SKIP_CELL_COUNT,
    'actual applicable/skip cell counts differ');
  assert(stagePairCount === EXPECTED_STAGE_PAIR_COUNT && compileCallCount === EXPECTED_COMPILE_CALL_COUNT,
    'actual paired stage/compile call counts differ');
  assert(cacheResetCount === EXPECTED_APPLICABLE_CELL_COUNT,
    'not every applicable cell contains an exact-FQBN cache-reset proof');
  validateCleanup(report);
  validateProductionExecutable(report.productionExecutable, executable, executableStat);
  if (reportSha256 != null) assertSha(reportSha256, 'matrix report');

  return {
    schemaId: VERIFICATION_SCHEMA_ID,
    schemaVersion: 1,
    status: 'passed',
    reportSha256,
    productionExecutableSha256: report.productionExecutable.before.executableSha256,
    targetCount: EXPECTED_TARGET_COUNT,
    workloadCount: EXPECTED_WORKLOAD_COUNT,
    cellCount: EXPECTED_CELL_COUNT,
    applicableCellCount: applicableCount,
    expectedSkipCellCount: skipCount,
    pairedStageCount: stagePairCount,
    compileCallCount,
    cacheResetCount,
    cleanupVerified: true,
    productionExecutableStable: true,
  };
}

function verifyMatrix(options) {
  const parsed = readJson(options.input, 'AVR matrix report');
  const executable = regularFile(
    options.expectedExecutable || path.join(REPO_ROOT, 'target', 'release', 'appsdesktop.exe'),
    'expected production executable',
  );
  return verifyReport(parsed.value, {
    executable: executable.file,
    executableStat: executable.stat,
    reportSha256: sha256Bytes(parsed.bytes),
  });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  const result = verifyMatrix(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

module.exports = {
  EXPECTED_APPLICABLE_CELL_COUNT,
  EXPECTED_CELL_COUNT,
  EXPECTED_COMPILE_CALL_COUNT,
  EXPECTED_SKIP_CELL_COUNT,
  EXPECTED_STAGE_PAIR_COUNT,
  EXPECTED_TARGET_COUNT,
  canonicalJson,
  expectedFullPlan,
  expectedRunEvidenceSha256,
  main,
  parseArgs,
  validateCleanup,
  validateProductionExecutable,
  validateRun,
  verifyMatrix,
  verifyReport,
};

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`CK AVR matrix verification: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
