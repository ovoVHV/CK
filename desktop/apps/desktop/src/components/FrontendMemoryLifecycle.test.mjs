import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const serialMonitor = await readFile(new URL('./SerialMonitor.tsx', import.meta.url), 'utf8');
const detachedConsole = await readFile(new URL('./DetachedConsoleWindow.tsx', import.meta.url), 'utf8');
const boardSelector = await readFile(new URL('./BoardSelector.tsx', import.meta.url), 'utf8');
const hardwareContext = await readFile(new URL('../contexts/HardwareContext.tsx', import.meta.url), 'utf8');
const extensionLoader = await readFile(new URL('../services/extension_loader.ts', import.meta.url), 'utf8');

test('bounds streamed compile output instead of retaining an ever-growing React string', () => {
    const appendStart = workspace.indexOf('const appendCompileLog = useCallback');
    const appendEnd = workspace.indexOf('const getCompileLineClass', appendStart);
    const append = workspace.slice(appendStart, appendEnd);
    assert.match(workspace, /appendCompileLogBufferBounded/);
    assert.match(workspace, /createCompileLogBuffer/);
    assert.match(append, /appendCompileLogBufferBounded\(compileLogBufferRef\.current, chunk\)/);
    assert.doesNotMatch(append, /prev \+ chunk/);
});

test('serial monitor closes an asynchronously registered listener after unmount', () => {
    assert.match(serialMonitor, /const stopListening = await listen<any>\('serial-data'/);
    assert.match(serialMonitor, /if \(destroyed\) stopListening\(\);\s*else unlisten = stopListening/);
    assert.match(serialMonitor, /unlisten\?\.\(\)/);
    assert.match(serialMonitor, /cancelAnimationFrame\(rafId\)/);
    assert.match(serialMonitor, /incomingBuffer = ''/);
    assert.match(serialMonitor, /terminal\.dispose\(\)[\s\S]{0,120}xtermRef\.current = null[\s\S]{0,120}fitAddonRef\.current = null/);
    assert.match(workspace, /<SerialMonitor[\s\S]{0,700}scrollback=\{8000\}[\s\S]{0,200}hideDebugProtocol/);
});

test('plot mode pauses the hidden text terminal without discarding its scrollback', () => {
    assert.match(workspace, /paused=\{isPaused \|\| consoleViewMode !== 'text'\}/);
    assert.match(workspace, /consoleViewMode === 'text' \? 'z-10[^']*' : 'z-0 invisible'/);
    assert.match(workspace, /consoleViewMode === 'plot' && \([\s\S]{0,240}<SerialPlotter/);
});

test('TFT image previews revoke temporary blob URLs and use a bounded managed LRU', () => {
    assert.match(extensionLoader, /TFT_IMAGE_CACHE_ENTRIES_MAX = 64/);
    assert.match(extensionLoader, /TFT_IMAGE_CACHE_TOTAL_BYTES_MAX = 128 \* 1024 \* 1024/);
    assert.match(extensionLoader, /const managedTftImageEntries = new Map/);
    assert.match(extensionLoader, /const activeKeys = activeTftImageCacheKeys\(\)/);
    assert.match(extensionLoader, /candidate => !activeKeys\.has\(candidate\.__ckCanonicalKey\)/);
    assert.match(extensionLoader, /const metadata = await stat\(filePath\)/);
    assert.match(extensionLoader, /finally \{[\s\S]{0,240}URL\.revokeObjectURL\(blobUrl\)/);
    assert.match(extensionLoader, /export const releaseTftImageCache/);
    assert.match(extensionLoader, /releaseTftImageCachePath\(state\.filePath, state\.fileName\)/);
});

test('detached console bounds its pending queue and handles listener registration races', () => {
    assert.match(detachedConsole, /chunk\.split\('\\n'\)\.slice\(-MAX_LOG_LINES\)/);
    assert.match(detachedConsole, /if \(pending\.length > MAX_LOG_LINES\)/);
    assert.match(detachedConsole, /if \(!alive\) \{\s*stopBuildLog\(\)/);
    assert.match(detachedConsole, /if \(!alive\) \{\s*stopConfig\(\)/);
    assert.match(detachedConsole, /pendingCompileLinesRef\.current = \[\]/);
});

test('workspace cancels transient UI timers and coalesced Blockly resize frames', () => {
    assert.match(workspace, /const toastTimerRef = useRef<ReturnType<typeof setTimeout> \| null>\(null\)/);
    assert.match(workspace, /clearTimeout\(toastTimerRef\.current\)/);
    assert.match(workspace, /let resizeFrame: number \| null = null/);
    assert.match(workspace, /if \(resizeFrame !== null\) cancelAnimationFrame\(resizeFrame\)/);
    assert.match(workspace, /const workspace = workspaceRef\.current;\s*if \(workspace\) Blockly\.svgResize\(workspace\)/);
});

test('workspace refreshes the Blockly widget singleton before every injection', () => {
    assert.match(workspace, /prepareBlocklyWidgetDivForInjection/);
    assert.ok(
        workspace.indexOf('prepareBlocklyWidgetDivForInjection(Blockly.WidgetDiv)')
            < workspace.indexOf('const ws = Blockly.inject'),
        'shared WidgetDiv must be refreshed before Blockly binds another keydown wrapper',
    );
});

test('Blockly locale transition refreshes declarative extension presentation before reinjection', () => {
    const refreshStart = workspace.indexOf('const refreshActiveExtensionLocales = useCallback');
    const refreshEnd = workspace.indexOf('// Toolbox callbacks are installed', refreshStart);
    assert.ok(refreshStart >= 0 && refreshEnd > refreshStart, 'extension locale refresh callback must remain discoverable');
    const refreshBody = workspace.slice(refreshStart, refreshEnd);
    assert.match(refreshBody, /activeExtensionLocaleEntriesRef\.current/);
    assert.match(refreshBody, /registerExtensionBlocks\([\s\S]{0,260}block_locale:\s*nextLocale/);
    assert.match(refreshBody, /entry\.visualColour/);
    assert.match(refreshBody, /entry\.boardIdentity/);
    assert.doesNotMatch(refreshBody, /registerExtensionGenerator/);

    const transitionStart = workspace.indexOf('// Package locale overlays are applied before Blockly disposes');
    const transitionEnd = workspace.indexOf('setBlocklyRendererRevision(revision => revision + 1)', transitionStart);
    assert.ok(transitionStart >= 0 && transitionEnd > transitionStart, 'locale transition must refresh extensions before the renderer revision');
    const transitionBody = workspace.slice(transitionStart, transitionEnd + 100);
    assert.match(transitionBody, /void refreshActiveExtensionLocales\(nextLocale\)\.then/);
    assert.ok(
        transitionBody.indexOf('refreshActiveExtensionLocales(nextLocale)')
            < transitionBody.indexOf('setBlocklyRendererRevision'),
        'workspace reinjection must wait for declarative locale refresh',
    );
});

test('initial project hydration and later edits use the lossless code-aware warmup scheduler', () => {
    const warmupStart = workspace.indexOf('// Warm the exact generated sketch after project hydration');
    const warmupEnd = workspace.indexOf('const buildCkFunctionFlyout', warmupStart);
    const warmup = workspace.slice(warmupStart, warmupEnd);
    assert.ok(warmupStart >= 0 && warmupEnd > warmupStart, 'warmup effect must remain discoverable');
    assert.match(warmup, /if \(projectLoadedRevision <= 0/);
    assert.match(warmup, /scheduler\.schedule\(createSilentPrecompileRequest\(/);
    assert.doesNotMatch(warmup, /silentPrecompileLoadedRevisionRef|lastSilentPrecompileKeyRef/);
    assert.match(workspace, /new SilentPrecompileScheduler\(\{/);
    assert.match(workspace, /isBlocked: \(\) => isCompilingRef\.current/);
    assert.equal(
        workspace.match(/createSilentPrecompileRequest\(/g)?.length,
        2,
        'foreground build and warmup effect must share one request builder',
    );
    assert.equal(
        workspace.match(/cancelSatisfied\(foregroundWarmupRequest\)/g)?.length,
        1,
        'the final successful foreground boundary must suppress only the exact redundant warmup',
    );
    assert.match(workspace, /scheduler\.dispose\(\)/);
});

test('project and board-option warmup have one exact-code owner', () => {
    assert.doesNotMatch(hardwareContext, /boardOptionsWarmupArmedRef|Config-change warmup triggered/);
    assert.doesNotMatch(hardwareContext, /startWarmup|code\s*\|\|\s*null/);
    const ownershipStart = hardwareContext.indexOf('// Workspace owns project/config warmup');
    const ownershipEnd = hardwareContext.indexOf('const setBoardOption', ownershipStart);
    const ownershipContract = hardwareContext.slice(ownershipStart, ownershipEnd);
    assert.ok(ownershipStart >= 0 && ownershipEnd > ownershipStart, 'warmup ownership contract must remain explicit');
    assert.doesNotMatch(ownershipContract, /invoke\('warmup_board'/);

    const warmupStart = workspace.indexOf('// Warm the exact generated sketch after project hydration');
    const warmupEnd = workspace.indexOf('const buildCkFunctionFlyout', warmupStart);
    const warmup = workspace.slice(warmupStart, warmupEnd);
    assert.match(warmup, /const board = String\(effectiveCompileFqbn/);
    assert.match(warmup, /scheduler\.schedule\(createSilentPrecompileRequest\(/);
    assert.match(warmup, /effectiveCompileFqbn/);
});

test('board installer progress remains bounded and partial listeners are fail-closed', () => {
    assert.match(boardSelector, /MAX_INSTALL_LOG_LINES = 500/);
    assert.match(boardSelector, /MAX_INSTALL_LOG_LINE_CHARACTERS = 2_000/);
    assert.match(boardSelector, /appendBoundedInstallLog/);
    assert.doesNotMatch(boardSelector, /setInstallLogs\(prev => \[\.\.\.prev,/);
    assert.match(boardSelector, /if \(disposed\) \{\s*stopProgress\(\)/);
    assert.match(boardSelector, /if \(disposed\) \{\s*stopJson\(\)/);
    assert.match(boardSelector, /if \(disposed\) \{\s*stopFinished\(\)/);
});
