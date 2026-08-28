import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const runner = require('./Run-CKAvrDependencyEditRegression.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'Run-CKAvrDependencyEditRegression.cjs'), 'utf8');

test('seven-stage sequence adds, edits and removes dependencies before exact core-only restoration', () => {
  assert.equal(runner.validateSequence(), true);
  assert.deepEqual(runner.DEPENDENCY_EDIT_SEQUENCE.map((stage) => stage.id), [
    'simple',
    'add-mstimer2',
    'edit-mstimer2',
    'remove-mstimer2',
    'add-wire-spi-eeprom',
    'edit-wire-spi-eeprom',
    'return-core-only',
  ]);
  assert.equal(
    runner.DEPENDENCY_EDIT_SEQUENCE[0].code,
    runner.DEPENDENCY_EDIT_SEQUENCE.at(-1).code,
  );
  assert.deepEqual(runner.DEPENDENCY_EDIT_SEQUENCE[1].expectedHeaders, ['MsTimer2.h']);
  assert.deepEqual(runner.DEPENDENCY_EDIT_SEQUENCE[3].expectedHeaders, []);
  assert.deepEqual(runner.DEPENDENCY_EDIT_SEQUENCE[4].expectedHeaders, ['Wire.h', 'SPI.h', 'EEPROM.h']);
  assert.equal(
    runner.DEPENDENCY_EDIT_SEQUENCE[1].preferredRoute,
    'native-relink-graph-transition',
  );
  assert.equal(runner.DEPENDENCY_EDIT_SEQUENCE[2].transitionKind, 'same-graph-edit');
  assert.equal(runner.DEPENDENCY_EDIT_SEQUENCE[5].preferredRoute, 'native-relink-compile-only');
  assert.equal(runner.DEPENDENCY_EDIT_SEQUENCE[0].transitionKind, 'initial-cold');
  assert.equal(runner.DEPENDENCY_EDIT_SEQUENCE[0].preferredRoute, null);
});

test('plan supports one target or all 38 with Gemma as one explicit sequence skip', () => {
  const full = runner.planFor(runner.parseArgs(['--plan']));
  assert.equal(full.targetCount, 38);
  assert.equal(full.applicableTargetCount, 37);
  assert.equal(full.expectedSkipTargetCount, 1);
  assert.equal(full.stageCountPerTarget, 7);
  assert.equal(full.pairedStageCount, 259);
  assert.equal(full.totalCompileCount, 518);
  assert.equal(full.trialsPerTarget, 1);
  assert.equal(full.targets.find((target) => target.id === 'gemma').applicability.status, 'expected-skip');
  assert.match(full.targets.find((target) => target.id === 'gemma').applicability.reason, /ATtiny85/u);

  const uno = runner.planFor(runner.parseArgs(['--plan', '--target', 'uno']));
  assert.equal(uno.targetCount, 1);
  assert.equal(uno.applicableTargetCount, 1);
  assert.equal(uno.pairedStageCount, 7);
  assert.equal(uno.totalCompileCount, 14);

  const formal = runner.planFor(runner.parseArgs(['--plan', '--target', 'uno', '--trials', '5']));
  assert.equal(formal.trialsPerTarget, 5);
  assert.equal(formal.pairedStageCount, 35);
  assert.equal(formal.totalCompileCount, 70);
  assert.equal(formal.performancePolicy.formalRecommendedTrials, 5);
  const fullFormal = runner.planFor(runner.parseArgs(['--plan', '--trials', '5']));
  assert.equal(fullFormal.pairedStageCount, 1_295);
  assert.equal(fullFormal.totalCompileCount, 2_590);

  const gemma = runner.planFor(runner.parseArgs(['--plan', '--target', 'gemma']));
  assert.equal(gemma.applicableTargetCount, 0);
  assert.equal(gemma.totalCompileCount, 0);
  assert.throws(() => runner.parseArgs(['--plan', '--target', 'missing']), /unknown target/u);
});

test('execute parsing is no-clobber and requires explicit cache-reset authority', () => {
  assert.throws(() => runner.parseArgs(['--execute']), /output/u);
  assert.throws(
    () => runner.parseArgs(['--execute', '--output', 'new.json']),
    /allow-cache-reset/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--allow-cache-reset']),
    /read-only/u,
  );
  assert.throws(
    () => runner.parseArgs(['--plan', '--target', 'all', '--target', 'uno']),
    /cannot be combined/u,
  );
});

test('native stage finalization binds target and phase before sealing report integrity', () => {
  const native = runner.finalizeRun({
    targetId: undefined,
    phase: 'native-incremental-name',
    rawTiming: { runnerWallNs: '1000000', pageWallMs: 1 },
    wallMs: 1,
  });
  const bound = runner.finalizeNativeStageRun(native, 'uno', 'add-library');
  assert.equal(bound.targetId, 'uno');
  assert.equal(bound.phase, 'add-library');
  assert.notEqual(bound.evidenceSha256, native.evidenceSha256);
  const { evidenceSha256, ...unsigned } = bound;
  assert.equal(runner.finalizeRun(unsigned).evidenceSha256, evidenceSha256);
  assert.throws(
    () => runner.finalizeNativeStageRun(native, '', 'add-library'),
    /target ID is missing/u,
  );
  assert.match(
    SOURCE,
    /stageResult\.native = finalizeNativeStageRun\(native, target\.id, stage\.id\)/u,
  );
});

test('route policy requires graph transition, preserves NativeRelink and keeps safe fallbacks visible', () => {
  const dependencyChange = runner.DEPENDENCY_EDIT_SEQUENCE[1];
  const sameGraph = runner.DEPENDENCY_EDIT_SEQUENCE[2];
  const graphTransition = {
    buildMode: 'native-relink-graph-transition',
    exactUsed: false,
    cache: { nativeRelinkDiagnostics: [] },
    fallback: { used: false },
  };
  assert.equal(
    runner.observedRouteMode(graphTransition),
    runner.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
  );
  assert.deepEqual(runner.routeEvidenceFor(graphTransition, dependencyChange), {
    policyId: 'ck-avr-dependency-edit-route-v2',
    transitionKind: 'dependency-change',
    preferredMode: 'native-relink-graph-transition',
    optimizationRequired: true,
    observedMode: 'native-relink-graph-transition',
    recognized: true,
    nativeRelinkEvidence: true,
    safe: true,
    preferred: true,
  });

  const coreSeeded = {
    buildMode: 'arduino-cli-incremental',
    structuredRoute: { mode: 'arduino-cli-core-seeded' },
    exactUsed: false,
    cache: { nativeRelinkDiagnostics: [] },
  };
  assert.equal(runner.observedRouteMode(coreSeeded), runner.CORE_SEEDED_ROUTE);
  assert.deepEqual(runner.routeEvidenceFor(coreSeeded, dependencyChange), {
    policyId: 'ck-avr-dependency-edit-route-v2',
    transitionKind: 'dependency-change',
    preferredMode: 'native-relink-graph-transition',
    optimizationRequired: true,
    observedMode: 'arduino-cli-core-seeded',
    recognized: true,
    nativeRelinkEvidence: true,
    safe: true,
    preferred: false,
  });

  const nativeRelink = {
    buildMode: 'native-relink-compile-only',
    exactUsed: false,
    cache: {
      nativeRelinkDiagnostics: [
        'NativeRelinkCompileOnly certificate matched',
        'NativeRelinkCompileOnly path: AVR Release sketch-only compile',
      ],
    },
  };
  assert.equal(runner.routeEvidenceFor(nativeRelink, sameGraph).preferred, true);
  assert.equal(runner.routeEvidenceFor(nativeRelink, sameGraph).safe, true);

  const compatibility = {
    buildMode: 'full-build', exactUsed: false, cache: { nativeRelinkDiagnostics: [] },
    fallback: { used: false },
  };
  assert.equal(runner.routeEvidenceFor(compatibility, dependencyChange).safe, true);
  assert.equal(runner.routeEvidenceFor(compatibility, dependencyChange).preferred, false);
  const initial = runner.routeEvidenceFor(compatibility, runner.DEPENDENCY_EDIT_SEQUENCE[0]);
  assert.equal(initial.safe, true);
  assert.equal(initial.optimizationRequired, false);
  assert.equal(initial.preferred, null);
  assert.equal(runner.routeEvidenceFor({ buildMode: 'unknown', exactUsed: false }, sameGraph).safe, false);
});

function performanceTrial(editCkMs = 800, nativeMs = 2_000, coldCkMs = 20_000) {
  const artifacts = [
    { name: 'app.hex', bytes: 4, sha256: 'a'.repeat(64), role: 'avr-application-hex' },
    { name: 'app.eep', bytes: 2, sha256: 'b'.repeat(64), role: 'avr-eeprom' },
  ];
  const resources = { evidenceComplete: true, flashUsedBytes: 100, ramUsedBytes: 10 };
  return {
    id: 'trial-001',
    cacheReset: {},
    failures: [],
    stages: runner.DEPENDENCY_EDIT_SEQUENCE.map((stage, index) => {
      const ck = {
        wallMs: index === 0 ? coldCkMs : editCkMs,
        codeSha256: index === 0 || index === 6 ? 'same' : `stage-${index}`,
        resources,
        artifacts,
        buildPathIdentitySha256: 'c'.repeat(64),
      };
      const native = {
        wallMs: index === 0 ? 10_000 : nativeMs,
        codeSha256: ck.codeSha256,
        resources,
        artifacts,
        buildPathIdentitySha256: 'd'.repeat(64),
      };
      return {
        id: stage.id,
        ck,
        native,
        equivalence: { source: true, resources: true, artifacts: { passed: true } },
        routeEvidence: {
          safe: true,
          optimizationRequired: index !== 0,
          preferred: index === 0 ? null : true,
        },
      };
    }),
  };
}

test('performance excludes initial cold and gates every later stage by 25% plus 500ms', () => {
  assert.equal(runner.PERFORMANCE_POLICY.id, 'ck-avr-dependency-edit-performance-v2');
  assert.equal(runner.PERFORMANCE_POLICY.minimumMedianSpeedupPct, 25);
  assert.equal(runner.PERFORMANCE_POLICY.formalRecommendedTrials, 5);
  const oneTrial = performanceTrial();
  oneTrial.result = runner.evaluateTrial(oneTrial);
  const passing = runner.evaluateTarget({ trials: [oneTrial], failures: [] });
  assert.equal(passing.performanceTarget.stages[0].recordedOnly, true);
  assert.equal(passing.performanceTarget.stages[0].passed, null);
  assert.equal(passing.performanceTarget.stages[0].optimizedRouteRequired, false);
  assert.equal(passing.performanceTarget.stages[0].ckMedianMs, 20_000);
  assert.ok(passing.performanceTarget.stages.slice(1).every((stage) => stage.passed === true));
  assert.ok(passing.performanceTarget.stages.slice(1).every(
    (stage) => stage.optimizedRouteRequired && stage.optimizedRoutePassed,
  ));
  assert.equal(passing.performanceTarget.passed, true);
  assert.match(passing.performanceTarget.note, /Exploratory 1-trial/u);

  const insufficientGain = performanceTrial(1_700, 2_000);
  insufficientGain.result = runner.evaluateTrial(insufficientGain);
  const failing = runner.evaluateTarget({ trials: [insufficientGain], failures: [] });
  assert.equal(failing.performanceTarget.stages[1].ckSpeedupPctVsNative, 15);
  assert.equal(failing.performanceTarget.stages[1].medianGainMs, 300);
  assert.equal(failing.performanceTarget.passed, false);

  const safeFallback = performanceTrial();
  safeFallback.stages[1].routeEvidence.preferred = false;
  safeFallback.result = runner.evaluateTrial(safeFallback);
  const routeGated = runner.evaluateTarget({ trials: [safeFallback], failures: [] });
  assert.equal(routeGated.performanceTarget.stages[1].optimizedRoutePassed, false);
  assert.equal(routeGated.performanceTarget.stages[1].passed, false);
  assert.equal(routeGated.performanceTarget.passed, false);

  const trials = [
    performanceTrial(700), performanceTrial(900), performanceTrial(800),
    performanceTrial(850), performanceTrial(750),
  ];
  trials.forEach((trial, index) => {
    trial.id = `trial-00${index + 1}`;
    trial.result = runner.evaluateTrial(trial);
  });
  const formal = runner.evaluateTarget({ trials, failures: [] });
  assert.deepEqual(formal.performanceTarget.stages[1].ckRawMs, [700, 900, 800, 850, 750]);
  assert.equal(formal.performanceTarget.stages[1].ckMedianMs, 800);
  assert.equal(formal.performanceTarget.note, null);
});

test('execution source remains compile-only, serial-free and one-reset continuous per target', () => {
  assert.doesNotMatch(SOURCE, /invoke\(['"]upload_sketch/u);
  assert.doesNotMatch(SOURCE, /open_serial|serial_monitor|upload_port/iu);
  assert.match(SOURCE, /qualification:\s*false/u);
  assert.match(SOURCE, /silent:\s*false/u);
  assert.match(SOURCE, /trial\.cacheReset = await clearCkCache/u);
  assert.match(SOURCE, /createNativeTrial/u);
  assert.match(SOURCE, /updateNativeTrialSource/u);
  assert.match(SOURCE, /stableBuildPathPerLane:\s*true/u);
  assert.match(SOURCE, /safeRemoveWorkdir/u);
  assert.match(SOURCE, /performanceTargetStatus/u);
  assert.match(SOURCE, /minimumMedianSpeedupPct:\s*25/u);
  assert.match(SOURCE, /minimumAbsoluteMedianGainMs:\s*500/u);
});

test('execution resolves and passes the native compiler baseline contract', () => {
  assert.match(
    SOURCE,
    /const nativeBaselineConfig = forge\.nativeBaselineContract\(null\);[\s\S]*?forge\.inspectCliAndCore\([\s\S]*?nativeBaselineConfig\.cliConfigPath[\s\S]*?const nativeBaseline = forge\.nativeBaselineContract\(null, row\.identity\);/u,
  );
  assert.match(
    SOURCE,
    /forge\.createNativeTrial\([\s\S]*?DEPENDENCY_EDIT_SEQUENCE\[0\]\.code,[\s\S]*?nativeBaseline,[\s\S]*?\);/u,
  );
});
