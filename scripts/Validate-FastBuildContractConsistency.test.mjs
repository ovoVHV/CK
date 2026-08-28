import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import { resolve } from 'node:path';
import test from 'node:test';

const root = resolve(import.meta.dirname, '..');
const read = path => readFileSync(resolve(root, path), 'utf8');
const extract = (source, pattern, label) => {
  const match = source.match(pattern);
  assert.ok(match, `cannot find ${label}`);
  return match[1];
};

test('builder is the authoritative Fast/build contract source across active layers', () => {
  const builder = read('crates/ck_core/src/builder/demo.rs');
  const forge = read('apps/desktop/src-tauri/src/ck_forge.rs');
  const boardPassport = read('apps/desktop/src-tauri/src/board_passport.rs');
  const compileDoctor = read('apps/desktop/src/services/compile_doctor.ts');
  const manifest = JSON.parse(read('apps/desktop/src-tauri/src/ck_forge_qualified_targets.v1.json'));
  const boardLockSchema = JSON.parse(read('docs/schemas/ck-board-lock.schema.json'));
  const specification = JSON.parse(read('docs/specification/index.json'));

  const current = extract(
    builder,
    /pub const FAST_BUILD_CONTRACT_SIGNATURE_MARKER: &str = "([^"]+)";/u,
    'Rust builder Fast/build marker',
  );
  const doctorMirror = extract(
    compileDoctor,
    /const CURRENT_CK_FORGE_CONTRACT_ID = '([^']+)'/u,
    'Compile Doctor Fast/build marker',
  );
  const specificationEntry = specification.contracts.find(contract => contract.id === 'ck.forge-regression');

  assert.equal(manifest.contract_id, current);
  assert.equal(boardLockSchema.$defs.certificationEngineContract.const, current);
  assert.equal(doctorMirror, current);
  assert.equal(specificationEntry?.fast_build_contract_id, current);
  assert.match(
    forge,
    /pub fn current_forge_contract_id\(\) -> &'static str \{\s*ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER\s*\}/u,
  );
  assert.match(forge, /manifest\.contract_id != current_forge_contract_id\(\)/u);
  assert.doesNotMatch(forge, /CK_FORGE_QUALIFIED_FAST_CONTRACT_ID/u);
  assert.match(boardPassport, /ck_core::builder::demo::FAST_BUILD_CONTRACT_SIGNATURE_MARKER/u);
});

test('the shipped target manifest remains candidate-only after its current identity is repaired', () => {
  const manifest = JSON.parse(read('apps/desktop/src-tauri/src/ck_forge_qualified_targets.v1.json'));
  assert.ok(Array.isArray(manifest.targets) && manifest.targets.length > 0);
  assert.ok(
    manifest.targets.every(target => target.performance_ab === undefined),
    'F-001 must not invent or migrate Fast performance authorization evidence',
  );
});
