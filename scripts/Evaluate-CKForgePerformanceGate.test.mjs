import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, rmSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';
import { validateJsonSchema } from './JsonSchemaValidator.mjs';

const require = createRequire(import.meta.url);
const {
  POLICY,
  COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  NATIVE_RELINK_ADAPTERS,
  NATIVE_RELINK_BINDING_SCHEMA_VERSION,
  NATIVE_RELINK_ADAPTER_ID,
  NATIVE_RELINK_ARTIFACT_POLICY_ID,
  NATIVE_RELINK_CONTRACT_ID,
  NATIVE_RELINK_PROFILE,
  SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
  ESP32C6_NATIVE_RELINK_ADAPTER,
  PORTABLE_EDIT_STAGES,
  artifactEquivalencePolicyIdForCandidate,
  canonicalCompleteFqbn,
  certifyNativeRelink,
  digestObject,
  evaluate,
  genericQualificationBinding,
  main,
  median,
  nativeRelinkAdapterFor,
  nativeRelinkQualificationBinding,
  nativeArtifactSetSha256,
  parseArgs,
  percentileNearestRank,
  validateCandidate,
} = require('./Evaluate-CKForgePerformanceGate.cjs');

test('performance evidence FQBN canonicalization matches the Rust runtime contract', () => {
  assert.equal(
    canonicalCompleteFqbn(' vendor : arch : board : \u00e9 = two , z = one '),
    'vendor:arch:board:z=one,\u00e9=two',
  );
  assert.equal(
    canonicalCompleteFqbn('vendor:arch:board:Key=one,\u212aey=two'),
    'vendor:arch:board:Key=one,\u212aey=two',
  );
  assert.throws(
    () => canonicalCompleteFqbn('vendor:arch:board:Flash=8M,flash=16M'),
    /options are invalid/,
  );
  assert.throws(
    () => canonicalCompleteFqbn('vendor:arch:board:mode=a=b'),
    /option is invalid/,
  );
});

test('NativeRelink adapter registry is explicit and fail-closed for unknown Core targets', () => {
  assert.equal(NATIVE_RELINK_ADAPTERS.length, 10);
  assert.equal(new Set(NATIVE_RELINK_ADAPTERS.map((adapter) => adapter.id)).size, 10);
  assert.equal(nativeRelinkAdapterFor({ fqbn: 'arduino:avr:uno', coreArchitecture: 'avr' })?.id,
    NATIVE_RELINK_ADAPTERS[0].id);
  assert.equal(
    nativeRelinkAdapterFor({ fqbn: 'arduino:avr:uno', coreArchitecture: 'avr' })?.engineContractId,
    'ck-native-relink-avr-release-compile-only-v2',
  );
  assert.deepEqual(
    [...nativeRelinkAdapterFor({ fqbn: 'arduino:avr:uno', coreArchitecture: 'avr' }).witnessArtifactRoles],
    [],
  );
  assert.equal(
    nativeRelinkAdapterFor({ fqbn: 'arduino:samd:mkrzero', coreArchitecture: 'samd' })?.id,
    'arduino-samd-mkrzero-native-relink-v1',
  );
  assert.deepEqual(
    [...nativeRelinkAdapterFor({ fqbn: 'arduino:samd:mkrzero', coreArchitecture: 'samd' }).witnessArtifactRoles],
    [],
  );
  assert.equal(
    nativeRelinkAdapterFor({
      fqbn: 'arduino:samd:mkrzero:usbstack=arduino', coreArchitecture: 'samd',
    })?.id,
    'arduino-samd-mkrzero-native-relink-v1',
  );
  for (const fqbn of [
    'arduino:samd:mkrzero_clone', 'arduino:samd:mkrwifi1010', 'arduino:samd:arduino_zero_native',
  ]) assert.equal(nativeRelinkAdapterFor({ fqbn, coreArchitecture: 'samd' }), null);
  const esp32 = nativeRelinkAdapterFor({ fqbn: 'esp32:esp32:esp32c6', coreArchitecture: 'esp32' });
  assert.equal(esp32?.id, 'esp32-esp32c6-native-relink-v1');
  assert.equal(esp32?.engineContractId, 'ck-native-relink-esp32-release-compile-only-phase1-v1');
  assert.equal(
    esp32?.artifactEquivalencePolicyId,
    'esp32-app-bin-witness-bootloader-partitions-exact-v1',
  );
  assert.deepEqual([...esp32.requiredArtifactRoles], ['bootloader-bin', 'partitions-bin']);
  assert.deepEqual([...esp32.witnessArtifactRoles], ['application-bin']);
  assert.deepEqual([...esp32.optionalArtifactRoles], []);
  assert.equal(
    nativeRelinkAdapterFor({
      fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
      coreArchitecture: 'esp32',
    })?.id,
    'esp32-esp32c6-native-relink-v1',
  );
  assert.equal(
    nativeRelinkAdapterFor({ fqbn: 'esp32:esp32:esp32c6', coreArchitecture: 'avr' }),
    null,
    'the evaluator requires an exact coreArchitecture match',
  );
  for (const [fqbn, expectedId] of [
    ['esp32:esp32:esp32', 'esp32-esp32-native-relink-v1'],
    ['esp32:esp32:esp32s2', 'esp32-esp32s2-native-relink-v1'],
    ['esp32:esp32:esp32s3', 'esp32-esp32s3-native-relink-v1'],
    ['esp32:esp32:esp32c3', 'esp32-esp32c3-native-relink-v1'],
    ['esp32:esp32:esp32c5', 'esp32-esp32c5-native-relink-v1'],
    ['esp32:esp32:esp32h2', 'esp32-esp32h2-native-relink-v1'],
    ['esp32:esp32:esp32p4', 'esp32-esp32p4-native-relink-v1'],
  ]) {
    assert.equal(
      nativeRelinkAdapterFor({ fqbn, coreArchitecture: 'esp32' })?.id,
      expectedId,
    );
  }
  for (const fqbn of [
    'esp32:esp32:esp32c6_clone', 'esp32:esp32:esp32wrover', 'esp32:esp32:esp32da',
  ]) assert.equal(nativeRelinkAdapterFor({ fqbn, coreArchitecture: 'esp32' }), null);
  assert.equal(nativeRelinkAdapterFor({ fqbn: 'thirdparty:custom:board', coreArchitecture: 'custom' }), null);
});

const HASH = Object.freeze({
  sketch: '1'.repeat(64),
  cli: '2'.repeat(64),
  cliConfig: '6'.repeat(64),
  host: '3'.repeat(64),
  input: '4'.repeat(64),
  nativeBaseline: '6'.repeat(64),
  toolchain: '7'.repeat(64),
  executable: '8'.repeat(64),
});

function run(wallMs, stage, lane, trialIndex) {
  const artifacts = [{
    name: `${stage.id}.bin`,
    role: 'application-bin',
    bytes: 1024,
    sha256: stage.sourceSha256,
    primaryApplication: true,
  }];
  const common = {
    success: true,
    wallMs,
    artifactsVerified: true,
    resourceGatePassed: true,
    exactUsed: false,
    evidenceSha256: '5'.repeat(64),
    artifactSetSha256: digestObject(artifacts),
    artifacts,
    codeSha256: stage.sourceSha256,
    buildPathIdentitySha256: digestObject({ lane, trialIndex }),
    resources: {
      evidenceComplete: true,
      flashUsedBytes: 1024,
      ramUsedBytes: 128,
      warningCount: 0,
    },
  };
  if (lane !== 'ck') return {
    ...common,
    profile: 'quick-fast',
    compilerPropertyDeltaSha256: HASH.nativeBaseline,
  };
  return {
    ...common,
    buildMode: stage.id === 'simple' ? 'full-build' : 'fast-relink',
    profile: 'quick-fast',
    qualificationOperation: 'compile',
    qualificationProfile: 'quick-fast',
    candidateRoute: 'qualification-token-probe',
    fallbackUsed: false,
    ckContractId: 'ck-fast-build-contract-fixture',
    recipeCapability: {
      schemaVersion: 2,
      baselineSha256: digestObject({ stage: stage.id, trialIndex }),
      observationOnly: true,
      capabilityGatePassed: true,
      requiredCapabilities: ['sketch_compile', 'core_archive_reuse', 'direct_link'],
      missingCapabilities: [],
    },
  };
}

function identity() {
  return {
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
    corePackage: 'esp32',
    coreArchitecture: 'esp32',
    coreVersion: '3.3.6',
    toolchainKey: `esp32|esp32|3.3.6|${HASH.toolchain}`,
    toolchainContentSha256: HASH.toolchain,
    sketchSha256: PORTABLE_EDIT_STAGES[0].sourceSha256,
    cliExecutableSha256: HASH.cli,
    cliConfigSha256: HASH.cliConfig,
    cliVersion: 'arduino-cli Version: 1.4.1',
    hostIdentitySha256: HASH.host,
    productionExecutableSha256: HASH.executable,
  };
}

function trials(samples, lane) {
  return samples.simple.map((_, index) => {
    const trial = { id: `trial-${index + 1}` };
    for (const stage of PORTABLE_EDIT_STAGES) {
      trial[stage.id] = run(samples[stage.id][index], stage, lane, index);
    }
    return trial;
  });
}

function candidate({
  ckSimple = [7000, 7100, 6900, 7050, 6950],
  ckComplex = [3500, 3600, 3400, 3550, 3450],
  ckMedium = [3800, 3900, 3700, 3850, 3750],
  ckSimpleReturn = [3000, 3100, 2900, 3050, 2950],
  nativeSimple = [10000, 10100, 9900, 10050, 9950],
  nativeComplex = [5000, 5100, 4900, 5050, 4950],
  nativeMedium = [5500, 5600, 5400, 5550, 5450],
  nativeSimpleReturn = [4500, 4600, 4400, 4550, 4450],
} = {}) {
  const ckSamples = {
    simple: ckSimple,
    complex: ckComplex,
    medium: ckMedium,
    'simple-return': ckSimpleReturn,
  };
  const nativeSamples = {
    simple: nativeSimple,
    complex: nativeComplex,
    medium: nativeMedium,
    'simple-return': nativeSimpleReturn,
  };
  return {
    schemaId: 'ck.forge.performance-ab-candidate',
    schemaVersion: 4,
    operation: 'compile',
    candidateProfile: 'quick-fast',
    ckContractId: 'ck-fast-build-contract-fixture',
    artifactEquivalencePolicyId: COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
    compilePropertyDelta: 'CK developer-loop profile uses documented fixture flags.',
    nativeBaselineCompilerPropertiesSha256: HASH.nativeBaseline,
    measurementSequence: 'portable-edit',
    sequenceSha256: digestObject(PORTABLE_EDIT_STAGES),
    stages: PORTABLE_EDIT_STAGES.map((stage) => ({ ...stage })),
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      sameMachine: true,
      freshBuildPathsVerified: true,
      sameBuildPathWithinLaneVerified: true,
      stageSourceHashesVerified: true,
      exactReuseDenied: true,
      routeGatePassed: true,
      recipeCapabilityGatePassed: true,
      globalCachesSharedEqually: true,
      noConcurrentCompiles: true,
      laneBoundaryIdleGatePassed: true,
      compilePropertyDeltaDeclared: true,
      dependencyClosureGatePassed: true,
      artifactGatePassed: true,
      resourceGatePassed: true,
      reproducibleBuildEnvironment: {
        policyId: 'source-date-epoch-utc-v1',
        sourceDateEpoch: 1704067200,
        timeZone: 'UTC',
        passed: true,
      },
    },
    captureOrder: ['ck-native', 'native-ck', 'ck-native', 'native-ck', 'ck-native'],
    lanes: {
      ck: { identity: identity(), trials: trials(ckSamples, 'ck') },
      native: { identity: identity(), trials: trials(nativeSamples, 'native') },
    },
  };
}

function candidateForCapability(operation, profile) {
  const value = candidate();
  value.operation = operation;
  value.candidateProfile = profile;
  value.artifactEquivalencePolicyId = artifactEquivalencePolicyIdForCandidate(operation, profile);
  for (const trial of value.lanes.ck.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      trial[stage.id].profile = profile;
      trial[stage.id].qualificationOperation = operation;
      trial[stage.id].qualificationProfile = profile;
    }
  }
  for (const trial of value.lanes.native.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) trial[stage.id].profile = profile;
  }
  return value;
}

function portableFastCandidate() {
  const value = candidateForCapability('compile', 'portable-fast');
  value.artifactEquivalencePolicyId = GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
  value.compilePropertyDelta = 'PortableFast retains native Core recipes and compiler properties.';
  for (const trial of value.lanes.ck.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      const run = trial[stage.id];
      run.buildMode = stage.id === 'simple' ? 'full-build' : 'arduino-cli-incremental';
      run.ccacheEnabled = true;
      run.recipeCapability = {
        ...run.recipeCapability,
        intent: 'native-recipe-cache',
        requiredCapabilities: ['sketch_compile', 'artifact_roles_complete'],
      };
    }
  }
  return value;
}

function nativeArtifactSet(ck) {
  const prefix = ck ? 'ck' : 'native';
  return [
    {
      name: `${prefix}.ino.hex`, bytes: 128, sha256: 'a'.repeat(64),
      primaryApplication: true, role: 'avr-application-hex',
    },
    {
      name: `${prefix}.ino.eep`, bytes: 13, sha256: 'b'.repeat(64),
      primaryApplication: false, role: 'avr-eeprom',
    },
  ];
}

function nativeRecord({ stage, wallMs, ck }) {
  const artifacts = nativeArtifactSet(ck);
  const unsigned = {
    trialId: 'filled-by-test',
    phase: stage.id,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: false,
    wallMs,
    buildMode: ck
      ? stage.id === 'simple' ? 'full-build' : NATIVE_RELINK_PROFILE
      : stage.id === 'simple' ? 'full-build' : 'arduino-cli-incremental',
    fqbn: 'arduino:avr:uno',
    toolchainKey: 'arduino|avr|1.8.6|fixture-toolchain',
    cliVersion: 'arduino-cli Version: 1.4.1',
    codeSha256: stage.sourceSha256,
    resources: { evidenceComplete: true, flashUsedBytes: 586, ramUsedBytes: 13, warningCount: 0 },
    artifacts,
    artifactsVerified: true,
    artifactSetSha256: digestObject(artifacts.map((artifact) => ({ ...artifact }))),
  };
  if (ck) {
    unsigned.route = {
      coreVersion: '1.8.6',
      contractId: 'ck-fast-build-contract-fixture',
      decision: 'force-platform',
    };
  }
  return { ...unsigned, evidenceSha256: digestObject(unsigned) };
}

function nativeRelinkEvidence({ trials = 5, failingStage = null } = {}) {
  const trialList = Array.from({ length: trials }, (_, index) => {
    const id = `trial-${String(index + 1).padStart(3, '0')}`;
    const ck = {};
    const native = {};
    for (const stage of PORTABLE_EDIT_STAGES) {
      const nativeMs = stage.id === 'simple' ? 8_000 + index * 10 : 3_000 + index * 10;
      const ckMs = stage.id === 'simple'
        ? 9_000 + index * 10
        : stage.id === failingStage ? 2_900 + index * 10 : 1_000 + index * 10;
      ck[stage.id] = nativeRecord({ stage, wallMs: ckMs, ck: true });
      native[stage.id] = nativeRecord({ stage, wallMs: nativeMs, ck: false });
      ck[stage.id].trialId = id;
      native[stage.id].trialId = id;
      const { evidenceSha256: ckDigest, ...ckUnsigned } = ck[stage.id];
      const { evidenceSha256: nativeDigest, ...nativeUnsigned } = native[stage.id];
      void ckDigest;
      void nativeDigest;
      ck[stage.id].evidenceSha256 = digestObject(ckUnsigned);
      native[stage.id].evidenceSha256 = digestObject(nativeUnsigned);
    }
    ck.cacheClear = {
      reset_scope: 'first-project-full-fqbn',
      force_rebuild_pending: false,
      ccache_store_preserved: true,
    };
    const order = index % 2 === 0 ? 'ck-native' : 'native-ck';
    return {
      id,
      order,
      ck,
      native,
      laneBoundaryIdle: order.split('-').map((lane) => ({
        lane,
        policyId: 'arduino-cli-lane-idle-window-v1',
        idleWindowMs: 500,
        timeoutMs: 60_000,
        pollIntervalMs: 100,
        waitedMs: 500,
        polls: 6,
      })),
    };
  });
  return {
    schemaId: 'ck.forge.native-ab-run',
    schemaVersion: 2,
    status: 'passed',
    measurementStatus: 'passed',
    qualificationStatus: 'qualified',
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      sameMachine: true,
      sameBundledCli: true,
      sameCliConfig: true,
      sameCoreAndCompleteFqbn: true,
      sameSourceBytes: true,
      sameParallelJobs: true,
      globalCachesSharedEqually: true,
      externalShortBuildPaths: true,
      sequentialNoConcurrentCompiles: true,
      ckQualificationMode: true,
      qualificationTokenBound: true,
      nativeRelinkAdapterId: NATIVE_RELINK_ADAPTER_ID,
      nativeRelinkEngineContractId: NATIVE_RELINK_CONTRACT_ID,
      artifactEquivalencePolicyId: NATIVE_RELINK_ARTIFACT_POLICY_ID,
      exactAllowed: false,
      exactCountedAsFresh: false,
      requiredCkMode: NATIVE_RELINK_PROFILE,
      measurementSequence: 'portable-edit',
      sameBuildPathWithinLane: true,
      laneBoundaryIdlePolicy: {
        policyId: 'arduino-cli-lane-idle-window-v1',
        idleWindowMs: 500,
        timeoutMs: 60_000,
        pollIntervalMs: 100,
        outsideMeasuredCompileWallTime: true,
      },
    },
    identity: {
      fqbn: 'arduino:avr:uno',
      coreArchitecture: 'avr',
      coreVersion: '1.8.6',
      cliVersion: 'arduino-cli Version: 1.4.1',
      cliExecutableSha256: '2'.repeat(64),
      hostIdentitySha256: '3'.repeat(64),
      runnerSha256: '4'.repeat(64),
      productionExecutableSha256: '5'.repeat(64),
      sequenceSha256: '6'.repeat(64),
    },
    stages: PORTABLE_EDIT_STAGES.map((stage) => ({ ...stage })),
    captureOrder: trialList.map((trial) => trial.order),
    trials: trialList,
    checks: [{ id: 'fixture-raw-measurement', passed: true }],
    failures: [],
    runner: { unchanged: true },
    productionExecutable: {
      before: { executableSha256: '5'.repeat(64) },
      after: { executableSha256: '5'.repeat(64) },
      unchanged: true,
    },
  };
}

function removeEepromArtifacts(evidence, lanes = ['ck', 'native']) {
  for (const trial of evidence.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      for (const lane of lanes) {
        const run = trial[lane][stage.id];
        run.artifacts = run.artifacts.filter((artifact) => artifact.role !== 'avr-eeprom');
        rebindNativeRelinkRun(run);
      }
    }
  }
}

function rebindNativeRelinkRun(run) {
  run.artifactSetSha256 = digestObject(run.artifacts.map((artifact) => ({ ...artifact })));
  const { evidenceSha256, ...unsigned } = run;
  void evidenceSha256;
  run.evidenceSha256 = digestObject(unsigned);
}

function samdMkrzeroNativeRelinkEvidence() {
  const evidence = nativeRelinkEvidence();
  const adapter = SAMD_MKRZERO_NATIVE_RELINK_ADAPTER;
  evidence.controls.nativeRelinkAdapterId = adapter.id;
  evidence.controls.nativeRelinkEngineContractId = adapter.engineContractId;
  evidence.controls.artifactEquivalencePolicyId = adapter.artifactEquivalencePolicyId;
  evidence.identity.fqbn = 'arduino:samd:mkrzero';
  evidence.identity.coreArchitecture = 'samd';
  evidence.identity.coreVersion = '1.8.14';
  for (const trial of evidence.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      for (const [lane, prefix] of [['ck', 'ck'], ['native', 'native']]) {
        const run = trial[lane][stage.id];
        run.fqbn = evidence.identity.fqbn;
        if (lane === 'ck') run.route.coreVersion = evidence.identity.coreVersion;
        run.artifacts = [
          {
            name: `${prefix}.ino.bin`, bytes: 128, sha256: 'a'.repeat(64),
            primaryApplication: true, role: 'samd-application-bin',
          },
          {
            name: `${prefix}.ino.hex`, bytes: 256, sha256: 'b'.repeat(64),
            primaryApplication: true, role: 'samd-application-hex',
          },
          {
            name: `${prefix}.ino.elf`, bytes: lane === 'ck' ? 400 : 401,
            sha256: lane === 'ck' ? 'c'.repeat(64) : 'd'.repeat(64),
            primaryApplication: true, role: 'application-elf',
          },
        ];
        // A native CLI lane keeps its standard with_bootloader exports.  The
        // CK edit lane is compile-only and must prove those upload-oriented
        // files were removed (the simple baseline is still a native CLI run).
        if (lane === 'native' || stage.id === 'simple') {
          run.artifacts.splice(2, 0,
            {
              name: `${prefix}.ino.with_bootloader.bin`, bytes: 384, sha256: 'e'.repeat(64),
              primaryApplication: false, role: 'samd-with-bootloader-bin',
            },
            {
              name: `${prefix}.ino.with_bootloader.hex`, bytes: 512, sha256: 'f'.repeat(64),
              primaryApplication: false, role: 'samd-with-bootloader-hex',
            },
          );
        }
        run.artifactSetSha256 = digestObject(run.artifacts.map((artifact) => ({ ...artifact })));
        const { evidenceSha256, ...unsigned } = run;
        void evidenceSha256;
        run.evidenceSha256 = digestObject(unsigned);
      }
    }
  }
  return evidence;
}

function esp32ApplicationBinPayloadWitness(bytes, prefix, body, footerHash, checksum) {
  return {
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
  };
}

function resignEsp32NativeRelinkRun(run) {
  run.artifactSetSha256 = nativeArtifactSetSha256(run.artifacts);
  const { evidenceSha256, ...unsigned } = run;
  void evidenceSha256;
  run.evidenceSha256 = digestObject(unsigned);
}

function esp32c6NativeRelinkEvidence() {
  const evidence = nativeRelinkEvidence();
  const adapter = ESP32C6_NATIVE_RELINK_ADAPTER;
  evidence.controls.nativeRelinkAdapterId = adapter.id;
  evidence.controls.nativeRelinkEngineContractId = adapter.engineContractId;
  evidence.controls.artifactEquivalencePolicyId = adapter.artifactEquivalencePolicyId;
  evidence.identity.fqbn = 'esp32:esp32:esp32c6';
  evidence.identity.coreArchitecture = 'esp32';
  evidence.identity.coreVersion = '3.3.6';
  for (const trial of evidence.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      for (const [lane, prefix] of [['ck', 'ck'], ['native', 'native']]) {
        const run = trial[lane][stage.id];
        run.fqbn = evidence.identity.fqbn;
        if (lane === 'ck') run.route.coreVersion = evidence.identity.coreVersion;
        run.artifacts = [
          {
            name: `${prefix}.ino.bootloader.bin`, bytes: 128, sha256: 'a'.repeat(64),
            primaryApplication: false, role: 'bootloader-bin',
          },
          {
            name: `${prefix}.ino.partitions.bin`, bytes: 96, sha256: 'b'.repeat(64),
            primaryApplication: false, role: 'partitions-bin',
          },
          // The linked ELF and flash_args embed lane-local paths/names; the
          // adapter treats them as uncompared lane-local metadata.
          {
            name: `${prefix}.ino.elf`, bytes: lane === 'ck' ? 90000 : 90001,
            sha256: lane === 'ck' ? 'c'.repeat(64) : 'd'.repeat(64),
            primaryApplication: false, role: 'application-elf',
          },
          {
            name: `${prefix}.ino.bin`, bytes: 512,
            sha256: lane === 'ck' ? '1'.repeat(64) : '2'.repeat(64),
            primaryApplication: true, role: 'application-bin',
            payloadEquivalenceWitness: esp32ApplicationBinPayloadWitness(
              512,
              '3'.repeat(64),
              '4'.repeat(64),
              lane === 'ck' ? '5'.repeat(64) : '6'.repeat(64),
              lane === 'ck' ? 31 : 47,
            ),
          },
        ];
        resignEsp32NativeRelinkRun(run);
      }
    }
  }
  return evidence;
}

test('policy is fixed and requires five paired trials', () => {
  assert.equal(POLICY.id, 'ck-forge-portable-edit-no-regression-v3');
  assert.equal(POLICY.minTrials, 5);
  assert.equal(POLICY.minMedianSpeedupPct, 25);
  assert.equal(POLICY.maxP95RegressionPct, 0);
  assert.equal(POLICY.requiredSequence, 'portable-edit');
  assert.deepEqual(POLICY.requiredStages, ['simple', 'complex', 'medium', 'simple-return']);
});

test('portable-edit v4 candidate and qualification report satisfy their JSON Schemas', () => {
  const candidateSchema = JSON.parse(readFileSync(new URL(
    '../docs/schemas/ck-forge-performance-ab-candidate.schema.json', import.meta.url,
  ), 'utf8'));
  const reportSchema = JSON.parse(readFileSync(new URL(
    '../docs/schemas/ck-forge-performance-qualification-report.schema.json', import.meta.url,
  ), 'utf8'));
  const value = candidate();
  assert.deepEqual(validateJsonSchema(candidateSchema, value).errors, []);
  const compileGenericCandidate = candidate();
  compileGenericCandidate.artifactEquivalencePolicyId = GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, compileGenericCandidate).errors, []);
  for (const profile of ['quick-fast', 'shared-fast']) {
    const uploadCandidate = candidate();
    uploadCandidate.operation = 'upload-ready';
    uploadCandidate.candidateProfile = profile;
    uploadCandidate.artifactEquivalencePolicyId = GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
    assert.deepEqual(validateJsonSchema(candidateSchema, uploadCandidate).errors, []);
    uploadCandidate.artifactEquivalencePolicyId = COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID;
    assert.notDeepEqual(validateJsonSchema(candidateSchema, uploadCandidate).errors, []);
  }
  const legacyCandidate = candidate();
  legacyCandidate.schemaVersion = 3;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, legacyCandidate).errors, []);
  const fallbackCandidate = candidate();
  fallbackCandidate.lanes.ck.trials[0].complex.fallbackUsed = true;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, fallbackCandidate).errors, []);
  const editFullBuildCandidate = candidate();
  editFullBuildCandidate.lanes.ck.trials[0].complex.buildMode = 'full-build';
  assert.notDeepEqual(validateJsonSchema(candidateSchema, editFullBuildCandidate).errors, []);
  const missingReproducibleEnvironment = candidate();
  delete missingReproducibleEnvironment.controls.reproducibleBuildEnvironment;
  assert.notDeepEqual(
    validateJsonSchema(candidateSchema, missingReproducibleEnvironment).errors,
    [],
  );
  for (const mutate of [
    controls => { controls.reproducibleBuildEnvironment.policyId = 'unbound'; },
    controls => { controls.reproducibleBuildEnvironment.sourceDateEpoch = 0; },
    controls => { controls.reproducibleBuildEnvironment.timeZone = 'Asia/Shanghai'; },
    controls => { controls.reproducibleBuildEnvironment.passed = false; },
    controls => { controls.reproducibleBuildEnvironment.extra = true; },
  ]) {
    const invalidReproducibleEnvironment = candidate();
    mutate(invalidReproducibleEnvironment.controls);
    assert.notDeepEqual(
      validateJsonSchema(candidateSchema, invalidReproducibleEnvironment).errors,
      [],
    );
    assert.throws(
      () => validateCandidate(invalidReproducibleEnvironment),
      /reproducibleBuildEnvironment/,
    );
  }
  assert.throws(
    () => validateCandidate(missingReproducibleEnvironment),
    /reproducibleBuildEnvironment/,
  );
  const report = evaluate(value, HASH.input, '2026-07-25T00:00:00.000Z');
  assert.deepEqual(validateJsonSchema(reportSchema, report).errors, []);
  const legacyPolicyReport = {
    ...report,
    policy: { ...report.policy, minMedianSpeedupPct: 10 },
  };
  assert.notDeepEqual(
    validateJsonSchema(reportSchema, legacyPolicyReport).errors,
    [],
    'the report schema must reject a weaker policy even when the report shape is otherwise valid',
  );
  const compileGenericReport = {
    ...report,
    artifactEquivalencePolicyId: GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  };
  assert.notDeepEqual(validateJsonSchema(reportSchema, compileGenericReport).errors, []);
  for (const profile of ['quick-fast', 'shared-fast']) {
    const uploadReport = {
      ...report,
      operation: 'upload-ready',
      candidateProfile: profile,
      artifactEquivalencePolicyId: GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
    };
    assert.deepEqual(validateJsonSchema(reportSchema, uploadReport).errors, []);
    uploadReport.artifactEquivalencePolicyId = COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID;
    assert.notDeepEqual(validateJsonSchema(reportSchema, uploadReport).errors, []);
  }
  const legacyReport = { ...report, schemaVersion: 3 };
  assert.notDeepEqual(validateJsonSchema(reportSchema, legacyReport).errors, []);
});

test('PortableFast application-bin payload witnesses have a closed, recipe-bound schema', () => {
  const candidateSchema = JSON.parse(readFileSync(new URL(
    '../docs/schemas/ck-forge-performance-ab-candidate.schema.json', import.meta.url,
  ), 'utf8'));
  const reportSchema = JSON.parse(readFileSync(new URL(
    '../docs/schemas/ck-forge-performance-qualification-report.schema.json', import.meta.url,
  ), 'utf8'));
  const value = portableFastCandidate();
  const recipeProof = {
    schemaVersion: 1,
    kind: 'esp32-platform-recipe-elf-sha256-offset-v1',
    corePackage: value.lanes.ck.identity.corePackage,
    coreArchitecture: value.lanes.ck.identity.coreArchitecture,
    coreVersion: value.lanes.ck.identity.coreVersion,
    recipeProperty: 'recipe.objcopy.bin.pattern_args',
    recipeSource: 'platform.txt',
    recipeSourceSha256: 'c'.repeat(64),
    recipeValueSha256: 'd'.repeat(64),
    elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
    elfSha256Offset: 176,
  };
  value.artifactEquivalencePolicyId = 'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2';
  value.portableFastEspApplicationBinRecipeProof = recipeProof;
  const witnessFor = (byteLength) => ({
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    recipe: {
      elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
      elfSha256Offset: 176,
    },
    byteLength,
    mutableRange: { offset: 176, length: 32 },
    immutableSegments: [
      { offset: 0, length: 176, sha256: '9'.repeat(64) },
      { offset: 208, length: byteLength - 241, sha256: 'a'.repeat(64) },
    ],
    footer: {
      offset: byteLength - 33,
      length: 33,
      checksumOffset: byteLength - 33,
      checksum: 0,
      validationHash: 'b'.repeat(64),
      checksumValid: true,
      validationHashValid: true,
    },
  });
  const applicationBin = value.lanes.ck.trials[0].simple.artifacts.find(
    (artifact) => artifact.role === 'application-bin',
  );
  assert.ok(applicationBin);
  applicationBin.payloadEquivalenceWitness = witnessFor(applicationBin.bytes);
  assert.deepEqual(validateJsonSchema(candidateSchema, value).errors, []);
  assert.deepEqual(
    validateJsonSchema(
      reportSchema,
      evaluate(portableFastCandidate(), HASH.input, '2026-07-26T00:00:00.000Z'),
    ).errors,
    [],
  );

  const badOffset = structuredClone(value);
  badOffset.lanes.ck.trials[0].simple.artifacts.find(
    (artifact) => artifact.role === 'application-bin',
  ).payloadEquivalenceWitness.mutableRange.offset = 175;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, badOffset).errors, []);

  const extraField = structuredClone(value);
  extraField.lanes.ck.trials[0].simple.artifacts.find(
    (artifact) => artifact.role === 'application-bin',
  ).payloadEquivalenceWitness.untrusted = true;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, extraField).errors, []);

  const wrongRole = structuredClone(value);
  const wrongRoleArtifact = wrongRole.lanes.ck.trials[0].simple.artifacts.find(
    (artifact) => artifact.role === 'application-bin',
  );
  wrongRoleArtifact.role = 'application-elf';
  wrongRoleArtifact.payloadEquivalenceWitness = witnessFor(applicationBin.bytes);
  assert.notDeepEqual(validateJsonSchema(candidateSchema, wrongRole).errors, []);

  const missingCcache = structuredClone(value);
  delete missingCcache.lanes.ck.trials[0].simple.ccacheEnabled;
  assert.notDeepEqual(validateJsonSchema(candidateSchema, missingCcache).errors, []);

  const quickFast = candidate();
  quickFast.lanes.ck.trials[0].simple.artifacts.find(
    (artifact) => artifact.role === 'application-bin',
  ).payloadEquivalenceWitness = witnessFor(applicationBin.bytes);
  assert.notDeepEqual(validateJsonSchema(candidateSchema, quickFast).errors, []);
});

test('evaluator keeps artifact identity independent of an optional payload witness', () => {
  const artifacts = [{
    name: 'sketch.ino.bin',
    role: 'application-bin',
    bytes: 512,
    sha256: 'a'.repeat(64),
    primaryApplication: true,
  }];
  const before = nativeArtifactSetSha256(artifacts);
  artifacts[0].payloadEquivalenceWitness = {
    schemaVersion: 1,
    kind: 'esp-application-bin-elf-sha256-offset-v1',
    mutableRange: { offset: 176, length: 32 },
  };
  assert.equal(nativeArtifactSetSha256(artifacts), before);
});

test('median and nearest-rank p95 are deterministic', () => {
  assert.equal(median([3, 1, 2]), 2);
  assert.equal(median([4, 1, 3, 2]), 2.5);
  assert.equal(percentileNearestRank([3, 1, 2], 95), 3);
});

test('qualifies only when all four portable-edit stages beat native with stable tails', () => {
  const report = evaluate(candidate(), HASH.input, '2026-07-18T00:00:00.000Z');
  assert.equal(report.status, 'qualified-fast');
  assert.equal(report.qualifiedFast, true);
  assert.equal(report.recommendedRoute, 'ck-fast');
  assert.equal(report.schemaVersion, 4);
  assert.equal(report.operation, 'compile');
  assert.equal(report.candidateProfile, 'quick-fast');
  assert.equal(report.candidateRoute, 'qualification-token-probe');
  assert.equal(report.hostIdentitySha256, HASH.host);
  assert.equal(report.sampleSetSha256, HASH.input);
  assert.equal(report.measurementSequence, 'portable-edit');
  assert.deepEqual(report.stages.map((stage) => stage.stage), [
    'simple', 'complex', 'medium', 'simple-return',
  ]);
  assert.ok(report.stages.every((stage) => stage.qualified));
});

test('generic qualification key binds the v3 performance policy ID', () => {
  const value = candidate();
  const report = evaluate(value, HASH.input, '2026-07-26T00:00:00.000Z');
  const binding = genericQualificationBinding(value);
  assert.equal(binding.performancePolicyId, 'ck-forge-portable-edit-no-regression-v3');
  assert.equal(report.qualificationKey, digestObject(binding));
  const legacyBinding = { ...binding, performancePolicyId: 'ck-forge-portable-edit-no-regression-v2' };
  assert.notEqual(report.qualificationKey, digestObject(legacyBinding));
});

test('refuses Fast when simple is slower even if all edit stages are faster', () => {
  const report = evaluate(candidate({
    ckSimple: [11000, 11100, 10900, 11050, 10950],
  }), HASH.input, '2026-07-18T00:00:00.000Z');
  assert.equal(report.status, 'not-qualified');
  assert.equal(report.qualifiedFast, false);
  assert.equal(report.recommendedRoute, 'native-arduino-cli');
  assert.deepEqual(report.reasonCodes, ['simple-performance-gate-failed']);
});

test('refuses Fast when p95 regresses despite a faster median', () => {
  const report = evaluate(candidate({
    ckSimple: [7000, 7000, 7000, 7000, 11000],
    nativeSimple: [10000, 10000, 10000, 10000, 10000],
  }), HASH.input, '2026-07-18T00:00:00.000Z');
  assert.equal(report.qualifiedFast, false);
  const simple = report.stages.find((stage) => stage.stage === 'simple');
  assert.equal(simple.checks.find((check) => check.id === 'ck-p95-does-not-regress').passed, false);
});

test('rejects mismatched Core/FQBN/toolchain identity instead of comparing unlike runs', () => {
  const value = candidate();
  value.lanes.native.identity.coreVersion = '3.3.7';
  assert.throws(() => validateCandidate(value), /identity mismatch: coreVersion/);

  const rebuilt = candidate();
  rebuilt.lanes.native.identity.productionExecutableSha256 = '9'.repeat(64);
  assert.throws(
    () => validateCandidate(rebuilt),
    /identity mismatch: productionExecutableSha256/,
  );

  const changedContent = candidate();
  changedContent.lanes.ck.identity.toolchainContentSha256 = '9'.repeat(64);
  changedContent.lanes.native.identity.toolchainContentSha256 = '9'.repeat(64);
  assert.throws(
    () => validateCandidate(changedContent),
    /toolchainContentSha256 does not match toolchainKey/,
  );

  const changedConfig = candidate();
  changedConfig.lanes.native.identity.cliConfigSha256 = 'a'.repeat(64);
  assert.throws(() => validateCandidate(changedConfig), /identity mismatch: cliConfigSha256/);
});

test('portable-edit candidate fails closed on source, path, route, capability, and resource drift', () => {
  const sourceDrift = candidate();
  sourceDrift.lanes.ck.trials[0].complex.codeSha256 = '9'.repeat(64);
  assert.throws(() => validateCandidate(sourceDrift), /codeSha256 does not match stage/);

  const pathDrift = candidate();
  pathDrift.lanes.native.trials[0].medium.buildPathIdentitySha256 = '9'.repeat(64);
  assert.throws(() => validateCandidate(pathDrift), /one build path across portable edits/);

  const routeDrift = candidate();
  routeDrift.lanes.ck.trials[0]['simple-return'].ckContractId = 'other-contract';
  assert.throws(() => validateCandidate(routeDrift), /Fast route binding/);

  const tokenRouteDrift = candidate();
  tokenRouteDrift.lanes.ck.trials[0].complex.candidateRoute = 'candidate-profile-probe';
  assert.throws(() => validateCandidate(tokenRouteDrift), /execution evidence/);

  const fallbackDrift = candidate();
  fallbackDrift.lanes.ck.trials[0].complex.fallbackUsed = true;
  assert.throws(() => validateCandidate(fallbackDrift), /execution evidence/);

  const editModeDrift = candidate();
  editModeDrift.lanes.ck.trials[0].complex.buildMode = 'full-build';
  assert.throws(() => validateCandidate(editModeDrift), /execution evidence/);

  const simpleFallbackDrift = candidate();
  simpleFallbackDrift.lanes.ck.trials[0].simple.fallbackUsed = true;
  assert.throws(() => validateCandidate(simpleFallbackDrift), /execution evidence/);

  const capabilityDrift = candidate();
  capabilityDrift.lanes.ck.trials[0].simple.recipeCapability.missingCapabilities = ['direct_link'];
  assert.throws(() => validateCandidate(capabilityDrift), /recipe capability gate/);

  const resourceDrift = candidate();
  resourceDrift.lanes.native.trials[0].medium.resources.flashUsedBytes += 1;
  assert.throws(() => validateCandidate(resourceDrift), /resource mismatch/);

  const nativeBaselineDrift = candidate();
  nativeBaselineDrift.lanes.native.trials[0].medium.compilerPropertyDeltaSha256 = 'a'.repeat(64);
  assert.throws(() => validateCandidate(nativeBaselineDrift), /native compiler baseline binding/);
});

test('binds each certificate to one supported operation and profile', () => {
  assert.equal(
    artifactEquivalencePolicyIdForCandidate('compile', 'quick-fast'),
    COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(
    artifactEquivalencePolicyIdForCandidate('upload-ready', 'quick-fast'),
    GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  assert.equal(
    artifactEquivalencePolicyIdForCandidate('upload-ready', 'shared-fast'),
    GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );

  const compileGeneric = candidate();
  compileGeneric.artifactEquivalencePolicyId = GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
  assert.throws(
    () => validateCandidate(compileGeneric),
    /artifactEquivalencePolicyId must be .*compile-only.* for compile\/quick-fast/,
  );

  const compileShared = candidate();
  compileShared.candidateProfile = 'shared-fast';
  assert.throws(() => validateCandidate(compileShared), /compile evidence may certify only portable-fast or quick-fast/);

  assert.equal(
    artifactEquivalencePolicyIdForCandidate('compile', 'portable-fast'),
    GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  );
  const portable = portableFastCandidate();
  assert.doesNotThrow(() => validateCandidate(portable));
  assert.equal(
    evaluate(portable, HASH.input, '2026-07-26T00:00:00.000Z').candidateProfile,
    'portable-fast',
  );
  const specialProof = {
    schemaVersion: 1,
    kind: 'esp32-platform-recipe-elf-sha256-offset-v1',
    corePackage: portable.lanes.ck.identity.corePackage,
    coreArchitecture: portable.lanes.ck.identity.coreArchitecture,
    coreVersion: portable.lanes.ck.identity.coreVersion,
    recipeProperty: 'recipe.objcopy.bin.pattern_args',
    recipeSource: 'platform.txt',
    recipeSourceSha256: 'c'.repeat(64),
    recipeValueSha256: 'd'.repeat(64),
    elfSha256OffsetArgument: '--elf-sha256-offset 0xb0',
    elfSha256Offset: 176,
  };
  assert.equal(
    artifactEquivalencePolicyIdForCandidate(
      'compile', 'portable-fast', specialProof, portable.lanes.ck.identity,
    ),
    'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2',
  );
  const specialPortable = portableFastCandidate();
  specialPortable.portableFastEspApplicationBinRecipeProof = specialProof;
  specialPortable.artifactEquivalencePolicyId = 'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2';
  assert.doesNotThrow(() => validateCandidate(specialPortable));
  const specialReport = evaluate(specialPortable, HASH.input, '2026-07-26T00:00:00.000Z');
  assert.equal(
    specialReport.artifactEquivalencePolicyId,
    'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2',
  );
  assert.deepEqual(specialReport.portableFastEspApplicationBinRecipeProof, specialProof);
  const forgedProof = structuredClone(specialPortable);
  forgedProof.portableFastEspApplicationBinRecipeProof.coreVersion = '3.3.5';
  assert.throws(() => validateCandidate(forgedProof), /recipe proof is malformed or bound to another Core/);
  const portableUpload = portableFastCandidate();
  portableUpload.operation = 'upload-ready';
  for (const trial of portableUpload.lanes.ck.trials) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      trial[stage.id].qualificationOperation = 'upload-ready';
    }
  }
  assert.throws(
    () => validateCandidate(portableUpload),
    /upload-ready evidence may not certify portable-fast/,
  );

  for (const profile of ['quick-fast', 'shared-fast']) {
    const uploadCandidate = candidateForCapability('upload-ready', profile);
    const report = evaluate(uploadCandidate, HASH.input, '2026-07-18T00:00:00.000Z');
    assert.equal(report.operation, 'upload-ready');
    assert.equal(report.candidateProfile, profile);
    assert.equal(report.artifactEquivalencePolicyId, GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID);

    uploadCandidate.artifactEquivalencePolicyId = COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID;
    assert.throws(
      () => validateCandidate(uploadCandidate),
      new RegExp(`artifactEquivalencePolicyId must be .*generic.* for upload-ready/${profile}`),
    );
  }

  const legacy = candidate();
  legacy.schemaVersion = 3;
  assert.throws(() => validateCandidate(legacy), /unsupported candidate schema identity/);
});

test('PortableFast requires native CLI modes, ccache evidence, native-recipe intent, and full artifacts', () => {
  for (const buildMode of [
    'full-build',
    'arduino-cli-core-seeded',
    'arduino-cli-incremental',
    'arduino-cli-incremental-fallback',
    'arduino-cli-full-fallback',
  ]) {
    const value = portableFastCandidate();
    value.lanes.ck.trials[0].complex.buildMode = buildMode;
    assert.doesNotThrow(() => validateCandidate(value), buildMode);
  }

  for (const buildMode of [
    'fast-relink',
    'native-relink-compile-only',
    'native-relink-graph-transition',
    'exact-match',
  ]) {
    const value = portableFastCandidate();
    value.lanes.ck.trials[0].complex.buildMode = buildMode;
    assert.throws(() => validateCandidate(value), /execution evidence/, buildMode);
  }

  const ccacheDisabled = portableFastCandidate();
  ccacheDisabled.lanes.ck.trials[0].medium.ccacheEnabled = false;
  assert.throws(() => validateCandidate(ccacheDisabled), /ccache evidence/);

  const wrongRecipeIntent = portableFastCandidate();
  wrongRecipeIntent.lanes.ck.trials[0].medium.recipeCapability.intent = 'compile';
  assert.throws(() => validateCandidate(wrongRecipeIntent), /recipe intent must be native-recipe-cache/);

  const artifactMismatch = portableFastCandidate();
  const nativeRun = artifactMismatch.lanes.native.trials[0].medium;
  nativeRun.artifacts[0].sha256 = 'f'.repeat(64);
  nativeRun.artifactSetSha256 = digestObject(nativeRun.artifacts);
  assert.throws(() => validateCandidate(artifactMismatch), /artifact equivalence failed/);
});

test('rejects single samples and unbalanced capture order', () => {
  const tooFew = candidate();
  tooFew.lanes.ck.trials = tooFew.lanes.ck.trials.slice(0, 1);
  tooFew.lanes.native.trials = tooFew.lanes.native.trials.slice(0, 1);
  tooFew.captureOrder = ['ck-native'];
  assert.throws(() => validateCandidate(tooFew), /alternate lane priority|5\.\.25/);

  const unbalanced = candidate();
  unbalanced.captureOrder = ['ck-native', 'ck-native', 'ck-native', 'ck-native', 'ck-native'];
  assert.throws(() => validateCandidate(unbalanced), /alternate lane priority/);
});

test('CLI refuses to overwrite output and returns 2 for valid non-qualification', () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-forge-performance-gate-'));
  try {
    const input = join(root, 'candidate.json');
    const output = join(root, 'report.json');
    writeFileSync(input, `${JSON.stringify(candidate({ ckSimple: [12000, 12100, 11900, 12050, 11950] }))}\n`);
    assert.equal(main(['--evaluate', '--input', input, '--output', output]), 2);
    const report = JSON.parse(readFileSync(output, 'utf8'));
    assert.equal(report.recommendedRoute, 'native-arduino-cli');
    assert.equal(main(['--evaluate', '--input', input, '--output', output]), 1);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('plan never requires or writes an output', () => {
  const options = parseArgs(['--plan', '--input', 'candidate.json']);
  assert.equal(options.action, 'plan');
  assert.equal(options.outputPath, null);
  assert.throws(
    () => parseArgs(['--plan', '--input', 'candidate.json', '--output', 'result.json']),
    /does not write output/,
  );
});

test('NativeRelink qualifies three edit stages while cold simple may be slower', () => {
  const evidence = nativeRelinkEvidence();
  const report = evaluate(evidence, '7'.repeat(64), '2026-07-18T00:00:00.000Z');
  assert.equal(report.status, 'qualified-native-relink');
  assert.equal(report.qualified, true);
  assert.equal(report.candidateProfile, NATIVE_RELINK_PROFILE);
  assert.equal(report.target.productionExecutableSha256, '5'.repeat(64));
  assert.equal(report.coldSimpleRequiredToWin, false);
  assert.deepEqual(report.stages.map((stage) => stage.id), ['complex', 'medium', 'simple-return']);
  assert.ok(report.stages.every((stage) => stage.qualified));
});

test('NativeRelink accepts absent AVR EEPROM images and rejects any one-sided or changed output', () => {
  const absentInBothLanes = nativeRelinkEvidence();
  removeEepromArtifacts(absentInBothLanes);
  assert.equal(
    evaluate(absentInBothLanes, '7'.repeat(64), '2026-07-18T00:00:00.000Z').qualified,
    true,
  );

  const oneSided = nativeRelinkEvidence();
  removeEepromArtifacts(oneSided, ['ck']);
  assert.throws(
    () => evaluate(oneSided, '7'.repeat(64), '2026-07-18T00:00:00.000Z'),
    /artifact evidence differs/,
  );

  const reverseOneSided = nativeRelinkEvidence();
  removeEepromArtifacts(reverseOneSided, ['native']);
  assert.throws(
    () => evaluate(reverseOneSided, '7'.repeat(64), '2026-07-18T00:00:00.000Z'),
    /artifact evidence differs/,
  );

  const byteDrift = nativeRelinkEvidence();
  const byteDriftRun = byteDrift.trials[0].ck.complex;
  byteDriftRun.artifacts.find((artifact) => artifact.role === 'avr-eeprom').bytes += 1;
  rebindNativeRelinkRun(byteDriftRun);
  assert.throws(
    () => evaluate(byteDrift, '7'.repeat(64), '2026-07-18T00:00:00.000Z'),
    /artifact evidence differs/,
  );

  const shaDrift = nativeRelinkEvidence();
  const shaDriftRun = shaDrift.trials[0].ck.complex;
  shaDriftRun.artifacts.find((artifact) => artifact.role === 'avr-eeprom').sha256 = 'f'.repeat(64);
  rebindNativeRelinkRun(shaDriftRun);
  assert.throws(
    () => evaluate(shaDrift, '7'.repeat(64), '2026-07-18T00:00:00.000Z'),
    /artifact evidence differs/,
  );
});

test('AVR v1 engine or artifact-policy evidence cannot authorize the v2 engine', () => {
  const legacy = nativeRelinkEvidence();
  legacy.controls.nativeRelinkEngineContractId = 'ck-native-relink-avr-release-compile-only-v1';
  assert.throws(
    () => evaluate(legacy, '7'.repeat(64)),
    /adapter\/artifact equivalence contract is missing or mismatched/,
  );

  const legacyPolicy = nativeRelinkEvidence();
  legacyPolicy.controls.artifactEquivalencePolicyId = 'arduino-avr-hex-eeprom-exact-v1';
  assert.throws(
    () => evaluate(legacyPolicy, '7'.repeat(64)),
    /adapter\/artifact equivalence contract is missing or mismatched/,
  );
});

test('NativeRelink qualification key and raw evidence are bound to the production executable', () => {
  const firstEvidence = nativeRelinkEvidence();
  const first = evaluate(firstEvidence, '7'.repeat(64));

  const rebuiltEvidence = nativeRelinkEvidence();
  rebuiltEvidence.identity.productionExecutableSha256 = '8'.repeat(64);
  rebuiltEvidence.productionExecutable.before.executableSha256 = '8'.repeat(64);
  rebuiltEvidence.productionExecutable.after.executableSha256 = '8'.repeat(64);
  const rebuilt = evaluate(rebuiltEvidence, '9'.repeat(64));
  assert.notEqual(first.qualificationKey, rebuilt.qualificationKey);
  assert.equal(rebuilt.target.productionExecutableSha256, '8'.repeat(64));

  const mismatchedEvidence = nativeRelinkEvidence();
  mismatchedEvidence.identity.productionExecutableSha256 = '8'.repeat(64);
  assert.throws(
    () => evaluate(mismatchedEvidence, '7'.repeat(64)),
    /production executable evidence does not match/,
  );
});

test('NativeRelink v3 binding has a fixed Rust-compatible executable-bound vector', () => {
  const target = {
    fqbn: 'arduino:avr:uno',
    coreVersion: '1.8.6',
    toolchainKey: 'arduino|avr|1.8.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931',
    cliVersion: 'arduino-cli  Version: 1.4.1 Commit: e39419312 Date: 2026-01-19T16:12:56Z',
    cliExecutableSha256: '8f73503f7ac280dc1245b085c4e856c9549eb1e88c2904c777bf229692ee4c39',
    hostIdentitySha256: '3c8d9136fbce589ba098f93c0c773c2d58ce7ea335fb68cae249af7c9f634768',
    productionExecutableSha256: '5'.repeat(64),
    sequenceSha256: 'b453c06daaa63bd6df776e8c5b24f60ebd33a11aff50a37f2e5bd325076d65f8',
  };
  const binding = nativeRelinkQualificationBinding(
    target,
    'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard',
  );
  assert.equal(binding.schemaVersion, NATIVE_RELINK_BINDING_SCHEMA_VERSION);
  assert.equal(binding.performancePolicyId, 'ck-forge-portable-edit-performance-v3');
  assert.equal(
    digestObject(binding),
    'af085d85b31194c5a4704d1f5af9ae291e5ae31866b7228436078fb991605398',
  );

  const esp32Target = {
    ...target,
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
    coreVersion: '3.3.6',
    toolchainKey: 'esp32|esp32|3.3.6|74aab7d9d0f1f1686add0ec776206f8054f0c1e3531a2113b56ca54c031fd931',
  };
  const esp32Binding = nativeRelinkQualificationBinding(
    esp32Target,
    'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard',
    ESP32C6_NATIVE_RELINK_ADAPTER,
  );
  assert.equal(
    esp32Binding.nativeRelinkContractId,
    'ck-native-relink-esp32-release-compile-only-phase1-v1',
  );
  assert.equal(
    digestObject(esp32Binding),
    '78b391ddf2c8372bf989485ce1b7790daafa88ae17de24c598fc205f03814c77',
  );
  assert.notEqual(
    digestObject(esp32Binding),
    digestObject(nativeRelinkQualificationBinding(
      esp32Target,
      'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard',
    )),
    'the ESP32 engine contract cryptographically separates its certificates from AVR',
  );
});

test('NativeRelink refuses tampered mode, fewer than five trials, and any failing edit stage', () => {
  const unboundProbe = nativeRelinkEvidence();
  delete unboundProbe.controls.qualificationTokenBound;
  assert.throws(
    () => evaluate(unboundProbe, '7'.repeat(64)),
    /qualification contract/,
  );

  const noLaneSettle = nativeRelinkEvidence();
  delete noLaneSettle.controls.laneBoundaryIdlePolicy;
  assert.throws(
    () => evaluate(noLaneSettle, '7'.repeat(64)),
    /lane-boundary idle policy/,
  );

  const wrongLaneSettle = nativeRelinkEvidence();
  wrongLaneSettle.trials[0].laneBoundaryIdle[0].lane = 'native';
  assert.throws(
    () => evaluate(wrongLaneSettle, '7'.repeat(64)),
    /lane-boundary idle evidence is invalid/,
  );

  const wrongMode = nativeRelinkEvidence();
  wrongMode.trials[0].ck.complex.buildMode = 'arduino-cli-incremental';
  const { evidenceSha256: staleDigest, ...wrongModeUnsigned } = wrongMode.trials[0].ck.complex;
  void staleDigest;
  wrongMode.trials[0].ck.complex.evidenceSha256 = digestObject(wrongModeUnsigned);
  assert.throws(() => evaluate(wrongMode, '7'.repeat(64)), /used buildMode/);

  assert.throws(
    () => evaluate(nativeRelinkEvidence({ trials: 4 }), '7'.repeat(64)),
    /requires 5\.\.25 paired trials/,
  );

  const report = evaluate(nativeRelinkEvidence({ failingStage: 'medium' }), '7'.repeat(64));
  assert.equal(report.qualified, false);
  assert.equal(report.status, 'not-qualified');
  assert.deepEqual(report.reasonCodes, ['medium-performance-gate-failed']);
});

test('NativeRelink certification admits exact MKR Zero and rejects other SAMD targets', () => {
  const samd = samdMkrzeroNativeRelinkEvidence();
  const report = evaluate(samd, '7'.repeat(64));
  assert.equal(report.qualified, true);
  assert.equal(report.nativeRelinkAdapterId, 'arduino-samd-mkrzero-native-relink-v1');
  assert.equal(
    report.nativeRelinkContractId,
    'ck-native-relink-samd-release-compile-only-phase1-v1',
  );
  assert.equal(
    report.artifactEquivalencePolicyId,
    'arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2',
  );

  const clone = samdMkrzeroNativeRelinkEvidence();
  clone.identity.fqbn = 'arduino:samd:mkrzero_clone';
  assert.throws(
    () => evaluate(clone, '7'.repeat(64)),
    /no matching registered adapter/,
  );

  const mismatchedPolicy = nativeRelinkEvidence();
  mismatchedPolicy.controls.artifactEquivalencePolicyId = 'samd-bin-hex-exact-v1';
  assert.throws(
    () => evaluate(mismatchedPolicy, '7'.repeat(64)),
    /adapter\/artifact equivalence contract is missing or mismatched/,
  );
});

test('MKR Zero certification requires exact application images, rejects CK bootloader residue and upload artifacts, and allows ELF drift', () => {
  const elfDrift = samdMkrzeroNativeRelinkEvidence();
  assert.equal(evaluate(elfDrift, '7'.repeat(64)).qualified, true);

  const binDrift = samdMkrzeroNativeRelinkEvidence();
  const bin = binDrift.trials[0].ck.complex.artifacts
    .find((artifact) => artifact.role === 'samd-application-bin');
  bin.sha256 = 'f'.repeat(64);
  const run = binDrift.trials[0].ck.complex;
  run.artifactSetSha256 = digestObject(run.artifacts.map((artifact) => ({ ...artifact })));
  const { evidenceSha256, ...unsigned } = run;
  void evidenceSha256;
  run.evidenceSha256 = digestObject(unsigned);
  assert.throws(
    () => evaluate(binDrift, '7'.repeat(64)),
    /required artifact evidence differs/,
  );

  for (const role of SAMD_MKRZERO_NATIVE_RELINK_ADAPTER.forbiddenCkEditArtifactRoles) {
    const residual = samdMkrzeroNativeRelinkEvidence();
    const residualRun = residual.trials[0].ck.complex;
    residualRun.artifacts.push({
      name: `${role}.fixture`, role, bytes: 1, sha256: 'e'.repeat(64), primaryApplication: false,
    });
    residualRun.artifactSetSha256 = digestObject(
      residualRun.artifacts.map((artifact) => ({ ...artifact })),
    );
    const { evidenceSha256: digest, ...residualUnsigned } = residualRun;
    void digest;
    residualRun.evidenceSha256 = digestObject(residualUnsigned);
    assert.throws(
      () => evaluate(residual, '7'.repeat(64)),
      /artifact policy rejected/,
      role,
    );
  }

  for (const role of SAMD_MKRZERO_NATIVE_RELINK_ADAPTER.forbiddenAllStageArtifactRoles) {
    const residual = samdMkrzeroNativeRelinkEvidence();
    const residualRun = residual.trials[0].ck.simple;
    residualRun.artifacts.push({
      name: `${role}.fixture`, role, bytes: 1, sha256: 'e'.repeat(64), primaryApplication: false,
    });
    residualRun.artifactSetSha256 = digestObject(
      residualRun.artifacts.map((artifact) => ({ ...artifact })),
    );
    const { evidenceSha256: digest, ...residualUnsigned } = residualRun;
    void digest;
    residualRun.evidenceSha256 = digestObject(residualUnsigned);
    assert.throws(
      () => evaluate(residual, '7'.repeat(64)),
      /artifact policy rejected/,
      role,
    );
  }
});

test('ESP32-C6 certification admits the application-bin payload witness and stays exact elsewhere', () => {
  const esp32 = esp32c6NativeRelinkEvidence();
  const report = evaluate(esp32, '7'.repeat(64));
  assert.equal(report.qualified, true);
  assert.equal(report.nativeRelinkAdapterId, 'esp32-esp32c6-native-relink-v1');
  assert.equal(
    report.nativeRelinkContractId,
    'ck-native-relink-esp32-release-compile-only-phase1-v1',
  );
  assert.equal(
    report.artifactEquivalencePolicyId,
    'esp32-app-bin-witness-bootloader-partitions-exact-v1',
  );
  const target = {
    fqbn: 'esp32:esp32:esp32c6',
    coreVersion: '3.3.6',
    toolchainKey: 'arduino|avr|1.8.6|fixture-toolchain',
    cliVersion: 'arduino-cli Version: 1.4.1',
    cliExecutableSha256: '2'.repeat(64),
    hostIdentitySha256: '3'.repeat(64),
    productionExecutableSha256: '5'.repeat(64),
    sequenceSha256: '6'.repeat(64),
  };
  assert.equal(
    report.qualificationKey,
    digestObject(nativeRelinkQualificationBinding(
      target,
      'ck-fast-build-contract-fixture',
      ESP32C6_NATIVE_RELINK_ADAPTER,
    )),
    'the qualification key binds the ESP32 engine contract, not the AVR default',
  );

  const missingWitness = esp32c6NativeRelinkEvidence();
  const witnessless = missingWitness.trials[0].native.complex;
  delete witnessless.artifacts.find((artifact) => artifact.role === 'application-bin')
    .payloadEquivalenceWitness;
  resignEsp32NativeRelinkRun(witnessless);
  assert.throws(
    () => evaluate(missingWitness, '7'.repeat(64)),
    /required artifact evidence differs/,
    'a digest mismatch without a payload witness on one lane fails closed',
  );

  const segmentDrift = esp32c6NativeRelinkEvidence();
  const driftedRun = segmentDrift.trials[0].ck.complex;
  driftedRun.artifacts.find((artifact) => artifact.role === 'application-bin')
    .payloadEquivalenceWitness.immutableSegments[1].sha256 = '9'.repeat(64);
  resignEsp32NativeRelinkRun(driftedRun);
  assert.throws(
    () => evaluate(segmentDrift, '7'.repeat(64)),
    /required artifact evidence differs/,
    'immutable-segment drift is a real content difference',
  );

  const bootloaderDrift = esp32c6NativeRelinkEvidence();
  const bootloaderRun = bootloaderDrift.trials[0].ck.complex;
  bootloaderRun.artifacts.find((artifact) => artifact.role === 'bootloader-bin')
    .sha256 = '9'.repeat(64);
  resignEsp32NativeRelinkRun(bootloaderRun);
  assert.throws(
    () => evaluate(bootloaderDrift, '7'.repeat(64)),
    /required artifact evidence differs/,
    'bootloader-bin stays byte-exact',
  );

  const lengthDrift = esp32c6NativeRelinkEvidence();
  const lengthRun = lengthDrift.trials[0].native.complex;
  const lengthBin = lengthRun.artifacts.find((artifact) => artifact.role === 'application-bin');
  lengthBin.bytes = 513;
  lengthBin.payloadEquivalenceWitness = esp32ApplicationBinPayloadWitness(
    513, '3'.repeat(64), '4'.repeat(64), '6'.repeat(64), 47,
  );
  resignEsp32NativeRelinkRun(lengthRun);
  assert.throws(
    () => evaluate(lengthDrift, '7'.repeat(64)),
    /required artifact evidence differs/,
    'witness roles require byte-length equality',
  );

  const otherBoard = esp32c6NativeRelinkEvidence();
  otherBoard.identity.fqbn = 'esp32:esp32:esp32wrover';
  assert.throws(
    () => evaluate(otherBoard, '7'.repeat(64)),
    /no matching registered adapter/,
    'named ESP32 variants stay unregistered',
  );

  const siblingBoard = esp32c6NativeRelinkEvidence();
  siblingBoard.identity.fqbn = 'esp32:esp32:esp32c3';
  assert.throws(
    () => evaluate(siblingBoard, '7'.repeat(64)),
    /adapter\/artifact equivalence contract is missing or mismatched/,
    'esp32c6 evidence can never certify under a sibling board adapter row',
  );

  const wrongArchitecture = esp32c6NativeRelinkEvidence();
  wrongArchitecture.identity.coreArchitecture = 'avr';
  assert.throws(
    () => evaluate(wrongArchitecture, '7'.repeat(64)),
    /no matching registered adapter/,
    'the evaluator requires identity.coreArchitecture to equal esp32 exactly',
  );
});

test('NativeRelink certification rejects AVR primary artifact drift before timing can qualify', () => {
  const evidence = nativeRelinkEvidence();
  const run = evidence.trials[0].ck.complex;
  run.artifacts[0].sha256 = 'f'.repeat(64);
  run.artifactSetSha256 = digestObject(run.artifacts.map((artifact) => ({ ...artifact })));
  const { evidenceSha256: staleDigest, ...unsigned } = run;
  void staleDigest;
  run.evidenceSha256 = digestObject(unsigned);
  assert.throws(
    () => evaluate(evidence, '7'.repeat(64)),
    /required artifact evidence differs/,
  );
});

test('AVR keeps native with-bootloader output but rejects it from CK edit output', () => {
  const nativeOutput = nativeRelinkEvidence();
  const nativeRun = nativeOutput.trials[0].native.complex;
  nativeRun.artifacts.push({
    name: 'native.ino.with_bootloader.hex', role: 'avr-with-bootloader',
    bytes: 140, sha256: 'e'.repeat(64), primaryApplication: false,
  });
  nativeRun.artifactSetSha256 = digestObject(
    nativeRun.artifacts.map((artifact) => ({ ...artifact })),
  );
  const { evidenceSha256: nativeDigest, ...nativeUnsigned } = nativeRun;
  void nativeDigest;
  nativeRun.evidenceSha256 = digestObject(nativeUnsigned);
  assert.equal(evaluate(nativeOutput, '7'.repeat(64)).qualified, true);

  const ckOutput = nativeRelinkEvidence();
  const ckRun = ckOutput.trials[0].ck.complex;
  ckRun.artifacts.push({
    name: 'ck.ino.with_bootloader.hex', role: 'avr-with-bootloader',
    bytes: 140, sha256: 'e'.repeat(64), primaryApplication: false,
  });
  ckRun.artifactSetSha256 = digestObject(ckRun.artifacts.map((artifact) => ({ ...artifact })));
  const { evidenceSha256: ckDigest, ...ckUnsigned } = ckRun;
  void ckDigest;
  ckRun.evidenceSha256 = digestObject(ckUnsigned);
  assert.throws(() => evaluate(ckOutput, '7'.repeat(64)), /artifact policy rejected/);
});

test('NativeRelink certificate installation preserves immutable evidence and refuses clobber', () => {
  const root = mkdtempSync(join(tmpdir(), 'ck-forge-native-relink-certificate-'));
  try {
    const input = join(root, 'native-ab.json');
    const qualificationRoot = join(root, 'state', 'qualifications');
    writeFileSync(input, `${JSON.stringify(nativeRelinkEvidence(), null, 2)}\n`);
    const installed = certifyNativeRelink(input, qualificationRoot);
    assert.equal(installed.report.qualified, true);
    const certificate = JSON.parse(readFileSync(join(installed.certificatePath, 'certificate.json'), 'utf8'));
    assert.equal(certificate.schemaVersion, 4);
    assert.equal(certificate.candidateProfile, NATIVE_RELINK_PROFILE);
    assert.deepEqual(
      readFileSync(join(installed.certificatePath, 'evidence.json')),
      readFileSync(input),
    );
    assert.throws(() => certifyNativeRelink(input, qualificationRoot), /refusing to overwrite/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
