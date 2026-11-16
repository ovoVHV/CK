import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./PinPreflightPanel.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'PinPreflightPanel.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'PinPreflightPanel.tsx should transpile without syntax errors');

test('renders a searchable full-board risk map with deterministic filters', () => {
    assert.match(source, /t\('pin\.risk'\)/);
    assert.match(source, /aria-label=\{t\('pin\.searchAriaLabel'\)\}/);
    assert.match(source, /placeholder=\{t\(attentionDefault \? 'pin\.searchCompact' : 'pin\.searchFull'\)\}/);
    assert.match(source, /\['all', t\('pin\.filter\.all'\)\]/);
    assert.match(source, /\['used', t\('pin\.filter\.used'\)\]/);
    assert.match(source, /\['risk', t\('pin\.filter\.risk'\)\]/);
    assert.match(source, /\['available', t\('pin\.filter\.available'\)\]/);
    assert.match(source, /t\('pin\.unusedDisclaimer'\)/);
    assert.match(source, /report\.catalog/);
});

test('labels evidence level and refuses to invent a physical pin layout', () => {
    assert.match(source, /t\(`pin\.evidenceLevel\.\$\{report\.pinEvidenceLevel\}`\)/);
    assert.match(source, /t\('pin\.catalogOrder\.physical'\)/);
    assert.match(source, /t\('pin\.catalogOrder\.logical'\)/);
    assert.match(source, /t\('pin\.publisherWarningSuffix'\)/);
    assert.match(source, /effectiveRiskSeverity/);
});

test('keeps unused board risks visually neutral and labels them informational', () => {
    assert.match(source, /const isPinUsed = \(pin: PinCatalogEntry\): boolean => pin\.usages\.length > 0/);
    assert.match(source, /const isUsed = isPinUsed\(pin\)/);
    assert.match(source, /isUsed && pin\.activeRisks/);
    assert.match(source, /t\('pin\.boardNoticeSuffix'\)/);
    assert.match(source, /t\('pin\.unusedSuffix'\)/);
});

test('uses a compact, attention-first health view without changing the full map', () => {
    assert.match(source, /type PanelCatalogFilter = PinCatalogFilter \| 'attention'/);
    assert.match(source, /useState<PanelCatalogFilter>\(attentionDefault \? 'attention' : 'all'\)/);
    assert.match(source, /simple \? t\('pin\.usage'\) : t\('pin\.risk'\)/);
    assert.match(source, /t\('pin\.summary\.attention'/);
    assert.match(source, /\['attention', t\('pin\.filter\.attentionCount'/);
    assert.match(source, /\['all', t\('pin\.filter\.allCount'/);
    assert.match(source, /catalogFilter === 'attention' \? 'all' : catalogFilter/);
    assert.match(source, /catalogFilter !== 'attention'/);
    assert.match(source, /\(attentionDefault\s*\? \[[\s\S]*?\['attention', t\('pin\.filter\.attentionCount'/);
    assert.match(source, /t\(collapsedUnusedPinCount > 0 \? 'pin\.collapsed\.withUnused' : 'pin\.collapsed\.none'/);
});

test('keeps unused pins out of the compact default and exposes an explicit full-catalog action', () => {
    assert.match(source, /'pin\.collapsed\.withUnused'/);
    assert.match(source, /'pin\.collapsed\.none'/);
    assert.match(source, /data-ck-pin-state=\{pin\.usages\.length > 0 \? 'used' : pin\.activeRisks\.length > 0 \|\| pin\.reservedBy\.length > 0 \? 'risk' : 'unused'\}/);
    assert.match(source, /compact && pin\.usages\.length === 0 \? 'px-1\.5 py-1' : 'px-2 py-1\.5'/);
    assert.match(source, /\['attention', t\('pin\.filter\.attentionCount'/);
    assert.match(source, /\['used', t\('pin\.filter\.usedCount'/);
    assert.match(source, /\['risk', t\('pin\.filter\.riskCount'/);
    assert.match(source, /\['all', t\('pin\.filter\.allCount'/);
});

test('makes each occupied pin directly locate its source block', () => {
    assert.match(source, /\{pin\.usages\.length > 0 && \(/);
    assert.match(source, /t\('pin\.referenceSummary', summarizePinReferences\(pin\.usages\)\)/);
    assert.match(source, /role\.references\.map\(usage/);
    assert.match(source, /<details key=\{role\.id\}/);
    assert.match(source, /onClick=\{\(\) => onLocateBlock\(usage\.blockId\)\}/);
    assert.match(source, /<span className="font-black">\{t\('pin\.locate'\)\}<\/span>/);
    assert.match(source, /title=\{t\('pin\.locateTitle', \{ usage: usageText\(usage\) \}\)\}/);
});

test('counts only truly collapsed pins in the compact summary', () => {
    assert.match(
        source,
        /const collapsedUnusedPinCount = report\.catalog\.filter\(pin => !isPinUsed\(pin\) && !hasPinRisk\(pin\)\)\.length;/,
    );
    assert.doesNotMatch(source, /const unusedPinCount = Math\.max\(0, report\.catalog\.length - usedPinCount\)/);
});
