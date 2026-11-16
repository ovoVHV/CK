import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = await readFile(new URL('./blockly_overlay_lifecycle.ts', import.meta.url), 'utf8');
const { outputText } = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
});
const { installBlocklyOverlayLifecycle } = await import(
    `data:text/javascript;base64,${Buffer.from(outputText).toString('base64')}`
);

test('real Blockly editor finishes when CK takes over, preserving value, undo and focus', async t => {
    const dom = new JSDOM('<!doctype html><body><button id="library">Libraries</button><input id="search"><div id="workspace"></div></body>', {
        pretendToBeVisual: true, url: 'http://localhost/',
    });
    const previous = new Map();
    const expose = (name, value) => {
        previous.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, { configurable: true, writable: true, value });
    };
    for (const name of [
        'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement',
        'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement', 'Event', 'FocusEvent',
        'MouseEvent', 'KeyboardEvent', 'DOMParser', 'XMLSerializer', 'MutationObserver', 'getComputedStyle', 'Image',
    ]) expose(name, name === 'window' ? dom.window : dom.window[name]);
    expose('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 0));
    expose('cancelAnimationFrame', clearTimeout);
    expose('PointerEvent', dom.window.MouseEvent);
    expose('ResizeObserver', class { observe() {} unobserve() {} disconnect() {} });
    dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 40 });
    dom.window.SVGElement.prototype.getScreenCTM = () => ({ a: 1, b: 0, c: 0, d: 1, e: 0, f: 0, inverse() { return this; } });
    dom.window.HTMLCanvasElement.prototype.getContext = () => ({ measureText: value => ({ width: String(value).length * 8 }) });
    const settle = () => new Promise(resolve => setTimeout(resolve, 30));
    let Blockly, ws, remove;
    try {
        Blockly = await import('blockly');
        await import('blockly/blocks');
        ws = Blockly.inject(document.getElementById('workspace'), {
            renderer: 'zelos', toolbox: { kind: 'flyoutToolbox', contents: [] }, trashcan: false, sounds: false,
        });
        const block = ws.newBlock('math_number');
        block.initSvg(); block.render();
        await Blockly.renderManagement.finishQueuedRenders();
        await settle();
        const field = block.getField('NUM');
        const search = document.getElementById('search');
        const library = document.getElementById('library');
        const input = () => Blockly.WidgetDiv.getDiv().querySelector('input.blocklyHtmlInput');
        const edit = value => {
            field.showEditor_();
            assert.ok(input());
            input().value = value;
            input().dispatchEvent(new Event('input', { bubbles: true }));
        };
        const pointer = element => element.dispatchEvent(new MouseEvent('pointerdown', { bubbles: true }));

        await t.test('reproduces the unclosed numeric widget before installing the fix', () => {
            edit('140');
            pointer(library);
            search.focus();
            assert.ok(input(), 'Blockly alone leaves the numeric editor above the app');
            Blockly.WidgetDiv.hide();
        });
        remove = installBlocklyOverlayLifecycle(Blockly, document);

        await t.test('outside pointer commits once before a toolbar action and remains undoable', async () => {
            await settle(); ws.clearUndo();
            edit('141');
            pointer(input());
            assert.ok(input(), 'editing inside the widget must stay open');
            pointer(library);
            assert.equal(input(), null);
            assert.equal(field.getValue(), 141);
            await settle();
            ws.undo(false);
            assert.equal(field.getValue(), 140, 'one undo restores the pre-edit value');
        });

        await t.test('external focus closes the widget without stealing the search caret', () => {
            edit('142');
            search.focus();
            assert.equal(input(), null);
            assert.equal(document.activeElement, search);
            search.value = 'servo.';
            search.dispatchEvent(new Event('input', { bubbles: true }));
            assert.equal(field.getValue(), 142);
            assert.equal(search.value, 'servo.');
        });

        await t.test('programmatic modal mounting closes even without a pointer or autofocus', async () => {
            edit('143');
            const modal = document.createElement('section');
            modal.innerHTML = '<div role="dialog" aria-modal="true"><span>Library manager</span></div>';
            document.body.append(modal);
            await settle();
            assert.equal(input(), null);
            assert.equal(field.getValue(), 143);
            // Exercise a real second workspace inside an existing dialog.
            // Normal updates must not terminate that preview's editor.
            const previewHost = document.createElement('div');
            modal.querySelector('[role="dialog"]').append(previewHost);
            const preview = Blockly.inject(previewHost, { renderer: 'zelos', sounds: false, trashcan: false });
            try {
                const previewBlock = preview.newBlock('math_number');
                previewBlock.initSvg(); previewBlock.render();
                await Blockly.renderManagement.finishQueuedRenders();
                await settle();
                const previewField = previewBlock.getField('NUM');
                previewField.showEditor_();
                input().value = '77';
                input().dispatchEvent(new Event('input', { bubbles: true }));
                pointer(input());
                modal.querySelector('span').textContent = 'Updated search results';
                await settle();
                assert.ok(input(), 'a Blockly preview inside a dialog must remain editable');
                pointer(search);
                assert.equal(input(), null);
                assert.equal(previewField.getValue(), 77);
            } finally {
                Blockly.WidgetDiv.hide();
                preview.dispose();
                Blockly.common.setMainWorkspace(ws);
            }
            modal.remove();
        });

        await t.test('window blur closes and commits the editor', () => {
            edit('144');
            window.dispatchEvent(new Event('blur'));
            assert.equal(input(), null);
            assert.equal(field.getValue(), 144);
        });

        await t.test('Enter commits and Escape still cancels using Blockly semantics', () => {
            edit('145');
            input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Enter', bubbles: true }));
            assert.equal(input(), null);
            assert.equal(field.getValue(), 145);
            edit('999');
            input().dispatchEvent(new KeyboardEvent('keydown', { key: 'Escape', bubbles: true }));
            assert.equal(input(), null);
            assert.equal(field.getValue(), 145);
        });

        await t.test('dropdown options remain interactive until an outside action', async () => {
            const compare = ws.newBlock('logic_compare');
            compare.initSvg(); compare.render();
            await Blockly.renderManagement.finishQueuedRenders();
            compare.getField('OP').showEditor_();
            const option = document.querySelector('.blocklyDropDownDiv .blocklyMenuItem');
            assert.ok(option);
            pointer(option);
            assert.equal(Blockly.DropDownDiv.isVisible(), true);
            pointer(library);
            assert.equal(Blockly.DropDownDiv.isVisible(), false);
        });

        await t.test('unmount removes document/window listeners and modal observation', async () => {
            remove(); remove = null;
            edit('146');
            pointer(library);
            search.focus();
            window.dispatchEvent(new Event('blur'));
            const modal = document.createElement('div');
            modal.setAttribute('role', 'dialog'); modal.setAttribute('aria-modal', 'true');
            document.body.append(modal);
            await settle();
            assert.ok(input(), 'no listener from the unmounted workspace remains');
            modal.remove();
        });
    } finally {
        remove?.();
        Blockly?.DropDownDiv.hideWithoutAnimation();
        Blockly?.WidgetDiv.hide();
        ws?.dispose();
        await Blockly?.renderManagement.finishQueuedRenders();
        await settle();
        dom.window.close();
        for (const [name, descriptor] of previous) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});
