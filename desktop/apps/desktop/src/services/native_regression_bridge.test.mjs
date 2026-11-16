import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./native_regression_bridge.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const workspaceSource = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'native_regression_bridge.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
    'native_regression_bridge.ts should transpile without syntax errors',
);

const bridgeService = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);
const {
    CK_NATIVE_REGRESSION_BRIDGE_NAME,
    installNativeRegressionBridge,
} = bridgeService;

test('exposes only a frozen, page-local current-context reader', () => {
    const host = {};
    const Blockly = { marker: 'blockly' };
    const workspace = { marker: 'workspace' };
    const remove = installNativeRegressionBridge(host, Blockly, workspace);
    const descriptor = Object.getOwnPropertyDescriptor(host, CK_NATIVE_REGRESSION_BRIDGE_NAME);
    const bridge = host[CK_NATIVE_REGRESSION_BRIDGE_NAME];

    assert.deepEqual(Object.keys(bridge).sort(), ['getCurrent', 'schemaVersion']);
    assert.equal(Object.isFrozen(bridge), true);
    assert.equal(descriptor.enumerable, false);
    assert.equal(descriptor.writable, false);
    assert.equal(descriptor.configurable, true);
    assert.deepEqual(bridge.getCurrent(), { Blockly, workspace });
    assert.equal(Object.isFrozen(bridge.getCurrent()), true);
    assert.equal('evaluate' in bridge, false);
    assert.equal('invoke' in bridge, false);
    assert.equal('fetch' in bridge, false);

    remove();
    assert.equal(bridge.getCurrent(), null, 'a captured bridge must become inactive on unmount');
    assert.equal(CK_NATIVE_REGRESSION_BRIDGE_NAME in host, false);
});

test('old cleanup cannot remove the bridge owned by a newer workspace', () => {
    const host = {};
    const removeFirst = installNativeRegressionBridge(host, { generation: 1 }, { generation: 1 });
    const first = host[CK_NATIVE_REGRESSION_BRIDGE_NAME];
    const removeSecond = installNativeRegressionBridge(host, { generation: 2 }, { generation: 2 });
    const second = host[CK_NATIVE_REGRESSION_BRIDGE_NAME];

    removeFirst();
    assert.equal(first.getCurrent(), null);
    assert.equal(host[CK_NATIVE_REGRESSION_BRIDGE_NAME], second);
    assert.equal(second.getCurrent().workspace.generation, 2);

    removeSecond();
    assert.equal(CK_NATIVE_REGRESSION_BRIDGE_NAME in host, false);
});

test('Workspace installs the bridge and revokes it before lifecycle-safe Blockly disposal', () => {
    assert.match(workspaceSource, /installNativeRegressionBridge\(window, Blockly, ws\)/);
    assert.match(workspaceSource, /const removeNativeRegressionBridge = installNativeRegressionBridge/);
    assert.ok(
        workspaceSource.indexOf('removeNativeRegressionBridge();') < workspaceSource.indexOf('disposeBlocklyWorkspaceLifecycle(ws'),
        'the page-global handle must be revoked before Blockly is disposed',
    );
});
