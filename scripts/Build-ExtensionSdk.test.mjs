import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import {
  mkdirSync,
  mkdtempSync,
  readFileSync,
  readdirSync,
  rmSync,
  statSync,
  writeFileSync,
} from 'node:fs';
import { tmpdir } from 'node:os';
import { dirname, join, relative, resolve, sep } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';
import { buildDeterministicZip } from './ckpkg.mjs';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const BUILD_SCRIPT = join(ROOT, 'scripts', 'Build-ExtensionSdk.ps1');
const VERIFY_SCRIPT = join(ROOT, 'scripts', 'Verify-ExtensionSdk.ps1');
const VERSION = '1.0.0';
const ROOT_NAME = `CK-Extension-SDK-${VERSION}`;

const sha256 = buffer => createHash('sha256').update(buffer).digest('hex');
const slash = value => value.split(sep).join('/');
const psQuote = value => `'${String(value).replaceAll("'", "''")}'`;

function runPowerShell(args, label) {
  const result = spawnSync(
    'powershell',
    ['-NoProfile', '-ExecutionPolicy', 'Bypass', ...args],
    { cwd: ROOT, encoding: 'utf8', maxBuffer: 32 * 1024 * 1024 },
  );
  assert.equal(
    result.status,
    0,
    `${label} failed\nstdout:\n${result.stdout}\nstderr:\n${result.stderr}`,
  );
  return result;
}

function listFiles(root) {
  const files = [];
  const visit = directory => {
    for (const entry of readdirSync(directory, { withFileTypes: true })) {
      const fullPath = join(directory, entry.name);
      if (entry.isDirectory()) visit(fullPath);
      else if (entry.isFile()) files.push(slash(relative(root, fullPath)));
      else assert.fail(`unexpected extracted SDK entry: ${fullPath}`);
    }
  };
  visit(root);
  return files.sort((left, right) => (left < right ? -1 : left > right ? 1 : 0));
}

test('extension SDK is allowlisted, self-verifying, and byte reproducible', { timeout: 120_000 }, () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ck-extension-sdk-test-'));
  try {
    const firstDirectory = join(temporaryRoot, 'first');
    const secondDirectory = join(temporaryRoot, 'second');
    mkdirSync(firstDirectory);
    mkdirSync(secondDirectory);
    const firstArchive = join(firstDirectory, `${ROOT_NAME}.zip`);
    const secondArchive = join(secondDirectory, `${ROOT_NAME}.zip`);
    const first = runPowerShell(
      ['-File', BUILD_SCRIPT, '-Root', ROOT, '-Version', VERSION, '-OutputPath', firstArchive],
      'first SDK build',
    );
    const second = runPowerShell(
      ['-File', BUILD_SCRIPT, '-Root', ROOT, '-Version', VERSION, '-OutputPath', secondArchive],
      'second SDK build',
    );
    assert.match(first.stdout, /two independent builds are byte-identical/);
    assert.match(second.stdout, /two independent builds are byte-identical/);

    const firstRelease = JSON.parse(readFileSync(join(firstDirectory, `${ROOT_NAME}.release.json`), 'utf8'));
    const secondRelease = JSON.parse(readFileSync(join(secondDirectory, `${ROOT_NAME}.release.json`), 'utf8'));
    assert.equal(firstRelease.schema_version, 1);
    assert.equal(firstRelease.channel, 'stable');
    assert.equal(firstRelease.sdk_version, VERSION);
    assert.equal(firstRelease.license, 'Apache-2.0');
    assert.equal(firstRelease.artifact_file, `${ROOT_NAME}.zip`);
    assert.equal(firstRelease.public_url, null);
    assert.equal(firstRelease.publication_status, 'local-artifact-ready');
    assert.equal(secondRelease.artifact_file, `${ROOT_NAME}.zip`);

    const firstBytes = readFileSync(firstArchive);
    const secondBytes = readFileSync(secondArchive);
    assert.deepEqual(firstBytes, secondBytes, 'independent SDK invocations must match byte-for-byte');
    assert.equal(sha256(firstBytes), sha256(secondBytes));

    runPowerShell(
      ['-File', VERIFY_SCRIPT, '-ArchivePath', firstArchive],
      'SDK archive verifier',
    );

    const extractionRoot = join(temporaryRoot, 'extracted');
    runPowerShell(
      [
        '-Command',
        `Expand-Archive -LiteralPath ${psQuote(firstArchive)} -DestinationPath ${psQuote(extractionRoot)}`,
      ],
      'SDK extraction',
    );
    const sdkRoot = join(extractionRoot, ROOT_NAME);
    assert.equal(statSync(sdkRoot).isDirectory(), true);

    const files = listFiles(sdkRoot);
    assert.ok(files.includes('manifest.json'));
    const manifest = JSON.parse(readFileSync(join(sdkRoot, 'manifest.json'), 'utf8').replace(/^\uFEFF/, ''));
    assert.equal(manifest.schema_version, 1);
    assert.equal(manifest.sdk_version, VERSION);
    assert.equal(manifest.archive_root, ROOT_NAME);
    assert.equal(manifest.manifest_scope, 'all archive files except manifest.json');
    assert.equal(manifest.reproducible_timestamp, '1980-01-01T00:00:00Z');
    assert.ok(manifest.certification_boundary.some(value => /not CK official certification/.test(value)));
    assert.ok(manifest.certification_boundary.some(value => /not a legal compatibility opinion/.test(value)));
    assert.ok(manifest.certification_boundary.some(value => /licensed under Apache-2\.0/.test(value)));

    const payloadPaths = files.filter(path => path !== 'manifest.json');
    const manifestPaths = manifest.files.map(file => file.path);
    assert.deepEqual(manifestPaths, [...manifestPaths].sort());
    assert.deepEqual(manifestPaths, payloadPaths);
    for (const file of manifest.files) {
      const bytes = readFileSync(join(sdkRoot, ...file.path.split('/')));
      assert.equal(file.bytes, bytes.length, `size mismatch for ${file.path}`);
      assert.equal(file.sha256, sha256(bytes), `SHA-256 mismatch for ${file.path}`);
    }

    const required = [
      'README.md',
      'LICENSE',
      'NOTICE',
      'release-channel.json',
      'package.json',
      'docs/blockly-library-package-standard.md',
      'docs/block-package-migration-v1.md',
      'docs/ckpkg.md',
      'docs/sensor-library-tutorial.md',
      'docs/package-quality-gates.md',
      'docs/third-party-board-passport.md',
      'docs/schemas/ck-board.schema.json',
      'docs/schemas/ck-board-lock.schema.json',
      'docs/schemas/ck-extension-sdk-release-artifact.schema.json',
      'docs/schemas/ck-extension-sdk-release-channel.schema.json',
      'docs/schemas/ck-library.schema.json',
      'docs/schemas/ck-blocks.schema.json',
      'docs/schemas/ck-blocks-v2.schema.json',
      'docs/schemas/ck-generator.schema.json',
      'docs/schemas/ck-migrations.schema.json',
      'docs/schemas/ck-package-quality-report.schema.json',
      'scripts/Validate-BoardPackage.mjs',
      'scripts/JsonSchemaValidator.mjs',
      'scripts/Validate-ImportablePackage.mjs',
      'scripts/Validate-PackageSchemas.test.mjs',
      'scripts/Verify-ExtensionSdk.ps1',
      'scripts/ckpkg.mjs',
      'scripts/ckpkg.test.mjs',
      'ci/github-actions-ckpkg.yml',
      'ci/github-actions-ckpkg-trusted.yml',
      'examples/importable-packages/Build-Examples.ps1',
    ];
    for (const name of [
      'ck_example_nano_board',
      'ck_example_c6_board',
      'ck_example_serial_blocks',
      'ck_example_i2c_sensor_v2',
      'ck_example_native_deep',
    ]) {
      required.push(`examples/importable-packages/${name}/README.md`);
      required.push(`examples/importable-packages/${name}.zip`);
    }
    for (const requiredPath of required) {
      assert.ok(files.includes(requiredPath), `missing SDK asset: ${requiredPath}`);
    }

    for (const path of files) {
      assert.doesNotMatch(path, /(^|\/)(?:\.git|node_modules|target|cache|tmp|temp|out|dist)(?:\/|$)/i);
      assert.doesNotMatch(path, /(^|\/)scripts\/fixtures(?:\/|$)/i);
      assert.doesNotMatch(path, /(?:negative|malicious)[_-]fixtures?/i);
      assert.doesNotMatch(path, /(?:^|\/)(?:\.ck-quality-report\.json|\.ck-install(?:ed)?\.json)$/i);
      assert.doesNotMatch(path, /\.(?:tmp|log|bak|swp|pyc)$/i);
    }

    const readme = readFileSync(join(sdkRoot, 'README.md'), 'utf8');
    assert.match(readme, /不是 CK 官方认证、发布者签名或真板验证/);
    assert.match(readme, /不会替作者作出法律意义上的许可证兼容结论/);
    assert.match(readme, /SDK 聚合包以 Apache License 2\.0 发布/);
    assert.match(readme, /public_url` 保持 `null`/);
    assert.match(readme, /\]\(docs\/ckpkg\.md\)/);
    assert.match(readme, /\]\(docs\/sensor-library-tutorial\.md\)/);
    assert.doesNotMatch(readme, /\]\(ckpkg\.md\)/);
    assert.doesNotMatch(readme, /\]\(sensor-library-tutorial\.md\)/);
    assert.match(readme, /旧 `blocks\.js` \/ `generator\.js` 不会进入主 WebView 执行/);
    assert.match(readme, /src\/vendor\/chip\/xxx\.cpp/);
    assert.match(readme, /ckpkg create my-sensor/);

    const ckpkgDoc = readFileSync(join(sdkRoot, 'docs', 'ckpkg.md'), 'utf8');
    assert.match(ckpkgDoc, /Compile never uploads|不会上传/);
    assert.match(ckpkgDoc, /未知别名直接退出 `2`/);
    assert.match(ckpkgDoc, /src\/vendor\/chip\/foo\.cpp/);

    const tutorial = readFileSync(join(sdkRoot, 'docs', 'sensor-library-tutorial.md'), 'utf8');
    assert.match(tutorial, /ckpkg create my-i2c-sensor/);
    assert.match(tutorial, /八类机器语义/);
    assert.match(tutorial, /compile-only/);

    const releaseChannel = JSON.parse(readFileSync(join(sdkRoot, 'release-channel.json'), 'utf8'));
    assert.equal(releaseChannel.sdk_version, VERSION);
    assert.equal(releaseChannel.license, 'Apache-2.0');
    assert.equal(releaseChannel.public_url, null);
    assert.equal(releaseChannel.integrity_metadata_file, `${ROOT_NAME}.release.json`);

    const ckpkgRegression = spawnSync(
      process.execPath,
      ['--test', join(sdkRoot, 'scripts', 'ckpkg.test.mjs')],
      { cwd: sdkRoot, encoding: 'utf8', maxBuffer: 16 * 1024 * 1024 },
    );
    assert.equal(
      ckpkgRegression.status,
      0,
      `SDK-contained ckpkg regression failed\nstdout:\n${ckpkgRegression.stdout}\nstderr:\n${ckpkgRegression.stderr}`,
    );

    const packageJson = JSON.parse(readFileSync(join(sdkRoot, 'package.json'), 'utf8'));
    assert.equal(packageJson.version, VERSION);
    assert.equal(packageJson.license, 'Apache-2.0');
    assert.equal(packageJson.bin.ckpkg, 'scripts/ckpkg.mjs');
    assert.equal(packageJson.engines.node, '>=20');
    const ciWorkflow = readFileSync(join(sdkRoot, 'ci', 'github-actions-ckpkg.yml'), 'utf8');
    assert.match(ciWorkflow, /version: '1\.4\.1'/);
    assert.match(ciWorkflow, /core install esp32:esp32@3\.3\.6/);
    assert.match(ciWorkflow, /LOCAL DEVELOPMENT ONLY/);
    assert.match(ciWorkflow, /not CK certification/);
    const trustedCi = readFileSync(join(sdkRoot, 'ci', 'github-actions-ckpkg-trusted.yml'), 'utf8');
    assert.match(trustedCi, /CK_TRUSTED_SDK_URL/);
    assert.match(trustedCi, /CK_TRUSTED_SDK_SHA256/);
    assert.match(trustedCi, /Trusted SDK SHA-256 mismatch/);
    assert.match(trustedCi, /must have exactly one root directory/);
    assert.doesNotMatch(trustedCi, /npm install --global \$env:CK_SDK/);

    const npmConsumer = join(temporaryRoot, 'npm-consumer');
    const npmInstall = spawnSync(
      process.platform === 'win32' ? 'npm.cmd' : 'npm',
      ['install', '--prefix', npmConsumer, '--ignore-scripts', sdkRoot],
      { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 8 * 1024 * 1024 },
    );
    assert.equal(
      npmInstall.status,
      0,
      `SDK npm bin install failed\nstdout:\n${npmInstall.stdout}\nstderr:\n${npmInstall.stderr}`,
    );
    const installedBin = process.platform === 'win32'
      ? join(npmConsumer, 'node_modules', '.bin', 'ckpkg.cmd')
      : join(npmConsumer, 'node_modules', '.bin', 'ckpkg');
    const installedHelp = spawnSync(
      installedBin,
      ['--help'],
      { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(
      installedHelp.status,
      0,
      `installed ckpkg bin failed\nstdout:\n${installedHelp.stdout}\nstderr:\n${installedHelp.stderr}`,
    );
    assert.match(installedHelp.stdout, /CK package developer CLI 1\.0\.0/);
    const installedVersion = spawnSync(
      installedBin,
      ['--version', '--json'],
      { encoding: 'utf8', shell: process.platform === 'win32', maxBuffer: 2 * 1024 * 1024 },
    );
    assert.equal(
      installedVersion.status,
      0,
      `installed ckpkg version failed\nstdout:\n${installedVersion.stdout}\nstderr:\n${installedVersion.stderr}`,
    );
    assert.deepEqual(JSON.parse(installedVersion.stdout), {
      schema_version: 1,
      tool: 'ckpkg',
      tool_version: VERSION,
    });

    const mismatchedPackageJson = { ...packageJson, version: '1.0.1' };
    writeFileSync(
      join(sdkRoot, 'package.json'),
      `${JSON.stringify(mismatchedPackageJson, null, 2)}\n`,
      'utf8',
    );
    const mismatchedArchive = join(temporaryRoot, 'mismatched-internal-version.zip');
    writeFileSync(mismatchedArchive, buildDeterministicZip(sdkRoot));
    const rejected = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        VERIFY_SCRIPT,
        '-ArchivePath',
        mismatchedArchive,
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.notEqual(rejected.status, 0);
    assert.match(`${rejected.stdout}\n${rejected.stderr}`, /version mismatch: root=1\.0\.0 package\.json=1\.0\.1/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('extension SDK build refuses a requested version that differs from embedded tools', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ck-extension-sdk-version-test-'));
  try {
    const output = join(temporaryRoot, 'mislabeled.zip');
    const result = spawnSync(
      'powershell',
      [
        '-NoProfile',
        '-ExecutionPolicy',
        'Bypass',
        '-File',
        BUILD_SCRIPT,
        '-Root',
        ROOT,
        '-Version',
        '1.0.1',
        '-OutputPath',
        output,
      ],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.notEqual(result.status, 0);
    assert.match(`${result.stdout}\n${result.stderr}`, /does not match embedded tool version/);
    assert.equal(statSafe(output), null);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

test('extension SDK verifier rejects symlink metadata and oversized entries before reading payloads', () => {
  const temporaryRoot = mkdtempSync(join(tmpdir(), 'ck-extension-sdk-malicious-test-'));
  try {
    const sdkRoot = join(temporaryRoot, ROOT_NAME);
    mkdirSync(sdkRoot);
    writeFileSync(join(sdkRoot, 'README.md'), 'fixture\n', 'utf8');
    const clean = buildDeterministicZip(sdkRoot);
    const centralOffset = clean.indexOf(Buffer.from([0x50, 0x4b, 0x01, 0x02]));
    assert.ok(centralOffset >= 0, 'fixture must contain a central directory entry');

    const symlink = Buffer.from(clean);
    symlink.writeUInt32LE(0xa0000000, centralOffset + 38);
    const symlinkArchive = join(temporaryRoot, 'symlink.zip');
    writeFileSync(symlinkArchive, symlink);
    const symlinkResult = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VERIFY_SCRIPT, '-ArchivePath', symlinkArchive],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.notEqual(symlinkResult.status, 0);
    assert.match(`${symlinkResult.stdout}\n${symlinkResult.stderr}`, /must not contain symbolic links/);

    const oversized = Buffer.from(clean);
    oversized.writeUInt32LE(33 * 1024 * 1024, centralOffset + 24);
    const oversizedArchive = join(temporaryRoot, 'oversized.zip');
    writeFileSync(oversizedArchive, oversized);
    const oversizedResult = spawnSync(
      'powershell',
      ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', VERIFY_SCRIPT, '-ArchivePath', oversizedArchive],
      { cwd: ROOT, encoding: 'utf8', maxBuffer: 4 * 1024 * 1024 },
    );
    assert.notEqual(oversizedResult.status, 0);
    assert.match(`${oversizedResult.stdout}\n${oversizedResult.stderr}`, /entry exceeds/);
  } finally {
    rmSync(temporaryRoot, { recursive: true, force: true });
  }
});

function statSafe(path) {
  try { return statSync(path); } catch { return null; }
}
