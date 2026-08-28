import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./BuildIssueCards.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'BuildIssueCards.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'BuildIssueCards.tsx should transpile without syntax errors');

test('renders an evidence-backed block error with reason, location, raw source and locate action', () => {
    assert.match(source, /“\$\{issue\.blockContext\.label\}”积木错误/);
    assert.match(source, />积木：</);
    assert.match(source, />位置：</);
    assert.match(source, />原因：</);
    assert.match(source, /issue\.sourceLine == null \? '原始诊断证据' : '原始源码证据'/);
    assert.match(source, /onLocateBlock\(issue\.blockContext!\.blockId\)/);
    assert.match(source, />定位积木</);
    assert.match(source, />建议：</);
});

test('keeps long compiler evidence readable and actions responsive in both themes', () => {
    assert.match(source, /whitespace-pre-wrap break-all/);
    assert.match(source, /flex flex-wrap items-center gap-1\.5/);
    assert.match(source, /dark:border-slate-700/);
    assert.match(source, /dark:text-slate-300/);
    assert.doesNotMatch(source, /className="[^"]*truncate[^"]*"[\s\S]*?issue\.evidence/);
});

test('keeps locate and remediation as independent operations', () => {
    assert.match(source, /issue\.blockContext && \(/);
    assert.match(source, /issue\.action && ActionIcon && \(/);
    assert.match(source, /onAction\(issue\.action!, issue\)/);
});
