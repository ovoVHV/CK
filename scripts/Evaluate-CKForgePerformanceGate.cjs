#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const path = require('node:path');

const POLICY = Object.freeze({
  id: 'ck-forge-portable-edit-no-regression-v3',
  minTrials: 5,
  maxTrials: 25,
  minMedianSpeedupPct: 25,
  minAbsoluteMedianGainMs: 500,
  maxP95RegressionPct: 0,
  maxCoefficientOfVariationPct: 20,
  requiredSequence: 'portable-edit',
  requiredStages: Object.freeze(['simple', 'complex', 'medium', 'simple-return']),
});
const GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID = 'generic-required-role-content-exact-v1';
const COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID = 'compile-only-shared-primary-application-exact-v1';
const PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID = 'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2';
const ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION = 1;
const ESP_APPLICATION_BIN_RECIPE_PROOF_KIND = 'esp32-platform-recipe-elf-sha256-offset-v1';
const ESP_APPLICATION_BIN_RECIPE_PROPERTY = 'recipe.objcopy.bin.pattern_args';
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION = 1;
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND = 'esp-application-bin-elf-sha256-offset-v1';
const ESP_APPLICATION_BIN_ELF_SHA256_OFFSET = 0xb0;
const ESP_APPLICATION_BIN_ELF_SHA256_LENGTH = 32;
const ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH = 33;
const ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT = '--elf-sha256-offset 0xb0';
const ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION = 1;
const ESP_FLASH_ARGS_WITNESS_KIND = 'esp-flash-args-normalized-v1';
const ESP_FLASH_ARGS_NORMALIZED_REFERENCE_REASON = 'flash_args normalized offset/role/payload references';
const PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES = Object.freeze([
  'application-elf',
  'merged-firmware-bin',
  // CK creates this provenance document while the stock Arduino CLI does
  // not. It is not a flash payload, so it is excluded from compile-only
  // equivalence under the one-sided constraint below.
  'upload-manifest',
]);
const PORTABLE_FAST_COMPILE_ONLY_CK_ONLY_ARTIFACT_ROLES = new Set([
  'upload-manifest',
]);
const QUALIFICATION_TOKEN_CANDIDATE_ROUTE = 'qualification-token-probe';
const QUALIFICATION_REPRODUCIBILITY_POLICY_ID = 'source-date-epoch-utc-v1';
const QUALIFICATION_SOURCE_DATE_EPOCH = 1704067200;
const QUALIFICATION_TIME_ZONE = 'UTC';
const PORTABLE_FAST_NATIVE_CLI_BUILD_MODES = Object.freeze([
  'full-build',
  'arduino-cli-core-seeded',
  'arduino-cli-incremental',
  'arduino-cli-incremental-fallback',
  'arduino-cli-full-fallback',
]);
const PORTABLE_FAST_RECIPE_INTENT = 'native-recipe-cache';

const NATIVE_RELINK_POLICY = Object.freeze({
  id: 'ck-forge-portable-edit-performance-v3',
  minTrials: 5,
  maxTrials: 25,
  minMedianSpeedupPct: 25,
  minAbsoluteMedianGainMs: 500,
  maxP95RegressionPct: 0,
  requiredSequence: 'portable-edit',
  requiredBuildMode: 'native-relink-compile-only',
  editStages: Object.freeze(['complex', 'medium', 'simple-return']),
});
const NATIVE_RELINK_LANE_IDLE_POLICY = Object.freeze({
  policyId: 'arduino-cli-lane-idle-window-v1',
  idleWindowMs: 500,
  timeoutMs: 60_000,
  pollIntervalMs: 100,
  outsideMeasuredCompileWallTime: true,
});

// The engine ID is part of the immutable qualification binding. Phase-1/v1
// evidence must be re-measured and can never authorize the AVR v2 capability.
const NATIVE_RELINK_CONTRACT_ID = 'ck-native-relink-avr-release-compile-only-v2';
const NATIVE_RELINK_PROFILE = 'native-relink-compile-only';
const NATIVE_RELINK_ADAPTER_ID = 'arduino-avr-native-relink-v1';
const NATIVE_RELINK_ARTIFACT_POLICY_ID = 'arduino-avr-hex-required-eeprom-optional-exact-v2';
const AVR_NATIVE_RELINK_ADAPTER = Object.freeze({
  id: NATIVE_RELINK_ADAPTER_ID,
  fqbnMatch: Object.freeze({ kind: 'prefix', value: 'arduino:avr:' }),
  coreArchitecture: 'avr',
  engineContractId: NATIVE_RELINK_CONTRACT_ID,
  artifactEquivalencePolicyId: NATIVE_RELINK_ARTIFACT_POLICY_ID,
  requiredArtifactRoles: Object.freeze(['avr-application-hex']),
  witnessArtifactRoles: Object.freeze([]),
  optionalArtifactRoles: Object.freeze(['avr-eeprom']),
  forbiddenAllStageArtifactRoles: Object.freeze([]),
  forbiddenCkEditArtifactRoles: Object.freeze(['avr-with-bootloader']),
});
const SAMD_MKRZERO_NATIVE_RELINK_ADAPTER = Object.freeze({
  id: 'arduino-samd-mkrzero-native-relink-v1',
  fqbnMatch: Object.freeze({ kind: 'exact-base', value: 'arduino:samd:mkrzero' }),
  coreArchitecture: 'samd',
  engineContractId: 'ck-native-relink-samd-release-compile-only-phase1-v1',
  artifactEquivalencePolicyId: 'arduino-samd-app-bin-hex-exact-ck-edit-no-bootloader-v2',
  requiredArtifactRoles: Object.freeze(['samd-application-bin', 'samd-application-hex']),
  witnessArtifactRoles: Object.freeze([]),
  optionalArtifactRoles: Object.freeze([]),
  forbiddenAllStageArtifactRoles: Object.freeze([
    'samd-uf2',
    'flash-arguments', 'upload-manifest', 'avr-eeprom', 'auxiliary-firmware',
  ]),
  forbiddenCkEditArtifactRoles: Object.freeze([
    'samd-with-bootloader-bin', 'samd-with-bootloader-hex',
  ]),
});
// Every ESP32-family adapter shares the phase-1 engine contract and artifact
// policy: bootloader/partitions stay byte-exact while the application image
// (which embeds the lane-local ELF SHA-256 digest, making cross-lane byte
// equality impossible) rides the existing validated ESP payload witness.
function esp32NativeRelinkAdapter(id, fqbnBase) {
  return Object.freeze({
    id,
    fqbnMatch: Object.freeze({ kind: 'exact-base', value: fqbnBase }),
    coreArchitecture: 'esp32',
    engineContractId: 'ck-native-relink-esp32-release-compile-only-phase1-v1',
    artifactEquivalencePolicyId: 'esp32-app-bin-witness-bootloader-partitions-exact-v1',
    requiredArtifactRoles: Object.freeze(['bootloader-bin', 'partitions-bin']),
    witnessArtifactRoles: Object.freeze(['application-bin']),
    optionalArtifactRoles: Object.freeze([]),
    forbiddenAllStageArtifactRoles: Object.freeze([]),
    forbiddenCkEditArtifactRoles: Object.freeze([]),
  });
}
const ESP32C6_NATIVE_RELINK_ADAPTER = esp32NativeRelinkAdapter(
  'esp32-esp32c6-native-relink-v1', 'esp32:esp32:esp32c6',
);
const ESP32_FAMILY_NATIVE_RELINK_ADAPTERS = Object.freeze([
  ESP32C6_NATIVE_RELINK_ADAPTER,
  esp32NativeRelinkAdapter('esp32-esp32-native-relink-v1', 'esp32:esp32:esp32'),
  esp32NativeRelinkAdapter('esp32-esp32s2-native-relink-v1', 'esp32:esp32:esp32s2'),
  esp32NativeRelinkAdapter('esp32-esp32s3-native-relink-v1', 'esp32:esp32:esp32s3'),
  esp32NativeRelinkAdapter('esp32-esp32c3-native-relink-v1', 'esp32:esp32:esp32c3'),
  esp32NativeRelinkAdapter('esp32-esp32c5-native-relink-v1', 'esp32:esp32:esp32c5'),
  esp32NativeRelinkAdapter('esp32-esp32h2-native-relink-v1', 'esp32:esp32:esp32h2'),
  esp32NativeRelinkAdapter('esp32-esp32p4-native-relink-v1', 'esp32:esp32:esp32p4'),
]);
// Registry entries are board-specific authorization contracts. The SAMD and
// ESP32 rows are exact-base only and never grant architecture-wide access.
const NATIVE_RELINK_ADAPTERS = Object.freeze([
  AVR_NATIVE_RELINK_ADAPTER,
  SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
  ...ESP32_FAMILY_NATIVE_RELINK_ADAPTERS,
]);

function hasReproducibleQualificationEnvironment(value) {
  return value != null
    && typeof value === 'object'
    && !Array.isArray(value)
    && Object.keys(value).length === 4
    && value.policyId === QUALIFICATION_REPRODUCIBILITY_POLICY_ID
    && value.sourceDateEpoch === QUALIFICATION_SOURCE_DATE_EPOCH
    && value.timeZone === QUALIFICATION_TIME_ZONE
    && value.passed === true;
}

function nativeRelinkAdapterFor(identity) {
  const fqbn = canonicalCompleteFqbn(identity?.fqbn);
  if (!fqbn) return null;
  const coreArchitecture = String(identity?.coreArchitecture || '').trim().toLowerCase();
  const fqbnMatches = (candidate) => {
    if (candidate.fqbnMatch.kind === 'prefix') return fqbn.startsWith(candidate.fqbnMatch.value);
    if (candidate.fqbnMatch.kind === 'exact-base') {
      return fqbn === candidate.fqbnMatch.value
        || fqbn.startsWith(`${candidate.fqbnMatch.value}:`);
    }
    return false;
  };
  return NATIVE_RELINK_ADAPTERS.find((candidate) => (
    fqbnMatches(candidate)
      && coreArchitecture === candidate.coreArchitecture
  )) || null;
}
const NATIVE_RELINK_RUN_SCHEMA_ID = 'ck.forge.native-ab-run';
const NATIVE_RELINK_REPORT_SCHEMA_ID = 'ck.forge.native-relink-local-qualification-report';
const NATIVE_RELINK_BINDING_SCHEMA_VERSION = 3;
const LOCAL_CERTIFICATE_SCHEMA_ID = 'ck.forge.local-performance-certificate';
const PORTABLE_EDIT_STAGES = Object.freeze([
  Object.freeze({ id: 'simple', sourceSha256: '9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5' }),
  Object.freeze({ id: 'complex', sourceSha256: 'ea468a750d243cc9a5a801d7bcd66a87e8daa2fdb535a783896fef99b0a0266e' }),
  Object.freeze({ id: 'medium', sourceSha256: '1e41189bc6e324ef3e72a08adfceef99ed1a1c8153a6d0a5c0f98cb874b52d99' }),
  Object.freeze({ id: 'simple-return', sourceSha256: '9957ed4144a4dcb3ea6918ae021976812dda56d4da3815ef92ca29682e0fa0b5' }),
]);

const IDENTITY_FIELDS = Object.freeze([
  'fqbn',
  'corePackage',
  'coreArchitecture',
  'coreVersion',
  'toolchainKey',
  'toolchainContentSha256',
  'sketchSha256',
  'cliExecutableSha256',
  'cliConfigSha256',
  'cliVersion',
  'hostIdentitySha256',
  'productionExecutableSha256',
]);

function usage() {
  return `CK Forge performance A/B no-regression gate

Usage:
  node scripts/Evaluate-CKForgePerformanceGate.cjs --plan --input <candidate.json>
  node scripts/Evaluate-CKForgePerformanceGate.cjs --evaluate --input <candidate.json> --output <new.json>
  node scripts/Evaluate-CKForgePerformanceGate.cjs --certify-native-relink --input <native-ab-run.json> --qualification-root <state/qualifications>

The policy is deliberately not configurable from the command line. A target is
certified Fast only when CK and native Arduino CLI use the same host, production
EXE, CLI, Core/tool content, toolchain, complete FQBN and the fixed portable-edit
sequence, and CK wins simple, complex, medium and simple-return medians by at
least ${POLICY.minMedianSpeedupPct}% without a p95 regression.
Every certificate authorizes exactly one operation/profile pair; compile
QuickFast evidence never authorizes upload-ready QuickFast or SharedFast.

Exit codes:
  0  qualified (or --plan succeeded)
  2  valid evidence, but Fast qualification was refused
  1  invalid arguments or invalid evidence
`;
}

function parseArgs(argv) {
  const options = {
    action: null, inputPath: null, outputPath: null, qualificationRoot: null, help: false,
  };
  const setAction = (action) => {
    if (options.action && options.action !== action) {
      throw new Error('choose exactly one of --plan or --evaluate');
    }
    options.action = action;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--evaluate') setAction('evaluate');
    else if (argument === '--certify-native-relink') setAction('certify-native-relink');
    else if (argument === '--input') {
      const value = argv[++index];
      if (!value) throw new Error('--input requires a JSON path');
      options.inputPath = path.resolve(process.cwd(), value);
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value) throw new Error('--output requires a new JSON path');
      options.outputPath = path.resolve(process.cwd(), value);
    } else if (argument === '--qualification-root') {
      const value = argv[++index];
      if (!value) throw new Error('--qualification-root requires a directory path');
      options.qualificationRoot = path.resolve(process.cwd(), value);
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --evaluate');
  if (!options.inputPath) throw new Error('--input is required');
  if (path.extname(options.inputPath).toLowerCase() !== '.json') {
    throw new Error('--input must use the .json extension');
  }
  if (options.action === 'plan' && options.outputPath) {
    throw new Error('--plan does not write output and cannot use --output');
  }
  if (options.action === 'evaluate' && !options.outputPath) {
    throw new Error('--evaluate requires --output');
  }
  if (options.action === 'certify-native-relink' && !options.qualificationRoot) {
    throw new Error('--certify-native-relink requires --qualification-root');
  }
  if (options.action !== 'certify-native-relink' && options.qualificationRoot) {
    throw new Error('--qualification-root is valid only with --certify-native-relink');
  }
  if (options.action === 'certify-native-relink' && options.outputPath) {
    throw new Error('--certify-native-relink writes a certificate directory and cannot use --output');
  }
  if (options.outputPath) {
    if (path.extname(options.outputPath).toLowerCase() !== '.json') {
      throw new Error('--output must use the .json extension');
    }
    if (normalizedPath(options.outputPath) === normalizedPath(options.inputPath)) {
      throw new Error('--output must not overwrite the input');
    }
  }
  return options;
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function sha256(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function isSha256(value) {
  return typeof value === 'string' && /^[0-9a-f]{64}$/u.test(value);
}

function isSafeCoreIdentityComponent(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}

function validEspApplicationPayloadRecipeProof(proof, identity = null) {
  if (!proof || typeof proof !== 'object' || Array.isArray(proof)
      || canonicalJson(Object.keys(proof).sort()) !== canonicalJson([
        'coreArchitecture',
        'corePackage',
        'coreVersion',
        'elfSha256Offset',
        'elfSha256OffsetArgument',
        'kind',
        'recipeProperty',
        'recipeSource',
        'recipeSourceSha256',
        'recipeValueSha256',
        'schemaVersion',
      ])
      || proof.schemaVersion !== ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION
      || proof.kind !== ESP_APPLICATION_BIN_RECIPE_PROOF_KIND
      || proof.recipeProperty !== ESP_APPLICATION_BIN_RECIPE_PROPERTY
      || !['platform.txt', 'platform.local.txt'].includes(proof.recipeSource)
      || !isSafeCoreIdentityComponent(proof.corePackage)
      || String(proof.coreArchitecture || '').toLowerCase() !== 'esp32'
      || !isSafeCoreIdentityComponent(proof.coreVersion)
      || !isSha256(proof.recipeSourceSha256)
      || !isSha256(proof.recipeValueSha256)
      || proof.elfSha256OffsetArgument !== ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT
      || proof.elfSha256Offset !== ESP_APPLICATION_BIN_ELF_SHA256_OFFSET) return false;
  return identity == null || (
    proof.corePackage === identity.corePackage
      && proof.coreArchitecture === identity.coreArchitecture
      && proof.coreVersion === identity.coreVersion
  );
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => (
    `${JSON.stringify(key)}:${canonicalJson(value[key])}`
  )).join(',')}}`;
}

function readInput(inputPath) {
  const metadata = fs.statSync(inputPath);
  if (!metadata.isFile() || metadata.size <= 0 || metadata.size > 4 * 1024 * 1024) {
    throw new Error('candidate evidence must be a non-empty JSON file no larger than 4 MiB');
  }
  const bytes = fs.readFileSync(inputPath);
  return { candidate: JSON.parse(bytes.toString('utf8')), inputSha256: sha256(bytes) };
}

function assertString(value, label) {
  if (typeof value !== 'string' || value.trim() === '') throw new Error(`${label} is required`);
}

function validateIdentity(identity, label) {
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error(`${label} identity is required`);
  }
  for (const field of IDENTITY_FIELDS) assertString(identity[field], `${label}.identity.${field}`);
  for (const field of [
    'toolchainContentSha256', 'sketchSha256', 'cliExecutableSha256', 'cliConfigSha256',
    'hostIdentitySha256', 'productionExecutableSha256',
  ]) {
    if (!isSha256(identity[field])) throw new Error(`${label}.identity.${field} must be lowercase SHA-256`);
  }
  if (!String(identity.toolchainKey).endsWith(`|${identity.toolchainContentSha256}`)) {
    throw new Error(`${label}.identity.toolchainContentSha256 does not match toolchainKey`);
  }
  const fqbnParts = identity.fqbn.split(':');
  if (fqbnParts.length < 3 || fqbnParts.length > 4) throw new Error(`${label}.identity.fqbn is invalid`);
}

function validateRun(run, label, expectedStage, candidate, ckLane) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error(`${label} is required`);
  if (run.success !== true) throw new Error(`${label}.success must be true`);
  if (!Number.isFinite(run.wallMs) || run.wallMs <= 0) throw new Error(`${label}.wallMs must be positive`);
  if (run.artifactsVerified !== true) throw new Error(`${label}.artifactsVerified must be true`);
  if (run.resourceGatePassed !== true) throw new Error(`${label}.resourceGatePassed must be true`);
  if (run.exactUsed !== false) throw new Error(`${label}.exactUsed must be false`);
  for (const field of ['evidenceSha256', 'artifactSetSha256']) {
    if (!isSha256(run[field])) throw new Error(`${label}.${field} must be lowercase SHA-256`);
  }
  if (!Array.isArray(run.artifacts) || run.artifacts.length === 0 || run.artifacts.length > 64) {
    throw new Error(`${label}.artifacts must contain 1..64 records`);
  }
  run.artifacts.forEach((artifact, index) => validateNativeArtifact(
    artifact, `${label}.artifacts[${index}]`,
  ));
  if (nativeArtifactSetSha256(run.artifacts) !== run.artifactSetSha256) {
    throw new Error(`${label}.artifactSetSha256 does not match projected artifacts`);
  }
  if (run.codeSha256 !== expectedStage.sourceSha256) {
    throw new Error(`${label}.codeSha256 does not match stage '${expectedStage.id}'`);
  }
  if (!isSha256(run.buildPathIdentitySha256)) {
    throw new Error(`${label}.buildPathIdentitySha256 must be lowercase SHA-256`);
  }
  if (run.resources?.evidenceComplete !== true
      || !Number.isSafeInteger(run.resources.flashUsedBytes) || run.resources.flashUsedBytes < 0
      || !Number.isSafeInteger(run.resources.ramUsedBytes) || run.resources.ramUsedBytes < 0
      || !Number.isSafeInteger(run.resources.warningCount) || run.resources.warningCount < 0) {
    throw new Error(`${label}.resources must be complete non-negative integers`);
  }
  if (!ckLane) {
    if (run.profile !== candidate.candidateProfile
        || run.compilerPropertyDeltaSha256 !== candidate.nativeBaselineCompilerPropertiesSha256) {
      throw new Error(`${label} native compiler baseline binding is missing or mismatched`);
    }
    return;
  }
  if (run.profile !== candidate.candidateProfile
      || run.qualificationOperation !== candidate.operation
      || run.qualificationProfile !== candidate.candidateProfile
      || run.ckContractId !== candidate.ckContractId) {
    throw new Error(`${label} Fast route binding is missing or mismatched`);
  }
  const portableFast = candidate.candidateProfile === 'portable-fast';
  const expectedBuildModes = portableFast
    ? PORTABLE_FAST_NATIVE_CLI_BUILD_MODES
    : expectedStage.id === 'simple'
      ? ['full-build', 'fast-relink']
      : ['fast-relink'];
  if (run.candidateRoute !== QUALIFICATION_TOKEN_CANDIDATE_ROUTE
      || !expectedBuildModes.includes(run.buildMode)
      || run.fallbackUsed !== false) {
    throw new Error(`${label} Fast qualification execution evidence is missing or mismatched`);
  }
  const recipe = run.recipeCapability;
  if (recipe?.schemaVersion !== 2
      || !isSha256(recipe.baselineSha256)
      || recipe.observationOnly !== true
      || recipe.capabilityGatePassed !== true
      || !Array.isArray(recipe.requiredCapabilities)
      || recipe.requiredCapabilities.length === 0
      || !recipe.requiredCapabilities.every((value) => typeof value === 'string' && value.length > 0)
      || !Array.isArray(recipe.missingCapabilities)
      || recipe.missingCapabilities.length !== 0) {
    throw new Error(`${label} recipe capability gate is incomplete`);
  }
  if (portableFast && run.ccacheEnabled !== true) {
    throw new Error(`${label} PortableFast ccache evidence is missing or disabled`);
  }
  if (portableFast && recipe.intent !== PORTABLE_FAST_RECIPE_INTENT) {
    throw new Error(`${label} PortableFast recipe intent must be ${PORTABLE_FAST_RECIPE_INTENT}`);
  }
}

function validateLane(lane, label, candidate, ckLane) {
  if (!lane || typeof lane !== 'object' || Array.isArray(lane)) throw new Error(`${label} lane is required`);
  validateIdentity(lane.identity, label);
  if (!Array.isArray(lane.trials)
      || lane.trials.length < POLICY.minTrials
      || lane.trials.length > POLICY.maxTrials) {
    throw new Error(`${label}.trials must contain ${POLICY.minTrials}..${POLICY.maxTrials} trials`);
  }
  const ids = new Set();
  for (const [index, trial] of lane.trials.entries()) {
    assertString(trial?.id, `${label}.trials[${index}].id`);
    if (ids.has(trial.id)) throw new Error(`${label}.trials contains duplicate id '${trial.id}'`);
    ids.add(trial.id);
    const paths = [];
    for (const stage of PORTABLE_EDIT_STAGES) {
      validateRun(
        trial[stage.id],
        `${label}.trials[${index}].${stage.id}`,
        stage,
        candidate,
        ckLane,
      );
      paths.push(trial[stage.id].buildPathIdentitySha256);
    }
    if (new Set(paths).size !== 1) {
      throw new Error(`${label}.trials[${index}] must keep one build path across portable edits`);
    }
  }
  const trialBuildPaths = lane.trials.map((trial) => trial.simple.buildPathIdentitySha256);
  if (new Set(trialBuildPaths).size !== trialBuildPaths.length) {
    throw new Error(`${label}.trials must use fresh independent build paths`);
  }
}

function validateCandidate(candidate) {
  if (!candidate || typeof candidate !== 'object' || Array.isArray(candidate)) {
    throw new Error('candidate evidence must be a JSON object');
  }
  if (candidate.schemaId !== 'ck.forge.performance-ab-candidate' || candidate.schemaVersion !== 4) {
    throw new Error('unsupported candidate schema identity');
  }
  if (!['compile', 'upload-ready'].includes(candidate.operation)) {
    throw new Error('operation must be compile or upload-ready');
  }
  if (!['portable-fast', 'quick-fast', 'shared-fast'].includes(candidate.candidateProfile)) {
    throw new Error('candidateProfile must be portable-fast, quick-fast, or shared-fast');
  }
  if (candidate.operation === 'compile'
      && !['portable-fast', 'quick-fast'].includes(candidate.candidateProfile)) {
    throw new Error('compile evidence may certify only portable-fast or quick-fast');
  }
  if (candidate.operation === 'upload-ready' && candidate.candidateProfile === 'portable-fast') {
    throw new Error('upload-ready evidence may not certify portable-fast');
  }
  if (!isSha256(candidate.nativeBaselineCompilerPropertiesSha256)) {
    throw new Error('nativeBaselineCompilerPropertiesSha256 must be lowercase SHA-256');
  }
  const controls = candidate.controls;
  if (!controls || typeof controls !== 'object' || Array.isArray(controls)) {
    throw new Error('controls are required');
  }
  const requiredTrue = [
    'compileOnly',
    'sameMachine',
    'freshBuildPathsVerified',
    'sameBuildPathWithinLaneVerified',
    'stageSourceHashesVerified',
    'exactReuseDenied',
    'routeGatePassed',
    'recipeCapabilityGatePassed',
    'globalCachesSharedEqually',
    'noConcurrentCompiles',
    'laneBoundaryIdleGatePassed',
    'compilePropertyDeltaDeclared',
    'dependencyClosureGatePassed',
    'artifactGatePassed',
    'resourceGatePassed',
  ];
  for (const field of requiredTrue) {
    if (controls[field] !== true) throw new Error(`controls.${field} must be true`);
  }
  for (const field of ['uploadPerformed', 'physicalFlashWritten', 'serialPortAccessed']) {
    if (controls[field] !== false) throw new Error(`controls.${field} must be false`);
  }
  if (!hasReproducibleQualificationEnvironment(controls.reproducibleBuildEnvironment)) {
    throw new Error('controls.reproducibleBuildEnvironment must bind the fixed qualification environment');
  }
  if (!Array.isArray(candidate.captureOrder)
      || candidate.captureOrder.length !== candidate?.lanes?.ck?.trials?.length) {
    throw new Error('captureOrder must have one entry per paired trial');
  }
  if (!candidate.captureOrder.every((value) => ['ck-native', 'native-ck'].includes(value))) {
    throw new Error('captureOrder entries must be ck-native or native-ck');
  }
  if (!candidate.captureOrder.includes('ck-native') || !candidate.captureOrder.includes('native-ck')) {
    throw new Error('captureOrder must alternate lane priority across the trial set');
  }
  if (candidate.measurementSequence !== POLICY.requiredSequence
      || !Array.isArray(candidate.stages)
      || canonicalJson(candidate.stages) !== canonicalJson(PORTABLE_EDIT_STAGES)
      || !isSha256(candidate.sequenceSha256)
      || candidate.sequenceSha256 !== digestObject(candidate.stages)) {
    throw new Error('candidate must bind the fixed portable-edit source sequence');
  }
  assertString(candidate.ckContractId, 'ckContractId');
  assertString(candidate.compilePropertyDelta, 'compilePropertyDelta');
  validateLane(candidate?.lanes?.ck, 'ck', candidate, true);
  validateLane(candidate?.lanes?.native, 'native', candidate, false);
  const ck = candidate.lanes.ck;
  const native = candidate.lanes.native;
  if (ck.trials.length !== native.trials.length) throw new Error('CK and native trial counts differ');
  const ckIds = ck.trials.map((trial) => trial.id);
  const nativeIds = native.trials.map((trial) => trial.id);
  if (JSON.stringify(ckIds) !== JSON.stringify(nativeIds)) throw new Error('CK and native trial IDs differ');
  for (const field of IDENTITY_FIELDS) {
    if (ck.identity[field] !== native.identity[field]) {
      throw new Error(`CK/native identity mismatch: ${field}`);
    }
  }
  if (ck.identity.sketchSha256 !== PORTABLE_EDIT_STAGES[0].sourceSha256) {
    throw new Error('identity.sketchSha256 must bind the simple stage source');
  }
  const payloadRecipeProof = candidate.portableFastEspApplicationBinRecipeProof;
  if (payloadRecipeProof != null && candidate.candidateProfile !== 'portable-fast') {
    throw new Error('ESP application-image recipe proof is only permitted for PortableFast');
  }
  if (payloadRecipeProof != null && !validEspApplicationPayloadRecipeProof(payloadRecipeProof, ck.identity)) {
    throw new Error('PortableFast ESP application-image recipe proof is malformed or bound to another Core');
  }
  const expectedArtifactPolicyId = artifactEquivalencePolicyIdForCandidate(
    candidate.operation,
    candidate.candidateProfile,
    payloadRecipeProof,
    ck.identity,
  );
  if (candidate.artifactEquivalencePolicyId !== expectedArtifactPolicyId) {
    throw new Error(
      `artifactEquivalencePolicyId must be '${expectedArtifactPolicyId}' for `
      + `${candidate.operation}/${candidate.candidateProfile}`,
    );
  }
  const hasPayloadWitness = [ck, native].some((lane) => lane.trials.some((trial) => (
    PORTABLE_EDIT_STAGES.some((stage) => trial[stage.id].artifacts.some(
      (artifact) => artifact.payloadEquivalenceWitness != null
        || artifact.flashArgumentsWitness != null,
    ))
  )));
  if (expectedArtifactPolicyId !== PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID
      && hasPayloadWitness) {
    throw new Error('ESP application-image payload witnesses require the resolved Core recipe exception policy');
  }
  for (const [trialIndex, ckTrial] of ck.trials.entries()) {
    for (const stage of PORTABLE_EDIT_STAGES) {
      const nativeRun = native.trials[trialIndex][stage.id];
      const ckRun = ckTrial[stage.id];
      if (ckRun.resources.flashUsedBytes !== nativeRun.resources.flashUsedBytes
          || ckRun.resources.ramUsedBytes !== nativeRun.resources.ramUsedBytes
          || ckRun.resources.warningCount !== nativeRun.resources.warningCount) {
        throw new Error(`CK/native resource mismatch: ${ckTrial.id}/${stage.id}`);
      }
      const artifactEquivalence = compareArtifactEquivalenceForCandidate(
        ckRun.artifacts, nativeRun.artifacts, candidate,
      );
      if (!artifactEquivalence.passed) {
        throw new Error(
          `CK/native artifact equivalence failed: ${ckTrial.id}/${stage.id}: ${artifactEquivalence.reason}`,
        );
      }
    }
  }
  return candidate;
}

function artifactEquivalencePolicyIdForCandidate(
  operation,
  candidateProfile,
  payloadRecipeProof = null,
  identity = null,
) {
  if (operation === 'compile' && candidateProfile === 'quick-fast') {
    return COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID;
  }
  if (operation === 'compile' && candidateProfile === 'portable-fast'
      && validEspApplicationPayloadRecipeProof(payloadRecipeProof, identity)) {
    return PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID;
  }
  if (operation === 'compile' && candidateProfile === 'portable-fast') {
    return GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
  }
  if (operation === 'upload-ready'
      && (candidateProfile === 'quick-fast' || candidateProfile === 'shared-fast')) {
    return GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
  }
  return null;
}

function canonicalCompleteFqbn(raw) {
  assertString(raw, 'identity.fqbn');
  const parts = raw.trim().split(':');
  if (parts.length < 3 || parts.length > 4) {
    throw new Error('identity.fqbn is invalid');
  }
  const base = parts.slice(0, 3).map((part) => part.trim());
  const validToken = (token) => token.length > 0 && !/[\s:,=]/u.test(token);
  const asciiLowercase = (token) => token.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const compareUtf8 = (left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  );
  if (!base.every(validToken)) throw new Error('identity.fqbn is invalid');
  if (parts.length === 3) return base.join(':');
  if (!parts[3].trim()) throw new Error('identity.fqbn option is invalid');
  const options = parts[3].split(',').map((entry) => {
    const separator = entry.indexOf('=');
    if (separator <= 0 || separator !== entry.lastIndexOf('=')) {
      throw new Error('identity.fqbn option is invalid');
    }
    return {
      key: entry.slice(0, separator).trim(),
      value: entry.slice(separator + 1).trim(),
    };
  });
  const seen = new Set();
  for (const option of options) {
    if (!validToken(option.key) || !validToken(option.value)) {
      throw new Error('identity.fqbn options are invalid');
    }
    option.normalizedKey = asciiLowercase(option.key);
    if (seen.has(option.normalizedKey)) throw new Error('identity.fqbn options are invalid');
    seen.add(option.normalizedKey);
  }
  options.sort((left, right) => compareUtf8(left.normalizedKey, right.normalizedKey)
    || compareUtf8(left.value, right.value));
  return `${base.join(':')}:${options.map(({ key, value }) => `${key}=${value}`).join(',')}`;
}

function digestObject(value) {
  return sha256(Buffer.from(canonicalJson(value), 'utf8'));
}

function validateNativeArtifact(artifact, label) {
  if (!artifact || typeof artifact !== 'object' || Array.isArray(artifact)) {
    throw new Error(`${label} must be an artifact object`);
  }
  assertString(artifact.name, `${label}.name`);
  assertString(artifact.role, `${label}.role`);
  if (!Number.isSafeInteger(artifact.bytes) || artifact.bytes <= 0) {
    throw new Error(`${label}.bytes must be positive`);
  }
  if (!isSha256(artifact.sha256)) throw new Error(`${label}.sha256 must be lowercase SHA-256`);
  if (typeof artifact.primaryApplication !== 'boolean') {
    throw new Error(`${label}.primaryApplication must be boolean`);
  }
  if (artifact.payloadEquivalenceWitness != null
      && !validEspApplicationBinPayloadEquivalenceWitness(
        artifact.payloadEquivalenceWitness,
        artifact.bytes,
      )) {
    throw new Error(`${label}.payloadEquivalenceWitness is malformed`);
  }
  if (artifact.flashArgumentsWitness != null
      && (artifact.role !== 'flash-arguments'
        || !validEspFlashArgumentsWitness(artifact.flashArgumentsWitness, artifact.bytes))) {
    throw new Error(`${label}.flashArgumentsWitness is malformed`);
  }
}

function nativeArtifactIntegrityProjection(artifact) {
  return {
    name: artifact.name,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    primaryApplication: artifact.primaryApplication,
    role: artifact.role,
  };
}

function nativeArtifactSetSha256(artifacts) {
  return digestObject(artifacts.map(nativeArtifactIntegrityProjection));
}

function compareGenericArtifactEquivalence(ckArtifacts, nativeArtifacts) {
  const invalid = (reason, details = {}) => ({
    policyId: GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
    requiredRoles: [],
    roles: {},
    comparable: false,
    passed: false,
    reason,
    ...details,
  });
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)
      || ckArtifacts.length === 0 || nativeArtifacts.length === 0) {
    return invalid('both lanes must expose non-empty artifact sets');
  }
  const roleMap = (artifacts) => artifacts.reduce((map, artifact) => {
    if (!map.has(artifact.role)) map.set(artifact.role, []);
    map.get(artifact.role).push(artifact);
    return map;
  }, new Map());
  const ckByRole = roleMap(ckArtifacts);
  const nativeByRole = roleMap(nativeArtifacts);
  const ckRoles = [...ckByRole.keys()].sort();
  const nativeRoles = [...nativeByRole.keys()].sort();
  if (canonicalJson(ckRoles) !== canonicalJson(nativeRoles)) {
    return invalid('artifact role sets differ across lanes', { ckRoles, nativeRoles });
  }
  const primaryRoles = (artifacts) => [...new Set(
    artifacts.filter((artifact) => artifact.primaryApplication).map((artifact) => artifact.role),
  )].sort();
  const ckPrimaryRoles = primaryRoles(ckArtifacts);
  const nativePrimaryRoles = primaryRoles(nativeArtifacts);
  if (ckPrimaryRoles.length === 0
      || canonicalJson(ckPrimaryRoles) !== canonicalJson(nativePrimaryRoles)) {
    return invalid('primary application roles are missing or differ across lanes', {
      ckPrimaryRoles,
      nativePrimaryRoles,
    });
  }
  const roles = {};
  for (const role of ckRoles) {
    const ck = ckByRole.get(role);
    const native = nativeByRole.get(role);
    const exactlyOnePerLane = ck.length === 1 && native.length === 1;
    const bytesMatch = exactlyOnePerLane && ck[0].bytes === native[0].bytes;
    const sha256Match = exactlyOnePerLane && ck[0].sha256 === native[0].sha256;
    const primaryApplicationMatch = exactlyOnePerLane
      && ck[0].primaryApplication === native[0].primaryApplication;
    roles[role] = {
      ckCount: ck.length,
      nativeCount: native.length,
      bytesMatch,
      sha256Match,
      primaryApplicationMatch,
      passed: exactlyOnePerLane && bytesMatch && sha256Match && primaryApplicationMatch,
    };
  }
  const comparable = ckRoles.every((role) => (
    roles[role].ckCount === 1 && roles[role].nativeCount === 1
  ));
  const passed = comparable && ckRoles.every((role) => roles[role].passed);
  return {
    policyId: GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
    requiredRoles: ckRoles,
    primaryRoles: ckPrimaryRoles,
    roles,
    comparable,
    passed,
    reason: passed ? null : comparable
      ? 'one or more required artifact contents differ'
      : 'one or more artifact roles are ambiguous',
  };
}

function validEspApplicationBinPayloadEquivalenceWitness(witness, byteLength) {
  const mutableEnd = ESP_APPLICATION_BIN_ELF_SHA256_OFFSET + ESP_APPLICATION_BIN_ELF_SHA256_LENGTH;
  const minimumLength = mutableEnd + ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH;
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)
      || witness.schemaVersion !== ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION
      || witness.kind !== ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND
      || witness.byteLength !== byteLength
      || !Number.isSafeInteger(byteLength) || byteLength < minimumLength
      || canonicalJson(Object.keys(witness).sort()) !== canonicalJson([
        'byteLength', 'footer', 'immutableSegments', 'kind', 'mutableRange', 'recipe', 'schemaVersion',
      ])) return false;
  const recipe = witness.recipe;
  if (!recipe || typeof recipe !== 'object' || Array.isArray(recipe)
      || canonicalJson(Object.keys(recipe).sort()) !== canonicalJson([
        'elfSha256Offset', 'elfSha256OffsetArgument',
      ])
      || recipe.elfSha256Offset !== ESP_APPLICATION_BIN_ELF_SHA256_OFFSET
      || recipe.elfSha256OffsetArgument !== ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT) return false;
  const mutableRange = witness.mutableRange;
  if (!mutableRange || typeof mutableRange !== 'object' || Array.isArray(mutableRange)
      || canonicalJson(Object.keys(mutableRange).sort()) !== canonicalJson(['length', 'offset'])
      || mutableRange.offset !== ESP_APPLICATION_BIN_ELF_SHA256_OFFSET
      || mutableRange.length !== ESP_APPLICATION_BIN_ELF_SHA256_LENGTH) return false;
  const footerOffset = byteLength - ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH;
  const footer = witness.footer;
  if (!footer || typeof footer !== 'object' || Array.isArray(footer)
      || canonicalJson(Object.keys(footer).sort()) !== canonicalJson([
        'checksum', 'checksumOffset', 'checksumValid', 'length', 'offset', 'validationHash',
        'validationHashValid',
      ])
      || footer.offset !== footerOffset
      || footer.length !== ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH
      || footer.checksumOffset !== footerOffset
      || !Number.isInteger(footer.checksum) || footer.checksum < 0 || footer.checksum > 255
      || !isSha256(footer.validationHash)
      || footer.checksumValid !== true || footer.validationHashValid !== true) return false;
  const expectedSegments = [
    [0, ESP_APPLICATION_BIN_ELF_SHA256_OFFSET],
    [mutableEnd, footerOffset - mutableEnd],
  ];
  if (!Array.isArray(witness.immutableSegments)
      || witness.immutableSegments.length !== expectedSegments.length) return false;
  return witness.immutableSegments.every((segment, index) => (
    segment && typeof segment === 'object' && !Array.isArray(segment)
      && canonicalJson(Object.keys(segment).sort()) === canonicalJson(['length', 'offset', 'sha256'])
      && segment.offset === expectedSegments[index][0]
      && segment.length === expectedSegments[index][1]
      && isSha256(segment.sha256)
  ));
}

function espApplicationBinFixedWitnessProjection(witness) {
  return {
    schemaVersion: witness.schemaVersion,
    kind: witness.kind,
    recipe: witness.recipe,
    byteLength: witness.byteLength,
    mutableRange: witness.mutableRange,
    immutableSegments: witness.immutableSegments.map(({ offset, length }) => ({ offset, length })),
    footer: {
      offset: witness.footer.offset,
      length: witness.footer.length,
      checksumOffset: witness.footer.checksumOffset,
      checksumValid: witness.footer.checksumValid,
      validationHashValid: witness.footer.validationHashValid,
    },
  };
}

// Both lanes must carry a valid ESP payload witness whose fixed layouts agree
// and whose immutable segments hash byte-equal; only the embedded ELF SHA-256
// window and the validated image footer may differ across lanes.
function espApplicationBinWitnessesEquivalent(ck, native) {
  if (!validEspApplicationBinPayloadEquivalenceWitness(ck.payloadEquivalenceWitness, ck.bytes)
      || !validEspApplicationBinPayloadEquivalenceWitness(
        native.payloadEquivalenceWitness,
        native.bytes,
      )) {
    return false;
  }
  const ckWitness = ck.payloadEquivalenceWitness;
  const nativeWitness = native.payloadEquivalenceWitness;
  if (canonicalJson(espApplicationBinFixedWitnessProjection(ckWitness))
      !== canonicalJson(espApplicationBinFixedWitnessProjection(nativeWitness))) {
    return false;
  }
  return ckWitness.immutableSegments.every((segment, index) => (
    segment.sha256 === nativeWitness.immutableSegments[index].sha256
  ));
}

function validEspFlashArgumentsWitness(witness, byteLength) {
  if (!witness || typeof witness !== 'object' || Array.isArray(witness)
      || witness.schemaVersion !== ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION
      || witness.kind !== ESP_FLASH_ARGS_WITNESS_KIND
      || witness.byteLength !== byteLength
      || !Number.isSafeInteger(byteLength) || byteLength <= 0
      || canonicalJson(Object.keys(witness).sort()) !== canonicalJson([
        'byteLength', 'kind', 'optionLines', 'schemaVersion', 'segments',
      ])) return false;
  if (!Array.isArray(witness.optionLines)
      || !witness.optionLines.every((line) => typeof line === 'string' && line.length > 0)) {
    return false;
  }
  if (!Array.isArray(witness.segments) || witness.segments.length === 0) return false;
  const offsets = new Set();
  return witness.segments.every((segment) => {
    if (!segment || typeof segment !== 'object' || Array.isArray(segment)
        || !Number.isSafeInteger(segment.offset) || segment.offset < 0
        || offsets.has(segment.offset)
        || typeof segment.role !== 'string' || segment.role.length === 0
        || typeof segment.reference !== 'string' || segment.reference.length === 0
        || segment.reference !== path.basename(segment.reference)) return false;
    if (segment.resolved === true) {
      if (canonicalJson(Object.keys(segment).sort()) !== canonicalJson([
        'bytes', 'offset', 'reference', 'resolved', 'role', 'sha256',
      ])
          || !Number.isSafeInteger(segment.bytes) || segment.bytes <= 0
          || !isSha256(segment.sha256)) return false;
    } else if (segment.resolved === false) {
      if (canonicalJson(Object.keys(segment).sort()) !== canonicalJson([
        'offset', 'reference', 'resolved', 'role',
      ])) return false;
    } else {
      return false;
    }
    offsets.add(segment.offset);
    return true;
  });
}

function portableFastControlledArtifactSet(artifacts) {
  const included = [];
  const excluded = new Map();
  for (const artifact of artifacts) {
    if (PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES.includes(artifact?.role)) {
      if (!excluded.has(artifact.role)) excluded.set(artifact.role, []);
      excluded.get(artifact.role).push(artifact);
    } else {
      included.push(artifact);
    }
  }
  return { included, excluded };
}

function comparePortableFastEspApplicationBinEquivalence(ckArtifacts, nativeArtifacts) {
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)) {
    return {
      policyId: PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
      requiredRoles: [],
      roles: {},
      comparable: false,
      passed: false,
      exceptionUsed: false,
      exceptionReason: 'both lanes must expose artifact arrays',
      reason: 'both lanes must expose artifact arrays',
    };
  }
  const ckControlled = portableFastControlledArtifactSet(ckArtifacts);
  const nativeControlled = portableFastControlledArtifactSet(nativeArtifacts);
  const excludedRoles = PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES.filter((role) => (
    (ckControlled.excluded.get(role) || []).length > 0
      || (nativeControlled.excluded.get(role) || []).length > 0
  ));
  for (const role of PORTABLE_FAST_COMPILE_ONLY_EXCLUDED_ARTIFACT_ROLES) {
    const ckCount = (ckControlled.excluded.get(role) || []).length;
    const nativeCount = (nativeControlled.excluded.get(role) || []).length;
    const isCkOnlyMetadata = PORTABLE_FAST_COMPILE_ONLY_CK_ONLY_ARTIFACT_ROLES.has(role);
    const validCount = isCkOnlyMetadata
      ? ckCount <= 1 && nativeCount === 0
      : ckCount === nativeCount && ckCount <= 1;
    if (!validCount) {
      return {
        policyId: PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
        requiredRoles: [],
        roles: {},
        comparable: false,
        passed: false,
        exceptionUsed: false,
        exceptionReason: 'controlled compile-only exclusions are missing or ambiguous',
        excludedRoles,
        reason: 'controlled compile-only exclusions are missing or ambiguous',
      };
    }
  }
  const exact = compareGenericArtifactEquivalence(
    ckControlled.included,
    nativeControlled.included,
  );
  if (exact.passed) {
    return {
      ...exact,
      policyId: PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
      exceptionUsed: false,
      exceptionReason: null,
      excludedRoles,
    };
  }
  const invalid = (reason, details = {}) => ({
    policyId: PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
    requiredRoles: exact.requiredRoles || [],
    primaryRoles: exact.primaryRoles || [],
    roles: exact.roles || {},
    comparable: false,
    passed: false,
    exceptionUsed: false,
    exceptionReason: reason,
    excludedRoles,
    reason,
    ...details,
  });
  if (!exact.comparable) return invalid(exact.reason || 'artifact roles are not exactly comparable');
  const mismatchedRoles = Object.entries(exact.roles)
    .filter(([, comparison]) => comparison.passed !== true)
    .map(([role]) => role);
  const permittedMismatchRoles = ['application-bin', 'flash-arguments'];
  if (mismatchedRoles.length === 0
      || mismatchedRoles.some((role) => !permittedMismatchRoles.includes(role))) {
    return invalid(
      'only application-bin and flash-arguments content mismatches may use the PortableFast exception',
      { mismatchedRoles },
    );
  }
  const ckApplication = ckControlled.included.filter((artifact) => artifact.role === 'application-bin');
  const nativeApplication = nativeControlled.included.filter((artifact) => artifact.role === 'application-bin');
  if (ckApplication.length !== 1 || nativeApplication.length !== 1) {
    return invalid('application-bin must be unique in both lanes');
  }
  const [ck] = ckApplication;
  const [native] = nativeApplication;
  const applicationBinMismatched = mismatchedRoles.includes('application-bin');
  const exceptionReasons = [];
  if (applicationBinMismatched) {
    if (ck.bytes !== native.bytes || ck.primaryApplication !== true || native.primaryApplication !== true
        || ck.sha256 === native.sha256) {
      return invalid('application-bin exception requires one same-length primary-image SHA-256 mismatch');
    }
    if (!validEspApplicationBinPayloadEquivalenceWitness(ck.payloadEquivalenceWitness, ck.bytes)
        || !validEspApplicationBinPayloadEquivalenceWitness(
          native.payloadEquivalenceWitness,
          native.bytes,
        )) {
      return invalid('application-bin mismatch lacks a valid ESP ELF SHA-256 payload witness');
    }
    const ckWitness = ck.payloadEquivalenceWitness;
    const nativeWitness = native.payloadEquivalenceWitness;
    if (canonicalJson(espApplicationBinFixedWitnessProjection(ckWitness))
        !== canonicalJson(espApplicationBinFixedWitnessProjection(nativeWitness))) {
      return invalid('application-bin payload witness layouts differ across lanes');
    }
    if (!ckWitness.immutableSegments.every((segment, index) => (
      segment.sha256 === nativeWitness.immutableSegments[index].sha256
    ))) {
      return invalid('application-bin bytes differ outside the allowed ELF SHA-256 window');
    }
    exceptionReasons.push(ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT);
  }
  if (mismatchedRoles.includes('flash-arguments')) {
    const ckFlash = ckControlled.included.filter((artifact) => artifact.role === 'flash-arguments');
    const nativeFlash = nativeControlled.included.filter((artifact) => artifact.role === 'flash-arguments');
    if (ckFlash.length !== 1 || nativeFlash.length !== 1) {
      return invalid('flash-arguments must be unique in both lanes');
    }
    const ckFlashWitness = ckFlash[0].flashArgumentsWitness;
    const nativeFlashWitness = nativeFlash[0].flashArgumentsWitness;
    if (!validEspFlashArgumentsWitness(ckFlashWitness, ckFlash[0].bytes)
        || !validEspFlashArgumentsWitness(nativeFlashWitness, nativeFlash[0].bytes)) {
      return invalid('flash-arguments mismatch lacks a valid normalized flash_args witness');
    }
    if (canonicalJson(ckFlashWitness.optionLines)
        !== canonicalJson(nativeFlashWitness.optionLines)) {
      return invalid('flash-arguments flash options differ across lanes');
    }
    if (ckFlashWitness.segments.length !== nativeFlashWitness.segments.length) {
      return invalid('flash-arguments segment layouts differ across lanes');
    }
    for (let index = 0; index < ckFlashWitness.segments.length; index += 1) {
      const ckSegment = ckFlashWitness.segments[index];
      const nativeSegment = nativeFlashWitness.segments[index];
      if (ckSegment.offset !== nativeSegment.offset
          || ckSegment.role !== nativeSegment.role
          || ckSegment.resolved !== nativeSegment.resolved) {
        return invalid('flash-arguments segment layouts differ across lanes');
      }
      if (ckSegment.resolved !== true) {
        if (ckSegment.reference !== nativeSegment.reference) {
          return invalid('flash-arguments segment layouts differ across lanes');
        }
        continue;
      }
      if (ckSegment.bytes !== nativeSegment.bytes) {
        return invalid('flash-arguments segment layouts differ across lanes');
      }
      if (ckSegment.sha256 === nativeSegment.sha256) continue;
      const segmentUsesApplicationException = ckSegment.role === 'application-bin'
        && applicationBinMismatched
        && ckSegment.sha256 === ck.sha256
        && nativeSegment.sha256 === native.sha256;
      if (!segmentUsesApplicationException) {
        return invalid('flash-arguments reference contents differ outside the application-bin exception');
      }
    }
    exceptionReasons.push(ESP_FLASH_ARGS_NORMALIZED_REFERENCE_REASON);
  }
  return {
    ...exact,
    policyId: PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
    comparable: true,
    passed: true,
    exceptionUsed: true,
    exceptionReason: exceptionReasons.join('; '),
    excludedRoles,
    reason: null,
  };
}

function compareArtifactEquivalenceForCandidate(ckArtifacts, nativeArtifacts, candidate) {
  if (candidate?.operation === 'compile'
      && candidate?.candidateProfile === 'portable-fast'
      && candidate?.artifactEquivalencePolicyId === PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID
      && validEspApplicationPayloadRecipeProof(
        candidate.portableFastEspApplicationBinRecipeProof,
        candidate?.lanes?.ck?.identity,
      )) {
    return comparePortableFastEspApplicationBinEquivalence(ckArtifacts, nativeArtifacts);
  }
  return compareGenericArtifactEquivalence(ckArtifacts, nativeArtifacts);
}

// Run records historically hashed every JSON number directly. JavaScript and
// Rust can choose different shortest spellings for an otherwise identical
// IEEE-754 diagnostic float, so v2 binds the exact integer nanosecond clock
// string and excludes derived display timings from the integrity projection.
function nativeRunIntegrityProjection(run) {
  const { evidenceSha256, ...unsigned } = run;
  if (unsigned.integritySchemaVersion !== 2) return unsigned;
  delete unsigned.wallMs;
  const rawTiming = unsigned.rawTiming;
  unsigned.rawTiming = rawTiming && typeof rawTiming === 'object'
    ? { runnerWallNs: rawTiming.runnerWallNs }
    : null;
  return unsigned;
}

function nativeRunMeasuredWallMs(run, label) {
  if (run.integritySchemaVersion !== 2) return run.wallMs;
  if (!/^[0-9]+$/u.test(String(run.rawTiming?.runnerWallNs || ''))) {
    throw new Error(`${label}.rawTiming.runnerWallNs is required for integrity v2`);
  }
  const derived = Number(BigInt(run.rawTiming.runnerWallNs)) / 1e6;
  if (!Number.isFinite(derived) || derived <= 0
      || !Number.isFinite(run.wallMs) || Math.abs(run.wallMs - derived) > 0.01) {
    throw new Error(`${label}.wallMs does not match the bound nanosecond clock`);
  }
  return derived;
}

function validateNativeRunRecord(run, label, expected) {
  if (!run || typeof run !== 'object' || Array.isArray(run)) throw new Error(`${label} is required`);
  if (run.success !== true || run.compileOnly !== true || run.uploadPerformed !== false
      || run.exactUsed !== false) {
    throw new Error(`${label} is not a successful non-Exact compile-only capture`);
  }
  nativeRunMeasuredWallMs(run, label);
  if (!isSha256(run.codeSha256) || run.codeSha256 !== expected.sourceSha256) {
    throw new Error(`${label}.codeSha256 does not match the fixed portable-edit source`);
  }
  if (!isSha256(run.evidenceSha256)) throw new Error(`${label}.evidenceSha256 is invalid`);
  if (digestObject(nativeRunIntegrityProjection(run)) !== run.evidenceSha256) {
    throw new Error(`${label}.evidenceSha256 was not recomputed`);
  }
  if (!Array.isArray(run.artifacts) || run.artifacts.length === 0 || run.artifacts.length > 64) {
    throw new Error(`${label}.artifacts is invalid`);
  }
  run.artifacts.forEach((artifact, index) => validateNativeArtifact(artifact, `${label}.artifacts[${index}]`));
  if (!isSha256(run.artifactSetSha256)
      || nativeArtifactSetSha256(run.artifacts) !== run.artifactSetSha256
      || run.artifactsVerified !== true) {
    throw new Error(`${label} artifact-set evidence is invalid`);
  }
  if (run.resources?.evidenceComplete !== true
      || !Number.isSafeInteger(run.resources.flashUsedBytes)
      || run.resources.flashUsedBytes < 0
      || !Number.isSafeInteger(run.resources.ramUsedBytes)
      || run.resources.ramUsedBytes < 0) {
    throw new Error(`${label} resource evidence is incomplete`);
  }
}

function compareRequiredArtifactRoles(ckArtifacts, nativeArtifacts, requiredRoles) {
  return requiredRoles.every((role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    return ck.length === 1 && native.length === 1
      && ck[0].bytes === native[0].bytes && ck[0].sha256 === native[0].sha256;
  });
}

function compareOptionalArtifactRoles(ckArtifacts, nativeArtifacts, optionalRoles) {
  return optionalRoles.every((role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    if (ck.length === 0 && native.length === 0) return true;
    return ck.length === 1 && native.length === 1
      && ck[0].bytes === native[0].bytes && ck[0].sha256 === native[0].sha256;
  });
}

// Witness roles are exactly one same-length primary application image per
// lane. Equal digests pass directly; a digest mismatch must be covered by the
// validated ESP payload witness on both lanes (layout-equal, immutable
// segments byte-equal).
function compareWitnessArtifactRoles(ckArtifacts, nativeArtifacts, witnessRoles) {
  return witnessRoles.every((role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    if (ck.length !== 1 || native.length !== 1
        || ck[0].bytes !== native[0].bytes
        || ck[0].primaryApplication !== true || native[0].primaryApplication !== true) {
      return false;
    }
    if (ck[0].sha256 === native[0].sha256) return true;
    return espApplicationBinWitnessesEquivalent(ck[0], native[0]);
  });
}

function validateNativeRelinkAdapter(identity, controls) {
  const adapter = nativeRelinkAdapterFor(identity);
  if (!adapter) {
    throw new Error(
      'no certified NativeRelink adapter contract exists for this Core/FQBN; '
      + 'the current certificate evaluator has no matching registered adapter',
    );
  }
  if (controls?.nativeRelinkAdapterId !== adapter.id
      || controls?.nativeRelinkEngineContractId !== adapter.engineContractId
      || controls?.artifactEquivalencePolicyId !== adapter.artifactEquivalencePolicyId) {
    throw new Error('NativeRelink adapter/artifact equivalence contract is missing or mismatched');
  }
  return adapter;
}

function nativeRelinkQualificationBinding(target, ckContractId, adapter = AVR_NATIVE_RELINK_ADAPTER) {
  return {
    schemaId: 'ck.forge.native-relink-local-binding',
    schemaVersion: NATIVE_RELINK_BINDING_SCHEMA_VERSION,
    profile: NATIVE_RELINK_PROFILE,
    fqbn: target.fqbn,
    coreVersion: target.coreVersion,
    toolchainKey: target.toolchainKey,
    cliVersion: target.cliVersion,
    cliExecutableSha256: target.cliExecutableSha256,
    hostIdentitySha256: target.hostIdentitySha256,
    productionExecutableSha256: target.productionExecutableSha256,
    sequenceSha256: target.sequenceSha256,
    ckContractId,
    // A stricter policy must never collide with an older certificate directory.
    performancePolicyId: NATIVE_RELINK_POLICY.id,
    nativeRelinkContractId: adapter.engineContractId,
  };
}

function validateAndEvaluateNativeRelink(evidence, evidenceSha256, evaluatedAt = new Date().toISOString()) {
  if (!evidence || typeof evidence !== 'object' || Array.isArray(evidence)
      || evidence.schemaId !== NATIVE_RELINK_RUN_SCHEMA_ID || evidence.schemaVersion !== 2) {
    throw new Error('unsupported NativeRelink evidence schema identity');
  }
  if (!isSha256(evidenceSha256)) throw new Error('NativeRelink evidence SHA-256 is invalid');
  if (evidence.measurementStatus !== 'passed'
      || !Array.isArray(evidence.failures) || evidence.failures.length !== 0
      || evidence.runner?.unchanged !== true || evidence.productionExecutable?.unchanged !== true
      || !Array.isArray(evidence.checks) || evidence.checks.length === 0
      || evidence.checks.some((check) => check?.passed !== true)) {
    throw new Error('NativeRelink raw measurement did not finish with immutable passing evidence');
  }
  const controls = evidence.controls;
  const requiredTrue = [
    'compileOnly', 'sameMachine', 'sameBundledCli', 'sameCliConfig',
    'sameCoreAndCompleteFqbn', 'sameSourceBytes', 'sameParallelJobs',
    'globalCachesSharedEqually', 'externalShortBuildPaths',
    'sequentialNoConcurrentCompiles', 'ckQualificationMode',
    'sameBuildPathWithinLane', 'qualificationTokenBound',
  ];
  if (!controls || requiredTrue.some((field) => controls[field] !== true)
      || controls.uploadPerformed !== false || controls.physicalFlashWritten !== false
      || controls.serialPortAccessed !== false || controls.exactAllowed !== false
      || controls.exactCountedAsFresh !== false
      || controls.measurementSequence !== NATIVE_RELINK_POLICY.requiredSequence
      || controls.requiredCkMode !== NATIVE_RELINK_PROFILE) {
    throw new Error('NativeRelink capture controls do not satisfy the compile-only qualification contract');
  }
  if (canonicalJson(controls.laneBoundaryIdlePolicy)
      !== canonicalJson(NATIVE_RELINK_LANE_IDLE_POLICY)) {
    throw new Error('NativeRelink lane-boundary idle policy is missing or mismatched');
  }
  const identity = evidence.identity;
  if (!identity || typeof identity !== 'object' || Array.isArray(identity)) {
    throw new Error('NativeRelink evidence identity is required');
  }
  const fqbn = canonicalCompleteFqbn(identity.fqbn);
  if (fqbn !== identity.fqbn) throw new Error('NativeRelink evidence FQBN must be canonical and complete');
  const adapter = validateNativeRelinkAdapter(identity, controls);
  for (const field of ['coreVersion', 'cliVersion']) assertString(identity[field], `identity.${field}`);
  for (const field of [
    'cliExecutableSha256', 'hostIdentitySha256', 'runnerSha256',
    'productionExecutableSha256', 'sequenceSha256',
  ]) {
    if (!isSha256(identity[field])) throw new Error(`identity.${field} must be lowercase SHA-256`);
  }
  const productionExecutableSha256 = identity.productionExecutableSha256;
  if (evidence.productionExecutable?.before?.executableSha256 !== productionExecutableSha256
      || evidence.productionExecutable?.after?.executableSha256 !== productionExecutableSha256) {
    throw new Error('NativeRelink production executable evidence does not match its bound identity');
  }
  if (!Array.isArray(evidence.stages)
      || canonicalJson(evidence.stages) !== canonicalJson(PORTABLE_EDIT_STAGES)) {
    throw new Error('NativeRelink evidence does not use the fixed portable-edit sequence');
  }
  if (!Array.isArray(evidence.trials)
      || evidence.trials.length < NATIVE_RELINK_POLICY.minTrials
      || evidence.trials.length > NATIVE_RELINK_POLICY.maxTrials) {
    throw new Error(`NativeRelink evidence requires ${NATIVE_RELINK_POLICY.minTrials}..${NATIVE_RELINK_POLICY.maxTrials} paired trials`);
  }
  if (!Array.isArray(evidence.captureOrder) || evidence.captureOrder.length !== evidence.trials.length
      || !evidence.captureOrder.every((entry) => entry === 'ck-native' || entry === 'native-ck')
      || !evidence.captureOrder.includes('ck-native') || !evidence.captureOrder.includes('native-ck')) {
    throw new Error('NativeRelink capture order is invalid');
  }

  const seenTrialIds = new Set();
  const observedToolchains = new Set();
  const observedContracts = new Set();
  for (const [trialIndex, trial] of evidence.trials.entries()) {
    assertString(trial?.id, `trials[${trialIndex}].id`);
    if (seenTrialIds.has(trial.id) || trial.order !== evidence.captureOrder[trialIndex]) {
      throw new Error('NativeRelink paired trial identity/order is invalid');
    }
    seenTrialIds.add(trial.id);
    const expectedLaneOrder = trial.order.split('-');
    if (!Array.isArray(trial.laneBoundaryIdle)
        || trial.laneBoundaryIdle.length !== expectedLaneOrder.length) {
      throw new Error('NativeRelink lane-boundary idle evidence is incomplete');
    }
    for (const [laneIndex, idle] of trial.laneBoundaryIdle.entries()) {
      if (idle?.lane !== expectedLaneOrder[laneIndex]
          || idle.policyId !== NATIVE_RELINK_LANE_IDLE_POLICY.policyId
          || idle.idleWindowMs !== NATIVE_RELINK_LANE_IDLE_POLICY.idleWindowMs
          || idle.timeoutMs !== NATIVE_RELINK_LANE_IDLE_POLICY.timeoutMs
          || idle.pollIntervalMs !== NATIVE_RELINK_LANE_IDLE_POLICY.pollIntervalMs
          || !Number.isSafeInteger(idle.waitedMs)
          || idle.waitedMs < idle.idleWindowMs
          || idle.waitedMs > idle.timeoutMs
          || !Number.isSafeInteger(idle.polls)
          || idle.polls < 2) {
        throw new Error('NativeRelink lane-boundary idle evidence is invalid');
      }
    }
    if (trial.ck?.cacheClear?.reset_scope !== 'first-project-full-fqbn'
        || trial.ck.cacheClear.force_rebuild_pending !== false
        || trial.ck.cacheClear.ccache_store_preserved !== true) {
      throw new Error('NativeRelink CK lane did not record the required per-trial cache-reset boundary');
    }
    for (const stage of PORTABLE_EDIT_STAGES) {
      const ck = trial?.ck?.[stage.id];
      const native = trial?.native?.[stage.id];
      validateNativeRunRecord(ck, `trials[${trialIndex}].ck.${stage.id}`, stage);
      validateNativeRunRecord(native, `trials[${trialIndex}].native.${stage.id}`, stage);
      if (canonicalCompleteFqbn(ck.fqbn) !== fqbn || canonicalCompleteFqbn(native.fqbn) !== fqbn
          || ck.cliVersion !== identity.cliVersion || ck.route?.coreVersion !== identity.coreVersion) {
        throw new Error('NativeRelink run identity does not match the report target');
      }
      observedToolchains.add(ck.toolchainKey);
      observedContracts.add(ck.route?.contractId);
      if (ck.resources.flashUsedBytes !== native.resources.flashUsedBytes
          || ck.resources.ramUsedBytes !== native.resources.ramUsedBytes) {
        throw new Error('NativeRelink resource evidence differs from native Arduino CLI');
      }
      if (!compareRequiredArtifactRoles(
        ck.artifacts, native.artifacts, adapter.requiredArtifactRoles,
      ) || !compareWitnessArtifactRoles(
        ck.artifacts, native.artifacts, adapter.witnessArtifactRoles,
      ) || !compareOptionalArtifactRoles(
        ck.artifacts, native.artifacts, adapter.optionalArtifactRoles,
      )) {
        throw new Error('NativeRelink required artifact evidence differs from native Arduino CLI');
      }
      const allStageForbiddenArtifact = [...ck.artifacts, ...native.artifacts]
        .find((artifact) => adapter.forbiddenAllStageArtifactRoles.includes(artifact.role));
      const ckEditForbiddenArtifact = stage.id === 'simple'
        ? null
        : ck.artifacts.find(
          (artifact) => adapter.forbiddenCkEditArtifactRoles.includes(artifact.role),
        );
      const forbiddenArtifact = allStageForbiddenArtifact || ckEditForbiddenArtifact;
      if (forbiddenArtifact != null) {
        throw new Error(
          `NativeRelink artifact policy rejected role=${forbiddenArtifact.role} name=${forbiddenArtifact.name}`,
        );
      }
      if (stage.id !== 'simple') {
        if (ck.buildMode !== NATIVE_RELINK_PROFILE) {
          throw new Error(`NativeRelink edit stage '${stage.id}' used buildMode=${ck.buildMode || 'missing'}`);
        }
      }
    }
  }
  if (observedToolchains.size !== 1 || [...observedToolchains].some((value) => typeof value !== 'string' || !value.trim())) {
    throw new Error('NativeRelink toolchain identity is missing or unstable');
  }
  if (observedContracts.size !== 1 || observedContracts.has(undefined) || observedContracts.has(null)) {
    throw new Error('NativeRelink CK/FLFE contract identity is missing or unstable');
  }
  const [ckContractId] = observedContracts;
  const [toolchainKey] = observedToolchains;
  assertString(ckContractId, 'ckContractId');

  const stageResults = NATIVE_RELINK_POLICY.editStages.map((stageId) => {
    const ckRawMs = evidence.trials.map((trial) => nativeRunMeasuredWallMs(
      trial.ck[stageId], `trials.ck.${stageId}`,
    ));
    const nativeRawMs = evidence.trials.map((trial) => nativeRunMeasuredWallMs(
      trial.native[stageId], `trials.native.${stageId}`,
    ));
    const ckMedianMs = median(ckRawMs);
    const nativeMedianMs = median(nativeRawMs);
    const ckP95Ms = percentileNearestRank(ckRawMs, 95);
    const nativeP95Ms = percentileNearestRank(nativeRawMs, 95);
    const medianGainMs = nativeMedianMs - ckMedianMs;
    const medianSpeedupPct = (medianGainMs / nativeMedianMs) * 100;
    const checks = [
      { id: 'minimum-five-paired-trials', passed: ckRawMs.length >= NATIVE_RELINK_POLICY.minTrials },
      { id: 'minimum-relative-median-speedup', passed: medianSpeedupPct >= NATIVE_RELINK_POLICY.minMedianSpeedupPct },
      { id: 'minimum-absolute-median-gain', passed: medianGainMs >= NATIVE_RELINK_POLICY.minAbsoluteMedianGainMs },
      { id: 'nearest-rank-p95-no-regression', passed: ckP95Ms <= nativeP95Ms },
    ];
    return {
      id: stageId,
      ckRawMs,
      nativeRawMs,
      ckMedianMs: rounded(ckMedianMs),
      nativeMedianMs: rounded(nativeMedianMs),
      ckP95Ms: rounded(ckP95Ms),
      nativeP95Ms: rounded(nativeP95Ms),
      medianGainMs: rounded(medianGainMs),
      medianSpeedupPct: rounded(medianSpeedupPct),
      checks,
      qualified: checks.every((check) => check.passed),
    };
  });
  const target = {
    fqbn,
    coreVersion: identity.coreVersion,
    toolchainKey,
    cliVersion: identity.cliVersion,
    cliExecutableSha256: identity.cliExecutableSha256,
    hostIdentitySha256: identity.hostIdentitySha256,
    productionExecutableSha256,
    sequenceSha256: identity.sequenceSha256,
  };
  const qualificationKey = digestObject(nativeRelinkQualificationBinding(target, ckContractId, adapter));
  const qualified = stageResults.every((stage) => stage.qualified);
  return {
    schemaId: NATIVE_RELINK_REPORT_SCHEMA_ID,
    schemaVersion: 1,
    evaluatedAt,
    evidenceSha256,
    qualificationKey,
    operation: 'compile',
    candidateProfile: NATIVE_RELINK_PROFILE,
    policy: { ...NATIVE_RELINK_POLICY },
    target,
    ckContractId,
    nativeRelinkAdapterId: adapter.id,
    nativeRelinkContractId: adapter.engineContractId,
    artifactEquivalencePolicyId: adapter.artifactEquivalencePolicyId,
    measurementSequence: NATIVE_RELINK_POLICY.requiredSequence,
    coldSimpleRequiredToWin: false,
    trialCountPerLane: evidence.trials.length,
    stages: stageResults,
    qualified,
    status: qualified ? 'qualified-native-relink' : 'not-qualified',
    recommendedRoute: qualified ? NATIVE_RELINK_PROFILE : 'native-arduino-cli',
    reasonCodes: qualified
      ? ['all-portable-edit-stages-qualified']
      : stageResults.filter((stage) => !stage.qualified).map((stage) => `${stage.id}-performance-gate-failed`),
  };
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileNearestRank(values, percentile) {
  const sorted = [...values].sort((left, right) => left - right);
  return sorted[Math.max(0, Math.ceil((percentile / 100) * sorted.length) - 1)];
}

function coefficientOfVariationPct(values) {
  const mean = values.reduce((total, value) => total + value, 0) / values.length;
  const variance = values.reduce((total, value) => total + ((value - mean) ** 2), 0) / values.length;
  return (Math.sqrt(variance) / mean) * 100;
}

function rounded(value) {
  return Math.round(value * 1000) / 1000;
}

function laneStats(lane, stage) {
  const values = lane.trials.map((trial) => trial[stage].wallMs);
  return {
    samples: values.length,
    valuesMs: values,
    medianMs: rounded(median(values)),
    p95Ms: rounded(percentileNearestRank(values, 95)),
    coefficientOfVariationPct: rounded(coefficientOfVariationPct(values)),
  };
}

function stageResult(candidate, stage) {
  const ck = laneStats(candidate.lanes.ck, stage);
  const native = laneStats(candidate.lanes.native, stage);
  const medianGainMs = native.medianMs - ck.medianMs;
  const medianSpeedupPct = (medianGainMs / native.medianMs) * 100;
  const p95RegressionPct = ((ck.p95Ms - native.p95Ms) / native.p95Ms) * 100;
  const checks = [
    {
      id: 'ck-median-is-meaningfully-faster',
      passed: medianSpeedupPct >= POLICY.minMedianSpeedupPct
        && medianGainMs >= POLICY.minAbsoluteMedianGainMs,
    },
    {
      id: 'ck-p95-does-not-regress',
      passed: p95RegressionPct <= POLICY.maxP95RegressionPct,
    },
    {
      id: 'ck-measurements-are-stable',
      passed: ck.coefficientOfVariationPct <= POLICY.maxCoefficientOfVariationPct,
    },
    {
      id: 'native-measurements-are-stable',
      passed: native.coefficientOfVariationPct <= POLICY.maxCoefficientOfVariationPct,
    },
  ];
  return {
    stage,
    ck,
    native,
    medianGainMs: rounded(medianGainMs),
    medianSpeedupPct: rounded(medianSpeedupPct),
    p95RegressionPct: rounded(p95RegressionPct),
    checks,
    qualified: checks.every((check) => check.passed),
  };
}

function genericQualificationBinding(candidate) {
  const identity = candidate.lanes.ck.identity;
  return {
    ...Object.fromEntries(IDENTITY_FIELDS.map((field) => [field, identity[field]])),
    ckContractId: candidate.ckContractId,
    performancePolicyId: POLICY.id,
    candidateRoute: QUALIFICATION_TOKEN_CANDIDATE_ROUTE,
    compilePropertyDelta: candidate.compilePropertyDelta,
    nativeBaselineCompilerPropertiesSha256: candidate.nativeBaselineCompilerPropertiesSha256,
    operation: candidate.operation,
    candidateProfile: candidate.candidateProfile,
    artifactEquivalencePolicyId: candidate.artifactEquivalencePolicyId,
    ...(candidate.portableFastEspApplicationBinRecipeProof == null ? {} : {
      portableFastEspApplicationBinRecipeProof: candidate.portableFastEspApplicationBinRecipeProof,
    }),
    measurementSequence: candidate.measurementSequence,
    sequenceSha256: candidate.sequenceSha256,
  };
}

function evaluate(candidate, inputSha256, evaluatedAt = new Date().toISOString()) {
  if (candidate?.schemaId === NATIVE_RELINK_RUN_SCHEMA_ID) {
    return validateAndEvaluateNativeRelink(candidate, inputSha256, evaluatedAt);
  }
  validateCandidate(candidate);
  const stages = POLICY.requiredStages.map((stage) => stageResult(candidate, stage));
  const identity = candidate.lanes.ck.identity;
  const qualificationKey = digestObject(genericQualificationBinding(candidate));
  const qualified = stages.every((stage) => stage.qualified);
  return {
    schemaId: 'ck.forge.performance-qualification-report',
    schemaVersion: 4,
    policy: { ...POLICY },
    evaluatedAt,
    inputSha256,
    qualificationKey,
    target: { ...identity },
    operation: candidate.operation,
    candidateProfile: candidate.candidateProfile,
    candidateRoute: QUALIFICATION_TOKEN_CANDIDATE_ROUTE,
    nativeBaselineCompilerPropertiesSha256: candidate.nativeBaselineCompilerPropertiesSha256,
    artifactEquivalencePolicyId: candidate.artifactEquivalencePolicyId,
    ...(candidate.portableFastEspApplicationBinRecipeProof == null ? {} : {
      portableFastEspApplicationBinRecipeProof: candidate.portableFastEspApplicationBinRecipeProof,
    }),
    measurementSequence: candidate.measurementSequence,
    sequenceSha256: candidate.sequenceSha256,
    hostIdentitySha256: identity.hostIdentitySha256,
    sampleSetSha256: inputSha256,
    ckContractId: candidate.ckContractId,
    compilePropertyDelta: candidate.compilePropertyDelta,
    trialCountPerLane: candidate.lanes.ck.trials.length,
    captureOrder: [...candidate.captureOrder],
    stages,
    qualifiedFast: qualified,
    status: qualified ? 'qualified-fast' : 'not-qualified',
    recommendedRoute: qualified ? 'ck-fast' : 'native-arduino-cli',
    reasonCodes: qualified
      ? ['all-portable-edit-stages-no-regression-gate-passed']
      : stages.filter((stage) => !stage.qualified).map((stage) => `${stage.stage}-performance-gate-failed`),
    controls: { ...candidate.controls },
    compileOnly: true,
    uploadPerformed: false,
    hardwareTested: false,
  };
}

function certifyNativeRelink(inputPath, qualificationRoot) {
  const inputBytes = fs.readFileSync(inputPath);
  if (inputBytes.length <= 0 || inputBytes.length > 4 * 1024 * 1024) {
    throw new Error('NativeRelink evidence must be a non-empty JSON file no larger than 4 MiB');
  }
  const evidence = JSON.parse(inputBytes.toString('utf8'));
  const evidenceSha256 = sha256(inputBytes);
  const report = validateAndEvaluateNativeRelink(evidence, evidenceSha256);
  if (!report.qualified) {
    return { report, certificatePath: null };
  }
  const reportBytes = Buffer.from(`${JSON.stringify(report, null, 2)}\n`, 'utf8');
  const reportSha256 = sha256(reportBytes);
  const certificate = {
    schemaId: LOCAL_CERTIFICATE_SCHEMA_ID,
    schemaVersion: 4,
    candidateProfile: NATIVE_RELINK_PROFILE,
    evidenceSha256,
    reportSha256,
  };
  const certificateBytes = Buffer.from(`${JSON.stringify(certificate, null, 2)}\n`, 'utf8');
  fs.mkdirSync(qualificationRoot, { recursive: true });
  const rootMetadata = fs.lstatSync(qualificationRoot);
  if (!rootMetadata.isDirectory() || rootMetadata.isSymbolicLink()) {
    throw new Error('qualification root must be a real directory');
  }
  const destination = path.join(qualificationRoot, report.qualificationKey);
  if (fs.existsSync(destination)) throw new Error('qualification certificate already exists; refusing to overwrite');
  const temporary = path.join(
    qualificationRoot,
    `.native-relink-${process.pid}-${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  try {
    fs.mkdirSync(temporary, { recursive: false });
    fs.writeFileSync(path.join(temporary, 'evidence.json'), inputBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'report.json'), reportBytes, { flag: 'wx' });
    fs.writeFileSync(path.join(temporary, 'certificate.json'), certificateBytes, { flag: 'wx' });
    fs.renameSync(temporary, destination);
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
  return { report, certificatePath: destination };
}

function writeNoClobber(outputPath, value) {
  const directory = path.dirname(outputPath);
  fs.mkdirSync(directory, { recursive: true });
  const payload = `${JSON.stringify(value, null, 2)}\n`;
  const descriptor = fs.openSync(outputPath, 'wx');
  try {
    fs.writeFileSync(descriptor, payload, 'utf8');
  } finally {
    fs.closeSync(descriptor);
  }
}

function plan(options) {
  return {
    schemaVersion: 3,
    action: 'evaluate-performance-ab',
    inputPath: options.inputPath,
    outputPath: options.outputPath,
    policy: { ...POLICY },
    identityFields: [...IDENTITY_FIELDS],
    requiredSequence: POLICY.requiredSequence,
    requiredStages: [...POLICY.requiredStages],
    requiredLanes: ['ck', 'native'],
    capabilityBinding: {
      operations: ['compile', 'upload-ready'],
      profiles: ['quick-fast', 'shared-fast', NATIVE_RELINK_PROFILE],
      compileProfiles: ['quick-fast'],
      nativeRelinkCompileOnly: {
        sourceSchema: `${NATIVE_RELINK_RUN_SCHEMA_ID}/v2`,
        minimumPairedTrials: NATIVE_RELINK_POLICY.minTrials,
        requiredEditStages: [...NATIVE_RELINK_POLICY.editStages],
        coldSimpleRequiredToWin: false,
      },
    },
    writesFiles: false,
  };
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\n`);
      return 0;
    }
    if (options.action === 'plan') {
      process.stdout.write(`${JSON.stringify(plan(options), null, 2)}\nNo evidence was evaluated or written.\n`);
      return 0;
    }
    if (options.action === 'certify-native-relink') {
      const result = certifyNativeRelink(options.inputPath, options.qualificationRoot);
      if (!result.report.qualified) {
        process.stdout.write(`NOT-QUALIFIED ${options.inputPath}\n`);
        return 2;
      }
      process.stdout.write(`QUALIFIED-NATIVE-RELINK ${result.certificatePath}\n`);
      return 0;
    }
    const { candidate, inputSha256 } = readInput(options.inputPath);
    const report = evaluate(candidate, inputSha256);
    writeNoClobber(options.outputPath, report);
    process.stdout.write(`${report.status.toUpperCase()} ${options.outputPath}\n`);
    return report.qualifiedFast === true || report.qualified === true ? 0 : 2;
  } catch (error) {
    process.stderr.write(`CK Forge performance gate: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  IDENTITY_FIELDS,
  POLICY,
  COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
  QUALIFICATION_SOURCE_DATE_EPOCH,
  QUALIFICATION_TIME_ZONE,
  NATIVE_RELINK_POLICY,
  NATIVE_RELINK_ADAPTERS,
  SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
  ESP32C6_NATIVE_RELINK_ADAPTER,
  NATIVE_RELINK_BINDING_SCHEMA_VERSION,
  NATIVE_RELINK_CONTRACT_ID,
  NATIVE_RELINK_ADAPTER_ID,
  NATIVE_RELINK_ARTIFACT_POLICY_ID,
  NATIVE_RELINK_PROFILE,
  PORTABLE_EDIT_STAGES,
  artifactEquivalencePolicyIdForCandidate,
  canonicalCompleteFqbn,
  canonicalJson,
  compareGenericArtifactEquivalence,
  compareWitnessArtifactRoles,
  coefficientOfVariationPct,
  digestObject,
  certifyNativeRelink,
  evaluate,
  genericQualificationBinding,
  laneStats,
  main,
  median,
  nativeRelinkAdapterFor,
  nativeRelinkQualificationBinding,
  nativeArtifactSetSha256,
  parseArgs,
  percentileNearestRank,
  phaseResult: stageResult,
  stageResult,
  validateCandidate,
  hasReproducibleQualificationEnvironment,
  validateAndEvaluateNativeRelink,
  validateNativeRelinkAdapter,
  writeNoClobber,
};
