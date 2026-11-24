import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('compile diagnostics use an immutable exact-code source map session', () => {
    assert.match(source, /compileSourceMapSessionRef\.current = sourceBuild \? null : \{/);
    assert.match(source, /freezeCompileSourceMap\(compileCode, \{ file: 'sketch\.ino' \}\)/);
    assert.match(source, /captureCompileIssueBlockPresentations\([\s\S]*?frozenCompileSourceMap/);
    assert.match(source, /blockPresentations: ReadonlyMap/);
    assert.match(source, /lookupCompileSourceMap\(session\.sourceMap/);
    assert.match(source, /resolveTrustedCompileDiagnosticFile\(\{/);
    assert.match(source, /trustedSketchAlias: TrustedCompileSketchAliasV1 \| null/);
    assert.match(source, /sha256Hex\(generatedCodeRef\.current \|\| ''\) !== session\.sourceMap\.codeSha256/);
    assert.match(source, /code: session\.code/);
    assert.match(source, /const compileSourceMapJson = sourceBuild \? null : JSON\.stringify\(frozenCompileSourceMap\)/);
    assert.match(source, /createNativeBuildRequest\(buildEvidence, compileCode, nativeBuildProjectId, buildProjectPath, compileSourceMapJson\)/);
    assert.match(source, /compileProject\(input\.request\)/);
    assert.match(source, /uploadProject\(input\.request,/);
});

test('library and arbitrary cpp diagnostics cannot be guessed as sketch blocks', () => {
    assert.match(source, /\.ino\(\?:\\\.cpp\)\?/);
    assert.match(source, /Generic \.cpp\/\.h lines are deliberately excluded/);
    assert.doesNotMatch(source, /getLineToBlockMap/);
    assert.match(source, /listen\('compile-sketch-alias'/);
    assert.match(source, /alias\.runId !== session\.runId/);
    assert.match(source, /session\.aliasRevoked = true/);
    assert.match(source, /diagnosticFile: location\.file/);
    assert.match(source, /setCompileIssues\(issues => reconcileCompileIssueBlocks\(issues\)\)/,
        'a late alias or revocation must reconcile cards independently of event ordering');
    const reports = readFileSync(new URL('../services/foreground_build_reports.ts', import.meta.url), 'utf8');
    assert.match(reports, /const issues = reconcileCompileIssueBlocks\(analyzedIssues\)/,
        'cards created after the alias must use the same reconciliation path');
});

test('click, warning, and issue-card navigation share the strict lookup', () => {
    const uses = source.match(/lookupCompileBlock\(/g) || [];
    assert.ok(uses.length >= 2, `expected strict lookup for warning/navigation consumers, found ${uses.length}`);
    assert.match(source, /reconcileCompileIssueBlockContexts\(\{/,
        'issue cards must use the same authenticated source-map evidence');
    assert.match(source, /mapping\.section/);
    assert.match(source, /mapping\?\.confidence === 'exact' \|\| mapping\?\.confidence === 'high'/);
    assert.match(source, /presentations: session\.blockPresentations/);
    assert.match(source, /if \(!\/\(\?:fatal\\s\+error\|error\)\\s\*:\/i\.test\(line\)\) continue/);
});

test('shows structured error cards in the compile console without requiring the health dock', () => {
    const consoleStart = source.indexOf('data-ck-role="compile-log-scroll-container"');
    const cardStart = source.indexOf('<BuildIssueCards', consoleStart);
    assert.ok(consoleStart >= 0 && cardStart > consoleStart);
    assert.match(source.slice(cardStart, cardStart + 600), /onLocateBlock=\{locateWorkspaceBlock\}/);
    assert.match(source.slice(cardStart, cardStart + 600), /handleCompileIssueAction/);
    assert.match(source, /const canLocateBlock = isError && isTrustedCompileBlockMapping\(mapping\)/);
    assert.match(source, /title=\{canLocateBlock \? '点击定位到已确认映射的积木' : undefined\}/);
});

test('workspace uses the tested compile feedback service to clear and mark mapped blocks', () => {
    assert.match(source, /clearCompileErrors\(ws\)/);
    assert.match(source, /markCompileError\(block,/);
    assert.doesNotMatch(source,/__ckCompileError\s*=/);
});
