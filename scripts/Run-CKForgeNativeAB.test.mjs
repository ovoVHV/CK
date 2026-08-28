import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import {
  existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync,
} from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const ENTRY = join(ROOT, 'scripts', 'Run-CKForgeNativeAB.cjs');
const runner = require(ENTRY);

test('host fingerprint v2 has a fixed cross-language byte vector', () => {
  const environment = {
    COMPUTERNAME: 'CK-DEV',
    NUMBER_OF_PROCESSORS: '16',
    PROCESSOR_ARCHITECTURE: 'AMD64',
    PROCESSOR_IDENTIFIER: 'Intel64 Family 6 Model DEV',
  };
  const expected = 'ebe0f423a2fcaca0cca95fefdfda3db982be39f09dafbcf6f6f6b0a31a1241b5';
  assert.equal(runner.hostEnvironmentFingerprintFromParts(
    'win32', 'x64', '//?/C:/Users/builder/CK/', environment,
  ), expected);
  assert.equal(runner.hostEnvironmentFingerprintFromParts(
    'windows', 'x86_64', 'c:\\users\\ai\\documents\\ck', environment,
  ), expected);
});

test('runner is inert by default and plan mode never resets caches', () => {
  const empty = spawnSync(process.execPath, [ENTRY], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(empty.status, 0, empty.stderr);
  assert.match(empty.stdout, /--allow-cache-reset/);

  const planned = spawnSync(process.execPath, [ENTRY, '--plan', '--trials', '4'], {
    cwd: ROOT,
    encoding: 'utf8',
  });
  assert.equal(planned.status, 0, planned.stderr);
  const json = JSON.parse(planned.stdout.slice(0, planned.stdout.lastIndexOf('\nNo benchmark was started.')));
  assert.equal(json.outputWillBeWritten, false);
  assert.equal(json.candidateArtifactBundleWillBeWritten, false);
  assert.equal(json.cacheWillBeReset, false);
  assert.equal(json.exactAllowed, false);
  assert.equal(json.performanceQualification.eligible, false);
  assert.equal(json.performanceQualification.policy.minimumMedianSpeedupPct, 25);
  assert.equal(json.performanceQualification.policy.minimumAbsoluteMedianGainMs, 500);
  assert.deepEqual(json.captureOrder, ['ck-native', 'native-ck', 'ck-native', 'native-ck']);
});

test('execution requires a new report path and explicit cache-reset acknowledgement', () => {
  assert.throws(() => runner.parseArgs(['--execute', '--output', 'new.json']), /--allow-cache-reset/);
  assert.throws(() => runner.parseArgs(['--execute', '--allow-cache-reset']), /--output/);
  assert.throws(() => runner.parseArgs(['--plan', '--allow-cache-reset']), /cannot.*acknowledge/i);
  assert.throws(() => runner.parseArgs(['--execute', '--allow-cache-reset', '--output', 'x.txt']), /\.json/);
  assert.throws(() => runner.parseArgs(['--plan', '--sequence', 'unknown']), /portable-edit/);
  assert.throws(() => runner.parseArgs(['--plan', '--require-ck-mode', 'fast-relink']), /native-relink-compile-only/);
  assert.throws(() => runner.parseArgs([
    '--plan', '--require-ck-mode', 'native-relink-compile-only',
  ]), /requires --sequence portable-edit/);
  assert.throws(() => runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '4',
    '--require-ck-mode', 'native-relink-compile-only',
  ]), /requires --trials 5\.\.25/);
  assert.equal(runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '5',
    '--fqbn', 'arduino:avr:uno',
    '--require-ck-mode', 'native-relink-compile-only',
  ]).trials, 5);
  assert.equal(runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '5',
    '--fqbn', 'arduino:samd:mkrzero',
    '--require-ck-mode', 'native-relink-compile-only',
  ]).trials, 5);

  const root = mkdtempSync(join(tmpdir(), 'ck-native-ab-token-'));
  const output = join(root, 'new.json');
  try {
    const argv = ['--execute', '--allow-cache-reset', '--output', output];
    assert.throws(() => runner.parseArgs(argv, {}), /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/);
    assert.throws(() => runner.parseArgs(argv, {
      CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: 'A'.repeat(64),
    }), /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/);
    const token = 'a'.repeat(64);
    assert.throws(() => runner.parseArgs(argv, {
      CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: ` ${token}`,
    }), /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/);
    assert.throws(() => runner.parseArgs(argv, {
      CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: `${token}\n`,
    }), /CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/);
    assert.equal(runner.parseArgs(argv, {
      CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token,
    }).qualificationToken, token);
    assert.equal(runner.parseArgs(['--plan'], {}).qualificationToken, null);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Fast profile qualification binds a fixed reproducible compiler environment', () => {
  const expected = {
    SOURCE_DATE_EPOCH: runner.QUALIFICATION_SOURCE_DATE_EPOCH,
    TZ: runner.QUALIFICATION_TIME_ZONE,
  };
  const reproducible = runner.qualificationReproducibility(expected);
  assert.deepEqual(reproducible, {
    policyId: runner.QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
    sourceDateEpoch: Number(runner.QUALIFICATION_SOURCE_DATE_EPOCH),
    timeZone: runner.QUALIFICATION_TIME_ZONE,
    passed: true,
  });
  assert.equal(runner.hasQualificationReproducibility(reproducible), true);
  assert.equal(runner.hasQualificationReproducibility(
    runner.qualificationReproducibility({ SOURCE_DATE_EPOCH: '1', TZ: 'UTC' }),
  ), false);
  const plan = runner.planFor(runner.parseArgs([
    '--plan', '--qualification-operation', 'compile', '--qualification-profile', 'quick-fast',
  ]));
  assert.deepEqual(plan.reproducibleBuildEnvironment, {
    policyId: runner.QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
    sourceDateEpoch: Number(runner.QUALIFICATION_SOURCE_DATE_EPOCH),
    timeZone: runner.QUALIFICATION_TIME_ZONE,
    requiredAtExecution: true,
  });
});

test('Fast profile probes require an explicit operation/profile pair and separate candidate output', () => {
  assert.throws(() => runner.parseArgs([
    '--plan', '--qualification-profile', 'quick-fast',
  ]), /must be supplied together/);
  assert.throws(() => runner.parseArgs([
    '--plan', '--qualification-operation', 'compile',
    '--qualification-profile', 'shared-fast',
  ]), /compile qualification may probe only quick-fast/);
  const planned = runner.parseArgs([
    '--plan', '--fqbn', 'esp32:esp32:esp32c6:FlashSize=16M',
    '--qualification-operation', 'compile',
    '--qualification-profile', 'quick-fast',
  ]);
  const plan = runner.planFor(planned);
  assert.equal(planned.sequence, 'portable-edit');
  assert.equal(plan.measurementSequence, 'portable-edit');
  assert.deepEqual(plan.stages.map((stage) => stage.id), [
    'simple', 'complex', 'medium', 'simple-return',
  ]);
  assert.equal(plan.performanceQualification.policy.id, 'ck-forge-portable-edit-no-regression-v3');
  assert.deepEqual(plan.performanceQualification.requiredStageIds, [
    'simple', 'complex', 'medium', 'simple-return',
  ]);
  assert.equal(plan.performanceQualification.profileProbeEligible, true);
  assert.equal(
    plan.performanceQualification.artifactEquivalencePolicyId,
    runner.COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(plan.nativeBaseline.profile, 'quick-fast');
  assert.equal(plan.nativeBaseline.cliConfigFile, 'arduino-cli-fast.yaml');
  assert.equal(plan.nativeBaseline.compilerPropertyCount, 6);
  assert.equal(plan.nativeBaseline.compilerPropertiesSha256, null);
  assert.equal(plan.nativeBaseline.compilerContractResolution, 'target-platform-at-execution');
  assert.deepEqual(plan.performanceQualification.fastProfileProbe, {
    operation: 'compile',
    profile: 'quick-fast',
    certificateGrantedByMeasurement: false,
    requiresSeparateEvaluationAndInstallation: true,
  });
  // The esp32c6 NativeRelink adapter is registered, so the plan documents it,
  // but a fast-profile probe without --require-ck-mode never becomes eligible.
  assert.equal(
    plan.performanceQualification.nativeRelinkAdapter?.id,
    'esp32-esp32c6-native-relink-v1',
  );
  assert.equal(plan.performanceQualification.eligible, false);

  const portablePlanned = runner.parseArgs([
    '--plan', '--fqbn', 'arduino:avr:uno', '--trials', '5',
    '--qualification-operation', 'compile',
    '--qualification-profile', 'portable-fast',
  ]);
  const portablePlan = runner.planFor(portablePlanned);
  assert.equal(portablePlanned.sequence, 'portable-edit');
  assert.equal(portablePlan.nativeBaseline.profile, 'portable-fast');
  assert.equal(portablePlan.nativeBaseline.cliConfigFile, 'arduino-cli-fast.yaml');
  assert.equal(
    portablePlan.performanceQualification.artifactEquivalencePolicyId,
    runner.GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.throws(() => runner.parseArgs([
    '--plan', '--qualification-operation', 'upload-ready',
    '--qualification-profile', 'portable-fast',
  ]), /compile only, not upload-ready/);

  const root = mkdtempSync(join(tmpdir(), 'ck-fast-profile-probe-'));
  try {
    const output = join(root, 'raw.json');
    const candidateOutput = join(root, 'candidate.json');
    const artifactBundle = join(root, 'candidate-artifacts');
    const failureLogs = join(root, 'failure-logs');
    const token = 'a'.repeat(64);
    assert.throws(() => runner.parseArgs([
      '--execute', '--allow-cache-reset', '--output', output,
      '--qualification-operation', 'upload-ready',
      '--qualification-profile', 'shared-fast',
    ], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token }), /--candidate-output/);
    const options = runner.parseArgs([
      '--execute', '--allow-cache-reset', '--output', output,
      '--candidate-output', candidateOutput,
      '--candidate-artifact-bundle', artifactBundle,
      '--failure-log-dir', failureLogs,
      '--qualification-operation', 'upload-ready',
      '--qualification-profile', 'shared-fast',
    ], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token });
    assert.equal(options.qualificationOperation, 'upload-ready');
    assert.equal(options.qualificationProfile, 'shared-fast');
    assert.equal(options.sequence, 'portable-edit');
    assert.equal(options.candidateArtifactBundlePath, artifactBundle);
    assert.equal(options.failureLogDirectoryPath, failureLogs);
    assert.throws(() => runner.parseArgs([
      '--plan', '--failure-log-dir', failureLogs,
    ]), /cannot write output/);
    assert.throws(() => runner.parseArgs([
      '--execute', '--allow-cache-reset', '--output', output,
      '--failure-log-dir', failureLogs,
    ], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token }), /Fast profile qualification/);
    assert.throws(() => runner.parseArgs([
      '--execute', '--allow-cache-reset', '--output', join(failureLogs, 'raw.json'),
      '--candidate-output', candidateOutput,
      '--failure-log-dir', failureLogs,
      '--qualification-operation', 'compile',
      '--qualification-profile', 'quick-fast',
    ], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token }), /must be separate/);
    assert.throws(() => runner.parseArgs([
      '--execute', '--allow-cache-reset', '--output', output,
      '--candidate-artifact-bundle', artifactBundle,
      '--qualification-operation', 'upload-ready',
      '--qualification-profile', 'shared-fast',
    ], { CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: token }), /requires --candidate-output/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('ESP32 family Fast probes share the generic profile path without NativeRelink inheritance', () => {
  const targets = [
    'esp32:esp32:esp32c3',
    'esp32:esp32:esp32c5',
    'esp32:esp32:esp32c6',
    'esp32:esp32:esp32s3',
    'esp32:esp32:esp32h2',
    'esp32:esp32:esp32p4',
    'esp32:esp32:adafruit_feather_esp32s3',
  ];

  for (const fqbn of targets) {
    const plan = runner.planFor(runner.parseArgs([
      '--plan', '--fqbn', fqbn,
      '--qualification-operation', 'compile',
      '--qualification-profile', 'quick-fast',
    ]));
    assert.equal(plan.fqbn, fqbn);
    assert.equal(plan.performanceQualification.profileProbeEligible, true);
    assert.deepEqual(plan.performanceQualification.fastProfileProbe, {
      operation: 'compile',
      profile: 'quick-fast',
      certificateGrantedByMeasurement: false,
      requiresSeparateEvaluationAndInstallation: true,
    });
    // Every generic ESP32 base carries its own registered NativeRelink
    // adapter row; named variants stay off the relink lane. A fast-profile
    // probe never becomes relink-eligible either way.
    const boardSegment = fqbn.split(':')[2];
    assert.equal(
      plan.performanceQualification.nativeRelinkAdapter?.id ?? null,
      fqbn === 'esp32:esp32:adafruit_feather_esp32s3'
        ? null
        : `esp32-${boardSegment}-native-relink-v1`,
    );
    assert.equal(plan.performanceQualification.eligible, false);
  }
});

test('cold desktop preflight allows bounded sysroot initialization time', () => {
  assert.equal(runner.cdpPreflightTimeoutMs(20 * 60_000), 60_000);
  assert.equal(runner.cdpPreflightTimeoutMs(30_000), 30_000);
  assert.throws(() => runner.cdpPreflightTimeoutMs(0), /positive finite/);
});

test('Arduino CLI barriers require complete idle windows and expose the lane-settle policy', async () => {
  let clock = 0;
  const observed = [2, 1, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0, 0];
  let index = 0;
  const result = await runner.waitForArduinoCliIdleWindow({
    idleWindowMs: 2_000,
    timeoutMs: 5_000,
    pollIntervalMs: 200,
    readProcessCount: () => observed[Math.min(index++, observed.length - 1)],
    now: () => clock,
    sleep: async (durationMs) => { clock += durationMs; },
  });
  assert.equal(result.policyId, 'arduino-cli-startup-idle-window-v1');
  assert.equal(result.waitedMs, 2_400);
  assert.equal(result.idleWindowMs, 2_000);
  assert.equal(result.polls, 13);

  let laneClock = 0;
  const laneObserved = [1, 0, 0, 0, 0, 0, 0];
  let laneIndex = 0;
  const laneResult = await runner.waitForArduinoCliIdleWindow({
    idleWindowMs: runner.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
    timeoutMs: runner.ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
    pollIntervalMs: runner.ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
    policyId: runner.ARDUINO_CLI_LANE_IDLE_POLICY_ID,
    phaseLabel: 'native lane boundary',
    readProcessCount: () => laneObserved[Math.min(laneIndex++, laneObserved.length - 1)],
    now: () => laneClock,
    sleep: async (durationMs) => { laneClock += durationMs; },
  });
  assert.equal(laneResult.policyId, 'arduino-cli-lane-idle-window-v1');
  assert.equal(laneResult.waitedMs, 600);
  assert.equal(laneResult.polls, 7);

  let timeoutClock = 0;
  await assert.rejects(
    runner.waitForArduinoCliIdleWindow({
      idleWindowMs: 500,
      timeoutMs: 1_000,
      pollIntervalMs: 200,
      readProcessCount: () => 1,
      readProcessDetails: () => [{
        processId: 42,
        parentProcessId: 7,
        creationDate: '20260725020000.000000+480',
      }],
      now: () => timeoutClock,
      sleep: async (durationMs) => { timeoutClock += durationMs; },
    }),
    (error) => {
      assert.match(error.message, /did not reach a 500ms idle window within 1000ms/);
      assert.equal(error.code, 'ARDUINO_CLI_IDLE_TIMEOUT');
      assert.equal(error.phaseLabel, 'startup');
      assert.equal(error.lastProcessCount, 1);
      assert.deepEqual(error.processes, [{
        processId: 42,
        parentProcessId: 7,
        creationDate: '20260725020000.000000+480',
      }]);
      assert.equal(error.processDetailsError, null);
      return true;
    },
  );
});

test('routine Arduino CLI idle polling avoids heavyweight WMI enumeration', () => {
  const source = readFileSync(ENTRY, 'utf8');
  const countStart = source.indexOf('function arduinoCliProcessCount(');
  const detailsStart = source.indexOf('function arduinoCliProcessDetails(');
  assert.ok(countStart >= 0 && detailsStart > countStart);
  const countSource = source.slice(countStart, detailsStart);
  assert.match(countSource, /Get-Process -Name 'arduino-cli'/u);
  assert.doesNotMatch(countSource, /Get-CimInstance/u);
});

test('CDP settings preflight is followed by a complete pre-trial idle proof before lane guard', async () => {
  const order = [];
  const result = await runner.runCdpPreflightAndWaitForPreTrialStability({
    evaluate: async (expression, timeoutMs) => {
      order.push('get-compile-settings');
      assert.match(expression, /get_compile_accel_settings/);
      assert.equal(timeoutMs, 30_000);
      return {
        invokeAvailable: true,
        url: 'http://tauri.localhost/',
        compileSettings: { max_jobs: 1, enabled: true },
      };
    },
    compileTimeoutMs: 30_000,
    expectedJobs: 1,
    waitForIdle: async (options) => {
      order.push('pre-trial-idle');
      assert.deepEqual(options, {
        idleWindowMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS,
        timeoutMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS,
        pollIntervalMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS,
        policyId: runner.ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID,
        phaseLabel: 'post-CDP preflight',
      });
      return {
        policyId: options.policyId,
        idleWindowMs: options.idleWindowMs,
        timeoutMs: options.timeoutMs,
        pollIntervalMs: options.pollIntervalMs,
        waitedMs: 2_400,
        polls: 13,
      };
    },
  });
  order.push('first-lane-assert');

  assert.deepEqual(order, [
    'get-compile-settings',
    'pre-trial-idle',
    'first-lane-assert',
  ]);
  assert.equal(result.backendJobs, 1);
  assert.deepEqual(result.compileSettings, { max_jobs: 1, enabled: true });
  assert.deepEqual(result.stability, {
    policyId: runner.ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID,
    idleWindowMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS,
    timeoutMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS,
    pollIntervalMs: runner.ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS,
    waitedMs: 2_400,
    polls: 13,
    trigger: 'get_compile_accel_settings',
    outsideMeasuredCompileWallTime: true,
    completedBeforeFirstLane: true,
  });
});

test('pre-trial idle timeout fails closed and the strict lane guard is unchanged', async () => {
  const order = [];
  await assert.rejects(
    runner.runCdpPreflightAndWaitForPreTrialStability({
      evaluate: async () => {
        order.push('get-compile-settings');
        return { invokeAvailable: true, compileSettings: { max_jobs: 1 } };
      },
      compileTimeoutMs: 30_000,
      expectedJobs: 1,
      waitForIdle: async () => {
        order.push('pre-trial-idle');
        throw new Error('Arduino CLI post-CDP preflight did not reach a complete idle window');
      },
    }),
    /did not reach a complete idle window/,
  );
  assert.deepEqual(order, ['get-compile-settings', 'pre-trial-idle']);
  assert.throws(
    () => runner.assertNoConcurrentArduinoCli(() => 1),
    /no-concurrent-compile guard found 1 active arduino-cli process/,
  );
  assert.throws(
    () => runner.assertNoConcurrentArduinoCli(() => -1),
    /invalid count/,
  );
});

test('formal mode plans remain inert and report output stays no-clobber', () => {
  const options = runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '5',
    '--fqbn', 'arduino:avr:uno',
    '--require-ck-mode', 'native-relink-compile-only',
  ]);
  const plan = runner.planFor(options);
  assert.equal(plan.outputWillBeWritten, false);
  assert.equal(plan.cacheWillBeReset, false);
  assert.equal(plan.performanceQualification.requiredCkMode, 'native-relink-compile-only');
  assert.equal(plan.performanceQualification.policy.minimumFormalTrials, 5);
  assert.equal(plan.performanceQualification.policy.p95Method, 'nearest-rank');
  assert.equal(plan.performanceQualification.policy.p95NoRegression, true);
  assert.deepEqual(plan.performanceQualification.editStageIds, [
    'complex', 'medium', 'simple-return',
  ]);

  const root = mkdtempSync(join(tmpdir(), 'ck-native-ab-no-clobber-'));
  const output = join(root, 'existing.json');
  try {
    writeFileSync(output, 'sentinel');
    assert.throws(() => runner.parseArgs([
      '--execute', '--allow-cache-reset', '--sequence', 'portable-edit',
      '--trials', '5', '--fqbn', 'arduino:avr:uno',
      '--require-ck-mode', 'native-relink-compile-only', '--output', output,
    ]), /refusing to overwrite existing report/);
    assert.equal(readFileSync(output, 'utf8'), 'sentinel');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('portable-edit plan is inert and declares the exact four-stage sequence', () => {
  const planned = spawnSync(process.execPath, [
    ENTRY, '--plan', '--sequence', 'portable-edit', '--trials', '3',
  ], { cwd: ROOT, encoding: 'utf8' });
  assert.equal(planned.status, 0, planned.stderr);
  const json = JSON.parse(planned.stdout.slice(0, planned.stdout.lastIndexOf('\nNo benchmark was started.')));
  assert.equal(json.measurementSequence, 'portable-edit');
  assert.equal(json.sameBuildPathWithinLane, true);
  assert.equal(json.exactAllowed, false);
  assert.equal(json.outputWillBeWritten, false);
  assert.equal(json.cacheWillBeReset, false);
  assert.equal(json.performanceQualification.eligible, false);
  // The default FQBN is esp32c6, whose registered adapter the plan documents;
  // without --require-ck-mode the plan still never becomes relink-eligible.
  assert.equal(
    json.performanceQualification.nativeRelinkAdapter?.id,
    'esp32-esp32c6-native-relink-v1',
  );
  assert.deepEqual(json.performanceQualification.editStageIds, [
    'complex', 'medium', 'simple-return',
  ]);
  assert.deepEqual(json.stages.map((stage) => stage.id), [
    'simple', 'complex', 'medium', 'simple-return',
  ]);
  assert.match(json.sourceSha256, /^[0-9a-f]{64}$/u);
});

test('adapter registry admits AVR, exact MKR Zero and exact generic ESP32 bases while other targets remain measurable', () => {
  assert.equal(runner.NATIVE_RELINK_ADAPTERS.length, 10);
  assert.equal(
    new Set(runner.NATIVE_RELINK_ADAPTERS.map((adapter) => adapter.id)).size,
    runner.NATIVE_RELINK_ADAPTERS.length,
  );
  const avr = runner.nativeRelinkAdapterFor('arduino:avr:uno', 'avr');
  assert.equal(avr.id, 'arduino-avr-native-relink-v1');
  assert.deepEqual([...avr.requiredArtifactRoles], ['avr-application-hex']);
  assert.deepEqual([...avr.witnessArtifactRoles], []);
  assert.deepEqual([...avr.optionalArtifactRoles], ['avr-eeprom']);
  assert.equal(runner.nativeRelinkAdapterFor('arduino:avr:uno', 'samd'), null);
  const mkrzero = runner.nativeRelinkAdapterFor('arduino:samd:mkrzero', 'samd');
  assert.equal(mkrzero.id, 'arduino-samd-mkrzero-native-relink-v1');
  assert.deepEqual(
    [...mkrzero.requiredArtifactRoles],
    ['samd-application-bin', 'samd-application-hex'],
  );
  assert.deepEqual([...mkrzero.witnessArtifactRoles], []);
  assert.equal(
    runner.nativeRelinkAdapterFor('arduino:samd:mkrzero:usbstack=arduino', 'samd')?.id,
    mkrzero.id,
  );
  for (const fqbn of [
    'arduino:samd:mkrzero_clone',
    'arduino:samd:mkrwifi1010',
    'arduino:samd:arduino_zero_native',
  ]) assert.equal(runner.nativeRelinkAdapterFor(fqbn, 'samd'), null);
  const esp32 = runner.nativeRelinkAdapterFor('esp32:esp32:esp32c6', 'esp32');
  assert.equal(esp32.id, 'esp32-esp32c6-native-relink-v1');
  assert.equal(
    esp32.engineContractId,
    'ck-native-relink-esp32-release-compile-only-phase1-v1',
  );
  assert.equal(
    esp32.artifactEquivalencePolicyId,
    'esp32-app-bin-witness-bootloader-partitions-exact-v1',
  );
  assert.deepEqual([...esp32.requiredArtifactRoles], ['bootloader-bin', 'partitions-bin']);
  assert.deepEqual([...esp32.witnessArtifactRoles], ['application-bin']);
  assert.deepEqual([...esp32.optionalArtifactRoles], []);
  assert.deepEqual([...esp32.forbiddenAllStageArtifactRoles], []);
  assert.deepEqual([...esp32.forbiddenCkEditArtifactRoles], []);
  assert.equal(
    runner.nativeRelinkAdapterFor(
      'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB', 'esp32',
    )?.id,
    esp32.id,
  );
  assert.equal(runner.nativeRelinkAdapterFor('esp32:esp32:esp32c6', 'avr'), null);
  for (const [fqbn, expectedId] of [
    ['esp32:esp32:esp32', 'esp32-esp32-native-relink-v1'],
    ['esp32:esp32:esp32s2', 'esp32-esp32s2-native-relink-v1'],
    ['esp32:esp32:esp32s3', 'esp32-esp32s3-native-relink-v1'],
    ['esp32:esp32:esp32c3', 'esp32-esp32c3-native-relink-v1'],
    ['esp32:esp32:esp32c5', 'esp32-esp32c5-native-relink-v1'],
    ['esp32:esp32:esp32h2', 'esp32-esp32h2-native-relink-v1'],
    ['esp32:esp32:esp32p4', 'esp32-esp32p4-native-relink-v1'],
  ]) {
    assert.equal(runner.nativeRelinkAdapterFor(fqbn, 'esp32')?.id, expectedId);
  }
  for (const fqbn of [
    'esp32:esp32:esp32c6_clone',
    'esp32:esp32:esp32wrover',
    'esp32:esp32:esp32da',
  ]) assert.equal(runner.nativeRelinkAdapterFor(fqbn, 'esp32'), null);

  const samd = runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '5',
    '--fqbn', 'arduino:samd:mkrzero',
    '--require-ck-mode', 'native-relink-compile-only',
  ]);
  const plan = runner.planFor(samd);
  assert.equal(plan.performanceQualification.eligible, true);
  assert.equal(
    plan.performanceQualification.nativeRelinkAdapter.id,
    'arduino-samd-mkrzero-native-relink-v1',
  );

  const esp32Plan = runner.planFor(runner.parseArgs([
    '--plan', '--sequence', 'portable-edit', '--trials', '5',
    '--fqbn', 'esp32:esp32:esp32c6',
    '--require-ck-mode', 'native-relink-compile-only',
  ]));
  assert.equal(esp32Plan.performanceQualification.eligible, true);
  assert.equal(
    esp32Plan.performanceQualification.nativeRelinkAdapter.id,
    'esp32-esp32c6-native-relink-v1',
  );
  assert.deepEqual(
    esp32Plan.performanceQualification.nativeRelinkAdapter.witnessArtifactRoles,
    ['application-bin'],
  );
});

test('qualification secret is removed case-insensitively from every child environment', () => {
  const sanitized = runner.sanitizedChildEnvironment({
    Path: 'C:\\Windows',
    CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN: 'a'.repeat(64),
    ck_forge_native_relink_qualification_token: 'b'.repeat(64),
    KEEP_ME: 'yes',
  });
  assert.deepEqual(sanitized, { Path: 'C:\\Windows', KEEP_ME: 'yes' });
  assert.doesNotMatch(JSON.stringify(sanitized), /a{64}|b{64}/u);
});

test('Windows process-tree termination is rooted at one validated child PID', () => {
  assert.deepEqual(runner.windowsTaskkillArgs(1234), ['/PID', '1234', '/T', '/F']);
  assert.throws(() => runner.windowsTaskkillArgs(0), /positive root PID/);
  assert.throws(() => runner.windowsTaskkillArgs(Number.NaN), /positive root PID/);
});

test('runner timeout terminates the complete owned process tree', { timeout: 5_000 }, async () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-native-ab-process-tree-'));
  const sentinel = join(root, 'grandchild-survived.txt');
  const grandchild = `
const fs = require('node:fs');
setTimeout(() => fs.writeFileSync(${JSON.stringify(sentinel)}, 'survived'), 800);
`;
  const parent = `
const { spawn } = require('node:child_process');
spawn(process.execPath, ['-e', ${JSON.stringify(grandchild)}], {
  windowsHide: true,
  stdio: 'ignore'
});
setInterval(() => {}, 1000);
`;
  try {
    await assert.rejects(
      runner.runProcess(process.execPath, ['-e', parent], 150),
      /exceeded/,
    );
    await new Promise((resolve) => setTimeout(resolve, 1_000));
    assert.equal(existsSync(sentinel), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('owned CKAB cleanup accounts bytes and verifies removal without following other roots', () => {
  const parent = join(tmpdir(), 'CKAB');
  const work = join(parent, `test-${process.pid}-${Date.now()}`);
  const unexpectedParent = mkdtempSync(join(tmpdir(), 'ck-native-ab-unowned-'));
  const unexpected = join(unexpectedParent, 'run');
  try {
    mkdirSync(join(work, 'nested'), { recursive: true });
    writeFileSync(join(work, 'one.bin'), Buffer.alloc(3));
    writeFileSync(join(work, 'nested', 'two.bin'), Buffer.alloc(5));
    assert.deepEqual(runner.inspectOwnedWorkdir(work), {
      measuredFileBytes: 8,
      regularFileCount: 2,
      directoryCount: 2,
      otherEntryCount: 0,
    });
    runner.safeRemoveWorkdir(work);
    assert.equal(existsSync(work), false);

    mkdirSync(unexpected);
    assert.throws(() => runner.safeRemoveWorkdir(unexpected), /unexpected A\/B work directory/);
    assert.equal(existsSync(unexpected), true);
  } finally {
    rmSync(work, { recursive: true, force: true });
    rmSync(unexpectedParent, { recursive: true, force: true });
  }
});

test('portable-edit qualification is library-free and returns to identical simple bytes', () => {
  const stages = runner.measurementStages('portable-edit');
  assert.equal(
    runner.AVR_NATIVE_RELINK_ADAPTER.engineContractId,
    'ck-native-relink-avr-release-compile-only-v2',
  );
  assert.equal(runner.validatePortableEditSequence(stages), true);
  assert.equal(stages[0].code, stages[3].code);
  assert.notEqual(stages[0].code, stages[1].code);
  assert.notEqual(stages[1].code, stages[2].code);
  for (const stage of stages) {
    assert.match(stage.code, /^#include <Arduino\.h>$/mu);
    assert.doesNotMatch(stage.code, /#include\s*[<"](?!Arduino\.h[>"])/u);
  }
  assert.equal(runner.validatePortableEditSequence([
    ...stages.slice(0, 3), { id: 'simple-return', code: `${stages[0].code}\n// changed` },
  ]), false);
});

test('native sequence source replacement preserves its project and build paths', () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-native-ab-sequence-'));
  const projectPath = join(root, 'project');
  const buildPath = join(root, 'build');
  const sourcePath = join(projectPath, 'project.ino');
  try {
    mkdirSync(projectPath);
    mkdirSync(buildPath);
    writeFileSync(sourcePath, runner.PORTABLE_SKETCH);
    const context = { projectPath, buildPath, sourcePath, codeSha256: '' };
    const beforeBuildPath = context.buildPath;
    const hash = runner.updateNativeTrialSource(context, runner.PORTABLE_EDIT_SEQUENCE[1].code);
    assert.equal(readFileSync(sourcePath, 'utf8'), runner.PORTABLE_EDIT_SEQUENCE[1].code);
    assert.equal(context.codeSha256, hash);
    assert.equal(context.buildPath, beforeBuildPath);
    assert.match(hash, /^[0-9a-f]{64}$/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('capture order alternates and the trial floor prevents one-shot claims', () => {
  assert.deepEqual(runner.captureOrder(5), [
    'ck-native', 'native-ck', 'ck-native', 'native-ck', 'ck-native',
  ]);
  assert.throws(
    () => runner.parseArgs(['--execute', '--allow-cache-reset', '--output', 'new.json', '--trials', '2']),
    /3\.\.25/,
  );
  assert.equal(
    runner.canonicalCompleteFqbn('esp32:esp32:esp32c6:PartitionScheme=default,FlashSize=4M'),
    'esp32:esp32:esp32c6:FlashSize=4M,PartitionScheme=default',
  );
  assert.equal(
    runner.canonicalCompleteFqbn(' vendor : arch : board : \u00e9 = two , z = one '),
    'vendor:arch:board:z=one,\u00e9=two',
  );
  assert.equal(
    runner.canonicalCompleteFqbn('vendor:arch:board:Key=one,\u212aey=two'),
    'vendor:arch:board:Key=one,\u212aey=two',
  );
  assert.equal(runner.canonicalCompleteFqbn('vendor:arch:board:Flash=8M,flash=16M'), null);
  assert.equal(runner.canonicalCompleteFqbn('vendor:arch:board:mode=a=b'), null);
});

test('effective job calculation mirrors the Rust compatibility rule', () => {
  assert.equal(runner.effectiveJobs('/missing-root', {}, 32), 16);
  assert.equal(runner.effectiveJobs('/missing-root', {}, 4), 4);
  assert.equal(runner.effectiveJobs('/missing-root', { CK_RESPECT_MAX_JOBS: 'true' }, 32), 16);
});

test('board details bind explicit menu selections even when Arduino reports only the base FQBN', () => {
  const details = {
    fqbn: 'STMicroelectronics:stm32:Nucleo_64',
    version: '2.12.0',
    platform: { architecture: 'stm32', name: 'STM32 MCU based boards' },
    config_options: [{
      option: 'pnum',
      values: [
        { value: 'NUCLEO_F401RE', selected: true },
        { value: 'NUCLEO_F411RE' },
      ],
    }],
  };
  assert.equal(runner.boardDetailsBindTarget(
    details,
    'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE',
  ), true);
  assert.equal(runner.boardDetailsBindTarget(
    details,
    'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F411RE',
  ), false);
});

test('resource and cache evidence fail closed', () => {
  assert.deepEqual(runner.parseResources(
    'Sketch uses 123 bytes (1%). Maximum is 1000 bytes.\nGlobal variables use 45 bytes (2%)',
  ), {
    evidenceComplete: true, flashUsedBytes: 123, ramUsedBytes: 45, warningCount: 0,
  });
  assert.equal(runner.parseResources(
    'foo.cpp:1:1: warning: unused variable\nSketch uses 123 bytes (1%).\nGlobal variables use 45 bytes (2%)\nWARNING: library quirk\n',
  ).warningCount, 2, 'every warning: line is counted with the same rule as CK evidence');
  assert.equal(runner.parseResources('compile succeeded').evidenceComplete, false);
  assert.equal(runner.resourcesEquivalent(
    { evidenceComplete: true, flashUsedBytes: 123, ramUsedBytes: 45 },
    { evidenceComplete: true, flashUsedBytes: 123, ramUsedBytes: 45 },
  ), true);
  assert.equal(runner.resourcesEquivalent(
    { evidenceComplete: true, flashUsedBytes: 123, ramUsedBytes: 45 },
    { evidenceComplete: true, flashUsedBytes: 124, ramUsedBytes: 45 },
  ), false);
  assert.equal(runner.validateCacheClear({
    fqbn: 'esp32:esp32:esp32c6',
    reset_scope: 'first-project-full-fqbn',
    force_rebuild_pending: false,
    ccache_store_preserved: true,
    prebuilt_core_preserved: false,
  }, 'esp32:esp32:esp32c6').passed, true);
  assert.equal(runner.validateCacheClear({
    fqbn: 'esp32:esp32:esp32c6',
    reset_scope: 'first-project-full-fqbn',
    force_rebuild_pending: false,
    ccache_store_preserved: true,
    prebuilt_core_preserved: true,
  }, 'esp32:esp32:esp32c6').passed, false);
});

test('ESP8266 resource evidence requires and sums the complete native segment set', () => {
  const native = `
. Variables and constants in RAM (global, static), used 28156 / 80192 bytes (35%)
║   SEGMENT  BYTES    DESCRIPTION
╠══ DATA     1496     initialized variables
╠══ RODATA   956      constants
╚══ BSS      25704    zeroed variables
. Instruction RAM (IRAM_ATTR, ICACHE_RAM_ATTR), used 59747 / 65536 bytes (91%)
║   SEGMENT  BYTES    DESCRIPTION
╠══ ICACHE   32768    reserved space for flash instruction cache
╚══ IRAM     26979    code in IRAM
. Code in flash (default, ICACHE_FLASH_ATTR), used 240256 / 1048576 bytes (22%)
║   SEGMENT  BYTES    DESCRIPTION
╚══ IROM     240256   code in flash
`;
  assert.deepEqual(runner.parseResources(native), {
    evidenceComplete: true,
    flashUsedBytes: 269687,
    ramUsedBytes: 28156,
    warningCount: 0,
  });
  assert.deepEqual(runner.parseResources(`
. Variables and constants in RAM (global, static), used 28156 / 80192 bytes (35%)
. Code in flash (default, ICACHE_FLASH_ATTR), used 240256 / 1048576 bytes (22%)
╚══ IROM     240256   code in flash
`), {
    evidenceComplete: false,
    flashUsedBytes: null,
    ramUsedBytes: null,
    warningCount: 0,
  });
});

test('CK compiler evidence rejects Exact and incremental work in the fresh lane', () => {
  const log = '[INFO] Compile parallel jobs: 8\n';
  const controlledProbe = (buildMode, fallbackUsed = false) => ({
    authorized: true,
    authorization: 'startup-token',
    operation: 'compile',
    profile: 'quick-fast',
    selectedProfile: 'quick-fast',
    candidateRoute: 'qualification-token-probe',
    observedBuildMode: buildMode,
    fallbackUsed,
    exactReuseDenied: true,
    physicalUploadPerformed: false,
    recipeCapability: {
      schemaVersion: 2,
      baselineSha256: 'a'.repeat(64),
      observationOnly: true,
      capabilityGatePassed: true,
      requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
      missingCapabilities: [],
    },
  });
  assert.deepEqual(runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'fresh', 8), {
    observedJobs: 8,
    jobsEvidenceSource: 'compile-log',
    exactUsed: false,
  });
  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'release',
  }, '', 'fresh', 8).jobsEvidenceSource, 'backend-settings-preflight');
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'exact-match',
    cache: { exactMatch: true },
    profile: 'release',
  }, log, 'fresh', 8), /returned Exact/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-incremental',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'fresh', 8), /unsupported buildMode/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-incremental',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'simple', 8), /unsupported buildMode/);
  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-incremental',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'complex', 8).exactUsed, false);
  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'native-relink-compile-only',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'complex', 8).exactUsed, false);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'native-relink-compile-only',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'simple', 8), /unsupported buildMode/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'release',
  }, log, 'fresh', 16), /did not match native jobs/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'quick-fast',
  }, log, 'fresh', 8), /does not match requested release/);

  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: {
      authorized: true,
      authorization: 'startup-token',
      operation: 'compile',
      profile: 'quick-fast',
      selectedProfile: 'quick-fast',
      candidateRoute: 'qualification-token-probe',
      observedBuildMode: 'full-build',
      fallbackUsed: false,
      exactReuseDenied: true,
      physicalUploadPerformed: false,
      recipeCapability: {
        schemaVersion: 2,
        baselineSha256: 'a'.repeat(64),
        observationOnly: true,
        capabilityGatePassed: true,
        requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
        missingCapabilities: [],
      },
    },
  }, log, 'fresh', 8, 'compile', 'quick-fast').exactUsed, false);
  assert.deepEqual(runner.validateCkCompilerEvidence({
    buildMode: 'fast-relink',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: controlledProbe('fast-relink'),
  }, log, 'complex', 8, 'compile', 'quick-fast'), {
    observedJobs: 8,
    jobsEvidenceSource: 'compile-log',
    exactUsed: false,
    recipeCapability: controlledProbe('fast-relink').recipeCapability,
    candidateRoute: 'qualification-token-probe',
    fallbackUsed: false,
  });
  const missingAuthorization = controlledProbe('fast-relink');
  delete missingAuthorization.authorization;
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'fast-relink',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: missingAuthorization,
  }, log, 'complex', 8, 'compile', 'quick-fast'), /missing or mismatched/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'fast-relink',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: controlledProbe('fast-relink', true),
  }, log, 'complex', 8, 'compile', 'quick-fast'), /missing or mismatched/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-full-fallback',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: controlledProbe('arduino-cli-full-fallback', true),
  }, log, 'simple', 8, 'compile', 'quick-fast'), /unsupported buildMode/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: controlledProbe('full-build'),
  }, log, 'complex', 8, 'compile', 'quick-fast'), /unsupported buildMode/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'quick-fast',
    qualificationProbe: {
      authorized: true,
      authorization: 'startup-token',
      operation: 'compile',
      profile: 'quick-fast',
      selectedProfile: 'quick-fast',
      candidateRoute: 'qualification-token-probe',
      observedBuildMode: 'full-build',
      fallbackUsed: false,
      exactReuseDenied: true,
      physicalUploadPerformed: false,
      recipeCapability: {
        schemaVersion: 2,
        baselineSha256: 'a'.repeat(64),
        observationOnly: true,
        capabilityGatePassed: false,
        requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
        missingCapabilities: ['core_archive_reuse'],
      },
    },
  }, log, 'fresh', 8, 'compile', 'quick-fast'), /recipe capability gate did not pass/);
  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false },
    profile: 'shared-fast',
    qualificationProbe: {
      authorized: true,
      authorization: 'startup-token',
      operation: 'upload-ready',
      profile: 'shared-fast',
      selectedProfile: 'shared-fast',
      candidateRoute: 'qualification-token-probe',
      observedBuildMode: 'full-build',
      fallbackUsed: false,
      exactReuseDenied: true,
      physicalUploadPerformed: false,
    },
  }, log, 'fresh', 8, 'upload-ready', 'shared-fast').exactUsed, false);

  const portableRecipe = {
    schemaVersion: 2,
    baselineSha256: 'b'.repeat(64),
    intent: 'native-recipe-cache',
    observationOnly: true,
    capabilityGatePassed: true,
    requiredCapabilities: ['sketch_compile', 'native_recipe_cache'],
    missingCapabilities: [],
  };
  const portableProbe = (buildMode, recipe = portableRecipe) => ({
    authorized: true,
    authorization: 'startup-token',
    operation: 'compile',
    profile: 'portable-fast',
    selectedProfile: 'portable-fast',
    candidateRoute: 'qualification-token-probe',
    observedBuildMode: buildMode,
    fallbackUsed: false,
    exactReuseDenied: true,
    physicalUploadPerformed: false,
    recipeCapability: recipe,
  });
  assert.deepEqual(runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-incremental',
    cache: { exactMatch: false, ccacheEnabled: true },
    profile: 'portable-fast',
    qualificationProbe: portableProbe('arduino-cli-incremental'),
  }, log, 'complex', 8, 'compile', 'portable-fast'), {
    observedJobs: 8,
    jobsEvidenceSource: 'compile-log',
    exactUsed: false,
    recipeCapability: portableRecipe,
    candidateRoute: 'qualification-token-probe',
    fallbackUsed: false,
    ccacheEnabled: true,
  });
  assert.equal(runner.validateCkCompilerEvidence({
    buildMode: 'arduino-cli-core-seeded',
    cache: { exactMatch: false, ccacheEnabled: true },
    profile: 'portable-fast',
    qualificationProbe: portableProbe('arduino-cli-core-seeded'),
  }, log, 'simple', 8, 'compile', 'portable-fast').ccacheEnabled, true);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false, ccacheEnabled: false },
    profile: 'portable-fast',
    qualificationProbe: portableProbe('full-build'),
  }, log, 'simple', 8, 'compile', 'portable-fast'), /ccacheEnabled=true/);
  assert.throws(() => runner.validateCkCompilerEvidence({
    buildMode: 'full-build',
    cache: { exactMatch: false, ccacheEnabled: true },
    profile: 'portable-fast',
    qualificationProbe: portableProbe('full-build', { ...portableRecipe, intent: 'direct-link' }),
  }, log, 'simple', 8, 'compile', 'portable-fast'), /recipe capability intent/);
  for (const buildMode of ['fast-relink', 'native-relink-compile-only', 'native-relink-graph-transition']) {
    assert.throws(() => runner.validateCkCompilerEvidence({
      buildMode,
      cache: { exactMatch: false, ccacheEnabled: true },
      profile: 'portable-fast',
      qualificationProbe: portableProbe(buildMode),
    }, log, 'complex', 8, 'compile', 'portable-fast'), /unsupported buildMode/);
  }
});

test('recipe capability observation is an authenticated post-compile evidence step', async () => {
  const recipe = {
    schemaVersion: 2,
    baselineSha256: 'b'.repeat(64),
    observationOnly: true,
    capabilityGatePassed: true,
    requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
    missingCapabilities: [],
  };
  let invocation = '';
  const observed = await runner.observeCkRecipeCapability(
    async (script) => {
      invocation = script;
      return { ok: true, recipe };
    },
    'esp32:esp32:esp32c6',
    'C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\qualification\\build',
    1_000,
    'qualification-token',
    'compile',
    'quick-fast',
  );
  assert.deepEqual(observed, recipe);
  assert.match(invocation, /observe_forge_recipe_capability/u);
  assert.match(invocation, /qualificationToken/u);
  await assert.rejects(
    () => runner.observeCkRecipeCapability(
      async () => ({ ok: true, recipe }),
      'esp32:esp32:esp32c6',
      'relative-build',
      1_000,
      'qualification-token',
      'compile',
      'quick-fast',
    ),
    /absolute managed build path/u,
  );
  await assert.rejects(
    () => runner.observeCkRecipeCapability(
      async () => ({ ok: true, recipe: { ...recipe, missingCapabilities: ['direct_link'] } }),
      'esp32:esp32:esp32c6',
      'C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\qualification\\build',
      1_000,
      'qualification-token',
      'compile',
      'quick-fast',
    ),
    /recipe capability gate did not pass/u,
  );
});

test('recipe capability gate retains bounded redacted blocker evidence', async () => {
  const secret = 'a'.repeat(64);
  const failedRecipe = {
    schemaVersion: 2,
    baselineSha256: 'b'.repeat(64),
    observationOnly: true,
    capabilityGatePassed: false,
    requiredCapabilities: ['sketch_compile', 'artifact_roles_complete'],
    missingCapabilities: ['artifact_roles_complete'],
    blockers: {
      artifact_roles_complete: [
        'prebuild artifact C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\sketch.ino.bootloader.bin has no unique effective producer',
        `authorization=${secret}`,
        'partition recipe was observed but did not name one manifest artifact',
        'merged image output was not an explicit final artifact',
        'this fifth reason must not be retained',
      ],
      sketch_compile: ['an irrelevant non-missing capability must not be retained'],
    },
  };
  const diagnostics = runner.recipeCapabilityFailureDiagnosticsFromRecipe(failedRecipe);
  assert.deepEqual(diagnostics.missingCapabilities, ['artifact_roles_complete']);
  assert.equal(diagnostics.truncated, true);
  assert.equal(diagnostics.blockers.artifact_roles_complete.length, 4);
  assert.match(diagnostics.blockers.artifact_roles_complete[0], /bootloader/u);
  assert.doesNotMatch(JSON.stringify(diagnostics), /C:\\Users\\AI|a{64}|irrelevant non-missing|fifth reason/u);

  const passRecipe = {
    schemaVersion: 2,
    baselineSha256: 'c'.repeat(64),
    observationOnly: true,
    capabilityGatePassed: true,
    requiredCapabilities: ['sketch_compile', 'artifact_roles_complete'],
    missingCapabilities: [],
  };
  const raw = JSON.stringify({
    diagnostics: {
      buildMode: 'full-build',
      profile: 'quick-fast',
      cache: { exactMatch: false },
      qualificationProbe: {
        authorized: true,
        authorization: 'startup-token',
        operation: 'compile',
        profile: 'quick-fast',
        selectedProfile: 'quick-fast',
        candidateRoute: 'qualification-token-probe',
        observedBuildMode: 'full-build',
        fallbackUsed: false,
        exactReuseDenied: true,
        physicalUploadPerformed: false,
        recipeCapability: passRecipe,
      },
    },
    log: '[INFO] Compile parallel jobs: 8\nPRIVATE_COMPILER_TRACE',
    qualificationDiagnosticTrace: 'PRIVATE_QUALIFICATION_TRACE',
    path: 'C:\\Users\\AI\\AppData\\Local\\Temp\\CK_Builds\\qualification\\build',
  });
  let retainedError;
  await assert.rejects(
    () => runner.runCkCompile(
      async (script) => script.includes('observe_forge_recipe_capability')
        ? { ok: true, recipe: failedRecipe }
        : { ok: true, raw, pageWallMs: 1 },
      'esp32:esp32:esp32c6',
      '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n',
      'simple',
      'trial-001',
      1_000,
      8,
      'qualification-token',
      'compile',
      'quick-fast',
    ),
    (error) => {
      retainedError = error;
      assert.equal(error.code, 'CK_RECIPE_CAPABILITY_GATE');
      assert.match(error.message, /artifact_roles_complete/u);
      assert.match(error.message, /bootloader/u);
      assert.doesNotMatch(error.message, /C:\\Users\\AI|a{64}/u);
      assert.equal(Object.keys(error).includes('recipeCapabilityFailureDiagnostics'), false);
      return true;
    },
  );
  assert.deepEqual(runner.recipeCapabilityGateFailureDiagnostics(retainedError), diagnostics);

  const root = mkdtempSync(join(tmpdir(), 'ck-recipe-capability-failure-log-'));
  const failureLogDirectory = join(root, 'failure-logs');
  try {
    const retainedPath = runner.retainLocalQualificationFailureLog(
      failureLogDirectory,
      retainedError,
    );
    assert.equal(retainedPath, join(failureLogDirectory, 'trial-001-recipe-capability.log'));
    const retained = readFileSync(retainedPath, 'utf8');
    assert.match(retained, /gate=recipe-capability/u);
    assert.match(retained, /recipe-capability-blockers/u);
    assert.match(retained, /bootloader/u);
    assert.doesNotMatch(retained, /C:\\Users\\AI|a{64}|PRIVATE_COMPILER_TRACE|PRIVATE_QUALIFICATION_TRACE/u);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('Fast Relink fallback qualification failure keeps only fixed diagnostic fields', async () => {
  const rawFailureDetail = '[DIAG] Fast Relink raw failure detail:\nprivate C:\\Users\\AI\\core command\n';
  const compilerLog = 'Sketch uses 123 bytes of program storage space.\n';
  const compileResult = (fallbackCode) => ({
    ok: true,
    pageWallMs: 1,
    raw: JSON.stringify({
      diagnostics: {
        buildMode: 'arduino-cli-full-fallback',
        profile: 'quick-fast',
        cache: {
          exactMatch: false,
          fastRelinkFallbackCode: fallbackCode,
        },
      },
      log: compilerLog,
      qualificationDiagnosticTrace: rawFailureDetail,
    }),
  });
  const invoke = (fallbackCode) => runner.runCkCompile(
    async () => compileResult(fallbackCode),
    'esp32:esp32:esp32c6',
    '#include <Arduino.h>\nvoid setup() {}\nvoid loop() {}\n',
    'complex',
    'trial-001',
    1_000,
    8,
    'qualification-token',
    'compile',
    'quick-fast',
  );

  let retainedError;
  await assert.rejects(invoke('ccdb'), (error) => {
    retainedError = error;
    assert.equal(error.code, 'CK_FAST_RELINK_FALLBACK');
    assert.equal(error.phase, 'complex');
    assert.equal(error.buildMode, 'arduino-cli-full-fallback');
    assert.equal(error.fallbackCode, 'ccdb');
    assert.equal(error.message, 'CK complex qualification rejected Fast Relink fallback');
    assert.equal(Object.keys(error).includes('localQualificationFailureEvidence'), false);
    assert.equal(error.localQualificationFailureEvidence.diagnosticTrace, rawFailureDetail);
    assert.equal(error.localQualificationFailureEvidence.compilerLog, compilerLog);
    assert.doesNotMatch(JSON.stringify(error), /private|raw failure detail/iu);
    return true;
  });

  const root = mkdtempSync(join(tmpdir(), 'ck-fast-failure-log-'));
  const failureLogDirectory = join(root, 'failure-logs');
  try {
    const retainedPath = runner.retainLocalQualificationFailureLog(
      failureLogDirectory,
      retainedError,
    );
    assert.equal(retainedPath, join(failureLogDirectory, 'trial-001-complex.log'));
    const retained = readFileSync(retainedPath, 'utf8');
    assert.match(retained, /fallbackCode=ccdb/u);
    assert.match(retained, /Fast Relink raw failure detail/u);
    assert.match(retained, /Sketch uses 123 bytes/u);
    assert.throws(
      () => runner.retainLocalQualificationFailureLog(failureLogDirectory, retainedError),
      /EEXIST/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }

  await assert.rejects(invoke('C:\\Users\\AI\\raw-compiler-output'), (error) => {
    assert.notEqual(error.code, 'CK_FAST_RELINK_FALLBACK');
    assert.match(error.message, /unsupported buildMode/);
    assert.doesNotMatch(error.message, /raw-compiler-output/);
    return true;
  });
  assert.equal(runner.validatedFastRelinkFallbackCode('artifacts'), 'artifacts');
  assert.equal(
    runner.validatedFastRelinkFallbackCode('prebuild-hooks'),
    'prebuild-hooks',
  );
  assert.equal(runner.validatedFastRelinkFallbackCode('unknown'), null);
  assert.deepEqual(runner.fastRelinkFallbackFailureDiagnostics({
    code: 'CK_FAST_RELINK_FALLBACK',
    phase: 'complex',
    buildMode: 'arduino-cli-full-fallback',
    fallbackCode: 'ccdb',
  }), {
    code: 'CK_FAST_RELINK_FALLBACK',
    phase: 'complex',
    buildMode: 'arduino-cli-full-fallback',
    fallbackCode: 'ccdb',
  });
  assert.deepEqual(runner.fastRelinkFallbackFailureDiagnostics({
    code: 'CK_FAST_RELINK_FALLBACK',
    phase: 'C:\\private',
    buildMode: 'secret compiler command',
    fallbackCode: 'raw output',
  }), {
    code: 'CK_FAST_RELINK_FALLBACK',
    phase: 'unknown',
    buildMode: 'unknown',
    fallbackCode: 'other',
  });
});

test('summary preserves raw samples instead of hiding them behind a median', () => {
  const trials = [
    { ck: { fresh: { wallMs: 90 } }, native: { fresh: { wallMs: 100 } } },
    { ck: { fresh: { wallMs: 110 } }, native: { fresh: { wallMs: 105 } } },
    { ck: { fresh: { wallMs: 95 } }, native: { fresh: { wallMs: 102 } } },
  ];
  assert.deepEqual(runner.summarize(trials, 'fresh').ckRawMs, [90, 110, 95]);
  assert.deepEqual(runner.summarize(trials, 'fresh').nativeRawMs, [100, 105, 102]);
  assert.equal(runner.summarize(trials, 'fresh').ckMedianMs, 95);
  assert.equal(runner.summarize(trials, 'fresh').nativeMedianMs, 102);
  assert.equal(runner.summarize(trials, 'fresh').ckP95Ms, 110);
  assert.equal(runner.summarize(trials, 'fresh').nativeP95Ms, 105);
  assert.equal(runner.median([4, 2, 3, 1]), 2.5);
  assert.equal(runner.percentileNearestRank([4, 2, 3, 1, 5], 95), 5);
});

test('Fast profile native baseline uses the managed config and derives final Core flags safely', () => {
  const baseline = runner.nativeBaselineContract('quick-fast');
  assert.equal(baseline.profile, 'quick-fast');
  assert.equal(baseline.cliConfigPath, runner.FAST_CLI_CONFIG);
  assert.match(baseline.cliConfigLabel, /arduino-cli-fast\.yaml$/u);
  assert.deepEqual(baseline.buildProperties, runner.FAST_PROFILE_NATIVE_BUILD_PROPERTIES);
  assert.equal(
    runner.nativeBaselineCompilerPropertiesSha256('quick-fast'),
    runner.digestObject(runner.FAST_PROFILE_NATIVE_BUILD_PROPERTIES),
  );
  const release = runner.nativeBaselineContract();
  assert.equal(release.profile, 'release');
  assert.deepEqual(release.buildProperties, []);
  const portable = runner.nativeBaselineContract('portable-fast');
  assert.equal(portable.profile, 'portable-fast');
  assert.equal(portable.cliConfigPath, runner.FAST_CLI_CONFIG);
  assert.match(portable.cliConfigLabel, /arduino-cli-fast\.yaml$/u);
  assert.deepEqual(portable.buildProperties, []);
  assert.equal(portable.compilerPropertiesSha256, runner.digestObject([]));

  const platform = [
    '# a Core may place SDK response files in the base C/C++ flags',
    'compiler.c.flags=-MMD -c "@{compiler.sdk.path}/c_flags" {compiler.optimization_flags}',
    'compiler.c.flags.windows=-MMD -c "@{compiler.sdk.path}/c_flags.windows"',
    'compiler.cpp.flags=-MMD -c "@{compiler.sdk.path}/cpp_flags" {compiler.optimization_flags}',
    'compiler.S.flags=-MMD -c "@{compiler.sdk.path}/asm_flags"',
    'compiler.cpp.extra_flags=-DIGNORED',
    'compiler.c.flags.preconfigured=-MMD {compiler.ck.final_flags}',
  ].join('\n');
  assert.deepEqual(runner.fastFinalFlagPropertiesFromPlatformText(platform), [
    ['compiler.c.flags', '-MMD -c "@{compiler.sdk.path}/c_flags" {compiler.optimization_flags} {compiler.ck.final_flags}'],
    ['compiler.c.flags.windows', '-MMD -c "@{compiler.sdk.path}/c_flags.windows" {compiler.ck.final_flags}'],
    ['compiler.cpp.flags', '-MMD -c "@{compiler.sdk.path}/cpp_flags" {compiler.optimization_flags} {compiler.ck.final_flags}'],
  ]);
  assert.throws(() => runner.fastFinalFlagPropertiesFromPlatformText(null), /must be text/);
  assert.equal(runner.corePackageFromFqbn('arduino:avr:uno'), 'arduino');
  assert.equal(
    runner.corePackageFromFqbn('STMicroelectronics:stm32:GenF4'),
    'STMicroelectronics',
  );
});

test('profile candidate binds EXE, Core/tool content, complete FQBN, operation and profile', () => {
  const content = '7'.repeat(64);
  const resolvedNativeBaselineSha256 = 'd'.repeat(64);
  const stages = runner.PORTABLE_EDIT_SEQUENCE.map((stage) => ({
    id: stage.id,
    sourceSha256: runner.sha256Bytes(stage.code),
  }));
  const sequenceSha256 = runner.digestObject(stages);
  const makeRun = (wallMs, lane, stage, trialIndex) => {
    const elf = {
      name: `${lane}-${stage.id}.ino.elf`,
      role: 'application-elf',
      bytes: 4096,
      sha256: 'e'.repeat(64),
      primaryApplication: true,
    };
    // QuickFast's compile-only lane may stop after the linker produces the
    // semantic ELF. Native Arduino CLI still produces upload packaging.
    const artifacts = lane === 'ck' ? [elf] : [
      elf,
      {
        name: `${lane}-${stage.id}.ino.bin`,
        role: 'application-bin',
        bytes: 3072,
        sha256: 'f'.repeat(64),
        primaryApplication: true,
      },
      {
        name: `${lane}-${stage.id}.ino.bootloader.bin`,
        role: 'bootloader-bin',
        bytes: 128,
        sha256: '1'.repeat(64),
        primaryApplication: false,
      },
      {
        name: 'flash_args',
        role: 'flash-arguments',
        bytes: 64,
        sha256: '2'.repeat(64),
        primaryApplication: false,
      },
    ];
    return {
      success: true,
      wallMs,
      artifactsVerified: true,
      exactUsed: false,
      evidenceSha256: (lane === 'ck' ? 'a' : 'b').repeat(64),
      artifactSetSha256: runner.digestObject(artifacts),
      artifacts,
      codeSha256: stage.sourceSha256,
      buildPathIdentitySha256: runner.sha256Bytes(`${lane}-trial-${trialIndex}`),
      resources: {
        evidenceComplete: true,
        flashUsedBytes: 1024,
        ramUsedBytes: 128,
        warningCount: 0,
      },
      toolchainKey: `esp32|esp32|3.3.6|${content}`,
      route: lane === 'ck' ? { contractId: 'ck-fast-contract-fixture' } : null,
      buildMode: lane === 'ck'
        ? stage.id === 'simple' ? 'full-build' : 'fast-relink'
        : 'arduino-cli-full',
      profile: 'quick-fast',
      qualificationOperation: lane === 'ck' ? 'compile' : null,
      qualificationProfile: 'quick-fast',
      candidateRoute: lane === 'ck' ? 'qualification-token-probe' : undefined,
      fallbackUsed: lane === 'ck' ? false : undefined,
      compilerPropertyDeltaSha256: lane === 'native'
        ? resolvedNativeBaselineSha256
        : undefined,
      recipeCapability: lane === 'ck' ? {
        schemaVersion: 2,
        baselineSha256: runner.sha256Bytes(`${stage.id}-${trialIndex}`),
        observationOnly: true,
        capabilityGatePassed: true,
        requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
        missingCapabilities: [],
      } : undefined,
    };
  };
  const report = {
    measurementStatus: 'passed',
    runner: { unchanged: true },
    productionExecutable: { unchanged: true },
    identity: {
      fqbn: 'esp32:esp32:esp32c6:PartitionScheme=default,FlashSize=4M',
      corePackage: 'esp32',
      coreArchitecture: 'esp32',
      coreVersion: '3.3.6',
      sketchSha256: stages[0].sourceSha256,
      sequenceSha256,
      cliExecutableSha256: '2'.repeat(64),
      cliConfigSha256: '5'.repeat(64),
      cliVersion: 'arduino-cli Version: 1.4.1',
      hostIdentitySha256: '3'.repeat(64),
      productionExecutableSha256: '4'.repeat(64),
    },
    controls: {
      measurementSequence: 'portable-edit',
      sameBuildPathWithinLane: true,
      nativeBaselineCompilerPropertiesSha256: resolvedNativeBaselineSha256,
      reproducibleBuildEnvironment: runner.qualificationReproducibility({
        SOURCE_DATE_EPOCH: runner.QUALIFICATION_SOURCE_DATE_EPOCH,
        TZ: runner.QUALIFICATION_TIME_ZONE,
      }),
    },
    stages,
    captureOrder: ['ck-native', 'native-ck', 'ck-native', 'native-ck', 'ck-native'],
    trials: Array.from({ length: 5 }, (_, index) => {
      const order = index % 2 === 0 ? 'ck-native' : 'native-ck';
      const trial = {
        id: `trial-${index + 1}`,
        order,
        ck: {},
        native: {},
        laneBoundaryIdle: order.split('-').map((lane) => ({
          lane,
          policyId: runner.ARDUINO_CLI_LANE_IDLE_POLICY_ID,
          idleWindowMs: runner.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
          timeoutMs: runner.ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
          pollIntervalMs: runner.ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
          waitedMs: runner.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
          polls: 6,
        })),
      };
      for (const stage of stages) {
        trial.ck[stage.id] = makeRun(8_000 + index, 'ck', stage, index);
        trial.native[stage.id] = makeRun(10_000 + index, 'native', stage, index);
      }
      return trial;
    }),
  };
  const candidate = runner.performanceCandidateFromReport(report, {
    qualificationOperation: 'compile',
    qualificationProfile: 'quick-fast',
  });
  assert.equal(
    candidate.lanes.ck.identity.fqbn,
    'esp32:esp32:esp32c6:FlashSize=4M,PartitionScheme=default',
  );
  assert.equal(candidate.lanes.ck.identity.toolchainContentSha256, content);
  assert.equal(candidate.lanes.ck.identity.productionExecutableSha256, '4'.repeat(64));
  assert.equal(candidate.operation, 'compile');
  assert.equal(candidate.candidateProfile, 'quick-fast');
  assert.equal(
    candidate.artifactEquivalencePolicyId,
    runner.COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(candidate.lanes.ck.identity.cliConfigSha256, '5'.repeat(64));
  assert.equal(
    candidate.nativeBaselineCompilerPropertiesSha256,
    resolvedNativeBaselineSha256,
  );
  assert.equal(candidate.lanes.native.trials[0].simple.profile, 'quick-fast');
  assert.equal(
    candidate.lanes.native.trials[0].simple.compilerPropertyDeltaSha256,
    candidate.nativeBaselineCompilerPropertiesSha256,
  );
  assert.equal(candidate.schemaVersion, 4);
  assert.equal(candidate.measurementSequence, 'portable-edit');
  assert.equal(candidate.sequenceSha256, sequenceSha256);
  assert.deepEqual(candidate.stages, stages);
  assert.equal(candidate.lanes.ck.trials[0].complex.ckContractId, 'ck-fast-contract-fixture');
  assert.equal(candidate.lanes.ck.trials[0].simple.buildMode, 'full-build');
  assert.equal(candidate.lanes.ck.trials[0].complex.buildMode, 'fast-relink');
  assert.equal(candidate.lanes.ck.trials[0].complex.candidateRoute, 'qualification-token-probe');
  assert.equal(candidate.lanes.ck.trials[0].complex.fallbackUsed, false);
  assert.equal(candidate.lanes.ck.trials[0].medium.recipeCapability.capabilityGatePassed, true);
  assert.deepEqual(candidate.lanes.ck.identity, candidate.lanes.native.identity);

  const portableReport = JSON.parse(JSON.stringify(report));
  portableReport.controls.nativeBaselineCompilerPropertiesSha256 = runner.digestObject([]);
  for (const trial of portableReport.trials) {
    for (const stage of stages) {
      const ckRun = trial.ck[stage.id];
      const nativeRun = trial.native[stage.id];
      ckRun.profile = 'portable-fast';
      ckRun.qualificationProfile = 'portable-fast';
      ckRun.buildMode = stage.id === 'simple' ? 'full-build' : 'arduino-cli-incremental';
      ckRun.ccacheEnabled = true;
      ckRun.recipeCapability.intent = 'native-recipe-cache';
      nativeRun.profile = 'portable-fast';
      nativeRun.qualificationProfile = 'portable-fast';
      nativeRun.compilerPropertyDeltaSha256 = runner.digestObject([]);
      nativeRun.artifacts = ckRun.artifacts.map((artifact) => ({ ...artifact }));
      nativeRun.artifactSetSha256 = runner.digestObject(nativeRun.artifacts);
    }
  }
  const portableCandidate = runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile',
    qualificationProfile: 'portable-fast',
  });
  assert.equal(portableCandidate.candidateProfile, 'portable-fast');
  assert.equal(
    portableCandidate.artifactEquivalencePolicyId,
    runner.GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(portableCandidate.nativeBaselineCompilerPropertiesSha256, runner.digestObject([]));
  assert.equal(portableCandidate.lanes.ck.trials[0].medium.ccacheEnabled, true);
  assert.equal(
    portableCandidate.lanes.ck.trials[0].medium.recipeCapability.intent,
    'native-recipe-cache',
  );
  portableReport.trials[0].ck.medium.ccacheEnabled = false;
  assert.throws(() => runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile', qualificationProfile: 'portable-fast',
  }), /controlled Fast route\/build-mode\/capability gate/);
  portableReport.trials[0].ck.medium.ccacheEnabled = true;
  portableReport.trials[0].ck.medium.recipeCapability.intent = 'direct-link';
  assert.throws(() => runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile', qualificationProfile: 'portable-fast',
  }), /controlled Fast route\/build-mode\/capability gate/);
  portableReport.trials[0].ck.medium.recipeCapability.intent = 'native-recipe-cache';
  portableReport.trials[0].ck.medium.buildMode = 'fast-relink';
  assert.throws(() => runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile', qualificationProfile: 'portable-fast',
  }), /controlled Fast route\/build-mode\/capability gate/);
  portableReport.trials[0].ck.medium.buildMode = 'native-relink-compile-only';
  assert.throws(() => runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile', qualificationProfile: 'portable-fast',
  }), /controlled Fast route\/build-mode\/capability gate/);
  portableReport.trials[0].ck.medium.buildMode = 'arduino-cli-incremental';
  portableReport.trials[0].native.medium.artifacts[0].sha256 = 'c'.repeat(64);
  portableReport.trials[0].native.medium.artifactSetSha256 = runner.digestObject(
    portableReport.trials[0].native.medium.artifacts,
  );
  assert.throws(() => runner.performanceCandidateFromReport(portableReport, {
    qualificationOperation: 'compile', qualificationProfile: 'portable-fast',
  }), /artifact equivalence failed/);

  report.trials[0].ck.complex.fallbackUsed = true;
  assert.throws(
    () => runner.performanceCandidateFromReport(report, {
      qualificationOperation: 'compile',
      qualificationProfile: 'quick-fast',
    }),
    /controlled Fast route\/build-mode\/capability gate/,
  );
  report.trials[0].ck.complex.fallbackUsed = false;
  report.trials[0].ck.complex.buildMode = 'full-build';
  assert.throws(
    () => runner.performanceCandidateFromReport(report, {
      qualificationOperation: 'compile',
      qualificationProfile: 'quick-fast',
    }),
    /controlled Fast route\/build-mode\/capability gate/,
  );
  report.trials[0].ck.complex.buildMode = 'fast-relink';
  report.trials[0].laneBoundaryIdle = [];
  assert.throws(
    () => runner.performanceCandidateFromReport(report, {
      qualificationOperation: 'compile',
      qualificationProfile: 'quick-fast',
    }),
    /lane-boundary idle evidence/,
  );
  report.trials[0].laneBoundaryIdle = report.trials[1].laneBoundaryIdle.map((entry) => ({
    ...entry,
    lane: entry.lane === 'ck' ? 'native' : 'ck',
  }));
  report.trials[0].ck.simple.artifacts[0].sha256 = 'f'.repeat(64);
  report.trials[0].ck.simple.artifactSetSha256 = runner.digestObject(
    report.trials[0].ck.simple.artifacts,
  );
  assert.throws(
    () => runner.performanceCandidateFromReport(report, {
      qualificationOperation: 'compile',
      qualificationProfile: 'quick-fast',
    }),
    /artifact equivalence failed/,
  );
  assert.throws(
    () => runner.toolchainContentSha256('esp32|esp32|3.3.6|weak'),
    /no bound Core\/tool content SHA-256/,
  );
});

function qualificationTrials(count = 5, modeFactory = () => ({
  buildMode: 'native-relink-compile-only',
  route: { decision: 'allow-fast' },
})) {
  return Array.from({ length: count }, (_, index) => ({
    id: `trial-${index + 1}`,
    ck: Object.fromEntries(['complex', 'medium', 'simple-return'].map((stageId) => [
      stageId,
      { ...modeFactory(stageId, index), artifacts: [] },
    ])),
  }));
}

function stageSummary(ckRawMs, nativeRawMs) {
  const trials = ckRawMs.map((wallMs, index) => ({
    ck: { stage: { wallMs } },
    native: { stage: { wallMs: nativeRawMs[index] } },
  }));
  return runner.summarize(trials, 'stage');
}

function qualificationSummary(count = 5, overrides = {}) {
  const repeated = (value) => Array.from({ length: count }, () => value);
  return {
    stages: {
      complex: stageSummary(repeated(7_000), repeated(10_000)),
      medium: stageSummary(repeated(3_500), repeated(5_000)),
      'simple-return': stageSummary(repeated(2_000), repeated(3_000)),
      ...overrides,
    },
  };
}

test('portable edit qualification requires every edit to clear both fixed median thresholds', () => {
  const stages = runner.measurementStages('portable-edit');
  const passing = runner.evaluatePerformanceQualification(
    qualificationSummary(), stages, qualificationTrials(), null,
  );
  assert.equal(passing.qualified, true);
  assert.equal(passing.status, 'qualified');
  assert.deepEqual(passing.editStageIds, ['complex', 'medium', 'simple-return']);
  assert.equal(passing.stages.find((stage) => stage.id === 'medium').medianSpeedupPct, 30);
  assert.equal(passing.stages.find((stage) => stage.id === 'medium').medianGainMs, 1_500);
  assert.deepEqual(passing.stages.find((stage) => stage.id === 'medium').ckRawMs, [
    3_500, 3_500, 3_500, 3_500, 3_500,
  ]);
  assert.equal(passing.stages.find((stage) => stage.id === 'medium').ckP95Ms, 3_500);
  assert.equal(passing.stages.find((stage) => stage.id === 'medium').p95NoRegression, true);

  const relativeFailure = runner.evaluatePerformanceQualification(
    qualificationSummary(5, {
      medium: stageSummary([5_450, 5_450, 5_450, 5_450, 5_450], [6_000, 6_000, 6_000, 6_000, 6_000]),
    }),
    stages,
    qualificationTrials(),
    null,
  );
  assert.equal(relativeFailure.qualified, false);
  assert.equal(
    relativeFailure.stages.find((stage) => stage.id === 'medium').checks
      .find((check) => check.id === 'minimum-relative-median-speedup').passed,
    false,
  );

  const absoluteFailure = runner.evaluatePerformanceQualification(
    qualificationSummary(5, {
      medium: stageSummary([2_600, 2_600, 2_600, 2_600, 2_600], [3_000, 3_000, 3_000, 3_000, 3_000]),
    }),
    stages,
    qualificationTrials(),
    null,
  );
  assert.equal(absoluteFailure.qualified, false);
  assert.equal(
    absoluteFailure.stages.find((stage) => stage.id === 'medium').checks
      .find((check) => check.id === 'minimum-absolute-median-gain').passed,
    false,
  );
});

test('formal CK mode is literal structured evidence and rejects every CLI fallback branch', () => {
  const required = runner.REQUIRED_CK_MODE_NATIVE_RELINK;
  assert.equal(runner.requiredCkModeEvidence({ buildMode: required }, required).passed, true);
  assert.equal(runner.requiredCkModeEvidence({
    buildMode: 'fast-relink',
    structuredRoute: { mode: required },
  }, required).passed, true);
  assert.equal(runner.requiredCkModeEvidence({ buildMode: 'fast-relink' }, required).passed, false);
  assert.equal(runner.requiredCkModeEvidence({
    buildMode: 'arduino-cli-incremental-fallback',
    structuredRoute: { mode: required },
  }, required).passed, false);

  const insufficient = runner.evaluatePerformanceQualification(
    qualificationSummary(3),
    runner.measurementStages('portable-edit'),
    qualificationTrials(3),
    required,
  );
  assert.equal(insufficient.qualified, false);
  assert.equal(insufficient.formalTrialCountPassed, false);
  assert.equal(insufficient.reasonCodes.includes('insufficient-formal-trials'), true);

  const trials = qualificationTrials(5);
  trials[1].ck.medium = {
    buildMode: 'arduino-cli-incremental-fallback',
    structuredRoute: { mode: required },
    artifacts: [],
  };
  const result = runner.evaluatePerformanceQualification(
    qualificationSummary(5),
    runner.measurementStages('portable-edit'),
    trials,
    required,
  );
  assert.equal(result.qualified, false);
  const medium = result.stages.find((stage) => stage.id === 'medium');
  assert.equal(medium.captures[1].modeMatched, true);
  assert.equal(medium.captures[1].cliFallback, true);
  assert.equal(medium.captures[1].passed, false);
});

test('nearest-rank p95 blocks a fast median with a regressing tail', () => {
  const result = runner.evaluatePerformanceQualification(
    qualificationSummary(5, {
      medium: stageSummary(
        [3_000, 3_000, 3_000, 3_000, 9_000],
        [5_000, 5_000, 5_000, 5_000, 5_000],
      ),
    }),
    runner.measurementStages('portable-edit'),
    qualificationTrials(5),
    null,
  );
  const medium = result.stages.find((stage) => stage.id === 'medium');
  assert.equal(medium.medianSpeedupPct, 40);
  assert.equal(medium.medianGainMs, 2_000);
  assert.equal(medium.ckP95Ms, 9_000);
  assert.equal(medium.nativeP95Ms, 5_000);
  assert.equal(medium.p95NoRegression, false);
  assert.equal(
    medium.checks.find((check) => check.id === 'nearest-rank-p95-no-regression').passed,
    false,
  );
  assert.equal(result.qualified, false);
});

test('slow CK remains a passed measurement while qualification is explicitly refused', () => {
  const report = {
    failures: [],
    performanceQualification: {
      qualified: false,
      status: 'not-qualified',
      reasonCodes: ['complex-performance-or-route-gate-failed'],
    },
  };
  runner.synchronizeReportStatuses(report);
  assert.equal(report.status, 'passed');
  assert.equal(report.measurementStatus, 'passed');
  assert.equal(report.qualificationStatus, 'not-qualified');

  report.failures.push('artifact role mismatch');
  runner.synchronizeReportStatuses(report);
  assert.equal(report.status, 'failed');
  assert.equal(report.measurementStatus, 'failed');
  assert.equal(report.qualificationStatus, 'not-qualified');
  assert.equal(report.performanceQualification.reasonCodes.includes('measurement-failed'), true);
});

test('AVR artifacts require HEX and treat EEPROM as optional but exact when emitted', () => {
  const make = (name, role, sha256, bytes) => ({ name, role, sha256, bytes });
  const ck = [
    make('sketch_arduino_avr_uno.ino.hex', 'avr-application-hex', 'a'.repeat(64), 100),
    make('sketch_arduino_avr_uno.ino.eep', 'avr-eeprom', 'b'.repeat(64), 13),
    make('sketch_arduino_avr_uno.ino.with_bootloader.hex', 'avr-with-bootloader', 'c'.repeat(64), 120),
  ];
  const native = [
    make('p_uno.ino.hex', 'avr-application-hex', 'a'.repeat(64), 100),
    make('p_uno.ino.eep', 'avr-eeprom', 'b'.repeat(64), 13),
    make('p_uno.ino.with_bootloader.hex', 'avr-with-bootloader', 'd'.repeat(64), 121),
  ];
  const matched = runner.compareAvrArtifactRoles(ck, native);
  assert.equal(matched.passed, true);
  assert.notEqual(
    matched.roles['avr-application-hex'].ckName,
    matched.roles['avr-application-hex'].nativeName,
  );
  assert.equal(matched.withBootloader.ck.length, 1);
  assert.equal(matched.withBootloader.native.length, 1);

  const drifted = native.map((artifact) => artifact.role === 'avr-eeprom'
    ? { ...artifact, sha256: 'e'.repeat(64) }
    : artifact);
  assert.equal(runner.compareAvrArtifactRoles(ck, drifted).passed, false);
  const sizeDrifted = native.map((artifact) => artifact.role === 'avr-eeprom'
    ? { ...artifact, bytes: artifact.bytes + 1 }
    : artifact);
  assert.equal(runner.compareAvrArtifactRoles(ck, sizeDrifted).passed, false);
  const noEepromCk = ck.filter((artifact) => artifact.role !== 'avr-eeprom');
  const noEepromNative = native.filter((artifact) => artifact.role !== 'avr-eeprom');
  const noEeprom = runner.compareAvrArtifactRoles(noEepromCk, noEepromNative);
  assert.equal(noEeprom.passed, true);
  assert.equal(noEeprom.optionalRoles['avr-eeprom'].absentInBothLanes, true);
  assert.equal(runner.compareAvrArtifactRoles(
    ck,
    noEepromNative,
  ).passed, false);
  assert.equal(runner.compareAvrArtifactRoles(
    noEepromCk,
    native,
  ).passed, false);
  assert.equal(runner.artifactRole('different.ino.hex'), 'avr-application-hex');
  assert.equal(runner.artifactRole('other.ino.eep'), 'avr-eeprom');
  assert.equal(runner.artifactRole('other.ino.with_bootloader.hex'), 'avr-with-bootloader');
});

test('AVR native relink compile-only rejects a retained with-bootloader artifact', () => {
  const run = {
    buildMode: 'native-relink-compile-only',
    artifacts: [{ role: 'avr-with-bootloader' }],
  };
  assert.equal(runner.hasStaleAvrWithBootloader(run), true);
  assert.equal(runner.hasStaleAvrWithBootloader({
    buildMode: 'full-build',
    artifacts: [{ role: 'avr-with-bootloader' }],
  }), false);
  assert.equal(runner.hasStaleAvrWithBootloader({
    buildMode: 'native-relink-compile-only',
    artifacts: [{ role: 'avr-application-hex' }, { role: 'avr-eeprom' }],
  }), false);

  const trials = qualificationTrials(5);
  trials[0].ck.complex.artifacts = [{ role: 'avr-with-bootloader' }];
  const qualification = runner.evaluatePerformanceQualification(
    qualificationSummary(5),
    runner.measurementStages('portable-edit'),
    trials,
    'native-relink-compile-only',
  );
  assert.equal(qualification.qualified, false);
  assert.equal(
    qualification.stages.find((stage) => stage.id === 'complex').checks
      .find((check) => check.id === 'no-stale-avr-with-bootloader').passed,
    false,
  );

  const nativeWithBootloader = qualificationTrials(5);
  nativeWithBootloader[0].native = {
    complex: { artifacts: [{ role: 'avr-with-bootloader' }] },
  };
  assert.equal(runner.evaluatePerformanceQualification(
    qualificationSummary(5),
    runner.measurementStages('portable-edit'),
    nativeWithBootloader,
    'native-relink-compile-only',
  ).qualified, true, 'native AVR normally emits with-bootloader output');
});

test('generic artifact equivalence requires identical unique roles and content', () => {
  const artifact = (name, role, sha256, primaryApplication = false) => ({
    name, role, bytes: 128, sha256, primaryApplication,
  });
  const ck = [
    artifact('ck.ino.bin', 'application-bin', 'a'.repeat(64), true),
    artifact('ck.ino.bootloader.bin', 'bootloader-bin', 'b'.repeat(64)),
  ];
  const native = [
    artifact('native.ino.bin', 'application-bin', 'a'.repeat(64), true),
    artifact('native.ino.bootloader.bin', 'bootloader-bin', 'b'.repeat(64)),
  ];
  const matched = runner.compareGenericArtifactEquivalence(ck, native);
  assert.equal(matched.policyId, 'generic-required-role-content-exact-v1');
  assert.equal(matched.comparable, true);
  assert.equal(matched.passed, true);
  assert.deepEqual(matched.requiredRoles, ['application-bin', 'bootloader-bin']);

  const drifted = native.map((value) => value.role === 'application-bin'
    ? { ...value, sha256: 'c'.repeat(64) }
    : value);
  assert.equal(runner.compareGenericArtifactEquivalence(ck, drifted).passed, false);
  assert.match(runner.compareGenericArtifactEquivalence(ck, drifted).reason, /contents differ/);

  const ambiguous = [...native, artifact('native-copy.bin', 'application-bin', 'a'.repeat(64), true)];
  const ambiguousResult = runner.compareGenericArtifactEquivalence(ck, ambiguous);
  assert.equal(ambiguousResult.comparable, false);
  assert.match(ambiguousResult.reason, /ambiguous/);

  const missingRole = native.filter((value) => value.role !== 'bootloader-bin');
  assert.match(
    runner.compareGenericArtifactEquivalence(ck, missingRole).reason,
    /role sets differ/,
  );
  assert.equal(runner.artifactRole('sketch.ino.bootloader.bin'), 'bootloader-bin');
  assert.equal(runner.artifactRole('sketch.ino.partitions.bin'), 'partitions-bin');
  assert.equal(runner.artifactRole('sketch.ino.merged.bin'), 'merged-firmware-bin');
});

test('artifact identity digest excludes the optional ESP payload witness', () => {
  const artifacts = [{
    name: 'sketch.ino.bin',
    role: 'application-bin',
    bytes: 512,
    sha256: 'a'.repeat(64),
    primaryApplication: true,
  }];
  const before = runner.artifactSetSha256(artifacts);
  artifacts[0].payloadEquivalenceWitness = {
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    mutableRange: { offset: 176, length: 32 },
  };
  assert.equal(
    runner.artifactSetSha256(artifacts),
    before,
    'the full report binds the witness; the stable artifact identity does not',
  );
});

test('PortableFast ESP payload exception is proof-bound and only ignores path-derived ELF packaging', () => {
  const identity = {
    corePackage: 'esp32',
    coreArchitecture: 'esp32',
    coreVersion: '3.3.6',
  };
  const recipeProof = {
    schemaVersion: 1,
    kind: 'esp32-platform-recipe-elf-sha256-offset-v1',
    ...identity,
    recipeProperty: 'recipe.objcopy.bin.pattern_args',
    recipeSource: 'platform.txt',
    recipeSourceSha256: '1'.repeat(64),
    recipeValueSha256: '2'.repeat(64),
    elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
    elfSha256Offset: 176,
  };
  const witness = (sha, checksum) => ({
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    recipe: {
      elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
      elfSha256Offset: 176,
    },
    byteLength: 512,
    mutableRange: { offset: 176, length: 32 },
    immutableSegments: [
      { offset: 0, length: 176, sha256: '3'.repeat(64) },
      { offset: 208, length: 271, sha256: '4'.repeat(64) },
    ],
    footer: {
      offset: 479,
      length: 33,
      checksumOffset: 479,
      checksum,
      validationHash: sha,
      checksumValid: true,
      validationHashValid: true,
    },
  });
  const artifact = (name, role, sha256, primaryApplication = false, bytes = 512, proof = null) => ({
    name,
    role,
    bytes,
    sha256,
    primaryApplication,
    ...(proof == null ? {} : { payloadEquivalenceWitness: proof }),
  });
  const ck = [
    artifact('ck.ino.elf', 'application-elf', '5'.repeat(64), true, 900),
    artifact('ck.ino.bin', 'application-bin', '6'.repeat(64), true, 512, witness('7'.repeat(64), 12)),
    artifact('ck.ino.bootloader.bin', 'bootloader-bin', '8'.repeat(64), false, 21120),
    artifact('ck.ino.partitions.bin', 'partitions-bin', '9'.repeat(64), false, 3072),
    artifact('ck.ino.merged.bin', 'merged-firmware-bin', 'a'.repeat(64), false, 4194304),
  ];
  const native = [
    artifact('native.ino.elf', 'application-elf', 'b'.repeat(64), true, 900),
    artifact('native.ino.bin', 'application-bin', 'c'.repeat(64), true, 512, witness('d'.repeat(64), 218)),
    artifact('native.ino.bootloader.bin', 'bootloader-bin', '8'.repeat(64), false, 21120),
    artifact('native.ino.partitions.bin', 'partitions-bin', '9'.repeat(64), false, 3072),
    artifact('native.ino.merged.bin', 'merged-firmware-bin', 'e'.repeat(64), false, 4194304),
  ];
  const genericPortable = {
    qualificationOperation: 'compile',
    qualificationProfile: 'portable-fast',
  };
  assert.equal(
    runner.artifactEquivalencePolicyIdForOptions(genericPortable, identity),
    runner.GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(runner.compareArtifactEquivalenceForOptions(ck, native, genericPortable, identity).passed, false);

  const espPortable = {
    ...genericPortable,
    portableFastEspApplicationBinRecipeProof: recipeProof,
  };
  assert.equal(
    runner.artifactEquivalencePolicyIdForOptions(espPortable, identity),
    runner.PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(runner.compareArtifactEquivalenceForOptions(ck, native, espPortable, identity).passed, true);

  const ckWithUploadManifest = [
    ...ck,
    artifact('.ck-upload-artifacts.json', 'upload-manifest', 'f'.repeat(64), false, 64),
  ];
  const ckOnlyMetadata = runner.compareArtifactEquivalenceForOptions(
    ckWithUploadManifest, native, espPortable, identity,
  );
  assert.equal(ckOnlyMetadata.passed, true);
  assert.deepEqual(ckOnlyMetadata.excludedRoles, [
    'application-elf', 'merged-firmware-bin', 'upload-manifest',
  ]);

  const duplicateCkUploadManifest = [
    ...ckWithUploadManifest,
    artifact('upload-manifest.json', 'upload-manifest', '0'.repeat(64), false, 65),
  ];
  assert.equal(
    runner.compareArtifactEquivalenceForOptions(
      duplicateCkUploadManifest, native, espPortable, identity,
    ).passed,
    false,
    'CK-only provenance metadata must remain unique',
  );

  const nativeWithUploadManifest = [
    ...native,
    artifact('upload-manifest.json', 'upload-manifest', '0'.repeat(64), false, 64),
  ];
  assert.equal(
    runner.compareArtifactEquivalenceForOptions(
      ck, nativeWithUploadManifest, espPortable, identity,
    ).passed,
    false,
    'a native upload manifest cannot be silently accepted as CK metadata',
  );

  const bootloaderDrift = native.map((value) => value.role === 'bootloader-bin'
    ? { ...value, sha256: 'f'.repeat(64) }
    : value);
  assert.equal(runner.compareArtifactEquivalenceForOptions(
    ck, bootloaderDrift, espPortable, identity,
  ).passed, false, 'the exception cannot hide another flash artifact drift');

  const forgedArchitecture = {
    ...espPortable,
    portableFastEspApplicationBinRecipeProof: { ...recipeProof, coreArchitecture: 'avr' },
  };
  assert.equal(
    runner.artifactEquivalencePolicyIdForOptions(forgedArchitecture, identity),
    runner.GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
});

test('PortableFast flash_args exception requires matching normalized witnesses bound to the application image', () => {
  const identity = {
    corePackage: 'esp32',
    coreArchitecture: 'esp32',
    coreVersion: '3.3.6',
  };
  const recipeProof = {
    schemaVersion: 1,
    kind: 'esp32-platform-recipe-elf-sha256-offset-v1',
    ...identity,
    recipeProperty: 'recipe.objcopy.bin.pattern_args',
    recipeSource: 'platform.txt',
    recipeSourceSha256: '1'.repeat(64),
    recipeValueSha256: '2'.repeat(64),
    elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
    elfSha256Offset: 176,
  };
  const applicationWitness = (sha, checksum) => ({
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    recipe: {
      elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
      elfSha256Offset: 176,
    },
    byteLength: 512,
    mutableRange: { offset: 176, length: 32 },
    immutableSegments: [
      { offset: 0, length: 176, sha256: '3'.repeat(64) },
      { offset: 208, length: 271, sha256: '4'.repeat(64) },
    ],
    footer: {
      offset: 479,
      length: 33,
      checksumOffset: 479,
      checksum,
      validationHash: sha,
      checksumValid: true,
      validationHashValid: true,
    },
  });
  const flashWitness = (byteLength, applicationSha, prefix) => ({
    schemaVersion: 1,
    kind: 'esp-flash-args-normalized-v1',
    byteLength,
    optionLines: ['--flash-mode dio --flash-freq 80m --flash-size 4MB'],
    segments: [
      {
        offset: 0,
        role: 'bootloader-bin',
        resolved: true,
        reference: `${prefix}.ino.bootloader.bin`,
        bytes: 21120,
        sha256: '8'.repeat(64),
      },
      {
        offset: 32768,
        role: 'partitions-bin',
        resolved: true,
        reference: `${prefix}.ino.partitions.bin`,
        bytes: 3072,
        sha256: '9'.repeat(64),
      },
      {
        offset: 57344,
        role: 'auxiliary-firmware',
        resolved: false,
        reference: 'boot_app0.bin',
      },
      {
        offset: 65536,
        role: 'application-bin',
        resolved: true,
        reference: `${prefix}.ino.bin`,
        bytes: 512,
        sha256: applicationSha,
      },
    ],
  });
  const artifact = (name, role, sha256, primaryApplication, bytes, extras = {}) => ({
    name, role, bytes, sha256, primaryApplication, ...extras,
  });
  const lane = (prefix, applicationSha, flashSha, flashBytes, checksum) => [
    artifact(`${prefix}.ino.bin`, 'application-bin', applicationSha, true, 512, {
      payloadEquivalenceWitness: applicationWitness(`${checksum}`.repeat(32).slice(0, 64), Number(checksum)),
    }),
    artifact(`${prefix}.ino.bootloader.bin`, 'bootloader-bin', '8'.repeat(64), false, 21120),
    artifact(`${prefix}.ino.partitions.bin`, 'partitions-bin', '9'.repeat(64), false, 3072),
    artifact('flash_args', 'flash-arguments', flashSha, false, flashBytes, {
      flashArgumentsWitness: flashWitness(flashBytes, applicationSha, prefix),
    }),
  ];
  const ck = lane('sketch_esp32_esp32_esp32c6_pfast3', '6'.repeat(64), 'a'.repeat(64), 168, 12);
  const native = lane('p_esp32c6', 'c'.repeat(64), 'b'.repeat(64), 140, 34);
  const espPortable = {
    qualificationOperation: 'compile',
    qualificationProfile: 'portable-fast',
    portableFastEspApplicationBinRecipeProof: recipeProof,
  };
  const matched = runner.compareArtifactEquivalenceForOptions(ck, native, espPortable, identity);
  assert.equal(matched.passed, true, matched.reason || 'flash_args exception should pass');
  assert.equal(matched.exceptionUsed, true);
  assert.match(matched.exceptionReason, /flash_args normalized/);
  assert.match(matched.exceptionReason, /--elf-sha256-offset 0xb0/);

  const noWitness = ck.map((value) => value.role === 'flash-arguments'
    ? { ...value, flashArgumentsWitness: undefined }
    : value);
  const missing = runner.compareArtifactEquivalenceForOptions(noWitness, native, espPortable, identity);
  assert.equal(missing.passed, false);
  assert.match(missing.reason, /lacks a valid normalized flash_args witness/);

  const optionDrift = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        optionLines: ['--flash-mode dio --flash-freq 80m --flash-size 16MB'],
      },
    }
    : value);
  const options = runner.compareArtifactEquivalenceForOptions(ck, optionDrift, espPortable, identity);
  assert.equal(options.passed, false);
  assert.match(options.reason, /flash options differ/);

  const offsetDrift = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        segments: value.flashArgumentsWitness.segments.map((segment, index) => (index === 0
          ? { ...segment, offset: 8192 }
          : segment)),
      },
    }
    : value);
  const offsets = runner.compareArtifactEquivalenceForOptions(ck, offsetDrift, espPortable, identity);
  assert.equal(offsets.passed, false);
  assert.match(offsets.reason, /segment layouts differ/);

  const payloadDrift = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        segments: value.flashArgumentsWitness.segments.map((segment) => (segment.role === 'bootloader-bin'
          ? { ...segment, sha256: 'f'.repeat(64) }
          : segment)),
      },
    }
    : value);
  const payload = runner.compareArtifactEquivalenceForOptions(ck, payloadDrift, espPortable, identity);
  assert.equal(payload.passed, false);
  assert.match(payload.reason, /outside the application-bin exception/);

  const unresolvedReferenceDrift = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        segments: value.flashArgumentsWitness.segments.map((segment) => (segment.resolved === false
          ? { ...segment, reference: 'boot_app1.bin' }
          : segment)),
      },
    }
    : value);
  const unresolvedReference = runner.compareArtifactEquivalenceForOptions(
    ck, unresolvedReferenceDrift, espPortable, identity,
  );
  assert.equal(unresolvedReference.passed, false);
  assert.match(unresolvedReference.reason, /segment layouts differ/);

  const resolvedFlagDrift = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        segments: value.flashArgumentsWitness.segments.map((segment) => (segment.resolved === false
          ? {
            ...segment, resolved: true, bytes: 8192, sha256: '5'.repeat(64),
          }
          : segment)),
      },
    }
    : value);
  const resolvedFlag = runner.compareArtifactEquivalenceForOptions(
    ck, resolvedFlagDrift, espPortable, identity,
  );
  assert.equal(
    resolvedFlag.passed,
    false,
    'a lane cannot claim a materialized payload the other lane flashes from the Core package',
  );

  const unboundApplicationReference = native.map((value) => value.role === 'flash-arguments'
    ? {
      ...value,
      flashArgumentsWitness: {
        ...value.flashArgumentsWitness,
        segments: value.flashArgumentsWitness.segments.map((segment) => (segment.role === 'application-bin'
          ? { ...segment, sha256: 'f'.repeat(64) }
          : segment)),
      },
    }
    : value);
  const unbound = runner.compareArtifactEquivalenceForOptions(
    ck, unboundApplicationReference, espPortable, identity,
  );
  assert.equal(
    unbound.passed,
    false,
    'the application segment must reference exactly the compared application image',
  );
});

test('QuickFast compile-only parity compares the shared application artifact and ignores native upload packaging', () => {
  const artifact = (name, role, sha256, primaryApplication = false, bytes = 128) => ({
    name, role, bytes, sha256, primaryApplication,
  });
  const ck = [
    artifact('ck.ino.elf', 'application-elf', 'a'.repeat(64), true, 900),
  ];
  const native = [
    artifact('native.ino.elf', 'application-elf', 'a'.repeat(64), true, 900),
    artifact('native.ino.bin', 'application-bin', 'b'.repeat(64), true, 700),
    artifact('native.ino.bootloader.bin', 'bootloader-bin', 'c'.repeat(64), false, 80),
    artifact('native.ino.partitions.bin', 'partitions-bin', 'd'.repeat(64), false, 40),
    artifact('flash_args', 'flash-arguments', 'e'.repeat(64), false, 30),
  ];
  const quickFast = {
    qualificationOperation: 'compile',
    qualificationProfile: 'quick-fast',
  };
  const matched = runner.compareArtifactEquivalenceForOptions(ck, native, quickFast);
  assert.equal(
    runner.artifactEquivalencePolicyIdForOptions(quickFast),
    runner.COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(matched.policyId, runner.COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID);
  assert.equal(matched.sharedApplicationRole, 'application-elf');
  assert.equal(matched.comparable, true);
  assert.equal(matched.passed, true);
  assert.deepEqual(matched.ignoredNativeRoles, [
    'application-bin', 'bootloader-bin', 'flash-arguments', 'partitions-bin',
  ]);

  const mismatchedElf = native.map((value) => value.role === 'application-elf'
    ? { ...value, sha256: 'f'.repeat(64) }
    : value);
  const mismatched = runner.compareArtifactEquivalenceForOptions(ck, mismatchedElf, quickFast);
  assert.equal(mismatched.passed, false);
  assert.match(mismatched.reason, /contents differ/);

  const noSharedApplication = runner.compareArtifactEquivalenceForOptions(
    ck,
    native.filter((value) => value.role !== 'application-elf'),
    quickFast,
  );
  assert.equal(noSharedApplication.passed, false);
  assert.match(noSharedApplication.reason, /application-elf is not exactly one shared/);

  const uploadReady = {
    qualificationOperation: 'upload-ready',
    qualificationProfile: 'shared-fast',
  };
  assert.equal(
    runner.artifactEquivalencePolicyIdForOptions(uploadReady),
    runner.GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(
    runner.compareArtifactEquivalenceForOptions(ck, native, uploadReady).passed,
    false,
    'upload-ready remains strict about every required artifact role',
  );
});

test('NativeRelink adapter equivalence tolerates lane-local metadata and stays exact on required roles', () => {
  const adapter = runner.AVR_NATIVE_RELINK_ADAPTER;
  const artifact = (name, role, sha256, bytes = 128) => ({
    name, role, bytes, sha256, primaryApplication: role === 'avr-application-hex',
  });
  const ck = [
    artifact('ck.ino.hex', 'avr-application-hex', 'a'.repeat(64), 3000),
    artifact('ck.ino.eep', 'avr-eeprom', 'b'.repeat(64), 12),
    artifact('ck.ino.elf', 'application-elf', 'c'.repeat(64), 90000),
    artifact('.ck-upload-artifacts.json', 'upload-manifest', 'd'.repeat(64), 64),
  ];
  const native = [
    artifact('native.ino.hex', 'avr-application-hex', 'a'.repeat(64), 3000),
    artifact('native.ino.eep', 'avr-eeprom', 'b'.repeat(64), 12),
    artifact('native.ino.elf', 'application-elf', 'e'.repeat(64), 90001),
    artifact('native.ino.with_bootloader.hex', 'avr-with-bootloader', 'f'.repeat(64), 5000),
    artifact('native.ino.with_bootloader.bin', 'with-bootloader-bin', '1'.repeat(64), 4000),
  ];
  for (const stageId of ['simple', 'complex']) {
    const matched = runner.compareNativeRelinkAdapterArtifactEquivalence(
      ck, native, adapter, stageId,
    );
    assert.equal(matched.passed, true, `${stageId}: ${matched.reason}`);
    assert.equal(matched.policyId, adapter.artifactEquivalencePolicyId);
  }

  const hexDrift = native.map((value) => value.role === 'avr-application-hex'
    ? { ...value, sha256: '9'.repeat(64) }
    : value);
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, hexDrift, adapter, 'complex').passed,
    false,
  );

  const eepromMissingOneLane = native.filter((value) => value.role !== 'avr-eeprom');
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(
      ck, eepromMissingOneLane, adapter, 'complex',
    ).passed,
    false,
    'an emitted EEPROM image must exist and match in both lanes',
  );

  const bothWithoutEeprom = runner.compareNativeRelinkAdapterArtifactEquivalence(
    ck.filter((value) => value.role !== 'avr-eeprom'),
    eepromMissingOneLane,
    adapter,
    'complex',
  );
  assert.equal(bothWithoutEeprom.passed, true, 'EEPROM is optional only when both lanes omit it');

  const ckEditResidual = [
    ...ck,
    artifact('ck.ino.with_bootloader.hex', 'avr-with-bootloader', 'f'.repeat(64), 5000),
  ];
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(
      ckEditResidual, native, adapter, 'simple',
    ).passed,
    true,
    'the simple stage may retain native upload packaging on the CK lane',
  );
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(
      ckEditResidual, native, adapter, 'complex',
    ).passed,
    false,
    'CK edit stages must not retain stale upload packaging',
  );
});

test('ESP32-C6 NativeRelink witness role admits only the validated ELF SHA-256 window difference', () => {
  const adapter = runner.ESP32C6_NATIVE_RELINK_ADAPTER;
  const witness = (bytes, prefix, body, footerHash, checksum) => ({
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    recipe: {
      elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
      elfSha256Offset: 0xb0,
    },
    byteLength: bytes,
    mutableRange: { offset: 0xb0, length: 32 },
    immutableSegments: [
      { offset: 0, length: 0xb0, sha256: prefix },
      { offset: 0xd0, length: bytes - 241, sha256: body },
    ],
    footer: {
      offset: bytes - 33,
      length: 33,
      checksumOffset: bytes - 33,
      checksum,
      validationHash: footerHash,
      checksumValid: true,
      validationHashValid: true,
    },
  });
  const artifact = (name, role, bytes, sha256, primary, payloadWitness = null) => ({
    name,
    role,
    bytes,
    sha256,
    primaryApplication: primary,
    ...(payloadWitness == null ? {} : { payloadEquivalenceWitness: payloadWitness }),
  });
  const ck = [
    artifact('ck.ino.bootloader.bin', 'bootloader-bin', 128, '1'.repeat(64), false),
    artifact('ck.ino.partitions.bin', 'partitions-bin', 96, '2'.repeat(64), false),
    artifact('ck.ino.elf', 'application-elf', 90000, '3'.repeat(64), true),
    artifact(
      'ck.ino.bin', 'application-bin', 512, '4'.repeat(64), true,
      witness(512, 'a'.repeat(64), 'b'.repeat(64), 'c'.repeat(64), 31),
    ),
    artifact('.ck-upload-artifacts.json', 'upload-manifest', 64, '5'.repeat(64), false),
  ];
  const native = [
    artifact('native.ino.bootloader.bin', 'bootloader-bin', 128, '1'.repeat(64), false),
    artifact('native.ino.partitions.bin', 'partitions-bin', 96, '2'.repeat(64), false),
    artifact('native.ino.elf', 'application-elf', 90001, '6'.repeat(64), true),
    artifact(
      'native.ino.bin', 'application-bin', 512, '7'.repeat(64), true,
      witness(512, 'a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64), 47),
    ),
    artifact('native.flash_args', 'flash-arguments', 200, '8'.repeat(64), false),
  ];
  for (const stageId of ['simple', 'complex']) {
    const matched = runner.compareNativeRelinkAdapterArtifactEquivalence(
      ck, native, adapter, stageId,
    );
    assert.equal(matched.passed, true, `${stageId}: ${matched.reason}`);
    assert.equal(matched.policyId, 'esp32-app-bin-witness-bootloader-partitions-exact-v1');
    assert.equal(matched.roles['application-bin'].witnessEquivalent, true);
  }

  const identicalBin = native.map((value) => value.role === 'application-bin'
    ? artifact('native.ino.bin', 'application-bin', 512, '4'.repeat(64), true)
    : value);
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, identicalBin, adapter, 'complex').passed,
    true,
    'byte-identical application images pass without payload witnesses',
  );

  const witnessMissingOneLane = native.map((value) => value.role === 'application-bin'
    ? artifact('native.ino.bin', 'application-bin', 512, '7'.repeat(64), true)
    : value);
  const missingWitness = runner.compareNativeRelinkAdapterArtifactEquivalence(
    ck, witnessMissingOneLane, adapter, 'complex',
  );
  assert.equal(missingWitness.passed, false, 'a digest mismatch without a witness fails closed');
  assert.match(missingWitness.reason, /witness/u);

  const segmentDrift = native.map((value) => value.role === 'application-bin'
    ? artifact(
      'native.ino.bin', 'application-bin', 512, '7'.repeat(64), true,
      witness(512, 'a'.repeat(64), '9'.repeat(64), 'd'.repeat(64), 47),
    )
    : value);
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, segmentDrift, adapter, 'complex').passed,
    false,
    'immutable-segment drift is a real content difference',
  );

  const lengthDrift = native.map((value) => value.role === 'application-bin'
    ? artifact(
      'native.ino.bin', 'application-bin', 513, '7'.repeat(64), true,
      witness(513, 'a'.repeat(64), 'b'.repeat(64), 'd'.repeat(64), 47),
    )
    : value);
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, lengthDrift, adapter, 'complex').passed,
    false,
    'witness roles require byte-length equality',
  );

  const notPrimary = native.map((value) => value.role === 'application-bin'
    ? { ...value, primaryApplication: false }
    : value);
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, notPrimary, adapter, 'complex').passed,
    false,
    'witness roles must be the primary application in both lanes',
  );

  const bootloaderDrift = native.map((value) => value.role === 'bootloader-bin'
    ? { ...value, sha256: '9'.repeat(64) }
    : value);
  const drifted = runner.compareNativeRelinkAdapterArtifactEquivalence(
    ck, bootloaderDrift, adapter, 'complex',
  );
  assert.equal(drifted.passed, false, 'bootloader-bin stays byte-exact');
  assert.match(drifted.reason, /required adapter artifact roles differ/u);

  const partitionsMissing = native.filter((value) => value.role !== 'partitions-bin');
  assert.equal(
    runner.compareNativeRelinkAdapterArtifactEquivalence(ck, partitionsMissing, adapter, 'complex').passed,
    false,
    'partitions-bin must be present exactly once in both lanes',
  );
});

test('MKR Zero requires exact application images and rejects CK edit bootloader/upload residual roles', () => {
  const adapter = runner.SAMD_MKRZERO_NATIVE_RELINK_ADAPTER;
  assert.equal(
    runner.artifactRole('sketch.ino.bin', adapter),
    'samd-application-bin',
  );
  assert.equal(
    runner.artifactRole('sketch.ino.hex', adapter),
    'samd-application-hex',
  );
  assert.equal(
    runner.artifactRole('sketch.ino.with_bootloader.hex', adapter),
    'samd-with-bootloader-hex',
  );
  assert.equal(runner.artifactRole('sketch.uf2', adapter), 'samd-uf2');
  assert.equal(runner.artifactRole('upload-manifest.json', adapter), 'upload-manifest');

  const ck = [
    { name: 'ck.ino.bin', role: 'samd-application-bin', bytes: 100, sha256: 'a'.repeat(64) },
    { name: 'ck.ino.hex', role: 'samd-application-hex', bytes: 200, sha256: 'b'.repeat(64) },
    { name: 'ck.ino.with_bootloader.bin', role: 'samd-with-bootloader-bin', bytes: 300, sha256: 'e'.repeat(64) },
    { name: 'ck.ino.with_bootloader.hex', role: 'samd-with-bootloader-hex', bytes: 400, sha256: 'f'.repeat(64) },
    { name: 'ck.ino.elf', role: 'application-elf', bytes: 300, sha256: 'c'.repeat(64) },
  ];
  const native = [
    { name: 'native.ino.bin', role: 'samd-application-bin', bytes: 100, sha256: 'a'.repeat(64) },
    { name: 'native.ino.hex', role: 'samd-application-hex', bytes: 200, sha256: 'b'.repeat(64) },
    { name: 'native.ino.with_bootloader.bin', role: 'samd-with-bootloader-bin', bytes: 300, sha256: 'e'.repeat(64) },
    { name: 'native.ino.with_bootloader.hex', role: 'samd-with-bootloader-hex', bytes: 400, sha256: 'f'.repeat(64) },
    { name: 'native.ino.elf', role: 'application-elf', bytes: 301, sha256: 'd'.repeat(64) },
  ];
  assert.equal(runner.compareArtifactRoles(
    ck, native, adapter.requiredArtifactRoles,
  ).passed, true, 'ELF is audited but not byte-equivalence-required');
  assert.equal(runner.compareArtifactRoles(
    ck, native.map((artifact) => artifact.role === 'samd-application-bin'
      ? { ...artifact, sha256: 'e'.repeat(64) }
      : artifact),
    adapter.requiredArtifactRoles,
  ).passed, false);

  for (const role of adapter.forbiddenAllStageArtifactRoles) {
    assert.equal(runner.hasForbiddenAdapterArtifact({ artifacts: [{ role }] }, adapter), true, role);
  }
  for (const role of adapter.forbiddenCkEditArtifactRoles) {
    assert.equal(runner.hasForbiddenAdapterArtifact({ artifacts: [{ role }] }, adapter), false, `${role} native lane`);
    assert.equal(runner.hasForbiddenAdapterArtifact({ artifacts: [{ role }] }, adapter, 'ck-edit'), true, `${role} CK edit lane`);
  }
  const trials = qualificationTrials(5);
  trials[0].ck.complex.artifacts = [{ role: 'samd-uf2' }];
  const qualification = runner.evaluatePerformanceQualification(
    qualificationSummary(5),
    runner.measurementStages('portable-edit'),
    trials,
    'native-relink-compile-only',
    adapter,
  );
  assert.equal(qualification.qualified, false);
  assert.equal(
    qualification.stages.find((stage) => stage.id === 'complex').checks
      .find((check) => check.id === 'no-forbidden-adapter-artifacts').passed,
    false,
  );
});

test('silent CK evidence discovers only top-level firmware inside the returned build path', () => {
  const project = `sketch_esp32_esp32_esp32c6_rel_${process.pid}_${Date.now()}`;
  const build = mkdtempSync(join(tmpdir(), 'ck-native-ab-artifacts-'));
  try {
    writeFileSync(join(build, `${project}.ino.elf`), 'elf');
    writeFileSync(join(build, `${project}.ino.bin`), 'bin');
    writeFileSync(join(build, 'flash_args'), '0x0 firmware.bin');
    writeFileSync(join(build, 'ignored.txt'), 'ignore');
    const renamed = join(dirname(build), project);
    // The project basename is part of the artifact identity contract.
    const { renameSync } = require('node:fs');
    renameSync(build, renamed);
    const artifacts = runner.inspectCkArtifacts({ path: renamed, artifacts: [] });
    assert.equal(artifacts.length, 3);
    assert.equal(artifacts.filter((artifact) => artifact.primaryApplication).length, 2);
    rmSync(renamed, { recursive: true, force: true });
  } finally {
    rmSync(build, { recursive: true, force: true });
  }
});

test('candidate artifact bundle preserves a hash-bound representative set without clobbering', () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-fast-artifact-bundle-'));
  try {
    const workRoot = join(root, 'work');
    const buildRoot = join(workRoot, 'n', '001', 'build', 'p_esp32c6');
    const output = join(root, 'bundle');
    mkdirSync(buildRoot, { recursive: true });
    const artifactBytes = Buffer.from('candidate-artifact\n', 'utf8');
    const artifact = {
      name: 'p_esp32c6.ino.bin',
      role: 'application-bin',
      bytes: artifactBytes.length,
      sha256: runner.sha256Bytes(artifactBytes),
      primaryApplication: true,
    };
    writeFileSync(join(buildRoot, artifact.name), artifactBytes);
    const candidate = {
      lanes: {
        native: {
          trials: [{ id: 'trial-001', 'simple-return': { artifacts: [artifact] } }],
        },
      },
    };
    const staged = runner.stagePerformanceArtifactBundle(
      output, workRoot, 'esp32:esp32:esp32c6', candidate,
    );
    assert.equal(existsSync(output), false, 'staging must not expose the final directory');
    const candidateBytes = Buffer.from('{"candidate":true}\n', 'utf8');
    const reportBytes = Buffer.from('{"capture":true}\n', 'utf8');
    runner.publishPerformanceArtifactBundle(staged, candidateBytes, reportBytes);
    const metadata = JSON.parse(readFileSync(join(output, 'bundle.json'), 'utf8'));
    const manifest = JSON.parse(readFileSync(join(output, 'artifact-manifest.json'), 'utf8'));
    assert.equal(metadata.schemaId, 'ck.forge.performance-artifact-bundle');
    assert.equal(metadata.candidateSha256, runner.sha256Bytes(candidateBytes));
    assert.equal(metadata.captureReportSha256, runner.sha256Bytes(reportBytes));
    assert.equal(metadata.artifactManifestSha256,
      runner.sha256Bytes(readFileSync(join(output, 'artifact-manifest.json'))));
    assert.deepEqual(readFileSync(join(output, ...manifest.artifacts[0].path.split('/'))), artifactBytes);
    assert.throws(
      () => runner.stagePerformanceArtifactBundle(
        output, workRoot, 'esp32:esp32:esp32c6', candidate,
      ),
      /refusing to overwrite/u,
    );
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
