import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./build_checkpoint_scheduler.ts', import.meta.url), 'utf8');
const compiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
}).outputText;
const moduleUrl = `data:text/javascript;base64,${Buffer.from(compiled).toString('base64')}`;
const { scheduleBuildCheckpoint } = await import(moduleUrl);

test('compile checkpoint is deferred and never blocks the caller', async () => {
    const queued = [];
    let writes = 0;
    const completion = scheduleBuildCheckpoint({
        mode: 'compile',
        persist: async () => { writes += 1; },
        onFailure: assert.fail,
        deferCompile: task => queued.push(task),
    });

    assert.equal(writes, 0);
    assert.equal(queued.length, 1);
    queued.shift()();
    await completion;
    assert.equal(writes, 1);
});

test('upload checkpoint begins immediately and completion waits for persistence', async () => {
    let release;
    let finished = false;
    const persisted = new Promise(resolve => { release = resolve; });
    const completion = scheduleBuildCheckpoint({
        mode: 'upload',
        persist: async () => {
            await persisted;
            finished = true;
        },
        onFailure: assert.fail,
    });

    await Promise.resolve();
    assert.equal(finished, false);
    release();
    await completion;
    assert.equal(finished, true);
});

test('checkpoint failure is reported without rejecting the build path', async () => {
    const errors = [];
    const completion = scheduleBuildCheckpoint({
        mode: 'upload',
        persist: async () => { throw new Error('disk full'); },
        onFailure: error => errors.push(String(error)),
    });

    await assert.doesNotReject(completion);
    assert.deepEqual(errors, ['Error: disk full']);
});
