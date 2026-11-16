import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const graphModule = await loadResourceModule('./hardware_resource_graph.ts');
const inspectorModule = await loadResourceModule('./hardware_resource_inspector.ts');
const { analyzeHardwareResources: analyze } = graphModule;
const { buildHardwareResourceInspector: buildInspector } = inspectorModule;

function fixtureGraph() {
  return {
    version: 1,
    resources: [
      { id: 'gpio.13', type: 'gpio', aliases: ['13', 'SCK'], capabilities: ['digital-input', 'digital-output', 'SCK'], sharing: 'exclusive', evidence: ['fixture.gpio'] },
      { id: 'gpio.21', type: 'gpio', aliases: ['21', 'SDA'], capabilities: ['digital-input', 'digital-output'], sharing: 'exclusive', evidence: ['fixture.gpio'] },
      { id: 'gpio.22', type: 'gpio', aliases: ['22', 'SCL'], capabilities: ['digital-input', 'digital-output'], sharing: 'exclusive', evidence: ['fixture.gpio'] },
      { id: 'timer1', type: 'timer', sharing: 'exclusive', evidence: ['fixture.timer'] },
      { id: 'timer1.channelA', type: 'pwm-channel', parent: 'timer1', sharing: 'exclusive', evidence: ['fixture.timer'] },
      { id: 'spi0', type: 'spi-controller', aliases: ['SPI0'], sharing: 'selector', evidence: ['fixture.bus'] },
      { id: 'i2c0', type: 'i2c-controller', aliases: ['I2C0'], sharing: 'address', evidence: ['fixture.bus'] },
    ],
    routes: [
      { id: 'spi0.sck', resource: 'spi0', signal: 'sck', mode: 'fixed', pins: ['gpio.13'] },
      { id: 'i2c0.sda', resource: 'i2c0', signal: 'sda', mode: 'selectable', pins: ['gpio.21'] },
      { id: 'i2c0.scl', resource: 'i2c0', signal: 'scl', mode: 'selectable', pins: ['gpio.22'] },
    ],
    evidence: [
      { id: 'fixture.gpio', source: 'fixture://board/gpio', confidence: 'verified' },
      { id: 'fixture.timer', source: 'fixture://board/timer', confidence: 'verified' },
      { id: 'fixture.bus', source: 'fixture://board/bus', confidence: 'declared' },
    ],
    coverage: 'full',
  };
}

function fixtureClaims() {
  return [
    { id: 'claim:digital', owner: 'ck.builtin', reference: 'block-digital', resource: 'gpio.13', role: 'digital-output' },
    { id: 'claim:servo', owner: 'vendor.servo', reference: 'block-servo', resource: 'timer1', role: 'servo', exclusive: true },
    { id: 'claim:pwm', owner: 'ck.builtin', reference: 'block-pwm', resource: 'timer1.channelA', role: 'hardware-pwm' },
    { id: 'claim:oled', owner: 'vendor.oled', reference: 'OLED', resource: 'i2c0', role: 'i2c-device', discriminator: '60', segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' } },
    { id: 'claim:aht20', owner: 'vendor.aht20', reference: 'AHT20', resource: 'i2c0', role: 'i2c-device', discriminator: '56', segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' } },
  ];
}

test('conflict card source data retains both claims and their binding path', () => {
  const graph = fixtureGraph();
  const claims = fixtureClaims();
  const report = analyze(graph, claims);
  assert.ok(report.conflicts.some(conflict => conflict.code === 'exclusive-conflict' && conflict.resource === 'timer1'));

  const view = buildInspector({ graph, analysis: report, claims });
  const card = view.conflictTraces.find(trace => trace.resourceId === 'timer1' && trace.conflict.code === 'exclusive-conflict');
  assert.ok(card, 'the presentation layer must expose an existing analyzer conflict');
  assert.deepEqual(card.conflict.claims, ['claim:servo', 'claim:pwm']);
  assert.deepEqual(card.claims.map(claim => claim.id), ['claim:servo', 'claim:pwm']);
  assert.ok(card.bindings.some(binding => binding.claimId === 'claim:servo' && binding.direct));
  assert.ok(card.bindings.some(binding => binding.claimId === 'claim:pwm' && !binding.direct && binding.ancestors.includes('timer1')));
  assert.deepEqual(card.blockReferences.sort(), ['block-pwm', 'block-servo']);
  assert.equal(card.resourceType, 'timer');
  assert.ok(card.evidence.every(item => item.confidence === 'verified'));
});

test('resource trace exposes capability, current usage, claim, binding, reference, conflict and evidence without inference', () => {
  const graph = fixtureGraph();
  const claims = fixtureClaims();
  const report = analyze(graph, claims);
  const before = JSON.stringify({ graph, claims });
  const view = buildInspector({ graph, analysis: report, claims });
  const trace = view.resourceTraces.find(item => item.resourceId === 'timer1');
  assert.ok(trace);
  assert.deepEqual(trace.capabilities, []);
  assert.equal(trace.currentUsage.some(item => item.reference === 'block-servo' && item.direct), true);
  assert.equal(trace.currentUsage.some(item => item.reference === 'block-pwm' && !item.direct), true);
  assert.equal(trace.claims.some(item => item.id === 'claim:pwm' && item.reference === 'block-pwm'), true);
  assert.equal(trace.bindings.some(item => item.claimId === 'claim:pwm' && item.ancestors.includes('timer1')), true);
  assert.deepEqual(trace.blockReferences.sort(), ['block-pwm', 'block-servo']);
  assert.equal(trace.conflicts.length, 1);
  assert.equal(trace.status, 'conflict');
  assert.equal(view.traces, view.resourceTraces, 'short trace alias must point at the same read-only records');
  assert.equal(JSON.stringify({ graph, claims }), before, 'projection must not mutate graph or claims');
});

test('expanded bus view groups addressed devices and preserves selectable route uncertainty', () => {
  const graph = fixtureGraph();
  const claims = fixtureClaims();
  const report = analyze(graph, claims);
  const view = buildInspector({ graph, analysis: report, claims });
  const bus = view.buses.find(item => item.id === 'i2c0');
  assert.ok(bus);
  assert.equal(bus.status, 'normal-sharing');
  assert.equal(bus.devices.length, 2);
  assert.deepEqual(bus.devices.map(device => [device.reference, device.address, device.segment]), [
    ['OLED', '60', 'i2c0'],
    ['AHT20', '56', 'i2c0'],
  ]);
  assert.deepEqual(bus.signals.map(signal => [signal.signal, signal.mode, signal.selectedPins]), [
    ['sda', 'selectable', ['gpio.21']],
    ['scl', 'selectable', ['gpio.22']],
  ]);
  assert.equal(bus.conflicts.length, 0);
  assert.equal(bus.currentUsage.length, 2);
});

