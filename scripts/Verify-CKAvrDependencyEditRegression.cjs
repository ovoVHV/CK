#!/usr/bin/env node
'use strict';

// Read-only verifier for Run-CKAvrDependencyEditRegression.cjs evidence.
// It never invokes CK/Arduino and recomputes the plan, run integrity,
// dependency-transition equivalence, route classification and cleanup gates.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const dependencyRunner = require('./Run-CKAvrDependencyEditRegression.cjs');
const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const VERIFICATION_SCHEMA_ID = 'ck.avr.dependency-edit-regression-verification';
const SHA256_RE = /^[0-9a-f]{64}$/u;

function fail(message) { throw new Error(message); }
function assert(condition, message) { if (!condition) fail(message); }

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function sha256Bytes(value) { return crypto.createHash('sha256').update(value).digest('hex'); }
function sha256File(file) { return sha256Bytes(fs.readFileSync(file)); }
function assertSha(value, label) {
  assert(typeof value === 'string' && SHA256_RE.test(value), `${label} is not a SHA-256 digest`);
}

function regularFile(file, label, maximumBytes = 128 * 1024 * 1024) {
  const resolved = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch { fail(`${label} is missing: ${resolved}`); }
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular non-symlink file`);
  assert(stat.size > 0 && stat.size <= maximumBytes, `${label} size is invalid`);
  return { file: resolved, stat };
}

function readJson(file, label) {
  const regular = regularFile(file, label);
  const bytes = fs.readFileSync(regular.file);
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`${label} is invalid JSON: ${error.message}`); }
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
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (!options.help && !options.input) throw new Error('--input <report.json> is required');
  return options;
}

function usage() {
  return `Read-only CK AVR dependency-edit regression verification

Usage:
  node scripts/Verify-CKAvrDependencyEditRegression.cjs --input <report.json> [--expected-executable <appsdesktop.exe>]
`;
}

function expectedPlanFromReport(report) {
  assert(Array.isArray(report?.targets) && report.targets.length >= 1 && report.targets.length <= 38,
    'report target selection is empty or too large');
  const ids = report.targets.map((target) => target.id);
  assert(new Set(ids).size === ids.length, 'report contains duplicate target IDs');
  assert(Number.isSafeInteger(report.trialsPerTarget)
    && report.trialsPerTarget >= 1 && report.trialsPerTarget <= 5,
  'report trialsPerTarget is invalid');
  const args = [
    '--plan', '--trials', String(report.trialsPerTarget),
    ...ids.flatMap((id) => ['--target', id]),
  ];
  return dependencyRunner.planFor(dependencyRunner.parseArgs(args));
}

function expectedEvidenceSha256(run) {
  const { evidenceSha256, ...projection } = run;
  assert(projection.integritySchemaVersion === 2, 'run integrity schema is not v2');
  delete projection.wallMs;
  projection.rawTiming = projection.rawTiming && typeof projection.rawTiming === 'object'
    ? { runnerWallNs: projection.rawTiming.runnerWallNs }
    : null;
  return forge.digestObject(projection);
}

function artifactSetSha256(artifacts) {
  return forge.digestObject(artifacts.map(({ name, bytes, sha256, primaryApplication, role }) => ({
    name, bytes, sha256, primaryApplication, role,
  })));
}

function validateRun(run, { lane, stage, target, identity, jobs }) {
  const label = `${target.id} ${stage.id} ${lane}`;
  assert(run?.targetId === target.id && run.phase === stage.id, `${label} target/stage binding differs`);
  assert(run.success === true && run.compileOnly === true && run.uploadPerformed === false,
    `${label} is not successful compile-only evidence`);
  assert(run.exactUsed === false, `${label} used Exact`);
  assert(run.profile === 'release' && run.jobs === jobs && run.fqbn === target.fqbn,
    `${label} profile/jobs/FQBN differ across lanes`);
  assert(run.codeSha256 === stage.sourceSha256, `${label} source SHA differs from plan`);
  assert(Number.isFinite(run.wallMs) && run.wallMs > 0
    && typeof run.rawTiming?.runnerWallNs === 'string'
    && /^[1-9]\d*$/u.test(run.rawTiming.runnerWallNs), `${label} monotonic timing is invalid`);
  assert(Math.abs(Number(BigInt(run.rawTiming.runnerWallNs)) / 1e6 - run.wallMs) < 0.001,
    `${label} wall time differs from monotonic timing`);
  assert(run.resources?.evidenceComplete === true
    && Number.isSafeInteger(run.resources.flashUsedBytes) && run.resources.flashUsedBytes >= 0
    && Number.isSafeInteger(run.resources.ramUsedBytes) && run.resources.ramUsedBytes >= 0,
  `${label} resource evidence is incomplete`);
  assert(Array.isArray(run.artifacts) && run.artifacts.length > 0, `${label} artifacts are missing`);
  for (const artifact of run.artifacts) {
    assert(typeof artifact.name === 'string' && artifact.name.length > 0, `${label} artifact name is invalid`);
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, `${label} artifact bytes are invalid`);
    assertSha(artifact.sha256, `${label} artifact`);
    assert(typeof artifact.role === 'string' && artifact.role.length > 0, `${label} artifact role is invalid`);
  }
  assert(run.artifactsVerified === true, `${label} artifacts were not verified`);
  assert(run.artifactSetSha256 === artifactSetSha256(run.artifacts), `${label} artifact-set SHA does not reproduce`);
  assertSha(run.buildPathIdentitySha256, `${label} build path`);
  assert(run.evidenceSha256 === expectedEvidenceSha256(run), `${label} evidence SHA does not reproduce`);

  if (lane === 'ck') {
    assert(run.cliVersion === identity.cliVersion, `${label} CLI identity differs from target preflight`);
    assert(typeof run.toolchainKey === 'string' && run.toolchainKey.length > 0, `${label} toolchain key is missing`);
    assert(run.route?.coreVersion === identity.coreVersion, `${label} Core route identity differs`);
    assertSha(run.responseSha256, `${label} response`);
    assert(run.cache?.exactMatch === false && Array.isArray(run.cache.nativeRelinkDiagnostics),
      `${label} cache/route diagnostics are invalid`);
  } else {
    assert(run.buildMode === (stage.id === 'simple' ? 'native-fresh-build' : 'native-incremental-edit'),
      `${label} native lane did not preserve its incremental build path`);
    assertSha(run.stdoutSha256, `${label} stdout`);
    assertSha(run.stderrSha256, `${label} stderr`);
    const expectedCommand = [
      '<BUNDLED_CLI>', '--config-file', '<CK_ROOT>/arduino-cli.yaml', 'compile',
      '--jobs', String(jobs), '--discovery-timeout', '100ms', '-b', target.fqbn,
      '--build-path', '<AB_WORKDIR>/build/<project>', '--no-color', '<AB_WORKDIR>/<project>',
    ];
    assert(canonicalJson(run.command) === canonicalJson(expectedCommand),
      `${label} native command differs from exact compile-only command`);
  }
}

function validateIdleBoundary(stageRow) {
  assert(matrix.laneBoundaryIdleEvidencePassed({
    order: stageRow.order,
    laneBoundaryIdle: stageRow.laneBoundaryIdle,
  }), `${stageRow.id} lane idle evidence is invalid`);
}

function validateCleanup(report) {
  const disk = report.disk;
  assert(Number.isSafeInteger(disk?.minimumFreeGiB) && disk.minimumFreeGiB >= 8,
    'disk free-space policy is invalid');
  const minimumBytes = disk.minimumFreeGiB * 1024 ** 3;
  for (const field of ['freeBytesBefore', 'freeBytesAfterCapture', 'freeBytesAfterCleanup']) {
    assert(Number.isSafeInteger(disk[field]) && disk[field] >= minimumBytes, `${field} failed the free-space gate`);
  }
  assert(disk.cleanup?.removed === true
    && canonicalJson(disk.cleanup.removedPaths) === canonicalJson(['<TEMP>/CKAB/<run-token>']),
  'runner-owned temporary root was not removed');
  for (const field of ['measuredFileBytes', 'regularFileCount', 'directoryCount', 'otherEntryCount']) {
    assert(Number.isSafeInteger(disk.cleanup[field]) && disk.cleanup[field] >= 0, `cleanup ${field} is invalid`);
  }
  assert(disk.cleanup.otherEntryCount === 0, 'cleanup observed unsupported filesystem entries');
}

function validateExecutable(binding, executable, stat) {
  assert(binding?.unchanged === true && canonicalJson(binding.before) === canonicalJson(binding.after),
    'production EXE/process identity changed during capture');
  assert(binding.before.executableBytes === stat.size, 'production EXE byte size differs');
  assert(binding.before.executableSha256 === sha256File(executable), 'production EXE SHA-256 differs');
  assert(binding.before.executableFileName.toLowerCase() === path.basename(executable).toLowerCase(),
    'production EXE filename differs');
}

function validateStartupEvidence(report) {
  const startup = report.startupStability;
  assert(startup?.policyId === 'arduino-cli-startup-idle-window-v1'
    && startup.idleWindowMs === 2_000 && startup.timeoutMs === 60_000
    && startup.pollIntervalMs === 200 && startup.waitedMs >= 2_000 && startup.waitedMs <= 60_000
    && Number.isSafeInteger(startup.polls) && startup.polls >= 2,
  'startup idle evidence is invalid');
  const pretrial = report.preTrialStability;
  assert(pretrial?.policyId === 'arduino-cli-pretrial-idle-window-v1'
    && pretrial.idleWindowMs === 2_000 && pretrial.timeoutMs === 60_000
    && pretrial.pollIntervalMs === 200 && pretrial.waitedMs >= 2_000 && pretrial.waitedMs <= 60_000
    && Number.isSafeInteger(pretrial.polls) && pretrial.polls >= 2
    && pretrial.trigger === 'get_compile_accel_settings'
    && pretrial.outsideMeasuredCompileWallTime === true
    && pretrial.completedBeforeFirstLane === true,
  'pre-trial idle evidence is invalid');
}

function verifyReport(report, { executable, executableStat, reportSha256 = null } = {}) {
  assert(report?.schemaId === dependencyRunner.REPORT_SCHEMA_ID
    && report.schemaVersion === dependencyRunner.SCHEMA_VERSION,
  'unsupported dependency-edit report schema');
  assert(report.status === 'passed' && report.measurementStatus === 'passed',
    'dependency-edit measurement did not pass');
  assert(['target-met', 'target-not-met', 'not-applicable'].includes(report.routeTargetStatus),
    'route target status is invalid');
  assert(Array.isArray(report.failures) && report.failures.length === 0, 'report contains failures');
  assert(Number.isFinite(Date.parse(report.startedAt)) && Number.isFinite(Date.parse(report.finishedAt))
    && Date.parse(report.finishedAt) >= Date.parse(report.startedAt), 'report timestamps are invalid');
  const controls = report.controls;
  assert(controls?.compileOnly === true && controls.uploadPerformed === false
    && controls.physicalFlashWritten === false && controls.serialPortAccessed === false
    && controls.qualificationClaimed === false, 'report does not prove compile-only/no-I/O execution');
  assert(controls.oneColdResetPerTargetTrial === true && controls.stableBuildPathPerLane === true
    && controls.sequentialNoConcurrentCompiles === true, 'continuous-edit controls are incomplete');
  assert(canonicalJson(controls.laneBoundaryIdlePolicy) === canonicalJson(matrix.LANE_BOUNDARY_IDLE_POLICY),
    'lane idle policy differs');
  validateStartupEvidence(report);
  assertSha(report.compileSettingsSha256, 'compile settings');

  const plan = expectedPlanFromReport(report);
  assert(report.planSha256 === forge.digestObject(plan), 'report plan SHA does not reproduce');
  assert(canonicalJson(report.sequence) === canonicalJson(plan.sequence), 'dependency-edit sequence differs from plan');
  assert(canonicalJson(controls.routePolicy) === canonicalJson(plan.routePolicy), 'route policy differs from plan');
  assert(plan.routePolicy.dependencyChangeRequiredForPerformance
    === dependencyRunner.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
  'dependency-change performance route is not NativeRelinkGraphTransition v1');
  assert(canonicalJson(controls.performancePolicy) === canonicalJson(plan.performancePolicy),
    'performance policy differs from plan');
  for (const field of [
    'targetCount', 'applicableTargetCount', 'expectedSkipTargetCount', 'trialsPerTarget',
    'stageCountPerTarget', 'pairedStageCount',
  ]) assert(report[field] === plan[field], `report ${field} differs from plan`);
  assert(report.plannedCompileCount === plan.totalCompileCount, 'planned compile count differs from plan');

  let applicableCount = 0;
  let skipCount = 0;
  let stagePairCount = 0;
  let compileCallCount = 0;
  for (const [targetIndex, planTarget] of plan.targets.entries()) {
    const target = report.targets[targetIndex];
    const { identity, trials, failures, result, ...staticRow } = target;
    assert(canonicalJson(staticRow) === canonicalJson(planTarget),
      `target ${targetIndex + 1} differs from exact selected plan row`);
    assert(Array.isArray(failures) && failures.length === 0, `${target.id} contains failures`);
    if (!planTarget.applicability.applicable) {
      skipCount += 1;
      assert(identity === null && trials.length === 0,
        `${target.id} expected-skip performed setup or compiles`);
      assert(canonicalJson(result) === canonicalJson(dependencyRunner.expectedSkipResult()),
        `${target.id} expected-skip result differs`);
      continue;
    }
    applicableCount += 1;
    assert(identity?.fqbn === target.fqbn && String(identity.coreArchitecture).toLowerCase() === 'avr'
      && identity.coreVersion === '1.8.6', `${target.id} identity is not exact Arduino AVR 1.8.6`);
    assertSha(identity.cliExecutableSha256, `${target.id} CLI executable`);
    assertSha(identity.cliConfigSha256, `${target.id} CLI config`);
    assert(Array.isArray(trials) && trials.length === plan.trialsPerTarget,
      `${target.id} does not contain the planned trial count`);
    for (const [trialIndex, trial] of trials.entries()) {
      assert(trial.id === `trial-${String(trialIndex + 1).padStart(3, '0')}`,
        `${target.id} trial ID/order differs`);
      assert(Array.isArray(trial.failures) && trial.failures.length === 0,
        `${target.id} ${trial.id} contains failures`);
      const cache = forge.validateCacheClear(trial.cacheReset, target.fqbn);
      assert(cache.passed, `${target.id} ${trial.id} cold reset is invalid: ${cache.failures.join('; ')}`);
      assert(Array.isArray(trial.stages) && trial.stages.length === plan.sequence.length,
        `${target.id} ${trial.id} does not contain all seven dependency edits`);
      const ckPaths = new Set();
      const nativePaths = new Set();
      const jobs = trial.stages[0]?.ck?.jobs;
      for (const [stageIndex, planStage] of plan.sequence.entries()) {
        const stage = trial.stages[stageIndex];
        const expectedOrder = (targetIndex + trialIndex + stageIndex) % 2 === 0
          ? 'ck-native' : 'native-ck';
        assert(stage?.id === planStage.id && stage.order === expectedOrder,
          `${target.id} ${trial.id} ${planStage.id} order differs from paired sequence`);
        validateIdleBoundary(stage);
        validateRun(stage.ck, { lane: 'ck', stage: planStage, target, identity, jobs });
        validateRun(stage.native, { lane: 'native', stage: planStage, target, identity, jobs });
        ckPaths.add(stage.ck.buildPathIdentitySha256);
        nativePaths.add(stage.native.buildPathIdentitySha256);
        const equivalence = {
          source: stage.ck.codeSha256 === stage.native.codeSha256
            && stage.ck.codeSha256 === planStage.sourceSha256,
          resources: forge.resourcesEquivalent(stage.ck.resources, stage.native.resources),
          artifacts: forge.compareAvrArtifactRoles(stage.ck.artifacts, stage.native.artifacts),
        };
        assert(canonicalJson(stage.equivalence) === canonicalJson(equivalence),
          `${target.id} ${trial.id} ${stage.id} equivalence does not reproduce`);
        assert(equivalence.source && equivalence.resources && equivalence.artifacts.passed,
          `${target.id} ${trial.id} ${stage.id} CK/native output differs`);
        const route = dependencyRunner.routeEvidenceFor(
          stage.ck, dependencyRunner.DEPENDENCY_EDIT_SEQUENCE[stageIndex],
        );
        assert(canonicalJson(stage.routeEvidence) === canonicalJson(route) && route.safe === true,
          `${target.id} ${trial.id} ${stage.id} route evidence is unsafe or does not reproduce`);
        if (planStage.transitionKind === 'dependency-change' && route.preferred === true) {
          assert(route.observedMode === dependencyRunner.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
            `${target.id} ${trial.id} ${stage.id} optimized dependency transition route differs`);
        }
        stagePairCount += 1;
        compileCallCount += 2;
      }
      assert(ckPaths.size === 1 && nativePaths.size === 1,
        `${target.id} ${trial.id} did not preserve one build path per lane`);
      const recomputedTrial = dependencyRunner.evaluateTrial(trial);
      assert(canonicalJson(trial.result) === canonicalJson(recomputedTrial),
        `${target.id} ${trial.id} result does not reproduce`);
    }
    const recomputed = dependencyRunner.evaluateTarget(target);
    assert(canonicalJson(result) === canonicalJson(recomputed), `${target.id} aggregate result does not reproduce`);
    assert(recomputed.measurementPassed === true && recomputed.routeSafetyPassed === true,
      `${target.id} did not pass dependency-edit gates`);
    if (recomputed.performanceTarget?.passed === true) {
      assert(recomputed.optimizedRoutePassed === true,
        `${target.id} performance target passed without every optimized route`);
    }
  }

  assert(applicableCount === plan.applicableTargetCount && skipCount === plan.expectedSkipTargetCount,
    'actual applicable/skip target counts differ');
  assert(stagePairCount === plan.pairedStageCount && compileCallCount === plan.totalCompileCount,
    'actual paired stage/compile call counts differ');
  const optimized = report.targets.filter((target) => target.applicability.applicable)
    .every((target) => target.result.optimizedRoutePassed === true);
  const expectedRouteStatus = applicableCount === 0 ? 'not-applicable'
    : optimized ? 'target-met' : 'target-not-met';
  assert(report.routeTargetStatus === expectedRouteStatus, 'route target status does not reproduce');
  const performancePassed = report.targets.filter((target) => target.applicability.applicable)
    .every((target) => target.result.performanceTarget?.passed === true);
  const expectedPerformanceStatus = applicableCount === 0 ? 'not-applicable'
    : performancePassed ? 'target-met' : 'target-not-met';
  assert(report.performanceTargetStatus === expectedPerformanceStatus,
    'performance target status does not reproduce');
  validateCleanup(report);
  validateExecutable(report.productionExecutable, executable, executableStat);
  if (reportSha256 != null) assertSha(reportSha256, 'report');
  return {
    schemaId: VERIFICATION_SCHEMA_ID,
    schemaVersion: 1,
    status: 'passed',
    reportSha256,
    productionExecutableSha256: report.productionExecutable.before.executableSha256,
    targetCount: plan.targetCount,
    applicableTargetCount: applicableCount,
    expectedSkipTargetCount: skipCount,
    stageCountPerTarget: plan.stageCountPerTarget,
    pairedStageCount: stagePairCount,
    compileCallCount,
    routeTargetStatus: expectedRouteStatus,
    performanceTargetStatus: expectedPerformanceStatus,
    cleanupVerified: true,
  };
}

function verifyEvidence(options) {
  const input = readJson(options.input, 'dependency-edit report');
  const executable = regularFile(
    options.expectedExecutable || path.join(REPO_ROOT, 'target', 'release', 'appsdesktop.exe'),
    'expected production executable',
  );
  return verifyReport(input.value, {
    executable: executable.file,
    executableStat: executable.stat,
    reportSha256: sha256Bytes(input.bytes),
  });
}

function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  const result = verifyEvidence(options);
  process.stdout.write(`${JSON.stringify(result, null, 2)}\n`);
  return result;
}

module.exports = {
  canonicalJson,
  expectedEvidenceSha256,
  expectedPlanFromReport,
  main,
  parseArgs,
  validateCleanup,
  validateRun,
  verifyEvidence,
  verifyReport,
};

if (require.main === module) {
  try { main(); } catch (error) {
    process.stderr.write(`CK AVR dependency-edit verification: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
