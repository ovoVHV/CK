import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const batch = require('./Run-CKAvrFullQualificationBatch.cjs');
const gate = require('./Evaluate-CKForgePerformanceGate.cjs');

const REPO_ROOT = path.resolve(import.meta.dirname, '..');
const QUALIFICATION_ROOT = path.join(REPO_ROOT, 'state', 'qualifications');
const VALID_TOKEN = 'a'.repeat(64);

function executeArgs(stateRoot) {
  return [
    '--execute', '--state-root', stateRoot, '--allow-cache-reset',
  ];
}

test('plan covers all 38 canonical complete AVR FQBNs and 1824 sequential compile calls', () => {
  const options = batch.parseArgs(['--plan']);
  const plan = batch.planFor(options);
  assert.equal(plan.targetCount, 38);
  assert.equal(plan.qualificationCompileCalls, 1520);
  assert.equal(plan.coverageCompileCalls, 304);
  assert.equal(plan.totalCompileCalls, 1824);
  assert.equal(plan.sequential, true);
  assert.equal(plan.compileOnly, true);
  assert.equal(plan.uploadPerformed, false);
  assert.equal(plan.exactFqbnCertificateBindingPreserved, true);
  assert.equal(new Set(plan.targets.map((target) => target.fqbn)).size, 38);
  assert.ok(plan.targets.every((target) => (
    target.qualificationTrials === 5
      && target.qualificationCompileCalls === 40
      && target.coverageCompileCalls === 8
  )));
});

test('batch manifest audits the bounded child-start idle policy outside runner measurements', () => {
  const options = batch.parseArgs(['--plan']);
  const manifest = batch.manifestFor(options, { executableSha256: 'a'.repeat(64) });
  assert.deepEqual(manifest.controls.childStartIdlePolicy, {
    policyId: 'arduino-cli-batch-child-idle-window-v1',
    idleWindowMs: 2_000,
    timeoutMs: 60_000,
    pollIntervalMs: 200,
    outsideChildRunnerMeasurement: true,
    followedByImmediateZeroProcessGuard: true,
  });
});

test('38 target list is an exhaustive expansion of Arduino AVR Core 1.8.6 boards.txt CPU menus', () => {
  const boardsText = fs.readFileSync(
    path.join(REPO_ROOT, 'packages', 'arduino', 'hardware', 'avr', '1.8.6', 'boards.txt'),
    'utf8',
  );
  const boardIds = [...boardsText.matchAll(/^([^.\s=]+)\.name=/gmu)].map((match) => match[1]);
  const expected = boardIds.flatMap((boardId) => {
    const expression = new RegExp(`^${boardId.replace(/[.*+?^${}()|[\]\\]/gu, '\\$&')}\\.menu\\.cpu\\.([^.\\s=]+)=`, 'gmu');
    const cpuValues = [...boardsText.matchAll(expression)].map((match) => match[1]);
    return cpuValues.length > 0
      ? cpuValues.map((cpu) => `arduino:avr:${boardId}:cpu=${cpu}`)
      : [`arduino:avr:${boardId}`];
  });
  assert.equal(boardIds.length, 27);
  assert.deepEqual(
    [...new Set(batch.targetPlan().map((target) => target.fqbn))].sort(),
    [...new Set(expected)].sort(),
  );
});

test('execute parsing requires explicit cache reset, state root and shared qualification token', () => {
  assert.throws(
    () => batch.parseArgs(['--execute'], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: VALID_TOKEN }),
    /state-root/u,
  );
  assert.throws(
    () => batch.parseArgs(['--execute', '--state-root', 'x'], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: VALID_TOKEN }),
    /allow-cache-reset/u,
  );
  assert.throws(
    () => batch.parseArgs(executeArgs('x'), {}),
    /64 lowercase hex/u,
  );
  const options = batch.parseArgs(executeArgs('x'), {
    CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: VALID_TOKEN,
  });
  assert.equal(options.maxTargets, 1);
  assert.equal(options.allRemaining, false);
  assert.equal(options.qualificationTokenPresent, true);
});

test('batch certificate consumer rejects portable fields in a NativeRelink envelope', () => {
  const valid = {
    schemaId: 'ck.forge.local-performance-certificate',
    schemaVersion: 4,
    candidateProfile: 'native-relink-compile-only',
    evidenceSha256: 'a'.repeat(64),
    reportSha256: 'b'.repeat(64),
  };
  assert.equal(batch.nativeRelinkCertificateHasExactShape(valid), true);
  assert.equal(batch.nativeRelinkCertificateHasExactShape({
    ...valid,
    candidateSha256: 'c'.repeat(64),
  }), false);
  assert.equal(batch.nativeRelinkCertificateHasExactShape({ ...valid, schemaVersion: 2 }), false);
  assert.equal(batch.nativeRelinkCertificateHasExactShape({ ...valid, schemaVersion: 999 }), false);
});

test('long-run and retry controls remain explicit and mutually bounded', () => {
  const environment = { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: VALID_TOKEN };
  assert.throws(
    () => batch.parseArgs([...executeArgs('x'), '--all-remaining', '--max-targets', '2'], environment),
    /mutually exclusive/u,
  );
  assert.throws(
    () => batch.parseArgs(['--plan', '--all-remaining']),
    /read-only/u,
  );
  const parsed = batch.parseArgs([
    ...executeArgs('x'), '--max-targets', '3', '--retry-failed', '--continue-on-failure',
  ], environment);
  assert.equal(parsed.maxTargets, 3);
  assert.equal(parsed.retryFailed, true);
  assert.equal(parsed.continueOnFailure, true);
});

test('child commands preserve compile-only exact-FQBN and formal five-trial contracts', () => {
  const target = batch.targetPlan().find((candidate) => candidate.id === 'nano-atmega328old');
  const options = { minFreeGiB: 12, timeoutMinutes: 10 };
  const qualification = batch.qualificationCommandFor(target, 'Q.json', options);
  assert.deepEqual(qualification.slice(qualification.indexOf('--fqbn'), qualification.indexOf('--fqbn') + 2), [
    '--fqbn', 'arduino:avr:nano:cpu=atmega328old',
  ]);
  assert.deepEqual(qualification.slice(qualification.indexOf('--trials'), qualification.indexOf('--trials') + 2), [
    '--trials', '5',
  ]);
  assert.deepEqual(qualification.slice(qualification.indexOf('--require-ck-mode'), qualification.indexOf('--require-ck-mode') + 2), [
    '--require-ck-mode', 'native-relink-compile-only',
  ]);
  assert.ok(!qualification.includes('upload'));

  const coverage = batch.coverageCommandFor(target, 'C.json', options);
  assert.deepEqual(coverage.slice(coverage.indexOf('--target'), coverage.indexOf('--target') + 2), [
    '--target', 'nano-atmega328old',
  ]);
  assert.deepEqual(coverage.slice(coverage.indexOf('--workload'), coverage.indexOf('--workload') + 2), [
    '--workload', 'core-only-block-style',
  ]);
  assert.ok(!coverage.includes('upload'));
});

test('batch child launch waits through a late CLI process and then applies the immediate guard', () => {
  let clock = 0;
  let index = 0;
  const observed = [1, 0, 0, 0, 0, 0, 0];
  const evidence = batch.prepareBatchChildLaunch({
    phase: 'qualification',
    idleWindowMs: 400,
    timeoutMs: 2_000,
    pollIntervalMs: 100,
    readProcessCount: () => observed[Math.min(index++, observed.length - 1)],
    now: () => clock,
    sleep: (durationMs) => { clock += durationMs; },
  });
  assert.deepEqual(evidence, {
    policyId: 'arduino-cli-batch-child-idle-window-v1',
    phase: 'qualification',
    idleWindowMs: 400,
    timeoutMs: 2_000,
    pollIntervalMs: 100,
    waitedMs: 500,
    polls: 6,
    restarts: 0,
    observedBusyTransitions: 1,
    lastObservedProcessCount: 0,
    outsideChildRunnerMeasurement: true,
    immediateObservedProcessCount: 0,
    immediateZeroProcessGuardPassed: true,
  });
  assert.equal(index, 7, 'the seventh read is the immediate post-window guard');
});

test('batch child launch retries a raced immediate guard inside one total deadline', () => {
  let clock = 0;
  let index = 0;
  const firstWindowRacedThenStable = [
    ...Array.from({ length: 11 }, () => 0),
    1,
    ...Array.from({ length: 12 }, () => 0),
  ];
  const evidence = batch.prepareBatchChildLaunch({
    phase: 'qualification',
    readProcessCount: () => firstWindowRacedThenStable[
      Math.min(index++, firstWindowRacedThenStable.length - 1)
    ],
    now: () => clock,
    sleep: (durationMs) => { clock += durationMs; },
  });
  assert.equal(evidence.waitedMs, 4_000);
  assert.equal(evidence.polls, 22);
  assert.equal(evidence.restarts, 1);
  assert.equal(evidence.observedBusyTransitions, 1);
  assert.equal(evidence.immediateObservedProcessCount, 0);
  assert.equal(evidence.immediateZeroProcessGuardPassed, true);
  assert.equal(index, 24);
});

test('batch child launch fails closed when permanent jitter exhausts the total budget', () => {
  let timeoutClock = 0;
  assert.throws(
    () => batch.prepareBatchChildLaunch({
      phase: 'coverage',
      idleWindowMs: 500,
      timeoutMs: 1_000,
      pollIntervalMs: 200,
      readProcessCount: () => 1,
      now: () => timeoutClock,
      sleep: (durationMs) => { timeoutClock += durationMs; },
    }),
    /coverage child-start gate did not obtain a complete 500ms idle window plus an immediate zero-process guard within the total 1000ms budget/,
  );

  let jitterClock = 0;
  let jitterIndex = 0;
  const jitter = [...Array.from({ length: 11 }, () => 0), 1];
  assert.throws(
    () => batch.prepareBatchChildLaunch({
      phase: 'qualification',
      timeoutMs: 5_000,
      readProcessCount: () => jitter[jitterIndex++ % jitter.length],
      now: () => jitterClock,
      sleep: (durationMs) => { jitterClock += durationMs; },
    }),
    /within the total 5000ms budget/,
  );
  assert.ok(jitterIndex >= 24, 'at least two raced 2s candidate windows must be retried');
});

test('append-only event journal reconstructs resumable per-target state', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-batch-events-'));
  try {
    batch.appendEvent(root, {
      targetId: 'uno', fqbn: 'arduino:avr:uno', phase: 'qualification', kind: 'started', attempt: 1,
    });
    batch.appendEvent(root, {
      targetId: 'uno', fqbn: 'arduino:avr:uno', phase: 'qualification', kind: 'passed', attempt: 1,
      certificatePath: 'certificate',
    });
    batch.appendEvent(root, {
      targetId: 'uno', fqbn: 'arduino:avr:uno', phase: 'coverage', kind: 'started', attempt: 1,
    });
    const events = batch.loadEvents(root);
    assert.equal(events.length, 3);
    assert.deepEqual(events.map((event) => event.sequence), [1, 2, 3]);
    assert.deepEqual(batch.latestTargetState(events, 'uno'), {
      qualification: 'passed',
      coverage: 'running',
      qualificationAttempts: 1,
      coverageAttempts: 1,
      failure: null,
      certificatePath: 'certificate',
    });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('current-policy five-trial certificate reproduces from raw evidence and rejects envelope tampering', () => {
  const candidates = fs.readdirSync(QUALIFICATION_ROOT)
    .filter((name) => /^[0-9a-f]{64}$/u.test(name))
    .map((name) => path.join(QUALIFICATION_ROOT, name))
    .filter((directory) => fs.existsSync(path.join(directory, 'report.json')));
  const directory = candidates.find((candidate) => {
    const report = JSON.parse(fs.readFileSync(path.join(candidate, 'report.json'), 'utf8'));
    return report?.target?.fqbn?.startsWith('arduino:avr:') && report.trialCountPerLane >= 5;
  });
  assert.ok(directory, 'expected at least one AVR five-trial qualification fixture');
  const fixtureRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-cert-current-'));
  try {
    const evidence = JSON.parse(fs.readFileSync(path.join(directory, 'evidence.json'), 'utf8'));
    evidence.controls.laneBoundaryIdlePolicy = {
      policyId: 'arduino-cli-lane-idle-window-v1',
      idleWindowMs: 500,
      timeoutMs: 60_000,
      pollIntervalMs: 100,
      outsideMeasuredCompileWallTime: true,
    };
    for (const trial of evidence.trials) {
      trial.laneBoundaryIdle = trial.order.split('-').map((lane) => ({
        lane,
        policyId: 'arduino-cli-lane-idle-window-v1',
        idleWindowMs: 500,
        timeoutMs: 60_000,
        pollIntervalMs: 100,
        waitedMs: 500,
        polls: 6,
      }));
    }
    const evidenceText = `${JSON.stringify(evidence, null, 2)}\n`;
    const evidenceSha256 = batch.sha256Bytes(Buffer.from(evidenceText));
    const oldReport = JSON.parse(fs.readFileSync(path.join(directory, 'report.json'), 'utf8'));
    const report = gate.validateAndEvaluateNativeRelink(
      evidence,
      evidenceSha256,
      oldReport.evaluatedAt,
    );
    const copy = path.join(fixtureRoot, report.qualificationKey);
    fs.mkdirSync(copy);
    fs.writeFileSync(path.join(copy, 'evidence.json'), evidenceText);
    const reportText = `${JSON.stringify(report, null, 2)}\n`;
    fs.writeFileSync(path.join(copy, 'report.json'), reportText);
    fs.writeFileSync(path.join(copy, 'certificate.json'), `${JSON.stringify({
      schemaId: 'ck.forge.local-performance-certificate',
      schemaVersion: 4,
      candidateProfile: 'native-relink-compile-only',
      evidenceSha256,
      reportSha256: batch.sha256Bytes(Buffer.from(reportText)),
    }, null, 2)}\n`);
    const expected = Object.fromEntries([
      'fqbn', 'coreVersion', 'cliVersion', 'cliExecutableSha256',
      'hostIdentitySha256', 'productionExecutableSha256',
    ].map((field) => [field, report.target[field]]));
    const validated = batch.validateCertificateDirectory(copy, expected);
    assert.equal(validated.qualificationKey, path.basename(copy));

    const certificatePath = path.join(copy, 'certificate.json');
    const certificate = JSON.parse(fs.readFileSync(certificatePath, 'utf8'));
    certificate.candidateSha256 = 'a'.repeat(64);
    fs.writeFileSync(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`);
    assert.throws(
      () => batch.validateCertificateDirectory(copy, expected),
      /envelope or content hashes/u,
      'a portable/local field must not be accepted in a NativeRelink envelope',
    );
    delete certificate.candidateSha256;
    certificate.evidenceSha256 = '0'.repeat(64);
    fs.writeFileSync(certificatePath, `${JSON.stringify(certificate, null, 2)}\n`);
    assert.throws(
      () => batch.validateCertificateDirectory(copy, expected),
      /envelope or content hashes/u,
    );
  } finally {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
  }
});

test('coverage evidence validator requires exact core-only production NativeRelink route', () => {
  const target = batch.targetPlan().find((candidate) => candidate.id === 'uno');
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-coverage-'));
  const file = path.join(root, 'coverage.json');
  const fixture = {
    schemaId: 'ck.avr.compile-regression-report',
    schemaVersion: 1,
    status: 'passed',
    measurementStatus: 'passed',
    performanceTargetStatus: 'target-met',
    trialsPerCell: 1,
    plannedCellCount: 1,
    applicableCellCount: 1,
    expectedSkipCellCount: 0,
    plannedCompileCount: batch.COVERAGE_COMPILES_PER_TARGET,
    failures: [],
    controls: {
      compileOnly: true, uploadPerformed: false, physicalFlashWritten: false, serialPortAccessed: false,
    },
    targets: [{ id: target.id, fqbn: target.fqbn }],
    cells: [{
      targetId: target.id,
      fqbn: target.fqbn,
      workloadId: 'core-only-block-style',
      result: {
        measurementPassed: true,
        artifactAndResourceEquivalent: true,
        noExactCompilerBypass: true,
        nativeRelinkRoutePassed: true,
      },
    }],
  };
  try {
    fs.writeFileSync(file, `${JSON.stringify(fixture)}\n`);
    assert.equal(batch.validateCoverageEvidence(file, target).measurementStatus, 'passed');
    fixture.performanceTargetStatus = 'target-not-met';
    fs.writeFileSync(file, `${JSON.stringify(fixture)}\n`);
    assert.equal(batch.validateCoverageEvidence(file, target).measurementStatus, 'passed');
    fixture.cells[0].fqbn = 'arduino:avr:nano:cpu=atmega328old';
    fs.writeFileSync(file, `${JSON.stringify(fixture)}\n`);
    assert.throws(
      () => batch.validateCoverageEvidence(file, target),
      /exact compile-only production-route contract/u,
    );
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});
