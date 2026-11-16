import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const detached = await readFile(new URL('./DetachedConsoleWindow.tsx', import.meta.url), 'utf8');

test('the detached console is a view and never owns the physical serial session', () => {
    assert.doesNotMatch(detached, /invoke\(['"]open_serial_monitor['"]/);
    assert.doesNotMatch(detached, /invoke\(['"]close_serial_monitor['"]/);
    assert.doesNotMatch(detached, /invoke\(['"]send_serial_data['"]/);
    assert.match(detached, /emitTo<DetachedConsoleCommand>\('main', 'ck-console-command'/);
    assert.match(detached, /action: isSerialMonitorOpen \? 'close' : 'open'/);
    assert.match(detached, /action: 'dock'/);
});

test('workspace remains the single serial controller for detached commands', () => {
    assert.match(workspace, /listen<DetachedConsoleCommand>\('ck-console-command'/);
    assert.match(workspace, /await closeSerialMonitorConfirmed\('detached'\)/);
    assert.match(workspace, /await invoke\('send_serial_data', \{ data \}\)/);
    assert.match(workspace, /await openSerialMonitorWithSettings\(portName, targetBaud, 'switch-baud', seq\)/);
    assert.match(workspace, /new WebviewWindow\(DETACHED_CONSOLE_LABEL/);
});

test('closing serial waits for backend confirmation before publishing closed state', () => {
    const helperStart = workspace.indexOf('const closeSerialMonitorConfirmed');
    const helperEnd = workspace.indexOf('const toggleSerialMonitor', helperStart);
    assert.ok(helperStart >= 0 && helperEnd > helperStart);
    const helper = workspace.slice(helperStart, helperEnd);
    const backendClose = helper.indexOf("await invoke('close_serial_monitor')");
    const uiClosed = helper.indexOf('setIsSerialMonitorOpen(false)');
    assert.ok(backendClose >= 0 && uiClosed > backendClose);
    assert.match(helper, /端口已经释放/);
});

test('detaching unmounts the embedded display and docking restores it without closing serial', () => {
    assert.match(workspace, /setConsoleOpen\(false\)/);
    assert.match(workspace, /isConsoleDetached \? \(/);
    assert.match(detached, /await sendCommand\(\{ action: 'dock' \}\)/);
    assert.match(detached, /await getCurrentWindow\(\)\.destroy\(\)/);
    assert.doesNotMatch(detached, /handleBackToMain[\s\S]{0,400}close_serial_monitor/);
});

test('real serial open-close control sits beside endpoint settings in both views', () => {
    const workspaceBaud = workspace.indexOf('<span>波特率</span>');
    const workspaceEndpointToggle = workspace.indexOf('data-ck-action="toggle-serial-monitor-near-endpoint"', workspaceBaud);
    assert.ok(workspaceBaud >= 0 && workspaceEndpointToggle > workspaceBaud);
    assert.ok(workspaceEndpointToggle - workspaceBaud < 5000);
    assert.match(workspace.slice(workspaceBaud - 2600, workspaceEndpointToggle), /value=\{activePort \|\| ''\}/);
    assert.match(workspace.slice(workspaceEndpointToggle - 500, workspaceEndpointToggle + 900), /真正关闭串口并释放端口/);

    const detachedPort = detached.indexOf('value={selectedPort}');
    const detachedBaud = detached.indexOf('value={baudRate}', detachedPort);
    const detachedEndpointToggle = detached.indexOf('data-ck-action="toggle-serial-monitor-near-endpoint"', detachedBaud);
    assert.ok(detachedPort >= 0 && detachedBaud > detachedPort && detachedEndpointToggle > detachedBaud);
    assert.ok(detachedEndpointToggle - detachedBaud < 1800);
});

test('detached title bar only docks or closes the floating view', () => {
    const titleBarStart = detached.indexOf("t('window.detached')");
    const controlsBarStart = detached.indexOf('min-h-10 bg-slate-50', titleBarStart + 1);
    const titleBar = detached.slice(titleBarStart, controlsBarStart);
    assert.match(titleBar, /t\('window\.returnToMain'\)/);
    assert.match(titleBar, /t\('window\.returnHint'\)/);
    assert.doesNotMatch(titleBar, /toggleSerialMonitor/);
    assert.doesNotMatch(titleBar, /t\('monitor\.close/);
});

test('focusing the detached serial console closes the view popover before moving window focus', () => {
    const actionHelperStart = workspace.indexOf('const runViewMenuAction');
    const actionHelperEnd = workspace.indexOf('const [isAppearanceSettingsOpen', actionHelperStart);
    assert.ok(actionHelperStart >= 0 && actionHelperEnd > actionHelperStart);
    const actionHelper = workspace.slice(actionHelperStart, actionHelperEnd);
    assert.ok(
        actionHelper.indexOf('setIsViewMenuOpen(false)') < actionHelper.indexOf('action()'),
        'the popover must close synchronously before an action can move focus to another window',
    );

    const focusActionStart = workspace.indexOf("data-ck-action={isConsoleDetached ? 'focus-detached-serial-console'");
    const focusActionEnd = workspace.indexOf('</button>', focusActionStart);
    assert.ok(focusActionStart >= 0 && focusActionEnd > focusActionStart);
    const focusAction = workspace.slice(focusActionStart, focusActionEnd);
    assert.match(focusAction, /runViewMenuAction\(\(\) => \{/);
    assert.match(focusAction, /if \(isConsoleDetached\)[\s\S]*?void openDetachedConsole\(\)/);
    assert.match(focusAction, /聚焦串口浮窗/);

    const focusHelperStart = workspace.indexOf('const openDetachedConsole');
    const focusHelperEnd = workspace.indexOf('const handleInspectDevice', focusHelperStart);
    const focusHelper = workspace.slice(focusHelperStart, focusHelperEnd);
    assert.ok(
        focusHelper.indexOf('setIsViewMenuOpen(false)') < focusHelper.indexOf('WebviewWindow.getByLabel'),
        'direct callers must also close the popover before Tauri window focus changes',
    );
});

test('the view popover still closes on click outside and Escape', () => {
    assert.match(
        workspace,
        /className="fixed inset-0 z-40" onClick=\{\(\) => setIsViewMenuOpen\(false\)\}/,
    );
    assert.match(workspace, /if \(!isViewMenuOpen\) return;[\s\S]*?event\.key !== 'Escape'/);
    assert.match(workspace, /window\.addEventListener\('keydown', closeOnEscape\)/);
    assert.match(workspace, /window\.removeEventListener\('keydown', closeOnEscape\)/);
});
