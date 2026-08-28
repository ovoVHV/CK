#!/usr/bin/env node
'use strict';

// Read-only verifier for the resumable AVR qualification journal.
//
// This file deliberately does not import the batch orchestrator.  The batch
// process is allowed to create state, summaries and certificates; this tool is
// an independent consumer of those artifacts and never creates or modifies a
// filesystem entry.  A successful result is therefore a stronger terminal
// assertion than the batch process' progress/exit status.

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');
const gate = require('./Evaluate-CKForgePerformanceGate.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const EXPECTED_TARGET_COUNT = 38;
const FORMAL_TRIALS = 5;
const QUALIFICATION_COMPILES_PER_TARGET = FORMAL_TRIALS * 4 * 2;
const COVERAGE_COMPILES_PER_TARGET = 1 * 4 * 2;
const TOTAL_COMPILES_PER_TARGET = QUALIFICATION_COMPILES_PER_TARGET + COVERAGE_COMPILES_PER_TARGET;
const MANIFEST_SCHEMA_ID = 'ck.avr.full-qualification-batch-manifest';
const EVENT_SCHEMA_ID = 'ck.avr.full-qualification-batch-event';
const SUMMARY_SCHEMA_ID = 'ck.avr.full-qualification-batch-summary';
const BATCH_SCHEMA_VERSION = 1;
const SHA256_RE = /^[0-9a-f]{64}$/u;
const EVENT_FILE_RE = /^event-(\d{6})\.json$/u;
const SUMMARY_FILE_RE = /^summary-(\d{6})\.json$/u;
const STAGES = Object.freeze(['simple', 'complex', 'medium', 'simple-return']);
const CHILD_START_IDLE_POLICY_ID = 'arduino-cli-batch-child-idle-window-v1';
const CHILD_START_IDLE_WINDOW_MS = 2_000;
const CHILD_START_IDLE_TIMEOUT_MS = 60_000;
const CHILD_START_IDLE_POLL_INTERVAL_MS = 200;
const NATIVE_RELINK_CERTIFICATE_KEYS = Object.freeze([
  'candidateProfile', 'evidenceSha256', 'reportSha256', 'schemaId', 'schemaVersion',
]);

function nativeRelinkCertificateHasExactShape(certificate) {
  return certificate !== null
    && typeof certificate === 'object'
    && !Array.isArray(certificate)
    && JSON.stringify(Object.keys(certificate).sort())
      === JSON.stringify(NATIVE_RELINK_CERTIFICATE_KEYS)
    && certificate.schemaId === 'ck.forge.local-performance-certificate'
    && certificate.schemaVersion === 4
    && certificate.candidateProfile === 'native-relink-compile-only'
    && typeof certificate.evidenceSha256 === 'string'
    && SHA256_RE.test(certificate.evidenceSha256)
    && typeof certificate.reportSha256 === 'string'
    && SHA256_RE.test(certificate.reportSha256);
}

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

function pathKey(value) {
  return process.platform === 'win32' ? value.toLowerCase() : value;
}

function samePath(left, right) {
  return pathKey(path.resolve(left)) === pathKey(path.resolve(right));
}

function realDirectory(directory, label) {
  const resolved = path.resolve(directory);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) { fail(`${label} is missing: ${resolved}`); }
  assert(stat.isDirectory() && !stat.isSymbolicLink(), `${label} must be a real directory: ${resolved}`);
  return fs.realpathSync.native(resolved);
}

function regularFile(file, label, maximumBytes = 64 * 1024 * 1024) {
  const resolved = path.resolve(file);
  let stat;
  try { stat = fs.lstatSync(resolved); } catch (error) { fail(`${label} is missing: ${resolved}`); }
  assert(stat.isFile() && !stat.isSymbolicLink(), `${label} must be a regular file: ${resolved}`);
  assert(stat.size > 0 && stat.size <= maximumBytes, `${label} has an invalid size: ${resolved}`);
  return resolved;
}

function readJson(file, label, maximumBytes = 64 * 1024 * 1024) {
  const regular = regularFile(file, label, maximumBytes);
  let bytes;
  try { bytes = fs.readFileSync(regular); } catch (error) { fail(`${label} cannot be read: ${error.message}`); }
  let value;
  try { value = JSON.parse(bytes.toString('utf8')); } catch (error) { fail(`${label} is not valid JSON: ${error.message}`); }
  return { file: regular, bytes, value };
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function assertPathWithin(candidate, root, label) {
  const resolved = path.resolve(candidate);
  assert(pathWithin(resolved, root), `${label} escapes its evidence root`);
  return resolved;
}

function assertSha(value, label) {
  assert(typeof value === 'string' && SHA256_RE.test(value), `${label} is not a SHA-256 digest`);
}

function expectedChildStartIdlePolicy() {
  return {
    policyId: CHILD_START_IDLE_POLICY_ID,
    idleWindowMs: CHILD_START_IDLE_WINDOW_MS,
    timeoutMs: CHILD_START_IDLE_TIMEOUT_MS,
    pollIntervalMs: CHILD_START_IDLE_POLL_INTERVAL_MS,
    outsideChildRunnerMeasurement: true,
    followedByImmediateZeroProcessGuard: true,
  };
}

function validateChildStartIdlePolicy(value, label) {
  assert(canonicalJson(value) === canonicalJson(expectedChildStartIdlePolicy()),
    `${label} child-start idle policy is missing or invalid`);
  return value;
}

function validateChildStartStability(value, phase, label) {
  assert(value && typeof value === 'object' && !Array.isArray(value),
    `${label} child-start stability evidence is missing`);
  const expectedKeys = [
    'idleWindowMs', 'immediateObservedProcessCount', 'immediateZeroProcessGuardPassed',
    'lastObservedProcessCount', 'outsideChildRunnerMeasurement', 'phase', 'policyId',
    'observedBusyTransitions', 'pollIntervalMs', 'polls', 'restarts', 'timeoutMs', 'waitedMs',
  ].sort();
  assert(canonicalJson(Object.keys(value).sort()) === canonicalJson(expectedKeys),
    `${label} child-start stability fields are not exact`);
  assert(value.policyId === CHILD_START_IDLE_POLICY_ID, `${label} child-start policy ID is invalid`);
  assert(value.phase === phase, `${label} child-start phase does not match its event`);
  assert(value.idleWindowMs === CHILD_START_IDLE_WINDOW_MS
    && value.timeoutMs === CHILD_START_IDLE_TIMEOUT_MS
    && value.pollIntervalMs === CHILD_START_IDLE_POLL_INTERVAL_MS,
  `${label} child-start timing policy is invalid`);
  assert(Number.isSafeInteger(value.waitedMs)
    && value.waitedMs >= CHILD_START_IDLE_WINDOW_MS
    && value.waitedMs <= CHILD_START_IDLE_TIMEOUT_MS,
  `${label} child-start wait does not prove a complete bounded idle window`);
  // PowerShell/CIM process enumeration can itself take longer than the
  // configured poll interval. Do not infer elapsed time from sample count:
  // `waitedMs` proves the >=2s span, while two samples prove distinct zero
  // observations at the beginning/end of the accepted idle window.
  assert(Number.isSafeInteger(value.polls) && value.polls >= 2,
    `${label} child-start poll count does not contain both boundary samples`);
  assert(Number.isSafeInteger(value.restarts) && value.restarts >= 0,
    `${label} child-start restart count is invalid`);
  assert(Number.isSafeInteger(value.observedBusyTransitions)
    && value.observedBusyTransitions >= value.restarts,
  `${label} child-start busy-transition count is invalid`);
  assert(value.lastObservedProcessCount === 0 && value.immediateObservedProcessCount === 0,
    `${label} child-start process counts are not both zero`);
  assert(value.outsideChildRunnerMeasurement === true,
    `${label} child-start wait is not declared outside child measurement`);
  assert(value.immediateZeroProcessGuardPassed === true,
    `${label} child-start immediate zero-process guard did not pass`);
  return value;
}

function childAttemptKey(event) {
  return `${event.targetId}\0${event.phase}\0${event.attempt}`;
}

function validateChildStartEventOrder(events) {
  const attempts = new Map();
  for (const event of events) {
    if (event.kind === 'adopted') continue;
    const key = childAttemptKey(event);
    if (event.kind === 'started') {
      assert(!attempts.has(key), `duplicate started event for ${event.targetId} ${event.phase} attempt ${event.attempt}`);
      validateChildStartIdlePolicy(event.childStartIdlePolicy,
        `${event.targetId} ${event.phase} attempt ${event.attempt} started event`);
      attempts.set(key, { stableCount: 0, terminal: false });
      continue;
    }
    const attempt = attempts.get(key);
    assert(attempt, `${event.kind} event has no matching started event for ${event.targetId} ${event.phase} attempt ${event.attempt}`);
    assert(attempt.terminal === false,
      `${event.kind} event appears after terminal event for ${event.targetId} ${event.phase} attempt ${event.attempt}`);
    if (event.kind === 'child-start-stable') {
      assert(attempt.stableCount === 0,
        `duplicate child-start-stable event for ${event.targetId} ${event.phase} attempt ${event.attempt}`);
      validateChildStartStability(event.childStartStability, event.phase,
        `${event.targetId} ${event.phase} attempt ${event.attempt}`);
      attempt.stableCount += 1;
      continue;
    }
    assert(['passed', 'failed'].includes(event.kind),
      `unsupported terminal event for ${event.targetId}`);
    assert(attempt.stableCount === 1,
      `${event.targetId} ${event.phase} attempt ${event.attempt} must have exactly one child-start-stable event before terminal state`);
    attempt.terminal = true;
  }
  for (const [key, attempt] of attempts) {
    assert(attempt.stableCount === 1, `${key} does not have exactly one child-start-stable event`);
    assert(attempt.terminal === true, `${key} has no terminal event after child-start-stable`);
  }
  return attempts;
}

function expectedTargets() {
  assert(Array.isArray(matrix.AVR_TARGETS) && matrix.AVR_TARGETS.length === EXPECTED_TARGET_COUNT,
    `current AVR source target list is not exactly ${EXPECTED_TARGET_COUNT}`);
  const seen = new Set();
  return matrix.AVR_TARGETS.map((target, index) => {
    const fqbn = forge.canonicalCompleteFqbn(target.fqbn);
    assert(fqbn === target.fqbn, `AVR target ${target.id} is not a canonical complete FQBN`);
    assert(!seen.has(fqbn), `duplicate AVR FQBN in current source: ${fqbn}`);
    seen.add(fqbn);
    return {
      ordinal: index + 1,
      id: target.id,
      label: target.label,
      fqbn,
      qualificationTrials: FORMAL_TRIALS,
      qualificationCompileCalls: QUALIFICATION_COMPILES_PER_TARGET,
      coverageWorkload: 'core-only-block-style',
      coverageTrials: 1,
      coverageCompileCalls: COVERAGE_COMPILES_PER_TARGET,
    };
  });
}

function sourceBindings() {
  const files = {
    batch: 'Run-CKAvrFullQualificationBatch.cjs',
    matrixRunner: 'Run-CKAvrRegressionMatrix.cjs',
    nativeAbRunner: 'Run-CKForgeNativeAB.cjs',
    performanceGate: 'Evaluate-CKForgePerformanceGate.cjs',
  };
  return Object.fromEntries(Object.entries(files).map(([id, fileName]) => {
    const file = regularFile(path.join(__dirname, fileName), `source ${id}`);
    return [id, { fileName, sha256: sha256File(file) }];
  }));
}

function expectedExecutablePath(value) {
  return path.resolve(value || path.join(REPO_ROOT, 'target', 'release', 'appsdesktop.exe'));
}

function expectedQualificationRoot(value) {
  return path.resolve(value || path.join(REPO_ROOT, 'state', 'qualifications'));
}

function validateControls(controls, label, { qualification }) {
  assert(controls && typeof controls === 'object', `${label} controls are missing`);
  assert(controls.compileOnly === true, `${label} is not compile-only`);
  assert(controls.uploadPerformed === false, `${label} declares an upload`);
  assert(controls.physicalFlashWritten === false, `${label} declares a physical flash write`);
  assert(controls.serialPortAccessed === false, `${label} declares serial-port access`);
  if (qualification) {
    assert(controls.ckQualificationMode === true && controls.qualificationTokenBound === true,
      `${label} is not qualification-token bound`);
    assert(controls.exactAllowed === false && controls.exactCountedAsFresh === false,
      `${label} permits Exact or counts it as fresh`);
    assert(controls.sameCoreAndCompleteFqbn === true && controls.sameSourceBytes === true,
      `${label} does not bind the complete FQBN/source bytes`);
  }
}

function validateManifest(stateRoot, manifest, executable, qualificationRoot) {
  assert(manifest?.schemaId === MANIFEST_SCHEMA_ID && manifest.schemaVersion === BATCH_SCHEMA_VERSION,
    'unsupported AVR qualification manifest');
  const controls = manifest.controls;
  assert(controls?.compileOnly === true && controls.uploadPerformed === false,
    'manifest does not declare compile-only/no-upload operation');
  assert(controls.sequential === true && controls.exactFqbnCertificateBindingPreserved === true,
    'manifest does not preserve sequential exact-FQBN binding');
  assert(controls.evidenceNoClobber === true && controls.appendOnlyEvents === true,
    'manifest does not declare no-clobber append-only evidence');
  validateChildStartIdlePolicy(controls.childStartIdlePolicy, 'manifest');
  assert(manifest.execution && typeof manifest.execution === 'object', 'manifest execution section is missing');
  assert(samePath(manifest.execution.qualificationRoot, qualificationRoot),
    'manifest qualification root differs from verifier qualification root');
  assertSha(manifest.execution.productionExecutableSha256, 'manifest production executable SHA');
  assert(manifest.execution.productionExecutableSha256 === sha256File(executable),
    'manifest production executable SHA does not match the supplied production EXE');
  const expectedSources = sourceBindings();
  assert(canonicalJson(manifest.sources) === canonicalJson(expectedSources),
    'manifest source bindings do not match current runner/gate source files');
  const targets = expectedTargets();
  assert(Array.isArray(manifest.targets) && manifest.targets.length === EXPECTED_TARGET_COUNT,
    `manifest must contain exactly ${EXPECTED_TARGET_COUNT} target rows`);
  assert(canonicalJson(manifest.targets) === canonicalJson(targets),
    'manifest target rows/FQBN set differ from the current exact AVR matrix');
  assert(manifest.targetSetSha256 === sha256Bytes(canonicalJson(targets)),
    'manifest target-set SHA does not reproduce from its exact rows');
  assert(manifest.totalCompileCalls === EXPECTED_TARGET_COUNT * TOTAL_COMPILES_PER_TARGET,
    'manifest total compile count is not the exact 38-target contract');
  assert(pathWithin(stateRoot, stateRoot), 'state root sanity check failed');
  return { targets, targetById: new Map(targets.map((target) => [target.id, target])) };
}

function readEventJournal(stateRoot, targetById) {
  const directory = realDirectory(path.join(stateRoot, 'events'), 'event journal');
  const names = fs.readdirSync(directory);
  assert(names.length > 0, 'event journal is empty');
  const eventNames = names.filter((name) => EVENT_FILE_RE.test(name)).sort();
  assert(eventNames.length === names.length, 'event journal contains an unexpected entry');
  const events = eventNames.map((name, index) => {
    const match = EVENT_FILE_RE.exec(name);
    assert(Number(match[1]) === index + 1, `event journal sequence is not contiguous at ${name}`);
    const parsed = readJson(path.join(directory, name), name, 256 * 1024).value;
    assert(parsed?.schemaId === EVENT_SCHEMA_ID && parsed.schemaVersion === BATCH_SCHEMA_VERSION,
      `event ${name} has an unsupported schema`);
    assert(parsed.sequence === index + 1, `event ${name} sequence field is not contiguous`);
    assert(targetById.has(parsed.targetId), `event ${name} names an unknown target`);
    assert(parsed.fqbn === targetById.get(parsed.targetId).fqbn, `event ${name} FQBN does not match its exact target row`);
    assert(['qualification', 'coverage'].includes(parsed.phase), `event ${name} has an invalid phase`);
    assert(['started', 'child-start-stable', 'passed', 'adopted', 'failed'].includes(parsed.kind),
      `event ${name} has an invalid kind`);
    // Adoption reuses an already certified exact-FQBN result and therefore has
    // no local compile attempt. Every started/terminal compile event still
    // carries a positive monotonic attempt number.
    if (parsed.kind !== 'adopted') {
      assert(Number.isSafeInteger(parsed.attempt) && parsed.attempt >= 1, `event ${name} has an invalid attempt`);
    } else {
      assert(parsed.phase === 'qualification', `event ${name} may only adopt qualification evidence`);
    }
    return parsed;
  });
  return events;
}

function assertEvidencePath(value, stateRoot, target, phase, attempt, required, requireFile = true) {
  if (!value) {
    assert(!required, `${target.id} ${phase} pass event has no evidence path`);
    return null;
  }
  const resolved = assertPathWithin(value, stateRoot, `${target.id} ${phase} evidence`);
  const expected = path.resolve(stateRoot, 'evidence', target.id, `${phase}-attempt-${String(attempt).padStart(3, '0')}.json`);
  assert(samePath(resolved, expected), `${target.id} ${phase} evidence path is not its no-clobber attempt path`);
  if (requireFile) regularFile(resolved, `${target.id} ${phase} evidence`);
  return resolved;
}

function assertRunNoWrites(run, label) {
  assert(run && typeof run === 'object', `${label} run is missing`);
  assert(run.success === true && run.compileOnly === true && run.uploadPerformed === false,
    `${label} run is not a successful compile-only/no-upload run`);
  assert(run.exactUsed === false, `${label} run used Exact`);
  assertSha(run.codeSha256, `${label} code`);
  assertSha(run.artifactSetSha256, `${label} artifact set`);
  assert(Array.isArray(run.artifacts), `${label} artifacts are missing`);
  const seen = new Set();
  for (const [index, artifact] of run.artifacts.entries()) {
    assert(artifact && typeof artifact === 'object', `${label} artifact ${index} is malformed`);
    assert(typeof artifact.name === 'string' && artifact.name.length > 0, `${label} artifact ${index} has no name`);
    assert(Number.isSafeInteger(artifact.bytes) && artifact.bytes >= 0, `${label} artifact ${index} has invalid bytes`);
    assertSha(artifact.sha256, `${label} artifact ${index}`);
    assert(typeof artifact.role === 'string' && artifact.role.length > 0, `${label} artifact ${index} has no role`);
    assert(!seen.has(`${artifact.role}\0${artifact.name}`), `${label} has duplicate artifacts`);
    seen.add(`${artifact.role}\0${artifact.name}`);
  }
  const projection = run.integritySchemaVersion === 2
    ? (() => {
      const copy = { ...run };
      delete copy.evidenceSha256;
      delete copy.wallMs;
      const rawTiming = copy.rawTiming;
      copy.rawTiming = rawTiming && typeof rawTiming === 'object'
        ? { runnerWallNs: rawTiming.runnerWallNs }
        : null;
      return copy;
    })()
    : (() => {
      const copy = { ...run, wallMs: undefined };
      delete copy.evidenceSha256;
      return copy;
    })();
  assert(run.evidenceSha256 === forge.digestObject(projection), `${label} evidence digest is invalid`);
  const artifactProjection = run.artifacts.map(({ name, bytes, sha256, primaryApplication, role }) => ({
    name, bytes, sha256, primaryApplication, role,
  }));
  assert(run.artifactSetSha256 === forge.digestObject(artifactProjection), `${label} artifact-set digest is invalid`);
}

function validateQualificationEvidence(file, target, manifest, executable, nativeRunnerSha) {
  const parsed = readJson(file, `${target.id} qualification evidence`, 64 * 1024 * 1024);
  const evidence = parsed.value;
  assert(evidence.schemaId === 'ck.forge.native-ab-run' && evidence.schemaVersion === 2,
    `${target.id} qualification evidence schema mismatch`);
  assert(evidence.status === 'passed' && evidence.measurementStatus === 'passed'
    && evidence.qualificationStatus === 'qualified', `${target.id} qualification evidence is not qualified`);
  validateControls(evidence.controls, `${target.id} qualification evidence`, { qualification: true });
  assert(evidence.identity?.fqbn === target.fqbn, `${target.id} qualification identity FQBN mismatch`);
  assert(evidence.identity.productionExecutableSha256 === manifest.execution.productionExecutableSha256,
    `${target.id} qualification identity EXE mismatch`);
  assert(evidence.identity.runnerSha256 === nativeRunnerSha, `${target.id} qualification runner SHA mismatch`);
  assert(evidence.runner?.before?.sha256 === nativeRunnerSha
    && evidence.runner?.after?.sha256 === nativeRunnerSha
    && evidence.runner.unchanged === true, `${target.id} qualification runner binding is not stable`);
  assert(evidence.productionExecutable?.before?.executableSha256 === sha256File(executable)
    && evidence.productionExecutable?.after?.executableSha256 === sha256File(executable)
    && evidence.productionExecutable.unchanged === true,
  `${target.id} qualification production EXE binding is not stable`);
  assert(Array.isArray(evidence.trials) && evidence.trials.length === FORMAL_TRIALS,
    `${target.id} qualification does not contain exactly five trials`);
  for (const [trialIndex, trial] of evidence.trials.entries()) {
    for (const stage of STAGES) {
      assertRunNoWrites(trial.ck?.[stage], `${target.id} qualification trial ${trialIndex + 1} CK ${stage}`);
      assertRunNoWrites(trial.native?.[stage], `${target.id} qualification trial ${trialIndex + 1} native ${stage}`);
    }
  }
  const report = gate.validateAndEvaluateNativeRelink(evidence, sha256Bytes(parsed.bytes));
  assert(report.qualified === true && report.target?.fqbn === target.fqbn,
    `${target.id} qualification report cannot be reproduced`);
  return { evidence, bytes: parsed.bytes, evidenceSha256: sha256Bytes(parsed.bytes), report };
}

function validateCertificate(certificateDirectory, target, manifest, executable, nativeRunnerSha) {
  const qualificationRoot = realDirectory(manifest.execution.qualificationRoot, 'qualification root');
  const directory = realDirectory(certificateDirectory, `${target.id} certificate directory`);
  assert(pathWithin(directory, qualificationRoot), `${target.id} certificate escapes qualification root`);
  assert(/^[0-9a-f]{64}$/u.test(path.basename(directory)), `${target.id} certificate key is not a SHA-256 key`);
  const evidenceParsed = readJson(path.join(directory, 'evidence.json'), `${target.id} certificate evidence`, 64 * 1024 * 1024);
  const reportParsed = readJson(path.join(directory, 'report.json'), `${target.id} certificate report`, 512 * 1024);
  const certificate = readJson(path.join(directory, 'certificate.json'), `${target.id} certificate envelope`, 256 * 1024).value;
  const evidenceSha256 = sha256Bytes(evidenceParsed.bytes);
  const reportSha256 = sha256Bytes(reportParsed.bytes);
  assert(nativeRelinkCertificateHasExactShape(certificate),
  `${target.id} certificate envelope schema/profile mismatch`);
  assert(certificate.evidenceSha256 === evidenceSha256 && certificate.reportSha256 === reportSha256,
    `${target.id} certificate content digest mismatch`);
  const validatedEvidence = validateQualificationEvidence(path.join(directory, 'evidence.json'), target, manifest, executable, nativeRunnerSha);
  assert(validatedEvidence.evidenceSha256 === evidenceSha256, `${target.id} certificate evidence digest changed during validation`);
  const evaluated = gate.validateAndEvaluateNativeRelink(
    evidenceParsed.value,
    evidenceSha256,
    reportParsed.value.evaluatedAt,
  );
  assert(canonicalJson(evaluated) === canonicalJson(reportParsed.value), `${target.id} certificate report is not reproducible`);
  assert(evaluated.qualified === true && evaluated.qualificationKey === path.basename(directory),
    `${target.id} certificate qualification key is invalid`);
  assert(evaluated.target?.fqbn === target.fqbn
    && evaluated.target.productionExecutableSha256 === manifest.execution.productionExecutableSha256,
  `${target.id} certificate exact target/EXE binding is invalid`);
  return { directory, certificate, evidence: evidenceParsed.value, evidenceSha256, report: reportParsed.value };
}

function validateCoverageRun(run, label, expectedFqbn, expectedCodeSha, nativeLane = false) {
  assertRunNoWrites(run, label);
  assert(run.fqbn === expectedFqbn && run.codeSha256 === expectedCodeSha, `${label} FQBN/source binding mismatch`);
  assert(Number.isSafeInteger(run.jobs) && run.jobs > 0, `${label} jobs binding is missing`);
  // The native CLI lane records its physical build-path identity. CK's
  // production JSON intentionally omits that host-local path, so only require
  // it where the lane contract promises it.
  if (nativeLane) {
    assert(typeof run.buildPathIdentitySha256 === 'string' && run.buildPathIdentitySha256.length > 0,
      `${label} build-path identity is missing`);
  }
}

function validateCoverageEvidence(file, target, manifest, executable) {
  const parsed = readJson(file, `${target.id} coverage evidence`, 64 * 1024 * 1024);
  const report = parsed.value;
  assert(report.schemaId === 'ck.avr.compile-regression-report' && report.schemaVersion === 1,
    `${target.id} coverage schema mismatch`);
  assert(report.status === 'passed' && report.measurementStatus === 'passed'
    && ['target-met', 'target-not-met'].includes(report.performanceTargetStatus),
  `${target.id} coverage measurement is not passed`);
  validateControls(report.controls, `${target.id} coverage evidence`, { qualification: false });
  assert(report.qualificationClaimed === false, `${target.id} coverage incorrectly claims qualification`);
  assert(report.trialsPerCell === 1 && report.plannedCellCount === 1
    && report.applicableCellCount === 1 && report.expectedSkipCellCount === 0
    && report.plannedCompileCount === COVERAGE_COMPILES_PER_TARGET,
  `${target.id} coverage plan counts are not exact`);
  assert(Array.isArray(report.failures) && report.failures.length === 0, `${target.id} coverage has failures`);
  assert(report.targets?.length === 1 && report.targets[0]?.id === target.id
    && report.targets[0]?.fqbn === target.fqbn, `${target.id} coverage target row mismatch`);
  assert(report.productionExecutable?.before?.executableSha256 === sha256File(executable)
    && report.productionExecutable?.after?.executableSha256 === sha256File(executable)
    && report.productionExecutable.unchanged === true,
  `${target.id} coverage production EXE binding is not stable`);
  assertSha(report.planSha256, `${target.id} coverage plan`);
  const planOptions = matrix.parseArgs([
    '--plan', '--target', target.id, '--workload', 'core-only-block-style', '--trials', '1',
  ]);
  const expectedPlan = matrix.planFor(planOptions);
  assert(report.planSha256 === forge.digestObject(expectedPlan), `${target.id} coverage plan SHA is not reproducible`);
  assert(Array.isArray(report.cells) && report.cells.length === 1, `${target.id} coverage must contain one cell`);
  const cell = report.cells[0];
  assert(cell.targetId === target.id && cell.fqbn === target.fqbn && cell.workloadId === 'core-only-block-style',
    `${target.id} coverage cell target/workload mismatch`);
  const expectedCell = expectedPlan.cells[0];
  const workload = matrix.AVR_WORKLOADS.find((candidate) => candidate.id === 'core-only-block-style');
  assert(workload, 'core-only-block-style workload is missing from the current matrix source');
  const expectedSourceSequence = expectedCell.stages.map((stage) => {
    const source = workload.stages.find((candidate) => candidate.id === stage.id);
    assert(source, `matrix source stage is missing: ${stage.id}`);
    return { id: stage.id, sha256: stage.sourceSha256, bytes: Buffer.byteLength(source.code) };
  });
  assert(canonicalJson(cell.sourceSequence) === canonicalJson(expectedSourceSequence),
    `${target.id} coverage source sequence differs from immutable plan`);
  assert(cell.applicability?.applicable === true, `${target.id} coverage cell is not applicable`);
  assert(Array.isArray(cell.trials) && cell.trials.length === 1, `${target.id} coverage must contain one trial`);
  const trial = cell.trials[0];
  for (const stage of STAGES) {
    const expectedCodeSha = expectedCell.stages.find((candidate) => candidate.id === stage).sourceSha256;
    validateCoverageRun(trial.ck?.[stage], `${target.id} coverage CK ${stage}`, target.fqbn, expectedCodeSha);
    validateCoverageRun(trial.native?.[stage], `${target.id} coverage native ${stage}`, target.fqbn, expectedCodeSha, true);
    const computedArtifacts = forge.compareAvrArtifactRoles(trial.ck[stage].artifacts, trial.native[stage].artifacts);
    const computedEquivalence = {
      source: trial.ck[stage].codeSha256 === trial.native[stage].codeSha256
        && trial.ck[stage].codeSha256 === expectedCodeSha,
      resources: forge.resourcesEquivalent(trial.ck[stage].resources, trial.native[stage].resources),
      artifacts: computedArtifacts,
    };
    assert(canonicalJson(trial.equivalence?.[stage]) === canonicalJson(computedEquivalence),
      `${target.id} coverage ${stage} artifact/resource equivalence was tampered`);
  }
  const computedRestoration = matrix.evaluateSimpleReturnRestoration(trial);
  assert(canonicalJson(trial.simpleReturnRestoration) === canonicalJson(computedRestoration),
    `${target.id} coverage simple-return restoration was tampered`);
  const computedResult = matrix.evaluateCell(cell);
  assert(canonicalJson(cell.result) === canonicalJson(computedResult), `${target.id} coverage result was tampered`);
  assert(cell.result.measurementPassed === true
    && cell.result.artifactAndResourceEquivalent === true
    && cell.result.nativeRelinkRoutePassed === true
    && cell.result.noExactCompilerBypass === true,
  `${target.id} coverage route/equivalence gate did not pass`);
  return report;
}

function assertEventStateAndEvidence(stateRoot, qualificationRoot, events, targetById, manifest, executable) {
  validateChildStartEventOrder(events);
  const state = new Map([...targetById.keys()].map((id) => [id, {
    qualification: 'pending', coverage: 'pending', qualificationAttempts: 0, coverageAttempts: 0,
  }]));
  const finalArtifacts = new Map();
  const nativeRunnerSha = manifest.sources.nativeAbRunner.sha256;
  for (const event of events) {
    const current = state.get(event.targetId);
    const target = targetById.get(event.targetId);
    const phaseState = event.phase === 'qualification' ? current.qualification : current.coverage;
    const attemptsKey = event.phase === 'qualification' ? 'qualificationAttempts' : 'coverageAttempts';
    if (event.kind === 'started') {
      assert(phaseState === 'pending' || phaseState === 'failed', `event starts ${event.targetId} ${event.phase} from ${phaseState}`);
      assert(event.attempt === current[attemptsKey] + 1, `event attempt is not monotonic for ${event.targetId} ${event.phase}`);
      // A started attempt may fail before its child creates the no-clobber JSON.
      // Preserve and validate the intended path, but require a file only when a
      // terminal event actually claims evidence.
      assertEvidencePath(event.outputPath, stateRoot, target, event.phase, event.attempt, true, false);
      current[attemptsKey] = event.attempt;
      current[event.phase === 'qualification' ? 'qualification' : 'coverage'] = 'running';
      continue;
    }
    if (event.kind === 'child-start-stable') {
      assert(phaseState === 'running',
        `child-start-stable event observes ${event.targetId} ${event.phase} from ${phaseState}`);
      assert(event.attempt === current[attemptsKey],
        `child-start-stable event attempt mismatch for ${event.targetId} ${event.phase}`);
      continue;
    }
    if (event.kind === 'failed') {
      assert(phaseState === 'running', `event fails ${event.targetId} ${event.phase} from ${phaseState}`);
      assert(event.attempt === current[attemptsKey], `failed event attempt mismatch for ${event.targetId} ${event.phase}`);
      if (event.evidencePath) assertEvidencePath(event.evidencePath, stateRoot, target, event.phase, event.attempt, false);
      current[event.phase === 'qualification' ? 'qualification' : 'coverage'] = 'failed';
      continue;
    }
    if (event.phase === 'qualification' && event.kind === 'adopted') {
      assert(phaseState === 'pending' || phaseState === 'failed', `certificate adoption starts ${event.targetId} from ${phaseState}`);
      assert(typeof event.certificatePath === 'string', `${event.targetId} adopted event has no certificate`);
      current.qualification = 'passed';
      const certificate = validateCertificate(event.certificatePath, target, manifest, executable, nativeRunnerSha);
      assert(event.qualificationKey === path.basename(certificate.directory),
        `${event.targetId} adopted qualification key does not match certificate`);
      current.certificatePath = certificate.directory;
      finalArtifacts.set(`${event.targetId}:qualification`, certificate);
      continue;
    }
    assert(event.kind === 'passed', `unsupported terminal event for ${event.targetId}`);
    assert(phaseState === 'running', `event passes ${event.targetId} ${event.phase} from ${phaseState}`);
    assert(event.attempt === current[attemptsKey], `passed event attempt mismatch for ${event.targetId} ${event.phase}`);
    const evidencePath = assertEvidencePath(event.evidencePath, stateRoot, target, event.phase, event.attempt, true);
    if (event.phase === 'qualification') {
      assert(typeof event.certificatePath === 'string' && typeof event.qualificationKey === 'string',
        `${event.targetId} qualification pass event has no exact certificate binding`);
      const certificate = validateCertificate(event.certificatePath, target, manifest, executable, nativeRunnerSha);
      assert(event.qualificationKey === path.basename(certificate.directory), `${event.targetId} qualification key does not match certificate`);
      const evidenceHash = sha256File(evidencePath);
      assert(evidenceHash === certificate.evidenceSha256, `${event.targetId} pass evidence differs from certified evidence`);
      current.qualification = 'passed';
      current.certificatePath = certificate.directory;
      finalArtifacts.set(`${event.targetId}:qualification`, certificate);
    } else {
      validateCoverageEvidence(evidencePath, target, manifest, executable);
      current.coverage = 'passed';
      finalArtifacts.set(`${event.targetId}:coverage`, evidencePath);
    }
  }
  for (const [id, target] of targetById.entries()) {
    const current = state.get(id);
    assert(current.qualification === 'passed' && current.coverage === 'passed', `${id} does not have passed qualification and coverage`);
    assert(finalArtifacts.has(`${id}:qualification`) && finalArtifacts.has(`${id}:coverage`), `${id} has incomplete final evidence binding`);
  }
  return state;
}

function validateSummaries(stateRoot, manifest, state) {
  const directory = realDirectory(path.join(stateRoot, 'summaries'), 'summary directory');
  const names = fs.readdirSync(directory);
  assert(names.length > 0, 'summary directory is empty');
  const summaryNames = names.filter((name) => SUMMARY_FILE_RE.test(name)).sort();
  assert(summaryNames.length === names.length, 'summary directory contains an unexpected entry');
  summaryNames.forEach((name, index) => assert(Number(SUMMARY_FILE_RE.exec(name)[1]) === index + 1,
    `summary sequence is not contiguous at ${name}`));
  const latest = readJson(path.join(directory, summaryNames.at(-1)), 'latest qualification summary', 4 * 1024 * 1024).value;
  assert(latest.schemaId === SUMMARY_SCHEMA_ID && latest.schemaVersion === BATCH_SCHEMA_VERSION,
    'latest qualification summary schema mismatch');
  assert(latest.targetCount === EXPECTED_TARGET_COUNT
    && latest.qualifiedCount === EXPECTED_TARGET_COUNT
    && latest.coveragePassedCount === EXPECTED_TARGET_COUNT
    && latest.completeCount === EXPECTED_TARGET_COUNT
    && latest.failedCount === 0,
  'latest qualification summary does not hard-pass all 38 counts');
  assert(Array.isArray(latest.targets) && latest.targets.length === EXPECTED_TARGET_COUNT,
    'latest qualification summary does not contain exactly 38 rows');
  const seen = new Set();
  for (const row of latest.targets) {
    assert(manifest.targets.some((target) => canonicalJson(target) === canonicalJson({
      ordinal: row.ordinal, id: row.id, label: row.label, fqbn: row.fqbn,
      qualificationTrials: row.qualificationTrials, qualificationCompileCalls: row.qualificationCompileCalls,
      coverageWorkload: row.coverageWorkload, coverageTrials: row.coverageTrials, coverageCompileCalls: row.coverageCompileCalls,
    })), `summary row ${row.id} is not an exact manifest row`);
    assert(!seen.has(row.id), `summary contains a duplicate target row: ${row.id}`);
    seen.add(row.id);
    const expected = state.get(row.id);
    assert(expected && row.qualification === expected.qualification && row.coverage === expected.coverage,
      `summary state mismatch for ${row.id}`);
    assert(row.qualificationAttempts === expected.qualificationAttempts
      && row.coverageAttempts === expected.coverageAttempts,
    `summary attempt count mismatch for ${row.id}`);
    assert(row.qualification === 'passed' && row.coverage === 'passed', `summary row ${row.id} is incomplete`);
  }
  assert(seen.size === EXPECTED_TARGET_COUNT, 'summary rows do not cover all exact FQBN targets');
  return latest;
}

function verifyBatch(options) {
  const stateRoot = realDirectory(options.stateRoot, 'state root');
  const executable = regularFile(expectedExecutablePath(options.expectedExecutable), 'production executable', 256 * 1024 * 1024);
  const qualificationRoot = realDirectory(expectedQualificationRoot(options.qualificationRoot), 'qualification root');
  const manifestParsed = readJson(path.join(stateRoot, 'manifest.json'), 'qualification manifest', 4 * 1024 * 1024);
  const manifest = manifestParsed.value;
  const { targets, targetById } = validateManifest(stateRoot, manifest, executable, qualificationRoot);
  const events = readEventJournal(stateRoot, targetById);
  const state = assertEventStateAndEvidence(stateRoot, qualificationRoot, events, targetById, manifest, executable);
  const summary = validateSummaries(stateRoot, manifest, state);
  return {
    status: 'passed', targetCount: targets.length, eventCount: events.length,
    qualifiedCount: summary.qualifiedCount, coveragePassedCount: summary.coveragePassedCount,
    completeCount: summary.completeCount, failedCount: summary.failedCount,
    manifest: manifestParsed.file,
  };
}

function parseArgs(argv) {
  const options = { stateRoot: null, expectedExecutable: null, qualificationRoot: null, help: false };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--state-root') options.stateRoot = argv[++index];
    else if (argument === '--expected-executable') options.expectedExecutable = argv[++index];
    else if (argument === '--qualification-root') options.qualificationRoot = argv[++index];
    else if (argument === '--help' || argument === '-h') options.help = true;
    else fail(`unknown argument '${argument}'`);
  }
  if (options.help) return options;
  assert(options.stateRoot, '--state-root <directory> is required');
  return options;
}

function usage() {
  return `Read-only verification of a complete CK AVR qualification batch\n\nUsage:\n  node scripts/Verify-CKAvrFullQualificationBatch.cjs --state-root <directory> [options]\n\nOptions:\n  --expected-executable <file>  Production appsdesktop.exe (default target/release/appsdesktop.exe)\n  --qualification-root <dir>   Certificate root (default state/qualifications)\n\nThe verifier never creates, deletes or modifies a file. It hard-requires 38\nexact FQBN rows, a contiguous event journal, complete certificate/runner/EXE\nbindings, and passed compile-only coverage evidence.\n`;
}

if (require.main === module) {
  try {
    const options = parseArgs(process.argv.slice(2));
    if (options.help) process.stdout.write(usage());
    else process.stdout.write(`${JSON.stringify(verifyBatch(options), null, 2)}\n`);
  } catch (error) {
    process.stderr.write(`CK AVR qualification verification: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  COVERAGE_COMPILES_PER_TARGET,
  EXPECTED_TARGET_COUNT,
  FORMAL_TRIALS,
  CHILD_START_IDLE_POLICY_ID,
  canonicalJson,
  expectedTargets,
  expectedChildStartIdlePolicy,
  nativeRelinkCertificateHasExactShape,
  parseArgs,
  readEventJournal,
  validateCertificate,
  validateChildStartEventOrder,
  validateChildStartIdlePolicy,
  validateChildStartStability,
  validateCoverageEvidence,
  validateManifest,
  validateQualificationEvidence,
  validateSummaries,
  verifyBatch,
};
