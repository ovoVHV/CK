import assert from 'node:assert/strict';
import { spawnSync } from 'node:child_process';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const source = await readFile(new URL('./Test-DesktopMemoryNative.ps1', import.meta.url), 'utf8');
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];
const selectorMatch = source.match(
    /# BEGIN SELECT-CK-WEBVIEW-DEBUG-HOST\r?\n([\s\S]*?)\r?\n# END SELECT-CK-WEBVIEW-DEBUG-HOST/,
);
assert.ok(selectorMatch, 'WebView2 debug-host selector should be independently fixture-testable');
const selectorSource = selectorMatch[1];
const linearTrendMatch = embeddedNode.match(
    /(function linearTrend\(values, noiseFloor\) \{[\s\S]*?\n\})\n\nfunction addCheck/,
);
assert.ok(linearTrendMatch, 'linearTrend should be independently fixture-testable');
const linearTrend = new Function(
    'thresholds',
    `${linearTrendMatch[1]}; return linearTrend;`,
)({
    linear_trend: {
        minimum_positive_steps: 7,
        minimum_r_squared: 0.8,
    },
});
const processTreeMatch = embeddedNode.match(
    /const PROCESS_TREE_SCRIPT = String\.raw`\r?\n([\s\S]*?)\r?\n`;/,
);
assert.ok(processTreeMatch, 'embedded Windows process-tree probe should be fixture-testable');
const processTreeSource = processTreeMatch[1];

test('embedded native CDP runner is valid JavaScript', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
});

test('passes the embedded runner over standard input without a Windows command-line payload', () => {
    assert.match(source, /\$nodeScript\s*\|\s*node\s+-/);
    assert.doesNotMatch(source, /\bnode(?:\.exe)?\s+(?:--eval|-e)\b/i);
});

test('requires the CK 1.0 ten-cycle shape with cycle two as the stable baseline', () => {
    assert.match(source, /\[int\]\$Cycles = 10/);
    assert.match(source, /\[int\]\$BaselineCycle = 2/);
    assert.match(source, /\$Cycles -lt 10/);
    assert.match(embeddedNode, /baseline_cycle:/);
    assert.match(embeddedNode, /final_cycle:/);
    assert.match(embeddedNode, /route_order_per_cycle: \['dashboard', 'workspace'\]/);
    assert.match(source, /stable comparison window must contain at least 9 samples/);
});

test('binds evidence to the exact running production executable and frozen source tree', () => {
    assert.match(source, /target\\release\\appsdesktop\.exe/);
    assert.match(source, /selected CK process does not run the requested production executable/);
    assert.match(source, /Get-Sha256Lower -Path \$actualExecutable/);
    assert.match(source, /manifest_sha256/);
    assert.match(source, /tree_sha256/);
    assert.match(source, /Assert-SourceTreeFreeze[\s\S]*Assert-SourceTreeFreeze/);
    assert.match(source, /postflight = \$postflightVerified/);
    assert.match(source, /desktop-memory-regression\.json/);
});

test('binds memory evidence to the same passed release gate and shared native identity', () => {
    assert.match(source, /NativeEvidenceBinding\.psm1/);
    assert.match(source, /New-NativeEvidenceBinding/);
    assert.match(source, /Complete-NativeEvidenceBinding/);
    assert.match(source, /NotePropertyName gate_run/);
    assert.match(source, /NotePropertyName cdp_binding/);
    assert.match(source, /shared-native-evidence-binding/);
    assert.ok(
        source.indexOf('Initialize-NativeEvidenceReportPath') < source.indexOf('New-NativeEvidenceBinding'),
        'stale passed memory evidence must be removed before binding preflight can fail',
    );
});

test('binds the CDP port to the direct WebView2 browser child of the selected CK process', () => {
    assert.match(source, /\$ckTreeIds = \[System\.Collections\.Generic\.HashSet\[uint32\]\]::new\(\)/);
    assert.match(source, /--remote-debugging-port=/);
    assert.match(source, /ParentProcessId -eq \$CkProcessId/);
    assert.match(source, /msedgewebview2\.exe/);
    assert.match(source, /CommandLine -notmatch '\(\?:\^\|\\s\)--type/);
    assert.match(source, /exactly one direct WebView2 browser host for CDP port/);
    assert.match(source, /does not belong to the exact CK process tree/);
    assert.match(embeddedNode, /CK_MEMORY_DEBUG_HOST_PID/);
    assert.match(embeddedNode, /hosting the selected CDP endpoint left the CK process tree/);
    assert.match(source, /Get-NetTCPConnection -State Listen -LocalPort \$DebugPort/);
    assert.match(source, /listener owner\(s\)/);
    assert.match(embeddedNode, /listener_bindings:/);
});

test('selects only the direct browser host when browser and renderer both inherit the CDP port', () => {
    const fixture = `${selectorSource}
$tree = [System.Collections.Generic.HashSet[uint32]]::new()
foreach ($id in @([uint32]100, [uint32]200, [uint32]201, [uint32]202)) { [void]$tree.Add($id) }
$processes = @(
    [pscustomobject]@{ ProcessId = [uint32]100; ParentProcessId = [uint32]0; Name = 'appsdesktop.exe'; ExecutablePath = 'C:\\CK\\appsdesktop.exe'; CommandLine = 'appsdesktop.exe' },
    [pscustomobject]@{ ProcessId = [uint32]200; ParentProcessId = [uint32]100; Name = 'msedgewebview2.exe'; ExecutablePath = 'C:\\WebView2\\msedgewebview2.exe'; CommandLine = 'msedgewebview2.exe --remote-debugging-port=9223' },
    [pscustomobject]@{ ProcessId = [uint32]201; ParentProcessId = [uint32]200; Name = 'msedgewebview2.exe'; ExecutablePath = 'C:\\WebView2\\msedgewebview2.exe'; CommandLine = 'msedgewebview2.exe --type=renderer --remote-debugging-port=9223' },
    [pscustomobject]@{ ProcessId = [uint32]202; ParentProcessId = [uint32]100; Name = 'msedgewebview2.exe'; ExecutablePath = 'C:\\WebView2\\msedgewebview2.exe'; CommandLine = 'msedgewebview2.exe --type=renderer --remote-debugging-port=9223' },
    [pscustomobject]@{ ProcessId = [uint32]300; ParentProcessId = [uint32]999; Name = 'msedgewebview2.exe'; ExecutablePath = 'C:\\Other\\msedgewebview2.exe'; CommandLine = 'msedgewebview2.exe --remote-debugging-port=9223' }
)
$selected = Select-CkWebViewDebugHost -Processes $processes -CkProcessId ([uint32]100) -DebugPort 9223 -CkTreeIds $tree
[ordered]@{ process_id = [int]$selected.ProcessId; parent_process_id = [int]$selected.ParentProcessId } | ConvertTo-Json -Compress
`;
    const directory = mkdtempSync(join(tmpdir(), 'ck-memory-cdp-host-'));
    const fixturePath = join(directory, 'fixture.ps1');
    try {
        writeFileSync(fixturePath, fixture, 'utf8');
        const result = spawnSync(
            'powershell.exe',
            ['-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixturePath],
            { encoding: 'utf8', windowsHide: true },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        assert.deepEqual(JSON.parse(result.stdout.trim()), {
            process_id: 200,
            parent_process_id: 100,
        });
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('targets only the main native CK page and restores native viewport state first', () => {
    assert.match(source, /console=detached/);
    assert.match(embeddedNode, /new WebSocket\(process\.env\.CK_CDP_URL\)/);
    assert.ok(
        embeddedNode.indexOf('restoreNativeViewport(call)') < embeddedNode.indexOf("HeapProfiler.enable"),
        'native viewport restoration must happen before memory sampling',
    );
});

test('collects V8, DOM, Blockly and recursive Windows process-tree evidence', () => {
    assert.match(embeddedNode, /HeapProfiler\.collectGarbage/);
    assert.match(embeddedNode, /Runtime\.getHeapUsage/);
    assert.match(embeddedNode, /Memory\.getDOMCounters/);
    assert.match(embeddedNode, /Blockly\.Workspace\.getAll\(\)/);
    assert.match(embeddedNode, /getMainWorkspace/);
    assert.match(embeddedNode, /target\?\.trashcan\?\.flyout\?\.getWorkspace/);
    assert.match(embeddedNode, /stale_trashcan_flyout_count/);
    assert.match(embeddedNode, /unexpected_workspace_count/);
    assert.match(embeddedNode, /Get-CimInstance Win32_Process/);
    assert.match(embeddedNode, /ParentProcessId/);
    assert.match(embeddedNode, /total_private_bytes/);
    assert.match(embeddedNode, /total_working_set_bytes/);
    assert.match(embeddedNode, /resident_private_bytes/);
    assert.match(embeddedNode, /toolchain_process_count/);
    assert.match(embeddedNode, /toolchain_processes/);
    assert.match(embeddedNode, /role = if \(\$isRoot\) \{ 'root' \}/);
    assert.match(embeddedNode, /'resident_webview'/);
    assert.match(embeddedNode, /'known_toolchain'/);
    assert.match(embeddedNode, /'unknown_descendant'/);
    assert.match(embeddedNode, /global_ck_related_orphan_candidate/);
    assert.match(embeddedNode, /command_sha256/);
    assert.match(embeddedNode, /creation_time_utc/);
});

test('Windows process probe classifies the root and non-resident descendants at runtime', () => {
    const result = spawnSync(
        'powershell.exe',
        ['-NoProfile', '-NonInteractive', '-Command', processTreeSource],
        {
            encoding: 'utf8',
            windowsHide: true,
            maxBuffer: 4 * 1024 * 1024,
            env: {
                ...process.env,
                CK_MEMORY_ROOT_PID: String(process.pid),
                CK_MEMORY_ROOT_PATH: process.cwd(),
            },
        },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
    const evidence = JSON.parse(result.stdout.trim());
    assert.equal(evidence.root_process_id, process.pid);
    assert.equal(
        evidence.processes.find((item) => item.process_id === process.pid)?.role,
        'root',
    );
    assert.ok(evidence.pollution_process_count >= 1, 'fixture PowerShell child should be pollution');
    assert.ok(
        evidence.pollution_processes.some((item) => item.role === 'unknown_descendant'),
        'the fixture PowerShell process must not be mislabeled as a browser',
    );
    assert.ok(Array.isArray(evidence.global_ck_related_processes));
});

test('navigates by exact project identity and refuses to discard unsaved work', () => {
    assert.match(embeddedNode, /Refusing to measure the wrong open project/);
    assert.match(embeddedNode, /heading\.title === \$\{JSON\.stringify\(name\)\}/);
    assert.match(embeddedNode, /MouseEvent\('click'/);
    assert.match(embeddedNode, /unsaved-changes-dialog/);
    assert.match(embeddedNode, /refused to discard them/);
    assert.match(embeddedNode, /code_fingerprint/);
});

test('enforces documented deltas and rejects persistent linear growth', () => {
    assert.match(embeddedNode, /renderer_heap_delta_bytes_max: 5 \* MiB/);
    assert.match(embeddedNode, /dom_node_delta_max: 1500/);
    assert.match(embeddedNode, /dom_event_listener_delta_max: 3/);
    assert.match(embeddedNode, /resident_process_tree_private_delta_bytes_max: 32 \* MiB/);
    assert.match(embeddedNode, /blockly_workspace_delta_max: 0/);
    assert.match(embeddedNode, /minimum_r_squared: 0\.8/);
    assert.match(embeddedNode, /persistent_linear_growth/);
    assert.match(embeddedNode, /dom-event-listener-delta-within-3/);
    assert.match(embeddedNode, /dashboard-releases-current-blockly-workspace-every-cycle/);
    assert.match(embeddedNode, /workspace-owns-only-current-blockly-tree-every-cycle/);
    assert.match(embeddedNode, /published-route-samples-have-zero-process-pollution/);
    assert.match(embeddedNode, /dashboard: analyzeRoute\('dashboard'\)/);
    assert.match(embeddedNode, /workspace: analyzeRoute\('workspace'\)/);
    assert.match(embeddedNode, /requireFiniteMetric/);
});

test('linear trend requires nine finite samples and detects monotonic growth', () => {
    assert.throws(() => linearTrend(Array(8).fill(1), 1), /at least 9 finite samples/);
    assert.throws(
        () => linearTrend([1, 2, 3, 4, Number.NaN, 6, 7, 8, 9], 1),
        /non-finite value/,
    );
    assert.equal(linearTrend(Array(9).fill(100), 1).persistent_linear_growth, false);
    assert.equal(
        linearTrend([0, 2, 4, 6, 8, 10, 12, 14, 16], 1).persistent_linear_growth,
        true,
    );
});

test('normalizes Blockly one-time listeners and samples only a quiescent UI process tree', () => {
    assert.match(embeddedNode, /releaseBlocklySoundPreloadListeners/);
    assert.match(embeddedNode, /Input\.dispatchMouseEvent/);
    assert.match(embeddedNode, /type: 'mouseMoved'/);
    assert.doesNotMatch(embeddedNode, /new PointerEvent\('pointermove'/);
    assert.match(embeddedNode, /waitForUiProcessTreeQuiescent/);
    assert.match(embeddedNode, /Build-tool process pollution did not return to zero/);
    assert.match(embeddedNode, /resident_process_tree_private_bytes/);
    assert.match(embeddedNode, /discarded_metric_groups/);
    assert.match(embeddedNode, /immediate_post_metrics/);
    assert.match(embeddedNode, /post_metrics_verification/);
    assert.match(embeddedNode, /CK_MEMORY_EVIDENCE_INCONCLUSIVE/);
    assert.match(embeddedNode, /report\.contamination\.status = 'inconclusive'/);
    assert.match(embeddedNode, /CDP call timed out after/);
});

test('publishes through a pending file and marks the source postflight before final evidence', () => {
    assert.match(source, /\$stagingFull = "\$outputFull\.pending"/);
    assert.match(embeddedNode, /CK_MEMORY_STAGING_OUTPUT/);
    assert.match(embeddedNode, /fs\.renameSync\(temporary, outputPath\)/);
    assert.match(source, /evidence_finalized_at/);
    assert.match(source, /Write-Utf8NoBomAtomic -Path \$outputFull/);
    assert.match(source, /node-process-exit-code/);
    assert.match(source, /Add-Member -NotePropertyName node_exit_code/);
    assert.match(source, /previousMemoryEnvironment/);
    assert.match(source, /\[EnvironmentVariableTarget\]::Process/);
});

test('memory lifecycle regression is non-mutating and does not compile or upload', () => {
    assert.doesNotMatch(embeddedNode, /__TAURI_INTERNALS__|invoke\(/);
    assert.doesNotMatch(embeddedNode, /build-compile-action|build-normal-upload-action/);
    assert.match(embeddedNode, /evidence_scope: 'production-exe-native-memory-lifecycle-no-hardware'/);
});
