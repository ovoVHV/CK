import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./compile_progress.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'compile_progress.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'compile_progress.ts should transpile without syntax errors');

const progress = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    applyBuildLogLine,
    applyBuildProgressEvent,
    buildStageIndex,
    createBuildProgressState,
    createIdleBuildProgress,
    formatBuildElapsed,
    formatBuildPercentage,
    tickBuildProgress,
} = progress;

test('native activity shows the latest actual task and never invents a whole-build percentage', () => {
    const initial = createBuildProgressState('compile', 1000);
    const state = applyBuildLogLine(initial, '[V9 进度] 对象编译：完成 1/8 · a.o\n[V9 进度] 链接固件：开始 1 项任务\n', 3000);
    assert.equal(state.stage, 'linking');
    assert.equal(state.message, '链接固件：开始 1 项任务');
    assert.equal(state.messageCode, null);
    assert.equal(state.indeterminate, true);
    assert.equal(state.percentage, initial.percentage);
    assert.equal(state.lastActivityAt, 3000);
    assert.equal(applyBuildLogLine(state, '[V9 等待] 请求尚未结束', 8000), state);
});

test('creates distinct compile, upload, and idle states', () => {
    const compile = createBuildProgressState('compile', 1_000);
    assert.deepEqual(compile, {
        percentage: 2,
        message: '正在初始化编译环境',
        messageCode: 'progress.message.initializingCompiler',
        messageParams: {},
        rawMessage: '',
        mode: 'compile',
        stage: 'preparing',
        indeterminate: true,
        fullBuildKind: null,
        startedAt: 1_000,
        elapsedMs: 0,
        lastActivityAt: 1_000,
        quietMs: 0,
    });

    const upload = createBuildProgressState('upload', 2_000);
    assert.equal(upload.percentage, 0);
    assert.equal(upload.stage, 'uploading');
    assert.equal(upload.indeterminate, false);
    assert.equal(upload.message, '正在准备上传');
    assert.equal(upload.messageCode, 'progress.message.preparingUpload');

    const idle = createIdleBuildProgress();
    assert.equal(idle.percentage, 0);
    assert.equal(idle.stage, 'idle');
    assert.equal(idle.indeterminate, false);
    assert.equal(idle.startedAt, 0);
    assert.equal(idle.message, '');
    assert.equal(idle.messageCode, null);
});

test('marks first builds and forced rebuilds as indeterminate full builds', () => {
    const initial = createBuildProgressState('compile', 1_000);
    const firstBuild = applyBuildProgressEvent(
        initial,
        95,
        'First build: compiling all dependencies...',
        3_000,
    );
    assert.equal(firstBuild.stage, 'full-build');
    assert.equal(firstBuild.fullBuildKind, 'first');
    assert.equal(firstBuild.indeterminate, true);
    assert.equal(firstBuild.message, '正在编译核心与依赖');
    assert.equal(firstBuild.messageCode, 'progress.message.compilingCore');
    assert.equal(firstBuild.elapsedMs, 2_000);

    const rebuild = applyBuildLogLine(
        initial,
        '[INFO] Forced rebuild requested after cache clean',
        4_000,
    );
    assert.equal(rebuild.stage, 'full-build');
    assert.equal(rebuild.fullBuildKind, 'rebuild');
    assert.equal(rebuild.indeterminate, true);
    assert.equal(rebuild.message, '正在强制重建当前配置');
    assert.equal(rebuild.messageCode, 'progress.message.forcedRebuild');
});

test('keeps reported percentages bounded and monotonic', () => {
    const initial = createBuildProgressState('compile', 1_000);
    const advanced = applyBuildProgressEvent(initial, 64, 'Compiling sketch unit', 2_000);
    const stale = applyBuildProgressEvent(advanced, 30, 'Compiling sketch unit', 3_000);
    const complete = applyBuildProgressEvent(stale, 180, 'Calculating size', 4_000);

    assert.equal(advanced.percentage, 64);
    assert.equal(stale.percentage, 64);
    assert.equal(complete.percentage, 100);
    assert.equal(applyBuildProgressEvent(initial, -20, 'Resolving libraries').percentage, 2);
    assert.equal(applyBuildProgressEvent(initial, Number.NaN, 'Resolving libraries').percentage, 2);
});

test('moves fast relink through sketch, linking, artifacts, and finalization', () => {
    let state = createBuildProgressState('compile', 1_000);

    state = applyBuildProgressEvent(state, 42, 'Fast Relink: compiling sketch unit', 2_000);
    assert.equal(state.stage, 'sketch');
    assert.equal(state.indeterminate, false);
    assert.equal(state.message, '正在编译当前草图');
    assert.equal(state.messageCode, 'progress.message.compilingSketch');

    state = applyBuildProgressEvent(state, 76, 'Fast Relink: linking firmware', 3_000);
    assert.equal(state.stage, 'linking');
    assert.equal(state.message, '正在链接固件');
    assert.equal(state.messageCode, 'progress.message.linkingFirmware');

    state = applyBuildProgressEvent(state, 90, 'Generating upload artifacts', 4_000);
    assert.equal(state.stage, 'artifacts');
    assert.equal(state.message, '正在生成烧录文件');
    assert.equal(state.messageCode, 'progress.message.generatingArtifacts');

    state = applyBuildLogLine(state, '[INFO] Firmware Artifacts (1):', 5_000);
    assert.equal(state.stage, 'finalizing');
    assert.equal(state.indeterminate, false);
});

test('tick updates elapsed and quiet time without inventing progress', () => {
    const initial = createBuildProgressState('compile', 1_000);
    const active = applyBuildLogLine(initial, '[INFO] Full Build: building dependencies', 6_000);
    const quiet = tickBuildProgress(active, 366_000);

    assert.equal(quiet.elapsedMs, 365_000);
    assert.equal(quiet.quietMs, 360_000);
    assert.equal(quiet.percentage, active.percentage);
    assert.equal(quiet.stage, 'full-build');
    assert.equal(quiet.indeterminate, true);
});

test('shows background warmup waiting and generic CLI compilation as real stages', () => {
    const initial = createBuildProgressState('compile', 1_000);
    const waiting = applyBuildLogLine(
        initial,
        '[INFO] Reusing compatible same-board warmup already in progress',
        2_000,
    );
    assert.equal(waiting.stage, 'waiting');
    assert.equal(waiting.indeterminate, true);
    assert.equal(waiting.message, '正在等待后台预热移交可复用缓存');
    assert.equal(waiting.messageCode, 'progress.message.waitingWarmupHandoff');

    const compiling = applyBuildProgressEvent(waiting, 5, 'Compiling...', 3_000);
    assert.equal(compiling.stage, 'full-build');
    assert.equal(compiling.indeterminate, true);
    assert.equal(compiling.message, '正在编译核心与依赖');
});

test('upload remains determinate and uses upload-specific messages', () => {
    const initial = createBuildProgressState('upload', 1_000);
    const connecting = applyBuildProgressEvent(initial, 12, 'Connecting to board...', 2_000);
    const resetting = applyBuildProgressEvent(connecting, 100, 'Resetting board...', 3_000);

    assert.equal(connecting.stage, 'uploading');
    assert.equal(connecting.indeterminate, false);
    assert.equal(connecting.message, '正在连接开发板');
    assert.equal(connecting.messageCode, 'progress.message.connectingBoard');
    assert.equal(resetting.percentage, 100);
    assert.equal(resetting.message, '正在复位开发板');
    assert.equal(resetting.messageCode, 'progress.message.resettingBoard');
});

test('compile-and-upload switches phase and resets compile percentage', () => {
    let state = createBuildProgressState('compile', 1_000);
    state = applyBuildProgressEvent(state, 100, 'Build success', 2_000);
    assert.equal(state.mode, 'compile');
    assert.equal(state.percentage, 100);

    state = applyBuildProgressEvent(state, 0, 'Starting Upload...', 3_000);
    assert.equal(state.mode, 'upload');
    assert.equal(state.stage, 'uploading');
    assert.equal(state.indeterminate, false);
    assert.equal(state.percentage, 0);

    state = applyBuildProgressEvent(state, 37, 'Uploading (37%)...', 4_000);
    assert.equal(state.percentage, 37);
});

test('ESP multi-image upload resets each image instead of staying pinned at 100%', () => {
    let state = createBuildProgressState('compile', 1_000);
    state = applyBuildProgressEvent(state, 100, 'Build success', 2_000);
    state = applyBuildProgressEvent(state, 0, 'Starting Upload...', 3_000);

    state = applyBuildProgressEvent(state, 100, 'Uploading (100.0%)...', 4_000);
    assert.equal(state.percentage, 100);

    state = applyBuildProgressEvent(state, 0, 'Uploading (0.0%)...', 5_000);
    assert.equal(state.percentage, 0);

    state = applyBuildProgressEvent(state, 47.3, 'Uploading (47.3%)...', 6_000);
    assert.equal(state.percentage, 47.3);
    assert.equal(formatBuildPercentage(state.percentage), '47%');
});

test('formats elapsed time and maps stages to the four visible milestones', () => {
    assert.equal(formatBuildElapsed(-1), '00:00');
    assert.equal(formatBuildElapsed(65_999), '01:05');
    assert.equal(formatBuildElapsed(3_661_000), '1:01:01');

    assert.equal(buildStageIndex('cache-check'), 0);
    assert.equal(buildStageIndex('full-build'), 1);
    assert.equal(buildStageIndex('sketch'), 1);
    assert.equal(buildStageIndex('linking'), 2);
    assert.equal(buildStageIndex('artifacts'), 3);
    assert.equal(buildStageIndex('uploading'), 3);
});

test('formats the complete 0-100 percentage without leaking invalid values', () => {
    assert.equal(formatBuildPercentage(0), '0%');
    assert.equal(formatBuildPercentage(7.4), '7%');
    assert.equal(formatBuildPercentage(47.3), '47%');
    assert.equal(formatBuildPercentage(100), '100%');
    assert.equal(formatBuildPercentage(160), '100%');
    assert.equal(formatBuildPercentage(-12), '0%');
    assert.equal(formatBuildPercentage(Number.NaN), '0%');
});
