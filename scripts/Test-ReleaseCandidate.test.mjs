import assert from 'node:assert/strict';
import test from 'node:test';
import { spawnSync } from 'node:child_process';
import { mkdir, mkdtemp, readFile, readdir, rm, writeFile } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join } from 'node:path';

const releaseScriptUrl = new URL('./Test-ReleaseCandidate.ps1', import.meta.url);
const releaseScriptPath = releaseScriptUrl.pathname.replace(/^\/(.:)/, '$1');
const source = await readFile(releaseScriptUrl, 'utf8');
const bundleModulePath = new URL('./ReleaseBundleGate.psm1', import.meta.url);
const bundleModuleSource = await readFile(bundleModulePath, 'utf8');

test('release candidate gate checks all five desktop version sources', () => {
    assert.match(source, /apps\\desktop\\package\.json/);
    assert.match(source, /apps\\desktop\\package-lock\.json/);
    assert.match(source, /apps\\desktop\\src-tauri\\tauri\.conf\.json/);
    assert.match(source, /apps\\desktop\\src-tauri\\Cargo\.toml/);
    assert.match(source, /Cargo\.lock/);
    assert.match(source, /package_lock_root/);
    assert.match(source, /cargo_lock_appsdesktop/);
    assert.match(source, /version mismatch/);
});

test('release candidate gate covers frontend, Rust, scripts, examples and production assets', () => {
    for (const gate of [
        'source-tree-freeze-preflight',
        'desktop-frontend-tests',
        'release-and-package-script-tests',
        'ck-core-tests',
        'arduino-rust-tests',
        'desktop-rust-tests',
        'deterministic-example-packages',
        'extension-sdk',
        'desktop-production-build',
        'bundled-resource-contract',
        'desktop-installers',
        'source-tree-freeze-postflight',
    ]) {
        assert.match(source, new RegExp(gate));
    }
    assert.match(source, /cargo fmt --all -- --check/);
    assert.match(
        source,
        /node --test --test-concurrency=1 @scriptTests/,
        'process-heavy script suites must remain serial on Windows',
    );
    assert.match(source, /function Assert-LastProcessSucceeded/);
    assert.ok(
        (source.match(/Assert-LastProcessSucceeded/g) || []).length >= 9,
        'every external release process must fail closed on its own exit code',
    );
});

test('the existing deterministic example gate also produces fresh bounded compile-only compatibility evidence', () => {
    const examplesStart = source.indexOf("Invoke-ReleaseGate 'deterministic-example-packages'");
    const sdkStart = source.indexOf("Invoke-ReleaseGate 'extension-sdk'", examplesStart);
    assert.ok(examplesStart >= 0 && sdkStart > examplesStart);
    const examplesGate = source.slice(examplesStart, sdkStart);
    assert.match(examplesGate, /Test-CoreCompatibility\.ps1/);
    assert.match(examplesGate, /-GeneratorOnly/);
    assert.match(examplesGate, /artifacts\/release\/core-compatibility-results\.json/);
    assert.match(examplesGate, /artifacts\/release\/builtin-block-generator-audit\.json/);
    assert.match(examplesGate, /tmp\/release-builtin-block-compatibility/);
    assert.match(examplesGate, /Get-ValidatedCompatibilityReportEvidence/);

    assert.match(source, /schema -cne 'ck-builtin-block-generator-audit'/);
    assert.match(source, /counts\.toolboxTypes -ne 147/);
    assert.match(source, /counts\.targetRuns -ne 294/);
    assert.match(source, /counts\.passed -ne 294/);
    assert.match(source, /counts\.failed -ne 0/);
    assert.match(source, /schema -cne 'ck-core-compatibility-results'/);
    assert.match(source, /blockEvidenceCounts\.blocks -ne 147/);
    assert.match(source, /blockEvidenceCounts\.targetCells -ne 294/);
    assert.match(source, /blockEvidenceCounts\.staticGenerationPass -ne 294/);
    assert.match(source, /generatedResults\.Count -ne 7/);
    assert.match(source, /Evidence -cne 'compile-only'/);
    assert.match(source, /Source -cne 'built-in-generator'/);
    assert.match(source, /HardwareTested -ne \$false/);
    assert.match(source, /compatibility_reports = @\(\$script:compatibilityReports\)/);
    assert.match(source, /hardware_tested = \$false/);
    assert.match(source, /built-in compatibility report is older than the current release gate/);
});

test('compatibility evidence validator rejects hardware claims and stale reports', async (t) => {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const validatorStart = source.indexOf('function Test-JsonProperty');
    const validatorEnd = source.indexOf('\nPush-Location $Root', validatorStart);
    assert.ok(validatorStart >= 0 && validatorEnd > validatorStart);
    const validatorSource = source.slice(validatorStart, validatorEnd);
    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ck-release-compatibility-evidence-'));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const reportRoot = join(fixtureRoot, 'artifacts', 'release');
    await mkdir(reportRoot, { recursive: true });
    const auditPath = join(reportRoot, 'builtin-block-generator-audit.json');
    const compatibilityPath = join(reportRoot, 'core-compatibility-results.json');
    await writeFile(auditPath, JSON.stringify({
        schema: 'ck-builtin-block-generator-audit',
        version: 1,
        hardwareTested: false,
        counts: { toolboxTypes: 147, targetRuns: 294, passed: 294, failed: 0 },
    }));
    await writeFile(compatibilityPath, JSON.stringify({
        schema: 'ck-core-compatibility-results',
        version: 1,
        hardwareTested: false,
        generatorOnly: true,
        blockEvidenceCounts: { blocks: 147, targetCells: 294, staticGenerationPass: 294 },
        results: Array.from({ length: 7 }, (_, index) => ({
            TargetId: index % 2 ? 'esp32-c6' : 'avr-nano',
            Passed: true,
            Evidence: 'compile-only',
            Source: 'built-in-generator',
            HardwareTested: false,
        })),
    }));

    const quote = (value) => value.replaceAll("'", "''");
    const fixtureScript = join(fixtureRoot, 'fixture.ps1');
    await writeFile(fixtureScript, `
$ErrorActionPreference = 'Stop'
$Root = '${quote(fixtureRoot)}'
Import-Module '${quote(bundleModulePath.pathname.replace(/^\/(.:)/, '$1'))}' -Force
${validatorSource}
$auditPath = '${quote(auditPath)}'
$compatibilityPath = '${quote(compatibilityPath)}'
$notBefore = [DateTimeOffset]::UtcNow.AddMinutes(-1)
$good = @(Get-ValidatedCompatibilityReportEvidence -AuditPath $auditPath -ReportPath $compatibilityPath -NotBeforeUtc $notBefore)
$originalCompatibility = Get-Content -LiteralPath $compatibilityPath -Raw -Encoding UTF8
$bad = $originalCompatibility | ConvertFrom-Json
$bad.results[0].HardwareTested = $true
$bad | ConvertTo-Json -Depth 8 | Set-Content -LiteralPath $compatibilityPath -Encoding UTF8
$hardwareClaimRejected = $false
try {
    Get-ValidatedCompatibilityReportEvidence -AuditPath $auditPath -ReportPath $compatibilityPath -NotBeforeUtc $notBefore | Out-Null
} catch {
    $hardwareClaimRejected = ([string]$_ -match 'hardwareTested=false')
}
$originalCompatibility | Set-Content -LiteralPath $compatibilityPath -Encoding UTF8
[System.IO.File]::SetLastWriteTimeUtc($auditPath, [DateTime]::UtcNow.AddHours(-2))
$staleRejected = $false
try {
    Get-ValidatedCompatibilityReportEvidence -AuditPath $auditPath -ReportPath $compatibilityPath -NotBeforeUtc $notBefore | Out-Null
} catch {
    $staleRejected = ([string]$_ -match 'older than the current release gate')
}
[ordered]@{
    count = $good.Count
    roles = @($good | ForEach-Object { $_.role })
    hardware_tested = @($good | ForEach-Object { $_.hardware_tested })
    audit_target_runs = $good[0].counts.target_runs
    generated_results = $good[1].counts.generated_results
    hardware_claim_rejected = $hardwareClaimRejected
    stale_rejected = $staleRejected
} | ConvertTo-Json -Compress
`, 'utf8');

    const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript], {
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(result, {
        count: 2,
        roles: ['builtin-block-generator-audit', 'core-compatibility-results'],
        hardware_tested: [false, false],
        audit_target_runs: 294,
        generated_results: 7,
        hardware_claim_rejected: true,
        stale_rejected: true,
    });
});

test('release candidate PowerShell parses after compatibility evidence integration', async (t) => {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const parseCommand = `$tokens = $null; $errors = $null; [System.Management.Automation.Language.Parser]::ParseFile('${releaseScriptPath.replaceAll("'", "''")}', [ref]$tokens, [ref]$errors) | Out-Null; if ($errors.Count -gt 0) { $errors | ForEach-Object { Write-Error $_.Message }; exit 1 }`;
    const run = spawnSync(shell, ['-NoProfile', '-Command', parseCommand], { encoding: 'utf8' });
    if (run.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
});

test('a new release run invalidates any previous gate report before executing gates', () => {
    const invalidation = source.indexOf('Remove-Item -LiteralPath $OutputPath -Force');
    const firstGate = source.indexOf("Invoke-ReleaseGate 'source-tree-freeze-preflight'");
    assert.ok(invalidation >= 0, 'the previous output must be removed');
    assert.ok(firstGate > invalidation, 'the previous output must be removed before the first gate');
    assert.match(source, /final report is published atomically/);
});

test('passed and failed release reports are atomically written as UTF-8 without BOM and parse in Node', async (t) => {
    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const writerStart = source.indexOf('function Write-Utf8NoBomAtomic');
    const writerEnd = source.indexOf('\nfunction Get-VerifiedSourceTreeFreeze', writerStart);
    assert.ok(writerStart >= 0 && writerEnd > writerStart, 'UTF-8 atomic writer must be extractable');
    const writerSource = source.slice(writerStart, writerEnd);
    assert.match(writerSource, /UTF8Encoding\]::new\(\$false\)/);
    assert.match(writerSource, /\[System\.IO\.File\]::(?:Replace|Move)/);
    const finalReportWriter = source.slice(source.indexOf('\nfinally {'));
    assert.match(finalReportWriter, /Write-Utf8NoBomAtomic -Path \$OutputPath -Content \$reportJson/);
    assert.doesNotMatch(finalReportWriter, /Set-Content[^\n]*-Encoding\s+utf8/i);

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ck-release-report-encoding-'));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const passedPath = join(fixtureRoot, 'passed.json');
    const failedPath = join(fixtureRoot, 'failed.json');
    // Seed one destination to cover File.Replace; leave the other absent to
    // cover the first-publication File.Move path used by a normal gate run.
    await writeFile(passedPath, '{"stale":true}\n', 'utf8');

    const quote = (value) => value.replaceAll("'", "''");
    const fixtureScript = join(fixtureRoot, 'fixture.ps1');
    await writeFile(fixtureScript, `
$ErrorActionPreference = 'Stop'
${writerSource}
$passed = ([ordered]@{ schema_version = 2; status = 'passed'; gates = @() } | ConvertTo-Json -Depth 8) + "\`n"
$failed = ([ordered]@{ schema_version = 2; status = 'failed'; gates = @([ordered]@{ name = 'fixture'; status = 'failed' }) } | ConvertTo-Json -Depth 8) + "\`n"
Write-Utf8NoBomAtomic -Path '${quote(passedPath)}' -Content $passed
Write-Utf8NoBomAtomic -Path '${quote(failedPath)}' -Content $failed
`, 'utf8');

    const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript], {
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);

    for (const [reportPath, expectedStatus] of [
        [passedPath, 'passed'],
        [failedPath, 'failed'],
    ]) {
        const bytes = await readFile(reportPath);
        assert.notDeepEqual(
            [...bytes.subarray(0, 3)],
            [0xef, 0xbb, 0xbf],
            `${expectedStatus} report must not start with a UTF-8 BOM`,
        );
        const parsed = JSON.parse(bytes.toString('utf8'));
        assert.equal(parsed.schema_version, 2);
        assert.equal(parsed.status, expectedStatus);
    }
    const residue = (await readdir(fixtureRoot)).filter(
        (name) => name.endsWith('.tmp') || name.endsWith('.replace-backup'),
    );
    assert.deepEqual(residue, [], 'atomic publication must not leave staging or replacement files');
});

test('release report remains honest about native and physical-board evidence', () => {
    assert.match(source, /Native desktop interaction and physical-board evidence are recorded separately/);
    assert.match(source, /example_packages/);
    assert.match(source, /desktop_bundles/);
    assert.match(source, /source_tree = \[ordered\]@\{/);
    assert.match(source, /verified_before_gate/);
    assert.match(source, /verified_after_gate/);
    assert.match(source, /manifest_sha256/);
    assert.match(source, /tree_sha256/);
    assert.match(source, /commit = \$null/);
    assert.match(source, /release_assets/);
    assert.match(source, /role = 'portable-executable'/);
    assert.match(source, /production executable is older than the current desktop bundle build/);
    assert.match(source, /CK-Extension-SDK-\$ExpectedVersion\.zip/);
    assert.match(source, /extension SDK ZIP is older than the current release gate/);
    assert.match(source, /generated_at = \(\[DateTimeOffset\]\$sdkItem\.LastWriteTimeUtc\)/);
    assert.match(source, /Get-FileHash/);
    assert.match(source, /status = if \(\$failed -gt 0\).*'partial'/s);
    assert.match(source, /automated_release_gates = \$coverage/);
    assert.match(source, /desktop_bundle_gate/);
    assert.match(source, /status = 'skipped'/);
    assert.match(source, /must not be presented as a complete release pass/);
});

test('release gate requires one unchanged no-Git source identity before and after the build', () => {
    assert.match(source, /New-SourceTreeManifest\.ps1/);
    assert.match(source, /-Mode Verify/);
    assert.match(source, /source tree manifest is missing; freeze source before running the release gate/);
    assert.match(source, /source tree freeze record is missing; freeze source before running the release gate/);
    assert.match(source, /source tree identity changed during the release gate/);
    assert.match(source, /no-Git source-tree manifest is verified before and after all build gates/);
    assert.match(source, /\$verificationOutput\s*=\s*@\(& powershell/);
    assert.match(source, /\$verificationExitCode\s*=\s*\$LASTEXITCODE/);
    assert.match(source, /source tree freeze verification exited with code/);
    assert.doesNotMatch(source, /commit\s*=\s*['"][0-9a-f]{7,40}['"]/i);
});

test('release report paths remain compatible with Windows PowerShell 5.1', () => {
    assert.doesNotMatch(
        source,
        /\[System\.IO\.Path\]::GetRelativePath/,
        'Windows PowerShell 5.1 runs on .NET Framework, which has no Path.GetRelativePath',
    );
    assert.match(
        source,
        /path = Get-RelativeEvidencePath -BasePath \$Root -Path \$sdkItem\.FullName/,
        'SDK release evidence must use the boundary-safe shared compatibility helper',
    );
});

test('desktop bundle gate isolates old outputs and accepts only fresh expected-version installers', async (t) => {
    assert.match(source, /Move-PreexistingReleaseBundleRoot/);
    assert.match(source, /Get-FreshReleaseBundleEvidence/);
    assert.match(source, /evidence\.Count -eq 0/);
    assert.match(bundleModuleSource, /filename or installer metadata/);
    assert.match(bundleModuleSource, /Get-FileHash/);
    assert.match(source, /Assert-BundledResourceContract -Root \$Root/);
    assert.match(source, /Assert-ReleaseInstallerResourceLayout -Root \$Root -BundleRoot \$bundleRoot/);

    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ck-release-bundle-gate-'));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const fixtureScript = join(fixtureRoot, 'fixture.ps1');
    const quote = (value) => value.replaceAll("'", "''");
    await writeFile(
        fixtureScript,
        `
$ErrorActionPreference = 'Stop'
Import-Module '${quote(bundleModulePath.pathname.replace(/^\/(.:)/, '$1'))}' -Force
$fixture = '${quote(fixtureRoot)}'
$bundle = Join-Path $fixture 'target\\release\\bundle'
$oldDir = Join-Path $bundle 'nsis'
New-Item -ItemType Directory -Force -Path $oldDir | Out-Null
Set-Content -LiteralPath (Join-Path $oldDir 'CK_0.1.0_x64-setup.exe') -Value 'old'
$quarantine = Move-PreexistingReleaseBundleRoot -BundleRoot $bundle -QuarantineRoot (Join-Path $fixture 'quarantine') -RunId 'fixture'
if (Test-Path -LiteralPath $bundle) { throw 'old bundle root was not isolated' }
if (-not (Test-Path -LiteralPath $quarantine.inventory_manifest)) { throw 'quarantine inventory was not recorded' }

$newDir = Join-Path $bundle 'nsis'
New-Item -ItemType Directory -Force -Path $newDir | Out-Null
$started = [DateTimeOffset]::UtcNow.AddSeconds(-1)
$goodPath = Join-Path $newDir 'CK_1.0.0_x64-setup.exe'
Set-Content -LiteralPath $goodPath -Value 'new'
[System.IO.File]::SetLastWriteTimeUtc($goodPath, [DateTime]::UtcNow)
$accepted = @(Get-FreshReleaseBundleEvidence -BundleRoot $bundle -ExpectedVersion '1.0.0' -NotBeforeUtc $started -ReportRoot $fixture)

$badPath = Join-Path $newDir 'CK_0.1.0_x64-setup.exe'
Set-Content -LiteralPath $badPath -Value 'wrong-version'
[System.IO.File]::SetLastWriteTimeUtc($badPath, [DateTime]::UtcNow)
$mismatchRejected = $false
try {
    Get-FreshReleaseBundleEvidence -BundleRoot $bundle -ExpectedVersion '1.0.0' -NotBeforeUtc $started -ReportRoot $fixture | Out-Null
} catch {
    $mismatchRejected = ([string]$_ -match 'does not identify expected version')
}
Remove-Item -LiteralPath $badPath

[System.IO.File]::SetLastWriteTimeUtc($goodPath, [DateTime]::UtcNow.AddMinutes(-10))
$staleRejected = $false
try {
    Get-FreshReleaseBundleEvidence -BundleRoot $bundle -ExpectedVersion '1.0.0' -NotBeforeUtc $started -ReportRoot $fixture | Out-Null
} catch {
    $staleRejected = ([string]$_ -match 'not fresh')
}

$sdkRoot = Join-Path $fixture 'sdk-root'
$sdkAsset = Join-Path $sdkRoot 'artifacts\\release\\CK-Extension-SDK-1.0.0.zip'
New-Item -ItemType Directory -Force -Path (Split-Path -Parent $sdkAsset) | Out-Null
Set-Content -LiteralPath $sdkAsset -Value 'sdk'
$sdkRelative = Get-RelativeEvidencePath -BasePath $sdkRoot -Path $sdkAsset
$prefixCollision = Join-Path $fixture 'sdk-root-sibling\\asset.zip'
$prefixCollisionEvidence = Get-RelativeEvidencePath -BasePath $sdkRoot -Path $prefixCollision

[ordered]@{
    quarantined = $quarantine.quarantined
    quarantined_installers = $quarantine.installer_count
    accepted_count = $accepted.Count
    accepted_path = $accepted[0].path
    accepted_version = $accepted[0].version
    mismatch_rejected = $mismatchRejected
    stale_rejected = $staleRejected
    sdk_relative = $sdkRelative
    prefix_collision_not_relativized = ($prefixCollisionEvidence -eq $prefixCollision.Replace('\\', '/'))
} | ConvertTo-Json -Compress
`,
        'utf8',
    );

    const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript], {
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const outputLine = run.stdout.trim().split(/\r?\n/).at(-1);
    const result = JSON.parse(outputLine);
    assert.deepEqual(result, {
        quarantined: true,
        quarantined_installers: 1,
        accepted_count: 1,
        accepted_path: 'target/release/bundle/nsis/CK_1.0.0_x64-setup.exe',
        accepted_version: '1.0.0',
        mismatch_rejected: true,
        stale_rejected: true,
        sdk_relative: 'artifacts/release/CK-Extension-SDK-1.0.0.zip',
        prefix_collision_not_relativized: true,
    });
    assert.doesNotMatch(result.accepted_path, /0\.1\.0/);
});

test('bundled resource contract rejects legacy or inconsistent license layouts', async (t) => {
    assert.match(bundleModuleSource, /bin\/GPL-3\.0\.txt/);
    assert.match(bundleModuleSource, /licenses\/GPL-3\.0\.txt/);
    assert.match(bundleModuleSource, /legacy licenses\/LICENSE\.txt/);
    assert.match(bundleModuleSource, /Get-MsiInstalledPaths/);

    const shell = process.platform === 'win32' ? 'powershell' : 'pwsh';
    const probe = spawnSync(shell, ['-NoProfile', '-Command', '$PSVersionTable.PSVersion.ToString()'], {
        encoding: 'utf8',
    });
    if (probe.error?.code === 'ENOENT') {
        t.skip(`${shell} is unavailable`);
        return;
    }
    assert.equal(probe.status, 0, probe.stderr);

    const fixtureRoot = await mkdtemp(join(tmpdir(), 'ck-bundled-resources-'));
    t.after(async () => rm(fixtureRoot, { recursive: true, force: true }));
    const tauriRoot = join(fixtureRoot, 'apps', 'desktop', 'src-tauri');
    await mkdir(join(tauriRoot, 'bin'), { recursive: true });
    await mkdir(join(fixtureRoot, 'tools'), { recursive: true });
    await writeFile(join(tauriRoot, 'bin', 'arduino-cli.exe'), 'cli');
    await writeFile(join(tauriRoot, 'bin', 'GPL-3.0.txt'), 'gpl');
    await writeFile(join(fixtureRoot, 'tools', 'ccache.exe'), 'ccache');
    await writeFile(
        join(tauriRoot, 'THIRD_PARTY_NOTICES.md'),
        'Arduino CLI 1.4.1\nccache 4.10.2\nlicenses/GPL-3.0.txt\n',
    );
    await writeFile(
        join(tauriRoot, 'tauri.conf.json'),
        JSON.stringify({
            bundle: {
                resources: {
                    'bin/arduino-cli.exe': 'bin/arduino-cli.exe',
                    'bin/GPL-3.0.txt': 'licenses/GPL-3.0.txt',
                    '../../../tools/ccache.exe': 'bin/ccache.exe',
                    'THIRD_PARTY_NOTICES.md': 'THIRD_PARTY_NOTICES.md',
                },
            },
        }),
    );

    const fixtureScript = join(fixtureRoot, 'fixture.ps1');
    const quote = (value) => value.replaceAll("'", "''");
    await writeFile(
        fixtureScript,
        `
$ErrorActionPreference = 'Stop'
Import-Module '${quote(bundleModulePath.pathname.replace(/^\/(.:)/, '$1'))}' -Force
$root = '${quote(fixtureRoot)}'
Assert-BundledResourceContract -Root $root
Assert-ExpectedInstalledResourcePaths -Context 'valid fixture' -ActualPaths @(
    'bin/arduino-cli.exe',
    'bin/ccache.exe',
    'licenses/GPL-3.0.txt',
    'THIRD_PARTY_NOTICES.md'
)

$layoutRejected = $false
try {
    Assert-ExpectedInstalledResourcePaths -Context 'legacy fixture' -ActualPaths @(
        'bin/arduino-cli.exe',
        'bin/ccache.exe',
        'licenses/LICENSE.txt',
        'THIRD_PARTY_NOTICES.md'
    )
} catch {
    $layoutRejected = ([string]$_ -match 'legacy licenses/LICENSE.txt')
}

$tauri = Join-Path $root 'apps\\desktop\\src-tauri'
Move-Item -LiteralPath (Join-Path $tauri 'bin\\GPL-3.0.txt') -Destination (Join-Path $tauri 'bin\\LICENSE.txt')
$configPath = Join-Path $tauri 'tauri.conf.json'
$configText = (Get-Content -LiteralPath $configPath -Raw).Replace('bin/GPL-3.0.txt', 'bin/LICENSE.txt')
Set-Content -LiteralPath $configPath -Value $configText
$sourceRejected = $false
try {
    Assert-BundledResourceContract -Root $root
} catch {
    $sourceRejected = ([string]$_ -match 'legacy bundled license source')
}

[ordered]@{
    layout_rejected = $layoutRejected
    source_rejected = $sourceRejected
} | ConvertTo-Json -Compress
`,
        'utf8',
    );

    const run = spawnSync(shell, ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File', fixtureScript], {
        encoding: 'utf8',
    });
    assert.equal(run.status, 0, `${run.stderr}\n${run.stdout}`);
    const result = JSON.parse(run.stdout.trim().split(/\r?\n/).at(-1));
    assert.deepEqual(result, { layout_rejected: true, source_rejected: true });
});
