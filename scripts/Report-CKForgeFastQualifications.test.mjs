import assert from 'node:assert/strict';
import { mkdtempSync, mkdirSync, readFileSync, writeFileSync } from 'node:fs';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const { collectQualifications, renderText } = require('./Report-CKForgeFastQualifications.cjs');
const gateEvaluator = require('./Evaluate-CKForgePerformanceGate.cjs');
const installer = require('./Install-CKForgePerformanceQualification.cjs');
const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CURRENT_EXE_SHA256 = '7b45eccf6dabbb4a23ebac269c7f8c1f1a04d1cf9a59e7acb5a4fe7fc7453476';

function options(architecture = null) {
  return {
    executablePath: null,
    executableSha256: CURRENT_EXE_SHA256,
    qualificationRoot: join(ROOT, 'state', 'qualifications'),
    architecture,
    format: 'json',
  };
}

function installedPortablePerformanceFixture() {
  const root = mkdtempSync(join(tmpdir(), 'ck-forge-source-bound-status-'));
  const qualificationRoot = join(root, 'qualifications');
  const artifactBytes = Buffer.from('source-bound-firmware\n', 'utf8');
  const artifactSha256 = installer.sha256(artifactBytes);
  const identity = {
    fqbn: 'esp32:esp32:esp32c6:FlashSize=4M,PartitionScheme=default',
    corePackage: 'esp32',
    coreArchitecture: 'esp32',
    coreVersion: '3.3.6',
    toolchainKey: `esp32|esp32|3.3.6|${'7'.repeat(64)}`,
    toolchainContentSha256: '7'.repeat(64),
    sketchSha256: gateEvaluator.PORTABLE_EDIT_STAGES[0].sourceSha256,
    cliExecutableSha256: '2'.repeat(64),
    cliConfigSha256: '6'.repeat(64),
    cliVersion: 'arduino-cli Version: 1.4.1',
    hostIdentitySha256: '3'.repeat(64),
    productionExecutableSha256: '4'.repeat(64),
  };
  const makeRun = (wallMs, stage, lane, trialIndex) => {
    const artifacts = [{
      name: `${lane}-${stage.id}.bin`, role: 'application-bin', bytes: artifactBytes.length,
      sha256: artifactSha256, primaryApplication: true,
    }];
    const value = {
      success: true,
      wallMs,
      artifactsVerified: true,
      resourceGatePassed: true,
      exactUsed: false,
      evidenceSha256: installer.sha256(Buffer.from(`${lane}-${stage.id}-${trialIndex}`)),
      artifactSetSha256: gateEvaluator.digestObject(artifacts),
      artifacts,
      codeSha256: stage.sourceSha256,
      buildPathIdentitySha256: gateEvaluator.digestObject({ lane, trialIndex }),
      resources: { evidenceComplete: true, flashUsedBytes: 1024, ramUsedBytes: 128, warningCount: 0 },
    };
    if (lane === 'native') return {
      ...value,
      profile: 'quick-fast',
      compilerPropertyDeltaSha256: '9'.repeat(64),
    };
    return {
      ...value,
      buildMode: stage.id === 'simple' ? 'full-build' : 'fast-relink',
      profile: 'quick-fast',
      qualificationOperation: 'compile',
      qualificationProfile: 'quick-fast',
      candidateRoute: 'qualification-token-probe',
      fallbackUsed: false,
      ckContractId: 'ck-fast-build-contract-fixture',
      recipeCapability: {
        schemaVersion: 2,
        baselineSha256: gateEvaluator.digestObject({ stage: stage.id, trialIndex }),
        observationOnly: true,
        capabilityGatePassed: true,
        requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
        missingCapabilities: [],
      },
    };
  };
  const trials = (lane, wallMs) => Array.from({ length: 5 }, (_, trialIndex) => ({
    id: `trial-${trialIndex + 1}`,
    ...Object.fromEntries(gateEvaluator.PORTABLE_EDIT_STAGES.map((stage) => [
      stage.id, makeRun(wallMs + trialIndex, stage, lane, trialIndex),
    ])),
  }));
  const candidate = {
    schemaId: 'ck.forge.performance-ab-candidate',
    schemaVersion: 4,
    operation: 'compile',
    candidateProfile: 'quick-fast',
    ckContractId: 'ck-fast-build-contract-fixture',
    artifactEquivalencePolicyId: gateEvaluator.COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
    compilePropertyDelta: 'fixture compile profile',
    nativeBaselineCompilerPropertiesSha256: '9'.repeat(64),
    measurementSequence: 'portable-edit',
    sequenceSha256: gateEvaluator.digestObject(gateEvaluator.PORTABLE_EDIT_STAGES),
    stages: gateEvaluator.PORTABLE_EDIT_STAGES.map((stage) => ({ ...stage })),
    controls: {
      compileOnly: true, uploadPerformed: false, physicalFlashWritten: false,
      serialPortAccessed: false, sameMachine: true, freshBuildPathsVerified: true,
      sameBuildPathWithinLaneVerified: true, stageSourceHashesVerified: true,
      exactReuseDenied: true, routeGatePassed: true, recipeCapabilityGatePassed: true,
      globalCachesSharedEqually: true, noConcurrentCompiles: true,
      laneBoundaryIdleGatePassed: true, compilePropertyDeltaDeclared: true,
      dependencyClosureGatePassed: true, artifactGatePassed: true, resourceGatePassed: true,
      reproducibleBuildEnvironment: {
        policyId: 'source-date-epoch-utc-v1', sourceDateEpoch: 1704067200,
        timeZone: 'UTC', passed: true,
      },
    },
    captureOrder: ['ck-native', 'native-ck', 'ck-native', 'native-ck', 'ck-native'],
    lanes: {
      ck: { identity: { ...identity }, trials: trials('ck', 7_000) },
      native: { identity: { ...identity }, trials: trials('native', 10_000) },
    },
  };
  const candidateBytes = installer.jsonPayload(candidate);
  const report = gateEvaluator.evaluate(
    candidate, installer.sha256(candidateBytes), '2026-07-25T08:00:00.000Z',
  );
  const reportBytes = installer.jsonPayload(report);
  const manifest = {
    schemaId: installer.ARTIFACT_MANIFEST_SCHEMA_ID,
    schemaVersion: 1,
    artifacts: [{ path: 'artifacts/firmware.bin', size: artifactBytes.length, sha256: artifactSha256 }],
  };
  const manifestBytes = installer.jsonPayload(manifest);
  const directory = join(qualificationRoot, report.qualificationKey);
  mkdirSync(join(directory, 'artifacts'), { recursive: true });
  writeFileSync(join(directory, 'candidate.json'), candidateBytes);
  writeFileSync(join(directory, 'report.json'), reportBytes);
  writeFileSync(join(directory, 'artifact-manifest.json'), manifestBytes);
  writeFileSync(join(directory, 'artifacts', 'firmware.bin'), artifactBytes);
  writeFileSync(join(directory, 'certificate.json'), installer.jsonPayload({
    schemaId: installer.CERTIFICATE_SCHEMA_ID,
    schemaVersion: 2,
    candidateSha256: installer.sha256(candidateBytes),
    reportSha256: installer.sha256(reportBytes),
    artifactManifestSha256: installer.sha256(manifestBytes),
  }));
  const currentIdentityResolver = () => ({
    fqbn: identity.fqbn,
    corePackage: identity.corePackage,
    coreArchitecture: identity.coreArchitecture,
    coreVersion: identity.coreVersion,
    cliExecutableSha256: identity.cliExecutableSha256,
    cliConfigSha256: identity.cliConfigSha256,
    cliVersion: identity.cliVersion,
    hostIdentitySha256: identity.hostIdentitySha256,
  });
  return { qualificationRoot, directory, identity, report, currentIdentityResolver };
}

test('preserved 7b45eccf certificates fail the current stricter qualification gate', () => {
  const report = collectQualifications(options());
  assert.equal(report.invalidCurrentCertificateCount, 2);
  assert.equal(report.qualifiedTargetCount, 0);
  assert.deepEqual(report.targets, []);
  assert.equal(report.countingRules.candidateRegistryGrantsFast, false);
  assert.equal(report.countingRules.exactMatchGrantsFast, false);
});

test('preserved 7b45eccf historical EXE has zero ESP32 Fast certificates', () => {
  const report = collectQualifications(options('esp32'));
  assert.equal(report.invalidCurrentCertificateCount, 2);
  assert.equal(report.allArchitectureQualifiedTargetCount, 0);
  assert.equal(report.qualifiedTargetCount, 0);
  assert.deepEqual(report.targets, []);
});

test('an EXE without matching certificates reports ESP32 targets as pending, not incompatible', () => {
  const report = collectQualifications({
    ...options('esp32'),
    executableSha256: 'a'.repeat(64),
  });
  assert.equal(report.qualifiedTargetCount, 0);
  assert.ok(report.pendingQualificationTargetCount >= 7);
  assert.equal(report.countingRules.pendingQualificationMeansIncompatible, false);
  assert.deepEqual(report.countingRules.requiredSequence, [
    'simple', 'complex', 'medium', 'simple-return',
  ]);
  const pendingFqbns = new Set(report.qualificationWorklist
    .filter((target) => target.qualificationState === 'qualification-pending')
    .map((target) => target.fqbn));
  for (const fqbn of [
    'esp32:esp32:esp32c3',
    'esp32:esp32:esp32c5',
    'esp32:esp32:esp32c6',
    'esp32:esp32:esp32s3',
    'esp32:esp32:esp32h2',
    'esp32:esp32:esp32p4',
    'esp32:esp32:adafruit_feather_esp32s3',
  ]) {
    assert.ok(pendingFqbns.has(fqbn), fqbn);
  }
  const text = renderText(report);
  assert.match(text, /Qualification pending \(not incompatible\)/);
  assert.match(text, /native Arduino CLI Release remains available/);
});

test('portable performance v2 is audited as a source-bound sample qualification without promoting the board target', () => {
  const value = installedPortablePerformanceFixture();
  const report = collectQualifications({
    executablePath: null,
    executableSha256: value.identity.productionExecutableSha256,
    qualificationRoot: value.qualificationRoot,
    architecture: null,
    format: 'json',
    currentIdentityResolver: value.currentIdentityResolver,
  });
  assert.equal(report.invalidCurrentCertificateCount, 0);
  assert.equal(report.qualifiedTargetCount, 0);
  assert.equal(report.sourceBoundQualifiedCapabilityCount, 1);
  assert.equal(report.sourceBoundSampleQualificationCount, 1);
  assert.equal(report.sourceBoundQualifications[0].qualificationKind,
    'source-bound-sample-qualification');
  assert.equal(report.sourceBoundQualifications[0].qualificationScope, 'exact-portable-simple-source');
  assert.equal(report.sourceBoundQualifications[0].targetWideFastGranted, false);
  assert.equal(report.countingRules.portablePerformanceGrantsTargetWideFast, false);
  assert.ok(report.qualificationWorklist.every(
    (target) => target.qualificationState !== 'fast-qualified'
      || target.fqbn !== value.identity.fqbn,
  ));
  const text = renderText(report);
  assert.match(text, /Source-bound sample qualifications: 1/u);
  assert.match(text, /SOURCE-BOUND SAMPLE/u);
  assert.match(text, /do not make a board target Fast-qualified/u);
});

test('reporter keeps certificate-family crossings fail-closed', () => {
  const collectFixture = (value) => collectQualifications({
    executablePath: null,
    executableSha256: value.identity.productionExecutableSha256,
    qualificationRoot: value.qualificationRoot,
    architecture: null,
    format: 'json',
    currentIdentityResolver: value.currentIdentityResolver,
  });

  // A valid portable v2 payload must stay source-bound and must never enter
  // the NativeRelink target-wide branch merely because its version is edited.
  {
    const value = installedPortablePerformanceFixture();
    const certificatePath = join(value.directory, 'certificate.json');
    const certificate = JSON.parse(readFileSync(certificatePath, 'utf8'));
    certificate.schemaVersion = 4;
    writeFileSync(certificatePath, installer.jsonPayload(certificate));
    const report = collectFixture(value);
    assert.equal(report.qualifiedTargetCount, 0);
    assert.equal(report.sourceBoundSampleQualificationCount, 0);
    assert.equal(report.invalidCurrentCertificateCount, 0);
  }

  // Closed envelopes reject a hybrid instead of treating the extra fields as
  // an upgrade. The reporter records it as invalid, never as a capability.
  {
    const value = installedPortablePerformanceFixture();
    const certificatePath = join(value.directory, 'certificate.json');
    const certificate = JSON.parse(readFileSync(certificatePath, 'utf8'));
    certificate.candidateProfile = 'native-relink-compile-only';
    certificate.evidenceSha256 = 'd'.repeat(64);
    writeFileSync(certificatePath, installer.jsonPayload(certificate));
    const report = collectFixture(value);
    assert.equal(report.qualifiedTargetCount, 0);
    assert.equal(report.sourceBoundSampleQualificationCount, 0);
    assert.equal(report.invalidCurrentCertificateCount, 1);
    assert.equal(report.invalidCurrentCertificates[0].certificateKind, 'portable-performance-v2');
  }

  // Unknown and reverse-labelled versions are ignored by the family router;
  // they cannot become authorization inputs through best-effort guessing.
  for (const schemaVersion of [999, 4]) {
    const value = installedPortablePerformanceFixture();
    const certificatePath = join(value.directory, 'certificate.json');
    const certificate = JSON.parse(readFileSync(certificatePath, 'utf8'));
    certificate.schemaVersion = schemaVersion;
    writeFileSync(certificatePath, installer.jsonPayload(certificate));
    const report = collectFixture(value);
    assert.equal(report.qualifiedTargetCount, 0);
    assert.equal(report.sourceBoundSampleQualificationCount, 0);
    assert.equal(report.invalidCurrentCertificateCount, 0);
  }
});

test('portable performance audit rejects changed artifacts and never increments either Fast count', () => {
  const value = installedPortablePerformanceFixture();
  writeFileSync(join(value.directory, 'artifacts', 'firmware.bin'), Buffer.from('changed'));
  const report = collectQualifications({
    executablePath: null,
    executableSha256: value.identity.productionExecutableSha256,
    qualificationRoot: value.qualificationRoot,
    architecture: null,
    format: 'json',
    currentIdentityResolver: value.currentIdentityResolver,
  });
  assert.equal(report.invalidCurrentCertificateCount, 1);
  assert.equal(report.qualifiedTargetCount, 0);
  assert.equal(report.sourceBoundQualifiedCapabilityCount, 0);
  assert.equal(report.invalidCurrentCertificates[0].certificateKind, 'portable-performance-v2');
});

test('portable performance audit rejects a self-consistent installed artifact set from another candidate', () => {
  const value = installedPortablePerformanceFixture();
  const rogueBytes = Buffer.from('different-qualified-looking-firmware\n', 'utf8');
  const rogueSha256 = installer.sha256(rogueBytes);
  const manifest = {
    schemaId: installer.ARTIFACT_MANIFEST_SCHEMA_ID,
    schemaVersion: 1,
    artifacts: [{ path: 'artifacts/firmware.bin', size: rogueBytes.length, sha256: rogueSha256 }],
  };
  const manifestBytes = installer.jsonPayload(manifest);
  writeFileSync(join(value.directory, 'artifacts', 'firmware.bin'), rogueBytes);
  writeFileSync(join(value.directory, 'artifact-manifest.json'), manifestBytes);
  const certificate = JSON.parse(readFileSync(join(value.directory, 'certificate.json'), 'utf8'));
  certificate.artifactManifestSha256 = installer.sha256(manifestBytes);
  writeFileSync(join(value.directory, 'certificate.json'), installer.jsonPayload(certificate));

  const report = collectQualifications({
    executablePath: null,
    executableSha256: value.identity.productionExecutableSha256,
    qualificationRoot: value.qualificationRoot,
    architecture: null,
    format: 'json',
    currentIdentityResolver: value.currentIdentityResolver,
  });
  assert.equal(report.qualifiedTargetCount, 0);
  assert.equal(report.sourceBoundSampleQualificationCount, 0);
  assert.equal(report.invalidCurrentCertificateCount, 1);
  assert.match(report.invalidCurrentCertificates[0].error, /candidate representative artifact set/u);
});

test('machine specification keeps current truth runtime-derived and old certificates historical', () => {
  const report = collectQualifications(options());
  const specification = JSON.parse(readFileSync(join(ROOT, 'docs', 'specification', 'index.json'), 'utf8'));
  const lane = specification.contracts.find((contract) => contract.id === 'ck.forge-flfe-portable-lane');
  const gate = specification.contracts.find((contract) => contract.id === 'ck.forge-performance-qualification');
  const regression = specification.contracts.find((contract) => contract.id === 'ck.forge-regression');

  assert.ok(lane);
  assert.ok(gate);
  assert.ok(regression);
  assert.equal(lane.current_fast_status_entrypoint, 'scripts/Report-CKForgeFastQualifications.cjs');
  assert.equal(lane.current_status_is_runtime_derived, true);
  assert.equal(lane.unqualified_target_display_status, 'qualification-pending');
  assert.equal(lane.qualification_pending_means_incompatible, false);
  assert.equal(lane.historical_checked_snapshot.production_executable_sha256, CURRENT_EXE_SHA256);
  assert.equal(lane.historical_checked_snapshot.current_gate_recomputed_fast_qualified_target_count, report.qualifiedTargetCount);
  assert.equal(lane.historical_checked_snapshot.current_gate_invalid_certificate_count, 2);
  assert.equal(lane.historical_checked_snapshot.at_time_fast_qualified_target_count, 2);
  assert.equal(lane.historical_checked_snapshot.at_time_fast_qualified_by_architecture.avr, 2);
  assert.equal(lane.historical_checked_snapshot.at_time_fast_qualified_by_architecture.esp32, 0);
  assert.equal(lane.historical_checked_snapshot.native_relink_certificates.length, 2);
  assert.equal(Object.hasOwn(lane, 'current_production_executable_sha256'), false);
  assert.equal(Object.hasOwn(lane, 'current_fast_qualified_target_count'), false);
  assert.equal(lane.candidate_identity_manifest_grants_fast, false);
  assert.equal(lane.exact_match_grants_fast, false);
  assert.equal(lane.historical_executable_certificates_grant_current_fast, false);
  assert.equal(gate.status_entrypoint, 'scripts/Report-CKForgeFastQualifications.cjs');
  assert.equal(gate.candidate_identity_manifest_grants_fast, false);
  assert.equal(gate.exact_match_grants_fast, false);
  assert.equal(regression.qualification_manifest_grants_fast, false);
  assert.equal(Object.hasOwn(lane, 'current_ab_results'), false);
  assert.equal(Object.hasOwn(lane, 'latest_evidence_record'), false);
  assert.ok(lane.historical_20260718_ab_results);
});
