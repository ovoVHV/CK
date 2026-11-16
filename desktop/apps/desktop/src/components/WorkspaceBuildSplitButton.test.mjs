import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

const workspaceHeader = () => {
    const start = source.indexOf('ck-workspace-header');
    const end = source.indexOf('{/* Main Content */}', start);
    assert.ok(start >= 0 && end > start, 'workspace header should be discoverable');
    return source.slice(start, end);
};

const elementWithRole = (text, role, tag = 'button') => {
    const roleAt = text.indexOf(`data-ck-role="${role}"`);
    assert.ok(roleAt >= 0, `missing ${role}`);
    const openAt = text.lastIndexOf(`<${tag}`, roleAt);
    let openEnd = -1;
    let quote = '';
    let escaped = false;
    let braceDepth = 0;
    for (let index = openAt; index < text.length; index += 1) {
        const character = text[index];
        if (quote) {
            if (escaped) escaped = false;
            else if (character === '\\') escaped = true;
            else if (character === quote) quote = '';
            continue;
        }
        if (character === '"' || character === "'" || character === '`') quote = character;
        else if (character === '{') braceDepth += 1;
        else if (character === '}') braceDepth -= 1;
        else if (character === '>' && braceDepth === 0) {
            openEnd = index;
            break;
        }
    }
    const end = text.indexOf(`</${tag}>`, openEnd);
    assert.ok(openAt >= 0 && openEnd > roleAt && end > openEnd, `malformed ${role}`);
    return {
        whole: text.slice(openAt, end + tag.length + 3),
        openTag: text.slice(openAt, openEnd),
    };
};

const classTokens = (openTag) => {
    const className = openTag.match(/className="([^"]+)"/)?.[1] || '';
    assert.ok(className, 'expected a static className contract');
    return className.split(/\s+/).filter(Boolean);
};

const assertAlwaysVisible = (element, label) => {
    const tokens = classTokens(element.openTag);
    assert.ok(!tokens.includes('hidden'), `${label} must remain present at 900/1024px`);
    assert.ok(tokens.includes('flex') || tokens.includes('inline-flex'), `${label} needs a base display mode`);
};

const assertBuildDisabled = (fragment, label, header) => {
    const expression = fragment.match(/disabled=\{([^}]+)\}/)?.[1];
    if (expression) {
        for (const state of ['isCompiling', 'isDeviceHealthRunning', 'blockDebugSession.active']) {
            assert.ok(expression.includes(state), `${label} must disable for ${state}`);
        }
        return;
    }
    const shared = fragment.match(/disabled=\{([A-Za-z_$][\w$]*)\}/)?.[1];
    assert.ok(shared, `${label} must expose a disabled expression`);
    const assignment = header.match(new RegExp(`const ${shared} = ([^;]+)`))?.[1] || '';
    for (const state of ['isCompiling', 'isDeviceHealthRunning', 'blockDebugSession.active']) {
        assert.ok(assignment.includes(state), `${label} shared disabled state must include ${state}`);
    }
};

test('header groups compile, normal upload and special-upload menu without merging their actions', () => {
    const header = workspaceHeader();
    assert.equal((header.match(/data-ck-role="build-action-group"/g) || []).length, 1);
    const group = elementWithRole(header, 'build-action-group', 'div');
    const compile = elementWithRole(header, 'build-compile-action');
    const normalUpload = elementWithRole(header, 'build-normal-upload-action');
    const trigger = elementWithRole(header, 'build-special-upload-trigger');

    assert.match(compile.openTag, /handleCompileAndUpload\(false\)/);
    assert.match(compile.whole, /isBuildPreparing \? buildT\('toolbar\.preparing'\) : buildT\('toolbar\.compile'\)/);
    assert.doesNotMatch(compile.whole, /handleCompileAndUpload\(true|uploadMode|handleStartBlockDebug/);

    assert.match(normalUpload.openTag, /handleCompileAndUpload\(true,\s*\{\s*uploadMode:\s*'normal'\s*\}\)/);
    assert.match(normalUpload.whole, /buildT\('toolbar\.upload'\)/);
    assert.match(normalUpload.whole, /buildT\('toolbar\.normalUploadHint'\)/);
    assert.doesNotMatch(normalUpload.whole, /handleStartBlockDebug|uploadMode:\s*'debug'|blockRunMode|preferred|remembered/);
    const missingPortAt = normalUpload.openTag.indexOf('if (!activePort)');
    const uploadAt = normalUpload.openTag.indexOf("handleCompileAndUpload(true, { uploadMode: 'normal' })");
    assert.ok(missingPortAt >= 0 && uploadAt > missingPortAt, 'normal upload must resolve a missing port before any compile/upload call');
    assert.match(normalUpload.openTag.slice(missingPortAt, uploadAt), /setIsPortMenuOpen\(true\)[\s\S]*?return/);

    assert.ok(!classTokens(group.openTag).includes('hidden'), 'build action group must remain present at 900/1024px');
    for (const [label, element] of [
        ['compile action', compile],
        ['normal upload action', normalUpload],
        ['special upload trigger', trigger],
    ]) {
        assertAlwaysVisible(element, label);
    }
    assertBuildDisabled(compile.openTag, 'compile action', header);
    assertBuildDisabled(normalUpload.openTag, 'normal upload action', header);
    assertBuildDisabled(trigger.openTag, 'special upload trigger', header);
});

test('dropdown contains special upload actions only and closes before debug upload', () => {
    const header = workspaceHeader();
    const menu = elementWithRole(header, 'build-special-upload-menu', 'div');
    const debug = elementWithRole(header, 'build-debug-upload-action');
    const trigger = elementWithRole(header, 'build-special-upload-trigger');

    assert.match(trigger.openTag, /aria-haspopup="menu"/);
    const menuState = trigger.openTag.match(/aria-expanded=\{([A-Za-z_$][\w$]*)\}/)?.[1];
    assert.ok(menuState, 'special upload trigger should expose its menu state');
    const menuSetter = `set${menuState[0].toUpperCase()}${menuState.slice(1)}`;
    assert.match(trigger.openTag, new RegExp(`${menuSetter}\\(`));
    assert.match(header, new RegExp(`\\{${menuState} && \\(`));
    assert.match(debug.whole, /buildT\('toolbar\.debugUpload'\)/);
    assert.doesNotMatch(menu.whole, /handleCompileAndUpload\(false\)|uploadMode:\s*'normal'|toolbar\.compileOnlyHint|toolbar\.normalUploadHint/);

    const closeAt = debug.whole.search(/setIs(?:Build|Compile)MenuOpen\(false\)/);
    const actionAt = debug.whole.indexOf('handleStartBlockDebug()');
    assert.ok(closeAt >= 0 && actionAt > closeAt, 'debug upload must close its menu before starting');
    assertBuildDisabled(debug.openTag, 'debug upload action', header);
});

test('normal compile/upload paths are explicit and cannot be promoted to remembered debug behavior', () => {
    const header = workspaceHeader();
    assert.doesNotMatch(header, /localStorage|sessionStorage/);
    assert.doesNotMatch(source, /(?:last|remembered|preferred)(?:Build|Compile|Upload|Debug)(?:Action|Mode)/i);

    assert.equal((header.match(/handleCompileAndUpload\(false\)/g) || []).length, 1, 'compile must have one one-click header action');
    assert.equal((header.match(/handleCompileAndUpload\(true,\s*\{\s*uploadMode:\s*'normal'/g) || []).length, 1, 'normal upload must have one one-click header action');
    assert.equal((header.match(/handleStartBlockDebug\(\)/g) || []).length, 1, 'debug upload must exist only inside the special menu');

    const debug = elementWithRole(header, 'build-debug-upload-action');
    const debugAt = header.indexOf(debug.whole);
    const menuAt = header.indexOf('data-ck-role="build-special-upload-menu"');
    assert.ok(menuAt >= 0 && debugAt > menuAt, 'debug upload must remain nested under the special-upload menu');
});

test('legacy standalone debug button is gone while active-build cancel remains', () => {
    const header = workspaceHeader();
    assert.equal((header.match(/data-ck-role="build-compile-action"/g) || []).length, 1);
    assert.equal((header.match(/data-ck-role="build-normal-upload-action"/g) || []).length, 1);
    assert.equal((header.match(/data-ck-role="build-special-upload-trigger"/g) || []).length, 1);
    assert.equal((header.match(/data-ck-role="build-cancel-action"/g) || []).length, 1);
    assert.equal((header.match(/data-ck-role="build-debug-upload-action"/g) || []).length, 1);
    assert.doesNotMatch(header, /data-ck-role="build-standalone-debug-action"/);
    assert.match(header, /\{isCompiling && \([\s\S]*?onClick=\{handleCancel\}[\s\S]*?buildT\('toolbar\.cancelOperation'\)[\s\S]*?buildT\('toolbar\.cancel'\)/);
});
