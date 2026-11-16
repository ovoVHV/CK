import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./acceptance_report_presentation.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'acceptance_report_presentation.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const api = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('presentation sidecar never mutates canonical acceptance report bytes', () => {
    const report = {
        schemaVersion: 1,
        kind: 'ck-project-acceptance-report',
        health: { counts: { pass: 3, warning: 1, error: 0, info: 2 }, checks: [], summary: 'legacy prose' },
        build: { resourceGrowth: { status: 'no-baseline' } },
    };
    const before = JSON.stringify(report);
    const presentation = api.createAcceptanceReportPresentation(report);
    assert.equal(JSON.stringify(report), before);
    assert.equal(presentation.report, report);
    assert.deepEqual(presentation.healthSummary, { passed: 3, warnings: 1, errors: 0, info: 2 });
    assert.equal(api.acceptanceCheckTitleKey({ id: 'compile-result' }), 'acceptance.checks.compile-result');
});
