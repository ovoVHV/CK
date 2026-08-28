import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const modalSource = await readFile(new URL('./ProjectCheckpointsModal.tsx', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('checkpoint modal can save the current complete workspace on demand', () => {
    assert.match(modalSource, /onCreate:\s*\(\) => Promise<void> \| void/);

    const handlerStart = modalSource.indexOf('const createManualCheckpoint = async () => {');
    const handlerEnd = modalSource.indexOf('const remove = async', handlerStart);
    assert.ok(handlerStart >= 0 && handlerEnd > handlerStart);
    const handler = modalSource.slice(handlerStart, handlerEnd);
    assert.match(handler, /if \(hasActiveOperation \|\| !isNativeCheckpointStorageAvailable\(\)\) return/);
    assert.match(handler, /await onCreate\(\)/);
    assert.match(handler, /await refresh\(\)/);
    assert.match(handler, /保存检查点失败/);

    const buttonStart = modalSource.indexOf('data-ck-role="create-manual-checkpoint"');
    const buttonEnd = modalSource.indexOf('</button>', buttonStart);
    assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
    const button = modalSource.slice(buttonStart, buttonEnd);
    assert.match(button, /保存当前状态/);
    assert.match(button, /disabled=\{hasActiveOperation \|\| !nativeAvailable\}/);
    assert.match(button, /立即保存当前积木、源码、板卡和完整配置/);
    assert.match(button, /w-full/);
    assert.match(button, /min-\[520px\]:w-auto/);

    const actionRowStart = modalSource.lastIndexOf('<div className=', buttonStart);
    const actionRow = modalSource.slice(actionRowStart, buttonStart);
    assert.match(actionRow, /flex-col/);
    assert.match(actionRow, /min-\[520px\]:flex-row/);
    assert.match(actionRow, /min-\[520px\]:items-center/);
});

test('manual checkpoint creation locks every modal dismissal path and reports failures', () => {
    assert.match(modalSource, /if \(event\.key === 'Escape' && !hasActiveOperation\) onClose\(\)/);
    assert.match(
        modalSource,
        /event\.target === event\.currentTarget && !hasActiveOperation\) onClose\(\)/,
    );
    assert.match(
        modalSource,
        /onClick=\{onClose\}[\s\S]{0,180}disabled=\{hasActiveOperation\}/,
    );

    const handlerStart = modalSource.indexOf('const createManualCheckpoint = async () => {');
    const handlerEnd = modalSource.indexOf('const remove = async', handlerStart);
    const handler = modalSource.slice(handlerStart, handlerEnd);
    assert.match(handler, /setCreating\(true\)/);
    assert.match(handler, /catch \(cause\)/);
    assert.match(handler, /setError\(`保存检查点失败：\$\{String\(cause\)\}`\)/);
    assert.match(handler, /finally \{[\s\S]*?setCreating\(false\)/);
});

test('checkpoint modal remains bounded and keyboard-readable at the desktop minimum window', () => {
    assert.match(modalSource, /role="dialog"/);
    assert.match(modalSource, /aria-modal="true"/);
    assert.match(modalSource, /aria-labelledby="project-checkpoints-title"/);
    assert.match(modalSource, /max-h-\[min\(720px,calc\(100vh-32px\)\)\]/);
    assert.match(modalSource, /w-full max-w-2xl/);
    assert.match(modalSource, /min-h-0 flex-1 overflow-y-auto/);
    assert.match(modalSource, /aria-label="关闭工程检查点"/);
});

test('checkpoint deletion is explicit, confirmed, and serialized with other modal operations', () => {
    assert.match(modalSource, /deleteProjectCheckpoint/);
    assert.match(
        modalSource,
        /const hasActiveOperation = loading \|\| creating \|\| Boolean\(restoringId\) \|\| Boolean\(deletingId\)/,
    );

    const removeStart = modalSource.indexOf('const remove = async');
    const removeEnd = modalSource.indexOf('const nativeAvailable', removeStart);
    assert.ok(removeStart >= 0 && removeEnd > removeStart);
    const remove = modalSource.slice(removeStart, removeEnd);
    assert.match(remove, /if \(hasActiveOperation \|\| !isNativeCheckpointStorageAvailable\(\)\) return/);
    assert.match(remove, /title: '删除这个工程检查点？'/);
    assert.match(remove, /删除后无法恢复，但不会修改当前工作区、源码或已烧录固件/);
    assert.match(remove, /tone: 'danger'/);
    assert.match(remove, /await deleteProjectCheckpoint\(projectPath, metadata\.id\)/);
    assert.match(remove, /await refresh\(\)/);

    const deleteStart = modalSource.indexOf('data-ck-role="delete-project-checkpoint"');
    const deleteEnd = modalSource.indexOf('</button>', deleteStart);
    assert.ok(deleteStart >= 0 && deleteEnd > deleteStart);
    const deleteButton = modalSource.slice(deleteStart, deleteEnd);
    assert.match(deleteButton, /disabled=\{hasActiveOperation\}/);
    assert.match(deleteButton, /删除中…/);
    assert.match(deleteButton, /aria-label=\{`删除检查点/);
});

test('workspace routes manual saves through the official complete checkpoint serializer', () => {
    const modalStart = workspaceSource.indexOf('<ProjectCheckpointsModal');
    const modalEnd = workspaceSource.indexOf('/>', modalStart);
    assert.ok(modalStart >= 0 && modalEnd > modalStart);
    const wiring = workspaceSource.slice(modalStart, modalEnd);
    assert.match(wiring, /onCreate=\{async \(\) => \{/);
    assert.match(wiring, /captureWorkspaceCheckpoint\('manual'\)/);
    assert.match(wiring, /if \(!checkpoint\)/);
    assert.match(wiring, /已保存当前工程检查点/);

    const captureStart = workspaceSource.indexOf('const captureWorkspaceCheckpoint = useCallback');
    const captureEnd = workspaceSource.indexOf('const handleCancel', captureStart);
    const capture = workspaceSource.slice(captureStart, captureEnd);
    assert.match(capture, /Blockly\.serialization\.workspaces\.save\(workspace\)/);
    assert.match(capture, /workspaceJson/);
    assert.match(capture, /code/);
    assert.match(capture, /boardPackageId/);
    assert.match(capture, /options/);
});
