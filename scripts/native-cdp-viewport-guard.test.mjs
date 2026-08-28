import assert from 'node:assert/strict';
import { createRequire } from 'node:module';
import { readdir, readFile } from 'node:fs/promises';
import path from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const scriptsDirectory = path.dirname(fileURLToPath(import.meta.url));
const thisTestName = path.basename(fileURLToPath(import.meta.url));
const capabilityPath = path.resolve(scriptsDirectory, '../apps/desktop/src-tauri/capabilities/default.json');
const require = createRequire(import.meta.url);
const { restoreNativeViewport } = require('./native-cdp-viewport-guard.cjs');

test('native viewport guard clears CDP metrics before checking the full-width roots', async () => {
  const calls = [];
  const geometry = {
    innerWidth: 1600,
    innerHeight: 900,
    devicePixelRatio: 1.5,
    documentClientWidth: 1600,
    documentScrollWidth: 1600,
    nativeLabel: 'main',
    nativeSize: { width: 2400, height: 1350 },
    nativeSizeError: '',
    root: { left: 0, right: 1600, width: 1600 },
    app: { left: 0, right: 1600, width: 1600 },
  };
  const result = await restoreNativeViewport(async (method) => {
    calls.push(method);
    if (method === 'Runtime.evaluate') return { result: { value: geometry } };
    return {};
  });

  assert.deepEqual(calls, ['Emulation.clearDeviceMetricsOverride', 'Runtime.evaluate']);
  assert.deepEqual(result, geometry);
});

test('native viewport guard rejects a root that leaves a compositor-side gap', async () => {
  await assert.rejects(
    restoreNativeViewport(async (method) => method === 'Runtime.evaluate'
      ? {
          result: {
            value: {
              innerWidth: 2048,
              innerHeight: 1000,
              devicePixelRatio: 1.5,
              nativeSize: { width: 3072, height: 1500 },
              root: { left: 0, right: 1334, width: 1334 },
              app: { left: 0, right: 1334, width: 1334 },
            },
          },
        }
      : {}),
    /does not fill the restored native viewport/,
  );
});

test('native viewport guard catches a full CSS root stranded inside a wider native window', async () => {
  await assert.rejects(
    restoreNativeViewport(async (method) => method === 'Runtime.evaluate'
      ? {
          result: {
            value: {
              innerWidth: 1024,
              innerHeight: 700,
              devicePixelRatio: 1.5,
              nativeSize: { width: 2048, height: 1050 },
              root: { left: 0, right: 1024, width: 1024 },
              app: { left: 0, right: 1024, width: 1024 },
            },
          },
        }
      : {}),
    /Tauri 2048x1050 physical px, CSS 1024x700 at DPR 1\.5 \(1536x1050 physical px\)/,
  );
});

test('native viewport guard fails closed when Tauri inner-size permission is unavailable', async () => {
  await assert.rejects(
    restoreNativeViewport(async (method) => method === 'Runtime.evaluate'
      ? {
          result: {
            value: {
              innerWidth: 1024,
              innerHeight: 700,
              devicePixelRatio: 1.5,
              nativeSize: null,
              nativeSizeError: 'not allowed by ACL',
              root: { left: 0, right: 1024, width: 1024 },
              app: { left: 0, right: 1024, width: 1024 },
            },
          },
        }
      : {}),
    /not allowed by ACL.*allow-inner-size/,
  );
});

test('main Tauri capability explicitly grants the physical inner-size signal', async () => {
  const capability = JSON.parse(await readFile(capabilityPath, 'utf8'));
  assert.ok(
    capability.permissions?.includes('core:window:allow-inner-size'),
    'native viewport validation must not rely on an implicit permission bundle',
  );
  assert.ok(capability.windows?.includes('main'), 'the physical-size grant must cover the main CK window');
});

test('live CK native regressions never install a synthetic CDP viewport', async () => {
  const entries = await readdir(scriptsDirectory, { withFileTypes: true });
  const sources = await Promise.all(entries
    .filter((entry) => entry.isFile()
      && entry.name !== thisTestName
      && /Native.*\.(?:ps1|js|mjs)$/i.test(entry.name))
    .map(async (entry) => ({
      name: entry.name,
      source: await readFile(path.join(scriptsDirectory, entry.name), 'utf8'),
    })));

  const liveCdpPrograms = sources.filter(({ source }) =>
    source.includes("new WebSocket(process.env.CK_CDP_URL)"));
  assert.ok(liveCdpPrograms.length >= 10, 'expected the native CDP regression programs to be audited');

  for (const { name, source } of sources) {
    assert.doesNotMatch(
      source,
      /(?:setViewportSize|Emulation\.setDeviceMetricsOverride)/,
      `${name} must resize the native window, never emulate the live WebView viewport`,
    );
  }
  for (const { name, source } of liveCdpPrograms) {
    assert.match(source, /restoreNativeViewport\(call\)/, `${name} must restore viewport state first`);
  }
});
