import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import { join } from 'node:path';
import { loadResourceModule } from './resource_test_loader.mjs';

const root = fileURLToPath(new URL('../../../../', import.meta.url));
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { resolveEsp32FamilyResourceModel } = await loadResourceModule('./esp32_resource_family.ts');

const packageCases = [
  { id: 'ck_hw_aht20', fields: { VALUE: '0' }, kind: 'i2c' },
  { id: 'ck_hw_mpu6050', fields: { VALUE: '0', ADDRESS: '0x68' }, kind: 'i2c' },
  { id: 'ck_hw_lcd1602_i2c', fields: { ADDRESS: '0x27', TEXT: 'CK' }, kind: 'i2c' },
  { id: 'ck_hw_mfrc522', fields: { SS: '10', RST: '9' }, kind: 'spi' },
  { id: 'ck_hw_dht11', fields: { PIN: '2', VALUE: '0' }, kind: 'gpio' },
  { id: 'ck_hw_dht22', fields: { PIN: '2', VALUE: '0' }, kind: 'gpio' },
  { id: 'ck_hw_ws2812', fields: { PIN: '6', COUNT: '8', INDEX: '0', R: '255', G: '0', B: '0' }, kind: 'gpio' },
  { id: 'ck_hw_relay', fields: { PIN: '3', LEVEL: 'HIGH' }, kind: 'gpio' },
];

const block = (id, type, fields) => ({
  id,
  type,
  getFieldValue: name => fields[name],
  getInputTargetBlock: () => null,
});

async function loadCase(item) {
  const manifest = JSON.parse(await readFile(join(root, 'packages', 'block-libraries', item.id, 'ck-blocks.json'), 'utf8'));
  const definition = manifest.blocks[0];
  return {
    ...item,
    manifest,
    definition,
    catalog: [{
      type: definition.type,
      library_id: manifest.id,
      metadata_source: 'v2',
      fields: (definition.fields || []).map(field => ({ name: field.name })),
      inputs: (definition.inputs || []).map(input => ({ name: input.name })),
      hardware: { claims: definition.hardware.claims },
    }],
  };
}

const unoIdentity = {
  fqbn: 'arduino:avr:uno', options: {}, mcu: 'atmega328p', variant: 'standard',
  coreVersion: '1.8.8', fCpu: '16000000L',
};
const c3Identity = {
  fqbn: 'esp32:esp32:esp32c3', options: {}, mcu: 'esp32c3', variant: 'esp32c3',
  coreVersion: '3.3.6', fCpu: '160000000L',
};
const s3Identity = {
  fqbn: 'esp32:esp32:esp32s3', options: {}, mcu: 'esp32s3', variant: 'esp32s3',
  coreVersion: '3.3.6', fCpu: '240000000L',
};

test('common declarative hardware claims cover GPIO, I2C and SPI without generator parsing', async () => {
  const cases = await Promise.all(packageCases.map(loadCase));
  const boards = [
    ['uno', resolveAvrResourceModel(unoIdentity)],
    ['c3', resolveEsp32FamilyResourceModel(c3Identity)],
    ['s3', resolveEsp32FamilyResourceModel(s3Identity)],
  ];
  for (const [boardName, model] of boards) {
    assert.equal(model.status, 'ready', `${boardName} model must be ready`);
    for (const item of cases) {
      const result = analyzeDeclaredHardware(model, item.catalog, [block(`${item.id}:${boardName}`, item.definition.type, item.fields)]);
      assert.ok(result.claims.length >= 1, `${item.id} must produce a claim on ${boardName}`);
      assert.equal(result.report.conflicts.length, 0, `${item.id} unexpectedly conflicts on ${boardName}`);
      assert.equal(result.gaps.length, 0, `${item.id} has unresolved claim gaps on ${boardName}: ${JSON.stringify(result.gaps)}`);
      if (item.kind === 'i2c') assert.ok(result.claims.some(claim => claim.role === 'i2c-device'));
      if (item.kind === 'spi') {
        assert.ok(result.claims.some(claim => claim.role === 'spi-device'));
        assert.ok(result.claims.some(claim => claim.role === 'chip-select'));
      }
      if (item.id === 'ck_hw_dht11' || item.id === 'ck_hw_dht22') {
        assert.ok(result.claims.some(claim => claim.role === 'digital-input'));
        assert.ok(!result.claims.some(claim => /^timer/i.test(claim.resource)));
      }
      if (item.id === 'ck_hw_ws2812') {
        assert.ok(result.claims.some(claim => claim.role === 'digital-output'));
        assert.ok(!result.claims.some(claim => /^timer/i.test(claim.resource)));
      }
      if (item.id === 'ck_hw_relay') {
        assert.ok(result.claims.some(claim => claim.role === 'digital-output'));
        assert.ok(!result.claims.some(claim => /^timer/i.test(claim.resource)));
      }
      if (item.id === 'ck_hw_aht20') assert.ok(result.claims.some(claim => claim.discriminator === '56'), 'AHT20 source-fixed 0x38 address must remain stable');
    }
  }
});

test('I2C address and SPI chip-select discriminators produce real conflicts', async () => {
  const [mpu, mfrc] = await Promise.all([
    loadCase(packageCases[1]),
    loadCase(packageCases[3]),
  ]);
  const model = resolveEsp32FamilyResourceModel(c3Identity);
  const mpuA = block('mpu-a', mpu.definition.type, mpu.fields);
  const mpuB = block('mpu-b', mpu.definition.type, mpu.fields);
  const i2c = analyzeDeclaredHardware(model, mpu.catalog, [mpuA, mpuB]);
  assert.ok(i2c.report.conflicts.some(conflict => conflict.code === 'discriminator-conflict'));
  const spiA = block('spi-a', mfrc.definition.type, mfrc.fields);
  const spiB = block('spi-b', mfrc.definition.type, mfrc.fields);
  const spi = analyzeDeclaredHardware(model, mfrc.catalog, [spiA, spiB]);
  assert.ok(spi.report.conflicts.some(conflict => conflict.code === 'discriminator-conflict'));
});

test('Servo claim binds only its signal pin and stays partial without timer/provider evidence', async () => {
  const item = {
    id: 'ck_hw_servo',
    fields: { PIN: '9', ANGLE: '90' },
    kind: 'servo',
  };
  const loaded = await loadCase(item);
  const result = analyzeDeclaredHardware(
    resolveAvrResourceModel(unoIdentity),
    loaded.catalog,
    [block('servo-1', loaded.definition.type, loaded.fields)],
  );

  assert.ok(result.claims.some(claim => claim.role === 'servo-signal' && claim.resource === 'gpio.9'));
  assert.ok(result.gaps.some(gap => gap.code === 'incomplete-claim-declaration'));
  assert.equal(result.report.coverage, 'partial');
  assert.ok(result.claims.every(claim => !/^timer/i.test(claim.resource)));
  assert.ok(result.claims.every(claim => claim.role !== 'servo-timer'));
});
