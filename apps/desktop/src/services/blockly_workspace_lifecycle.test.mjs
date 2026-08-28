import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const source = await readFile(new URL('./blockly_workspace_lifecycle.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'blockly_workspace_lifecycle.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, []);
const { disposeBlocklyWorkspaceLifecycle, prepareBlocklyWidgetDivForInjection } = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('refreshes Blockly shared widget div before reinjection without retaining old listeners', () => {
    const calls = [];
    const replacement = { id: 'clean-clone' };
    const parent = {
        replaceChild: (next, previous) => calls.push(['replace', next, previous]),
    };
    const current = {
        id: 'listener-owning-singleton',
        parentNode: parent,
        cloneNode: deep => {
            calls.push(['clone', deep]);
            return replacement;
        },
    };

    prepareBlocklyWidgetDivForInjection({
        hide: () => calls.push(['hide']),
        getDiv: () => current,
    });

    assert.deepEqual(calls, [
        ['hide'],
        ['clone', false],
        ['replace', replacement, current],
    ]);
});

test('widget div refresh remains fail-safe when no connected singleton exists', () => {
    assert.doesNotThrow(() => prepareBlocklyWidgetDivForInjection({
        hide: () => undefined,
        getDiv: () => null,
    }));
});

test('disposes the trashcan flyout and releases the owned global main workspace', () => {
    const calls = [];
    let mainWorkspace;
    const workspace = {
        trashcan: { flyout: null },
        dispose: () => calls.push('workspace'),
    };
    const flyout = {
        targetWorkspace: workspace,
        dispose: () => calls.push('flyout'),
    };
    workspace.trashcan.flyout = flyout;
    mainWorkspace = workspace;

    disposeBlocklyWorkspaceLifecycle(workspace, {
        getMainWorkspace: () => mainWorkspace,
        setMainWorkspace: value => {
            calls.push('main:null');
            mainWorkspace = value;
        },
    });

    assert.deepEqual(calls, ['flyout', 'workspace', 'main:null']);
    assert.equal(workspace.trashcan.flyout, null);
    assert.equal(mainWorkspace, null);
});

test('never clears a newer workspace installed while the old workspace disposes', () => {
    const replacement = { id: 'new-workspace' };
    let mainWorkspace;
    const workspace = {
        trashcan: null,
        dispose: () => { mainWorkspace = replacement; },
    };
    mainWorkspace = workspace;
    let clearCalls = 0;

    disposeBlocklyWorkspaceLifecycle(workspace, {
        getMainWorkspace: () => mainWorkspace,
        setMainWorkspace: () => { clearCalls += 1; },
    });

    assert.equal(mainWorkspace, replacement);
    assert.equal(clearCalls, 0);
});

test('does not dispose a flyout owned by a different live workspace', () => {
    const otherWorkspace = { id: 'other' };
    let flyoutDisposed = false;
    const workspace = {
        trashcan: {
            flyout: {
                targetWorkspace: otherWorkspace,
                dispose: () => { flyoutDisposed = true; },
            },
        },
        dispose: () => undefined,
    };

    disposeBlocklyWorkspaceLifecycle(workspace, {
        getMainWorkspace: () => null,
        setMainWorkspace: () => undefined,
    });

    assert.equal(flyoutDisposed, false);
    assert.notEqual(workspace.trashcan.flyout, null);
});

test('real Blockly fields and shortcuts remain usable after a second inject', async () => {
    const dom = new JSDOM(
        '<!doctype html><html><body><div id="first"></div><div id="second"></div></body></html>',
        { pretendToBeVisual: true, url: 'http://localhost/' },
    );
    const previousGlobals = new Map();
    const expose = (name, value) => {
        previousGlobals.set(name, Object.getOwnPropertyDescriptor(globalThis, name));
        Object.defineProperty(globalThis, name, {
            configurable: true,
            writable: true,
            value,
        });
    };
    const windowGlobals = [
        'window', 'document', 'navigator', 'Node', 'Element', 'HTMLElement', 'SVGElement',
        'HTMLInputElement', 'HTMLTextAreaElement', 'HTMLCanvasElement',
        'Event', 'FocusEvent', 'MouseEvent', 'KeyboardEvent', 'DOMParser', 'XMLSerializer',
        'MutationObserver', 'getComputedStyle', 'Image',
    ];
    for (const name of windowGlobals) {
        expose(name, name === 'window' ? dom.window : dom.window[name]);
    }
    expose('requestAnimationFrame', callback => setTimeout(() => callback(Date.now()), 0));
    expose('cancelAnimationFrame', timer => clearTimeout(timer));
    expose('ResizeObserver', class {
        observe() {}
        unobserve() {}
        disconnect() {}
    });
    if (!dom.window.PointerEvent) expose('PointerEvent', dom.window.MouseEvent);
    if (!dom.window.SVGElement.prototype.getBBox) {
        dom.window.SVGElement.prototype.getBBox = () => ({ x: 0, y: 0, width: 120, height: 40 });
    }
    if (!dom.window.SVGElement.prototype.getScreenCTM) {
        dom.window.SVGElement.prototype.getScreenCTM = () => ({
            a: 1, b: 0, c: 0, d: 1, e: 0, f: 0,
            inverse() { return this; },
        });
    }
    dom.window.HTMLCanvasElement.prototype.getContext = () => ({
        measureText: text => ({ width: String(text || '').length * 8 }),
    });

    let firstWorkspace;
    let secondWorkspace;
    let BlocklyApi;
    try {
        const Blockly = await import('blockly');
        BlocklyApi = Blockly;
        await import('blockly/blocks');
        const injectionOptions = {
            renderer: 'zelos',
            toolbox: { kind: 'flyoutToolbox', contents: [] },
            trashcan: false,
            sounds: false,
        };

        firstWorkspace = Blockly.inject(document.getElementById('first'), injectionOptions);
        const firstWidgetDiv = Blockly.WidgetDiv.getDiv();
        firstWorkspace.dispose();
        prepareBlocklyWidgetDivForInjection(Blockly.WidgetDiv);
        secondWorkspace = Blockly.inject(document.getElementById('second'), injectionOptions);

        const secondWidgetDiv = Blockly.WidgetDiv.getDiv();
        assert.ok(secondWidgetDiv?.isConnected);
        assert.notEqual(secondWidgetDiv, firstWidgetDiv, 'reinject must adopt the listener-free clone');

        const numberBlock = secondWorkspace.newBlock('math_number');
        numberBlock.initSvg();
        numberBlock.render();
        await Blockly.renderManagement.finishQueuedRenders();
        const numberField = numberBlock.getField('NUM');
        numberField.showEditor_();
        const numberInput = secondWidgetDiv.querySelector('input.blocklyHtmlInput');
        assert.ok(numberInput, 'number field must mount its editor into the adopted widget div');
        numberInput.value = '42';
        numberInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        numberInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
        }));
        Blockly.WidgetDiv.hide();
        assert.equal(String(numberField.getValue()), '42');

        const textBlock = secondWorkspace.newBlock('text');
        textBlock.initSvg();
        textBlock.render();
        await Blockly.renderManagement.finishQueuedRenders();
        const textField = textBlock.getField('TEXT');
        textField.showEditor_();
        const textInput = secondWidgetDiv.querySelector('input.blocklyHtmlInput');
        assert.ok(textInput, 'text field must remain editable after reinjection');
        textInput.value = 'CK reinjected';
        textInput.dispatchEvent(new dom.window.Event('input', { bubbles: true }));
        textInput.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Enter',
            bubbles: true,
        }));
        Blockly.WidgetDiv.hide();
        assert.equal(textField.getValue(), 'CK reinjected');

        const compareBlock = secondWorkspace.newBlock('logic_compare');
        compareBlock.initSvg();
        compareBlock.render();
        await Blockly.renderManagement.finishQueuedRenders();
        const dropdown = compareBlock.getField('OP');
        assert.doesNotThrow(() => dropdown.showEditor_());
        assert.ok(
            document.querySelectorAll('.blocklyDropDownDiv .blocklyMenuItem').length >= 1,
            'dropdown menu must still render after reinjection',
        );
        Blockly.DropDownDiv.hideWithoutAnimation();

        assert.doesNotThrow(() => secondWidgetDiv.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'z',
            ctrlKey: true,
            bubbles: true,
        })));
    } finally {
        try { BlocklyApi?.DropDownDiv.hideWithoutAnimation(); } catch {}
        try { BlocklyApi?.WidgetDiv.hide(); } catch {}
        try { secondWorkspace?.dispose(); } catch {}
        try { firstWorkspace?.dispose(); } catch {}
        try { await BlocklyApi?.renderManagement.finishQueuedRenders(); } catch {}
        await new Promise(resolve => setTimeout(resolve, 20));
        dom.window.close();
        for (const [name, descriptor] of previousGlobals) {
            if (descriptor) Object.defineProperty(globalThis, name, descriptor);
            else delete globalThis[name];
        }
    }
});
