import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const libraryManager = await readFile(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8');

test('missing-header action opens Arduino library search with the detected header prefilled', () => {
    const actionStart = workspace.indexOf("if (action.kind === 'library_search')");
    const actionEnd = workspace.indexOf("if (action.kind === 'rescan_ports')", actionStart);
    assert.ok(actionStart >= 0 && actionEnd > actionStart);
    const handler = workspace.slice(actionStart, actionEnd);
    assert.match(handler, /query: action\.query/);
    assert.match(handler, /setLibrarySearchRequest/);
    assert.match(handler, /setIsLibManagerOpen\(true\)/);

    const prefillStart = libraryManager.indexOf('if (!isOpen || !initialArduinoSearch) return');
    const prefillEnd = libraryManager.indexOf('}, [initialArduinoSearch, isOpen]);', prefillStart);
    assert.ok(prefillStart >= 0 && prefillEnd > prefillStart);
    const prefill = libraryManager.slice(prefillStart, prefillEnd);
    assert.match(prefill, /setDiscoverKind\('arduino'\)/);
    assert.match(prefill, /setArduinoQuery\(query\)/);
    assert.match(prefill, /searchArduino\(query\)/);
});

test('locating an error block is independent and does not collapse engineering health', () => {
    const healthDockStart = workspace.indexOf('<EngineeringHealthDock');
    const locateStart = workspace.indexOf('onLocateBlock={(blockId) => {', healthDockStart);
    const locateEnd = workspace.indexOf('onIssueAction=', locateStart);
    const locate = workspace.slice(locateStart, locateEnd);
    assert.match(locate, /locateWorkspaceBlock\(blockId\)/);
    assert.doesNotMatch(locate, /setIsEngineeringHealthOpen\(false\)/);

    const consoleCardStart = workspace.indexOf('<BuildIssueCards', workspace.indexOf('compile-log-scroll-container'));
    assert.match(workspace.slice(consoleCardStart, consoleCardStart + 450), /onLocateBlock=\{locateWorkspaceBlock\}/);
});
