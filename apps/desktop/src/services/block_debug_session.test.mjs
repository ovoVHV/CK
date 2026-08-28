import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_debug_session.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_debug_session.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'block_debug_session.ts should transpile without syntax errors');

const lifecycle = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    IDLE_BLOCK_DEBUG_SESSION,
    markBlockDebugSessionConnecting,
    markBlockDebugSessionReconnected,
    markBlockDebugSessionStopping,
} = lifecycle;

const pausedSession = {
    active: true,
    sessionId: 'session-a',
    phase: 'paused',
    pausedBlockId: 'block-1',
    pausedBlockLabel: '等待 1 秒',
};

test('serial disconnect preserves the active session while entering connecting', () => {
    assert.deepEqual(markBlockDebugSessionConnecting(pausedSession), {
        active: true,
        sessionId: 'session-a',
        phase: 'connecting',
        pausedBlockId: 'block-1',
        pausedBlockLabel: '等待 1 秒',
    });
    assert.strictEqual(
        markBlockDebugSessionConnecting(IDLE_BLOCK_DEBUG_SESSION),
        IDLE_BLOCK_DEBUG_SESSION,
    );
    const stoppingSession = { ...pausedSession, phase: 'stopping' };
    assert.strictEqual(
        markBlockDebugSessionConnecting(stoppingSession),
        stoppingSession,
    );
});

test('successful reconnect restores paused or running controls without waiting for READY', () => {
    const pausedConnecting = markBlockDebugSessionConnecting(pausedSession);
    assert.deepEqual(markBlockDebugSessionReconnected(pausedConnecting), pausedSession);

    const runningConnecting = markBlockDebugSessionConnecting({
        ...pausedSession,
        phase: 'running',
        pausedBlockId: null,
        pausedBlockLabel: '',
    });
    assert.equal(markBlockDebugSessionReconnected(runningConnecting).phase, 'running');
    assert.strictEqual(markBlockDebugSessionReconnected(pausedSession), pausedSession);
});

test('only a successful request for the current session can enter stopping', () => {
    assert.deepEqual(markBlockDebugSessionStopping(pausedSession, 'session-a'), {
        ...pausedSession,
        phase: 'stopping',
    });
    assert.strictEqual(
        markBlockDebugSessionStopping(pausedSession, 'old-session'),
        pausedSession,
    );
    const connectingSession = markBlockDebugSessionConnecting(pausedSession);
    assert.deepEqual(markBlockDebugSessionStopping(connectingSession, 'session-a'), {
        ...connectingSession,
        phase: 'stopping',
    });
    assert.strictEqual(
        markBlockDebugSessionStopping(IDLE_BLOCK_DEBUG_SESSION, 'session-a'),
        IDLE_BLOCK_DEBUG_SESSION,
    );
});
