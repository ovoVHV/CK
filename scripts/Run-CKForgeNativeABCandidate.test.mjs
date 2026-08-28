import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'scripts', 'Run-CKForgeNativeABCandidate.ps1');
const SOURCE = fs.readFileSync(FILE, 'utf8');

test('generic Native A/B candidate wrapper has valid PowerShell syntax', () => {
  const escaped = FILE.replaceAll("'", "''");
  const command = [
    '$tokens=$null',
    '$errors=$null',
    `[System.Management.Automation.Language.Parser]::ParseFile('${escaped}',[ref]$tokens,[ref]$errors) | Out-Null`,
    "if($errors.Count -gt 0){$errors | ForEach-Object { [Console]::Error.WriteLine($_.Message) }; exit 1}",
  ].join('; ');
  const parsed = spawnSync('powershell.exe', [
    '-NoLogo', '-NoProfile', '-NonInteractive', '-Command', command,
  ], { cwd: ROOT, encoding: 'utf8', windowsHide: true });
  assert.equal(parsed.status, 0, parsed.stderr);
});

test('wrapper exposes generic no-clobber probe inputs and validates them before launch', () => {
  assert.match(SOURCE, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$Output/u);
  assert.match(SOURCE, /\[Parameter\(Mandatory = \$true\)\][\s\S]*\[string\]\$CandidateOutput/u);
  assert.match(SOURCE, /\[string\]\$ArtifactBundle = ''/u);
  assert.match(SOURCE, /\[string\]\$FailureLogDirectory = ''/u);
  assert.match(SOURCE, /\[string\]\$Fqbn = 'esp32:esp32:esp32c6'/u);
  assert.match(SOURCE, /\[ValidateRange\(5, 25\)\][\s\S]*\[int\]\$Trials = 5/u);
  assert.match(SOURCE, /\[ValidateSet\('compile', 'upload-ready'\)\]/u);
  assert.match(SOURCE, /\[ValidateSet\('portable-fast', 'quick-fast', 'shared-fast'\)\]/u);
  assert.match(SOURCE, /portable-fast or quick-fast/u);
  assert.match(SOURCE, /portable-fast profile is compile-only/u);
  assert.match(SOURCE, /ExpectedProductionExecutableSha256/u);
  assert.doesNotMatch(SOURCE, /Path\]::GetRelativePath/u,
    'Windows PowerShell 5.1 does not expose Path.GetRelativePath');
  const launchIndex = SOURCE.indexOf('Start-Process -FilePath $executable');
  for (const contract of [
    'Refusing to overwrite Native A/B evidence',
    'Output and CandidateOutput must be different',
    'Get-FileHash -LiteralPath $executable',
    'Get-PSDrive C',
  ]) {
    const index = SOURCE.indexOf(contract);
    assert.ok(index >= 0 && index < launchIndex, `${contract} must be enforced before launch`);
  }
});

test('wrapper requires an isolated app, CLI, and CDP endpoint before hidden launch', () => {
  assert.match(SOURCE, /Get-Process -Name appsdesktop, arduino-cli/u);
  assert.match(SOURCE, /Get-NetTCPConnection -LocalPort \$DebugPort -State Listen/u);
  assert.match(SOURCE, /msedgewebview2\.exe[\s\S]*--remote-debugging-port/u);
  assert.match(SOURCE, /Start-Process -FilePath \$executable[\s\S]*-WindowStyle Hidden -PassThru/u);
  assert.match(SOURCE, /pages\.Count -gt 1[\s\S]*More than one tauri\.localhost/u);
  assert.match(SOURCE, /pages\.Count -eq 1/u);
  assert.match(SOURCE, /http:\/\/tauri\.localhost\//u);
});

test('wrapper creates and restores one 32-byte qualification token and binds the owned PID', () => {
  assert.match(SOURCE, /New-Object byte\[\] 32/u);
  assert.match(SOURCE, /RandomNumberGenerator/u);
  const tokenSet = SOURCE.indexOf('$env:CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN = $qualificationToken');
  const launch = SOURCE.indexOf('Start-Process -FilePath $executable');
  assert.ok(tokenSet >= 0 && tokenSet < launch, 'token must be inherited by the production app');
  assert.match(SOURCE, /CK_PROCESS_ID = \[string\]\$app\.Id/u);
  assert.match(SOURCE, /\$saved = @\{[\s\S]*CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN[\s\S]*CK_PROCESS_ID/u);
  assert.match(SOURCE, /foreach \(\$name in \$saved\.Keys\)[\s\S]*SetEnvironmentVariable\(\$name, \$saved\[\$name\], 'Process'\)/u);
  assert.match(SOURCE, /\[Array\]::Clear\(\$tokenBytes/u);
});

test('wrapper fixes and verifies the reproducible compiler environment for both lanes', () => {
  assert.match(SOURCE, /\$reproducibilityPolicyId = 'source-date-epoch-utc-v1'/u);
  assert.match(SOURCE, /\$sourceDateEpoch = \[int64\]1704067200/u);
  assert.match(SOURCE, /\$timeZone = 'UTC'/u);
  const epochSet = SOURCE.indexOf('$env:SOURCE_DATE_EPOCH = $sourceDateEpoch');
  const zoneSet = SOURCE.indexOf('$env:TZ = $timeZone');
  const launch = SOURCE.indexOf('Start-Process -FilePath $executable');
  assert.ok(epochSet >= 0 && epochSet < launch, 'epoch must be inherited by the production app');
  assert.ok(zoneSet >= 0 && zoneSet < launch, 'timezone must be inherited by the production app');
  assert.match(SOURCE, /SOURCE_DATE_EPOCH = \$env:SOURCE_DATE_EPOCH/u);
  assert.match(SOURCE, /TZ = \$env:TZ/u);
  assert.match(SOURCE, /reproducibility\.policyId -cne \$reproducibilityPolicyId/u);
  assert.match(SOURCE, /candidate\.controls\.reproducibleBuildEnvironment\.passed -ne \$true/u);
});

test('runner receives the complete fixed portable-edit Fast probe contract', () => {
  for (const argument of [
    "'--execute'",
    "'--allow-cache-reset'",
    "'--sequence', 'portable-edit'",
    "'--fqbn', $Fqbn",
    "'--trials', [string]$Trials",
    "'--qualification-operation', $Operation",
    "'--qualification-profile', $Profile",
    "'--timeout-minutes', [string]$TimeoutMinutes",
    "'--min-free-gib', [string]$MinFreeGiB",
    "'--output', $outputPath",
    "'--candidate-output', $candidateOutputPath",
    "'--failure-log-dir', $failureLogDirectoryPath",
  ]) assert.ok(SOURCE.includes(argument), `missing runner argument contract: ${argument}`);
  assert.match(SOURCE, /--candidate-artifact-bundle[\s\S]*\$artifactBundlePath/u);
  assert.match(SOURCE, /& node @runnerArguments/u);
  assert.match(SOURCE, /GetFileNameWithoutExtension\(\$outputPath\)[\s\S]*'-failure-logs'/u);
});

test('exit 0 and 2 require valid bound outputs while every other runner exit is rejected', () => {
  assert.match(SOURCE, /\$runnerExit -notin @\(0, 2\)/u);
  assert.match(SOURCE, /measurementStatus -cne 'passed'/u);
  assert.match(SOURCE, /productionExecutable\.before\.executableSha256 -cne \$executableSha256/u);
  assert.match(SOURCE, /candidate\.schemaId -cne 'ck\.forge\.performance-ab-candidate'/u);
  assert.match(SOURCE, /candidate\.schemaVersion -ne 4/u);
  assert.match(SOURCE, /candidate\.operation -cne \$Operation/u);
  assert.match(SOURCE, /candidate\.candidateProfile -cne \$Profile/u);
  assert.match(SOURCE, /runnerExit -eq 0[\s\S]*qualificationStatus -cne 'qualified'/u);
  assert.match(SOURCE, /runnerExit -eq 2[\s\S]*qualificationStatus -cne 'not-qualified'/u);
  assert.match(SOURCE, /if \(\$terminalExit -eq 2\)[\s\S]*exit 2/u);
});

test('optional bundle is hash-checked and cleanup targets only the owned PID tree', () => {
  assert.match(SOURCE, /candidateSha256 -cne \$candidateSha/u);
  assert.match(SOURCE, /captureReportSha256 -cne \$reportSha/u);
  assert.match(SOURCE, /artifactManifestSha256 -cne \$manifestSha/u);
  assert.match(SOURCE, /Get-OwnedProcessIds -RootProcessId/u);
  assert.match(SOURCE, /taskkill\.exe \/PID \$app\.Id \/T \/F/u);
  assert.doesNotMatch(SOURCE, /Stop-Process\s+-Name/u);
  assert.doesNotMatch(SOURCE, /taskkill\.exe\s+\/IM/u);
  assert.match(SOURCE, /owned process IDs remain active/u);
  assert.match(SOURCE, /CDP debug port \$DebugPort remains occupied/u);
  assert.match(SOURCE, /C: fell below \$MinFreeGiB GiB free/u);
});
