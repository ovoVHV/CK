import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const zhCNCommon = JSON.parse(await readFile(new URL('../locales/zh-CN/common.json', import.meta.url), 'utf8'));

const sourcePath = new URL('./project_open.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const testableSource = source
    .replace(
        "import { invoke } from '@tauri-apps/api/core';",
        'const invoke = (...args: unknown[]) => (globalThis as any).__ckProjectOpenInvoke(...args);',
    )
    .replace(
        "import { listen } from '@tauri-apps/api/event';",
        'const listen = (...args: unknown[]) => (globalThis as any).__ckProjectOpenListen(...args);',
    );
assert.notEqual(testableSource, source, 'Tauri imports must remain replaceable for contract tests');

const transpiled = ts.transpileModule(testableSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'project_open.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
);

const calls = [];
let liveListener;
let pending = [];
let pendingDrainError = null;
globalThis.window = { __TAURI_INTERNALS__: {} };
globalThis.__ckProjectOpenListen = async (eventName, listener) => {
    calls.push(['listen', eventName]);
    liveListener = listener;
    return () => calls.push(['unlisten']);
};
globalThis.__ckProjectOpenInvoke = async (command, args) => {
    calls.push([command, args]);
    if (command === 'drain_pending_project_opens') {
        if (pendingDrainError) {
            const error = pendingDrainError;
            pendingDrainError = null;
            throw error;
        }
        return pending.splice(0);
    }
    if (command === 'prepare_project_open_v2') return { path: args.path, name: 'demo' };
    return undefined;
};

const projectOpen = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('prepares an external path through the native validation command', async () => {
    calls.length = 0;
    const target = await projectOpen.prepareProjectOpen('C:/Projects/demo.ck');
    assert.deepEqual(target, { path: 'C:/Projects/demo.ck', name: 'demo' });
    assert.deepEqual(calls[0], ['prepare_project_open_v2', { path: 'C:/Projects/demo.ck' }]);
    await assert.rejects(() => projectOpen.prepareProjectOpen('  '), /工程路径为空/);
});

test('normalizes typed IPC errors without using the localized message as identity', async () => {
    const previousInvoke = globalThis.__ckProjectOpenInvoke;
    globalThis.__ckProjectOpenInvoke = async command => {
        if (command === 'prepare_project_open_v2') {
            throw {
                code: 'PROJECT_VERSION_UNSUPPORTED',
                params: { schemaVersion: 999 },
                message: '工程版本不兼容',
                rawCause: null,
            };
        }
        return undefined;
    };
    try {
        await assert.rejects(
            async () => {
                try {
                    await projectOpen.prepareProjectOpen('C:/Projects/future.ck');
                } catch (error) {
                    assert.equal(error.descriptor.code, 'PROJECT_VERSION_UNSUPPORTED');
                    assert.equal(error.descriptor.params.schemaVersion, 999);
                    assert.equal(projectOpen.projectOpenErrorMessage(error), '工程版本不兼容');
                    throw error;
                }
            },
            /工程版本不兼容/,
        );
    } finally {
        globalThis.__ckProjectOpenInvoke = previousInvoke;
    }
});

test('accepts one ck or maker file from a native drop and explains invalid drops', () => {
    assert.equal(projectOpen.isSupportedProjectFilePath('C:/Projects/demo.ck'), true);
    assert.equal(projectOpen.isSupportedProjectFilePath('C:\\Projects\\Legacy.MAKER'), true);
    assert.equal(projectOpen.isSupportedProjectFilePath('C:/Projects/readme.txt'), false);
    assert.equal(
        projectOpen.projectPathsReferToSameFile('C:/Projects/Demo.ck', 'c:\\projects\\demo.ck'),
        true,
    );
    assert.equal(
        projectOpen.projectPathsReferToSameFile('C:/Projects/a.ck', 'C:/Projects/b.ck'),
        false,
    );

    assert.deepEqual(
        projectOpen.inspectDroppedProjectPaths([' C:/Projects/demo.ck ']),
        { path: 'C:/Projects/demo.ck', fileName: 'demo.ck', error: null },
    );
    assert.deepEqual(
        projectOpen.inspectDroppedProjectPaths(['C:\\Projects\\legacy.maker']),
        { path: 'C:\\Projects\\legacy.maker', fileName: 'legacy.maker', error: null },
    );
    assert.match(projectOpen.inspectDroppedProjectPaths([]).error, /没有识别到/);
    assert.match(projectOpen.inspectDroppedProjectPaths(['a.ck', 'b.maker']).error, /一次只能/);
    assert.match(projectOpen.inspectDroppedProjectPaths(['notes.txt']).error, /\.ck 或 \.maker/);
});

test('serializes project-open requests until each unsaved-work decision settles', async () => {
    const steps = [];
    let releaseFirst;
    const firstGate = new Promise(resolve => { releaseFirst = resolve; });
    const queue = projectOpen.createProjectOpenRequestQueue(async request => {
        steps.push(`start:${request.requestId}`);
        if (request.requestId === 'first') await firstGate;
        steps.push(`finish:${request.requestId}`);
    });

    const first = queue.enqueue({ requestId: 'first', path: 'C:/Projects/first.ck', source: 'drag-drop' });
    const second = queue.enqueue({ requestId: 'second', path: 'C:/Projects/second.maker', source: 'second-instance' });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(steps, ['start:first']);
    assert.equal(queue.pendingCount(), 2);

    releaseFirst();
    await Promise.all([first, second]);
    assert.deepEqual(steps, [
        'start:first',
        'finish:first',
        'start:second',
        'finish:second',
    ]);
    assert.equal(queue.pendingCount(), 0);
    queue.dispose();
});

test('registers live delivery before draining cold-start work and acknowledges requests', async () => {
    calls.length = 0;
    pending = [{ requestId: 'cold-1', path: 'C:/Projects/cold.ck', source: 'cold-start' }];
    const delivered = [];
    const unsubscribe = await projectOpen.subscribeProjectOpenRequests(request => {
        delivered.push(request.requestId);
    });
    assert.deepEqual(delivered, ['cold-1']);
    assert.equal(calls[0][0], 'listen');
    assert.equal(calls[1][0], 'drain_pending_project_opens');
    assert.ok(calls.some(([command, args]) => command === 'acknowledge_project_open' && args.requestId === 'cold-1'));

    liveListener({ payload: { requestId: 'live-2', path: 'C:/Projects/live.ck', source: 'second-instance' } });
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(delivered, ['cold-1', 'live-2']);
    unsubscribe();
    assert.equal(calls.at(-1)[0], 'unlisten');
});

test('releases the live listener when startup snapshot delivery fails', async () => {
    calls.length = 0;
    pending = [];
    pendingDrainError = new Error('snapshot unavailable');

    await assert.rejects(
        () => projectOpen.subscribeProjectOpenRequests(() => undefined),
        /snapshot unavailable/,
    );
    assert.equal(calls[0][0], 'listen');
    assert.equal(calls[1][0], 'drain_pending_project_opens');
    assert.equal(calls.at(-1)[0], 'unlisten');
});

test('deduplicates the listener/drain race by request id', async () => {
    calls.length = 0;
    const request = { requestId: 'race-1', path: 'C:/Projects/race.ck', source: 'second-instance' };
    pending = [request];
    const delivered = [];
    globalThis.__ckProjectOpenListen = async (_eventName, listener) => {
        liveListener = listener;
        listener({ payload: request });
        return () => undefined;
    };
    await projectOpen.subscribeProjectOpenRequests(item => delivered.push(item.requestId));
    await new Promise(resolve => setTimeout(resolve, 0));
    assert.deepEqual(delivered, ['race-1']);
});

test('cold-start requests stay ahead of live requests observed during bootstrap', async () => {
    calls.length = 0;
    const cold = { requestId: 'cold-first', path: 'C:/Projects/cold.ck', source: 'cold-start' };
    const live = { requestId: 'live-second', path: 'C:/Projects/live.ck', source: 'second-instance' };
    pending = [cold];
    globalThis.__ckProjectOpenListen = async (_eventName, listener) => {
        liveListener = listener;
        listener({ payload: live });
        return () => undefined;
    };
    const delivered = [];
    await projectOpen.subscribeProjectOpenRequests(async item => {
        delivered.push(item.requestId);
        await new Promise(resolve => setTimeout(resolve, 0));
    });
    assert.deepEqual(delivered, ['cold-first', 'live-second']);
});

test('the app and workspace route external opens through the unsaved navigation gate', async () => {
    const app = await readFile(new URL('../App.tsx', import.meta.url), 'utf8');
    const workspace = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
    const rust = await readFile(new URL('../../src-tauri/src/project_open.rs', import.meta.url), 'utf8');
    const config = JSON.parse(await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'));

    assert.match(app, /subscribeProjectOpenRequests/);
    assert.match(app, /prepareProjectOpen\(request\.path\)/);
    assert.match(app, /getCurrentWebview\(\)\.onDragDropEvent/);
    assert.match(app, /inspectDroppedProjectPaths\(payload\.paths\)/);
    assert.match(app, /source: 'drag-drop'/);
    assert.match(app, /createProjectOpenRequestQueue\(handleRequestedProjectOpen\)/);
    assert.match(app, /return enqueueProjectOpenRequest\(request\)/);
    assert.match(app, /data-project-drop-state/);
    assert.match(app, /if \(payload\.type !== 'drop'\) return;[\s\S]*clearDropNotice\(\)/);
    assert.match(app, /window\.addEventListener\('blur', clearDropNotice\)/);
    assert.match(app, /window\.addEventListener\('dragend', clearDropNotice, true\)/);
    assert.match(app, /event\.key === 'Escape'/);
    assert.match(app, /onPointerDown=\{\(\) => setProjectDropNotice\(null\)\}/);
    assert.doesNotMatch(app, /state: 'opening'/);
    assert.doesNotMatch(app, /pointer-events-none fixed inset-0 z-\[10000\]/);
    assert.match(app, /new CustomEvent\(PROJECT_OPEN_BROWSER_EVENT/);
    assert.match(app, /accept: \(\) => \{/);
    assert.match(app, /onSettled: async \(\) =>/);
    assert.match(app, /projectOpenQueueRef\.current\?\.dispose\(\)/);
    assert.match(app, /workspaceOpenListenerWaitersRef\.current\.splice\(0\)/);
    assert.match(app, /i18n\.t\('app\.projectOpen\.editorNotReady'\)/);
    assert.match(zhCNCommon.app.projectOpen.editorNotReady, /编辑器未能及时准备工程打开功能/);
    assert.match(workspace, /confirmUnsavedNavigation\('open'\)/);
    assert.match(workspace, /projectPathsReferToSameFile\(targetPath, currentPathRef\.current\)/);
    assert.match(workspace, /beginProjectLoad\(targetPath\)/);
    assert.match(workspace, /if \(detail\.accept\) detail\.accept\(\)/);
    assert.match(workspace, /await detail\.onSettled\?\.\(\)/);
    assert.doesNotMatch(workspace, /if \(!targetPath \|\| switching\) return/);
    assert.match(rust, /get_webview_window\("main"\)/);
    assert.match(rust, /window\.set_focus\(\)/);
    assert.deepEqual(config.bundle.fileAssociations[0].ext, ['ck', 'maker']);
});
