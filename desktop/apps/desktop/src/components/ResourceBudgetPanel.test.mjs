import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./ResourceBudgetPanel.tsx', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        jsx: ts.JsxEmit.ReactJSX,
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'ResourceBudgetPanel.tsx',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);

test('resource budget panel remains valid TSX', () => {
    assert.deepEqual(syntaxErrors, []);
});

test('separates build limits, board configuration, and measured hardware capacity', () => {
    assert.match(source, /aria-label=\{t\('resource\.currentBuildAriaLabel'\)\}/);
    assert.match(source, /aria-label=\{t\('resource\.boardCapacityAriaLabel'\)\}/);

    assert.match(source, /t\('resource\.programSpace'\)/);
    assert.match(source, /'resource\.programSpaceEsp32Description'/);
    assert.match(source, /t\('resource\.internalRam'\)/);
    assert.match(source, /t\('resource\.internalRamDescription'\)/);

    assert.match(source, /t\('resource\.currentConfiguration'\)/);
    assert.match(source, /t\('resource\.configuredFlash'\)/);
    assert.match(source, /'resource\.configuration\.appPartition'/);
    assert.match(source, /t\('resource\.psramMode'\)/);
    assert.match(source, /t\('resource\.configurationNotProgramSpace'\)/);

    assert.match(source, /t\('resource\.latestMeasurement'\)/);
    assert.match(source, /t\('resource\.physicalFlash'\)/);
    assert.match(source, /t\('resource\.physicalPsram'\)/);
    assert.match(source, /report\.uploaderMemory\?\.measuredAt/);
    assert.match(source, /t\('resource\.measurement\.nrDisclaimerSuffix'\)/);
});

test('does not present unsupported physical capacity as an AVR measurement', () => {
    // Physical Flash/PSRAM evidence is currently supplied only by the ESP32
    // uploader path.  Other cores must keep their compile metrics, but must
    // not show an empty "未实测" hardware card or irrelevant PSRAM settings.
    assert.match(source, /const isEsp32 = \/\^esp32:esp32:\/i\.test/);
    assert.match(source, /\{isEsp32 && \([\s\S]*t\('resource\.compactMeasurement'/);
    assert.match(source, /\{isEsp32 && \([\s\S]*aria-label=\{t\('resource\.boardCapacityAriaLabel'\)\}/);

    const panelStart = source.indexOf('export function ResourceBudgetPanel');
    const compactStart = source.indexOf('if (compact)', panelStart);
    const compactEnd = source.indexOf('\n    return (', compactStart);
    const compact = source.slice(compactStart, compactEnd);
    assert.match(compact, /\{isEsp32 && \(/, 'compact board-capacity details must be ESP32-only');
    assert.doesNotMatch(compact, /ResourceGrowthDetails/, 'compact mode should retain only program/RAM metrics');
});

test('keeps capacity risks visible and retains the compact output layout', () => {
    assert.match(source, /t\('resource\.assessment\.configuredLarger'\)/);
    assert.match(source, /t\('resource\.assessment\.configuredSmaller'\)/);
    assert.match(source, /t\('resource\.assessment\.psramDisabled'\)/);
    assert.match(source, /aria-label=\{t\('resource\.capacityCheckAriaLabel'\)\}/);

    assert.match(source, /if \(compact\)/);
    assert.match(source, /t\('resource\.compactConfiguration', \{ partition: configuredPartition, psram: configuredPsram \}\)/);
    assert.match(source, /t\('resource\.compactMeasurement', \{ flash: observedFlash, psram: observedPsram \}\)/);
    assert.match(source, /dark:bg-slate-900\/85/);
    assert.match(source, /dark:border-red-900/);

    const panelStart = source.indexOf('export function ResourceBudgetPanel');
    const compactStart = source.indexOf('if (compact)', panelStart);
    const compactEnd = source.indexOf('\n    return (', compactStart);
    const compact = source.slice(compactStart, compactEnd);
    assert.doesNotMatch(
        compact,
        /min-\[1180px\]/,
        'a global viewport breakpoint must not inject extra badges into a narrow dock',
    );
});

test('keeps the capacity comparison container-safe inside the resizable health dock', () => {
    assert.match(source, /data-ck-role="resource-budget-panel"/);
    assert.match(source, /mt-2 grid min-w-0 grid-cols-1 gap-2/);
    assert.match(source, /repeat\(auto-fit, minmax\(min\(160px, 100%\), 1fr\)\)/);
    assert.doesNotMatch(source, /min-\[900px\]:grid-cols/);
});

test('compact metrics and capacity warnings wrap at the 280px dock minimum', () => {
    const panelStart = source.indexOf('export function ResourceBudgetPanel');
    const compactStart = source.indexOf('if (compact)', panelStart);
    const compactEnd = source.indexOf('\n    return (', compactStart);
    assert.ok(panelStart >= 0 && compactStart >= 0 && compactEnd > compactStart, 'compact panel branch should be discoverable');
    const compact = source.slice(compactStart, compactEnd);

    assert.match(
        compact,
        /className="flex min-w-0 flex-wrap items-center gap-2"/,
        'the compact title, metrics and updating badge must wrap instead of competing for one fixed row',
    );
    assert.match(
        compact,
        /className="mt-1 flex min-w-0 flex-wrap items-(?:start|center)/,
        'configuration, measured capacity and warnings need independent wrapping space',
    );
    assert.doesNotMatch(
        compact,
        /assessmentItems\.map\([\s\S]*?className=\{`truncate rounded border/,
        'capacity mismatch warnings must never be collapsed to an ellipsis',
    );
});

test('important capacity evidence wraps instead of relying on hover-only truncated text', () => {
    const requiredReadableValues = [
        ['compact configured partition', /<span className="([^"]+)" title=\{configurationTitle\}>\{t\('resource\.compactConfiguration'/],
        ['full configured partition', /<span className="([^"]+)" title=\{configuredPartition\}>\{configuredPartition\}<\/span>/],
        ['measured timestamp', /<div className="([^"]+)">\s*\{observedAtText/],
    ];

    for (const [label, pattern] of requiredReadableValues) {
        const match = source.match(pattern);
        assert.ok(match, `${label} should remain represented by a dedicated element`);
        assert.doesNotMatch(match[1], /\btruncate\b/, `${label} must not be visually truncated`);
        assert.match(
            match[1],
            /\b(?:break-words|break-all|whitespace-normal)\b/,
            `${label} should use an explicit wrapping policy`,
        );
    }
});
