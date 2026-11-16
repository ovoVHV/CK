import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_trace_visuals.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_trace_visuals.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(
    syntaxErrors,
    [],
    'block_trace_visuals.ts should transpile without syntax errors',
);

const { refreshBlockTraceVisuals } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const createRoot = () => {
    const classes = new Set();
    const attributes = new Map();
    return {
        classes,
        attributes,
        classList: {
            toggle(name, force) {
                if (force) classes.add(name);
                else classes.delete(name);
                return Boolean(force);
            },
        },
        setAttribute(name, value) {
            attributes.set(name, value);
        },
        removeAttribute(name) {
            attributes.delete(name);
        },
        getAttribute(name) {
            return attributes.get(name) ?? null;
        },
    };
};

const createWorkspace = (...ids) => {
    const roots = new Map(ids.map(id => [id, createRoot()]));
    return {
        roots,
        getAllBlocks() {
            return ids.map(id => ({
                id,
                getSvgRoot: () => roots.get(id),
            }));
        },
    };
};

const snapshot = {
    stats: [
        { blockId: 'covered-old', label: '旧采样', covered: true, sampledHits: 2 },
        { blockId: 'pending', label: '尚未采样', covered: false, sampledHits: 0 },
        { blockId: 'covered-latest', label: '最新采样', covered: true, sampledHits: 5 },
    ],
    recent: [
        { blockId: 'covered-latest' },
        { blockId: 'covered-old' },
        { blockId: 'covered-latest' },
    ],
};

test('marks covered and pending blocks while only the last sampled block is current', () => {
    const workspace = createWorkspace(
        'covered-old',
        'pending',
        'covered-latest',
        'not-tracked',
    );

    refreshBlockTraceVisuals(workspace, snapshot);

    const old = workspace.roots.get('covered-old');
    assert.equal(old.classes.has('ck-block-trace-covered'), true);
    assert.equal(old.classes.has('ck-block-trace-pending'), false);
    assert.equal(old.classes.has('ck-block-trace-current'), false);
    assert.equal(old.getAttribute('data-ck-trace-hits'), '2');
    assert.equal(old.getAttribute('data-ck-trace-label'), '旧采样，采样命中 2 次');

    const pending = workspace.roots.get('pending');
    assert.equal(pending.classes.has('ck-block-trace-covered'), false);
    assert.equal(pending.classes.has('ck-block-trace-pending'), true);
    assert.equal(pending.classes.has('ck-block-trace-current'), false);
    assert.equal(pending.getAttribute('data-ck-trace-hits'), '0');
    assert.equal(pending.getAttribute('data-ck-trace-label'), '尚未采样，尚未采样命中');

    const latest = workspace.roots.get('covered-latest');
    assert.equal(latest.classes.has('ck-block-trace-covered'), true);
    assert.equal(latest.classes.has('ck-block-trace-pending'), false);
    assert.equal(latest.classes.has('ck-block-trace-current'), true);

    const untracked = workspace.roots.get('not-tracked');
    assert.deepEqual([...untracked.classes], []);
    assert.equal(untracked.getAttribute('data-ck-trace-hits'), null);
    assert.equal(untracked.getAttribute('data-ck-trace-label'), null);
});

test('snapshot null clears all trace classes and data attributes', () => {
    const workspace = createWorkspace('covered-old', 'pending', 'covered-latest');
    refreshBlockTraceVisuals(workspace, snapshot);
    refreshBlockTraceVisuals(workspace, null);

    for (const root of workspace.roots.values()) {
        assert.equal(root.classes.has('ck-block-trace-covered'), false);
        assert.equal(root.classes.has('ck-block-trace-pending'), false);
        assert.equal(root.classes.has('ck-block-trace-current'), false);
        assert.equal(root.getAttribute('data-ck-trace-hits'), null);
        assert.equal(root.getAttribute('data-ck-trace-label'), null);
    }
});
