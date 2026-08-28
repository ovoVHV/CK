import assert from 'node:assert/strict';
import test from 'node:test';
import { mkdtemp, readFile, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';
import { fileURLToPath } from 'node:url';
import { spawnSync } from 'node:child_process';

const source = await readFile(new URL('./Test-NativeEditor.ps1', import.meta.url), 'utf8');
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];

test('production native editor smoke embeds valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
});

const requiredNativeChecks = [
    'tauri-runtime',
    'dashboard-workspace-roundtrip',
    'expected-port-selected-for-protection',
    'theme-light-dark-restored',
    'system-paths-complete',
    'exact-full-fqbn-visible',
    'exact-full-fqbn-wrappable',
    'engineering-health-dock-layout',
    'health-resource-layout-no-overlap',
    'engineering-health-collapse-reopen',
    'block-catalog-ready',
    'search-result-present',
    'flyout-visible-during-search',
    'source-label-visible',
    'expected-source-visible',
    'search-cleanup-restored-idle',
    'project-checkpoints-entry-opened',
    'recovery-draft-entry-opened',
    'last-working-version-entry-opened',
    'declarative-package-quality-complete',
    'declarative-package-runtime-safe',
    'declarative-package-search-source-visible',
    'legacy-javascript-import-fail-closed',
    'unknown-block-read-only-protection',
    'unknown-block-actions-blocked',
    'unknown-project-bytes-preserved',
    'no-horizontal-overflow',
    'cleanup-restored-final-state',
];

test('emits an atomic schema-v3 passed report with the exact productization check contract', () => {
    assert.match(source, /v1-native-smoke\.json/);
    assert.match(embeddedNode, /schemaVersion: 3/);
    assert.match(embeddedNode, /test_id: 'ck-production-native-editor-smoke-v1'/);
    assert.match(embeddedNode, /status: 'passed'/);
    for (const id of requiredNativeChecks) assert.match(embeddedNode, new RegExp(`'${id}'`));
    const checkArray = embeddedNode.match(/const checks = \[([\s\S]*?)\]\s*\.map\(passedCheck\)/)?.[1] || '';
    const actualIds = [...checkArray.matchAll(/'([^']+)'/g)].map((match) => match[1]);
    assert.deepEqual(actualIds, requiredNativeChecks);
    assert.match(embeddedNode, /fs\.renameSync\(temporary, outputPath\)/);
});

test('uses one real native session for dashboard, theme, FQBN, compile-backed health and recovery surfaces', () => {
    assert.match(source, /\[string\]\$ProjectName = 'c6_regression'/);
    assert.match(source, /\[string\]\$Port = 'COM12'/);
    assert.match(source, /esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB/);
    assert.match(embeddedNode, /ensureDashboard/);
    assert.match(embeddedNode, /openProject\(expectedProject\)/);
    assert.match(embeddedNode, /selectThemeMode\('light'\)/);
    assert.match(embeddedNode, /selectThemeMode\('dark'\)/);
    assert.match(embeddedNode, /selectExpectedPort/);
    assert.match(embeddedNode, /expectedPortIsSelected/);
    assert.match(embeddedNode, /get_system_paths/);
    assert.match(embeddedNode, /board-config-effective-fqbn/);
    assert.match(embeddedNode, /compileForHealthEvidence/);
    assert.match(embeddedNode, /new compile UI active transition/);
    assert.match(embeddedNode, /600000,[\s\S]*?'new compile completion and UI recovery'/);
    assert.match(embeddedNode, /resource-budget-panel/);
    assert.match(embeddedNode, /overlappingPanelCount/);
    assert.match(embeddedNode, /workspaceDockOverlap/);
    assert.match(embeddedNode, /project-checkpoints-title/);
    assert.match(embeddedNode, /last-working-version-title/);
    assert.match(embeddedNode, /save_recovery_draft/);
    assert.match(embeddedNode, /recovery-draft-dialog/);
});

test('waits for stable project storage initialization before entering and verifying diagnostics', () => {
    const start = embeddedNode.indexOf('async function inspectSystemPaths()');
    const end = embeddedNode.indexOf('\nasync function waitForExactBoard()', start);
    const inspect = embeddedNode.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(inspect, /const expectedProjectRoots = await invoke\('get_project_roots'\)/);
    assert.match(inspect, /stableStorageReadCount >= 2/);
    assert.match(inspect, /stable project storage initialization/);
    assert.match(inspect, /renderedRootCount === expectedRoots\.length/);
    assert.match(inspect, /!loading/);
    assert.match(inspect, /await waitFor\([\s\S]*?advanced diagnostics view after stable storage initialization/);
    assert.match(inspect, /const expectedSystemPaths = await invoke\('get_system_paths'\)/);
    assert.ok(
        inspect.indexOf("stable project storage initialization") < inspect.indexOf('const diagnosticsClicked'),
        'storage initialization must settle before the advanced diagnostics click',
    );
    assert.ok(
        inspect.indexOf('advanced diagnostics view after stable storage initialization') < inspect.indexOf('const result = await waitFor'),
        'the diagnostics view must be confirmed before complete rows are accepted',
    );
    assert.doesNotMatch(inspect, /await wait\(\d+\)/);
});

test('waits for each recovery dialog close action to become visible and enabled before clicking', () => {
    const helperStart = embeddedNode.indexOf('async function closeDialogWhenReady(');
    const helperEnd = embeddedNode.indexOf('\nasync function inspectRecoveryEntries()', helperStart);
    const helper = embeddedNode.slice(helperStart, helperEnd);
    const inspectStart = helperEnd;
    const inspectEnd = embeddedNode.indexOf('\nasync function createAndOpenRecoveryDraft(', inspectStart);
    const inspect = embeddedNode.slice(inspectStart, inspectEnd);
    assert.ok(helperStart >= 0 && helperEnd > helperStart && inspectEnd > inspectStart);
    assert.match(helper, /dialog\?\.contains\(item\)/);
    assert.match(helper, /!button\.disabled/);
    assert.match(helper, /visible/);
    assert.match(helper, /30000,[\s\S]*?enabled close action/);
    assert.match(helper, /close action became unavailable before it could be clicked/);
    assert.match(helper, /5000,[\s\S]*?`\$\{label\} close`/);
    assert.match(inspect, /closeDialogWhenReady\([\s\S]*?project-checkpoints-title/);
    assert.match(inspect, /closeDialogWhenReady\([\s\S]*?last-working-version-title/);
    assert.doesNotMatch(inspect, /\?\.click\(\)/);
});

test('compile-backed health evidence is scoped to a fresh visible operation without invoke monkey-patching', () => {
    const start = embeddedNode.indexOf('async function compileForHealthEvidence()');
    const end = embeddedNode.indexOf('\nasync function openEngineeringHealth()', start);
    const compileEvidence = embeddedNode.slice(start, end);
    assert.ok(start >= 0 && end > start);
    assert.match(compileEvidence, /new MutationObserver\(sample\)/);
    assert.match(compileEvidence, /build-compile-action/);
    assert.match(compileEvidence, /compile-progress-overlay/);
    assert.match(compileEvidence, /seenActive/);
    assert.match(compileEvidence, /baselineLog: summarizeLog\(readLog\(\)\)/);
    assert.match(compileEvidence, /seenFreshTargetLog/);
    assert.match(compileEvidence, /fresh compile target log/);
    assert.match(compileEvidence, /log\.includes\(\$\{JSON\.stringify\(expectedFqbn\)\}\)/);
    assert.match(compileEvidence, /Sketch uses\\\\s\+\\\\d\+\\\\s\+bytes/);
    assert.match(compileEvidence, /Global variables use\\\\s\+\\\\d\+\\\\s\+bytes/);
    assert.match(compileEvidence, /successMarkerIsFinal/);
    assert.doesNotMatch(compileEvidence, /__ckNativeCompileProbe/);
    assert.doesNotMatch(compileEvidence, /__TAURI_INTERNALS__\.invoke\s*=/);
});

test('imports a unique declarative example with complete quality evidence and rejects legacy JavaScript', () => {
    assert.match(source, /examples\\importable-packages\\ck_example_serial_blocks/);
    assert.match(embeddedNode, /fs\.cpSync\(examplePackageDirectory/);
    assert.match(embeddedNode, /crypto\.randomUUID/);
    assert.match(embeddedNode, /import_extension/);
    assert.match(embeddedNode, /get_all_libraries/);
    assert.match(embeddedNode, /qualityReportComplete/);
    assert.match(embeddedNode, /report\.schema_version === 2/);
    assert.match(embeddedNode, /activation\?\.state === 'declarative-safe'/);
    assert.match(embeddedNode, /activation\?\.executablePresent === false/);
    assert.doesNotMatch(embeddedNode, /activation\?\.executable_present/);
    assert.match(embeddedNode, /blocks\/blocks\.js/);
    assert.match(embeddedNode, /blocks\/generator\.js/);
    assert.match(embeddedNode, /Legacy JavaScript package was not rejected/);
    assert.match(embeddedNode, /sentinelNotExecuted/);
    assert.match(embeddedNode, /delete_library/);
});

test('explicitly refreshes the library manager before accepting an imported block in the catalog', () => {
    const triggerStart = embeddedNode.indexOf('async function triggerLibraryManagerRefresh(');
    const triggerEnd = embeddedNode.indexOf('\nasync function refreshLibraryContextAndAssertPresent(', triggerStart);
    const trigger = embeddedNode.slice(triggerStart, triggerEnd);
    const helperStart = embeddedNode.indexOf('async function refreshLibraryContextAndAssertPresent(');
    const helperEnd = embeddedNode.indexOf('\nasync function exerciseThirdPartyPackages(', helperStart);
    const helper = embeddedNode.slice(helperStart, helperEnd);
    const exerciseStart = helperEnd;
    const exerciseEnd = embeddedNode.indexOf('\nasync function createUnknownProject(', exerciseStart);
    const exercise = embeddedNode.slice(exerciseStart, exerciseEnd);
    const absentStart = embeddedNode.indexOf('async function refreshLibraryContextAndAssertAbsent(');
    const absentEnd = embeddedNode.indexOf('\nasync function cleanupNativeFixtures(', absentStart);
    const absent = embeddedNode.slice(absentStart, absentEnd);
    assert.ok(
        triggerStart >= 0 && triggerEnd > triggerStart
            && helperStart >= 0 && helperEnd > helperStart
            && exerciseEnd > exerciseStart
            && absentStart >= 0 && absentEnd > absentStart,
    );
    assert.match(trigger, /library-manager-title/);
    assert.match(trigger, /item\.textContent\.trim\(\) === '\\u5237\\u65b0'/);
    assert.match(trigger, /button\?\.click\(\)/);
    assert.match(trigger, /if \(!refreshed\) throw new Error/);
    assert.match(helper, /await openLibraryManager\(\)/);
    assert.match(helper, /await triggerLibraryManagerRefresh\(\)/);
    assert.match(helper, /CK_BLOCK_CATALOG\?\.blocks\?\.some/);
    assert.match(helper, /packageInfo\.blockType/);
    assert.match(helper, /after explicit library refresh/);
    assert.ok(
        helper.indexOf('await triggerLibraryManagerRefresh()') < helper.indexOf('window.CK_BLOCK_CATALOG'),
        'the explicit product refresh must happen before waiting for the imported block catalog entry',
    );
    assert.ok(
        helper.indexOf('window.CK_BLOCK_CATALOG') < helper.indexOf('await closeLibraryManager()'),
        'the library manager must remain open until the Workspace catalog reload is observed',
    );
    assert.match(exercise, /await refreshLibraryContextAndAssertPresent\(safe\)/);
    assert.doesNotMatch(exercise, /await openLibraryManager\(\)[\s\S]*?CK_BLOCK_CATALOG/);
    assert.match(absent, /await triggerLibraryManagerRefresh\(\)/);
    assert.match(absent, /removed packages absent from block catalog/);
    assert.doesNotMatch(absent, /await wait\(\d+\)/);
});

test('proves unknown-block save, compile and upload fail closed without changing file bytes', () => {
    assert.match(embeddedNode, /ck_native_unknown_/);
    assert.match(embeddedNode, /save_project_as/);
    assert.match(embeddedNode, /unknown-block-protection/);
    assert.match(embeddedNode, /build-compile-action/);
    assert.match(embeddedNode, /build-normal-upload-action/);
    assert.match(embeddedNode, /installUnknownGuardUiTracker/);
    assert.match(embeddedNode, /MutationObserver/);
    assert.match(embeddedNode, /compile-progress-overlay/);
    assert.match(embeddedNode, /waitForCkToolProcessQuiescence/);
    assert.match(embeddedNode, /observedToolProcessCount/);
    assert.doesNotMatch(embeddedNode, /installInvokeProtectionProbe|forbiddenInvokeCount/);
    assert.doesNotMatch(embeddedNode, /__TAURI_INTERNALS__\.invoke\s*=/);
    assert.match(embeddedNode, /beforeBytes\.equals\(afterBytes\)/);
    assert.match(embeddedNode, /delete_project/);
});

test('always removes exact temporary state, restores the theme and leaves c6_regression open', () => {
    assert.match(embeddedNode, /delete_recovery_draft/);
    assert.match(embeddedNode, /fs\.rmSync\(cleanup\.tempRoot, \{ recursive: true, force: true \}\)/);
    assert.match(embeddedNode, /refreshLibraryContextAndAssertAbsent/);
    assert.match(embeddedNode, /restore original theme/);
    assert.match(embeddedNode, /restore expected workspace/);
    assert.match(embeddedNode, /Final workspace is not the expected C6 project/);
    assert.match(embeddedNode, /Native smoke cleanup failed/);
});

test('keeps report metrics path-free and rejects absolute paths or complete MAC addresses', () => {
    const reportStart = embeddedNode.indexOf('const report = {');
    const reportEnd = embeddedNode.indexOf('const serialized = JSON.stringify(report);', reportStart);
    const reportLiteral = embeddedNode.slice(reportStart, reportEnd);
    assert.ok(reportStart >= 0 && reportEnd > reportStart);
    assert.doesNotMatch(reportLiteral, /projectPath|packageRoot|tempRoot|installedPath|\.path\b/);
    assert.match(embeddedNode, /Native smoke report contains an absolute path or complete MAC address/);
    assert.match(embeddedNode, /\[a-z\]:\[\\\\\/\]/i);
    assert.match(embeddedNode, /\[0-9a-f\]\{12\}/i);
});

test('uses the shared pre/post source, executable, process, listener and CDP binding', () => {
    assert.match(source, /NativeEvidenceBinding\.psm1/);
    assert.match(source, /New-NativeEvidenceBinding/);
    assert.match(source, /Complete-NativeEvidenceBinding/);
    assert.match(source, /Add-NativeEvidenceBindingToReport/);
    assert.match(source, /Save-NativeEvidenceEnvironment/);
    assert.match(source, /finally\s*\{[\s\S]*Restore-NativeEvidenceEnvironment/);
    assert.match(source, /Initialize-NativeEvidenceReportPath/);
    assert.ok(
        source.indexOf('Initialize-NativeEvidenceReportPath -Path $OutputPath') <
            source.indexOf('$binding = New-NativeEvidenceBinding'),
        'an old passed report must be invalidated before native binding or execution begins',
    );
});

test('executes the embedded smoke from a bounded UTF-8 temporary JavaScript file', () => {
    assert.match(source, /\[System\.IO\.Path\]::GetTempPath\(\)/);
    assert.match(source, /ck-native-editor-\{0\}\.js/);
    assert.match(source, /\[Guid\]::NewGuid\(\)\.ToString\('N'\)/);
    assert.match(source, /\[System\.Text\.UTF8Encoding\]::new\(\$false\)/);
    assert.match(source, /\[System\.IO\.FileMode\]::CreateNew/);
    assert.match(source, /\[System\.IO\.FileShare\]::None/);
    assert.match(source, /\$nodeScriptStream\.Dispose\(\)/);
    assert.match(source, /& node \$nodeScriptPath/);
    assert.doesNotMatch(source, /node\s+-e/);
    assert.doesNotMatch(source, /ToBase64String/);
});

test('temporary Node entrypoint resolves ws through the explicit desktop modules path', async () => {
    assert.match(source, /'CK_DESKTOP_NODE_MODULES'/);
    assert.match(source, /\$env:CK_DESKTOP_NODE_MODULES = Join-Path \$desktop 'node_modules'/);
    assert.match(
        embeddedNode,
        /require\(path\.join\(process\.env\.CK_DESKTOP_NODE_MODULES, 'ws'\)\)/,
    );
    assert.doesNotMatch(embeddedNode, /require\('ws'\)/);

    const scriptsDirectory = dirname(fileURLToPath(import.meta.url));
    const desktopNodeModules = join(scriptsDirectory, '..', 'apps', 'desktop', 'node_modules');
    const temporaryDirectory = await mkdtemp(join(tmpdir(), 'ck-native-editor-module-test-'));
    const entrypoint = join(temporaryDirectory, 'entrypoint.js');
    try {
        await writeFile(
            entrypoint,
            `const path = require('node:path');\n` +
                `const WebSocket = require(path.join(process.env.CK_DESKTOP_NODE_MODULES, 'ws'));\n` +
                `if (typeof WebSocket !== 'function') process.exit(2);\n`,
            'utf8',
        );
        const result = spawnSync(process.execPath, [entrypoint], {
            cwd: temporaryDirectory,
            env: { ...process.env, CK_DESKTOP_NODE_MODULES: desktopNodeModules },
            encoding: 'utf8',
        });
        assert.equal(
            result.status,
            0,
            `temporary entrypoint failed to resolve ws: ${result.stderr || result.stdout}`,
        );
    } finally {
        await rm(temporaryDirectory, { recursive: true, force: true });
    }
});

test('always removes the temporary JavaScript without adding its path to the report', () => {
    assert.match(
        source,
        /try\s*\{[\s\S]*& node \$nodeScriptPath[\s\S]*\}\s*finally\s*\{\s*if \(\$nodeScriptPath[\s\S]*\[System\.IO\.File\]::Delete\(\$nodeScriptPath\)/,
    );
    assert.doesNotMatch(embeddedNode, /nodeScriptPath|ck-native-editor-/);
});
