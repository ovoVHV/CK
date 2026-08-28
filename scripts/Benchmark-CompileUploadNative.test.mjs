import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { createRequire } from 'node:module';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const scriptUrl = new URL('./Benchmark-CompileUploadNative.ps1', import.meta.url);
const scriptPath = fileURLToPath(scriptUrl);
const source = await readFile(scriptUrl, 'utf8');
const bindingSource = await readFile(new URL('./NativeEvidenceBinding.psm1', import.meta.url), 'utf8');
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];
const harnessNode = embeddedNode.replace(
    /const WebSocket = require\([^\r\n]+\);/,
    'class WebSocket { on() {} send() {} close() {} }',
);
const {
    parseMetrics,
    analyzeUploadCompileLock,
    assertCompileIncludeConsistency,
    recordUploadProgressSample,
    analyzeUploadProgress,
    pageBlocklyContextPrelude,
    sanitizeEvidenceValue,
    buildVerifiedBaseline,
    evaluateCacheClearIdentity,
    buildBenchmarkOutcomeChecks,
} = new Function(
    'require',
    `${harnessNode}\nreturn { parseMetrics, analyzeUploadCompileLock, assertCompileIncludeConsistency, recordUploadProgressSample, analyzeUploadProgress, pageBlocklyContextPrelude, sanitizeEvidenceValue, buildVerifiedBaseline, evaluateCacheClearIdentity, buildBenchmarkOutcomeChecks };`,
)(createRequire(import.meta.url));

const cacheClearFixture = (coldMode) => {
    const ready = coldMode === 'readyInstallCold';
    return {
        fqbn: 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB',
        reset_scope: ready
            ? 'ready-install-project-full-fqbn'
            : 'first-project-full-fqbn',
        ccache_store_preserved: true,
        prebuilt_core_preserved: ready,
        prebuilt_core_validated: ready,
        force_rebuild_pending: false,
        force_ccache_recache: false,
    };
};

test('embedded CDP program is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
});

test('successful benchmark evidence publishes explicit top-level checks and failures', () => {
    const sourceIdentity = { codeFingerprint: 'source-a', includeHeaders: ['WiFi.h'] };
    const hotIdentity = { codeFingerprint: 'source-b', includeHeaders: ['WiFi.h'] };
    const checks = buildBenchmarkOutcomeChecks({
        coldMode: 'firstProjectCold',
        fqbn: cacheClearFixture('firstProjectCold').fqbn,
        cacheClear: cacheClearFixture('firstProjectCold'),
        requireUploadProgress: true,
        sourceGate: { initial: sourceIdentity, hotEdit: hotIdentity, restored: sourceIdentity },
        cycles: {
            cold: { fullBuild: true, exactMatch: false },
            exact: { exactMatch: true },
            hotEdit: { exactMatch: false, codeChanged: true },
            upload: { wallSeconds: 1 },
        },
        skippedStages: [],
        uploadCompileLock: { status: 'passed', failures: [] },
        uploadProgress: { status: 'passed', failures: [] },
        verified_baseline: { id: 'verified' },
    });
    assert.equal(checks.length, 5);
    assert.ok(checks.every((check) => check.passed === true));
    assert.match(embeddedNode, /checks:\s*\[\],\s*\n\s*failures:\s*\[\]/);
    assert.match(embeddedNode, /result\.failures = result\.checks/);
    assert.match(embeddedNode, /Benchmark outcome checks failed/);
});

test('benchmark outcome contract exposes a deterministic failed check', () => {
    const checks = buildBenchmarkOutcomeChecks({
        coldMode: 'firstProjectCold',
        sourceGate: {
            initial: { codeFingerprint: 'same', includeHeaders: [] },
            hotEdit: { codeFingerprint: 'same', includeHeaders: [] },
            restored: { codeFingerprint: 'same', includeHeaders: [] },
        },
        cycles: { cold: {}, exact: {}, hotEdit: {} },
        skippedStages: [{ stage: 'upload', reason: 'fixture' }],
    });
    assert.ok(checks.some((check) => check.passed === false));
});

for (const coldMode of ['firstProjectCold', 'readyInstallCold']) {
    test(`${coldMode} accepts only its exact cache-clear identity`, () => {
        const fixture = cacheClearFixture(coldMode);
        const result = evaluateCacheClearIdentity(coldMode, fixture, fixture.fqbn);
        assert.deepEqual(result, { required: true, passed: true, failures: [] });
    });

    for (const field of [
        'fqbn',
        'reset_scope',
        'ccache_store_preserved',
        'prebuilt_core_preserved',
        'prebuilt_core_validated',
        'force_rebuild_pending',
        'force_ccache_recache',
    ]) {
        test(`${coldMode} rejects a missing cache-clear ${field}`, () => {
            const fixture = cacheClearFixture(coldMode);
            delete fixture[field];
            const result = evaluateCacheClearIdentity(coldMode, fixture, cacheClearFixture(coldMode).fqbn);
            assert.equal(result.passed, false);
            assert.ok(result.failures.includes(field));
        });

        test(`${coldMode} rejects an incorrect cache-clear ${field}`, () => {
            const fixture = cacheClearFixture(coldMode);
            fixture[field] = typeof fixture[field] === 'boolean'
                ? !fixture[field]
                : `${fixture[field]}-wrong`;
            const result = evaluateCacheClearIdentity(coldMode, fixture, cacheClearFixture(coldMode).fqbn);
            assert.equal(result.passed, false);
            assert.ok(result.failures.includes(field));
        });
    }

    for (const field of [
        'ccache_store_preserved',
        'prebuilt_core_preserved',
        'prebuilt_core_validated',
        'force_rebuild_pending',
        'force_ccache_recache',
    ]) {
        test(`${coldMode} rejects a string cache-clear ${field}`, () => {
            const fixture = cacheClearFixture(coldMode);
            fixture[field] = String(fixture[field]);
            const result = evaluateCacheClearIdentity(coldMode, fixture, cacheClearFixture(coldMode).fqbn);
            assert.equal(result.passed, false);
            assert.ok(result.failures.includes(field));
        });
    }

    test(`${coldMode} cache-clear identity is part of the cold-stage outcome check`, () => {
        const cacheClear = cacheClearFixture(coldMode);
        const cycles = {
            cold: coldMode === 'readyInstallCold'
                ? {
                    exactMatch: false,
                    fastRelink: true,
                    fullBuild: false,
                    prebuiltCoreInjected: true,
                    syntheticCcdbPrepared: true,
                    arduinoCliCcdbRefreshObserved: false,
                }
                : { fullBuild: true, exactMatch: false },
        };
        const build = () => buildBenchmarkOutcomeChecks({
            coldMode,
            fqbn: cacheClearFixture(coldMode).fqbn,
            cacheClear,
            cycles,
            skippedStages: [{ stage: 'upload', reason: 'fixture' }],
        }).find((check) => check.id === 'cold-stage-verified-or-explicitly-skipped');

        assert.equal(build()?.passed, true);
        cacheClear.force_rebuild_pending = 'false';
        assert.equal(build()?.passed, false);
    });
}

test('PowerShell 5.1 parser accepts the benchmark runner', () => {
    const escaped = scriptPath.replaceAll("'", "''");
    const command = [
        '$tokens=$null',
        '$errors=$null',
        `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)|Out-Null`,
        "if($errors.Count){throw ($errors|Out-String)}",
    ].join(';');
    const result = spawnSync(
        'powershell.exe',
        ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('streams the long embedded program over stdin without putting it on the Windows command line', () => {
    assert.match(source, /\$nodeScript\s*\|\s*node\s+-/);
    assert.doesNotMatch(source, /(?:^|\s)node(?:\.exe)?\s+-e\b/im);
    assert.doesNotMatch(source, /WriteAllText\([^\r\n]*\$nodeScript/);
    assert.equal((source.match(/\$nodeScript\s*\|\s*node\s+-/g) || []).length, 1);
});

test('scrubs build paths and complete MAC addresses before writing or logging benchmark evidence', () => {
    const previousRoot = process.env.CK_BENCHMARK_ROOT;
    process.env.CK_BENCHMARK_ROOT = 'C:\\Users\\builder\\CK';
    try {
        const safe = sanitizeEvidenceValue({
            source: 'C:\\Users\\builder\\CK\\apps\\desktop',
            build: path.join(tmpdir(), 'CK_Builds', 'fixture', 'build'),
            mac: 'AA:BB:CC:DD:EE:FF',
            external: 'D:\\vendor\\private\\artifact.bin',
        });
        assert.equal(safe.source, '<CK_ROOT>\\apps\\desktop');
        assert.match(safe.build, /^<CK_BUILDS>/);
        assert.equal(safe.mac, '[REDACTED_MAC]');
        assert.equal(safe.external, '[REDACTED_ABSOLUTE_PATH]');
    } finally {
        if (previousRoot === undefined) delete process.env.CK_BENCHMARK_ROOT;
        else process.env.CK_BENCHMARK_ROOT = previousRoot;
    }
});

const verifiedBaselineFixture = () => ({
    schemaVersion: 1,
    id: 'do-not-export-id',
    createdAt: '2026-07-14T02:03:04.000Z',
    verifiedAt: '2026-07-14T02:04:05.000Z',
    project: {
        originalPath: 'C:\\Users\\builder\\Documents\\secret.maker',
        generatedCode: 'const char *ssid = "secret";',
    },
    lock: { content: '{"private":true}' },
    environment: {
        fqbn: 'esp32:esp32:esp32c6:FlashSize=16M',
        coreId: 'esp32:esp32',
        coreVersion: '3.3.6',
        arduinoCliVersion: '1.3.1',
        toolchainKey: 'toolchain-key-0123',
        buildSignature: 'build-signature-4567',
        compileProfile: 'shared-fast',
        optimization: '-O1',
    },
    firmware: {
        buildDirectory: 'C:\\Users\\builder\\AppData\\Local\\Temp\\private-build',
        manifestPath: 'C:\\Users\\builder\\private-manifest.json',
        manifestSha256: '1'.repeat(64),
        partition: {
            path: 'C:\\Users\\builder\\partitions.csv',
            sha256: '2'.repeat(64),
        },
        artifacts: [
            {
                path: 'C:\\Users\\builder\\flash_args',
                role: 'esp32-flash-arguments',
                flashAddress: null,
                size: 200,
                sha256: '3'.repeat(64),
            },
            {
                path: 'C:\\Users\\builder\\bootloader.bin',
                role: 'esp32-bootloader',
                flashAddress: '0x0',
                size: 16384,
                sha256: '4'.repeat(64),
            },
            {
                path: 'C:\\Users\\builder\\firmware.bin',
                role: 'esp32-application',
                flashAddress: '0x10000',
                size: 987654,
                sha256: '5'.repeat(64),
            },
        ],
    },
    device: {
        chip: 'ESP32-C6',
        revision: 'v0.1',
        flashBytes: 16 * 1024 * 1024,
        psramBytes: null,
        mac: 'AA:BB:CC:DD:EE:FF',
    },
    resources: {
        flashUsedBytes: 987654,
        flashMaxBytes: 3 * 1024 * 1024,
        ramUsedBytes: 40960,
        ramMaxBytes: 512 * 1024,
        warningCount: 0,
    },
    logs: {
        compilePath: 'C:\\Users\\builder\\compile.log',
        uploadPath: 'C:\\Users\\builder\\upload.log',
    },
});

test('publishes a strict path-free verified upload baseline using an explicit whitelist', () => {
    const fqbn = 'esp32:esp32:esp32c6:FlashSize=16M';
    const baseline = buildVerifiedBaseline(verifiedBaselineFixture(), fqbn, '2026-07-14T02:00:00.000Z');
    assert.deepEqual(Object.keys(baseline), [
        'createdAt',
        'verifiedAt',
        'environment',
        'firmware',
        'device',
        'resources',
    ]);
    assert.deepEqual(Object.keys(baseline.environment), [
        'fqbn',
        'coreId',
        'coreVersion',
        'arduinoCliVersion',
        'toolchainKey',
        'buildSignature',
        'compileProfile',
        'optimization',
    ]);
    assert.deepEqual(Object.keys(baseline.firmware), [
        'manifestSha256',
        'partitionSha256',
        'artifacts',
    ]);
    assert.equal(baseline.firmware.artifacts.length, 2);
    assert.deepEqual(Object.keys(baseline.firmware.artifacts[0]), [
        'role',
        'flashAddress',
        'size',
        'sha256',
    ]);
    assert.equal(baseline.device.psramBytes, null, 'unreported PSRAM must remain explicitly null');
    assert.equal(baseline.device.flashBytes, 16 * 1024 * 1024);
    assert.equal(baseline.resources.flashMaxBytes, 3 * 1024 * 1024);
    assert.notEqual(
        baseline.resources.flashMaxBytes,
        baseline.device.flashBytes,
        'the APP partition budget must not be replaced by physical Flash capacity',
    );
    const encoded = JSON.stringify(baseline);
    assert.doesNotMatch(encoded, /[a-z]:[\\/]/i);
    assert.doesNotMatch(encoded, /AA:BB:CC:DD:EE:FF/i);
    assert.doesNotMatch(encoded, /generatedCode|workspace|project|lock|logs|path/i);
});

test('rejects incomplete or mismatched upload baselines before benchmark status can pass', () => {
    const fqbn = 'esp32:esp32:esp32c6:FlashSize=16M';
    const cases = [
        ['FQBN mismatch', (value) => { value.environment.fqbn = 'esp32:esp32:esp32c5'; }, /FQBN mismatch/],
        ['Core identity missing', (value) => { value.environment.coreId = ''; }, /environment\.coreId/],
        ['Core version missing', (value) => { value.environment.coreVersion = null; }, /environment\.coreVersion/],
        ['CLI missing', (value) => { value.environment.arduinoCliVersion = ''; }, /arduinoCliVersion/],
        ['toolchain missing', (value) => { value.environment.toolchainKey = ''; }, /toolchainKey/],
        ['build signature missing', (value) => { value.environment.buildSignature = ''; }, /buildSignature/],
        ['manifest hash invalid', (value) => { value.firmware.manifestSha256 = 'bad'; }, /manifestSha256/],
        ['partition hash missing', (value) => { value.firmware.partition = null; }, /partitionSha256/],
        ['segments missing', (value) => { value.firmware.artifacts = []; }, /no addressed firmware segments/],
        ['segment address invalid', (value) => { value.firmware.artifacts[1].flashAddress = '65536'; }, /flashAddress is invalid/],
        ['segment size invalid', (value) => { value.firmware.artifacts[1].size = 0; }, /size must be a positive/],
        ['segment hash invalid', (value) => { value.firmware.artifacts[1].sha256 = 'x'.repeat(64); }, /not a valid SHA-256/],
        ['chip missing', (value) => { value.device.chip = ''; }, /device\.chip/],
        ['Flash missing', (value) => { value.device.flashBytes = null; }, /device\.flashBytes/],
        ['Flash used missing', (value) => { value.resources.flashUsedBytes = null; }, /resources\.flashUsedBytes is missing/],
        ['Flash maximum missing', (value) => { value.resources.flashMaxBytes = null; }, /resources\.flashMaxBytes is missing/],
        ['RAM used missing', (value) => { value.resources.ramUsedBytes = null; }, /resources\.ramUsedBytes is missing/],
        ['RAM maximum missing', (value) => { value.resources.ramMaxBytes = null; }, /resources\.ramMaxBytes is missing/],
        ['warnings missing', (value) => { value.resources.warningCount = null; }, /warningCount is missing/],
        ['numeric string rejected', (value) => { value.resources.flashUsedBytes = '987654'; }, /flashUsedBytes is invalid/],
        ['boolean rejected', (value) => { value.resources.ramUsedBytes = true; }, /ramUsedBytes is invalid/],
    ];
    for (const [label, mutate, expected] of cases) {
        const fixture = verifiedBaselineFixture();
        mutate(fixture);
        assert.throws(
            () => buildVerifiedBaseline(fixture, fqbn, '2026-07-14T02:00:00.000Z'),
            expected,
            label,
        );
    }
});

test('rejects a same-FQBN baseline that predates the current upload operation', () => {
    const fqbn = 'esp32:esp32:esp32c6:FlashSize=16M';
    assert.throws(
        () => buildVerifiedBaseline(verifiedBaselineFixture(), fqbn, '2026-07-14T02:05:00.000Z'),
        /predates this upload operation/,
    );
});

test('rejects a same-FQBN baseline whose identity did not change during upload', () => {
    const fqbn = 'esp32:esp32:esp32c6:FlashSize=16M';
    const fixture = verifiedBaselineFixture();
    assert.throws(
        () => buildVerifiedBaseline(
            fixture,
            fqbn,
            '2026-07-14T02:00:00.000Z',
            fixture.id,
        ),
        /identity did not change/,
    );
});

test('queries the exact project path only after upload and exports no project path', () => {
    assert.match(embeddedNode, /const projects = await invoke\('list_projects', \{\}\)/);
    assert.match(embeddedNode, /String\(project\?\.name \|\| ''\) === projectName/);
    assert.match(embeddedNode, /invoke\('get_last_working_version', \{ projectPath: matches\[0\]\.path \}\)/);
    assert.match(embeddedNode, /const uploadStartedAt = new Date\(\)\.toISOString\(\)/);
    assert.match(embeddedNode, /const previousBaseline = await readLastWorkingVersion/);
    assert.match(embeddedNode, /previousBaselineId,/);
    assert.match(embeddedNode, /result\.verified_baseline = await captureVerifiedBaseline/);
    assert.match(embeddedNode, /activeFqbn,\s*uploadStartedAt,/);
    assert.ok(
        embeddedNode.indexOf("await runOperation('upload')")
            < embeddedNode.indexOf('result.verified_baseline = await captureVerifiedBaseline'),
        'baseline capture must happen only after the upload operation succeeds',
    );
    assert.ok(
        embeddedNode.indexOf('result.verified_baseline = await captureVerifiedBaseline')
            < embeddedNode.indexOf('result.checks = buildBenchmarkOutcomeChecks'),
        'baseline validation must finish before the benchmark can pass',
    );
    assert.match(embeddedNode, /result\.status = result\.failures\.length === 0 \? 'passed' : 'failed'/);
});

test('generated page bridge prelude stays valid for project names requiring JavaScript escaping', () => {
    const previousProject = process.env.CK_BENCHMARK_PROJECT;
    process.env.CK_BENCHMARK_PROJECT = "C6 owner's 回归";
    try {
        const prelude = pageBlocklyContextPrelude();
        assert.doesNotThrow(() => new Function(`return (async () => { ${prelude} return true; })()`));
        assert.match(prelude, /C6 owner's 回归/);
    } finally {
        if (previousProject === undefined) delete process.env.CK_BENCHMARK_PROJECT;
        else process.env.CK_BENCHMARK_PROJECT = previousProject;
    }
});

test('uses the narrow release bridge before the Blockly and Vite development fallbacks', () => {
    assert.match(embeddedNode, /const nativeRegressionBridge = globalThis\.CK_NATIVE_REGRESSION/);
    assert.match(embeddedNode, /nativeRegressionBridge\?\.schemaVersion === 1/);
    assert.match(embeddedNode, /nativeRegressionBridge\.getCurrent\(\)/);
    assert.match(embeddedNode, /let Blockly = nativeRegressionContext\?\.Blockly \|\| globalThis\.Blockly/);
    assert.match(embeddedNode, /let workspace = nativeRegressionContext\?\.workspace \|\| null/);
    assert.match(embeddedNode, /typeof Blockly\?\.getMainWorkspace !== 'function' && blocklyUrl/);
    assert.match(embeddedNode, /globalThis\.Mixly\?\.Editor\?\.blockEditor/);
    assert.ok(
        embeddedNode.indexOf('globalThis.CK_NATIVE_REGRESSION') < embeddedNode.indexOf('globalThis.Blockly'),
        'the release bridge must be resolved before development globals',
    );
});

test('selects the main CK page and compares selector values without CSS interpolation', () => {
    assert.match(bindingSource, /console=detached/);
    assert.match(embeddedNode, /heading\.title === \$\{JSON\.stringify\(projectName\)\}/);
    assert.match(embeddedNode, /button\.title === \$\{JSON\.stringify\(port\)\}/);
    assert.match(embeddedNode, /querySelector\('span\.font-mono'\)\?\.textContent\?\.trim\(\) === \$\{JSON\.stringify\(port\)\}/);
    assert.doesNotMatch(embeddedNode, /textContent\.includes\(\$\{JSON\.stringify\(port\)\}\)/);
});

test('refuses to edit or upload an unrelated workspace', () => {
    assert.match(embeddedNode, /workspace-project-identity/);
    assert.match(embeddedNode, /Refusing to benchmark the wrong open project/);
    assert.match(embeddedNode, /Opened workspace identity mismatch/);
    assert.match(embeddedNode, /expectedNames\.includes\(currentProject\)/);
    assert.match(embeddedNode, /Native regression workspace mismatch/);
    assert.match(embeddedNode, /const expectedProjects =/);
    assert.match(embeddedNode, /if \(!expectedProjects\.includes\(currentProject\)\)/);
});

test('clears and reports the exact active FQBN instead of a prefix match', () => {
    assert.match(embeddedNode, /if \(activeFqbn === expectedFqbn\) return activeFqbn/);
    assert.match(embeddedNode, /Board mismatch after waiting for project configuration/);
    assert.match(embeddedNode, /const deadline = Date\.now\(\) \+ 60000/);
    assert.match(embeddedNode, /result\.cacheClear = await invoke\(cacheClearCommand, \{ fqbn: activeFqbn \}\)/);
    assert.match(embeddedNode, /evaluateCacheClearIdentity\(\s*result\.coldMode,\s*result\.cacheClear,\s*activeFqbn,\s*\)/);
    assert.ok(
        embeddedNode.indexOf('result.cacheClear = await invoke(cacheClearCommand, { fqbn: activeFqbn })')
            < embeddedNode.indexOf("result.cycles.cold = await runOperation('compile')"),
        'cache-clear identity must be rejected before the cold compile begins',
    );
    assert.doesNotMatch(embeddedNode, /boardTitle\.includes\(expectedFqbn\)/);
});

test('selects first-project cold only through the explicit switch and records the mode', () => {
    assert.match(source, /\[switch\]\$FirstProjectCold/);
    assert.match(source, /A cold benchmark mode cannot be requested together with -SkipCold/);
    assert.match(source, /CK_BENCHMARK_FIRST_PROJECT_COLD/);
    assert.match(embeddedNode, /\? 'firstProjectCold'/);
    assert.match(embeddedNode, /: 'hardRefreshCold'/);
    assert.match(embeddedNode, /\? 'clear_board_first_project_compile_cache'/);
    assert.match(embeddedNode, /: 'clear_board_compile_cache'/);
    assert.equal(
        (embeddedNode.match(/clear_board_first_project_compile_cache/g) || []).length,
        1,
        'the benchmark-only command must only be reachable from the explicit mode selector',
    );
});

test('ready-install cold preserves and verifies an exact-target prebuilt Core', () => {
    assert.match(source, /\[switch\]\$ReadyInstallCold/);
    assert.match(source, /-FirstProjectCold and -ReadyInstallCold are mutually exclusive/);
    assert.match(source, /CK_BENCHMARK_READY_INSTALL_COLD/);
    assert.match(embeddedNode, /\? 'readyInstallCold'/);
    assert.match(embeddedNode, /\? 'clear_board_ready_install_project_compile_cache'/);
    assert.match(embeddedNode, /result\.cycles\.cold\.exactMatch !== false/);
    assert.match(embeddedNode, /result\.cycles\.cold\.fastRelink !== true/);
    assert.match(embeddedNode, /result\.cycles\.cold\.fullBuild !== false/);
    assert.match(embeddedNode, /result\.cycles\.cold\.prebuiltCoreInjected !== true/);
    assert.match(embeddedNode, /result\.cycles\.cold\.syntheticCcdbPrepared !== true/);
    assert.match(embeddedNode, /result\.cycles\.cold\.arduinoCliCcdbRefreshObserved !== false/);
    assert.match(embeddedNode, /result\.cacheClear\?\.prebuilt_core_preserved !== true/);
    assert.match(embeddedNode, /result\.cacheClear\?\.prebuilt_core_validated !== true/);
});

test('ready-install CCDB evidence accepts only synthetic success and exposes every CLI fallback', () => {
    const synthetic = parseMetrics([
        '[Timing DIAG] fast_relink_ccdb_prepare method=synthetic duration_ms=17 status=success',
    ].join('\n'));
    assert.equal(synthetic.syntheticCcdbPrepared, true);
    assert.equal(synthetic.arduinoCliCcdbRefreshObserved, false);

    const failedSynthetic = parseMetrics([
        '[Timing DIAG] fast_relink_ccdb_prepare method=synthetic duration_ms=17 status=failed',
        '[Timing DIAG] fast_relink_ccdb_prepare method=synthetic duration_ms=18 status=not_created',
    ].join('\n'));
    assert.equal(failedSynthetic.syntheticCcdbPrepared, false);
    assert.equal(failedSynthetic.arduinoCliCcdbRefreshObserved, false);

    const generic = parseMetrics([
        '[Timing DIAG] fast_relink_ccdb_prepare method=sibling duration_ms=9 status=success',
        '[INFO] fast_relink_ccdb_prepare method=synthetic duration_ms=1 status=success',
    ].join('\n'));
    assert.equal(generic.syntheticCcdbPrepared, false);
    assert.equal(generic.arduinoCliCcdbRefreshObserved, false);

    const cliFallback = parseMetrics([
        '[Timing DIAG] fast_relink_ccdb_prepare method=synthetic duration_ms=17 status=success',
        '[Timing DIAG] fast_relink_ccdb_prepare method=arduino-cli-only-compilation-database duration_ms=60234 status=success',
    ].join('\n'));
    assert.equal(cliFallback.syntheticCcdbPrepared, true);
    assert.equal(cliFallback.arduinoCliCcdbRefreshObserved, true);

    assert.match(embeddedNode, /Core cache injected directly\|fast_relink_ccdb_prepare\|Sketch file updated/);
});

test('waits for two stable generated-source samples before clearing cache', () => {
    assert.match(embeddedNode, /data-ck-code-fingerprint/);
    assert.match(embeddedNode, /data-ck-include-signature/);
    assert.match(embeddedNode, /consecutiveStableSamples >= 2/);
    assert.match(embeddedNode, /state\.hasWifiConnect && !includeHeaders\.includes\('wifi\.h'\)/);
    assert.match(embeddedNode, /const initialSource = await waitForStableGeneratedSource\(\)/);
    assert.ok(embeddedNode.indexOf('const initialSource = await waitForStableGeneratedSource()')
        < embeddedNode.indexOf('const cacheClearCommand'));
});

test('tracks a real operation transition and accepts the current Chinese upload marker', () => {
    assert.match(embeddedNode, /data-ck-role="build-compile-action"/);
    assert.match(embeddedNode, /data-ck-role="build-normal-upload-action"/);
    assert.doesNotMatch(embeddedNode, /item\.title === '\\u7f16\\u8bd1'/);
    assert.doesNotMatch(embeddedNode, /item\.title\.startsWith\('\\u666e\\u901a\\u4e0a\\u4f20'\)/);
    assert.match(embeddedNode, /new MutationObserver\(\(records\) =>/);
    assert.match(embeddedNode, /attributeOldValue: true/);
    assert.match(embeddedNode, /state\.seenActive && !state\.active && state\.ready/);
    assert.ok(embeddedNode.includes(String.raw`/\u666e\u901a(?:\u56fa\u4ef6)?\u4e0a\u4f20\u6210\u529f/`));
});

test('upload lock gate distinguishes measured zero from missing telemetry', () => {
    const measured = parseMetrics('[Timing] Upload compile lock wait (quick-fast-upload): 0.0s\n');
    assert.equal(measured.compileLockWaitReported, true);
    assert.equal(measured.compileLockSeconds, 0);
    assert.equal(measured.uploadCompileLockWaitReported, true);
    assert.equal(measured.uploadCompileLockSeconds, 0);
    assert.equal(analyzeUploadCompileLock(measured).status, 'passed');

    const missing = parseMetrics('[Timing] Upload CLI compile phase (quick-fast-upload): 0.8s\n');
    assert.equal(missing.compileLockWaitReported, false);
    assert.equal(missing.compileLockSeconds, 0);
    const audit = analyzeUploadCompileLock(missing);
    assert.equal(audit.status, 'failed');
    assert.match(audit.failures.join(' '), /telemetry was not reported/i);
});

test('generic compile-lock telemetry cannot satisfy the upload gate', () => {
    const generic = parseMetrics('[Timing] Compile lock wait: 0.0s\n');
    assert.equal(generic.compileLockWaitReported, true);
    assert.equal(generic.uploadCompileLockWaitReported, false);
    assert.equal(analyzeUploadCompileLock(generic).status, 'failed');

    const malformed = parseMetrics('[Timing] Upload compile lock wait (quick-fast-upload): 1..2s\n');
    assert.equal(malformed.uploadCompileLockWaitReported, false);
    assert.equal(analyzeUploadCompileLock(malformed).status, 'failed');
});

test('upload lock gate rejects long waits and background warmup reuse', () => {
    const metrics = parseMetrics([
        '[Timing] Upload compile lock wait (quick-fast-upload): 5.1s',
        '[INFO] Upload is reusing compatible same-board warmup already in progress.',
        '[INFO] First-compile optimization: waited for matching warmup window (<=900ms)',
    ].join('\n'));
    const audit = analyzeUploadCompileLock(metrics, 5);
    assert.equal(audit.status, 'failed');
    assert.equal(audit.reported, true);
    assert.equal(audit.seconds, 5.1);
    assert.equal(audit.matchingWarmupWaitObserved, true);
    assert.equal(audit.compatibleWarmupReuseObserved, true);
    assert.equal(audit.failures.length, 3);
});

test('benchmark makes the upload lock audit a mandatory pre-baseline gate', () => {
    assert.match(embeddedNode, /result\.uploadCompileLock = analyzeUploadCompileLock\(uploadMetrics, 5\)/);
    assert.match(embeddedNode, /if \(result\.uploadCompileLock\.status !== 'passed'\)/);
    assert.ok(
        embeddedNode.indexOf("result.uploadCompileLock = analyzeUploadCompileLock(uploadMetrics, 5)")
          < embeddedNode.indexOf('result.verified_baseline = await captureVerifiedBaseline'),
        'a slow or unmeasured lock wait must fail before publishing a verified baseline',
    );
});

test('benchmark retains raw warmup markers for independent release-manifest review', () => {
    assert.match(embeddedNode, /matching warmup/);
    assert.match(embeddedNode, /Reusing compatible same-board warmup/);
});

test('exposes optional strict progress evidence without starting another upload', () => {
    assert.match(source, /\[string\]\$ProgressOutputPath = ''/);
    assert.match(source, /\[switch\]\$RequireUploadProgress/);
    assert.match(source, /function Initialize-NativeBenchmarkReportPaths/);
    assert.match(source, /foreach \(\$path in \$Paths\)[\s\S]*?IsNullOrWhiteSpace\(\$path\)[\s\S]*?Initialize-NativeEvidenceReportPath -Path \$path/);
    assert.equal(
        (source.match(/Initialize-NativeBenchmarkReportPaths -Paths @\(\$OutputPath, \$ProgressOutputPath\)/g) || []).length,
        3,
        'initialization, run failure, and binding failure must all ignore omitted optional paths',
    );
    assert.doesNotMatch(source, /Initialize-NativeEvidenceReportPath -Path \$ProgressOutputPath/);
    assert.match(source, /CK_BENCHMARK_PROGRESS_OUTPUT/);
    assert.match(source, /CK_BENCHMARK_REQUIRE_UPLOAD_PROGRESS/);
    assert.match(source, /Upload progress capture cannot be requested together with -SkipUpload/);
    assert.equal((embeddedNode.match(/await runOperation\('upload'\)/g) || []).length, 1);
    assert.match(embeddedNode, /progressOutputPath/);
    assert.match(embeddedNode, /Upload progress evidence failed/);
    assert.match(embeddedNode, /status:\s*progressAnalysis\.success \? 'passed' : 'failed'/);
    assert.match(embeddedNode, /benchmarkRunId:\s*result\.runId/);
    assert.match(embeddedNode, /writeJsonAtomic\(progressOutputPath, sanitizeEvidenceValue\(result\.uploadProgress\)\)/);
    assert.match(embeddedNode, /samples:\s*captured/);
});

test('captures deduplicated upload samples from the existing 200ms polling loop', () => {
    assert.match(embeddedNode, /overlay\?\.dataset\.ckProgressMode === 'upload'/);
    assert.match(embeddedNode, /overlay\.dataset\.ckProgressPercentage/);
    assert.match(embeddedNode, /visiblePercentageText/);
    assert.match(embeddedNode, /percentage\.clientWidth/);
    assert.match(embeddedNode, /percentage\.scrollWidth/);
    assert.match(embeddedNode, /progressSamples\.splice\(0\)/);
    assert.match(embeddedNode, /characterData: true/);
    assert.match(embeddedNode, /recordUploadProgressSample\(uploadProgressSamples, uploadProgressSeenKeys/);
    assert.match(embeddedNode, /await wait\(200\)/);

    const samples = [];
    const seen = new Set();
    const add = (percentage, visiblePercentageText, elapsedMs) => recordUploadProgressSample(samples, seen, {
        elapsedMs,
        stage: 'uploading',
        message: `Uploading total ${percentage}%`,
        visiblePercentageText,
        percentage,
        textClientWidth: 36,
        textScrollWidth: 24,
    });
    assert.equal(add(0, '0%', 10), true);
    assert.equal(add(14, '14%', 200), true);
    assert.equal(add(14, '14%', 400), false);
    assert.equal(add(73, '73%', 800), true);
    assert.equal(add(100, '100%', 1200), true);
    assert.equal(samples.length, 4);

    const audit = analyzeUploadProgress(samples);
    assert.equal(audit.success, true);
    assert.equal(audit.valuesBounded, true);
    assert.equal(audit.monotonic, true);
    assert.equal(audit.hasTwoDigitPercentage, true);
    assert.equal(audit.finalPercentageIs100, true);
    assert.equal(audit.percentageTextComplete, true);
    assert.equal(audit.percentageTextFits, true);
});

test('strict progress analysis rejects regression, cropped digits, and a missing final 100%', () => {
    const regressedAndCropped = analyzeUploadProgress([
        { percentage: 0, visiblePercentageText: '0%', textFits: true },
        { percentage: 62, visiblePercentageText: '2%', textFits: false },
        { percentage: 41, visiblePercentageText: '41%', textFits: true },
        { percentage: 100, visiblePercentageText: '100%', textFits: true },
    ]);
    assert.equal(regressedAndCropped.success, false);
    assert.equal(regressedAndCropped.monotonic, false);
    assert.equal(regressedAndCropped.percentageTextComplete, false);
    assert.equal(regressedAndCropped.percentageTextFits, false);

    const unfinished = analyzeUploadProgress([
        { percentage: 0, visiblePercentageText: '0%', textFits: true },
        { percentage: 9, visiblePercentageText: '9%', textFits: true },
    ]);
    assert.equal(unfinished.success, false);
    assert.equal(unfinished.hasTwoDigitPercentage, false);
    assert.equal(unfinished.finalPercentageIs100, false);

    const outOfRange = analyzeUploadProgress([
        { percentage: 101, visiblePercentageText: '101%', textFits: true },
    ]);
    assert.equal(outOfRange.success, false);
    assert.equal(outOfRange.valuesBounded, false);
});

test('refuses to mislabel cold, exact, and hot-edit cycles', () => {
    assert.ok(embeddedNode.includes(String.raw`Cached build \(Exact Match\)`));
    assert.match(embeddedNode, /cold\.fullBuild \|\| result\.cycles\.cold\.exactMatch/);
    assert.match(embeddedNode, /if \(!result\.cycles\.exact\.exactMatch\)/);
    assert.match(embeddedNode, /hotEdit\.exactMatch \|\| !result\.cycles\.hotEdit\.codeChanged/);
    assert.match(embeddedNode, /exactPriming/);
});

test('records one session identity and intentional skips for the unified summary', () => {
    assert.match(embeddedNode, /schemaId: 'ck\.native-compile-upload-benchmark'/);
    assert.match(embeddedNode, /runId: `native-\$\{Date\.now\(\)\}-\$\{process\.pid\}`/);
    assert.match(embeddedNode, /evidenceScope: 'single-native-session'/);
    assert.match(embeddedNode, /schemaId: 'ck\.native-compile-upload-operation'[\s\S]*?success: true/);
    assert.match(embeddedNode, /schemaId: 'ck\.native-upload-progress'/);
    assert.match(embeddedNode, /coldMode: process\.env\.CK_BENCHMARK_SKIP_COLD/);
    assert.match(embeddedNode, /skippedStages: \[\]/);
    assert.match(embeddedNode, /stage: 'cold', reason: 'requested by -SkipCold'/);
    assert.match(embeddedNode, /stage: 'upload', reason: 'requested by -SkipUpload'/);
});

test('publishes only compile cycles with a consistent include signature', () => {
    assert.match(embeddedNode, /parseReportedIncludeHeaders/);
    assert.match(embeddedNode, /includeHeadersReported: includeReport\.reported/);
    assert.match(embeddedNode, /\['cold', cycles\.cold\]/);
    assert.match(embeddedNode, /\['exact', cycles\.exact\]/);
    assert.match(embeddedNode, /\['hotEdit', cycles\.hotEdit\]/);
    assert.match(embeddedNode, /if \(!sameHeaderList\(cycle\.includeHeaders, expectedHeaders\)\)/);
    assert.match(embeddedNode, /result\.includeConsistency = assertCompileIncludeConsistency/);
});

test('requires a delay-only hot edit to change code without changing includes', () => {
    assert.match(embeddedNode, /initialSource\.codeFingerprint/);
    assert.match(embeddedNode, /Delay-only source edit changed the generated include signature/);
    assert.match(embeddedNode, /cycles\.hotEdit\?\.includeHeadersChanged/);
    assert.match(embeddedNode, /Boolean\(hotDelta\?\.added\?\.length\)/);
    assert.match(embeddedNode, /Delay-only hot edit reported a non-empty include delta/);
    assert.match(embeddedNode, /include headers delta/);
    assert.match(embeddedNode, /include delta\\s\*\\\(/);
});

test('normalizes reported includes and rejects a real hot-edit delta', () => {
    const stableLog = [
        '[INFO] Sketch include headers (1):',
        '[INFO] Include Header: WiFi.h',
        '[DIAG] include headers delta: added=[(none)] removed=[(none)]',
    ].join('\n');
    const stableMetrics = parseMetrics(stableLog);
    assert.deepEqual(stableMetrics.includeHeaders, ['wifi.h']);
    assert.deepEqual(stableMetrics.includeHeadersDelta, {
        reported: true,
        added: [],
        removed: [],
    });
    assert.doesNotThrow(() => assertCompileIncludeConsistency({
        cold: stableMetrics,
        exact: stableMetrics,
        hotEdit: stableMetrics,
    }, { includeHeaders: ['wifi.h'] }, { includeHeaders: ['WiFi.h'] }));

    const changedMetrics = parseMetrics(`${stableLog}\n[INFO] Fast Relink probe: small include delta (added=[SPI.h], removed=[(none)]).`);
    assert.throws(() => assertCompileIncludeConsistency({
        cold: stableMetrics,
        exact: stableMetrics,
        hotEdit: changedMetrics,
    }, { includeHeaders: ['wifi.h'] }, { includeHeaders: ['wifi.h'] }), /non-empty include delta/);
});

test('captures forced cold-reset and cache-reuse facts for future summaries', () => {
    const metrics = parseMetrics([
        '[INFO] Forced rebuild requested: cleared 7 board cache entries (80.0 MiB); ccache will be refreshed.',
        '[INFO] Core cache injected directly from prebuilt_cores repository',
        '[INFO] Forced rebuild: bypassing existing ccache hits for this compile.',
    ].join('\n'));
    assert.equal(metrics.forcedRebuildObserved, true);
    assert.equal(metrics.forceCcacheRecacheObserved, true);
    assert.equal(metrics.prebuiltCoreInjected, true);
    assert.match(embeddedNode, /Forced rebuild\|ccache will be refreshed\|bypassing existing ccache hits\|Core cache injected directly/);
});

test('labels the hot-edit improvement target without implying a cold-build target result', () => {
    assert.match(embeddedNode, /result\.hotEditTarget30PercentMet/);
    assert.match(embeddedNode, /result\.hotEditTarget40PercentMet/);
    assert.doesNotMatch(embeddedNode, /result\.target30PercentMet/);
    assert.doesNotMatch(embeddedNode, /result\.target40PercentMet/);
});

test('edits and restores one identified delay field rather than an arbitrary number block', () => {
    assert.match(embeddedNode, /delayBlockType/);
    assert.match(embeddedNode, /fieldBlockId/);
    assert.match(embeddedNode, /workspace\?\.getBlockById\(edit\.fieldBlockId\)/);
    assert.match(embeddedNode, /const delayPreflight = await mutateDelay\(0\)/);
    assert.ok(embeddedNode.indexOf('const delayPreflight = await mutateDelay(0)')
        < embeddedNode.indexOf('const cacheClearCommand'));
    assert.match(embeddedNode, /if \(!await restoreDelay\(delayEdit\)\)/);
    assert.doesNotMatch(embeddedNode, /find\(\(block\) => block\.type === 'math_number'\)/);
});

test('waits for a confirmed project save after restoring the edit', () => {
    assert.match(embeddedNode, /new KeyboardEvent\('keydown'/);
    assert.match(embeddedNode, /project save result/);
    assert.match(embeddedNode, /if \(!await saveProject\(\)\)/);
});
