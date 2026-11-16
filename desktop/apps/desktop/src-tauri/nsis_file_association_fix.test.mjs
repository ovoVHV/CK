import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TAURI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(TAURI_ROOT, '..', '..', '..');
const HOOK_PATH = path.join(
  TAURI_ROOT,
  'windows',
  'project-file-association-hooks.nsh',
);
const hook = readFileSync(HOOK_PATH, 'utf8');

function extractMacro(source, name) {
  const start = source.indexOf('!macro ' + name);
  assert.notEqual(start, -1, 'missing ' + name + ' macro');
  const end = source.indexOf('!macroend', start);
  assert.notEqual(end, -1, 'unterminated ' + name + ' macro');
  return source.slice(start, end);
}

function generatedInstaller() {
  const candidates = [
    path.join(WORKSPACE_ROOT, 'target', 'debug', 'nsis', 'x64', 'installer.nsi'),
    path.join(WORKSPACE_ROOT, 'target', 'release', 'nsis', 'x64', 'installer.nsi'),
  ];
  const file = candidates.find((candidate) => existsSync(candidate));
  return file ? readFileSync(file, 'utf8') : null;
}

test('NSIS association command quotes both executable path and %1', () => {
  const nsisQuote = '$' + String.fromCharCode(92) + '"';
  const expectedCommand =
    nsisQuote + '$INSTDIR\\${MAINBINARYNAME}.exe' + nsisQuote +
    ' ' + nsisQuote + '%1' + nsisQuote;

  const associate = extractMacro(hook, 'APP_ASSOCIATE');
  assert.ok(
    associate.includes(expectedCommand),
    'APP_ASSOCIATE must register a quoted executable and quoted %1',
  );

  const installer = generatedInstaller();
  if (!installer) return;
  for (const ext of ['ck', 'maker']) {
    assert.ok(
      installer.includes('APP_ASSOCIATE "' + ext + '"'),
      'generated installer must associate .' + ext,
    );
  }
});

test('NSIS APP_ASSOCIATE preserves the first association backup', () => {
  const associate = extractMacro(hook, 'APP_ASSOCIATE');
  const backupToken = '${FILECLASS}_backup';
  const backupRead = associate.indexOf(backupToken);
  const backupWrite = associate.lastIndexOf('WriteRegStr');
  assert.ok(backupRead >= 0, 'APP_ASSOCIATE must inspect the existing backup');
  assert.ok(backupWrite > backupRead, 'backup must be written after it is read');
  assert.ok(
    associate.slice(backupRead, backupWrite).includes('${If} ${Errors}'),
    'backup write must be guarded by the missing-backup check',
  );
  assert.equal(
    associate.split(backupToken).length - 1,
    2,
    'associate macro should read and write the backup exactly once',
  );
});

test('NSIS APP_UNASSOCIATE restores or removes only CK-owned associations', () => {
  const unassociate = extractMacro(hook, 'APP_UNASSOCIATE');
  assert.ok(
    unassociate.includes('ReadRegStr $R1 SHELL_CONTEXT "Software\\Classes\\.${EXT}" "${FILECLASS}_backup"'),
  );
  assert.ok(
    unassociate.includes('${If} "$R0" == "${FILECLASS}"'),
    'uninstall must guard restoration by current CK ownership',
  );
  assert.ok(
    unassociate.includes('DeleteRegValue SHELL_CONTEXT "Software\\Classes\\.${EXT}" "${FILECLASS}_backup"'),
    'uninstall must delete CK backup metadata',
  );
  assert.ok(
    unassociate.includes('DeleteRegKey /ifempty SHELL_CONTEXT "Software\\Classes\\.${EXT}"'),
    'uninstall must remove an empty extension key',
  );
  assert.ok(
    unassociate.includes('DeleteRegKey SHELL_CONTEXT "Software\\Classes\\${FILECLASS}"'),
    'uninstall must remove the CK class after both extensions are free',
  );
});

test('generated NSIS installer handles .ck and .maker independently', () => {
  const installer = generatedInstaller();
  if (!installer) return;
  for (const ext of ['ck', 'maker']) {
    assert.ok(installer.includes('APP_ASSOCIATE "' + ext + '"'));
    assert.ok(installer.includes('APP_UNASSOCIATE "' + ext + '"'));
  }
});

function simulateInstallUpdateUninstall(initialOwners, takeover = {}) {
  const state = {
    owners: { ...initialOwners },
    backup: {},
    classPresent: false,
  };
  const extensions = ['ck', 'maker'];
  const install = () => {
    state.classPresent = true;
    for (const ext of extensions) {
      if (!Object.prototype.hasOwnProperty.call(state.backup, ext)) {
        state.backup[ext] = state.owners[ext] || '';
      }
      state.owners[ext] = 'CK Project';
    }
  };
  const uninstall = () => {
    for (const ext of extensions) {
      if (state.owners[ext] === 'CK Project') {
        state.owners[ext] = state.backup[ext] || '';
      }
      delete state.backup[ext];
    }
    state.classPresent = extensions.some((ext) => state.owners[ext] === 'CK Project');
  };

  install();
  Object.assign(state.owners, takeover);
  const firstBackup = { ...state.backup };
  install();
  assert.deepEqual(state.backup, firstBackup, 'update must not overwrite backups');
  uninstall();
  return state;
}

function simulateExternalTakeover(initialOwners, takeover) {
  const state = {
    owners: { ...initialOwners },
    backup: {},
    classPresent: false,
  };
  for (const ext of ['ck', 'maker']) {
    state.backup[ext] = state.owners[ext] || '';
    state.owners[ext] = 'CK Project';
  }
  state.classPresent = true;
  Object.assign(state.owners, takeover);
  for (const ext of ['ck', 'maker']) {
    if (state.owners[ext] === 'CK Project') {
      state.owners[ext] = state.backup[ext] || '';
    }
    delete state.backup[ext];
  }
  state.classPresent = ['ck', 'maker'].some((ext) => state.owners[ext] === 'CK Project');
  return state;
}

test('association lifecycle keeps no-owner and old-owner behavior', () => {
  const clean = simulateInstallUpdateUninstall({});
  assert.deepEqual(clean.owners, { ck: '', maker: '' });
  assert.deepEqual(clean.backup, {});
  assert.equal(clean.classPresent, false);

  const restored = simulateInstallUpdateUninstall({
    ck: 'OtherApp.CK',
    maker: 'OtherApp.Maker',
  });
  assert.deepEqual(restored.owners, {
    ck: 'OtherApp.CK',
    maker: 'OtherApp.Maker',
  });
  assert.deepEqual(restored.backup, {});
  assert.equal(restored.classPresent, false);

  const takeover = simulateExternalTakeover(
    { ck: 'OtherApp.CK', maker: 'OtherApp.Maker' },
    { ck: 'NewOwner.CK' },
  );
  assert.equal(takeover.owners.ck, 'NewOwner.CK');
  assert.equal(takeover.owners.maker, 'OtherApp.Maker');
  assert.equal(takeover.classPresent, false);
});
