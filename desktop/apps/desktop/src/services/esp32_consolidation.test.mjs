import test from 'node:test';
import assert from 'node:assert/strict';
import { readFile } from 'node:fs/promises';
import { loadResourceModule } from './resource_test_loader.mjs';

const root = new URL('./', import.meta.url);
const readSource = name => readFile(new URL(name, root), 'utf8');
const familyModule = await loadResourceModule('./esp32_resource_family.ts');
const claimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const productionModule = await loadResourceModule('./production_resource_analysis.ts');

const evidenceKey = entry => `${entry.path}|${entry.sha256 ?? ''}`;
const setIntersection = (left, right) => [...left].filter(value => right.has(value));

const classic = { fqbn: 'esp32:esp32:esp32', options: {}, mcu: 'esp32', variant: 'esp32', coreVersion: '3.3.6', fCpu: '240000000L' };
const c3 = { fqbn: 'esp32:esp32:esp32c3', options: {}, mcu: 'esp32c3', variant: 'esp32c3', coreVersion: '3.3.6', fCpu: '160000000L' };
const c6 = { fqbn: 'esp32:esp32:esp32c6', options: {}, mcu: 'esp32c6', variant: 'esp32c6', coreVersion: '3.3.6', fCpu: '160000000L' };
const s3 = { fqbn: 'esp32:esp32:esp32s3', options: {}, mcu: 'esp32s3', variant: 'esp32s3', coreVersion: '3.3.6', fCpu: '240000000L' };
const workspace = (...blocks) => ({ getAllBlocks: () => blocks });
const digitalBlock = id => ({
  id,
  type: 'write_digital',
  getFieldValue: name => name === 'PIN' ? '2' : undefined,
  getInputTargetBlock: () => null,
});

test('classic ESP32, C3, C6 and S3 use the same graph builder and shared semantic layers', async () => {
  const [classicSource, c3Source, c6Source, s3Source, avrSource, claimsSource, bindingSource, graphSource, productionSource] = await Promise.all([
    readSource('esp32_resource_model.ts'),
    readSource('esp32_c3_resource_model.ts'),
    readSource('esp32_c6_resource_model.ts'),
    readSource('esp32_s3_resource_model.ts'),
    readSource('avr_resource_definition.ts'),
    readSource('esp32_builtin_resource_claims.ts'),
    readSource('resource_claim_binding.ts'),
    readSource('hardware_resource_graph.ts'),
    readSource('production_resource_analysis.ts'),
  ]);
  for (const source of [classicSource, c3Source, c6Source, s3Source, avrSource]) {
    assert.match(source, /resource_graph_builder/);
    assert.doesNotMatch(source, /const\s+add\s*=|const\s+fixedRoute\s*=|const\s+selectableRoute\s*=/);
  }
  assert.match(claimsSource, /analyzeDeclaredHardware/);
  assert.match(claimsSource, /analyzeHardwareResources/);
  // A family model is selected by the generic resolver; generic analysis layers
  // must not grow C3/C6 (or any future chip) analyzer branches.
  const familyBranchPattern = /(?:resolve|matches|select|dispatch|analy[sz]e)[A-Za-z0-9_]*(?:C3|C6)(?:ResourceModel|Identity|Analyzer|ClaimAdapter|Graph)?|(?:mcu|variant|fqbn)\s*={2,3}\s*['"]esp32c[36]['"]|case\s+['"]esp32c[36]['"]/i;
  for (const source of [claimsSource, bindingSource, graphSource, productionSource]) {
    assert.doesNotMatch(source, familyBranchPattern);
  }
});

test('classic ESP32, C3, C6 and S3 flow through one generic claim, binding and conflict analyzer', () => {
  for (const identity of [classic, c3, c6, s3]) {
    const result = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(digitalBlock(`${identity.mcu}:digital`)));
    assert.equal(result.status, 'ready');
    assert.equal(result.claims.length, 1);
    assert.ok(result.report);
    assert.equal(result.gaps.length, 0);
    assert.equal(result.report.bindings.length >= 1, true);
  }
});

test('shared resource graph semantics express routes, dynamic LEDC and conditional system ownership', () => {
  for (const identity of [classic, c3, c6, s3]) {
    const model = familyModule.resolveEsp32FamilyResourceModel(identity);
    assert.equal(model.status, 'ready');
    assert.ok(model.resource_graph.routes.some(route => route.mode === 'selectable'));
    assert.ok(model.resource_graph.resources.some(resource => resource.type === 'ledc-controller'));
    assert.ok(model.resource_graph.resources.some(resource => resource.capabilities?.includes('dynamic-channel-allocation')));
  }
  const c3Model = familyModule.resolveEsp32FamilyResourceModel(c3);
  assert.ok(c3Model.resource_graph.resources.some(resource => resource.type === 'usb-serial-jtag-controller'));
  assert.ok(c3Model.resource_graph.resources.some(resource => resource.capabilities?.includes('system-owned-when-usb-active')) === false);
  const c3Cdc = familyModule.resolveEsp32FamilyResourceModel({ ...c3, options: { CDCOnBoot: 'cdc' } });
  assert.ok(c3Cdc.resource_graph.resources.some(resource => resource.capabilities?.includes('system-owned-when-active')));
  const c6Model = familyModule.resolveEsp32FamilyResourceModel(c6);
  assert.ok(c6Model.resource_graph.resources.some(resource => resource.id === 'ieee802154.radio'));
});

test('evidence snapshots remain independent and production dispatch stays identity-driven', async () => {
  const classicEvidence = JSON.parse(await readFile(new URL('../config/esp32-resource-evidence/esp32-dev-module-3.3.6.json', root), 'utf8'));
  const c3Evidence = JSON.parse(await readFile(new URL('../config/esp32-resource-evidence/esp32-c3-3.3.6.json', root), 'utf8'));
  const c6Evidence = JSON.parse(await readFile(new URL('../config/esp32-resource-evidence/esp32-c6-3.3.6.json', root), 'utf8'));
  const s3Evidence = JSON.parse(await readFile(new URL('../config/esp32-resource-evidence/esp32-s3-3.3.6.json', root), 'utf8'));
  assert.notDeepEqual(classicEvidence.evidence.map(entry => entry.id), c3Evidence.evidence.map(entry => entry.id));
  assert.notDeepEqual(c3Evidence.evidence.map(entry => entry.id), c6Evidence.evidence.map(entry => entry.id));
  assert.notDeepEqual(c6Evidence.evidence.map(entry => entry.id), s3Evidence.evidence.map(entry => entry.id));

  // Core/board sources can legitimately be shared by several chips.  The
  // family-specific source path+hash pairs must nevertheless be independent;
  // this catches accidentally copying a C3 snapshot into the C6 model while
  // allowing common Arduino-ESP32 implementation evidence.
  const snapshots = [classicEvidence, c3Evidence, c6Evidence, s3Evidence];
  const allKeys = snapshots.map(snapshot => new Set(snapshot.evidence.map(evidenceKey)));
  const familySpecificPatterns = [
    /\/variants\/esp32\/|\/tools\/esp32-libs\//i,
    /\/variants\/esp32c3\/|\/tools\/esp32c3-libs\//i,
    /\/variants\/esp32c6\/|\/tools\/esp32c6-libs\//i,
    /\/variants\/esp32s3\/|\/tools\/esp32s3-libs\//i,
  ];
  const familySpecific = snapshots.map((snapshot, index) => {
    const entries = snapshot.evidence.filter(entry => familySpecificPatterns[index].test(entry.path));
    assert.ok(entries.length > 0, `missing family-specific evidence for snapshot ${index}`);
    return {
      keys: new Set(entries.map(evidenceKey)),
      paths: new Set(entries.map(entry => entry.path)),
      hashes: new Set(entries.map(entry => entry.sha256).filter(Boolean)),
    };
  });
  for (let left = 0; left < familySpecific.length; left += 1) {
    for (let right = left + 1; right < familySpecific.length; right += 1) {
      assert.deepEqual(setIntersection(familySpecific[left].keys, familySpecific[right].keys), [], `family evidence key overlap ${left}/${right}`);
      assert.deepEqual(setIntersection(familySpecific[left].paths, familySpecific[right].paths), [], `family evidence path overlap ${left}/${right}`);
      assert.deepEqual(setIntersection(familySpecific[left].hashes, familySpecific[right].hashes), [], `family evidence hash overlap ${left}/${right}`);
    }
  }

  // Keep the complete snapshot sets in scope so the test documents that
  // shared evidence is intentional rather than silently ignored.
  assert.ok(allKeys.every(set => set.size > 0));
  assert.equal(productionModule.analyzeProductionResolvedResources(classic, workspace(digitalBlock('classic'))).model.identity.mcu, 'esp32');
  assert.equal(productionModule.analyzeProductionResolvedResources(c3, workspace(digitalBlock('c3'))).model.identity.mcu, 'esp32c3');
  assert.equal(productionModule.analyzeProductionResolvedResources(c6, workspace(digitalBlock('c6'))).model.identity.mcu, 'esp32c6');
  assert.equal(productionModule.analyzeProductionResolvedResources(s3, workspace(digitalBlock('s3'))).model.identity.mcu, 'esp32s3');
});
