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

test('manufacturer filters group boards across cores and choose a stable packaged logo', () => {
    const boards = [
        { id: 'b', fqbn: 'esp32:esp32:s3', is_custom: true, catalog_vendor: 'ACME', vendor_logo_path: 'b/logo.svg' },
        { id: 'a', fqbn: 'arduino:avr:uno', is_custom: true, catalog_vendor: 'Acme' },
        { id: 'c', is_custom: true, catalog_vendor: 'Acme', vendor_logo_path: 'c/logo.png' },
        { id: 'legacy', is_custom: true, author: 'Single author' },
        { id: 'uno', fqbn: 'arduino:avr:uno' },
    ];
    const groups = identity.boardCatalogCategories(boards);
    assert.deepEqual(groups, identity.boardCatalogCategories(boards.reverse()));
    assert.deepEqual(groups.map(c => c.id), ['all', 'custom', 'arduino', 'vendor:acme']);
    assert.deepEqual(groups.at(-1), { id: 'vendor:acme', name: 'Acme', logoPath: 'b/logo.svg' });
    assert.equal(boards.filter(b => identity.boardCategoryId(b) === 'vendor:acme').length, 3);
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
