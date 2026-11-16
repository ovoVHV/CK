import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('../components/BoardSelector.tsx', import.meta.url), 'utf8');
const identitySource = await readFile(new URL('./board_selector_identity.ts', import.meta.url), 'utf8');
const transpiled = ts.transpileModule(identitySource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2022 },
    fileName: 'board_selector_identity.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const identity = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

test('board categories use stable ids while labels remain presentation-only', () => {
    assert.match(source, /const BOARD_CATEGORY_LABEL_KEYS: Record<BoardCategoryId, string>/);
    assert.match(source, /boardCategoryId\(b\) === activeCategoryId/);
    assert.doesNotMatch(source, /activeCategory\s*===\s*['"]自定义['"]/);

    assert.equal(identity.boardSourceType({ is_custom: true, fqbn: 'esp32:any' }), 'custom');
    assert.equal(identity.boardCategoryId({ is_custom: true, fqbn: 'esp32:any' }), 'custom');
    assert.equal(identity.boardCategoryId({ fqbn: 'esp32:esp32:dev' }), 'esp32');
    assert.equal(identity.boardCategoryId({ fqbn: 'arduino:avr:uno' }), 'arduino');
    assert.equal(identity.boardCategoryId({ fqbn: 'vendor:arch:board' }), 'other');
    assert.deepEqual(
        ['arduino', 'other', 'custom', 'esp32'].sort(identity.compareBoardCategoryIds),
        ['custom', 'esp32', 'arduino', 'other'],
    );
    assert.doesNotMatch(source, /leftLabel\s*[<>]|rightLabel\s*[<>]/);
});

test('core install state and deduplication use stable structured phases', () => {
    assert.equal(identity.coreInstallPhaseForEventType('download_progress'), 'downloading');
    assert.equal(identity.coreInstallPhaseForEventType('install_progress'), 'installing');
    assert.equal(identity.coreInstallPhaseForEventType('正在下载'), null);
    assert.equal(identity.shouldAppendCoreInstallPhaseLog('downloading', 'installing'), true);
    assert.equal(identity.shouldAppendCoreInstallPhaseLog('installing', 'installing'), false);
    assert.match(source, /setProgress\(\{ phase: 'downloading'/);
    assert.match(source, /setProgress\(\{ phase: 'installing'/);
    assert.match(source, /shouldAppendCoreInstallPhaseLog\(installLogPhaseRef\.current, eventPhase\)/);

    // Legacy strings remain visible as evidence but cannot classify phase.
    assert.doesNotMatch(source, /cleanMsg\.startsWith\(["']正在下载/);
    assert.doesNotMatch(source, /last\s*!==\s*["']> 正在安装包/);
});
