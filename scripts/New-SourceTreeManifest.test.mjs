import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    rm,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const scriptPath = new URL('./New-SourceTreeManifest.ps1', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';

function runManifest(root, mode, manifest, freeze) {
    return spawnSync(
        shell,
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-Mode',
            mode,
            '-Root',
            root,
            '-ManifestPath',
            manifest,
            '-FreezeRecordPath',
            freeze,
        ],
        { encoding: 'utf8' },
    );
}

async function makeFixture() {
    const root = await mkdtemp(join(tmpdir(), 'ck-source-tree-'));
    for (const directory of [
        '.cargo',
        'apps/desktop/src',
        'apps/desktop/src-tauri/bin',
        'apps/desktop/node_modules/dependency',
        'apps/desktop/dist/assets',
        'crates/ck_core/src',
        'docs',
        'examples/importable-packages/example/src/nested',
        'scripts',
        'tools',
        'target/release',
        'packages/esp32',
        'artifacts/release',
    ]) {
        await mkdir(join(root, directory), { recursive: true });
    }
    const files = new Map([
        ['.cargo/config.toml', '[build]\ntarget-dir = "target"\n'],
        ['apps/desktop/package.json', '{"name":"fixture"}\n'],
        ['apps/desktop/src/main.ts', 'export const fixture = true;\n'],
        ['apps/desktop/src-tauri/bin/arduino-cli.exe', 'arduino-cli-fixture'],
        ['apps/desktop/node_modules/dependency/index.js', 'excluded dependency'],
        ['apps/desktop/dist/assets/index.js', 'excluded build'],
        ['apps/desktop/local.tmp', 'excluded temporary file'],
        ['crates/ck_core/src/lib.rs', 'pub fn fixture() {}\n'],
        ['docs/readme.md', '# fixture\n'],
        ['examples/importable-packages/Build-Examples.ps1', '# build fixture\n'],
        ['examples/importable-packages/example/src/nested/device.c', 'void run(void) {}\n'],
        ['examples/importable-packages/example.zip', 'excluded generated archive'],
        ['scripts/gate.ps1', '# fixture gate\n'],
        ['Cargo.lock', '# lock\n'],
        ['Cargo.toml', '[workspace]\n'],
        ['README.md', '# CK fixture\n'],
        ['tools/ccache.exe', 'ccache-fixture'],
        ['target/release/app.exe', 'excluded target'],
        ['packages/esp32/tool.exe', 'excluded package cache'],
    ]);
    for (const [relativePath, contents] of files) {
        await writeFile(join(root, relativePath), contents);
    }
    return root;
}

test('no-Git source freeze is deterministic, independently reproducible and excludes mutable workspace data', async (t) => {
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const root = await makeFixture();
    t.after(async () => rm(root, { recursive: true, force: true }));
    const manifest = join(root, 'artifacts', 'release', 'source-tree-manifest.json');
    const freeze = join(root, 'artifacts', 'release', 'source-tree-freeze.json');
    const first = runManifest(root, 'Create', manifest, freeze);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);

    const manifestBytes = await readFile(manifest);
    const parsed = JSON.parse(manifestBytes.toString('utf8'));
    const freezeRecord = JSON.parse(await readFile(freeze, 'utf8'));
    const paths = parsed.files.map((file) => file.path);
    assert.deepEqual(paths, [...paths].sort(), 'relative paths must use stable ordinal order for this fixture');
    assert.ok(paths.includes('apps/desktop/src/main.ts'));
    assert.ok(paths.includes('apps/desktop/src-tauri/bin/arduino-cli.exe'));
    assert.ok(paths.includes('tools/ccache.exe'));
    assert.ok(paths.includes('examples/importable-packages/example/src/nested/device.c'));
    for (const excluded of [
        'apps/desktop/node_modules/dependency/index.js',
        'apps/desktop/dist/assets/index.js',
        'apps/desktop/local.tmp',
        'examples/importable-packages/example.zip',
        'target/release/app.exe',
        'packages/esp32/tool.exe',
    ]) {
        assert.ok(!paths.includes(excluded), `${excluded} must be excluded`);
    }
    assert.equal(parsed.source_control.kind, 'none');
    assert.equal(parsed.source_control.commit, null);
    assert.ok(!Object.hasOwn(parsed, 'frozen_at'), 'wall-clock time must not pollute deterministic manifest bytes');
    assert.match(freezeRecord.frozen_at, /^\d{4}-\d{2}-\d{2}T/);
    assert.equal(freezeRecord.source_control.commit, null);

    const independentRows = parsed.files
        .map((file) => `${file.path}\t${file.bytes}\t${file.sha256}\n`)
        .join('');
    const independentTreeHash = createHash('sha256').update(independentRows, 'utf8').digest('hex');
    const independentManifestHash = createHash('sha256').update(manifestBytes).digest('hex');
    assert.equal(parsed.tree_sha256, independentTreeHash);
    assert.equal(freezeRecord.tree_sha256, independentTreeHash);
    assert.equal(freezeRecord.manifest_sha256, independentManifestHash);

    const verify = runManifest(root, 'Verify', manifest, freeze);
    assert.equal(verify.status, 0, `${verify.stderr}\n${verify.stdout}`);

    await writeFile(join(root, 'target', 'release', 'later.exe'), 'new excluded output');
    const verifyAfterExcludedChange = runManifest(root, 'Verify', manifest, freeze);
    assert.equal(
        verifyAfterExcludedChange.status,
        0,
        `${verifyAfterExcludedChange.stderr}\n${verifyAfterExcludedChange.stdout}`,
    );

    await writeFile(join(root, 'apps', 'desktop', 'src', 'main.ts'), 'export const fixture = false;\n');
    const verifyAfterSourceChange = runManifest(root, 'Verify', manifest, freeze);
    assert.notEqual(verifyAfterSourceChange.status, 0, 'an included source change must invalidate the freeze');
    assert.match(`${verifyAfterSourceChange.stderr}\n${verifyAfterSourceChange.stdout}`, /changed=apps\/desktop\/src\/main\.ts/);
});

test('frozen_at is separate, so identical source produces byte-identical manifests', async (t) => {
    const root = await makeFixture();
    t.after(async () => rm(root, { recursive: true, force: true }));
    const manifestA = join(root, 'evidence-a', 'manifest.json');
    const freezeA = join(root, 'evidence-a', 'freeze.json');
    const manifestB = join(root, 'evidence-b', 'manifest.json');
    const freezeB = join(root, 'evidence-b', 'freeze.json');
    const first = runManifest(root, 'Create', manifestA, freezeA);
    assert.equal(first.status, 0, `${first.stderr}\n${first.stdout}`);
    await new Promise((resolve) => setTimeout(resolve, 20));
    const second = runManifest(root, 'Create', manifestB, freezeB);
    assert.equal(second.status, 0, `${second.stderr}\n${second.stdout}`);
    assert.deepEqual(await readFile(manifestA), await readFile(manifestB));
    const recordA = JSON.parse(await readFile(freezeA, 'utf8'));
    const recordB = JSON.parse(await readFile(freezeB, 'utf8'));
    assert.equal(recordA.manifest_sha256, recordB.manifest_sha256);
    assert.equal(recordA.tree_sha256, recordB.tree_sha256);
    assert.notEqual(recordA.manifest_path, recordB.manifest_path);
});

test('freeze outputs inside hashed roots and synthetic Git identities fail closed', async (t) => {
    const root = await makeFixture();
    t.after(async () => rm(root, { recursive: true, force: true }));
    const unsafeManifest = join(root, 'apps', 'desktop', 'source-tree-manifest.json');
    const unsafeFreeze = join(root, 'artifacts', 'release', 'freeze.json');
    const unsafe = runManifest(root, 'Create', unsafeManifest, unsafeFreeze);
    assert.notEqual(unsafe.status, 0);
    assert.match(`${unsafe.stderr}\n${unsafe.stdout}`, /must not be written inside a hashed source directory/);

    await mkdir(join(root, '.git'));
    const withGit = runManifest(
        root,
        'Create',
        join(root, 'artifacts', 'release', 'manifest.json'),
        join(root, 'artifacts', 'release', 'freeze.json'),
    );
    assert.notEqual(withGit.status, 0);
    assert.match(`${withGit.stderr}\n${withGit.stdout}`, /without Git metadata/);
});
