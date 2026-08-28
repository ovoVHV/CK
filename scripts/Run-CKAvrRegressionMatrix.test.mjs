import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const here = path.dirname(fileURLToPath(import.meta.url));
const source = fs.readFileSync(path.join(here, 'Run-CKAvrRegressionMatrix.cjs'), 'utf8');

function avrCoreFqbns() {
  const boardsPath = path.join(here, '..', 'packages', 'arduino', 'hardware', 'avr', '1.8.6', 'boards.txt');
  const boards = fs.readFileSync(boardsPath, 'utf8');
  const boardIds = [...boards.matchAll(/^([A-Za-z0-9_]+)\.name=/gmu)].map((match) => match[1]);
  const menus = new Map();
  for (const match of boards.matchAll(/^([A-Za-z0-9_]+)\.menu\.cpu\.([^.\r\n=]+)=/gmu)) {
    const values = menus.get(match[1]) || [];
    values.push(match[2]);
    menus.set(match[1], values);
  }
  return boardIds.flatMap((boardId) => {
    const values = menus.get(boardId);
    return values?.length
      ? values.map((value) => `arduino:avr:${boardId}:cpu=${value}`)
      : [`arduino:avr:${boardId}`];
  });
}

test('AVR matrix exhaustively binds every complete Arduino AVR Core 1.8.6 board configuration', () => {
  const expected = avrCoreFqbns().sort();
  const actual = matrix.AVR_TARGETS.map((target) => target.fqbn).sort();
  assert.equal(expected.length, 38);
  assert.equal(matrix.AVR_TARGETS.length, 38);
  assert.equal(new Set(matrix.AVR_TARGETS.map((target) => target.id)).size, 38);
  assert.equal(new Set(actual).size, 38);
  assert.deepEqual(actual, expected);
  assert.equal(new Set(expected.map((fqbn) => fqbn.split(':')[2])).size, 27);
  for (const target of matrix.AVR_TARGETS) {
    assert.match(target.fqbn, /^arduino:avr:[A-Za-z0-9_]+(?::cpu=[A-Za-z0-9]+)?$/u);
    assert.match(target.hardware.mcu, /^(?:atmega|attiny)[a-z0-9]+$/u);
    assert.ok([8_000_000, 16_000_000].includes(target.hardware.clockHz));
    assert.equal(typeof target.hardware.variant, 'string');
  }

  const nanoOld = matrix.AVR_TARGETS.find((target) => target.id === 'nano-atmega328old');
  assert.equal(nanoOld.fqbn, 'arduino:avr:nano:cpu=atmega328old');
  assert.deepEqual(nanoOld.hardware, {
    mcu: 'atmega328p', clockHz: 16_000_000, variant: 'eightanaloginputs',
  });
  assert.equal(matrix.workloadApplicability(
    nanoOld,
    matrix.AVR_WORKLOADS.find((workload) => workload.id === 'mstimer2'),
  ).status, 'applicable');

  const gemma = matrix.AVR_TARGETS.find((target) => target.id === 'gemma');
  assert.deepEqual(Object.keys(gemma.expectedSkips).sort(), ['mstimer2', 'wire-spi-eeprom']);
  for (const workload of matrix.AVR_WORKLOADS) {
    const applicability = matrix.workloadApplicability(gemma, workload);
    assert.equal(
      applicability.status,
      workload.id === 'core-only-block-style' ? 'applicable' : 'expected-skip',
      workload.id,
    );
  }
  assert.equal(
    matrix.AVR_TARGETS.filter((target) => Object.keys(target.expectedSkips).length > 0).length,
    1,
  );
});

test('every real workload preserves the four-stage edit contract and dependency coverage', () => {
  assert.deepEqual(matrix.AVR_WORKLOADS.map((workload) => workload.id), [
    'core-only-block-style',
    'mstimer2',
    'wire-spi-eeprom',
  ]);
  for (const workload of matrix.AVR_WORKLOADS) {
    assert.equal(matrix.validateWorkload(workload), true, workload.id);
    assert.deepEqual(workload.stages.map((stage) => stage.id), matrix.STAGE_IDS);
    const hashes = workload.stages.map((stage) => matrix.sha256Bytes(stage.code));
    assert.equal(hashes[0], hashes[3], `${workload.id} must restore the exact simple bytes`);
    assert.notEqual(hashes[0], hashes[1]);
    assert.notEqual(hashes[0], hashes[2]);
    assert.notEqual(hashes[1], hashes[2]);
    for (const stage of workload.stages) {
      assert.match(stage.code, /@ck-source-begin:v1:[0-9a-f]+/u);
      assert.match(stage.code, /@ck-source-end:v1:[0-9a-f]+/u);
    }
  }
  const timerSource = matrix.AVR_WORKLOADS.find((item) => item.id === 'mstimer2').stages[0].code;
  assert.match(timerSource, /#if defined\(ARDUINO_ARCH_AVR\).*@ck-source-begin/u);
  assert.match(timerSource, /#include <MsTimer2\.h>/u);
  assert.match(timerSource, /unsigned long intervalMs_ = 0;/u);
  assert.match(timerSource, /lastTick_ \+= intervalMs_;/u);
  assert.match(timerSource, /static CKMsTimer2Compat ck_ms_timer2;/u);
  const busSource = matrix.AVR_WORKLOADS.find((item) => item.id === 'wire-spi-eeprom').stages[0].code;
  for (const header of ['Wire.h', 'SPI.h', 'EEPROM.h']) assert.match(busSource, new RegExp(`#include <${header}>`, 'u'));
});

function restorationRun(sourceSha256, flashUsedBytes, ramUsedBytes, warningCount, suffix) {
  return {
    codeSha256: sourceSha256,
    resources: { evidenceComplete: true, flashUsedBytes, ramUsedBytes, warningCount },
    artifacts: [
      { name: `p${suffix}.ino.hex`, bytes: 12, sha256: 'hex-sha', role: 'avr-application-hex' },
      { name: `p${suffix}.ino.eep`, bytes: 4, sha256: 'eep-sha', role: 'avr-eeprom' },
    ],
  };
}

test('simple-return restoration gate checks source, AVR artifacts and resources per lane', () => {
  const simple = restorationRun('same-source', 1234, 56, 0, 'simple');
  const restored = restorationRun('same-source', 1234, 56, 7, 'return');
  const evidence = matrix.evaluateSimpleReturnRestoration({
    ck: { simple, 'simple-return': restored },
    native: { simple, 'simple-return': restored },
  });
  assert.equal(evidence.passed, true);
  assert.equal(evidence.ck.warningCount.comparable, true);
  assert.equal(evidence.ck.warningCount.match, false);
  assert.equal(evidence.ck.warningCount.gateRequired, false);
  assert.equal(evidence.policy.warningCountGateRequired, false);

  const artifactDrift = restorationRun('same-source', 1234, 56, 0, 'return');
  artifactDrift.artifacts[0].sha256 = 'different-hex';
  const artifactFailure = matrix.evaluateSimpleReturnRestoration({
    ck: { simple, 'simple-return': artifactDrift },
    native: { simple, 'simple-return': restored },
  });
  assert.equal(artifactFailure.ck.artifacts.passed, false);
  assert.equal(artifactFailure.passed, false);

  const resourceDrift = restorationRun('same-source', 1235, 56, 0, 'return');
  const resourceFailure = matrix.evaluateSimpleReturnRestoration({
    ck: { simple, 'simple-return': resourceDrift },
    native: { simple, 'simple-return': restored },
  });
  assert.equal(resourceFailure.ck.resources.passed, false);
  assert.equal(resourceFailure.passed, false);

  const sourceDrift = restorationRun('different-source', 1234, 56, 0, 'return');
  const sourceFailure = matrix.evaluateSimpleReturnRestoration({
    ck: { simple, 'simple-return': sourceDrift },
    native: { simple, 'simple-return': restored },
  });
  assert.equal(sourceFailure.ck.source.passed, false);
  assert.equal(sourceFailure.passed, false);
});

test('plan is deterministic, read-only and defaults to 114 cells / 896 compiles', () => {
  const options = matrix.parseArgs(['--plan']);
  const plan = matrix.planFor(options);
  assert.equal(plan.targets.length, 38);
  assert.equal(plan.workloads.length, 3);
  assert.equal(plan.cellCount, 114);
  assert.equal(plan.applicableCellCount, 112);
  assert.equal(plan.expectedSkipCellCount, 2);
  assert.equal(plan.totalCompileCount, 896);
  assert.equal(plan.compileOnly, true);
  assert.equal(plan.uploadPerformed, false);
  assert.equal(plan.serialPortAccessed, false);
  assert.equal(plan.qualificationClaimed, false);
  assert.equal(plan.simpleReturnRestorationPolicy.id, 'ck-avr-simple-return-restoration-v1');
  assert.equal(plan.simpleReturnRestorationPolicy.warningCountGateRequired, false);

  const filtered = matrix.parseArgs([
    '--plan', '--target', 'nano-atmega328old', '--workload', 'mstimer2', '--trials', '3',
  ]);
  const filteredPlan = matrix.planFor(filtered);
  assert.equal(filteredPlan.cellCount, 1);
  assert.equal(filteredPlan.applicableCellCount, 1);
  assert.equal(filteredPlan.expectedSkipCellCount, 0);
  assert.equal(filteredPlan.totalCompileCount, 24);

  const gemmaSkip = matrix.planFor(matrix.parseArgs([
    '--plan', '--target', 'gemma', '--workload', 'mstimer2',
  ]));
  assert.equal(gemmaSkip.cellCount, 1);
  assert.equal(gemmaSkip.applicableCellCount, 0);
  assert.equal(gemmaSkip.expectedSkipCellCount, 1);
  assert.equal(gemmaSkip.totalCompileCount, 0);
  assert.equal(gemmaSkip.cells[0].applicability.status, 'expected-skip');
  assert.match(gemmaSkip.cells[0].applicability.reason, /ATtiny85/u);

  const gemmaCore = matrix.planFor(matrix.parseArgs([
    '--plan', '--target', 'gemma', '--workload', 'core-only-block-style',
  ]));
  assert.equal(gemmaCore.applicableCellCount, 1);
  assert.equal(gemmaCore.totalCompileCount, 8);
  assert.throws(() => matrix.parseArgs(['--execute', '--output', 'report.json']), /allow-cache-reset/u);
  assert.throws(() => matrix.parseArgs(['--plan', '--target', 'not-a-board']), /unknown target/u);
});

function syntheticTrial(editCkMs = 2000) {
  const trial = {
    order: 'ck-native',
    ck: {},
    native: {},
    equivalence: {},
    failures: [],
    laneBoundaryIdle: ['ck', 'native'].map((lane) => ({
      lane,
      policyId: matrix.LANE_BOUNDARY_IDLE_POLICY.policyId,
      idleWindowMs: matrix.LANE_BOUNDARY_IDLE_POLICY.idleWindowMs,
      timeoutMs: matrix.LANE_BOUNDARY_IDLE_POLICY.timeoutMs,
      pollIntervalMs: matrix.LANE_BOUNDARY_IDLE_POLICY.pollIntervalMs,
      waitedMs: matrix.LANE_BOUNDARY_IDLE_POLICY.idleWindowMs,
      polls: 6,
    })),
  };
  for (const stageId of matrix.STAGE_IDS) {
    const ckWall = stageId === 'simple' ? 5000 : editCkMs;
    trial.ck[stageId] = {
      wallMs: ckWall,
      buildMode: stageId === 'simple' ? 'full-build' : 'native-relink-compile-only',
      exactUsed: false,
      fallback: { used: false },
      cache: {
        nativeRelinkDiagnostics: stageId === 'simple'
          ? [
            '[INFO] CK Forge NativeRelinkCompileOnly certificate matched this host/Core/toolchain/FQBN',
            '[INFO] NativeRelink AVR Release baseline committed (authorization=certified).',
          ]
          : [
            '[INFO] CK Forge NativeRelinkCompileOnly certificate matched this host/Core/toolchain/FQBN',
            '[INFO] NativeRelinkCompileOnly path: AVR Release sketch-only compile + native link/objcopy',
          ],
      },
    };
    trial.native[stageId] = { wallMs: 4000 };
    trial.equivalence[stageId] = {
      source: true,
      resources: true,
      artifacts: { passed: true },
    };
  }
  // The execution runner fills this from real CK/native artifacts. Keep the
  // performance-only fixture explicit so evaluateCell remains fail-closed for
  // production reports while this fixture focuses on timing policy.
  trial.simpleReturnRestoration = { passed: true };
  return trial;
}

test('performance target excludes cold simple and never becomes a certificate claim', () => {
  assert.equal(matrix.PERFORMANCE_POLICY.id, 'ck-avr-matrix-edit-target-v2');
  assert.equal(matrix.PERFORMANCE_POLICY.minimumMedianSpeedupPct, 25);
  const fast = matrix.evaluateCell({ trials: [syntheticTrial()], failures: [] });
  assert.equal(fast.measurementPassed, true);
  assert.equal(fast.stages.simple.performancePassed, null);
  assert.equal(fast.performanceTarget.passed, true);
  assert.equal(fast.performanceTarget.status, 'target-met');
  assert.equal(fast.performanceTarget.qualificationClaimed, false);

  const slow = matrix.evaluateCell({ trials: [syntheticTrial(4500)], failures: [] });
  assert.equal(slow.measurementPassed, true);
  assert.equal(slow.performanceTarget.passed, false);
  assert.equal(slow.performanceTarget.status, 'target-not-met');

  const restorationDrift = syntheticTrial();
  restorationDrift.simpleReturnRestoration = { passed: false };
  const failedRestoration = matrix.evaluateCell({ trials: [restorationDrift], failures: [] });
  assert.equal(failedRestoration.stageByStageArtifactAndResourceEquivalent, true);
  assert.equal(failedRestoration.simpleReturnRestorationEquivalent, false);
  assert.equal(failedRestoration.artifactAndResourceEquivalent, false);
  assert.equal(failedRestoration.measurementPassed, false);
});

test('lane boundary waits for the shared 500ms idle policy and evidence order is fail-closed', async () => {
  assert.deepEqual(matrix.LANE_BOUNDARY_IDLE_POLICY, {
    policyId: 'arduino-cli-lane-idle-window-v1',
    idleWindowMs: 500,
    timeoutMs: 60_000,
    pollIntervalMs: 100,
    outsideMeasuredCompileWallTime: true,
  });
  let observedOptions = null;
  const record = await matrix.waitForLaneIdleBoundary('native', async (options) => {
    observedOptions = options;
    return {
      policyId: options.policyId,
      idleWindowMs: options.idleWindowMs,
      timeoutMs: options.timeoutMs,
      pollIntervalMs: options.pollIntervalMs,
      waitedMs: 700,
      polls: 8,
    };
  });
  assert.deepEqual(observedOptions, {
    idleWindowMs: 500,
    timeoutMs: 60_000,
    pollIntervalMs: 100,
    policyId: 'arduino-cli-lane-idle-window-v1',
    phaseLabel: 'native lane boundary',
  });
  assert.equal(record.lane, 'native');
  assert.equal(record.waitedMs, 700);
  await assert.rejects(matrix.waitForLaneIdleBoundary('other'), /unsupported compile lane/u);

  const trial = syntheticTrial();
  assert.equal(matrix.laneBoundaryIdleEvidencePassed(trial), true);
  trial.laneBoundaryIdle.reverse();
  assert.equal(matrix.laneBoundaryIdleEvidencePassed(trial), false);
  const failed = matrix.evaluateCell({ trials: [trial], failures: [] });
  assert.equal(failed.laneBoundaryIdlePassed, false);
  assert.equal(failed.measurementPassed, false);
});

test('execution source is compile-only, normal-route and cleanup bounded', () => {
  assert.doesNotMatch(source, /invoke\(['"]upload_sketch['"]/u);
  assert.match(source, /qualification:\s*false/u);
  assert.match(source, /silent:\s*false/u);
  assert.doesNotMatch(source, /silent:\s*true/u);
  assert.match(source, /const runId = crypto\.randomUUID\(\)/u);
  assert.doesNotMatch(source, /runId:\s*null/u);
  assert.match(source, /nativeRelinkDiagnostics/u);
  assert.match(source, /nativeRelinkRoutePassed/u);
  assert.match(source, /clear_board_first_project_compile_cache/u);
  assert.match(source, /assertNoConcurrentArduinoCli/u);
  assert.match(source, /trial\.laneBoundaryIdle\.push\(await waitForLaneIdleBoundary\(lane\)\)/u);
  assert.match(source, /laneBoundaryIdlePolicy:\s*LANE_BOUNDARY_IDLE_POLICY/u);
  assert.match(source, /inspectOwnedWorkdir/u);
  assert.match(source, /safeRemoveWorkdir/u);
  assert.match(source, /qualificationClaimed:\s*false/u);
});
