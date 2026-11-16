import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const TAURI_ROOT = path.dirname(fileURLToPath(import.meta.url));
const CONFIG = JSON.parse(
  readFileSync(path.join(TAURI_ROOT, 'tauri.conf.json'), 'utf8'),
);

const ASSET_SPECS = new Map([
  ['windows/assets/ck-nsis-header.bmp', [150, 57]],
  ['windows/assets/ck-nsis-sidebar.bmp', [164, 314]],
  ['windows/assets/ck-wix-banner.bmp', [493, 58]],
  ['windows/assets/ck-wix-dialog.bmp', [493, 312]],
]);

function readBmp(relativePath) {
  const contents = readFileSync(path.join(TAURI_ROOT, relativePath));
  assert.equal(contents.toString('ascii', 0, 2), 'BM');
  assert.equal(contents.readUInt16LE(28), 24, `${relativePath} must be 24-bit`);

  const width = contents.readInt32LE(18);
  const height = Math.abs(contents.readInt32LE(22));
  const pixelOffset = contents.readUInt32LE(10);
  const rowStride = Math.ceil((width * 3) / 4) * 4;
  const colors = new Set();

  for (let y = 0; y < height; y += Math.max(1, Math.floor(height / 24))) {
    for (let x = 0; x < width; x += Math.max(1, Math.floor(width / 24))) {
      const offset = pixelOffset + y * rowStride + x * 3;
      colors.add(
        `${contents[offset + 2]},${contents[offset + 1]},${contents[offset]}`,
      );
    }
  }

  return { contents, width, height, colors };
}

test('NSIS offers a bilingual branded setup without replacing association hooks', () => {
  const nsis = CONFIG.bundle.windows.nsis;
  assert.deepEqual(nsis.languages, ['English', 'SimpChinese']);
  assert.equal(nsis.displayLanguageSelector, true);
  assert.equal(nsis.startMenuFolder, 'CK MakerSwitch');
  assert.equal(nsis.installerIcon, 'icons/icon.ico');
  assert.equal(
    nsis.installerHooks,
    'windows/project-file-association-hooks.nsh',
  );
  assert.equal(nsis.headerImage, 'windows/assets/ck-nsis-header.bmp');
  assert.equal(nsis.sidebarImage, 'windows/assets/ck-nsis-sidebar.bmp');
});

test('WiX produces separate English and Simplified Chinese localized MSI bundles', () => {
  const wix = CONFIG.bundle.windows.wix;
  assert.deepEqual(wix.language, {
    'en-US': { localePath: 'windows/locales/en-US.wxl' },
    'zh-CN': { localePath: 'windows/locales/zh-CN.wxl' },
  });
  assert.equal(wix.bannerPath, 'windows/assets/ck-wix-banner.bmp');
  assert.equal(wix.dialogImagePath, 'windows/assets/ck-wix-dialog.bmp');
  assert.deepEqual(wix.fragmentPaths, [
    'windows/project-file-associations.wxs',
  ]);
  assert.deepEqual(wix.componentGroupRefs, ['CKProjectAssociationIcons']);
});

test('interactive NSIS reinstall keeps language selection available', () => {
  const hooks = readFileSync(path.join(TAURI_ROOT, CONFIG.bundle.windows.nsis.installerHooks), 'utf8');
  assert.match(hooks, /^!define MUI_LANGDLL_ALWAYSSHOW$/m);
  assert.doesNotMatch(hooks, /DeleteRegValue.*Installer Language/);
});

test('custom MSI copy is readable in both languages', () => {
  const english = readFileSync(
    path.join(TAURI_ROOT, 'windows/locales/en-US.wxl'),
    'utf8',
  );
  const chinese = readFileSync(
    path.join(TAURI_ROOT, 'windows/locales/zh-CN.wxl'),
    'utf8',
  );

  assert.match(english, /WixLocalization Culture="en-US"/);
  assert.match(chinese, /WixLocalization Culture="zh-CN"/);

  for (const id of [
    'LaunchApp',
    'DowngradeErrorMessage',
    'PathEnvVarFeature',
    'InstallAppFeature',
  ]) {
    assert.match(english, new RegExp(`<String Id="${id}">[^<]+</String>`));
    assert.match(chinese, new RegExp(`<String Id="${id}">[^<]+</String>`));
  }

  assert.match(english, /Launch CK when setup finishes/);
  assert.match(chinese, /安装完成后启动 CK/);
  assert.match(chinese, /可视化硬件开发工作台/);
});

test('installer artwork has the exact native-dialog dimensions and visible color depth', () => {
  for (const [relativePath, [expectedWidth, expectedHeight]] of ASSET_SPECS) {
    const { contents, width, height, colors } = readBmp(relativePath);
    assert.equal(width, expectedWidth, `${relativePath} width`);
    assert.equal(height, expectedHeight, `${relativePath} height`);
    assert.ok(contents.length > width * height * 2, `${relativePath} is not empty`);
    assert.ok(colors.size >= 8, `${relativePath} must not be a flat placeholder`);
  }
});
