#!/usr/bin/env node
'use strict';

const { spawnSync } = require('node:child_process');
const { existsSync, lstatSync, readFileSync } = require('node:fs');
const path = require('node:path');

const REPO_ROOT = path.resolve(__dirname, '..');
const LEGACY_HARNESS = path.join(
  REPO_ROOT,
  'artifacts',
  'benchmarks',
  'Run-CrossBoard-CompileOnly.cjs',
);
const REPORT_SCHEMA = path.join(
  REPO_ROOT,
  'docs',
  'schemas',
  'ck-forge-regression-report.schema.json',
);

// The checked-in qualification rows currently prove correctness only. A
// platform/host match is not a performance certificate, so every catalog row
// remains on native Arduino CLI until a versioned A/B report is attached.
const BUILTIN_EXPECTED_DECISION = 'force-platform';
const BUILTIN_EXPECTED_PROFILE = 'release';

const BASE_TARGETS = Object.freeze([
  { id: 'c3', label: 'ESP32-C3', fqbn: 'esp32:esp32:esp32c3', architecture: 'esp32', builtinUiBoard: true },
  { id: 'c5', label: 'ESP32-C5', fqbn: 'esp32:esp32:esp32c5', architecture: 'esp32', builtinUiBoard: true },
  { id: 'c6', label: 'ESP32-C6', fqbn: 'esp32:esp32:esp32c6', architecture: 'esp32', builtinUiBoard: true },
  { id: 's3', label: 'ESP32-S3', fqbn: 'esp32:esp32:esp32s3', architecture: 'esp32', builtinUiBoard: true },
  { id: 's2', label: 'ESP32-S2', fqbn: 'esp32:esp32:esp32s2', architecture: 'esp32', builtinUiBoard: true },
  { id: 'esp32', label: 'ESP32 Dev Module', fqbn: 'esp32:esp32:esp32', architecture: 'esp32', builtinUiBoard: true },
  { id: 'avr', label: 'Arduino Uno', fqbn: 'arduino:avr:uno', architecture: 'avr', builtinUiBoard: true },
  { id: 'nano', label: 'Arduino Nano (ATmega328P)', fqbn: 'arduino:avr:nano:cpu=atmega328', architecture: 'avr', builtinUiBoard: true },
  { id: 'mega', label: 'Arduino Mega 2560', fqbn: 'arduino:avr:mega:cpu=atmega2560', architecture: 'avr', builtinUiBoard: true },
  { id: 'diecimila', label: 'Arduino Duemilanove (ATmega328P)', fqbn: 'arduino:avr:diecimila:cpu=atmega328', architecture: 'avr', builtinUiBoard: true },
  { id: 'esp8266', label: 'NodeMCU 1.0 (ESP-12E)', fqbn: 'esp8266:esp8266:nodemcuv2', architecture: 'esp8266', builtinUiBoard: false },
]);

// These rows exercise high-risk menu combinations advertised by ESP32 Core
// 3.3.6. They are compile-only configurations, not physical module claims:
// in particular PSRAM=enabled cannot prove that a connected C5 actually has
// 8 MiB PSRAM. Hardware capacity remains the device-health gate's job.
const CONFIGURATION_TARGETS = Object.freeze([
  {
    id: 'c5-n16r8-config',
    label: 'ESP32-C5 N16R8 menu profile',
    fqbn: 'esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled',
    architecture: 'esp32',
    builtinUiBoard: true,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
  {
    id: 'c6-16m-config',
    label: 'ESP32-C6 16MB menu profile',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
    architecture: 'esp32',
    builtinUiBoard: true,
    hardwareTested: false,
    expectedForgeDecision: BUILTIN_EXPECTED_DECISION,
    expectedCompileProfile: BUILTIN_EXPECTED_PROFILE,
  },
  {
    id: 's3-16m-opi-config',
    label: 'ESP32-S3 16MB OPI PSRAM menu profile',
    fqbn: 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi',
    architecture: 'esp32',
    builtinUiBoard: true,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
]);

// Installed board definitions deliberately outside CK Forge v1's qualified
// fast-path list. These are native-compatibility sentinels: every new run must
// keep the Core's unmodified Arduino CLI recipes/hooks and must not receive a
// Fast label before an independent no-regression A/B qualification passes.
const COMPATIBILITY_TARGETS = Object.freeze([
  {
    id: 'h2',
    label: 'ESP32-H2 Dev Module',
    fqbn: 'esp32:esp32:esp32h2',
    architecture: 'esp32',
    builtinUiBoard: false,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
  {
    id: 'p4',
    label: 'ESP32-P4 Dev Module',
    fqbn: 'esp32:esp32:esp32p4',
    architecture: 'esp32',
    builtinUiBoard: false,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
  {
    id: 'compat-esp32s3-feather',
    label: 'Adafruit Feather ESP32-S3 2MB PSRAM',
    fqbn: 'esp32:esp32:adafruit_feather_esp32s3',
    architecture: 'esp32',
    builtinUiBoard: false,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
  {
    id: 'compat-avr-leonardo',
    label: 'Arduino Leonardo',
    fqbn: 'arduino:avr:leonardo',
    architecture: 'avr',
    builtinUiBoard: false,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
  {
    id: 'compat-esp8266-generic',
    label: 'Generic ESP8266 Module',
    fqbn: 'esp8266:esp8266:generic',
    architecture: 'esp8266',
    builtinUiBoard: false,
    hardwareTested: false,
    expectedForgeDecision: 'force-platform',
    expectedCompileProfile: 'release',
  },
]);

const TARGETS = Object.freeze([
  ...BASE_TARGETS.map((target) => Object.freeze({
    ...target,
    hardwareTested: false,
    expectedForgeDecision: BUILTIN_EXPECTED_DECISION,
    expectedCompileProfile: BUILTIN_EXPECTED_PROFILE,
  })),
  ...CONFIGURATION_TARGETS,
  ...COMPATIBILITY_TARGETS,
]);

const MATRICES = Object.freeze({
  minimum: Object.freeze(['c3', 'c5', 'c6', 's3', 'nano', 'mega', 'esp8266']),
  release: Object.freeze(BASE_TARGETS.map((target) => target.id)),
  dependency: Object.freeze(['c6', 'nano', 'esp8266']),
  configuration: Object.freeze(CONFIGURATION_TARGETS.map((target) => target.id)),
  compatibility: Object.freeze(COMPATIBILITY_TARGETS.map((target) => target.id)),
});

function usage() {
  return `CK Forge Regression v1

Usage:
  node scripts/Run-CKForgeRegression.cjs
  node scripts/Run-CKForgeRegression.cjs --list
  node scripts/Run-CKForgeRegression.cjs --plan --matrix minimum --output <new.json>
  node scripts/Run-CKForgeRegression.cjs --execute --matrix minimum --output <new.json>

Actions (choose exactly one):
  --list                  Print the stable target and matrix catalog; never compile.
  --plan                  Print the delegated command; never compile or clear cache.
  --execute               Explicitly run the compile-only regression harness.

Target selection (required by --plan and --execute):
  --matrix <name>         minimum, release, dependency, configuration, or compatibility.
  --targets <ids>         Explicit comma-separated target IDs; cannot combine with --matrix.

Execution options:
  --output <new.json>     Required. Existing paths are always refused.
  --dependency-cycle     Run simple -> built-in dependency -> simple -> Exact.
  --no-exact             Explicitly omit the identical-source Exact pass.
  --timeout-minutes <n>  Per-compile timeout, 1..120 (default 20).
  --cold                  Request first-project cache cleanup for exact target FQBNs.
  --allow-cache-reset     Required together with --cold; has no effect by itself.

Safety defaults:
  No arguments only print this help. CK Forge never uploads, opens a serial port,
  probes hardware, or writes Flash. It does not clear caches unless both --cold and
  --allow-cache-reset are present. Compilation still populates normal build caches.
`;
}

function targetById(id) {
  return TARGETS.find((target) => target.id === id);
}

function parseTargetIds(value) {
  if (typeof value !== 'string' || value.trim() === '') {
    throw new Error('--targets requires a non-empty comma-separated value');
  }
  const ids = value.split(',').map((item) => item.trim().toLowerCase()).filter(Boolean);
  if (new Set(ids).size !== ids.length) throw new Error('--targets must not contain duplicates');
  for (const id of ids) {
    if (!targetById(id)) throw new Error(`Unknown CK Forge target '${id}'`);
  }
  return ids;
}

function parseArgs(argv) {
  const options = {
    action: null,
    matrix: null,
    targetIds: null,
    outputPath: null,
    dependencyCycle: false,
    includeExact: true,
    cold: false,
    allowCacheReset: false,
    timeoutMinutes: 20,
    help: false,
  };

  const setAction = (action) => {
    if (options.action && options.action !== action) {
      throw new Error(`Choose exactly one action; already selected --${options.action}`);
    }
    options.action = action;
  };

  for (let index = 0; index < argv.length; ++index) {
    const argument = argv[index];
    if (argument === '--list') {
      setAction('list');
    } else if (argument === '--plan') {
      setAction('plan');
    } else if (argument === '--execute') {
      setAction('execute');
    } else if (argument === '--matrix') {
      const value = argv[++index];
      if (!value || !Object.hasOwn(MATRICES, value)) {
        throw new Error('--matrix must be one of: minimum, release, dependency, configuration, compatibility');
      }
      options.matrix = value;
    } else if (argument === '--targets') {
      options.targetIds = parseTargetIds(argv[++index]);
    } else if (argument === '--output') {
      const value = argv[++index];
      if (!value) throw new Error('--output requires a new JSON path');
      options.outputPath = path.resolve(process.cwd(), value);
      if (path.extname(options.outputPath).toLowerCase() !== '.json') {
        throw new Error('--output must use the .json extension');
      }
    } else if (argument === '--dependency-cycle') {
      options.dependencyCycle = true;
    } else if (argument === '--no-exact') {
      options.includeExact = false;
    } else if (argument === '--cold') {
      options.cold = true;
    } else if (argument === '--allow-cache-reset') {
      options.allowCacheReset = true;
    } else if (argument === '--timeout-minutes') {
      const value = Number(argv[++index]);
      if (!Number.isFinite(value) || value < 1 || value > 120) {
        throw new Error('--timeout-minutes must be a number from 1 through 120');
      }
      options.timeoutMinutes = value;
    } else if (argument === '--help' || argument === '-h') {
      options.help = true;
    } else {
      throw new Error(`Unknown argument '${argument}'`);
    }
  }

  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('Choose --list, --plan, or --execute');
  if (options.matrix && options.targetIds) throw new Error('--matrix and --targets cannot be combined');

  if (options.action === 'list') {
    const executionOptionUsed = options.matrix || options.targetIds || options.outputPath
      || options.dependencyCycle || !options.includeExact || options.cold
      || options.allowCacheReset || options.timeoutMinutes !== 20;
    if (executionOptionUsed) throw new Error('--list cannot be combined with execution options');
    return options;
  }

  if (!options.matrix && !options.targetIds) {
    throw new Error('--plan and --execute require an explicit --matrix or --targets selection');
  }
  if (!options.outputPath) throw new Error('--plan and --execute require an explicit --output path');
  if (options.cold && !options.allowCacheReset) {
    throw new Error('--cold requires the separate --allow-cache-reset acknowledgement');
  }
  if (options.allowCacheReset && !options.cold) {
    throw new Error('--allow-cache-reset is only valid together with --cold');
  }

  return {
    ...options,
    targetIds: options.targetIds || [...MATRICES[options.matrix]],
  };
}

function pathEntryExists(candidate) {
  try {
    lstatSync(candidate);
    return true;
  } catch (error) {
    if (error && error.code === 'ENOENT') return false;
    throw error;
  }
}

function assertOutputAvailable(outputPath) {
  if (pathEntryExists(outputPath)) {
    throw new Error(`Refusing to overwrite existing CK Forge report: ${outputPath}`);
  }
}

function buildHarnessArgs(options) {
  const args = [
    LEGACY_HARNESS,
    '--targets',
    options.targetIds.join(','),
    '--output',
    options.outputPath,
    '--timeout-minutes',
    String(options.timeoutMinutes),
  ];
  if (!options.includeExact) args.push('--no-exact');
  if (options.dependencyCycle) args.push('--dependency-cycle');
  if (options.cold) args.push('--cold');
  return args;
}

function planFor(options) {
  const harnessArgs = buildHarnessArgs(options);
  return {
    schema_version: 1,
    action: options.action,
    matrix: options.matrix,
    target_ids: [...options.targetIds],
    fqbn_targets: options.targetIds.map((id) => targetById(id).fqbn),
    target_expectations: options.targetIds.map((id) => {
      const target = targetById(id);
      return {
        id: target.id,
        fqbn: target.fqbn,
        hardware_tested: false,
        expected_forge_decision: target.expectedForgeDecision || null,
        expected_compile_profile: target.expectedCompileProfile || null,
      };
    }),
    phases: [
      'compile',
      ...(options.dependencyCycle ? ['dependency', 'simple-return'] : []),
      ...(options.includeExact ? ['exact'] : []),
    ],
    compile_only: true,
    upload_performed: false,
    hardware_tested: false,
    cache_reset_requested: options.cold,
    cache_reset_acknowledged: options.allowCacheReset,
    output_path: options.outputPath,
    delegated_program: path.relative(REPO_ROOT, LEGACY_HARNESS).replaceAll('\\', '/'),
    delegated_arguments: harnessArgs.slice(1),
    report_schema: path.relative(REPO_ROOT, REPORT_SCHEMA).replaceAll('\\', '/'),
  };
}

function validatePublishedReport(report, options) {
  if (!report || typeof report !== 'object' || Array.isArray(report)) {
    throw new Error('CK Forge report is not a JSON object');
  }
  if (report.schemaId !== 'ck.cross-board-compile-only-matrix' || report.schemaVersion !== 2) {
    throw new Error('CK Forge delegated report has an unsupported schema identity');
  }
  if (!['passed', 'passed-with-warnings'].includes(report.status)
      || !Array.isArray(report.failures)
      || report.failures.length !== 0) {
    throw new Error('CK Forge delegated report did not publish a passing final status');
  }
  const safety = report.controls || {};
  for (const [field, expected] of [
    ['compileOnly', true],
    ['uploadPerformed', false],
    ['physicalFlashWritten', false],
    ['serialPortAccessed', false],
    ['deviceProbePerformed', false],
    ['hardwareTested', false],
    ['formalProjectModified', false],
  ]) {
    if (safety[field] !== expected) throw new Error(`CK Forge safety field ${field} is invalid`);
  }
  if (safety.explicitCacheClear !== options.cold) {
    throw new Error('CK Forge cache-reset evidence does not match the requested plan');
  }
  if (typeof options.includeExact === 'boolean'
      && safety.exactRecompileRequested !== options.includeExact) {
    throw new Error('CK Forge Exact evidence does not match the requested plan');
  }
  if (!Array.isArray(report.checks) || report.checks.length === 0) {
    throw new Error('CK Forge delegated report has no matrix checks');
  }
  for (const check of report.checks) {
    if (check?.skipped !== true && check?.passed !== true) {
      throw new Error(`CK Forge matrix check ${check?.id || '(unknown)'} did not pass`);
    }
  }
  if (JSON.stringify(report.selectedTargetIds) !== JSON.stringify(options.targetIds)) {
    throw new Error('CK Forge report target selection does not match the requested plan');
  }
  if (!Array.isArray(report.targets)
      || JSON.stringify(report.targets.map((target) => target.id)) !== JSON.stringify(options.targetIds)) {
    throw new Error('CK Forge report target rows do not match the requested plan');
  }
  for (const target of report.targets) {
    if (target.hardwareTested !== false
        || !Array.isArray(target.runs)
        || !['passed', 'passed-with-warnings'].includes(target.status)
        || !Array.isArray(target.checks)) {
      throw new Error(`CK Forge target ${target.id || '(unknown)'} has invalid evidence scope`);
    }
    for (const check of target.checks) {
      if (check?.skipped !== true && check?.passed !== true) {
        throw new Error(
          `CK Forge target check ${target.id}/${check?.id || '(unknown)'} did not pass`,
        );
      }
    }
    const catalogTarget = targetById(target.id);
    for (const run of target.runs) {
      if (run.uploadPerformed !== false || run.hardwareTested !== false || run.success !== true) {
        throw new Error(`CK Forge run ${target.id}/${run.phase || '(unknown)'} exceeded compile-only scope`);
      }
      if (run.engine?.id !== 'ck-forge'
          || run.engine?.schemaVersion !== 1
          || !['allow-fast', 'force-platform'].includes(run.engine?.decision)
          || !Array.isArray(run.engine?.reasonCodes)
          || run.engine.reasonCodes.length === 0) {
        throw new Error(`CK Forge run ${target.id}/${run.phase || '(unknown)'} has no valid engine route evidence`);
      }
      if (!['process-memory', 'persistent-metadata', 'strong-content'].includes(
        run.environment?.toolchainIdentitySource,
      )) {
        throw new Error(
          `CK Forge run ${target.id}/${run.phase || '(unknown)'} has no valid toolchain identity source`,
        );
      }
      if (catalogTarget?.expectedForgeDecision
          && run.engine.decision !== catalogTarget.expectedForgeDecision) {
        throw new Error(
          `CK Forge target ${target.id}/${run.phase || '(unknown)'} reported ${run.engine.decision}; expected ${catalogTarget.expectedForgeDecision}`,
        );
      }
      if (catalogTarget?.expectedCompileProfile
          && run.profile !== catalogTarget.expectedCompileProfile) {
        throw new Error(
          `CK Forge target ${target.id}/${run.phase || '(unknown)'} reported profile ${run.profile}; expected ${catalogTarget.expectedCompileProfile}`,
        );
      }
      const exactMode = run.buildMode === 'exact-match';
      if (typeof run.cache?.exactMatch !== 'boolean' || run.cache.exactMatch !== exactMode) {
        throw new Error(
          `CK Forge target ${target.id}/${run.phase || '(unknown)'} has inconsistent Exact evidence`,
        );
      }
      if (run.engine.decision === 'force-platform'
          && run.profile !== 'release') {
        throw new Error(
          `CK Forge target ${target.id}/${run.phase || '(unknown)'} did not stay on the native Release lane`,
        );
      }
      if (run.engine.decision === 'allow-fast'
          && (run.profile !== 'quick-fast' || (run.phase === 'exact' && !exactMode))) {
        throw new Error(
          `CK Forge target ${target.id}/${run.phase || '(unknown)'} did not satisfy the fast Exact contract`,
        );
      }
    }
  }
  return true;
}

function catalog() {
  return {
    schema_version: 1,
    contract: 'ck-forge-regression-v1',
    default_action: 'help-only',
    matrices: Object.fromEntries(Object.entries(MATRICES).map(([name, ids]) => [name, [...ids]])),
    targets: TARGETS.map((target) => ({ ...target })),
    safety: {
      compile_only: true,
      uploads: false,
      serial_or_device_probe: false,
      default_cache_reset: false,
      cache_reset_requires: ['--cold', '--allow-cache-reset'],
    },
  };
}

function execute(options) {
  if (!existsSync(LEGACY_HARNESS)) {
    throw new Error(`CK Forge delegated harness is missing: ${LEGACY_HARNESS}`);
  }
  if (!existsSync(REPORT_SCHEMA)) {
    throw new Error(`CK Forge report schema is missing: ${REPORT_SCHEMA}`);
  }
  assertOutputAvailable(options.outputPath);
  const result = spawnSync(process.execPath, buildHarnessArgs(options), {
    cwd: REPO_ROOT,
    encoding: 'utf8',
    stdio: 'inherit',
    windowsHide: true,
  });
  if (result.error) throw result.error;
  if (result.status !== 0) return result.status ?? 1;
  if (!existsSync(options.outputPath)) throw new Error('CK Forge harness exited successfully without publishing its report');
  const report = JSON.parse(readFileSync(options.outputPath, 'utf8'));
  validatePublishedReport(report, options);
  return 0;
}

function main(argv = process.argv.slice(2)) {
  try {
    const options = parseArgs(argv);
    if (options.help) {
      process.stdout.write(`${usage()}\nNo regression run was started.\n`);
      return 0;
    }
    if (options.action === 'list') {
      process.stdout.write(`${JSON.stringify(catalog(), null, 2)}\n`);
      return 0;
    }
    if (options.action === 'plan') {
      process.stdout.write(`${JSON.stringify(planFor(options), null, 2)}\nNo regression run was started.\n`);
      return 0;
    }
    return execute(options);
  } catch (error) {
    process.stderr.write(`CK Forge: ${error instanceof Error ? error.message : String(error)}\n`);
    return 1;
  }
}

if (require.main === module) process.exitCode = main();

module.exports = {
  BASE_TARGETS,
  COMPATIBILITY_TARGETS,
  CONFIGURATION_TARGETS,
  LEGACY_HARNESS,
  MATRICES,
  REPORT_SCHEMA,
  TARGETS,
  assertOutputAvailable,
  buildHarnessArgs,
  catalog,
  main,
  parseArgs,
  planFor,
  validatePublishedReport,
};
