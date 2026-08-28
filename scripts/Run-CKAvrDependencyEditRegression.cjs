#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_MIN_FREE_GIB = 8;
const DEFAULT_TRIALS = 1;
const REPORT_SCHEMA_ID = 'ck.avr.dependency-edit-regression-report';
const PLAN_SCHEMA_ID = 'ck.avr.dependency-edit-regression-plan';
const SCHEMA_VERSION = 1;
const CORE_SEEDED_ROUTE = 'arduino-cli-core-seeded';
const NATIVE_RELINK_ROUTE = 'native-relink-compile-only';
const NATIVE_RELINK_GRAPH_TRANSITION_ROUTE = 'native-relink-graph-transition';
const COMPATIBILITY_CLI_ROUTE = 'arduino-cli-compatibility';
const GEMMA_SKIP_REASON = 'ATtiny85 cannot compile the required MsTimer2 and Wire/SPI dependency transitions.';
const PERFORMANCE_POLICY = Object.freeze({
  id: 'ck-avr-dependency-edit-performance-v2',
  minimumMedianSpeedupPct: 25,
  minimumAbsoluteMedianGainMs: 500,
  aggregation: 'median',
  initialColdStageRecordedOnly: true,
  formalRecommendedTrials: 5,
  certification: false,
});

function sourceFrom(workloadId, stageId) {
  const workload = matrix.AVR_WORKLOADS.find((candidate) => candidate.id === workloadId);
  if (!workload) throw new Error(`missing AVR workload source: ${workloadId}`);
  const stage = workload.stages.find((candidate) => candidate.id === stageId);
  if (!stage) throw new Error(`missing AVR workload stage: ${workloadId}/${stageId}`);
  return stage.code;
}

function sequenceStage(id, label, workloadId, workloadStageId, dependencyGraph, transitionKind, expectedHeaders) {
  const code = sourceFrom(workloadId, workloadStageId);
  return Object.freeze({
    id,
    label,
    workloadId,
    workloadStageId,
    dependencyGraph,
    transitionKind,
    expectedHeaders: Object.freeze([...expectedHeaders]),
    preferredRoute: transitionKind === 'initial-cold'
      ? null : transitionKind === 'same-graph-edit'
        ? NATIVE_RELINK_ROUTE : NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
    code,
  });
}

const DEPENDENCY_EDIT_SEQUENCE = Object.freeze([
  sequenceStage('simple', 'Core-only cold baseline', 'core-only-block-style', 'simple', 'core-only', 'initial-cold', []),
  sequenceStage('add-mstimer2', 'Add MsTimer2', 'mstimer2', 'simple', 'mstimer2', 'dependency-change', ['MsTimer2.h']),
  sequenceStage('edit-mstimer2', 'Edit with MsTimer2 unchanged', 'mstimer2', 'complex', 'mstimer2', 'same-graph-edit', ['MsTimer2.h']),
  sequenceStage('remove-mstimer2', 'Remove MsTimer2', 'core-only-block-style', 'medium', 'core-only', 'dependency-change', []),
  sequenceStage('add-wire-spi-eeprom', 'Add Wire/SPI/EEPROM', 'wire-spi-eeprom', 'simple', 'wire-spi-eeprom', 'dependency-change', ['Wire.h', 'SPI.h', 'EEPROM.h']),
  sequenceStage('edit-wire-spi-eeprom', 'Edit with Wire/SPI/EEPROM unchanged', 'wire-spi-eeprom', 'complex', 'wire-spi-eeprom', 'same-graph-edit', ['Wire.h', 'SPI.h', 'EEPROM.h']),
  sequenceStage('return-core-only', 'Return to exact core-only baseline', 'core-only-block-style', 'simple', 'core-only', 'dependency-change', []),
]);

function validateSequence() {
  const ids = DEPENDENCY_EDIT_SEQUENCE.map((stage) => stage.id);
  if (new Set(ids).size !== ids.length || ids.length !== 7) return false;
  if (DEPENDENCY_EDIT_SEQUENCE[0].code !== DEPENDENCY_EDIT_SEQUENCE.at(-1).code) return false;
  return DEPENDENCY_EDIT_SEQUENCE.every((stage) => (
    typeof stage.code === 'string'
    && stage.code.length > 0
    && stage.expectedHeaders.every((header) => stage.code.includes(`#include <${header}>`))
  ));
}

function targetApplicability(target) {
  return target.id === 'gemma'
    ? Object.freeze({ status: 'expected-skip', applicable: false, reason: GEMMA_SKIP_REASON })
    : Object.freeze({ status: 'applicable', applicable: true, reason: null });
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function selectedTargets(ids) {
  if (ids.length === 0 || ids.includes('all')) return [...matrix.AVR_TARGETS];
  const requested = new Set(ids);
  const selected = matrix.AVR_TARGETS.filter((target) => requested.has(target.id));
  const missing = [...requested].filter((id) => !matrix.AVR_TARGETS.some((target) => target.id === id));
  if (missing.length > 0) throw new Error(`unknown target: ${missing.join(', ')}`);
  return selected;
}

function parseArgs(argv) {
  const options = {
    action: null,
    targetIds: [],
    targets: [],
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    trials: DEFAULT_TRIALS,
    outputPath: null,
    allowCacheReset: false,
    keepWorkdir: false,
    help: false,
  };
  const setAction = (value) => {
    if (options.action && options.action !== value) throw new Error('choose exactly one of --plan or --execute');
    options.action = value;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--execute') setAction('execute');
    else if (argument === '--target') {
      const value = argv[++index];
      if (!value) throw new Error('--target requires an ID or all');
      options.targetIds.push(value);
    } else if (argument === '--timeout-minutes') {
      options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    } else if (argument === '--trials') {
      options.trials = parseInteger(argv[++index], '--trials', 1, 5);
    } else if (argument === '--min-free-gib') {
      options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 8, 100);
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value) throw new Error('--output requires a JSON file');
      options.outputPath = path.resolve(process.cwd(), value);
    } else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --execute');
  if (options.targetIds.includes('all') && options.targetIds.length > 1) throw new Error('--target all cannot be combined');
  options.targets = selectedTargets(options.targetIds);
  if (options.action === 'plan') {
    if (options.outputPath || options.allowCacheReset || options.keepWorkdir) {
      throw new Error('--plan is read-only and cannot accept execution flags');
    }
  } else {
    if (!options.outputPath || path.extname(options.outputPath).toLowerCase() !== '.json') {
      throw new Error('--execute requires --output <new.json>');
    }
    if (!options.allowCacheReset) throw new Error('--execute requires explicit --allow-cache-reset');
    if (fs.existsSync(options.outputPath)) throw new Error(`refusing to overwrite existing report: ${options.outputPath}`);
  }
  return options;
}

function usage() {
  return `CK AVR continuous dependency-edit regression

Usage:
  node scripts/Run-CKAvrDependencyEditRegression.cjs --plan [--target <id|all>] [--trials <1..5>]
  node scripts/Run-CKAvrDependencyEditRegression.cjs --execute --allow-cache-reset --output <new.json> [options]

Sequence:
  core-only -> add MsTimer2 -> edit MsTimer2 -> remove MsTimer2 ->
  add Wire/SPI/EEPROM -> edit Wire/SPI/EEPROM -> exact core-only return

This runner is compile-only. It never uploads firmware or opens a serial port.
Default is one exploratory trial; use --trials 3 for the recommended formal median.
`;
}

function planFor(options) {
  if (!validateSequence()) throw new Error('dependency-edit source sequence is invalid');
  const targets = options.targets.map((target) => ({
    ...target,
    applicability: targetApplicability(target),
  }));
  const applicableTargetCount = targets.filter((target) => target.applicability.applicable).length;
  return {
    schemaId: PLAN_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    compileOnly: true,
    uploadPerformed: false,
    physicalFlashWritten: false,
    serialPortAccessed: false,
    oneColdResetPerTargetTrial: true,
    stableBuildPathPerLane: true,
    targetCount: targets.length,
    applicableTargetCount,
    expectedSkipTargetCount: targets.length - applicableTargetCount,
    trialsPerTarget: options.trials,
    stageCountPerTarget: DEPENDENCY_EDIT_SEQUENCE.length,
    pairedStageCount: applicableTargetCount * options.trials * DEPENDENCY_EDIT_SEQUENCE.length,
    totalCompileCount: applicableTargetCount * options.trials * DEPENDENCY_EDIT_SEQUENCE.length * 2,
    targets,
    sequence: DEPENDENCY_EDIT_SEQUENCE.map(({ code, ...stage }) => ({
      ...stage,
      sourceSha256: forge.sha256Bytes(code),
      sourceBytes: Buffer.byteLength(code, 'utf8'),
    })),
    routePolicy: {
      id: 'ck-avr-dependency-edit-route-v2',
      initialColdRecordedOnly: true,
      dependencyChangePreferred: NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
      dependencyChangeRequiredForPerformance: NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
      sameGraphEditPreferred: NATIVE_RELINK_ROUTE,
      safeFallbacksRecognizedButNotPreferred: [CORE_SEEDED_ROUTE, COMPATIBILITY_CLI_ROUTE],
    },
    performancePolicy: PERFORMANCE_POLICY,
  };
}

function writeJsonNoClobber(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.linkSync(temporary, outputPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function artifactSetSha256(artifacts) {
  return forge.digestObject(artifacts.map(({ name, bytes, sha256, primaryApplication, role }) => ({
    name, bytes, sha256, primaryApplication, role,
  })));
}

function finalizeRun(run) {
  const withVersion = { ...run, integritySchemaVersion: 2 };
  const { evidenceSha256, ...projection } = withVersion;
  delete projection.wallMs;
  projection.rawTiming = projection.rawTiming && typeof projection.rawTiming === 'object'
    ? { runnerWallNs: projection.rawTiming.runnerWallNs }
    : null;
  return { ...withVersion, evidenceSha256: forge.digestObject(projection) };
}

function finalizeNativeStageRun(run, targetId, stageId) {
  if (!run || typeof run !== 'object') throw new Error('native dependency-edit run is missing');
  if (typeof targetId !== 'string' || targetId.length === 0) {
    throw new Error('native dependency-edit target ID is missing');
  }
  if (typeof stageId !== 'string' || stageId.length === 0) {
    throw new Error('native dependency-edit stage ID is missing');
  }
  const { evidenceSha256, ...unsigned } = run;
  return finalizeRun({ ...unsigned, targetId, phase: stageId });
}

function fallbackEvidence(buildMode, log) {
  const normalizedMode = String(buildMode || '').toLowerCase();
  const normalizedLog = String(log || '').toLowerCase();
  return {
    used: normalizedMode.includes('fallback') || normalizedLog.includes('falling back'),
    buildMode: buildMode || null,
    reasonLines: String(log || '').split(/\r?\n/u)
      .filter((line) => /\b(?:fallback|not eligible|no passing a\/b performance certificate)\b/iu.test(line))
      .slice(0, 12),
  };
}

function observedRouteMode(run) {
  const candidates = [
    run?.structuredRoute,
    run?.structuredRoute?.mode,
    run?.structuredRoute?.route,
    run?.route?.mode,
    run?.route?.route,
    run?.route?.buildMode,
    run?.buildMode,
  ].filter((value) => typeof value === 'string').map((value) => value.toLowerCase());
  if (candidates.includes(NATIVE_RELINK_GRAPH_TRANSITION_ROUTE)) {
    return NATIVE_RELINK_GRAPH_TRANSITION_ROUTE;
  }
  if (candidates.includes(NATIVE_RELINK_ROUTE)) return NATIVE_RELINK_ROUTE;
  if (candidates.includes(CORE_SEEDED_ROUTE)) return CORE_SEEDED_ROUTE;
  if (candidates.some((value) => /^(?:full-build|arduino-cli-(?:full|incremental)(?:-fallback)?|arduino-cli-incremental)$/u.test(value))) {
    return COMPATIBILITY_CLI_ROUTE;
  }
  return 'unknown';
}

function routeEvidenceFor(run, stage) {
  const observedMode = observedRouteMode(run);
  const nativeRelinkEvidence = observedMode !== NATIVE_RELINK_ROUTE || (
    run?.cache?.nativeRelinkDiagnostics?.some((line) => String(line).includes('NativeRelinkCompileOnly path:'))
    && run?.cache?.nativeRelinkDiagnostics?.some((line) => String(line).includes('NativeRelinkCompileOnly certificate matched'))
  );
  return {
    policyId: 'ck-avr-dependency-edit-route-v2',
    transitionKind: stage.transitionKind,
    preferredMode: stage.preferredRoute,
    optimizationRequired: stage.transitionKind !== 'initial-cold',
    observedMode,
    recognized: observedMode !== 'unknown',
    nativeRelinkEvidence,
    safe: observedMode !== 'unknown' && nativeRelinkEvidence && run?.exactUsed === false,
    preferred: stage.transitionKind === 'initial-cold'
      ? null : observedMode === stage.preferredRoute && nativeRelinkEvidence && run?.fallback?.used !== true,
  };
}

function compilerEvidence(diagnostics, log, phase, expectedJobs) {
  const buildMode = diagnostics?.buildMode;
  if (buildMode === 'exact-match' || diagnostics?.cache?.exactMatch === true) {
    throw new Error(`CK ${phase} returned Exact; dependency-edit regression requires compilation`);
  }
  const allowed = new Set([
    'full-build', 'arduino-cli-full-fallback', 'arduino-cli-incremental',
    'arduino-cli-incremental-fallback', 'fast-relink', NATIVE_RELINK_ROUTE,
    NATIVE_RELINK_GRAPH_TRANSITION_ROUTE, CORE_SEEDED_ROUTE,
  ]);
  if (!allowed.has(buildMode)) throw new Error(`CK ${phase} reported unsupported buildMode=${buildMode || 'missing'}`);
  if (diagnostics?.profile !== 'release') throw new Error(`CK ${phase} is not a Release compile`);
  const match = String(log || '').match(/\[INFO\] Compile parallel jobs:\s*(\d+)/u);
  const observedJobs = match ? Number(match[1]) : expectedJobs;
  if (observedJobs !== expectedJobs) throw new Error(`CK jobs=${observedJobs} did not match native jobs=${expectedJobs}`);
  return { observedJobs };
}

async function runCkCompile(evaluate, fqbn, stage, targetId, timeoutMs, expectedJobs) {
  const codeSha256 = forge.sha256Bytes(stage.code);
  const runId = crypto.randomUUID();
  const started = process.hrtime.bigint();
  const result = await evaluate(`(async () => {
    const started = performance.now();
    try {
      const raw = await window.__TAURI_INTERNALS__.invoke('compile_sketch', {
        code: ${JSON.stringify(stage.code)},
        fqbn: ${JSON.stringify(fqbn)},
        boardPackageId: null,
        runId: ${JSON.stringify(runId)},
        workspaceFingerprint: ${JSON.stringify(codeSha256)},
        sourceMapJson: null,
        silent: false,
        qualification: false
      });
      return { ok: true, raw, pageWallMs: performance.now() - started };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  const wallNs = process.hrtime.bigint() - started;
  if (!result?.ok) throw new Error(`CK ${stage.id} compile failed: ${result?.error || 'unknown error'}`);
  const parsed = JSON.parse(result.raw);
  const diagnostics = parsed.diagnostics || {};
  const compiler = compilerEvidence(diagnostics, parsed.log, stage.id, expectedJobs);
  const artifacts = forge.inspectCkArtifacts(parsed, forge.nativeRelinkAdapterFor(fqbn));
  const resources = diagnostics.resources || {};
  if (resources.evidenceComplete !== true) throw new Error(`CK ${stage.id} resource evidence is incomplete`);
  return finalizeRun({
    targetId,
    phase: stage.id,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: false,
    wallMs: Number(wallNs) / 1e6,
    rawTiming: {
      runnerWallNs: wallNs.toString(),
      pageWallMs: Number(result.pageWallMs),
      backend: diagnostics.timing || null,
    },
    buildMode: diagnostics.buildMode || null,
    fallback: fallbackEvidence(diagnostics.buildMode, parsed.log),
    profile: diagnostics.profile || null,
    route: diagnostics.engine || null,
    structuredRoute: diagnostics.route || diagnostics.engine?.route || null,
    cache: {
      exactMatch: diagnostics.cache?.exactMatch === true,
      forcedRebuild: diagnostics.cache?.forcedRebuild === true,
      missReasons: Array.isArray(diagnostics.cache?.missReasons) ? diagnostics.cache.missReasons.slice(0, 16) : [],
      nativeRelinkDiagnostics: Array.isArray(diagnostics.cache?.nativeRelinkDiagnostics)
        ? diagnostics.cache.nativeRelinkDiagnostics.slice(0, 16) : [],
    },
    jobs: compiler.observedJobs,
    fqbn: diagnostics.fqbn || null,
    toolchainKey: diagnostics.environment?.toolchainKey || null,
    cliVersion: diagnostics.environment?.cliVersion || null,
    codeSha256,
    responseSha256: forge.sha256Bytes(result.raw),
    resources: {
      evidenceComplete: true,
      flashUsedBytes: Number(resources.flashUsedBytes),
      ramUsedBytes: Number(resources.ramUsedBytes),
      warningCount: Number(resources.warningCount),
    },
    artifacts,
    artifactsVerified: true,
    artifactSetSha256: artifactSetSha256(artifacts),
    buildPathIdentitySha256: forge.sha256Bytes(normalizedPath(fs.realpathSync.native(parsed.path))),
  });
}

async function clearCkCache(evaluate, fqbn, timeoutMs) {
  const result = await evaluate(`(async () => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(
        'clear_board_first_project_compile_cache', { fqbn: ${JSON.stringify(fqbn)} }
      ) };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  if (!result?.ok) throw new Error(`CK exact-target cache reset failed: ${result?.error || 'unknown error'}`);
  const validation = forge.validateCacheClear(result.value, fqbn);
  if (!validation.passed) throw new Error(`CK cache reset evidence failed: ${validation.failures.join('; ')}`);
  return result.value;
}

async function waitForLaneBoundary(lane) {
  const idle = await forge.waitForArduinoCliIdleWindow({
    idleWindowMs: forge.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
    timeoutMs: forge.ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
    pollIntervalMs: forge.ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
    policyId: forge.ARDUINO_CLI_LANE_IDLE_POLICY_ID,
    phaseLabel: `${lane} dependency-edit lane`,
  });
  return { lane, ...idle };
}

function compareRestorationLane(first, last) {
  return {
    source: first.codeSha256 === last.codeSha256,
    resources: forge.resourcesEquivalent(first.resources, last.resources),
    artifacts: forge.compareAvrArtifactRoles(first.artifacts, last.artifacts),
  };
}

function evaluateTrial(trial) {
  const stagesPassed = trial.stages.every((stage) => (
    stage.equivalence?.source === true
    && stage.equivalence?.resources === true
    && stage.equivalence?.artifacts?.passed === true
  ));
  const routeSafetyPassed = trial.stages.every((stage) => stage.routeEvidence?.safe === true);
  const optimizedRoutePassed = trial.stages
    .filter((stage) => stage.routeEvidence?.optimizationRequired === true)
    .every((stage) => stage.routeEvidence?.preferred === true);
  const first = trial.stages[0];
  const last = trial.stages.at(-1);
  const restoration = {
    ck: compareRestorationLane(first.ck, last.ck),
    native: compareRestorationLane(first.native, last.native),
  };
  restoration.passed = ['ck', 'native'].every((lane) => (
    restoration[lane].source
    && restoration[lane].resources
    && restoration[lane].artifacts.passed
  ));
  const ckBuildPaths = new Set(trial.stages.map((stage) => stage.ck.buildPathIdentitySha256));
  const nativeBuildPaths = new Set(trial.stages.map((stage) => stage.native.buildPathIdentitySha256));
  const stableBuildPaths = ckBuildPaths.size === 1 && nativeBuildPaths.size === 1;
  return {
    measurementPassed: stagesPassed && routeSafetyPassed && restoration.passed
      && stableBuildPaths && trial.failures.length === 0,
    stageEquivalencePassed: stagesPassed,
    routeSafetyPassed,
    optimizedRoutePassed,
    stableBuildPaths,
    restoration,
  };
}

function performanceSummary(trials, stageIndex) {
  const ckRawMs = trials.map((trial) => trial.stages[stageIndex].ck.wallMs);
  const nativeRawMs = trials.map((trial) => trial.stages[stageIndex].native.wallMs);
  const ckMedianMs = forge.median(ckRawMs);
  const nativeMedianMs = forge.median(nativeRawMs);
  const medianGainMs = nativeMedianMs - ckMedianMs;
  const speedupPct = nativeMedianMs > 0 ? (medianGainMs / nativeMedianMs) * 100 : null;
  const recordedOnly = stageIndex === 0;
  const optimizedRoutePassed = recordedOnly ? null : trials.every(
    (trial) => trial.stages[stageIndex].routeEvidence?.preferred === true,
  );
  return {
    stageId: DEPENDENCY_EDIT_SEQUENCE[stageIndex].id,
    ckRawMs,
    nativeRawMs,
    ckMedianMs,
    nativeMedianMs,
    medianGainMs,
    ckSpeedupPctVsNative: speedupPct,
    recordedOnly,
    optimizedRouteRequired: !recordedOnly,
    optimizedRoutePassed,
    passed: recordedOnly ? null : optimizedRoutePassed
      && speedupPct >= PERFORMANCE_POLICY.minimumMedianSpeedupPct
      && medianGainMs >= PERFORMANCE_POLICY.minimumAbsoluteMedianGainMs,
  };
}

function evaluateTarget(targetResult) {
  const trialResults = targetResult.trials.map((trial) => evaluateTrial(trial));
  const performanceStages = DEPENDENCY_EDIT_SEQUENCE.map((stage, index) => performanceSummary(
    targetResult.trials, index,
  ));
  const performancePassed = performanceStages.slice(1).every((stage) => stage.passed === true);
  return {
    measurementPassed: trialResults.every((result) => result.measurementPassed)
      && targetResult.failures.length === 0,
    routeSafetyPassed: trialResults.every((result) => result.routeSafetyPassed),
    optimizedRoutePassed: trialResults.every((result) => result.optimizedRoutePassed),
    stableBuildPaths: trialResults.every((result) => result.stableBuildPaths),
    trialResults,
    performanceTarget: {
      policy: PERFORMANCE_POLICY,
      status: performancePassed ? 'target-met' : 'target-not-met',
      passed: performancePassed,
      qualificationClaimed: false,
      stages: performanceStages,
      note: targetResult.trials.length < PERFORMANCE_POLICY.formalRecommendedTrials
        ? `Exploratory ${targetResult.trials.length}-trial result; use --trials ${PERFORMANCE_POLICY.formalRecommendedTrials} for the recommended formal sample.`
        : null,
    },
  };
}

function expectedSkipResult() {
  return {
    measurementPassed: true,
    measurementStatus: 'expected-skip',
    routeSafetyPassed: null,
    optimizedRoutePassed: null,
    performanceTarget: {
      policy: PERFORMANCE_POLICY,
      status: 'not-applicable',
      passed: null,
      qualificationClaimed: false,
      stages: [],
      note: null,
    },
  };
}

function safeTargetPath(root, targetId) {
  const candidate = path.join(root, 'targets', String(targetId).replace(/[^a-z0-9_-]+/giu, '_'));
  const relative = path.relative(root, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('target path escaped work root');
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

async function execute(options) {
  const plan = planFor(options);
  const timeoutMs = options.timeoutMinutes * 60_000;
  const jobs = forge.effectiveJobs();
  const workParent = path.join(os.tmpdir(), 'CKAB');
  fs.mkdirSync(workParent, { recursive: true });
  const workRoot = path.join(workParent, crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(workRoot, { recursive: false });
  const productionBefore = forge.inspectProductionExecutable();
  const report = {
    schemaId: REPORT_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    measurementStatus: 'running',
    routeTargetStatus: 'not-evaluated',
    performanceTargetStatus: 'not-evaluated',
    startedAt: new Date().toISOString(),
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
    targets: [],
    failures: [],
    startupStability: null,
    preTrialStability: null,
    compileSettingsSha256: null,
    productionExecutable: { before: productionBefore, after: null, unchanged: null },
    disk: {
      minimumFreeGiB: options.minFreeGiB,
      freeBytesBefore: forge.assertFreeSpace(workRoot, options.minFreeGiB),
      freeBytesAfterCapture: null,
      freeBytesAfterCleanup: null,
      cleanup: null,
    },
  };
  const attemptedFqbns = new Set();
  let cdp;
  try {
    report.startupStability = await forge.waitForArduinoCliIdleWindow();
    const page = await forge.getCdpTarget();
    cdp = forge.createCdp(page.webSocketDebuggerUrl);
    const preflight = await forge.runCdpPreflightAndWaitForPreTrialStability({
      evaluate: cdp.evaluate,
      compileTimeoutMs: timeoutMs,
      expectedJobs: jobs,
    });
    report.preTrialStability = preflight.stability;
    report.compileSettingsSha256 = forge.digestObject(preflight.compileSettings);

    for (const [targetIndex, target] of options.targets.entries()) {
      const applicability = targetApplicability(target);
      const row = {
        ...target,
        applicability,
        identity: null,
        trials: [],
        failures: [],
        result: null,
      };
      if (!applicability.applicable) {
        row.result = expectedSkipResult();
        report.targets.push(row);
        continue;
      }
      try {
        const nativeBaselineConfig = forge.nativeBaselineContract(null);
        row.identity = forge.inspectCliAndCore(
          target.fqbn,
          nativeBaselineConfig.cliConfigPath,
        );
        if (String(row.identity.coreArchitecture).toLowerCase() !== 'avr') {
          throw new Error(`resolved architecture ${row.identity.coreArchitecture} is not AVR`);
        }
        const nativeBaseline = forge.nativeBaselineContract(null, row.identity);
        await forge.waitForArduinoCliIdleWindow({ phaseLabel: `${target.id} post-identity` });
        attemptedFqbns.add(target.fqbn);
        for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
          const trialId = `trial-${String(trialIndex + 1).padStart(3, '0')}`;
          const trial = { id: trialId, cacheReset: null, stages: [], failures: [], result: null };
          row.trials.push(trial);
          trial.cacheReset = await clearCkCache(cdp.evaluate, target.fqbn, timeoutMs);
          const nativeRoot = safeTargetPath(workRoot, `${target.id}-${trialId}`);
          const nativeContext = forge.createNativeTrial(
            nativeRoot,
            `${target.id}-${trialId}`,
            target.fqbn,
            jobs,
            DEPENDENCY_EDIT_SEQUENCE[0].code,
            nativeBaseline,
          );
          for (const [stageIndex, stage] of DEPENDENCY_EDIT_SEQUENCE.entries()) {
            const order = (targetIndex + trialIndex + stageIndex) % 2 === 0
              ? ['ck', 'native'] : ['native', 'ck'];
            const stageResult = {
              id: stage.id,
              order: order.join('-'),
              ck: null,
              native: null,
              equivalence: null,
              routeEvidence: null,
              laneBoundaryIdle: [],
            };
            for (const lane of order) {
              forge.assertNoConcurrentArduinoCli();
              if (lane === 'ck') {
                stageResult.ck = await runCkCompile(
                  cdp.evaluate, target.fqbn, stage, target.id, timeoutMs, jobs,
                );
              } else {
                forge.updateNativeTrialSource(nativeContext, stage.code);
                const nativePhase = stageIndex === 0 ? 'simple' : stage.id;
                const native = await forge.runNativeCompile(nativeContext, nativePhase, target.id, timeoutMs);
                stageResult.native = finalizeNativeStageRun(native, target.id, stage.id);
              }
              stageResult.laneBoundaryIdle.push(await waitForLaneBoundary(lane));
            }
            stageResult.equivalence = {
              source: stageResult.ck.codeSha256 === stageResult.native.codeSha256
                && stageResult.ck.codeSha256 === forge.sha256Bytes(stage.code),
              resources: forge.resourcesEquivalent(stageResult.ck.resources, stageResult.native.resources),
              artifacts: forge.compareAvrArtifactRoles(stageResult.ck.artifacts, stageResult.native.artifacts),
            };
            stageResult.routeEvidence = routeEvidenceFor(stageResult.ck, stage);
            trial.stages.push(stageResult);
          }
          trial.result = evaluateTrial(trial);
        }
        row.result = evaluateTarget(row);
        if (!row.result.measurementPassed) report.failures.push(`${target.id}: dependency-edit measurement failed`);
      } catch (error) {
        row.failures.push(String(error?.stack || error));
        row.result = {
          measurementPassed: false,
          routeSafetyPassed: false,
          optimizedRoutePassed: false,
          performanceTarget: { policy: PERFORMANCE_POLICY, status: 'not-evaluated', passed: false },
        };
        report.failures.push(`${target.id}: ${error?.message || error}`);
      } finally {
        try { await clearCkCache(cdp.evaluate, target.fqbn, timeoutMs); } catch (error) {
          row.failures.push(`cleanup: ${error?.message || error}`);
          report.failures.push(`${target.id}: CK cache cleanup failed`);
        }
      }
      report.targets.push(row);
    }
  } catch (error) {
    report.failures.push(String(error?.stack || error));
  } finally {
    if (cdp) {
      for (const fqbn of attemptedFqbns) {
        try { await clearCkCache(cdp.evaluate, fqbn, timeoutMs); } catch (error) {
          report.failures.push(`final CK cache cleanup ${fqbn}: ${error?.message || error}`);
        }
      }
    }
    cdp?.socket.close();
    report.finishedAt = new Date().toISOString();
    try {
      const productionAfter = forge.inspectProductionExecutable();
      report.productionExecutable.after = productionAfter;
      report.productionExecutable.unchanged = forge.digestObject(productionBefore) === forge.digestObject(productionAfter);
      if (!report.productionExecutable.unchanged) report.failures.push('production executable/process changed');
    } catch (error) {
      report.failures.push(`production identity finalization failed: ${error?.message || error}`);
    }
    try {
      report.disk.freeBytesAfterCapture = forge.assertFreeSpace(workRoot, options.minFreeGiB);
      report.disk.cleanup = forge.inspectOwnedWorkdir(workRoot);
      if (!options.keepWorkdir) {
        forge.safeRemoveWorkdir(workRoot);
        if (fs.existsSync(workRoot)) throw new Error('owned work directory remains after cleanup');
        report.disk.cleanup.removed = true;
        report.disk.cleanup.removedPaths = ['<TEMP>/CKAB/<run-token>'];
      } else {
        report.disk.cleanup.removed = false;
        report.disk.cleanup.removedPaths = [];
      }
      report.disk.freeBytesAfterCleanup = forge.assertFreeSpace(workParent, options.minFreeGiB);
    } catch (error) {
      report.failures.push(`workdir cleanup failed: ${error?.message || error}`);
    }
    report.measurementStatus = report.failures.length === 0
      && report.targets.every((target) => target.result?.measurementPassed === true)
      ? 'passed' : 'failed';
    const applicable = report.targets.filter((target) => target.applicability.applicable);
    report.routeTargetStatus = report.measurementStatus !== 'passed'
      ? 'not-evaluated'
      : applicable.length === 0 ? 'not-applicable'
        : applicable.every((target) => target.result.optimizedRoutePassed === true)
          ? 'target-met' : 'target-not-met';
    report.performanceTargetStatus = report.measurementStatus !== 'passed'
      ? 'not-evaluated'
      : applicable.length === 0 ? 'not-applicable'
        : applicable.every((target) => target.result.performanceTarget?.passed === true)
          ? 'target-met' : 'target-not-met';
    report.status = report.measurementStatus;
    writeJsonNoClobber(options.outputPath, report);
    process.stdout.write(`REPORT ${options.outputPath}\n`);
  }
  if (report.measurementStatus !== 'passed') process.exitCode = 1;
  else if (report.routeTargetStatus === 'target-not-met'
      || report.performanceTargetStatus === 'target-not-met') process.exitCode = 2;
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  if (options.action === 'plan') {
    const plan = planFor(options);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\nNo compile, cache reset, upload or serial access was started.\n`);
    return plan;
  }
  return execute(options);
}

module.exports = {
  COMPATIBILITY_CLI_ROUTE,
  CORE_SEEDED_ROUTE,
  DEPENDENCY_EDIT_SEQUENCE,
  GEMMA_SKIP_REASON,
  NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
  NATIVE_RELINK_ROUTE,
  PERFORMANCE_POLICY,
  PLAN_SCHEMA_ID,
  REPORT_SCHEMA_ID,
  SCHEMA_VERSION,
  evaluateTarget,
  evaluateTrial,
  expectedSkipResult,
  finalizeNativeStageRun,
  finalizeRun,
  main,
  observedRouteMode,
  parseArgs,
  planFor,
  performanceSummary,
  routeEvidenceFor,
  targetApplicability,
  validateSequence,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`CK AVR dependency-edit regression: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
