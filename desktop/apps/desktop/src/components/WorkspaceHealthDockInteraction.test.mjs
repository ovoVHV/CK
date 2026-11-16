import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspaceSource = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const dockSource = await readFile(new URL('./EngineeringHealthDock.tsx', import.meta.url), 'utf8');
const healthViewSource = await readFile(new URL('./EngineeringHealthView.tsx', import.meta.url), 'utf8');

test('health dock is a non-modal flex sibling inside the workspace main row', () => {
    assert.match(
        workspaceSource,
        /ck-workspace-shell flex h-full w-full min-w-0 flex-col overflow-hidden/,
        'the workspace shell must not grow to the header min-content width and clip the right dock',
    );
    assert.match(
        workspaceSource,
        /ck-workspace-main flex flex-1 min-h-0 overflow-hidden min-w-0 w-full max-w-full/,
        'the main row must stay within the visible client width so the collapsed rail remains on-screen',
    );
    const mainStart = workspaceSource.indexOf('ck-workspace-main flex flex-1 min-h-0 overflow-hidden');
    const mainEnd = workspaceSource.indexOf('{/* Bottom: Console / Serial Monitor */}', mainStart);
    assert.ok(mainStart >= 0 && mainEnd > mainStart, 'workspace main row should wrap the dock');

    const main = workspaceSource.slice(mainStart, mainEnd);
    const stageAt = main.indexOf('ck-workspace-stage flex-1 min-w-0 min-h-0');
    const dockAt = main.indexOf('<EngineeringHealthDock');
    assert.ok(stageAt >= 0 && dockAt > stageAt, 'dock must sit beside, not over, the Blockly stage');
    assert.equal((main.match(/<EngineeringHealthDock/g) || []).length, 1);
    assert.match(main, /\{isEngineeringHealthOpen && \(\s*<EngineeringHealthDock/);

    assert.match(dockSource, /<aside/);
    assert.match(dockSource, /min-h-0 shrink-0 flex-col overflow-hidden/);
    assert.doesNotMatch(dockSource, /fixed inset-0|aria-modal|role="dialog"|backdrop-blur/);
    assert.doesNotMatch(dockSource, /\.focus\s*\(/, 'opening the dock must not steal Blockly focus');
    assert.match(healthViewSource, /overflow-y-auto overscroll-contain/);
    assert.match(
        healthViewSource,
        /min-w-0 overflow-x-hidden overflow-y-auto/,
        'long capacity/FQBN evidence must wrap or clip inside the dock, never create a horizontal report scroller',
    );
});

test('opening, closing and locating blocks preserve Blockly interaction ownership', () => {
    const openerStart = workspaceSource.indexOf('const openEngineeringHealth = useCallback');
    const openerEnd = workspaceSource.indexOf('// Backend / Hardware State', openerStart);
    assert.ok(openerStart >= 0 && openerEnd > openerStart);
    const opener = workspaceSource.slice(openerStart, openerEnd);

    assert.match(opener, /if \(window\.innerWidth < \d+\) setCodeViewOpen\(false\)/);
    assert.match(opener, /workspaceRef\.current\?\.hideChaff\(\)/);
    assert.match(opener, /setIsEngineeringHealthOpen\(true\)/);
    assert.doesNotMatch(opener, /\n\s*openEngineeringHealth\(\);/);

    const dockUseStart = workspaceSource.indexOf('<EngineeringHealthDock');
    const dockUseEnd = workspaceSource.indexOf('/>', dockUseStart);
    const dockUse = workspaceSource.slice(dockUseStart, dockUseEnd);
    assert.match(dockUse, /onClose=\{\(\) => setIsEngineeringHealthOpen\(false\)\}/);
    const locateStart = dockUse.indexOf('onLocateBlock={(blockId) => {');
    const locateEnd = dockUse.indexOf('onIssueAction=', locateStart);
    const locateHandler = dockUse.slice(locateStart, locateEnd);
    assert.match(
        locateHandler,
        /requestAnimationFrame\(\(\) => \{[\s\S]*?locateWorkspaceBlock\(blockId\)/,
        'centering should run against the current remaining Blockly stage',
    );
    assert.doesNotMatch(locateHandler, /setIsEngineeringHealthOpen\(false\)/, 'locating must keep the dock open');
});

test('the always-visible header button replaces the collapsed rail without consuming Blockly width', () => {
    assert.doesNotMatch(workspaceSource, /engineering-health-rail(?:-slot)?/);

    const buttonStart = workspaceSource.indexOf('data-ck-role="engineering-health-button"');
    const buttonOpenTagEnd = workspaceSource.indexOf('>', buttonStart);
    const buttonEnd = workspaceSource.indexOf('</button>', buttonStart);
    assert.ok(buttonStart >= 0 && buttonOpenTagEnd > buttonStart && buttonEnd > buttonOpenTagEnd);
    assert.equal((workspaceSource.match(/data-ck-role="engineering-health-button"/g) || []).length, 1);
    const buttonOpenTag = workspaceSource.slice(buttonStart, buttonOpenTagEnd);
    const button = workspaceSource.slice(buttonStart, buttonEnd);

    assert.match(buttonOpenTag, /onClick=\{openEngineeringHealth\}/);
    assert.match(buttonOpenTag, /aria-expanded=\{isEngineeringHealthOpen\}/);
    assert.match(buttonOpenTag, /title=/);
    const className = buttonOpenTag.match(/className="([^"]+)"/)?.[1] || '';
    assert.ok(className, 'health button should expose a stable class contract');
    assert.ok(!className.split(/\s+/).includes('hidden'), 'only the text label may hide at a breakpoint; the button must always exist');
    assert.doesNotMatch(className, /violet|h-full|self-stretch|fixed|absolute|sticky/);
    assert.match(className, /slate|teal/);

    assert.match(button, /<HeartPulse/);
    assert.match(button, /<span[^>]*className="hidden [^"]*min-\[[^\]]+\]:inline[^"]*"[^>]*>\{healthTranslate\('productV2.check'\)\}<\/span>/);
    assert.match(button, /hasEngineeringHealthResults[\s\S]*?h-1\.5 w-1\.5 rounded-full/);
    assert.match(button, /h-1\.5 w-1\.5 rounded-full[^>]*aria-hidden="true"/);
    assert.doesNotMatch(button, /handleInspectDevice|setDeviceHealthPublication|setCompileDoctorReport|setCompileResourceReport/);

    const menuStart = workspaceSource.indexOf('data-ck-role="engineering-health-menu-action"');
    const menuEnd = workspaceSource.indexOf('</button>', menuStart);
    assert.ok(menuStart >= 0 && menuEnd > menuStart, 'View menu should keep a backup engineering-health action');
    assert.match(workspaceSource.slice(menuStart, menuEnd), /runViewMenuAction\(openEngineeringHealth\)/);
});

test('compact layouts keep code preview and health dock mutually exclusive in both directions', () => {
    const healthStart = workspaceSource.indexOf('const openEngineeringHealth = useCallback');
    const healthEnd = workspaceSource.indexOf('const toggleCodeView = useCallback', healthStart);
    const healthOpener = workspaceSource.slice(healthStart, healthEnd);
    assert.match(healthOpener, /window\.innerWidth < 1180[\s\S]*?setCodeViewOpen\(false\)/);

    const codeStart = healthEnd;
    const codeEnd = workspaceSource.indexOf('useEffect(() => {', codeStart);
    const codeToggle = workspaceSource.slice(codeStart, codeEnd);
    assert.match(codeToggle, /workspaceRef\.current\?\.hideChaff\(\)/);
    assert.match(codeToggle, /if \(codeViewOpen\)[\s\S]*?setCodeViewOpen\(false\)[\s\S]*?return/);
    assert.match(codeToggle, /window\.innerWidth < 1180[\s\S]*?setIsEngineeringHealthOpen\(false\)[\s\S]*?setCodeViewOpen\(true\)/);
    assert.equal((workspaceSource.match(/onClick=\{toggleCodeView\}/g) || []).length, 1);
    assert.equal((workspaceSource.match(/runViewMenuAction\(toggleCodeView\)/g) || []).length, 1);
});

test('dock width is clamped and its pointer gesture cannot mutate Blockly content', () => {
    assert.match(dockSource, /ENGINEERING_HEALTH_DOCK_MIN_WIDTH = 280/);
    assert.match(dockSource, /ENGINEERING_HEALTH_DOCK_MAX_WIDTH = 640/);
    assert.match(dockSource, /Math\.min\([\s\S]*?ENGINEERING_HEALTH_DOCK_MAX_WIDTH[\s\S]*?Math\.max\([\s\S]*?ENGINEERING_HEALTH_DOCK_MIN_WIDTH/);
    assert.match(dockSource, /onWidthChange\(clampDockWidth\(resizeOriginRef\.current\.width \+ delta\)\)/);
    assert.match(
        dockSource,
        /width: `max\(\$\{ENGINEERING_HEALTH_DOCK_MIN_WIDTH\}px, min\(\$\{clampDockWidth\(width\)\}px, 44vw\)\)`/,
    );
    assert.match(dockSource, /role="separator"/);
    assert.match(dockSource, /event\.stopPropagation\(\)/);
    assert.match(dockSource, /event\.preventDefault\(\)/);
    assert.match(dockSource, /event\.currentTarget\.setPointerCapture\(event\.pointerId\)/);
    assert.match(dockSource, /onPointerMove=\{continueResize\}/);
    assert.match(dockSource, /onPointerUp=\{finishResize\}/);
    assert.match(dockSource, /onPointerCancel=\{finishResize\}/);
    assert.match(dockSource, /event\.currentTarget\.releasePointerCapture\(event\.pointerId\)/);
    assert.match(workspaceSource, /onResizeStart=\{\(\) => workspaceRef\.current\?\.hideChaff\(\)\}/);
    assert.doesNotMatch(dockSource, /centerOnBlock|zoomToFit|updateToolbox|workspaceToCode/);
});

test('Blockly resize follows the real stage box without recentering the view', () => {
    const resizeStart = workspaceSource.indexOf('// Use ResizeObserver for robust layout handling');
    const resizeEnd = workspaceSource.indexOf('return (', resizeStart);
    assert.ok(resizeStart >= 0 && resizeEnd > resizeStart);
    const resize = workspaceSource.slice(resizeStart, resizeEnd);

    assert.match(resize, /new ResizeObserver/);
    assert.match(resize, /resizeObserver\.observe\(blocklyDiv\.current\)/);
    assert.match(resize, /requestAnimationFrame\([\s\S]*?const workspace = workspaceRef\.current;[\s\S]*?Blockly\.svgResize\(workspace\)/);
    assert.match(resize, /cancelAnimationFrame\(resizeFrame\)/);
    assert.doesNotMatch(resize, /centerOnBlock|zoomToFit|updateToolbox/);
});
