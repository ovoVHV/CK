#!/usr/bin/env node
'use strict';

// Compile-only A/B evidence runner for the ESP32 library-aware FLFE candidate.
// It never uploads. Graph-establishing stages may use a clean Release fallback;
// only same-graph sketch edits are eligible for the performance claim.

const crypto = require('node:crypto');
const fs = require('node:fs');
const os = require('node:os');
const path = require('node:path');

const dependency = require('./Run-CKAvrDependencyEditRegression.cjs');
const forge = require('./Run-CKForgeNativeAB.cjs');

const REPO_ROOT = path.resolve(__dirname, '..');
const PLAN_SCHEMA_ID = 'ck.esp32.library-edit-regression-plan';
const REPORT_SCHEMA_ID = 'ck.esp32.library-edit-regression-report';
const SCHEMA_VERSION = 1;
const DEFAULT_FQBN = 'esp32:esp32:esp32c6';
const DEFAULT_TIMEOUT_MINUTES = 15;
const DEFAULT_MIN_FREE_GIB = 8;
const FIXTURE_NAME = 'CKEsp32LibraryProbeQ17';
const FIXTURE_MARKER = '.ck-esp32-library-edit-fixture.json';
const FIXTURE_SCHEMA_ID = 'ck.esp32.library-edit-fixture';
const FIXTURE_SCHEMA_VERSION = 1;
const CCDB_SCHEMA_ID = 'ck.esp32.library-edit-ccdb-evidence';
const CCDB_SCHEMA_VERSION = 1;
const CCDB_MAX_BYTES = 16 * 1024 * 1024;
const CCDB_MAX_ENTRIES = 8192;
const ESP32_LIBRARY_NATIVE_RELINK_DIAGNOSTIC_SCHEMA_VERSION = 1;
const ESP32_LIBRARY_NATIVE_RELINK_MANIFEST_SCHEMA_VERSION = 4;
const ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT = 'ck-esp32-library-relink-evidence-v4';
const ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID =
  'ck-esp32-library-native-relink-evidence-v4';
const ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER =
  '[INFO] NativeRelinkCompileOnly path: ESP32 Release sketch compile + sealed library objects in native order + native artifact recipes';
const ESP32_LIBRARY_NATIVE_RELINK_HASH_FIELDS = Object.freeze([
  'manifestSha256',
  'propertyContractSha256',
  'commandGraphSha256',
  'libraryTreeSha256',
  'orderedLinkInputsSha256',
  'nativeLinkArgvSha256',
  'nativeLinkExecutableSha256',
  'nativeLinkResponseGraphSha256',
]);
const ESP32_LIBRARY_NATIVE_RELINK_STABLE_FIELDS = Object.freeze([
  'schemaVersion',
  'evidenceContract',
  'manifestSchemaVersion',
  'propertyContractSha256',
  'commandGraphSha256',
  'libraryTreeSha256',
  'libraryRootCount',
  'libraryFileCount',
  'libraryTotalBytes',
  'orderedLinkInputsSha256',
  'nativeLinkArgvSha256',
  'nativeLinkExecutableSha256',
  'nativeLinkResponseGraphSha256',
  'nativeLinkResponseFileCount',
]);
const MAX_ESP32_LIBRARY_NATIVE_RELINK_ROOTS = 16;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_FILES = 16_384;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_BYTES = 512 * 1024 * 1024;
const MAX_ESP32_LIBRARY_NATIVE_RELINK_RESPONSE_FILES = 128;
const QUALIFICATION_TOKEN_ENV = 'CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN';
const REQUIRED_ESP32_ARTIFACT_ROLES = Object.freeze([
  'application-bin',
  'bootloader-bin',
  'partitions-bin',
  'flash-arguments',
]);
const LANE_LOCAL_DIAGNOSTIC_ARTIFACT_ROLES = Object.freeze(['merged-firmware-bin']);
const PERFORMANCE_POLICY = Object.freeze({
  id: 'ck-esp32-library-same-graph-edit-performance-v1',
  minimumMedianSpeedupPct: 20,
  minimumAbsoluteMedianGainMs: 500,
  aggregation: 'median',
  graphEstablishingStagesRecordedOnly: true,
  formalRecommendedTrials: 5,
  certification: false,
});

function sha256Bytes(value) {
  return crypto.createHash('sha256').update(value).digest('hex');
}

function canonicalJson(value) {
  if (value === null || typeof value !== 'object') return JSON.stringify(value);
  if (Array.isArray(value)) return `[${value.map(canonicalJson).join(',')}]`;
  return `{${Object.keys(value).sort().map((key) => `${JSON.stringify(key)}:${canonicalJson(value[key])}`).join(',')}}`;
}

function finalizeRun(run) {
  const withVersion = { ...run, integritySchemaVersion: 2 };
  const { evidenceSha256, ...projection } = withVersion;
  delete projection.wallMs;
  projection.rawTiming = projection.rawTiming && typeof projection.rawTiming === 'object'
    ? { runnerWallNs: projection.rawTiming.runnerWallNs }
    : null;
  return { ...withVersion, evidenceSha256: forge.digestObject(projection) };
}

function fixtureFiles() {
  return Object.freeze({
    'library.properties': [
      `name=${FIXTURE_NAME}`,
      'version=1.0.0',
      'author=CK deterministic ESP32 regression fixture',
      'maintainer=CK deterministic ESP32 regression fixture',
      'sentence=Name-agnostic ESP32 library edit regression fixture.',
      'paragraph=Installed temporarily for compile-only CK versus Arduino CLI evidence.',
      'category=Other',
      'url=https://invalid.example/ck-esp32-library-edit-fixture',
      'architectures=esp32',
      '',
    ].join('\n'),
    [`src/${FIXTURE_NAME}.h`]: [
      '#ifndef CK_ESP32_LIBRARY_PROBE_Q17_H',
      '#define CK_ESP32_LIBRARY_PROBE_Q17_H',
      '#include <stdint.h>',
      'uint32_t ck_esp32_library_probe_q17(uint32_t value);',
      '#endif',
      '',
    ].join('\n'),
    [`src/${FIXTURE_NAME}.cpp`]: [
      `#include "${FIXTURE_NAME}.h"`,
      '#include "nested/CKEsp32LibraryProbeDetail.h"',
      'uint32_t ck_esp32_library_probe_q17(uint32_t value) {',
      '  return ck_esp32_library_probe_detail(value) + 17U;',
      '}',
      '',
    ].join('\n'),
    'src/nested/CKEsp32LibraryProbeDetail.h': [
      '#ifndef CK_ESP32_LIBRARY_PROBE_DETAIL_H',
      '#define CK_ESP32_LIBRARY_PROBE_DETAIL_H',
      '#include <stdint.h>',
      '#ifdef __cplusplus',
      'extern "C" {',
      '#endif',
      'uint32_t ck_esp32_library_probe_detail(uint32_t value);',
      '#ifdef __cplusplus',
      '}',
      '#endif',
      '#endif',
      '',
    ].join('\n'),
    'src/nested/CKEsp32LibraryProbeDetail.c': [
      '#include "CKEsp32LibraryProbeDetail.h"',
      'uint32_t ck_esp32_library_probe_detail(uint32_t value) {',
      '  return value * 3U + 29U;',
      '}',
      '',
    ].join('\n'),
  });
}

const FIXTURE_TRANSLATION_UNITS = Object.freeze([
  `src/${FIXTURE_NAME}.cpp`,
  'src/nested/CKEsp32LibraryProbeDetail.c',
]);

function fixtureManifest() {
  const files = fixtureFiles();
  const manifest = {
    schemaId: FIXTURE_SCHEMA_ID,
    schemaVersion: FIXTURE_SCHEMA_VERSION,
    libraryName: FIXTURE_NAME,
    architectures: ['esp32'],
    shape: 'modern-src-deep-mixed-c-cpp',
    translationUnits: FIXTURE_TRANSLATION_UNITS.map((sourceRelativePath) => ({
      sourceRelativePath,
      language: path.extname(sourceRelativePath).toLowerCase() === '.c' ? 'c' : 'cpp',
      bytes: Buffer.byteLength(files[sourceRelativePath], 'utf8'),
      sha256: sha256Bytes(files[sourceRelativePath]),
    })),
    files: Object.entries(files).map(([filePath, content]) => ({
      path: filePath,
      bytes: Buffer.byteLength(content, 'utf8'),
      sha256: sha256Bytes(content),
    })).sort((left, right) => Buffer.from(left.path).compare(Buffer.from(right.path))),
  };
  return { ...manifest, manifestSha256: forge.digestObject(manifest) };
}

function thirdPartySketch(seed) {
  return [
    `#include <${FIXTURE_NAME}.h>`,
    '',
    'volatile uint32_t ck_library_sink = 0;',
    'void setup() {',
    `  ck_library_sink = ck_esp32_library_probe_q17(${seed}U);`,
    '}',
    'void loop() {',
    '  if (ck_library_sink == 0xFFFFFFFFUL) {',
    `    ck_library_sink = ck_esp32_library_probe_q17(${seed + 1}U);`,
    '  }',
    '}',
    '',
  ].join('\n');
}

function coreLibrarySketch(seed) {
  return [
    '#include <SPI.h>',
    '',
    'volatile uint32_t ck_library_sink = 0;',
    'void setup() {',
    '  SPI.begin();',
    `  ck_library_sink = ${seed}U;`,
    '}',
    'void loop() {',
    '  if (ck_library_sink == 0xFFFFFFFFUL) {',
    `    ck_library_sink = ${seed + 1}U;`,
    '  }',
    '}',
    '',
  ].join('\n');
}

function stage(id, workload, transitionKind, performanceRequired, code) {
  return Object.freeze({
    id,
    workload,
    transitionKind,
    performanceRequired,
    preferredRoute: performanceRequired ? dependency.NATIVE_RELINK_ROUTE : null,
    code,
    sourceSha256: sha256Bytes(code),
  });
}

const LIBRARY_EDIT_SEQUENCE = Object.freeze([
  stage('third-party-cold', 'third-party', 'graph-establishing', false, thirdPartySketch(3)),
  stage('third-party-same-graph-edit', 'third-party', 'same-library-graph-edit', true, thirdPartySketch(11)),
  stage('core-library-cold', 'core-library', 'graph-transition', false, coreLibrarySketch(5)),
  stage('core-library-same-graph-edit', 'core-library', 'same-library-graph-edit', true, coreLibrarySketch(13)),
]);

function validateFixtureDefinition() {
  const manifest = fixtureManifest();
  const files = fixtureFiles();
  return manifest.architectures.join(',') === 'esp32'
    && manifest.shape === 'modern-src-deep-mixed-c-cpp'
    && manifest.translationUnits.length === 2
    && new Set(manifest.translationUnits.map((unit) => unit.language)).size === 2
    && Object.values(files).every((content) => typeof content === 'string')
    && LIBRARY_EDIT_SEQUENCE.every((entry) => entry.sourceSha256 === sha256Bytes(entry.code))
    && LIBRARY_EDIT_SEQUENCE.filter((entry) => entry.performanceRequired).length === 2;
}

function parseInteger(value, label, minimum, maximum) {
  if (!/^\d+$/u.test(String(value || ''))) throw new Error(`${label} must be an integer`);
  const parsed = Number(value);
  if (!Number.isSafeInteger(parsed) || parsed < minimum || parsed > maximum) {
    throw new Error(`${label} must be in ${minimum}..${maximum}`);
  }
  return parsed;
}

function parseArgs(argv) {
  const options = {
    action: null,
    fqbn: DEFAULT_FQBN,
    trials: 1,
    timeoutMinutes: DEFAULT_TIMEOUT_MINUTES,
    minFreeGiB: DEFAULT_MIN_FREE_GIB,
    outputPath: null,
    allowCacheReset: false,
    allowFixtureInstall: false,
    keepWorkdir: false,
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
    else if (argument === '--cleanup-owned-fixture') setAction('cleanup-owned-fixture');
    else if (argument === '--fqbn') options.fqbn = forge.canonicalCompleteFqbn(argv[++index]);
    else if (argument === '--trials') options.trials = parseInteger(argv[++index], '--trials', 1, 5);
    else if (argument === '--timeout-minutes') options.timeoutMinutes = parseInteger(argv[++index], '--timeout-minutes', 1, 60);
    else if (argument === '--min-free-gib') options.minFreeGiB = parseInteger(argv[++index], '--min-free-gib', 8, 100);
    else if (argument === '--output') {
      const output = argv[++index];
      if (!output) throw new Error('--output requires a JSON file');
      options.outputPath = path.resolve(process.cwd(), output);
    } else if (argument === '--allow-cache-reset') options.allowCacheReset = true;
    else if (argument === '--allow-fixture-install') options.allowFixtureInstall = true;
    else if (argument === '--keep-workdir') options.keepWorkdir = true;
    else if (argument === '--help' || argument === '-h') options.help = true;
    else throw new Error(`unknown argument '${argument}'`);
  }
  if (options.help || argv.length === 0) return { ...options, help: true };
  if (!options.action) throw new Error('choose --plan, --execute or --cleanup-owned-fixture');
  if (options.action === 'cleanup-owned-fixture') {
    if (argv.length !== 1) throw new Error('--cleanup-owned-fixture cannot be combined with other arguments');
    return options;
  }
  if (!String(options.fqbn).startsWith('esp32:esp32:')) throw new Error('target must be an ESP32 package FQBN');
  if (options.action === 'plan') {
    if (options.outputPath || options.allowCacheReset || options.allowFixtureInstall || options.keepWorkdir) {
      throw new Error('--plan is read-only and cannot accept execution flags');
    }
  } else {
    if (!options.outputPath || path.extname(options.outputPath).toLowerCase() !== '.json') {
      throw new Error('--execute requires --output <new.json>');
    }
    const forbiddenOutputRoots = [
      path.join(REPO_ROOT, 'sketchbook', 'libraries'),
      path.join(REPO_ROOT, 'packages'),
      path.join(os.tmpdir(), 'CKAB'),
      path.join(os.tmpdir(), 'CK_Builds'),
    ];
    const forbiddenRoot = forbiddenOutputRoots.find((root) => (
      pathIsWithinOrEqual(options.outputPath, root)
    ));
    if (forbiddenRoot) {
      throw new Error(`report output must stay outside managed mutation root: ${forbiddenRoot}`);
    }
    if (fs.existsSync(options.outputPath)) throw new Error(`refusing to overwrite report: ${options.outputPath}`);
    if (!options.allowCacheReset) throw new Error('--execute requires explicit --allow-cache-reset');
    if (!options.allowFixtureInstall) throw new Error('--execute requires explicit --allow-fixture-install');
  }
  return options;
}

function usage() {
  return `CK ESP32 library-aware FLFE compile-only A/B regression

Usage:
  node scripts/Run-CKEsp32LibraryEditRegression.cjs --plan [--fqbn ${DEFAULT_FQBN}]
  node scripts/Run-CKEsp32LibraryEditRegression.cjs --cleanup-owned-fixture
  node scripts/Run-CKEsp32LibraryEditRegression.cjs --execute \\
    --allow-cache-reset --allow-fixture-install --output <new.json> [options]

The runner temporarily installs one marker-owned ESP32 library, never uploads,
and never opens a serial port. Graph-establishing stages record equivalence and
may use a safe Release fallback. Same-graph edits must use the library-aware
NativeRelink route and beat native Arduino CLI by at least 20% and 500 ms.
`;
}

function planFor(options) {
  if (!validateFixtureDefinition()) throw new Error('ESP32 fixture definition is invalid');
  const adapter = forge.nativeRelinkAdapterFor(options.fqbn);
  return {
    schemaId: PLAN_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    fqbn: options.fqbn,
    compileOnly: true,
    uploadPerformed: false,
    serialPortAccessed: false,
    qualificationClaimed: false,
    qualificationProbe: {
      tokenEnvironmentVariable: QUALIFICATION_TOKEN_ENV,
      tokenBytes: 32,
      requiredAtExecution: true,
      certificateInstalledByRunner: false,
    },
    trials: options.trials,
    pairedStageCount: options.trials * LIBRARY_EDIT_SEQUENCE.length,
    compileCount: options.trials * LIBRARY_EDIT_SEQUENCE.length * 2,
    fixture: fixtureManifest(),
    coreLibraryProbe: 'SPI',
    sequence: LIBRARY_EDIT_SEQUENCE.map(({ code, ...entry }) => ({
      ...entry,
      sourceBytes: Buffer.byteLength(code, 'utf8'),
    })),
    routePolicy: {
      id: 'ck-esp32-library-edit-route-v2',
      graphEstablishing: 'recognized-safe-release-fallback-or-native-graph-transition',
      sameGraphEdit: dependency.NATIVE_RELINK_ROUTE,
      sameGraphLibraryRouteMarker: ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER,
      qualificationProbeEvidenceRequired: true,
      structuredNativeRelinkEvidenceRequired: true,
      structuredNativeRelinkEvidencePolicyId: ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID,
      certifiedProductRouteCannotQualifyThisProbe: true,
      exactForbidden: true,
      fallbackCannotQualifySameGraphEdit: true,
    },
    equivalencePolicy: {
      id: 'ck-esp32-library-edit-equivalence-v1',
      sourceSha256: true,
      flashAndRamBytes: true,
      requiredEsp32ArtifactRoles: [...REQUIRED_ESP32_ARTIFACT_ROLES],
      laneLocalDiagnosticArtifactRoles: [...LANE_LOCAL_DIAGNOSTIC_ARTIFACT_ROLES],
      adapterPolicyId: adapter?.artifactEquivalencePolicyId || null,
      fixtureAndCoreLibraryCcdbSourceObjectBinding: 'one-source-to-one-object',
      sameGraphLibraryObjectReuse: true,
      nativeRelinkEvidenceContract: ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT,
      sameGraphNativeRelinkEvidenceStable: [...ESP32_LIBRARY_NATIVE_RELINK_STABLE_FIELDS],
    },
    performancePolicy: PERFORMANCE_POLICY,
    adapter: adapter == null ? null : {
      id: adapter.id,
      engineContractId: adapter.engineContractId,
      artifactEquivalencePolicyId: adapter.artifactEquivalencePolicyId,
    },
    reproducibility: {
      policyId: forge.QUALIFICATION_REPRODUCIBILITY_POLICY_ID,
      sourceDateEpoch: Number(forge.QUALIFICATION_SOURCE_DATE_EPOCH),
      timeZone: forge.QUALIFICATION_TIME_ZONE,
      requiredAtExecution: true,
    },
  };
}

function writeJsonNoClobber(outputPath, value) {
  fs.mkdirSync(path.dirname(outputPath), { recursive: true });
  if (fs.existsSync(outputPath)) throw new Error(`refusing to overwrite ${outputPath}`);
  const temporary = `${outputPath}.${process.pid}.${crypto.randomBytes(4).toString('hex')}.tmp`;
  try {
    fs.writeFileSync(temporary, `${JSON.stringify(value, null, 2)}\n`, { encoding: 'utf8', flag: 'wx' });
    fs.linkSync(temporary, outputPath);
  } finally {
    try { fs.unlinkSync(temporary); } catch {}
  }
}

function normalizedPath(value) {
  const resolved = path.resolve(value);
  return process.platform === 'win32' ? resolved.toLowerCase() : resolved;
}

function pathIsWithinOrEqual(candidate, parent) {
  const relative = path.relative(parent, candidate);
  return relative === '' || (!relative.startsWith('..') && !path.isAbsolute(relative));
}

function ordinaryDirectory(directory, label) {
  const resolved = path.resolve(directory);
  const stat = fs.lstatSync(resolved);
  if (!stat.isDirectory() || stat.isSymbolicLink()) throw new Error(`${label} must be an ordinary directory`);
  return fs.realpathSync.native(resolved);
}

function ordinaryFile(file, label) {
  const resolved = path.resolve(file);
  const stat = fs.lstatSync(resolved);
  if (!stat.isFile() || stat.isSymbolicLink() || stat.size <= 0) {
    throw new Error(`${label} must be an ordinary non-empty file`);
  }
  return { real: fs.realpathSync.native(resolved), stat };
}

function isSafeComponent(value) {
  return typeof value === 'string' && /^[A-Za-z0-9][A-Za-z0-9._+-]{0,127}$/u.test(value);
}

function corePlatformRoot(identity) {
  for (const [label, value] of [
    ['Core package', identity?.corePackage],
    ['Core architecture', identity?.coreArchitecture],
    ['Core version', identity?.coreVersion],
  ]) {
    if (!isSafeComponent(value)) throw new Error(`${label} cannot safely locate the platform root`);
  }
  const packagesRoot = ordinaryDirectory(path.join(REPO_ROOT, 'packages'), 'packages root');
  const platformRoot = ordinaryDirectory(path.join(
    packagesRoot, identity.corePackage, 'hardware', identity.coreArchitecture, identity.coreVersion,
  ), 'resolved ESP32 platform root');
  if (!pathIsWithinOrEqual(platformRoot, packagesRoot)) throw new Error('ESP32 platform root escaped packages');
  return platformRoot;
}

function fixtureRootFor(librariesRoot) {
  return path.join(path.resolve(librariesRoot), FIXTURE_NAME);
}

function materializeFixture(librariesRoot, runToken) {
  if (!/^[a-f0-9]{32}$/u.test(String(runToken || ''))) throw new Error('fixture run token is invalid');
  const root = ordinaryDirectory(librariesRoot, 'sketchbook libraries root');
  const fixtureRoot = fixtureRootFor(root);
  if (!pathIsWithinOrEqual(fixtureRoot, root) || fs.existsSync(fixtureRoot)) {
    throw new Error(`fixture destination already exists or escaped: ${fixtureRoot}`);
  }
  fs.mkdirSync(fixtureRoot, { recursive: false });
  try {
    for (const [relativePath, content] of Object.entries(fixtureFiles())) {
      const target = path.join(fixtureRoot, ...relativePath.split('/'));
      if (!pathIsWithinOrEqual(target, fixtureRoot)) throw new Error('fixture file escaped its root');
      fs.mkdirSync(path.dirname(target), { recursive: true });
      fs.writeFileSync(target, content, { encoding: 'utf8', flag: 'wx' });
    }
    const marker = {
      schemaId: FIXTURE_SCHEMA_ID,
      schemaVersion: FIXTURE_SCHEMA_VERSION,
      runToken,
      manifestSha256: fixtureManifest().manifestSha256,
    };
    fs.writeFileSync(path.join(fixtureRoot, FIXTURE_MARKER), `${JSON.stringify(marker)}\n`, {
      encoding: 'utf8', flag: 'wx',
    });
    return { ...fixtureManifest(), installedRoot: '<CK_SKETCHBOOK>/libraries' };
  } catch (error) {
    fs.rmSync(fixtureRoot, { recursive: true, force: true });
    throw error;
  }
}

function validateFixtureMarker(fixtureRoot, runToken) {
  const marker = JSON.parse(fs.readFileSync(ordinaryFile(
    path.join(fixtureRoot, FIXTURE_MARKER), 'fixture ownership marker',
  ).real, 'utf8'));
  if (marker.schemaId !== FIXTURE_SCHEMA_ID || marker.schemaVersion !== FIXTURE_SCHEMA_VERSION
      || marker.runToken !== runToken || marker.manifestSha256 !== fixtureManifest().manifestSha256) {
    throw new Error('fixture ownership marker mismatch');
  }
}

function cleanupFixture(librariesRoot, runToken) {
  const root = ordinaryDirectory(librariesRoot, 'sketchbook libraries root');
  const fixtureRoot = fixtureRootFor(root);
  if (!fs.existsSync(fixtureRoot)) return { removed: false, remaining: false };
  if (!pathIsWithinOrEqual(fixtureRoot, root)) throw new Error('fixture cleanup escaped libraries root');
  validateFixtureMarker(fixtureRoot, runToken);
  fs.rmSync(fixtureRoot, { recursive: true, force: false });
  return { removed: true, remaining: fs.existsSync(fixtureRoot) };
}

function validateInstalledFixtureContents(librariesRoot, runToken) {
  const root = ordinaryDirectory(librariesRoot, 'sketchbook libraries root');
  const fixtureRoot = ordinaryDirectory(fixtureRootFor(root), 'installed fixture root');
  validateFixtureMarker(fixtureRoot, runToken);
  const observed = [];
  const pending = [fixtureRoot];
  while (pending.length > 0) {
    const directory = pending.pop();
    for (const entry of fs.readdirSync(directory, { withFileTypes: true })) {
      const target = path.join(directory, entry.name);
      if (!pathIsWithinOrEqual(target, fixtureRoot) || entry.isSymbolicLink()) {
        throw new Error('fixture recovery found an unsafe path');
      }
      if (entry.isDirectory()) pending.push(target);
      else if (entry.isFile()) observed.push(path.relative(fixtureRoot, target).replaceAll('\\', '/'));
      else throw new Error('fixture recovery found a non-file entry');
    }
  }
  observed.sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  const expected = [...Object.keys(fixtureFiles()), FIXTURE_MARKER]
    .sort((left, right) => Buffer.from(left).compare(Buffer.from(right)));
  if (canonicalJson(observed) !== canonicalJson(expected)) {
    throw new Error('fixture recovery file set differs from the marker-owned fixture');
  }
  for (const [relativePath, expectedContent] of Object.entries(fixtureFiles())) {
    const file = ordinaryFile(path.join(fixtureRoot, ...relativePath.split('/')), `fixture file ${relativePath}`);
    const bytes = fs.readFileSync(file.real);
    if (bytes.length !== Buffer.byteLength(expectedContent, 'utf8')
        || sha256Bytes(bytes) !== sha256Bytes(expectedContent)) {
      throw new Error(`fixture recovery content mismatch: ${relativePath}`);
    }
  }
  return { fixtureRoot, runToken, manifestSha256: fixtureManifest().manifestSha256 };
}

function recoverOwnedFixture(librariesRoot) {
  const root = ordinaryDirectory(librariesRoot, 'sketchbook libraries root');
  const fixtureRoot = fixtureRootFor(root);
  if (!fs.existsSync(fixtureRoot)) return { recovered: false, remaining: false };
  const markerFile = ordinaryFile(path.join(fixtureRoot, FIXTURE_MARKER), 'fixture ownership marker');
  let marker;
  try { marker = JSON.parse(fs.readFileSync(markerFile.real, 'utf8')); } catch (error) {
    throw new Error(`fixture ownership marker is invalid JSON: ${error.message}`);
  }
  if (!/^[a-f0-9]{32}$/u.test(String(marker?.runToken || ''))) {
    throw new Error('fixture ownership marker has no valid run token');
  }
  validateInstalledFixtureContents(root, marker.runToken);
  const cleanup = cleanupFixture(root, marker.runToken);
  return { recovered: cleanup.removed, remaining: cleanup.remaining };
}

function resolveCcdbPath(value, directory, label) {
  if (typeof value !== 'string' || value.trim() === '' || value.includes('\0')) {
    throw new Error(`${label} is invalid`);
  }
  const unquoted = value.length >= 2 && value.startsWith('"') && value.endsWith('"')
    ? value.slice(1, -1) : value;
  return path.resolve(directory, unquoted);
}

function ccdbOutputPath(entry, directory, index) {
  if (!Array.isArray(entry.arguments) || entry.arguments.some((argument) => typeof argument !== 'string')) {
    throw new Error(`CCDB library entry ${index} requires arguments form`);
  }
  const indexes = entry.arguments.map((value, argumentIndex) => value === '-o' ? argumentIndex : -1)
    .filter((argumentIndex) => argumentIndex >= 0);
  if (indexes.length !== 1 || indexes[0] + 1 >= entry.arguments.length) {
    throw new Error(`CCDB library entry ${index} must bind exactly one -o object`);
  }
  return resolveCcdbPath(entry.arguments[indexes[0] + 1], directory, `CCDB object ${index}`);
}

function controlledSourceRoots(librariesRoot, platformRoot) {
  const fixtureRoot = ordinaryDirectory(fixtureRootFor(librariesRoot), 'installed fixture root');
  const spiRoot = ordinaryDirectory(path.join(platformRoot, 'libraries', 'SPI'), 'ESP32 SPI library root');
  return { fixtureRoot, spiRoot };
}

function inspectCcdbLibraryEvidence(buildPath, librariesRoot, platformRoot, workload) {
  const build = ordinaryDirectory(buildPath, 'CCDB build root');
  const roots = controlledSourceRoots(librariesRoot, platformRoot);
  const ccdb = ordinaryFile(path.join(build, 'compile_commands.json'), 'compile_commands.json');
  if (path.dirname(ccdb.real) !== build || ccdb.stat.size > CCDB_MAX_BYTES) {
    throw new Error('compile_commands.json escaped build root or exceeded size bound');
  }
  let entries;
  try { entries = JSON.parse(fs.readFileSync(ccdb.real, 'utf8')); } catch (error) {
    throw new Error(`compile_commands.json is invalid JSON: ${error.message}`);
  }
  if (!Array.isArray(entries) || entries.length === 0 || entries.length > CCDB_MAX_ENTRIES) {
    throw new Error('compile_commands.json must be a non-empty bounded array');
  }
  const units = [];
  const sourceKeys = new Set();
  const objectKeys = new Set();
  for (const [index, entry] of entries.entries()) {
    if (!entry || typeof entry !== 'object' || Array.isArray(entry)) continue;
    let directory;
    let source;
    try {
      directory = ordinaryDirectory(entry.directory, `CCDB working directory ${index}`);
      source = ordinaryFile(resolveCcdbPath(entry.file, directory, `CCDB source ${index}`), `CCDB source ${index}`);
    } catch {
      continue;
    }
    const rootKind = pathIsWithinOrEqual(source.real, roots.fixtureRoot) ? 'third-party'
      : pathIsWithinOrEqual(source.real, roots.spiRoot) ? 'core-library' : null;
    if (rootKind == null) continue;
    const sourceRoot = rootKind === 'third-party' ? roots.fixtureRoot : roots.spiRoot;
    if (!Array.isArray(entry.arguments)) {
      throw new Error(`CCDB library entry ${index} requires arguments form`);
    }
    const sourceArgumentCount = entry.arguments.filter((argument) => {
      if (typeof argument !== 'string' || argument.startsWith('-') || argument.startsWith('@')) return false;
      try {
        const candidate = resolveCcdbPath(argument, directory, `CCDB source argument ${index}`);
        return fs.existsSync(candidate)
          && normalizedPath(fs.realpathSync.native(candidate)) === normalizedPath(source.real);
      } catch {
        return false;
      }
    }).length;
    if (sourceArgumentCount !== 1) {
      throw new Error(`CCDB library entry ${index} must bind its source exactly once`);
    }
    const objectPath = ccdbOutputPath(entry, directory, index);
    if (!pathIsWithinOrEqual(objectPath, build)) throw new Error(`CCDB object ${index} escaped build root`);
    const object = ordinaryFile(objectPath, `CCDB object ${index}`);
    if (!pathIsWithinOrEqual(object.real, build) || path.extname(object.real).toLowerCase() !== '.o') {
      throw new Error(`CCDB object ${index} is not a controlled .o file`);
    }
    const sourceKey = normalizedPath(source.real);
    const objectKey = normalizedPath(object.real);
    if (sourceKeys.has(sourceKey) || objectKeys.has(objectKey)) {
      throw new Error('CCDB library source/object bindings are not one-to-one');
    }
    sourceKeys.add(sourceKey);
    objectKeys.add(objectKey);
    units.push({
      rootKind,
      sourceRelativePath: path.relative(sourceRoot, source.real).replaceAll('\\', '/'),
      language: path.extname(source.real).toLowerCase() === '.c' ? 'c' : 'cpp',
      sourceBytes: source.stat.size,
      sourceSha256: sha256Bytes(fs.readFileSync(source.real)),
      objectRelativePath: path.relative(build, object.real).replaceAll('\\', '/'),
      objectBytes: object.stat.size,
      objectSha256: sha256Bytes(fs.readFileSync(object.real)),
      ccdbEntryIndex: index,
    });
  }
  units.sort((left, right) => Buffer.from(`${left.rootKind}/${left.sourceRelativePath}`)
    .compare(Buffer.from(`${right.rootKind}/${right.sourceRelativePath}`)));
  const active = units.filter((unit) => unit.rootKind === workload);
  const inactive = units.filter((unit) => unit.rootKind !== workload);
  if (workload === 'third-party') {
    const observed = active.map((unit) => unit.sourceRelativePath);
    if (canonicalJson(observed) !== canonicalJson([...FIXTURE_TRANSLATION_UNITS].sort())) {
      throw new Error(`CCDB fixture TU set mismatch: ${observed.join(', ') || '(none)'}`);
    }
  } else if (workload === 'core-library' && active.length === 0) {
    throw new Error('CCDB contains no ESP32 SPI library translation unit');
  }
  if (inactive.length !== 0) throw new Error('CCDB retained stale library-graph translation units');
  return {
    schemaId: CCDB_SCHEMA_ID,
    schemaVersion: CCDB_SCHEMA_VERSION,
    workload,
    ccdbBytes: ccdb.stat.size,
    ccdbSha256: sha256Bytes(fs.readFileSync(ccdb.real)),
    ccdbEntryCount: entries.length,
    sourceObjectBinding: 'one-source-to-one-object',
    units,
    structuralValidationPassed: true,
  };
}

function ccdbSourceProjection(evidence) {
  return (evidence?.units || []).map(({ rootKind, sourceRelativePath, language, sourceBytes, sourceSha256 }) => ({
    rootKind, sourceRelativePath, language, sourceBytes, sourceSha256,
  }));
}

function ccdbObjectProjection(evidence) {
  return (evidence?.units || []).map(({ rootKind, sourceRelativePath, objectRelativePath, objectBytes, objectSha256 }) => ({
    rootKind, sourceRelativePath, objectRelativePath, objectBytes, objectSha256,
  }));
}

function ccdbEquivalent(ck, native) {
  const ckProjection = ccdbSourceProjection(ck);
  const nativeProjection = ccdbSourceProjection(native);
  return {
    sourceSetsExact: canonicalJson(ckProjection) === canonicalJson(nativeProjection),
    ckSourceObjectBinding: ck?.sourceObjectBinding === 'one-source-to-one-object',
    nativeSourceObjectBinding: native?.sourceObjectBinding === 'one-source-to-one-object',
    ck: ckProjection,
    native: nativeProjection,
    passed: canonicalJson(ckProjection) === canonicalJson(nativeProjection)
      && ck?.structuralValidationPassed === true && native?.structuralValidationPassed === true,
  };
}

function sameGraphObjectReuse(stages, workload, lane) {
  const pair = stages.filter((stageRow) => stageRow.workload === workload);
  if (pair.length !== 2) return { exact: false, reason: 'same-graph workload pair is incomplete' };
  const first = ccdbObjectProjection(pair[0]?.[lane]?.ccdb);
  const edit = ccdbObjectProjection(pair[1]?.[lane]?.ccdb);
  const exact = canonicalJson(first) === canonicalJson(edit);
  return { exact, first, edit, reason: exact ? null : 'library objects changed during a sketch-only same-graph edit' };
}

function isPlainObject(value) {
  return value != null && typeof value === 'object' && !Array.isArray(value);
}

function exactObjectKeys(value, expected) {
  if (!isPlainObject(value)) return false;
  const actual = Object.keys(value).sort();
  const wanted = [...expected].sort();
  return actual.length === wanted.length && actual.every((key, index) => key === wanted[index]);
}

function isLowercaseSha256(value) {
  return typeof value === 'string' && /^[a-f0-9]{64}$/u.test(value);
}

function parseNativeRelinkTiming(log) {
  const text = String(log || '');
  const executionMatch = text.match(
    /\[Timing DIAG\] ESP32 NativeRelink sketch=(\d{1,12})ms link=(\d{1,12})ms artifacts=(\d{1,12})ms size=(\d{1,12})ms total=(\d{1,12})ms/u,
  );
  const evidenceMatch = text.match(
    /\[Timing DIAG\] ESP32 NativeRelink evidence prepareTotal=(\d{1,12})ms prepareCapture=(\d{1,12})ms preLinkRefresh=(\d{1,12})ms linkerSpawn=(\d{1,12})ms finalRefreshCommit=(\d{1,12})ms/u,
  );
  if (!executionMatch || !evidenceMatch) return null;
  const execution = executionMatch.slice(1).map(Number);
  const evidence = evidenceMatch.slice(1).map(Number);
  if ([...execution, ...evidence].some(
    (value) => !Number.isSafeInteger(value) || value < 0,
  )) return null;
  if (execution[1] !== evidence[3]) return null;
  return {
    schemaVersion: 1,
    prepareTotalMs: evidence[0],
    prepareCaptureMs: evidence[1],
    preLinkRefreshMs: evidence[2],
    sketchCompileMs: execution[0],
    linkerSpawnMs: evidence[3],
    artifactsMs: execution[2],
    sizeMs: execution[3],
    finalRefreshCommitMs: evidence[4],
    executeTotalMs: execution[4],
  };
}

function validateNativeRelinkEvidence(diagnostics) {
  const wrapper = diagnostics?.cache?.nativeRelinkEvidence;
  const failures = [];
  const wrapperKeys = ['status', 'markerCount', 'evidence'];
  if (!exactObjectKeys(wrapper, wrapperKeys)) failures.push('diagnostic-wrapper-shape');
  if (wrapper?.status !== 'valid') failures.push(`diagnostic-status-${wrapper?.status || 'missing'}`);
  if (!Number.isSafeInteger(wrapper?.markerCount) || wrapper.markerCount < 1 || wrapper.markerCount > 16) {
    failures.push('diagnostic-marker-count');
  }

  const evidence = wrapper?.evidence;
  const evidenceKeys = [
    'schemaVersion', 'evidenceContract', 'manifestSchemaVersion',
    ...ESP32_LIBRARY_NATIVE_RELINK_HASH_FIELDS,
    'libraryRootCount', 'libraryFileCount', 'libraryTotalBytes',
    'nativeLinkResponseFileCount',
  ];
  if (!exactObjectKeys(evidence, evidenceKeys)) failures.push('evidence-shape');
  if (evidence?.schemaVersion !== ESP32_LIBRARY_NATIVE_RELINK_DIAGNOSTIC_SCHEMA_VERSION
      || evidence?.evidenceContract !== ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT
      || evidence?.manifestSchemaVersion !== ESP32_LIBRARY_NATIVE_RELINK_MANIFEST_SCHEMA_VERSION) {
    failures.push('evidence-contract');
  }
  for (const field of ESP32_LIBRARY_NATIVE_RELINK_HASH_FIELDS) {
    if (!isLowercaseSha256(evidence?.[field])) failures.push(`${field}-malformed`);
  }
  if (!Number.isSafeInteger(evidence?.libraryRootCount)
      || evidence.libraryRootCount < 1
      || evidence.libraryRootCount > MAX_ESP32_LIBRARY_NATIVE_RELINK_ROOTS) {
    failures.push('library-root-count');
  }
  if (!Number.isSafeInteger(evidence?.libraryFileCount)
      || evidence.libraryFileCount < (evidence?.libraryRootCount || 1)
      || evidence.libraryFileCount > MAX_ESP32_LIBRARY_NATIVE_RELINK_FILES) {
    failures.push('library-file-count');
  }
  if (!Number.isSafeInteger(evidence?.libraryTotalBytes)
      || evidence.libraryTotalBytes < 0
      || evidence.libraryTotalBytes > MAX_ESP32_LIBRARY_NATIVE_RELINK_BYTES) {
    failures.push('library-total-bytes');
  }
  if (!Number.isSafeInteger(evidence?.nativeLinkResponseFileCount)
      || evidence.nativeLinkResponseFileCount < 0
      || evidence.nativeLinkResponseFileCount > MAX_ESP32_LIBRARY_NATIVE_RELINK_RESPONSE_FILES) {
    failures.push('native-link-response-file-count');
  }

  return {
    policyId: ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID,
    required: true,
    backendStatus: wrapper?.status || 'missing',
    markerCount: Number.isSafeInteger(wrapper?.markerCount) ? wrapper.markerCount : null,
    evidence: failures.length === 0 ? { ...evidence } : null,
    failures,
    passed: failures.length === 0,
  };
}

function nativeRelinkStableProjection(evidence) {
  if (!isPlainObject(evidence)) return null;
  return Object.fromEntries(ESP32_LIBRARY_NATIVE_RELINK_STABLE_FIELDS.map((field) => (
    [field, evidence[field]]
  )));
}

function sameGraphNativeRelinkEvidence(stages, workload) {
  const pair = stages.filter((stageRow) => stageRow.workload === workload);
  if (pair.length !== 2) {
    return { passed: false, stable: false, reason: 'same-graph workload pair is incomplete' };
  }
  const first = pair[0]?.ck?.nativeRelinkEvidence;
  const edit = pair[1]?.ck?.nativeRelinkEvidence;
  if (first?.passed !== true || edit?.passed !== true) {
    return { passed: false, stable: false, reason: 'one or more stages lack valid NativeRelink v4 evidence' };
  }
  const firstProjection = nativeRelinkStableProjection(first.evidence);
  const editProjection = nativeRelinkStableProjection(edit.evidence);
  const stable = canonicalJson(firstProjection) === canonicalJson(editProjection);
  return {
    policyId: ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID,
    passed: stable,
    stable,
    first: firstProjection,
    edit: editProjection,
    firstManifestSha256: first.evidence.manifestSha256,
    editManifestSha256: edit.evidence.manifestSha256,
    manifestChanged: first.evidence.manifestSha256 !== edit.evidence.manifestSha256,
    reason: stable ? null : 'sealed command, property, response or library-tree evidence changed within one library graph',
  };
}

function requiredArtifactPresence(artifacts) {
  const roles = Object.fromEntries(REQUIRED_ESP32_ARTIFACT_ROLES.map((role) => [
    role, (artifacts || []).filter((artifact) => artifact.role === role).length,
  ]));
  const unique = Object.values(roles).every((count) => count === 1);
  const flash = (artifacts || []).find((artifact) => artifact.role === 'flash-arguments');
  const flashWitnessValid = flash != null
    && forge.validEspFlashArgumentsWitness(flash.flashArgumentsWitness, flash.bytes);
  const diagnosticRoleCounts = Object.fromEntries(LANE_LOCAL_DIAGNOSTIC_ARTIFACT_ROLES.map((role) => [
    role, (artifacts || []).filter((artifact) => artifact.role === role).length,
  ]));
  return {
    requiredRoles: [...REQUIRED_ESP32_ARTIFACT_ROLES],
    observedRoleCounts: roles,
    laneLocalDiagnosticRoleCounts: diagnosticRoleCounts,
    unique,
    flashWitnessValid,
    passed: unique && flashWitnessValid,
  };
}

function normalizedFlashArgumentsWitness(artifact) {
  const witness = artifact?.flashArgumentsWitness;
  if (!forge.validEspFlashArgumentsWitness(witness, artifact?.bytes)) return null;
  return {
    optionLines: [...witness.optionLines],
    segments: witness.segments.map((segment) => ({
      offset: segment.offset,
      role: segment.role,
      resolved: segment.resolved,
      ...(segment.resolved ? {
        bytes: segment.bytes,
        // Application bytes are already compared by the bounded ELF-SHA
        // payload witness. Other resolved flash segments stay byte-exact.
        ...(segment.role === 'application-bin' ? {} : { sha256: segment.sha256 }),
      } : { reference: segment.reference }),
    })),
  };
}

function flashArgumentsEquivalent(ckArtifacts, nativeArtifacts) {
  const ckFlash = (ckArtifacts || []).filter((artifact) => artifact.role === 'flash-arguments');
  const nativeFlash = (nativeArtifacts || []).filter((artifact) => artifact.role === 'flash-arguments');
  const ck = ckFlash.length === 1 ? normalizedFlashArgumentsWitness(ckFlash[0]) : null;
  const native = nativeFlash.length === 1 ? normalizedFlashArgumentsWitness(nativeFlash[0]) : null;
  const exact = ck != null && native != null && canonicalJson(ck) === canonicalJson(native);
  return {
    policyId: 'ck-esp32-flash-arguments-normalized-equivalence-v1',
    ck,
    native,
    exact,
    passed: exact,
  };
}

function artifactEquivalence(ck, native, adapter, stageId) {
  const adapterComparison = forge.compareNativeRelinkAdapterArtifactEquivalence(
    ck.artifacts, native.artifacts, adapter, stageId,
  );
  const ckPresence = requiredArtifactPresence(ck.artifacts);
  const nativePresence = requiredArtifactPresence(native.artifacts);
  const flashArguments = flashArgumentsEquivalent(ck.artifacts, native.artifacts);
  return {
    adapterComparison,
    ckPresence,
    nativePresence,
    flashArguments,
    passed: adapterComparison.passed && ckPresence.passed && nativePresence.passed
      && flashArguments.passed,
  };
}

function fallbackEvidence(buildMode, log) {
  const normalized = String(log || '').toLowerCase();
  return {
    used: String(buildMode || '').toLowerCase().includes('fallback') || normalized.includes('falling back'),
    reasonLines: String(log || '').split(/\r?\n/u)
      .filter((line) => /(?:fallback|not eligible|library|include set)/iu.test(line)).slice(0, 12),
  };
}

function validateCompilerEvidence(diagnostics, log, stageId, expectedJobs) {
  const buildMode = diagnostics?.buildMode;
  if (buildMode === 'exact-match' || diagnostics?.cache?.exactMatch === true) {
    throw new Error(`CK ${stageId} returned Exact; library regression requires compilation`);
  }
  const allowed = new Set([
    'full-build', 'arduino-cli-full-fallback', 'arduino-cli-incremental',
    'arduino-cli-incremental-fallback', dependency.CORE_SEEDED_ROUTE,
    dependency.NATIVE_RELINK_ROUTE, dependency.NATIVE_RELINK_GRAPH_TRANSITION_ROUTE,
  ]);
  if (!allowed.has(buildMode)) throw new Error(`CK ${stageId} reported unsupported buildMode=${buildMode || 'missing'}`);
  if (diagnostics?.profile !== 'release') throw new Error(`CK ${stageId} is not a Release compile`);
  const match = String(log || '').match(/\[INFO\] Compile parallel jobs:\s*(\d+)/u);
  const jobs = match ? Number(match[1]) : expectedJobs;
  if (jobs !== expectedJobs) throw new Error(`CK jobs=${jobs} differs from native jobs=${expectedJobs}`);
  return jobs;
}

async function runCkCompile(
  evaluate, fqbn, stageEntry, timeoutMs, jobs, librariesRoot, platformRoot,
  payloadProof, qualificationToken,
) {
  const started = process.hrtime.bigint();
  const result = await evaluate(`(async () => {
    const started = performance.now();
    try {
      const raw = await window.__TAURI_INTERNALS__.invoke('compile_sketch', {
        code: ${JSON.stringify(stageEntry.code)},
        fqbn: ${JSON.stringify(fqbn)},
        boardPackageId: null,
        runId: null,
        workspaceFingerprint: ${JSON.stringify(stageEntry.sourceSha256)},
        sourceMapJson: null,
        silent: false,
        qualification: true,
        qualificationToken: ${JSON.stringify(qualificationToken)},
        qualificationOperation: null,
        qualificationProfile: null
      });
      return { ok: true, raw, pageWallMs: performance.now() - started };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  const wallNs = process.hrtime.bigint() - started;
  if (!result?.ok) throw new Error(`CK ${stageEntry.id} failed: ${result?.error || 'unknown error'}`);
  const parsed = JSON.parse(result.raw);
  const diagnostics = parsed.diagnostics || {};
  const observedJobs = validateCompilerEvidence(diagnostics, parsed.log, stageEntry.id, jobs);
  const buildPath = fs.realpathSync.native(parsed.path);
  const adapter = forge.nativeRelinkAdapterFor(fqbn);
  const resources = diagnostics.resources || {};
  if (resources.evidenceComplete !== true) throw new Error(`CK ${stageEntry.id} resource evidence is incomplete`);
  const nativeRelinkEvidence = validateNativeRelinkEvidence(diagnostics);
  const artifacts = forge.inspectCkArtifacts(parsed, adapter, payloadProof);
  return finalizeRun({
    phase: stageEntry.id,
    success: true,
    compileOnly: true,
    uploadPerformed: false,
    exactUsed: false,
    wallMs: Number(wallNs) / 1e6,
    rawTiming: {
      runnerWallNs: wallNs.toString(),
      pageWallMs: Number(result.pageWallMs),
      backend: diagnostics.timing || null,
      nativeRelink: parseNativeRelinkTiming(parsed.log),
    },
    buildMode: diagnostics.buildMode || null,
    profile: diagnostics.profile || null,
    route: diagnostics.engine || null,
    structuredRoute: diagnostics.route || diagnostics.engine?.route || null,
    fallback: fallbackEvidence(diagnostics.buildMode, parsed.log),
    cache: {
      exactMatch: diagnostics.cache?.exactMatch === true,
      missReasons: Array.isArray(diagnostics.cache?.missReasons) ? diagnostics.cache.missReasons.slice(0, 16) : [],
      nativeRelinkDiagnostics: Array.isArray(diagnostics.cache?.nativeRelinkDiagnostics)
        ? diagnostics.cache.nativeRelinkDiagnostics.slice(0, 32) : [],
    },
    nativeRelinkEvidence,
    jobs: observedJobs,
    fqbn: diagnostics.fqbn || null,
    codeSha256: stageEntry.sourceSha256,
    toolchainKey: diagnostics.environment?.toolchainKey || null,
    cliVersion: diagnostics.environment?.cliVersion || null,
    resources: {
      evidenceComplete: true,
      flashUsedBytes: Number(resources.flashUsedBytes),
      ramUsedBytes: Number(resources.ramUsedBytes),
      warningCount: Number(resources.warningCount),
    },
    artifacts,
    artifactSetSha256: forge.artifactSetSha256(artifacts),
    buildPathIdentitySha256: sha256Bytes(normalizedPath(buildPath)),
    ccdb: inspectCcdbLibraryEvidence(buildPath, librariesRoot, platformRoot, stageEntry.workload),
  });
}

async function clearCkCache(evaluate, fqbn, timeoutMs) {
  const result = await evaluate(`(async () => {
    try {
      return { ok: true, value: await window.__TAURI_INTERNALS__.invoke(
        'clear_board_first_project_compile_cache', { fqbn: ${JSON.stringify(fqbn)} }
      ) };
    } catch (error) { return { ok: false, error: String(error) }; }
  })()`, timeoutMs);
  if (!result?.ok) throw new Error(`CK cache reset failed: ${result?.error || 'unknown error'}`);
  const validation = forge.validateCacheClear(result.value, fqbn);
  if (!validation.passed) throw new Error(`CK cache reset evidence failed: ${validation.failures.join('; ')}`);
  return result.value;
}

function routeEvidence(run, stageEntry) {
  const observedMode = dependency.observedRouteMode(run);
  const nativeRelinkDiagnostics = run?.cache?.nativeRelinkDiagnostics || [];
  const qualificationProbeEnabled = nativeRelinkDiagnostics.some((line) => (
    String(line).includes('NativeRelinkCompileOnly qualification probe enabled')
  ));
  const qualificationProbeAuthorization = nativeRelinkDiagnostics.some((line) => (
    String(line).includes('NativeRelink authorization: qualification-probe')
  ));
  const nativeRelinkPath = nativeRelinkDiagnostics.some((line) => (
    String(line).includes('NativeRelinkCompileOnly path:')
  ));
  const libraryNativeRelinkPath = nativeRelinkDiagnostics.some((line) => (
    String(line).trim() === ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER
  ));
  const certificateMatched = nativeRelinkDiagnostics.some((line) => (
    String(line).includes('NativeRelinkCompileOnly certificate matched')
  ));
  const nativeRelinkPathEvidence = observedMode !== dependency.NATIVE_RELINK_ROUTE
    || (libraryNativeRelinkPath && qualificationProbeAuthorization);
  const structuredNativeRelinkEvidence = run?.nativeRelinkEvidence?.passed === true;
  const recognized = observedMode !== 'unknown';
  const safe = recognized && qualificationProbeEnabled && nativeRelinkPathEvidence
    && structuredNativeRelinkEvidence
    && !certificateMatched && run?.exactUsed === false;
  const preferred = stageEntry.performanceRequired
    ? safe && observedMode === dependency.NATIVE_RELINK_ROUTE && run?.fallback?.used !== true
    : null;
  return {
    policyId: 'ck-esp32-library-edit-route-v2',
    transitionKind: stageEntry.transitionKind,
    performanceRequired: stageEntry.performanceRequired,
    preferredMode: stageEntry.preferredRoute,
    observedMode,
    recognized,
    safe,
    qualificationProbeEnabled,
    qualificationProbeAuthorization,
    nativeRelinkPath,
    libraryNativeRelinkPath,
    certificateMatched,
    nativeRelinkPathEvidence,
    structuredNativeRelinkEvidence,
    preferred,
    fallbackAllowedForMeasurement: !stageEntry.performanceRequired,
  };
}

const LIBRARY_BASELINE_COMMITTED_MARKER =
  'ESP32 library NativeRelink qualification baseline committed';

function graphBaselineEvidence(run, stageEntry) {
  const required = !stageEntry.performanceRequired;
  const diagnostics = Array.isArray(run?.cache?.nativeRelinkDiagnostics)
    ? run.cache.nativeRelinkDiagnostics.map((line) => String(line)) : [];
  const committed = diagnostics.some((line) => line.includes(LIBRARY_BASELINE_COMMITTED_MARKER));
  const rejectionReasons = diagnostics.filter((line) => (
    line.includes('ESP32 library NativeRelink baseline commit skipped')
    || line.includes('ESP32 library NativeRelink baseline capture skipped')
  ));
  const structuredEvidencePassed = run?.nativeRelinkEvidence?.passed === true;
  return {
    policyId: 'ck-esp32-library-baseline-establishment-v2',
    required,
    marker: LIBRARY_BASELINE_COMMITTED_MARKER,
    committed: required ? committed : null,
    structuredEvidencePassed,
    rejectionReasons,
    passed: required ? committed && structuredEvidencePassed : true,
  };
}

function normalizedCliVersion(value) {
  return String(value || '').replace(/\s+/gu, ' ').trim();
}

function stageIdentityEvidence(ck, native, identity, requestedFqbn) {
  const requested = forge.canonicalCompleteFqbn(requestedFqbn);
  const ckFqbnExact = forge.canonicalCompleteFqbn(ck?.fqbn) === requested;
  const nativeFqbnExact = forge.canonicalCompleteFqbn(native?.fqbn) === requested;
  const cliVersionExact = normalizedCliVersion(ck?.cliVersion)
    === normalizedCliVersion(identity?.cliVersion);
  const coreVersionExact = String(ck?.route?.coreVersion || '') === String(identity?.coreVersion || '');
  const toolchainIdentityPresent = typeof ck?.toolchainKey === 'string' && ck.toolchainKey.length > 0;
  return {
    requestedFqbn: requested,
    ckFqbnExact,
    nativeFqbnExact,
    cliVersionExact,
    coreVersionExact,
    toolchainIdentityPresent,
    passed: ckFqbnExact && nativeFqbnExact && cliVersionExact
      && coreVersionExact && toolchainIdentityPresent,
  };
}

function stageEquivalence(stageEntry, ck, native, adapter, identity, requestedFqbn) {
  const artifacts = artifactEquivalence(ck, native, adapter, stageEntry.id);
  const ccdb = ccdbEquivalent(ck.ccdb, native.ccdb);
  const identityEvidence = stageIdentityEvidence(ck, native, identity, requestedFqbn);
  return {
    source: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === stageEntry.sourceSha256,
    resources: forge.resourcesEquivalent(ck.resources, native.resources),
    artifacts,
    ccdb,
    identity: identityEvidence,
    passed: ck.codeSha256 === native.codeSha256 && ck.codeSha256 === stageEntry.sourceSha256
      && forge.resourcesEquivalent(ck.resources, native.resources)
      && artifacts.passed && ccdb.passed && identityEvidence.passed,
  };
}

function evaluateTrial(trial) {
  const complete = trial.stages.length === LIBRARY_EDIT_SEQUENCE.length;
  const paths = {
    ck: new Set(trial.stages.map((stageRow) => stageRow.ck?.buildPathIdentitySha256)).size === 1,
    native: new Set(trial.stages.map((stageRow) => stageRow.native?.buildPathIdentitySha256)).size === 1,
  };
  const objectReuse = {
    thirdPartyCk: sameGraphObjectReuse(trial.stages, 'third-party', 'ck'),
    thirdPartyNative: sameGraphObjectReuse(trial.stages, 'third-party', 'native'),
    coreLibraryCk: sameGraphObjectReuse(trial.stages, 'core-library', 'ck'),
    coreLibraryNative: sameGraphObjectReuse(trial.stages, 'core-library', 'native'),
  };
  const nativeRelinkEvidence = {
    thirdParty: sameGraphNativeRelinkEvidence(trial.stages, 'third-party'),
    coreLibrary: sameGraphNativeRelinkEvidence(trial.stages, 'core-library'),
  };
  const measurementPassed = complete && trial.stages.every((stageRow) => (
    stageRow.equivalence?.passed === true && stageRow.routeEvidence?.safe === true
  )) && Object.values(paths).every(Boolean)
    && Object.values(objectReuse).every((evidence) => evidence.exact === true)
    && Object.values(nativeRelinkEvidence).every((evidence) => evidence.passed === true)
    && trial.failures.length === 0;
  const optimizedRoutePassed = complete
    && trial.stages.filter((stageRow) => stageRow.performanceRequired)
    .every((stageRow) => stageRow.routeEvidence?.preferred === true);
  return {
    complete, measurementPassed, optimizedRoutePassed, stableBuildPaths: paths, objectReuse,
    nativeRelinkEvidence,
  };
}

function toolchainIdentityEvidence(trials) {
  const keys = trials.flatMap((trial) => trial.stages.map((stageRow) => stageRow.ck?.toolchainKey))
    .filter((value) => typeof value === 'string' && value.length > 0);
  const expectedCount = trials.reduce((count, trial) => count + trial.stages.length, 0);
  const stable = keys.length === expectedCount && new Set(keys).size === 1;
  return {
    observedRunCount: keys.length,
    expectedRunCount: expectedCount,
    distinctIdentityCount: new Set(keys).size,
    toolchainKey: stable ? keys[0] : null,
    passed: stable,
  };
}

function median(values) {
  const sorted = values.filter(Number.isFinite).sort((left, right) => left - right);
  if (sorted.length === 0) return null;
  const middle = Math.floor(sorted.length / 2);
  return sorted.length % 2 ? sorted[middle] : (sorted[middle - 1] + sorted[middle]) / 2;
}

function evaluatePerformance(trials) {
  const stages = LIBRARY_EDIT_SEQUENCE.map((stageEntry) => {
    const ckRawMs = trials.map((trial) => Number(trial.stages.find((row) => row.id === stageEntry.id)?.ck?.wallMs));
    const nativeRawMs = trials.map((trial) => Number(trial.stages.find((row) => row.id === stageEntry.id)?.native?.wallMs));
    const ckMedianMs = median(ckRawMs);
    const nativeMedianMs = median(nativeRawMs);
    const recordedOnly = !stageEntry.performanceRequired;
    const medianGainMs = ckMedianMs == null || nativeMedianMs == null ? null : nativeMedianMs - ckMedianMs;
    const speedupPct = ckMedianMs == null || nativeMedianMs == null || nativeMedianMs <= 0
      ? null : ((nativeMedianMs - ckMedianMs) / nativeMedianMs) * 100;
    const optimizedRoutePassed = recordedOnly || trials.every((trial) => (
      trial.stages.find((row) => row.id === stageEntry.id)?.routeEvidence?.preferred === true
    ));
    const passed = recordedOnly ? null : optimizedRoutePassed
      && speedupPct >= PERFORMANCE_POLICY.minimumMedianSpeedupPct
      && medianGainMs >= PERFORMANCE_POLICY.minimumAbsoluteMedianGainMs;
    return {
      id: stageEntry.id,
      workload: stageEntry.workload,
      transitionKind: stageEntry.transitionKind,
      recordedOnly,
      optimizedRoutePassed,
      ckRawMs,
      nativeRawMs,
      ckMedianMs,
      nativeMedianMs,
      ckSpeedupPctVsNative: speedupPct,
      medianGainMs,
      passed,
    };
  });
  const gated = stages.filter((stageEntry) => !stageEntry.recordedOnly);
  const targetMet = gated.length === 2 && gated.every((stageEntry) => stageEntry.passed === true);
  const formalTrialCount = trials.length >= PERFORMANCE_POLICY.formalRecommendedTrials;
  const qualified = targetMet && formalTrialCount;
  return {
    policy: PERFORMANCE_POLICY,
    trialCount: trials.length,
    formalTrialCount,
    stages,
    targetMet,
    qualified,
    passed: qualified,
    status: qualified ? 'qualified' : targetMet ? 'exploratory-target-met' : 'target-not-met',
    note: !formalTrialCount
      ? `Exploratory ${trials.length}-trial evidence; use ${PERFORMANCE_POLICY.formalRecommendedTrials} trials for formal review.`
      : null,
  };
}

function safeTrialRoot(workRoot, trialId) {
  const candidate = path.join(workRoot, 'trials', trialId);
  const relative = path.relative(workRoot, candidate);
  if (relative.startsWith('..') || path.isAbsolute(relative)) throw new Error('trial root escaped work root');
  fs.mkdirSync(candidate, { recursive: true });
  return candidate;
}

async function laneBoundary(lane) {
  return {
    lane,
    ...await forge.waitForArduinoCliIdleWindow({
      phaseLabel: `${lane} ESP32 library-edit lane`,
      idleWindowMs: forge.ARDUINO_CLI_LANE_IDLE_WINDOW_MS,
      timeoutMs: forge.ARDUINO_CLI_LANE_IDLE_TIMEOUT_MS,
      pollIntervalMs: forge.ARDUINO_CLI_LANE_IDLE_POLL_INTERVAL_MS,
      policyId: forge.ARDUINO_CLI_LANE_IDLE_POLICY_ID,
    }),
  };
}

async function execute(options) {
  const plan = planFor(options);
  const timeoutMs = options.timeoutMinutes * 60_000;
  const jobs = forge.effectiveJobs();
  const adapter = forge.nativeRelinkAdapterFor(options.fqbn);
  if (adapter == null || adapter.coreArchitecture !== 'esp32') {
    throw new Error('FQBN has no exact ESP32 NativeRelink adapter contract');
  }
  const reproducibility = forge.qualificationReproducibility();
  if (!reproducibility.passed) {
    throw new Error(`ESP32 evidence requires SOURCE_DATE_EPOCH=${forge.QUALIFICATION_SOURCE_DATE_EPOCH} and TZ=${forge.QUALIFICATION_TIME_ZONE}`);
  }
  const qualificationToken = String(process.env[QUALIFICATION_TOKEN_ENV] || '');
  if (!/^[a-f0-9]{64}$/u.test(qualificationToken)) {
    throw new Error(`execution requires a 64-character token in ${QUALIFICATION_TOKEN_ENV}`);
  }
  const workParent = path.join(os.tmpdir(), 'CKAB');
  fs.mkdirSync(workParent, { recursive: true });
  const workRoot = path.join(workParent, crypto.randomBytes(8).toString('hex'));
  fs.mkdirSync(workRoot, { recursive: false });
  const librariesRoot = path.join(REPO_ROOT, 'sketchbook', 'libraries');
  const runToken = crypto.randomBytes(16).toString('hex');
  const productionBefore = forge.inspectProductionExecutable();
  const report = {
    schemaId: REPORT_SCHEMA_ID,
    schemaVersion: SCHEMA_VERSION,
    status: 'running',
    measurementStatus: 'running',
    libraryFastPathStatus: 'not-evaluated',
    startedAt: new Date().toISOString(),
    controls: {
      compileOnly: true,
      uploadPerformed: false,
      physicalFlashWritten: false,
      serialPortAccessed: false,
      qualificationClaimed: false,
      qualificationProbe: true,
      qualificationTokenBound: true,
      fixtureInstallAuthorized: true,
      oneCacheResetPerTrial: true,
      sequentialNoConcurrentCompiles: true,
      reproducibility,
      routePolicy: plan.routePolicy,
      equivalencePolicy: plan.equivalencePolicy,
    },
    fqbn: options.fqbn,
    planSha256: forge.digestObject(plan),
    identity: null,
    trials: [],
    performanceTarget: null,
    failures: [],
    fixtureLifecycle: { installed: false, cleaned: false, manifestSha256: null },
    productionExecutable: { before: productionBefore, after: null, unchanged: null },
    disk: {
      minimumFreeGiB: options.minFreeGiB,
      freeBytesBefore: forge.assertFreeSpace(workRoot, options.minFreeGiB),
      freeBytesAfterCapture: null,
      freeBytesAfterCleanup: null,
      cleanup: null,
    },
  };
  let cdp;
  try {
    const installed = materializeFixture(librariesRoot, runToken);
    report.fixtureLifecycle.installed = true;
    report.fixtureLifecycle.manifestSha256 = installed.manifestSha256;
    report.startupStability = await forge.waitForArduinoCliIdleWindow();
    const page = await forge.getCdpTarget();
    cdp = forge.createCdp(page.webSocketDebuggerUrl);
    const preflight = await forge.runCdpPreflightAndWaitForPreTrialStability({
      evaluate: cdp.evaluate, compileTimeoutMs: timeoutMs, expectedJobs: jobs,
    });
    report.preTrialStability = preflight.stability;
    report.compileSettingsSha256 = forge.digestObject(preflight.compileSettings);
    const baselineConfig = forge.nativeBaselineContract(null);
    report.identity = forge.inspectCliAndCore(options.fqbn, baselineConfig.cliConfigPath);
    if (String(report.identity.coreArchitecture).toLowerCase() !== 'esp32') {
      throw new Error(`resolved architecture ${report.identity.coreArchitecture} is not ESP32`);
    }
    const platformRoot = corePlatformRoot(report.identity);
    const payloadProof = forge.espApplicationPayloadRecipeProofForCore(report.identity);
    if (!forge.validEspApplicationPayloadRecipeProof(payloadProof, report.identity)) {
      throw new Error('resolved ESP32 Core lacks the bounded application payload recipe proof');
    }
    report.payloadRecipeProof = payloadProof;
    const nativeBaseline = forge.nativeBaselineContract(null, report.identity);
    await forge.waitForArduinoCliIdleWindow({ phaseLabel: 'ESP32 library-edit post-identity' });
    for (let trialIndex = 0; trialIndex < options.trials; trialIndex += 1) {
      const trialId = `trial-${String(trialIndex + 1).padStart(3, '0')}`;
      const trial = { id: trialId, cacheReset: null, stages: [], failures: [], result: null };
      report.trials.push(trial);
      trial.cacheReset = await clearCkCache(cdp.evaluate, options.fqbn, timeoutMs);
      const nativeContext = forge.createNativeTrial(
        safeTrialRoot(workRoot, trialId), trialId, options.fqbn, jobs,
        LIBRARY_EDIT_SEQUENCE[0].code, nativeBaseline, payloadProof,
      );
      let graphEstablishmentFailed = false;
      for (const [stageIndex, stageEntry] of LIBRARY_EDIT_SEQUENCE.entries()) {
        const order = (trialIndex + stageIndex) % 2 === 0 ? ['ck', 'native'] : ['native', 'ck'];
        const row = {
          id: stageEntry.id,
          workload: stageEntry.workload,
          transitionKind: stageEntry.transitionKind,
          performanceRequired: stageEntry.performanceRequired,
          order: order.join('-'),
          ck: null,
          native: null,
          equivalence: null,
          routeEvidence: null,
          graphBaselineEvidence: null,
          laneBoundaryIdle: [],
        };
        for (const lane of order) {
          forge.assertNoConcurrentArduinoCli();
          if (lane === 'ck') {
            row.ck = await runCkCompile(
              cdp.evaluate, options.fqbn, stageEntry, timeoutMs, jobs,
              librariesRoot, platformRoot, payloadProof, qualificationToken,
            );
          } else {
            forge.updateNativeTrialSource(nativeContext, stageEntry.code);
            const native = await forge.runNativeCompile(
              nativeContext, stageIndex === 0 ? 'simple' : stageEntry.id, trialId, timeoutMs,
            );
            row.native = dependency.finalizeNativeStageRun({
              ...native,
              ccdb: inspectCcdbLibraryEvidence(
                nativeContext.buildPath, librariesRoot, platformRoot, stageEntry.workload,
              ),
            }, options.fqbn, stageEntry.id);
          }
          row.laneBoundaryIdle.push(await laneBoundary(lane));
        }
        row.equivalence = stageEquivalence(
          stageEntry, row.ck, row.native, adapter, report.identity, options.fqbn,
        );
        row.routeEvidence = routeEvidence(row.ck, stageEntry);
        row.graphBaselineEvidence = graphBaselineEvidence(row.ck, stageEntry);
        trial.stages.push(row);
        if (!row.graphBaselineEvidence.passed) {
          const detail = row.graphBaselineEvidence.rejectionReasons.join(' | ')
            || row.ck?.nativeRelinkEvidence?.failures?.join(', ')
            || 'the required baseline commit marker was absent';
          trial.failures.push(`${stageEntry.id}: library fast baseline was not established: ${detail}`);
          graphEstablishmentFailed = true;
          break;
        }
      }
      trial.result = evaluateTrial(trial);
      if (!trial.result.measurementPassed) report.failures.push(`${trialId}: equivalence, route safety, CCDB or object reuse failed`);
      if (graphEstablishmentFailed) break;
    }
  } catch (error) {
    report.failures.push(String(error?.stack || error));
  } finally {
    if (cdp) {
      try { await clearCkCache(cdp.evaluate, options.fqbn, timeoutMs); } catch (error) {
        report.failures.push(`final cache cleanup: ${error?.message || error}`);
      }
    }
    cdp?.socket.close();
    try {
      if (report.fixtureLifecycle.installed) {
        const cleanup = cleanupFixture(librariesRoot, runToken);
        report.fixtureLifecycle.cleaned = cleanup.removed && !cleanup.remaining;
        if (!report.fixtureLifecycle.cleaned) report.failures.push('temporary ESP32 fixture remains');
      }
    } catch (error) {
      report.failures.push(`fixture cleanup failed: ${error?.message || error}`);
    }
    try {
      report.disk.freeBytesAfterCapture = forge.freeBytesAt(workRoot);
    } catch (error) {
      report.failures.push(`free-space capture failed: ${error?.message || error}`);
    }
    try {
      report.disk.cleanup = forge.inspectOwnedWorkdir(workRoot);
    } catch (error) {
      report.disk.cleanup = { inspectionFailed: true, removed: false, removedPaths: [] };
      report.failures.push(`workdir inspection failed: ${error?.message || error}`);
    }
    if (!options.keepWorkdir) {
      try {
        // Cleanup is deliberately independent from the free-space threshold
        // and evidence inspection so a low-disk failure cannot retain CKAB.
        forge.safeRemoveWorkdir(workRoot);
        report.disk.cleanup.removed = !fs.existsSync(workRoot);
        report.disk.cleanup.removedPaths = ['<TEMP>/CKAB/<run-token>'];
        if (!report.disk.cleanup.removed) throw new Error('owned work directory remains');
      } catch (error) {
        report.failures.push(`workdir removal failed: ${error?.message || error}`);
      }
    } else {
      report.disk.cleanup.removed = false;
      report.disk.cleanup.removedPaths = [];
    }
    try {
      report.disk.freeBytesAfterCleanup = forge.assertFreeSpace(workParent, options.minFreeGiB);
    } catch (error) {
      report.failures.push(`post-cleanup free-space gate failed: ${error?.message || error}`);
    }
    try {
      report.productionExecutable.after = forge.inspectProductionExecutable();
      report.productionExecutable.unchanged = forge.digestObject(productionBefore)
        === forge.digestObject(report.productionExecutable.after);
      if (!report.productionExecutable.unchanged) report.failures.push('production executable/process changed');
    } catch (error) {
      report.failures.push(`production identity finalization failed: ${error?.message || error}`);
    }
    report.performanceTarget = evaluatePerformance(report.trials);
    report.toolchainIdentity = toolchainIdentityEvidence(report.trials);
    report.measurementStatus = report.failures.length === 0
      && report.trials.length === options.trials
      && report.trials.every((trial) => trial.result?.measurementPassed === true)
      && report.toolchainIdentity.passed === true
      && report.fixtureLifecycle.cleaned === true ? 'passed' : 'failed';
    report.libraryFastPathStatus = report.measurementStatus === 'passed'
      && report.trials.every((trial) => trial.result?.optimizedRoutePassed === true)
      && report.performanceTarget.qualified === true
      ? 'qualified'
      : report.measurementStatus === 'passed' && report.performanceTarget.targetMet === true
        ? 'exploratory-target-met' : 'not-qualified';
    report.status = report.measurementStatus === 'passed' && report.libraryFastPathStatus === 'qualified'
      ? 'passed'
      : report.measurementStatus === 'passed' && report.libraryFastPathStatus === 'exploratory-target-met'
        ? 'exploratory' : report.measurementStatus === 'passed' ? 'not-qualified' : 'failed';
    report.finishedAt = new Date().toISOString();
    writeJsonNoClobber(options.outputPath, report);
    process.stdout.write(`REPORT ${options.outputPath}\n`);
  }
  if (report.status !== 'passed') process.exitCode = 1;
  return report;
}

async function main(argv = process.argv.slice(2)) {
  const options = parseArgs(argv);
  if (options.help) {
    process.stdout.write(usage());
    return null;
  }
  if (options.action === 'plan') {
    const plan = planFor(options);
    process.stdout.write(`${JSON.stringify(plan, null, 2)}\nNo compile, cache reset, fixture install, upload or serial access was started.\n`);
    return plan;
  }
  if (options.action === 'cleanup-owned-fixture') {
    const recovery = recoverOwnedFixture(path.join(REPO_ROOT, 'sketchbook', 'libraries'));
    process.stdout.write(`${JSON.stringify(recovery)}\n`);
    return recovery;
  }
  return execute(options);
}

module.exports = {
  DEFAULT_FQBN,
  FIXTURE_NAME,
  FIXTURE_TRANSLATION_UNITS,
  LIBRARY_EDIT_SEQUENCE,
  PERFORMANCE_POLICY,
  PLAN_SCHEMA_ID,
  REPORT_SCHEMA_ID,
  REQUIRED_ESP32_ARTIFACT_ROLES,
  QUALIFICATION_TOKEN_ENV,
  SCHEMA_VERSION,
  ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_CONTRACT,
  ESP32_LIBRARY_NATIVE_RELINK_EVIDENCE_POLICY_ID,
  ESP32_LIBRARY_NATIVE_RELINK_ROUTE_MARKER,
  artifactEquivalence,
  ccdbEquivalent,
  cleanupFixture,
  evaluatePerformance,
  evaluateTrial,
  fixtureFiles,
  fixtureManifest,
  flashArgumentsEquivalent,
  graphBaselineEvidence,
  inspectCcdbLibraryEvidence,
  main,
  materializeFixture,
  parseNativeRelinkTiming,
  parseArgs,
  planFor,
  recoverOwnedFixture,
  requiredArtifactPresence,
  routeEvidence,
  sameGraphObjectReuse,
  sameGraphNativeRelinkEvidence,
  validateNativeRelinkEvidence,
  validateFixtureDefinition,
};

if (require.main === module) {
  main().catch((error) => {
    process.stderr.write(`CK ESP32 library edit regression: ${error?.stack || error}\n`);
    process.exitCode = 1;
  });
}
