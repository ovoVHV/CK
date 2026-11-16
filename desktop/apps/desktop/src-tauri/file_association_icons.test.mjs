import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TAURI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const WORKSPACE_ROOT = path.resolve(TAURI_ROOT, '..', '..', '..');
const CONFIG_PATH = path.join(TAURI_ROOT, 'tauri.conf.json');
const CONFIG = JSON.parse(readFileSync(CONFIG_PATH, 'utf8'));

const WIX_FRAGMENT_PATH = path.join(
  TAURI_ROOT,
  'windows',
  'project-file-associations.wxs',
);
const GENERATED_WIX_PATH = path.join(
  WORKSPACE_ROOT,
  'target',
  'release',
  'wix',
  'x64',
  'main.wxs',
);

test('Windows installers associate current and legacy CK project extensions', () => {
  const association = CONFIG.bundle.fileAssociations?.find(
    (entry) => entry.name === 'CK Project',
  );

  assert.ok(association, 'CK Project file association must be declared');
  assert.deepEqual(association.ext, ['ck', 'maker']);
  assert.equal(association.description, 'CK Visual Hardware Project');
  assert.equal(association.role, 'Editor');
});

test('Windows project associations can use the packaged multi-size CK icon', () => {
  const iconPath = CONFIG.bundle.windows?.nsis?.installerIcon;
  assert.equal(iconPath, 'icons/icon.ico');
  assert.ok(CONFIG.bundle.icon.includes(iconPath));

  const ico = readFileSync(path.join(TAURI_ROOT, iconPath));
  assert.equal(ico.readUInt16LE(0), 0, 'ICO reserved field must be zero');
  assert.equal(ico.readUInt16LE(2), 1, 'asset must be a Windows icon');

  const imageCount = ico.readUInt16LE(4);
  assert.ok(imageCount >= 4, 'project icon should contain several Explorer sizes');

  const sizes = new Set();
  for (let index = 0; index < imageCount; index += 1) {
    const entryOffset = 6 + index * 16;
    const width = ico[entryOffset] || 256;
    const height = ico[entryOffset + 1] || 256;
    sizes.add(`${width}x${height}`);
  }

  for (const requiredSize of ['16x16', '32x32', '128x128', '256x256']) {
    assert.ok(sizes.has(requiredSize), `missing ${requiredSize} Explorer icon frame`);
  }
});

test('MSI writes explicit machine-scoped CK icons for both project ProgIds', () => {
  const wix = CONFIG.bundle.windows?.wix;
  assert.deepEqual(wix?.fragmentPaths, ['windows/project-file-associations.wxs']);
  assert.deepEqual(wix?.componentGroupRefs, ['CKProjectAssociationIcons']);

  const fragment = readFileSync(WIX_FRAGMENT_PATH, 'utf8');
  const iconKeys = [
    'Software\\Classes\\CK.ck\\DefaultIcon',
    'Software\\Classes\\CK.maker\\DefaultIcon',
  ];

  for (const key of iconKeys) {
    const escapedKey = key.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    const keyTag = fragment.match(
      new RegExp(
        `<RegistryKey\\s+Root="([^"]+)"\\s+Key="${escapedKey}"\\s+ForceDeleteOnUninstall="([^"]+)"`,
      ),
    );
    assert.ok(keyTag, `missing explicit RegistryKey for ${key}`);
    assert.equal(keyTag[1], 'HKLM', `${key} must be machine-scoped`);
    assert.equal(
      keyTag[2],
      'yes',
      `${key} must be removed with the MSI component`,
    );
  }

  assert.doesNotMatch(
    fragment,
    /<RegistryKey\s+Root="HKCU"\s+Key="Software\\Classes\\CK\.(?:ck|maker)\\DefaultIcon"/,
    'project icon keys must not remain user-scoped',
  );
  assert.equal(
    fragment.match(/Value="\[INSTALLDIR\]appsdesktop\.exe,0"/g)?.length,
    2,
  );
});

test('MSI advertised associations and icon component use the per-machine scope', () => {
  // Tauri's WiX backend emits the Package scope in the generated product
  // template. When a release build is present, verify the actual generated
  // installer input as well as the checked-in fragment contract above.
  if (!existsSync(GENERATED_WIX_PATH)) {
    return;
  }

  const generated = readFileSync(GENERATED_WIX_PATH, 'utf8');
  assert.match(
    generated,
    /<Package[\s\S]*?InstallScope="perMachine"[\s\S]*?\/>/,
    'the MSI Product must remain per-machine',
  );

  const pathComponent = generated.match(
    /<Component\s+Id="Path"[\s\S]*?<File\s+Id="Path"[\s\S]*?<ProgId\s+Id="CK\.ck"[\s\S]*?<ProgId\s+Id="CK\.maker"[\s\S]*?<\/Component>/,
  );
  assert.ok(
    pathComponent,
    'both advertised ProgIds must remain attached to the main executable component',
  );
  assert.match(generated, /<ComponentGroupRef\s+Id="CKProjectAssociationIcons"\s*\/>/);
});

test('NSIS refreshes Explorer after association install and removal', () => {
  const hooksPath = CONFIG.bundle.windows?.nsis?.installerHooks;
  assert.equal(hooksPath, 'windows/project-file-association-hooks.nsh');

  const hooks = readFileSync(path.join(TAURI_ROOT, hooksPath), 'utf8');
  assert.match(hooks, /!macro NSIS_HOOK_POSTINSTALL[\s\S]*UPDATEFILEASSOC/);
  assert.match(hooks, /!macro NSIS_HOOK_POSTUNINSTALL[\s\S]*UPDATEFILEASSOC/);
});
