import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { loadResourceModule } from './resource_test_loader.mjs';
const { validateResourceGraph, validateResourceClaims, assertResourceJson } = await loadResourceModule('./resource_contract.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const root = new URL('../../../../examples/resource-contract-fixture/', import.meta.url);
const load = async name => JSON.parse(await readFile(new URL(name, root), 'utf8'));
const board = await load('board.json');
const block = (await load('libraries/orchard_probe/ck-blocks.json')).blocks[0];
for (const c of await load('validation-corpus.json')) test(`shared boundary: ${c.id}`, () => {
  let value = structuredClone(c.target === 'graph' ? board.resource_graph : block.hardware.claims);
  if (c.path !== undefined) {
    if (!c.path) value = c.value;
    else {
      const path = c.path.slice(1).split('/');
      const key = path.pop();
      const object = path.reduce((v, k) => v[k], value);
      if (c.remove) delete object[key];
      else Object.defineProperty(object, key, { value: structuredClone(c.value), enumerable: true, configurable: true, writable: true });
    }
  }
  const run = () => c.target === 'graph' ? validateResourceGraph(value) : validateResourceClaims(value, ['BUS'], ['ADDRESS']);
  if (c.valid) assert.doesNotThrow(run); else assert.throws(run);
});
test('JSON guard refuses getters, sparse arrays, symbols and oversized data', () => {
  let called = false;
  assert.throws(() => assertResourceJson({ get x() { called = true; return 1; } }));
  assert.equal(called, false);
  assert.throws(() => assertResourceJson(Array(3)));
  assert.throws(() => assertResourceJson({ [Symbol('x')]: 1 }));
  assert.throws(() => assertResourceJson(Array(20001).fill(1)));
  assert.throws(() => assertResourceJson(Array(200).fill('a'.repeat(4096))));
});
const catalog = [{ ...block, metadata_source: 'v2', library_id: 'orchard_probe' }];
const instance = (address, type = 'math_number') => ({ id: 'probe-a', type: block.type, getFieldValue: () => 'sensor-port', getInputTargetBlock: () => ({ type, getFieldValue: () => address }) });
test('field alias and input literal bind without mutating source data', () => {
  const before = JSON.stringify({ board, catalog });
  const r = analyzeDeclaredHardware(board, catalog, [instance('0x3c')]);
  assert.equal(r.claims[0].resource, 'fabric.sensorbus');
  assert.equal(r.claims[0].discriminator, '60');
  assert.equal(r.claims[0].segment, 'fabric.sensorbus');
  assert.equal(r.report.coverage, 'full');
  assert.equal(r.report.bindings.length, 3);
  assert.equal(JSON.stringify({ board, catalog }), before);
});
test('dynamic input is not evaluated, does not claim complete analysis', () => {
  const r = analyzeDeclaredHardware(board, catalog, [instance('60', 'variables_get')]);
  assert.equal(r.claims.length, 0);
  assert.equal(r.report.coverage, 'partial');
  assert.equal(r.gaps[0].code, 'unresolved-claim');
});
test('legacy missing claims and absent board remain explicit incomplete states', () => {
  assert.equal(analyzeDeclaredHardware(board, [{ ...block, hardware: { resources: [] } }], [instance(60)]).report.coverage, 'partial');
  assert.equal(analyzeDeclaredHardware({}, catalog, [instance(60)]).report, null);
  assert.throws(() => analyzeDeclaredHardware({ resource_graph: null }, catalog, [instance(60)]));
});
test('address formatting cannot escape numeric collision identity', () => {
  const modified = structuredClone(catalog);
  modified[0].hardware.claims.templates[0].discriminator = { kind: 'fixed', valueType: 'id', value: '0x3c' };
  const result = analyzeDeclaredHardware(board, modified, [instance(60)]);
  assert.equal(result.report.coverage, 'partial');
  assert.equal(result.gaps[0].code, 'unresolved-address');
});
