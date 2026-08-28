import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('./Run-CKAvrDependencyEditRegression.cjs');
const verifier = require('./Verify-CKAvrDependencyEditRegression.cjs');
const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'Verify-CKAvrDependencyEditRegression.cjs');
const SOURCE = fs.readFileSync(ENTRY, 'utf8');
const EXE = path.join(ROOT, 'target', 'release', 'appsdesktop.exe');
const EXE_STAT = fs.statSync(EXE);
const EXE_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');
const HISTORICAL = JSON.parse(fs.readFileSync(path.join(
  ROOT, 'artifacts', 'benchmarks', 'ck-avr-full-matrix-exe821a2c10-20260719.json',
), 'utf8'));

function historicalRun(targetId, workloadId, workloadStageId, lane) {
  const cell = HISTORICAL.cells.find((candidate) => (
    candidate.targetId === targetId && candidate.workloadId === workloadId
  ));
  return structuredClone(cell.trials[0][lane][workloadStageId]);
}

function convertRun(original, { target, stage, lane, buildPathIdentitySha256 }) {
  const run = structuredClone(original);
  delete run.trialId;
  delete run.targetId;
  delete run.evidenceSha256;
  run.phase = stage.id;
  run.codeSha256 = stage.sourceSha256;
  run.buildPathIdentitySha256 = buildPathIdentitySha256;
  run.artifactsVerified = true;
  if (lane === 'ck') {
    run.targetId = target.id;
    run.buildMode = stage.transitionKind === 'same-graph-edit'
      ? runner.NATIVE_RELINK_ROUTE
      : stage.transitionKind === 'dependency-change'
        ? runner.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE : runner.CORE_SEEDED_ROUTE;
    run.structuredRoute = { mode: run.buildMode };
    run.fallback = { used: false, buildMode: run.buildMode, reasonLines: [] };
    run.cache.exactMatch = false;
    if (stage.transitionKind === 'same-graph-edit') {
      run.cache.nativeRelinkDiagnostics = [
        'NativeRelinkCompileOnly certificate matched',
        'NativeRelinkCompileOnly path: AVR Release sketch-only compile + native link/objcopy',
      ];
    }
  } else {
    run.buildMode = stage.id === 'simple' ? 'native-fresh-build' : 'native-incremental-edit';
    return runner.finalizeNativeStageRun(run, target.id, stage.id);
  }
  return runner.finalizeRun(run);
}

function makeReport(targetId = 'uno') {
  const options = runner.parseArgs(['--plan', '--target', targetId]);
  const plan = runner.planFor(options);
  const planTarget = plan.targets[0];
  const target = matrix.AVR_TARGETS.find((candidate) => candidate.id === targetId);
  const identity = structuredClone(HISTORICAL.targets.find((candidate) => candidate.id === targetId).identity);
  const row = {
    ...planTarget,
    identity,
    trials: [],
    failures: [],
    result: null,
  };
  const trial = {
    id: 'trial-001',
    cacheReset: structuredClone(HISTORICAL.cells.find((cell) => (
      cell.targetId === targetId && cell.applicability.applicable
    )).trials[0].cacheReset),
    stages: [],
    failures: [],
    result: null,
  };
  row.trials.push(trial);
  const ckPath = 'a'.repeat(64);
  const nativePath = 'b'.repeat(64);
  for (const [index, planStage] of plan.sequence.entries()) {
    const source = runner.DEPENDENCY_EDIT_SEQUENCE[index];
    const ck = convertRun(
      historicalRun(targetId, source.workloadId, source.workloadStageId, 'ck'),
      { target, stage: planStage, lane: 'ck', buildPathIdentitySha256: ckPath },
    );
    const native = convertRun(
      historicalRun(targetId, source.workloadId, source.workloadStageId, 'native'),
      { target, stage: planStage, lane: 'native', buildPathIdentitySha256: nativePath },
    );
    const order = index % 2 === 0 ? 'ck-native' : 'native-ck';
    const stage = {
      id: planStage.id,
      order,
      ck,
      native,
      equivalence: {
        source: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === planStage.sourceSha256,
        resources: forge.resourcesEquivalent(ck.resources, native.resources),
        artifacts: forge.compareAvrArtifactRoles(ck.artifacts, native.artifacts),
      },
      routeEvidence: runner.routeEvidenceFor(ck, source),
      laneBoundaryIdle: order.split('-').map((lane) => ({
        lane,
        policyId: matrix.LANE_BOUNDARY_IDLE_POLICY.policyId,
        idleWindowMs: matrix.LANE_BOUNDARY_IDLE_POLICY.idleWindowMs,
        timeoutMs: matrix.LANE_BOUNDARY_IDLE_POLICY.timeoutMs,
        pollIntervalMs: matrix.LANE_BOUNDARY_IDLE_POLICY.pollIntervalMs,
        waitedMs: 700,
        polls: 3,
      })),
    };
    trial.stages.push(stage);
  }
  trial.result = runner.evaluateTrial(trial);
  row.result = runner.evaluateTarget(row);
  const freeBytes = 16 * 1024 ** 3;
  return {
    schemaId: runner.REPORT_SCHEMA_ID,
    schemaVersion: runner.SCHEMA_VERSION,
    status: 'passed',
    measurementStatus: 'passed',
    routeTargetStatus: 'target-met',
    performanceTargetStatus: row.result.performanceTarget.status,
    startedAt: '2026-07-20T00:00:00.000Z',
    finishedAt: '2026-07-20T00:10:00.000Z',
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      qualificationClaimed: false,
      oneColdResetPerTargetTrial: true,
      stableBuildPathPerLane: true,
      sequentialNoConcurrentCompiles: true,
      laneBoundaryIdlePolicy: matrix.LANE_BOUNDARY_IDLE_POLICY,
      routePolicy: plan.routePolicy,
      performancePolicy: plan.performancePolicy,
    },
    planSha256: forge.digestObject(plan),
    targetCount: plan.targetCount,
    applicableTargetCount: plan.applicableTargetCount,
    expectedSkipTargetCount: plan.expectedSkipTargetCount,
    trialsPerTarget: plan.trialsPerTarget,
    stageCountPerTarget: plan.stageCountPerTarget,
    pairedStageCount: plan.pairedStageCount,
    plannedCompileCount: plan.totalCompileCount,
    sequence: plan.sequence,
    targets: [row],
    failures: [],
    startupStability: {
      policyId: 'arduino-cli-startup-idle-window-v1', idleWindowMs: 2_000,
      timeoutMs: 60_000, pollIntervalMs: 200, waitedMs: 3_000, polls: 3,
    },
    preTrialStability: {
      policyId: 'arduino-cli-pretrial-idle-window-v1', idleWindowMs: 2_000,
      timeoutMs: 60_000, pollIntervalMs: 200, waitedMs: 3_000, polls: 3,
      trigger: 'get_compile_accel_settings', outsideMeasuredCompileWallTime: true,
      completedBeforeFirstLane: true,
    },
    compileSettingsSha256: 'c'.repeat(64),
    productionExecutable: {
      before: {
        appProcessId: 1, cdpListenerProcessId: 2,
        executableFileName: path.basename(EXE), executableBytes: EXE_STAT.size,
        executableSha256: EXE_SHA256,
      },
      after: {
        appProcessId: 1, cdpListenerProcessId: 2,
        executableFileName: path.basename(EXE), executableBytes: EXE_STAT.size,
        executableSha256: EXE_SHA256,
      },
      unchanged: true,
    },
    disk: {
      minimumFreeGiB: 8,
      freeBytesBefore: freeBytes,
      freeBytesAfterCapture: freeBytes,
      freeBytesAfterCleanup: freeBytes,
      cleanup: {
        measuredFileBytes: 100, regularFileCount: 10, directoryCount: 4,
        otherEntryCount: 0, removed: true, removedPaths: ['<TEMP>/CKAB/<run-token>'],
      },
    },
  };
}

function verify(report) {
  return verifier.verifyReport(report, { executable: EXE, executableStat: EXE_STAT });
}

function expandToThreeTrials(report) {
  const row = report.targets[0];
  const template = row.trials[0];
  row.trials = [0, 1, 2].map((trialIndex) => {
    const trial = structuredClone(template);
    trial.id = `trial-00${trialIndex + 1}`;
    trial.stages.forEach((stage, stageIndex) => {
      stage.order = (trialIndex + stageIndex) % 2 === 0 ? 'ck-native' : 'native-ck';
      const byLane = new Map(stage.laneBoundaryIdle.map((entry) => [entry.lane, entry]));
      stage.laneBoundaryIdle = stage.order.split('-').map((lane) => byLane.get(lane));
    });
    trial.result = runner.evaluateTrial(trial);
    return trial;
  });
  row.result = runner.evaluateTarget(row);
  const plan = runner.planFor(runner.parseArgs(['--plan', '--target', row.id, '--trials', '3']));
  report.planSha256 = forge.digestObject(plan);
  report.trialsPerTarget = plan.trialsPerTarget;
  report.pairedStageCount = plan.pairedStageCount;
  report.plannedCompileCount = plan.totalCompileCount;
  report.sequence = plan.sequence;
  report.routeTargetStatus = row.result.optimizedRoutePassed ? 'target-met' : 'target-not-met';
  report.performanceTargetStatus = row.result.performanceTarget.status;
  return report;
}

test('independent verifier accepts a complete seven-stage one-target proof without mutation', () => {
  const report = makeReport();
  const before = JSON.stringify(report);
  const result = verify(report);
  assert.equal(result.status, 'passed');
  assert.equal(result.targetCount, 1);
  assert.equal(result.applicableTargetCount, 1);
  assert.equal(result.stageCountPerTarget, 7);
  assert.equal(result.pairedStageCount, 7);
  assert.equal(result.compileCallCount, 14);
  assert.equal(result.routeTargetStatus, 'target-met');
  assert.equal(JSON.stringify(report), before);
});

test('runner-shaped native evidence cannot omit its target binding', () => {
  const report = makeReport();
  const native = report.targets[0].trials[0].stages[0].native;
  assert.equal(native.targetId, 'uno');
  const { evidenceSha256, targetId, ...unsigned } = native;
  report.targets[0].trials[0].stages[0].native = runner.finalizeRun(unsigned);
  assert.throws(() => verify(report), /native target\/stage binding differs/u);
});

test('three-trial formal report is verified with median performance and 42 compile calls', () => {
  const report = expandToThreeTrials(makeReport());
  const result = verify(report);
  assert.equal(result.pairedStageCount, 21);
  assert.equal(result.compileCallCount, 42);
  assert.equal(report.targets[0].result.performanceTarget.stages[1].ckRawMs.length, 3);
  assert.equal(report.targets[0].result.performanceTarget.note, null);
});

test('dependency source/order, single cold reset and stable build paths fail closed', () => {
  const sourceDrift = makeReport();
  sourceDrift.targets[0].trials[0].stages[3].ck.codeSha256 = '0'.repeat(64);
  assert.throws(() => verify(sourceDrift), /source SHA differs/u);

  const orderDrift = makeReport();
  orderDrift.targets[0].trials[0].stages[1].order = 'ck-native';
  assert.throws(() => verify(orderDrift), /order differs/u);

  const resetDrift = makeReport();
  resetDrift.targets[0].trials[0].cacheReset.reset_scope = 'other';
  assert.throws(() => verify(resetDrift), /cold reset is invalid/u);

  const pathDrift = makeReport();
  const run = pathDrift.targets[0].trials[0].stages[4].native;
  run.buildPathIdentitySha256 = 'd'.repeat(64);
  run.evidenceSha256 = runner.finalizeRun((({ evidenceSha256, ...value }) => value)(run)).evidenceSha256;
  pathDrift.targets[0].trials[0].result = runner.evaluateTrial(pathDrift.targets[0].trials[0]);
  pathDrift.targets[0].result = runner.evaluateTarget(pathDrift.targets[0]);
  assert.throws(() => verify(pathDrift), /one build path|preserve one build path/u);
});

test('upload declarations, artifact/resource drift and unrecognized routes are rejected', () => {
  const upload = makeReport();
  upload.targets[0].trials[0].stages[0].ck.uploadPerformed = true;
  assert.throws(() => verify(upload), /compile-only/u);

  const artifact = makeReport();
  artifact.targets[0].trials[0].stages[0].equivalence.artifacts.passed = false;
  assert.throws(() => verify(artifact), /equivalence does not reproduce/u);

  const route = makeReport();
  const ck = route.targets[0].trials[0].stages[2].ck;
  ck.buildMode = 'mystery-route';
  ck.structuredRoute = { mode: 'mystery-route' };
  ck.evidenceSha256 = runner.finalizeRun((({ evidenceSha256, ...value }) => value)(ck)).evidenceSha256;
  assert.throws(() => verify(route), /route evidence is unsafe|does not reproduce/u);
});

test('core-seeded dependency fallback stays verifiable but cannot satisfy route or performance target', () => {
  const report = makeReport();
  const row = report.targets[0];
  const trial = row.trials[0];
  const stage = trial.stages[1];
  stage.ck.buildMode = runner.CORE_SEEDED_ROUTE;
  stage.ck.structuredRoute = { mode: runner.CORE_SEEDED_ROUTE };
  stage.ck.fallback = { used: false, buildMode: runner.CORE_SEEDED_ROUTE, reasonLines: [] };
  stage.ck.evidenceSha256 = runner.finalizeRun(
    (({ evidenceSha256, ...value }) => value)(stage.ck),
  ).evidenceSha256;
  stage.routeEvidence = runner.routeEvidenceFor(
    stage.ck, runner.DEPENDENCY_EDIT_SEQUENCE[1],
  );
  trial.result = runner.evaluateTrial(trial);
  row.result = runner.evaluateTarget(row);
  report.routeTargetStatus = 'target-not-met';
  report.performanceTargetStatus = 'target-not-met';

  const result = verify(report);
  assert.equal(result.status, 'passed');
  assert.equal(result.routeTargetStatus, 'target-not-met');
  assert.equal(result.performanceTargetStatus, 'target-not-met');
  assert.equal(stage.routeEvidence.safe, true);
  assert.equal(stage.routeEvidence.preferred, false);

  report.performanceTargetStatus = 'target-met';
  assert.throws(() => verify(report), /performance target status does not reproduce/u);
});

test('verifier binds wallMs to monotonic nanoseconds and recomputes performance status', () => {
  const timing = makeReport();
  timing.targets[0].trials[0].stages[1].ck.wallMs += 1;
  assert.throws(() => verify(timing), /wall time differs/u);

  const performance = makeReport();
  const stage = performance.targets[0].trials[0].stages[1];
  stage.ck.wallMs = stage.native.wallMs - 100;
  stage.ck.rawTiming.runnerWallNs = String(Math.round(stage.ck.wallMs * 1e6));
  stage.ck.evidenceSha256 = runner.finalizeRun(
    (({ evidenceSha256, ...value }) => value)(stage.ck),
  ).evidenceSha256;
  performance.targets[0].trials[0].result = runner.evaluateTrial(performance.targets[0].trials[0]);
  performance.targets[0].result = runner.evaluateTarget(performance.targets[0]);
  assert.equal(performance.targets[0].result.performanceTarget.passed, false);
  performance.performanceTargetStatus = 'target-met';
  assert.throws(() => verify(performance), /performance target status does not reproduce/u);
});

test('read-only CLI verifies a report digest and exposes no output/mutation option', () => {
  assert.throws(() => verifier.parseArgs([]), /input/u);
  assert.throws(() => verifier.parseArgs(['--input', 'x', '--output', 'y']), /unknown argument/u);
  assert.doesNotMatch(SOURCE, /fs\.(?:write|append|unlink|rm|rename|link|mkdir)/u);
  assert.doesNotMatch(SOURCE, /(?:spawn|exec)(?:File)?Sync\s*\(/u);
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-dependency-verify-'));
  const input = path.join(temporary, 'evidence.json');
  try {
    fs.writeFileSync(input, `${JSON.stringify(makeReport())}\n`);
    const before = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    const child = spawnSync(process.execPath, [
      ENTRY, '--input', input, '--expected-executable', EXE,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(child.status, 0, child.stderr);
    assert.equal(JSON.parse(child.stdout).reportSha256, before);
    assert.equal(crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex'), before);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('EXE binding and owned temporary cleanup are terminal gates', () => {
  const exe = makeReport();
  exe.productionExecutable.after.executableSha256 = '0'.repeat(64);
  assert.throws(() => verify(exe), /identity changed/u);

  const cleanup = makeReport();
  cleanup.disk.cleanup.removed = false;
  assert.throws(() => verify(cleanup), /temporary root was not removed/u);
});
