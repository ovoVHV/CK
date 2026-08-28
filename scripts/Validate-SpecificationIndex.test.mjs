import assert from 'node:assert/strict';
import { existsSync, readFileSync } from 'node:fs';
import { dirname, resolve } from 'node:path';
import test from 'node:test';
import { fileURLToPath } from 'node:url';

const ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '..');
const INDEX_PATH = resolve(ROOT, 'docs', 'specification', 'index.json');
const ALLOWED_STATUS = new Set(['normative', 'stable-local', 'internal', 'deferred']);

test('CK Specification index has unique contracts and resolvable local resources', () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  assert.equal(index.schema_version, 1);
  assert.equal(index.specification_version, '1.0');
  assert.equal(index.contract_governance, 'docs/contract-governance.md');
  assert.equal(existsSync(resolve(ROOT, index.contract_governance)), true);
  assert.equal(index.contract_inventory, 'docs/specification/contracts.json');
  assert.equal(existsSync(resolve(ROOT, index.contract_inventory)), true);
  assert.ok(Array.isArray(index.contracts) && index.contracts.length > 0);

  const ids = new Set();
  for (const contract of index.contracts) {
    assert.equal(typeof contract.id, 'string');
    assert.ok(contract.id.length > 0);
    assert.equal(ids.has(contract.id), false, `duplicate specification id: ${contract.id}`);
    ids.add(contract.id);
    assert.ok(ALLOWED_STATUS.has(contract.status), `unsupported status for ${contract.id}`);

    for (const field of ['document', 'schema', 'release_channel', 'entrypoint']) {
      if (!contract[field]) continue;
      const path = resolve(ROOT, contract[field]);
      assert.equal(existsSync(path), true, `${contract.id} references missing ${field}: ${contract[field]}`);
    }
  }

  assert.equal(ids.has('ck.project'), true);
  assert.equal(ids.has('ck.recovery-drafts'), true);
  assert.equal(ids.has('ck.block-contract'), true);
  assert.equal(ids.has('ck.block-evidence-passport'), true);
  assert.equal(ids.has('ck.extension-sdk'), true);
  assert.equal(ids.has('ck.forge-regression'), true);
  assert.equal(ids.has('ck.project-checkpoints'), true);
  assert.equal(ids.has('ck.build-identity'), true);
  assert.equal(ids.has('ck.upload-artifact-manifest'), true);
  assert.equal(ids.has('ck.last-working-version'), true);
  assert.equal(ids.has('ck.release-evidence-manifest'), true);
  assert.equal(ids.has('cktrace'), true);
  assert.equal(ids.has('ck.lab'), true);
  assert.equal(ids.has('ck.ai-engineering-advisor'), true);
});

test('machine index covers the internal and stable-local rows listed by the human index', () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  const byId = new Map(index.contracts.map(contract => [contract.id, contract]));
  assert.equal(byId.get('ck.project-checkpoints')?.status, 'internal');
  assert.equal(byId.get('ck.build-identity')?.status, 'internal');
  assert.equal(byId.get('ck.upload-artifact-manifest')?.status, 'internal');
  assert.equal(byId.get('ck.last-working-version')?.status, 'stable-local');
  assert.equal(byId.get('ck.forge-regression')?.status, 'stable-local');
  assert.equal(byId.get('ck.release-evidence-manifest')?.status, 'internal');
});

test('deferred formats are not mislabeled as shipped contracts', () => {
  const index = JSON.parse(readFileSync(INDEX_PATH, 'utf8'));
  const byId = new Map(index.contracts.map(contract => [contract.id, contract]));
  for (const id of ['cktrace', 'ck.lab', 'ck.ai-engineering-advisor']) {
    assert.equal(byId.get(id)?.status, 'deferred', `${id} must stay deferred for this release`);
  }
});
