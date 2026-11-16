import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

const REPORT_MUTATION = /set(?:DeviceHealthPublication|CompileDoctorReport|CompileResourceReport|CompileIssues|PinPreflightReport)\s*\(/;

test('opening and collapsing the dock only change presentation state', () => {
    const openStart = source.indexOf('const openEngineeringHealth = useCallback');
    const openEnd = source.indexOf('const toggleCodeView = useCallback', openStart);
    assert.ok(openStart >= 0 && openEnd > openStart);
    const open = source.slice(openStart, openEnd);
    assert.match(open, /workspaceRef\.current\?\.hideChaff\(\)/);
    assert.match(open, /setIsEngineeringHealthOpen\(true\)/);
    assert.doesNotMatch(open, REPORT_MUTATION);
    assert.doesNotMatch(open, /handleInspectDevice/);

    const dockStart = source.indexOf('<EngineeringHealthDock');
    const closeAt = source.indexOf('onClose=', dockStart);
    const firstReportProp = source.indexOf('compileDoctorReport=', closeAt);
    const close = source.slice(closeAt, firstReportProp);
    assert.match(close, /setIsEngineeringHealthOpen\(false\)/);
    assert.doesNotMatch(close, REPORT_MUTATION);
    assert.doesNotMatch(close, /handleInspectDevice/);
});

test('locating a block keeps the dock and all reports mounted', () => {
    const dockStart = source.indexOf('<EngineeringHealthDock');
    const locateStart = source.indexOf('onLocateBlock=', dockStart);
    const locateEnd = source.indexOf('onIssueAction=', locateStart);
    assert.ok(dockStart >= 0 && locateStart > dockStart && locateEnd > locateStart);
    const locate = source.slice(locateStart, locateEnd);

    assert.match(locate, /locateWorkspaceBlock\(blockId\)/);
    assert.doesNotMatch(locate, /setIsEngineeringHealthOpen\(false\)/);
    assert.doesNotMatch(locate, REPORT_MUTATION);
    assert.doesNotMatch(locate, /handleInspectDevice/);
});

test('showing an existing report never starts a new device inspection', () => {
    const references = source.match(/handleInspectDevice/g) || [];
    assert.equal(
        references.length,
        3,
        'device inspection should have one implementation and only its two explicit user actions',
    );
    assert.match(source, /data-ck-role="device-health-menu-action"[\s\S]{0,400}onClick=\{\(\) => void handleInspectDevice\(\)\}/);
    assert.match(source, /data-ck-role="device-health-button"[\s\S]{0,220}onClick=\{\(\) => void handleInspectDevice\(\)\}/);
    assert.doesNotMatch(
        source.slice(source.indexOf('data-ck-role="engineering-health-button"'), source.indexOf('data-ck-role="device-health-button"')),
        /handleInspectDevice/,
    );
});

test('device-health publication expires only when its request or hardware identity changes', () => {
    assert.equal(
        (source.match(/setDeviceHealthPublication\(null\)/g) || []).length,
        1,
        'visibility, locating and report rendering must not clear the device report',
    );

    const identityStart = source.indexOf('if (!deviceHealthPublication) return;');
    const identityEnd = source.indexOf('useEffect(() => () => {', identityStart);
    assert.ok(identityStart >= 0 && identityEnd > identityStart);
    const identity = source.slice(identityStart, identityEnd);
    assert.match(identity, /requestId: deviceHealthRequestIdRef\.current/);
    assert.match(identity, /fqbn: effectiveCompileFqbn/);
    assert.match(identity, /port: activePort \|\| ''/);
    assert.match(identity, /isSameDeviceHealthTarget\(deviceHealthPublication\.target, currentTarget\)/);
    assert.match(identity, /setDeviceHealthPublication\(null\)/);
    assert.match(identity, /\[activePort, deviceHealthPublication, effectiveCompileFqbn\]/);

    const presentationStart = source.indexOf('const currentDeviceHealthReport = useMemo');
    const presentationEnd = source.indexOf('const compileLogRef', presentationStart);
    const presentation = source.slice(presentationStart, presentationEnd);
    assert.match(presentation, /target\.fqbn !== effectiveCompileFqbn/);
    assert.match(presentation, /target\.port !== \(activePort \|\| ''\)/);
});

test('compile reports expire on project target or generated-source identity changes, not dock visibility', () => {
    const targetEffectStart = source.indexOf('const snapshot = loadCompileResourceSnapshot(currentPath, effectiveCompileFqbn);');
    const targetEffectEnd = source.indexOf('/** Parse only diagnostics emitted for an Arduino sketch translation unit.', targetEffectStart);
    assert.ok(targetEffectStart >= 0 && targetEffectEnd > targetEffectStart);
    const targetEffect = source.slice(targetEffectStart, targetEffectEnd);
    assert.match(targetEffect, /setCompileDoctorReport\(null\)/);
    assert.match(targetEffect, /setCompileIssues\(\[\]\)/);
    assert.match(targetEffect, /setPinPreflightReport\(null\)/);
    assert.match(targetEffect, /\[currentPath, effectiveCompileFqbn\]/);

    const editStart = source.indexOf('if (codeChanged) {');
    const editEnd = source.indexOf('refreshBlockBreakpointVisuals', editStart);
    const editInvalidation = source.slice(editStart, editEnd);
    assert.match(editInvalidation, /setCompileDoctorReport\(null\)/);
    assert.match(editInvalidation, /setCompileResourceReport\(null\)/);
    assert.match(editInvalidation, /setCompileIssues\(\[\]\)/);
    assert.match(editInvalidation, /setPinPreflightReport\(null\)/);
});
