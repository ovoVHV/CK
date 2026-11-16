import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

const elementSlice = (role) => {
    const start = source.indexOf(`data-ck-role="${role}"`);
    const end = source.indexOf('</button>', start);
    assert.ok(start >= 0 && end > start, `${role} should exist`);
    return source.slice(start, end);
};

test('keeps compile and ordinary upload as separate one-click split actions', () => {
    const compile = elementSlice('build-compile-action');
    assert.match(compile, /handleCompileAndUpload\(false\)/);
    assert.match(compile, /isBuildPreparing \? buildT\('toolbar\.preparing'\) : buildT\('toolbar\.compile'\)/);
    assert.match(compile, /disabled=\{isCompiling \|\| isBuildPreparing \|\| isDeviceHealthRunning \|\| blockDebugSession\.active\}/);
    assert.doesNotMatch(compile, /handleStartBlockDebug|uploadMode:/);

    const upload = elementSlice('build-normal-upload-action');
    assert.match(upload, /handleCompileAndUpload\(true, \{ uploadMode: 'normal' \}\)/);
    assert.match(upload, /<span[^>]*>\{buildT\('toolbar\.upload'\)\}<\/span>/);
    assert.match(upload, /disabled=\{isCompiling \|\| isBuildPreparing \|\| isDeviceHealthRunning \|\| blockDebugSession\.active\}/);
    assert.doesNotMatch(upload, /handleStartBlockDebug|liveBreakpointIds|uploadMode:\s*'debug'/);
});

test('keeps only debug upload in the explicit non-persistent arrow menu', () => {
    assert.match(source, /const \[isBuildMenuOpen, setIsBuildMenuOpen\] = useState\(false\)/);

    const menuButton = elementSlice('build-special-upload-trigger');
    assert.match(menuButton, /aria-haspopup="menu"/);
    assert.match(menuButton, /aria-expanded=\{isBuildMenuOpen\}/);
    assert.match(menuButton, /disabled=\{isCompiling \|\| isBuildPreparing \|\| isDeviceHealthRunning \|\| blockDebugSession\.active\}/);

    const debugUpload = elementSlice('build-debug-upload-action');
    assert.match(debugUpload, /setIsBuildMenuOpen\(false\)/);
    assert.match(debugUpload, /handleStartBlockDebug\(\)/);
    assert.match(debugUpload, /<span[^>]*>\{buildT\('toolbar\.debugUpload'\)\}<\/span>/);
    assert.match(debugUpload, /liveBreakpointIds\.length/);
    assert.match(debugUpload, /\{liveBreakpointIds\.length\}/);
    assert.doesNotMatch(source, /data-ck-role="compile-only-action"|>编译上传<\/span>/);
});

test('keeps cancel reachable and bounds the popup inside the viewport', () => {
    const splitStart = source.indexOf('data-ck-role="build-action-group"');
    const cancelStart = source.indexOf('onClick={handleCancel}', splitStart);
    assert.ok(splitStart >= 0 && cancelStart > splitStart);
    assert.match(source.slice(splitStart, cancelStart), /right-0 top-\[calc\(100%\+8px\)\]/);
    assert.match(source.slice(splitStart, cancelStart), /max-w-\[calc\(100vw-1rem\)\]/);
    assert.match(source.slice(cancelStart, source.indexOf('</button>', cancelStart)), /<span[^>]*>\{buildT\('toolbar\.cancel'\)\}<\/span>/);
});
