import assert from 'node:assert/strict';
import crypto from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import test from 'node:test';
import { createRequire } from 'node:module';

const require = createRequire(import.meta.url);
const forge = require('./Run-CKForgeNativeAB.cjs');

const ROOT = path.resolve(import.meta.dirname, '..');
const SOURCE = fs.readFileSync(path.join(ROOT, 'scripts', 'Run-CKForgeNativeAB.cjs'), 'utf8');
const CANDIDATE_SOURCE = fs.readFileSync(
  path.join(ROOT, 'scripts', 'Run-CKEsp32LibraryEditCandidate.ps1'), 'utf8',
);

function sha256File(file) {
  return crypto.createHash('sha256').update(fs.readFileSync(file)).digest('hex');
}

function withExecutables(callback) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'ck-forge-production-binding-'));
  const primary = path.join(root, 'candidate', 'appsdesktop.exe');
  const neighbor = path.join(root, 'neighbor', 'appsdesktop.exe');
  fs.mkdirSync(path.dirname(primary), { recursive: true });
  fs.mkdirSync(path.dirname(neighbor), { recursive: true });
  fs.writeFileSync(primary, 'candidate-executable-v1\n');
  fs.writeFileSync(neighbor, 'neighbor-executable\n');
  try {
    return callback({ root, primary, neighbor });
  } finally {
    fs.rmSync(root, { recursive: true, force: true });
  }
}

function explicitEnvironment(executable, processId = 4242) {
  return {
    [forge.PRODUCTION_EXECUTABLE_PATH_ENV]: executable,
    [forge.PRODUCTION_EXECUTABLE_SHA256_ENV]: sha256File(executable),
    [forge.PRODUCTION_PROCESS_ID_ENV]: String(processId),
  };
}

test('default production binding remains pinned to target/release/appsdesktop.exe', () => {
  const contract = forge.productionExecutableBindingContract({});
  assert.equal(contract.mode, 'repository-production-default');
  assert.equal(contract.explicitOverride, false);
  assert.equal(contract.expectedProcessId, null);
  assert.equal(
    path.normalize(contract.expectedPath),
    path.normalize(path.join(ROOT, 'target', 'release', 'appsdesktop.exe')),
  );
  assert.match(contract.expectedSha256, /^[a-f0-9]{64}$/u);
});

test('explicit candidate contract binds absolute real path, SHA-256 and positive PID', () => {
  withExecutables(({ primary }) => {
    const contract = forge.productionExecutableBindingContract(explicitEnvironment(primary));
    assert.equal(contract.mode, 'explicit-candidate');
    assert.equal(contract.explicitOverride, true);
    assert.equal(contract.expectedPath, fs.realpathSync.native(primary));
    assert.equal(contract.expectedSha256, sha256File(primary));
    assert.equal(contract.expectedProcessId, 4242);
    assert.match(contract.expectedPathSha256, /^[a-f0-9]{64}$/u);

    const evidence = forge.validateProductionProcessBinding({
      appPid: 4242,
      listenerPid: 5252,
      path: primary,
    }, contract);
    assert.equal(evidence.bindingMode, 'explicit-candidate');
    assert.equal(evidence.appProcessId, 4242);
    assert.equal(evidence.cdpListenerProcessId, 5252);
    assert.equal(evidence.executablePath, fs.realpathSync.native(primary));
    assert.equal(evidence.executableSha256, sha256File(primary));
  });
});

test('an explicit path override is fail-closed unless path, digest and PID are all present', () => {
  withExecutables(({ primary }) => {
    const digest = sha256File(primary);
    assert.throws(
      () => forge.productionExecutableBindingContract({
        [forge.PRODUCTION_EXECUTABLE_PATH_ENV]: primary,
      }),
      /must be provided together/u,
    );
    assert.throws(
      () => forge.productionExecutableBindingContract({
        [forge.PRODUCTION_EXECUTABLE_SHA256_ENV]: digest,
      }),
      /must be provided together/u,
    );
    assert.throws(
      () => forge.productionExecutableBindingContract({
        [forge.PRODUCTION_EXECUTABLE_PATH_ENV]: primary,
        [forge.PRODUCTION_EXECUTABLE_SHA256_ENV]: digest,
      }),
      /must be provided together/u,
    );
    assert.throws(
      () => forge.productionExecutableBindingContract({
        ...explicitEnvironment(primary),
        [forge.PRODUCTION_PROCESS_ID_ENV]: '0',
      }),
      /positive integer/u,
    );
    assert.throws(
      () => forge.productionExecutableBindingContract({
        ...explicitEnvironment(primary),
        [forge.PRODUCTION_EXECUTABLE_SHA256_ENV]: 'not-a-digest',
      }),
      /SHA-256 digest/u,
    );
  });
});

test('explicit candidate rejects relative paths, wrong filenames and pre-launch hash drift', () => {
  withExecutables(({ root, primary }) => {
    assert.throws(
      () => forge.productionExecutableBindingContract({
        ...explicitEnvironment(primary),
        [forge.PRODUCTION_EXECUTABLE_PATH_ENV]: path.join('relative', 'appsdesktop.exe'),
      }),
      /absolute path/u,
    );
    const wrongName = path.join(root, 'candidate', 'renamed.exe');
    fs.writeFileSync(wrongName, 'wrong-name\n');
    assert.throws(
      () => forge.productionExecutableBindingContract(explicitEnvironment(wrongName)),
      /must name appsdesktop\.exe/u,
    );
    assert.throws(
      () => forge.productionExecutableBindingContract({
        ...explicitEnvironment(primary),
        [forge.PRODUCTION_EXECUTABLE_SHA256_ENV]: 'f'.repeat(64),
      }),
      /does not match/u,
    );
  });
});

test('independent CDP ancestry evidence rejects adjacent executable, PID drift and file mutation', () => {
  withExecutables(({ primary, neighbor }) => {
    const contract = forge.productionExecutableBindingContract(explicitEnvironment(primary, 7301));
    assert.throws(
      () => forge.validateProductionProcessBinding({
        appPid: 7301, listenerPid: 7302, path: neighbor,
      }, contract),
      /CDP is not owned/u,
    );
    assert.throws(
      () => forge.validateProductionProcessBinding({
        appPid: 9999, listenerPid: 7302, path: primary,
      }, contract),
      /CK_PROCESS_ID does not match/u,
    );
    assert.throws(
      () => forge.validateProductionProcessBinding({
        appPid: 0, listenerPid: 7302, path: primary,
      }, contract),
      /invalid process identifiers/u,
    );

    fs.writeFileSync(primary, 'candidate-executable-v2\n');
    assert.throws(
      () => forge.validateProductionProcessBinding({
        appPid: 7301, listenerPid: 7302, path: primary,
      }, contract),
      /SHA-256 changed/u,
    );
  });
});

test('source keeps repository default and requires the complete explicit candidate triple', () => {
  assert.match(SOURCE, /path\.join\(REPO_ROOT, 'target', 'release', 'appsdesktop\.exe'\)/u);
  assert.match(SOURCE, /PRODUCTION_EXECUTABLE_PATH_ENV/u);
  assert.match(SOURCE, /PRODUCTION_EXECUTABLE_SHA256_ENV/u);
  assert.match(SOURCE, /PRODUCTION_PROCESS_ID_ENV/u);
  assert.match(SOURCE, /must be provided together/u);
  assert.match(SOURCE, /validateProductionProcessBinding/u);
  assert.match(SOURCE, /CDP is not owned by target\/release\/appsdesktop\.exe/u);
  assert.match(CANDIDATE_SOURCE, /\[string\]\$ExecutablePath/u);
  assert.match(CANDIDATE_SOURCE, /\$env:CK_FORGE_PRODUCTION_EXECUTABLE_PATH = \$executablePath/u);
  assert.match(CANDIDATE_SOURCE, /\$env:CK_FORGE_PRODUCTION_EXECUTABLE_SHA256 = \$executableSha256/u);
  assert.match(CANDIDATE_SOURCE, /\$env:CK_PROCESS_ID = \[string\]\$candidateProcess\.Id/u);
  assert.match(CANDIDATE_SOURCE, /\$env:CK_FORGE_PRODUCTION_EXECUTABLE_PATH = \$savedProductionExecutablePath/u);
  assert.match(CANDIDATE_SOURCE, /\$env:CK_FORGE_PRODUCTION_EXECUTABLE_SHA256 = \$savedProductionExecutableSha256/u);
});
