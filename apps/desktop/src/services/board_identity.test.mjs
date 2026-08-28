import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./board_identity.ts', import.meta.url), 'utf8');
const boardSelectorSource = await readFile(
    new URL('../components/BoardSelector.tsx', import.meta.url),
    'utf8',
);
const hardwareContextSource = await readFile(
    new URL('../contexts/HardwareContext.tsx', import.meta.url),
    'utf8',
);
const workspaceSource = await readFile(
    new URL('../components/Workspace.tsx', import.meta.url),
    'utf8',
);
const dashboardSource = await readFile(
    new URL('../components/Dashboard.tsx', import.meta.url),
    'utf8',
);
const libraryManagerSource = await readFile(
    new URL('../components/LibraryManagerModal.tsx', import.meta.url),
    'utf8',
);
const transpiled = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'board_identity.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const identity = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const fqbn = 'esp32:esp32:esp32c6';
const official = { id: fqbn, fqbn, name: 'Official' };
const custom = {
    id: 'acme-c6-board',
    fqbn,
    name: 'ACME C6',
    is_custom: true,
    usable: true,
    quality_report: {
        status: 'passed',
        validated_consumers: ['runtime-loader'],
        checks: [],
    },
};

test('keeps a custom package distinct when it shares an official FQBN', () => {
    assert.equal(identity.boardPackageKey(custom), 'acme-c6-board');
    assert.equal(identity.resolveBoardPackage([official, custom], fqbn, custom.id), custom);
});

test('legacy FQBN-only projects deterministically prefer the built-in package', () => {
    assert.equal(identity.resolveBoardPackage([custom, official], fqbn), official);
});

test('does not resolve a package id against a different compiler target', () => {
    const other = { ...custom, fqbn: 'esp32:esp32:esp32c3' };
    assert.equal(identity.resolveBoardPackage([official, other], fqbn, custom.id), undefined);
});

test('does not replace a removed custom package with the built-in board sharing its FQBN', () => {
    assert.equal(identity.resolveBoardPackage([official], fqbn, custom.id), undefined);
});

test('build gate blocks missing, failed and unusable packages without blocking project viewing', () => {
    assert.equal(
        identity.evaluateBoardPackageBuildGate([official], fqbn, custom.id).status,
        'missing',
    );
    assert.equal(identity.evaluateBoardPackageBuildGate([official], fqbn, custom.id).canBuild, false);

    const failed = { ...custom, quality_report: { status: 'failed' } };
    assert.equal(identity.evaluateBoardPackageBuildGate([official, failed], fqbn, failed.id).status, 'quality-failed');

    const unusable = { ...custom, usable: false, availability_error: 'Core not ready' };
    const unusableGate = identity.evaluateBoardPackageBuildGate([official, unusable], fqbn, unusable.id);
    assert.equal(unusableGate.status, 'unusable');
    assert.match(unusableGate.reason, /Core not ready/);

    assert.equal(identity.evaluateBoardPackageBuildGate([official, custom], fqbn, custom.id).canBuild, true);

    const uncertified = { ...custom, quality_report: undefined };
    assert.equal(
        identity.evaluateBoardPackageBuildGate([official, uncertified], fqbn, uncertified.id).status,
        'uncertified',
    );
    const tampered = {
        ...custom,
        quality_report: {
            ...custom.quality_report,
            status: 'passed_with_warnings',
            checks: [{ code: 'installed-content-changed', status: 'warning' }],
        },
    };
    assert.equal(
        identity.evaluateBoardPackageBuildGate([official, tampered], fqbn, tampered.id).status,
        'quality-failed',
    );
});

test('selection, persistence, libraries and pins carry package identity separately from FQBN', () => {
    assert.match(
        boardSelectorSource,
        /setActiveBoard\(selectedBoard\.fqbn, boardPackageKey\(selectedBoard\)\)/,
    );
    assert.match(boardSelectorSource, /boardPackageId:\s*boardPackageKey\(selectedBoard\)/);
    assert.match(hardwareContextSource, /const cacheKey = `\$\{activeBoard\}::\$\{activeBoardPackageId\}`/);
    assert.match(hardwareContextSource, /activeBoardPackageIdRef\.current !== activeBoardPackageId/);
    assert.match(workspaceSource, /data\?\.board_package_id/);
    assert.match(workspaceSource, /setActiveBoard\(targetBoard, targetBoardPackageId\)/);
    assert.match(workspaceSource, /boardPackageId:\s*activeBoardPackageId/);
    assert.match(workspaceSource, /invoke\('compile_sketch',[\s\S]{0,260}?boardPackageId:\s*activeBoardPackageId/);
    assert.match(workspaceSource, /invoke\('upload_sketch',[\s\S]{0,320}?boardPackageId:\s*activeBoardPackageId/);
    assert.match(workspaceSource, /if \(!activeBoardPackageBuildGate\.canBuild\)/);
    assert.match(workspaceSource, /\[板卡包门禁\] 已阻止/);
    assert.match(
        workspaceSource,
        /boardPackageId:\s*allowPackageScopedExtensions \? boardPackageId : null/,
    );
    assert.match(
        workspaceSource,
        /qualityReport\?\.package_id \|\| qualityReport\?\.packageId \|\| ''\) === libraryId/,
    );
    assert.match(
        workspaceSource,
        /registerDetailedBoard\([\s\S]*?activeBoardPackageId,[\s\S]*?isCustomBoardPackage/,
    );
    assert.match(
        workspaceSource,
        /activeBoardPackageBuildGate\.canBuild \? currentBoardData\?\.pins \|\| \[\] : \[\]/,
    );
    assert.match(dashboardSource, /board_package_id\?:\s*string/);
    assert.match(dashboardSource, /boardPackageKey\(board\) === packageId/);
    assert.match(dashboardSource, /missingBoard:\s*project\.board_package_id \|\| project\.board/);
    assert.match(
        libraryManagerSource,
        /prepareBlockLibraryMigration\(\{[\s\S]{0,240}?boardPackageId:\s*activeBoardPackageId/,
    );
    assert.match(libraryManagerSource, /reloadLibraries\(activeBoard, activeBoardPackageId\)/);
});
