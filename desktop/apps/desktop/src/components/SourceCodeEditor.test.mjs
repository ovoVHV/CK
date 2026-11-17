import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import { build } from 'esbuild';
import { JSDOM } from 'jsdom';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { EditorView } from '@codemirror/view';
import { undo } from '@codemirror/commands';
import { diagnosticCount } from '@codemirror/lint';

const dom = new JSDOM('<div id="root"></div>', { pretendToBeVisual: true, url: 'http://localhost' });
for (const key of ['window','Window','document','HTMLElement','Element','Node','MutationObserver','Range','getComputedStyle']) globalThis[key] = dom.window[key];
const runtimeErrors = []; dom.window.addEventListener('error', event => runtimeErrors.push(event.error));
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: dom.window.navigator });
globalThis.requestAnimationFrame = dom.window.requestAnimationFrame.bind(dom.window);
globalThis.cancelAnimationFrame = dom.window.cancelAnimationFrame.bind(dom.window);
globalThis.ResizeObserver = class { observe() {} disconnect() {} unobserve() {} };
dom.window.Range.prototype.getClientRects = () => [];
dom.window.Range.prototype.getBoundingClientRect = () => ({ top: 0, left: 0, right: 0, bottom: 0, height: 0, width: 0 });
globalThis.IS_REACT_ACT_ENVIRONMENT = true;
const output = new URL(`./.source-editor-test-${process.pid}.mjs`, import.meta.url);
await build({ entryPoints: [new URL('./SourceCodeEditor.tsx', import.meta.url).pathname.replace(/^\/([A-Z]:)/, '$1')], outfile: output.pathname.replace(/^\/([A-Z]:)/, '$1'), bundle: true, packages: 'external', platform: 'node', format: 'esm', jsx: 'automatic', logLevel: 'silent' });
const { SourceCodeEditor } = await import(output.href);
await fs.unlink(output);

test('real editor keeps edits and undo across theme/readonly changes, and isolates documents', async () => {
    const root = createRoot(document.getElementById('root'));
    const changes = [], rejected = [];
    let props = { code: 'void setup() {}\nvoid loop() {}', documentKey: 'a', dark: false, readOnly: false, diagnostics: [], reveal: null,
        onChange: code => changes.push(code), onSave() {}, onBuild() {}, onCursor() {}, onRejectedEdit: reason => rejected.push(reason) };
    const render = async update => { props = { ...props, ...update }; await act(async () => root.render(React.createElement(SourceCodeEditor, props))); };
    const current = () => EditorView.findFromDOM(document.querySelector('.cm-editor'));
    try {
        await render({});
        await act(async () => current().dispatch({ changes: { from: 0, insert: '// 中文源码\n' } }));
        const edited = changes.at(-1); assert.ok(edited.startsWith('// 中文源码'));
        await render({ code: edited, dark: true, readOnly: true });
        assert.equal(current().state.doc.toString(), edited); assert.equal(current().state.readOnly, true);
        await render({ readOnly: false });
        await act(async () => current().contentDOM.dispatchEvent(new dom.window.KeyboardEvent('keydown', { key: 'h', code: 'KeyH', ctrlKey: true, bubbles: true })));
        assert.ok(document.querySelector('.cm-search input[name="replace"]'));
        await act(async () => { assert.equal(undo(current()), true); });
        assert.equal(current().state.doc.toString(), 'void setup() {}\nvoid loop() {}');
        await render({ documentKey: 'b', code: 'void setup() { bad(); }\nvoid loop() {}', diagnostics: [{ line: 1, column: 16, severity: 'error', message: 'bad not declared' }] });
        assert.equal(undo(current()), false); assert.equal(diagnosticCount(current().state), 1);
        await render({ reveal: { line: 1, column: 16, sequence: 1 } });
        assert.equal(current().state.selection.main.head, 15);
        await act(async () => current().dispatch({ changes: { from: 0, insert: '中'.repeat(400000) } }));
        assert.equal(current().state.doc.toString(), props.code); assert.match(rejected.at(-1), /1 MiB/);
        await render({ diagnostics: [] }); assert.equal(diagnosticCount(current().state), 0);
        assert.deepEqual(runtimeErrors, []);
    } finally { await act(async () => root.unmount()); dom.window.close(); }
});
