import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { spawnSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import test from 'node:test';

const scriptsDir = dirname(fileURLToPath(import.meta.url));
const root = resolve(scriptsDir, '..');

test('PowerShell entrypoints never evaluate PSScriptRoot inside parameter defaults', () => {
  const offenders = readdirSync(scriptsDir)
    .filter((name) => name.endsWith('.ps1'))
    .filter((name) => {
      const source = readFileSync(join(scriptsDir, name), 'utf8');
      return /\$Root\s*=\s*\(Split-Path\s+-Parent\s+\$PSScriptRoot\)/.test(source);
    });

  assert.deepEqual(offenders, []);
});

test('AVR qualification wrapper resolves its repository root under Windows PowerShell 5', (t) => {
  if (process.platform !== 'win32') {
    t.skip('Windows PowerShell 5 regression');
    return;
  }

  const wrapper = join(scriptsDir, 'Run-CKAvrQualificationCandidate.ps1');
  const stateRoot = join(root, 'artifacts', 'benchmarks', 'powershell-root-default-probe');
  const result = spawnSync(
    'powershell.exe',
    [
      '-NoLogo',
      '-NoProfile',
      '-NonInteractive',
      '-ExecutionPolicy',
      'Bypass',
      '-File',
      wrapper,
      '-StateRoot',
      stateRoot,
      '-ExpectedExecutableSha256',
      '0'.repeat(64),
    ],
    { cwd: root, encoding: 'utf8', timeout: 30_000 },
  );

  const output = `${result.stdout ?? ''}\n${result.stderr ?? ''}`;
  assert.notEqual(result.status, 0);
  assert.doesNotMatch(output, /Cannot bind argument to parameter 'Path'.*empty string/is);
  assert.match(output, /Production executable (?:does not exist|SHA-256 mismatch)/i);
  assert.doesNotMatch(output, /\[QUAL\] Candidate ready/);
});
