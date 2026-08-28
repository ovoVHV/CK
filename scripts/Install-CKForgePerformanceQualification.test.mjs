import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const installer = require('./Install-CKForgePerformanceQualification.cjs');
const gate = require('./Evaluate-CKForgePerformanceGate.cjs');
const runner = require('./Run-CKForgeNativeAB.cjs');

function writeJson(file, value) {
  writeFileSync(file, installer.jsonPayload(value), { flag: 'wx' });
}

function fixture() {
  const root = mkdtempSync(join(tmpdir(), 'ck-forge-performance-install-'));
  const nativeBaselineCompilerPropertiesSha256 =
    runner.nativeBaselineCompilerPropertiesSha256('quick-fast');
  const stages = runner.PORTABLE_EDIT_SEQUENCE.map((stage) => ({
    id: stage.id,
    sourceSha256: runner.sha256Bytes(stage.code),
  }));
  const sequenceSha256 = runner.digestObject(stages);
  const artifactBytes = Buffer.from('qualified-firmware-fixture\n', 'utf8');
  const artifactSha256 = runner.sha256Bytes(artifactBytes);
  const toolContent = '7'.repeat(64);
  const makeRun = (wallMs, lane, stage, trialIndex) => {
    const artifacts = [{
      name: `${lane}-${stage.id}.ino.bin`,
      role: 'application-bin',
      bytes: artifactBytes.length,
      sha256: artifactSha256,
      primaryApplication: true,
    }];
    return {
      success: true,
      wallMs,
      artifactsVerified: true,
      exactUsed: false,
      evidenceSha256: runner.sha256Bytes(`${lane}-${stage.id}-${trialIndex}`),
      artifactSetSha256: runner.digestObject(artifacts),
      artifacts,
      codeSha256: stage.sourceSha256,
      buildPathIdentitySha256: runner.sha256Bytes(`${lane}-build-${trialIndex}`),
      resources: {
        evidenceComplete: true,
        flashUsedBytes: 1024,
        ramUsedBytes: 128,
        warningCount: 0,
      },
      toolchainKey: `esp32|esp32|3.3.6|${toolContent}`,
      route: lane === 'ck' ? { contractId: 'ck-fast-build-contract-fixture' } : null,
      buildMode: lane === 'ck'
        ? stage.id === 'simple' ? 'full-build' : 'fast-relink'
        : 'arduino-cli-full',
      profile: 'quick-fast',
      qualificationOperation: lane === 'ck' ? 'compile' : null,
      qualificationProfile: 'quick-fast',
      candidateRoute: lane === 'ck' ? 'qualification-token-probe' : undefined,
      fallbackUsed: lane === 'ck' ? false : undefined,
      compilerPropertyDeltaSha256: lane === 'native'
        ? nativeBaselineCompilerPropertiesSha256
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
  const capture = {
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
      cliConfigSha256: '6'.repeat(64),
      cliVersion: 'arduino-cli Version: 1.4.1',
      hostIdentitySha256: '3'.repeat(64),
      productionExecutableSha256: '4'.repeat(64),
    },
    controls: {
      measurementSequence: 'portable-edit',
      sameBuildPathWithinLane: true,
      nativeBaselineCompilerPropertiesSha256,
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
        trial.ck[stage.id] = makeRun(7_000 + index, 'ck', stage, index);
        trial.native[stage.id] = makeRun(10_000 + index, 'native', stage, index);
      }
      return trial;
    }),
  };
  const candidate = runner.performanceCandidateFromReport(capture, {
    qualificationOperation: 'compile', qualificationProfile: 'quick-fast',
  });
  const capturePath = join(root, 'capture.json');
  const candidatePath = join(root, 'candidate.json');
  writeJson(capturePath, capture);
  writeJson(candidatePath, candidate);
  const candidateBytes = readFileSync(candidatePath);
  const report = gate.evaluate(
    candidate, installer.sha256(candidateBytes), '2026-07-25T08:00:00.000Z',
  );
  assert.equal(report.qualifiedFast, true);
  const reportPath = join(root, 'report.json');
  writeJson(reportPath, report);

  const bundlePath = join(root, 'bundle');
  mkdirSync(join(bundlePath, 'artifacts'), { recursive: true });
  writeFileSync(join(bundlePath, 'artifacts', '00-firmware.bin'), artifactBytes, { flag: 'wx' });
  const manifest = {
    schemaId: installer.ARTIFACT_MANIFEST_SCHEMA_ID,
    schemaVersion: 1,
    artifacts: [{
      path: 'artifacts/00-firmware.bin', size: artifactBytes.length, sha256: artifactSha256,
    }],
  };
  const manifestBytes = installer.jsonPayload(manifest);
  writeFileSync(join(bundlePath, 'artifact-manifest.json'), manifestBytes, { flag: 'wx' });
  writeJson(join(bundlePath, 'bundle.json'), {
    schemaId: installer.BUNDLE_SCHEMA_ID,
    schemaVersion: 1,
    candidateSha256: installer.sha256(candidateBytes),
    captureReportSha256: installer.sha256(readFileSync(capturePath)),
    artifactManifestSha256: installer.sha256(manifestBytes),
    representativeLane: 'native',
    representativeTrialId: 'trial-1',
    representativeStage: 'simple-return',
  });
  return {
    root, capturePath, candidatePath, reportPath, bundlePath,
    qualificationRoot: join(root, 'qualifications'), report, candidate,
  };
}

function args(value, action = '--install') {
  return [
    action,
    '--capture-report', value.capturePath,
    '--candidate', value.candidatePath,
    '--report', value.reportPath,
    '--artifact-bundle', value.bundlePath,
    '--qualification-root', value.qualificationRoot,
  ];
}

test('plan validates all four evidence inputs without creating the qualification root', () => {
  const value = fixture();
  const options = installer.parseArgs(args(value, '--plan'));
  const validated = installer.validateInputs(options);
  assert.equal(validated.qualificationKey, value.report.qualificationKey);
  assert.equal(validated.artifactFiles.length, 1);
  assert.equal(installer.main(args(value, '--plan')), 0);
  assert.throws(() => readFileSync(join(value.qualificationRoot, 'anything')), /ENOENT/u);
});

test('install atomically creates the exact runtime certificate set and never overwrites it', () => {
  const value = fixture();
  assert.equal(installer.main(args(value)), 0);
  const directory = join(value.qualificationRoot, value.report.qualificationKey);
  const certificate = JSON.parse(readFileSync(join(directory, 'certificate.json'), 'utf8'));
  assert.deepEqual(certificate, {
    schemaId: installer.CERTIFICATE_SCHEMA_ID,
    schemaVersion: 2,
    candidateSha256: installer.sha256(readFileSync(value.candidatePath)),
    reportSha256: installer.sha256(readFileSync(value.reportPath)),
    artifactManifestSha256: installer.sha256(
      readFileSync(join(value.bundlePath, 'artifact-manifest.json')),
    ),
  });
  assert.deepEqual(
    readFileSync(join(directory, 'artifacts', '00-firmware.bin')),
    readFileSync(join(value.bundlePath, 'artifacts', '00-firmware.bin')),
  );
  assert.equal(installer.main(args(value)), 1, 'a second install must fail closed');
});

test('tampered report, candidate provenance, bundle binding and artifact bytes are rejected', () => {
  {
    const value = fixture();
    const report = JSON.parse(readFileSync(value.reportPath, 'utf8'));
    report.recommendedRoute = 'native-arduino-cli';
    writeFileSync(value.reportPath, installer.jsonPayload(report));
    assert.throws(() => installer.validateInputs(installer.parseArgs(args(value))), /fresh evaluation/u);
  }
  {
    const value = fixture();
    const candidate = JSON.parse(readFileSync(value.candidatePath, 'utf8'));
    candidate.compilePropertyDelta = 'hand-written promotion';
    writeFileSync(value.candidatePath, installer.jsonPayload(candidate));
    assert.throws(
      () => installer.validateInputs(installer.parseArgs(args(value))),
      /does not reproduce|not bound/u,
    );
  }
  {
    const value = fixture();
    const bundle = JSON.parse(readFileSync(join(value.bundlePath, 'bundle.json'), 'utf8'));
    bundle.captureReportSha256 = 'f'.repeat(64);
    writeFileSync(join(value.bundlePath, 'bundle.json'), installer.jsonPayload(bundle));
    assert.throws(() => installer.validateInputs(installer.parseArgs(args(value))), /not bound/u);
  }
  {
    const value = fixture();
    const bundle = JSON.parse(readFileSync(join(value.bundlePath, 'bundle.json'), 'utf8'));
    bundle.representativeTrialId = 'trial-2';
    writeFileSync(join(value.bundlePath, 'bundle.json'), installer.jsonPayload(bundle));
    assert.throws(
      () => installer.validateInputs(installer.parseArgs(args(value))),
      /first native trial/u,
    );
  }
  {
    const value = fixture();
    writeFileSync(join(value.bundlePath, 'artifacts', '00-firmware.bin'), Buffer.from('tampered'));
    assert.throws(
      () => installer.validateInputs(installer.parseArgs(args(value))),
      /wrong size|SHA-256 mismatch/u,
    );
  }
});

test('installer path parser is explicit and artifact paths cannot escape the bundle', () => {
  assert.equal(installer.relativeArtifactPath('artifacts/firmware.bin'), join('artifacts', 'firmware.bin'));
  for (const unsafe of [
    '../firmware.bin', 'artifacts/../firmware.bin', '/artifacts/firmware.bin',
    'C:/artifacts/firmware.bin', 'artifacts\\firmware.bin', 'candidate.json',
  ]) assert.equal(installer.relativeArtifactPath(unsafe), null);
  assert.throws(() => installer.parseArgs(['--install']), /--capture-report/u);
  assert.throws(() => installer.parseArgs(['--plan', '--install']), /exactly one/u);
});
