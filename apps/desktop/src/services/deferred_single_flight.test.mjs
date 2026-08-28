import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const sourcePath = new URL('./deferred_single_flight.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(transpiled).toString('base64')}`;
const { createDeferredSingleFlightQueue } = await import(moduleUrl);

const deferred = () => {
    let resolve;
    const promise = new Promise(next => {
        resolve = next;
    });
    return { promise, resolve };
};

const nextMicrotask = () => new Promise(resolve => setImmediate(resolve));

test('concurrent requests share one owner and defer one pass using the latest state', async () => {
    let tokenSequence = 0;
    let latestState = 'first';
    let activeRuns = 0;
    let maximumActiveRuns = 0;
    const runs = [];
    const passes = [];
    const queue = createDeferredSingleFlightQueue({
        nextOwnerToken: () => ++tokenSequence,
        runLatest: async ownerToken => {
            activeRuns += 1;
            maximumActiveRuns = Math.max(maximumActiveRuns, activeRuns);
            runs.push({ ownerToken, state: latestState });
            const pass = deferred();
            passes.push(pass);
            const result = await pass.promise;
            activeRuns -= 1;
            return result;
        },
    });

    const first = queue.request();
    latestState = 'newest';
    const second = queue.request();
    assert.equal(first, second, 'all callers must wait for the complete owner queue');
    assert.equal(runs.length, 1, 'the duplicate request must not start another concurrent pass');

    passes[0].resolve(true);
    await nextMicrotask();
    assert.deepEqual(runs, [
        { ownerToken: 1, state: 'first' },
        { ownerToken: 1, state: 'newest' },
    ]);
    assert.equal(maximumActiveRuns, 1);

    passes[1].resolve(true);
    assert.equal(await first, true);
    assert.equal(await second, true);
    assert.equal(queue.activeOwnerToken(), null);
});

test('a request received during the deferred pass schedules one further latest pass', async () => {
    let tokenSequence = 40;
    let latestRevision = 1;
    const observed = [];
    const passes = [];
    const settled = [];
    const queue = createDeferredSingleFlightQueue({
        nextOwnerToken: () => ++tokenSequence,
        runLatest: async ownerToken => {
            observed.push({ ownerToken, latestRevision });
            const pass = deferred();
            passes.push(pass);
            return pass.promise;
        },
        onOwnerSettled: (ownerToken, result) => settled.push({ ownerToken, result }),
    });

    const ownerPromise = queue.request();
    queue.request();
    passes[0].resolve(true);
    await nextMicrotask();
    latestRevision = 2;
    queue.request();
    passes[1].resolve(false);
    await nextMicrotask();
    assert.deepEqual(observed, [
        { ownerToken: 41, latestRevision: 1 },
        { ownerToken: 41, latestRevision: 1 },
        { ownerToken: 41, latestRevision: 2 },
    ]);

    passes[2].resolve(true);
    assert.equal(await ownerPromise, true, 'the queue result is the last persisted state');
    assert.deepEqual(settled, [{ ownerToken: 41, result: true }]);

    const nextOwner = queue.request();
    assert.equal(queue.activeOwnerToken(), 42, 'a later owner receives a unique token');
    passes[3].resolve(true);
    assert.equal(await nextOwner, true);
});

test('a throwing settle callback still releases the owner for a new token', async () => {
    let tokenSequence = 70;
    let shouldThrow = true;
    const observedTokens = [];
    const queue = createDeferredSingleFlightQueue({
        nextOwnerToken: () => ++tokenSequence,
        runLatest: async ownerToken => {
            observedTokens.push(ownerToken);
            return true;
        },
        onOwnerSettled: () => {
            if (shouldThrow) throw new Error('settle failed');
        },
    });

    await assert.rejects(queue.request(), /settle failed/);
    assert.equal(queue.activeOwnerToken(), null);
    shouldThrow = false;
    assert.equal(await queue.request(), true);
    assert.deepEqual(observedTokens, [71, 72]);
});
