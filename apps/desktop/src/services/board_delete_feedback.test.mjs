import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const helperSource = await readFile(new URL('./board_delete_feedback.ts', import.meta.url), 'utf8');
const managerSource = await readFile(new URL('./board_manager.ts', import.meta.url), 'utf8');
const selectorSource = await readFile(new URL('../components/BoardSelector.tsx', import.meta.url), 'utf8');

const transpiled = ts.transpileModule(helperSource, {
    compilerOptions: {
        module: ts.ModuleKind.CommonJS,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'board_delete_feedback.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'board_delete_feedback.ts should transpile without syntax errors');
const helperModule = { exports: {} };
new Function('module', 'exports', transpiled.outputText)(helperModule, helperModule.exports);
const { summarizeBoardDeletionWarnings } = helperModule.exports;

test('ordinary successful deletion log stays a compact success', () => {
    assert.equal(summarizeBoardDeletionWarnings([
        "Removed board package 'vendor_board'.",
        "Removed 2 learned compile target(s) for 'vendor:arch:board'.",
    ].join('\n')), null);
    assert.equal(summarizeBoardDeletionWarnings(''), null);
    assert.equal(summarizeBoardDeletionWarnings(undefined), null);
});

test('English and Chinese cleanup warnings remain visible and readable', () => {
    assert.equal(
        summarizeBoardDeletionWarnings([
            "Removed board package 'vendor_board'.",
            'Warning: installed-board synchronization failed after deletion: Arduino CLI unavailable',
            '警告：旧库目录清理失败，请稍后手动检查',
        ].join('\n')),
        'installed-board synchronization failed after deletion: Arduino CLI unavailable；旧库目录清理失败，请稍后手动检查',
    );
});

test('warning summary is deduplicated and bounded for the transient toast', () => {
    const longReason = `Warning: ${'x'.repeat(200)}`;
    const summary = summarizeBoardDeletionWarnings([
        longReason,
        longReason,
        'WARNING: second warning',
        'Warning: third warning',
    ].join('\n'));
    assert.ok(summary);
    assert.match(summary, /…；second warning（另有 1 条）$/);
    assert.ok(summary.length < 150, `summary should stay compact, got ${summary.length}`);
});

test('board manager preserves the backend log and backend rejection remains an exception', () => {
    assert.match(managerSource, /const result = await invoke<string>\('uninstall_board', \{ boardId \}\)/);
    assert.match(managerSource, /return typeof result === 'string' \? result : String\(result \?\? ''\)/);
    assert.match(managerSource, /catch \(e: any\)[\s\S]*throw new Error\(e\.toString\(\)\)/);
});

test('board selector distinguishes warning success, clean success, and backend failure', () => {
    assert.match(selectorSource, /const deletionLog = await BoardManager\.deleteBoard\(id\)/);
    assert.match(selectorSource, /const warningSummary = summarizeBoardDeletionWarnings\(deletionLog\)/);
    assert.match(selectorSource, /if \(warningSummary\)[\s\S]*板卡已删除，但部分清理有警告：\$\{warningSummary\}[\s\S]*"info"/);
    assert.match(selectorSource, /else \{[\s\S]*showToast\(`已删除 '\$\{name\}'`, "success"\)/);
    assert.match(selectorSource, /catch \(e\)[\s\S]*showToast\(`删除失败：\$\{e\}`, "error"\)/);
    assert.doesNotMatch(selectorSource, /await BoardManager\.deleteBoard\(id\);\s*\n\s*await reloadBoards/);
});
