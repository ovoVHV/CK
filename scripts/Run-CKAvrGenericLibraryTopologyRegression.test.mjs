import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('./Run-CKAvrGenericLibraryTopologyRegression.cjs');
const fixtures = require('./CKAvrGenericLibraryTopologyFixtures.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKAvrGenericLibraryTopologyRegression.cjs'),
  'utf8',
);
const CANDIDATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKAvrGenericLibraryTopologyCandidate.ps1'),
  'utf8',
);

test('plan seals topology, per-TU hashes, dependency edges and exact expected routes', () => {
  const options = runner.parseArgs(['--plan', '--target', 'uno', '--trials', '3']);
  const plan = runner.planFor(options);
  assert.equal(plan.schemaId, runner.PLAN_SCHEMA_ID);
  assert.equal(plan.compileOnly, true);
  assert.equal(plan.uploadPerformed, false);
  assert.equal(plan.serialPortAccessed, false);
  assert.equal(plan.trials, 3);
  assert.equal(plan.pairedStageCount, 18);
  assert.equal(plan.compileCount, 36);
  assert.equal(plan.topologyManifestSha256, fixtures.fixtureManifest().manifestSha256);
  assert.deepEqual(plan.topologyManifest.dependencyEdges, [
    { from: 'CKTopoA17', to: 'CKTopoB29', source: 'library.properties:depends' },
    { from: 'CKTopoB29', to: 'CKTopoC43', source: 'library.properties:depends' },
  ]);
  assert.equal(
    plan.topologyManifest.libraries.flatMap((library) => library.translationUnits).length,
    4,
  );
  assert.ok(plan.topologyManifest.libraries.flatMap(
    (library) => library.translationUnits,
  ).every((unit) => /^[0-9a-f]{64}$/u.test(unit.sha256)));
  assert.deepEqual(plan.sequence.map((stage) => stage.expectedRoute), [
    null,
    'native-relink-graph-transition',
    'native-relink-compile-only',
    'native-relink-graph-transition',
    'native-relink-graph-transition',
    'native-relink-graph-transition',
  ]);
  assert.equal(
    plan.routePolicy.includeOrderChange,
    'native-relink-graph-transition',
  );
  assert.deepEqual(plan.sequence.map((stage) => stage.expectedOrderedLibraries), [
    [],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoD61', 'CKTopoA17', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoB29', 'CKTopoC43'],
    ['CKTopoA17', 'CKTopoD61', 'CKTopoB29', 'CKTopoC43'],
  ]);
  assert.deepEqual(plan.sequence[1].expectedOrderedTUs, [
    { library: 'CKTopoA17', sourceRelativePath: 'src/CKTopoA17.cpp', language: 'cpp' },
    { library: 'CKTopoD61', sourceRelativePath: 'src/CKTopoD61.cpp', language: 'cpp' },
    { library: 'CKTopoB29', sourceRelativePath: 'src/CKTopoB29.cpp', language: 'cpp' },
    { library: 'CKTopoB29', sourceRelativePath: 'src/nested/CKTopoB29Detail.c', language: 'c' },
  ]);
  assert.equal(
    plan.equivalencePolicy.ccdbLibraryTuOrder,
    'first-library-occurrence-plus-sealed-tu-membership-not-link-order',
  );
});

test('execution requires separate explicit cache and fixture mutation authority', () => {
  assert.throws(
    () => runner.parseArgs(['--execute', '--output', 'new.json']),
    /allow-cache-reset/u,
  );
  assert.throws(
    () => runner.parseArgs(['--execute', '--allow-cache-reset', '--output', 'new.json']),
    /allow-fixture-install/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--allow-fixture-install']),
    /read-only/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--target', 'not-a-board']),
    /unknown AVR target/u,
  );
});

test('route gate distinguishes graph changes, same-graph edits and cold recording', () => {
  const graphStage = fixtures.TOPOLOGY_SEQUENCE[1];
  const graph = runner.routeEvidence({
    buildMode: 'native-relink-graph-transition',
    exactUsed: false,
    cache: { nativeRelinkDiagnostics: [] },
    fallback: { used: false },
  }, graphStage);
  assert.equal(graph.expectedMode, 'native-relink-graph-transition');
  assert.equal(graph.observedMode, graph.expectedMode);
  assert.equal(graph.passed, true);

  const editStage = fixtures.TOPOLOGY_SEQUENCE[2];
  const edit = runner.routeEvidence({
    buildMode: 'native-relink-compile-only',
    exactUsed: false,
    cache: {
      nativeRelinkDiagnostics: [
        'NativeRelinkCompileOnly certificate matched',
        'NativeRelinkCompileOnly path: AVR Release sketch-only compile',
      ],
    },
    fallback: { used: false },
  }, editStage);
  assert.equal(edit.passed, true);

  const wrong = runner.routeEvidence({
    buildMode: 'arduino-cli-incremental',
    structuredRoute: { mode: 'arduino-cli-core-seeded' },
    exactUsed: false,
    cache: { nativeRelinkDiagnostics: [] },
    fallback: { used: false },
  }, graphStage);
  assert.equal(wrong.safe, true);
  assert.equal(wrong.passed, false);
});

function artifacts(seed) {
  return [
    {
      name: 'fixture.hex',
      bytes: 100,
      sha256: seed.repeat(64),
      role: 'avr-application-hex',
      primaryApplication: true,
    },
    {
      name: 'fixture.eep',
      bytes: 20,
      sha256: 'e'.repeat(64),
      role: 'avr-eeprom',
      primaryApplication: false,
    },
  ];
}

function makeTrial() {
  const resources = { evidenceComplete: true, flashUsedBytes: 100, ramUsedBytes: 20 };
  return {
    id: 'trial-001',
    failures: [],
    stages: fixtures.TOPOLOGY_SEQUENCE.map((stage, index) => {
      const restoredIndex = index === 5 ? 1 : index;
      const ck = {
        codeSha256: stage.sourceSha256,
        resources,
        artifacts: artifacts(String(restoredIndex)),
        buildPathIdentitySha256: 'c'.repeat(64),
        ccdbLibraryTuOrder: {
          observedLibraryOrder: [...stage.expectedCcdbObservableLibraryOrder],
          normalizedOrderedTUs: stage.expectedOrderedTUs.map((unit) => ({ ...unit })),
        },
      };
      const native = {
        codeSha256: stage.sourceSha256,
        resources,
        artifacts: artifacts(String(restoredIndex)),
        buildPathIdentitySha256: 'd'.repeat(64),
        ccdbLibraryTuOrder: {
          observedLibraryOrder: [...stage.expectedCcdbObservableLibraryOrder],
          normalizedOrderedTUs: stage.expectedOrderedTUs.map((unit) => ({ ...unit })),
        },
      };
      return {
        id: stage.id,
        ck,
        native,
        equivalence: runner.stageEquivalence(stage, ck, native),
        routeEvidence: { passed: true, preferred: index === 0 ? null : true },
      };
    }),
  };
}

test('trial gate requires per-stage HEX/EEP/resources and exact add-to-restore equivalence', () => {
  const passing = makeTrial();
  const result = runner.evaluateTrial(passing);
  assert.equal(result.stageEquivalencePassed, true);
  assert.equal(result.routePassed, true);
  assert.equal(result.stableBuildPaths, true);
  assert.equal(result.restoration.passed, true);
  assert.equal(result.passed, true);

  const changed = makeTrial();
  changed.stages.at(-1).ck.artifacts = artifacts('a');
  changed.stages.at(-1).equivalence = runner.stageEquivalence(
    fixtures.TOPOLOGY_SEQUENCE.at(-1),
    changed.stages.at(-1).ck,
    changed.stages.at(-1).native,
  );
  const failed = runner.evaluateTrial(changed);
  assert.equal(failed.stageEquivalencePassed, false);
  assert.equal(failed.restoration.passed, false);
  assert.equal(failed.passed, false);

  const reordered = makeTrial();
  reordered.stages[3].ck.ccdbLibraryTuOrder.normalizedOrderedTUs.reverse();
  reordered.stages[3].equivalence = runner.stageEquivalence(
    fixtures.TOPOLOGY_SEQUENCE[3],
    reordered.stages[3].ck,
    reordered.stages[3].native,
  );
  const wrongCcdbOrder = runner.evaluateTrial(reordered);
  assert.equal(wrongCcdbOrder.stageEquivalencePassed, false);
  assert.equal(wrongCcdbOrder.passed, false);
});

test('generic library topology performance records cold add and gates later edits', () => {
  const trial = makeTrial();
  trial.stages.forEach((stage, index) => {
    stage.ck.wallMs = index === 0 ? 10_000 : 2_000;
    stage.native.wallMs = index === 0 ? 7_000 : 4_000;
  });
  const exploratory = runner.evaluatePerformanceTarget([trial]);
  assert.equal(exploratory.status, 'target-met');
  assert.equal(exploratory.stages[0].recordedOnly, true);
  assert.equal(exploratory.stages[0].passed, null);
  assert.ok(exploratory.stages.slice(1).every((stage) => stage.passed === true));
  assert.match(exploratory.note, /Exploratory 1-trial/u);

  const slow = makeTrial();
  slow.stages.forEach((stage, index) => {
    stage.ck.wallMs = index === 0 ? 10_000 : 3_500;
    stage.native.wallMs = index === 0 ? 7_000 : 4_000;
  });
  assert.equal(runner.evaluatePerformanceTarget([slow]).status, 'target-not-met');
});

function withCcdbFixture(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-topology-ccdb-order-test-'));
  const librariesRoot = path.join(root, 'libraries');
  const buildPath = path.join(root, 'build');
  fs.mkdirSync(librariesRoot);
  fs.mkdirSync(buildPath);
  const runToken = 'a'.repeat(32);
  fixtures.materializeLibraries(librariesRoot, runToken);
  const entries = fixtures.TOPOLOGY_SEQUENCE[1].expectedOrderedTUs.map((unit, index) => {
    const source = path.join(librariesRoot, unit.library, ...unit.sourceRelativePath.split('/'));
    const object = path.join(buildPath, 'libraries', unit.library, `${unit.sourceRelativePath}.o`);
    fs.mkdirSync(path.dirname(object), { recursive: true });
    fs.writeFileSync(object, Buffer.from(`object-${index}`));
    return {
      directory: buildPath,
      arguments: ['avr-g++', '-c', source, '-o', object],
      file: source,
    };
  });
  const writeCcdb = (value) => fs.writeFileSync(
    path.join(buildPath, 'compile_commands.json'), `${JSON.stringify(value)}\n`, 'utf8',
  );
  writeCcdb(entries);
  try {
    return callback({ buildPath, librariesRoot, entries, writeCcdb });
  } finally {
    fixtures.cleanupMaterializedLibraries(librariesRoot, runToken);
    fs.rmSync(root, { recursive: true, force: true });
  }
}

test('CCDB evidence records fixture TU entry order without claiming linker order', () => {
  withCcdbFixture(({ buildPath, librariesRoot }) => {
    const evidence = runner.inspectCcdbLibraryTuOrder(buildPath, librariesRoot);
    assert.equal(evidence.rawOrderSemantics, 'compile-commands-json-entry-order-not-link-order');
    assert.equal(
      evidence.normalizedOrderSemantics,
      'ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order',
    );
    assert.equal(evidence.sourceObjectBinding, 'one-source-to-one-object');
    assert.deepEqual(
      evidence.normalizedOrderedTUs.map(
        ({ library, sourceRelativePath, language }) => ({ library, sourceRelativePath, language }),
      ),
      fixtures.TOPOLOGY_SEQUENCE[1].expectedOrderedTUs,
    );
    const comparison = runner.ccdbTuOrderEvidence(
      fixtures.TOPOLOGY_SEQUENCE[1],
      { ccdbLibraryTuOrder: evidence },
      { ccdbLibraryTuOrder: evidence },
    );
    assert.equal(comparison.passed, true);
  });
});

test('CCDB gate keeps raw worker order but normalizes only within a library group', () => {
  withCcdbFixture(({ buildPath, librariesRoot, entries, writeCcdb }) => {
    writeCcdb([entries[0], entries[1], entries[3], entries[2]]);
    const evidence = runner.inspectCcdbLibraryTuOrder(buildPath, librariesRoot);
    assert.deepEqual(
      evidence.rawCcdbEntryOrderedTUs.map((unit) => unit.sourceRelativePath),
      [
        'src/CKTopoA17.cpp',
        'src/CKTopoD61.cpp',
        'src/nested/CKTopoB29Detail.c',
        'src/CKTopoB29.cpp',
      ],
    );
    assert.deepEqual(
      evidence.normalizedOrderedTUs.map((unit) => unit.sourceRelativePath),
      fixtures.TOPOLOGY_SEQUENCE[1].expectedOrderedTUs.map((unit) => unit.sourceRelativePath),
    );
    assert.equal(runner.ccdbTuOrderEvidence(
      fixtures.TOPOLOGY_SEQUENCE[1],
      { ccdbLibraryTuOrder: evidence },
      { ccdbLibraryTuOrder: evidence },
    ).passed, true);

    writeCcdb([entries[1], entries[0], entries[2], entries[3]]);
    const wrongLibraryOrder = runner.inspectCcdbLibraryTuOrder(buildPath, librariesRoot);
    assert.equal(runner.ccdbTuOrderEvidence(
      fixtures.TOPOLOGY_SEQUENCE[1],
      { ccdbLibraryTuOrder: wrongLibraryOrder },
      { ccdbLibraryTuOrder: evidence },
    ).passed, false);
  });
});

test('CCDB evidence fails closed on duplicate source or escaped object bindings', () => {
  withCcdbFixture(({ buildPath, librariesRoot, entries, writeCcdb }) => {
    const duplicateObject = path.join(buildPath, 'libraries', 'duplicate.o');
    fs.mkdirSync(path.dirname(duplicateObject), { recursive: true });
    fs.writeFileSync(duplicateObject, 'duplicate');
    writeCcdb([...entries, {
      ...entries[0],
      arguments: ['avr-g++', '-c', entries[0].file, '-o', duplicateObject],
    }]);
    assert.throws(
      () => runner.inspectCcdbLibraryTuOrder(buildPath, librariesRoot),
      /one-to-one/u,
    );

    const escapedObject = path.join(path.dirname(buildPath), 'escaped.o');
    fs.writeFileSync(escapedObject, 'escaped');
    writeCcdb(entries.map((entry, index) => index === 0 ? {
      ...entry,
      arguments: ['avr-g++', '-c', entry.file, '-o', escapedObject],
    } : entry));
    assert.throws(
      () => runner.inspectCcdbLibraryTuOrder(buildPath, librariesRoot),
      /escaped the build root/u,
    );
  });
});

test('runner remains compile-only and cleans marker-owned fixtures in finally', () => {
  assert.doesNotMatch(SOURCE, /invoke\(['"]upload_sketch/u);
  assert.doesNotMatch(SOURCE, /open_serial|serial_monitor|upload_port/iu);
  assert.match(SOURCE, /qualification:\s*false/u);
  assert.match(SOURCE, /materializeLibraries/u);
  assert.match(SOURCE, /cleanupMaterializedLibraries/u);
  assert.match(SOURCE, /finally\s*\{/u);
  assert.match(SOURCE, /compareAvrArtifactRoles/u);
  assert.match(SOURCE, /expectedOrderedTUs/u);
  assert.match(SOURCE, /ccdb-first-library-occurrence-then-sealed-tu-order-not-link-order/u);
  assert.match(SOURCE, /source\/object bindings are not one-to-one/u);
  assert.match(
    SOURCE,
    /const nativeBaselineConfig = forge\.nativeBaselineContract\(null\);[\s\S]*?forge\.inspectCliAndCore\([\s\S]*?nativeBaselineConfig\.cliConfigPath[\s\S]*?const nativeBaseline = forge\.nativeBaselineContract\(null, report\.identity\);/u,
  );
  assert.match(
    SOURCE,
    /forge\.createNativeTrial\([\s\S]*?fixtures\.TOPOLOGY_SEQUENCE\[0\]\.code,[\s\S]*?nativeBaseline,[\s\S]*?\);/u,
  );
  assert.match(
    SOURCE,
    /row\.native = dependency\.finalizeNativeStageRun\(\{/u,
  );
  assert.match(SOURCE, /inspectCcdbLibraryTuOrder\(\s*nativeContext\.buildPath, librariesRoot/um);
  assert.match(CANDIDATE_SOURCE, /ExpectedExecutableSha256/u);
  assert.match(CANDIDATE_SOURCE, /\.url -eq 'http:\/\/tauri\.localhost\/'/u);
  assert.match(CANDIDATE_SOURCE, /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN', \$null/u);
  assert.match(CANDIDATE_SOURCE, /--allow-cache-reset/u);
  assert.match(CANDIDATE_SOURCE, /--allow-fixture-install/u);
  assert.match(CANDIDATE_SOURCE, /Invoke-OwnedFixtureRecovery/u);
  assert.match(CANDIDATE_SOURCE, /Get-NetTCPConnection -LocalPort \$DebugPort/u);
  assert.match(CANDIDATE_SOURCE, /foreach \(\$name in \$saved\.Keys\)/u);
});
