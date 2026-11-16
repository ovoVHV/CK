import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const [modal, workspace, backend, project, appBackend] = await Promise.all([
    readFile(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8'),
    readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/src/block_package_migration_tx.rs', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/src/project.rs', import.meta.url), 'utf8'),
    readFile(new URL('../../src-tauri/src/lib.rs', import.meta.url), 'utf8'),
]);

test('local block package imports use staged migration instead of immediate replacement', () => {
    assert.match(modal, /prepareBlockLibraryMigration\(\{[\s\S]*?projectPath/);
    assert.match(modal, /previewPreparedBlockLibraryMigration\(prepared, workspaceJson\)/);
    assert.match(modal, /formatBlockLibraryMigrationPreview\(preview\)/);
    assert.match(modal, /createBlockPackageMigrationCheckpoint\([\s\S]*?preview\.workspaceBeforeJson/);
    assert.match(modal, /commitPreparedBlockLibraryMigration\([\s\S]*?checkpointId/);
    assert.doesNotMatch(modal, /invoke\(['"]import_library['"]/);
});

test('Workspace supplies exact JSON or protected raw JSON and creates the required checkpoint', () => {
    assert.match(workspace, /loadedProjectWorkspaceFormatRef\.current !== 'json'/);
    assert.match(workspace, /unknownBlockProtection\.inspection\.rawWorkspace\.serialized/);
    assert.match(workspace, /reason:\s*'before_package_migration'/);
    assert.match(workspace, /currentWorkspaceJson !== exactWorkspaceJson/);
    assert.match(workspace, /readBlockPackageMigrationWorkspace=\{readBlockPackageMigrationWorkspace\}/);
    assert.match(workspace, /createBlockPackageMigrationCheckpoint=\{createBlockPackageMigrationCheckpoint\}/);
    assert.match(workspace, /onBlockPackageMigrationCommitted=\{handleBlockPackageMigrationCommitted\}/);
});

test('backend commit verifies checkpoint and CAS before switching package and project', () => {
    const checkpointIndex = backend.indexOf('verify_checkpoint(');
    const casIndex = backend.indexOf('Project changed on disk after migration preview');
    const committingIndex = backend.indexOf('write_state_marker(transaction_root, &metadata.token, "committing")');
    const packageRenameIndex = backend.indexOf('fs::rename(&stage, &target)');
    const projectRenameIndex = backend.indexOf('fs::rename(&project_temp, &project_path)');
    assert.ok(checkpointIndex >= 0);
    assert.ok(casIndex >= 0);
    assert.ok(committingIndex > checkpointIndex);
    assert.ok(packageRenameIndex > committingIndex);
    assert.ok(projectRenameIndex > packageRenameIndex);
    assert.match(backend, /rollback_incomplete_transaction\(transaction_root, ck_root, &metadata\)/);
    assert.match(backend, /CommitFailurePoint::AfterPackageActivation/);
});

test('normal single-file saves preserve migration and future project evidence', () => {
    assert.match(project, /Unknown fields are[\s\S]*?intentionally retained/);
    assert.match(project, /let mut json = migrate_project_document_v0_to_v1\(parsed\)\?/);
    assert.match(project, /let mut content = if let Some\(source\) = source\.as_deref\(\)/);
    assert.match(project, /read_editable_project_document\(source, "Source"\)\?/);
    assert.match(project, /single_file_save_preserves_block_package_migration_evidence/);
    assert.match(project, /saved\["ck_block_packages"\], evidence/);
});

test('missing source evidence is never guessed and safe saves record enabled inventory', () => {
    assert.match(backend, /BLOCK_PACKAGE_EVIDENCE_REQUIRED/);
    assert.doesNotMatch(backend, /project_record\.clone\(\)\.or_else/);
    assert.match(workspace, /enabledBlockPackageInventoryRef/);
    assert.match(workspace, /blockPackageInventory:\s*enabledBlockPackageInventoryRef\.current/);
    assert.match(workspace, /enabledRuntimeKeys/);
    assert.match(project, /validate_enabled_block_package_inventory/);
    assert.match(project, /enabled-declarative-runtime-packages/);
    assert.match(project, /runtime_quality_report_is_trusted_for_package/);
});

test('application startup recovers interrupted package migration transactions', () => {
    const loggerIndex = appBackend.indexOf('logging::init(app.handle().clone())');
    const recoveryIndex = appBackend.indexOf(
        'block_package_migration_tx::recover_block_package_migrations_on_startup',
    );
    const sysrootIndex = appBackend.indexOf('init_bundled_cli(app.handle())');
    assert.ok(loggerIndex >= 0);
    assert.ok(recoveryIndex > loggerIndex);
    assert.ok(sysrootIndex > recoveryIndex);
    assert.match(appBackend, /future migrations remain blocked/);
});
