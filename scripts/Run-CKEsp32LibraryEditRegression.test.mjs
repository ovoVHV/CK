import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('./Run-CKEsp32LibraryEditRegression.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKEsp32LibraryEditRegression.cjs'), 'utf8',
);
const CANDIDATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKEsp32LibraryEditCandidate.ps1'), 'utf8',
);

test('plan separates graph-establishing records from the two gated same-graph edits', () => {
  const plan = runner.planFor(runner.parseArgs([
    '--plan', '--fqbn', 'esp32:esp32:esp32c6', '--trials', '5',
  ]));
  assert.equal(plan.schemaId, runner.PLAN_SCHEMA_ID);
  assert.equal(plan.compileOnly, true);
  assert.equal(plan.uploadPerformed, false);
  assert.equal(plan.serialPortAccessed, false);
  assert.equal(plan.trials, 5);
  assert.equal(plan.pairedStageCount, 20);
  assert.equal(plan.compileCount, 40);
  assert.deepEqual(plan.sequence.map((stage) => stage.id), [
    'third-party-cold',
    'third-party-same-graph-edit',
    'core-library-cold',
    'core-library-same-graph-edit',
  ]);
  assert.deepEqual(plan.sequence.map((stage) => stage.performanceRequired), [false, true, false, true]);
  assert.deepEqual(plan.sequence.filter((stage) => stage.performanceRequired)
    .map((stage) => stage.preferredRoute), [
    'native-relink-compile-only', 'native-relink-compile-only',
  ]);
  assert.equal(plan.performancePolicy.minimumMedianSpeedupPct, 20);
  assert.equal(plan.performancePolicy.minimumAbsoluteMedianGainMs, 500);
  assert.equal(plan.performancePolicy.formalRecommendedTrials, 5);
  assert.equal(plan.adapter.id, 'esp32-esp32c6-native-relink-v1');
  assert.equal(plan.routePolicy.qualificationProbeEvidenceRequired, true);
  assert.equal(plan.routePolicy.structuredNativeRelinkEvidenceRequired, true);
  assert.equal(
    plan.equivalencePolicy.nativeRelinkEvidenceContract,
    runner.ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT,
  );
  assert.equal(plan.routePolicy.certifiedProductRouteCannotQualifyThisProbe, true);
  assert.equal(plan.reproducibility.requiredAtExecution, true);
});

test('fixture is ESP32-specific, mixed C/C++, nested and marker-owned', () => {
  assert.equal(runner.validateFixtureDefinition(), true);
  const manifest = runner.fixtureManifest();
  assert.deepEqual(manifest.architectures, ['esp32']);
  assert.equal(manifest.shape, 'modern-src-deep-mixed-c-cpp');
  assert.deepEqual(manifest.translationUnits.map((unit) => unit.language), ['cpp', 'c']);
  assert.ok(manifest.translationUnits.some((unit) => unit.sourceRelativePath.includes('/nested/')));
  assert.match(runner.fixtureFiles()['library.properties'], /^architectures=esp32$/mu);

  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-esp32-library-fixture-test-'));
  const librariesRoot = path.join(root, 'libraries');
  fs.mkdirSync(librariesRoot);
  const token = 'a'.repeat(32);
  try {
    const installed = runner.materializeFixture(librariesRoot, token);
    assert.equal(installed.manifestSha256, manifest.manifestSha256);
    assert.throws(() => runner.materializeFixture(librariesRoot, token), /already exists/u);
    assert.deepEqual(runner.cleanupFixture(librariesRoot, token), { removed: true, remaining: false });
    runner.materializeFixture(librariesRoot, token);
    const unexpected = path.join(librariesRoot, runner.FIXTURE_NAME, 'unexpected.txt');
    fs.writeFileSync(unexpected, 'not marker-owned');
    assert.throws(() => runner.recoverOwnedFixture(librariesRoot), /file set differs/u);
    fs.unlinkSync(unexpected);
    assert.deepEqual(runner.recoverOwnedFixture(librariesRoot), { recovered: true, remaining: false });
    assert.deepEqual(runner.recoverOwnedFixture(librariesRoot), { recovered: false, remaining: false });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('execution needs explicit mutation authority and remains no-clobber', () => {
  assert.throws(
    () => runner.parseArgs(['--execute', '--output', 'new.json']),
    /allow-cache-reset/u,
  );
  assert.throws(
    () => runner.parseArgs(['--execute', '--allow-cache-reset', '--output', 'new.json']),
    /allow-fixture-install/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--allow-cache-reset']),
    /read-only/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--fqbn', 'arduino:avr:uno']),
    /ESP32 package FQBN/u,
  );
  const forbiddenOutput = path.join(ROOT, 'sketchbook', 'libraries', runner.FIXTURE_NAME, 'report.json');
  assert.throws(() => runner.parseArgs([
    '--execute', '--allow-cache-reset', '--allow-fixture-install', '--output', forbiddenOutput,
  ]), /managed mutation root/u);
  const packageOutput = path.join(ROOT, 'packages', 'esp32', 'report.json');
  assert.throws(() => runner.parseArgs([
    '--execute', '--allow-cache-reset', '--allow-fixture-install', '--output', packageOutput,
  ]), /managed mutation root/u);
  assert.equal(runner.parseArgs(['--cleanup-owned-fixture']).action, 'cleanup-owned-fixture');
  assert.throws(
    () => runner.parseArgs(['--cleanup-owned-fixture', '--fqbn', 'esp32:esp32:esp32c6']),
    /cannot be combined/u,
  );
});

function backendNativeRelinkEvidence(overrides = {}) {
  return {
    status: 'valid',
    markerCount: 2,
    evidence: {
      schemaVersion: 1,
      evidenceContract: runner.ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT,
      manifestSchemaVersion: 4,
      manifestSha256: 'a'.repeat(64),
      propertyContractSha256: 'b'.repeat(64),
      commandGraphSha256: 'c'.repeat(64),
      libraryTreeSha256: 'd'.repeat(64),
      libraryRootCount: 1,
      libraryFileCount: 5,
      libraryTotalBytes: 4096,
      orderedLinkInputsSha256: 'e'.repeat(64),
      nativeLinkArgvSha256: 'f'.repeat(64),
      nativeLinkExecutableSha256: '1'.repeat(64),
      nativeLinkResponseGraphSha256: '2'.repeat(64),
      nativeLinkResponseFileCount: 3,
      ...overrides,
    },
  };
}

function validatedNativeRelinkEvidence(overrides = {}) {
  return runner.validateNativeRelinkEvidence({
    cache: { nativeRelinkEvidence: backendNativeRelinkEvidence(overrides) },
  });
}

function ckRun(buildMode, diagnostics = [], fallback = false,
  nativeRelinkEvidence = validatedNativeRelinkEvidence()) {
  return {
    buildMode,
    exactUsed: false,
    structuredRoute: { mode: buildMode },
    cache: { nativeRelinkDiagnostics: diagnostics },
    fallback: { used: fallback },
    nativeRelinkEvidence,
  };
}

test('runner independently validates the complete NativeRelink v4 evidence contract', () => {
  const valid = validatedNativeRelinkEvidence();
  assert.equal(valid.passed, true);
  assert.equal(valid.policyId, runner.ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID);
  assert.equal(valid.evidence.nativeLinkResponseFileCount, 3);

  const missingExecutable = backendNativeRelinkEvidence();
  delete missingExecutable.evidence.nativeLinkExecutableSha256;
  const missing = runner.validateNativeRelinkEvidence({
    cache: { nativeRelinkEvidence: missingExecutable },
  });
  assert.equal(missing.passed, false);
  assert.ok(missing.failures.includes('evidence-shape'));

  const malformed = validatedNativeRelinkEvidence({ nativeLinkArgvSha256: 'NOT-A-SHA' });
  assert.equal(malformed.passed, false);
  assert.ok(malformed.failures.includes('nativeLinkArgvSha256-malformed'));

  const wrongContract = validatedNativeRelinkEvidence({
    evidenceContract: 'ck-esp32-library-relink-evidence-v3',
  });
  assert.equal(wrongContract.passed, false);
  assert.ok(wrongContract.failures.includes('evidence-contract'));
});

test('runner parses granular NativeRelink evidence timings without guessing missing fields', () => {
  const timing = runner.parseNativeRelinkTiming([
    '[INFO] NativeRelinkCompileOnly path: ESP32 Release sketch compile',
    '[Timing DIAG] ESP32 NativeRelink sketch=3712ms link=14987ms artifacts=4821ms size=51ms total=37890ms',
    '[Timing DIAG] ESP32 NativeRelink evidence prepareTotal=8123ms prepareCapture=7012ms preLinkRefresh=6543ms linkerSpawn=14987ms finalRefreshCommit=6234ms',
  ].join('\n'));
  assert.deepEqual(timing, {
    schemaVersion: 1,
    prepareTotalMs: 8123,
    prepareCaptureMs: 7012,
    preLinkRefreshMs: 6543,
    sketchCompileMs: 3712,
    linkerSpawnMs: 14987,
    artifactsMs: 4821,
    sizeMs: 51,
    finalRefreshCommitMs: 6234,
    executeTotalMs: 37890,
  });
  assert.equal(runner.parseNativeRelinkTiming('no timing evidence'), null);
  assert.equal(runner.parseNativeRelinkTiming(
    '[Timing DIAG] ESP32 NativeRelink evidence prepareTotal=1ms linkerSpawn=2ms',
  ), null);
  assert.equal(runner.parseNativeRelinkTiming(
    '[Timing DIAG] ESP32 NativeRelink evidence prepareTotal=-1ms prepareCapture=1ms preLinkRefresh=1ms linkerSpawn=1ms finalRefreshCommit=1ms',
  ), null);
  assert.equal(runner.parseNativeRelinkTiming([
    '[Timing DIAG] ESP32 NativeRelink sketch=1ms link=2ms artifacts=3ms size=4ms total=5ms',
    '[Timing DIAG] ESP32 NativeRelink evidence prepareTotal=6ms prepareCapture=7ms preLinkRefresh=8ms linkerSpawn=9ms finalRefreshCommit=10ms',
  ].join('\n')), null);
});

test('route policy permits safe graph fallback but never lets it qualify a same-graph edit', () => {
  const cold = runner.LIBRARY_EDIT_SEQUENCE[0];
  const edit = runner.LIBRARY_EDIT_SEQUENCE[1];
  const probeEnabled = 'CK Forge NativeRelinkCompileOnly qualification probe enabled';
  const fallback = ckRun('arduino-cli-incremental-fallback', [probeEnabled], true);
  const coldEvidence = runner.routeEvidence(fallback, cold);
  assert.equal(coldEvidence.safe, true);
  assert.equal(coldEvidence.preferred, null);
  assert.equal(coldEvidence.fallbackAllowedForMeasurement, true);

  const editFallback = runner.routeEvidence(fallback, edit);
  assert.equal(editFallback.safe, true);
  assert.equal(editFallback.preferred, false);
  assert.equal(editFallback.fallbackAllowedForMeasurement, false);

  const optimized = ckRun('native-relink-compile-only', [
    probeEnabled,
    runner.ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER,
    'NativeRelink authorization: qualification-probe',
  ]);
  const optimizedEvidence = runner.routeEvidence(optimized, edit);
  assert.equal(optimizedEvidence.safe, true);
  assert.equal(optimizedEvidence.preferred, true);

  const missingStructuredEvidence = runner.routeEvidence(
    ckRun('native-relink-compile-only', [
      probeEnabled,
      runner.ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER,
      'NativeRelink authorization: qualification-probe',
    ], false, runner.validateNativeRelinkEvidence({ cache: {} })),
    edit,
  );
  assert.equal(missingStructuredEvidence.safe, false);
  assert.equal(missingStructuredEvidence.structuredNativeRelinkEvidence, false);

  const phase1WithV3Evidence = runner.routeEvidence(
    ckRun('native-relink-compile-only', [
      probeEnabled,
      '[INFO] NativeRelinkCompileOnly path: ESP32 Release sketch-only compile + native link + native artifact recipes',
      '[INFO] NativeRelink authorization: qualification-probe',
    ]),
    edit,
  );
  assert.equal(phase1WithV3Evidence.structuredNativeRelinkEvidence, true);
  assert.equal(phase1WithV3Evidence.nativeRelinkPath, true);
  assert.equal(phase1WithV3Evidence.libraryNativeRelinkPath, false);
  assert.equal(phase1WithV3Evidence.safe, false);
  assert.equal(phase1WithV3Evidence.preferred, false);

  const unproved = runner.routeEvidence(
    ckRun('native-relink-compile-only', [probeEnabled, 'NativeRelinkCompileOnly path: ESP32']), edit,
  );
  assert.equal(unproved.safe, false);
  assert.equal(unproved.preferred, false);

  const certifiedInsteadOfProbe = runner.routeEvidence(ckRun('native-relink-compile-only', [
    'NativeRelinkCompileOnly certificate matched',
    'NativeRelinkCompileOnly path: ESP32 Release sketch-only compile',
  ]), edit);
  assert.equal(certifiedInsteadOfProbe.safe, false);
});

test('cold graph stages require an explicit library baseline commit and edits do not', () => {
  const cold = runner.LIBRARY_EDIT_SEQUENCE[0];
  const edit = runner.LIBRARY_EDIT_SEQUENCE[1];
  const committed = runner.graphBaselineEvidence(ckRun('full-build', [
    '[INFO] ESP32 library NativeRelink qualification baseline committed; native object order and library graph are sealed.',
  ]), cold);
  assert.equal(committed.required, true);
  assert.equal(committed.committed, true);
  assert.equal(committed.passed, true);

  const skipped = runner.graphBaselineEvidence(ckRun('full-build', [
    '[WARN] ESP32 library NativeRelink baseline commit skipped; Arduino CLI result remains valid: compiler unavailable',
  ]), cold);
  assert.equal(skipped.required, true);
  assert.equal(skipped.committed, false);
  assert.equal(skipped.passed, false);
  assert.equal(skipped.rejectionReasons.length, 1);

  const sameGraph = runner.graphBaselineEvidence(ckRun('native-relink-compile-only', []), edit);
  assert.equal(sameGraph.required, false);
  assert.equal(sameGraph.committed, null);
  assert.equal(sameGraph.passed, true);
});

test('same-graph evidence keeps sealed argv, executable, response, property and library tree stable', () => {
  const stages = [
    {
      workload: 'third-party',
      ck: { nativeRelinkEvidence: validatedNativeRelinkEvidence({ manifestSha256: '3'.repeat(64) }) },
    },
    {
      workload: 'third-party',
      ck: { nativeRelinkEvidence: validatedNativeRelinkEvidence({ manifestSha256: '4'.repeat(64) }) },
    },
  ];
  const stable = runner.sameGraphNativeRelinkEvidence(stages, 'third-party');
  assert.equal(stable.passed, true);
  assert.equal(stable.manifestChanged, true);

  stages[1].ck.nativeRelinkEvidence = validatedNativeRelinkEvidence({
    manifestSha256: '4'.repeat(64),
    nativeLinkResponseGraphSha256: '5'.repeat(64),
  });
  const drifted = runner.sameGraphNativeRelinkEvidence(stages, 'third-party');
  assert.equal(drifted.passed, false);
  assert.match(drifted.reason, /response or library-tree evidence changed/u);
});

function performanceTrial(editCkMs = 900, editNativeMs = 2_000) {
  return {
    stages: runner.LIBRARY_EDIT_SEQUENCE.map((stage, index) => ({
      id: stage.id,
      ck: { wallMs: stage.performanceRequired ? editCkMs : 20_000 + index },
      native: { wallMs: stage.performanceRequired ? editNativeMs : 10_000 + index },
      routeEvidence: { preferred: stage.performanceRequired ? true : null },
    })),
  };
}

test('performance records both cold graph stages and gates both edits by 20% plus 500ms', () => {
  const exploratory = runner.evaluatePerformance([performanceTrial()]);
  assert.deepEqual(exploratory.stages.map((stage) => stage.recordedOnly), [true, false, true, false]);
  assert.equal(exploratory.stages[0].passed, null);
  assert.equal(exploratory.stages[2].passed, null);
  assert.ok(Math.abs(exploratory.stages[1].ckSpeedupPctVsNative - 55) < 1e-9);
  assert.equal(exploratory.stages[1].medianGainMs, 1_100);
  assert.equal(exploratory.targetMet, true);
  assert.equal(exploratory.qualified, false);
  assert.equal(exploratory.passed, false);
  assert.equal(exploratory.status, 'exploratory-target-met');
  assert.match(exploratory.note, /Exploratory 1-trial/u);

  const passing = runner.evaluatePerformance(Array.from({ length: 5 }, () => performanceTrial()));
  assert.equal(passing.formalTrialCount, true);
  assert.equal(passing.qualified, true);
  assert.equal(passing.passed, true);

  const tooSmall = runner.evaluatePerformance([performanceTrial(1_600, 2_000)]);
  assert.equal(tooSmall.stages[1].medianGainMs, 400);
  assert.equal(tooSmall.stages[1].passed, false);
  assert.equal(tooSmall.passed, false);

  const fallback = performanceTrial();
  fallback.stages[1].routeEvidence.preferred = false;
  assert.equal(runner.evaluatePerformance([fallback]).passed, false);
});

function writeCcdbFixture(root, workload) {
  const librariesRoot = path.join(root, 'libraries');
  const platformRoot = path.join(root, 'packages', 'esp32', 'hardware', 'esp32', '9.9.9');
  const spiRoot = path.join(platformRoot, 'libraries', 'SPI');
  const buildPath = path.join(root, `build-${workload}`);
  fs.mkdirSync(librariesRoot, { recursive: true });
  fs.mkdirSync(path.join(spiRoot, 'src'), { recursive: true });
  fs.mkdirSync(buildPath, { recursive: true });
  const token = 'b'.repeat(32);
  runner.materializeFixture(librariesRoot, token);
  fs.writeFileSync(path.join(spiRoot, 'src', 'SPI.cpp'), 'int ck_spi_fixture = 1;\n');

  const sources = workload === 'third-party'
    ? runner.FIXTURE_TRANSLATION_UNITS.map((relative) => path.join(
      librariesRoot, runner.FIXTURE_NAME, ...relative.split('/'),
    ))
    : [path.join(spiRoot, 'src', 'SPI.cpp')];
  const entries = sources.map((source, index) => {
    const object = path.join(buildPath, 'libraries', workload, `unit-${index}.o`);
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(object, `object-${index}`);
    return {
      directory: buildPath,
      arguments: ['compiler', '-c', source, '-o', object],
      file: source,
    };
  });
  fs.writeFileSync(path.join(buildPath, 'compile_commands.json'), `${JSON.stringify(entries)}\n`);
  return { librariesRoot, platformRoot, buildPath, token, entries };
}

test('CCDB evidence seals third-party and Core-library source/object bindings', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-esp32-library-ccdb-test-'));
  try {
    const thirdParty = writeCcdbFixture(path.join(root, 'third'), 'third-party');
    const fixtureEvidence = runner.inspectCcdbLibraryEvidence(
      thirdParty.buildPath, thirdParty.librariesRoot, thirdParty.platformRoot, 'third-party',
    );
    assert.equal(fixtureEvidence.structuralValidationPassed, true);
    assert.equal(fixtureEvidence.units.length, 2);
    assert.deepEqual(fixtureEvidence.units.map((unit) => unit.language), ['cpp', 'c']);
    assert.equal(runner.ccdbEquivalent(fixtureEvidence, fixtureEvidence).passed, true);

    const core = writeCcdbFixture(path.join(root, 'core'), 'core-library');
    const coreEvidence = runner.inspectCcdbLibraryEvidence(
      core.buildPath, core.librariesRoot, core.platformRoot, 'core-library',
    );
    assert.equal(coreEvidence.units.length, 1);
    assert.equal(coreEvidence.units[0].rootKind, 'core-library');

    const duplicateObject = path.join(thirdParty.buildPath, 'libraries', 'duplicate.o');
    fs.writeFileSync(duplicateObject, 'duplicate');
    fs.writeFileSync(path.join(thirdParty.buildPath, 'compile_commands.json'), JSON.stringify([
      ...thirdParty.entries,
      { ...thirdParty.entries[0], arguments: [
        'compiler', '-c', thirdParty.entries[0].file, '-o', duplicateObject,
      ] },
    ]));
    assert.throws(() => runner.inspectCcdbLibraryEvidence(
      thirdParty.buildPath, thirdParty.librariesRoot, thirdParty.platformRoot, 'third-party',
    ), /one-to-one/u);

    const alienSource = path.join(thirdParty.buildPath, 'alien.cpp');
    fs.writeFileSync(alienSource, 'int alien = 1;\n');
    fs.writeFileSync(path.join(thirdParty.buildPath, 'compile_commands.json'), JSON.stringify([
      { ...thirdParty.entries[0], arguments: [
        'compiler', '-c', alienSource, '-o', thirdParty.entries[0].arguments.at(-1),
      ] },
      thirdParty.entries[1],
    ]));
    assert.throws(() => runner.inspectCcdbLibraryEvidence(
      thirdParty.buildPath, thirdParty.librariesRoot, thirdParty.platformRoot, 'third-party',
    ), /bind its source exactly once/u);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('required ESP32 role gate validates flash_args and rejects DIO/QIO cross-lane drift', () => {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-esp32-artifact-role-test-'));
  try {
    const application = path.join(root, 'probe.ino.bin');
    const bootloader = path.join(root, 'probe.ino.bootloader.bin');
    const partitions = path.join(root, 'probe.ino.partitions.bin');
    const merged = path.join(root, 'probe.ino.merged.bin');
    for (const [file, content] of [
      [application, 'application'], [bootloader, 'bootloader'],
      [partitions, 'partitions'], [merged, 'merged'],
    ]) fs.writeFileSync(file, content);
    const flashPath = path.join(root, 'flash_args');
    fs.writeFileSync(flashPath, [
      '--flash_mode dio',
      `0x0 ${path.basename(bootloader)}`,
      `0x8000 ${path.basename(partitions)}`,
      `0x10000 ${path.basename(application)}`,
      '',
    ].join('\n'));
    const adapter = forge.nativeRelinkAdapterFor('esp32:esp32:esp32c6');
    const flashBytes = fs.statSync(flashPath).size;
    const witness = forge.espFlashArgumentsWitness(flashPath, flashBytes, root, adapter);
    const artifacts = [
      { role: 'application-bin', bytes: fs.statSync(application).size },
      { role: 'bootloader-bin', bytes: fs.statSync(bootloader).size },
      { role: 'partitions-bin', bytes: fs.statSync(partitions).size },
      { role: 'merged-firmware-bin', bytes: fs.statSync(merged).size },
      { role: 'flash-arguments', bytes: flashBytes, flashArgumentsWitness: witness },
    ];
    assert.equal(runner.requiredArtifactPresence(artifacts).passed, true);
    assert.equal(runner.requiredArtifactPresence(artifacts.slice(0, -1)).passed, false);
    const qioWitness = structuredClone(witness);
    qioWitness.optionLines = ['--flash_mode qio'];
    assert.equal(runner.flashArgumentsEquivalent(
      [{ role: 'flash-arguments', bytes: flashBytes, flashArgumentsWitness: witness }],
      [{ role: 'flash-arguments', bytes: flashBytes, flashArgumentsWitness: qioWitness }],
    ).passed, false);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
});

test('runner source is compile-only, fail-closed and does not touch the Rust engine', () => {
  assert.doesNotMatch(SOURCE, /invoke\(['"]upload_sketch/u);
  assert.doesNotMatch(SOURCE, /open_serial|serial_monitor|upload_port/iu);
  assert.match(SOURCE, /qualification:\s*true/u);
  assert.match(SOURCE, /qualificationToken:/u);
  assert.match(SOURCE, /execution requires a 64-character token/u);
  assert.match(SOURCE, /compareNativeRelinkAdapterArtifactEquivalence/u);
  assert.match(SOURCE, /validEspFlashArgumentsWitness/u);
  assert.match(SOURCE, /sealed library objects in native order/u);
  assert.match(SOURCE, /SOURCE_DATE_EPOCH/u);
  assert.match(SOURCE, /cleanupFixture/u);
  assert.match(SOURCE, /finally\s*\{/u);
  assert.match(SOURCE, /minimumMedianSpeedupPct:\s*20/u);
  assert.match(SOURCE, /minimumAbsoluteMedianGainMs:\s*500/u);
  assert.doesNotMatch(SOURCE, /builder\/demo\.rs/u);
  assert.match(CANDIDATE_SOURCE, /SOURCE_DATE_EPOCH = '1704067200'/u);
  assert.match(CANDIDATE_SOURCE, /\$env:TZ = 'UTC'/u);
  assert.match(CANDIDATE_SOURCE, /--allow-cache-reset/u);
  assert.match(CANDIDATE_SOURCE, /--allow-fixture-install/u);
  assert.match(CANDIDATE_SOURCE, /ExpectedExecutableSha256/u);
  assert.match(CANDIDATE_SOURCE, /\[string\]\$ExecutablePath/u);
  assert.match(CANDIDATE_SOURCE, /RandomNumberGenerator/u);
  assert.match(CANDIDATE_SOURCE, /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/u);
  assert.match(CANDIDATE_SOURCE, /\[Array\]::Clear\(\$tokenBytes/u);
  assert.match(CANDIDATE_SOURCE, /--cleanup-owned-fixture/u);
  assert.match(CANDIDATE_SOURCE, /Get-Process -Name appsdesktop, arduino-cli/u);
  assert.match(CANDIDATE_SOURCE, /-WorkingDirectory \$rootPath/u);
  assert.match(CANDIDATE_SOURCE, /CK_PROCESS_ID/u);
  assert.match(CANDIDATE_SOURCE, /taskkill\.exe \/PID \$candidateProcess\.Id \/T \/F/u);
  assert.match(CANDIDATE_SOURCE, /debug port \$DebugPort remains occupied/u);
  assert.match(CANDIDATE_SOURCE, /Get-NetTCPConnection -LocalPort \$DebugPort/u);
  assert.match(CANDIDATE_SOURCE, /\.url -eq 'http:\/\/tauri\.localhost\/'/u);
});
