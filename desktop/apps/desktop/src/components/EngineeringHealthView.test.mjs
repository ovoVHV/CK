import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');
const dockSource = await readFile(new URL('./EngineeringHealthDock.tsx', import.meta.url), 'utf8');
const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const compileDoctorSource = await readFile(new URL('./CompileDoctorPanel.tsx', import.meta.url), 'utf8');
const pinPreflightSource = await readFile(new URL('./PinPreflightPanel.tsx', import.meta.url), 'utf8');

test('collects structured engineering reports outside the raw output log', () => {
    assert.match(source, /data-ck-role="engineering-health-view"/);
    assert.match(source, /aria-label=\{t\('title'\)\}/);
    assert.match(source, /<CompileDoctorPanel/);
    assert.match(source, /<DeviceHealthPanel/);
    assert.match(source, /<ResourceBudgetPanel/);
    assert.match(source, /<PinPreflightPanel/);
    assert.match(source, /<BuildIssueCards/);
    assert.match(source, /onLocateBlock=\{onLocateBlock\}/);

    assert.match(dockSource, /<EngineeringHealthView/);
    assert.doesNotMatch(workspaceSource, /data-ck-role="engineering-health-tab"/);
    assert.doesNotMatch(workspaceSource, /consoleTab === 'health'/);
});

test('adds an independent non-modal dock and routes device, pin blockers, and resource actions to it', () => {
    assert.match(workspaceSource, /useState<'serial' \| 'compile'>\('serial'\)/);
    assert.match(workspaceSource, /data-ck-role="engineering-health-button"/);
    assert.match(workspaceSource, /data-ck-role="engineering-health-menu-action"/);
    assert.match(workspaceSource, /<EngineeringHealthDock/);
    assert.match(dockSource, /data-ck-role="engineering-health-dock"/);
    assert.doesNotMatch(dockSource, /fixed inset-0|aria-modal|role="dialog"/);

    const openHelperStart = workspaceSource.indexOf('const openEngineeringHealth = useCallback');
    const openHelperEnd = workspaceSource.indexOf('// Backend / Hardware State', openHelperStart);
    const openHelper = workspaceSource.slice(openHelperStart, openHelperEnd);
    assert.match(openHelper, /setIsEngineeringHealthOpen\(true\)/);
    assert.doesNotMatch(openHelper, /handleInspectDevice|inspect_device_health|invoke\(|setIsDeviceHealthRunning|setDeviceHealthPublication/);

    const inspectStart = workspaceSource.indexOf('const handleInspectDevice = async () =>');
    const inspectEnd = workspaceSource.indexOf('const handleSendSerial = async () =>', inspectStart);
    const inspectHandler = workspaceSource.slice(inspectStart, inspectEnd);
    assert.match(inspectHandler, /openEngineeringHealth\(\)/);
    assert.doesNotMatch(inspectHandler, /setConsoleTab\('health'\)|setConsoleOpen\(true\)/);

    const pinGateStart = workspaceSource.indexOf('if (!nextPinPreflight.canCompile)');
    const pinGateEnd = workspaceSource.indexOf('isCompilingRef.current = true', pinGateStart);
    assert.match(workspaceSource.slice(pinGateStart, pinGateEnd), /openEngineeringHealth\(\)/);

    const resourceActionStart = workspaceSource.indexOf("if (action.kind === 'show_resources')");
    const resourceActionEnd = workspaceSource.indexOf("if (action.kind === 'open_board_config')", resourceActionStart);
    assert.match(workspaceSource.slice(resourceActionStart, resourceActionEnd), /openEngineeringHealth\(\)/);
});

test('clearing raw output cannot erase structured health results', () => {
    const clearAt = workspaceSource.lastIndexOf("replaceCompileLog('')");
    assert.ok(clearAt >= 0);
    assert.doesNotMatch(
        workspaceSource.slice(clearAt, clearAt + 250),
        /setCompileIssues|setCompileDoctorReport|setCompileResourceReport|setPinPreflightReport|setDeviceHealthPublication/,
    );
});

test('invalidates source-bound and target-bound reports when their identity changes', () => {
    assert.match(workspaceSource, /if \(codeChanged\) \{[\s\S]*?setCompileDoctorReport\(null\)[\s\S]*?setCompileResourceReport\(null\)[\s\S]*?setCompileIssues\(\[\]\)[\s\S]*?setPinPreflightReport\(null\)/);
    assert.match(workspaceSource, /deviceHealthPublication\.target\.fqbn !== effectiveCompileFqbn/);
    assert.match(workspaceSource, /deviceHealthPublication\.target\.port !== \(activePort \|\| ''\)/);
    assert.match(workspaceSource, /setCompileDoctorReport\(null\)[\s\S]*?setCompileIssues\(\[\]\)[\s\S]*?setPinPreflightReport\(null\)[\s\S]*?\}, \[currentPath, effectiveCompileFqbn\]\)/);
});

test('keeps the collapsed console and engineering health reachable in short windows', () => {
    assert.match(workspaceSource, /ck-workspace-main flex flex-1 min-h-0 overflow-hidden/);
    assert.match(workspaceSource, /ck-workspace-stage flex-1 min-w-0 min-h-0/);
    assert.match(workspaceSource, /className="h-7[^\n]*shrink-0/);
    assert.match(dockSource, /max\(\$\{ENGINEERING_HEALTH_DOCK_MIN_WIDTH\}px, min\(\$\{clampDockWidth\(width\)\}px, 44vw\)\)/);
    assert.match(dockSource, /ENGINEERING_HEALTH_DOCK_MIN_WIDTH = 280/);
    assert.match(workspaceSource, /data-ck-role="engineering-health-menu-action"/);
});

test('removes the collapsed rail and keeps health reachable from the header', () => {
    assert.doesNotMatch(workspaceSource, /engineering-health-rail(?:-slot)?/);
    const buttonStart = workspaceSource.indexOf('data-ck-role="engineering-health-button"');
    const buttonEnd = workspaceSource.indexOf('</button>', buttonStart);
    const button = workspaceSource.slice(buttonStart, buttonEnd);
    assert.ok(buttonStart >= 0 && buttonEnd > buttonStart);
    assert.match(button, /onClick=\{openEngineeringHealth\}/);
    assert.match(button, /aria-expanded=\{isEngineeringHealthOpen\}/);
    assert.doesNotMatch(button, /handleInspectDevice|inspect_device_health/);
});

test('mounts the dock as a main-flex sibling and persists only its preferred width', () => {
    const mainStart = workspaceSource.indexOf('ck-workspace-main flex flex-1');
    const stageStart = workspaceSource.indexOf('ck-workspace-stage flex-1', mainStart);
    const dockStart = workspaceSource.indexOf('<EngineeringHealthDock', stageStart);
    const consoleStart = workspaceSource.indexOf('{/* Bottom: Console / Serial Monitor */}', dockStart);
    assert.ok(mainStart >= 0 && stageStart > mainStart);
    assert.ok(dockStart > stageStart && consoleStart > dockStart);
    assert.match(workspaceSource, /return 350;/);
    assert.match(workspaceSource, /ck_engineering_health_dock_width/);
    assert.match(workspaceSource, /onResizeStart=\{\(\) => workspaceRef\.current\?\.hideChaff\(\)\}/);
    const locateStart = workspaceSource.indexOf('onLocateBlock={(blockId) => {', dockStart);
    const locateEnd = workspaceSource.indexOf('onIssueAction=', locateStart);
    const locateHandler = workspaceSource.slice(locateStart, locateEnd);
    assert.match(locateHandler, /requestAnimationFrame\(\(\) => \{[\s\S]{0,100}locateWorkspaceBlock\(blockId\)/);
    assert.doesNotMatch(locateHandler, /setIsEngineeringHealthOpen\(false\)/);
    assert.match(workspaceSource, /data-ck-role="engineering-health-button"/);
});

test('dock reports use their own available width instead of viewport breakpoints', () => {
    assert.match(compileDoctorSource, /repeat\(auto-fit, minmax\(min\(110px, 100%\), 1fr\)\)/);
    assert.doesNotMatch(compileDoctorSource, /min-\[900px\]:grid-cols-4/);
    assert.match(pinPreflightSource, /repeat\(auto-fit, minmax\(min\(260px, 100%\), 1fr\)\)/);
    assert.match(pinPreflightSource, /repeat\(auto-fit, minmax\(min\(180px, 100%\), 1fr\)\)/);
    assert.doesNotMatch(pinPreflightSource, /lg:flex-row|sm:grid-cols-2|xl:grid-cols-3/);
});
