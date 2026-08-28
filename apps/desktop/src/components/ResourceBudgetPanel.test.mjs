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
    assert.match(source, /aria-label="本次构建资源占用"/);
    assert.match(source, /aria-label="板卡 Flash 和 PSRAM 容量"/);

    assert.match(source, /程序空间/);
    assert.match(source, /APP 分区上限，不等于整颗 Flash/);
    assert.match(source, /内部 RAM/);
    assert.match(source, /静态用量，不含 PSRAM/);

    assert.match(source, /当前编译配置/);
    assert.match(source, /配置 Flash/);
    assert.match(source, /APP 分区/);
    assert.match(source, /PSRAM 模式/);
    assert.match(source, /配置值 ≠ 程序空间/);

    assert.match(source, /最近成功上传实测/);
    assert.match(source, /实体 Flash/);
    assert.match(source, /实体 PSRAM/);
    assert.match(source, /report\.uploaderMemory\?\.measuredAt/);
    assert.match(source, /N\/R 不作为容量依据/);
});

test('does not present unsupported physical capacity as an AVR measurement', () => {
    // Physical Flash/PSRAM evidence is currently supplied only by the ESP32
    // uploader path.  Other cores must keep their compile metrics, but must
    // not show an empty "未实测" hardware card or irrelevant PSRAM settings.
    assert.match(source, /const isEsp32 = \/\^esp32:esp32:\/i\.test/);
    assert.match(source, /\{isEsp32 && \([\s\S]*实体 Flash \{observedFlash\} · PSRAM \{observedPsram\}/);
    assert.match(source, /\{isEsp32 && \([\s\S]*aria-label="板卡 Flash 和 PSRAM 容量"/);

    const panelStart = source.indexOf('export function ResourceBudgetPanel');
    const compactStart = source.indexOf('if (compact)', panelStart);
    const compactEnd = source.indexOf('\n    return (', compactStart);
    const compact = source.slice(compactStart, compactEnd);
    assert.match(compact, /\{isEsp32 && \(/, 'compact board-capacity details must be ESP32-only');
    assert.doesNotMatch(compact, /ResourceGrowthDetails/, 'compact mode should retain only program/RAM metrics');
});

test('keeps capacity risks visible and retains the compact output layout', () => {
    assert.match(source, /配置容量大于实体 Flash，上传前需修正/);
    assert.match(source, /配置容量小于实体 Flash，仅使用部分空间/);
    assert.match(source, /检测到实体 PSRAM，但当前配置未启用/);
    assert.match(source, /aria-label="容量配置检查"/);

    assert.match(source, /if \(compact\)/);
    assert.match(source, /分区 \{configuredPartition\} · PSRAM 模式 \{configuredPsram\}/);
    assert.match(source, /实体 Flash \{observedFlash\} · PSRAM \{observedPsram\}/);
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
        ['compact configured partition', /<span className="([^"]+)" title=\{configurationTitle\}>分区/],
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
