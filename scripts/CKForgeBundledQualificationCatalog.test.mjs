import assert from 'node:assert/strict';
import { readdirSync, readFileSync } from 'node:fs';
import { join, resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const qualificationRoot = join(root, 'apps', 'desktop', 'src-tauri', 'state', 'qualifications');
const catalogPath = join(
  root,
  'apps',
  'desktop',
  'src-tauri',
  'src',
  'ck_forge_bundled_qualifications.v1.json',
);

const identity = ({ fqbn, coreVersion }) => `${fqbn}\0${coreVersion}`;

test('bundled FLFE catalog exactly reflects authenticated certificate targets', () => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  assert.equal(catalog.schemaId, 'ck.forge.bundled-qualification-catalog');
  assert.equal(catalog.schemaVersion, 1);
  assert.equal(catalog.candidateProfile, 'native-relink-compile-only');
  assert.ok(Array.isArray(catalog.entries) && catalog.entries.length > 0);

  const catalogIdentities = catalog.entries.map(identity);
  assert.equal(new Set(catalogIdentities).size, catalogIdentities.length, 'catalog rows must be unique');

  const reportIdentities = new Set();
  for (const name of readdirSync(qualificationRoot)) {
    if (!/^[0-9a-f]{64}$/u.test(name)) continue;
    const report = JSON.parse(readFileSync(join(qualificationRoot, name, 'report.json'), 'utf8'));
    assert.equal(report.schemaId, 'ck.forge.native-relink-local-qualification-report');
    assert.equal(report.candidateProfile, catalog.candidateProfile);
    assert.equal(report.qualified, true);
    assert.equal(report.status, 'qualified-native-relink');
    reportIdentities.add(identity(report.target));
  }

  assert.deepEqual(new Set(catalogIdentities), reportIdentities);
});

test('Arduino AVR 1.8.8 common boards are explicitly discoverable', () => {
  const catalog = JSON.parse(readFileSync(catalogPath, 'utf8'));
  const avr188 = new Set(catalog.entries
    .filter((entry) => entry.coreVersion === '1.8.8')
    .map((entry) => entry.fqbn));
  assert.deepEqual(avr188, new Set([
    'arduino:avr:diecimila:cpu=atmega328',
    'arduino:avr:leonardo',
    'arduino:avr:mega:cpu=atmega2560',
    'arduino:avr:nano:cpu=atmega328',
    'arduino:avr:uno',
  ]));
});
