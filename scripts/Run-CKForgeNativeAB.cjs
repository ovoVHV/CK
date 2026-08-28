#!/usr/bin/env node
'use strict';

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');
const util = require('node:util');
const { execFileSync, spawn } = require('node:child_process');

const REPO_ROOT = path.resolve(__dirname, '..');
const CLI_PATH = path.join(REPO_ROOT, 'bin', process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli');
const CLI_CONFIG = path.join(REPO_ROOT, 'arduino-cli.yaml');
const FAST_CLI_CONFIG = path.join(REPO_ROOT, 'arduino-cli-fast.yaml');
const FAST_PROFILE_NATIVE_BUILD_PROPERTIES = Object.freeze([
  Object.freeze(['compiler.optimization_flags', '-O1']),
  Object.freeze(['compiler.c.extra_flags', '-pipe -g0 -O1 -fno-lto']),
  Object.freeze(['compiler.cpp.extra_flags', '-pipe -g0 -O1 -fno-lto']),
  Object.freeze(['compiler.S.extra_flags', '-pipe -fno-lto']),
  Object.freeze(['compiler.c.elf.extra_flags', '-O1 -g0 -fno-lto']),
  Object.freeze(['compiler.ck.final_flags', '-O1 -g0 -fno-lto']),
]);
const DEFAULT_FQBN = 'esp32:esp32:esp32c6';
const DEFAULT_TRIALS = 5;
const DEFAULT_TIMEOUT_MINUTES = 20;
const DEFAULT_MIN_FREE_GIB = 8;
const REQUIRED_CK_MODE_NATIVE_RELINK = 'native-relink-compile-only';
const NATIVE_RELINK_QUALIFICATION_TOKEN_ENV = 'CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN';
const PRODUCTION_EXECUTABLE_PATH_ENV = 'CK_FORGE_PRODUCTION_EXECUTABLE_PATH';
const PRODUCTION_EXECUTABLE_SHA256_ENV = 'CK_FORGE_PRODUCTION_EXECUTABLE_SHA256';
const PRODUCTION_PROCESS_ID_ENV = 'CK_PROCESS_ID';
// ESP32 Core embeds __DATE__/__TIME__ in a few core objects.  A qualification
// capture compares CK and native ELF bytes, so its two lanes must share a
// deterministic timestamp environment.  This is deliberately limited to the
// offline qualification harness; ordinary user builds retain their real build
// time semantics.
const QUALIFICATION_REPRODUCIBILITY_POLICY_ID = 'source-date-epoch-utc-v1';
const QUALIFICATION_SOURCE_DATE_EPOCH = '1704067200';
const QUALIFICATION_TIME_ZONE = 'UTC';
const FORGE_QUALIFICATION_OPERATIONS = Object.freeze(['compile', 'upload-ready']);
const PORTABLE_FAST_PROFILE = 'portable-fast';
const PORTABLE_FAST_RECIPE_INTENT = 'native-recipe-cache';
// PortableFast deliberately stays inside Arduino CLI's native build path. It
// may use CK's command-scoped ccache setup, but it must never silently become
// a relink or direct-engine measurement.
const PORTABLE_FAST_CK_BUILD_MODES = Object.freeze([
  'full-build',
  'arduino-cli-full-fallback',
  'arduino-cli-incremental',
  'arduino-cli-incremental-fallback',
  'arduino-cli-core-seeded',
]);
const FORGE_QUALIFICATION_PROFILES = Object.freeze([
  'quick-fast',
  'shared-fast',
  PORTABLE_FAST_PROFILE,
]);
const FAST_RELINK_FALLBACK_CODES = Object.freeze([
  'properties',
  'prebuild-hooks',
  'ccdb',
  'library-semantics',
  'core-identity',
  'compiler',
  'artifacts',
  'other',
]);
const DIAGNOSTIC_BUILD_MODES = Object.freeze([
  'exact-match',
  'native-relink-compile-only',
  'native-relink-graph-transition',
  'arduino-cli-core-seeded',
  'fast-relink',
  'arduino-cli-incremental-fallback',
  'arduino-cli-incremental',
  'arduino-cli-full-fallback',
  'full-build',
  'unknown',
]);
const QUALIFICATION_PHASES = Object.freeze([
  'fresh', 'repeat', 'simple', 'complex', 'medium', 'simple-return',
]);
const AVR_NATIVE_RELINK_ADAPTER = Object.freeze({
  id: 'arduino-avr-native-relink-v1',
  fqbnMatch: Object.freeze({ kind: 'prefix', value: 'arduino:avr:' }),
  coreArchitecture: 'avr',
  engineContractId: 'ck-native-relink-avr-release-compile-only-v2',
  // Some AVR Core/build-route combinations omit an empty EEPROM image. The
  // application HEX is always required; an EEPROM image is optional only when
  // both lanes omit it, and must be byte-identical whenever either lane emits one.
  artifactEquivalencePolicyId: 'arduino-avr-hex-required-eeprom-optional-exact-v2',
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
  // Native CLI may emit with_bootloader images; CK edit transactions must
  // remove them before committing compile-only output.
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
// Every row is an independently qualified product adapter. SAMD and ESP32 are
// deliberately limited to exact base FQBNs; no architecture-wide inheritance.
const NATIVE_RELINK_ADAPTERS = Object.freeze([
  AVR_NATIVE_RELINK_ADAPTER,
  SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
  ...ESP32_FAMILY_NATIVE_RELINK_ADAPTERS,
]);
const PERFORMANCE_QUALIFICATION_POLICY = Object.freeze({
  id: 'ck-forge-portable-edit-performance-v3',
  minimumMedianSpeedupPct: 25,
  minimumAbsoluteMedianGainMs: 500,
  minimumFormalTrials: 5,
  p95Method: 'nearest-rank',
  p95NoRegression: true,
  requiredSequence: 'portable-edit',
});
const FAST_PROFILE_PERFORMANCE_POLICY = Object.freeze({
  id: 'ck-forge-portable-edit-no-regression-v3',
  minimumMedianSpeedupPct: 25,
  minimumAbsoluteMedianGainMs: 500,
  minimumTrials: 5,
  maximumCoefficientOfVariationPct: 20,
  p95Method: 'nearest-rank',
  p95NoRegression: true,
  requiredSequence: 'portable-edit',
  requiredStages: Object.freeze(['simple', 'complex', 'medium', 'simple-return']),
});
const GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID = 'generic-required-role-content-exact-v1';
// PortableFast normally keeps the generic exact role/content contract.  Two
// narrowly scoped exceptions exist: ESP32's ELF SHA-256 insertion window in a
// primary application image (only after the resolved Core recipe proves that
// it is the documented 0xb0..0xd0 window), and the flash_args response file,
// whose bytes embed each lane's own sketch-derived artifact file names.  The
// latter is never skipped: both lanes must produce a validated normalized
// witness proving identical flash options, identical offset layout, and
// per-offset referenced payloads that are byte-identical across lanes (or the
// validated application-bin image for the application segment).
const PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID = 'portable-fast-esp-application-bin-elf-sha256-offset-flash-args-normalized-v2';
const ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION = 1;
const ESP_FLASH_ARGS_WITNESS_KIND = 'esp-flash-args-normalized-v1';
const ESP_FLASH_ARGS_NORMALIZED_REFERENCE_REASON = 'flash_args normalized offset/role/payload references';
const ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION = 1;
const ESP_APPLICATION_BIN_RECIPE_PROOF_KIND = 'esp32-platform-recipe-elf-sha256-offset-v1';
const ESP_APPLICATION_BIN_RECIPE_PROPERTY = 'recipe.objcopy.bin.pattern_args';
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION = 1;
const ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND = 'esp-application-bin-elf-sha256-offset-v1';
const ESP_APPLICATION_BIN_ELF_SHA256_OFFSET = 0xb0;
const ESP_APPLICATION_BIN_ELF_SHA256_LENGTH = 32;
const ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH = 33;
const ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT = '--elf-sha256-offset 0xb0';
// These are non-flash compile byproducts/derived aggregates. PortableFast
// qualification compares the controlled flash-artifact set, where every
// retained role remains exact except the validated ESP application image.
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
// QuickFast compile-only is allowed to stop after the linked application ELF.
// Arduino CLI may still materialize bootloader, partition, flash-argument, and
// other upload packaging files. Those files are not part of a compile-only
// semantic comparison, so this policy binds one shared application artifact
// instead of requiring both directories to have the same complete role set.
const COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID = 'compile-only-shared-primary-application-exact-v1';
const COMPILE_ONLY_SEMANTIC_APPLICATION_ROLES = Object.freeze([
  'application-elf',
  'application-bin',
  'avr-application-hex',
  'samd-application-bin',
  'samd-application-hex',
]);
const CDP_LIST_URL = process.env.CK_CDP_LIST_URL || 'http://127.0.0.1:9223/json/list';
const CDP_PORT = Number(new URL(CDP_LIST_URL).port);
const MAX_CAPTURE_BYTES = 4 * 1024 * 1024;
// Capability observations are normally retained only as hashes and structured
// booleans. Failed gates are the exception: preserve a small, redacted subset
// of the backend's blocker map so a failed architecture adapter is diagnosable
// without copying paths, credentials, or arbitrary compiler output into the
// immutable A/B report.
const RECIPE_CAPABILITY_FAILURE_DIAGNOSTICS_SCHEMA_VERSION = 1;
const MAX_RECIPE_CAPABILITY_FAILURE_CAPABILITIES = 8;
const MAX_RECIPE_CAPABILITY_FAILURE_REASONS_PER_CAPABILITY = 4;
const MAX_RECIPE_CAPABILITY_FAILURE_REASON_CHARS = 320;
const MAX_RECIPE_CAPABILITY_FAILURE_SUMMARY_CHARS = 1_200;
// The desktop may launch a short Arduino CLI discovery/prewarm command after
// its CDP page is already listening.  Do not let the first benchmark-owned
// board-details invocation race that startup work.  This is a startup-only
// barrier; the per-lane no-concurrent-CLI assertion below remains unchanged.
const ARDUINO_CLI_STARTUP_IDLE_POLICY_ID = 'arduino-cli-startup-idle-window-v1';
const ARDUINO_CLI_STARTUP_IDLE_WINDOW_MS = 2_000;
const ARDUINO_CLI_STARTUP_IDLE_TIMEOUT_MS = 60_000;
const ARDUINO_CLI_STARTUP_POLL_INTERVAL_MS = 200;
const ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID = 'arduino-cli-pretrial-idle-window-v1';
const ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS = 2_000;
const ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS = 60_000;
const ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS = 200;
const ARDUINO_CLI_LANE_IDLE_POLICY_ID = 'arduino-cli-lane-idle-window-v1';
const ARDUINO_CLI_LANE_IDLE_WINDOW_MS = 500;
// Heavy Arduino-compatible cores can leave a short-lived arduino-cli child
// behind after the measured command returns.  Keep the wait outside measured
// wall time, but allow the same conservative drain window used at startup so
// a valid ESP32/STM32 run is not discarded as a false concurrency failure.
const ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS = 60_000;
const ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS = 100;

const PORTABLE_SKETCH = `#include <Arduino.h>

volatile unsigned long ckCounter = 0;

void setup() {
}

void loop() {
  ckCounter++;
  delay(1);
}
`;

const PORTABLE_EDIT_SEQUENCE = Object.freeze([
  Object.freeze({ id: 'simple', code: PORTABLE_SKETCH }),
  Object.freeze({
    id: 'complex',
    code: `#include <Arduino.h>

struct CkRollingWindow {
  uint16_t values[32];
  uint8_t cursor;
  uint32_t total;
};

volatile uint32_t ckResult = 0;
CkRollingWindow ckWindow = {{0}, 0, 0};

uint16_t ckMix(uint16_t value, uint8_t round) {
  value = (uint16_t)((value << 3) | (value >> 13));
  return (uint16_t)(value ^ (uint16_t)(0x9e37U + (uint16_t)round * 17U));
}

void ckPush(uint16_t value) {
  ckWindow.total -= ckWindow.values[ckWindow.cursor];
  ckWindow.values[ckWindow.cursor] = value;
  ckWindow.total += value;
  ckWindow.cursor = (uint8_t)((ckWindow.cursor + 1U) & 31U);
}

void setup() {
  for (uint8_t index = 0; index < 32U; index++) {
    ckPush((uint16_t)(index * 29U));
  }
}

void loop() {
  uint16_t value = (uint16_t)millis();
  for (uint8_t round = 0; round < 12U; round++) {
    value = ckMix(value, round);
  }
  ckPush(value);
  ckResult = (ckWindow.total >> 5) ^ value;
  delay(1);
}
`,
  }),
  Object.freeze({
    id: 'medium',
    code: `#include <Arduino.h>

volatile uint16_t ckResult = 0;
uint16_t ckSamples[8] = {3, 5, 8, 13, 21, 34, 55, 89};

uint16_t ckAverage() {
  uint16_t total = 0;
  for (uint8_t index = 0; index < 8U; index++) {
    total = (uint16_t)(total + ckSamples[index]);
  }
  return (uint16_t)(total / 8U);
}

void setup() {
}

void loop() {
  const uint8_t slot = (uint8_t)(millis() & 7U);
  ckSamples[slot] = (uint16_t)(ckSamples[slot] + slot + 1U);
  ckResult = ckAverage();
  delay(1);
}
`,
  }),
  Object.freeze({ id: 'simple-return', code: PORTABLE_SKETCH }),
]);

const DEFAULT_SEQUENCE = 'fresh-repeat';
const PORTABLE_EDIT_SEQUENCE_NAME = 'portable-edit';

function measurementStages(sequence = DEFAULT_SEQUENCE) {
  if (sequence === DEFAULT_SEQUENCE) {
    return Object.freeze([
      Object.freeze({ id: 'fresh', code: PORTABLE_SKETCH }),
      Object.freeze({ id: 'repeat', code: PORTABLE_SKETCH }),
    ]);
  }
  if (sequence === PORTABLE_EDIT_SEQUENCE_NAME) return PORTABLE_EDIT_SEQUENCE;
  throw new Error(`unsupported measurement sequence '${sequence}'`);
}

function validatePortableEditSequence(stages = PORTABLE_EDIT_SEQUENCE) {
  const expectedIds = ['simple', 'complex', 'medium', 'simple-return'];
  if (!Array.isArray(stages) || stages.length !== expectedIds.length) return false;
  if (!stages.every((stage, index) => stage?.id === expectedIds[index]
      && typeof stage.code === 'string'
      && stage.code.startsWith('#include <Arduino.h>\n')
      && !/#include\s*[<"](?!Arduino\.h[>"])/u.test(stage.code))) return false;
  const hashes = stages.map((stage) => sha256Bytes(stage.code));
  return hashes[0] === hashes[3] && hashes[0] !== hashes[1] && hashes[1] !== hashes[2]
    && hashes[0] !== hashes[2];
}

function usage() {
  return `Independent same-host CK Forge vs native Arduino CLI A/B runner

Usage:
  node scripts/Run-CKForgeNativeAB.cjs --plan [options]
  node scripts/Run-CKForgeNativeAB.cjs --execute --allow-cache-reset --output <new.json> [options]

Options:
  --fqbn <complete-fqbn>       Target; default ${DEFAULT_FQBN}
  --sequence portable-edit     Measure simple -> complex -> medium -> simple-return edits
  --trials <3..25>             Paired trials; default ${DEFAULT_TRIALS}
  --timeout-minutes <1..60>    Per compile timeout; default ${DEFAULT_TIMEOUT_MINUTES}
  --min-free-gib <1..100>      Abort before C: becomes tight; default ${DEFAULT_MIN_FREE_GIB}
  --require-ck-mode ${REQUIRED_CK_MODE_NATIVE_RELINK}
                               Require every edit capture to use the structured
                               NativeRelink compile-only route with no CLI fallback
  --qualification-operation <compile|upload-ready>
  --qualification-profile <quick-fast|shared-fast|portable-fast>
                               Probe one exact Fast operation/profile pair. These
                               options must be supplied together and never grant a
                               normal product route by themselves. Fast probes always
                               use the fixed portable-edit sequence.
  --candidate-output <new.json>
                               Required for a Fast profile probe. Writes the
                               evaluator-ready performance candidate separately
                               from the immutable raw A/B report.
  --candidate-artifact-bundle <new-directory>
                               Optional with --candidate-output. Preserves one
                               candidate-bound simple-return artifact set for the
                               fail-closed qualification installer. The directory
                               is created only after a valid capture and is never
                               overwritten.
  --failure-log-dir <new-directory>
                               Optional for a Fast profile probe. On a CK Fast
                               Relink fallback, retains the authenticated bounded
                               diagnostic trace and compiler log locally. Raw log
                               text is never projected into the JSON report.
  --keep-workdir               Retain native short-build directories for diagnosis
  --help                       Show this text

Safety and measurement contract:
  * compile-only: no upload, serial access, discovery probe, or physical write;
  * execution requires ${NATIVE_RELINK_QUALIFICATION_TOKEN_ENV}=<64 lowercase hex>
    inherited unchanged by this runner and the production CK process;
  * CK and native use the same bundled CLI, config, Core, complete FQBN,
    exact source bytes and job count;
  * unqualified baselines default to fresh/repeat. Every Fast profile probe and
    explicit --sequence portable-edit compiles four source stages on one
    unchanged lane/build path;
  * before board-details setup, the runner waits for the production desktop's
    Arduino CLI process count to remain zero for a ${ARDUINO_CLI_STARTUP_IDLE_WINDOW_MS / 1000}-second bounded startup
    idle window; this wait is reported separately and is not benchmark time;
  * lane priority alternates CK/native then native/CK;
  * CK uses qualification=true, which denies Exact reuse and forces a compiler
    invocation. Any Exact telemetry fails the run instead of being counted as
    a fresh or repeat compile;
  * the fixed portable-edit source is library-free. Passing it qualifies this
    engine/target timing lane only; library-bearing workloads require the
    separate real-library acceptance matrix and are not proven by this report;
  * measurementStatus reports evidence validity. qualificationStatus separately
    requires every portable edit median to beat native by at least
    ${PERFORMANCE_QUALIFICATION_POLICY.minimumMedianSpeedupPct}% and
    ${PERFORMANCE_QUALIFICATION_POLICY.minimumAbsoluteMedianGainMs} ms, with
    nearest-rank p95 no slower than native. Formal NativeRelink qualification
    requires at least ${PERFORMANCE_QUALIFICATION_POLICY.minimumFormalTrials} paired trials.

Exit codes:
  0  valid measurement and performance-qualified
  2  valid measurement, but performance qualification was refused
  1  invalid arguments, invalid evidence, or failed measurement
`;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function validateFqbn(value) {
  const parts = String(value || '').trim().split(':');
  if (parts.length < 3 || parts.length > 4 || parts.slice(0, 3).some((part) => !part.trim())) {
    throw new Error('--fqbn must be a complete Arduino FQBN');
  }
  if (parts[3] && parts[3].split(',').some((item) => !/^[^=,\s]+=[^=,]+$/u.test(item))) {
    throw new Error('--fqbn contains malformed menu options');
  }
  return value.trim();
}

function canonicalCompleteFqbn(value) {
  if (typeof value !== 'string') return null;
  const parts = value.trim().split(':');
  if (parts.length < 3 || parts.length > 4) return null;
  const base = parts.slice(0, 3).map((part) => part.trim());
  const validToken = (token) => token.length > 0 && !/[\s:,=]/u.test(token);
  const asciiLowercase = (token) => token.replace(/[A-Z]/g, (character) => character.toLowerCase());
  const compareUtf8 = (left, right) => Buffer.compare(
    Buffer.from(left, 'utf8'),
    Buffer.from(right, 'utf8'),
  );
  if (!base.every(validToken)) return null;
  if (parts.length === 3) return base.join(':');

  const rawOptions = parts[3].trim();
  if (!rawOptions) return null;
  const options = [];
  const normalizedKeys = new Set();
  for (const rawOption of rawOptions.split(',')) {
    const separator = rawOption.indexOf('=');
    if (separator <= 0 || separator !== rawOption.lastIndexOf('=')) return null;
    const key = rawOption.slice(0, separator).trim();
    const optionValue = rawOption.slice(separator + 1).trim();
    if (!validToken(key) || !validToken(optionValue)) return null;
    const normalizedKey = asciiLowercase(key);
    if (normalizedKeys.has(normalizedKey)) return null;
    normalizedKeys.add(normalizedKey);
    options.push({ key, normalizedKey, optionValue });
  }
  options.sort((left, right) => (
    compareUtf8(left.normalizedKey, right.normalizedKey)
      || compareUtf8(left.optionValue, right.optionValue)
  ));
  return `${base.join(':')}:${options.map(({ key, optionValue }) => `${key}=${optionValue}`).join(',')}`;
}

function nativeRelinkAdapterFor(fqbn, coreArchitecture = null) {
  const canonical = canonicalCompleteFqbn(fqbn);
  if (!canonical) return null;
  const fqbnMatches = (adapter) => {
    if (adapter.fqbnMatch.kind === 'prefix') return canonical.startsWith(adapter.fqbnMatch.value);
    if (adapter.fqbnMatch.kind === 'exact-base') {
      return canonical === adapter.fqbnMatch.value
        || canonical.startsWith(`${adapter.fqbnMatch.value}:`);
    }
    return false;
  };
  return NATIVE_RELINK_ADAPTERS.find((adapter) => (
    fqbnMatches(adapter)
      && (coreArchitecture == null
        || String(coreArchitecture).trim().toLowerCase() === adapter.coreArchitecture)
  )) || null;
}

function sanitizedChildEnvironment(environment = process.env) {
  const blocked = NATIVE_RELINK_QUALIFICATION_TOKEN_ENV.toUpperCase();
  return Object.fromEntries(Object.entries(environment).filter(
    ([key]) => String(key).toUpperCase() !== blocked,
  ));
}

function qualificationReproducibility(environment = process.env) {
  const sourceDateEpochText = String(environment.SOURCE_DATE_EPOCH ?? '');
  const timeZone = String(environment.TZ ?? '');
  return {
    policyId: QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
    sourceDateEpoch: Number(sourceDateEpochText),
    timeZone,
    passed: sourceDateEpochText === QUALIFICATION_SOURCE_DATE_EPOCH
      && timeZone === QUALIFICATION_TIME_ZONE,
  };
}

function hasQualificationReproducibility(value) {
  return value != null
    && value.policyId === QUALIFICATION_REPRODUCIBILITY_POLICY_ID
    && value.sourceDateEpoch === Number(QUALIFICATION_SOURCE_DATE_EPOCH)
    && value.timeZone === QUALIFICATION_TIME_ZONE
    && value.passed === true;
}

function parseArgs(argv, environment = process.env) {
  const options = {
    action: null,
    fqbn: DEFAULT_FQBN,
    sequence: DEFAULT_SEQUENCE,
    trials: DEFAULT_TRIALS,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    outputPath: null,
    candidateOutputPath: null,
    candidateArtifactBundlePath: null,
    failureLogDirectoryPath: null,
    allowCacheReset: false,
    keepWorkdir: false,
    requireCkMode: null,
    qualificationOperation: null,
    qualificationProfile: null,
    qualificationToken: null,
    help: false,
  };
  const setAction = (action) => {
    if (options.action && options.action !== action) throw new Error('choose exactly one of --plan or --execute');
    options.action = action;
  };
  for (let index = 0; index < argv.length; index += 1) {
    const argument = argv[index];
    if (argument === '--plan') setAction('plan');
    else if (argument === '--execute') setAction('execute');
    else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else if (argument === '--require-ck-mode') {
      const mode = argv[++index];
      if (mode !== REQUIRED_CK_MODE_NATIVE_RELINK) {
        throw new Error(`--require-ck-mode must be ${REQUIRED_CK_MODE_NATIVE_RELINK}`);
      }
      options.requireCkMode = mode;
    }
    else if (argument === '--qualification-operation') {
      const operation = argv[++index];
      if (!FORGE_QUALIFICATION_OPERATIONS.includes(operation)) {
        throw new Error('--qualification-operation must be compile or upload-ready');
      }
      options.qualificationOperation = operation;
    }
    else if (argument === '--qualification-profile') {
      const profile = argv[++index];
      if (!FORGE_QUALIFICATION_PROFILES.includes(profile)) {
        throw new Error('--qualification-profile must be quick-fast, shared-fast, or portable-fast');
      }
      options.qualificationProfile = profile;
    }
    else if (argument === '--fqbn') options.fqbn = validateFqbn(argv[++index]);
    else if (argument === '--sequence') {
      const sequence = argv[++index];
      if (sequence !== PORTABLE_EDIT_SEQUENCE_NAME) {
        throw new Error(`--sequence must be ${PORTABLE_EDIT_SEQUENCE_NAME}`);
      }
      options.sequence = sequence;
    }
    else if (argument === '--trials') options.trials = parseInteger(argv[++index], '--trials', 3, 25);
    else if (argument === '--timeout-minutes') {
      options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    } else if (argument === '--min-free-gib') {
      options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 1, 100);
    } else if (argument === '--output') {
      const output = argv[++index];
      if (!output) throw new Error('--output requires a JSON path');
      options.outputPath = path.resolve(process.cwd(), output);
    } else if (argument === '--candidate-output') {
      const output = argv[++index];
      if (!output) throw new Error('--candidate-output requires a JSON path');
      options.candidateOutputPath = path.resolve(process.cwd(), output);
    } else if (argument === '--candidate-artifact-bundle') {
      const output = argv[++index];
      if (!output) throw new Error('--candidate-artifact-bundle requires a directory path');
      options.candidateArtifactBundlePath = path.resolve(process.cwd(), output);
    } else if (argument === '--failure-log-dir') {
      const output = argv[++index];
      if (!output) throw new Error('--failure-log-dir requires a directory path');
      options.failureLogDirectoryPath = path.resolve(process.cwd(), output);
    } else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan or --execute');
  if (options.outputPath && path.extname(options.outputPath).toLowerCase() !== '.json') {
    throw new Error('--output must use the .json extension');
  }
  if (options.candidateOutputPath
      && path.extname(options.candidateOutputPath).toLowerCase() !== '.json') {
    throw new Error('--candidate-output must use the .json extension');
  }
  if (options.action === 'plan'
      && (options.outputPath || options.candidateOutputPath
        || options.candidateArtifactBundlePath || options.failureLogDirectoryPath
        || options.allowCacheReset)) {
    throw new Error('--plan cannot write output or acknowledge cache reset');
  }
  if (options.requireCkMode && options.sequence !== PORTABLE_EDIT_SEQUENCE_NAME) {
    throw new Error('--require-ck-mode requires --sequence portable-edit because only edit captures are eligible');
  }
  const hasQualificationOperation = options.qualificationOperation != null;
  const hasQualificationProfile = options.qualificationProfile != null;
  if (hasQualificationOperation !== hasQualificationProfile) {
    throw new Error('--qualification-operation and --qualification-profile must be supplied together');
  }
  if (hasQualificationOperation && options.requireCkMode) {
    throw new Error('Fast profile qualification and --require-ck-mode are separate contracts');
  }
  if (hasQualificationOperation) options.sequence = PORTABLE_EDIT_SEQUENCE_NAME;
  if (hasQualificationOperation && options.action === 'execute' && !options.candidateOutputPath) {
    throw new Error('Fast profile qualification requires --candidate-output');
  }
  if (!hasQualificationOperation && options.candidateOutputPath) {
    throw new Error('--candidate-output is valid only for a Fast profile qualification');
  }
  if (!hasQualificationOperation && options.candidateArtifactBundlePath) {
    throw new Error('--candidate-artifact-bundle is valid only for a Fast profile qualification');
  }
  if (!hasQualificationOperation && options.failureLogDirectoryPath) {
    throw new Error('--failure-log-dir is valid only for a Fast profile qualification');
  }
  if (options.candidateArtifactBundlePath && !options.candidateOutputPath) {
    throw new Error('--candidate-artifact-bundle requires --candidate-output');
  }
  if (options.outputPath && options.candidateOutputPath
      && normalizedPath(options.outputPath) === normalizedPath(options.candidateOutputPath)) {
    throw new Error('--output and --candidate-output must be different files');
  }
  if (options.failureLogDirectoryPath
      && [options.outputPath, options.candidateOutputPath, options.candidateArtifactBundlePath]
        .filter(Boolean)
        .some((otherPath) => pathLexicallyWithin(otherPath, options.failureLogDirectoryPath)
          || pathLexicallyWithin(options.failureLogDirectoryPath, otherPath))) {
    throw new Error('--failure-log-dir must be separate from report, candidate, and artifact bundle paths');
  }
  if (options.qualificationOperation === 'compile'
      && !['quick-fast', PORTABLE_FAST_PROFILE].includes(options.qualificationProfile)) {
    throw new Error('compile qualification may probe only quick-fast or portable-fast');
  }
  if (options.qualificationOperation === 'upload-ready'
      && options.qualificationProfile === PORTABLE_FAST_PROFILE) {
    throw new Error('portable-fast qualification supports compile only, not upload-ready');
  }
  if ((options.requireCkMode || hasQualificationOperation)
      && options.trials < PERFORMANCE_QUALIFICATION_POLICY.minimumFormalTrials) {
    throw new Error(
      `formal qualification requires --trials ${PERFORMANCE_QUALIFICATION_POLICY.minimumFormalTrials}..25`,
    );
  }
  if (options.requireCkMode && !nativeRelinkAdapterFor(options.fqbn)) {
    throw new Error(
      '--require-ck-mode has no certified NativeRelink adapter contract for this FQBN; '
      + 'cross-Core baselines may be measured without claiming qualification',
    );
  }
  if (options.action === 'execute') {
    if (!options.outputPath) throw new Error('--execute requires --output');
    if (!options.allowCacheReset) throw new Error('--execute requires explicit --allow-cache-reset');
    if (fs.existsSync(options.outputPath)) throw new Error(`refusing to overwrite existing report: ${options.outputPath}`);
    if (options.candidateOutputPath && fs.existsSync(options.candidateOutputPath)) {
      throw new Error(`refusing to overwrite existing candidate: ${options.candidateOutputPath}`);
    }
    if (options.candidateArtifactBundlePath && fs.existsSync(options.candidateArtifactBundlePath)) {
      throw new Error(`refusing to overwrite existing artifact bundle: ${options.candidateArtifactBundlePath}`);
    }
    if (options.failureLogDirectoryPath && fs.existsSync(options.failureLogDirectoryPath)) {
      throw new Error(`refusing to overwrite existing failure log directory: ${options.failureLogDirectoryPath}`);
    }
    const qualificationToken = String(environment[NATIVE_RELINK_QUALIFICATION_TOKEN_ENV] || '');
    if (!/^[0-9a-f]{64}$/u.test(qualificationToken)) {
      throw new Error(
        `--execute requires ${NATIVE_RELINK_QUALIFICATION_TOKEN_ENV}=<64 lowercase hex> in both the runner and production process`,
      );
    }
    options.qualificationToken = qualificationToken;
  }
  return options;
}

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function sha256File(file) {
  return sha256Bytes(fs.readFileSync(file));
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function digestObject(value) {
  return sha256Bytes(canonicalJson(value));
}

function realpathExisting(value) {
  return fs.realpathSync.native(path.resolve(value));
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathLexicallyWithin(candidate, root) {
  const relative = path.relative(path.resolve(root), path.resolve(candidate));
  return relative === ''
    || (!path.isAbsolute(relative) && relative !== '..' && !relative.startsWith(`..${path.sep}`));
}

function pathIsWithin(candidate, root) {
  const relative = path.relative(realpathExisting(root), realpathExisting(candidate));
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function jsonPayload(value) {
  return Buffer.from(`${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function writeJsonNoClobber(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite existing report: ${outputPath}`);
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, jsonPayload(value), { flag: 'wx' });
    fs.linkSync(temporary, outputPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function nativeTrialBuildPath(workRoot, fqbn, trialIndex = 1) {
  const board = String(fqbn).split(':')[2];
  if (!board) throw new Error('cannot derive native artifact project name from FQBN');
  const projectName = `p_${board.replace(/[^a-z0-9]+/giu, '_')}`;
  return path.join(
    workRoot, 'n', String(trialIndex).padStart(3, '0'), 'build', projectName,
  );
}

function safeBundleArtifactName(index, name) {
  const normalized = String(name || 'artifact').replace(/[^A-Za-z0-9._-]+/gu, '_');
  return `${String(index).padStart(2, '0')}-${normalized || 'artifact'}`;
}

function stagePerformanceArtifactBundle(outputPath, workRoot, fqbn, candidate) {
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite existing artifact bundle: ${outputPath}`);
  const trial = candidate?.lanes?.native?.trials?.[0];
  const artifacts = trial?.['simple-return']?.artifacts;
  if (!trial?.id || !Array.isArray(artifacts) || artifacts.length === 0 || artifacts.length > 64) {
    throw new Error('candidate has no bounded native simple-return artifact set to preserve');
  }
  const sourceRoot = realpathExisting(nativeTrialBuildPath(workRoot, fqbn, 1));
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  const temporary = path.join(
    path.dirname(outputPath),
    `.${path.basename(outputPath)}.${process.pid}.${crypto.randomBytes(8).toString('hex')}.tmp`,
  );
  const manifest = {
    schemaId: 'ck.forge.qualification-artifact-set',
    schemaVersion: 1,
    artifacts: [],
  };
  try {
    fs.mkdirSync(path.join(temporary, 'artifacts'), { recursive: true });
    let totalBytes = 0;
    for (const [index, artifact] of artifacts.entries()) {
      const source = path.join(sourceRoot, artifact.name);
      if (!pathIsWithin(source, sourceRoot)) throw new Error('qualification artifact escaped native build path');
      const metadata = fs.lstatSync(source);
      if (!metadata.isFile() || metadata.isSymbolicLink()
          || metadata.size !== artifact.bytes || metadata.size <= 0
          || sha256File(source) !== artifact.sha256) {
        throw new Error(`native simple-return artifact '${artifact.name}' changed before preservation`);
      }
      totalBytes += metadata.size;
      if (totalBytes > 512 * 1024 * 1024) throw new Error('qualification artifact bundle exceeds 512 MiB');
      const relative = `artifacts/${safeBundleArtifactName(index, artifact.name)}`;
      const destination = path.join(temporary, ...relative.split('/'));
      fs.copyFileSync(source, destination, fs.constants.COPYFILE_EXCL);
      if (sha256File(destination) !== artifact.sha256) {
        throw new Error(`preserved artifact '${artifact.name}' failed post-copy verification`);
      }
      manifest.artifacts.push({ path: relative, size: artifact.bytes, sha256: artifact.sha256 });
    }
    const manifestBytes = jsonPayload(manifest);
    fs.writeFileSync(path.join(temporary, 'artifact-manifest.json'), manifestBytes, { flag: 'wx' });
    return {
      destination: outputPath,
      temporary,
      manifestSha256: sha256Bytes(manifestBytes),
      representativeTrialId: trial.id,
    };
  } catch (error) {
    fs.rmSync(temporary, { recursive: true, force: true });
    throw error;
  }
}

function discardStagedPerformanceArtifactBundle(staged) {
  if (staged?.temporary) fs.rmSync(staged.temporary, { recursive: true, force: true });
}

function publishPerformanceArtifactBundle(staged, candidateBytes, captureReportBytes) {
  if (!staged) return null;
  if (fs.existsSync(staged.destination)) {
    throw new Error(`refusing to overwrite existing artifact bundle: ${staged.destination}`);
  }
  const metadata = {
    schemaId: 'ck.forge.performance-artifact-bundle',
    schemaVersion: 1,
    candidateSha256: sha256Bytes(candidateBytes),
    captureReportSha256: sha256Bytes(captureReportBytes),
    artifactManifestSha256: staged.manifestSha256,
    representativeLane: 'native',
    representativeTrialId: staged.representativeTrialId,
    representativeStage: 'simple-return',
  };
  try {
    fs.writeFileSync(path.join(staged.temporary, 'bundle.json'), jsonPayload(metadata), { flag: 'wx' });
    fs.renameSync(staged.temporary, staged.destination);
  } catch (error) {
    discardStagedPerformanceArtifactBundle(staged);
    throw error;
  }
  return staged.destination;
}

function captureOrder(trials) {
  return Array.from({ length: trials }, (_, index) => (index % 2 === 0 ? 'ck-native' : 'native-ck'));
}

function effectiveJobsFromMaxJobs(maxJobs, environment = process.env, cpuCount = os.cpus().length) {
  const hostDefault = Math.max(1, Math.min(16, Number(cpuCount) || 1));
  if (maxJobs === 0) return hostDefault;
  const respect = /^(?:1|true|yes|on)$/iu.test(String(environment.CK_RESPECT_MAX_JOBS || '').trim());
  return maxJobs === 8 && hostDefault > 8 && !respect ? hostDefault : maxJobs;
}

function effectiveJobs(root = REPO_ROOT, environment = process.env, cpuCount = os.cpus().length) {
  let maxJobs = 0;
  try {
    maxJobs = Number(JSON.parse(fs.readFileSync(path.join(root, 'state', 'compile_accel.json'), 'utf8')).max_jobs) || 0;
  } catch {}
  return effectiveJobsFromMaxJobs(maxJobs, environment, cpuCount);
}

const HOST_ENVIRONMENT_FINGERPRINT_DOMAIN = Buffer.from('ck-forge-host-environment-v2\0', 'utf8');
const HOST_ENVIRONMENT_KEYS = Object.freeze([
  'COMPUTERNAME', 'HOSTNAME', 'NUMBER_OF_PROCESSORS', 'PROCESSOR_ARCHITECTURE', 'PROCESSOR_IDENTIFIER',
]);

function normalizedHostOs(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (normalized === 'win32' || normalized === 'windows') return 'windows';
  if (normalized === 'darwin' || normalized === 'macos' || normalized === 'osx') return 'macos';
  return normalized;
}

function normalizedHostArch(value) {
  const normalized = String(value || '').trim().toLowerCase();
  if (['x64', 'amd64', 'x86_64'].includes(normalized)) return 'x86_64';
  if (['ia32', 'i386', 'i486', 'i586', 'i686', 'x86'].includes(normalized)) return 'x86';
  if (normalized === 'arm64' || normalized === 'aarch64') return 'aarch64';
  return normalized;
}

function normalizedHostSysroot(value, normalizedOs) {
  let normalized = String(value || '').replaceAll('\\', '/');
  if (normalizedOs === 'windows') {
    if (normalized.startsWith('//?/UNC/')) normalized = `//${normalized.slice('//?/UNC/'.length)}`;
    else if (normalized.startsWith('//?/')) normalized = normalized.slice('//?/'.length);
    normalized = normalized.replace(/[A-Z]/gu, (character) => character.toLowerCase());
  }
  while (normalized.endsWith('/') && normalized.length > 1
      && !(normalizedOs === 'windows' && normalized.length === 3 && normalized[1] === ':')) {
    normalized = normalized.slice(0, -1);
  }
  return normalized;
}

// Shared with ck_forge.rs: domain bytes, followed by UTF-8 fields framed with
// unsigned 64-bit little-endian byte lengths. Do not replace these explicit
// normalizers with language runtime labels (`win32` vs `windows`, `x64` vs
// `x86_64`) or platform-specific canonical path spelling.
function hostEnvironmentFingerprintFromParts(
  hostOs,
  hostArch,
  canonicalRoot,
  environment = {},
) {
  const normalizedOs = normalizedHostOs(hostOs);
  const fields = [
    `os=${normalizedOs}`,
    `arch=${normalizedHostArch(hostArch)}`,
    `sysroot=${normalizedHostSysroot(canonicalRoot, normalizedOs)}`,
    ...HOST_ENVIRONMENT_KEYS.map((key) => `${key}=${environment[key] ?? '<unset>'}`),
  ];
  const hash = crypto.createHash('sha256');
  hash.update(HOST_ENVIRONMENT_FINGERPRINT_DOMAIN);
  for (const field of fields) {
    const bytes = Buffer.from(field, 'utf8');
    const length = Buffer.alloc(8);
    length.writeBigUInt64LE(BigInt(bytes.length));
    hash.update(length);
    hash.update(bytes);
  }
  return hash.digest('hex');
}

function hostEnvironmentFingerprint(root = REPO_ROOT, environment = process.env) {
  return hostEnvironmentFingerprintFromParts(
    process.platform,
    process.arch,
    realpathExisting(root),
    environment,
  );
}

function freeBytesAt(value) {
  const stats = fs.statfsSync(value);
  return Number(stats.bavail) * Number(stats.bsize);
}

function windowsTaskkillArgs(pid) {
  if (!Number.isSafeInteger(pid) || pid <= 0) {
    throw new Error('owned process-tree termination requires a positive root PID');
  }
  return ['/PID', String(pid), '/T', '/F'];
}

function terminateOwnedProcessTree(child, environment = process.env) {
  const pid = Number(child?.pid);
  if (!Number.isSafeInteger(pid) || pid <= 0 || child.exitCode != null) return false;
  if (process.platform === 'win32') {
    const windowsRoot = environment.SystemRoot || environment.WINDIR;
    const taskkill = windowsRoot
      ? path.join(windowsRoot, 'System32', 'taskkill.exe')
      : 'taskkill.exe';
    try {
      execFileSync(taskkill, windowsTaskkillArgs(pid), {
        windowsHide: true,
        stdio: 'ignore',
        timeout: 10_000,
        env: sanitizedChildEnvironment(environment),
      });
      return true;
    } catch {
      // The root may have exited between the guard and taskkill. Fall back to
      // Node's handle, still scoped to the exact child created by this runner.
      try { return child.kill(); } catch { return false; }
    }
  }
  try {
    process.kill(-pid, 'SIGKILL');
    return true;
  } catch {
    try { return child.kill('SIGKILL'); } catch { return false; }
  }
}

function assertFreeSpace(value, minimumGiB) {
  const freeBytes = freeBytesAt(value);
  const requiredBytes = minimumGiB * 1024 ** 3;
  if (!Number.isFinite(freeBytes) || freeBytes < requiredBytes) {
    throw new Error(`free-space guard failed: ${(freeBytes / 1024 ** 3).toFixed(2)} GiB < ${minimumGiB} GiB`);
  }
  return freeBytes;
}

function inspectRunner() {
  const file = realpathExisting(__filename);
  const stat = fs.statSync(file);
  return { fileName: path.basename(file), bytes: stat.size, sha256: sha256File(file) };
}

function ordinaryProductionExecutable(value, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${label} is missing or invalid`);
  }
  if (!path.isAbsolute(value)) throw new Error(`${label} must be an absolute path`);
  const lexical = path.resolve(value);
  const lexicalStat = fs.lstatSync(lexical);
  if (!lexicalStat.isFile() || lexicalStat.isSymbolicLink()) {
    throw new Error(`${label} must be an ordinary file`);
  }
  const real = realpathExisting(lexical);
  if (path.basename(real).toLowerCase() !== 'appsdesktop.exe') {
    throw new Error(`${label} must name appsdesktop.exe`);
  }
  return real;
}

function productionExecutableBindingContract(environment = process.env) {
  const customPath = String(environment[PRODUCTION_EXECUTABLE_PATH_ENV] || '').trim();
  const customSha256 = String(environment[PRODUCTION_EXECUTABLE_SHA256_ENV] || '').trim();
  const processIdText = String(environment[PRODUCTION_PROCESS_ID_ENV] || '').trim();
  const explicitOverride = customPath !== '' || customSha256 !== '';
  if (explicitOverride && (customPath === '' || customSha256 === '' || processIdText === '')) {
    throw new Error(
      `${PRODUCTION_EXECUTABLE_PATH_ENV}, ${PRODUCTION_EXECUTABLE_SHA256_ENV}, and ${PRODUCTION_PROCESS_ID_ENV} must be provided together`,
    );
  }
  if (customSha256 !== '' && !/^[a-f0-9]{64}$/iu.test(customSha256)) {
    throw new Error(`${PRODUCTION_EXECUTABLE_SHA256_ENV} must be a SHA-256 digest`);
  }
  let expectedProcessId = null;
  if (processIdText !== '') {
    if (!/^\d+$/u.test(processIdText)) throw new Error(`${PRODUCTION_PROCESS_ID_ENV} must be a positive integer`);
    expectedProcessId = Number(processIdText);
    if (!Number.isSafeInteger(expectedProcessId) || expectedProcessId <= 0) {
      throw new Error(`${PRODUCTION_PROCESS_ID_ENV} must be a positive integer`);
    }
  }
  const expectedPath = ordinaryProductionExecutable(
    explicitOverride
      ? customPath
      : path.join(REPO_ROOT, 'target', 'release', 'appsdesktop.exe'),
    explicitOverride ? PRODUCTION_EXECUTABLE_PATH_ENV : 'default production executable',
  );
  const observedSha256 = sha256File(expectedPath);
  const expectedSha256 = explicitOverride ? customSha256.toLowerCase() : observedSha256;
  if (observedSha256 !== expectedSha256) {
    throw new Error(`${PRODUCTION_EXECUTABLE_SHA256_ENV} does not match the expected executable`);
  }
  return Object.freeze({
    schemaVersion: 1,
    mode: explicitOverride ? 'explicit-candidate' : 'repository-production-default',
    expectedPath,
    expectedPathNormalized: normalizedPath(expectedPath),
    expectedPathSha256: sha256Bytes(normalizedPath(expectedPath)),
    expectedSha256,
    expectedProcessId,
    explicitOverride,
  });
}

function validateProductionProcessBinding(processInfo, contract) {
  const appProcessId = Number(processInfo?.appPid);
  const listenerProcessId = Number(processInfo?.listenerPid);
  if (!Number.isSafeInteger(appProcessId) || appProcessId <= 0
      || !Number.isSafeInteger(listenerProcessId) || listenerProcessId <= 0) {
    throw new Error('CDP production process binding returned invalid process identifiers');
  }
  const actual = ordinaryProductionExecutable(
    String(processInfo?.path || ''), 'CDP production executable',
  );
  if (normalizedPath(actual) !== contract.expectedPathNormalized) {
    if (!contract.explicitOverride) {
      throw new Error('CDP is not owned by target/release/appsdesktop.exe');
    }
    throw new Error(`CDP is not owned by ${PRODUCTION_EXECUTABLE_PATH_ENV}`);
  }
  if (contract.expectedProcessId != null && contract.expectedProcessId !== appProcessId) {
    throw new Error(`${PRODUCTION_PROCESS_ID_ENV} does not match the independently resolved production process`);
  }
  const executableSha256 = sha256File(actual);
  if (executableSha256 !== contract.expectedSha256) {
    throw new Error('CDP production executable SHA-256 changed or did not match its binding');
  }
  const stat = fs.statSync(actual);
  return {
    bindingSchemaVersion: contract.schemaVersion,
    bindingMode: contract.mode,
    appProcessId,
    cdpListenerProcessId: listenerProcessId,
    executablePath: actual,
    executablePathSha256: contract.expectedPathSha256,
    executableFileName: path.basename(actual),
    executableBytes: stat.size,
    executableSha256,
  };
}

function inspectProductionExecutable(environment = process.env) {
  if (process.platform !== 'win32') throw new Error('production process binding currently requires Windows');
  const contract = productionExecutableBindingContract(environment);
  const script = `
$ErrorActionPreference = 'Stop'
[Console]::OutputEncoding = New-Object System.Text.UTF8Encoding($false)
$owners = @(Get-NetTCPConnection -LocalPort ${CDP_PORT} -State Listen -ErrorAction Stop | Select-Object -ExpandProperty OwningProcess -Unique)
if ($owners.Count -ne 1) { throw "Expected one CDP listener owner, found $($owners.Count)" }
$listener = Get-CimInstance Win32_Process -Filter "ProcessId = $($owners[0])" -ErrorAction Stop
$current = $listener
$app = $null
for ($depth = 0; $depth -lt 8 -and $null -ne $current; $depth += 1) {
  if ([string]$current.Name -ieq 'appsdesktop.exe') { $app = $current; break }
  $parentId = [int]$current.ParentProcessId
  if ($parentId -le 0) { break }
  $current = Get-CimInstance Win32_Process -Filter "ProcessId = $parentId" -ErrorAction SilentlyContinue
}
if ($null -eq $app) { throw 'CDP listener ancestry did not resolve to appsdesktop.exe' }
[PSCustomObject]@{ listenerPid = [int]$listener.ProcessId; appPid = [int]$app.ProcessId; path = [string]$app.ExecutablePath } | ConvertTo-Json -Compress
`;
  const processInfo = JSON.parse(execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 1024 * 1024,
    env: sanitizedChildEnvironment(environment),
  }).trim());
  return validateProductionProcessBinding(processInfo, contract);
}

function arduinoCliProcessCount(environment = process.env) {
  if (process.platform !== 'win32') return 0;
  const raw = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command',
    "@(Get-Process -Name 'arduino-cli' -ErrorAction SilentlyContinue).Count",
  ], { encoding: 'utf8', windowsHide: true, env: sanitizedChildEnvironment(environment) }).trim();
  const count = Number(raw);
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Arduino CLI process count was not a non-negative integer: ${raw || 'unknown'}`);
  }
  return count;
}

function arduinoCliProcessDetails(environment = process.env) {
  if (process.platform !== 'win32') return [];
  const script = `
$items = @(Get-CimInstance Win32_Process -Filter "Name = 'arduino-cli.exe'" -ErrorAction Stop | ForEach-Object {
  [PSCustomObject]@{
    processId = [int]$_.ProcessId
    parentProcessId = [int]$_.ParentProcessId
    creationDate = [string]$_.CreationDate
  }
})
ConvertTo-Json -InputObject $items -Compress
`;
  const raw = execFileSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', script,
  ], { encoding: 'utf8', windowsHide: true, env: sanitizedChildEnvironment(environment) }).trim();
  const parsed = raw ? JSON.parse(raw) : [];
  const processes = Array.isArray(parsed) ? parsed : [parsed];
  return processes.map((entry) => {
    const processId = Number(entry?.processId);
    const parentProcessId = Number(entry?.parentProcessId);
    if (!Number.isSafeInteger(processId) || processId <= 0
        || !Number.isSafeInteger(parentProcessId) || parentProcessId < 0) {
      throw new Error('Arduino CLI process details contained an invalid process identity');
    }
    return {
      processId,
      parentProcessId,
      creationDate: String(entry?.creationDate || ''),
    };
  });
}

function assertNoConcurrentArduinoCli(readProcessCount = () => arduinoCliProcessCount()) {
  const count = readProcessCount();
  if (!Number.isSafeInteger(count) || count < 0) {
    throw new Error(`Arduino CLI process reader returned an invalid count: ${count}`);
  }
  if (count !== 0) {
    throw new Error(`no-concurrent-compile guard found ${count} active arduino-cli process(es)`);
  }
}

/**
 * Wait until the desktop's startup Arduino CLI activity has been absent for a
 * complete, bounded stability window.  The process-count reader and clock are
 * injectable so this policy can be tested without spawning PowerShell.  This
 * function is intentionally separate from the lane guard: it only runs once
 * before benchmark setup and never permits concurrent lane compiles.
 */
async function waitForArduinoCliIdleWindow({
  idleWindowMs = ARDUINO_CLI_STARTUP_IDLE_WINDOW_MS,
  timeoutMs = ARDUINO_CLI_STARTUP_IDLE_TIMEOUT_MS,
  pollIntervalMs = ARDUINO_CLI_STARTUP_POLL_INTERVAL_MS,
  policyId = ARDUINO_CLI_STARTUP_IDLE_POLICY_ID,
  phaseLabel = 'startup',
  readProcessCount = () => arduinoCliProcessCount(),
  readProcessDetails = null,
  sleep = (durationMs) => new Promise((resolve) => setTimeout(resolve, durationMs)),
  now = () => Date.now(),
} = {}) {
  for (const [label, value] of [
    ['idleWindowMs', idleWindowMs],
    ['timeoutMs', timeoutMs],
    ['pollIntervalMs', pollIntervalMs],
  ]) {
    if (!Number.isSafeInteger(value) || value <= 0) {
      throw new Error(`${label} must be a positive integer`);
    }
  }
  if (idleWindowMs > timeoutMs) {
    throw new Error('idleWindowMs must not exceed timeoutMs');
  }
  const startedAt = now();
  let idleSince = null;
  let lastCount = null;
  let polls = 0;
  for (;;) {
    lastCount = await readProcessCount();
    if (!Number.isSafeInteger(lastCount) || lastCount < 0) {
      throw new Error(`Arduino CLI process reader returned an invalid count: ${lastCount}`);
    }
    polls += 1;
    const sampledAt = now();
    if (lastCount === 0) {
      if (idleSince === null) idleSince = sampledAt;
      if (sampledAt - idleSince >= idleWindowMs) {
        return {
          policyId,
          idleWindowMs,
          timeoutMs,
          pollIntervalMs,
          waitedMs: sampledAt - startedAt,
          polls,
        };
      }
    } else {
      idleSince = null;
    }
    const elapsed = sampledAt - startedAt;
    if (elapsed >= timeoutMs) {
      let processes = [];
      let processDetailsError = null;
      if (typeof readProcessDetails === 'function') {
        try {
          const observed = await readProcessDetails();
          processes = Array.isArray(observed) ? observed : [];
        } catch (error) {
          processDetailsError = String(error?.message || error);
        }
      }
      const error = new Error(
        `Arduino CLI ${phaseLabel} did not reach a ${idleWindowMs}ms idle window within ${timeoutMs}ms `
        + `(last observed process count: ${lastCount})`,
      );
      error.code = 'ARDUINO_CLI_IDLE_TIMEOUT';
      error.phaseLabel = phaseLabel;
      error.lastProcessCount = lastCount;
      error.processes = processes;
      error.processDetailsError = processDetailsError;
      throw error;
    }
    await sleep(Math.min(pollIntervalMs, timeoutMs - elapsed));
  }
}

/**
 * Read the production backend settings and then prove that any CLI work caused
 * by that CDP preflight has fully settled before trial 1 is created. The idle
 * wait is deliberately outside measured compile walls. It complements rather
 * than replaces the zero-process assertion at the start of every lane.
 */
async function runCdpPreflightAndWaitForPreTrialStability({
  evaluate,
  compileTimeoutMs,
  expectedJobs,
  waitForIdle = waitForArduinoCliIdleWindow,
} = {}) {
  if (typeof evaluate !== 'function') throw new Error('CDP evaluate must be a function');
  if (!Number.isSafeInteger(expectedJobs) || expectedJobs <= 0) {
    throw new Error('expectedJobs must be a positive integer');
  }
  const preflight = await evaluate(`(async () => ({
    invokeAvailable: typeof window.__TAURI_INTERNALS__?.invoke === 'function',
    url: location.href,
    compileSettings: await window.__TAURI_INTERNALS__.invoke('get_compile_accel_settings')
  }))()`, cdpPreflightTimeoutMs(compileTimeoutMs));
  if (!preflight?.invokeAvailable) throw new Error('production page has no Tauri invoke bridge');
  const backendMaxJobs = Number(preflight.compileSettings?.max_jobs) || 0;
  const backendJobs = effectiveJobsFromMaxJobs(backendMaxJobs);
  if (backendJobs !== expectedJobs) {
    throw new Error(`production backend jobs=${backendJobs} did not match native jobs=${expectedJobs}`);
  }
  const idle = await waitForIdle({
    idleWindowMs: ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS,
    timeoutMs: ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS,
    pollIntervalMs: ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS,
    policyId: ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID,
    phaseLabel: 'post-CDP preflight',
  });
  return {
    compileSettings: preflight.compileSettings,
    backendJobs,
    stability: {
      ...idle,
      trigger: 'get_compile_accel_settings',
      outsideMeasuredCompileWallTime: true,
      completedBeforeFirstLane: true,
    },
  };
}

function sameIdentity(left, right) {
  return canonicalJson(left) === canonicalJson(right);
}

async function getCdpTarget() {
  const response = await fetch(CDP_LIST_URL, { signal: AbortSignal.timeout(10_000) });
  if (!response.ok) throw new Error(`CDP target list returned HTTP ${response.status}`);
  const targets = await response.json();
  const pages = targets.filter((target) => target.type === 'page' && target.url === 'http://tauri.localhost/');
  if (pages.length !== 1) throw new Error(`expected one production CK page, found ${pages.length}`);
  return pages[0];
}

function createCdp(webSocketDebuggerUrl) {
  const WebSocket = require(path.join(REPO_ROOT, 'apps', 'desktop', 'node_modules', 'ws'));
  const socket = new WebSocket(webSocketDebuggerUrl);
  const pending = new Map();
  let nextId = 0;
  const opened = new Promise((resolve, reject) => {
    socket.once('open', resolve);
    socket.once('error', reject);
  });
  socket.on('message', (raw) => {
    const message = JSON.parse(raw);
    const request = pending.get(message.id);
    if (!request) return;
    pending.delete(message.id);
    if (message.error) request.reject(new Error(message.error.message));
    else request.resolve(message.result);
  });
  socket.on('close', () => {
    for (const request of pending.values()) request.reject(new Error('CDP socket closed'));
    pending.clear();
  });
  async function call(method, params) {
    await opened;
    return new Promise((resolve, reject) => {
      const id = ++nextId;
      pending.set(id, { resolve, reject });
      socket.send(JSON.stringify({ id, method, params }));
    });
  }
  async function evaluate(expression, timeoutMs) {
    let timer;
    try {
      return await Promise.race([
        call('Runtime.evaluate', { expression, awaitPromise: true, returnByValue: true }).then((result) => {
          if (result.exceptionDetails) throw new Error(result.exceptionDetails.exception?.description || result.exceptionDetails.text);
          return result.result.value;
        }),
        new Promise((_, reject) => {
          timer = setTimeout(() => reject(new Error('CDP compile timed out')), timeoutMs);
        }),
      ]);
    } finally {
      clearTimeout(timer);
    }
  }
  return { socket, evaluate };
}

function cdpPreflightTimeoutMs(compileTimeoutMs) {
  if (!Number.isFinite(compileTimeoutMs) || compileTimeoutMs <= 0) {
    throw new Error('compile timeout must be a positive finite duration');
  }
  // The first Tauri invoke can legitimately initialize the managed sysroot on
  // a cold desktop start. Ten seconds was too short on Windows and produced a
  // false benchmark failure before trial 1. Keep this bounded independently
  // from a potentially much longer per-compile timeout.
  return Math.min(compileTimeoutMs, 60_000);
}

function artifactRole(name, adapter = null) {
  const normalized = String(name || '').toLowerCase();
  if (normalized === '.ck-upload-artifacts.json' || normalized === 'upload-manifest.json') {
    return 'upload-manifest';
  }
  if (adapter?.id === SAMD_MKRZERO_NATIVE_RELINK_ADAPTER.id) {
    if (/\.with_bootloader\.bin$/u.test(normalized)) return 'samd-with-bootloader-bin';
    if (/\.with_bootloader\.hex$/u.test(normalized)) return 'samd-with-bootloader-hex';
    if (/\.ino\.bin$/u.test(normalized)) return 'samd-application-bin';
    if (/\.ino\.hex$/u.test(normalized)) return 'samd-application-hex';
    if (/\.uf2$/u.test(normalized)) return 'samd-uf2';
  }
  if (/\.ino\.with_bootloader\.hex$/u.test(normalized)) return 'avr-with-bootloader';
  if (/\.ino\.bootloader\.bin$/u.test(normalized)) return 'bootloader-bin';
  if (/\.ino\.partitions\.bin$/u.test(normalized)) return 'partitions-bin';
  if (/\.ino\.merged\.bin$/u.test(normalized)) return 'merged-firmware-bin';
  if (/\.ino\.boot_app0\.bin$/u.test(normalized)) return 'boot-app0-bin';
  if (/\.ino\.spiffs\.bin$/u.test(normalized)) return 'spiffs-image-bin';
  if (/\.ino\.littlefs\.bin$/u.test(normalized)) return 'littlefs-image-bin';
  if (/\.ino\.fatfs\.bin$/u.test(normalized)) return 'fatfs-image-bin';
  if (/\.ino\.hex$/u.test(normalized)) return 'avr-application-hex';
  if (/\.eep$/u.test(normalized)) return 'avr-eeprom';
  if (/\.ino\.elf$/u.test(normalized)) return 'application-elf';
  if (/\.ino\.bin$/u.test(normalized)) return 'application-bin';
  if (/\.with_bootloader\.bin$/u.test(normalized)) return 'with-bootloader-bin';
  if (normalized === 'flash_args') return 'flash-arguments';
  return 'auxiliary-firmware';
}

function validEspApplicationPayloadRecipeProof(proof, core = null) {
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
      || !isSafeCorePathComponent(proof.corePackage)
      || String(proof.coreArchitecture || '').toLowerCase() !== 'esp32'
      || !isSafeCorePathComponent(proof.coreVersion)
      || !/^[0-9a-f]{64}$/u.test(String(proof.recipeSourceSha256 || ''))
      || !/^[0-9a-f]{64}$/u.test(String(proof.recipeValueSha256 || ''))
      || proof.elfSha256OffsetArgument !== ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT
      || proof.elfSha256Offset !== ESP_APPLICATION_BIN_ELF_SHA256_OFFSET) return false;
  return core == null || (
    proof.corePackage === core.corePackage
      && proof.coreArchitecture === core.coreArchitecture
      && proof.coreVersion === core.coreVersion
  );
}

function espApplicationImageFooterEvidence(image) {
  // ESP32-family images use a 24-byte header followed by segment headers and
  // payloads. The last 33 bytes are a derived XOR checksum and SHA-256
  // validation digest. They legitimately change when the embedded ELF digest
  // changes, so they are validated rather than compared byte-for-byte.
  if (!Buffer.isBuffer(image) || image.length < 24 + ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH
      || image[0] !== 0xe9 || image[1] < 1 || image[1] > 16 || image[23] !== 1) {
    return null;
  }
  let cursor = 24;
  let checksum = 0xef;
  for (let index = 0; index < image[1]; index += 1) {
    if (cursor + 8 > image.length) return null;
    const segmentLength = image.readUInt32LE(cursor + 4);
    cursor += 8;
    if (segmentLength > image.length - cursor) return null;
    for (let offset = 0; offset < segmentLength; offset += 1) checksum ^= image[cursor + offset];
    cursor += segmentLength;
  }
  const checksumOffset = cursor + ((15 - (cursor % 16)) % 16);
  const validationHashOffset = checksumOffset + 1;
  if (validationHashOffset + 32 !== image.length || image[checksumOffset] !== checksum) return null;
  const validationHash = image.subarray(validationHashOffset);
  const computedValidationHash = crypto.createHash('sha256')
    .update(image.subarray(0, validationHashOffset))
    .digest();
  if (!crypto.timingSafeEqual(validationHash, computedValidationHash)) return null;
  return {
    offset: checksumOffset,
    length: ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH,
    checksumOffset,
    checksum: image[checksumOffset],
    validationHash: validationHash.toString('hex'),
    checksumValid: true,
    validationHashValid: true,
  };
}

function espApplicationBinPayloadEquivalenceWitness(file, byteLength, recipeProof) {
  if (!validEspApplicationPayloadRecipeProof(recipeProof)) {
    throw new Error('ESP application payload witness requires an explicit resolved recipe proof');
  }
  const minimumLength = ESP_APPLICATION_BIN_ELF_SHA256_OFFSET
    + ESP_APPLICATION_BIN_ELF_SHA256_LENGTH
    + ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH;
  if (!Number.isSafeInteger(byteLength) || byteLength < minimumLength) {
    throw new Error('ESP application image is too short for the fixed ELF SHA-256 witness layout');
  }
  const image = fs.readFileSync(file);
  if (image.length !== byteLength) {
    throw new Error('ESP application image changed while creating payload equivalence witness');
  }
  const mutableEnd = ESP_APPLICATION_BIN_ELF_SHA256_OFFSET + ESP_APPLICATION_BIN_ELF_SHA256_LENGTH;
  const footer = espApplicationImageFooterEvidence(image);
  if (footer == null || footer.offset !== byteLength - ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH) {
    throw new Error('ESP application image footer checksum/SHA validation failed');
  }
  return {
    schemaVersion: ESP_APPLICATION_BIN_PAYLOAD_WITNESS_SCHEMA_VERSION,
    kind: ESP_APPLICATION_BIN_PAYLOAD_WITNESS_KIND,
    recipe: {
      elfSha256OffsetArgument: ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT,
      elfSha256Offset: ESP_APPLICATION_BIN_ELF_SHA256_OFFSET,
    },
    byteLength,
    mutableRange: {
      offset: ESP_APPLICATION_BIN_ELF_SHA256_OFFSET,
      length: ESP_APPLICATION_BIN_ELF_SHA256_LENGTH,
    },
    immutableSegments: [
      {
        offset: 0,
        length: ESP_APPLICATION_BIN_ELF_SHA256_OFFSET,
        sha256: sha256Bytes(image.subarray(0, ESP_APPLICATION_BIN_ELF_SHA256_OFFSET)),
      },
      {
        offset: mutableEnd,
        length: footer.offset - mutableEnd,
        sha256: sha256Bytes(image.subarray(mutableEnd, footer.offset)),
      },
    ],
    footer,
  };
}

function espFlashArgumentsWitness(file, byteLength, buildRoot, adapter = null) {
  const raw = fs.readFileSync(file);
  if (raw.length !== byteLength) {
    throw new Error('flash_args changed while creating the normalized witness');
  }
  const optionLines = [];
  const segments = [];
  const seenOffsets = new Set();
  for (const line of raw.toString('utf8').split(/\r?\n/u)) {
    const normalized = line.trim().replace(/\s+/gu, ' ');
    if (normalized.length === 0) continue;
    const segment = /^(0x[0-9a-fA-F]+) (\S+)$/u.exec(normalized);
    if (segment == null) {
      optionLines.push(normalized);
      continue;
    }
    const offset = Number.parseInt(segment[1], 16);
    const reference = segment[2];
    if (!Number.isSafeInteger(offset) || offset < 0 || seenOffsets.has(offset)) {
      throw new Error('flash_args lists an invalid or duplicate flash offset');
    }
    seenOffsets.add(offset);
    if (reference !== path.basename(reference) || reference === '.' || reference === '..') {
      throw new Error('flash_args must reference plain file names inside the build path');
    }
    const referencedPath = path.join(buildRoot, reference);
    if (!fs.existsSync(referencedPath)) {
      // Core-package constants (e.g. boot_app0.bin) are flashed straight from
      // the shared Core installation and never materialize in the build path.
      // Record the exact reference so both lanes must agree on the layout;
      // content provenance is bound by the identical Core/toolchain identity.
      segments.push({
        offset,
        role: artifactRole(reference, adapter),
        resolved: false,
        reference,
      });
      continue;
    }
    if (!pathIsWithin(referencedPath, buildRoot)) {
      throw new Error('flash_args reference escaped the build path');
    }
    const referencedStat = fs.statSync(referencedPath);
    if (!referencedStat.isFile() || referencedStat.size <= 0) {
      throw new Error(`flash_args references a non-file or empty payload: ${reference}`);
    }
    segments.push({
      offset,
      role: artifactRole(reference, adapter),
      resolved: true,
      reference,
      bytes: referencedStat.size,
      sha256: sha256File(referencedPath),
    });
  }
  if (segments.length === 0) {
    throw new Error('flash_args lists no flash segments');
  }
  return {
    schemaVersion: ESP_FLASH_ARGS_WITNESS_SCHEMA_VERSION,
    kind: ESP_FLASH_ARGS_WITNESS_KIND,
    byteLength,
    optionLines,
    segments,
  };
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
          || !/^[0-9a-f]{64}$/u.test(String(segment.sha256 || ''))) return false;
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

function artifactEntry(file, buildRoot, primaryNames, adapter = null, payloadRecipeProof = null) {
  if (!pathIsWithin(file, buildRoot)) throw new Error('artifact escaped build path');
  const stat = fs.statSync(file);
  if (!stat.isFile() || stat.size <= 0) throw new Error(`artifact is empty: ${path.basename(file)}`);
  const name = path.basename(file);
  const role = artifactRole(name, adapter);
  const artifact = {
    name,
    bytes: stat.size,
    sha256: sha256File(file),
    primaryApplication: primaryNames.has(name),
    role,
  };
  if (role === 'application-bin' && payloadRecipeProof != null) {
    artifact.payloadEquivalenceWitness = espApplicationBinPayloadEquivalenceWitness(
      file,
      stat.size,
      payloadRecipeProof,
    );
  }
  if (role === 'flash-arguments' && payloadRecipeProof != null) {
    artifact.flashArgumentsWitness = espFlashArgumentsWitness(
      file,
      stat.size,
      buildRoot,
      adapter,
    );
  }
  return artifact;
}

const TOP_LEVEL_QUALIFICATION_ARTIFACT = /^(?:.+\.ino(?:\.[^.]+)*\.(?:elf|bin|hex)|.+\.with_bootloader\.(?:bin|hex)|.+\.eep|.+\.uf2|flash_args|\.ck-upload-artifacts\.json|upload-manifest\.json)$/iu;

function inspectNativeArtifacts(buildPath, projectName, adapter = null, payloadRecipeProof = null) {
  const primaryNames = new Set([
    `${projectName}.ino.elf`, `${projectName}.ino.bin`, `${projectName}.ino.hex`,
  ]);
  const artifacts = fs.readdirSync(buildPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TOP_LEVEL_QUALIFICATION_ARTIFACT.test(entry.name))
    .map((entry) => artifactEntry(
      path.join(buildPath, entry.name), buildPath, primaryNames, adapter, payloadRecipeProof,
    ))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  if (!artifacts.some((artifact) => artifact.primaryApplication)) {
    throw new Error('native compile produced no primary application artifact');
  }
  return artifacts;
}

function inspectCkArtifacts(parsed, adapter = null, payloadRecipeProof = null) {
  if (!parsed?.path) throw new Error('CK compile omitted build path');
  const buildPath = realpathExisting(parsed.path);
  const projectName = path.basename(buildPath);
  const primaryNames = new Set([
    `${projectName}.ino.elf`, `${projectName}.ino.bin`, `${projectName}.ino.hex`,
  ]);
  // Silent qualification intentionally omits the frontend artifact list.  The
  // runner independently inspects only regular top-level firmware outputs
  // inside the canonical build directory returned by CK.
  const artifacts = fs.readdirSync(buildPath, { withFileTypes: true })
    .filter((entry) => entry.isFile() && TOP_LEVEL_QUALIFICATION_ARTIFACT.test(entry.name))
    .map((entry) => artifactEntry(
      path.join(buildPath, entry.name), buildPath, primaryNames, adapter, payloadRecipeProof,
    ))
    .sort((left, right) => Buffer.from(left.name).compare(Buffer.from(right.name)));
  if (!artifacts.some((artifact) => artifact.primaryApplication)) {
    throw new Error('CK compile produced no primary application artifact');
  }
  return artifacts;
}

function parseResources(text) {
  const normalized = String(text || '').replace(/\u001b\[[0-9;]*m/gu, '');
  const lastNumber = (pattern) => {
    const matches = [...normalized.matchAll(pattern)];
    if (matches.length === 0) return null;
    const value = Number(matches[matches.length - 1][1]);
    return Number.isSafeInteger(value) && value >= 0 ? value : null;
  };
  // Same counting rule as CK's compiler evidence: any output line containing
  // a case-insensitive "warning:" marker is one warning.
  const warningCount = normalized
    .split(/\r?\n/u)
    .filter((line) => line.toLowerCase().includes('warning:'))
    .length;
  const flash = lastNumber(/Sketch uses\s+(\d+)\s+bytes/giu);
  const ram = lastNumber(/Global variables use\s+(\d+)\s+bytes/giu);
  if (flash != null && ram != null) {
    return {
      evidenceComplete: true, flashUsedBytes: flash, ramUsedBytes: ram, warningCount,
    };
  }

  // ESP8266 Core 3.x does not emit the generic Arduino "Sketch uses" lines.
  // Match the same complete four-segment evidence contract as CK's resource
  // panel: IROM + IRAM + DATA + RODATA is the measured program footprint,
  // while the Core's RAM heading is the authoritative aggregate RAM usage.
  // Requiring every segment prevents an IROM-only line from being mislabeled
  // as total Flash usage.
  const esp8266Ram = lastNumber(/^\.\s*Variables and constants in RAM.*?used\s+(\d+)\s*\//gimu);
  const esp8266Segments = [
    /^[^\r\n]*\bIROM\s+(\d+)\s+code in flash\s*$/gimu,
    /^[^\r\n]*\bIRAM\s+(\d+)\s+code in IRAM\s*$/gimu,
    /^[^\r\n]*\bDATA\s+(\d+)\s+initialized variables\s*$/gimu,
    /^[^\r\n]*\bRODATA\s+(\d+)\s+constants\s*$/gimu,
  ].map(lastNumber);
  const esp8266Flash = esp8266Segments.every((value) => value != null)
    ? esp8266Segments.reduce((total, value) => total + value, 0)
    : null;
  const esp8266Complete = esp8266Ram != null
    && esp8266Flash != null
    && Number.isSafeInteger(esp8266Flash);
  return {
    evidenceComplete: esp8266Complete,
    flashUsedBytes: esp8266Complete ? esp8266Flash : null,
    ramUsedBytes: esp8266Complete ? esp8266Ram : null,
    warningCount,
  };
}

function artifactIntegrityProjection(artifact) {
  return {
    name: artifact.name,
    bytes: artifact.bytes,
    sha256: artifact.sha256,
    primaryApplication: artifact.primaryApplication,
    role: artifact.role,
  };
}

function artifactSetSha256(artifacts) {
  return digestObject(artifacts.map(artifactIntegrityProjection));
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
  const validArtifact = (artifact) => artifact && typeof artifact === 'object'
    && typeof artifact.role === 'string' && artifact.role.length > 0
    && typeof artifact.name === 'string' && artifact.name.length > 0
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
    && /^[0-9a-f]{64}$/u.test(String(artifact.sha256 || ''))
    && typeof artifact.primaryApplication === 'boolean';
  if (!ckArtifacts.every(validArtifact) || !nativeArtifacts.every(validArtifact)) {
    return invalid('one or more artifact records are malformed');
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
      ckName: exactlyOnePerLane ? ck[0].name : null,
      nativeName: exactlyOnePerLane ? native[0].name : null,
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
  const footer = witness.footer;
  const footerOffset = byteLength - ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH;
  if (!footer || typeof footer !== 'object' || Array.isArray(footer)
      || canonicalJson(Object.keys(footer).sort()) !== canonicalJson([
        'checksum', 'checksumOffset', 'checksumValid', 'length', 'offset', 'validationHash',
        'validationHashValid',
      ])
      || footer.offset !== footerOffset
      || footer.length !== ESP_APPLICATION_BIN_TRAILING_FOOTER_LENGTH
      || footer.checksumOffset !== footerOffset
      || !Number.isInteger(footer.checksum) || footer.checksum < 0 || footer.checksum > 255
      || !/^[0-9a-f]{64}$/u.test(String(footer.validationHash || ''))
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
      && /^[0-9a-f]{64}$/u.test(String(segment.sha256 || ''))
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
        // Both lanes flash this offset straight from the shared Core package;
        // the exact reference name must agree, and the payload provenance is
        // already bound by the identical Core/toolchain identity checks.
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

function compareCompileOnlyApplicationArtifactEquivalence(ckArtifacts, nativeArtifacts) {
  const invalid = (reason, details = {}) => ({
    policyId: COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
    requiredRoles: [],
    sharedApplicationRole: null,
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
  const validArtifact = (artifact) => artifact && typeof artifact === 'object'
    && typeof artifact.role === 'string' && artifact.role.length > 0
    && typeof artifact.name === 'string' && artifact.name.length > 0
    && Number.isSafeInteger(artifact.bytes) && artifact.bytes > 0
    && /^[0-9a-f]{64}$/u.test(String(artifact.sha256 || ''))
    && typeof artifact.primaryApplication === 'boolean';
  if (!ckArtifacts.every(validArtifact) || !nativeArtifacts.every(validArtifact)) {
    return invalid('one or more artifact records are malformed');
  }
  const roleMap = (artifacts) => artifacts.reduce((map, artifact) => {
    if (!map.has(artifact.role)) map.set(artifact.role, []);
    map.get(artifact.role).push(artifact);
    return map;
  }, new Map());
  const ckByRole = roleMap(ckArtifacts);
  const nativeByRole = roleMap(nativeArtifacts);
  const artifactPairForRole = (role) => {
    const ck = ckByRole.get(role) || [];
    const native = nativeByRole.get(role) || [];
    const exactlyOnePerLane = ck.length === 1 && native.length === 1;
    const bothPrimary = exactlyOnePerLane
      && ck[0].primaryApplication === true && native[0].primaryApplication === true;
    return {
      role,
      ck,
      native,
      exactlyOnePerLane,
      bothPrimary,
      sharedPrimary: exactlyOnePerLane && bothPrimary,
    };
  };

  // The ELF is the canonical shared semantic application output. If either
  // lane exposes it, do not silently fall through to a different artifact
  // when it is missing, duplicated, or not marked primary in the other lane.
  const elf = artifactPairForRole('application-elf');
  let selected = null;
  if (elf.ck.length > 0 || elf.native.length > 0) {
    if (!elf.sharedPrimary) {
      return invalid('application-elf is not exactly one shared primary application artifact', {
        ckCount: elf.ck.length,
        nativeCount: elf.native.length,
        ckPrimary: elf.ck.length === 1 ? elf.ck[0].primaryApplication : null,
        nativePrimary: elf.native.length === 1 ? elf.native[0].primaryApplication : null,
      });
    }
    selected = elf;
  } else {
    const fallbackCandidates = COMPILE_ONLY_SEMANTIC_APPLICATION_ROLES
      .filter((role) => role !== 'application-elf')
      .map(artifactPairForRole)
      .filter((pair) => pair.sharedPrimary);
    if (fallbackCandidates.length !== 1) {
      return invalid(
        fallbackCandidates.length === 0
          ? 'no shared semantic primary application artifact exists across lanes'
          : 'shared semantic primary application artifact is ambiguous across lanes',
        {
          sharedRoles: fallbackCandidates.map((pair) => pair.role),
        },
      );
    }
    selected = fallbackCandidates[0];
  }

  const [ckArtifact] = selected.ck;
  const [nativeArtifact] = selected.native;
  const bytesMatch = ckArtifact.bytes === nativeArtifact.bytes;
  const sha256Match = ckArtifact.sha256 === nativeArtifact.sha256;
  const primaryApplicationMatch = ckArtifact.primaryApplication === nativeArtifact.primaryApplication;
  const passed = bytesMatch && sha256Match && primaryApplicationMatch;
  const ignoredRoles = (byRole, selectedRole) => [...byRole.keys()]
    .filter((role) => role !== selectedRole)
    .sort();
  return {
    policyId: COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
    requiredRoles: [selected.role],
    sharedApplicationRole: selected.role,
    primaryRoles: {
      ck: [...new Set(ckArtifacts.filter((artifact) => artifact.primaryApplication).map((artifact) => artifact.role))].sort(),
      native: [...new Set(nativeArtifacts.filter((artifact) => artifact.primaryApplication).map((artifact) => artifact.role))].sort(),
    },
    ignoredCkRoles: ignoredRoles(ckByRole, selected.role),
    ignoredNativeRoles: ignoredRoles(nativeByRole, selected.role),
    roles: {
      [selected.role]: {
        ckCount: selected.ck.length,
        nativeCount: selected.native.length,
        ckName: ckArtifact.name,
        nativeName: nativeArtifact.name,
        bytesMatch,
        sha256Match,
        primaryApplicationMatch,
        passed,
      },
    },
    comparable: true,
    passed,
    reason: passed ? null : 'shared semantic application artifact contents differ',
  };
}

function usesCompileOnlyApplicationArtifactEquivalence(options) {
  return options?.qualificationOperation === 'compile'
    && options?.qualificationProfile === 'quick-fast';
}

function usesPortableFastEspApplicationBinEquivalence(options, core = null) {
  return options?.qualificationOperation === 'compile'
    && options?.qualificationProfile === PORTABLE_FAST_PROFILE
    && validEspApplicationPayloadRecipeProof(
      options?.portableFastEspApplicationBinRecipeProof,
      core,
    );
}

function artifactEquivalencePolicyIdForOptions(options, core = null) {
  if (usesCompileOnlyApplicationArtifactEquivalence(options)) {
    return COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID;
  }
  if (usesPortableFastEspApplicationBinEquivalence(options, core)) {
    return PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID;
  }
  return GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID;
}

function compareArtifactEquivalenceForOptions(ckArtifacts, nativeArtifacts, options, core = null) {
  if (usesCompileOnlyApplicationArtifactEquivalence(options)) {
    return compareCompileOnlyApplicationArtifactEquivalence(ckArtifacts, nativeArtifacts);
  }
  if (usesPortableFastEspApplicationBinEquivalence(options, core)) {
    return comparePortableFastEspApplicationBinEquivalence(ckArtifacts, nativeArtifacts);
  }
  return compareGenericArtifactEquivalence(ckArtifacts, nativeArtifacts);
}

function compareArtifactRoles(ckArtifacts, nativeArtifacts, requiredRoles) {
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)
      || !Array.isArray(requiredRoles) || requiredRoles.length === 0
      || new Set(requiredRoles).size !== requiredRoles.length) {
    return { requiredRoles: [], roles: {}, passed: false };
  }
  const compareRole = (role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    const exactlyOnePerLane = ck.length === 1 && native.length === 1;
    return {
      role,
      ckCount: ck.length,
      nativeCount: native.length,
      ckName: ck.length === 1 ? ck[0].name : null,
      nativeName: native.length === 1 ? native[0].name : null,
      bytesMatch: exactlyOnePerLane && ck[0].bytes === native[0].bytes,
      sha256Match: exactlyOnePerLane && ck[0].sha256 === native[0].sha256,
      passed: exactlyOnePerLane
        && ck[0].bytes === native[0].bytes
        && ck[0].sha256 === native[0].sha256,
    };
  };
  const roles = Object.fromEntries(requiredRoles.map((role) => [role, compareRole(role)]));
  return {
    requiredRoles: [...requiredRoles],
    roles,
    passed: requiredRoles.every((role) => roles[role].passed),
  };
}

function compareOptionalArtifactRoles(ckArtifacts, nativeArtifacts, optionalRoles) {
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)
      || !Array.isArray(optionalRoles) || new Set(optionalRoles).size !== optionalRoles.length) {
    return { optionalRoles: [], roles: {}, passed: false };
  }
  const compareRole = (role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    const absentInBothLanes = ck.length === 0 && native.length === 0;
    const exactlyOnePerLane = ck.length === 1 && native.length === 1;
    return {
      role,
      ckCount: ck.length,
      nativeCount: native.length,
      ckName: ck.length === 1 ? ck[0].name : null,
      nativeName: native.length === 1 ? native[0].name : null,
      absentInBothLanes,
      bytesMatch: exactlyOnePerLane && ck[0].bytes === native[0].bytes,
      sha256Match: exactlyOnePerLane && ck[0].sha256 === native[0].sha256,
      passed: absentInBothLanes || (exactlyOnePerLane
        && ck[0].bytes === native[0].bytes
        && ck[0].sha256 === native[0].sha256),
    };
  };
  const roles = Object.fromEntries(optionalRoles.map((role) => [role, compareRole(role)]));
  return {
    optionalRoles: [...optionalRoles],
    roles,
    passed: optionalRoles.every((role) => roles[role].passed),
  };
}

// Witness roles are exactly one same-length primary application image per
// lane. Equal digests pass directly; a digest mismatch must be covered by the
// validated ESP payload witness on both lanes (layout-equal, immutable
// segments byte-equal).
function compareWitnessArtifactRoles(ckArtifacts, nativeArtifacts, witnessRoles) {
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)
      || !Array.isArray(witnessRoles) || new Set(witnessRoles).size !== witnessRoles.length) {
    return { witnessRoles: [], roles: {}, passed: false };
  }
  const compareRole = (role) => {
    const ck = ckArtifacts.filter((artifact) => artifact.role === role);
    const native = nativeArtifacts.filter((artifact) => artifact.role === role);
    const exactlyOnePerLane = ck.length === 1 && native.length === 1;
    const bytesMatch = exactlyOnePerLane && ck[0].bytes === native[0].bytes;
    const sha256Match = exactlyOnePerLane && ck[0].sha256 === native[0].sha256;
    const primaryInBothLanes = exactlyOnePerLane
      && ck[0].primaryApplication === true && native[0].primaryApplication === true;
    const witnessEquivalent = exactlyOnePerLane && bytesMatch && !sha256Match
      && espApplicationBinWitnessesEquivalent(ck[0], native[0]);
    return {
      role,
      ckCount: ck.length,
      nativeCount: native.length,
      ckName: ck.length === 1 ? ck[0].name : null,
      nativeName: native.length === 1 ? native[0].name : null,
      bytesMatch,
      sha256Match,
      primaryInBothLanes,
      witnessEquivalent,
      passed: exactlyOnePerLane && bytesMatch && primaryInBothLanes
        && (sha256Match || witnessEquivalent),
    };
  };
  const roles = Object.fromEntries(witnessRoles.map((role) => [role, compareRole(role)]));
  return {
    witnessRoles: [...witnessRoles],
    roles,
    passed: witnessRoles.every((role) => roles[role].passed),
  };
}

/// Mirror of the desktop validator's NativeRelink artifact policy: required
/// roles stay byte-exact, witness roles are same-length primary images bound
/// by the validated ESP payload witness, optional roles are both-or-none
/// exact, forbidden roles fail closed, and every other role (CK's provenance
/// upload manifest, native upload packaging, the path-derived ELF) is
/// lane-local metadata that the adapter deliberately does not compare.
function compareNativeRelinkAdapterArtifactEquivalence(
  ckArtifacts,
  nativeArtifacts,
  adapter,
  stageId,
) {
  const invalid = (reason) => ({
    policyId: adapter.artifactEquivalencePolicyId,
    requiredRoles: [...adapter.requiredArtifactRoles],
    witnessArtifactRoles: [...adapter.witnessArtifactRoles],
    optionalArtifactRoles: [...adapter.optionalArtifactRoles],
    roles: {},
    comparable: false,
    passed: false,
    reason,
  });
  if (!Array.isArray(ckArtifacts) || !Array.isArray(nativeArtifacts)
      || ckArtifacts.length === 0 || nativeArtifacts.length === 0) {
    return invalid('both lanes must expose non-empty artifact sets');
  }
  const required = compareArtifactRoles(
    ckArtifacts,
    nativeArtifacts,
    adapter.requiredArtifactRoles,
  );
  const witness = compareWitnessArtifactRoles(
    ckArtifacts,
    nativeArtifacts,
    adapter.witnessArtifactRoles,
  );
  const optional = compareOptionalArtifactRoles(
    ckArtifacts,
    nativeArtifacts,
    adapter.optionalArtifactRoles,
  );
  const forbiddenAllStagePresent = [...ckArtifacts, ...nativeArtifacts].some(
    (artifact) => adapter.forbiddenAllStageArtifactRoles.includes(artifact?.role),
  );
  const ckEditForbiddenPresent = stageId !== 'simple' && ckArtifacts.some(
    (artifact) => adapter.forbiddenCkEditArtifactRoles.includes(artifact?.role),
  );
  const passed = required.passed && witness.passed && optional.passed
    && !forbiddenAllStagePresent && !ckEditForbiddenPresent;
  return {
    policyId: adapter.artifactEquivalencePolicyId,
    requiredRoles: [...adapter.requiredArtifactRoles],
    witnessArtifactRoles: [...adapter.witnessArtifactRoles],
    optionalArtifactRoles: [...adapter.optionalArtifactRoles],
    roles: { ...required.roles, ...witness.roles, ...optional.roles },
    comparable: true,
    passed,
    reason: passed ? null
      : !required.passed ? 'one or more required adapter artifact roles differ'
        : !witness.passed ? 'one or more witness adapter artifact roles lack a valid equivalent payload witness'
          : !optional.passed ? 'optional adapter artifact roles are asymmetric or differ'
            : forbiddenAllStagePresent ? 'a forbidden adapter artifact role is present'
              : 'a CK edit stage retains a stale upload-packaging artifact',
  };
}

function compareAvrArtifactRoles(ckArtifacts, nativeArtifacts) {
  const required = compareArtifactRoles(
    ckArtifacts,
    nativeArtifacts,
    AVR_NATIVE_RELINK_ADAPTER.requiredArtifactRoles,
  );
  const optional = compareOptionalArtifactRoles(
    ckArtifacts,
    nativeArtifacts,
    AVR_NATIVE_RELINK_ADAPTER.optionalArtifactRoles,
  );
  const recordWithBootloader = (artifacts) => artifacts
    .filter((artifact) => artifact.role === 'avr-with-bootloader')
    .map(({ name, bytes, sha256, role }) => ({ name, bytes, sha256, role }));
  return {
    ...required,
    roles: { ...required.roles, ...optional.roles },
    optionalArtifactRoles: [...optional.optionalRoles],
    optionalRoles: optional.roles,
    passed: required.passed && optional.passed,
    withBootloader: {
      ck: recordWithBootloader(ckArtifacts),
      native: recordWithBootloader(nativeArtifacts),
    },
  };
}

function evidenceIntegrityProjection(run) {
  const { evidenceSha256, ...unsigned } = run;
  if (unsigned.integritySchemaVersion !== 2) return unsigned;
  delete unsigned.wallMs;
  const rawTiming = unsigned.rawTiming;
  unsigned.rawTiming = rawTiming && typeof rawTiming === 'object'
    ? { runnerWallNs: rawTiming.runnerWallNs }
    : null;
  return unsigned;
}

function finalizeRun(run) {
  const withIntegrityVersion = { ...run, integritySchemaVersion: 2 };
  const evidenceSha256 = digestObject(evidenceIntegrityProjection(withIntegrityVersion));
  return { ...withIntegrityVersion, evidenceSha256 };
}

function validateCacheClear(value, fqbn) {
  const failures = [];
  if (!value || typeof value !== 'object') failures.push('result is not an object');
  if (value?.fqbn !== fqbn) failures.push('complete FQBN mismatch');
  if (value?.reset_scope !== 'first-project-full-fqbn') failures.push('reset scope mismatch');
  if (value?.force_rebuild_pending !== false) failures.push('force rebuild unexpectedly armed');
  if (value?.ccache_store_preserved !== true) failures.push('shared ccache was not preserved');
  if (value?.prebuilt_core_preserved !== false) failures.push('prebuilt Core was retained');
  return { passed: failures.length === 0, failures };
}

function validatedFastRelinkFallbackCode(value) {
  return typeof value === 'string' && FAST_RELINK_FALLBACK_CODES.includes(value)
    ? value
    : null;
}

function sanitizedDiagnosticBuildMode(value) {
  return typeof value === 'string' && DIAGNOSTIC_BUILD_MODES.includes(value)
    ? value
    : 'unknown';
}

function sanitizedQualificationPhase(value) {
  return typeof value === 'string' && QUALIFICATION_PHASES.includes(value)
    ? value
    : 'unknown';
}

function fastRelinkFallbackQualificationError(phase, buildMode, fallbackCode) {
  const error = new Error(
    `CK ${sanitizedQualificationPhase(phase)} qualification rejected Fast Relink fallback`,
  );
  error.code = 'CK_FAST_RELINK_FALLBACK';
  error.phase = sanitizedQualificationPhase(phase);
  error.buildMode = sanitizedDiagnosticBuildMode(buildMode);
  error.fallbackCode = fallbackCode;
  return error;
}

function fastRelinkFallbackFailureDiagnostics(error) {
  if (error?.code !== 'CK_FAST_RELINK_FALLBACK') return null;
  return {
    code: 'CK_FAST_RELINK_FALLBACK',
    phase: sanitizedQualificationPhase(error.phase),
    buildMode: sanitizedDiagnosticBuildMode(error.buildMode),
    fallbackCode: validatedFastRelinkFallbackCode(error.fallbackCode) || 'other',
  };
}

function boundedDiagnosticText(value, maximumCharacters) {
  if (typeof value !== 'string') return null;
  const normalized = value
    .replace(/[\u0000-\u001f\u007f]+/gu, ' ')
    .replace(/\s+/gu, ' ')
    .trim();
  if (normalized === '') return null;
  if (normalized.length <= maximumCharacters) return normalized;
  return `${normalized.slice(0, Math.max(0, maximumCharacters - 3))}...`;
}

function sanitizedRecipeCapabilityIdentifier(value) {
  const candidate = typeof value === 'string' ? value.trim() : '';
  return /^[a-z][a-z0-9_]{0,63}$/u.test(candidate) ? candidate : null;
}

function recipeCapabilityPathPlaceholder(candidate) {
  const normalized = String(candidate || '').replace(/\\/gu, '/');
  const fileLike = normalized.match(/[A-Za-z0-9_-]+(?:\.[A-Za-z0-9._-]+)+/gu);
  const tail = fileLike?.at(-1) || normalized.split('/').pop() || '';
  return /^[A-Za-z0-9._-]{1,128}$/u.test(tail) ? `<path>/${tail}` : '<path>';
}

function redactedRecipeCapabilityBlocker(value) {
  if (typeof value !== 'string') return null;
  let redacted = value.replace(/[\u0000-\u001f\u007f]+/gu, ' ');
  // The capability service is local, but a reason may contain an expanded
  // platform recipe. Never let credentials or a qualified-run token escape
  // into the portable report merely because a gate failed.
  redacted = redacted.replace(
    /\b(authorization|token|password|passwd|secret|api[-_]?key|access[-_]?key)\b(?:\s*[:=]\s*|\s+)(?:"[^"]*"|'[^']*'|[^\s,;]+)/giu,
    (_match, label) => `${label}=<redacted>`,
  );
  redacted = redacted.replace(/\b[0-9a-f]{64}\b/giu, '<sha256>');
  // Artifact adaptation reasons often include a complete managed build path.
  // Keep only a conservative basename when it is safe so an ESP32 bootloader
  // or partition artifact remains identifiable without exposing the user path.
  redacted = redacted.replace(
    /(?:[A-Za-z]:[\\/]|\\\\(?:\?\\)?[^\s\\/]+[\\/])[^\r\n]*/gu,
    (candidate) => recipeCapabilityPathPlaceholder(candidate),
  );
  redacted = redacted.replace(
    /(^|[\s([{'"=])((?:\/(?:Users|home|private|tmp|var|opt|mnt)\/)[^\r\n]*)/giu,
    (_match, prefix, candidate) => `${prefix}${recipeCapabilityPathPlaceholder(candidate)}`,
  );
  redacted = redacted.replace(/file:\/\/\/?[^\r\n]*/giu, (candidate) => recipeCapabilityPathPlaceholder(candidate));
  redacted = redacted.replace(
    /%(?:USERPROFILE|HOMEDRIVE|HOMEPATH|TEMP|TMP)%[\\/][^\r\n]*/giu,
    (candidate) => recipeCapabilityPathPlaceholder(candidate),
  );
  return boundedDiagnosticText(redacted, MAX_RECIPE_CAPABILITY_FAILURE_REASON_CHARS);
}

function recipeCapabilityFailureDiagnosticsFromRecipe(recipe) {
  const missingCapabilities = [];
  let truncated = false;
  const rawMissing = Array.isArray(recipe?.missingCapabilities)
    ? recipe.missingCapabilities
    : [];
  for (let index = 0; index < rawMissing.length; index += 1) {
    if (index >= MAX_RECIPE_CAPABILITY_FAILURE_CAPABILITIES) {
      truncated = true;
      break;
    }
    const rawCapability = rawMissing[index];
    const capability = sanitizedRecipeCapabilityIdentifier(rawCapability);
    if (capability == null || missingCapabilities.includes(capability)) continue;
    missingCapabilities.push(capability);
  }
  const rawBlockers = recipe?.blockers != null
    && typeof recipe.blockers === 'object'
    && !Array.isArray(recipe.blockers)
    ? recipe.blockers
    : null;
  const blockers = {};
  for (const capability of missingCapabilities) {
    if (rawBlockers == null || !Object.prototype.hasOwnProperty.call(rawBlockers, capability)) {
      continue;
    }
    const rawReasons = rawBlockers[capability];
    if (!Array.isArray(rawReasons)) continue;
    const reasons = [];
    for (let index = 0; index < rawReasons.length; index += 1) {
      if (index >= MAX_RECIPE_CAPABILITY_FAILURE_REASONS_PER_CAPABILITY) {
        truncated = true;
        break;
      }
      const rawReason = rawReasons[index];
      const reason = redactedRecipeCapabilityBlocker(rawReason);
      if (reason != null && !reasons.includes(reason)) reasons.push(reason);
    }
    if (reasons.length > 0) blockers[capability] = reasons;
  }
  return {
    schemaVersion: RECIPE_CAPABILITY_FAILURE_DIAGNOSTICS_SCHEMA_VERSION,
    code: 'CK_RECIPE_CAPABILITY_GATE',
    missingCapabilities,
    blockers,
    truncated,
  };
}

function recipeCapabilityFailureSummary(diagnostics) {
  const parts = [];
  for (const capability of diagnostics.missingCapabilities) {
    for (const reason of diagnostics.blockers[capability] || []) {
      parts.push(`${capability}: ${reason}`);
    }
  }
  return boundedDiagnosticText(parts.join('; '), MAX_RECIPE_CAPABILITY_FAILURE_SUMMARY_CHARS);
}

function recipeCapabilityGateFailureDiagnostics(error) {
  if (error?.code !== 'CK_RECIPE_CAPABILITY_GATE') return null;
  const diagnostics = error.recipeCapabilityFailureDiagnostics;
  if (diagnostics?.schemaVersion !== RECIPE_CAPABILITY_FAILURE_DIAGNOSTICS_SCHEMA_VERSION
      || diagnostics.code !== 'CK_RECIPE_CAPABILITY_GATE'
      || !Array.isArray(diagnostics.missingCapabilities)
      || diagnostics.blockers == null
      || typeof diagnostics.blockers !== 'object') {
    return null;
  }
  const sanitized = recipeCapabilityFailureDiagnosticsFromRecipe(diagnostics);
  return {
    ...sanitized,
    truncated: diagnostics.truncated === true || sanitized.truncated,
  };
}

function recipeCapabilityGateError(recipe) {
  const diagnostics = recipeCapabilityFailureDiagnosticsFromRecipe(recipe);
  const missing = diagnostics.missingCapabilities.length > 0
    ? diagnostics.missingCapabilities.join(', ')
    : 'completed_baseline_observation';
  const summary = recipeCapabilityFailureSummary(diagnostics);
  const error = new Error(
    `CK recipe capability gate did not pass: ${missing}${summary == null ? '' : `; blockers: ${summary}`}`,
  );
  error.code = 'CK_RECIPE_CAPABILITY_GATE';
  const frozenBlockers = Object.freeze(Object.fromEntries(
    Object.entries(diagnostics.blockers).map(([capability, reasons]) => [
      capability,
      Object.freeze([...reasons]),
    ]),
  ));
  Object.defineProperty(error, 'recipeCapabilityFailureDiagnostics', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      ...diagnostics,
      missingCapabilities: Object.freeze([...diagnostics.missingCapabilities]),
      blockers: frozenBlockers,
    }),
  });
  return error;
}

function attachLocalQualificationFailureEvidence(error, {
  trialId,
  fqbn,
  responseSha256,
  diagnosticTrace,
  compilerLog,
}) {
  Object.defineProperty(error, 'localQualificationFailureEvidence', {
    configurable: false,
    enumerable: false,
    writable: false,
    value: Object.freeze({
      trialId: /^trial-\d{3}$/u.test(String(trialId || '')) ? trialId : 'trial-unknown',
      fqbn: String(fqbn || ''),
      responseSha256: /^[0-9a-f]{64}$/u.test(String(responseSha256 || ''))
        ? responseSha256
        : null,
      diagnosticTrace: typeof diagnosticTrace === 'string' ? diagnosticTrace : '',
      compilerLog: typeof compilerLog === 'string' ? compilerLog : '',
    }),
  });
  return error;
}

function localQualificationFailureLogText(error) {
  const fallbackDiagnostics = fastRelinkFallbackFailureDiagnostics(error);
  const recipeDiagnostics = recipeCapabilityGateFailureDiagnostics(error);
  const evidence = error?.localQualificationFailureEvidence;
  if ((fallbackDiagnostics == null && recipeDiagnostics == null) || evidence == null) return null;
  if (recipeDiagnostics != null) {
    const lines = [
      'CK Forge local qualification failure evidence v1',
      `trial=${evidence.trialId}`,
      'phase=recipe-capability-observation',
      `fqbn=${evidence.fqbn}`,
      'gate=recipe-capability',
      `missingCapabilities=${recipeDiagnostics.missingCapabilities.join(',') || 'unavailable'}`,
      `blockersTruncated=${recipeDiagnostics.truncated === true}`,
      `responseSha256=${evidence.responseSha256 || 'unavailable'}`,
      '',
      '[recipe-capability-blockers]',
      JSON.stringify(recipeDiagnostics.blockers, null, 2),
      '',
    ];
    return lines.join('\n');
  }
  const lines = [
    'CK Forge local qualification failure evidence v1',
    `trial=${evidence.trialId}`,
    `phase=${fallbackDiagnostics.phase}`,
    `fqbn=${evidence.fqbn}`,
    `buildMode=${fallbackDiagnostics.buildMode}`,
    `fallbackCode=${fallbackDiagnostics.fallbackCode}`,
    `responseSha256=${evidence.responseSha256 || 'unavailable'}`,
    '',
    '[qualification-diagnostic-trace]',
    evidence.diagnosticTrace || '(trace unavailable)',
    '',
    '[compiler-log]',
    evidence.compilerLog || '(compiler log unavailable)',
    '',
  ];
  return lines.join('\n');
}

function retainLocalQualificationFailureLog(directoryPath, error) {
  if (!directoryPath) return null;
  const content = localQualificationFailureLogText(error);
  if (content == null) return null;
  const fallbackDiagnostics = fastRelinkFallbackFailureDiagnostics(error);
  const recipeDiagnostics = recipeCapabilityGateFailureDiagnostics(error);
  const evidence = error.localQualificationFailureEvidence;
  fs.mkdirSync(path.dirname(directoryPath), { recursive: true });
  fs.mkdirSync(directoryPath);
  const fileName = fallbackDiagnostics != null
    ? `${evidence.trialId}-${fallbackDiagnostics.phase}.log`
    : recipeDiagnostics != null
      ? `${evidence.trialId}-recipe-capability.log`
      : null;
  if (fileName == null) return null;
  const outputPath = path.join(directoryPath, fileName);
  fs.writeFileSync(outputPath, content, { encoding: 'utf8', flag: 'wx' });
  return outputPath;
}

function validateCkCompilerEvidence(
  diagnostics,
  log,
  phase,
  expectedJobs,
  qualificationOperation = null,
  qualificationProfile = null,
) {
  const exact = diagnostics?.buildMode === 'exact-match' || diagnostics?.cache?.exactMatch === true;
  if (exact) throw new Error(`CK ${phase} returned Exact; A/B qualification requires a compiler invocation`);
  const genericCompilerModes = phase === 'fresh' || phase === 'simple'
    ? ['full-build', 'arduino-cli-full-fallback']
    : [
      'full-build',
      'arduino-cli-full-fallback',
      'arduino-cli-incremental',
      'arduino-cli-incremental-fallback',
      'fast-relink',
      REQUIRED_CK_MODE_NATIVE_RELINK,
    ];
  const qualificationEditPhase = ['complex', 'medium', 'simple-return'].includes(phase);
  const compilerModes = qualificationOperation == null
    ? genericCompilerModes
    : qualificationProfile === PORTABLE_FAST_PROFILE
      ? PORTABLE_FAST_CK_BUILD_MODES
    : qualificationEditPhase
      ? ['fast-relink']
      : ['full-build', 'fast-relink'];
  if (!compilerModes.includes(diagnostics?.buildMode)) {
    throw new Error(`CK ${phase} reported unsupported buildMode=${diagnostics?.buildMode || 'missing'}`);
  }
  const expectedProfile = qualificationProfile || 'release';
  if (diagnostics?.profile !== expectedProfile) {
    throw new Error(`CK profile=${diagnostics?.profile || 'missing'} does not match requested ${expectedProfile}`);
  }
  if (qualificationOperation != null) {
    const probe = diagnostics?.qualificationProbe;
    if (probe?.authorized !== true
        || probe.authorization !== 'startup-token'
        || probe.operation !== qualificationOperation
        || probe.profile !== qualificationProfile
        || probe.selectedProfile !== qualificationProfile
        || probe.candidateRoute !== 'qualification-token-probe'
        || probe.observedBuildMode !== diagnostics?.buildMode
        || probe.fallbackUsed !== false
        || probe.exactReuseDenied !== true
        || probe.physicalUploadPerformed !== false) {
      throw new Error('CK controlled qualification probe evidence is missing or mismatched');
    }
    if (probe.recipeCapability != null) {
      validateRecipeCapability(
        probe.recipeCapability,
        qualificationProfile === PORTABLE_FAST_PROFILE ? PORTABLE_FAST_RECIPE_INTENT : null,
      );
    }
    if (qualificationProfile === PORTABLE_FAST_PROFILE
        && diagnostics?.cache?.ccacheEnabled !== true) {
      throw new Error('PortableFast qualification requires diagnostics.cache.ccacheEnabled=true');
    }
  } else if (diagnostics?.qualificationProbe != null) {
    throw new Error('CK unexpectedly reported a Fast profile qualification probe');
  }
  const jobsMatch = String(log || '').match(/\[INFO\] Compile parallel jobs:\s*(\d+)/u);
  // Silent qualification responses intentionally return only the compiler's
  // bounded log, not the outer desktop trace that prints the job count.  The
  // runner independently binds `expectedJobs` to the production backend's
  // get_compile_accel_settings result before any lane starts; use that proof
  // when the outer trace is absent.
  const observedJobs = jobsMatch ? Number(jobsMatch[1]) : expectedJobs;
  if (observedJobs !== expectedJobs) {
    throw new Error(`CK jobs=${observedJobs ?? 'missing'} did not match native jobs=${expectedJobs}`);
  }
  const validated = {
    observedJobs,
    jobsEvidenceSource: jobsMatch ? 'compile-log' : 'backend-settings-preflight',
    exactUsed: false,
  };
  if (qualificationOperation != null) {
    if (diagnostics.qualificationProbe.recipeCapability != null) {
      validated.recipeCapability = diagnostics.qualificationProbe.recipeCapability;
    }
    validated.candidateRoute = diagnostics.qualificationProbe.candidateRoute;
    validated.fallbackUsed = diagnostics.qualificationProbe.fallbackUsed;
    if (qualificationProfile === PORTABLE_FAST_PROFILE) validated.ccacheEnabled = true;
  }
  return validated;
}

function validateRecipeCapability(recipe, expectedIntent = null) {
  if (recipe?.schemaVersion !== 2
      || recipe.observationOnly !== true
      || recipe.capabilityGatePassed !== true
      || !/^[0-9a-f]{64}$/u.test(String(recipe.baselineSha256 || ''))
      || !Array.isArray(recipe.requiredCapabilities)
      || recipe.requiredCapabilities.length === 0
      || !Array.isArray(recipe.missingCapabilities)
      || recipe.missingCapabilities.length !== 0) {
    throw recipeCapabilityGateError(recipe);
  }
  if (expectedIntent != null && recipe.intent !== expectedIntent) {
    throw new Error(`CK recipe capability intent must be ${expectedIntent}`);
  }
  return recipe;
}

async function observeCkRecipeCapability(
  evaluate,
  fqbn,
  buildPath,
  timeoutMs,
  qualificationToken,
  qualificationOperation,
  qualificationProfile,
) {
  if (!path.isAbsolute(buildPath)) {
    throw new Error('CK recipe capability observation has no absolute managed build path');
  }
  const result = await evaluate(`(async () => {
    try {
      const recipe = await window.__TAURI_INTERNALS__.invoke('observe_forge_recipe_capability', {
        fqbn: ${JSON.stringify(fqbn)},
        buildPath: ${JSON.stringify(buildPath)},
        qualificationToken: ${JSON.stringify(qualificationToken)},
        qualificationOperation: ${JSON.stringify(qualificationOperation)},
        qualificationProfile: ${JSON.stringify(qualificationProfile)}
      });
      return { ok: true, recipe };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  if (!result?.ok) {
    throw new Error(`CK recipe capability observation failed: ${result?.error || 'unknown error'}`);
  }
  return validateRecipeCapability(
    result.recipe,
    qualificationProfile === PORTABLE_FAST_PROFILE ? PORTABLE_FAST_RECIPE_INTENT : null,
  );
}

async function clearCkCache(evaluate, fqbn, timeoutMs) {
  const result = await evaluate(`(async () => {
    try {
      const value = await window.__TAURI_INTERNALS__.invoke(
        'clear_board_first_project_compile_cache', { fqbn: ${JSON.stringify(fqbn)} }
      );
      return { ok: true, value };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  if (!result?.ok) throw new Error(`CK cache reset failed: ${result?.error || 'unknown error'}`);
  const validation = validateCacheClear(result.value, fqbn);
  if (!validation.passed) throw new Error(`CK cache reset evidence failed: ${validation.failures.join('; ')}`);
  return result.value;
}

async function runCkCompile(
  evaluate,
  fqbn,
  code,
  phase,
  trialId,
  timeoutMs,
  expectedJobs,
  qualificationToken,
  qualificationOperation = null,
  qualificationProfile = null,
  payloadRecipeProof = null,
) {
  const codeSha256 = sha256Bytes(code);
  const outerStart = process.hrtime.bigint();
  const result = await evaluate(`(async () => {
    const started = performance.now();
    try {
      const raw = await window.__TAURI_INTERNALS__.invoke('compile_sketch', {
        code: ${JSON.stringify(code)},
        fqbn: ${JSON.stringify(fqbn)},
        boardPackageId: null,
        runId: null,
        workspaceFingerprint: ${JSON.stringify(codeSha256)},
        sourceMapJson: null,
        silent: true,
        qualification: true,
        qualificationToken: ${JSON.stringify(qualificationToken)},
        qualificationOperation: ${JSON.stringify(qualificationOperation)},
        qualificationProfile: ${JSON.stringify(qualificationProfile)}
      });
      return { ok: true, raw, pageWallMs: performance.now() - started };
    } catch (error) { return { ok: false, error: String(error), pageWallMs: performance.now() - started }; }
  })()`, timeoutMs);
  const outerNs = process.hrtime.bigint() - outerStart;
  if (!result?.ok) throw new Error(`CK ${phase} compile failed: ${result?.error || 'unknown error'}`);
  const parsed = JSON.parse(result.raw);
  const diagnostics = parsed.diagnostics || {};
  const fastRelinkFallbackCode = validatedFastRelinkFallbackCode(
    diagnostics?.cache?.fastRelinkFallbackCode,
  );
  let compilerEvidence;
  try {
    compilerEvidence = validateCkCompilerEvidence(
      diagnostics,
      parsed.log,
      phase,
      expectedJobs,
      qualificationOperation,
      qualificationProfile,
    );
  } catch (error) {
    if (fastRelinkFallbackCode != null) {
      throw attachLocalQualificationFailureEvidence(
        fastRelinkFallbackQualificationError(
          phase,
          diagnostics?.buildMode,
          fastRelinkFallbackCode,
        ),
        {
          trialId,
          fqbn,
          responseSha256: sha256Bytes(result.raw),
          diagnosticTrace: parsed.qualificationDiagnosticTrace,
          compilerLog: parsed.log,
        },
      );
    }
    if (recipeCapabilityGateFailureDiagnostics(error) != null) {
      // The recipe assessment is already reduced to a redacted structured
      // diagnostic. Do not retain the raw compiler log or trace for this
      // failure class merely to produce a local gate report.
      throw attachLocalQualificationFailureEvidence(error, {
        trialId,
        fqbn,
        responseSha256: sha256Bytes(result.raw),
        diagnosticTrace: '',
        compilerLog: '',
      });
    }
    throw error;
  }
  const {
    observedJobs,
    candidateRoute,
    fallbackUsed,
    ccacheEnabled,
  } = compilerEvidence;
  let recipeCapability = null;
  if (qualificationOperation != null) {
    try {
      recipeCapability = await observeCkRecipeCapability(
        evaluate,
        fqbn,
        String(parsed.path || ''),
        timeoutMs,
        qualificationToken,
        qualificationOperation,
        qualificationProfile,
      );
    } catch (error) {
      if (recipeCapabilityGateFailureDiagnostics(error) != null) {
        throw attachLocalQualificationFailureEvidence(error, {
          trialId,
          fqbn,
          responseSha256: sha256Bytes(result.raw),
          diagnosticTrace: '',
          compilerLog: '',
        });
      }
      throw error;
    }
  }
  const artifacts = inspectCkArtifacts(
    parsed,
    nativeRelinkAdapterFor(fqbn),
    payloadRecipeProof,
  );
  const buildPathIdentitySha256 = sha256Bytes(normalizedPath(realpathExisting(parsed.path)));
  const resources = diagnostics.resources || {};
  if (resources.evidenceComplete !== true) throw new Error('CK resource evidence is incomplete');
  const run = {
    trialId,
    phase,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: false,
    wallMs: Number(outerNs) / 1e6,
    rawTiming: {
      runnerWallNs: outerNs.toString(),
      pageWallMs: Number(result.pageWallMs),
      backend: diagnostics.timing || null,
    },
    buildMode: diagnostics.buildMode,
    profile: diagnostics.profile || null,
    qualificationOperation,
    qualificationProfile,
    ...(qualificationOperation == null ? {} : {
      recipeCapability,
      candidateRoute,
      fallbackUsed,
    }),
    ...(qualificationProfile === PORTABLE_FAST_PROFILE ? { ccacheEnabled } : {}),
    route: diagnostics.engine || null,
    structuredRoute: diagnostics.route || diagnostics.engine?.route || null,
    jobs: observedJobs,
    fqbn: diagnostics.fqbn || null,
    toolchainKey: diagnostics.environment?.toolchainKey || null,
    cliVersion: diagnostics.environment?.cliVersion || null,
    codeSha256,
    responseSha256: sha256Bytes(result.raw),
    resources: {
      evidenceComplete: true,
      flashUsedBytes: Number(resources.flashUsedBytes),
      ramUsedBytes: Number(resources.ramUsedBytes),
      warningCount: Number(resources.warningCount),
    },
    artifacts,
    artifactsVerified: true,
    artifactSetSha256: artifactSetSha256(artifacts),
    buildPathIdentitySha256,
  };
  return finalizeRun(run);
}

function runProcess(executable, args, timeoutMs) {
  return new Promise((resolve, reject) => {
    const started = process.hrtime.bigint();
    const child = spawn(executable, args, {
      cwd: REPO_ROOT,
      windowsHide: true,
      detached: process.platform !== 'win32',
      stdio: ['ignore', 'pipe', 'pipe'],
      env: sanitizedChildEnvironment(),
    });
    const stdout = [];
    const stderr = [];
    let stdoutBytes = 0;
    let stderrBytes = 0;
    let captureError = null;
    let terminationStarted = false;
    const terminate = () => {
      if (terminationStarted) return;
      terminationStarted = true;
      terminateOwnedProcessTree(child);
    };
    const capture = (chunks, kind) => (chunk) => {
      const length = chunk.length;
      if (kind === 'stdout') stdoutBytes += length;
      else stderrBytes += length;
      if (stdoutBytes + stderrBytes > MAX_CAPTURE_BYTES) {
        captureError = new Error('Arduino CLI output exceeded the 4 MiB evidence bound');
        terminate();
        return;
      }
      chunks.push(chunk);
    };
    child.stdout.on('data', capture(stdout, 'stdout'));
    child.stderr.on('data', capture(stderr, 'stderr'));
    child.once('error', reject);
    const timer = setTimeout(() => {
      captureError = new Error(`Arduino CLI exceeded ${Math.round(timeoutMs / 60_000)} minute(s)`);
      terminate();
    }, timeoutMs);
    child.once('close', (code, signal) => {
      clearTimeout(timer);
      const wallNs = process.hrtime.bigint() - started;
      if (captureError) return reject(captureError);
      resolve({ code, signal, wallNs, stdout: Buffer.concat(stdout), stderr: Buffer.concat(stderr) });
    });
  });
}

function isSafeCorePathComponent(value) {
  return typeof value === 'string'
    && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}

function corePackageFromFqbn(fqbn) {
  const packageId = canonicalCompleteFqbn(fqbn).split(':', 1)[0];
  if (!isSafeCorePathComponent(packageId)) {
    throw new Error('complete FQBN does not contain a safe Core package id');
  }
  return packageId;
}

function logicalArduinoPropertyLines(text) {
  if (typeof text !== 'string') throw new Error('Arduino platform metadata must be text');
  const lines = [];
  let pending = '';
  for (const raw of text.split(/\r?\n/gu)) {
    const line = `${pending}${raw}`;
    if (/\\$/u.test(line) && !/\\\\$/u.test(line)) {
      pending = line.slice(0, -1);
      continue;
    }
    lines.push(line);
    pending = '';
  }
  if (pending !== '') lines.push(pending);
  return lines;
}

function arduinoPropertiesFromText(text) {
  const properties = new Map();
  for (const raw of logicalArduinoPropertyLines(text)) {
    const line = raw.trim();
    if (line === '' || line.startsWith('#')) continue;
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator).trim();
    if (key === '') continue;
    properties.set(key, line.slice(separator + 1).trim());
  }
  return properties;
}

function resolvedCorePlatformRoot(core) {
  if (!core || !isSafeCorePathComponent(core.corePackage)
      || !isSafeCorePathComponent(core.coreArchitecture)
      || !isSafeCorePathComponent(core.coreVersion)) {
    throw new Error('resolved Core identity cannot safely locate platform.txt');
  }
  const packagesRoot = realpathExisting(path.join(REPO_ROOT, 'packages'));
  const platformRoot = realpathExisting(path.join(
    packagesRoot,
    core.corePackage,
    'hardware',
    core.coreArchitecture,
    core.coreVersion,
  ));
  if (!pathIsWithin(platformRoot, packagesRoot)) {
    throw new Error('resolved Core platform escaped CK packages root');
  }
  return { packagesRoot, platformRoot };
}

function readResolvedPlatformPropertySources(platformRoot) {
  const sources = [];
  for (const name of ['platform.txt', 'platform.local.txt']) {
    const file = path.join(platformRoot, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      throw new Error(`resolved Core ${name} is not a bounded regular file`);
    }
    const bytes = fs.readFileSync(file);
    sources.push({
      name,
      sha256: sha256Bytes(bytes),
      properties: arduinoPropertiesFromText(bytes.toString('utf8')),
    });
  }
  return sources;
}

function espApplicationPayloadRecipeProofForCore(core) {
  if (String(core?.coreArchitecture || '').toLowerCase() !== 'esp32') return null;
  const { platformRoot } = resolvedCorePlatformRoot(core);
  const sources = readResolvedPlatformPropertySources(platformRoot);
  let recipeArgs = null;
  let recipeSource = null;
  for (const source of sources) {
    if (source.properties.has(ESP_APPLICATION_BIN_RECIPE_PROPERTY)) {
      recipeArgs = source.properties.get(ESP_APPLICATION_BIN_RECIPE_PROPERTY);
      recipeSource = source;
    }
  }
  // We do not expand arbitrary Core property indirection here. A literal
  // invocation is required so this exception cannot be enabled by guessing
  // based on FQBN, file extension, or an ESP32 architecture label alone.
  if (typeof recipeArgs !== 'string'
      || !/(?:^|\s)--elf-sha256-offset\s+0xb0(?:\s|$)/u.test(recipeArgs)) {
    return null;
  }
  for (const name of ['boards.txt', 'boards.local.txt']) {
    const file = path.join(platformRoot, name);
    if (!fs.existsSync(file)) continue;
    const stat = fs.statSync(file);
    if (!stat.isFile() || stat.size > 4 * 1024 * 1024) {
      throw new Error(`resolved Core ${name} is not a bounded regular file`);
    }
    // A board-specific override needs a full FQBN property resolver. Until
    // that exists, decline the narrow exception rather than infer its value.
    if ([...arduinoPropertiesFromText(fs.readFileSync(file, 'utf8')).keys()].some((key) => (
      key === 'recipe.objcopy.bin.pattern_args'
        || key.endsWith('.recipe.objcopy.bin.pattern_args')
    ))) return null;
  }
  return Object.freeze({
    schemaVersion: ESP_APPLICATION_BIN_RECIPE_PROOF_SCHEMA_VERSION,
    kind: ESP_APPLICATION_BIN_RECIPE_PROOF_KIND,
    corePackage: core.corePackage,
    coreArchitecture: core.coreArchitecture,
    coreVersion: core.coreVersion,
    recipeProperty: ESP_APPLICATION_BIN_RECIPE_PROPERTY,
    recipeSource: recipeSource.name,
    recipeSourceSha256: recipeSource.sha256,
    recipeValueSha256: sha256Bytes(Buffer.from(recipeArgs, 'utf8')),
    elfSha256OffsetArgument: ESP_APPLICATION_BIN_ELF_SHA256_ARGUMENT,
    elfSha256Offset: ESP_APPLICATION_BIN_ELF_SHA256_OFFSET,
  });
}

function fastFinalFlagPropertiesFromPlatformText(platformText) {
  if (typeof platformText !== 'string') {
    throw new Error('platform.txt content must be text');
  }
  const overrides = [];
  for (const rawLine of platformText.split(/\r?\n/gu)) {
    const line = rawLine.trim();
    const separator = line.indexOf('=');
    if (separator <= 0) continue;
    const key = line.slice(0, separator);
    const flags = line.slice(separator + 1);
    const isCOrCppFlags = key === 'compiler.c.flags'
      || key === 'compiler.cpp.flags'
      || key.startsWith('compiler.c.flags.')
      || key.startsWith('compiler.cpp.flags.');
    if (!isCOrCppFlags || flags.includes('{compiler.ck.final_flags}')) continue;
    overrides.push([key, `${flags.trimEnd()} {compiler.ck.final_flags}`]);
  }
  return overrides;
}

function fastFinalFlagPropertiesForCore(core) {
  const { platformRoot } = resolvedCorePlatformRoot(core);
  const platformTxt = path.join(platformRoot, 'platform.txt');
  if (!fs.statSync(platformTxt).isFile()) {
    throw new Error('resolved Core platform.txt is missing');
  }
  return fastFinalFlagPropertiesFromPlatformText(fs.readFileSync(platformTxt, 'utf8'));
}

function nativeBaselineContract(qualificationProfile = null, core = null) {
  if (qualificationProfile == null) {
    const buildProperties = [];
    return {
      profile: 'release',
      cliConfigPath: CLI_CONFIG,
      cliConfigLabel: '<CK_ROOT>/arduino-cli.yaml',
      buildProperties,
      compilerPropertiesSha256: digestObject(buildProperties),
    };
  }
  if (qualificationProfile === PORTABLE_FAST_PROFILE) {
    // PortableFast compares CK against the Core's unmodified native Arduino
    // recipes. The only allowed acceleration evidence is CK's ccache route.
    // Its native baseline must still use CK's fast CLI configuration so both
    // lanes resolve the same sketchbook and build-cache policy.
    const buildProperties = [];
    return {
      profile: PORTABLE_FAST_PROFILE,
      cliConfigPath: FAST_CLI_CONFIG,
      cliConfigLabel: '<CK_ROOT>/arduino-cli-fast.yaml',
      buildProperties,
      compilerPropertiesSha256: digestObject(buildProperties),
    };
  }
  if (!FORGE_QUALIFICATION_PROFILES.includes(qualificationProfile)) {
    throw new Error(`unsupported native Fast baseline profile '${qualificationProfile}'`);
  }
  const buildProperties = [
    ...FAST_PROFILE_NATIVE_BUILD_PROPERTIES.map(([key, value]) => [key, value]),
    ...(core == null ? [] : fastFinalFlagPropertiesForCore(core)),
  ];
  return {
    profile: qualificationProfile,
    cliConfigPath: FAST_CLI_CONFIG,
    cliConfigLabel: '<CK_ROOT>/arduino-cli-fast.yaml',
    buildProperties,
    compilerPropertiesSha256: digestObject(buildProperties),
  };
}

function nativeBaselineCompilerPropertiesSha256(qualificationProfile, core = null) {
  return nativeBaselineContract(qualificationProfile, core).compilerPropertiesSha256;
}

async function runNativeCompile(context, phase, trialId, timeoutMs) {
  const buildPropertyArgs = context.buildProperties.flatMap(([key, value]) => [
    '--build-property', `${key}=${value}`,
  ]);
  const args = [
    '--config-file', context.cliConfigPath,
    'compile', '--jobs', String(context.jobs), '--discovery-timeout', '100ms',
    ...buildPropertyArgs,
    '-b', context.fqbn, '--build-path', context.buildPath, '--no-color', context.projectPath,
  ];
  const result = await runProcess(CLI_PATH, args, timeoutMs);
  const stdout = result.stdout.toString('utf8');
  const stderr = result.stderr.toString('utf8');
  if (result.code !== 0) throw new Error(`native ${phase} compile failed (${result.code}): ${(stderr || stdout).slice(-2000)}`);
  const artifacts = inspectNativeArtifacts(
    context.buildPath,
    context.projectName,
    nativeRelinkAdapterFor(context.fqbn),
    context.payloadRecipeProof,
  );
  const resources = parseResources(`${stdout}\n${stderr}`);
  if (!resources.evidenceComplete) throw new Error('native resource evidence is incomplete');
  return finalizeRun({
    trialId,
    phase,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: false,
    wallMs: Number(result.wallNs) / 1e6,
    rawTiming: { runnerWallNs: result.wallNs.toString() },
    buildMode: phase === 'fresh' || phase === 'simple'
      ? 'native-fresh-build'
      : phase === 'repeat' ? 'native-incremental-repeat' : 'native-incremental-edit',
    profile: context.profile,
    qualificationProfile: context.qualificationProfile,
    compilerPropertyDeltaSha256: context.compilerPropertiesSha256,
    jobs: context.jobs,
    fqbn: context.fqbn,
    codeSha256: context.codeSha256,
    command: [
      '<BUNDLED_CLI>', '--config-file', context.cliConfigLabel, 'compile',
      '--jobs', String(context.jobs), '--discovery-timeout', '100ms', '-b', context.fqbn,
      ...context.buildProperties.flatMap(([key, value]) => [
        '--build-property', `${key}=${value}`,
      ]),
      '--build-path', '<AB_WORKDIR>/build/<project>', '--no-color', '<AB_WORKDIR>/<project>',
    ],
    stdoutSha256: sha256Bytes(result.stdout),
    stderrSha256: sha256Bytes(result.stderr),
    resources,
    artifacts,
    artifactsVerified: true,
    artifactSetSha256: artifactSetSha256(artifacts),
    buildPathIdentitySha256: sha256Bytes(normalizedPath(realpathExisting(context.buildPath))),
  });
}

function median(values) {
  const sorted = [...values].sort((left, right) => left - right);
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function percentileNearestRank(values, percentile) {
  if (!Array.isArray(values) || values.length === 0) {
    throw new Error('nearest-rank percentile requires at least one sample');
  }
  if (!Number.isFinite(percentile) || percentile <= 0 || percentile > 100) {
    throw new Error('nearest-rank percentile must be in (0, 100]');
  }
  const sorted = [...values].sort((left, right) => left - right);
  const rank = Math.max(1, Math.ceil((percentile / 100) * sorted.length));
  return sorted[rank - 1];
}

function summarize(trials, phase) {
  const ckValues = trials.map((trial) => trial.ck[phase].wallMs);
  const nativeValues = trials.map((trial) => trial.native[phase].wallMs);
  const ckMedianMs = median(ckValues);
  const nativeMedianMs = median(nativeValues);
  return {
    ckRawMs: ckValues,
    nativeRawMs: nativeValues,
    ckMedianMs,
    nativeMedianMs,
    ckP95Ms: percentileNearestRank(ckValues, 95),
    nativeP95Ms: percentileNearestRank(nativeValues, 95),
    ckSpeedupPctVsNative: ((nativeMedianMs - ckMedianMs) / nativeMedianMs) * 100,
    fasterLane: ckMedianMs < nativeMedianMs ? 'ck' : ckMedianMs > nativeMedianMs ? 'native' : 'tie',
  };
}

function requiredCkModeEvidence(run, requiredMode) {
  if (!requiredMode) {
    return {
      required: false,
      requiredMode: null,
      observedBuildMode: run?.buildMode || null,
      observedRoute: run?.structuredRoute || run?.route?.mode || run?.route?.route || null,
      modeMatched: true,
      cliFallback: false,
      passed: true,
    };
  }
  const routeMode = typeof run?.structuredRoute === 'string'
    ? run.structuredRoute
    : run?.structuredRoute?.mode || run?.structuredRoute?.route
      || run?.route?.mode || run?.route?.route || run?.route?.buildMode || null;
  const observedBuildMode = run?.buildMode || null;
  const modeMatched = observedBuildMode === requiredMode || routeMode === requiredMode;
  const routeDecision = run?.route?.decision || run?.structuredRoute?.decision || null;
  const fallbackText = [observedBuildMode, routeMode, routeDecision]
    .filter(Boolean)
    .join('\n');
  const cliFallback = /arduino-cli|fallback/iu.test(fallbackText)
    || run?.route?.fallback === true
    || run?.route?.cliFallback === true
    || run?.structuredRoute?.fallback === true
    || run?.structuredRoute?.cliFallback === true;
  return {
    required: true,
    requiredMode,
    observedBuildMode,
    observedRoute: routeMode,
    modeMatched,
    cliFallback,
    passed: modeMatched && !cliFallback,
  };
}

function isNativeRelinkCompileOnlyCapture(run) {
  const evidence = requiredCkModeEvidence(run, REQUIRED_CK_MODE_NATIVE_RELINK);
  return evidence.modeMatched || run?.buildMode === 'fast-relink';
}

function hasStaleAvrWithBootloader(run) {
  return isNativeRelinkCompileOnlyCapture(run)
    && Array.isArray(run?.artifacts)
    && run.artifacts.some((artifact) => artifact.role === 'avr-with-bootloader');
}

function hasForbiddenAdapterArtifact(run, adapter, scope = 'all-stage') {
  if (adapter == null || !Array.isArray(run?.artifacts)) return false;
  const forbidden = scope === 'ck-edit'
    ? [...adapter.forbiddenAllStageArtifactRoles, ...adapter.forbiddenCkEditArtifactRoles]
    : adapter.forbiddenAllStageArtifactRoles;
  return run.artifacts.some((artifact) => forbidden.includes(artifact.role));
}

function evaluatePerformanceQualification(
  summary,
  stages,
  trials,
  requireCkMode = null,
  adapterContract = AVR_NATIVE_RELINK_ADAPTER,
) {
  const adapter = adapterContract && typeof adapterContract === 'object'
    ? adapterContract
    : (adapterContract ? AVR_NATIVE_RELINK_ADAPTER : null);
  const adapterContractBound = adapter != null;
  const stageIds = Array.isArray(stages)
    ? stages.map((stage) => (typeof stage === 'string' ? stage : stage?.id)).filter(Boolean)
    : [];
  const editStageIds = stageIds.slice(1);
  if (!summary?.stages || editStageIds.length === 0 || !Array.isArray(trials)) {
    return {
      policy: { ...PERFORMANCE_QUALIFICATION_POLICY },
      requiredCkMode: requireCkMode,
      editStageIds,
      stages: [],
      qualified: false,
      status: 'not-qualified',
      reasonCodes: ['portable-edit-measurement-required'],
    };
  }
  const formalTrialCountPassed = trials.length >= PERFORMANCE_QUALIFICATION_POLICY.minimumFormalTrials;
  const stageResults = editStageIds.map((stageId) => {
    const stageSummary = summary.stages[stageId];
    const ckRawMs = Array.isArray(stageSummary?.ckRawMs) ? [...stageSummary.ckRawMs] : [];
    const nativeRawMs = Array.isArray(stageSummary?.nativeRawMs) ? [...stageSummary.nativeRawMs] : [];
    const rawEvidenceComplete = ckRawMs.length === trials.length
      && nativeRawMs.length === trials.length
      && ckRawMs.every((value) => Number.isFinite(value) && value > 0)
      && nativeRawMs.every((value) => Number.isFinite(value) && value > 0);
    const ckMedianMs = Number(stageSummary?.ckMedianMs);
    const nativeMedianMs = Number(stageSummary?.nativeMedianMs);
    const ckP95Ms = Number(stageSummary?.ckP95Ms);
    const nativeP95Ms = Number(stageSummary?.nativeP95Ms);
    const summaryStatisticsConsistent = rawEvidenceComplete
      && ckMedianMs === median(ckRawMs)
      && nativeMedianMs === median(nativeRawMs)
      && ckP95Ms === percentileNearestRank(ckRawMs, 95)
      && nativeP95Ms === percentileNearestRank(nativeRawMs, 95);
    const medianGainMs = nativeMedianMs - ckMedianMs;
    const medianSpeedupPct = nativeMedianMs > 0 ? (medianGainMs / nativeMedianMs) * 100 : Number.NaN;
    const medianSpeedupPassed = Number.isFinite(medianSpeedupPct)
      && medianSpeedupPct >= PERFORMANCE_QUALIFICATION_POLICY.minimumMedianSpeedupPct;
    const absoluteGainPassed = Number.isFinite(medianGainMs)
      && medianGainMs >= PERFORMANCE_QUALIFICATION_POLICY.minimumAbsoluteMedianGainMs;
    const p95NoRegression = Number.isFinite(ckP95Ms)
      && Number.isFinite(nativeP95Ms)
      && ckP95Ms <= nativeP95Ms;
    const captures = trials.map((trial) => {
      const run = trial?.ck?.[stageId];
      const nativeRun = trial?.native?.[stageId];
      return {
        trialId: trial?.id || null,
        ...requiredCkModeEvidence(run, requireCkMode),
        staleAvrWithBootloader: hasStaleAvrWithBootloader(run),
        forbiddenAdapterArtifact: hasForbiddenAdapterArtifact(run, adapter, 'ck-edit')
          || hasForbiddenAdapterArtifact(nativeRun, adapter, 'all-stage'),
      };
    });
    const requiredModePassed = captures.every((capture) => capture.passed);
    const noForbiddenAdapterArtifacts = captures.every(
      (capture) => !capture.forbiddenAdapterArtifact,
    );
    const qualified = rawEvidenceComplete
      && summaryStatisticsConsistent
      && formalTrialCountPassed
      && medianSpeedupPassed
      && absoluteGainPassed
      && p95NoRegression
      && requiredModePassed
      && noForbiddenAdapterArtifacts;
    return {
      id: stageId,
      ckRawMs,
      nativeRawMs,
      ckMedianMs,
      nativeMedianMs,
      ckP95Ms,
      nativeP95Ms,
      medianGainMs,
      medianSpeedupPct,
      p95NoRegression,
      checks: [
        { id: 'raw-samples-and-summary-statistics-consistent', passed: summaryStatisticsConsistent },
        { id: 'minimum-formal-trial-count', passed: formalTrialCountPassed },
        { id: 'minimum-relative-median-speedup', passed: medianSpeedupPassed },
        { id: 'minimum-absolute-median-gain', passed: absoluteGainPassed },
        { id: 'nearest-rank-p95-no-regression', passed: p95NoRegression },
        { id: 'required-ck-mode-without-cli-fallback', passed: requiredModePassed },
        {
          id: adapter?.id === AVR_NATIVE_RELINK_ADAPTER.id
            ? 'no-stale-avr-with-bootloader'
            : 'no-forbidden-adapter-artifacts',
          passed: noForbiddenAdapterArtifacts,
        },
      ],
      captures,
      qualified,
    };
  });
  const qualified = adapterContractBound
    && formalTrialCountPassed
    && stageResults.every((stage) => stage.qualified);
  const reasonCodes = qualified
    ? ['all-portable-edit-stages-qualified']
    : [
      ...(adapterContractBound ? [] : ['native-relink-adapter-contract-not-bound']),
      ...(formalTrialCountPassed ? [] : ['insufficient-formal-trials']),
      ...stageResults
      .filter((stage) => !stage.qualified)
      .map((stage) => `${stage.id}-performance-stability-or-route-gate-failed`),
    ];
  return {
    policy: { ...PERFORMANCE_QUALIFICATION_POLICY },
    requiredCkMode: requireCkMode,
    trialCount: trials.length,
    adapterContractBound,
    formalTrialCountPassed,
    editStageIds,
    stages: stageResults,
    qualified,
    status: qualified ? 'qualified' : 'not-qualified',
    reasonCodes,
  };
}

function resourcesEquivalent(left, right) {
  return left?.evidenceComplete === true && right?.evidenceComplete === true
    && left.flashUsedBytes === right.flashUsedBytes
    && left.ramUsedBytes === right.ramUsedBytes;
}

function createNativeTrial(
  root,
  trialId,
  fqbn,
  jobs,
  initialCode = PORTABLE_SKETCH,
  baseline,
  payloadRecipeProof = null,
) {
  if (!baseline || typeof baseline !== 'object'
      || !Array.isArray(baseline.buildProperties)
      || !/^[0-9a-f]{64}$/u.test(String(baseline.compilerPropertiesSha256 || ''))) {
    throw new Error('native trial requires a resolved compiler baseline contract');
  }
  const projectName = `p_${fqbn.split(':')[2].replace(/[^a-z0-9]+/giu, '_')}`;
  const trialRoot = path.join(root, 'n', trialId.replace('trial-', ''));
  const projectPath = path.join(trialRoot, projectName);
  const buildPath = path.join(trialRoot, 'build', projectName);
  fs.mkdirSync(projectPath, { recursive: true });
  fs.mkdirSync(buildPath, { recursive: true });
  const sourcePath = path.join(projectPath, `${projectName}.ino`);
  fs.writeFileSync(sourcePath, initialCode, { encoding: 'utf8', flag: 'wx' });
  return {
    projectName,
    projectPath,
    buildPath,
    sourcePath,
    fqbn,
    jobs,
    qualificationProfile: baseline.profile === 'release' ? null : baseline.profile,
    payloadRecipeProof,
    ...baseline,
    codeSha256: sha256Bytes(initialCode),
  };
}

function updateNativeTrialSource(context, code) {
  if (!pathIsWithin(context.sourcePath, context.projectPath)
      || path.dirname(realpathExisting(context.sourcePath)) !== realpathExisting(context.projectPath)) {
    throw new Error('native sequence source escaped its project directory');
  }
  fs.writeFileSync(context.sourcePath, code, { encoding: 'utf8', flag: 'w' });
  context.codeSha256 = sha256Bytes(code);
  return context.codeSha256;
}

function boardDetailsBindTarget(details, fqbn) {
  const requested = canonicalCompleteFqbn(fqbn);
  const requestedParts = requested.split(':');
  const requestedBase = requestedParts.slice(0, 3).join(':');
  if (canonicalCompleteFqbn(details?.fqbn) !== requestedBase
      || !details?.version
      || !details?.platform?.architecture
      || !details?.platform?.name) return false;
  const requestedOptions = requestedParts[3]
    ? requestedParts[3].split(',').map((entry) => entry.split('='))
    : [];
  return requestedOptions.every(([optionId, optionValue]) => {
    const option = (details.config_options || []).find((candidate) => candidate.option === optionId);
    const selected = (option?.values || []).filter((candidate) => candidate.selected === true);
    return selected.length === 1 && selected[0].value === optionValue;
  });
}

function inspectCliAndCore(fqbn, cliConfigPath = CLI_CONFIG) {
  if (![CLI_CONFIG, FAST_CLI_CONFIG].includes(cliConfigPath)) {
    throw new Error('CLI config must be a managed CK configuration');
  }
  for (const file of [CLI_PATH, cliConfigPath]) {
    if (!fs.statSync(file).isFile()) throw new Error(`required managed input is missing: ${file}`);
  }
  const cliVersion = execFileSync(CLI_PATH, ['version'], {
    encoding: 'utf8', windowsHide: true, env: sanitizedChildEnvironment(),
  }).trim();
  const details = JSON.parse(execFileSync(CLI_PATH, [
    '--config-file', cliConfigPath, 'board', 'details', '-b', fqbn, '--format', 'json',
  ], {
    encoding: 'utf8', windowsHide: true, maxBuffer: 16 * 1024 * 1024,
    env: sanitizedChildEnvironment(),
  }));
  if (!boardDetailsBindTarget(details, fqbn)) {
    throw new Error('Arduino CLI board details did not bind the requested target/Core');
  }
  return {
    cliVersion,
    cliExecutableSha256: sha256File(CLI_PATH),
    cliConfigSha256: sha256File(cliConfigPath),
    fqbn: canonicalCompleteFqbn(fqbn),
    // platform.name is a human display label (for example "Arduino AVR
    // Boards" or "STM32 MCU based boards"), not the package directory.
    corePackage: corePackageFromFqbn(fqbn),
    coreArchitecture: details.platform.architecture,
    coreVersion: details.version,
  };
}

function safeRemoveWorkdir(workRoot) {
  const expectedParent = realpathExisting(path.join(os.tmpdir(), 'CKAB'));
  const parent = realpathExisting(path.dirname(workRoot));
  const candidate = realpathExisting(workRoot);
  if (normalizedPath(parent) !== normalizedPath(expectedParent)
      || normalizedPath(path.dirname(candidate)) !== normalizedPath(expectedParent)
      || path.basename(expectedParent) !== 'CKAB') {
    throw new Error('refusing to remove an unexpected A/B work directory');
  }
  fs.rmSync(candidate, { recursive: true, force: true });
}

function inspectOwnedWorkdir(workRoot) {
  const expectedParent = realpathExisting(path.join(os.tmpdir(), 'CKAB'));
  const candidate = realpathExisting(workRoot);
  if (normalizedPath(path.dirname(candidate)) !== normalizedPath(expectedParent)) {
    throw new Error('refusing to inspect an unexpected A/B work directory');
  }
  const pending = [candidate];
  let measuredFileBytes = 0;
  let regularFileCount = 0;
  let directoryCount = 0;
  let otherEntryCount = 0;
  while (pending.length > 0) {
    const directory = pending.pop();
    directoryCount += 1;
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const entryPath = path.join(directory, entry.name);
      if (entry.isDirectory()) pending.push(entryPath);
      else if (entry.isFile()) {
        const stat = fs.statSync(entryPath);
        measuredFileBytes += stat.size;
        regularFileCount += 1;
      } else {
        // Never follow symlinks/reparse points while accounting cleanup scope.
        otherEntryCount += 1;
      }
    }
  }
  return { measuredFileBytes, regularFileCount, directoryCount, otherEntryCount };
}

function synchronizeReportStatuses(report) {
  const measurementFailed = Array.isArray(report.failures) && report.failures.length > 0;
  report.measurementStatus = measurementFailed ? 'failed' : 'passed';
  // Keep `status` as the backwards-compatible measurement status. A slow CK
  // lane is still valid evidence and must not be mislabeled as a broken run.
  report.status = report.measurementStatus;
  if (measurementFailed) {
    const existing = report.performanceQualification && typeof report.performanceQualification === 'object'
      ? report.performanceQualification
      : {};
    const reasonCodes = Array.isArray(existing.reasonCodes) ? [...existing.reasonCodes] : [];
    if (!reasonCodes.includes('measurement-failed')) reasonCodes.push('measurement-failed');
    report.performanceQualification = {
      ...existing,
      qualified: false,
      status: 'not-qualified',
      reasonCodes,
    };
    report.qualificationStatus = 'not-qualified';
    return;
  }
  report.qualificationStatus = report.performanceQualification?.qualified === true
    ? 'qualified'
    : 'not-qualified';
}

function toolchainContentSha256(toolchainKey) {
  const match = String(toolchainKey || '').match(/\|([0-9a-f]{64})$/u);
  if (!match) throw new Error('CK toolchain identity has no bound Core/tool content SHA-256');
  return match[1];
}

function performanceCandidateRun(run, label, stage, options, ckContractId, ckLane) {
  if (!run || run.success !== true || run.artifactsVerified !== true || run.exactUsed !== false
      || !/^[0-9a-f]{64}$/u.test(String(run.evidenceSha256 || ''))
      || !/^[0-9a-f]{64}$/u.test(String(run.artifactSetSha256 || ''))
      || !Array.isArray(run.artifacts) || run.artifacts.length === 0
      || artifactSetSha256(run.artifacts) !== run.artifactSetSha256
      || !/^[0-9a-f]{64}$/u.test(String(run.buildPathIdentitySha256 || ''))
      || !Number.isFinite(run.wallMs) || run.wallMs <= 0) {
    throw new Error(`${label} cannot be projected into performance evidence`);
  }
  const expectedCodeSha256 = sha256Bytes(stage.code);
  if (run.codeSha256 !== expectedCodeSha256) {
    throw new Error(`${label} source hash does not match portable-edit stage '${stage.id}'`);
  }
  const resources = run.resources;
  if (resources?.evidenceComplete !== true
      || !Number.isSafeInteger(resources.flashUsedBytes) || resources.flashUsedBytes < 0
      || !Number.isSafeInteger(resources.ramUsedBytes) || resources.ramUsedBytes < 0
      || !Number.isSafeInteger(resources.warningCount) || resources.warningCount < 0) {
    throw new Error(`${label} has incomplete resource evidence`);
  }
  const projected = {
    success: true,
    wallMs: Math.max(1, Math.ceil(run.wallMs)),
    artifactsVerified: true,
    resourceGatePassed: true,
    exactUsed: false,
    evidenceSha256: run.evidenceSha256,
    artifactSetSha256: run.artifactSetSha256,
    artifacts: run.artifacts.map((artifact) => ({
      name: artifact.name,
      role: artifact.role,
      bytes: artifact.bytes,
      sha256: artifact.sha256,
      primaryApplication: artifact.primaryApplication,
      ...(artifact.payloadEquivalenceWitness == null ? {} : {
        payloadEquivalenceWitness: JSON.parse(canonicalJson(artifact.payloadEquivalenceWitness)),
      }),
      ...(artifact.flashArgumentsWitness == null ? {} : {
        flashArgumentsWitness: JSON.parse(canonicalJson(artifact.flashArgumentsWitness)),
      }),
    })),
    codeSha256: run.codeSha256,
    buildPathIdentitySha256: run.buildPathIdentitySha256,
    resources: {
      evidenceComplete: true,
      flashUsedBytes: resources.flashUsedBytes,
      ramUsedBytes: resources.ramUsedBytes,
      warningCount: resources.warningCount,
    },
  };
  if (!ckLane) {
    const expectedPropertyDeltaSha256 = options.nativeBaselineCompilerPropertiesSha256;
    if (!/^[0-9a-f]{64}$/u.test(String(expectedPropertyDeltaSha256 || ''))) {
      throw new Error(`${label} is missing the resolved native compiler baseline binding`);
    }
    if (run.profile !== options.qualificationProfile
        || run.qualificationProfile !== options.qualificationProfile
        || run.compilerPropertyDeltaSha256 !== expectedPropertyDeltaSha256) {
      throw new Error(`${label} does not preserve the native Fast compiler baseline`);
    }
    return {
      ...projected,
      profile: run.profile,
      compilerPropertyDeltaSha256: run.compilerPropertyDeltaSha256,
    };
  }
  const recipe = run.recipeCapability;
  const observedContractId = String(run.route?.contractId || '');
  const portableFast = options.qualificationProfile === PORTABLE_FAST_PROFILE;
  const expectedBuildModes = portableFast
    ? PORTABLE_FAST_CK_BUILD_MODES
    : stage.id === 'simple'
      ? ['full-build', 'fast-relink']
      : ['fast-relink'];
  if (run.profile !== options.qualificationProfile
      || run.qualificationOperation !== options.qualificationOperation
      || run.qualificationProfile !== options.qualificationProfile
      || run.candidateRoute !== 'qualification-token-probe'
      || !expectedBuildModes.includes(run.buildMode)
      || run.fallbackUsed !== false
      || observedContractId !== ckContractId
      || recipe?.schemaVersion !== 2
      || recipe.observationOnly !== true
      || recipe.capabilityGatePassed !== true
      || !/^[0-9a-f]{64}$/u.test(String(recipe.baselineSha256 || ''))
      || !Array.isArray(recipe.requiredCapabilities)
      || recipe.requiredCapabilities.length === 0
      || !Array.isArray(recipe.missingCapabilities)
      || recipe.missingCapabilities.length !== 0
      || (portableFast && run.ccacheEnabled !== true)
      || (portableFast && recipe.intent !== PORTABLE_FAST_RECIPE_INTENT)) {
    throw new Error(`${label} does not preserve the controlled Fast route/build-mode/capability gate`);
  }
  return {
    ...projected,
    buildMode: run.buildMode,
    profile: run.profile,
    qualificationOperation: run.qualificationOperation,
    qualificationProfile: run.qualificationProfile,
    candidateRoute: run.candidateRoute,
    fallbackUsed: false,
    ckContractId: observedContractId,
    ...(portableFast ? { ccacheEnabled: true } : {}),
    recipeCapability: {
      schemaVersion: recipe.schemaVersion,
      baselineSha256: recipe.baselineSha256,
      observationOnly: true,
      capabilityGatePassed: true,
      requiredCapabilities: [...recipe.requiredCapabilities],
      missingCapabilities: [],
      ...(portableFast ? { intent: PORTABLE_FAST_RECIPE_INTENT } : {}),
    },
  };
}

function performanceCompilePropertyDelta(profile) {
  if (profile === 'quick-fast') {
    return 'quick-fast: CK and native CLI baseline both use -O1 -g0 -fno-lto; only CK execution/cache/guard behavior differs';
  }
  if (profile === 'shared-fast') {
    return 'shared-fast: CK and native CLI baseline share Fast compiler properties; only CK upload-ready execution/cache/guard behavior differs';
  }
  if (profile === PORTABLE_FAST_PROFILE) {
    return 'portable-fast: CK and native CLI use the Core\'s unmodified Arduino recipes and compiler properties; CK may qualify only through command-scoped ccache evidence, never FastRelink or NativeRelink';
  }
  throw new Error(`unsupported performance profile '${profile}'`);
}

function performanceCandidateFromReport(report, options) {
  if (options.qualificationOperation == null || options.qualificationProfile == null) {
    throw new Error('performance candidate requires an explicit operation/profile probe');
  }
  if (report.measurementStatus !== 'passed'
      || report.runner?.unchanged !== true
      || report.productionExecutable?.unchanged !== true
      || !Array.isArray(report.trials)
      || report.trials.length < 3) {
    throw new Error('raw A/B report is not immutable passing evidence');
  }
  if (report.controls?.measurementSequence !== PORTABLE_EDIT_SEQUENCE_NAME
      || report.controls?.sameBuildPathWithinLane !== true
      || !Array.isArray(report.stages)
      || !validatePortableEditSequence(PORTABLE_EDIT_SEQUENCE)
      || canonicalJson(report.stages) !== canonicalJson(PORTABLE_EDIT_SEQUENCE.map((stage) => ({
        id: stage.id,
        sourceSha256: sha256Bytes(stage.code),
      })))) {
    throw new Error('performance candidate requires the fixed portable-edit sequence');
  }
  if (options.qualificationOperation != null
      && !hasQualificationReproducibility(report.controls?.reproducibleBuildEnvironment)) {
    throw new Error('performance candidate requires the fixed reproducible qualification environment');
  }
  const laneIdleEvidencePassed = report.trials.every((trial, index) => {
    const order = String(trial.order || report.captureOrder?.[index] || '').split('-');
    return order.length === 2
      && report.captureOrder?.[index] === trial.order
      && Array.isArray(trial.laneBoundaryIdle)
      && trial.laneBoundaryIdle.length === order.length
      && trial.laneBoundaryIdle.every((entry, laneIndex) => (
        entry?.lane === order[laneIndex]
        && entry.policyId === ARDUINO_CLI_LANE_IDLE_POLICY_ID
        && entry.idleWindowMs === ARDUINO_CLI_LANE_IDLE_WINDOW_MS
        && entry.timeoutMs === ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS
        && entry.pollIntervalMs === ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS
        && Number.isFinite(entry.waitedMs)
        && entry.waitedMs >= entry.idleWindowMs
        && entry.waitedMs <= entry.timeoutMs
        && Number.isSafeInteger(entry.polls)
        && entry.polls > 0
      ));
  });
  if (!laneIdleEvidencePassed) {
    throw new Error('performance candidate lane-boundary idle evidence is incomplete or mismatched');
  }
  const firstCk = report.trials[0]?.ck?.simple;
  const toolchainKey = String(firstCk?.toolchainKey || '');
  const ckContractId = String(firstCk?.route?.contractId || '');
  if (!ckContractId) throw new Error('CK Fast contract identity is missing from the raw report');
  const nativeBaselineCompilerPropertiesSha256 = String(
    report.controls?.nativeBaselineCompilerPropertiesSha256 || '',
  );
  if (!/^[0-9a-f]{64}$/u.test(nativeBaselineCompilerPropertiesSha256)) {
    throw new Error('raw A/B report is missing the resolved native compiler baseline binding');
  }
  const sequenceSha256 = digestObject(report.stages);
  if (report.identity?.sequenceSha256 !== sequenceSha256) {
    throw new Error('portable-edit sequence identity is missing or mismatched');
  }
  const identity = {
    fqbn: canonicalCompleteFqbn(report.identity?.fqbn),
    corePackage: String(report.identity?.corePackage || ''),
    coreArchitecture: String(report.identity?.coreArchitecture || ''),
    coreVersion: String(report.identity?.coreVersion || ''),
    toolchainKey,
    toolchainContentSha256: toolchainContentSha256(toolchainKey),
    sketchSha256: String(report.identity?.sketchSha256 || ''),
    cliExecutableSha256: String(report.identity?.cliExecutableSha256 || ''),
    cliConfigSha256: String(report.identity?.cliConfigSha256 || ''),
    cliVersion: String(report.identity?.cliVersion || ''),
    hostIdentitySha256: String(report.identity?.hostIdentitySha256 || ''),
    productionExecutableSha256: String(report.identity?.productionExecutableSha256 || ''),
  };
  const reportPayloadRecipeProof = report.controls?.portableFastEspApplicationBinRecipeProof;
  if (reportPayloadRecipeProof != null
      && !validEspApplicationPayloadRecipeProof(reportPayloadRecipeProof, identity)) {
    throw new Error('raw A/B report has an invalid resolved ESP application-image recipe proof');
  }
  if (options.portableFastEspApplicationBinRecipeProof != null
      && canonicalJson(options.portableFastEspApplicationBinRecipeProof)
        !== canonicalJson(reportPayloadRecipeProof)) {
    throw new Error('raw A/B report recipe proof does not match the resolved qualification Core');
  }
  const candidateOptions = {
    ...options,
    nativeBaselineCompilerPropertiesSha256,
    ...(reportPayloadRecipeProof == null ? {} : {
      portableFastEspApplicationBinRecipeProof: reportPayloadRecipeProof,
    }),
  };
  const artifactEquivalencePolicyId = artifactEquivalencePolicyIdForOptions(candidateOptions, identity);
  const candidateTrials = (lane) => report.trials.map((trial) => {
    const projected = { id: trial.id };
    for (const stage of PORTABLE_EDIT_SEQUENCE) {
      projected[stage.id] = performanceCandidateRun(
        trial[lane]?.[stage.id],
        `${lane}/${trial.id}/${stage.id}`,
        stage,
        candidateOptions,
        ckContractId,
        lane === 'ck',
      );
    }
    if (new Set(PORTABLE_EDIT_SEQUENCE.map(
      (stage) => projected[stage.id].buildPathIdentitySha256,
    )).size !== 1) {
      throw new Error(`${lane}/${trial.id} did not preserve one build path across portable edits`);
    }
    return projected;
  });
  const ckTrials = candidateTrials('ck');
  const nativeTrials = candidateTrials('native');
  for (const [trialIndex, trial] of ckTrials.entries()) {
    for (const stage of PORTABLE_EDIT_SEQUENCE) {
      if (!resourcesEquivalent(trial[stage.id].resources, nativeTrials[trialIndex][stage.id].resources)) {
        throw new Error(`candidate resource equivalence failed at ${trial.id}/${stage.id}`);
      }
      const artifactEquivalence = compareArtifactEquivalenceForOptions(
        trial[stage.id].artifacts,
        nativeTrials[trialIndex][stage.id].artifacts,
        candidateOptions,
        identity,
      );
      if (!artifactEquivalence.passed) {
        throw new Error(
          `candidate artifact equivalence failed at ${trial.id}/${stage.id}: ${artifactEquivalence.reason}`,
        );
      }
    }
  }
  for (const [lane, trials] of [['ck', ckTrials], ['native', nativeTrials]]) {
    const buildPaths = trials.map((trial) => trial.simple.buildPathIdentitySha256);
    if (new Set(buildPaths).size !== buildPaths.length) {
      throw new Error(`${lane} portable-edit trials did not use fresh independent build paths`);
    }
  }
  return {
    schemaId: 'ck.forge.performance-ab-candidate',
    schemaVersion: 4,
    operation: options.qualificationOperation,
    candidateProfile: options.qualificationProfile,
    ckContractId,
    artifactEquivalencePolicyId,
    ...(artifactEquivalencePolicyId === PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID ? {
      portableFastEspApplicationBinRecipeProof: JSON.parse(canonicalJson(reportPayloadRecipeProof)),
    } : {}),
    compilePropertyDelta: performanceCompilePropertyDelta(options.qualificationProfile),
    nativeBaselineCompilerPropertiesSha256,
    measurementSequence: PORTABLE_EDIT_SEQUENCE_NAME,
    sequenceSha256,
    stages: report.stages.map((stage) => ({ ...stage })),
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
        ...report.controls.reproducibleBuildEnvironment,
      },
    },
    captureOrder: [...report.captureOrder],
    lanes: {
      ck: { identity: { ...identity }, trials: ckTrials },
      native: { identity: { ...identity }, trials: nativeTrials },
    },
  };
}

function planFor(options) {
  const sequence = options.sequence || DEFAULT_SEQUENCE;
  const stages = measurementStages(sequence);
  const sequenceMode = sequence === PORTABLE_EDIT_SEQUENCE_NAME;
  const nativeRelinkAdapter = nativeRelinkAdapterFor(options.fqbn);
  const fastProfileProbe = options.qualificationOperation == null ? null : {
    operation: options.qualificationOperation,
    profile: options.qualificationProfile,
    certificateGrantedByMeasurement: false,
    requiresSeparateEvaluationAndInstallation: true,
  };
  const nativeBaseline = nativeBaselineContract(options.qualificationProfile);
  const plan = {
    schemaId: 'ck.forge.native-ab-plan',
    schemaVersion: 2,
    fqbn: options.fqbn,
    trials: options.trials,
    captureOrder: captureOrder(options.trials),
    jobs: effectiveJobs(),
    compileOnly: true,
    exactAllowed: false,
    uploadPerformed: false,
    sourceSha256: sha256Bytes(PORTABLE_SKETCH),
    outputWillBeWritten: false,
    candidateOutputWillBeWritten: false,
    candidateArtifactBundleWillBeWritten: false,
    cacheWillBeReset: false,
    reproducibleBuildEnvironment: fastProfileProbe == null ? null : {
      policyId: QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
      sourceDateEpoch: Number(QUALIFICATION_SOURCE_DATE_EPOCH),
      timeZone: QUALIFICATION_TIME_ZONE,
      requiredAtExecution: true,
    },
    nativeBaseline: {
      profile: nativeBaseline.profile,
      cliConfigFile: path.basename(nativeBaseline.cliConfigPath),
      compilerPropertyCount: nativeBaseline.buildProperties.length,
      compilerPropertiesSha256: fastProfileProbe == null
        ? nativeBaseline.compilerPropertiesSha256
        : null,
      compilerContractResolution: fastProfileProbe == null
        ? 'static-release'
        : 'target-platform-at-execution',
    },
    performanceQualification: {
      policy: {
        ...(fastProfileProbe == null
          ? PERFORMANCE_QUALIFICATION_POLICY
          : FAST_PROFILE_PERFORMANCE_POLICY),
      },
      eligible: sequenceMode
        && options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK
        && nativeRelinkAdapter != null,
      profileProbeEligible: fastProfileProbe != null,
      fastProfileProbe,
      requiredStageIds: fastProfileProbe == null
        ? stages.slice(1).map((stage) => stage.id)
        : stages.map((stage) => stage.id),
      editStageIds: sequenceMode ? stages.slice(1).map((stage) => stage.id) : [],
      requiredCkMode: options.requireCkMode,
      qualificationOperation: options.qualificationOperation,
      qualificationProfile: options.qualificationProfile,
      artifactEquivalencePolicyId: options.qualificationProfile != null
        ? artifactEquivalencePolicyIdForOptions(options)
        : nativeRelinkAdapter?.artifactEquivalencePolicyId || null,
      nativeRelinkAdapter: nativeRelinkAdapter == null ? null : {
        id: nativeRelinkAdapter.id,
        engineContractId: nativeRelinkAdapter.engineContractId,
        artifactEquivalencePolicyId: nativeRelinkAdapter.artifactEquivalencePolicyId,
        requiredArtifactRoles: [...nativeRelinkAdapter.requiredArtifactRoles],
        witnessArtifactRoles: [...nativeRelinkAdapter.witnessArtifactRoles],
        optionalArtifactRoles: [...nativeRelinkAdapter.optionalArtifactRoles],
      },
    },
  };
  if (sequenceMode) {
    plan.measurementSequence = sequence;
    plan.stages = stages.map((stage) => ({ id: stage.id, sourceSha256: sha256Bytes(stage.code) }));
    plan.sourceSha256 = digestObject(plan.stages);
    plan.sameBuildPathWithinLane = true;
  }
  return plan;
}

async function execute(options) {
  const sequence = options.sequence || DEFAULT_SEQUENCE;
  const stages = measurementStages(sequence);
  const sequenceMode = sequence === PORTABLE_EDIT_SEQUENCE_NAME;
  if (sequenceMode && !validatePortableEditSequence(stages)) {
    throw new Error('portable-edit source sequence failed its portability/integrity contract');
  }
  const reproducibleBuildEnvironment = qualificationReproducibility();
  if (options.qualificationOperation != null && !reproducibleBuildEnvironment.passed) {
    throw new Error(
      `Fast profile qualification requires SOURCE_DATE_EPOCH=${QUALIFICATION_SOURCE_DATE_EPOCH} and TZ=${QUALIFICATION_TIME_ZONE}`,
    );
  }
  // ESP32 application images embed esp_app_desc compile date/time strings, so
  // byte-level lane equivalence only holds under the frozen reproducibility
  // environment. Fail fast here instead of failing the witness comparison
  // after a full capture.
  if (options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK
      && String(options.fqbn || '').startsWith('esp32:')
      && !reproducibleBuildEnvironment.passed) {
    throw new Error(
      `ESP32 NativeRelink qualification requires SOURCE_DATE_EPOCH=${QUALIFICATION_SOURCE_DATE_EPOCH} and TZ=${QUALIFICATION_TIME_ZONE}`,
    );
  }
  const stageIds = stages.map((stage) => stage.id);
  const runnerBefore = inspectRunner();
  const productionBefore = inspectProductionExecutable();
  // CDP can be ready before the desktop's startup discovery/prewarm CLI has
  // finished.  Wait before the runner performs its own board-details CLI call;
  // otherwise that call can be mistaken for (or contend with) startup work.
  // This barrier is outside all trial/lane timers and does not change the
  // sequential no-concurrent-compile gate used during measurement.
  const startupCliIdle = await waitForArduinoCliIdleWindow();
  const nativeBaselineConfig = nativeBaselineContract(options.qualificationProfile);
  const cli = inspectCliAndCore(options.fqbn, nativeBaselineConfig.cliConfigPath);
  const nativeBaseline = nativeBaselineContract(options.qualificationProfile, cli);
  const portableFastPayloadRecipeProof = options.qualificationProfile === PORTABLE_FAST_PROFILE
    ? espApplicationPayloadRecipeProofForCore(cli)
    : null;
  // The ESP image exception is enabled only after this local Core inspection.
  // Plans intentionally remain generic because they do not resolve a Core.
  const runtimeOptions = {
    ...options,
    ...(portableFastPayloadRecipeProof == null ? {} : {
      portableFastEspApplicationBinRecipeProof: portableFastPayloadRecipeProof,
    }),
  };
  // `inspectCliAndCore` is itself an unmeasured identity probe. On Windows a
  // just-exited CLI can remain visible to process inventory briefly, and Core
  // discovery may also finish asynchronously. Require another complete idle
  // window before creating trial 1 instead of letting the strict lane guard
  // turn that harmless setup tail into a false concurrent-compile failure.
  // This remains outside every measured CK/native wall and does not relax the
  // zero-concurrency assertion at the lane boundary.
  const identityCliIdle = await waitForArduinoCliIdleWindow({
    phaseLabel: 'post-identity setup',
  });
  const nativeRelinkAdapter = nativeRelinkAdapterFor(cli.fqbn, cli.coreArchitecture);
  if (options.requireCkMode && nativeRelinkAdapter == null) {
    throw new Error('resolved Core/FQBN has no certified NativeRelink adapter contract');
  }
  // NativeRelink esp32 adapters prove their witness roles with the same ESP
  // payload witness as PortableFast, so relink lanes need the resolved recipe
  // proof too. A missing/non-literal recipe leaves witnesses absent and the
  // witness-role comparison fails closed.
  const nativeRelinkPayloadRecipeProof = options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK
    && String(cli.coreArchitecture || '').toLowerCase() === 'esp32'
    ? espApplicationPayloadRecipeProofForCore(cli)
    : null;
  const payloadRecipeProof = portableFastPayloadRecipeProof ?? nativeRelinkPayloadRecipeProof;
  const jobs = effectiveJobs();
  const hostIdentitySha256 = hostEnvironmentFingerprint();
  const timeoutMs = options.timeoutMinutes * 60_000;
  const runToken = crypto.randomBytes(8).toString('hex');
  const workParent = path.join(os.tmpdir(), 'CKAB');
  fs.mkdirSync(workParent, { recursive: true });
  const workRoot = path.join(workParent, runToken);
  fs.mkdirSync(workRoot, { recursive: false });
  const report = {
    schemaId: 'ck.forge.native-ab-run',
    schemaVersion: 2,
    status: 'running',
    measurementStatus: 'running',
    qualificationStatus: 'not-evaluated',
    startedAt: new Date().toISOString(),
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
      exactAllowed: false,
      exactCountedAsFresh: false,
      requiredCkMode: options.requireCkMode,
      nativeRelinkAdapterId: nativeRelinkAdapter?.id || null,
      nativeRelinkEngineContractId: nativeRelinkAdapter?.engineContractId || null,
      artifactEquivalencePolicyId: options.qualificationProfile != null
        ? artifactEquivalencePolicyIdForOptions(runtimeOptions, cli)
        : nativeRelinkAdapter?.artifactEquivalencePolicyId || null,
      ...(portableFastPayloadRecipeProof == null ? {} : {
        portableFastEspApplicationBinRecipeProof: portableFastPayloadRecipeProof,
      }),
      nativeBaselineProfile: nativeBaseline.profile,
      nativeBaselineCliConfigFile: path.basename(nativeBaseline.cliConfigPath),
      nativeBaselineCompilerPropertiesSha256: nativeBaseline.compilerPropertiesSha256,
      reproducibleBuildEnvironment,
      laneBoundaryIdlePolicy: {
        policyId: ARDUINO_CLI_LANE_IDLE_POLICY_ID,
        idleWindowMs: ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
        timeoutMs: ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
        pollIntervalMs: ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
        outsideMeasuredCompileWallTime: true,
      },
      preTrialIdlePolicy: {
        policyId: ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID,
        idleWindowMs: ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS,
        timeoutMs: ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS,
        pollIntervalMs: ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS,
        outsideMeasuredCompileWallTime: true,
        completedBeforeFirstLane: true,
      },
    },
    identity: {
      ...cli,
      jobs,
      sketchSha256: sha256Bytes(PORTABLE_SKETCH),
      hostIdentitySha256,
      runnerSha256: runnerBefore.sha256,
      productionExecutableSha256: productionBefore.executableSha256,
    },
    captureOrder: captureOrder(options.trials),
    trials: [],
    summary: null,
    performanceQualification: {
      policy: { ...PERFORMANCE_QUALIFICATION_POLICY },
      requiredCkMode: options.requireCkMode,
      qualificationOperation: options.qualificationOperation,
      qualificationProfile: options.qualificationProfile,
      editStageIds: sequenceMode ? stageIds.slice(1) : [],
      stages: [],
      qualified: false,
      status: 'not-evaluated',
      reasonCodes: [],
    },
    checks: [],
    failures: [],
    workdir: {
      retained: options.keepWorkdir,
      tokenSha256: sha256Bytes(runToken),
      freeBytesBefore: assertFreeSpace(workRoot, options.minFreeGiB),
      freeBytesAfterCapture: null,
      freeBytesAfter: null,
      cleanup: {
        ownedPath: '<TEMP>/CKAB/<run-token>',
        measuredFileBytes: null,
        regularFileCount: null,
        directoryCount: null,
        otherEntryCount: null,
        removed: false,
        removedPaths: [],
      },
    },
    runner: { before: runnerBefore, after: null, unchanged: null },
    productionExecutable: { before: productionBefore, after: null, unchanged: null },
    startupStability: startupCliIdle,
    identitySetupStability: identityCliIdle,
    preTrialStability: null,
    partialTrial: null,
    failureDiagnostics: null,
  };
  if (sequenceMode) {
    report.controls.measurementSequence = sequence;
    report.controls.sameBuildPathWithinLane = true;
    report.identity.sequenceSha256 = digestObject(stages.map((stage) => ({
      id: stage.id,
      sourceSha256: sha256Bytes(stage.code),
    })));
    report.stages = stages.map((stage) => ({ id: stage.id, sourceSha256: sha256Bytes(stage.code) }));
  }
  let cdp;
  let activeTrial = null;
  try {
    const target = await getCdpTarget();
    cdp = createCdp(target.webSocketDebuggerUrl);
    const preflight = await runCdpPreflightAndWaitForPreTrialStability({
      evaluate: cdp.evaluate,
      compileTimeoutMs: timeoutMs,
      expectedJobs: jobs,
    });
    report.identity.compileSettingsSha256 = digestObject(preflight.compileSettings);
    report.identity.jobsEvidenceSource = 'production-backend-settings';
    report.preTrialStability = preflight.stability;

    for (let index = 0; index < options.trials; index += 1) {
      assertFreeSpace(workRoot, options.minFreeGiB);
      const trialId = `trial-${String(index + 1).padStart(3, '0')}`;
      const order = report.captureOrder[index].split('-');
      const trial = {
        id: trialId,
        order: report.captureOrder[index],
        ck: {},
        native: {},
        laneBoundaryIdle: [],
      };
      activeTrial = trial;
      const nativeContext = createNativeTrial(
        workRoot,
        trialId,
        options.fqbn,
        jobs,
        stages[0].code,
        nativeBaseline,
        payloadRecipeProof,
      );
      const runLane = async (lane) => {
        assertNoConcurrentArduinoCli();
        if (lane === 'ck') {
          trial.ck.cacheClear = await clearCkCache(cdp.evaluate, options.fqbn, timeoutMs);
          for (const stage of stages) {
            trial.ck[stage.id] = await runCkCompile(
              cdp.evaluate,
              options.fqbn,
              stage.code,
              stage.id,
              trialId,
              timeoutMs,
              jobs,
              options.qualificationToken,
              options.qualificationOperation,
              options.qualificationProfile,
              payloadRecipeProof,
            );
          }
        } else {
          for (const [stageIndex, stage] of stages.entries()) {
            if (sequenceMode || stageIndex === 0) updateNativeTrialSource(nativeContext, stage.code);
            trial.native[stage.id] = await runNativeCompile(nativeContext, stage.id, trialId, timeoutMs);
          }
        }
        const idle = await waitForArduinoCliIdleWindow({
          idleWindowMs: ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
          timeoutMs: ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
          pollIntervalMs: ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
          policyId: ARDUINO_CLI_LANE_IDLE_POLICY_ID,
          phaseLabel: `${lane} lane boundary`,
          readProcessDetails: () => arduinoCliProcessDetails(),
        });
        trial.laneBoundaryIdle.push({ lane, ...idle });
      };
      for (const lane of order) await runLane(lane);
      const allRuns = stageIds.flatMap((stageId) => [trial.ck[stageId], trial.native[stageId]]);
      if (String(cli.coreArchitecture).toLowerCase() === 'avr') {
        trial.avrArtifactRoleEquivalence = {
          byStage: Object.fromEntries(stageIds.map((stageId) => [
            stageId,
            compareAvrArtifactRoles(
              trial.ck[stageId].artifacts,
              trial.native[stageId].artifacts,
            ),
          ])),
        };
      }
      if (nativeRelinkAdapter?.id === SAMD_MKRZERO_NATIVE_RELINK_ADAPTER.id) {
        trial.samdArtifactRoleEquivalence = {
          byStage: Object.fromEntries(stageIds.map((stageId) => [stageId, {
            required: compareArtifactRoles(
              trial.ck[stageId].artifacts,
              trial.native[stageId].artifacts,
              nativeRelinkAdapter.requiredArtifactRoles,
            ),
            forbiddenAbsent: !hasForbiddenAdapterArtifact(
              trial.ck[stageId], nativeRelinkAdapter,
              stageId === 'simple' ? 'all-stage' : 'ck-edit',
            ) && !hasForbiddenAdapterArtifact(
              trial.native[stageId], nativeRelinkAdapter, 'all-stage',
            ),
          }])),
        };
      }
      if (nativeRelinkAdapter?.coreArchitecture === 'esp32') {
        trial.esp32ArtifactRoleEquivalence = {
          byStage: Object.fromEntries(stageIds.map((stageId) => [stageId, {
            required: compareArtifactRoles(
              trial.ck[stageId].artifacts,
              trial.native[stageId].artifacts,
              nativeRelinkAdapter.requiredArtifactRoles,
            ),
            witness: compareWitnessArtifactRoles(
              trial.ck[stageId].artifacts,
              trial.native[stageId].artifacts,
              nativeRelinkAdapter.witnessArtifactRoles,
            ),
            forbiddenAbsent: !hasForbiddenAdapterArtifact(
              trial.ck[stageId], nativeRelinkAdapter,
              stageId === 'simple' ? 'all-stage' : 'ck-edit',
            ) && !hasForbiddenAdapterArtifact(
              trial.native[stageId], nativeRelinkAdapter, 'all-stage',
            ),
          }])),
        };
      }
      if (sequenceMode) {
        trial.artifactAndResourceEquivalence = {
          byStage: Object.fromEntries(stageIds.map((stageId) => [stageId, {
            resources: resourcesEquivalent(
              trial.ck[stageId].resources,
              trial.native[stageId].resources,
            ),
            codeSha256: trial.ck[stageId].codeSha256 === trial.native[stageId].codeSha256,
            artifacts: options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK
              && nativeRelinkAdapter != null
              ? compareNativeRelinkAdapterArtifactEquivalence(
                trial.ck[stageId].artifacts,
                trial.native[stageId].artifacts,
                nativeRelinkAdapter,
                stageId,
              )
              : compareArtifactEquivalenceForOptions(
                trial.ck[stageId].artifacts,
                trial.native[stageId].artifacts,
                runtimeOptions,
                cli,
              ),
          }])),
          allArtifactSetsIndependentlyHashed: allRuns.every(
            (run) => /^[0-9a-f]{64}$/u.test(run.artifactSetSha256),
          ),
        };
      } else {
        trial.artifactAndResourceEquivalence = {
          freshResources: resourcesEquivalent(trial.ck.fresh.resources, trial.native.fresh.resources),
          repeatResources: resourcesEquivalent(trial.ck.repeat.resources, trial.native.repeat.resources),
          allArtifactSetsIndependentlyHashed: allRuns.every(
            (run) => /^[0-9a-f]{64}$/u.test(run.artifactSetSha256),
          ),
        };
      }
      report.trials.push(trial);
      activeTrial = null;
      if (sequenceMode) {
        process.stdout.write(`${trialId} ${trial.order}: ${stageIds.map((stageId) => (
          `${stageId} CK ${trial.ck[stageId].wallMs.toFixed(0)} / native ${trial.native[stageId].wallMs.toFixed(0)} ms`
        )).join('; ')}\n`);
      } else {
        process.stdout.write(`${trialId} ${trial.order}: CK ${trial.ck.fresh.wallMs.toFixed(0)}/${trial.ck.repeat.wallMs.toFixed(0)} ms; native ${trial.native.fresh.wallMs.toFixed(0)}/${trial.native.repeat.wallMs.toFixed(0)} ms\n`);
      }
    }
    report.summary = sequenceMode
      ? { stages: Object.fromEntries(stageIds.map((stageId) => [stageId, summarize(report.trials, stageId)])) }
      : { fresh: summarize(report.trials, 'fresh'), repeat: summarize(report.trials, 'repeat') };
    report.performanceQualification = evaluatePerformanceQualification(
      report.summary,
      stages,
      report.trials,
      options.requireCkMode,
      options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK
        ? nativeRelinkAdapter
        : null,
    );
    const everyRun = (predicate) => report.trials.every((trial) => stageIds.every(
      (stageId) => predicate(trial.ck[stageId]) && predicate(trial.native[stageId]),
    ));
    const everyCkRun = (predicate) => report.trials.every((trial) => stageIds.every(
      (stageId) => predicate(trial.ck[stageId]),
    ));
    report.checks = [
      { id: 'all-runs-succeeded', passed: everyRun((run) => run.success) },
      { id: 'no-exact-run-was-counted', passed: everyCkRun((run) => !run.exactUsed) },
      { id: 'every-fresh-ck-run-had-validated-cache-reset', passed: report.trials.every((trial) => trial.ck.cacheClear?.reset_scope === 'first-project-full-fqbn') },
      { id: 'jobs-match-across-lanes', passed: everyRun((run) => run.jobs === jobs) },
      { id: 'complete-fqbn-matches-across-lanes', passed: everyRun((run) => canonicalCompleteFqbn(run.fqbn) === canonicalCompleteFqbn(options.fqbn)) },
      { id: 'bundled-cli-version-matches-ck', passed: everyCkRun((run) => String(run.cliVersion || '').replace(/\s+/gu, ' ').trim() === String(cli.cliVersion).replace(/\s+/gu, ' ').trim()) },
      { id: 'core-version-matches-ck-route', passed: everyCkRun((run) => run.route?.coreVersion === cli.coreVersion) },
      { id: 'toolchain-identity-stable', passed: new Set(report.trials.flatMap((trial) => stageIds.map((stageId) => trial.ck[stageId].toolchainKey))).size === 1 && Boolean(report.trials[0]?.ck?.[stageIds[0]]?.toolchainKey) },
      { id: 'resources-match-across-lanes', passed: sequenceMode
        ? report.trials.every((trial) => stageIds.every((stageId) => trial.artifactAndResourceEquivalence.byStage[stageId].resources))
        : report.trials.every((trial) => trial.artifactAndResourceEquivalence.freshResources && trial.artifactAndResourceEquivalence.repeatResources) },
      { id: 'artifact-sets-independently-hashed', passed: report.trials.every((trial) => trial.artifactAndResourceEquivalence.allArtifactSetsIndependentlyHashed) },
      {
        id: options.requireCkMode === REQUIRED_CK_MODE_NATIVE_RELINK && nativeRelinkAdapter != null
          ? 'native-relink-adapter-artifact-roles-and-content-match'
          : usesCompileOnlyApplicationArtifactEquivalence(options)
            ? 'compile-only-shared-primary-application-artifact-match'
            : usesPortableFastEspApplicationBinEquivalence(runtimeOptions, cli)
              ? 'portable-fast-esp-application-payload-and-controlled-role-match'
              : 'generic-required-artifact-roles-and-content-match',
        passed: sequenceMode
        ? report.trials.every((trial) => stageIds.every(
          (stageId) => trial.artifactAndResourceEquivalence.byStage[stageId].artifacts.passed,
        ))
        : report.trials.every((trial) => compareArtifactEquivalenceForOptions(
          trial.ck.fresh.artifacts, trial.native.fresh.artifacts,
          runtimeOptions,
          cli,
        ).passed && compareArtifactEquivalenceForOptions(
          trial.ck.repeat.artifacts, trial.native.repeat.artifacts,
          runtimeOptions,
          cli,
        ).passed) },
      { id: 'no-upload-was-performed', passed: everyRun((run) => run.uploadPerformed === false) },
    ];
    if (options.qualificationOperation != null) {
      report.checks.push({
        id: 'controlled-fast-profile-probe-matched-every-ck-run',
        passed: everyCkRun((run) => (
          run.profile === options.qualificationProfile
          && run.qualificationOperation === options.qualificationOperation
          && run.qualificationProfile === options.qualificationProfile
          && run.recipeCapability?.schemaVersion === 2
          && run.recipeCapability?.observationOnly === true
          && run.recipeCapability?.capabilityGatePassed === true
          && Array.isArray(run.recipeCapability?.missingCapabilities)
          && run.recipeCapability.missingCapabilities.length === 0
        )),
      });
      if (options.qualificationProfile === PORTABLE_FAST_PROFILE) {
        report.checks.push({
          id: 'portable-fast-uses-native-recipes-and-ccache-every-ck-run',
          passed: everyCkRun((run) => (
            PORTABLE_FAST_CK_BUILD_MODES.includes(run.buildMode)
            && run.ccacheEnabled === true
            && run.recipeCapability?.intent === PORTABLE_FAST_RECIPE_INTENT
          )),
        });
      }
    }
    if (String(cli.coreArchitecture).toLowerCase() === 'avr') {
      report.checks.push(
        {
          id: 'avr-application-hex-required-eeprom-optional-match-by-role',
          passed: report.trials.every((trial) => stageIds.every(
            (stageId) => trial.avrArtifactRoleEquivalence.byStage[stageId].passed,
          )),
        },
        {
          id: 'avr-native-relink-edit-has-no-stale-with-bootloader',
          passed: report.trials.every((trial) => stageIds.slice(1).every(
            (stageId) => !hasStaleAvrWithBootloader(trial.ck[stageId]),
          )),
        },
      );
    }
    if (nativeRelinkAdapter?.id === SAMD_MKRZERO_NATIVE_RELINK_ADAPTER.id) {
      report.checks.push(
        {
          id: 'samd-mkrzero-application-bin-and-hex-match-by-role',
          passed: report.trials.every((trial) => stageIds.every(
            (stageId) => trial.samdArtifactRoleEquivalence.byStage[stageId].required.passed,
          )),
        },
        {
          id: 'samd-mkrzero-has-no-upload-or-auxiliary-artifact-residual',
          passed: report.trials.every((trial) => stageIds.every(
            (stageId) => trial.samdArtifactRoleEquivalence.byStage[stageId].forbiddenAbsent,
          )),
        },
      );
    }
    if (nativeRelinkAdapter?.coreArchitecture === 'esp32') {
      const boardLabel = nativeRelinkAdapter.fqbnMatch.value.split(':').pop();
      report.checks.push(
        {
          id: `${boardLabel}-bootloader-partitions-match-and-app-bin-witness`,
          passed: report.trials.every((trial) => stageIds.every(
            (stageId) => trial.esp32ArtifactRoleEquivalence.byStage[stageId].required.passed
              && trial.esp32ArtifactRoleEquivalence.byStage[stageId].witness.passed,
          )),
        },
        {
          id: `${boardLabel}-has-no-forbidden-adapter-artifact-residual`,
          passed: report.trials.every((trial) => stageIds.every(
            (stageId) => trial.esp32ArtifactRoleEquivalence.byStage[stageId].forbiddenAbsent,
          )),
        },
      );
    }
    if (sequenceMode) {
      report.checks.push(
        { id: 'stage-order-is-exact', passed: report.stages.map((stage) => stage.id).join('\0') === stageIds.join('\0') },
        { id: 'stage-source-hashes-match-across-lanes', passed: report.trials.every((trial) => stages.every((stage) => {
          const expected = sha256Bytes(stage.code);
          return trial.ck[stage.id].codeSha256 === expected
            && trial.native[stage.id].codeSha256 === expected
            && trial.artifactAndResourceEquivalence.byStage[stage.id].codeSha256;
        })) },
        { id: 'one-build-path-per-lane-and-trial', passed: report.trials.every((trial) => (
          new Set(stageIds.map((stageId) => trial.ck[stageId].buildPathIdentitySha256)).size === 1
          && new Set(stageIds.map((stageId) => trial.native[stageId].buildPathIdentitySha256)).size === 1
        )) },
      );
    }
    report.failures = report.checks.filter((check) => !check.passed).map((check) => `check failed: ${check.id}`);
    synchronizeReportStatuses(report);
  } catch (error) {
    if (activeTrial != null) report.partialTrial = activeTrial;
    if (error?.code === 'ARDUINO_CLI_IDLE_TIMEOUT') {
      report.failureDiagnostics = {
        code: error.code,
        phaseLabel: error.phaseLabel,
        lastProcessCount: error.lastProcessCount,
        processes: error.processes,
        processDetailsError: error.processDetailsError,
      };
    }
    const fallbackDiagnostics = fastRelinkFallbackFailureDiagnostics(error);
    const recipeDiagnostics = recipeCapabilityGateFailureDiagnostics(error);
    if (fallbackDiagnostics != null || recipeDiagnostics != null) {
      report.failureDiagnostics = fallbackDiagnostics || recipeDiagnostics;
      if (recipeDiagnostics != null) {
        process.stderr.write(`RECIPE-CAPABILITY-GATE ${JSON.stringify(recipeDiagnostics)}\n`);
      }
      try {
        const retainedLog = retainLocalQualificationFailureLog(
          options.failureLogDirectoryPath,
          error,
        );
        if (retainedLog != null) process.stderr.write(`LOCAL-FAILURE-LOG ${retainedLog}\n`);
      } catch {
        report.failures.push('local qualification failure log retention failed');
      }
    }
    report.failures.push(String(error?.stack || error));
    synchronizeReportStatuses(report);
  } finally {
    let performanceCandidate = null;
    let stagedArtifactBundle = null;
    report.finishedAt = new Date().toISOString();
    try {
      const runnerAfter = inspectRunner();
      const productionAfter = inspectProductionExecutable();
      report.runner.after = runnerAfter;
      report.runner.unchanged = sameIdentity(runnerBefore, runnerAfter);
      report.productionExecutable.after = productionAfter;
      report.productionExecutable.unchanged = sameIdentity(productionBefore, productionAfter);
      if (!report.runner.unchanged) report.failures.push('runner changed during capture');
      if (!report.productionExecutable.unchanged) report.failures.push('production executable/process changed during capture');
    } catch (error) {
      report.failures.push(`final identity verification failed: ${error?.message || error}`);
    }
    cdp?.socket.close();
    synchronizeReportStatuses(report);
    if (options.candidateArtifactBundlePath && report.measurementStatus === 'passed') {
      try {
        performanceCandidate = performanceCandidateFromReport(report, runtimeOptions);
        stagedArtifactBundle = stagePerformanceArtifactBundle(
          options.candidateArtifactBundlePath, workRoot, options.fqbn, performanceCandidate,
        );
      } catch (error) {
        report.failures.push(`performance artifact bundle staging failed: ${error?.message || error}`);
        synchronizeReportStatuses(report);
      }
    }
    try {
      report.workdir.freeBytesAfterCapture = freeBytesAt(workParent);
      const owned = inspectOwnedWorkdir(workRoot);
      Object.assign(report.workdir.cleanup, owned);
      if (!options.keepWorkdir) {
        safeRemoveWorkdir(workRoot);
        if (fs.existsSync(workRoot)) throw new Error('owned work directory still exists after removal');
        report.workdir.cleanup.removed = true;
        report.workdir.cleanup.removedPaths = ['<TEMP>/CKAB/<run-token>'];
      }
      report.workdir.freeBytesAfter = freeBytesAt(workParent);
    } catch (error) {
      report.failures.push(`workdir cleanup failed: ${error?.message || error}`);
    }
    synchronizeReportStatuses(report);
    if (report.measurementStatus !== 'passed') {
      discardStagedPerformanceArtifactBundle(stagedArtifactBundle);
      stagedArtifactBundle = null;
      performanceCandidate = null;
    }
    if (options.qualificationOperation != null && report.measurementStatus === 'passed') {
      try {
        const finalCandidate = performanceCandidateFromReport(report, runtimeOptions);
        if (performanceCandidate != null
            && !util.isDeepStrictEqual(finalCandidate, performanceCandidate)) {
          throw new Error('candidate projection changed after artifact preservation');
        }
        performanceCandidate = finalCandidate;
      } catch (error) {
        report.failures.push(`performance candidate projection failed: ${error?.message || error}`);
        discardStagedPerformanceArtifactBundle(stagedArtifactBundle);
        stagedArtifactBundle = null;
        performanceCandidate = null;
        synchronizeReportStatuses(report);
      }
    }
    let artifactBundlePublished = false;
    try {
      const captureReportBytes = jsonPayload(report);
      writeJsonNoClobber(options.outputPath, report);
      if (performanceCandidate != null) {
        const candidateBytes = jsonPayload(performanceCandidate);
        writeJsonNoClobber(options.candidateOutputPath, performanceCandidate);
        process.stdout.write(`CANDIDATE ${options.candidateOutputPath}\n`);
        if (stagedArtifactBundle != null) {
          const published = publishPerformanceArtifactBundle(
            stagedArtifactBundle, candidateBytes, captureReportBytes,
          );
          artifactBundlePublished = true;
          process.stdout.write(`CANDIDATE-ARTIFACT-BUNDLE ${published}\n`);
        }
      }
      process.stdout.write(`REPORT ${options.outputPath}\n`);
    } finally {
      if (!artifactBundlePublished) discardStagedPerformanceArtifactBundle(stagedArtifactBundle);
    }
  }
  if (report.measurementStatus === 'failed') process.exitCode = 1;
  else if (report.qualificationStatus !== 'qualified') {
    process.exitCode = 2;
  }
  return report;
}

async function main() {
  const options = parseArgs(process.argv.slice(2));
  if (options.help) {
    process.stdout.write(usage());
    return;
  }
  if (options.action === 'plan') {
    process.stdout.write(`${JSON.stringify(planFor(options), null, 2)}\nNo benchmark was started.\n`);
    return;
  }
  await execute(options);
}

module.exports = {
  AVR_NATIVE_RELINK_ADAPTER,
  SAMD_MKRZERO_NATIVE_RELINK_ADAPTER,
  ESP32C6_NATIVE_RELINK_ADAPTER,
  NATIVE_RELINK_ADAPTERS,
  ARDUINO_CLI_STARTUP_IDLE_POLICY_ID,
  ARDUINO_CLI_STARTUP_IDLE_WINDOW_MS,
  ARDUINO_CLI_STARTUP_IDLE_TIMEOUT_MS,
  ARDUINO_CLI_STARTUP_POLL_INTERVAL_MS,
  ARDUINO_CLI_PRETRIAL_IDLE_POLICY_ID,
  ARDUINO_CLI_PRETRIAL_IDLE_WINDOW_MS,
  ARDUINO_CLI_PRETRIAL_IDLE_TIMEOUT_MS,
  ARDUINO_CLI_PRETRIAL_IDLE_POLL_INTERVAL_MS,
  ARDUINO_CLI_LANE_IDLE_POLICY_ID,
  ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
  ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
  ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
  DEFAULT_SEQUENCE,
  FORGE_QUALIFICATION_OPERATIONS,
  FORGE_QUALIFICATION_PROFILES,
  PORTABLE_FAST_PROFILE,
  PORTABLE_FAST_RECIPE_INTENT,
  PORTABLE_FAST_CK_BUILD_MODES,
  QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
  QUALIFICATION_SOURCE_DATE_EPOCH,
  QUALIFICATION_TIME_ZONE,
  PRODUCTION_EXECUTABLE_PATH_ENV,
  PRODUCTION_EXECUTABLE_SHA256_ENV,
  PRODUCTION_PROCESS_ID_ENV,
  FAST_RELINK_FALLBACK_CODES,
  FAST_PROFILE_PERFORMANCE_POLICY,
  FAST_PROFILE_NATIVE_BUILD_PROPERTIES,
  CLI_CONFIG,
  FAST_CLI_CONFIG,
  COMPILE_ONLY_APPLICATION_ARTIFACT_EQUIVALENCE_POLICY_ID,
  COMPILE_ONLY_SEMANTIC_APPLICATION_ROLES,
  GENERIC_ARTIFACT_EQUIVALENCE_POLICY_ID,
  PORTABLE_FAST_ESP_APPLICATION_BIN_EQUIVALENCE_POLICY_ID,
  PERFORMANCE_QUALIFICATION_POLICY,
  PORTABLE_EDIT_SEQUENCE,
  PORTABLE_EDIT_SEQUENCE_NAME,
  PORTABLE_SKETCH,
  REQUIRED_CK_MODE_NATIVE_RELINK,
  artifactRole,
  arduinoCliProcessCount,
  arduinoCliProcessDetails,
  assertFreeSpace,
  assertNoConcurrentArduinoCli,
  boardDetailsBindTarget,
  canonicalCompleteFqbn,
  cdpPreflightTimeoutMs,
  captureOrder,
  createCdp,
  createNativeTrial,
  digestObject,
  effectiveJobs,
  espApplicationPayloadRecipeProofForCore,
  espFlashArgumentsWitness,
  validEspFlashArgumentsWitness,
  freeBytesAt,
  getCdpTarget,
  hostEnvironmentFingerprint,
  hostEnvironmentFingerprintFromParts,
  hasForbiddenAdapterArtifact,
  inspectCliAndCore,
  inspectOwnedWorkdir,
  inspectCkArtifacts,
  inspectProductionExecutable,
  productionExecutableBindingContract,
  validateProductionProcessBinding,
  localQualificationFailureLogText,
  compareArtifactRoles,
  compareOptionalArtifactRoles,
  compareWitnessArtifactRoles,
  compareArtifactEquivalenceForOptions,
  compareNativeRelinkAdapterArtifactEquivalence,
  compareCompileOnlyApplicationArtifactEquivalence,
  compareGenericArtifactEquivalence,
  compareAvrArtifactRoles,
  corePackageFromFqbn,
  evaluatePerformanceQualification,
  fastRelinkFallbackFailureDiagnostics,
  fastFinalFlagPropertiesFromPlatformText,
  hasStaleAvrWithBootloader,
  median,
  measurementStages,
  nativeBaselineContract,
  nativeBaselineCompilerPropertiesSha256,
  nativeRelinkAdapterFor,
  parseArgs,
  parseResources,
  performanceCandidateFromReport,
  performanceCompilePropertyDelta,
  publishPerformanceArtifactBundle,
  percentileNearestRank,
  planFor,
  recipeCapabilityFailureDiagnosticsFromRecipe,
  recipeCapabilityGateError,
  recipeCapabilityGateFailureDiagnostics,
  redactedRecipeCapabilityBlocker,
  resourcesEquivalent,
  retainLocalQualificationFailureLog,
  artifactEquivalencePolicyIdForOptions,
  artifactSetSha256,
  requiredCkModeEvidence,
  qualificationReproducibility,
  hasQualificationReproducibility,
  runCdpPreflightAndWaitForPreTrialStability,
  runCkCompile,
  runNativeCompile,
  runProcess,
  observeCkRecipeCapability,
  safeRemoveWorkdir,
  sanitizedDiagnosticBuildMode,
  sanitizedQualificationPhase,
  sha256Bytes,
  stagePerformanceArtifactBundle,
  summarize,
  sanitizedChildEnvironment,
  synchronizeReportStatuses,
  toolchainContentSha256,
  updateNativeTrialSource,
  usesCompileOnlyApplicationArtifactEquivalence,
  validateCacheClear,
  validateCkCompilerEvidence,
  validateRecipeCapability,
  validEspApplicationPayloadRecipeProof,
  validatedFastRelinkFallbackCode,
  validatePortableEditSequence,
  waitForArduinoCliIdleWindow,
  terminateOwnedProcessTree,
  windowsTaskkillArgs,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
