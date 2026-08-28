import assert from 'node:assert/strict';
import { mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from 'node:fs';
import { readFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const modulePath = path.resolve(new URL('./NativeEvidenceBinding.psm1', import.meta.url).pathname.slice(1));
const repoRoot = path.dirname(path.dirname(modulePath));
const moduleSource = await readFile(new URL('./NativeEvidenceBinding.psm1', import.meta.url), 'utf8');
const boundScripts = [
    'Benchmark-CompileUploadNative.ps1',
    'Test-DeviceHealthNative.ps1',
    'Test-UploadManifestGateNative.ps1',
    'Test-NativeEditor.ps1',
];

test('PowerShell 5.1 parses the shared module and all required bound runners', () => {
    const files = [modulePath, ...boundScripts.map((name) => path.join(repoRoot, 'scripts', name))];
    const command = [
        "$ErrorActionPreference='Stop'",
        ...files.map((file) => {
            const escaped = file.replaceAll("'", "''");
            return `$tokens=$null;$errors=$null;[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors)|Out-Null;if($errors.Count){throw ($errors|Out-String)}`;
        }),
        `Import-Module '${modulePath.replaceAll("'", "''")}' -Force`,
        "if(-not (Get-Command New-NativeEvidenceBinding -ErrorAction SilentlyContinue)){throw 'module export missing'}",
    ].join(';');
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('binding is fail-closed across no-Git freeze, passed gate, process, listener, and CDP identity', () => {
    assert.match(moduleSource, /Test-Path -LiteralPath \(Join-Path \$Root '\.git'\)/);
    assert.match(moduleSource, /source_control\.kind -cne 'none'/);
    assert.match(moduleSource, /New-SourceTreeManifest\.ps1/);
    assert.match(moduleSource, /status -cne 'passed'/);
    assert.match(moduleSource, /manifest_sha256', 'tree_sha256', 'frozen_at'/);
    assert.match(moduleSource, /Expected exactly one running CK process/);
    assert.match(moduleSource, /ParentProcessId =/);
    assert.match(moduleSource, /--remote-debugging-port/);
    assert.match(moduleSource, /Get-DebugPortOwnerIds/);
    assert.match(moduleSource, /listener_owning_process_id/);
    assert.match(moduleSource, /Expected exactly one main CK CDP page/);
    assert.match(moduleSource, /console=detached/);
    assert.match(moduleSource, /\$productionUrl = 'http:\/\/tauri\.localhost\/'/);
    assert.match(moduleSource, /\[string\]\$target\.url -cne \$productionUrl/);
    assert.match(moduleSource, /Source evidence changed during the native run/);
    assert.match(moduleSource, /Executable binding changed during the native run/);
    assert.match(moduleSource, /CDP binding changed during the native run/);
    assert.match(moduleSource, /Release gate binding changed during the native run/);
});

test('native release evidence accepts only the exact production Tauri URL', () => {
    const command = `
$ErrorActionPreference = 'Stop'
Import-Module '${modulePath.replaceAll("'", "''")}' -Force
$module = Get-Module NativeEvidenceBinding
function Test-Url([string]$url, [bool]$shouldPass) {
  try {
    & $module { param([string]$candidateUrl)
      function Invoke-RestMethod {
        [pscustomobject]@{
          type = 'page'
          id = 'target-1'
          url = $candidateUrl
          webSocketDebuggerUrl = 'ws://127.0.0.1:9223/devtools/page/target-1'
        }
      }
      Get-NativeCdpTarget -DebugPort 9223
    } $url | Out-Null
    if (-not $shouldPass) { throw "unexpected acceptance: $url" }
  }
  catch {
    if ($shouldPass) { throw }
    if ($_.Exception.Message -notmatch 'exact CK production Tauri URL') { throw }
  }
}
Test-Url 'http://tauri.localhost/' $true
Test-Url 'http://localhost:1420/' $false
Test-Url 'http://127.0.0.1:1420/' $false
Test-Url 'chrome-error://chromewebdata/' $false
Test-Url 'http://tauri.localhost/?dev=true' $false
Test-Url 'HTTP://tauri.localhost/' $false
`;
    const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command], {
        encoding: 'utf8',
    });
    assert.equal(result.status, 0, result.stderr || result.stdout);
});

test('bound runners restore process environment, clear stale reports, and attach the shared contract', async () => {
    for (const name of boundScripts) {
        const source = await readFile(new URL(`./${name}`, import.meta.url), 'utf8');
        assert.match(source, /Import-Module \(Join-Path \$PSScriptRoot 'NativeEvidenceBinding\.psm1'\)/, name);
        assert.match(source, /New-NativeEvidenceBinding/, name);
        assert.match(source, /Complete-NativeEvidenceBinding/, name);
        assert.match(source, /Save-NativeEvidenceEnvironment/, name);
        assert.match(source, /finally\s*\{[\s\S]*Restore-NativeEvidenceEnvironment/, name);
        assert.match(source, /Initialize-NativeEvidenceReportPath/, name);
        assert.match(source, /Add-NativeEvidenceBindingToReport/, name);
        assert.ok(
            source.indexOf('Initialize-NativeEvidenceReportPath') < source.indexOf('New-NativeEvidenceBinding'),
            `${name} must remove stale evidence before binding preflight can fail`,
        );
    }
});

test('report attachment is atomic, private-path safe, MAC-safe, and keeps required top-level fields', () => {
    const directory = mkdtempSync(path.join(tmpdir(), 'ck-native-binding-test-'));
    const report = path.join(directory, 'report.json');
    const driver = path.join(directory, 'driver.ps1');
    try {
        writeFileSync(report, JSON.stringify({
            status: 'passed',
            buildDirectory: path.join(tmpdir(), 'CK_Builds', 'fixture', 'build'),
            sourcePath: path.join(repoRoot, 'apps', 'desktop', 'src', 'main.tsx'),
            forwardSourcePath: path.join(repoRoot, 'docs', 'README.md').replaceAll('\\', '/'),
            mac: 'AA:BB:CC:DD:EE:FF',
            failures: [],
            contamination: { observations: [] },
            oneItemArray: [{ id: 'kept-as-array' }],
        }));
        const escapedModule = modulePath.replaceAll("'", "''");
        const script = `
$ErrorActionPreference = 'Stop'
Import-Module '${escapedModule}' -Force
$snapshot = Save-NativeEvidenceEnvironment -Names @('CK_NATIVE_BINDING_TEST_VALUE')
$env:CK_NATIVE_BINDING_TEST_VALUE = 'changed'
Restore-NativeEvidenceEnvironment -Snapshot $snapshot
if ($null -ne $env:CK_NATIVE_BINDING_TEST_VALUE) { throw 'environment was not restored' }
$evidence = [ordered]@{
  source_tree = [ordered]@{ manifest_path='artifacts/release/source-tree-manifest.json'; manifest_sha256=('a' * 64); tree_sha256=('b' * 64); frozen_at='2026-01-01T00:00:00Z' }
  gate_run = [ordered]@{ run_id='run'; finished_at='2026-01-01T00:00:00Z'; report_path='artifacts/release/v1-release-gates.json'; report_sha256=('c' * 64) }
  executable = [ordered]@{ path='target/release/appsdesktop.exe'; bytes=123; sha256=('d' * 64) }
  cdp_binding = [ordered]@{ bound=$true; process_id=12; browser_process_id=13; executable_sha256=('d' * 64) }
  binding_verification = [ordered]@{ unchanged=$true }
}
Add-NativeEvidenceBindingToReport -Path $env:CK_TEST_REPORT -Evidence $evidence
`;
        writeFileSync(driver, script);
        const result = spawnSync('powershell.exe', ['-NoLogo', '-NoProfile', '-NonInteractive', '-File', driver], {
            encoding: 'utf8',
            env: { ...process.env, CK_TEST_REPORT: report, CK_NATIVE_BINDING_TEST_VALUE: undefined },
        });
        assert.equal(result.status, 0, result.stderr || result.stdout);
        const encoded = readFileSync(report, 'utf8');
        const parsed = JSON.parse(encoded);
        assert.equal(parsed.status, 'passed');
        assert.equal(parsed.source_tree.manifest_path, 'artifacts/release/source-tree-manifest.json');
        assert.equal(parsed.executable.path, 'target/release/appsdesktop.exe');
        assert.equal(parsed.cdp_binding.bound, true);
        assert.equal(parsed.gate_run.run_id, 'run');
        assert.match(parsed.buildDirectory, /^<CK_BUILDS>/);
        assert.match(parsed.sourcePath, /^<CK_ROOT>/);
        assert.match(parsed.forwardSourcePath, /^<CK_ROOT>/);
        assert.equal(parsed.mac, '[REDACTED_MAC]');
        assert.deepEqual(parsed.failures, []);
        assert.deepEqual(parsed.contamination.observations, []);
        assert.deepEqual(parsed.oneItemArray, [{ id: 'kept-as-array' }]);
        assert.doesNotMatch(encoded, /[A-Z]:[\\/]Users[\\/]/i);
        assert.doesNotMatch(encoded, /(?:[0-9a-f]{2}[:-]){5}[0-9a-f]{2}/i);
        assert.deepEqual(readdirSync(directory).filter((name) => name.endsWith('.tmp')), []);
    } finally {
        rmSync(directory, { recursive: true, force: true });
    }
});
