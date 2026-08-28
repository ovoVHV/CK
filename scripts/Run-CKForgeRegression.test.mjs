import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import { createRequire } from 'node:module';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { validateJsonSchema } from './JsonSchemaValidator.mjs';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'scripts', 'Run-CKForgeRegression.cjs');
const forge = require(ENTRY);
const schema = JSON.parse(readFileSync(forge.REPORT_SCHEMA, 'utf8'));
const historicalReport = JSON.parse(readFileSync(
  join(ROOT, 'artifacts', 'release', 'cross-board-compile-regression-20260716-final.json'),
  'utf8',
));

test('CK Forge default and planning actions never start a regression', () => {
  const empty = spawnSync(process.execPath, [ENTRY], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /No regression run was started/);
  assert.match(empty.stdout, /default_cache_reset|does not clear caches|does not clear cache/i);

  const plan = spawnSync(process.execPath, [
    ENTRY,
    '--plan',
    '--matrix',
    'minimum',
    '--output',
    join(tmpdir(), 'ck-forge-plan-only.json'),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(plan.status, 0, plan.stderr);
  assert.match(plan.stdout, /No regression run was started/);
  const jsonText = plan.stdout.slice(0, plan.stdout.lastIndexOf('\nNo regression run was started.'));
  const parsed = JSON.parse(jsonText);
  assert.equal(parsed.cache_reset_requested, false);
  assert.equal(parsed.upload_performed, false);
  assert.equal(parsed.hardware_tested, false);
  assert.equal(parsed.delegated_arguments.includes('--cold'), false);
});

test('CK Forge publishes one explicit and stable target matrix catalog', () => {
  assert.deepEqual(forge.MATRICES.minimum, ['c3', 'c5', 'c6', 's3', 'nano', 'mega', 'esp8266']);
  assert.deepEqual(forge.MATRICES.dependency, ['c6', 'nano', 'esp8266']);
  assert.deepEqual(forge.MATRICES.configuration, [
    'c5-n16r8-config',
    'c6-16m-config',
    's3-16m-opi-config',
  ]);
  assert.deepEqual(forge.MATRICES.compatibility, [
    'h2',
    'p4',
    'compat-esp32s3-feather',
    'compat-avr-leonardo',
    'compat-esp8266-generic',
  ]);
  assert.equal(forge.MATRICES.release.length, 11);
  assert.deepEqual(forge.MATRICES.release, forge.BASE_TARGETS.map((target) => target.id));
  assert.equal(forge.TARGETS.length, 19);
  assert.equal(new Set(forge.TARGETS.map((target) => target.id)).size, forge.TARGETS.length);
  assert.equal(new Set(forge.TARGETS.map((target) => target.fqbn)).size, forge.TARGETS.length);
  assert.ok(forge.TARGETS.every((target) => /^[^:]+:[^:]+:[^:]+/.test(target.fqbn)));
  assert.ok(forge.TARGETS.every((target) => target.hardwareTested === false));
  for (const target of forge.BASE_TARGETS) {
    const catalogTarget = forge.TARGETS.find((candidate) => candidate.id === target.id);
    assert.equal(catalogTarget.expectedForgeDecision, 'force-platform');
    assert.equal(catalogTarget.expectedCompileProfile, 'release');
  }

  const listed = spawnSync(process.execPath, [ENTRY, '--list'], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr);
  const catalog = JSON.parse(listed.stdout);
  assert.equal(catalog.default_action, 'help-only');
  assert.equal(catalog.safety.default_cache_reset, false);
  assert.deepEqual(catalog.safety.cache_reset_requires, ['--cold', '--allow-cache-reset']);
});

test('configuration matrix uses menu values advertised by installed ESP32 Core 3.3.6', () => {
  const boardsText = readFileSync(
    join(ROOT, 'packages', 'esp32', 'hardware', 'esp32', '3.3.6', 'boards.txt'),
    'utf8',
  );
  for (const target of forge.CONFIGURATION_TARGETS) {
    assert.equal(target.hardwareTested, false);
    const [packageName, architecture, boardId, menuText] = target.fqbn.split(':');
    assert.equal(`${packageName}:${architecture}`, 'esp32:esp32');
    assert.ok(menuText, `${target.id} must bind explicit menu selections`);
    for (const selection of menuText.split(',')) {
      const [menuId, optionId] = selection.split('=');
      assert.ok(menuId && optionId, `${target.id} has malformed menu selection ${selection}`);
      assert.ok(
        boardsText.includes(`${boardId}.menu.${menuId}.${optionId}=`),
        `${target.id} selects an option not advertised by boards.txt: ${selection}`,
      );
    }
  }

  assert.equal(
    forge.CONFIGURATION_TARGETS.find((target) => target.id === 'c5-n16r8-config').fqbn,
    'esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled',
  );
  assert.equal(
    forge.CONFIGURATION_TARGETS.find((target) => target.id === 'c6-16m-config').fqbn,
    'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
  );
  assert.equal(
    forge.CONFIGURATION_TARGETS.find((target) => target.id === 's3-16m-opi-config').fqbn,
    'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi',
  );
});

test('compatibility matrix uses installed but non-whitelisted board declarations', () => {
  const boardsByPlatform = new Map([
    ['esp32:esp32', readFileSync(
      join(ROOT, 'packages', 'esp32', 'hardware', 'esp32', '3.3.6', 'boards.txt'),
      'utf8',
    )],
    ['arduino:avr', readFileSync(
      join(ROOT, 'packages', 'arduino', 'hardware', 'avr', '1.8.6', 'boards.txt'),
      'utf8',
    )],
    ['esp8266:esp8266', readFileSync(
      join(ROOT, 'packages', 'esp8266', 'hardware', 'esp8266', '3.1.2', 'boards.txt'),
      'utf8',
    )],
  ]);
  const expectedFqbns = [
    'esp32:esp32:esp32h2',
    'esp32:esp32:esp32p4',
    'esp32:esp32:adafruit_feather_esp32s3',
    'arduino:avr:leonardo',
    'esp8266:esp8266:generic',
  ];

  assert.deepEqual(
    forge.COMPATIBILITY_TARGETS.map((target) => target.fqbn),
    expectedFqbns,
  );
  for (const target of forge.COMPATIBILITY_TARGETS) {
    const [packageName, architecture, boardId] = target.fqbn.split(':');
    const boardsText = boardsByPlatform.get(`${packageName}:${architecture}`);
    assert.ok(boardsText, `${target.id} must bind an installed platform`);
    assert.ok(
      boardsText.includes(`${boardId}.name=`),
      `${target.id} board ID is not declared by the installed boards.txt`,
    );
    assert.equal(target.hardwareTested, false);
    assert.equal(target.expectedForgeDecision, 'force-platform');
    assert.equal(target.expectedCompileProfile, 'release');
  }
});

test('compatibility plan delegates only unqualified native sentinels without running them', () => {
  const options = forge.parseArgs([
    '--plan', '--matrix', 'compatibility', '--output', join(tmpdir(), 'ck-forge-compat-plan.json'),
  ]);
  const plan = forge.planFor(options);
  assert.deepEqual(plan.target_ids, forge.MATRICES.compatibility);
  assert.deepEqual(
    plan.fqbn_targets,
    forge.COMPATIBILITY_TARGETS.map((target) => target.fqbn),
  );
  assert.equal(plan.compile_only, true);
  assert.equal(plan.upload_performed, false);
  assert.equal(plan.hardware_tested, false);
  assert.equal(plan.cache_reset_requested, false);
  assert.deepEqual(
    plan.target_expectations.map((target) => ({
      id: target.id,
      decision: target.expected_forge_decision,
      profile: target.expected_compile_profile,
      hardwareTested: target.hardware_tested,
    })),
    forge.MATRICES.compatibility.map((id) => ({
      id,
      decision: 'force-platform',
      profile: 'release',
      hardwareTested: false,
    })),
  );

  const legacyCompatibility = spawnSync(process.execPath, [
    forge.LEGACY_HARNESS,
    '--list',
    '--targets',
    forge.MATRICES.compatibility.join(','),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(legacyCompatibility.status, 0, legacyCompatibility.stderr);
  assert.deepEqual(
    JSON.parse(legacyCompatibility.stdout).map((target) => target.id),
    forge.MATRICES.compatibility,
  );
});

test('configuration plan delegates exact opt-in targets without changing release matrix', () => {
  const output = join(tmpdir(), 'ck-forge-configuration-plan.json');
  const options = forge.parseArgs([
    '--plan', '--matrix', 'configuration', '--output', output,
  ]);
  const plan = forge.planFor(options);
  assert.deepEqual(plan.target_ids, forge.MATRICES.configuration);
  assert.deepEqual(
    plan.fqbn_targets,
    forge.CONFIGURATION_TARGETS.map((target) => target.fqbn),
  );
  assert.equal(plan.compile_only, true);
  assert.equal(plan.hardware_tested, false);
  assert.deepEqual(
    plan.target_expectations.map((target) => [
      target.id,
      target.expected_forge_decision,
      target.expected_compile_profile,
    ]),
    [
      ['c5-n16r8-config', 'force-platform', 'release'],
      ['c6-16m-config', 'force-platform', 'release'],
      ['s3-16m-opi-config', 'force-platform', 'release'],
    ],
  );
  assert.deepEqual(
    forge.MATRICES.release,
    ['c3', 'c5', 'c6', 's3', 's2', 'esp32', 'avr', 'nano', 'mega', 'diecimila', 'esp8266'],
  );

  const legacyDefault = spawnSync(process.execPath, [forge.LEGACY_HARNESS, '--list'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(legacyDefault.status, 0, legacyDefault.stderr);
  assert.deepEqual(
    JSON.parse(legacyDefault.stdout).map((target) => target.id),
    forge.MATRICES.release,
    'the delegated harness keeps its historical 11-target default',
  );

  const legacyConfiguration = spawnSync(process.execPath, [
    forge.LEGACY_HARNESS,
    '--list',
    '--targets',
    forge.MATRICES.configuration.join(','),
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(legacyConfiguration.status, 0, legacyConfiguration.stderr);
  assert.deepEqual(
    JSON.parse(legacyConfiguration.stdout).map((target) => target.id),
    forge.MATRICES.configuration,
  );
});

test('CK Forge requires explicit execution, targets, output, and cache-reset acknowledgement', () => {
  assert.equal(forge.parseArgs([]).help, true);
  assert.throws(() => forge.parseArgs(['--execute']), /explicit --matrix or --targets/);
  assert.throws(
    () => forge.parseArgs(['--execute', '--matrix', 'minimum']),
    /explicit --output/,
  );
  assert.throws(
    () => forge.parseArgs(['--execute', '--matrix', 'minimum', '--output', 'x.json', '--cold']),
    /--allow-cache-reset/,
  );
  assert.throws(
    () => forge.parseArgs(['--execute', '--matrix', 'minimum', '--output', 'x.json', '--allow-cache-reset']),
    /only valid together with --cold/,
  );
  assert.throws(
    () => forge.parseArgs(['--plan', '--matrix', 'minimum', '--targets', 'c6', '--output', 'x.json']),
    /cannot be combined/,
  );

  const cold = forge.parseArgs([
    '--execute', '--matrix', 'dependency', '--dependency-cycle', '--output', 'new.json',
    '--cold', '--allow-cache-reset',
  ]);
  const args = forge.buildHarnessArgs(cold);
  assert.equal(args.includes('--cold'), true);
  assert.equal(args.includes('--dependency-cycle'), true);
  assert.equal(args.includes('--allow-cache-reset'), false, 'acknowledgement is wrapper-only');
});

test('CK Forge refuses an existing output before contacting the native harness', () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-forge-no-clobber-'));
  try {
    const output = join(root, 'existing.json');
    writeFileSync(output, 'sentinel', 'utf8');
    const result = spawnSync(process.execPath, [
      ENTRY,
      '--execute',
      '--targets',
      'c6',
      '--output',
      output,
    ], { cwd: ROOT, encoding: 'utf8' });
    assert.notEqual(result.status, 0);
    assert.match(result.stderr, /Refusing to overwrite existing CK Forge report/);
    assert.equal(readFileSync(output, 'utf8'), 'sentinel');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CK Forge schema accepts the saved v2 report and fails closed on scope drift', () => {
  assert.deepEqual(validateJsonSchema(schema, historicalReport).errors, []);

  const uploaded = structuredClone(historicalReport);
  uploaded.controls.uploadPerformed = true;
  assert.notDeepEqual(validateJsonSchema(schema, uploaded).errors, []);

  const hardwareClaim = structuredClone(historicalReport);
  hardwareClaim.targets[0].hardwareTested = true;
  assert.notDeepEqual(validateJsonSchema(schema, hardwareClaim).errors, []);

  const badFqbn = structuredClone(historicalReport);
  badFqbn.targets[0].fqbn = 'esp32c3';
  assert.notDeepEqual(validateJsonSchema(schema, badFqbn).errors, []);
});

test('post-run guard binds safety scope and the exact requested target order', () => {
  const currentReport = structuredClone(historicalReport);
  for (const target of currentReport.targets) {
    for (const run of target.runs) {
      run.profile = 'release';
      run.buildMode = 'arduino-cli-incremental';
      run.cache = { ...(run.cache || {}), exactMatch: false };
      run.environment.toolchainIdentitySource = 'persistent-metadata';
      run.engine = {
        id: 'ck-forge',
        schemaVersion: 1,
        productVersion: '1',
        contractId: 'test-contract',
        decision: 'force-platform',
        source: 'conservative-fallback',
        reasonCodes: ['builtin-performance-qualification-missing'],
      };
    }
  }
  const options = {
    cold: true,
    targetIds: [...currentReport.selectedTargetIds],
  };
  assert.equal(forge.validatePublishedReport(currentReport, options), true);

  const targetDrift = structuredClone(currentReport);
  targetDrift.selectedTargetIds = [...targetDrift.selectedTargetIds].reverse();
  assert.throws(() => forge.validatePublishedReport(targetDrift, options), /target selection/);

  const runScopeDrift = structuredClone(currentReport);
  runScopeDrift.targets[0].runs[0].uploadPerformed = true;
  assert.throws(() => forge.validatePublishedReport(runScopeDrift, options), /compile-only scope/);

  const missingEngine = structuredClone(currentReport);
  delete missingEngine.targets[0].runs[0].engine;
  assert.throws(() => forge.validatePublishedReport(missingEngine, options), /engine route evidence/);
});

test('post-run guard requires compatibility sentinels to stay on native Release', () => {
  const report = structuredClone(historicalReport);
  report.selectedTargetIds = [...forge.MATRICES.compatibility];
  report.targets = forge.COMPATIBILITY_TARGETS.map((catalogTarget, index) => {
    const target = structuredClone(historicalReport.targets[index]);
    target.id = catalogTarget.id;
    target.label = catalogTarget.label;
    target.fqbn = catalogTarget.fqbn;
    target.hardwareTested = false;
    for (const run of target.runs) {
      run.profile = 'release';
      run.buildMode = 'arduino-cli-incremental';
      run.cache = { ...(run.cache || {}), exactMatch: false };
      run.environment.toolchainIdentitySource = 'persistent-metadata';
      run.engine = {
        id: 'ck-forge',
        schemaVersion: 1,
        productVersion: '1',
        contractId: 'test-contract',
        decision: 'force-platform',
        source: 'conservative-fallback',
        reasonCodes: ['unverified-board-target'],
      };
    }
    return target;
  });
  const options = { cold: true, targetIds: [...forge.MATRICES.compatibility] };
  assert.equal(forge.validatePublishedReport(report, options), true);

  const accidentalFastRoute = structuredClone(report);
  accidentalFastRoute.targets[0].runs[0].engine.decision = 'allow-fast';
  assert.throws(
    () => forge.validatePublishedReport(accidentalFastRoute, options),
    /reported allow-fast; expected force-platform/,
  );

  const accidentalFastProfile = structuredClone(report);
  accidentalFastProfile.targets[1].runs[0].profile = 'quick-fast';
  assert.throws(
    () => forge.validatePublishedReport(accidentalFastProfile, options),
    /reported profile quick-fast; expected release/,
  );

  const mislabeledPortableFast = structuredClone(report);
  mislabeledPortableFast.targets[1].runs[0].profile = 'portable-fast';
  assert.throws(
    () => forge.validatePublishedReport(mislabeledPortableFast, options),
    /reported profile portable-fast; expected release/,
    'an unqualified target must not be marketed as PortableFast without A\/B proof',
  );

  const hiddenExact = structuredClone(report);
  hiddenExact.targets[2].runs[1].cache.exactMatch = true;
  assert.throws(
    () => forge.validatePublishedReport(hiddenExact, options),
    /inconsistent Exact evidence/,
  );

  const mislabeledExact = structuredClone(report);
  mislabeledExact.targets[2].runs[1].buildMode = 'exact-match';
  mislabeledExact.targets[2].runs[1].cache.exactMatch = true;
  assert.equal(
    forge.validatePublishedReport(mislabeledExact, options),
    true,
    'an authenticated Exact replay is valid on the native Release route',
  );
});

test('post-run guard rejects failed summaries even when individual route fields look valid', () => {
  const report = structuredClone(historicalReport);
  for (const target of report.targets) {
    for (const run of target.runs) {
      run.environment.toolchainIdentitySource = 'strong-content';
      run.engine = {
        id: 'ck-forge',
        schemaVersion: 1,
        productVersion: '1',
        contractId: 'test-contract',
        decision: 'allow-fast',
        source: 'builtin-matrix',
        reasonCodes: ['builtin-platform-core-qualified'],
      };
    }
  }
  const options = { cold: true, targetIds: [...report.selectedTargetIds] };
  report.status = 'failed';
  report.failures = ['matrix check failed'];
  assert.throws(
    () => forge.validatePublishedReport(report, options),
    /passing final status/,
  );
});
