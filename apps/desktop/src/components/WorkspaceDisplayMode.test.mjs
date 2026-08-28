import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const healthView = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');
const healthDock = await readFile(new URL('./EngineeringHealthDock.tsx', import.meta.url), 'utf8');
const compileDoctor = await readFile(new URL('./CompileDoctorPanel.tsx', import.meta.url), 'utf8');
const deviceHealth = await readFile(new URL('./DeviceHealthPanel.tsx', import.meta.url), 'utf8');
const boardConfig = await readFile(new URL('./BoardConfigModal.tsx', import.meta.url), 'utf8');

test('persists one display-only preference and exposes both modes from the View controls', () => {
    assert.match(workspace, /readWorkspaceViewMode\(\)/);
    assert.match(workspace, /setWorkspaceDisplayMode\(persistWorkspaceViewMode\(mode\)\)/);
    assert.match(workspace, /data-ck-role="workspace-display-mode"/);
    assert.match(workspace, /workspace-display-mode-' \+ mode/);
    assert.match(workspace, /'simple', '简洁视图'/);
    assert.match(workspace, /'engineering', '工程视图'/);
    assert.match(workspace, /role="menuitemradio"/);

    const setterStart = workspace.indexOf('const applyWorkspaceDisplayMode');
    const setterEnd = workspace.indexOf('const openEngineeringHealth', setterStart);
    const setter = workspace.slice(setterStart, setterEnd);
    assert.doesNotMatch(setter, /setIsProjectDirty|saveProject|invoke\(/);
});

test('passes the same display mode through board settings and all engineering health panels', () => {
    assert.match(workspace, /<BoardConfigModal[\s\S]*?displayMode=\{workspaceDisplayMode\}/);
    assert.match(workspace, /<EngineeringHealthDock[\s\S]*?displayMode=\{workspaceDisplayMode\}/);
    assert.match(healthDock, /<EngineeringHealthView[\s\S]*?displayMode=\{displayMode\}/);
    assert.match(healthView, /<CompileDoctorPanel[\s\S]*?displayMode=\{displayMode\}/);
    assert.match(healthView, /<DeviceHealthPanel[\s\S]*?displayMode=\{displayMode\}/);
});

test('simple mode folds technical evidence but never hides issues or safety boundaries', () => {
    assert.match(healthView, /简洁视图只折叠技术证据；错误、上传风险与安全门禁始终完整显示/);
    assert.match(healthView, /<BuildIssueCards[\s\S]*?issues=\{compileIssues\}/);
    assert.match(healthView, /<ResourceBudgetPanel[\s\S]*?compact=\{compact \|\| simple\}/);
    assert.match(healthView, /<PinPreflightPanel[\s\S]*?compact=\{compact \|\| simple\}/);

    assert.match(compileDoctor, /data-ck-role="compile-doctor-actionable-summary"/);
    assert.match(compileDoctor, /<span[^>]*>建议：<\/span>[\s\S]*?\{report\.recommendation\}/);
    assert.match(compileDoctor, /data-ck-role="compile-doctor-advanced-details"/);

    assert.match(deviceHealth, /actionableChecks = presentation\.orderedChecks\.filter\(check => check\.state === 'error' \|\| check\.state === 'warning'\)/);
    assert.match(deviceHealth, /actionableChecks\.length > 0 \? actionableChecks/);
    assert.match(deviceHealth, /问题与风险不会被折叠/);
    assert.match(deviceHealth, /data-ck-role="device-health-advanced-target"/);
});

test('simple board settings fold only the full FQBN and keep configuration blockers actionable', () => {
    assert.match(boardConfig, /displayMode === 'engineering'/);
    assert.match(boardConfig, /data-ck-role="board-config-advanced-target"/);
    assert.match(boardConfig, /查看完整编译目标/);
    assert.match(boardConfig, /data-ck-role="board-config-effective-fqbn"/);
    assert.match(boardConfig, /已阻止构建/);
    assert.match(boardConfig, /移除不兼容旧配置/);

    const targetEnd = boardConfig.lastIndexOf('</details>');
    const blockerStart = boardConfig.indexOf('Object.keys(droppedBoardOptions).length > 0');
    assert.ok(targetEnd >= 0 && blockerStart > targetEnd);
});
