import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const modalSource = await readFile(new URL('./BoardConfigModal.tsx', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('board configuration is locked while compile, upload, or device inspection is active', () => {
    assert.match(modalSource, /isBusy\?: boolean/);
    assert.match(modalSource, /const configurationLocked = isBusy \|\| cacheAction !== null/);
    assert.match(modalSource, /<select[\s\S]*?disabled=\{configurationLocked\}/);
    assert.match(workspaceSource, /<BoardConfigModal[\s\S]*?isBusy=\{isCompiling \|\| isDeviceHealthRunning\}/);
    assert.match(workspaceSource, /onClick=\{\(\) => setIsConfigOpen\(true\)\}[\s\S]*?disabled=\{isCompiling \|\| isDeviceHealthRunning\}/);
});

test('unsupported saved board options hard-block builds and have an explicit repair action', () => {
    assert.match(workspaceSource, /if \(Object\.keys\(droppedBoardOptions\)\.length > 0\)/);
    assert.match(workspaceSource, /已阻止编译\/上传/);
    assert.match(modalSource, /已阻止构建/);
    assert.match(modalSource, /移除不兼容旧配置/);
    assert.match(modalSource, /Object\.entries\(boardOptions\)\.filter/);
    assert.doesNotMatch(modalSource, /编译将使用此板卡的默认值/);
});

const reports = await readFile(new URL('../services/foreground_build_reports.ts', import.meta.url), 'utf8');

test('late resource results are gated by the operation target identity', () => {
    assert.match(workspaceSource, /resourceTargetIdentity: CompileResourceTargetIdentity/);
    assert.match(reports, /isSameCompileResourceTarget\(resourceTargetIdentity, currentTargetIdentity\)/);
    assert.match(reports, /saveCompileResourceSnapshot\(resourceTargetIdentity\.projectPath, nextSnapshot\)/);
});

test('board settings show the complete effective FQBN without truncating configuration options', () => {
    const targetStart = modalSource.indexOf('data-ck-role="board-config-effective-fqbn"');
    const targetEnd = modalSource.indexOf('</code>', targetStart);
    assert.ok(targetStart >= 0 && targetEnd > targetStart);
    const target = modalSource.slice(targetStart, targetEnd);
    assert.match(modalSource.slice(targetStart - 240, targetStart), /完整编译目标/);
    assert.match(target, /boardFqbn \|\| '未记录 FQBN'/);
    assert.match(target, /title=\{boardFqbn \|\| '未记录 FQBN'\}/);
    assert.match(target, /select-text/);
    assert.match(target, /whitespace-normal/);
    assert.match(target, /break-all/);
    assert.match(target, /\[overflow-wrap:anywhere\]/);
    assert.doesNotMatch(target, /truncate/);
});

test('the complete FQBN stays selectable, bounded by the dialog, and exposed to assistive text', () => {
    assert.match(modalSource, /w-\[700px\] max-w-full/);
    assert.match(modalSource, /max-h-\[82vh\]/);
    assert.match(modalSource, /data-ck-role="board-config-effective-fqbn"/);
    assert.match(modalSource, /title=\{boardFqbn \|\| '未记录 FQBN'\}/);
    assert.match(modalSource, /完整编译目标/);
    assert.match(modalSource, /select-text whitespace-normal break-all \[overflow-wrap:anywhere\]/);
});

test('cache recovery has a fast content-verified rebuild and an explicit deep refresh', () => {
    assert.match(modalSource, /onDeepClearCache\?: \(\) => Promise<boolean>/);
    assert.match(modalSource, /runCacheAction\('deep'\)/);
    assert.match(modalSource, /data-ck-role="deep-compile-cache-refresh"/);
    assert.match(modalSource, /ESP32 可能需要数分钟/);
    assert.match(modalSource, /重建缓存/);
    assert.match(workspaceSource, /cacheMode: 'safe' \| 'deep' = 'safe'/);
    assert.match(workspaceSource, /\? 'clear_board_compile_cache'\s*:\s*'clear_board_first_project_compile_cache'/);
    assert.match(workspaceSource, /已保留按源码内容校验的共享 ccache/);
    assert.match(workspaceSource, /onDeepClearCache=\{\(\) => clearCurrentBoardCompileCache\('clear', 'deep'\)\}/);
});
