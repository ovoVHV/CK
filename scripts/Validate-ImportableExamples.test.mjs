import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import {
  cpSync,
  mkdirSync,
  mkdtempSync,
  readFileSync,
  rmSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { basename, dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

import {
  inspectArduinoLayout,
  listPackageFiles,
  validateImportablePackage,
} from './Validate-ImportablePackage.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const exampleRoot = join(ROOT, 'examples', 'importable-packages');
const fixtureRoot = join(ROOT, 'scripts', 'fixtures', 'importable-packages');
const buildScript = join(exampleRoot, 'Build-Examples.ps1');
const sha256File = path => createHash('sha256').update(readFileSync(path)).digest('hex');

test('pure native example covers the standard recursive Arduino library contract', () => {
  const root = join(exampleRoot, 'ck_example_native_deep');
  const result = validateImportablePackage(root, { kind: 'native' });

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.manifest.id, 'ck_example_native_deep');
  assert.equal(result.manifest.version, '1.0.0');
  assert.equal(result.manifest.license, 'MIT');
  assert.deepEqual(result.manifest.architectures, ['*']);
  assert.deepEqual(result.manifest.includes, [
    'CKNativeDeep.h',
    'driver/CKNativeDriver.h',
  ]);
  assert.deepEqual(result.manifest.dependencies, { Wire: '*' });
  assert.equal(result.properties.depends, 'Wire');
  assert.equal(result.properties.architectures, '*');
  assert.equal(result.properties.includes, 'CKNativeDeep.h,driver/CKNativeDriver.h');
  assert.equal(result.properties.license, 'MIT');
  assert.equal(result.layout.kind, 'src-1.5');
  assert.deepEqual(result.layout.sources, [
    'src/driver/foo.cpp',
    'src/foo.c',
    'src/vendor/deep/foo.c',
  ]);
  assert.deepEqual(result.layout.mixedLegacySources, []);
  assert.ok(result.files.includes('README.md'));
  assert.ok(result.files.includes('LICENSE'));
  assert.ok(result.files.includes('examples/native_deep_smoke/native_deep_smoke.ino'));
  assert.deepEqual(result.files, [...result.files].sort(), 'package paths must be ordinally stable');
});

test('migration example pairs a v1 workspace with a closed v2 package contract', () => {
  const root = join(exampleRoot, 'ck_example_i2c_sensor_v2');
  const result = validateImportablePackage(root, { kind: 'block' });

  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  assert.equal(result.migrations.schema_version, 1);
  assert.equal(result.migrations.package_id, 'ck_example_i2c_sensor_v2');
  assert.equal(result.manifest.version, '2.0.0');
  const blockManifest = JSON.parse(readFileSync(join(root, 'ck-blocks.json'), 'utf8'));
  assert.deepEqual(blockManifest.entrypoints, {
    blocks: 'blocks/blocks.json',
    generator: 'blocks/ck-generator.json',
    toolbox: 'blocks/toolbox.xml',
  });
  const generator = JSON.parse(readFileSync(join(root, 'blocks', 'ck-generator.json'), 'utf8'));
  assert.equal(generator.schema, 'ck-generator');
  assert.equal(generator.version, 1);
  assert.deepEqual(generator.rules.map(rule => rule.type), ['ck_example_read_temperature_v2']);
  assert.equal(result.files.some(file => file.endsWith('.js')), false);
  assert.deepEqual(result.migrationCoverage, [{
    fixture: 'migration-fixtures/legacy-1.5.0.workspace.json',
    step: 'legacy-1x-to-2.0.0',
    operations: [
      { op: 'renameBlockType', matches: 2 },
      { op: 'renameField', matches: 2 },
      { op: 'mapEnum', matches: 2 },
    ],
  }]);
  const fixture = JSON.parse(readFileSync(
    join(root, 'migration-fixtures', 'legacy-1.5.0.workspace.json'),
    'utf8',
  ));
  assert.equal(fixture.blocks.blocks[0].type, 'ck_example_read_temperature');
  assert.equal(fixture.blocks.blocks[0].fields.I2C_ADDRESS, '72');
  assert.equal(fixture.blocks.blocks[0].inputs.FALLBACK.shadow.fields.I2C_ADDRESS, '73');
  assert.equal(
    fixture.blocks.blocks[0].extraState.opaque_author_state.fields.I2C_ADDRESS,
    'raw-must-not-migrate',
  );
});

test('minimal block example uses the non-executable CK 1.0 runtime contract', () => {
  const root = join(exampleRoot, 'ck_example_serial_blocks');
  const result = validateImportablePackage(root, { kind: 'block' });
  assert.deepEqual(result.errors, []);
  assert.equal(result.ok, true);
  const blockManifest = JSON.parse(readFileSync(join(root, 'ck-blocks.json'), 'utf8'));
  assert.equal(blockManifest.entrypoints.blocks, 'blocks/blocks.json');
  assert.equal(blockManifest.entrypoints.generator, 'blocks/ck-generator.json');
  assert.ok(result.files.includes('blocks/blocks.json'));
  assert.ok(result.files.includes('blocks/ck-generator.json'));
  assert.equal(result.files.some(file => /(?:blocks|generator)\.js$/i.test(file)), false);
});

test('legacy utility layout remains a separate compiler compatibility fixture', () => {
  const root = join(fixtureRoot, 'legacy_utility_library');
  const listing = listPackageFiles(root);
  const layout = inspectArduinoLayout(root, listing.files);

  assert.deepEqual(listing.errors, []);
  assert.equal(layout.kind, 'legacy-1.0');
  assert.deepEqual(layout.sources, ['root.c', 'utility/deep/helper.c']);
  assert.equal(listing.files.some(file => file.startsWith('src/')), false);
  assert.equal(
    resolve(root).startsWith(resolve(exampleRoot)),
    false,
    'compatibility fixture must not be a user-facing package source',
  );
});

test('negative traversal fixture is rejected and is outside every user ZIP source', () => {
  const root = join(fixtureRoot, 'invalid_native_include');
  const result = validateImportablePackage(root, { kind: 'native' });

  assert.equal(result.ok, false);
  assert.ok(result.errors.some(error => (
    error.includes('library.json.includes') && error.includes('../escape.h')
  )));
  assert.ok(result.errors.some(error => (
    error.includes('library.properties includes') && error.includes('../escape.h')
  )));
  assert.equal(resolve(root).startsWith(resolve(exampleRoot)), false);
  const buildSource = readFileSync(buildScript, 'utf8');
  assert.doesNotMatch(buildSource, /invalid_native_include|legacy_utility_library/);
});

function writeJson(path, value) {
  writeFileSync(path, `${JSON.stringify(value, null, 2)}\n`, 'utf8');
}

function createNativeFixture(parent, id, layout, options = {}) {
  const root = join(parent, id);
  mkdirSync(root, { recursive: true });
  writeJson(join(root, 'library.json'), {
    id,
    name: id,
    version: '1.0.0',
    license: 'MIT',
    architectures: ['*'],
    includes: [layout.publicHeader],
    dependencies: {},
  });
  writeFileSync(join(root, 'README.md'), `# ${id}\n`, 'utf8');
  writeFileSync(join(root, 'LICENSE'), 'test-only MIT fixture\n', 'utf8');
  for (const [relativePath, source] of Object.entries(layout.files)) {
    const path = join(root, ...relativePath.split('/'));
    mkdirSync(dirname(path), { recursive: true });
    writeFileSync(path, source, 'utf8');
  }
  if (options.properties !== false) {
    writeFileSync(join(root, 'library.properties'), [
      `name=${id}`,
      'version=1.0.0',
      'author=Fixture',
      'maintainer=Fixture',
      'sentence=Native compatibility fixture.',
      'paragraph=Exercises a supported Arduino source layout.',
      'category=Other',
      'url=https://example.invalid/native-fixture',
      'architectures=*',
      `includes=${layout.publicHeader}`,
      'license=MIT',
      '',
    ].join('\n'), 'utf8');
  }
  return root;
}

test('native gate accepts pure C, pure C++, header-only, deep src and legacy utility layouts', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ck-native-layouts-'));
  try {
    const fixtures = [
      ['pure_c', {
        publicHeader: 'PureC.h',
        files: {
          'src/PureC.h': '#pragma once\nint pure_c(void);\n',
          'src/vendor/chip/deep/PureC.c': 'int pure_c(void) { return 1; }\n',
        },
      }, 'src-1.5'],
      ['pure_cpp', {
        publicHeader: 'PureCpp.hpp',
        files: {
          'src/PureCpp.hpp': '#pragma once\nint pure_cpp();\n',
          'src/driver/deep/PureCpp.cpp': 'int pure_cpp() { return 2; }\n',
        },
      }, 'src-1.5'],
      ['header_only', {
        publicHeader: 'HeaderOnly.hpp',
        files: { 'src/HeaderOnly.hpp': '#pragma once\ninline int header_only() { return 3; }\n' },
      }, 'src-1.5'],
      ['legacy_utility', {
        publicHeader: 'Legacy.h',
        files: {
          'Legacy.h': '#pragma once\nint legacy_value(void);\n',
          'utility/deep/Legacy.c': 'int legacy_value(void) { return 4; }\n',
        },
      }, 'legacy-1.0'],
    ];
    for (const [id, layout, expectedKind] of fixtures) {
      const root = createNativeFixture(parent, id, layout);
      const result = validateImportablePackage(root, { kind: 'native' });
      assert.equal(result.ok, true, `${id}: ${result.errors.join('; ')}`);
      assert.equal(result.layout.kind, expectedKind);
      assert.equal(result.manifest.dependencies && Object.keys(result.manifest.dependencies).length, 0);
    }
    const headerOnly = validateImportablePackage(join(parent, 'header_only'), { kind: 'native' });
    assert.equal(headerOnly.layout.headerOnly, true);
    assert.ok(headerOnly.warnings.some(warning => /header_only/.test(warning)));
    const legacy = validateImportablePackage(join(parent, 'legacy_utility'), { kind: 'native' });
    assert.ok(legacy.warnings.some(warning => /arduino-layout:legacy/.test(warning)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('native gate accepts a package without library.properties as an explicit warning', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ck-native-no-properties-'));
  try {
    const root = createNativeFixture(parent, 'no_properties', {
      publicHeader: 'NoProperties.h',
      files: {
        'src/NoProperties.h': '#pragma once\nint no_properties(void);\n',
        'src/deep/NoProperties.c': 'int no_properties(void) { return 1; }\n',
      },
    }, { properties: false });
    const result = validateImportablePackage(root, { kind: 'native' });
    assert.equal(result.ok, true, result.errors.join('; '));
    assert.ok(result.warnings.some(warning => /library\.properties:not_declared/.test(warning)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('v2 block gate rejects incomplete semantics, invalid placeholders, and cross-file parameter drift', () => {
  const parent = mkdtempSync(join(tmpdir(), 'ck-v2-contract-'));
  const template = join(exampleRoot, 'ck_example_i2c_sensor_v2');
  const runMutation = (name, mutate) => {
    const root = join(parent, `ck_example_i2c_sensor_v2_${name}`);
    cpSync(template, root, { recursive: true });
    const libraryPath = join(root, 'library.json');
    const blockPath = join(root, 'ck-blocks.json');
    const library = JSON.parse(readFileSync(libraryPath, 'utf8'));
    const blocks = JSON.parse(readFileSync(blockPath, 'utf8'));
    library.id = basename(root);
    blocks.id = basename(root);
    writeJson(libraryPath, library);
    writeJson(blockPath, blocks);
    mutate(root);
    return validateImportablePackage(root, { kind: 'block' });
  };
  try {
    const missingSemantics = runMutation('missing_semantics', root => {
      const path = join(root, 'ck-blocks.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      delete value.blocks[0].semantics;
      writeJson(path, value);
    });
    assert.equal(missingSemantics.ok, false);
    assert.ok(missingSemantics.errors.some(error => /missing required property 'semantics'/.test(error)));

    const invalidPlaceholder = runMutation('invalid_placeholder', root => {
      const path = join(root, 'blocks', 'ck-generator.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value.rules[0].template = 'read({{evil:ADDRESS}})';
      writeJson(path, value);
    });
    assert.equal(invalidPlaceholder.ok, false);
    assert.ok(invalidPlaceholder.errors.some(error => /invalid placeholder/.test(error)));

    const fieldDrift = runMutation('field_drift', root => {
      const path = join(root, 'blocks', 'blocks.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value[0].args0[0].name = 'OTHER_ADDRESS';
      writeJson(path, value);
    });
    assert.equal(fieldDrift.ok, false);
    assert.ok(fieldDrift.errors.some(error => /fields mismatch/.test(error)));

    const missingExample = runMutation('missing_example', root => {
      const path = join(root, 'ck-blocks.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value.blocks[0].examples[0].project = 'examples/not-present/not-present.ino';
      writeJson(path, value);
    });
    assert.equal(missingExample.ok, false);
    assert.ok(missingExample.errors.some(error => /references missing package file/.test(error)));

    const wrongKind = runMutation('wrong_kind', root => {
      const path = join(root, 'blocks', 'ck-generator.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value.rules[0].kind = 'statement';
      writeJson(path, value);
    });
    assert.equal(wrongKind.ok, false);
    assert.ok(wrongKind.errors.some(error => /requires a expression generator/.test(error)));

    const resourceField = runMutation('resource_field', root => {
      const path = join(root, 'blocks', 'blocks.json');
      const value = JSON.parse(readFileSync(path, 'utf8'));
      value[0].args0.push({ type: 'field_image', src: 'local-icon.png', width: 16, height: 16 });
      writeJson(path, value);
    });
    assert.equal(resourceField.ok, false);
    assert.ok(resourceField.errors.some(error => /field_image|resource-bearing/.test(error)));
  } finally {
    rmSync(parent, { recursive: true, force: true });
  }
});

test('Build-Examples emits byte-stable filtered ZIPs into an isolated output directory', () => {
  const output = mkdtempSync(join(tmpdir(), 'ck-importable-examples-'));
  const safeTempRoot = resolve(tmpdir()) + '\\';
  assert.ok(resolve(output).startsWith(safeTempRoot), 'test output must stay under the OS temp root');
  const args = [
    '-NoProfile',
    '-ExecutionPolicy', 'Bypass',
    '-File', buildScript,
    '-OutputDirectory', output,
    '-Package', 'ck_example_native_deep,ck_example_i2c_sensor_v2',
  ];
  try {
    const first = spawnSync('powershell', args, { cwd: ROOT, encoding: 'utf8' });
    assert.equal(first.status, 0, first.stderr || first.stdout);
    const nativeZip = join(output, 'ck_example_native_deep.zip');
    const migrationZip = join(output, 'ck_example_i2c_sensor_v2.zip');
    const firstHashes = [sha256File(nativeZip), sha256File(migrationZip)];

    const second = spawnSync('powershell', args, { cwd: ROOT, encoding: 'utf8' });
    assert.equal(second.status, 0, second.stderr || second.stdout);
    assert.deepEqual(
      [sha256File(nativeZip), sha256File(migrationZip)],
      firstHashes,
      'fixed timestamps and ordinal entry order must make rebuilds byte-identical',
    );
    assert.match(second.stdout, /migration_fixtures":1/);
    assert.match(second.stdout, /ck_example_native_deep\.zip \(11 files, sha256=[0-9a-f]{64}\)/);
    assert.match(second.stdout, /ck_example_i2c_sensor_v2\.zip \(16 files, sha256=[0-9a-f]{64}\)/);
  } finally {
    assert.ok(resolve(output).startsWith(safeTempRoot));
    rmSync(output, { recursive: true, force: true });
  }
});
