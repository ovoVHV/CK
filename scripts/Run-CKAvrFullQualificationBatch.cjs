#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const { spawnSync } = require('node:child_process');

const {
  AVR_TARGETS,
} = require('./Run-CKAvrRegressionMatrix.cjs');
const {
  assertFreeSpace,
  assertNoConcurrentArduinoCli,
  arduinoCliProcessCount,
  canonicalCompleteFqbn,
  hostEnvironmentFingerprint,
  inspectCliAndCore,
  inspectProductionExecutable,
} = require('./Run-CKForgeNativeAB.cjs');
const {
  validateAndEvaluateNativeRelink,
} = require('./Evaluate-CKForgePerformanceGate.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const MATRIX_RUNNER = path.join(__dirname, 'Run-CKAvrRegressionMatrix.cjs');
const NATIVE_AB_RUNNER = path.join(__dirname, 'Run-CKForgeNativeAB.cjs');
const PERFORMANCE_GATE = path.join(__dirname, 'Evaluate-CKForgePerformanceGate.cjs');
const DEFAULT_QUALIFICATION_ROOT = path.join(REPO_ROOT, 'state', 'qualifications');
const DEFAULT_MIN_FREE_GIB = 12;
const DEFAULT_TIMEOUT_MINUTES = 10;
const FORMAL_TRIALS = 5;
const QUALIFICATION_COMPILES_PER_TARGET = FORMAL_TRIALS * 4 * 2;
const COVERAGE_COMPILES_PER_TARGET = 1 * 4 * 2;
const TOTAL_COMPILES_PER_TARGET = QUALIFICATION_COMPILES_PER_TARGET
  + COVERAGE_COMPILES_PER_TARGET;
const QUALIFICATION_TOKEN_ENV = 'CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN';
const MANIFEST_SCHEMA_ID = 'ck.avr.full-qualification-batch-manifest';
const EVENT_SCHEMA_ID = 'ck.avr.full-qualification-batch-event';
const BATCH_SCHEMA_VERSION = 1;
const BATCH_CHILD_IDLE_POLICY_ID = 'arduino-cli-batch-child-idle-window-v1';
const BATCH_CHILD_IDLE_WINDOW_MS = 2_000;
const BATCH_CHILD_IDLE_TIMEOUT_MS = 60_000;
const BATCH_CHILD_IDLE_POLL_INTERVAL_MS = 200;
const SHA256_RE = /^[0-9a-f]{64}$/u;
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

function batchChildIdlePolicy() {
  return {
    policyId: BATCH_CHILD_IDLE_POLICY_ID,
    idleWindowMs: BATCH_CHILD_IDLE_WINDOW_MS,
    timeoutMs: BATCH_CHILD_IDLE_TIMEOUT_MS,
    pollIntervalMs: BATCH_CHILD_IDLE_POLL_INTERVAL_MS,
    outsideChildRunnerMeasurement: true,
    followedByImmediateZeroProcessGuard: true,
  };
}

function sleepSynchronously(durationMs) {
  const signal = new Int32Array(new SharedArrayBuffer(4));
  Atomics.wait(signal, 0, 0, durationMs);
}

function waitForBatchChildArduinoCliIdleWindow({
  phase = 'child',
  idleWindowMs = BATCH_CHILD_IDLE_WINDOW_MS,
  timeoutMs = BATCH_CHILD_IDLE_TIMEOUT_MS,
  pollIntervalMs = BATCH_CHILD_IDLE_POLL_INTERVAL_MS,
  readProcessCount = () => arduinoCliProcessCount(),
  sleep = sleepSynchronously,
  now = () => Date.now(),
} = {}) {
  for (const [label, value] of [
    ['idleWindowMs', idleWindowMs],
    ['timeoutMs', timeoutMs],
    ['pollIntervalMs', pollIntervalMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
  if (idleWindowMs > timeoutMs) throw new Error('idleWindowMs must not exceed timeoutMs');
  const startedAt = now();
  let idleSince = null;
  let lastCount = null;
  let polls = 0;
  for (;;) {
    lastCount = readProcessCount();
    if (!Number.isSafeInteger(lastCount) || lastCount < 0) {
      throw new Error(`Arduino CLI process reader returned an invalid count: ${lastCount}`);
    }
    polls += 1;
    const sampledAt = now();
    if (lastCount === 0) {
      if (idleSince === null) idleSince = sampledAt;
      if (sampledAt - idleSince >= idleWindowMs) {
        return {
          policyId: BATCH_CHILD_IDLE_POLICY_ID,
          phase,
          idleWindowMs,
          timeoutMs,
          pollIntervalMs,
          waitedMs: sampledAt - startedAt,
          polls,
          lastObservedProcessCount: lastCount,
          outsideChildRunnerMeasurement: true,
        };
      }
    } else {
      idleSince = null;
    }
    const elapsed = sampledAt - startedAt;
    if (elapsed >= timeoutMs) {
      throw new Error(
        `Arduino CLI ${phase} child-start gate did not reach a ${idleWindowMs}ms idle window `
        + `within ${timeoutMs}ms (last observed process count: ${lastCount})`,
      );
    }
    sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
  }
}

function prepareBatchChildLaunch({
  phase,
  readProcessCount = () => arduinoCliProcessCount(),
  sleep = sleepSynchronously,
  now = () => Date.now(),
  idleWindowMs = BATCH_CHILD_IDLE_WINDOW_MS,
  timeoutMs = BATCH_CHILD_IDLE_TIMEOUT_MS,
  pollIntervalMs = BATCH_CHILD_IDLE_POLL_INTERVAL_MS,
} = {}) {
  if (!['qualification', 'coverage'].includes(phase)) {
    throw new Error('batch child phase must be qualification or coverage');
  }
  const startedAt = now();
  let previousCount = null;
  let restarts = 0;
  let observedBusyTransitions = 0;
  let polls = 0;
  const trackedReadProcessCount = () => {
    const count = readProcessCount();
    if (!Number.isSafeInteger(count) || count < 0) {
      throw new Error(`Arduino CLI process reader returned an invalid count: ${count}`);
    }
    if (count > 0 && (previousCount === null || previousCount === 0)) {
      observedBusyTransitions += 1;
      if (previousCount === 0) restarts += 1;
    }
    previousCount = count;
    return count;
  };
  const timeoutError = (lastCount = previousCount) => new Error(
    `Arduino CLI ${phase} child-start gate did not obtain a complete ${idleWindowMs}ms idle window `
    + `plus an immediate zero-process guard within the total ${timeoutMs}ms budget `
    + `(last observed process count: ${lastCount ?? 'unknown'})`,
  );

  for (;;) {
    const elapsed = now() - startedAt;
    const remainingMs = timeoutMs - elapsed;
    if (remainingMs < idleWindowMs) throw timeoutError();
    let stability;
    try {
      stability = waitForBatchChildArduinoCliIdleWindow({
        phase,
        idleWindowMs,
        timeoutMs: remainingMs,
        pollIntervalMs,
        readProcessCount: trackedReadProcessCount,
        sleep,
        now,
      });
    } catch (error) {
      if (now() - startedAt >= timeoutMs) throw timeoutError();
      throw error;
    }
    polls += stability.polls;

    // A complete idle window is still not permission to launch: immediately
    // assert zero again. If a late CLI appears at this exact boundary, the
    // candidate window is discarded and rebuilt inside the original deadline.
    const immediateObservedProcessCount = trackedReadProcessCount();
    try {
      assertNoConcurrentArduinoCli(() => immediateObservedProcessCount);
    } catch (error) {
      if (now() - startedAt >= timeoutMs) throw timeoutError(immediateObservedProcessCount);
      continue;
    }
    return {
      policyId: BATCH_CHILD_IDLE_POLICY_ID,
      phase,
      idleWindowMs,
      timeoutMs,
      pollIntervalMs,
      waitedMs: now() - startedAt,
      polls,
      restarts,
      observedBusyTransitions,
      lastObservedProcessCount: stability.lastObservedProcessCount,
      outsideChildRunnerMeasurement: true,
      immediateObservedProcessCount,
      immediateZeroProcessGuardPassed: true,
    };
  }
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function canonicalJson(value) {
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  if (value && typeof value === 'object') {
    return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
  }
  return JSON.stringify(value);
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function parseArgs(argv, environment = process.env) {
  const options = {
    action: null,
    stateRoot: null,
    qualificationRoot: DEFAULT_QUALIFICATION_ROOT,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    maxTargets: 1,
    allRemaining: false,
    allowCacheReset: false,
    retryFailed: false,
    continueOnFailure: false,
    help: false,
  };
  const setAction = (value) => {
    if (options.action && options.action !== value) throw new Error('choose exactly one of --plan or --execute');
    options.action = value;
  };
  let maxTargetsExplicit = false;
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--execute') setAction('execute');
    else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--retry-failed') options.retryFailed = true;
    else if (argument === '--continue-on-failure') options.continueOnFailure = true;
    else if (argument === '--all-remaining') options.allRemaining = true;
    else if (argument === '--state-root') {
      const value = argv[++index];
      if (!value) throw new Error('--state-root requires a directory');
      options.stateRoot = path.resolve(process.cwd(), value);
    }
    else if (argument === '--qualification-root') {
      const value = argv[++index];
      if (!value) throw new Error('--qualification-root requires a directory');
      options.qualificationRoot = path.resolve(process.cwd(), value);
    } else if (argument === '--min-free-gib') {
      options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 8, 100);
    } else if (argument === '--timeout-minutes') {
      options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    } else if (argument === '--max-targets') {
      options.maxTargets = parseInteger(argv[++index], '--max-targets', 1, AVR_TARGETS.length);
      maxTargetsExplicit = true;
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --execute');
  if (options.allRemaining && maxTargetsExplicit) {
    throw new Error('--all-remaining and --max-targets are mutually exclusive');
  }
  if (options.action === 'plan') {
    if (options.stateRoot || options.allowCacheReset || options.retryFailed
        || options.continueOnFailure || options.allRemaining || maxTargetsExplicit) {
      throw new Error('--plan is read-only and accepts only timeout/disk/qualification-root options');
    }
  } else {
    if (!options.stateRoot) throw new Error('--execute requires --state-root <new-or-existing-directory>');
    if (!options.allowCacheReset) throw new Error('--execute requires --allow-cache-reset');
    const token = String(environment[QUALIFICATION_TOKEN_ENV] || '');
    if (!/^[0-9a-f]{64}$/u.test(token)) {
      throw new Error(`${QUALIFICATION_TOKEN_ENV}=<64 lowercase hex> must be inherited by this batch and the production CK process`);
    }
    options.qualificationTokenPresent = true;
  }
  return options;
}

function usage() {
  return `Complete Arduino AVR compile-only coverage and qualification batch

Usage:
  node scripts/Run-CKAvrFullQualificationBatch.cjs --plan
  node scripts/Run-CKAvrFullQualificationBatch.cjs --execute --state-root <directory> --allow-cache-reset [options]

Options:
  --max-targets <1..${AVR_TARGETS.length}>  Process at most this many unfinished targets; default 1
  --all-remaining            Explicitly process every unfinished target in one long run
  --retry-failed             Permit a new no-clobber attempt after a recorded failure
  --continue-on-failure      Continue to later targets after a failed target
  --timeout-minutes <1..60>  Per compile timeout; default ${DEFAULT_TIMEOUT_MINUTES}
  --min-free-gib <8..100>    Guard state, qualification and TEMP volumes; default ${DEFAULT_MIN_FREE_GIB}
  --qualification-root <dir> Certificate root; default state/qualifications

Contract:
  * exactly ${AVR_TARGETS.length} complete FQBNs from the Arduino AVR 1.8.6 matrix;
  * one independent ${FORMAL_TRIALS}-trial portable-edit qualification per exact FQBN;
  * after a valid certificate, one production-path core-only regression cell per FQBN;
  * ${TOTAL_COMPILES_PER_TARGET} compile invocations per target, ${TOTAL_COMPILES_PER_TARGET * AVR_TARGETS.length} total;
  * strictly sequential children; compile-only, no upload, serial or physical write;
  * append-only events and no-clobber evidence make interruption resumable;
  * no certificate is copied or broadened: the existing evaluator binds Core,
    toolchain, host, production EXE and exact complete FQBN.
`;
}

function targetPlan() {
  if (AVR_TARGETS.length !== 38) throw new Error(`expected 38 AVR targets, found ${AVR_TARGETS.length}`);
  const seen = new Set();
  return AVR_TARGETS.map((target, index) => {
    const fqbn = canonicalCompleteFqbn(target.fqbn);
    if (!fqbn || fqbn !== target.fqbn) throw new Error(`target ${target.id} is not a canonical complete FQBN`);
    if (seen.has(fqbn)) throw new Error(`duplicate complete FQBN: ${fqbn}`);
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

function planFor(options) {
  const targets = targetPlan();
  return {
    schemaId: 'ck.avr.full-qualification-batch-plan',
    schemaVersion: BATCH_SCHEMA_VERSION,
    compileOnly: true,
    uploadPerformed: false,
    serialPortAccessed: false,
    physicalFlashWritten: false,
    exactFqbnCertificateBindingPreserved: true,
    sequential: true,
    resumable: true,
    minFreeGiB: options.minFreeGiB,
    timeoutMinutes: options.timeoutMinutes,
    qualificationRoot: options.qualificationRoot,
    targetCount: targets.length,
    qualificationCompileCalls: targets.length * QUALIFICATION_COMPILES_PER_TARGET,
    coverageCompileCalls: targets.length * COVERAGE_COMPILES_PER_TARGET,
    totalCompileCalls: targets.length * TOTAL_COMPILES_PER_TARGET,
    targets,
  };
}

function regularRealDirectory(directory, { create = false } = {}) {
  if (create) fs.mkdirSync(directory, { recursive: true });
  const metadata = fs.lstatSync(directory);
  if (!metadata.isDirectory() || metadata.isSymbolicLink()) {
    throw new Error(`directory must be real and must not be a symlink: ${directory}`);
  }
  return fs.realpathSync.native(directory);
}

function regularFile(file) {
  const metadata = fs.lstatSync(file);
  if (!metadata.isFile() || metadata.isSymbolicLink()) {
    throw new Error(`file must be regular and must not be a symlink: ${file}`);
  }
  return file;
}

function pathWithin(candidate, root) {
  const relative = path.relative(root, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function validateStateSeparation(stateRoot, qualificationRoot) {
  const state = path.resolve(stateRoot);
  const qualification = path.resolve(qualificationRoot);
  if (state === REPO_ROOT || state === path.parse(state).root
      || pathWithin(state, qualification) || pathWithin(qualification, state)) {
    throw new Error('state root must be a dedicated directory, not the repository root or qualification tree');
  }
}

function writeJsonNoClobber(file, value) {
  fs.mkdirSync(path.dirname(file), { recursive: true });
  const descriptor = fs.openSync(file, 'wx');
  try {
    fs.writeFileSync(descriptor, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
    fs.fsyncSync(descriptor);
  } finally {
    fs.closeSync(descriptor);
  }
}

function sourceBindings() {
  return Object.fromEntries([
    ['batch', __filename],
    ['matrixRunner', MATRIX_RUNNER],
    ['nativeAbRunner', NATIVE_AB_RUNNER],
    ['performanceGate', PERFORMANCE_GATE],
  ].map(([id, file]) => [id, { fileName: path.basename(file), sha256: sha256File(regularFile(file)) }]));
}

function manifestFor(options, productionExecutable) {
  const plan = planFor(options);
  return {
    schemaId: MANIFEST_SCHEMA_ID,
    schemaVersion: BATCH_SCHEMA_VERSION,
    createdAt: new Date().toISOString(),
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      sequential: true,
      exactFqbnCertificateBindingPreserved: true,
      evidenceNoClobber: true,
      appendOnlyEvents: true,
      childStartIdlePolicy: batchChildIdlePolicy(),
    },
    execution: {
      minFreeGiB: options.minFreeGiB,
      timeoutMinutes: options.timeoutMinutes,
      qualificationRoot: fs.realpathSync.native(options.qualificationRoot),
      productionExecutableSha256: productionExecutable.executableSha256,
    },
    sources: sourceBindings(),
    targetSetSha256: sha256Bytes(canonicalJson(plan.targets)),
    targets: plan.targets,
    totalCompileCalls: plan.totalCompileCalls,
  };
}

function readJson(file, maximumBytes = 4 * 1024 * 1024) {
  regularFile(file);
  const bytes = fs.readFileSync(file);
  if (bytes.length <= 0 || bytes.length > maximumBytes) {
    throw new Error(`JSON evidence size is outside 1..${maximumBytes}: ${file}`);
  }
  return { bytes, value: JSON.parse(bytes.toString('utf8')) };
}

function loadOrCreateManifest(options, productionExecutable) {
  const stateRoot = options.stateRoot;
  const existed = fs.existsSync(stateRoot);
  regularRealDirectory(stateRoot, { create: true });
  const manifestPath = path.join(stateRoot, 'manifest.json');
  if (!fs.existsSync(manifestPath)) {
    const visible = fs.readdirSync(stateRoot).filter((name) => name !== 'manifest.json');
    if (existed && visible.length > 0) {
      throw new Error('existing state root has no CK batch manifest and is not empty');
    }
    const manifest = manifestFor(options, productionExecutable);
    writeJsonNoClobber(manifestPath, manifest);
    return manifest;
  }
  const manifest = readJson(manifestPath).value;
  if (manifest?.schemaId !== MANIFEST_SCHEMA_ID || manifest.schemaVersion !== BATCH_SCHEMA_VERSION) {
    throw new Error('unsupported AVR batch manifest');
  }
  const expectedSources = sourceBindings();
  if (canonicalJson(manifest.sources) !== canonicalJson(expectedSources)) {
    throw new Error('batch sources changed; start a new state root instead of mixing evidence');
  }
  if (manifest.execution?.productionExecutableSha256 !== productionExecutable.executableSha256) {
    throw new Error('production executable changed; start a new state root and requalify exact targets');
  }
  if (fs.realpathSync.native(options.qualificationRoot) !== manifest.execution?.qualificationRoot) {
    throw new Error('qualification root differs from the immutable batch manifest');
  }
  if (manifest.execution?.minFreeGiB !== options.minFreeGiB
      || manifest.execution?.timeoutMinutes !== options.timeoutMinutes) {
    throw new Error('timeout/disk policy differs from the immutable batch manifest');
  }
  const targets = targetPlan();
  if (manifest.targetSetSha256 !== sha256Bytes(canonicalJson(targets))
      || canonicalJson(manifest.targets) !== canonicalJson(targets)) {
    throw new Error('exact AVR target set changed; start a new state root');
  }
  return manifest;
}

function eventsDirectory(stateRoot) {
  const directory = path.join(stateRoot, 'events');
  regularRealDirectory(directory, { create: true });
  return directory;
}

function loadEvents(stateRoot) {
  const directory = eventsDirectory(stateRoot);
  return fs.readdirSync(directory)
    .filter((name) => /^event-\d{6}\.json$/u.test(name))
    .sort()
    .map((name, index) => {
      const event = readJson(path.join(directory, name), 256 * 1024).value;
      if (event?.schemaId !== EVENT_SCHEMA_ID || event.schemaVersion !== BATCH_SCHEMA_VERSION
          || event.sequence !== index + 1) {
        throw new Error(`event journal is not contiguous at ${name}`);
      }
      return event;
    });
}

function appendEvent(stateRoot, value) {
  const events = loadEvents(stateRoot);
  const sequence = events.length + 1;
  const event = {
    schemaId: EVENT_SCHEMA_ID,
    schemaVersion: BATCH_SCHEMA_VERSION,
    sequence,
    recordedAt: new Date().toISOString(),
    ...value,
  };
  const file = path.join(eventsDirectory(stateRoot), `event-${String(sequence).padStart(6, '0')}.json`);
  writeJsonNoClobber(file, event);
  return event;
}

function latestTargetState(events, targetId) {
  const selected = events.filter((event) => event.targetId === targetId);
  const state = {
    qualification: 'pending',
    coverage: 'pending',
    qualificationAttempts: 0,
    coverageAttempts: 0,
    failure: null,
  };
  for (const event of selected) {
    if (event.phase === 'qualification' && event.kind === 'started') {
      state.qualification = 'running';
      state.qualificationAttempts = Math.max(state.qualificationAttempts, event.attempt || 0);
    } else if (event.phase === 'qualification' && ['passed', 'adopted'].includes(event.kind)) {
      state.qualification = 'passed';
      state.certificatePath = event.certificatePath;
      state.failure = null;
    } else if (event.phase === 'qualification' && event.kind === 'failed') {
      state.qualification = 'failed';
      state.failure = event.reason;
    } else if (event.phase === 'coverage' && event.kind === 'started') {
      state.coverage = 'running';
      state.coverageAttempts = Math.max(state.coverageAttempts, event.attempt || 0);
    } else if (event.phase === 'coverage' && event.kind === 'passed') {
      state.coverage = 'passed';
      state.failure = null;
    } else if (event.phase === 'coverage' && event.kind === 'failed') {
      state.coverage = 'failed';
      state.failure = event.reason;
    }
  }
  return state;
}

function expectedCurrentIdentity(target, productionExecutable) {
  const cli = inspectCliAndCore(target.fqbn);
  return {
    fqbn: target.fqbn,
    coreVersion: cli.coreVersion,
    cliVersion: cli.cliVersion,
    cliExecutableSha256: cli.cliExecutableSha256,
    hostIdentitySha256: hostEnvironmentFingerprint(),
    productionExecutableSha256: productionExecutable.executableSha256,
  };
}

function validateCertificateDirectory(directory, expectedIdentity) {
  const realDirectory = regularRealDirectory(directory);
  const evidencePath = regularFile(path.join(realDirectory, 'evidence.json'));
  const reportPath = regularFile(path.join(realDirectory, 'report.json'));
  const certificatePath = regularFile(path.join(realDirectory, 'certificate.json'));
  const evidence = readJson(evidencePath);
  const storedReport = readJson(reportPath);
  const certificate = readJson(certificatePath, 256 * 1024).value;
  const evidenceSha256 = sha256Bytes(evidence.bytes);
  const reportSha256 = sha256Bytes(storedReport.bytes);
  if (!nativeRelinkCertificateHasExactShape(certificate)
      || certificate.evidenceSha256 !== evidenceSha256
      || certificate.reportSha256 !== reportSha256) {
    throw new Error('certificate envelope or content hashes are invalid');
  }
  const evaluated = validateAndEvaluateNativeRelink(
    evidence.value,
    evidenceSha256,
    storedReport.value.evaluatedAt,
  );
  if (canonicalJson(evaluated) !== canonicalJson(storedReport.value)
      || evaluated.qualified !== true
      || evaluated.qualificationKey !== path.basename(realDirectory)) {
    throw new Error('certificate report cannot be reproduced from its evidence');
  }
  for (const [field, expected] of Object.entries(expectedIdentity)) {
    if (evaluated.target?.[field] !== expected) {
      throw new Error(`certificate ${field} does not match the current exact target`);
    }
  }
  return {
    certificatePath: realDirectory,
    qualificationKey: evaluated.qualificationKey,
    target: evaluated.target,
  };
}

function findValidExistingCertificate(qualificationRoot, expectedIdentity) {
  const root = regularRealDirectory(qualificationRoot);
  const matches = [];
  for (const entry of fs.readdirSync(root, { withFileTypes: true })) {
    if (!entry.isDirectory() || !/^[0-9a-f]{64}$/u.test(entry.name)) continue;
    try {
      matches.push(validateCertificateDirectory(path.join(root, entry.name), expectedIdentity));
    } catch {
      // Stale, foreign or corrupt certificates are ignored here. The CK runtime
      // performs its own fail-closed validation and the coverage phase must
      // still prove that the exact current certificate is actually consumed.
    }
  }
  if (matches.length > 1) throw new Error('multiple valid certificates bind the same exact current identity');
  return matches[0] || null;
}

function evidencePathFor(stateRoot, target, phase, attempt) {
  const directory = path.join(stateRoot, 'evidence', target.id);
  regularRealDirectory(directory, { create: true });
  return path.join(directory, `${phase}-attempt-${String(attempt).padStart(3, '0')}.json`);
}

function qualificationCommandFor(target, outputPath, options) {
  return [
    NATIVE_AB_RUNNER,
    '--execute',
    '--allow-cache-reset',
    '--fqbn', target.fqbn,
    '--sequence', 'portable-edit',
    '--trials', String(FORMAL_TRIALS),
    '--timeout-minutes', String(options.timeoutMinutes),
    '--min-free-gib', String(options.minFreeGiB),
    '--require-ck-mode', 'native-relink-compile-only',
    '--output', outputPath,
  ];
}

function coverageCommandFor(target, outputPath, options) {
  return [
    MATRIX_RUNNER,
    '--execute',
    '--allow-cache-reset',
    '--target', target.id,
    '--workload', 'core-only-block-style',
    '--trials', '1',
    '--timeout-minutes', String(options.timeoutMinutes),
    '--min-free-gib', String(options.minFreeGiB),
    '--output', outputPath,
  ];
}

function certificationCommandFor(evidencePath, qualificationRoot) {
  return [
    PERFORMANCE_GATE,
    '--certify-native-relink',
    '--input', evidencePath,
    '--qualification-root', qualificationRoot,
  ];
}

function runChild(args) {
  const display = [process.execPath, ...args].map((value) => JSON.stringify(value)).join(' ');
  process.stdout.write(`\n[AVR BATCH] ${display}\n`);
  const result = spawnSync(process.execPath, args, {
    cwd: REPO_ROOT,
    env: process.env,
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  return Number.isInteger(result.status) ? result.status : 1;
}

function validateQualificationEvidence(file, target) {
  const input = readJson(file);
  const report = validateAndEvaluateNativeRelink(input.value, sha256Bytes(input.bytes));
  if (report.qualified !== true || report.target?.fqbn !== target.fqbn
      || report.trialCountPerLane !== FORMAL_TRIALS) {
    throw new Error('formal evidence is not a qualified five-trial report for the exact FQBN');
  }
  return report;
}

function validateCoverageEvidence(file, target) {
  const report = readJson(file, 16 * 1024 * 1024).value;
  const cell = Array.isArray(report.cells) && report.cells.length === 1 ? report.cells[0] : null;
  if (report?.schemaId !== 'ck.avr.compile-regression-report' || report.schemaVersion !== 1
      || report.status !== 'passed'
      || report.measurementStatus !== 'passed'
      || !['target-met', 'target-not-met'].includes(report.performanceTargetStatus)
      || report.controls?.compileOnly !== true
      || report.controls?.uploadPerformed !== false
      || report.controls?.physicalFlashWritten !== false
      || report.controls?.serialPortAccessed !== false
      || report.trialsPerCell !== 1
      || report.plannedCellCount !== 1
      || report.applicableCellCount !== 1
      || report.expectedSkipCellCount !== 0
      || report.plannedCompileCount !== COVERAGE_COMPILES_PER_TARGET
      || !Array.isArray(report.failures)
      || report.failures.length !== 0
      || report.targets?.length !== 1
      || report.targets[0]?.id !== target.id
      || report.targets[0]?.fqbn !== target.fqbn
      || cell?.targetId !== target.id
      || cell?.fqbn !== target.fqbn
      || cell?.workloadId !== 'core-only-block-style'
      || cell?.result?.measurementPassed !== true
      || cell?.result?.artifactAndResourceEquivalent !== true
      || cell?.result?.noExactCompilerBypass !== true
      || cell?.result?.nativeRelinkRoutePassed !== true) {
    throw new Error('coverage evidence did not pass the exact compile-only production-route contract');
  }
  return report;
}

function assertDiskGates(options) {
  const roots = new Set([
    fs.realpathSync.native(options.stateRoot),
    fs.realpathSync.native(options.qualificationRoot),
    fs.realpathSync.native(os.tmpdir()),
  ]);
  return [...roots].map((root) => ({ root, freeBytes: assertFreeSpace(root, options.minFreeGiB) }));
}

function nextAttempt(state, phase) {
  return (phase === 'qualification' ? state.qualificationAttempts : state.coverageAttempts) + 1;
}

function markInterruptedAttemptIfNeeded(options, target, state, productionExecutable) {
  for (const phase of ['qualification', 'coverage']) {
    if (state[phase] !== 'running') continue;
    const attempt = phase === 'qualification' ? state.qualificationAttempts : state.coverageAttempts;
    const outputPath = evidencePathFor(options.stateRoot, target, phase, attempt);
    try {
      let certificate = null;
      if (phase === 'qualification') {
        const report = validateQualificationEvidence(outputPath, target);
        const currentIdentity = expectedCurrentIdentity(target, productionExecutable);
        certificate = findValidExistingCertificate(options.qualificationRoot, currentIdentity);
        if (!certificate || certificate.qualificationKey !== report.qualificationKey) {
          const gateExitCode = runChild(certificationCommandFor(outputPath, options.qualificationRoot));
          certificate = findValidExistingCertificate(options.qualificationRoot, currentIdentity);
          if (!certificate || certificate.qualificationKey !== report.qualificationKey) {
            throw new Error(`certificate recovery failed after evaluator exit ${gateExitCode}`);
          }
        }
      } else validateCoverageEvidence(outputPath, target);
      appendEvent(options.stateRoot, {
        targetId: target.id, fqbn: target.fqbn, phase, kind: 'passed', attempt,
        evidencePath: outputPath,
        certificatePath: certificate?.certificatePath,
        qualificationKey: certificate?.qualificationKey,
        recoveredAfterInterruption: true,
      });
    } catch (error) {
      appendEvent(options.stateRoot, {
        targetId: target.id, fqbn: target.fqbn, phase, kind: 'failed', attempt,
        evidencePath: fs.existsSync(outputPath) ? outputPath : null,
        reason: `interrupted attempt was not recoverable: ${error.message}`,
      });
    }
  }
}

function runQualification(options, target, productionExecutable, state) {
  const currentIdentity = expectedCurrentIdentity(target, productionExecutable);
  const existing = findValidExistingCertificate(options.qualificationRoot, currentIdentity);
  if (existing) {
    appendEvent(options.stateRoot, {
      targetId: target.id,
      fqbn: target.fqbn,
      phase: 'qualification',
      kind: 'adopted',
      certificatePath: existing.certificatePath,
      qualificationKey: existing.qualificationKey,
    });
    process.stdout.write(`[AVR BATCH] ${target.id}: adopted current exact-FQBN certificate ${existing.qualificationKey}\n`);
    return;
  }
  if (state.qualification === 'failed' && !options.retryFailed) {
    throw new Error(`${target.id} qualification previously failed; pass --retry-failed for a new no-clobber attempt`);
  }
  const attempt = nextAttempt(state, 'qualification');
  const outputPath = evidencePathFor(options.stateRoot, target, 'qualification', attempt);
  appendEvent(options.stateRoot, {
    targetId: target.id, fqbn: target.fqbn, phase: 'qualification', kind: 'started', attempt, outputPath,
    childStartIdlePolicy: batchChildIdlePolicy(),
  });
  let exitCode = null;
  let report;
  try {
    assertDiskGates(options);
    const childStartStability = prepareBatchChildLaunch({ phase: 'qualification' });
    appendEvent(options.stateRoot, {
      targetId: target.id,
      fqbn: target.fqbn,
      phase: 'qualification',
      kind: 'child-start-stable',
      attempt,
      childStartStability,
    });
    exitCode = runChild(qualificationCommandFor(target, outputPath, options));
    report = validateQualificationEvidence(outputPath, target);
    if (exitCode !== 0) throw new Error(`formal runner exited ${exitCode} despite qualified evidence`);
    const gateExitCode = runChild(certificationCommandFor(outputPath, options.qualificationRoot));
    const certificate = findValidExistingCertificate(options.qualificationRoot, currentIdentity);
    if (!certificate || certificate.qualificationKey !== report.qualificationKey) {
      throw new Error(`new certificate was not found under its exact evaluator qualification key (evaluator exit ${gateExitCode})`);
    }
    appendEvent(options.stateRoot, {
      targetId: target.id,
      fqbn: target.fqbn,
      phase: 'qualification',
      kind: 'passed',
      attempt,
      evidencePath: outputPath,
      certificatePath: certificate.certificatePath,
      qualificationKey: certificate.qualificationKey,
    });
  } catch (error) {
    appendEvent(options.stateRoot, {
      targetId: target.id, fqbn: target.fqbn, phase: 'qualification', kind: 'failed', attempt,
      evidencePath: fs.existsSync(outputPath) ? outputPath : null,
      runnerExitCode: exitCode,
      reason: error.message,
    });
    throw error;
  } finally {
    assertDiskGates(options);
  }
}

function runCoverage(options, target, state) {
  if (state.coverage === 'failed' && !options.retryFailed) {
    throw new Error(`${target.id} coverage previously failed; pass --retry-failed for a new no-clobber attempt`);
  }
  const attempt = nextAttempt(state, 'coverage');
  const outputPath = evidencePathFor(options.stateRoot, target, 'coverage', attempt);
  appendEvent(options.stateRoot, {
    targetId: target.id, fqbn: target.fqbn, phase: 'coverage', kind: 'started', attempt, outputPath,
    childStartIdlePolicy: batchChildIdlePolicy(),
  });
  let exitCode = null;
  try {
    assertDiskGates(options);
    const childStartStability = prepareBatchChildLaunch({ phase: 'coverage' });
    appendEvent(options.stateRoot, {
      targetId: target.id,
      fqbn: target.fqbn,
      phase: 'coverage',
      kind: 'child-start-stable',
      attempt,
      childStartStability,
    });
    exitCode = runChild(coverageCommandFor(target, outputPath, options));
    const report = validateCoverageEvidence(outputPath, target);
    if (![0, 2].includes(exitCode)) throw new Error(`coverage runner exited ${exitCode}`);
    appendEvent(options.stateRoot, {
      targetId: target.id,
      fqbn: target.fqbn,
      phase: 'coverage',
      kind: 'passed',
      attempt,
      evidencePath: outputPath,
      performanceTargetStatus: report.performanceTargetStatus,
    });
  } catch (error) {
    appendEvent(options.stateRoot, {
      targetId: target.id, fqbn: target.fqbn, phase: 'coverage', kind: 'failed', attempt,
      evidencePath: fs.existsSync(outputPath) ? outputPath : null,
      runnerExitCode: exitCode,
      reason: error.message,
    });
    throw error;
  } finally {
    assertDiskGates(options);
  }
}

function summaryFor(manifest, events) {
  const targets = manifest.targets.map((target) => ({
    ...target,
    ...latestTargetState(events, target.id),
  }));
  return {
    schemaId: 'ck.avr.full-qualification-batch-summary',
    schemaVersion: BATCH_SCHEMA_VERSION,
    targetCount: targets.length,
    qualifiedCount: targets.filter((target) => target.qualification === 'passed').length,
    coveragePassedCount: targets.filter((target) => target.coverage === 'passed').length,
    completeCount: targets.filter((target) => (
      target.qualification === 'passed' && target.coverage === 'passed'
    )).length,
    failedCount: targets.filter((target) => (
      target.qualification === 'failed' || target.coverage === 'failed'
    )).length,
    targets,
  };
}

function writeLatestSummary(stateRoot, summary) {
  const directory = path.join(stateRoot, 'summaries');
  regularRealDirectory(directory, { create: true });
  const sequence = fs.readdirSync(directory).filter((name) => /^summary-\d{6}\.json$/u.test(name)).length + 1;
  const file = path.join(directory, `summary-${String(sequence).padStart(6, '0')}.json`);
  writeJsonNoClobber(file, { generatedAt: new Date().toISOString(), ...summary });
  return file;
}

function execute(options) {
  validateStateSeparation(options.stateRoot, options.qualificationRoot);
  regularRealDirectory(options.qualificationRoot, { create: true });
  regularRealDirectory(path.dirname(options.stateRoot), { create: true });
  const productionExecutable = inspectProductionExecutable();
  const manifest = loadOrCreateManifest(options, productionExecutable);
  assertDiskGates(options);
  let events = loadEvents(options.stateRoot);
  for (const target of manifest.targets) {
    const state = latestTargetState(events, target.id);
    markInterruptedAttemptIfNeeded(options, target, state, productionExecutable);
    events = loadEvents(options.stateRoot);
  }
  let summary = summaryFor(manifest, events);
  const unfinished = summary.targets.filter((target) => !(
    target.qualification === 'passed' && target.coverage === 'passed'
  ));
  const limit = options.allRemaining ? unfinished.length : Math.min(options.maxTargets, unfinished.length);
  let attemptedTargets = 0;
  for (const target of unfinished) {
    if (attemptedTargets >= limit) break;
    attemptedTargets += 1;
    process.stdout.write(`\n[AVR BATCH] target ${target.ordinal}/${manifest.targets.length}: ${target.id} (${target.fqbn})\n`);
    try {
      let state = latestTargetState(loadEvents(options.stateRoot), target.id);
      if (state.qualification !== 'passed') {
        runQualification(options, target, productionExecutable, state);
      }
      state = latestTargetState(loadEvents(options.stateRoot), target.id);
      if (state.qualification !== 'passed') throw new Error('qualification did not reach passed state');
      if (state.coverage !== 'passed') runCoverage(options, target, state);
    } catch (error) {
      process.stderr.write(`[AVR BATCH] ${target.id} failed: ${error.message}\n`);
      if (!options.continueOnFailure) break;
    }
  }
  events = loadEvents(options.stateRoot);
  summary = summaryFor(manifest, events);
  const summaryPath = writeLatestSummary(options.stateRoot, summary);
  process.stdout.write(`\n[AVR BATCH] ${summary.completeCount}/${summary.targetCount} exact FQBNs complete; summary ${summaryPath}\n`);
  if (summary.failedCount > 0) process.exitCode = 1;
  else if (summary.completeCount < summary.targetCount) process.exitCode = 2;
  return summary;
}

function main(argv = process.argv.slice(2), environment = process.env) {
  const options = parseArgs(argv, environment);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  if (options.action === 'plan') {
    const plan = planFor(options);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\nNo compile, cache reset or certificate write was started.\n`);
    return plan;
  }
  return execute(options);
}

module.exports = {
  BATCH_SCHEMA_VERSION,
  BATCH_CHILD_IDLE_POLICY_ID,
  BATCH_CHILD_IDLE_WINDOW_MS,
  BATCH_CHILD_IDLE_TIMEOUT_MS,
  BATCH_CHILD_IDLE_POLL_INTERVAL_MS,
  COVERAGE_COMPILES_PER_TARGET,
  DEFAULT_MIN_FREE_GIB,
  FORMAL_TRIALS,
  QUALIFICATION_COMPILES_PER_TARGET,
  TOTAL_COMPILES_PER_TARGET,
  appendEvent,
  batchChildIdlePolicy,
  canonicalJson,
  certificationCommandFor,
  coverageCommandFor,
  findValidExistingCertificate,
  latestTargetState,
  loadEvents,
  main,
  manifestFor,
  nativeRelinkCertificateHasExactShape,
  parseArgs,
  planFor,
  prepareBatchChildLaunch,
  qualificationCommandFor,
  sha256Bytes,
  summaryFor,
  targetPlan,
  validateCertificateDirectory,
  validateCoverageEvidence,
  validateQualificationEvidence,
  waitForBatchChildArduinoCliIdleWindow,
};

if (require.main === module) {
  try {
    main();
  } catch (error) {
    process.stderr.write(`CK AVR qualification batch: ${error?.stack || error}\n`);
    process.exitCode = 1;
  }
}
