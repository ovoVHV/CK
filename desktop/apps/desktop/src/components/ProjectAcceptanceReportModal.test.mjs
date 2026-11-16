import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./ProjectAcceptanceReportModal.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'ProjectAcceptanceReportModal.tsx',
    reportDiagnostics: true,
});

test('project acceptance report modal remains valid TSX', () => {
    assert.deepEqual(
        (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
        [],
    );
});

test('uses a modal instead of another persistent programming sidebar', () => {
    assert.match(source, /fixed inset-0/);
    assert.match(source, /role="dialog"/);
    assert.match(source, /aria-modal="true"/);
    assert.doesNotMatch(source, /EngineeringHealthDock|PanelRight|position:\s*fixed[^\n]*right/);
});

test('shows explicit health items without a numeric score', () => {
    assert.match(source, /t\('acceptance\.healthChecksTitle'\)/);
    assert.match(source, /t\('acceptance\.passportStagesAria'\)/);
    assert.match(source, /check\.stages\.map/);
    assert.match(source, /report\.health\.checks\.map/);
    assert.match(source, /t\('acceptance\.subtitle'\)/);
    assert.doesNotMatch(source, /score|healthScore|总分|评分/);
});

test('exports private structured JSON and printable HTML', () => {
    assert.match(source, /JSON\.stringify\(freshReport, null, 2\)/);
    assert.match(source, /projectAcceptanceReportToHtml\(freshReport\)/);
    assert.match(source, /writeTextFile\(path, content\)/);
    assert.match(source, /t\('acceptance\.export\.structuredButton'\)/);
    assert.match(source, /t\('acceptance\.export\.printableButton'\)/);
    assert.match(source, /t\('acceptance\.export\.printableTooltip'\)/);
    assert.match(source, /t\('acceptance\.footerNote'\)/);
});

test('renders the compact project.ckpkg workflow inside the existing modal', () => {
    assert.match(source, /t\('acceptance\.submission\.exportHeading'\)/);
    assert.match(source, /t\('acceptance\.submission\.openReadOnly'\)/);
    assert.match(source, /value="no_source"/);
    assert.match(source, /value="editable_project"/);
    assert.match(source, /value="generated_source"/);
    assert.match(source, /value="editable_and_generated"/);
    assert.match(source, /sourceDisclosureAcknowledged/);
    assert.match(source, /t\('acceptance\.submission\.includeLock'\)/);
    assert.match(source, /t\('acceptance\.submission\.includeEvidence'\)/);
    assert.match(source, /onClick=\{\(\) => void exportSubmission\(\)\}/);
    assert.match(source, /onClick=\{\(\) => void importSubmission\(\)\}/);
    assert.match(source, /t\('acceptance\.submission\.checkedDescription'\)/);
    assert.match(source, /t\('acceptance\.shaLabel'\)/);
    assert.match(source, /result\.packageFileName/);
    assert.match(source, /result\.packageSha256/);
    assert.match(source, /t\('acceptance\.submission\.exportedTitle'\)/);
    assert.match(source, /t\('acceptance\.submission\.lockLabel'\)/);
    assert.match(source, /t\(submissionScopeLabelKey\[importedSubmission\.sourceScope\]\)/);
    assert.match(source, /t\('acceptance\.submission\.disclosureFooter'\)/);
    assert.doesNotMatch(source, /position:\s*fixed[^\n]*right|ProjectSubmissionDock/);
});

test('readonly package inspection is independent from local report generation and clears stale package state', () => {
    const independent = source.indexOf("aria-label={t('acceptance.submission.inspectSectionAria')}");
    const reportGate = source.indexOf('{report && (');
    assert.ok(independent >= 0 && reportGate > independent);
    assert.match(source, /if \(!isOpen\) return;[\s\S]*setImportedSubmission\(null\);/);
    assert.match(source, /if \(exporting \|\| loadedProviderRef.current === reportProvider\) return;[\s\S]*void load\(\)/);
    const importStart = source.indexOf('const importSubmission = async');
    const importEnd = source.indexOf('return (', importStart);
    assert.match(source.slice(importStart, importEnd), /setImportedSubmission\(null\);[\s\S]*openFile/);
});

test('does not put submission actions in the modal header', () => {
    const header = source.slice(source.indexOf('<header'), source.indexOf('</header>'));
    assert.doesNotMatch(header, /acceptance\.submission|FolderInput|PackageCheck/);
});

test('does not pretend checkpoint count is modification count', () => {
    assert.match(source, /t\('acceptance\.checkpointLabel'\).*report\.history\.checkpointCount/);
    assert.match(source, /t\('acceptance\.editCountLabel'\).*t\('acceptance\.unknown'\)/);
});
