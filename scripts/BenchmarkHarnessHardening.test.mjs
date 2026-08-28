import assert from 'node:assert/strict';
import * as crypto from 'node:crypto';
import {
  mkdtempSync,
  mkdirSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import * as fs from 'node:fs';
import { tmpdir } from 'node:os';
import * as path from 'node:path';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const harnesses = [
  fileURLToPath(new URL('../artifacts/benchmarks/Run-CrossBoard-CompileOnly.cjs', import.meta.url)),
  fileURLToPath(new URL('../artifacts/benchmarks/Run-C6-CodeSequence.cjs', import.meta.url)),
];

const sources = harnesses.map((file) => ({ file, source: readFileSync(file, 'utf8') }));

function loadNamedFunctions(source, names, context = {}) {
  const declarations = names.map((name) => {
    const start = source.indexOf(`function ${name}(`);
    assert.notEqual(start, -1, `missing function ${name}`);
    const openBrace = source.indexOf('{', start);
    assert.notEqual(openBrace, -1, `missing opening brace for ${name}`);
    let depth = 0;
    for (let index = openBrace; index < source.length; ++index) {
      if (source[index] === '{') depth += 1;
      if (source[index] === '}') depth -= 1;
      if (depth === 0) return source.slice(start, index + 1);
    }
    throw new Error(`missing closing brace for ${name}`);
  });
  const contextNames = Object.keys(context);
  return Function(
    ...contextNames,
    `"use strict";\n${declarations.join('\n')}\nreturn { ${names.join(', ')} };`,
  )(...Object.values(context));
}

test('both native benchmark harnesses remain valid CommonJS programs', () => {
  for (const { file } of sources) {
    const result = spawnSync(process.execPath, ['--check', file], { encoding: 'utf8' });
    assert.equal(result.status, 0, `${file}\n${result.stderr || result.stdout}`);
  }
});

test('cross-board catalog includes the official STM32 Nucleo F401RE compile-only target', () => {
  const harness = harnesses.find((file) => file.endsWith('Run-CrossBoard-CompileOnly.cjs'));
  const listed = spawnSync(process.execPath, [
    harness,
    '--targets',
    'stm32-f401re',
    '--list',
  ], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const [target] = JSON.parse(listed.stdout);

  assert.equal(target.id, 'stm32-f401re');
  assert.equal(target.fqbn, 'STMicroelectronics:stm32:Nucleo_64:pnum=NUCLEO_F401RE');
  assert.equal(target.referenceCoreVersion, '2.12.0');
  assert.equal(
    target.fqbnEvidence,
    'https://github.com/stm32duino/Arduino_Core_STM32/blob/2.12.0/boards.txt',
  );
  assert.equal(typeof target.installedPlatform.available, 'boolean');
  if (!target.installedPlatform.available) {
    assert.ok(
      typeof target.installedPlatform.reason === 'string'
        || target.installedPlatform.boardDeclared === false
        || target.installedPlatform.menuSelectionsDeclared === false,
      'a missing Core/board/menu must be reported as unavailable, not advertised as compiled support',
    );
  }
});

test('cross-board catalog binds ESP32-H2 and ESP32-P4 to Core 3.3.6 board IDs', () => {
  const boardsText = readFileSync(new URL(
    '../packages/esp32/hardware/esp32/3.3.6/boards.txt',
    import.meta.url,
  ), 'utf8');
  assert.match(boardsText, /^esp32h2\.name=ESP32H2 Dev Module$/m);
  assert.match(boardsText, /^esp32p4\.name=ESP32P4 Dev Module$/m);

  const harness = harnesses.find((file) => file.endsWith('Run-CrossBoard-CompileOnly.cjs'));
  const listed = spawnSync(process.execPath, [
    harness,
    '--targets',
    'h2,p4',
    '--list',
  ], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const targets = JSON.parse(listed.stdout);
  assert.deepEqual(
    targets.map(({ id, fqbn, referenceCoreVersion }) => ({ id, fqbn, referenceCoreVersion })),
    [
      { id: 'h2', fqbn: 'esp32:esp32:esp32h2', referenceCoreVersion: '3.3.6' },
      { id: 'p4', fqbn: 'esp32:esp32:esp32p4', referenceCoreVersion: '3.3.6' },
    ],
  );
  assert.ok(targets.every((target) => target.installedPlatform.available === true));
});

test('cross-board catalog binds broad ESP32 targets and menu profiles to Core 3.3.6', () => {
  const boardsText = readFileSync(new URL(
    '../packages/esp32/hardware/esp32/3.3.6/boards.txt',
    import.meta.url,
  ), 'utf8');
  for (const declaration of [
    /^esp32c2\.name=ESP32C2 Dev Module$/m,
    /^esp32c61\.name=ESP32C61 Dev Module$/m,
    /^adafruit_feather_esp32c6\.name=Adafruit Feather ESP32-C6$/m,
    /^sparkfun_esp32s3_thing_plus\.name=SparkFun ESP32-S3 Thing Plus$/m,
    /^esp32wrover\.name=ESP32 Wrover Module$/m,
  ]) {
    assert.match(boardsText, declaration);
  }

  const harness = harnesses.find((file) => file.endsWith('Run-CrossBoard-CompileOnly.cjs'));
  const targetIds = [
    'c2-2m-minimal-config',
    'c61-8m-psram-config',
    'c3-2m-minimal-config',
    's3-32m-opi-config',
    'compat-adafruit-feather-c6',
    'compat-sparkfun-s3-thing-plus',
    'compat-esp32-wrover',
  ];
  const listed = spawnSync(process.execPath, [
    harness,
    '--targets',
    targetIds.join(','),
    '--list',
  ], { encoding: 'utf8' });
  assert.equal(listed.status, 0, listed.stderr || listed.stdout);
  const targets = JSON.parse(listed.stdout);
  assert.deepEqual(targets.map((target) => target.id), targetIds);
  assert.ok(targets.every((target) => target.referenceCoreVersion === '3.3.6'));
  assert.ok(targets.every((target) => typeof target.coveragePurpose === 'string'));
  assert.ok(targets.every((target) => target.coveragePurpose.length >= 40));
  assert.ok(targets.every((target) => target.installedPlatform.available === true));
  assert.ok(targets.every((target) => target.installedPlatform.boardDeclared === true));
  assert.ok(targets.every((target) => target.installedPlatform.menuSelectionsDeclared === true));
});

test('cross-board installed-platform preflight authenticates complete FQBN menu selections', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  assert.match(source, /const menuSelectionsDeclared = menuSelections\.every/);
  assert.match(source, /available: Boolean\(declaredVersion && boardDeclared && menuSelectionsDeclared\)/);
  assert.match(source, /target\.architecture === 'avr' \|\| target\.architecture === 'stm32'/);
});

test('both harnesses bind their own bytes and the independently resolved production process', () => {
  for (const { source } of sources) {
    assert.match(source, /function inspectRunnerIdentity\(\)/);
    assert.match(source, /sha256:\s*sha256File\(runnerPath\)/);
    assert.match(source, /Get-NetTCPConnection -LocalPort \$\{/);
    assert.match(source, /CDP listener ancestry did not resolve to appsdesktop\.exe/);
    assert.match(source, /CK_PROCESS_ID does not match the independently resolved production process/);
    assert.match(source, /target['"],?\s*['"]release['"],?\s*['"]appsdesktop\.exe/);
    assert.match(source, /executableSha256:\s*sha256File\(actualExecutable\)/);
    assert.match(source, /sameRunnerIdentity\(runnerBefore, runnerAfter\)/);
    assert.match(source, /sameProductionBinding\(productionBefore, productionAfter\)/);
    assert.match(source, /if \(report\.status === 'failed'\) process\.exitCode = 1;/);
  }
});

test('filesystem evidence uses real paths and requires an exact primary application artifact', () => {
  for (const { source } of sources) {
    assert.match(source, /const canonicalRoot = realpathExisting\(root\)/);
    assert.match(source, /const canonicalCandidate = realpathExisting\(candidate\)/);
    assert.match(source, /primaryApplication = expectedPrimaryNames\.has\(name\)/);
    assert.match(source, /artifact\.verified && artifact\.primaryApplication === true/);
    assert.match(source, /compile_commands\.json escaped the build path/);
  }
});

test('cross-board evidence recognizes the FLFE out-of-tree build layout without widening paths', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const {
    inspectArtifacts,
    inspectSourceEvidence,
  } = loadNamedFunctions(
    source,
    [
      'sha256File',
      'realpathExisting',
      'normalizedPathKey',
      'pathIsWithin',
      'inspectSourceEvidence',
      'inspectArtifacts',
    ],
    { crypto, fs, path },
  );
  const root = mkdtempSync(join(tmpdir(), 'ck-cross-board-evidence-'));
  try {
    const projectName = 'sketch_esp32_esp32_esp32c6_rel';
    const project = join(root, projectName);
    const outOfTreeBuild = join(root, 'build', projectName);
    mkdirSync(project, { recursive: true });
    mkdirSync(outOfTreeBuild, { recursive: true });
    const sketch = join(project, `${projectName}.ino`);
    writeFileSync(sketch, 'void setup() {}\nvoid loop() {}\n');
    const { sha256File } = loadNamedFunctions(source, ['sha256File'], { crypto, fs, path });
    const expectedHash = sha256File(sketch);
    const evidence = inspectSourceEvidence(outOfTreeBuild, expectedHash);
    assert.deepEqual(evidence, {
      projectDirectoryPresent: true,
      rootInoCount: 1,
      exactSourceMatches: 1,
    });

    const elf = join(outOfTreeBuild, `${projectName}.ino.elf`);
    writeFileSync(elf, 'ELF test artifact\n');
    const artifacts = inspectArtifacts([elf], outOfTreeBuild, 'esp32');
    assert.equal(artifacts.length, 1);
    assert.equal(artifacts[0].verified, true);
    assert.equal(artifacts[0].primaryApplication, true);

    // Keep the historical <project>/build layout working as well.
    const legacyProjectName = 'sketch_arduino_avr_uno_rel';
    const legacyProject = join(root, legacyProjectName);
    const legacyBuild = join(legacyProject, 'build');
    mkdirSync(legacyBuild, { recursive: true });
    const legacySketch = join(legacyProject, `${legacyProjectName}.ino`);
    writeFileSync(legacySketch, 'void setup() {}\nvoid loop() {}\n');
    const legacyHash = sha256File(legacySketch);
    assert.deepEqual(inspectSourceEvidence(legacyBuild, legacyHash), {
      projectDirectoryPresent: true,
      rootInoCount: 1,
      exactSourceMatches: 1,
    });
    const legacyElf = join(legacyBuild, `${legacyProjectName}.ino.elf`);
    writeFileSync(legacyElf, 'ELF legacy artifact\n');
    assert.equal(inspectArtifacts([legacyElf], legacyBuild, 'avr')[0].primaryApplication, true);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('cross-board evidence accepts portable firmware formats and treats platform libraries as Core', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { isPlatformCoreSource } = loadNamedFunctions(source, ['isPlatformCoreSource']);
  assert.match(source, /function isPlatformCoreSource\(source\)/);
  assert.match(source, /requiredLibraries\\\.cpp/);
  assert.ok(source.includes(String.raw`/\/packages\/[^/]+\/hardware\/[^/]+\/[^/]+\//i.test(source)`));
  assert.match(source, /allowedExtensions = new Set\(\['\.elf', '\.bin', '\.hex'\]\)/);

  assert.equal(
    isPlatformCoreSource('C:/temp/CK_Builds/sketch_target_rel/build/sketch/requiredLibraries.cpp'),
    true,
    'legacy in-project generated dependency anchor must remain Core-owned',
  );
  assert.equal(
    isPlatformCoreSource('C:/temp/CK_Builds/build/sketch_target_rel/sketch/requiredLibraries.cpp'),
    true,
    'FLFE out-of-tree generated dependency anchor must be Core-owned',
  );
  assert.equal(
    isPlatformCoreSource('C:/workspace/sketch/requiredLibraries.cpp'),
    false,
    'an identically named user source outside a build tree must not be trusted',
  );
  assert.equal(
    isPlatformCoreSource('C:/temp/CK_Builds/build/sketch_target_rel/sketch/userLibrary.cpp'),
    false,
    'the rule must not widen to arbitrary generated or user sketch sources',
  );
});

test('resource, library, and first-project cache evidence fail closed', () => {
  for (const { file, source } of sources) {
    assert.match(source, /resources\?\.evidenceComplete === true/);
    assert.match(source, /Number\.isSafeInteger\(run\.resources\.warningCount\)/);
    assert.match(source, /customLibrariesReported = Array\.isArray\(parsed\?\.customLibraries\)/);
    assert.match(source, /arduinoLibrariesReported = Array\.isArray\(parsed\?\.arduinoLibraries\)/);
    assert.match(source, /customLibraryCount:\s*customLibrariesReported \? parsed\.customLibraries\.length : null/);
    if (file.endsWith('Run-CrossBoard-CompileOnly.cjs')) {
      assert.match(source, /!completeFqbnMatches\(value\.fqbn, expectedFqbn\)/);
    } else {
      assert.match(source, /value\.fqbn !== fqbn/);
    }
    assert.match(source, /value\.reset_scope !== 'first-project-full-fqbn'/);
    assert.match(source, /value\.ccache_store_preserved !== true/);
    assert.match(source, /value\.prebuilt_core_preserved !== false/);
  }
});

test('cross-board exact checks are strict by default and every failed matrix check fails status', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  assert.match(source, /strictExact:\s*true/);
  assert.match(source, /platform-native-recompile-bypassed-ck-exact/);
  assert.match(source, /runMatchesForgeRoute\(exact, 'allow-fast', true\)/);
  assert.match(source, /runMatchesForgeRoute\(exact, 'force-platform', false\)/);
  assert.match(source, /run\.cache\?\.exactMatch !== exactMode/);
  assert.match(source, /'arduino-cli-full-fallback'/);
  assert.match(source, /all-compile-phases-match-forge-route-and-profile/);
  assert.match(source, /if \(!check\.skipped && check\.passed !== true\)/);
  assert.match(source, /report\.failures\.push\(`matrix check failed:/);
  assert.doesNotMatch(source, /check\.id === 'exact-match-observed' && !options\.strictExact/);
});

test('cross-board FQBN evidence compares canonical menu options and fails malformed input closed', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { canonicalCompleteFqbn, completeFqbnMatches } = loadNamedFunctions(
    source,
    ['canonicalCompleteFqbn', 'completeFqbnMatches'],
  );
  const requested = 'esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled';
  const reported = 'esp32:esp32:esp32c5:FlashSize=16M,PSRAM=enabled,PartitionScheme=app3M_fat9M_16MB';

  assert.equal(completeFqbnMatches(requested, reported), true);
  assert.match(source, /&& completeFqbnMatches\(reportedFqbn, target\.fqbn\)/);
  assert.equal(
    canonicalCompleteFqbn(requested),
    'esp32:esp32:esp32c5:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=enabled',
  );
  assert.equal(completeFqbnMatches(requested, `${reported},flashsize=8M`), false);
  assert.equal(completeFqbnMatches(requested, 'esp32:esp32:esp32c5:FlashSize'), false);
  assert.equal(completeFqbnMatches(null, null), false);
  assert.equal(
    canonicalCompleteFqbn('vendor:arch:board:\u00e9=two,z=one'),
    'vendor:arch:board:z=one,\u00e9=two',
    'canonical order must use Rust-compatible UTF-8 bytes, not locale collation',
  );
  assert.notEqual(
    canonicalCompleteFqbn('vendor:arch:board:Key=one,\u212aey=two'),
    null,
    'only ASCII case folding is valid for duplicate-key detection',
  );
});

test('cross-board route/profile and exact telemetry checks cannot be mixed across runs', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { runMatchesForgeRoute, validForgeEngineEvidence } = loadNamedFunctions(
    source,
    ['runMatchesForgeRoute', 'validForgeEngineEvidence'],
  );
  const allowEngine = {
    id: 'ck-forge',
    schemaVersion: 1,
    productVersion: '1',
    contractId: 'contract',
    decision: 'allow-fast',
    source: 'builtin-matrix',
    reasonCodes: ['builtin-platform-core-qualified'],
  };
  const allowExact = {
    success: true,
    profile: 'quick-fast',
    buildMode: 'exact-match',
    cache: { exactMatch: true },
    engine: allowEngine,
  };
  assert.equal(validForgeEngineEvidence(allowEngine), true);
  assert.equal(runMatchesForgeRoute(allowExact, 'allow-fast', true), true);

  const routeDrift = structuredClone(allowExact);
  routeDrift.engine.decision = 'force-platform';
  routeDrift.engine.source = 'conservative-fallback';
  assert.equal(runMatchesForgeRoute(routeDrift, 'allow-fast', true), false);
  const profileDrift = structuredClone(allowExact);
  profileDrift.profile = 'release';
  assert.equal(runMatchesForgeRoute(profileDrift, 'allow-fast', true), false);
  const hiddenExact = structuredClone(allowExact);
  hiddenExact.buildMode = 'arduino-cli-incremental';
  assert.equal(runMatchesForgeRoute(hiddenExact, 'allow-fast', false), false);

  const forceNative = {
    success: true,
    profile: 'release',
    buildMode: 'arduino-cli-incremental',
    cache: { exactMatch: false },
    engine: {
      ...allowEngine,
      decision: 'force-platform',
      source: 'conservative-fallback',
      reasonCodes: ['unknown-platform'],
    },
  };
  assert.equal(validForgeEngineEvidence(forceNative.engine), true);
  assert.equal(runMatchesForgeRoute(forceNative, 'force-platform', false), true);

  const mislabeledPortableFast = structuredClone(forceNative);
  mislabeledPortableFast.profile = 'portable-fast';
  assert.equal(runMatchesForgeRoute(mislabeledPortableFast, 'force-platform', false), false);

  forceNative.cache.exactMatch = true;
  forceNative.buildMode = 'exact-match';
  assert.equal(runMatchesForgeRoute(forceNative, 'force-platform', false), true);

  const forceNativeHiddenExact = structuredClone(forceNative);
  forceNativeHiddenExact.buildMode = 'arduino-cli-incremental';
  assert.equal(runMatchesForgeRoute(forceNativeHiddenExact, 'force-platform', false), false);

  const malformedEvidence = structuredClone(allowEngine);
  malformedEvidence.reasonCodes = [];
  assert.equal(validForgeEngineEvidence(malformedEvidence), false);
});

test('cross-board cache clear accepts only canonically equivalent complete FQBNs', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { validateFirstProjectCacheClear } = loadNamedFunctions(
    source,
    ['canonicalCompleteFqbn', 'completeFqbnMatches', 'validateFirstProjectCacheClear'],
  );
  const expected = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB';
  const value = {
    fqbn: 'esp32:esp32:esp32c6:PartitionScheme=app3M_fat9M_16MB,FlashSize=16M',
    reset_scope: 'first-project-full-fqbn',
    removed_entries: 0,
    removed_bytes: 0,
    force_rebuild_pending: false,
    ccache_store_preserved: true,
    prebuilt_core_preserved: false,
    prebuilt_core_validated: false,
    force_ccache_recache: false,
  };
  assert.equal(validateFirstProjectCacheClear(value, expected).valid, true);
  value.fqbn = 'esp32:esp32:esp32c6:FlashSize=8M,PartitionScheme=app3M_fat9M_16MB';
  assert.equal(validateFirstProjectCacheClear(value, expected).valid, false);
});

test('cross-board dependency equivalence ignores cold Core CCDB entry-count differences', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { dependencyClosureEquivalent } = loadNamedFunctions(source, ['dependencyClosureEquivalent']);
  const coldCliRun = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 84,
      nonCoreEntryCount: 0,
      nonCoreSourceSetSha256: 'core-only-set',
      libraryNames: [],
    },
  };
  const syntheticFastRelinkRun = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 1,
      nonCoreEntryCount: 0,
      nonCoreSourceSetSha256: 'core-only-set',
      libraryNames: [],
    },
  };

  assert.equal(dependencyClosureEquivalent(coldCliRun, syntheticFastRelinkRun), true);
  syntheticFastRelinkRun.dependencyClosure.nonCoreEntryCount = 1;
  assert.equal(dependencyClosureEquivalent(coldCliRun, syntheticFastRelinkRun), false);
});

test('cross-board expected-library check compares non-Core growth, not total CCDB entries', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { dependencyClosureAddsExpectedLibrary } = loadNamedFunctions(
    source,
    ['dependencyClosureAddsExpectedLibrary'],
  );
  const coldCliRun = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 84,
      nonCoreEntryCount: 0,
      nonCoreSourceSetSha256: 'core-only-set',
      libraryNames: [],
    },
  };
  const syntheticDependencyRun = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 2,
      nonCoreEntryCount: 1,
      nonCoreSourceSetSha256: 'wifi-source-set',
      libraryNames: ['WiFi'],
    },
  };

  assert.equal(dependencyClosureAddsExpectedLibrary(coldCliRun, syntheticDependencyRun, 'WiFi'), true);
  syntheticDependencyRun.dependencyClosure.nonCoreEntryCount = 0;
  assert.equal(dependencyClosureAddsExpectedLibrary(coldCliRun, syntheticDependencyRun, 'WiFi'), false);
});

test('cross-board expected-library check accepts a Core-provided header without inventing a user library', () => {
  const source = sources.find(({ file }) => file.endsWith('Run-CrossBoard-CompileOnly.cjs')).source;
  const { dependencyClosureAddsExpectedLibrary } = loadNamedFunctions(
    source,
    ['dependencyClosureAddsExpectedLibrary'],
  );
  const primary = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 57,
      nonCoreEntryCount: 0,
      nonCoreSourceSetSha256: 'core-only-set',
      libraryNames: [],
    },
    environment: { includeHeaders: ['Arduino.h'] },
  };
  const dependency = {
    dependencyClosure: {
      compileCommandsPresent: true,
      entryCount: 71,
      nonCoreEntryCount: 0,
      nonCoreSourceSetSha256: 'core-only-set',
      libraryNames: [],
    },
    environment: { includeHeaders: ['Arduino.h', 'WiFi.h'] },
  };

  assert.equal(dependencyClosureAddsExpectedLibrary(primary, dependency, 'WiFi'), true);
  dependency.environment.includeHeaders = ['Arduino.h'];
  assert.equal(dependencyClosureAddsExpectedLibrary(primary, dependency, 'WiFi'), false);
});
