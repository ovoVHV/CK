import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INVENTORY_PATH = resolve(ROOT, 'docs', 'specification', 'contracts.json');
const ALLOWED_CLASSIFICATIONS = new Set([
  'Schema',
  'Contract',
  'Policy',
  'Identity',
  'MIXED / NEEDS_SPLIT',
]);
const ALLOWED_LIFECYCLES = new Set(['ACTIVE', 'FROZEN', 'RETIRED']);

test('contract inventory is machine-readable, unique and governance-only', () => {
  assert.equal(existsSync(INVENTORY_PATH), true);
  const inventory = JSON.parse(readFileSync(INVENTORY_PATH, 'utf8'));
  assert.equal(inventory.inventory_schema, 1);
  assert.equal(inventory.inventory_id, 'ck-contract-inventory');
  assert.equal(inventory.status, 'internal-governance');
  assert.equal(inventory.runtime_consumed, false);
  assert.deepEqual(inventory.lifecycle_values, ['ACTIVE', 'FROZEN', 'RETIRED']);
  assert.ok(Array.isArray(inventory.entries) && inventory.entries.length >= 20);

  const ids = new Set();
  for (const entry of inventory.entries) {
    assert.equal(typeof entry.id, 'string');
    assert.ok(entry.id.length > 0);
    assert.equal(ids.has(entry.id), false, `duplicate inventory id: ${entry.id}`);
    ids.add(entry.id);
    assert.equal(ALLOWED_CLASSIFICATIONS.has(entry.classification), true, entry.id);
    assert.equal(ALLOWED_LIFECYCLES.has(entry.lifecycle), true, entry.id);
    assert.ok(Array.isArray(entry.source_files) && entry.source_files.length > 0, entry.id);
    for (const sourceFile of entry.source_files) {
      assert.equal(existsSync(resolve(ROOT, sourceFile)), true, `${entry.id} references missing source: ${sourceFile}`);
    }
    assert.ok(Array.isArray(entry.producers) && entry.producers.length > 0, entry.id);
    assert.ok(Array.isArray(entry.consumers) && entry.consumers.length > 0, entry.id);
    assert.equal(typeof entry.runtime_decision, 'boolean', entry.id);
    assert.equal(typeof entry.invalidates_evidence, 'boolean', entry.id);
    assert.equal(typeof entry.recommendation, 'string');
  }

  const fast = inventory.entries.find(entry => entry.id === 'ck-fast-build-contract');
  assert.equal(fast?.classification, 'MIXED / NEEDS_SPLIT');
  assert.equal(fast?.lifecycle, 'FROZEN');
  const v8v9 = inventory.findings.find(finding => finding.id === 'F-001');
  assert.equal(v8v9?.severity, 'critical');
});
