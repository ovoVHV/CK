import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import * as Blockly from 'blockly';
import ts from 'typescript';

const sourcePath = new URL('./blockly_change_guard.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'blockly_change_guard.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'blockly_change_guard.ts should transpile without syntax errors');

const guard = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const {
    hasGeneratedCodeChanged,
    resolveCompileSource,
    shouldProcessBlocklyContentEvent,
} = guard;

test('ignores Blockly 12 UI events regardless of their concrete event type', () => {
    for (const type of ['selected', 'click', 'marker_move', 'toolbox_item_select', 'theme_change']) {
        assert.equal(shouldProcessBlocklyContentEvent({ type, isUiEvent: true }), false, type);
    }
    assert.equal(shouldProcessBlocklyContentEvent({ type: 'ui' }), false);
    assert.equal(shouldProcessBlocklyContentEvent({ type: 'viewport_change' }), false);
});

test('recognizes real Blockly 12 UI and non-content event instances', () => {
    for (const event of [
        new Blockly.Events.Selected(),
        new Blockly.Events.Click(),
        new Blockly.Events.BlockDrag(),
        new Blockly.Events.ViewportChange(),
        new Blockly.Events.ToolboxItemSelect(),
    ]) {
        assert.equal(event.isUiEvent, true, event.type);
        assert.equal(shouldProcessBlocklyContentEvent(event), false, event.type);
    }

    const finishedLoading = new Blockly.Events.FinishedLoading();
    assert.equal(finishedLoading.isUiEvent, false);
    assert.equal(shouldProcessBlocklyContentEvent(finishedLoading), false);

    const intermediateChange = new Blockly.Events.BlockFieldIntermediateChange();
    assert.equal(intermediateChange.isUiEvent, false);
    assert.equal(shouldProcessBlocklyContentEvent(intermediateChange), false);
});

test('ignores workspace loading and intermediate field events', () => {
    assert.equal(shouldProcessBlocklyContentEvent({ type: 'finished_loading', isUiEvent: false }), false);
    assert.equal(shouldProcessBlocklyContentEvent({ type: 'block_field_intermediate_change', isUiEvent: false }), false);
    assert.equal(shouldProcessBlocklyContentEvent(null), false);
    assert.equal(shouldProcessBlocklyContentEvent({}), false);
});

test('keeps real workspace content events for code and dirty-state evaluation', () => {
    for (const type of ['create', 'delete', 'change', 'move', 'var_rename', 'comment_change']) {
        assert.equal(shouldProcessBlocklyContentEvent({ type, isUiEvent: false }), true, type);
    }
});

test('only reports an actual generated-code change', () => {
    assert.equal(hasGeneratedCodeChanged('void loop() {}', 'void loop() {}'), false);
    assert.equal(hasGeneratedCodeChanged('void loop() {}', 'void loop() { delay(1); }'), true);
});

test('compile source follows the current workspace instead of stale preview state', () => {
    const workspace = { code: '#include <WiFi.h>\nvoid loop() { delay(1000); }' };
    let generated = 0;
    const source = resolveCompileSource(
        undefined,
        workspace,
        current => {
            generated += 1;
            return current.code;
        },
        '// stale pre-load source',
    );

    assert.equal(source, workspace.code);
    assert.equal(generated, 1);
});

test('instrumented source override wins exactly, including an empty override', () => {
    let generated = 0;
    const source = resolveCompileSource(
        '',
        { code: 'workspace code' },
        current => {
            generated += 1;
            return current.code;
        },
        'fallback code',
    );

    assert.equal(source, '');
    assert.equal(generated, 0);
});

test('compile source falls back only before a workspace exists', () => {
    assert.equal(
        resolveCompileSource(undefined, null, () => 'unreachable', 'preview fallback'),
        'preview fallback',
    );
});
