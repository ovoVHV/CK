import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const HERE = path.dirname(fileURLToPath(import.meta.url));
const DESKTOP_ROOT = path.resolve(HERE, '..');
const MAIN_RS = path.join(HERE, 'src', 'main.rs');
const PACKAGE_JSON = path.join(DESKTOP_ROOT, 'package.json');
const README = path.join(DESKTOP_ROOT, 'README.md');

test('release binaries cannot be compiled without Tauri custom-protocol', () => {
  const source = readFileSync(MAIN_RS, 'utf8');

  assert.match(
    source,
    /#\[cfg\(all\(not\(debug_assertions\), not\(feature = "custom-protocol"\)\)\)\]\s*compile_error!/,
  );
  assert.match(source, /CK production builds require the `custom-protocol` feature/);
  assert.match(source, /http:\/\/localhost:1420/);
});

test('named npm desktop build commands cannot create a protocol-less release EXE', () => {
  const packageJson = JSON.parse(readFileSync(PACKAGE_JSON, 'utf8'));
  const scripts = packageJson.scripts ?? {};

  assert.equal(scripts['desktop:dev'], 'tauri dev');
  assert.equal(scripts['desktop:build'], 'tauri build');
  assert.equal(scripts['desktop:build:debug'], 'tauri build --debug');
  assert.match(scripts['desktop:build:exe'], /^npm run build:web && cargo build /);
  assert.match(scripts['desktop:build:exe'], /--release(?:\s|$)/);
  assert.match(scripts['desktop:build:exe'], /--features custom-protocol(?:\s|$)/);

  for (const [name, command] of Object.entries(scripts)) {
    if (/cargo\s+build\b/.test(command) && /--release(?:\s|$)/.test(command)) {
      assert.match(
        command,
        /--features custom-protocol(?:\s|$)/,
        `${name} must not build a release desktop executable without custom-protocol`,
      );
    }
  }
});

test('desktop documentation distinguishes web output, EXE output, and installers', () => {
  const readme = readFileSync(README, 'utf8');

  assert.match(readme, /npm run desktop:build\b/);
  assert.match(readme, /npm run desktop:build:exe\b/);
  assert.match(readme, /不要直接执行 `cargo build --release`/);
  assert.match(readme, /`npm run build` \/ `npm run build:web` 只生成前端静态资源/);
  assert.match(readme, /http:\/\/localhost:1420/);
});
