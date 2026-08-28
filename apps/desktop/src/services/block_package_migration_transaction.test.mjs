import assert from 'node:assert/strict';
import { webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

if (!globalThis.crypto) Object.defineProperty(globalThis, 'crypto', { value: webcrypto });

const transpile = (source, fileName) => {
    const result = ts.transpileModule(source, {
        compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
        fileName,
        reportDiagnostics: true,
    });
    const errors = (result.diagnostics || []).filter(
        diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
    );
    assert.deepEqual(errors, [], `${fileName} should transpile without syntax errors`);
    return result.outputText;
};

const engineSource = await readFile(new URL('./block_package_migrations.ts', import.meta.url), 'utf8');
const engine = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(engineSource, 'block_package_migrations.ts')).toString('base64')}`
);
globalThis.__ckBlockMigrationDomain = engine;

const sourcePath = new URL('./block_package_migration_transaction.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
let testableSource = source.replace(
    "import { invoke } from '@tauri-apps/api/core';",
    'const invoke = (...args: unknown[]) => (globalThis as any).__ckBlockMigrationInvoke(...args);',
);
testableSource = testableSource.replace(
    /import \{[\s\S]*?\} from '\.\/block_package_migrations';/,
    'const { planBlockPackageMigration } = (globalThis as any).__ckBlockMigrationDomain;',
);
assert.notEqual(testableSource, source, 'native and migration imports must be replaced for Node tests');

const calls = [];
let responder = async () => undefined;
globalThis.__ckBlockMigrationInvoke = async (command, args) => {
    calls.push([command, args]);
    return responder(command, args);
};
const transaction = await import(
    `data:text/javascript;base64,${Buffer.from(transpile(testableSource, 'block_package_migration_transaction.ts')).toString('base64')}`
);

const {
    PreparedBlockLibraryMigrationBlockedError,
    cancelPreparedBlockLibraryMigration,
    commitPreparedBlockLibraryMigration,
    formatBlockLibraryMigrationPreview,
    prepareBlockLibraryMigration,
    previewPreparedBlockLibraryMigration,
} = transaction;

const H = {
    old: '1'.repeat(64),
    next: '2'.repeat(64),
    manifest: '3'.repeat(64),
    project: '4'.repeat(64),
};

const manifest = {
    schema_version: 1,
    package_id: 'vendor_sensor',
    migrations: [{
        id: 'v1-to-v2',
        from: '>=1.0.0 <2.0.0',
        to: '2.0.0',
        operations: [
            { op: 'renameBlockType', from: 'vendor_sensor_read', to: 'vendor_sensor_read_v2' },
            { op: 'renameField', block_type: 'vendor_sensor_read_v2', from: 'ADDRESS', to: 'I2C_ADDRESS' },
            {
                op: 'mapEnum',
                block_type: 'vendor_sensor_read_v2',
                field: 'I2C_ADDRESS',
                mappings: [{ from: '72', to: '0x48' }],
            },
        ],
    }],
};

const prepared = (overrides = {}) => ({
    schemaVersion: 1,
    token: 'a'.repeat(32),
    operation: 'upgrade',
    packageId: 'vendor_sensor',
    packageName: 'Vendor Sensor',
    installedFromVersion: '1.0.0',
    installedFromContentSha256: H.old,
    projectFromVersion: '1.0.0',
    projectFromContentSha256: H.old,
    toVersion: '2.0.0',
    toContentSha256: H.next,
    migrationManifest: manifest,
    migrationManifestSha256: H.manifest,
    projectPath: 'C:/Projects/demo.maker',
    projectDiskSha256: H.project,
    requiresProjectMigration: true,
    expiresAt: new Date(Date.now() + 60_000).toISOString(),
    ...overrides,
});

const workspace = (address = '72') => JSON.stringify({
    blocks: {
        blocks: [{
            type: 'vendor_sensor_read',
            id: 'root',
            fields: { ADDRESS: address },
            extraState: {
                originalSubtree: {
                    type: 'vendor_sensor_read',
                    fields: { ADDRESS: '72' },
                },
            },
        }],
    },
});

test('prepare uses a staging command and validates package/project evidence', async () => {
    calls.length = 0;
    responder = async command => {
        assert.equal(command, 'prepare_block_library_migration');
        return prepared();
    };
    const result = await prepareBlockLibraryMigration({
        path: ' C:/Packages/vendor.zip ',
        board: ' arduino:avr:uno ',
        boardPackageId: ' arduino:avr:uno ',
        projectPath: ' C:/Projects/demo.maker ',
    });
    assert.equal(result.packageId, 'vendor_sensor');
    assert.deepEqual(calls[0], [
        'prepare_block_library_migration',
        {
            input: {
                path: 'C:/Packages/vendor.zip',
                board: 'arduino:avr:uno',
                boardPackageId: 'arduino:avr:uno',
                projectPath: 'C:/Projects/demo.maker',
            },
        },
    ]);
});

test('missing project package evidence produces an actionable fail-closed message', async () => {
    calls.length = 0;
    responder = async () => {
        throw 'BLOCK_PACKAGE_EVIDENCE_REQUIRED: no source evidence';
    };
    await assert.rejects(
        () => prepareBlockLibraryMigration({
            path: 'C:/Packages/vendor.zip',
            board: 'arduino:avr:uno',
            projectPath: 'C:/Projects/demo.maker',
        }),
        error => {
            assert.match(String(error?.message || error), /完整打开工程并保存一次/);
            assert.match(String(error?.message || error), /不能强行覆盖/);
            return true;
        },
    );
});

test('dry-run migrates only Blockly block nodes and preserves opaque extraState', async () => {
    const before = workspace();
    const preview = await previewPreparedBlockLibraryMigration(prepared(), before);
    assert.equal(preview.plan.canApply, true);
    assert.equal(preview.plan.changedBlockCount, 1);
    assert.deepEqual(preview.plan.path.map(step => step.id), ['v1-to-v2']);
    const after = JSON.parse(preview.workspaceAfterJson);
    assert.equal(after.blocks.blocks[0].type, 'vendor_sensor_read_v2');
    assert.deepEqual(after.blocks.blocks[0].fields, { I2C_ADDRESS: '0x48' });
    assert.deepEqual(after.blocks.blocks[0].extraState, {
        originalSubtree: {
            type: 'vendor_sensor_read',
            fields: { ADDRESS: '72' },
        },
    });
    assert.equal(preview.workspaceBeforeJson, before);
    assert.match(preview.workspaceBeforeSha256, /^[a-f0-9]{64}$/);
    assert.match(preview.workspaceAfterSha256, /^[a-f0-9]{64}$/);
    assert.notEqual(preview.workspaceBeforeSha256, preview.workspaceAfterSha256);
});

test('uncovered enum values block preview and never produce commit data', async () => {
    await assert.rejects(
        previewPreparedBlockLibraryMigration(prepared(), workspace('uncovered')),
        error => {
            assert.equal(error instanceof PreparedBlockLibraryMigrationBlockedError, true);
            assert.equal(error.plan.canApply, false);
            assert.equal(error.plan.unresolved.some(issue => issue.code === 'ENUM_VALUE_UNMAPPED'), true);
            return true;
        },
    );
});

test('commit binds the exact preview, checkpoint and ordered migration steps', async () => {
    calls.length = 0;
    const current = prepared();
    const preview = await previewPreparedBlockLibraryMigration(current, workspace());
    responder = async command => {
        assert.equal(command, 'commit_prepared_block_library_migration');
        return {
            status: 'committed',
            packageId: current.packageId,
            packageVersion: current.toVersion,
            packageContentSha256: current.toContentSha256,
            packageActivated: true,
            projectMigrated: true,
            projectDiskSha256: '5'.repeat(64),
        };
    };
    const result = await commitPreparedBlockLibraryMigration(
        current,
        preview,
        'checkpoint-before-migration',
    );
    assert.equal(result.projectMigrated, true);
    const payload = calls[0][1].input;
    assert.equal(payload.token, current.token);
    assert.equal(payload.project.workspaceBeforeJson, preview.workspaceBeforeJson);
    assert.equal(payload.project.workspaceAfterJson, preview.workspaceAfterJson);
    assert.equal(payload.project.checkpointId, 'checkpoint-before-migration');
    assert.deepEqual(payload.project.stepIds, ['v1-to-v2']);
});

test('migration commit refuses missing preview or checkpoint before native invocation', async () => {
    calls.length = 0;
    const current = prepared();
    const preview = await previewPreparedBlockLibraryMigration(current, workspace());
    await assert.rejects(commitPreparedBlockLibraryMigration(current), /dry-run 预览/);
    await assert.rejects(
        commitPreparedBlockLibraryMigration(current, preview),
        /迁移前检查点不能为空/,
    );
    assert.equal(calls.length, 0);
});

test('new installs commit without project mutation or checkpoint', async () => {
    calls.length = 0;
    const current = prepared({
        operation: 'new-install',
        installedFromVersion: null,
        installedFromContentSha256: null,
        projectFromVersion: null,
        projectFromContentSha256: null,
        migrationManifest: null,
        migrationManifestSha256: null,
        requiresProjectMigration: false,
    });
    responder = async () => ({
        status: 'committed',
        packageId: current.packageId,
        packageVersion: current.toVersion,
        packageContentSha256: current.toContentSha256,
        packageActivated: true,
        projectMigrated: false,
        projectDiskSha256: null,
    });
    await commitPreparedBlockLibraryMigration(current);
    assert.equal(calls[0][1].input.project, null);
});

test('preview summary exposes version, hashes, steps and affected blocks', async () => {
    const preview = await previewPreparedBlockLibraryMigration(prepared(), workspace());
    const summary = formatBlockLibraryMigrationPreview(preview);
    assert.match(summary, /1\.0\.0 → 2\.0\.0/);
    assert.match(summary, /v1-to-v2/);
    assert.match(summary, /受影响积木：1 个/);
    assert.match(summary, /root: vendor_sensor_read → vendor_sensor_read_v2/);
    assert.match(summary, /先保存完整检查点/);
});

test('cancel uses only the prepared transaction token', async () => {
    calls.length = 0;
    responder = async () => undefined;
    await cancelPreparedBlockLibraryMigration('b'.repeat(32));
    assert.deepEqual(calls, [[
        'cancel_prepared_block_library_migration',
        { token: 'b'.repeat(32) },
    ]]);
});
