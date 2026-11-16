import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import React, { act } from 'react';
import { createRoot } from 'react-dom/client';
import { renderToStaticMarkup } from 'react-dom/server';
import { JSDOM } from 'jsdom';
import ts from 'typescript';

const sourcePath = new URL('./CKConfirmDialog.tsx', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
        jsx: ts.JsxEmit.ReactJSX,
        esModuleInterop: true,
    },
    fileName: 'CKConfirmDialog.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'CKConfirmDialog.tsx should transpile without syntax errors');

const require = createRequire(import.meta.url);
const loadedModule = { exports: {} };
const translations = {
    'dialog.confirm.title': '确认操作',
    'dialog.confirm.warningTitle': '请确认风险',
    'dialog.confirm.dangerTitle': '确认危险操作',
    'common.actions.confirm': '确定',
    'common.actions.cancel': '取消',
    'common.status.processing': '正在处理…',
};
const customRequire = specifier => {
    if (specifier === 'react-i18next') {
        return { useTranslation: () => ({ t: key => translations[key] || key }) };
    }
    return require(specifier);
};
const evaluateCommonJs = new Function('require', 'module', 'exports', transpiled.outputText);
evaluateCommonJs(customRequire, loadedModule, loadedModule.exports);
const { CKConfirmDialog } = loadedModule.exports;

const baseProps = {
    open: true,
    message: '这项操作会修改当前内容。',
    onConfirm: () => undefined,
    onCancel: () => undefined,
};

const installDom = () => {
    const dom = new JSDOM(
        '<!doctype html><html><body><button id="opener">打开确认</button><div id="root"></div></body></html>',
        { url: 'http://localhost/', pretendToBeVisual: true },
    );
    const previous = new Map();
    const globals = {
        window: dom.window,
        document: dom.window.document,
        navigator: dom.window.navigator,
        HTMLElement: dom.window.HTMLElement,
        HTMLButtonElement: dom.window.HTMLButtonElement,
        HTMLTextAreaElement: dom.window.HTMLTextAreaElement,
        Event: dom.window.Event,
        KeyboardEvent: dom.window.KeyboardEvent,
        MouseEvent: dom.window.MouseEvent,
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

    const root = createRoot(dom.window.document.getElementById('root'));
    const cleanup = async () => {
        await act(async () => root.unmount());
        dom.window.close();
        for (const [key, value] of previous) {
            if (value === undefined) delete globalThis[key];
            else globalThis[key] = value;
        }
    };
    return { dom, root, cleanup };
};

const flushEffects = async (milliseconds = 10) => {
    await act(async () => {
        await new Promise(resolve => setTimeout(resolve, milliseconds));
    });
};

test('renders Chinese icon-and-text variants with accessible dialog roles', () => {
    const variants = [
        ['normal', '确认操作', 'dialog'],
        ['warning', '请确认风险', 'alertdialog'],
        ['danger', '确认危险操作', 'alertdialog'],
    ];
    for (const [tone, title, role] of variants) {
        const markup = renderToStaticMarkup(React.createElement(CKConfirmDialog, {
            ...baseProps,
            tone,
        }));
        assert.match(markup, new RegExp(`role="${role}"`));
        assert.match(markup, new RegExp(`data-ck-confirm-tone="${tone}"`));
        assert.match(markup, new RegExp(title));
        assert.match(markup, /data-ck-action="cancel-confirm"/);
        assert.match(markup, />取消</);
        assert.match(markup, /data-ck-action="submit-confirm"/);
        assert.match(markup, />确定</);
        assert.match(markup, /<svg/);
    }

    assert.equal(renderToStaticMarkup(React.createElement(CKConfirmDialog, {
        ...baseProps,
        open: false,
    })), '');
});

test('uses safe initial focus, traps Tab, handles Escape and restores focus', async () => {
    const { dom, root, cleanup } = installDom();
    try {
        const opener = dom.window.document.getElementById('opener');
        opener.focus();
        const cancelReasons = [];
        await act(async () => root.render(React.createElement(CKConfirmDialog, {
            ...baseProps,
            tone: 'danger',
            onCancel: reason => cancelReasons.push(reason),
        })));
        await flushEffects();

        const cancel = dom.window.document.querySelector('[data-ck-action="cancel-confirm"]');
        const confirm = dom.window.document.querySelector('[data-ck-action="submit-confirm"]');
        assert.equal(dom.window.document.activeElement, cancel, 'danger dialogs should focus Cancel');

        confirm.focus();
        confirm.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(dom.window.document.activeElement, cancel, 'Tab should wrap to the first action');

        cancel.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Tab',
            shiftKey: true,
            bubbles: true,
            cancelable: true,
        }));
        assert.equal(dom.window.document.activeElement, confirm, 'Shift+Tab should wrap backwards');

        dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
            key: 'Escape',
            bubbles: true,
            cancelable: true,
        }));
        assert.deepEqual(cancelReasons, ['escape']);

        await act(async () => root.render(React.createElement(CKConfirmDialog, {
            ...baseProps,
            open: false,
        })));
        await flushEffects();
        assert.equal(dom.window.document.activeElement, opener, 'focus should return to the opener');
        assert.equal(dom.window.document.body.style.overflow, '');
    } finally {
        await cleanup();
    }
});

test('Enter confirms once and pending state blocks duplicate submit and cancellation', async () => {
    const { dom, root, cleanup } = installDom();
    let releaseConfirmation;
    try {
        let confirmCalls = 0;
        const cancelReasons = [];
        const pendingConfirmation = new Promise(resolve => {
            releaseConfirmation = resolve;
        });

        await act(async () => root.render(React.createElement(CKConfirmDialog, {
            ...baseProps,
            tone: 'normal',
            onConfirm: () => {
                confirmCalls += 1;
                return pendingConfirmation;
            },
            onCancel: reason => cancelReasons.push(reason),
        })));
        await flushEffects();

        const confirm = dom.window.document.querySelector('[data-ck-action="submit-confirm"]');
        assert.equal(dom.window.document.activeElement, confirm, 'normal dialogs should focus Confirm');
        await act(async () => {
            confirm.click();
            confirm.click();
        });
        assert.equal(confirmCalls, 1, 'two clicks in the same tick must submit once');
        assert.equal(confirm.disabled, true);
        assert.match(confirm.textContent, /正在处理/);

        await act(async () => {
            dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Escape',
                bubbles: true,
                cancelable: true,
            }));
            dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }));
        });
        assert.deepEqual(cancelReasons, [], 'pending confirmation must ignore Escape');
        assert.equal(confirmCalls, 1, 'pending confirmation must ignore Enter');

        await act(async () => {
            releaseConfirmation();
            await pendingConfirmation;
        });
        await flushEffects();
        assert.equal(confirm.disabled, false);
        assert.match(confirm.textContent, /确定/);

        await act(async () => {
            dom.window.document.dispatchEvent(new dom.window.KeyboardEvent('keydown', {
                key: 'Enter',
                bubbles: true,
                cancelable: true,
            }));
            await Promise.resolve();
        });
        assert.equal(confirmCalls, 2, 'Enter should submit again after the prior action settles');
    } finally {
        releaseConfirmation?.();
        await flushEffects();
        await cleanup();
    }
});
