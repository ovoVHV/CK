import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { spawnSync } from 'node:child_process';
import test from 'node:test';
import {
    mkdir,
    mkdtemp,
    readFile,
    readdir,
    rename,
    rm,
    stat,
    symlink,
    utimes,
    writeFile,
} from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { dirname, join } from 'node:path';

const scriptPath = new URL('./New-ReleaseEvidenceManifest.ps1', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const sourceManifestScriptPath = new URL('./New-SourceTreeManifest.ps1', import.meta.url).pathname.replace(/^\/(.:)/, '$1');
const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';

const requiredGateNames = [
    'source-tree-freeze-preflight',
    'version-consistency',
    'bundled-resource-contract',
    'rustfmt',
    'desktop-frontend-tests',
    'release-and-package-script-tests',
    'ck-core-tests',
    'arduino-rust-tests',
    'desktop-rust-tests',
    'deterministic-example-packages',
    'extension-sdk',
    'desktop-production-build',
    'desktop-installers',
    'source-tree-freeze-postflight',
];

const nativeSmokeCheckNames = [
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
    'no-horizontal-overflow',
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
    'cleanup-restored-final-state',
];

const memoryCheckNames = [
    'renderer-heap-delta-within-5-mib',
    'dom-node-delta-within-1500',
    'dom-document-delta-within-1',
    'dom-event-listener-delta-within-3',
    'resident-process-tree-private-delta-within-32-mib',
    'blockly-workspace-registry-does-not-grow',
    'renderer_heap-has-no-persistent-linear-growth',
    'dom_nodes-has-no-persistent-linear-growth',
    'dom_documents-has-no-persistent-linear-growth',
    'dom_event_listeners-has-no-persistent-linear-growth',
    'resident_process_tree_private-has-no-persistent-linear-growth',
    'dashboard-renderer-heap-delta-within-5-mib',
    'dashboard-dom-node-delta-within-1500',
    'dashboard-dom-document-delta-within-1',
    'dashboard-dom-event-listener-delta-within-3',
    'dashboard-resident-process-tree-private-delta-within-32-mib',
    'dashboard-blockly-workspace-registry-does-not-grow',
    'dashboard-renderer_heap-has-no-persistent-linear-growth',
    'dashboard-dom_nodes-has-no-persistent-linear-growth',
    'dashboard-dom_documents-has-no-persistent-linear-growth',
    'dashboard-dom_event_listeners-has-no-persistent-linear-growth',
    'dashboard-resident_process_tree_private-has-no-persistent-linear-growth',
    'dashboard-releases-current-blockly-workspace-every-cycle',
    'workspace-owns-only-current-blockly-tree-every-cycle',
    'published-route-samples-have-zero-process-pollution',
    'project-code-fingerprint-remains-stable',
];

const safeCancelCheckNames = [
    'normal-upload-button-started',
    'real-arduino-cli-or-gcc-stage-observed',
    'cancel-command-matched-upload-run-id',
    'backend-terminated-and-waited-owned-process-tree',
    'no-flash-transport-before-cancel',
    'ck-tool-tree-and-global-orphans-continuously-zero',
    'recovery-compile-new-run-id-succeeded',
    'compile-lock-released-within-5-seconds',
    'source-fqbn-and-port-unchanged',
];

const exampleNames = [
    'ck_example_c6_board.zip',
    'ck_example_i2c_sensor_v2.zip',
    'ck_example_nano_board.zip',
    'ck_example_native_deep.zip',
    'ck_example_serial_blocks.zip',
];
const exactC6Fqbn = 'esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB';

const sha256 = (value) => createHash('sha256').update(value).digest('hex');

async function write(root, relativePath, contents) {
    const target = join(root, relativePath);
    await mkdir(dirname(target), { recursive: true });
    await writeFile(target, contents);
    return target;
}

async function identity(root, relativePath) {
    const bytes = await readFile(join(root, relativePath));
    return {
        path: relativePath.replaceAll('\\', '/'),
        bytes: bytes.length,
        sha256: sha256(bytes),
    };
}

function run(root, extraArguments = [], maximumEvidenceAgeHours = '24') {
    return spawnSync(
        shell,
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            scriptPath,
            '-Root',
            root,
            '-MaximumEvidenceAgeHours',
            maximumEvidenceAgeHours,
            ...extraArguments,
        ],
        { encoding: 'utf8' },
    );
}

async function readJson(root, relativePath) {
    return JSON.parse(await readFile(join(root, relativePath), 'utf8'));
}

async function mutateJson(root, relativePath, mutate) {
    const value = await readJson(root, relativePath);
    await mutate(value);
    await writeFile(join(root, relativePath), `${JSON.stringify(value)}\n`);
    return value;
}

function issues(manifest) {
    return [...manifest.issues.failed, ...manifest.issues.stale];
}

function assertRejected(result, manifest, issueId) {
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    assert.notEqual(manifest.status, 'passed');
    assert.ok(
        issues(manifest).some((entry) => entry.id === issueId),
        `${issueId} was not reported: ${JSON.stringify(manifest.issues)}`,
    );
}

async function createFrozenSourceTree(root) {
    for (const directory of ['.cargo', 'apps/desktop/src', 'crates', 'docs', 'examples', 'scripts']) {
        await mkdir(join(root, directory), { recursive: true });
    }
    for (const [relativePath, contents] of [
        ['apps/desktop/src/product.txt', 'frozen-product-source\n'],
        ['Cargo.lock', '# fixture Cargo.lock\n'],
        ['Cargo.toml', '[workspace]\nmembers = []\n'],
        ['README.md', '# fixture\n'],
        ['tools/ccache.exe', 'fixture-ccache'],
    ]) {
        await write(root, relativePath, Buffer.from(contents));
    }
    const result = spawnSync(
        shell,
        [
            '-NoProfile',
            '-ExecutionPolicy',
            'Bypass',
            '-File',
            sourceManifestScriptPath,
            '-Mode',
            'Create',
            '-Root',
            root,
        ],
        { encoding: 'utf8' },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);

    const manifestRelative = 'artifacts/release/source-tree-manifest.json';
    const freezeRelative = 'artifacts/release/source-tree-freeze.json';
    const sourceManifest = await readJson(root, manifestRelative);
    const manifestBytes = await readFile(join(root, manifestRelative));
    const freeze = await readJson(root, freezeRelative);
    // Real captures take minutes. Backdating only the separate observation time
    // keeps this fast fixture's gate/native windows realistic without changing
    // the canonical source-manifest bytes verified by the authoritative tool.
    freeze.frozen_at = new Date(Date.now() - 10 * 60_000).toISOString();
    await writeFile(join(root, freezeRelative), `${JSON.stringify(freeze)}\n`);
    const freezeBytes = await readFile(join(root, freezeRelative));
    return {
        frozenAt: freeze.frozen_at,
        manifestSha256: sha256(manifestBytes),
        treeSha256: sourceManifest.tree_sha256,
        freezeSha256: sha256(freezeBytes),
    };
}

async function makeFixture({ sensitiveReportValues = false } = {}) {
    const root = await mkdtemp(join(tmpdir(), 'ck-release-evidence-'));
    const { frozenAt, manifestSha256, treeSha256, freezeSha256 } = await createFrozenSourceTree(root);
    const now = Date.now();

    const exePath = 'target/release/appsdesktop.exe';
    const msiPath = 'target/release/bundle/msi/CK_1.0.0_x64_en-US.msi';
    const nsisPath = 'target/release/bundle/nsis/CK_1.0.0_x64-setup.exe';
    const sdkPath = 'artifacts/release/CK-Extension-SDK-1.0.0.zip';
    await write(root, exePath, Buffer.from('fixture-production-executable'));
    await write(root, msiPath, Buffer.from('fixture-msi'));
    await write(root, nsisPath, Buffer.from('fixture-nsis'));
    await write(root, sdkPath, Buffer.from('fixture-extension-sdk'));
    const executable = await identity(root, exePath);
    const msi = await identity(root, msiPath);
    const nsis = await identity(root, nsisPath);
    const sdk = await identity(root, sdkPath);

    const examples = [];
    for (const name of exampleNames) {
        const relative = `examples/importable-packages/${name}`;
        await write(root, relative, Buffer.from(`fixture:${name}`));
        const record = await identity(root, relative);
        examples.push({ name, bytes: record.bytes, sha256: record.sha256 });
    }

    const generatorAuditPath = 'artifacts/release/builtin-block-generator-audit.json';
    const coreCompatibilityPath = 'artifacts/release/core-compatibility-results.json';
    const generatorAudit = {
        schema: 'ck-builtin-block-generator-audit',
        version: 1,
        hardwareTested: false,
        counts: { toolboxTypes: 147, targetRuns: 294, passed: 294, failed: 0 },
    };
    const coreCompatibility = {
        schema: 'ck-core-compatibility-results',
        version: 1,
        evidence: 'compile-only',
        hardwareTested: false,
        generatorOnly: true,
        blockEvidenceCounts: { blocks: 147, targetCells: 294, staticGenerationPass: 294 },
        results: Array.from({ length: 7 }, (_, index) => ({
            TargetId: `fixture-target-${index + 1}`,
            Passed: true,
            Evidence: 'compile-only',
            Source: 'built-in-generator',
            HardwareTested: false,
        })),
    };
    await write(root, generatorAuditPath, `${JSON.stringify(generatorAudit)}\n`);
    await write(root, coreCompatibilityPath, `${JSON.stringify(coreCompatibility)}\n`);
    const compatibilityTime = new Date(now - 30_000);
    await utimes(join(root, generatorAuditPath), compatibilityTime, compatibilityTime);
    await utimes(join(root, coreCompatibilityPath), compatibilityTime, compatibilityTime);
    const generatorAuditIdentity = await identity(root, generatorAuditPath);
    const coreCompatibilityIdentity = await identity(root, coreCompatibilityPath);
    const generatorAuditStat = await stat(join(root, generatorAuditPath));
    const coreCompatibilityStat = await stat(join(root, coreCompatibilityPath));

    const startedAt = new Date(now - 8 * 60_000).toISOString();
    const generatedAt = new Date(now - 7 * 60_000).toISOString();
    const finishedAt = new Date(now - 6 * 60_000).toISOString();
    const runId = 'fixture-release-gate-1';
    const gate = {
        schema_version: 2,
        expected_version: '1.0.0',
        run_id: runId,
        started_at: startedAt,
        finished_at: finishedAt,
        status: 'passed',
        coverage: {
            automated_release_gates: 'complete',
            skipped_gate_count: 0,
            desktop_bundle_gate: 'complete',
        },
        gates: requiredGateNames.map((name) => ({ name, status: 'passed' })),
        source_tree: {
            required: true,
            verified_before_gate: true,
            verified_after_gate: true,
            identity: {
                policy_id: 'ck-source-tree-v1',
                manifest_path: 'artifacts/release/source-tree-manifest.json',
                freeze_record_path: 'artifacts/release/source-tree-freeze.json',
                manifest_sha256: manifestSha256,
                tree_sha256: treeSha256,
                frozen_at: frozenAt,
                source_control: { kind: 'none', commit: null },
            },
        },
        example_packages: examples,
        compatibility_reports: [
            {
                role: 'builtin-block-generator-audit',
                ...generatorAuditIdentity,
                generated_at: generatorAuditStat.mtime.toISOString(),
                schema: 'ck-builtin-block-generator-audit',
                version: 1,
                hardware_tested: false,
                counts: { toolbox_types: 147, target_runs: 294, passed: 294, failed: 0 },
            },
            {
                role: 'core-compatibility-results',
                ...coreCompatibilityIdentity,
                generated_at: coreCompatibilityStat.mtime.toISOString(),
                schema: 'ck-core-compatibility-results',
                version: 1,
                hardware_tested: false,
                generator_only: true,
                evidence: 'compile-only',
                counts: {
                    blocks: 147,
                    target_cells: 294,
                    static_generation_pass: 294,
                    generated_results: 7,
                    passed: 7,
                },
            },
        ],
        release_assets: [
            { role: 'extension-sdk', ...sdk, generated_at: generatedAt },
            { role: 'portable-executable', ...executable, generated_at: generatedAt, version: '1.0.0' },
        ],
        desktop_bundles: [
            { ...msi, generated_at: generatedAt, version: '1.0.0' },
            { ...nsis, generated_at: generatedAt, version: '1.0.0' },
        ],
    };
    const gateText = `${JSON.stringify(gate)}\n`;
    await write(root, 'artifacts/release/v1-release-gates.json', gateText);
    const gateSha256 = sha256(Buffer.from(gateText));
    const capturedAt = new Date(now - 5 * 60_000).toISOString();
    const processStartedAt = new Date(now - 5.9 * 60_000).toISOString();
    const browserStartedAt = new Date(now - 5.8 * 60_000).toISOString();
    const sourceTree = {
        manifest_path: 'artifacts/release/source-tree-manifest.json',
        manifest_sha256: manifestSha256,
        freeze_record_path: 'artifacts/release/source-tree-freeze.json',
        freeze_record_sha256: freezeSha256,
        tree_sha256: treeSha256,
        frozen_at: frozenAt,
    };
    const cdpBinding = {
        bound: true,
        debug_port: 9223,
        process_id: 1234,
        browser_process_id: 5678,
        browser_host_process_id: 5678,
        browser_host_path: 'msedgewebview2.exe',
        browser_host_started_at: browserStartedAt,
        listener_owning_process_id: 5678,
        target_id: 'fixture-cdp-target',
        target_type: 'page',
        target_url: 'http://tauri.localhost/',
        web_socket_debugger_url: 'ws://127.0.0.1:9223/devtools/page/fixture-cdp-target',
        executable_sha256: executable.sha256,
    };
    const gateRun = {
        run_id: runId,
        finished_at: finishedAt,
        report_path: 'artifacts/release/v1-release-gates.json',
        report_sha256: gateSha256,
        status: 'passed',
    };
    const binding = {
        capturedAt,
        source_tree: sourceTree,
        executable: {
            ...executable,
            process_id: 1234,
            process_started_at: processStartedAt,
        },
        cdp_binding: cdpBinding,
        gate_run: gateRun,
        binding_verification: {
            schema_version: 1,
            verified_before_at: new Date(now - 5.5 * 60_000).toISOString(),
            verified_after_at: new Date(now - 4.5 * 60_000).toISOString(),
            unchanged: true,
        },
    };
    const sensitive = sensitiveReportValues ? {
        diagnosticMac: 'AA:BB:CC:DD:EE:FF',
        diagnosticBareMac: 'AABBCCDDEEFF',
        diagnosticDottedMac: 'aabb.ccdd.eeff',
        diagnosticPath: 'C:\\Users\\Alice\\private\\project.maker',
        diagnosticNonUserPath: 'D:\\private-lab\\fixture\\project.maker',
        diagnosticUncPath: '\\\\private-server\\private-share\\project.maker',
        diagnosticFileUri: 'file:///C:/private/project.maker',
    } : {};
    const memoryCycles = Array.from({ length: 10 }, (_, index) => ({
        cycle: index + 1,
        dashboard: { process_tree: { pollution_process_count: 0, pollution_processes: [] } },
        workspace: { process_tree: { pollution_process_count: 0, pollution_processes: [] } },
    }));
    const benchmarkRunId = 'native-fixture-c6-run';
    const progressSamples = [
        {
            elapsedMs: 100,
            stage: 'uploading',
            message: 'Connecting',
            visiblePercentageText: '0%',
            percentage: 0,
            textClientWidth: 27,
            textScrollWidth: 27,
            textFits: true,
        },
        {
            elapsedMs: 500,
            stage: 'uploading',
            message: 'Writing application',
            visiblePercentageText: '42%',
            percentage: 42,
            textClientWidth: 27,
            textScrollWidth: 27,
            textFits: true,
        },
        {
            elapsedMs: 1_900,
            stage: 'uploading',
            message: 'Complete',
            visiblePercentageText: '100%',
            percentage: 100,
            textClientWidth: 27,
            textScrollWidth: 27,
            textFits: true,
        },
    ];
    const uploadProgress = {
        schemaVersion: 1,
        status: 'passed',
        benchmarkRunId,
        project: 'c6_regression',
        fqbn: exactC6Fqbn,
        port: 'COM12',
        operationWallSeconds: 2,
        success: true,
        sampleCount: progressSamples.length,
        minPercent: 0,
        maxPercent: 100,
        valuesBounded: true,
        integerPercentages: true,
        monotonic: true,
        hasTwoDigitPercentage: true,
        finalPercentageIs100: true,
        percentageTextComplete: true,
        percentageTextFits: true,
        failures: [],
        samples: progressSamples,
    };
    const performanceSamples = {
        firstProjectCold: [100, 110, 120].map((seconds, index) => ({
            sampleId: `firstProjectCold-0${index + 1}-${String(index + 1).repeat(12)}`,
            seconds,
        })),
        readyInstallCold: [60, 70, 80].map((seconds, index) => ({
            sampleId: `readyInstallCold-0${index + 1}-${String(index + 4).repeat(12)}`,
            seconds,
        })),
    };
    const firstCompilePerformance = {
        schemaId: 'ck.first-compile-performance-summary',
        schemaVersion: 1,
        status: 'passed',
        generatedAt: new Date(now - 4 * 60_000).toISOString(),
        evidenceMode: 'direct-local-file-verification-no-build-executed',
        attestationBoundary: 'same-source-files-directly-verified-not-a-cryptographic-signer',
        policy: {
            minimumSamplesPerMode: 3,
            requireExactSamplesPerMode: true,
            maximumCompileLockSeconds: 5,
            percentileMethod: 'nearest-rank',
            targetImprovementPercent: 30,
            requireMedianAndP95: true,
            requireSuccessfulUploadBaseline: true,
            requiredTemporalSequence: [
                'firstProjectCold',
                'readyInstallCold',
                'firstProjectCold',
                'readyInstallCold',
                'firstProjectCold',
                'readyInstallCold',
            ],
            requireNonOverlappingSamples: true,
            requireGateExecutableSampleOrder: true,
            maximumBatchSpanHours: 2,
            maximumEvidenceAgeHours: 72,
            futureTimestampToleranceMinutes: 5,
            compileProfilesByColdMode: {
                firstProjectCold: { cold: 'quick-fast', upload: 'quick-fast' },
                readyInstallCold: { cold: 'quick-fast', upload: 'shared-fast' },
            },
            cacheClearByColdMode: {
                firstProjectCold: {
                    reset_scope: 'first-project-full-fqbn',
                    ccache_store_preserved: true,
                    prebuilt_core_preserved: false,
                    prebuilt_core_validated: false,
                    force_rebuild_pending: false,
                    force_ccache_recache: false,
                },
                readyInstallCold: {
                    reset_scope: 'ready-install-project-full-fqbn',
                    ccache_store_preserved: true,
                    prebuilt_core_preserved: true,
                    prebuilt_core_validated: true,
                    force_rebuild_pending: false,
                    force_ccache_recache: false,
                },
            },
        },
        batch: {
            spanSeconds: 45 * 60,
            expiresAt: new Date(
                Date.parse(binding.binding_verification.verified_before_at) + 72 * 60 * 60_000,
            ).toISOString(),
        },
        binding: {
            project: 'c6_regression',
            port: 'COM12',
            fqbn: exactC6Fqbn,
            initialSource: {
                sourceFingerprintBindingSha256: sha256(Buffer.from('fixture-source-before')),
                includeSignature: 'wifi.h',
            },
            sourceTree: {
                treeSha256,
                manifestSha256,
                freezeRecordSha256: freezeSha256,
            },
            gateRun: { reportSha256: gateSha256, status: 'passed' },
            executable: {
                sha256: executable.sha256,
                bytes: executable.bytes,
                processId: 1234,
            },
            environment: {
                fqbn: exactC6Fqbn,
                coreId: 'esp32:esp32',
                coreVersion: '3.3.6',
                arduinoCliVersion: '1.4.1',
                toolchainKey: 'fixture-toolchain',
                buildSignature: 'fixture-build-signature',
                compileProfile: 'quick-fast',
                optimization: '-O1',
            },
            device: {
                chip: 'ESP32-C6',
                revision: null,
                flashBytes: 16 * 1024 * 1024,
                psramBytes: null,
            },
        },
        samples: performanceSamples,
        statistics: {
            firstProjectCold: { count: 3, medianSeconds: 110, maxSeconds: 120, p95Seconds: 120 },
            readyInstallCold: { count: 3, medianSeconds: 70, maxSeconds: 80, p95Seconds: 80 },
        },
        improvementPercent: {
            median: 36.36,
            p95: 33.33,
            medianTargetMet: true,
            p95TargetMet: true,
        },
        failures: [],
    };
    const reports = new Map([
        ['first-compile-performance-summary.json', firstCompilePerformance],
        ['v1-native-smoke.json', {
            schemaVersion: 3,
            test_id: 'ck-production-native-editor-smoke-v1',
            status: 'passed',
            project: { requested_name: 'c6_regression', fqbn: exactC6Fqbn },
            checks: nativeSmokeCheckNames.map((id) => ({ id, passed: true })),
            failures: [],
            cleanup: {
                themeRestored: true,
                declarativePackageRemoved: true,
                legacyPackageAbsent: true,
                recoveryDraftRemoved: true,
                unknownProjectRemoved: true,
                temporarySourcesRemoved: true,
                finalProjectRestored: true,
            },
            metrics: {
                system_path_count: 6,
                existing_system_path_count: 6,
                system_path_complete_count: 6,
                catalog_count: 147,
                builtin_search_result_count: 2,
                builtin_source_label_count: 2,
                package_quality_check_count: 18,
                imported_search_result_count: 1,
                unknown_block_count: 1,
                protected_project_bytes: 512,
                resource_panel_present: true,
                expected_port_selected: true,
                maximum_horizontal_overflow: 0,
            },
            ...binding,
            ...sensitive,
        }],
        ['desktop-memory-regression.json', {
            schemaVersion: 1,
            test_id: 'ck-desktop-memory-lifecycle-v1',
            status: 'passed',
            result_kind: 'conclusive',
            method: { cycles: 10 },
            contamination: {
                status: 'clean',
                observed_poll_count: 0,
                discarded_metric_groups: 0,
                observations: [],
            },
            cycles: memoryCycles,
            comparison: { baseline_cycle: 2, final_cycle: 10, sample_count: 9 },
            project: {
                requested_name: 'c6_regression',
                code_fingerprint: 'fixture-source-before',
                fqbn: exactC6Fqbn,
            },
            checks: memoryCheckNames.map((id) => ({ id, passed: true })),
            failures: [],
            ...binding,
        }],
        ['v1-c6-hardware-regression.json', {
            schemaVersion: 1,
            runId: benchmarkRunId,
            status: 'passed',
            checks: [{ id: 'cold-exact-hot-upload', passed: true }],
            failures: [],
            project: 'c6_regression',
            fqbn: exactC6Fqbn,
            port: 'COM12',
            coldMode: 'firstProjectCold',
            skippedStages: [],
            cacheClear: {
                fqbn: exactC6Fqbn,
                reset_scope: 'first-project-full-fqbn',
                ccache_store_preserved: true,
                prebuilt_core_preserved: false,
                prebuilt_core_validated: false,
                force_rebuild_pending: false,
                force_ccache_recache: false,
            },
            cycles: {
                cold: {
                    schemaId: 'ck.native-compile-upload-operation',
                    schemaVersion: 1,
                    kind: 'compile',
                    success: true,
                    profile: 'quick-fast',
                    wallSeconds: 100,
                    fullBuild: true,
                    exactMatch: false,
                },
                exact: {
                    schemaId: 'ck.native-compile-upload-operation',
                    schemaVersion: 1,
                    kind: 'compile',
                    success: true,
                    wallSeconds: 1.5,
                    profile: 'quick-fast',
                    exactMatch: true,
                    codeChanged: false,
                },
                hotEdit: {
                    schemaId: 'ck.native-compile-upload-operation',
                    schemaVersion: 1,
                    kind: 'compile',
                    success: true,
                    wallSeconds: 2.5,
                    profile: 'quick-fast',
                    exactMatch: false,
                    codeChanged: true,
                },
                upload: {
                    schemaId: 'ck.native-compile-upload-operation',
                    schemaVersion: 1,
                    kind: 'upload',
                    success: true,
                    profile: 'quick-fast (fast local loop)',
                    wallSeconds: 2,
                    compileLockWaitReported: true,
                    compileLockSeconds: 0.2,
                    uploadCompileLockWaitReported: true,
                    uploadCompileLockSeconds: 0.2,
                    matchingWarmupWaitObserved: false,
                    compatibleWarmupReuseObserved: false,
                    evidence: ['[Timing] Upload compile lock wait (quick-fast-upload): 0.2s'],
                },
            },
            uploadCompileLock: {
                status: 'passed',
                reported: true,
                seconds: 0.2,
                maxAllowedSeconds: 5,
                matchingWarmupWaitObserved: false,
                compatibleWarmupReuseObserved: false,
                failures: [],
            },
            sourceGate: {
                initial: { codeFingerprint: 'fixture-source-before', includeSignature: 'wifi.h' },
                hotEdit: { codeFingerprint: 'fixture-source-after-edit', includeSignature: 'wifi.h' },
                restored: { codeFingerprint: 'fixture-source-before', includeSignature: 'wifi.h' },
            },
            verified_baseline: {
                createdAt: new Date(now - 4.9 * 60_000).toISOString(),
                verifiedAt: new Date(now - 4.8 * 60_000).toISOString(),
                environment: {
                    fqbn: exactC6Fqbn,
                    coreId: 'esp32:esp32',
                    coreVersion: '3.3.6',
                    arduinoCliVersion: '1.4.1',
                    toolchainKey: 'fixture-toolchain',
                    buildSignature: 'fixture-build-signature',
                    compileProfile: 'quick-fast',
                    optimization: '-O1',
                },
                firmware: {
                    manifestSha256: '1'.repeat(64),
                    partitionSha256: '2'.repeat(64),
                    artifacts: [
                        { role: 'esp32-bootloader', flashAddress: '0x0', size: 16384, sha256: '3'.repeat(64) },
                        { role: 'esp32-application', flashAddress: '0x10000', size: 900000, sha256: '4'.repeat(64) },
                    ],
                },
                device: { chip: 'ESP32-C6', flashBytes: 16 * 1024 * 1024, psramBytes: null },
                resources: {
                    flashUsedBytes: 900000,
                    flashMaxBytes: 3 * 1024 * 1024,
                    ramUsedBytes: 40000,
                    ramMaxBytes: 512 * 1024,
                    warningCount: 0,
                },
            },
            uploadProgress,
            ...binding,
        }],
        ['v1-c6-device-health.json', {
            schemaVersion: 1,
            status: 'healthy',
            checks: [
                'chip-family-confirmed',
                'physical-flash-confirmed',
                'full-fqbn-visible',
                'local-mac-output-redacted',
                'serial-monitor-restored',
            ].map((id) => ({ id, passed: true })),
            failures: [],
            project: 'c6_regression',
            fqbn: exactC6Fqbn,
            port: 'COM12',
            privacy: {
                panelContainsFullMac: true,
                outputContainsFullMac: false,
                pageContainsFullMac: true,
                exportedPanelTextRedacted: true,
            },
            serialRestore: { requested: true, verified: true },
            hardwareEvidence: {
                chipModel: 'ESP32-C6',
                flashBytes: 16 * 1024 * 1024,
                configuredFlashBytes: 16 * 1024 * 1024,
                psramBytes: null,
                psramEvidenceState: 'unknown',
                psramCheckState: 'unknown',
                resolvedFqbn: exactC6Fqbn,
            },
            ...binding,
        }],
        ['v1-c6-upload-progress.json', {
            ...uploadProgress,
            ...binding,
        }],
        ['v1-c6-manifest-gate.json', {
            schemaVersion: 2,
            status: 'passed',
            project: 'c6_regression.maker',
            fqbn: exactC6Fqbn,
            port: 'COM12',
            failures: [],
            gate: {
                exactMatchBeforeRejection: true,
                fqbnMismatchRejected: true,
                transportBlockedUntilRejection: true,
                sharedFastFreshBuild: true,
                sharedFastManifestVerified: true,
                transportRevalidated: true,
                transportObservedAfterRevalidation: true,
                ordinaryUploadSucceeded: true,
                allTargetFqbnsExact: true,
            },
            mutation: { onlyManifestModified: true, firmwareArtifactsModified: false },
            protectedFiles: { count: 1, unchanged: true },
            restoration: { requested: true, completed: true, valid: true },
            recoveryManifest: {
                profile: 'shared-fast',
                exactFqbn: true,
                freshlySealed: true,
                manifestHash: '8'.repeat(64),
            },
            hashMutation: {
                field: 'artifacts[esp32-application].sha256',
                artifactRole: 'esp32-application',
                onlyManifestModified: true,
                firmwareArtifactsModified: false,
            },
            hashGate: {
                exactMatchBeforeRejection: true,
                artifactHashMismatchRejected: true,
                transportBlockedUntilRejection: true,
                transportBlockedUntilHashRejection: true,
                sharedFastFreshBuild: true,
                sharedFastManifestVerified: true,
                transportRevalidated: true,
                transportObservedAfterRevalidation: true,
                ordinaryUploadSucceeded: true,
                allTargetFqbnsExact: true,
                artifactRole: 'esp32-application',
            },
            hashRecoveryManifest: {
                profile: 'shared-fast',
                exactFqbn: true,
                freshlySealed: true,
                manifestHash: '9'.repeat(64),
            },
            hashProtectedFiles: { count: 4, unchanged: true },
            hashRestoration: {
                requested: true,
                completed: true,
                action: 'restored-original-manifest',
                valid: true,
                originalHashRestored: true,
                backupRemoved: true,
                residueRemoved: true,
            },
            initialCacheClear: {
                fqbn: exactC6Fqbn,
                resetScope: 'exact-full-fqbn',
                forceRebuildPending: true,
                forceCcacheRecache: true,
                prebuiltCorePreserved: false,
            },
            betweenPhaseCacheClear: {
                fqbn: exactC6Fqbn,
                resetScope: 'exact-full-fqbn',
                forceRebuildPending: true,
                forceCcacheRecache: true,
                prebuiltCorePreserved: false,
            },
            privacy: { completeMacRecorded: false },
            identity: {
                before: {
                    project: 'c6_regression',
                    codeFingerprint: 'fixture-source-before',
                    includeSignature: 'wifi.h',
                    fqbn: exactC6Fqbn,
                    port: 'COM12',
                },
                after: {
                    project: 'c6_regression',
                    codeFingerprint: 'fixture-source-before',
                    includeSignature: 'wifi.h',
                    fqbn: exactC6Fqbn,
                    port: 'COM12',
                },
                unchanged: true,
            },
            ...binding,
        }],
        ['v1-c6-safe-cancel.json', {
            schemaVersion: 1,
            test_id: 'ck-production-safe-cancel-c6-v1',
            status: 'passed',
            project: 'c6_regression',
            fqbn: exactC6Fqbn,
            port: 'COM12',
            runIds: {
                uploadSketch: '550e8400-e29b-41d4-a716-446655440000',
                cancelCommand: '550e8400-e29b-41d4-a716-446655440000',
                recoveryCompile: '550e8400-e29b-41d4-a716-446655440001',
            },
            operation: {
                startAction: 'build-normal-upload-action',
                backendCommand: 'upload_sketch',
                workspaceFingerprint: 'fixture-source-before',
                stageObservation: {
                    process: { arduino_or_gcc_stage: true, name: 'arduino-cli.exe' },
                },
            },
            cancellation: {
                command: 'cancel_foreground_build',
                uploadRejected: true,
                backendConfirmedWait: true,
                terminatedProcessTreeCount: 1,
            },
            flashTransport: { observed: false, observationCount: 0, observations: [] },
            quiescence: {
                afterCancel: {
                    requiredConsecutiveCleanPolls: 3,
                    observedConsecutiveCleanPolls: 3,
                    samples: Array.from({ length: 3 }, () => ({ toolTreeCount: 0, globalOrphanCount: 0 })),
                },
                afterRecovery: {
                    requiredConsecutiveCleanPolls: 3,
                    observedConsecutiveCleanPolls: 3,
                    samples: Array.from({ length: 3 }, () => ({ toolTreeCount: 0, globalOrphanCount: 0 })),
                },
            },
            recoveryCompile: {
                command: 'compile_sketch',
                success: true,
                successMarker: true,
                compileLockWaitSeconds: 0.6,
                workspaceFingerprint: 'fixture-source-before',
            },
            identity: {
                before: {
                    project: 'c6_regression',
                    sourceFingerprint: 'fixture-source-before',
                    includeSignature: 'wifi.h',
                    fqbn: exactC6Fqbn,
                    port: 'COM12',
                },
                after: {
                    project: 'c6_regression',
                    sourceFingerprint: 'fixture-source-before',
                    includeSignature: 'wifi.h',
                    fqbn: exactC6Fqbn,
                    port: 'COM12',
                },
            },
            checks: safeCancelCheckNames.map((id) => ({ id, passed: true })),
            failures: [],
            ...binding,
        }],
    ]);
    for (const [name, report] of reports) {
        await write(root, `artifacts/release/${name}`, `${JSON.stringify(report)}\n`);
    }
    return { root, executable, startedAt, finishedAt, capturedAt };
}

async function readManifest(root) {
    return JSON.parse(await readFile(join(root, 'artifacts/release/v1-release-evidence-manifest.json'), 'utf8'));
}

test('writes a hash-verified closed-test-only manifest for one coherent evidence set', async (t) => {
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], { encoding: 'utf8' });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = run(root);
    const manifestBytes = await readFile(join(root, 'artifacts/release/v1-release-evidence-manifest.json'));
    const diagnosticManifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(result.status, 0, `${result.stderr}\n${result.stdout}\n${JSON.stringify(diagnosticManifest.issues)}`);
    assert.notDeepEqual([...manifestBytes.subarray(0, 3)], [0xef, 0xbb, 0xbf]);
    const manifest = JSON.parse(manifestBytes.toString('utf8'));
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.releaseClass, 'local-machine-and-closed-test-candidate-only');
    assert.equal(manifest.publicFormalRelease, false);
    assert.equal(manifest.claimScope.publicFormalRelease, false);
    assert.equal(manifest.automatedReleaseGate.gateCount, 14);
    assert.equal(manifest.automatedReleaseGate.passedGateCount, 14);
    assert.equal(memoryCheckNames.length, 26);
    assert.equal(manifest.references.length, 22);
    assert.equal(manifest.references.filter((entry) => entry.role === 'first-compile-performance').length, 1);
    assert.equal(manifest.references.filter((entry) => entry.role.startsWith('example-package:')).length, 5);
    for (const reference of manifest.references) {
        assert.equal(reference.path.includes(root), false);
        const actual = await identity(root, reference.path);
        assert.equal(reference.bytes, actual.bytes, reference.role);
        assert.equal(reference.sha256, actual.sha256, reference.role);
    }
});

test('workspace path containment rejects child junctions without touching external files', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('Windows junction containment is a Windows release boundary');
        return;
    }

    await t.test('output parent junction is rejected before any external write', async (st) => {
        const { root } = await makeFixture();
        const outside = await mkdtemp(join(tmpdir(), 'ck-release-evidence-outside-output-'));
        st.after(async () => {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        });
        const releaseDirectory = join(root, 'artifacts/release');
        await rm(releaseDirectory, { recursive: true, force: true });
        await writeFile(join(outside, 'sentinel.txt'), 'outside-output-sentinel');
        await symlink(outside, releaseDirectory, 'junction');

        const result = run(root);
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
        assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside-output-sentinel');
        await assert.rejects(readFile(join(outside, 'v1-release-evidence-manifest.json'), 'utf8'), { code: 'ENOENT' });
    });

    await t.test('explicit input junction is rejected and remains read-only', async (st) => {
        const { root } = await makeFixture();
        const outside = await mkdtemp(join(tmpdir(), 'ck-release-evidence-outside-input-'));
        st.after(async () => {
            await rm(root, { recursive: true, force: true });
            await rm(outside, { recursive: true, force: true });
        });
        const externalSummary = await readFile(join(root, 'artifacts/release/first-compile-performance-summary.json'));
        await writeFile(join(outside, 'summary.json'), externalSummary);
        await writeFile(join(outside, 'sentinel.txt'), 'outside-input-sentinel');
        await symlink(outside, join(root, 'evidence-link'), 'junction');

        const result = run(root, ['-FirstCompilePerformancePath', 'evidence-link/summary.json']);
        assert.notEqual(result.status, 0, result.stderr || result.stdout);
        assert.equal(await readFile(join(outside, 'sentinel.txt'), 'utf8'), 'outside-input-sentinel');
        assert.equal((await readdir(outside)).sort().join(','), 'sentinel.txt,summary.json');
        const manifest = await readManifest(root);
        assert.equal(manifest.status, 'candidate_evidence_stale');
        assert.equal(manifest.invalidated, true);
    });
});

test('workspace root itself may be a junction while ordinary child paths remain contained', async (t) => {
    if (process.platform !== 'win32') {
        t.skip('Windows junction behavior is only asserted on Windows');
        return;
    }
    const { root } = await makeFixture();
    const aliasParent = await mkdtemp(join(tmpdir(), 'ck-release-evidence-root-alias-'));
    const alias = join(aliasParent, 'workspace');
    t.after(async () => {
        await rm(alias, { recursive: true, force: true });
        await rm(root, { recursive: true, force: true });
        await rm(aliasParent, { recursive: true, force: true });
    });
    await symlink(root, alias, 'junction');

    const result = run(alias);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'passed');
});

test('JSON true fields require literal booleans across source, native, CDP, and upload gates', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-release-gates.json', (gate) => {
        gate.source_tree.verified_before_gate = 'true';
    });
    await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
        report.checks[0].passed = 'true';
        report.cdp_binding.bound = 'true';
    });
    await mutateJson(root, 'artifacts/release/v1-c6-manifest-gate.json', (report) => {
        report.gate.fqbnMismatchRejected = 'true';
    });

    const result = run(root);
    const manifest = await readManifest(root);
    for (const issueId of [
        'gate-source-tree-not-verified-before-and-after',
        'evidence-report-has-failed-checks',
        'native-report-cdp-binding-mismatch',
        'upload-manifest-gate-check-failed',
    ]) {
        assertRejected(result, manifest, issueId);
    }
});

test('JSON false fields reject missing values and string lookalikes', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => {
        report.cycles.cold.exactMatch = 'false';
    });
    await mutateJson(root, 'artifacts/release/v1-c6-device-health.json', (report) => {
        report.privacy.outputContainsFullMac = 'false';
    });
    await mutateJson(root, 'artifacts/release/v1-c6-manifest-gate.json', (report) => {
        delete report.mutation.firmwareArtifactsModified;
        report.hashMutation.firmwareArtifactsModified = 'false';
        report.betweenPhaseCacheClear.prebuiltCorePreserved = 'garbage';
    });
    await mutateJson(root, 'artifacts/release/v1-c6-safe-cancel.json', (report) => {
        report.flashTransport.observed = 'false';
    });

    const result = run(root);
    const manifest = await readManifest(root);
    for (const issueId of [
        'benchmark-required-cold-exact-hot-upload-stage-missing',
        'device-health-status-not-acceptable',
        'upload-manifest-gate-supporting-proof-invalid',
        'upload-manifest-hash-mutation-proof-invalid',
        'upload-manifest-between-phase-cache-clear-invalid',
        'safe-cancel-flash-transport-observed',
    ]) {
        assertRejected(result, manifest, issueId);
    }
});

test('JSON numeric strings cannot satisfy schemas, counts, PIDs, sizes, or capacities', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
        report.schemaVersion = '3';
        report.metrics.system_path_count = String(report.metrics.system_path_count);
        report.executable.bytes = String(report.executable.bytes);
        report.executable.process_id = String(report.executable.process_id);
        report.cdp_binding.debug_port = String(report.cdp_binding.debug_port);
    });
    await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => {
        report.schemaVersion = '1';
        report.verified_baseline.firmware.artifacts[0].size = String(report.verified_baseline.firmware.artifacts[0].size);
        report.verified_baseline.device.flashBytes = String(report.verified_baseline.device.flashBytes);
        report.verified_baseline.resources.flashMaxBytes = String(report.verified_baseline.resources.flashMaxBytes);
    });
    await mutateJson(root, 'artifacts/release/v1-c6-device-health.json', (report) => {
        report.schemaVersion = '1';
        report.hardwareEvidence.flashBytes = String(report.hardwareEvidence.flashBytes);
    });
    await mutateJson(root, 'artifacts/release/v1-c6-manifest-gate.json', (report) => {
        report.schemaVersion = '2';
        report.protectedFiles.count = String(report.protectedFiles.count);
    });
    await mutateJson(root, 'artifacts/release/v1-c6-safe-cancel.json', (report) => {
        report.schemaVersion = '1';
        report.cancellation.terminatedProcessTreeCount = '1';
        report.recoveryCompile.compileLockWaitSeconds = '0.6';
    });

    const result = run(root);
    const manifest = await readManifest(root);
    for (const issueId of [
        'native-smoke-schema-or-status-invalid',
        'native-report-executable-binding-mismatch',
        'native-report-cdp-binding-mismatch',
        'benchmark-schema-or-status-invalid',
        'benchmark-verified-baseline-invalid',
        'device-health-status-not-acceptable',
        'upload-manifest-gate-schema-or-status-invalid',
        'upload-manifest-gate-supporting-proof-invalid',
        'safe-cancel-schema-or-status-invalid',
        'safe-cancel-owned-process-wait-proof-invalid',
        'safe-cancel-recovery-compile-or-lock-proof-invalid',
    ]) {
        assertRejected(result, manifest, issueId);
    }
});

test('JSON array contracts reject scalar and null checks, samples, artifacts, segments, and failures', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
        report.checks = report.checks[0];
        report.failures = null;
    });
    await mutateJson(root, 'artifacts/release/v1-c6-upload-progress.json', (report) => {
        report.samples = report.samples[0];
        report.failures = { unexpected: false };
    });
    await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => {
        report.verified_baseline.firmware.artifacts = report.verified_baseline.firmware.artifacts[0];
        report.uploadCompileLock.failures = {};
    });
    await mutateJson(root, 'artifacts/release/v1-c6-safe-cancel.json', (report) => {
        report.quiescence.afterCancel.samples = report.quiescence.afterCancel.samples[0];
    });
    await mutateJson(root, 'artifacts/release/first-compile-performance-summary.json', (report) => {
        report.failures = {};
        report.samples.firstProjectCold = report.samples.firstProjectCold[0];
    });

    const result = run(root);
    const manifest = await readManifest(root);
    for (const issueId of [
        'evidence-report-has-failed-checks',
        'c6-upload-progress-samples-invalid',
        'benchmark-verified-baseline-invalid',
        'c6-firmware-layout-out-of-bounds-or-overlapping',
        'benchmark-upload-compile-lock-proof-invalid',
        'safe-cancel-quiescence-proof-invalid',
        'first-compile-performance-contains-failures',
        'first-compile-performance-sample-set-invalid',
    ]) {
        assertRejected(result, manifest, issueId);
    }
});

test('first-compile performance evidence is mandatory, strict, and fully bound', async (t) => {
    const reportPath = 'artifacts/release/first-compile-performance-summary.json';
    const cases = [
        ['missing report', async (root) => rm(join(root, reportPath), { force: true }), 'required-reference-missing'],
        ['failed status', async (root) => mutateJson(root, reportPath, (report) => { report.status = 'failed'; }), 'first-compile-performance-not-passed'],
        ['wrong schema', async (root) => mutateJson(root, reportPath, (report) => { report.schemaVersion = 2; }), 'first-compile-performance-schema-invalid'],
        ['policy threshold drift', async (root) => mutateJson(root, reportPath, (report) => { report.policy.targetImprovementPercent = 29; }), 'first-compile-performance-policy-invalid'],
        ['mode profile policy drift', async (root) => mutateJson(root, reportPath, (report) => { report.policy.compileProfilesByColdMode.readyInstallCold.upload = 'quick-fast'; }), 'first-compile-performance-policy-invalid'],
        ['cache policy boolean string', async (root) => mutateJson(root, reportPath, (report) => { report.policy.cacheClearByColdMode.firstProjectCold.ccache_store_preserved = 'true'; }), 'first-compile-performance-policy-invalid'],
        ['policy string number', async (root) => mutateJson(root, reportPath, (report) => { report.policy.maximumCompileLockSeconds = '5'; }), 'first-compile-performance-policy-invalid'],
        ['temporal sequence drift', async (root) => mutateJson(root, reportPath, (report) => {
            [report.policy.requiredTemporalSequence[1], report.policy.requiredTemporalSequence[2]] = [
                report.policy.requiredTemporalSequence[2],
                report.policy.requiredTemporalSequence[1],
            ];
        }), 'first-compile-performance-policy-invalid'],
        ['overlap policy disabled', async (root) => mutateJson(root, reportPath, (report) => { report.policy.requireNonOverlappingSamples = false; }), 'first-compile-performance-policy-invalid'],
        ['gate ordering policy disabled', async (root) => mutateJson(root, reportPath, (report) => { report.policy.requireGateExecutableSampleOrder = false; }), 'first-compile-performance-policy-invalid'],
        ['batch span policy drift', async (root) => mutateJson(root, reportPath, (report) => { report.policy.maximumBatchSpanHours = 3; }), 'first-compile-performance-policy-invalid'],
        ['evidence age policy drift', async (root) => mutateJson(root, reportPath, (report) => { report.policy.maximumEvidenceAgeHours = 73; }), 'first-compile-performance-policy-invalid'],
        ['future tolerance policy drift', async (root) => mutateJson(root, reportPath, (report) => { report.policy.futureTimestampToleranceMinutes = 6; }), 'first-compile-performance-policy-invalid'],
        ['batch span missing', async (root) => mutateJson(root, reportPath, (report) => { delete report.batch.spanSeconds; }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch span string', async (root) => mutateJson(root, reportPath, (report) => { report.batch.spanSeconds = '2700'; }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch span exceeds policy', async (root) => mutateJson(root, reportPath, (report) => { report.batch.spanSeconds = 7200.001; }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch expiry missing', async (root) => mutateJson(root, reportPath, (report) => { delete report.batch.expiresAt; }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch expiry malformed', async (root) => mutateJson(root, reportPath, (report) => { report.batch.expiresAt = 'not-a-time'; }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch expiry is past', async (root) => mutateJson(root, reportPath, (report) => { report.batch.expiresAt = new Date(Date.now() - 60_000).toISOString(); }), 'first-compile-performance-batch-expired'],
        ['batch expiry is too far from generation', async (root) => mutateJson(root, reportPath, (report) => {
            report.batch.expiresAt = new Date(Date.parse(report.generatedAt) + 72 * 60 * 60_000 + 1).toISOString();
        }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch expiry drifts from first verified sample', async (root) => mutateJson(root, reportPath, (report) => {
            report.batch.expiresAt = new Date(Date.parse(report.batch.expiresAt) + 1).toISOString();
        }), 'first-compile-performance-temporal-batch-invalid'],
        ['batch leaks raw timestamp', async (root) => mutateJson(root, reportPath, (report) => { report.batch.capturedAt = new Date().toISOString(); }), 'first-compile-performance-temporal-batch-invalid'],
        ['sample removed', async (root) => mutateJson(root, reportPath, (report) => { report.samples.readyInstallCold.pop(); }), 'first-compile-performance-sample-set-invalid'],
        ['fourth sample added', async (root) => mutateJson(root, reportPath, (report) => { report.samples.readyInstallCold.push({ sampleId: 'readyInstallCold-04-777777777777', seconds: 65 }); }), 'first-compile-performance-sample-set-invalid'],
        ['sample seconds string', async (root) => mutateJson(root, reportPath, (report) => { report.samples.firstProjectCold[0].seconds = '100'; }), 'first-compile-performance-sample-set-invalid'],
        ['statistics count string', async (root) => mutateJson(root, reportPath, (report) => { report.statistics.firstProjectCold.count = '3'; }), 'first-compile-performance-statistics-invalid'],
        ['source binding drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.sourceTree.treeSha256 = 'a'.repeat(64); }), 'first-compile-performance-source-binding-mismatch'],
        ['gate hash drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.gateRun.reportSha256 = 'b'.repeat(64); }), 'first-compile-performance-gate-binding-mismatch'],
        ['process drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.executable.processId = 9999; }), 'first-compile-performance-process-binding-mismatch'],
        ['process string', async (root) => mutateJson(root, reportPath, (report) => { report.binding.executable.processId = '1234'; }), 'first-compile-performance-process-binding-mismatch'],
        ['FQBN drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.fqbn = 'esp32:esp32:esp32c6'; }), 'first-compile-performance-fqbn-mismatch'],
        ['Core drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.environment.coreVersion = '9.9.9'; }), 'first-compile-performance-environment-binding-mismatch'],
        ['primary benchmark mode drift', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.coldMode = 'readyInstallCold'; }), 'first-compile-performance-primary-benchmark-mode-invalid'],
        ['primary upload profile drift', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cycles.upload.profile = 'shared-fast'; }), 'first-compile-performance-primary-benchmark-mode-invalid'],
        ['primary cold operation schema missing', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { delete report.cycles.cold.schemaId; }), 'first-compile-performance-primary-benchmark-mode-invalid'],
        ['primary upload operation schema string version', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cycles.upload.schemaVersion = '1'; }), 'first-compile-performance-primary-benchmark-mode-invalid'],
        ['primary upload wall time string', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cycles.upload.wallSeconds = '2'; }), 'first-compile-performance-primary-benchmark-mode-invalid'],
        ['primary cache scope drift', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cacheClear.reset_scope = 'ready-install-project-full-fqbn'; }), 'first-compile-performance-primary-benchmark-cache-clear-invalid'],
        ['primary cache boolean string', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cacheClear.prebuilt_core_preserved = 'false'; }), 'first-compile-performance-primary-benchmark-cache-clear-invalid'],
        ['primary exact codeChanged missing', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { delete report.cycles.exact.codeChanged; }), 'first-compile-performance-primary-benchmark-cycle-invalid'],
        ['primary hot cycle profile drift', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cycles.hotEdit.profile = 'shared-fast'; }), 'first-compile-performance-primary-benchmark-cycle-invalid'],
        ['primary invalid optional priming', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.cycles.exactPriming = { schemaId: 'ck.native-compile-upload-operation', schemaVersion: 1, kind: 'compile', success: 'true', wallSeconds: 1, profile: 'quick-fast' }; }), 'first-compile-performance-primary-benchmark-cycle-invalid'],
        ['primary baseline createdAt missing', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { delete report.verified_baseline.createdAt; }), 'first-compile-performance-primary-benchmark-time-invalid'],
        ['primary baseline created before capture', async (root) => mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => { report.verified_baseline.createdAt = new Date(Date.parse(report.capturedAt) - 1).toISOString(); }), 'first-compile-performance-primary-benchmark-time-invalid'],
        ['common project drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.project = 'different-project'; }), 'first-compile-performance-common-binding-mismatch'],
        ['common device drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.device.flashBytes = 8 * 1024 * 1024; }), 'first-compile-performance-common-binding-mismatch'],
        ['executable hash drift', async (root) => mutateJson(root, reportPath, (report) => { report.binding.executable.sha256 = 'c'.repeat(64); }), 'first-compile-performance-executable-binding-mismatch'],
        ['executable bytes string', async (root) => mutateJson(root, reportPath, (report) => { report.binding.executable.bytes = String(report.binding.executable.bytes); }), 'first-compile-performance-executable-binding-mismatch'],
        ['target regression', async (root) => mutateJson(root, reportPath, (report) => { report.improvementPercent.p95 = 29; report.improvementPercent.p95TargetMet = false; }), 'first-compile-performance-target-invalid'],
        ['nonempty failures', async (root) => mutateJson(root, reportPath, (report) => { report.failures.push({ id: 'fixture-failure' }); }), 'first-compile-performance-contains-failures'],
        ['null failures', async (root) => mutateJson(root, reportPath, (report) => { report.failures = null; }), 'first-compile-performance-contains-failures'],
        ['historical summary', async (root) => mutateJson(root, reportPath, (report) => { report.generatedAt = new Date(Date.now() - 48 * 60 * 60_000).toISOString(); }), 'first-compile-performance-freshness-invalid'],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutate(root);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('first-compile batch expiry cannot be extended by MaximumEvidenceAgeHours', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/first-compile-performance-summary.json', (report) => {
        report.batch.expiresAt = new Date(Date.now() - 1).toISOString();
    });
    const result = run(root, [], '72');
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'first-compile-performance-batch-expired');
});

test('MaximumEvidenceAgeHours accepts 24 but rejects values above the fixed 72-hour ceiling', async (t) => {
    await t.test('accepts a shorter 24-hour window', async (st) => {
        const { root } = await makeFixture();
        st.after(() => rm(root, { recursive: true, force: true }));
        const result = run(root, [], '24');
        assert.equal(result.status, 0, `${result.stdout}\n${result.stderr}`);
        assert.equal((await readManifest(root)).status, 'passed');
    });

    await t.test('rejects 73 during parameter binding', async (st) => {
        const { root } = await makeFixture();
        st.after(() => rm(root, { recursive: true, force: true }));
        const result = run(root, [], '73');
        assert.notEqual(result.status, 0, `${result.stdout}\n${result.stderr}`);
    });
});

test('compatibility reports are hash-bound, fresh, compile-only, and never hardware claims', async (t) => {
    const gatePath = 'artifacts/release/v1-release-gates.json';
    const auditPath = 'artifacts/release/builtin-block-generator-audit.json';
    const corePath = 'artifacts/release/core-compatibility-results.json';
    const cases = [
        ['missing gate item', async (root) => mutateJson(root, gatePath, (gate) => { gate.compatibility_reports.pop(); }), 'compatibility-report-set-invalid'],
        ['wrong gate hash', async (root) => mutateJson(root, gatePath, (gate) => { gate.compatibility_reports[0].sha256 = '0'.repeat(64); }), 'recorded-hash-or-size-mismatch'],
        ['missing report file', async (root) => rm(join(root, auditPath), { force: true }), 'required-reference-missing'],
        ['audit hardware claim', async (root) => mutateJson(root, auditPath, (report) => { report.hardwareTested = true; }), 'compatibility-hardware-boundary-violated'],
        ['audit count drift', async (root) => mutateJson(root, auditPath, (report) => { report.counts.passed = 293; }), 'builtin-generator-audit-invalid'],
        ['core hardware claim', async (root) => mutateJson(root, corePath, (report) => { report.results[0].HardwareTested = true; }), 'compatibility-hardware-boundary-violated'],
        ['core result count drift', async (root) => mutateJson(root, corePath, (report) => { report.results.pop(); }), 'core-compatibility-report-invalid'],
        ['core failed compile-only result', async (root) => mutateJson(root, corePath, (report) => { report.results[0].Passed = false; }), 'core-compatibility-report-invalid'],
        ['old report mtime', async (root) => {
            const gate = await readJson(root, gatePath);
            const old = new Date(Date.parse(gate.started_at) - 60_000);
            await utimes(join(root, corePath), old, old);
        }, 'compatibility-report-digest-or-freshness-invalid'],
        ['sensitive report path', async (root) => mutateJson(root, corePath, (report) => { report.diagnosticPath = 'C:\\private\\compile.log'; }), 'evidence-report-contains-sensitive-value'],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutate(root);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('tampered executable hash cannot inherit a passed report', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await write(root, 'target/release/appsdesktop.exe', Buffer.from('tampered-after-native-evidence'));
    const result = run(root);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'candidate_evidence_stale');
    assert.ok(manifest.issues.stale.some((entry) => entry.evidenceRole === 'production-executable'));
    assert.ok(manifest.issues.stale.some((entry) => entry.id === 'native-report-executable-binding-mismatch'));
});

test('a historical pre-gate native report is classified stale, never passed', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'artifacts/release/v1-native-smoke.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.capturedAt = new Date(Date.parse(report.gate_run.finished_at) - 60_000).toISOString();
    await writeFile(path, `${JSON.stringify(report)}\n`);
    const result = run(root);
    assert.equal(result.status, 2, result.stderr || result.stdout);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'candidate_evidence_stale');
    assert.ok(manifest.issues.stale.some((entry) => entry.id === 'native-report-is-missing-fresh-post-gate-time'));
});

test('an explicit failed native check produces failed instead of a stale pass', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const path = join(root, 'artifacts/release/desktop-memory-regression.json');
    const report = JSON.parse(await readFile(path, 'utf8'));
    report.status = 'failed';
    report.failures = ['resident-ui-private-memory-growth'];
    report.checks = [{ id: 'resident-ui-private-memory', passed: false }];
    await writeFile(path, `${JSON.stringify(report)}\n`);
    const result = run(root);
    assert.equal(result.status, 1, result.stderr || result.stdout);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'failed');
    assert.ok(manifest.issues.failed.some((entry) => entry.evidenceRole === 'desktop-memory-regression'));
});

test('unsigned fixtures remain eligible only for local closed testing', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = run(root);
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const manifest = await readManifest(root);
    assert.equal(manifest.status, 'passed');
    assert.equal(manifest.publicFormalRelease, false);
    assert.equal(manifest.authenticode.publicFormalRelease, false);
    assert.ok(manifest.authenticode.assets.every((entry) => entry.signed === false));
});

test('a newly added source file that is absent from the frozen inventory cannot pass', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await write(root, 'apps/desktop/src/unlisted.ts', 'export const unlisted = true;\n');
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'authoritative-source-tree-inventory-mismatch');
});

test('the authoritative source inventory is reverified around atomic finalization', async () => {
    const source = await readFile(scriptPath, 'utf8');
    const verifyCalls = [...source.matchAll(/Invoke-AuthoritativeSourceTreeVerify\s+-ManifestPath\s+\$SourceManifestPath\s+-FreezePath\s+\$SourceFreezePath/g)]
        .map((match) => match.index);
    const crossReportIndex = source.indexOf('Test-C6CrossReportEvidence');
    const firstDecisionWriteIndex = source.indexOf('Write-Utf8NoBomAtomic -Path $OutputPath -Content $json', crossReportIndex);
    const writtenManifestIndex = source.indexOf('$written = [System.IO.File]::ReadAllText', firstDecisionWriteIndex);
    const finalRawIndex = source.indexOf('$finalRaw = [System.IO.File]::ReadAllText', writtenManifestIndex);

    assert.ok(crossReportIndex >= 0 && firstDecisionWriteIndex > crossReportIndex);
    assert.ok(writtenManifestIndex > firstDecisionWriteIndex && finalRawIndex > writtenManifestIndex);
    assert.ok(verifyCalls.some((index) => index > crossReportIndex && index < firstDecisionWriteIndex));
    assert.ok(verifyCalls.some((index) => index > writtenManifestIndex && index < finalRawIndex));
    assert.ok(verifyCalls.some((index) => index > finalRawIndex));
    assert.match(source, /throw 'source tree or referenced evidence changed after final evidence write'/);
});

test('the exact required 14-gate set rejects deletion, renaming, and duplication', async (t) => {
    const cases = [
        ['deleted gate', (gate) => gate.gates.pop()],
        ['renamed gate', (gate) => { gate.gates[3].name = 'rustfmt-renamed'; }],
        ['duplicate gate', (gate) => { gate.gates.at(-1).name = gate.gates[0].name; }],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-release-gates.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'automated-release-gate-required-set-invalid');
        });
    }
});

test('explicit contract: gate schema and gate timestamps fail closed', async (t) => {
    const cases = [
        [
            'wrong gate schema',
            (gate) => { gate.schema_version = 99; },
            'automated-release-gate-schema-invalid',
        ],
        [
            'future gate window',
            (gate) => {
                gate.started_at = new Date(Date.now() + 10 * 60_000).toISOString();
                gate.finished_at = new Date(Date.now() + 11 * 60_000).toISOString();
            },
            'gate-time-window-invalid',
        ],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(name, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-release-gates.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('explicit contract: source and freeze schema, no-Git metadata, and time fail closed', async (t) => {
    const cases = [
        [
            'wrong source schema',
            async (root) => mutateJson(root, 'artifacts/release/source-tree-manifest.json', (manifest) => {
                manifest.schema_version = 99;
            }),
            'source-manifest-or-freeze-schema-invalid',
        ],
        [
            'wrong freeze schema',
            async (root) => mutateJson(root, 'artifacts/release/source-tree-freeze.json', (freeze) => {
                freeze.schema_version = 99;
            }),
            'source-manifest-or-freeze-schema-invalid',
        ],
        [
            'Git metadata in source and freeze records',
            async (root) => {
                await mutateJson(root, 'artifacts/release/source-tree-manifest.json', (manifest) => {
                    manifest.source_control = { kind: 'git', commit: '0123456789abcdef' };
                });
                await mutateJson(root, 'artifacts/release/source-tree-freeze.json', (freeze) => {
                    freeze.source_control = { kind: 'git', commit: '0123456789abcdef' };
                });
            },
            'source-control-no-git-contract-invalid',
        ],
        [
            'future freeze observation',
            async (root) => mutateJson(root, 'artifacts/release/source-tree-freeze.json', (freeze) => {
                freeze.frozen_at = new Date(Date.now() + 10 * 60_000).toISOString();
            }),
            'source-freeze-time-is-in-the-future',
        ],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(name, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutate(root);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('explicit contract: device health requires privacy, serial, hardware, and check proof', async (t) => {
    const cases = [
        ['privacy proof', (report) => { delete report.privacy; }, 'device-health-status-not-acceptable'],
        ['serial restoration proof', (report) => { delete report.serialRestore; }, 'device-health-status-not-acceptable'],
        ['hardware proof', (report) => { delete report.hardwareEvidence; }, 'device-health-status-not-acceptable'],
        ['required check', (report) => { report.checks.pop(); }, 'native-report-required-check-set-invalid'],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-c6-device-health.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('explicit contract: benchmark requires every stage and source restoration proof', async (t) => {
    const cases = [
        ['cold stage', (report) => { delete report.cycles.cold; }, 'benchmark-required-cold-exact-hot-upload-stage-missing'],
        ['exact stage', (report) => { delete report.cycles.exact; }, 'benchmark-required-cold-exact-hot-upload-stage-missing'],
        ['hot stage', (report) => { delete report.cycles.hotEdit; }, 'benchmark-required-cold-exact-hot-upload-stage-missing'],
        ['upload stage', (report) => { delete report.cycles.upload; }, 'benchmark-required-cold-exact-hot-upload-stage-missing'],
        ['source restoration', (report) => { delete report.sourceGate.restored; }, 'benchmark-source-edit-and-restore-proof-invalid'],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('explicit contract: benchmark upload lock evidence is measured and bounded', async (t) => {
    const cases = [
        ['missing gate', (report) => { delete report.uploadCompileLock; }],
        ['missing telemetry', (report) => { report.uploadCompileLock.reported = false; }],
        ['non-boolean summary telemetry', (report) => { report.uploadCompileLock.reported = 'true'; }],
        ['missing cycle upload telemetry', (report) => { delete report.cycles.upload.uploadCompileLockWaitReported; }],
        ['non-boolean cycle upload telemetry', (report) => { report.cycles.upload.uploadCompileLockWaitReported = 'true'; }],
        ['slow lock wait', (report) => {
            report.uploadCompileLock.seconds = 5.1;
            report.cycles.upload.uploadCompileLockSeconds = 5.1;
            report.cycles.upload.evidence = ['[Timing] Upload compile lock wait (quick-fast-upload): 5.1s'];
        }],
        ['warmup reuse', (report) => { report.uploadCompileLock.compatibleWarmupReuseObserved = true; }],
        ['cycle warmup wait', (report) => { report.cycles.upload.matchingWarmupWaitObserved = true; }],
        ['cycle mismatch', (report) => { report.cycles.upload.uploadCompileLockSeconds = 0.3; }],
        ['raw evidence mismatch', (report) => {
            report.cycles.upload.evidence = ['[Timing] Upload compile lock wait (quick-fast-upload): 4.9s'];
        }],
        ['generic lock evidence cannot stand in for upload telemetry', (report) => {
            report.cycles.upload.evidence = ['[Timing] Compile lock wait: 0.2s'];
        }],
        ['malformed upload lock evidence', (report) => {
            report.cycles.upload.evidence = [
                '[Timing] Upload compile lock wait (quick-fast-upload): 0.2s',
                '[Timing] Upload compile lock wait (fallback): unknown',
            ];
        }],
        ['raw matching-warmup marker', (report) => {
            report.cycles.upload.evidence.push('[INFO] First-compile optimization: waited for matching warmup window (<=900ms)');
        }],
        ['raw compatible-warmup marker', (report) => {
            report.cycles.upload.evidence.push('[INFO] Upload is reusing compatible same-board warmup already in progress.');
        }],
        ['missing cycle warmup flag', (report) => { delete report.cycles.upload.matchingWarmupWaitObserved; }],
        ['missing summary warmup flag', (report) => { delete report.uploadCompileLock.compatibleWarmupReuseObserved; }],
        ['missing failures', (report) => { delete report.uploadCompileLock.failures; }],
        ['null failures', (report) => { report.uploadCompileLock.failures = null; }],
        ['non-empty failures', (report) => { report.uploadCompileLock.failures = ['unexpected']; }],
        ['scalar raw evidence', (report) => {
            report.cycles.upload.evidence = '[Timing] Upload compile lock wait (quick-fast-upload): 0.2s';
        }],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'benchmark-upload-compile-lock-proof-invalid');
        });
    }
});

test('benchmark verified baseline is required and field-complete', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-c6-hardware-regression.json', (report) => {
        delete report.verified_baseline.environment.toolchainKey;
    });
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'benchmark-verified-baseline-invalid');
});

test('explicit contract: upload manifest and gate-run supporting proof is mandatory', async (t) => {
    const cases = [
        [
            'upload-manifest supporting proof',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { delete report.protectedFiles; },
            'upload-manifest-gate-supporting-proof-invalid',
        ],
        [
            'upload-manifest schema v2',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.schemaVersion = 1; },
            'upload-manifest-gate-schema-or-status-invalid',
        ],
        [
            'original wrong-FQBN rejection fields',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.gate.fqbnMismatchRejected = false; },
            'upload-manifest-gate-check-failed',
        ],
        [
            'artifact-hash rejection before transport',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.hashGate.transportBlockedUntilHashRejection = false; },
            'upload-manifest-hash-gate-check-failed',
        ],
        [
            'hash mutation leaves firmware bytes unchanged',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.hashMutation.firmwareArtifactsModified = true; },
            'upload-manifest-hash-mutation-proof-invalid',
        ],
        [
            'fresh exact-FQBN SharedFast hash recovery manifest',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.hashRecoveryManifest.freshlySealed = false; },
            'upload-manifest-hash-recovery-manifest-invalid',
        ],
        [
            'fresh exact-FQBN SharedFast normal recovery manifest',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.recoveryManifest.manifestHash = 'not-a-sha256'; },
            'upload-manifest-recovery-manifest-invalid',
        ],
        [
            'unchanged manifest-gate source and target identity',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.identity.after.codeFingerprint = 'different-source'; },
            'upload-manifest-source-target-identity-invalid',
        ],
        [
            'hash protected files remain unchanged',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.hashProtectedFiles.unchanged = false; },
            'upload-manifest-hash-protection-or-restoration-invalid',
        ],
        [
            'hash restoration removes backup and residue',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.hashRestoration.backupRemoved = false; },
            'upload-manifest-hash-protection-or-restoration-invalid',
        ],
        [
            'initial exact-FQBN force-rebuild cache clear',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.initialCacheClear.forceCcacheRecache = false; },
            'upload-manifest-between-phase-cache-clear-invalid',
        ],
        [
            'between-phase cache clear removes prebuilt-core reuse',
            'artifacts/release/v1-c6-manifest-gate.json',
            (report) => { report.betweenPhaseCacheClear.prebuiltCorePreserved = true; },
            'upload-manifest-between-phase-cache-clear-invalid',
        ],
        [
            'passed gate-run status',
            'artifacts/release/v1-native-smoke.json',
            (report) => { report.gate_run.status = 'failed'; },
            'native-report-gate-run-binding-mismatch',
        ],
    ];
    for (const [name, relativePath, mutate, issueId] of cases) {
        await t.test(`missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, relativePath, mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('a startup exception atomically invalidates an old pass and leaves no temporary output', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const outputRelative = 'artifacts/release/v1-release-evidence-manifest.json';
    await write(root, outputRelative, `${JSON.stringify({ status: 'passed', oldPassSentinel: true })}\n`);
    // Point a required file input at an existing directory so path resolution
    // throws after the old decision has already been atomically invalidated.
    const result = run(root, ['-SourceManifestPath', 'artifacts/release']);
    assert.notEqual(result.status, 0, result.stderr || result.stdout);
    const invalidated = await readJson(root, outputRelative);
    assert.equal(invalidated.status, 'candidate_evidence_stale');
    assert.equal(invalidated.invalidated, true);
    assert.equal(invalidated.oldPassSentinel, undefined);
    const releaseFiles = await readdir(join(root, 'artifacts/release'));
    assert.deepEqual(
        releaseFiles.filter((name) => /^v1-release-evidence-manifest\.json\..+\.(?:tmp|replace-backup)$/i.test(name)),
        [],
    );
});

test('native smoke rejects omission of every fixed productization check', async (t) => {
    for (const missingId of nativeSmokeCheckNames) {
        await t.test(`missing ${missingId}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
                report.checks = report.checks.filter((entry) => entry.id !== missingId);
            });
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'native-report-required-check-set-invalid');
        });
    }
});

test('native smoke requires schema v3, exact C6 identity and completed cleanup', async (t) => {
    const cases = [
        ['schema v3', (report) => { report.schemaVersion = 2; }],
        ['exact project', (report) => { report.project.requested_name = 'other_project'; }],
        ['exact FQBN', (report) => { report.project.fqbn = 'esp32:esp32:esp32c6'; }],
        ['theme cleanup', (report) => { report.cleanup.themeRestored = false; }],
        ['package cleanup', (report) => { report.cleanup.declarativePackageRemoved = false; }],
        ['legacy cleanup', (report) => { report.cleanup.legacyPackageAbsent = false; }],
        ['draft cleanup', (report) => { report.cleanup.recoveryDraftRemoved = false; }],
        ['project cleanup', (report) => { report.cleanup.unknownProjectRemoved = false; }],
        ['temporary-source cleanup', (report) => { report.cleanup.temporarySourcesRemoved = false; }],
        ['final project restore', (report) => { report.cleanup.finalProjectRestored = false; }],
        ['complete system path metrics', (report) => { report.metrics.system_path_complete_count -= 1; }],
        ['block catalog metrics', (report) => { report.metrics.catalog_count = 0; }],
        ['built-in search metrics', (report) => { report.metrics.builtin_search_result_count = 0; }],
        ['source label metrics', (report) => { report.metrics.builtin_source_label_count = 0; }],
        ['quality report metrics', (report) => { report.metrics.package_quality_check_count = 7; }],
        ['imported search metrics', (report) => { report.metrics.imported_search_result_count = 0; }],
        ['unknown block metrics', (report) => { report.metrics.unknown_block_count = 0; }],
        ['protected byte metrics', (report) => { report.metrics.protected_project_bytes = 0; }],
        ['resource panel evidence', (report) => { report.metrics.resource_panel_present = false; }],
        ['expected port selection', (report) => { report.metrics.expected_port_selected = false; }],
        ['horizontal overflow metric presence', (report) => { delete report.metrics.maximum_horizontal_overflow; }],
        ['horizontal overflow metrics', (report) => { report.metrics.maximum_horizontal_overflow = 2; }],
    ];
    for (const [name, mutate] of cases) {
        await t.test(name, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-native-smoke.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'native-smoke-schema-or-status-invalid');
        });
    }
});

test('memory evidence requires conclusive, ten-cycle, clean, core-check proof', async (t) => {
    const cases = [
        ['conclusive result', (report) => { delete report.result_kind; }, 'memory-report-not-conclusive-pass'],
        ['ten numbered cycles', (report) => { report.cycles.pop(); }, 'memory-report-not-conclusive-pass'],
        ['clean contamination state', (report) => { report.contamination.status = 'transient_observed'; }, 'memory-report-not-conclusive-pass'],
        ['required core checks', (report) => { report.checks.shift(); }, 'native-report-required-check-set-invalid'],
        ['exact requested project', (report) => { report.project.requested_name = 'another_project'; }, 'memory-report-not-conclusive-pass'],
        ['nonempty code fingerprint', (report) => { report.project.code_fingerprint = ''; }, 'memory-report-not-conclusive-pass'],
        ['exact full C6 FQBN', (report) => { report.project.fqbn = 'esp32:esp32:esp32c6'; }, 'memory-report-not-conclusive-pass'],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/desktop-memory-regression.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('upload progress booleans cannot pass without status=passed', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-c6-upload-progress.json', (report) => {
        delete report.status;
    });
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'upload-progress-schema-or-status-invalid');
});

test('every C6 report is bound to the exact project, full FQBN, and COM12', async (t) => {
    const cases = [
        ['device-health project', 'artifacts/release/v1-c6-device-health.json', (report) => { report.project = 'other'; }],
        ['upload-progress port', 'artifacts/release/v1-c6-upload-progress.json', (report) => { report.port = 'COM99'; }],
        ['manifest-gate full FQBN', 'artifacts/release/v1-c6-manifest-gate.json', (report) => { report.fqbn = 'esp32:esp32:esp32c6'; }],
    ];
    for (const [name, relativePath, mutate] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, relativePath, mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'c6-report-exact-session-identity-invalid');
        });
    }
});

test('C6 hardware evidence is cross-checked for chip, capacity, layout, and PSRAM semantics', async (t) => {
    const hardwarePath = 'artifacts/release/v1-c6-hardware-regression.json';
    const devicePath = 'artifacts/release/v1-c6-device-health.json';
    const cases = [
        ['benchmark chip family', hardwarePath, (report) => { report.verified_baseline.device.chip = 'ESP32-S3'; }, 'c6-hardware-cross-report-invalid'],
        ['physical Flash equality', devicePath, (report) => { report.hardwareEvidence.flashBytes = 8 * 1024 * 1024; }, 'c6-hardware-cross-report-invalid'],
        ['configured Flash capacity', devicePath, (report) => { report.hardwareEvidence.configuredFlashBytes = 8 * 1024 * 1024; }, 'c6-hardware-cross-report-invalid'],
        ['resource budget bounded by configured Flash', hardwarePath, (report) => { report.verified_baseline.resources.flashMaxBytes = 17 * 1024 * 1024; }, 'c6-hardware-cross-report-invalid'],
        ['firmware segment stays in physical Flash', hardwarePath, (report) => { report.verified_baseline.firmware.artifacts[1].flashAddress = '0x1000000'; }, 'c6-firmware-layout-out-of-bounds-or-overlapping'],
        ['firmware segments do not overlap', hardwarePath, (report) => { report.verified_baseline.firmware.artifacts[1].flashAddress = '0x1000'; }, 'c6-firmware-layout-out-of-bounds-or-overlapping'],
        ['benchmark PSRAM property is explicit', hardwarePath, (report) => { delete report.verified_baseline.device.psramBytes; }, 'c6-psram-evidence-inconsistent'],
        ['device PSRAM property is explicit', devicePath, (report) => { delete report.hardwareEvidence.psramBytes; }, 'c6-psram-evidence-inconsistent'],
        ['null PSRAM remains unknown', devicePath, (report) => { report.hardwareEvidence.psramEvidenceState = 'reported'; }, 'c6-psram-evidence-inconsistent'],
        ['one reported PSRAM value cannot match one unknown', hardwarePath, (report) => { report.verified_baseline.device.psramBytes = 8 * 1024 * 1024; }, 'c6-psram-evidence-inconsistent'],
        ['explicitly enabled PSRAM cannot remain unmeasured', hardwarePath, (report) => {
            report.fqbn = `${exactC6Fqbn}:PSRAM=opi`;
            report.verified_baseline.environment.fqbn = report.fqbn;
        }, 'c6-psram-evidence-inconsistent'],
    ];
    for (const [name, relativePath, mutate, issueId] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, relativePath, mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('upload progress is recomputed from raw samples and bound to one benchmark run', async (t) => {
    const benchmarkPath = 'artifacts/release/v1-c6-hardware-regression.json';
    const progressPath = 'artifacts/release/v1-c6-upload-progress.json';
    const cases = [
        ['embedded run ID', benchmarkPath, (report) => { report.uploadProgress.benchmarkRunId = 'other-run'; }, 'c6-upload-progress-run-id-mismatch'],
        ['standalone run ID', progressPath, (report) => { report.benchmarkRunId = 'other-run'; }, 'c6-upload-progress-run-id-mismatch'],
        ['integer percentages', progressPath, (report) => { report.samples[1].percentage = 42.5; }, 'c6-upload-progress-samples-invalid'],
        ['monotonic percentages', progressPath, (report) => { report.samples[0].percentage = 50; report.samples[0].visiblePercentageText = '50%'; }, 'c6-upload-progress-samples-invalid'],
        ['an intermediate 10-99 percentage', progressPath, (report) => { report.samples[1].percentage = 5; report.samples[1].visiblePercentageText = '5%'; }, 'c6-upload-progress-samples-invalid'],
        ['a final 100 percentage', progressPath, (report) => { report.samples.at(-1).percentage = 99; report.samples.at(-1).visiblePercentageText = '99%'; }, 'c6-upload-progress-samples-invalid'],
        ['exact visible percentage text', progressPath, (report) => { report.samples[1].visiblePercentageText = '4%'; }, 'c6-upload-progress-samples-invalid'],
        ['non-overflowing percentage text', progressPath, (report) => { report.samples[1].textScrollWidth = 40; }, 'c6-upload-progress-samples-invalid'],
        ['literal per-sample text-fit proof', progressPath, (report) => { report.samples[1].textFits = 'true'; }, 'c6-upload-progress-samples-invalid'],
        ['nonnegative monotonic elapsed time', progressPath, (report) => { report.samples[1].elapsedMs = 50; }, 'c6-upload-progress-samples-invalid'],
        ['sample count derived from the array', progressPath, (report) => { report.sampleCount = 99; }, 'c6-upload-progress-samples-invalid'],
        ['upload wall time equality', progressPath, (report) => { report.operationWallSeconds = 3; }, 'c6-upload-progress-wall-time-mismatch'],
        ['full embedded and standalone sample equality', progressPath, (report) => { report.samples[1].message = 'different sample'; }, 'c6-upload-progress-cross-report-mismatch'],
    ];
    for (const [name, relativePath, mutate, issueId] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, relativePath, mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('memory, benchmark, safe-cancel, and manifest-gate share one source identity', async (t) => {
    const cases = [
        ['memory fingerprint', 'artifacts/release/desktop-memory-regression.json', (report) => { report.project.code_fingerprint = 'other-source'; }, 'c6-source-fingerprint-cross-report-mismatch'],
        ['safe-cancel fingerprint', 'artifacts/release/v1-c6-safe-cancel.json', (report) => {
            report.identity.before.sourceFingerprint = 'other-source';
            report.identity.after.sourceFingerprint = 'other-source';
            report.operation.workspaceFingerprint = 'other-source';
            report.recoveryCompile.workspaceFingerprint = 'other-source';
        }, 'c6-source-fingerprint-cross-report-mismatch'],
        ['manifest-gate fingerprint', 'artifacts/release/v1-c6-manifest-gate.json', (report) => {
            report.identity.before.codeFingerprint = 'other-source';
            report.identity.after.codeFingerprint = 'other-source';
        }, 'c6-source-fingerprint-cross-report-mismatch'],
        ['available include signatures', 'artifacts/release/v1-c6-manifest-gate.json', (report) => {
            report.identity.before.includeSignature = 'spi.h';
            report.identity.after.includeSignature = 'spi.h';
        }, 'c6-include-signature-cross-report-mismatch'],
    ];
    for (const [name, relativePath, mutate, issueId] of cases) {
        await t.test(`rejects ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, relativePath, mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('safe-cancel evidence requires an exact run-scoped compiler-stage cancellation proof', async (t) => {
    const cases = [
        [
            'matching upload/cancel run IDs',
            (report) => { report.runIds.cancelCommand = report.runIds.recoveryCompile; },
            'safe-cancel-run-id-chain-invalid',
        ],
        [
            'the exact c6_regression/full-FQBN identity',
            (report) => { report.fqbn = 'esp32:esp32:esp32c6'; },
            'safe-cancel-c6-identity-invalid',
        ],
        [
            'a real Arduino CLI/GCC stage',
            (report) => { report.operation.stageObservation.process.arduino_or_gcc_stage = false; },
            'safe-cancel-owned-process-wait-proof-invalid',
        ],
        [
            'backend process-tree termination and wait',
            (report) => { report.cancellation.terminatedProcessTreeCount = 0; },
            'safe-cancel-owned-process-wait-proof-invalid',
        ],
        [
            'zero Flash transport',
            (report) => {
                report.flashTransport.observed = true;
                report.flashTransport.observationCount = 1;
                report.flashTransport.observations.push({ reason: 'esptool-write-flash' });
            },
            'safe-cancel-flash-transport-observed',
        ],
        [
            'three consecutive clean global/tool-tree samples',
            (report) => { report.quiescence.afterCancel.samples.at(-1).globalOrphanCount = 1; },
            'safe-cancel-quiescence-proof-invalid',
        ],
        [
            'a fresh recovery run ID',
            (report) => { report.runIds.recoveryCompile = report.runIds.uploadSketch; },
            'safe-cancel-run-id-chain-invalid',
        ],
        [
            'a recovery compile lock wait no greater than five seconds',
            (report) => { report.recoveryCompile.compileLockWaitSeconds = 5.01; },
            'safe-cancel-recovery-compile-or-lock-proof-invalid',
        ],
        [
            'unchanged source/target identity',
            (report) => { report.identity.after.sourceFingerprint = 'changed-source'; },
            'safe-cancel-source-target-identity-changed',
        ],
        [
            'invoked source fingerprint identity',
            (report) => { report.recoveryCompile.workspaceFingerprint = 'stale-source'; },
            'safe-cancel-invoked-source-fingerprint-mismatch',
        ],
        [
            'the exact machine check set',
            (report) => { report.checks.pop(); },
            'native-report-required-check-set-invalid',
        ],
    ];
    for (const [name, mutate, issueId] of cases) {
        await t.test(`rejects missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-c6-safe-cancel.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, issueId);
        });
    }
});

test('native evidence rejects missing PID, CDP, listener, and target bindings', async (t) => {
    const cases = [
        ['executable PID', (report) => { delete report.executable.process_id; }],
        ['CDP binding', (report) => { delete report.cdp_binding; }],
        ['listener owner', (report) => { delete report.cdp_binding.listener_owning_process_id; }],
        ['CDP target', (report) => { delete report.cdp_binding.target_id; }],
    ];
    for (const [name, mutate] of cases) {
        await t.test(`missing ${name}`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            await mutateJson(root, 'artifacts/release/v1-native-smoke.json', mutate);
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'native-report-cdp-binding-mismatch');
        });
    }
});

test('every Windows native report requires the exact production Tauri target URL', async (t) => {
    const nativeReportPaths = [
        'artifacts/release/v1-native-smoke.json',
        'artifacts/release/desktop-memory-regression.json',
        'artifacts/release/v1-c6-hardware-regression.json',
        'artifacts/release/v1-c6-device-health.json',
        'artifacts/release/v1-c6-upload-progress.json',
        'artifacts/release/v1-c6-manifest-gate.json',
        'artifacts/release/v1-c6-safe-cancel.json',
    ];
    const invalidUrls = [
        ['Vite development server', 'http://localhost:1420/'],
        ['WebView navigation error', 'chrome-error://chromewebdata/'],
        ['production origin with a query', 'http://tauri.localhost/?dev=true'],
        ['case-altered production origin', 'HTTP://tauri.localhost/'],
    ];

    for (const [name, targetUrl] of invalidUrls) {
        await t.test(`rejects ${name} even when all reports agree`, async (st) => {
            const { root } = await makeFixture();
            st.after(() => rm(root, { recursive: true, force: true }));
            for (const reportPath of nativeReportPaths) {
                await mutateJson(root, reportPath, (report) => {
                    report.cdp_binding.target_url = targetUrl;
                });
            }
            const result = run(root);
            const manifest = await readManifest(root);
            assertRejected(result, manifest, 'native-report-production-target-url-mismatch');
        });
    }
});

test('all native reports must name the same otherwise-valid CDP target', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
        report.cdp_binding.target_id = 'alternate-valid-target';
        report.cdp_binding.web_socket_debugger_url = 'ws://127.0.0.1:9223/devtools/page/alternate-valid-target';
    });
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'native-reports-do-not-share-one-runtime-binding');
});

test('binding verification timestamps must enclose the evidence capture', async (t) => {
    const { root, capturedAt } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
        report.binding_verification.verified_before_at = new Date(Date.parse(capturedAt) + 10_000).toISOString();
    });
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'native-report-is-missing-fresh-post-gate-time');
});

test('exactly five ZIPs with a noncanonical name are still rejected', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const originalName = exampleNames[0];
    const replacementName = 'ck_example_noncanonical.zip';
    await rename(
        join(root, 'examples/importable-packages', originalName),
        join(root, 'examples/importable-packages', replacementName),
    );
    await mutateJson(root, 'artifacts/release/v1-release-gates.json', (gate) => {
        gate.example_packages.find((entry) => entry.name === originalName).name = replacementName;
    });
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'example-package-canonical-name-set-invalid');
});

test('an example ZIP older than the current gate start is stale', async (t) => {
    const { root, startedAt } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const oldTime = new Date(Date.parse(startedAt) - 60_000);
    await utimes(join(root, 'examples/importable-packages', exampleNames[0]), oldTime, oldTime);
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'example-package-not-fresh-for-gate-run');
});

test('MAC variants and absolute paths fail the evidence set without being copied', async (t) => {
    const { root } = await makeFixture({ sensitiveReportValues: true });
    t.after(() => rm(root, { recursive: true, force: true }));
    const result = run(root);
    const raw = await readFile(join(root, 'artifacts/release/v1-release-evidence-manifest.json'), 'utf8');
    const manifest = JSON.parse(raw);
    assertRejected(result, manifest, 'evidence-report-contains-sensitive-value');
    assert.doesNotMatch(raw, /AA:BB:CC:DD:EE:FF/i);
    assert.doesNotMatch(raw, /AABBCCDDEEFF/i);
    assert.doesNotMatch(raw, /aabb\.ccdd\.eeff/i);
    assert.doesNotMatch(raw, /C:\\Users\\Alice/i);
    assert.doesNotMatch(raw, /D:\\private-lab/i);
    assert.doesNotMatch(raw, /private-server/i);
    assert.doesNotMatch(raw, /file:\/\/\/C:\/private/i);
    assert.equal(manifest.privacy.containsFullMac, false);
    assert.equal(manifest.privacy.containsUserAbsolutePath, false);
    assert.equal(manifest.privacy.containsWindowsAbsolutePath, false);
    assert.equal(manifest.privacy.sensitiveValuesCopiedIntoManifest, false);
    assert.ok(manifest.privacy.observedFullMacValueCount >= 3);
    assert.ok(manifest.privacy.observedUserAbsolutePathCount >= 4);
});

test('raw MAC detection distinguishes decimal measurements from device identifiers', async (t) => {
    await t.test('does not treat a twelve-digit decimal fraction as a MAC', async (st) => {
        const { root } = await makeFixture();
        st.after(() => rm(root, { recursive: true, force: true }));
        await mutateJson(root, 'artifacts/release/desktop-memory-regression.json', (report) => {
            report.diagnostics = { slope_per_cycle: 64723.333333333336 };
        });
        const result = run(root);
        const manifest = await readManifest(root);
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.equal(manifest.status, 'passed');
        assert.equal(manifest.privacy.observedFullMacValueCount, 0);
    });

    await t.test('rejects an all-numeric raw MAC when it has a MAC label', async (st) => {
        const { root } = await makeFixture();
        st.after(() => rm(root, { recursive: true, force: true }));
        await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
            report.mac = '123456789012';
        });
        const result = run(root);
        const manifest = await readManifest(root);
        assertRejected(result, manifest, 'evidence-report-contains-sensitive-value');
        assert.ok(manifest.privacy.observedFullMacValueCount >= 1);
    });

    await t.test('rejects an unlabeled raw MAC containing hexadecimal letters', async (st) => {
        const { root } = await makeFixture();
        st.after(() => rm(root, { recursive: true, force: true }));
        await mutateJson(root, 'artifacts/release/v1-native-smoke.json', (report) => {
            report.opaqueIdentifier = 'A1B2C3D4E5F6';
        });
        const result = run(root);
        const manifest = await readManifest(root);
        assertRejected(result, manifest, 'evidence-report-contains-sensitive-value');
        assert.ok(manifest.privacy.observedFullMacValueCount >= 1);
    });
});

test('a referenced JSON report larger than 16 MiB is rejected before parsing', async (t) => {
    const { root } = await makeFixture();
    t.after(() => rm(root, { recursive: true, force: true }));
    const target = join(root, 'artifacts/release/v1-c6-upload-progress.json');
    await writeFile(target, `{"padding":"${'x'.repeat(16 * 1024 * 1024)}"}\n`);
    const result = run(root);
    const manifest = await readManifest(root);
    assertRejected(result, manifest, 'evidence-json-exceeds-16-mib');
});
