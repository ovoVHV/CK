import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const verifier = require('./Verify-CKAvrRegressionMatrix.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const ENTRY = path.join(ROOT, 'scripts', 'Verify-CKAvrRegressionMatrix.cjs');
const HISTORICAL_REPORT = path.join(
  ROOT, 'artifacts', 'benchmarks', 'ck-avr-full-matrix-exe821a2c10-20260719.json',
);
const EXE = path.join(ROOT, 'target', 'release', 'appsdesktop.exe');
const SOURCE = fs.readFileSync(ENTRY, 'utf8');
const CANDIDATE_WRAPPER = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKAvrFullMatrixCandidate.ps1'), 'utf8',
);
const BASE = JSON.parse(fs.readFileSync(HISTORICAL_REPORT, 'utf8'));
const EXE_STAT = fs.statSync(EXE);
const EXE_SHA256 = crypto.createHash('sha256').update(fs.readFileSync(EXE)).digest('hex');

function currentizedReport() {
  const report = structuredClone(BASE);
  for (const side of ['before', 'after']) {
    report.productionExecutable[side].executableBytes = EXE_STAT.size;
    report.productionExecutable[side].executableSha256 = EXE_SHA256;
  }
  return report;
}

function verify(report) {
  return verifier.verifyReport(report, {
    executable: EXE,
    executableStat: EXE_STAT,
  });
}

test('fixed full-matrix contract is 38 FQBNs x 3 workloads with two exact Gemma skips', () => {
  const plan = verifier.expectedFullPlan();
  assert.equal(plan.targets.length, 38);
  assert.equal(new Set(plan.targets.map((target) => target.fqbn)).size, 38);
  assert.equal(plan.workloads.length, 3);
  assert.equal(plan.cellCount, 114);
  assert.equal(plan.applicableCellCount, 112);
  assert.equal(plan.expectedSkipCellCount, 2);
  assert.equal(plan.totalCompileCount, 896);
  assert.deepEqual(
    plan.cells.filter((cell) => !cell.applicability.applicable).map((cell) => (
      `${cell.targetId}__${cell.workloadId}`
    )),
    ['gemma__mstimer2', 'gemma__wire-spi-eeprom'],
  );
});

test('independent verifier recomputes the complete historical matrix against the supplied current EXE', () => {
  const report = currentizedReport();
  const before = JSON.stringify(report);
  const result = verify(report);
  assert.equal(result.status, 'passed');
  assert.equal(result.targetCount, 38);
  assert.equal(result.workloadCount, 3);
  assert.equal(result.cellCount, 114);
  assert.equal(result.applicableCellCount, 112);
  assert.equal(result.expectedSkipCellCount, 2);
  assert.equal(result.pairedStageCount, 448);
  assert.equal(result.compileCallCount, 896);
  assert.equal(result.cacheResetCount, 112);
  assert.equal(result.cleanupVerified, true);
  assert.equal(result.productionExecutableSha256, EXE_SHA256);
  assert.equal(JSON.stringify(report), before, 'verification must not mutate in-memory evidence');
});

test('CLI is read-only, emits a report digest and exposes no mutation options', () => {
  assert.throws(() => verifier.parseArgs([]), /--input/u);
  assert.throws(() => verifier.parseArgs(['--input']), /requires a JSON file/u);
  assert.throws(() => verifier.parseArgs(['--input', 'x.json', '--expected-executable']), /requires a file/u);
  assert.throws(() => verifier.parseArgs(['--input', 'x.json', '--output', 'y.json']), /unknown argument/u);
  assert.equal(verifier.parseArgs(['--help']).help, true);
  assert.doesNotMatch(SOURCE, /(?:spawn|exec)(?:File)?Sync\s*\(/u);
  assert.doesNotMatch(SOURCE, /fs\.(?:write|append|unlink|rm|rename|link|mkdir)/u);
  assert.match(CANDIDATE_WRAPPER, /Verify-CKAvrRegressionMatrix\.cjs/u);
  assert.match(CANDIDATE_WRAPPER, /Independent AVR matrix verification failed/u);
  assert.match(CANDIDATE_WRAPPER, /MATRIX-VERIFIED/u);

  const temporary = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-avr-matrix-verify-'));
  const input = path.join(temporary, 'matrix.json');
  try {
    fs.writeFileSync(input, `${JSON.stringify(currentizedReport())}\n`);
    const before = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    const run = spawnSync(process.execPath, [
      ENTRY, '--input', input, '--expected-executable', EXE,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.equal(run.status, 0, run.stderr);
    const output = JSON.parse(run.stdout);
    assert.equal(output.status, 'passed');
    assert.equal(output.reportSha256, before);
    const after = crypto.createHash('sha256').update(fs.readFileSync(input)).digest('hex');
    assert.equal(after, before);
    assert.deepEqual(fs.readdirSync(temporary), ['matrix.json']);
  } finally {
    fs.rmSync(temporary, { recursive: true, force: true });
  }
});

test('count, Cartesian order and expected-skip tampering fail closed', () => {
  const wrongCount = currentizedReport();
  wrongCount.plannedCompileCount = 895;
  assert.throws(() => verify(wrongCount), /top-level counts/u);

  const wrongOrder = currentizedReport();
  [wrongOrder.cells[0], wrongOrder.cells[1]] = [wrongOrder.cells[1], wrongOrder.cells[0]];
  assert.throws(() => verify(wrongOrder), /Cartesian row/u);

  const fakeSkip = currentizedReport();
  const skip = fakeSkip.cells.find((cell) => cell.id === 'gemma__mstimer2');
  skip.applicability.applicable = true;
  assert.throws(() => verify(fakeSkip), /applicability differs/u);
});

test('lane order, route, per-run integrity and equivalence are independently recomputed', () => {
  const wrongOrder = currentizedReport();
  wrongOrder.cells[0].trials[0].order = 'native-ck';
  assert.throws(() => verify(wrongOrder), /lane alternation/u);

  const routeDrift = currentizedReport();
  const simple = routeDrift.cells[0].trials[0].ck.simple;
  simple.cache.nativeRelinkDiagnostics = simple.cache.nativeRelinkDiagnostics.filter(
    (line) => !line.includes('baseline committed'),
  );
  simple.evidenceSha256 = verifier.expectedRunEvidenceSha256(simple, 'ck');
  assert.throws(() => verify(routeDrift), /did not commit the certified AVR baseline/u);

  const unsignedDrift = currentizedReport();
  unsignedDrift.cells[0].trials[0].ck.simple.jobs += 1;
  assert.throws(() => verify(unsignedDrift), /jobs differ|evidence SHA/u);

  const equivalenceDrift = currentizedReport();
  equivalenceDrift.cells[0].trials[0].equivalence.simple.source = false;
  assert.throws(() => verify(equivalenceDrift), /equivalence does not reproduce/u);
});

test('cleanup and production EXE hash are hard terminal gates', () => {
  const retained = currentizedReport();
  retained.disk.cleanup.removed = false;
  assert.throws(() => verify(retained), /work directory was not removed/u);

  const wrongExecutable = currentizedReport();
  wrongExecutable.productionExecutable.after.executableSha256 = '0'.repeat(64);
  assert.throws(() => verify(wrongExecutable), /before\/after identities differ/u);

  assert.throws(
    () => verifier.verifyMatrix({ input: HISTORICAL_REPORT, expectedExecutable: EXE }),
    /byte size differs|SHA-256 differs/u,
    'historical output must not be relabeled as evidence for a different production EXE',
  );
});
