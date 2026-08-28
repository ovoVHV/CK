import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import { validateBoardPackage } from './Validate-BoardPackage.mjs';

const scriptDirectory = path.dirname(fileURLToPath(import.meta.url));
const repositoryRoot = path.resolve(scriptDirectory, '..');
const c6Example = path.join(repositoryRoot, 'examples', 'importable-packages', 'ck_example_c6_board');

test('board and ck.lock schemas expose the passport contract as valid JSON', () => {
  const boardSchema = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'docs', 'schemas', 'ck-board.schema.json'), 'utf8'),
  );
  const lockSchema = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'docs', 'schemas', 'ck-board-lock.schema.json'), 'utf8'),
  );
  assert.ok(boardSchema.properties.hardware_variants);
  assert.ok(boardSchema.properties.validation_profiles);
  assert.ok(boardSchema.properties.smoke_tests);
  assert.ok(boardSchema.properties.validation_matrix);
  assert.equal(boardSchema.properties.pins.items.$ref, '#/$defs/pin');
  assert.deepEqual(boardSchema.$defs.pinRisk.properties.severity.enum, [
    'blocker',
    'warning',
    'notice',
  ]);
  assert.equal(boardSchema.$defs.pinRisk.properties.when.$ref, '#/$defs/pinRiskCondition');
  assert.deepEqual(boardSchema.$defs.pinRiskCondition.properties.features, {
    type: 'array',
    minItems: 1,
    maxItems: 16,
    uniqueItems: true,
    items: { $ref: '#/$defs/pinIdentifier' },
  });
  assert.equal(boardSchema.$defs.pin.properties.value.$ref, '#/$defs/pinCodeToken');
  assert.equal(
    boardSchema.$defs.pinCodeToken.pattern,
    '^(?:0|[1-9][0-9]*|[A-Za-z_][A-Za-z0-9_]*)$',
  );
  assert.deepEqual(boardSchema.$defs.pinConnector.properties.side.enum, [
    'left',
    'right',
    'top',
    'bottom',
  ]);
  for (const field of [
    'aliases',
    'capabilities',
    'risks',
    'reserved_by',
    'sharing',
    'connector',
    'source',
    'evidence',
  ]) {
    assert.ok(boardSchema.$defs.pin.properties[field], `missing precise pin field ${field}`);
  }
  const reservationContract = boardSchema.$defs.pin.properties.reserved_by;
  assert.equal(reservationContract.oneOf[0].type, 'string');
  assert.equal(reservationContract.oneOf[1].type, 'array');
  assert.equal(reservationContract.oneOf[1].minItems, 1);
  assert.equal(reservationContract.oneOf[1].uniqueItems, true);
  assert.ok(boardSchema.$defs.arduinoCore.properties.recommended_version);
  assert.ok(boardSchema.$defs.arduinoCore.properties.version_range);
  assert.equal(boardSchema.$defs.optionMap.minProperties, undefined);
  assert.equal(boardSchema.$defs.optionValue.pattern, '^[A-Za-z0-9_.-]+$');
  assert.ok(lockSchema.properties.core.$ref);
  assert.ok(lockSchema.required.includes('certification_engine_contract'));
  assert.equal(
    lockSchema.properties.certification_engine_contract.$ref,
    '#/$defs/certificationEngineContract',
  );
  assert.equal(
    lockSchema.$defs.certificationEngineContract.const,
    'ck-fast-build-contract-v9:command-scoped-ccache-native-file-paths-O1-final-g0-no-lto-expanded-ccdb-core-deps-portable-response-guard',
  );
  assert.ok(lockSchema.$defs.coreCompatibility.properties.installed_version);
  assert.deepEqual(lockSchema.properties.evidence_provenance.enum, ['local', 'publisher', 'ck']);
  assert.deepEqual(lockSchema.$defs.evidence.properties.provenance.enum, ['local', 'publisher', 'ck']);
  assert.deepEqual(lockSchema.$defs.evidence.properties.kind.enum, [
    'environment-result',
    'compile-result',
    'device-result',
    'upload-result',
    'runtime-result',
  ]);
});

test('ck.lock schema tracks certified toolchain, resource, partition and timeout evidence', () => {
  const lockSchema = JSON.parse(
    fs.readFileSync(path.join(repositoryRoot, 'docs', 'schemas', 'ck-board-lock.schema.json'), 'utf8'),
  );
  const profile = lockSchema.$defs.profile;
  assert.ok(profile.properties.toolchain_key);
  const certifiedProfileRule = profile.allOf.find(rule => (
    rule.if?.properties?.status?.enum?.includes('compile_passed')
  ));
  assert.ok(certifiedProfileRule.then.required.includes('toolchain_key'));

  const smoke = lockSchema.$defs.smokeResult;
  for (const field of [
    'source_sha256',
    'log_sha256',
    'toolchain_key',
    'build_signature',
    'duration_ms',
    'flash_used_bytes',
    'ram_used_bytes',
    'warning_count',
    'declared_timeout_seconds',
    'timeout_enforced',
    'partition_path',
    'partition_sha256',
  ]) {
    assert.ok(smoke.properties[field], `missing smoke result field ${field}`);
  }
  assert.equal(smoke.properties.timeout_enforced.const, false);
  assert.deepEqual(smoke.dependentRequired.partition_path, ['partition_sha256']);
  const shaPattern = new RegExp(lockSchema.$defs.sha256.pattern);
  assert.equal(shaPattern.test('a'.repeat(64)), true);
  assert.equal(shaPattern.test('a'.repeat(63)), false);

  for (const field of ['toolchain_keys', 'build_signatures', 'smoke_results', 'matrix_executed']) {
    assert.ok(lockSchema.$defs.evidence.properties[field], `missing evidence field ${field}`);
  }
  assert.equal(
    lockSchema.$defs.evidence.properties.certification_engine_contract.$ref,
    '#/$defs/certificationEngineContract',
  );
  const compileRule = lockSchema.$defs.evidence.allOf.find(rule => (
    rule.if?.properties?.kind?.const === 'compile-result'
  ));
  assert.ok(compileRule.then.required.includes('certification_engine_contract'));
  const esp32Rule = lockSchema.$defs.evidence.allOf.find(rule => (
    rule.if?.properties?.canonical_fqbn?.pattern === '^esp32:'
  ));
  assert.deepEqual(
    esp32Rule.then.properties.smoke_results.items.then.required,
    ['partition_path', 'partition_sha256'],
  );
});

function withTemporaryDirectory(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-board-validator-'));
  try {
    return callback(root);
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function copyC6Example(root) {
  const target = path.join(root, 'ck_example_c6_board');
  fs.cpSync(c6Example, target, { recursive: true });
  return target;
}

function updateManifest(root, mutate) {
  const manifestPath = path.join(root, 'board.json');
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
  mutate(manifest);
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8');
}

test('the distributed C6 example is a valid multi-variant board passport', () => {
  const report = validateBoardPackage(c6Example);
  assert.equal(report.valid, true, report.errors.join('\n'));
  assert.deepEqual(report.counts, {
    hardware_variants: 3,
    validation_profiles: 3,
    smoke_tests: 2,
  });
});

test('direct board validation requires a non-empty LICENSE and rejects package-tree links', (t) => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    fs.rmSync(path.join(packageRoot, 'LICENSE'));
    const missing = validateBoardPackage(packageRoot);
    assert.equal(missing.valid, false);
    assert.ok(missing.errors.includes('LICENSE is required.'));

    fs.writeFileSync(path.join(packageRoot, 'LICENSE'), ' \r\n\t', 'utf8');
    const empty = validateBoardPackage(packageRoot);
    assert.equal(empty.valid, false);
    assert.ok(empty.errors.includes('LICENSE must contain non-whitespace license text.'));
  });

  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    const outsideSmoke = path.join(root, 'outside-smoke');
    fs.renameSync(path.join(packageRoot, 'smoke'), outsideSmoke);
    try {
      fs.symlinkSync(
        outsideSmoke,
        path.join(packageRoot, 'smoke'),
        process.platform === 'win32' ? 'junction' : 'dir',
      );
    } catch (cause) {
      t.diagnostic(`directory link creation unavailable: ${cause.message}`);
      return;
    }
    const linkedParent = validateBoardPackage(packageRoot);
    assert.equal(linkedParent.valid, false);
    assert.match(linkedParent.errors.join('\n'), /symbolic links and junctions are forbidden: smoke/);
  });

  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    const iconPath = path.join(packageRoot, 'assets', 'board.svg');
    const outsideIcon = path.join(root, 'outside-board.svg');
    fs.renameSync(iconPath, outsideIcon);
    try {
      fs.symlinkSync(outsideIcon, iconPath, 'file');
    } catch (cause) {
      t.diagnostic(`file link creation unavailable: ${cause.message}`);
      return;
    }
    const linkedFile = validateBoardPackage(packageRoot);
    assert.equal(linkedFile.valid, false);
    assert.match(linkedFile.errors.join('\n'), /symbolic links and junctions are forbidden: assets\/board\.svg/);
  });
});

test('pin catalog is schema-validated, conflict-checked, and explicitly warns when absent', () => {
  const detailed = validateBoardPackage(c6Example);
  assert.equal(detailed.valid, true, detailed.errors.join('\n'));
  assert.equal(detailed.warnings.some(warning => /^pins:/.test(warning)), false);

  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, manifest => { delete manifest.pins; });
    const absent = validateBoardPackage(packageRoot);
    assert.equal(absent.valid, true, absent.errors.join('\n'));
    assert.match(absent.warnings.join('\n'), /pins:not_declared/);
  });

  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, manifest => {
      manifest.pins[0].value = '../GPIO2';
      manifest.pins[0].sharing = 'sometimes';
      manifest.pins[1].aliases.push(manifest.pins[0].aliases[0]);
    });
    const invalid = validateBoardPackage(packageRoot);
    assert.equal(invalid.valid, false);
    assert.match(invalid.errors.join('\n'), /board\.json.*pins.*pattern|does not match pattern/);
    assert.match(invalid.errors.join('\n'), /allowed value/);
    assert.match(invalid.errors.join('\n'), /token .* conflicts/);
  });
});

test('pin risk feature conditions use the shared CK feature allowlist', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, manifest => {
      manifest.pins[0].risks = [{
        code: 'wifi-scoped-risk',
        severity: 'warning',
        title: 'WiFi-scoped risk',
        when: { features: ['wifi'] },
      }];
    });
    const accepted = validateBoardPackage(packageRoot);
    assert.equal(accepted.valid, true, accepted.errors.join('\n'));
  });

  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, manifest => {
      manifest.pins[0].risks = [{
        code: 'future-scoped-risk',
        severity: 'warning',
        title: 'Future-scoped risk',
        when: { features: ['future-radio'] },
      }];
    });
    const rejected = validateBoardPackage(packageRoot);
    assert.equal(rejected.valid, false);
    assert.match(rejected.errors.join('\n'), /unsupported feature 'future-radio'/);
  });
});

test('the distributed C6 board carries one scoped native library with recursive src', () => {
  const libraryRoot = path.join(
    c6Example,
    'libraries',
    'ck_example_c6_native',
  );
  const manifest = JSON.parse(
    fs.readFileSync(path.join(libraryRoot, 'library.json'), 'utf8'),
  );
  const properties = fs.readFileSync(
    path.join(libraryRoot, 'library.properties'),
    'utf8',
  );
  const smoke = fs.readFileSync(
    path.join(c6Example, 'smoke', 'wifi_compile', 'wifi_compile.ino'),
    'utf8',
  );

  assert.equal(manifest.id, 'ck_example_c6_native');
  assert.deepEqual(manifest.architectures, ['esp32']);
  assert.deepEqual(manifest.includes, ['CKExampleC6Native.h']);
  assert.match(properties, /^includes=CKExampleC6Native\.h$/m);
  assert.equal(
    fs.existsSync(path.join(libraryRoot, 'src', 'CKExampleC6Native.c')),
    true,
  );
  assert.equal(
    fs.existsSync(
      path.join(libraryRoot, 'src', 'vendor', 'protocol', 'codec.c'),
    ),
    true,
  );
  assert.match(smoke, /#include <CKExampleC6Native\.h>/);
  assert.match(smoke, /ck_example_c6_native_signature\(\)/);
});

test('legacy v1 version-only board packages remain valid with a migration warning', () => {
  withTemporaryDirectory((root) => {
    fs.writeFileSync(path.join(root, 'LICENSE'), 'test-only license text\n', 'utf8');
    fs.writeFileSync(
      path.join(root, 'board.json'),
      JSON.stringify({
        schema_version: 1,
        id: 'legacy_nano_clone',
        name: 'Legacy Nano Clone',
        version: '1.0.0',
        description: 'Legacy v1 compatibility fixture',
        architecture: 'avr',
        fqbn_base: 'arduino:avr:nano',
        arduino_core: { package: 'arduino:avr', version: '1.8.6' },
      }),
      'utf8',
    );
    const report = validateBoardPackage(root);
    assert.equal(report.valid, true, report.errors.join('\n'));
    assert.match(report.warnings.join('\n'), /legacy recommended-version alias/);
  });
});

test('smoke tests reject arbitrary command fields', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.smoke_tests[0].command = 'powershell.exe';
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /cannot run arbitrary commands/);
  });
});

test('profiles must assert a complete option map and obey physical fixed options', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.validation_profiles[0].options_complete = false;
      manifest.validation_profiles[0].options.FlashSize = '16M';
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /options_complete must be true/);
    assert.match(report.errors.join('\n'), /violates fixed option FlashSize=4M/);
  });
});

test('an advanced passport may use options={} only when the real target declares no menus', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      delete manifest.custom_menus;
      delete manifest.validation_matrix;
      const profile = manifest.validation_profiles[0];
      profile.options = {};
      manifest.validation_profiles = [profile];
      const variant = manifest.hardware_variants[0];
      delete variant.fixed_options;
      manifest.hardware_variants = [variant];
      const smoke = manifest.smoke_tests[0];
      smoke.profiles = [profile.id];
      manifest.smoke_tests = [smoke];
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, true, report.errors.join('\n'));
  });
});

test('FQBN option keys and values reject delimiters and non-ASCII text', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.validation_profiles[0].options.FlashSize = '16M,EraseFlash=all';
      manifest.validation_profiles[0].options['Bad,Key'] = 'value';
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /must contain only ASCII letters/);
    assert.match(report.errors.join('\n'), /invalid option key 'Bad,Key'/);
  });
});

test('recommended and tested versions cannot also be known incompatible', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.arduino_core.known_incompatible = [
        { version: '3.3.6', reason: 'Regression fixture' },
      ];
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /recommended core version is also declared known_incompatible/);
    assert.match(report.errors.join('\n'), /Tested core version '3.3.6'/);
  });
});

test('maximum_exclusive is a tested-range warning, not an offline blocker', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.arduino_core.version = '4.0.0';
      manifest.arduino_core.recommended_version = '4.0.0';
      manifest.arduino_core.tested_versions = ['4.0.0'];
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, true, report.errors.join('\n'));
    assert.match(report.warnings.join('\n'), /above the publisher-tested range/);
  });
});

test('actual core policy only blocks the minimum floor and known incompatible versions', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.arduino_core.known_incompatible = [
        { version: '3.3.5', reason: 'Regression fixture' },
      ];
    });

    const recommended = validateBoardPackage(packageRoot, { actualCoreVersion: '3.3.6' });
    assert.equal(recommended.valid, true, recommended.errors.join('\n'));
    assert.equal(recommended.warnings.length, 0);

    const untested = validateBoardPackage(packageRoot, { actualCoreVersion: '3.3.7' });
    assert.equal(untested.valid, true, untested.errors.join('\n'));
    assert.match(untested.warnings.join('\n'), /allowed but requires revalidation/);

    const newer = validateBoardPackage(packageRoot, { actualCoreVersion: '4.1.0' });
    assert.equal(newer.valid, true, newer.errors.join('\n'));
    assert.match(newer.warnings.join('\n'), /at or above the publisher-tested upper edge/);

    const tooOld = validateBoardPackage(packageRoot, { actualCoreVersion: '3.2.9' });
    assert.equal(tooOld.valid, false);
    assert.match(tooOld.errors.join('\n'), /below the hard minimum/);

    const incompatible = validateBoardPackage(packageRoot, { actualCoreVersion: '3.3.5' });
    assert.equal(incompatible.valid, false);
    assert.match(incompatible.errors.join('\n'), /explicitly known_incompatible/);
  });
});

test('device smoke tests require explicit consent', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.smoke_tests[0].mode = 'device-upload';
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /requires_user_consent=true/);
  });
});

test('smoke resource budgets must be bounded integers', () => {
  withTemporaryDirectory((root) => {
    const packageRoot = copyC6Example(root);
    updateManifest(packageRoot, (manifest) => {
      manifest.smoke_tests[0].resource_limits.max_flash_bytes = 0;
      manifest.smoke_tests[0].resource_limits.max_warnings = -1;
      manifest.smoke_tests[0].resource_limits.command = 'hidden hook';
    });
    const report = validateBoardPackage(packageRoot);
    assert.equal(report.valid, false);
    assert.match(report.errors.join('\n'), /max_flash_bytes must be a positive integer/);
    assert.match(report.errors.join('\n'), /max_warnings must be an integer from 0 to 10000/);
    assert.match(report.errors.join('\n'), /unsupported field 'command'/);
  });
});
