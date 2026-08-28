import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./board_details_cache.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const hardwareContextSource = await readFile(
    new URL('../contexts/HardwareContext.tsx', import.meta.url),
    'utf8',
);
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'board_details_cache.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'board_details_cache.ts should transpile without syntax errors');

const executableSource = transpiled.outputText
    .replace(
        "import { baseBoardFqbn } from './board_fqbn';",
        "const baseBoardFqbn = fqbn => String(fqbn || '').split(':').slice(0, 3).join(':');",
    )
    .replace(
        "await import('@tauri-apps/api/core')",
        'globalThis.__CK_BOARD_DETAILS_TEST_API__',
    );

const deferred = () => {
    let resolve;
    let reject;
    const promise = new Promise((resolvePromise, rejectPromise) => {
        resolve = resolvePromise;
        reject = rejectPromise;
    });
    return { promise, resolve, reject };
};

test('schema invalidation synchronously revokes the active HardwareContext load sequence', () => {
    const callbackStart = hardwareContextSource.indexOf(
        'const invalidateCurrentBoardOptionSchema = useCallback(() => {',
    );
    const callbackEnd = hardwareContextSource.indexOf(
        'const scanPorts = useCallback',
        callbackStart,
    );
    assert.notEqual(callbackStart, -1);
    assert.notEqual(callbackEnd, -1);
    const callbackSource = hardwareContextSource.slice(callbackStart, callbackEnd);
    const revokeIndex = callbackSource.indexOf('boardOptionLoadSeqRef.current += 1;');
    const clearIndex = callbackSource.indexOf('clearBoardOptionSchemaCache();');

    assert.ok(revokeIndex >= 0, 'the current schema effect must be revoked immediately');
    assert.ok(
        revokeIndex < clearIndex,
        'the load sequence must advance before cache clearing and scheduled React updates',
    );
});

test('a cleared generation cannot return or cache details from its in-flight request', async () => {
    const calls = [];
    globalThis.__CK_BOARD_DETAILS_TEST_API__ = {
        invoke(command, args) {
            const request = deferred();
            calls.push({ command, args, request });
            return request.promise;
        },
    };

    try {
        const cacheModule = await import(
            `data:text/javascript;base64,${Buffer.from(executableSource).toString('base64')}`
        );
        const board = 'esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi';
        const stalePromise = cacheModule.getBoardDetailsCached(board);
        assert.equal(calls.length, 1);
        assert.deepEqual(calls[0].args, { fqbn: 'esp32:esp32:esp32s3' });

        cacheModule.clearBoardDetailsCache();
        const freshPromise = cacheModule.getBoardDetailsCached(board);
        assert.equal(calls.length, 2, 'a cleared generation must start a fresh CLI request');

        const staleRejection = assert.rejects(
            stalePromise,
            error => error instanceof cacheModule.BoardDetailsCacheInvalidatedError
                && error.name === 'BoardDetailsCacheInvalidatedError',
        );
        calls[0].request.resolve(JSON.stringify({ generation: 'old' }));
        await staleRejection;

        const joinedFreshPromise = cacheModule.getBoardDetailsCached(board);
        assert.equal(
            calls.length,
            2,
            'completion of the stale request must not delete the current request entry',
        );
        calls[1].request.resolve(JSON.stringify({ generation: 'fresh' }));
        assert.deepEqual(await freshPromise, { generation: 'fresh' });
        assert.deepEqual(await joinedFreshPromise, { generation: 'fresh' });

        assert.deepEqual(
            await cacheModule.getBoardDetailsCached(board),
            { generation: 'fresh' },
        );
        assert.equal(calls.length, 2, 'only the fresh generation may populate the cache');
    } finally {
        delete globalThis.__CK_BOARD_DETAILS_TEST_API__;
    }
});
