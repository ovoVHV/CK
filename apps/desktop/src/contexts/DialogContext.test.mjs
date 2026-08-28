import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const sourcePath = new URL('./DialogContext.tsx', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
    },
    fileName: 'DialogContext.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'DialogContext.tsx should transpile without syntax errors');

const require = createRequire(import.meta.url);
const loadedModule = { exports: {} };
const customRequire = (specifier) => {
    if (specifier === '../components/ui/CKConfirmDialog') {
        return { CKConfirmDialog: () => null };
    }
    return require(specifier);
};
const evaluateCommonJs = new Function('require', 'module', 'exports', transpiled.outputText);
evaluateCommonJs(customRequire, loadedModule, loadedModule.exports);
const { DialogProvider, useDialog } = loadedModule.exports;

const installDom = () => {
    const dom = new JSDOM(
        '<!doctype html><html><body><button id="opener">打开弹窗</button><div id="root"></div></body></html>',
        { url: 'http://localhost/', pretendToBeVisual: true },
    );
    const previous = new Map();
    const globals = {
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
        HTMLInputElement: dom.window.HTMLInputElement,
        KeyboardEvent: dom.window.KeyboardEvent,
        Event: dom.window.Event,
        Node: dom.window.Node,
        getComputedStyle: dom.window.getComputedStyle,
        IS_REACT_ACT_ENVIRONMENT: true,
    };
    for (const [key, value] of Object.entries(globals)) {
        previous.set(key, globalThis[key]);
        globalThis[key] = value;
    }
    dom.window.requestAnimationFrame = callback => dom.window.setTimeout(
        () => callback(dom.window.performance.now()),
        0,
    );
    dom.window.cancelAnimationFrame = handle => dom.window.clearTimeout(handle);
    // React's legacy input-event fallback is selected because react-dom is
    // imported before jsdom exists. These no-ops mirror the old IE surface it
    // probes and keep focus tests representative without browser-only errors.
    dom.window.HTMLElement.prototype.attachEvent = () => undefined;
    dom.window.HTMLElement.prototype.detachEvent = () => undefined;

    let dialogApi;
    const CaptureApi = () => {
        dialogApi = useDialog();
        return null;
    };
    const root = createRoot(dom.window.document.getElementById('root'));
    const renderProvider = async () => {
        await act(async () => root.render(
            React.createElement(DialogProvider, null, React.createElement(CaptureApi)),
        ));
    };
    const cleanup = async () => {
        await act(async () => root.unmount());
        dom.window.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    };
    return { dom, getDialogApi: () => dialogApi, renderProvider, cleanup };
};

const flushEffects = async (milliseconds = 10) => {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, milliseconds));
    });
};

test('alert uses Chinese accessible UI, dark styles, Escape, and focus restoration', async () => {
    const { dom, getDialogApi, renderProvider, cleanup } = installDom();
    try {
        await renderProvider();
        const opener = dom.window.document.getElementById('opener');
        opener.focus();

        let alertPromise;
        await act(async () => {
            alertPromise = getDialogApi().alert({
                type: 'warning',
                message: '清除后需要重新编译。',
            });
        });
        await flushEffects();

        const modal = dom.window.document.querySelector('[data-ck-role="message-dialog"]');
        const submit = dom.window.document.querySelector('[data-ck-action="submit-dialog"]');
        assert.equal(modal.getAttribute('role'), 'alertdialog');
        assert.equal(modal.getAttribute('aria-modal'), 'true');
        assert.ok(modal.getAttribute('aria-labelledby'));
        assert.ok(modal.getAttribute('aria-describedby'));
        assert.match(modal.textContent, /请注意/);
        assert.match(submit.textContent, /知道了/);
        assert.ok(submit.querySelector('svg'), 'action should include an icon and text');
        assert.match(modal.className, /dark:bg-slate-900/);
        assert.equal(dom.window.document.activeElement, submit);
        assert.equal(dom.window.document.body.style.overflow, 'hidden');

        await act(async () => {
            dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
            await alertPromise;
        });
        await flushEffects();
        assert.equal(dom.window.document.querySelector('[data-ck-role="message-dialog"]'), null);
        assert.equal(dom.window.document.activeElement, opener);
        assert.equal(dom.window.document.body.style.overflow, '');
    } finally {
        await cleanup();
    }
});

test('prompt labels its input, traps focus, confirms with Enter, and cancels with Escape', async () => {
    const { dom, getDialogApi, renderProvider, cleanup } = installDom();
    try {
        await renderProvider();

        let promptPromise;
        await act(async () => {
            promptPromise = getDialogApi().prompt({
                message: '请填写新的工程名称。',
                defaultValue: '旧名称',
                placeholder: '例如：温度监测',
                inputLabel: '工程名称',
            });
        });
        await flushEffects();

        const modal = dom.window.document.querySelector('[data-ck-role="message-dialog"]');
        const input = modal.querySelector('input');
        const cancel = modal.querySelector('[data-ck-action="cancel-dialog"]');
        const submit = modal.querySelector('[data-ck-action="submit-dialog"]');
        const label = modal.querySelector(`label[for="${input.id}"]`);
        assert.equal(modal.getAttribute('role'), 'dialog');
        assert.equal(input.value, '旧名称');
        assert.equal(input.placeholder, '例如：温度监测');
        assert.equal(label.textContent.trim(), '工程名称');
        assert.match(cancel.textContent, /取消/);
        assert.match(submit.textContent, /确定/);
        assert.equal(dom.window.document.activeElement, input);

        input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(dom.window.document.activeElement, submit, 'Shift+Tab should wrap to the last action');
        submit.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(dom.window.document.activeElement, input, 'Tab should wrap back to the input');

        const valueSetter = Object.getOwnPropertyDescriptor(
            dom.window.HTMLInputElement.prototype,
            'value',
        ).set;
        await act(async () => {
            valueSetter.call(input, '新名称');
            input.dispatchEvent(new dom.window.KeyboardEvent('keyup', {
                key: '字',
                bubbles: true,
                cancelable: true,
            }));
        });
        await act(async () => {
            input.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }));
        });
        assert.equal(await promptPromise, '新名称');
        assert.equal(dom.window.document.querySelector('[data-ck-role="message-dialog"]'), null);

        let cancelledPrompt;
        await act(async () => {
            cancelledPrompt = getDialogApi().prompt('不会保存这次输入。');
        });
        await flushEffects();
        await act(async () => {
            dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
        });
        assert.equal(await cancelledPrompt, null);
    } finally {
        await cleanup();
    }
});
