import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { spawnSync } from 'node:child_process';
import test from 'node:test';

const ROOT = path.resolve(import.meta.dirname, '..');
const FILE = path.join(ROOT, 'scripts', 'Run-CKAvrDependencyEditCandidate.ps1');
const SOURCE = fs.readFileSync(FILE, 'utf8');

test('dependency candidate wrapper has valid PowerShell syntax', () => {
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

test('wrapper binds output, candidate EXE, disk, processes and CDP before launch', () => {
  assert.match(SOURCE, /artifacts\\benchmarks/u);
  assert.match(SOURCE, /StartsWith\(/u);
  assert.match(SOURCE, /Refusing to overwrite dependency-edit evidence/u);
  assert.match(SOURCE, /Get-FileHash[\s\S]*ExpectedExecutableSha256/u);
  assert.match(SOURCE, /Get-Process -Name appsdesktop, arduino-cli/u);
  assert.match(SOURCE, /Get-NetTCPConnection -LocalPort \$DebugPort -State Listen/u);
  assert.match(SOURCE, /Get-PSDrive C/u);
  assert.match(SOURCE, /Start-Process[\s\S]*-WindowStyle Hidden -PassThru/u);
  assert.match(SOURCE, /CK_PROCESS_ID = \[string\]\$app\.Id/u);
  assert.match(SOURCE, /http:\/\/tauri\.localhost\//u);
  assert.match(SOURCE, /Get-CimInstance Win32_Process/u);
});

test('wrapper launches a normal no-token app and restores every inherited environment value', () => {
  const clearIndex = SOURCE.indexOf("'CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN', $null, 'Process'");
  const launchIndex = SOURCE.indexOf('Start-Process -FilePath $executable');
  assert.ok(clearIndex >= 0 && clearIndex < launchIndex, 'qualification token must be removed before launch');
  assert.match(SOURCE, /\$saved = @\{[\s\S]*CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN/u);
  assert.match(SOURCE, /finally \{[\s\S]*Stop-Process -Id \$app\.Id/u);
  assert.match(SOURCE, /foreach \(\$name in \$saved\.Keys\)/u);
  assert.match(SOURCE, /SetEnvironmentVariable\(\$name, \$saved\[\$name\], 'Process'\)/u);
  assert.doesNotMatch(SOURCE, /Stop-Process\s+-Name/u);
});

test('Target/Trials flow to runner and only exit 0 invokes the independent verifier', () => {
  assert.match(SOURCE, /\[string\]\$Target = 'all'/u);
  assert.match(SOURCE, /\[ValidateRange\(1, 5\)\][\s\S]*\[int\]\$Trials = 1/u);
  assert.match(SOURCE, /--target \$Target/u);
  assert.match(SOURCE, /--trials \$Trials/u);
  assert.match(SOURCE, /Run-CKAvrDependencyEditRegression\.cjs/u);
  assert.match(SOURCE, /Verify-CKAvrDependencyEditRegression\.cjs/u);
  const successBranch = SOURCE.match(/if \(\$runnerExit -eq 0\) \{([\s\S]*?)\n    \} else \{/u)?.[1] || '';
  assert.match(successBranch, /& node \$verifier/u);
  assert.match(successBranch, /DEPENDENCY-EDIT-VERIFIED/u);
  assert.match(SOURCE, /\$runnerExit -notin @\(0, 2\)/u);
});

test('exit 2 preserves evidence, skips the verifier and cleanup still runs', () => {
  const successStart = SOURCE.indexOf('    if ($runnerExit -eq 0) {');
  const elseStart = SOURCE.indexOf('    } else {', successStart);
  const finallyStart = SOURCE.indexOf('\n} finally {', elseStart);
  const exitTwoBranch = SOURCE.slice(elseStart, finallyStart);
  assert.match(exitTwoBranch, /\$terminalExit = 2/u);
  assert.match(exitTwoBranch, /DEPENDENCY-EDIT-TARGET-NOT-MET/u);
  assert.doesNotMatch(exitTwoBranch, /& node \$verifier/u);
  assert.doesNotMatch(SOURCE, /Remove-Item|Clear-Content|Set-Content/u);
  assert.match(SOURCE, /if \(-not \(Test-Path -LiteralPath \$outputPath -PathType Leaf\)\)/u);
  assert.match(SOURCE, /if \(\$terminalExit -ne 0\) \{[\s\S]*exit \$terminalExit/u);
});
