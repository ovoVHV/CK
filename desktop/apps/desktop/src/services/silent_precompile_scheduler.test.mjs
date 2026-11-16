import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./silent_precompile_scheduler.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'silent_precompile_scheduler.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);
const { SilentPrecompileScheduler, createSilentPrecompileRequest } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const createFakeClock = () => {
    let nextId = 1;
    const tasks = new Map();
    return {
        setTimer(callback, delayMs) {
            const id = nextId++;
            tasks.set(id, { callback, delayMs, order: id });
            return id;
        },
        clearTimer(id) {
            tasks.delete(id);
        },
        get size() {
            return tasks.size;
        },
        async runNext() {
            const next = [...tasks.entries()].sort((left, right) => (
                left[1].delayMs - right[1].delayMs || left[1].order - right[1].order
            ))[0];
            if (!next) return false;
            tasks.delete(next[0]);
            next[1].callback();
            await new Promise(resolve => setImmediate(resolve));
            return true;
        },
    };
};

const request = (key, code = key) => ({
    key,
    fqbn: 'esp32:esp32:esp32c6',
    code,
});

test('one request builder preserves the complete target, extension revision, and exact code', () => {
    assert.deepEqual(
        createSilentPrecompileRequest(
            'esp32:esp32:esp32c6:FlashSize=16M',
            7,
            'wifi.h',
            '42:abcdef01',
            'exact source bytes',
        ),
        {
            key: 'esp32:esp32:esp32c6:FlashSize=16M::7::wifi.h::42:abcdef01',
            fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
            code: 'exact source bytes',
        },
    );
});

test('loaded project schedules its complete generated code on the first request', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push(item); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('loaded', 'void setup() {}\nvoid loop() {}'));
    assert.equal(clock.size, 1);
    await clock.runNext();
    assert.deepEqual(runs.map(item => item.key), ['loaded']);
    assert.match(runs[0].code, /void setup/);
});

test('edit requested during foreground compilation retries when the build becomes idle', async () => {
    const clock = createFakeClock();
    const runs = [];
    let compiling = true;
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => compiling,
        run: async item => { runs.push(item.key); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('edited-during-compile'));
    await clock.runNext();
    assert.deepEqual(runs, []);
    assert.equal(clock.size, 1, 'blocked request must remain armed for a short retry');

    compiling = false;
    await clock.runNext();
    assert.deepEqual(runs, ['edited-during-compile']);
});

test('edit requested while a warmup enqueue is in flight runs immediately afterward', async () => {
    const clock = createFakeClock();
    const runs = [];
    let releaseFirst;
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => {
            runs.push(item.key);
            if (item.key === 'first') {
                await new Promise(resolve => { releaseFirst = resolve; });
            }
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('first'));
    await clock.runNext();
    assert.deepEqual(runs, ['first']);

    scheduler.schedule(request('latest'));
    await clock.runNext();
    assert.deepEqual(runs, ['first'], 'latest request must wait without being discarded');
    assert.equal(clock.size, 1);

    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    await clock.runNext();
    assert.deepEqual(runs, ['first', 'latest']);
});

test('continuous edits replace the pending warmup and run only the latest code', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push([item.key, item.code]); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('edit-1', 'old code'));
    scheduler.schedule(request('edit-2', 'middle code'));
    scheduler.schedule(request('edit-3', 'latest code'));
    assert.equal(clock.size, 1);
    await clock.runNext();
    assert.deepEqual(runs, [['edit-3', 'latest code']]);
});

test('foreground success cancels only the matching pending warmup', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push(item.key); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    const compiled = request('compiled-key');
    scheduler.schedule(compiled);
    assert.equal(scheduler.cancelSatisfied(compiled), true);
    assert.equal(clock.size, 0);
    assert.equal(await clock.runNext(), false);
    assert.deepEqual(runs, []);
});

test('foreground success preserves a newer edit or different target request', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push([item.key, item.fqbn, item.code]); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('newer-edit', 'new code'));
    assert.equal(scheduler.cancelSatisfied(request('compiled-key')), false);
    assert.equal(clock.size, 1);
    await clock.runNext();
    assert.deepEqual(runs, [['newer-edit', 'esp32:esp32:esp32c6', 'new code']]);

    const otherTarget = {
        key: 'compiled-key',
        fqbn: 'esp32:esp32:esp32s3:FlashSize=16M',
        code: 'compiled-key',
    };
    scheduler.schedule(otherTarget);
    assert.equal(scheduler.cancelSatisfied(request('compiled-key')), false);
    await clock.runNext();
    assert.deepEqual(runs.at(-1), ['compiled-key', otherTarget.fqbn, otherTarget.code]);
});

test('foreground confirmation rejects a key collision with different exact bytes', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push(item.code); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('same-key', 'new exact bytes'));
    assert.equal(
        scheduler.cancelSatisfied(request('same-key', 'compiled old bytes')),
        false,
    );
    await clock.runNext();
    assert.deepEqual(runs, ['new exact bytes']);
});

test('foreground confirmation preserves the same bytes for a newer extension revision', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push(item.key); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const compiled = createSilentPrecompileRequest('esp32:esp32:esp32c6', 1, 'wifi.h', 'fp', 'same code');
    const newerRuntime = createSilentPrecompileRequest('esp32:esp32:esp32c6', 2, 'wifi.h', 'fp', 'same code');
    scheduler.schedule(newerRuntime);
    assert.equal(scheduler.cancelSatisfied(compiled), false);
    await clock.runNext();
    assert.deepEqual(runs, [newerRuntime.key]);
});

test('confirming an in-flight request cannot erase newer pending work', async () => {
    const clock = createFakeClock();
    const runs = [];
    let releaseFirst;
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => {
            runs.push(item.key);
            if (item.key === 'compiled') {
                await new Promise(resolve => { releaseFirst = resolve; });
            }
        },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });
    const compiled = request('compiled');
    scheduler.schedule(compiled);
    await clock.runNext();
    scheduler.schedule(request('newer'));
    assert.equal(scheduler.cancelSatisfied(compiled), false, 'in-flight work is no longer pending');
    releaseFirst();
    await new Promise(resolve => setImmediate(resolve));
    await clock.runNext();
    assert.deepEqual(runs, ['compiled', 'newer']);
});

test('dispose cancels the armed timer and prevents warmup after unmount', async () => {
    const clock = createFakeClock();
    const runs = [];
    const scheduler = new SilentPrecompileScheduler({
        delayMs: 650,
        retryDelayMs: 180,
        isBlocked: () => false,
        run: async item => { runs.push(item.key); },
        setTimer: clock.setTimer,
        clearTimer: clock.clearTimer,
    });

    scheduler.schedule(request('unmounted-project'));
    scheduler.dispose();
    assert.equal(clock.size, 0);
    assert.equal(await clock.runNext(), false);
    assert.deepEqual(runs, []);
});
