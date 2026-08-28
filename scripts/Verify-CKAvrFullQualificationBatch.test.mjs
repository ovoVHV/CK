import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const verifier = require('./Verify-CKAvrFullQualificationBatch.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const EXE = path.join(ROOT, 'target', 'release', 'appsdesktop.exe');
const QUAL_ROOT = path.join(ROOT, 'state', 'qualifications');
const INCOMPLETE_BATCH = path.join(
  ROOT,
  'artifacts', 'benchmarks', 'ck-avr-full-qualification-exe1c2f5223-20260720-r3',
);

function readJson(file) {
  return JSON.parse(fs.readFileSync(file, 'utf8'));
}

function sha256(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function treeSnapshot(root) {
  const rows = [];
  const visit = (directory) => {
    for (const entry of fs.readdirSync(directory, { withFileTypes: true }).sort((a, b) => a.name.localeCompare(b.name))) {
      const file = path.join(directory, entry.name);
      assert.equal(entry.isSymbolicLink(), false, `fixture unexpectedly contains symlink: ${file}`);
      if (entry.isDirectory()) visit(file);
      else rows.push(`${path.relative(root, file)}\0${sha256(file)}`);
    }
  };
  visit(root);
  return rows;
}

test('expected AVR target contract is exactly 38 unique complete FQBN rows', () => {
  const targets = verifier.expectedTargets();
  assert.equal(targets.length, 38);
  assert.equal(new Set(targets.map((target) => target.id)).size, 38);
  assert.equal(new Set(targets.map((target) => target.fqbn)).size, 38);
  assert.ok(targets.every((target) => target.qualificationTrials === 5
    && target.qualificationCompileCalls === 40
    && target.coverageCompileCalls === 8));
});

test('child-start-stable is accepted exactly once between matching started and terminal events', () => {
  const policy = verifier.expectedChildStartIdlePolicy();
  const stability = {
    policyId: 'arduino-cli-batch-child-idle-window-v1',
    phase: 'qualification',
    idleWindowMs: 2_000,
    timeoutMs: 60_000,
    pollIntervalMs: 200,
    waitedMs: 2_400,
    polls: 13,
    restarts: 0,
    observedBusyTransitions: 0,
    lastObservedProcessCount: 0,
    outsideChildRunnerMeasurement: true,
    immediateObservedProcessCount: 0,
    immediateZeroProcessGuardPassed: true,
  };
  const events = [
    { targetId: 'uno', phase: 'qualification', kind: 'started', attempt: 1, childStartIdlePolicy: policy },
    { targetId: 'uno', phase: 'qualification', kind: 'child-start-stable', attempt: 1, childStartStability: stability },
    { targetId: 'uno', phase: 'qualification', kind: 'passed', attempt: 1 },
    { targetId: 'uno', phase: 'coverage', kind: 'started', attempt: 1, childStartIdlePolicy: policy },
    {
      targetId: 'uno', phase: 'coverage', kind: 'child-start-stable', attempt: 1,
      childStartStability: { ...stability, phase: 'coverage' },
    },
    { targetId: 'uno', phase: 'coverage', kind: 'failed', attempt: 1 },
  ];
  assert.equal(verifier.validateChildStartEventOrder(events).size, 2);

  assert.throws(
    () => verifier.validateChildStartEventOrder([events[1], events[0], events[2]]),
    /no matching started event/u,
  );
  assert.throws(
    () => verifier.validateChildStartEventOrder([events[0], events[1], events[1], events[2]]),
    /duplicate child-start-stable/u,
  );
  assert.throws(
    () => verifier.validateChildStartEventOrder([events[0], events[2]]),
    /exactly one child-start-stable/u,
  );
  assert.throws(
    () => verifier.validateChildStartEventOrder([events[0], events[1], events[2], events[1]]),
    /after terminal event/u,
  );
});

test('child-start stability evidence fails closed on short windows, phase drift and nonzero counts', () => {
  const valid = {
    policyId: 'arduino-cli-batch-child-idle-window-v1',
    phase: 'coverage',
    idleWindowMs: 2_000,
    timeoutMs: 60_000,
    pollIntervalMs: 200,
    waitedMs: 2_000,
    polls: 11,
    restarts: 0,
    observedBusyTransitions: 0,
    lastObservedProcessCount: 0,
    outsideChildRunnerMeasurement: true,
    immediateObservedProcessCount: 0,
    immediateZeroProcessGuardPassed: true,
  };
  assert.deepEqual(verifier.validateChildStartStability(valid, 'coverage', 'fixture'), valid);
  assert.deepEqual(verifier.validateChildStartStability({
    ...valid,
    waitedMs: 4_481,
    polls: 3,
  }, 'coverage', 'slow CIM fixture').polls, 3);
  assert.throws(
    () => verifier.validateChildStartStability({ ...valid, waitedMs: 1_999 }, 'coverage', 'fixture'),
    /complete bounded idle window/u,
  );
  assert.throws(
    () => verifier.validateChildStartStability({ ...valid, polls: 1 }, 'coverage', 'fixture'),
    /both boundary samples/u,
  );
  assert.throws(
    () => verifier.validateChildStartStability({ ...valid, phase: 'qualification' }, 'coverage', 'fixture'),
    /phase does not match/u,
  );
  assert.throws(
    () => verifier.validateChildStartStability({ ...valid, immediateObservedProcessCount: 1 }, 'coverage', 'fixture'),
    /counts are not both zero/u,
  );
  assert.throws(
    () => verifier.validateChildStartIdlePolicy({
      ...verifier.expectedChildStartIdlePolicy(), idleWindowMs: 500,
    }, 'fixture'),
    /policy is missing or invalid/u,
  );
});

test('legacy batch evidence is rejected after runner, EXE and child-start policy changes', () => {
  const manifest = readJson(path.join(INCOMPLETE_BATCH, 'manifest.json'));
  const executable = fs.realpathSync.native(EXE);
  assert.throws(
    () => verifier.validateManifest(
      fs.realpathSync.native(INCOMPLETE_BATCH),
      manifest,
      executable,
      fs.realpathSync.native(QUAL_ROOT),
    ),
    /child-start idle policy|production executable SHA|source bindings/u,
  );
});

test('event journal and terminal verifier reject the incomplete batch, never accepting exit-2 style progress', () => {
  const targetById = new Map(verifier.expectedTargets().map((target) => [target.id, target]));
  const events = verifier.readEventJournal(fs.realpathSync.native(INCOMPLETE_BATCH), targetById);
  assert.ok(events.length > 0);
  assert.throws(
    () => verifier.verifyBatch({ stateRoot: INCOMPLETE_BATCH }),
    /child-start idle policy|production executable SHA|source bindings|does not have passed qualification and coverage/u,
  );
});

test('terminal verifier is strictly read-only, including when verification fails', () => {
  const before = treeSnapshot(INCOMPLETE_BATCH);
  assert.throws(() => verifier.verifyBatch({ stateRoot: INCOMPLETE_BATCH }));
  const after = treeSnapshot(INCOMPLETE_BATCH);
  assert.deepEqual(after, before);
});

test('coverage validator rejects upload/serial/physical-write declarations and tampered route result', () => {
  const manifest = readJson(path.join(INCOMPLETE_BATCH, 'manifest.json'));
  const target = verifier.expectedTargets().find((candidate) => candidate.id === 'yun');
  const original = readJson(path.join(INCOMPLETE_BATCH, 'evidence', 'yun', 'coverage-attempt-001.json'));
  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-verifier-fixture-'));
  const file = path.join(temporary, 'coverage.json');
  try {
    const executableSha256 = sha256(EXE);
    original.productionExecutable.before.executableSha256 = executableSha256;
    original.productionExecutable.after.executableSha256 = executableSha256;
    fs.writeFileSync(file, JSON.stringify(original));
    assert.equal(
      verifier.validateCoverageEvidence(file, target, manifest, fs.realpathSync.native(EXE)).cells.length,
      1,
    );
    original.controls.uploadPerformed = true;
    fs.writeFileSync(file, JSON.stringify(original));
    assert.throws(
      () => verifier.validateCoverageEvidence(file, target, manifest, fs.realpathSync.native(EXE)),
      /declares an upload/u,
    );
    original.controls.uploadPerformed = false;
    original.cells[0].result.nativeRelinkRoutePassed = false;
    fs.writeFileSync(file, JSON.stringify(original));
    assert.throws(
      () => verifier.validateCoverageEvidence(file, target, manifest, fs.realpathSync.native(EXE)),
      /result was tampered|route\/equivalence gate/u,
    );
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('argument parser has no mutation/output options', () => {
  assert.equal(verifier.parseArgs(['--state-root', 'evidence']).stateRoot, 'evidence');
  assert.throws(() => verifier.parseArgs(['--state-root', 'evidence', '--output', 'x.json']), /unknown argument/u);
  assert.throws(() => verifier.parseArgs([]), /state-root/u);
});

test('certificate verifier keeps the NativeRelink envelope closed', () => {
  const valid = {
    schemaId: 'ck.forge.local-performance-certificate',
    schemaVersion: 4,
    candidateProfile: 'native-relink-compile-only',
    evidenceSha256: 'a'.repeat(64),
    reportSha256: 'b'.repeat(64),
  };
  assert.equal(verifier.nativeRelinkCertificateHasExactShape(valid), true);
  assert.equal(verifier.nativeRelinkCertificateHasExactShape({
    ...valid,
    candidateSha256: 'c'.repeat(64),
  }), false);
  assert.equal(verifier.nativeRelinkCertificateHasExactShape({ ...valid, schemaVersion: 2 }), false);
  assert.equal(verifier.nativeRelinkCertificateHasExactShape({ ...valid, schemaVersion: 999 }), false);
});

test('candidate wrapper treats terminal exit 2 as failure and invokes the independent verifier', () => {
  const source = fs.readFileSync(path.join(ROOT, 'scripts', 'Run-CKAvrQualificationCandidate.ps1'), 'utf8');
  assert.match(source, /if \(\$batchExit -ne 0\)/u);
  assert.doesNotMatch(source, /\$batchExit -notin @\(0, 2\)/u);
  assert.match(source, /Verify-CKAvrFullQualificationBatch\.cjs/u);
  assert.match(source, /if \(\$verificationExit -ne 0\)/u);
});
