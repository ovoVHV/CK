import assert from 'node:assert/strict';
import { createHash, webcrypto } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

if (!globalThis.crypto) {
    Object.defineProperty(globalThis, 'crypto', { value: webcrypto });
}

const sourcePath = new URL('./recovery_drafts.ts', import.meta.url);
const rustSourcePath = new URL('../../src-tauri/src/recovery_drafts.rs', import.meta.url);
const checkpointRustSourcePath = new URL('../../src-tauri/src/project_checkpoints.rs', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const testableSource = source.replace(
    "import { invoke } from '@tauri-apps/api/core';",
    'const invoke = (...args: unknown[]) => (globalThis as any).__ckRecoveryDraftInvoke(...args);',
);
assert.notEqual(testableSource, source, 'the Tauri invoke import must be replaced for the Node contract test');

const transpiled = ts.transpileModule(testableSource, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'recovery_drafts.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'recovery_drafts.ts should transpile without syntax errors');

const calls = [];
let invokeResponder = async () => undefined;
globalThis.__ckRecoveryDraftInvoke = async (command, args) => {
    calls.push([command, args]);
    return invokeResponder(command, args);
};

const recovery = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    RECOVERY_DRAFT_SCHEMA_VERSION,
    computeRecoveryDraftFullStateHash,
    deleteRecoveryDraft,
    discardProjectRecoveryDrafts,
    getProjectRecoveryBaseline,
    listRecoveryDrafts,
    loadRecoveryDraft,
    recoveryDraftFullStatePayload,
    recoveryOfferSessionKey,
    recoveryProjectSessionKey,
    recoveryProjectSessionMatches,
    resolveCompletedRecoveryProjectSession,
    saveRecoveryDraft,
    selectLatestRecoveryDraftForSession,
    shouldOfferRecoveryDraft,
} = recovery;

test('project recovery sessions bind path, completed load key, and revision', () => {
    const session = {
        projectPath: 'C:/Projects/demo.maker',
        loadKey: 'C:/Projects/demo.maker::4',
        revision: 7,
    };
    assert.equal(recoveryProjectSessionMatches(session, { ...session }), true);
    assert.equal(recoveryProjectSessionMatches(session, { ...session, projectPath: 'C:/Projects/other.maker' }), false);
    assert.equal(recoveryProjectSessionMatches(session, { ...session, loadKey: 'C:/Projects/demo.maker::5' }), false);
    assert.equal(recoveryProjectSessionMatches(session, { ...session, revision: 8 }), false);
    assert.equal(recoveryProjectSessionMatches(session, null), false);
    assert.equal(
        recoveryProjectSessionKey(session),
        JSON.stringify([session.projectPath, session.loadKey, session.revision]),
    );
});

test('an A to B load window has no completed session that may reach a save backend', () => {
    assert.equal(resolveCompletedRecoveryProjectSession({
        projectPath: 'C:/Projects/B.maker',
        requestedLoadKey: 'C:/Projects/B.maker::3',
        completedLoadKey: 'C:/Projects/A.maker::2',
        revision: 8,
    }), null);
    assert.equal(resolveCompletedRecoveryProjectSession({
        projectPath: 'C:/Projects/B.maker',
        requestedLoadKey: 'C:/Projects/B.maker::3',
        completedLoadKey: null,
        revision: 8,
    }), null);
    assert.deepEqual(resolveCompletedRecoveryProjectSession({
        projectPath: 'C:/Projects/B.maker',
        requestedLoadKey: 'C:/Projects/B.maker::3',
        completedLoadKey: 'C:/Projects/B.maker::3',
        revision: 9,
    }), {
        projectPath: 'C:/Projects/B.maker',
        loadKey: 'C:/Projects/B.maker::3',
        revision: 9,
    });
});

const stateVector = () => ({
    workspaceJson: '{"blocks":{"blocks":[{"type":"第三方/温度","id":"b-1"}]}}',
    sourceCode: 'void setup() {\n  Serial.println("温度");\n}\n',
    board: 'ESP32-C6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=8M',
    boardPackageId: 'ck-c6-carrier',
    options: '{"FlashSize":"8M","USBMode":"hwcdc"}',
});

const metadata = (overrides = {}) => ({
    schemaVersion: RECOVERY_DRAFT_SCHEMA_VERSION,
    id: 'draft-1',
    projectId: 'project-1',
    projectPath: 'C:/Projects/demo.maker',
    projectName: 'demo',
    createdAt: '2026-07-14T02:00:00.000Z',
    diskBaselineHash: `sha256:${'1'.repeat(64)}`,
    diskBaselineModifiedAt: '2026-07-14T01:00:00.000Z',
    fullStateHash: `sha256:${'2'.repeat(64)}`,
    board: 'ESP32-C6',
    fqbn: 'esp32:esp32:esp32c6:FlashSize=8M',
    boardPackageId: 'ck-c6-carrier',
    options: '{}',
    byteSize: 1024,
    ...overrides,
});

test('full-state hash matches the Rust recovery-drafts-v1 contract vector', async () => {
    const state = stateVector();
    const payload = recoveryDraftFullStatePayload(state);
    const expected = 'sha256:6816261b5b983ae86f54d84e52fe0d493617244d0348764dd4751c1104d0a2be';

    assert.equal(`sha256:${createHash('sha256').update(payload).digest('hex')}`, expected);
    assert.equal(await computeRecoveryDraftFullStateHash(state), expected);
});

test('every recovery state field contributes to the full-state hash', async () => {
    const original = stateVector();
    const originalHash = await computeRecoveryDraftFullStateHash(original);
    for (const field of [
        'workspaceJson',
        'sourceCode',
        'board',
        'fqbn',
        'boardPackageId',
        'options',
    ]) {
        const changed = { ...original, [field]: `${original[field]}#changed` };
        assert.notEqual(
            await computeRecoveryDraftFullStateHash(changed),
            originalHash,
            `${field} must be covered by the full-state hash`,
        );
    }
});

test('save preserves opaque state and sends baseline plus client hash evidence', async () => {
    calls.length = 0;
    const state = {
        ...stateVector(),
        workspaceJson: '{\n  "blocks": { "blocks": [{ "type": "第三方/原样" }] }\n}',
        options: '{ "FlashSize": "8M", "custom": [3, 2, 1] }',
    };
    const baseline = {
        sha256: `sha256:${'a'.repeat(64)}`,
        modifiedAt: '2026-07-14T01:00:00.000Z',
    };
    const saved = metadata();
    invokeResponder = async command => {
        assert.equal(command, 'save_recovery_draft');
        return saved;
    };

    assert.equal(await saveRecoveryDraft({
        projectPath: '  C:/Projects/demo.maker  ',
        projectId: ' project-1 ',
        diskBaseline: baseline,
        ...state,
    }), saved);

    assert.equal(calls.length, 1);
    const [command, args] = calls[0];
    assert.equal(command, 'save_recovery_draft');
    assert.equal(args.input.projectPath, 'C:/Projects/demo.maker');
    assert.equal(args.input.projectId, 'project-1');
    assert.equal(args.input.diskBaselineHash, baseline.sha256);
    assert.equal(args.input.diskBaselineModifiedAt, baseline.modifiedAt);
    assert.equal(args.input.workspaceJson, state.workspaceJson);
    assert.equal(args.input.sourceCode, state.sourceCode);
    assert.equal(args.input.board, state.board);
    assert.equal(args.input.fqbn, state.fqbn);
    assert.equal(args.input.boardPackageId, state.boardPackageId);
    assert.equal(args.input.options, state.options);
    assert.equal(
        args.input.expectedFullStateHash,
        await computeRecoveryDraftFullStateHash(state),
    );
});

test('save obtains the formal disk baseline when the caller has no captured baseline', async () => {
    calls.length = 0;
    const baseline = {
        projectPath: 'C:/Projects/demo.maker',
        projectId: 'project-1',
        sha256: `sha256:${'b'.repeat(64)}`,
        modifiedAt: '2026-07-14T01:00:00.000Z',
        byteSize: 2048,
    };
    invokeResponder = async command => {
        if (command === 'get_project_recovery_baseline') return baseline;
        if (command === 'save_recovery_draft') return metadata();
        throw new Error(`unexpected command: ${command}`);
    };

    await saveRecoveryDraft({
        projectPath: baseline.projectPath,
        projectId: baseline.projectId,
        ...stateVector(),
    });

    assert.deepEqual(calls.map(([command]) => command), [
        'get_project_recovery_baseline',
        'save_recovery_draft',
    ]);
    assert.deepEqual(calls[0][1], {
        projectPath: baseline.projectPath,
        projectId: baseline.projectId,
    });
    assert.equal(calls[1][1].input.diskBaselineHash, baseline.sha256);
    assert.equal(calls[1][1].input.diskBaselineModifiedAt, baseline.modifiedAt);
});

test('candidate policy requires matching hashes, a changed state, schema v1, and positive time ordering', () => {
    const candidate = metadata();
    const current = {
        diskBaselineHash: candidate.diskBaselineHash,
        diskModifiedAt: '2026-07-14T01:30:00.000Z',
        fullStateHash: `sha256:${'3'.repeat(64)}`,
    };
    assert.equal(shouldOfferRecoveryDraft(candidate, current), true);
    assert.equal(shouldOfferRecoveryDraft(
        { ...candidate, diskBaselineHash: `sha256:${'4'.repeat(64)}` },
        current,
    ), false);
    assert.equal(shouldOfferRecoveryDraft(
        candidate,
        { ...current, fullStateHash: candidate.fullStateHash },
    ), false);
    assert.equal(shouldOfferRecoveryDraft(
        { ...candidate, schemaVersion: 99 },
        current,
    ), false);
    assert.equal(shouldOfferRecoveryDraft(
        candidate,
        { ...current, diskModifiedAt: '2026-07-14T02:00:00.000Z' },
    ), false);

    // An invalid current timestamp may fall back to the baseline time that was
    // captured with the draft, but missing evidence must remain fail-closed.
    assert.equal(shouldOfferRecoveryDraft(
        candidate,
        { ...current, diskModifiedAt: 'not-a-time' },
    ), true);
    assert.equal(shouldOfferRecoveryDraft(
        { ...candidate, diskBaselineModifiedAt: null },
        { ...current, diskModifiedAt: null },
    ), false);
    assert.equal(shouldOfferRecoveryDraft(
        { ...candidate, createdAt: 'not-a-time' },
        current,
    ), false);
});

test('one loaded project baseline offers only its latest eligible draft per session', () => {
    const current = {
        diskBaselineHash: `sha256:${'1'.repeat(64)}`,
        diskModifiedAt: '2026-07-14T01:30:00.000Z',
        fullStateHash: `sha256:${'9'.repeat(64)}`,
    };
    const older = metadata({
        id: 'draft-older',
        createdAt: '2026-07-14T01:50:00.000Z',
        fullStateHash: `sha256:${'3'.repeat(64)}`,
    });
    const newest = metadata({
        id: 'draft-newest',
        createdAt: '2026-07-14T02:10:00.000Z',
        fullStateHash: `sha256:${'4'.repeat(64)}`,
    });

    const first = selectLatestRecoveryDraftForSession(
        [older, newest],
        current,
        'C:/Projects/demo.maker',
        7,
        null,
    );
    assert.equal(first.suppressed, false);
    assert.equal(first.candidate?.id, newest.id, 'input ordering must not replace newest-first policy');
    assert.equal(first.sessionKey, recoveryOfferSessionKey(
        'C:/Projects/demo.maker',
        7,
        current.diskBaselineHash,
    ));

    const repeatedEffect = selectLatestRecoveryDraftForSession(
        [older, newest],
        { ...current, fullStateHash: newest.fullStateHash },
        'C:/Projects/demo.maker',
        7,
        first.sessionKey,
    );
    assert.equal(repeatedEffect.suppressed, true);
    assert.equal(repeatedEffect.candidate, null, 'an older draft must not become an automatic queue');

    const reopenedProject = selectLatestRecoveryDraftForSession(
        [older, newest],
        current,
        'C:/Projects/demo.maker',
        8,
        first.sessionKey,
    );
    assert.equal(reopenedProject.suppressed, false);
    assert.equal(reopenedProject.candidate?.id, newest.id);
    assert.notEqual(reopenedProject.sessionKey, first.sessionKey);
});

test('list, read, delete, discard, and baseline use only recovery-specific commands', async () => {
    calls.length = 0;
    invokeResponder = async command => {
        if (command === 'list_recovery_drafts') return [metadata()];
        if (command === 'load_recovery_draft') return { ...metadata(), ...stateVector() };
        if (command === 'get_project_recovery_baseline') return {
            projectPath: 'C:/Projects/demo.maker',
            projectId: 'project-1',
            sha256: `sha256:${'1'.repeat(64)}`,
            modifiedAt: '2026-07-14T01:00:00.000Z',
            byteSize: 10,
        };
        return undefined;
    };

    await listRecoveryDrafts(' C:/Projects/demo.maker ');
    await loadRecoveryDraft('C:/Projects/demo.maker', ' draft-1 ');
    await deleteRecoveryDraft('C:/Projects/demo.maker', ' draft-1 ');
    await discardProjectRecoveryDrafts('C:/Projects/demo.maker');
    await getProjectRecoveryBaseline('C:/Projects/demo.maker', 'project-1');

    assert.deepEqual(calls.map(([command]) => command), [
        'list_recovery_drafts',
        'load_recovery_draft',
        'delete_recovery_draft',
        'discard_project_recovery_drafts',
        'get_project_recovery_baseline',
    ]);
    assert.equal(calls.every(([command]) => !command.includes('checkpoint')), true);
    assert.equal(calls[1][1].draftId, 'draft-1');
    assert.equal(calls[2][1].draftId, 'draft-1');
});

test('invalid state is rejected before any native write', async () => {
    calls.length = 0;
    await assert.rejects(
        saveRecoveryDraft({
            projectPath: 'C:/Projects/demo.maker',
            ...stateVector(),
            workspaceJson: '[]',
        }),
        /Blockly 数据必须是 JSON 对象/,
    );
    await assert.rejects(
        saveRecoveryDraft({
            projectPath: 'C:/Projects/demo.maker',
            ...stateVector(),
            fqbn: '',
        }),
        /明确的板卡和完整 FQBN/,
    );
    assert.equal(calls.length, 0);
});

test('storage roots stay separate and recovery has no clean-shutdown dependency', async () => {
    const [rustSource, checkpointRustSource] = await Promise.all([
        readFile(rustSourcePath, 'utf8'),
        readFile(checkpointRustSourcePath, 'utf8'),
    ]);
    assert.match(rustSource, /app_data\.join\("recovery-drafts-v1"\)/);
    assert.match(checkpointRustSource, /app_data\.join\("project-checkpoints-v1"\)/);
    assert.doesNotMatch(rustSource, /project-checkpoints-v1/);
    assert.doesNotMatch(source, /clean_shutdown|cleanShutdown/);
    assert.doesNotMatch(rustSource, /clean_shutdown|cleanShutdown/);
});
