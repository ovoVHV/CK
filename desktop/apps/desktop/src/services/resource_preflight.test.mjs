import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const preflightModule = await loadResourceModule('./resource_preflight.ts');
const inspectorModule = await loadResourceModule('./hardware_resource_inspector.ts');
const graphModule = await loadResourceModule('./hardware_resource_graph.ts');
const avrModelModule = await loadResourceModule('./avr_resource_model.ts');
const avrClaimsModule = await loadResourceModule('./avr_builtin_resource_claims.ts');

const { buildResourcePreflight, runResourcePreflight } = preflightModule;
const { buildHardwareResourceInspector } = inspectorModule;
const { analyzeHardwareResources } = graphModule;

const literal = (type, field, value) => ({
  id: `literal:${field}`,
  type,
  getFieldValue: name => name === field ? value : undefined,
  getInputTargetBlock: () => null,
});
const block = (id, type, fields = {}, inputs = {}) => ({
  id,
  type,
  getFieldValue: name => fields[name],
  getInputTargetBlock: name => inputs[name] ?? null,
});
const workspace = (...blocks) => ({ getAllBlocks: () => blocks });

const unoIdentity = {
  fqbn: 'arduino:avr:uno',
  options: {},
  mcu: 'atmega328p',
  variant: 'standard',
  coreVersion: '1.8.8',
  fCpu: '16000000L',
};

test('missing resolved identity is unavailable and never guesses a board', () => {
  const report = runResourcePreflight({ phase: 'edit', workspace: workspace() });
  assert.equal(report.status, 'unavailable');
  assert.equal(report.reasonCode, 'missing-resolved-identity');
  assert.equal(report.source, 'none');
});

test('normal Uno digital output gets a resource-analysis pass without SPI usage inference', () => {
  const report = runResourcePreflight({
    phase: 'edit',
    resolvedIdentity: unoIdentity,
    workspace: workspace(block('d13', 'io_digital_write', {}, {
      PIN: literal('board_pin_selector', 'PIN', '13'),
    })),
  });
  assert.equal(report.available, true);
  assert.equal(report.source, 'resource-analysis');
  assert.notEqual(report.status, 'conflict');
  assert.equal(report.issues.some(issue => issue.code === 'exclusive-conflict'), false);
});

test('existing conflict is projected with claims, bindings, evidence and source references', () => {
  const graph = {
    version: 1,
    coverage: 'full',
    resources: [{ id: 'TIMER1', type: 'timer', sharing: 'exclusive', evidence: ['core'] }],
    routes: [],
    evidence: [{ id: 'core', source: 'core', confidence: 'verified' }],
  };
  const claims = [
    { id: 'servo', owner: 'servo', reference: 'block:servo-1', resource: 'TIMER1', role: 'servo', exclusive: true },
    { id: 'pwm', owner: 'pwm', reference: 'block:pwm-1', resource: 'TIMER1', role: 'hardware-pwm', exclusive: true },
  ];
  const analysis = analyzeHardwareResources(graph, claims);
  const inspector = buildHardwareResourceInspector({ graph, analysis, claims });
  const report = buildResourcePreflight({ phase: 'compile', analysis, inspector, checkedAt: '2026-09-22T00:00:00.000Z' });
  assert.equal(report.status, 'conflict');
  const issue = report.issues.find(item => item.code === 'exclusive-conflict');
  assert.ok(issue);
  assert.deepEqual(issue.claimIds.sort(), ['pwm', 'servo']);
  assert.deepEqual(issue.blockReferences.sort(), ['block:pwm-1', 'block:servo-1']);
  assert.equal(issue.bindings.length, 2);
  assert.equal(issue.evidence[0].id, 'core');
  assert.equal(issue.canLocate, true);
});

test('shared I2C devices produce a positive shared-bus check, not a duplicate-use warning', () => {
  const graph = {
    version: 1,
    coverage: 'full',
    resources: [{ id: 'I2C0', type: 'i2c-controller', sharing: 'address', evidence: ['core'] }],
    routes: [],
    evidence: [{ id: 'core', source: 'core', confidence: 'verified' }],
  };
  const claims = [
    { id: 'oled', owner: 'oled', reference: 'block:oled', resource: 'I2C0', role: 'i2c-device', discriminator: '0x3C', segment: 'i2c0' },
    { id: 'aht', owner: 'aht20', reference: 'block:aht', resource: 'I2C0', role: 'i2c-device', discriminator: '0x38', segment: 'i2c0' },
  ];
  const analysis = analyzeHardwareResources(graph, claims);
  const inspector = buildHardwareResourceInspector({ graph, analysis, claims });
  const report = buildResourcePreflight({ phase: 'compile', analysis, inspector });
  assert.equal(report.issues.length, 0);
  assert.ok(report.checks.some(check => check.code === 'shared-bus-addresses' && check.severity === 'pass'));
});

test('shared SPI devices produce one shared-bus pass and no duplicate-use warning', () => {
  const graph = {
    version: 1,
    coverage: 'full',
    resources: [{ id: 'vendor.spi0', type: 'spi-controller', sharing: 'selector', evidence: ['vendor-core'] }],
    routes: [],
    evidence: [{ id: 'vendor-core', source: 'vendor-core-resource-definition', confidence: 'verified' }],
  };
  const claims = [
    { id: 'sd', owner: 'storage', reference: 'block:sd', resource: 'vendor.spi0', role: 'spi-device', discriminator: 'gpio.10' },
    { id: 'tft', owner: 'display', reference: 'block:tft', resource: 'vendor.spi0', role: 'spi-device', discriminator: 'gpio.8' },
  ];
  const analysis = analyzeHardwareResources(graph, claims);
  const inspector = buildHardwareResourceInspector({ graph, analysis, claims });
  const report = buildResourcePreflight({ phase: 'compile', analysis, inspector });
  assert.equal(analysis.conflicts.length, 0);
  assert.equal(report.status, 'pass');
  assert.equal(report.issues.length, 0);
  assert.ok(report.checks.some(check => check.code === 'shared-bus' && check.status === 'pass'));
  assert.equal(report.checks.some(check => check.code === 'discriminator-conflict'), false);
});

test('USB Serial/JTAG exclusive conflict is surfaced with resource and source blocks', () => {
  const graph = {
    version: 1,
    coverage: 'full',
    resources: [{ id: 'vendor.usb-serial-jtag', type: 'usb-serial-jtag-controller', sharing: 'exclusive', evidence: ['vendor-usb'] }],
    routes: [],
    evidence: [{ id: 'vendor-usb', source: 'vendor-usb-resource-definition', confidence: 'verified' }],
  };
  const claims = [
    { id: 'console-a', owner: 'console-a', reference: 'block:console-a', resource: 'vendor.usb-serial-jtag', role: 'usb-serial-jtag', exclusive: true },
    { id: 'console-b', owner: 'console-b', reference: 'block:console-b', resource: 'vendor.usb-serial-jtag', role: 'usb-serial-jtag', exclusive: true },
  ];
  const analysis = analyzeHardwareResources(graph, claims);
  const inspector = buildHardwareResourceInspector({ graph, analysis, claims });
  const report = buildResourcePreflight({ phase: 'compile', analysis, inspector });
  assert.ok(inspector.usbSerialJtag.some(resource => resource.id === 'vendor.usb-serial-jtag'));
  assert.equal(report.status, 'conflict');
  const issue = report.issues.find(item => item.code === 'exclusive-conflict' && item.resource === 'vendor.usb-serial-jtag');
  assert.ok(issue);
  assert.deepEqual(issue.claimIds.sort(), ['console-a', 'console-b']);
  assert.deepEqual(issue.blockReferences.sort(), ['block:console-a', 'block:console-b']);
  assert.equal(issue.canLocate, true);
});

test('a fully non-built-in third-party graph projects through the same preflight path', () => {
  const graph = {
    version: 1,
    coverage: 'full',
    resources: [
      { id: 'acme.board.sensor-bus', type: 'spi-controller', aliases: ['ACME-SPI'], sharing: 'selector', evidence: ['acme-spec'] },
      { id: 'acme.board.cs-a', type: 'gpio', sharing: 'exclusive', evidence: ['acme-spec'] },
      { id: 'acme.board.cs-b', type: 'gpio', sharing: 'exclusive', evidence: ['acme-spec'] },
    ],
    routes: [],
    evidence: [{ id: 'acme-spec', source: 'acme-board-resource-package', confidence: 'declared' }],
  };
  const claims = [
    { id: 'acme-device-a', owner: 'acme-display', reference: 'block:acme-display', resource: 'acme.board.sensor-bus', role: 'spi-device', discriminator: 'acme.board.cs-a' },
    { id: 'acme-device-b', owner: 'acme-storage', reference: 'block:acme-storage', resource: 'acme.board.sensor-bus', role: 'spi-device', discriminator: 'acme.board.cs-b' },
  ];
  const analysis = analyzeHardwareResources(graph, claims);
  const inspector = buildHardwareResourceInspector({ graph, analysis, claims });
  const report = buildResourcePreflight({ phase: 'edit', analysis, inspector });
  assert.equal(report.available, true);
  assert.equal(report.source, 'resource-analysis');
  assert.equal(report.status, 'pass');
  assert.equal(report.issues.length, 0);
  assert.ok(inspector.buses.some(bus => bus.id === 'acme.board.sensor-bus' && bus.devices.length === 2));
  assert.ok(inspector.resourceTraces.some(trace => trace.resourceId === 'acme.board.sensor-bus'));
  assert.ok(report.checks.some(check => check.code === 'shared-bus' && check.resource === 'acme.board.sensor-bus'));
});

test('partial coverage never becomes a verified-safe pass', () => {
  const graph = {
    version: 1,
    coverage: 'partial',
    resources: [{ id: 'GPIO13', type: 'gpio', sharing: 'shared', evidence: [] }],
    routes: [],
    evidence: [],
  };
  const analysis = { coverage: 'partial', bindings: [], conflicts: [], gaps: [], usages: [] };
  const inspector = buildHardwareResourceInspector({ graph, analysis });
  const report = buildResourcePreflight({ phase: 'edit', analysis, inspector });
  assert.equal(report.status, 'warning');
  assert.ok(report.issues.some(issue => issue.code === 'coverage-partial'));
  assert.equal(report.checks.some(check => check.code === 'resource-analysis-complete'), false);
});
