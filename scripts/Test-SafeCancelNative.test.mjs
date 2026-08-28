import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const scriptUrl = new URL('./Test-SafeCancelNative.ps1', import.meta.url);
const scriptPath = scriptUrl.pathname.replace(/^\/(.:)/, '$1');
const source = await readFile(scriptUrl, 'utf8');
const backendSource = await readFile(
    new URL('../apps/desktop/src-tauri/src/lib.rs', import.meta.url),
    'utf8',
);
const nodeMatch = source.match(/\$nodeScript\s*=\s*@'\r?\n([\s\S]*?)\r?\n'@/);
assert.ok(nodeMatch, 'embedded Node here-string should be present');
const embeddedNode = nodeMatch[1];
const harnessNode = embeddedNode
    .replace(
        /const WebSocket = require\([^\r\n]+\);/,
        'class WebSocket { on() {} send() {} close() {} }',
    )
    .replace(
        /const \{ restoreNativeViewport \} = require\([^\r\n]+\);/,
        'const restoreNativeViewport = async () => {};',
    );
const {
    parseCompileLockSeconds,
    parseBackendCancellation,
    makeChecks,
    sanitizeEvidenceValue,
} = new Function(
    'require',
    `${harnessNode}\nreturn { parseCompileLockSeconds, parseBackendCancellation, makeChecks, sanitizeEvidenceValue };`,
)(createRequire(import.meta.url));
const classifierMatch = embeddedNode.match(
    /\/\/ BEGIN SAFE-CANCEL-PROCESS-CLASSIFIER\r?\nconst PROCESS_MONITOR_SCRIPT = String\.raw`\r?\n([\s\S]*?)\r?\n`;\r?\n\/\/ END SAFE-CANCEL-PROCESS-CLASSIFIER/,
);
assert.ok(classifierMatch, 'PowerShell process classifier should be independently fixture-testable');
const classifierSource = classifierMatch[1];
const classifierFunctions = classifierSource.match(
    /(function Test-SafeCancelKnownToolchainProcess[\s\S]*?function New-SafeCancelProcessRecord[\s\S]*?\n})\r?\n\r?\nwhile \(\$true\)/,
);
assert.ok(classifierFunctions, 'process classifier function boundary should be extractable');

test('PowerShell 5.1 parser accepts the safe-cancel runner', () => {
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
        { encoding: 'utf8', windowsHide: true },
    );
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('embedded CDP runner is valid JavaScript and is streamed over stdin', () => {
    assert.doesNotThrow(() => new Function(embeddedNode));
    assert.match(source, /\$nodeScript\s*\|\s*node\s+-/);
    assert.doesNotMatch(source, /(?:^|\s)node(?:\.exe)?\s+(?:--eval|-e)\b/im);
    assert.doesNotMatch(source, /WriteAllText\([^\r\n]*\$nodeScript/);
});

test('binds to the frozen production runtime before and after and invalidates stale output', () => {
    assert.match(source, /NativeEvidenceBinding\.psm1/);
    assert.match(source, /Initialize-NativeEvidenceReportPath -Path \$outputFull/);
    assert.ok(
        source.indexOf('Initialize-NativeEvidenceReportPath -Path $outputFull')
            < source.indexOf('New-NativeEvidenceBinding'),
        'old passed evidence must be removed before binding preflight',
    );
    assert.match(source, /New-NativeEvidenceBinding/);
    assert.match(source, /Complete-NativeEvidenceBinding/);
    assert.match(source, /Add-NativeEvidenceBindingToReport/);
    assert.match(source, /Restore-NativeEvidenceEnvironment/);
    assert.match(source, /native-cdp-viewport-guard\.cjs/);
});

test('uses the exact C6 project/FQBN/port and starts from the normal-upload UI action', () => {
    assert.match(source, /\[string\]\$Port = 'COM12'/);
    assert.match(source, /\[string\]\$ProjectName = 'c6_regression'/);
    assert.match(source, /esp32:esp32:esp32c6:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB/);
    assert.match(embeddedNode, /Refusing to test the wrong open project/);
    assert.match(embeddedNode, /waitForExactBoard/);
    assert.match(embeddedNode, /selectPort/);
    assert.match(embeddedNode, /clickBuildAction\('build-normal-upload-action'\)/);
    assert.match(embeddedNode, /clear_board_compile_cache/);
});

test('read-only progress DOM and cancellation log prove the run-scoped upload/cancel chain', () => {
    assert.match(embeddedNode, /readBuildEvidence/);
    assert.match(embeddedNode, /waitForExactBuildEvidence\('upload', beforeIdentity\)/);
    assert.match(embeddedNode, /waitForExactBuildEvidence\('compile', beforeIdentity, uploadCall\.runId\)/);
    assert.match(embeddedNode, /data-ck-role=\"compile-progress-overlay\"/);
    assert.match(embeddedNode, /data-ck-build-evidence-schema/);
    assert.match(embeddedNode, /data-ck-build-run-id/);
    assert.match(embeddedNode, /data-ck-build-kind/);
    assert.match(embeddedNode, /data-ck-build-fqbn/);
    assert.match(embeddedNode, /data-ck-build-port/);
    assert.match(embeddedNode, /data-ck-build-workspace-fingerprint/);
    assert.match(embeddedNode, /data-ck-role=\"build-cancel-action\"/);
    assert.match(embeddedNode, /getAttribute\('aria-label'\)/);
    assert.doesNotMatch(embeddedNode, /querySelectorAll\('button'\)[\s\S]{0,160}title === '\\u53d6\\u6d88/);
    assert.match(embeddedNode, /parseBackendCancellation\(log, uploadCall\.runId\)/);
    assert.match(embeddedNode, /cancellationEvidence\.runId !== uploadCall\.runId/);
    assert.match(embeddedNode, /terminated and waited/i);
    assert.match(embeddedNode, /parsed\.terminatedProcessTreeCount >= 1/);
    assert.match(embeddedNode, /matching-backend-cancellation-log-and-frontend-overlay-cleanup/);
    assert.doesNotMatch(embeddedNode, /__ckSafeCancelProbe/);
    assert.doesNotMatch(embeddedNode, /__TAURI_INTERNALS__\.invoke\s*=/);
    assert.doesNotMatch(embeddedNode, /installInvokeProbe|readInvokeProbe|restoreInvokeProbe/);
    assert.ok(
        embeddedNode.indexOf('const cancellationEvidence = await waitFor')
            < embeddedNode.indexOf('const recoveryStartedAt = new Date().toISOString()'),
        'the matching cancellation log must be captured before recovery compile can replace it',
    );
});

test('backend cancellation parser requires the exact UUID and waited process-tree count', () => {
    const uploadRunId = '550e8400-e29b-41d4-a716-446655440000';
    const anotherRunId = '550e8400-e29b-41d4-a716-446655440001';
    const log = [
        `[INFO] build run ${anotherRunId} cancelled; 2 active process tree(s) terminated and waited`,
        `[INFO] build run ${uploadRunId} cancelled; 1 active process tree(s) terminated and waited`,
    ].join('\n');
    assert.deepEqual(parseBackendCancellation(log, uploadRunId), {
        runId: uploadRunId,
        terminatedProcessTreeCount: 1,
    });
    assert.equal(parseBackendCancellation(log, '550e8400-e29b-41d4-a716-446655440002'), null);
    assert.equal(
        parseBackendCancellation(`build run ${uploadRunId} cancelled without waiting`, uploadRunId),
        null,
    );
});

test('process classifier distinguishes real compiler, packaging, and Flash transport', () => {
    const fixture = `
$rootPath = 'C:\\CK'
$expectedPort = 'COM12'
${classifierFunctions[1]}
$rows = @(
  [pscustomobject]@{ ProcessId=1; ParentProcessId=0; Name='arduino-cli.exe'; CommandLine='arduino-cli compile --fqbn esp32:esp32:esp32c6'; ExecutablePath='C:\\CK\\arduino-cli.exe' },
  [pscustomobject]@{ ProcessId=2; ParentProcessId=1; Name='riscv32-esp-elf-g++.exe'; CommandLine='riscv32-esp-elf-g++.exe -c sketch.cpp'; ExecutablePath='C:\\CK\\gcc.exe' },
  [pscustomobject]@{ ProcessId=3; ParentProcessId=1; Name='esptool.exe'; CommandLine='esptool.exe --chip esp32c6 elf2image sketch.elf'; ExecutablePath='C:\\CK\\esptool.exe' },
  [pscustomobject]@{ ProcessId=4; ParentProcessId=1; Name='esptool.exe'; CommandLine='esptool.exe --chip esp32c6 --port COM12 write_flash 0x0 boot.bin'; ExecutablePath='C:\\CK\\esptool.exe' },
  [pscustomobject]@{ ProcessId=5; ParentProcessId=1; Name='avrdude.exe'; CommandLine='avrdude.exe -patmega328p'; ExecutablePath='C:\\CK\\avrdude.exe' }
)
@($rows | ForEach-Object {
  [ordered]@{
    known = [bool](Test-SafeCancelKnownToolchainProcess -Item $_)
    compiler = [bool](Test-SafeCancelArduinoOrGccStage -Item $_)
    transport = [string](Get-SafeCancelFlashTransportReason -Item $_)
  }
}) | ConvertTo-Json -Compress
`;
    const directory = mkdtempSync(join(tmpdir(), 'ck-safe-cancel-classifier-'));
    const fixturePath = join(directory, 'fixture.ps1');
    try {
        writeFileSync(fixturePath, fixture, 'utf8');
        const result = spawnSync(
            'powershell.exe',
            ['-NoLogo', '-NoProfile', '-NonInteractive', '-ExecutionPolicy', 'Bypass', '-File', fixturePath],
            { encoding: 'utf8', windowsHide: true },
        );
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const rows = JSON.parse(result.stdout.trim());
        assert.deepEqual(rows.map((item) => item.known), [true, true, true, true, true]);
        assert.deepEqual(rows.map((item) => item.compiler), [true, true, false, false, false]);
        assert.equal(rows[2].transport, '', 'elf2image packaging is not Flash transport');
        assert.match(rows[3].transport, /^esptool-/);
        assert.equal(rows[4].transport, 'avrdude-transport');
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});

test('requires three consecutive clean tool-tree and global-orphan samples twice', () => {
    assert.match(embeddedNode, /waitForProcessQuiescence\(monitor, 3, 60000, 'after-cancel'\)/);
    assert.match(embeddedNode, /waitForProcessQuiescence\(monitor, 3, 60000, 'after-recovery'\)/);
    assert.match(embeddedNode, /toolTreeCount === 0 && sample\.globalOrphanCount === 0/);
    assert.match(classifierSource, /global-ck-related-orphan-candidate/);
    assert.match(classifierSource, /command_sha256/);
    assert.doesNotMatch(classifierSource, /raw_command_line\s*=/i);
    assert.match(embeddedNode, /monitor\.stageObservations\.length = 0/);
    assert.match(embeddedNode, /monitor\.flashTransports\.length = 0/);
});

test('recovery compile requires a reported lock wait no greater than five seconds', () => {
    assert.equal(parseCompileLockSeconds('[Timing] Compile lock wait: 4.9s'), 4.9);
    assert.equal(parseCompileLockSeconds('[Timing] Upload compile lock wait (release): 0.6s'), 0.6);
    assert.ok(Number.isNaN(parseCompileLockSeconds('compile success without timing')));
    assert.match(embeddedNode, /compileLockWaitSeconds > 5/);
    assert.match(embeddedNode, /\\u7f16\\u8bd1\\u6210\\u529f/);
});

test('backend always publishes compile lock telemetry, including a real zero wait', () => {
    for (const marker of [
        '[Timing] Compile lock wait: {:.1}s\\n',
        '[Timing] Upload compile lock wait ({}): {:.1}s\\n',
    ]) {
        const markerAt = backendSource.indexOf(marker);
        assert.ok(markerAt >= 0, `missing backend timing marker: ${marker}`);
        const prefix = backendSource.slice(Math.max(0, markerAt - 240), markerAt);
        assert.doesNotMatch(prefix, /if\s+\w*compile_lock_wait\.as_millis\(\)\s*>\s*0\s*\{/);
    }
});

test('machine checks reject mismatched identity, reused run IDs, transport, and lock delay', () => {
    const base = {
        runIds: {
            uploadSketch: '550e8400-e29b-41d4-a716-446655440000',
            cancelCommand: '550e8400-e29b-41d4-a716-446655440000',
            recoveryCompile: '550e8400-e29b-41d4-a716-446655440001',
        },
        operation: {
            startAction: 'build-normal-upload-action',
            buildEvidenceSchema: 1,
            buildKind: 'upload',
            workspaceFingerprint: 'fingerprint',
            stageObservation: { process: { arduino_or_gcc_stage: true } },
        },
        cancellation: { backendConfirmedWait: true, terminatedProcessTreeCount: 1 },
        flashTransport: { observed: false },
        quiescence: {
            afterCancel: { observedConsecutiveCleanPolls: 3 },
            afterRecovery: { observedConsecutiveCleanPolls: 3 },
        },
        recoveryCompile: {
            success: true,
            buildEvidenceSchema: 1,
            buildKind: 'compile',
            workspaceFingerprint: 'fingerprint',
            compileLockWaitSeconds: 0.6,
        },
        identity: {
            before: { fqbn: 'fqbn', port: 'COM12', sourceFingerprint: 'fingerprint' },
            after: { fqbn: 'fqbn', port: 'COM12', sourceFingerprint: 'fingerprint' },
        },
    };
    assert.ok(makeChecks(base).every((item) => item.passed));
    for (const mutate of [
        (facts) => { facts.operation.buildEvidenceSchema = 0; },
        (facts) => { facts.recoveryCompile.buildKind = 'upload'; },
        (facts) => { facts.runIds.cancelCommand = facts.runIds.recoveryCompile; },
        (facts) => { facts.runIds.recoveryCompile = facts.runIds.uploadSketch; },
        (facts) => { facts.flashTransport.observed = true; },
        (facts) => { facts.recoveryCompile.compileLockWaitSeconds = 5.01; },
        (facts) => { facts.recoveryCompile.workspaceFingerprint = 'other'; },
        (facts) => { facts.identity.after.port = 'COM13'; },
    ]) {
        const facts = structuredClone(base);
        mutate(facts);
        assert.ok(makeChecks(facts).some((item) => !item.passed));
    }
});

test('scrubs full MACs, workspace paths, user paths, and external Windows paths', () => {
    const previousRoot = process.env.CK_SAFE_CANCEL_ROOT;
    process.env.CK_SAFE_CANCEL_ROOT = 'C:\\Users\\builder\\CK';
    try {
        const safe = sanitizeEvidenceValue({
            root: 'C:\\Users\\builder\\CK\\target',
            mac: 'AA:BB:CC:DD:EE:FF',
            external: 'D:\\lab\\private.bin',
        });
        assert.match(safe.root, /^<CK_ROOT>/);
        assert.equal(safe.mac, '[REDACTED_MAC]');
        assert.equal(safe.external, '[REDACTED_ABSOLUTE_PATH]');
    } finally {
        if (previousRoot === undefined) delete process.env.CK_SAFE_CANCEL_ROOT;
        else process.env.CK_SAFE_CANCEL_ROOT = previousRoot;
    }
});

test('writes one bounded atomic report and never records raw logs or command lines', () => {
    assert.match(embeddedNode, /writeJsonAtomic\(process\.env\.CK_SAFE_CANCEL_OUTPUT/);
    assert.match(embeddedNode, /observations: monitor\.flashTransports\.slice\(0, 16\)/);
    assert.match(embeddedNode, /state\.snapshots\.length >= 256/);
    assert.match(embeddedNode, /rawCommandLinesRecorded: false/);
    assert.match(embeddedNode, /rawCompileLogRecorded: false/);
    assert.doesNotMatch(embeddedNode, /compileLog:\s*recoveryLog/);
});
