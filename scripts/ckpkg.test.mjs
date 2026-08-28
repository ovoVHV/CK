import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { cpSync, existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, symlinkSync, writeFileSync } from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import {
  EXIT,
  buildDeterministicZip,
  compilePackage,
  createPackage,
  packPackage,
  resolveArduinoCli,
  testPackage,
  validatePackage,
} from './ckpkg.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const CLI = join(ROOT, 'scripts', 'ckpkg.mjs');
const TEMPLATE = join(ROOT, 'examples', 'importable-packages', 'ck_example_i2c_sensor_v2');

function temporaryDirectory() {
  return mkdtempSync(join(tmpdir(), 'ckpkg-test-'));
}

function cli(args, options = {}) {
  return spawnSync(process.execPath, [CLI, ...args], {
    cwd: options.cwd ?? ROOT,
    encoding: 'utf8',
    maxBuffer: 8 * 1024 * 1024,
  });
}

function createFixture(root, id = 'vendor-sensor') {
  createPackage(id, { directory: root, templateRoot: TEMPLATE });
  return join(root, id);
}

test('help documents five commands, explicit compile profiles, and stable exit codes', () => {
  const result = cli(['--help']);
  assert.equal(result.status, EXIT.OK);
  for (const command of ['create', 'validate', 'test', 'compile', 'pack']) {
    assert.match(result.stdout, new RegExp(`ckpkg ${command}`));
  }
  assert.match(result.stdout, /Compile never uploads/);
  assert.match(result.stdout, /Exit codes: 0 passed; 1 validation\/test\/compile failed; 2 usage\/config error/);

  const version = cli(['--version', '--json']);
  assert.equal(version.status, EXIT.OK);
  assert.deepEqual(JSON.parse(version.stdout), {
    schema_version: 1,
    tool: 'ckpkg',
    tool_version: '1.0.0',
  });
  const mixedVersionCommand = cli(['validate', '--version', '--json']);
  assert.equal(mixedVersionCommand.status, EXIT.USAGE);
  assert.match(JSON.parse(mixedVersionCommand.stdout).errors[0], /does not accept a command/);

  const bad = cli(['unknown-command', '--json']);
  assert.equal(bad.status, EXIT.USAGE);
  const report = JSON.parse(bad.stdout);
  assert.equal(report.status, 'failed');
  assert.equal(report.exit_code, EXIT.USAGE);

  const unknownOption = cli(['validate', '.', '--upload', '--json']);
  assert.equal(unknownOption.status, EXIT.USAGE);
  assert.match(JSON.parse(unknownOption.stdout).errors[0], /unknown option.*--upload/);
});

test('create emits a valid v2 package with generator, tests, profiles, and recursive native sources', () => {
  const root = temporaryDirectory();
  try {
    const report = createPackage('acme-sensor', { directory: root, templateRoot: TEMPLATE });
    assert.equal(report.status, 'passed_with_warnings');
    assert.equal(report.package.id, 'acme-sensor');
    assert.match(report.package.content_sha256, /^[a-f0-9]{64}$/);
    assert.deepEqual(report.created.compile_profiles, ['esp32-c6', 'arduino-nano']);
    const packageRoot = join(root, 'acme-sensor');
    assert.equal(JSON.parse(readFileSync(join(packageRoot, 'ck-blocks.json'), 'utf8')).entrypoints.generator, 'generator/ck-generator.json');
    assert.match(
      JSON.parse(readFileSync(join(packageRoot, 'ckpkg.json'), 'utf8')).compile_profiles[0].fqbn,
      /^esp32:esp32:esp32c6:.*FlashSize=4M.*PartitionScheme=default|^esp32:esp32:esp32c6:.*PartitionScheme=default.*FlashSize=4M/,
    );
    const validation = validatePackage(packageRoot);
    assert.equal(validation.status, 'passed_with_warnings');
    assert.equal(validation.summary.arduino_layout, 'src-1.5');
    assert.equal(validation.summary.recursive_source_count, 3);
    assert.equal(validation.checks.find(check => check.id === 'ai-metadata').status, 'passed');
    assert.equal(validation.checks.find(check => check.id === 'compile-profile-contract').status, 'passed');
    const publicHeader = JSON.parse(readFileSync(join(packageRoot, 'library.json'), 'utf8')).includes[0];
    assert.match(publicHeader, /^ckp_acme_sensor_[a-f0-9]{12}_sensor\.h$/);
    assert.equal(existsSync(join(packageRoot, 'src', publicHeader)), true);
    assert.equal(readdirSync(join(packageRoot, 'src')).some(name => name.startsWith('CKExampleSensor')), false);
    const contract = testPackage(packageRoot);
    assert.equal(contract.status, 'passed_with_warnings');
    assert.equal(contract.test_summary.declared_checks, 4);
    assert.equal(contract.test_summary.compilation_performed, false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('create rejects unsafe identifiers and never overwrites an existing target', () => {
  const root = temporaryDirectory();
  try {
    assert.throws(() => createPackage('../escape', { directory: root, templateRoot: TEMPLATE }), /package-id/);
    assert.throws(() => createPackage('Uppercase-Package', { directory: root, templateRoot: TEMPLATE }), /canonical lowercase/);
    createFixture(root, 'occupied');
    assert.throws(() => createPackage('occupied', { directory: root, templateRoot: TEMPLATE }), /already exists/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('side-by-side package IDs that normalize to the same slug get distinct block and C symbol prefixes', () => {
  const root = temporaryDirectory();
  try {
    const packageIds = ['foo-bar', 'foo.bar', 'foo_bar'];
    const blockTypes = new Set();
    const cSymbols = new Set();
    const publicHeaders = new Set();
    const publicClasses = new Set();
    for (const packageId of packageIds) {
      const packageRoot = createFixture(root, packageId);
      const manifest = JSON.parse(readFileSync(join(packageRoot, 'ck-blocks.json'), 'utf8'));
      blockTypes.add(manifest.blocks[0].type);
      const library = JSON.parse(readFileSync(join(packageRoot, 'library.json'), 'utf8'));
      const publicHeader = library.includes[0];
      publicHeaders.add(publicHeader);
      const headerSource = readFileSync(join(packageRoot, 'src', publicHeader), 'utf8');
      const publicClass = /class\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\{/.exec(headerSource)?.[1];
      assert.ok(publicClass, `missing generated C++ class for ${packageId}`);
      publicClasses.add(publicClass);
      const mathSource = readdirSync(join(packageRoot, 'src')).find(name => name.endsWith('_sensor_math.c'));
      assert.ok(mathSource, `missing generated math source for ${packageId}`);
      const source = readFileSync(join(packageRoot, 'src', mathSource), 'utf8');
      const symbol = /float\s+([a-zA-Z_][a-zA-Z0-9_]*)\s*\(/.exec(source)?.[1];
      assert.ok(symbol, `missing generated C symbol for ${packageId}`);
      cSymbols.add(symbol);
    }
    assert.equal(blockTypes.size, packageIds.length);
    assert.equal(cSymbols.size, packageIds.length);
    assert.equal(publicHeaders.size, packageIds.length);
    assert.equal(publicClasses.size, packageIds.length);
    for (const type of blockTypes) assert.match(type, /^ckp_foo_bar_[a-f0-9]{12}_read_temperature_v2$/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('validate reuses board, block, and native package contracts', () => {
  const block = validatePackage(join(ROOT, 'examples', 'importable-packages', 'ck_example_i2c_sensor_v2'));
  assert.equal(block.status, 'passed');
  assert.equal(block.package.kind, 'block');
  assert.equal(block.checks.find(check => check.id === 'generator-contract').status, 'passed');

  const native = validatePackage(join(ROOT, 'examples', 'importable-packages', 'ck_example_native_deep'));
  assert.equal(native.status, 'passed');
  assert.equal(native.package.kind, 'native');
  assert.ok(native.summary.recursive_source_count >= 3);

  const board = validatePackage(join(ROOT, 'examples', 'importable-packages', 'ck_example_c6_board'));
  assert.notEqual(board.status, 'failed');
  assert.equal(board.package.kind, 'board');
  assert.equal(board.summary.hardware_variants, 3);
});

test('board packages fail unified LICENSE and unreferenced link preflight checks', t => {
  const root = temporaryDirectory();
  try {
    const boardRoot = join(root, 'ck_example_c6_board');
    cpSync(join(ROOT, 'examples', 'importable-packages', 'ck_example_c6_board'), boardRoot, { recursive: true });
    rmSync(join(boardRoot, 'LICENSE'));
    let result = validatePackage(boardRoot);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => error === 'LICENSE is required'));
    assert.equal(result.package.content_sha256, null);

    writeFileSync(join(boardRoot, 'LICENSE'), '');
    result = validatePackage(boardRoot);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => error === 'LICENSE must contain non-whitespace license text'));

    writeFileSync(join(boardRoot, 'LICENSE'), ' \r\n\t');
    result = validatePackage(boardRoot);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => error === 'LICENSE must contain non-whitespace license text'));

    writeFileSync(join(boardRoot, 'LICENSE'), 'test-only license text\n');
    const linkTarget = join(root, 'unused-target');
    mkdirSync(linkTarget);
    try {
      symlinkSync(linkTarget, join(boardRoot, 'unused-link'), process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.diagnostic(`link creation unavailable: ${error.message}`);
      return;
    }
    result = validatePackage(boardRoot);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => /symbolic links and junctions are forbidden/.test(error)));
    assert.equal(result.checks.find(check => check.id === 'package-path-size-integrity').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('test fails closed for a broken declarative generator and a failed declared check', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const generatorPath = join(packageRoot, 'generator', 'ck-generator.json');
    const generator = JSON.parse(readFileSync(generatorPath, 'utf8'));
    generator.rules[0].type = 'undefined_block';
    writeFileSync(generatorPath, `${JSON.stringify(generator, null, 2)}\n`);
    const brokenGenerator = testPackage(packageRoot);
    assert.equal(brokenGenerator.status, 'failed');
    assert.ok(brokenGenerator.errors.some(error => /undefined block|no ck-generator rule/.test(error)));

    rmSync(packageRoot, { recursive: true, force: true });
    const fresh = createFixture(root, 'declared-failure');
    const testPath = join(fresh, 'tests', 'ckpkg-tests.json');
    const manifest = JSON.parse(readFileSync(testPath, 'utf8'));
    manifest.checks[0].text = 'text-that-does-not-exist';
    writeFileSync(testPath, `${JSON.stringify(manifest, null, 2)}\n`);
    const declaredFailure = testPackage(fresh);
    assert.equal(declaredFailure.status, 'failed');
    assert.equal(declaredFailure.test_summary.declared_passed, 3);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compile rejects unknown aliases before transport and propagates real process failure', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    assert.throws(
      () => compilePackage(packageRoot, { profile: 'guessed-board' }),
      /unknown compile profile.*--fqbn/,
    );
    assert.throws(
      () => compilePackage(packageRoot, { profile: 'esp32-c6', fqbn: 'esp32:esp32:esp32c6' }),
      /do not override/,
    );
    const emptyConfig = join(root, 'arduino-cli.yaml');
    writeFileSync(emptyConfig, '{}\n');
    const result = compilePackage(packageRoot, {
      profile: 'esp32-c6',
      arduinoCli: process.execPath,
      config: emptyConfig,
      jobs: 1,
    });
    assert.equal(result.status, 'failed');
    assert.equal(result.compile.performed, true);
    assert.equal(result.compile.upload_performed, false);
    assert.notEqual(result.compile.exit_code, 0);
    assert.equal(result.checks.find(check => check.id === 'example-compile').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('default Arduino CLI resolution skips package-local executables while explicit paths remain untrusted', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const safeBin = join(root, 'safe-bin');
    mkdirSync(safeBin);
    const executableName = process.platform === 'win32' ? 'arduino-cli.exe' : 'arduino-cli';
    const malicious = join(packageRoot, executableName);
    const safe = join(safeBin, executableName);
    writeFileSync(malicious, 'package-local fake');
    writeFileSync(safe, 'external fake');
    const separator = process.platform === 'win32' ? ';' : ':';
    const resolved = resolveArduinoCli({
      packageRoot,
      repositoryRoot: null,
      environment: { PATH: `${packageRoot}${separator}${safeBin}` },
    });
    assert.equal(resolved.path, safe);
    assert.equal(resolved.source, 'path');
    assert.equal(resolved.trust, 'path-untrusted');

    const explicit = resolveArduinoCli({ explicit: malicious, packageRoot, repositoryRoot: null, environment: {} });
    assert.equal(explicit.path, malicious);
    assert.equal(explicit.source, 'explicit');
    assert.equal(explicit.trust, 'explicit-untrusted');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compile rejects a tool-success result when package content changes during the compile window', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    writeFileSync(
      join(packageRoot, 'compile'),
      "require('node:fs').appendFileSync('README.md', '\\nconcurrent mutation\\n');\n",
    );
    const result = compilePackage(packageRoot, {
      profile: 'esp32-c6',
      arduinoCli: process.execPath,
      jobs: 1,
    });
    assert.equal(result.compile.exit_code, 0);
    assert.equal(result.compile.package_content.stable, false);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => /changed during compile/.test(error)));
    assert.equal(result.checks.find(check => check.id === 'package-content-stable').status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('compile profile paths are package-relative and cannot escape', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const configPath = join(packageRoot, 'ckpkg.json');
    const config = JSON.parse(readFileSync(configPath, 'utf8'));
    config.compile_profiles[0].sketch = '../outside';
    writeFileSync(configPath, `${JSON.stringify(config, null, 2)}\n`);
    const result = testPackage(packageRoot);
    assert.equal(result.status, 'failed');
    assert.ok(result.errors.some(error => /sketch is not a safe package path/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('malformed ckpkg and declarative test manifests are check failures, not I/O crashes', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    writeFileSync(join(packageRoot, 'ckpkg.json'), '{broken-json');
    const badConfig = cli(['validate', packageRoot, '--json']);
    assert.equal(badConfig.status, EXIT.CHECK_FAILED);
    assert.match(JSON.parse(badConfig.stdout).errors[0], /ckpkg\.json is not valid readable JSON/);

    rmSync(packageRoot, { recursive: true, force: true });
    const fresh = createFixture(root, 'bad-tests');
    writeFileSync(join(fresh, 'tests', 'ckpkg-tests.json'), '{broken-json');
    const badTests = cli(['test', fresh, '--json']);
    assert.equal(badTests.status, EXIT.CHECK_FAILED);
    assert.match(JSON.parse(badTests.stdout).errors[0], /tests\/ckpkg-tests\.json is not valid readable JSON/);

    rmSync(fresh, { recursive: true, force: true });
    const badBlocks = createFixture(root, 'bad-blocks');
    writeFileSync(join(badBlocks, 'ck-blocks.json'), '{broken-json');
    const badBlockManifest = cli(['validate', badBlocks, '--json']);
    assert.equal(badBlockManifest.status, EXIT.CHECK_FAILED);
    assert.equal(JSON.parse(badBlockManifest.stdout).status, 'failed');
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pack is deterministic, rooted, validated, and does not include its output', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const firstBytes = buildDeterministicZip(packageRoot);
    const secondBytes = buildDeterministicZip(packageRoot);
    assert.deepEqual(firstBytes, secondBytes);
    assert.equal(firstBytes.readUInt32LE(0), 0x04034B50);
    assert.match(firstBytes.toString('utf8'), /vendor-sensor\/ck-blocks\.json/);
    assert.match(firstBytes.toString('utf8'), /vendor-sensor\/src\/internal\/ckp_vendor_sensor_[a-f0-9]{12}_sensor_codec\.c/);

    const output = join(root, 'vendor-sensor.zip');
    const report = packPackage(packageRoot, { output });
    assert.equal(report.status, 'passed_with_warnings');
    assert.equal(report.artifact.sha256.length, 64);
    assert.deepEqual(readFileSync(output), firstBytes);
    assert.throws(() => packPackage(packageRoot, { output }), /already exists/);
    assert.throws(() => packPackage(packageRoot, { output: join(packageRoot, 'bad.zip') }), /outside/);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('CLI writes the same structured report to --output and uses exit 1 for gate failures', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const output = join(root, 'report.json');
    const passed = cli(['validate', packageRoot, '--json', '--output', output]);
    assert.equal(passed.status, EXIT.OK);
    const passedReport = JSON.parse(passed.stdout);
    assert.equal(passedReport.exit_code, EXIT.OK);
    assert.equal(passedReport.package.root_name, 'vendor-sensor');
    assert.equal(ownPath(passedReport, 'root'), false);
    assert.equal(JSON.stringify(passedReport).includes(packageRoot), false);
    assert.deepEqual(passedReport, JSON.parse(readFileSync(output, 'utf8')));

    rmSync(join(packageRoot, 'LICENSE'));
    const failed = cli(['validate', packageRoot, '--json']);
    assert.equal(failed.status, EXIT.CHECK_FAILED);
    const report = JSON.parse(failed.stdout);
    assert.equal(report.status, 'failed');
    assert.ok(report.errors.some(error => /LICENSE is required/.test(error)));
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

function ownPath(report, key) {
  return Object.prototype.hasOwnProperty.call(report.package ?? {}, key);
}

test('report output inside the package or through an outside junction is rejected before writing', t => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const direct = cli(['validate', '.', '--json', '--output', 'report.json'], { cwd: packageRoot });
    assert.equal(direct.status, EXIT.USAGE);
    assert.match(JSON.parse(direct.stdout).errors[0], /--output must be outside/);
    assert.equal(existsSync(join(packageRoot, 'report.json')), false);

    const outsideReport = join(root, 'outside-report.json');
    writeFileSync(outsideReport, 'outside-original');
    let fileSymlinkCreated = false;
    try {
      symlinkSync(outsideReport, join(packageRoot, 'report.json'));
      fileSymlinkCreated = true;
    } catch (error) {
      t.diagnostic(`file symlink creation unavailable: ${error.message}`);
    }
    if (fileSymlinkCreated) {
      const throughFileSymlink = cli(['validate', '.', '--json', '--output', 'report.json'], { cwd: packageRoot });
      assert.equal(throughFileSymlink.status, EXIT.USAGE);
      assert.match(JSON.parse(throughFileSymlink.stdout).errors[0], /--output must be outside/);
      assert.equal(readFileSync(outsideReport, 'utf8'), 'outside-original');
      rmSync(join(packageRoot, 'report.json'));
    }

    const junction = join(root, 'package-junction');
    try {
      symlinkSync(packageRoot, junction, process.platform === 'win32' ? 'junction' : 'dir');
    } catch (error) {
      t.diagnostic(`junction creation unavailable: ${error.message}`);
      return;
    }
    const throughJunction = join(junction, 'junction-report.json');
    const linked = cli(['validate', packageRoot, '--json', '--output', throughJunction]);
    assert.equal(linked.status, EXIT.USAGE);
    assert.match(JSON.parse(linked.stdout).errors[0], /--output must be outside/);
    assert.equal(existsSync(join(packageRoot, 'junction-report.json')), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});

test('pack archive and machine report cannot target the same file', () => {
  const root = temporaryDirectory();
  try {
    const packageRoot = createFixture(root);
    const collision = join(root, 'collision.zip');
    const result = cli([
      'pack', packageRoot, '--out', collision, '--output', collision, '--json',
    ]);
    assert.equal(result.status, EXIT.USAGE);
    assert.match(JSON.parse(result.stdout).errors[0], /--out and report --output must be different/);
    assert.equal(existsSync(collision), false);
  } finally {
    rmSync(root, { recursive: true, force: true });
  }
});
