#!/usr/bin/env node
'use strict';

// Compile-only CK/native equivalence runner for generic Arduino library
// topologies.  This deliberately uses synthetic, semantically meaningless
// library names so a passing result cannot be attributed to a production
// library allow-list.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dependency = require('./Run-CKAvrDependencyEditRegression.cjs');
const fixtures = require('./CKAvrGenericLibraryTopologyFixtures.cjs');
const matrix = require('./Run-CKAvrRegressionMatrix.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const REPORT_SCHEMA_ID = 'ck.avr.generic-library-topology-regression-report';
const PLAN_SCHEMA_ID = 'ck.avr.generic-library-topology-regression-plan';
const SCHEMA_VERSION = 2;
const DEFAULT_TIMEOUT_MINUTES = 10;
const DEFAULT_MIN_FREE_GIB = 8;
const CCDB_ORDER_EVIDENCE_SCHEMA_ID = 'ck.avr.ccdb-library-tu-order-evidence';
const CCDB_ORDER_EVIDENCE_SCHEMA_VERSION = 1;
const CCDB_MAX_BYTES = 16 * 1024 * 1024;
const CCDB_MAX_ENTRIES = 4096;
const PERFORMANCE_POLICY = Object.freeze({
  id: 'ck-avr-generic-library-topology-performance-v1',
  minimumMedianSpeedupPct: 25,
  minimumAbsoluteMedianGainMs: 500,
  aggregation: 'median',
  initialColdStageRecordedOnly: true,
  formalRecommendedTrials: 5,
  certification: false,
});

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function targetById(id) {
  const target = matrix.AVR_TARGETS.find((candidate) => candidate.id === id);
  if (!target) throw new Error(`unknown AVR target: ${id}`);
  return target;
}

function parseArgs(argv) {
  const options = {
    action: null,
    target: targetById('uno'),
    trials: 1,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    outputPath: null,
    allowCacheReset: false,
    allowFixtureInstall: false,
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
    else if (argument === '--target') options.target = targetById(argv[++index]);
    else if (argument === '--trials') options.trials = parseInteger(argv[++index], '--trials', 1, 5);
    else if (argument === '--timeout-minutes') {
      options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    } else if (argument === '--min-free-gib') {
      options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 8, 100);
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value) throw new Error('--output requires a JSON file');
      options.outputPath = path.resolve(process.cwd(), value);
    } else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--allow-fixture-install') options.allowFixtureInstall = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --execute');
  if (options.action === 'plan') {
    if (options.outputPath || options.allowCacheReset || options.allowFixtureInstall || options.keepWorkdir) {
      throw new Error('--plan is read-only and cannot accept execution flags');
    }
  } else {
    if (!options.outputPath || path.extname(options.outputPath).toLowerCase() !== '.json') {
      throw new Error('--execute requires --output <new.json>');
    }
    if (fs.existsSync(options.outputPath)) throw new Error(`refusing to overwrite report: ${options.outputPath}`);
    if (!options.allowCacheReset) throw new Error('--execute requires explicit --allow-cache-reset');
    if (!options.allowFixtureInstall) throw new Error('--execute requires explicit --allow-fixture-install');
  }
  return options;
}

function usage() {
  return `CK AVR generic Arduino-library topology regression

Usage:
  node scripts/Run-CKAvrGenericLibraryTopologyRegression.cjs --plan [--target uno]
  node scripts/Run-CKAvrGenericLibraryTopologyRegression.cjs --execute \\
    --allow-cache-reset --allow-fixture-install --output <new.json> [options]

The positive matrix is compile-only and installs four no-clobber, marker-owned
fixture libraries under CK's managed sketchbook for the duration of the run.
It never uploads firmware or opens a serial port. Archive/precompiled/ldflags
cells are policy-only negative cases and must use a clean Arduino CLI fallback.
`;
}

function stagePlan(stage) {
  const { code, ...withoutCode } = stage;
  return {
    ...withoutCode,
    sourceBytes: Buffer.byteLength(code, 'utf8'),
  };
}

function planFor(options) {
  if (!fixtures.validateTopologyDefinition()) throw new Error('generic topology fixture definition is invalid');
  const fixture = fixtures.fixtureManifest();
  const sequence = fixtures.TOPOLOGY_SEQUENCE.map(stagePlan);
  return {
    schemaId: PLAN_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    compileOnly: true,
    uploadPerformed: false,
    serialPortAccessed: false,
    fixtureInstallIsTemporary: true,
    fixtureNoClobber: true,
    fixtureOwnershipMarkerRequired: true,
    target: options.target,
    trials: options.trials,
    pairedStageCount: options.trials * sequence.length,
    compileCount: options.trials * sequence.length * 2,
    topologyManifest: fixture,
    topologyManifestSha256: fixture.manifestSha256,
    sequence,
    routePolicy: {
      id: 'ck-avr-generic-library-topology-route-v1',
      initialColdRecordedOnly: true,
      dependencyChange: dependency.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
      includeOrderChange: dependency.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
      sameGraphEdit: dependency.NATIVE_RELINK_ROUTE,
      exactForbidden: true,
      unsafeFallbackForbidden: true,
    },
    equivalencePolicy: {
      id: 'ck-avr-generic-library-topology-equivalence-v1',
      sourceSha256: true,
      flashAndRamBytes: true,
      avrHexByRoleAndSha256: true,
      avrEepromByRoleAndSha256: true,
      ccdbLibraryTuOrder: 'first-library-occurrence-plus-sealed-tu-membership-not-link-order',
      ccdbSourceObjectBinding: 'one-source-to-one-object',
      exactRestoreToAddStage: true,
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

function pathIsWithinOrEqual(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ordinaryRealDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary directory`);
  }
  return fs.realpathSync.native(resolved);
}

function ordinaryRealFile(file, label, { nonempty = true } = {}) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || (nonempty && stat.size <= 0)) {
    throw new Error(`${label} must be an ordinary${nonempty ? ' non-empty' : ''} file`);
  }
  return { real: fs.realpathSync.native(resolved), stat };
}

function resolveCcdbPath(value, directory, label) {
  if (typeof value !== 'string' || value.trim().length === 0 || value.includes('\0')) {
    throw new Error(`${label} is missing or invalid`);
  }
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1) : value;
  return path.resolve(directory, unquoted);
}

function ccdbOutputPath(entry, directory, entryIndex) {
  if (!Array.isArray(entry.arguments) || entry.arguments.length < 4
      || entry.arguments.some((argument) => typeof argument !== 'string')) {
    throw new Error(`compile_commands.json fixture entry ${entryIndex} requires arguments form`);
  }
  const outputIndexes = [];
  for (let index = 0; index < entry.arguments.length; index += 1) {
    if (entry.arguments[index] === '-o') outputIndexes.push(index);
  }
  if (outputIndexes.length !== 1 || outputIndexes[0] + 1 >= entry.arguments.length) {
    throw new Error(`compile_commands.json fixture entry ${entryIndex} must bind exactly one -o object`);
  }
  const output = resolveCcdbPath(
    entry.arguments[outputIndexes[0] + 1], directory,
    `compile_commands.json fixture entry ${entryIndex} object`,
  );
  if (entry.output != null) {
    const declared = resolveCcdbPath(
      entry.output, directory, `compile_commands.json fixture entry ${entryIndex} output`,
    );
    if (normalizedPath(declared) !== normalizedPath(output)) {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} output disagrees with -o`);
    }
  }
  return output;
}

function inspectCcdbLibraryTuOrder(buildPath, librariesRoot) {
  const build = ordinaryRealDirectory(buildPath, 'CCDB build root');
  const fixtureParent = ordinaryRealDirectory(librariesRoot, 'fixture libraries root');
  const ccdbPath = path.join(build, 'compile_commands.json');
  const ccdbFile = ordinaryRealFile(ccdbPath, 'compile_commands.json');
  if (path.dirname(ccdbFile.real) !== build || ccdbFile.stat.size > CCDB_MAX_BYTES) {
    throw new Error('compile_commands.json escaped the build root or exceeded the size bound');
  }
  const ccdbBytes = fs.readFileSync(ccdbFile.real);
  let entries;
  try {
    entries = JSON.parse(ccdbBytes.toString('utf8'));
  } catch (error) {
    throw new Error(`compile_commands.json is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > CCDB_MAX_ENTRIES) {
    throw new Error('compile_commands.json must be a non-empty bounded array');
  }

  const expectedSources = new Map();
  for (const library of fixtures.LIBRARIES) {
    const root = ordinaryRealDirectory(path.join(fixtureParent, library.name), `${library.name} root`);
    if (path.dirname(root) !== fixtureParent) throw new Error(`${library.name} escaped fixture root`);
    for (const sourceRelativePath of library.translationUnits) {
      const sourcePath = path.join(root, ...sourceRelativePath.split('/'));
      const sourceFile = ordinaryRealFile(sourcePath, `${library.name}/${sourceRelativePath}`);
      if (!pathIsWithinOrEqual(sourceFile.real, root)) {
        throw new Error(`${library.name}/${sourceRelativePath} escaped its library root`);
      }
      const expectedContent = library.files[sourceRelativePath];
      const observedContent = fs.readFileSync(sourceFile.real);
      if (sourceFile.stat.size !== Buffer.byteLength(expectedContent, 'utf8')
          || fixtures.sha256Bytes(observedContent) !== fixtures.sha256Bytes(expectedContent)) {
        throw new Error(`${library.name}/${sourceRelativePath} differs from the sealed fixture`);
      }
      expectedSources.set(normalizedPath(sourceFile.real), {
        library: library.name,
        sourceRelativePath,
        language: path.extname(sourceRelativePath).toLowerCase() === '.c' ? 'c' : 'cpp',
        sourceBytes: sourceFile.stat.size,
        sourceSha256: fixtures.sha256Bytes(observedContent),
      });
    }
  }

  const allowedWorkingRoots = [REPO_ROOT, process.cwd(), build]
    .map((directory) => ordinaryRealDirectory(directory, 'CCDB working root'));
  const sourceKeys = new Set();
  const objectKeys = new Set();
  const rawCcdbEntryOrderedTUs = [];
  for (const [entryIndex, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) {
      throw new Error(`compile_commands.json entry ${entryIndex} is not an object`);
    }
    const directory = ordinaryRealDirectory(entry.directory, `compile_commands.json entry ${entryIndex} directory`);
    const sourceLexical = resolveCcdbPath(
      entry.file, directory, `compile_commands.json entry ${entryIndex} source`,
    );
    let sourceFile;
    try {
      sourceFile = ordinaryRealFile(sourceLexical, `compile_commands.json entry ${entryIndex} source`);
    } catch {
      // A non-fixture stale entry is outside this evidence contract. Expected
      // fixture TUs can never take this branch because their sealed files exist.
      continue;
    }
    const expected = expectedSources.get(normalizedPath(sourceFile.real));
    if (!expected) continue;
    if (!allowedWorkingRoots.some((root) => pathIsWithinOrEqual(directory, root))) {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} has an uncontrolled working directory`);
    }
    if (!Array.isArray(entry.arguments)) {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} requires arguments form`);
    }
    const sourceArgumentCount = entry.arguments.filter((argument) => {
      if (typeof argument !== 'string' || argument.startsWith('-') || argument.startsWith('@')) return false;
      try {
        const candidate = resolveCcdbPath(argument, directory, 'CCDB source argument');
        if (!fs.existsSync(candidate)) return false;
        return normalizedPath(fs.realpathSync.native(candidate)) === normalizedPath(sourceFile.real);
      } catch {
        return false;
      }
    }).length;
    if (sourceArgumentCount !== 1) {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} must bind its source exactly once`);
    }
    const outputLexical = ccdbOutputPath(entry, directory, entryIndex);
    if (!pathIsWithinOrEqual(outputLexical, build)) {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} object escaped the build root`);
    }
    const outputFile = ordinaryRealFile(outputLexical, `compile_commands.json fixture entry ${entryIndex} object`);
    if (!pathIsWithinOrEqual(outputFile.real, build) || path.extname(outputFile.real).toLowerCase() !== '.o') {
      throw new Error(`compile_commands.json fixture entry ${entryIndex} object is not a controlled .o file`);
    }
    const sourceKey = normalizedPath(sourceFile.real);
    const objectKey = normalizedPath(outputFile.real);
    if (sourceKeys.has(sourceKey) || objectKeys.has(objectKey)) {
      throw new Error('compile_commands.json fixture source/object bindings are not one-to-one');
    }
    sourceKeys.add(sourceKey);
    objectKeys.add(objectKey);
    rawCcdbEntryOrderedTUs.push({
      ...expected,
      objectRelativePath: path.relative(build, outputFile.real).replaceAll('\\', '/'),
      objectBytes: outputFile.stat.size,
      objectSha256: fixtures.sha256Bytes(fs.readFileSync(outputFile.real)),
      ccdbEntryIndex: entryIndex,
    });
  }
  // Arduino CLI schedules a library's translation units on multiple workers;
  // Database.Add therefore makes raw same-library CCDB entry order racy. Keep
  // the raw order as evidence, but normalize only inside each first-seen
  // library group using the sealed fixture manifest. Cross-library first
  // occurrence order remains observed and gated.
  const observedLibraryOrder = [];
  const observedByLibrary = new Map();
  for (const unit of rawCcdbEntryOrderedTUs) {
    if (!observedByLibrary.has(unit.library)) {
      observedByLibrary.set(unit.library, new Map());
      observedLibraryOrder.push(unit.library);
    }
    observedByLibrary.get(unit.library).set(unit.sourceRelativePath, unit);
  }
  const normalizedOrderedTUs = observedLibraryOrder.flatMap((libraryName) => {
    const library = fixtures.LIBRARIES.find((candidate) => candidate.name === libraryName);
    const observed = observedByLibrary.get(libraryName);
    return library.translationUnits
      .filter((sourceRelativePath) => observed.has(sourceRelativePath))
      .map((sourceRelativePath) => observed.get(sourceRelativePath));
  });
  return {
    schemaId: CCDB_ORDER_EVIDENCE_SCHEMA_ID,
    schemaVersion: CCDB_ORDER_EVIDENCE_SCHEMA_VERSION,
    rawOrderSemantics: 'compile-commands-json-entry-order-not-link-order',
    normalizedOrderSemantics: 'ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order',
    sourceObjectBinding: 'one-source-to-one-object',
    ccdbRelativePath: 'compile_commands.json',
    ccdbBytes: ccdbFile.stat.size,
    ccdbSha256: fixtures.sha256Bytes(ccdbBytes),
    ccdbEntryCount: entries.length,
    observedLibraryOrder,
    rawCcdbEntryOrderedTUs,
    normalizedOrderedTUs,
    structuralValidationPassed: true,
  };
}

function orderedTuProjection(units) {
  return (units || []).map(({ library, sourceRelativePath, language }) => ({
    library, sourceRelativePath, language,
  }));
}

function ccdbTuOrderEvidence(stage, ck, native) {
  const expected = orderedTuProjection(stage.expectedOrderedTUs);
  const expectedLibraryOrder = [...stage.expectedCcdbObservableLibraryOrder];
  const ckObserved = orderedTuProjection(ck?.ccdbLibraryTuOrder?.normalizedOrderedTUs);
  const nativeObserved = orderedTuProjection(native?.ccdbLibraryTuOrder?.normalizedOrderedTUs);
  const ckObservedLibraryOrder = [...(ck?.ccdbLibraryTuOrder?.observedLibraryOrder || [])];
  const nativeObservedLibraryOrder = [...(native?.ccdbLibraryTuOrder?.observedLibraryOrder || [])];
  const exact = (observed) => fixtures.canonicalJson(observed) === fixtures.canonicalJson(expected);
  const librariesExact = (observed) => (
    fixtures.canonicalJson(observed) === fixtures.canonicalJson(expectedLibraryOrder)
  );
  return {
    semantics: 'ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order',
    expectedCcdbObservableLibraryOrder: expectedLibraryOrder,
    ckObservedLibraryOrder,
    nativeObservedLibraryOrder,
    expectedOrderedTUs: expected,
    ckObservedOrderedTUs: ckObserved,
    nativeObservedOrderedTUs: nativeObserved,
    ckExact: exact(ckObserved),
    nativeExact: exact(nativeObserved),
    ckLibraryOrderExact: librariesExact(ckObservedLibraryOrder),
    nativeLibraryOrderExact: librariesExact(nativeObservedLibraryOrder),
    passed: exact(ckObserved) && exact(nativeObserved)
      && librariesExact(ckObservedLibraryOrder) && librariesExact(nativeObservedLibraryOrder),
  };
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

function fallbackEvidence(buildMode, log) {
  const normalizedMode = String(buildMode || '').toLowerCase();
  const normalizedLog = String(log || '').toLowerCase();
  return {
    used: normalizedMode.includes('fallback') || normalizedLog.includes('falling back'),
    buildMode: buildMode || null,
  };
}

function validateCompilerEvidence(diagnostics, log, stageId, expectedJobs) {
  if (diagnostics?.buildMode === 'exact-match' || diagnostics?.cache?.exactMatch === true) {
    throw new Error(`CK ${stageId} returned Exact; topology regression requires compilation`);
  }
  if (diagnostics?.profile !== 'release') throw new Error(`CK ${stageId} is not a Release compile`);
  const match = String(log || '').match(/\[INFO\] Compile parallel jobs:\s*(\d+)/u);
  const observedJobs = match ? Number(match[1]) : expectedJobs;
  if (observedJobs !== expectedJobs) throw new Error(`CK jobs=${observedJobs} differs from native jobs=${expectedJobs}`);
  return observedJobs;
}

async function runCkCompile(
  evaluate, fqbn, stage, targetId, timeoutMs, expectedJobs, librariesRoot,
) {
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
        workspaceFingerprint: ${JSON.stringify(stage.sourceSha256)},
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
  const jobs = validateCompilerEvidence(diagnostics, parsed.log, stage.id, expectedJobs);
  const artifacts = forge.inspectCkArtifacts(parsed, forge.nativeRelinkAdapterFor(fqbn));
  const buildPath = fs.realpathSync.native(parsed.path);
  const ccdbLibraryTuOrder = inspectCcdbLibraryTuOrder(buildPath, librariesRoot);
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
        ? diagnostics.cache.nativeRelinkDiagnostics.slice(0, 24) : [],
    },
    jobs,
    fqbn: diagnostics.fqbn || null,
    toolchainKey: diagnostics.environment?.toolchainKey || null,
    cliVersion: diagnostics.environment?.cliVersion || null,
    codeSha256: stage.sourceSha256,
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
    buildPathIdentitySha256: forge.sha256Bytes(normalizedPath(buildPath)),
    ccdbLibraryTuOrder,
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
  if (!result?.ok) throw new Error(`CK cache reset failed: ${result?.error || 'unknown error'}`);
  const validation = forge.validateCacheClear(result.value, fqbn);
  if (!validation.passed) throw new Error(`CK cache reset evidence failed: ${validation.failures.join('; ')}`);
  return result.value;
}

async function laneBoundary(lane) {
  const evidence = await forge.waitForArduinoCliIdleWindow({
    idleWindowMs: forge.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
    timeoutMs: forge.ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
    pollIntervalMs: forge.ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
    policyId: forge.ARDUINO_CLI_LANE_IDLE_POLICY_ID,
    phaseLabel: `${lane} generic-topology lane`,
  });
  return { lane, ...evidence };
}

function routeEvidence(run, stage) {
  const evidence = dependency.routeEvidenceFor(run, {
    ...stage,
    preferredRoute: stage.expectedRoute,
  });
  return {
    ...evidence,
    expectedMode: stage.expectedRoute,
    passed: stage.transitionKind === 'initial-cold'
      ? evidence.safe === true
      : evidence.safe === true && evidence.observedMode === stage.expectedRoute && evidence.preferred === true,
  };
}

function stageEquivalence(stage, ck, native) {
  return {
    source: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === stage.sourceSha256,
    resources: forge.resourcesEquivalent(ck.resources, native.resources),
    artifacts: forge.compareAvrArtifactRoles(ck.artifacts, native.artifacts),
    ccdbLibraryTuOrder: ccdbTuOrderEvidence(stage, ck, native),
  };
}

function laneRestoration(stages, lane) {
  const add = stages.find((stage) => stage.id === 'add-topology')?.[lane];
  const restore = stages.find((stage) => stage.id === 'restore')?.[lane];
  if (!add || !restore) return { source: false, resources: false, artifacts: { passed: false } };
  return {
    source: add.codeSha256 === restore.codeSha256,
    resources: forge.resourcesEquivalent(add.resources, restore.resources),
    artifacts: forge.compareAvrArtifactRoles(add.artifacts, restore.artifacts),
    ccdbLibraryTuOrder: {
      semantics: 'ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order',
      exact: fixtures.canonicalJson(orderedTuProjection(add.ccdbLibraryTuOrder?.normalizedOrderedTUs))
        === fixtures.canonicalJson(orderedTuProjection(restore.ccdbLibraryTuOrder?.normalizedOrderedTUs)),
    },
  };
}

function evaluateTrial(trial) {
  const stageEquivalencePassed = trial.stages.every((stage) => (
    stage.equivalence?.source === true
    && stage.equivalence?.resources === true
    && stage.equivalence?.artifacts?.passed === true
    && stage.equivalence?.ccdbLibraryTuOrder?.passed === true
  ));
  const routePassed = trial.stages.every((stage) => stage.routeEvidence?.passed === true);
  const ckPaths = new Set(trial.stages.map((stage) => stage.ck.buildPathIdentitySha256));
  const nativePaths = new Set(trial.stages.map((stage) => stage.native.buildPathIdentitySha256));
  const stableBuildPaths = ckPaths.size === 1 && nativePaths.size === 1;
  const restoration = {
    ck: laneRestoration(trial.stages, 'ck'),
    native: laneRestoration(trial.stages, 'native'),
  };
  restoration.passed = ['ck', 'native'].every((lane) => (
    restoration[lane].source
    && restoration[lane].resources
    && restoration[lane].artifacts.passed
    && restoration[lane].ccdbLibraryTuOrder.exact
  ));
  return {
    passed: stageEquivalencePassed && routePassed && stableBuildPaths
      && restoration.passed && trial.failures.length === 0,
    stageEquivalencePassed,
    routePassed,
    stableBuildPaths,
    restoration,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 === 1
    ? sorted[middle]
    : (sorted[middle - 1] + sorted[middle]) / 2;
}

// The first appearance of a library graph necessarily compiles its objects;
// it is recorded for diagnosis but never used to claim fast performance. Every
// later topology edit must clear the same speed gate used by dependency edits.
function evaluatePerformanceTarget(trials) {
  const stages = fixtures.TOPOLOGY_SEQUENCE.map((stage) => {
    const ckRawMs = trials.map((trial) => Number(trial.stages.find((candidate) => candidate.id === stage.id)?.ck?.wallMs));
    const nativeRawMs = trials.map((trial) => Number(trial.stages.find((candidate) => candidate.id === stage.id)?.native?.wallMs));
    const ckMedianMs = median(ckRawMs);
    const nativeMedianMs = median(nativeRawMs);
    const recordedOnly = stage.transitionKind === 'initial-cold';
    const optimizedRouteRequired = !recordedOnly;
    const optimizedRoutePassed = recordedOnly || trials.every((trial) => (
      trial.stages.find((candidate) => candidate.id === stage.id)?.routeEvidence?.passed === true
      && trial.stages.find((candidate) => candidate.id === stage.id)?.routeEvidence?.preferred === true
    ));
    const medianGainMs = ckMedianMs == null || nativeMedianMs == null
      ? null : nativeMedianMs - ckMedianMs;
    const ckSpeedupPctVsNative = ckMedianMs == null || nativeMedianMs == null || nativeMedianMs <= 0
      ? null : ((nativeMedianMs - ckMedianMs) / nativeMedianMs) * 100;
    const passed = recordedOnly
      ? null
      : ckMedianMs != null && nativeMedianMs != null
        && optimizedRoutePassed
        && ckSpeedupPctVsNative >= PERFORMANCE_POLICY.minimumMedianSpeedupPct
        && medianGainMs >= PERFORMANCE_POLICY.minimumAbsoluteMedianGainMs;
    return {
      id: stage.id,
      transitionKind: stage.transitionKind,
      recordedOnly,
      optimizedRouteRequired,
      optimizedRoutePassed,
      ckRawMs,
      nativeRawMs,
      ckMedianMs,
      nativeMedianMs,
      ckSpeedupPctVsNative,
      medianGainMs,
      passed,
    };
  });
  const optimizedStages = stages.filter((stage) => !stage.recordedOnly);
  const passed = optimizedStages.length > 0 && optimizedStages.every((stage) => stage.passed === true);
  return {
    policy: PERFORMANCE_POLICY,
    trialCount: trials.length,
    formalTrialCount: trials.length >= PERFORMANCE_POLICY.formalRecommendedTrials,
    stages,
    passed,
    status: passed ? 'target-met' : 'target-not-met',
    note: trials.length < PERFORMANCE_POLICY.formalRecommendedTrials
      ? `Exploratory ${trials.length}-trial evidence; ${PERFORMANCE_POLICY.formalRecommendedTrials} trials are recommended for formal review.`
      : null,
  };
}

function safeTrialPath(workRoot, trialId) {
  const candidate = path.join(workRoot, 'trials', trialId);
  const relative = path.relative(workRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('trial path escaped work root');
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
  const librariesRoot = path.join(REPO_ROOT, 'sketchbook', 'libraries');
  const runToken = crypto.randomBytes(16).toString('hex');
  const productionBefore = forge.inspectProductionExecutable();
  const report = {
    schemaId: REPORT_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    startedAt: new Date().toISOString(),
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      qualificationClaimed: false,
      fixtureInstallAuthorized: true,
      fixtureNoClobber: true,
      oneCacheResetPerTrial: true,
      stableBuildPathPerLane: true,
      sequentialNoConcurrentCompiles: true,
      routePolicy: plan.routePolicy,
      equivalencePolicy: plan.equivalencePolicy,
    },
    planSha256: forge.digestObject(plan),
    target: plan.target,
    identity: null,
    trials: [],
    performanceTarget: null,
    failures: [],
    topologyManifest: null,
    topologyManifestSha256: plan.topologyManifestSha256,
    fixtureLifecycle: { installed: false, audited: false, cleaned: false, removed: [], remaining: [] },
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
  let cdp;
  try {
    report.topologyManifest = fixtures.materializeLibraries(librariesRoot, runToken);
    report.fixtureLifecycle.installed = true;
    report.fixtureLifecycle.audited = true;
    if (report.topologyManifest.manifestSha256 !== plan.topologyManifestSha256) {
      throw new Error('installed topology manifest differs from the sealed plan');
    }
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
    const nativeBaselineConfig = forge.nativeBaselineContract(null);
    report.identity = forge.inspectCliAndCore(
      options.target.fqbn,
      nativeBaselineConfig.cliConfigPath,
    );
    if (String(report.identity.coreArchitecture).toLowerCase() !== 'avr') {
      throw new Error(`resolved architecture ${report.identity.coreArchitecture} is not AVR`);
    }
    const nativeBaseline = forge.nativeBaselineContract(null, report.identity);

    for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
      const trialId = `trial-${String(trialIndex + 1).padStart(3, '0')}`;
      const trial = { id: trialId, cacheReset: null, stages: [], failures: [], result: null };
      report.trials.push(trial);
      trial.cacheReset = await clearCkCache(cdp.evaluate, options.target.fqbn, timeoutMs);
      const nativeContext = forge.createNativeTrial(
        safeTrialPath(workRoot, trialId),
        trialId,
        options.target.fqbn,
        jobs,
        fixtures.TOPOLOGY_SEQUENCE[0].code,
        nativeBaseline,
      );
      for (const [stageIndex, stage] of fixtures.TOPOLOGY_SEQUENCE.entries()) {
        const order = (trialIndex + stageIndex) % 2 === 0 ? ['ck', 'native'] : ['native', 'ck'];
        const row = {
          id: stage.id,
          expectedRoute: stage.expectedRoute,
          directLibraries: [...stage.directLibraries],
          expectedLibrarySet: [...stage.expectedLibrarySet],
          expectedOrderedLibraries: [...stage.expectedOrderedLibraries],
          expectedCcdbObservableLibraryOrder: [...stage.expectedCcdbObservableLibraryOrder],
          expectedOrderedTUs: stage.expectedOrderedTUs.map((unit) => ({ ...unit })),
          ccdbOrderSemantics: 'ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order',
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
            row.ck = await runCkCompile(
              cdp.evaluate, options.target.fqbn, stage, options.target.id, timeoutMs, jobs,
              librariesRoot,
            );
          } else {
            forge.updateNativeTrialSource(nativeContext, stage.code);
            const native = await forge.runNativeCompile(
              nativeContext,
              stageIndex === 0 ? 'simple' : stage.id,
              options.target.id,
              timeoutMs,
            );
            row.native = dependency.finalizeNativeStageRun({
              ...native,
              ccdbLibraryTuOrder: inspectCcdbLibraryTuOrder(
                nativeContext.buildPath, librariesRoot,
              ),
            }, options.target.id, stage.id);
          }
          row.laneBoundaryIdle.push(await laneBoundary(lane));
        }
        row.equivalence = stageEquivalence(stage, row.ck, row.native);
        row.routeEvidence = routeEvidence(row.ck, stage);
        trial.stages.push(row);
      }
      trial.result = evaluateTrial(trial);
      if (!trial.result.passed) report.failures.push(`${trialId}: topology equivalence or route gate failed`);
    }
  } catch (error) {
    report.failures.push(String(error?.stack || error));
  } finally {
    if (cdp) {
      try { await clearCkCache(cdp.evaluate, options.target.fqbn, timeoutMs); } catch (error) {
        report.failures.push(`final cache cleanup: ${error?.message || error}`);
      }
    }
    cdp?.socket.close();
    try {
      if (report.fixtureLifecycle.installed) {
        const cleanup = fixtures.cleanupMaterializedLibraries(librariesRoot, runToken);
        report.fixtureLifecycle.cleaned = cleanup.remaining.length === 0;
        report.fixtureLifecycle.removed = cleanup.removed;
        report.fixtureLifecycle.remaining = cleanup.remaining;
        if (!report.fixtureLifecycle.cleaned) report.failures.push('temporary topology fixtures remain');
      }
    } catch (error) {
      report.failures.push(`fixture cleanup failed: ${error?.message || error}`);
    }
    try {
      report.disk.freeBytesAfterCapture = forge.assertFreeSpace(workRoot, options.minFreeGiB);
      report.disk.cleanup = forge.inspectOwnedWorkdir(workRoot);
      if (!options.keepWorkdir) {
        forge.safeRemoveWorkdir(workRoot);
        if (fs.existsSync(workRoot)) throw new Error('runner-owned work directory remains');
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
    try {
      const after = forge.inspectProductionExecutable();
      report.productionExecutable.after = after;
      report.productionExecutable.unchanged = forge.digestObject(productionBefore) === forge.digestObject(after);
      if (!report.productionExecutable.unchanged) report.failures.push('production executable/process changed');
    } catch (error) {
      report.failures.push(`production identity finalization failed: ${error?.message || error}`);
    }
    report.finishedAt = new Date().toISOString();
    report.performanceTarget = evaluatePerformanceTarget(report.trials);
    report.status = report.failures.length === 0
      && report.trials.length === options.trials
      && report.trials.every((trial) => trial.result?.passed === true)
      && report.performanceTarget.passed === true
      && report.fixtureLifecycle.cleaned === true
      ? 'passed' : 'failed';
    writeJsonNoClobber(options.outputPath, report);
    process.stdout.write(`REPORT ${options.outputPath}\n`);
  }
  if (report.status !== 'passed') process.exitCode = 1;
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
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\nNo compile, cache reset, fixture install, upload or serial access was started.\n`);
    return plan;
  }
  return execute(options);
}

module.exports = {
  PLAN_SCHEMA_ID,
  REPORT_SCHEMA_ID,
  SCHEMA_VERSION,
  ccdbTuOrderEvidence,
  evaluateTrial,
  evaluatePerformanceTarget,
  inspectCcdbLibraryTuOrder,
  main,
  parseArgs,
  planFor,
  routeEvidence,
  stageEquivalence,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`CK AVR generic topology regression: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
