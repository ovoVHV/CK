import assert from 'node:assert/strict';
import test from 'node:test';
import { loadResourceModule } from './resource_test_loader.mjs';

const inspectorModule = await loadResourceModule('./hardware_resource_inspector.ts');
const graphModule = await loadResourceModule('./hardware_resource_graph.ts');
const avrModelModule = await loadResourceModule('./avr_resource_model.ts');
const avrClaimsModule = await loadResourceModule('./avr_builtin_resource_claims.ts');
const c3ModelModule = await loadResourceModule('./esp32_c3_resource_model.ts');
const c3ClaimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const classicModelModule = await loadResourceModule('./esp32_resource_model.ts');
const classicClaimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const bindingModule = await loadResourceModule('./resource_claim_binding.ts');

const { buildHardwareResourceInspector: buildInspector } = inspectorModule;
const { analyzeHardwareResources: analyze } = graphModule;

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
const c3Identity = {
  fqbn: 'esp32:esp32:esp32c3',
  options: {},
  mcu: 'esp32c3',
  variant: 'esp32c3',
  coreVersion: '3.3.6',
  fCpu: '160000000L',
};
const classicIdentity = {
  fqbn: 'esp32:esp32:esp32',
  options: {},
  mcu: 'esp32',
  variant: 'esp32',
  coreVersion: '3.3.6',
  fCpu: '240000000L',
};

test('Uno D13 keeps SPI capability separate from digital current usage', () => {
  const model = avrModelModule.resolveAvrResourceModel(unoIdentity);
  assert.equal(model.status, 'ready');
  const result = avrClaimsModule.analyzeAvrWorkspaceResources(unoIdentity, workspace(
    block('d13', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13') }),
  ));
  assert.equal(result.status, 'ready');
  const view = buildInspector({ graph: model.resource_graph, analysis: result.report, claims: result.claims, coverage: result.coverage });
  const pin = view.pins.find(item => item.id === 'gpio.13');
  assert.ok(pin, 'D13 must be visible as a pin record');
  assert.ok(pin.capabilities.includes('SCK'), 'SPI SCK remains a capability');
  assert.ok(pin.currentUsage.some(usage => usage.role === 'digital-output'), 'digital output is current usage');
  assert.equal(pin.currentUsage.some(usage => usage.role === 'spi.sck'), false, 'capability must not become usage');
  assert.equal(pin.relatedResources.some(route => route.resource === 'spi' && route.signal === 'sck'), true);
  assert.equal(pin.referenceCount, 1);
});

test('C3 USB Serial/JTAG is an independent controller, not a UART', () => {
  const cdcIdentity = { ...c3Identity, options: { CDCOnBoot: 'cdc' } };
  const model = c3ModelModule.resolveEsp32C3ResourceModel(cdcIdentity);
  const result = c3ClaimsModule.analyzeEsp32WorkspaceResources(cdcIdentity, workspace(
    block('usb', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(result.status, 'ready', 'claim adapter returns report data for a ready model');
  const view = buildInspector({ graph: model.resource_graph, analysis: result.report, claims: result.claims, gaps: result.gaps });
  const usb = view.usbSerialJtag.find(item => item.id === 'usb-serial-jtag');
  assert.ok(usb, 'USB Serial/JTAG must have its own inspector section');
  assert.ok(usb.currentUsage.some(usage => usage.role === 'hardware-serial'));
  assert.equal(view.uarts.some(item => item.id === 'usb-serial-jtag'), false);
  assert.equal(view.uarts.some(item => item.currentUsage.some(usage => usage.role === 'hardware-serial')), false);
  assert.deepEqual(usb.signals.map(signal => [signal.signal, signal.fixedPin]), [
    ['dm', 'gpio.18'],
    ['dp', 'gpio.19'],
  ]);
});

test('classic ESP32 LEDC remains dynamic/unresolved instead of inventing a channel', () => {
  const model = classicModelModule.resolveEsp32ResourceModel(classicIdentity);
  const result = classicClaimsModule.analyzeEsp32WorkspaceResources(classicIdentity, workspace(
    block('pwm', 'io_analog_write', {}, {
      PIN: literal('board_pin_selector', 'PIN', '13'),
      VALUE: literal('math_number', 'NUM', '128'),
    }),
  ));
  const view = buildInspector({ graph: model.resource_graph, analysis: result.report, claims: result.claims, gaps: result.gaps });
  const ledc = view.timers.find(item => item.id === 'ledc');
  assert.ok(ledc, 'LEDC controller must be visible in timer/PWM inspector');
  assert.equal(ledc.allocation, 'dynamic-unresolved');
  assert.equal(ledc.consumers.some(consumer => consumer.assignedChannel !== undefined), false, 'channel is not selected by the graph');
  assert.ok(view.gaps.some(gap => gap.code === 'dynamic-ledc-channel-unresolved'));
});

test('UART inspector exposes fixed RX/TX and keeps controller usage separate from pins', () => {
  const model = avrModelModule.resolveAvrResourceModel(unoIdentity);
  const result = avrClaimsModule.analyzeAvrWorkspaceResources(unoIdentity, workspace(
    block('serial', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  const view = buildInspector({ graph: model.resource_graph, analysis: result.report, claims: result.claims, gaps: result.gaps });
  const uart = view.uarts.find(item => item.id === 'uart0');
  assert.ok(uart);
  assert.equal(uart.rx, 'gpio.0');
  assert.equal(uart.tx, 'gpio.1');
  assert.ok(uart.usedBy.some(usage => usage.role === 'hardware-uart'));
  assert.equal(view.usbSerialJtag.length, 0);
});

test('timer inspector shows an existing Servo/PWM conflict without inferring allocation', () => {
  const model = avrModelModule.resolveAvrResourceModel(unoIdentity);
  const claims = [
    { id: 'servo', owner: 'fixture', reference: 'Servo', resource: 'TIMER2', role: 'servo', exclusive: true },
    { id: 'pwm', owner: 'fixture', reference: 'PWM', resource: 'TIMER2B', role: 'hardware-pwm' },
  ];
  const report = analyze(model.resource_graph, claims);
  const view = buildInspector({ graph: model.resource_graph, analysis: report, claims });
  const timer = view.timers.find(item => item.id === 'TIMER2');
  assert.ok(timer);
  assert.equal(timer.status, 'conflict');
  assert.ok(timer.consumers.some(consumer => consumer.reference === 'Servo'));
  assert.ok(timer.consumers.some(consumer => consumer.assignedChannel === 'TIMER2B'));
  assert.equal(report.conflicts.some(conflict => conflict.code === 'exclusive-conflict' && conflict.resource === 'TIMER2'), true);
});

test('I2C inspector presents one shared bus with multiple addressed devices', () => {
  const model = classicModelModule.resolveEsp32ResourceModel(classicIdentity);
  const i2cClaims = [
    { id: 'oled', owner: 'display', reference: 'OLED', resource: 'i2c0', role: 'i2c-device', discriminator: '60', segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' } },
    { id: 'aht20', owner: 'sensor', reference: 'AHT20', resource: 'i2c0', role: 'i2c-device', discriminator: '56', segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' } },
    { id: 'mpu6050', owner: 'imu', reference: 'MPU6050', resource: 'i2c0', role: 'i2c-device', discriminator: '104', segment: 'i2c0', signals: { sda: 'gpio.21', scl: 'gpio.22' } },
  ];
  const report = analyze(model.resource_graph, i2cClaims);
  assert.equal(report.conflicts.length, 0);
  const view = buildInspector({ graph: model.resource_graph, analysis: report, claims: i2cClaims });
  const bus = view.buses.find(item => item.id === 'i2c0');
  assert.ok(bus);
  assert.equal(bus.devices.length, 3);
  assert.equal(bus.status, 'normal-sharing');
  assert.deepEqual(bus.signals.filter(signal => signal.signal === 'sda')[0].selectedPins, ['gpio.21']);
  assert.deepEqual(bus.signals.filter(signal => signal.signal === 'scl')[0].selectedPins, ['gpio.22']);
  assert.deepEqual(bus.devices.map(device => device.reference), ['OLED', 'AHT20', 'MPU6050']);
});

test('SPI inspector presents one shared bus and separate chip-select consumers', () => {
  const model = classicModelModule.resolveEsp32ResourceModel(classicIdentity);
  const spiClaims = [
    // Chip-select identity is retained as the selector discriminator.  Since
    // no existing claim selected a CS route, the inspector must not invent
    // one; the current graph remains a shared bus with an unresolved route.
    { id: 'sd', owner: 'storage', reference: 'SD Card', resource: 'spi3', role: 'spi-device', discriminator: 'gpio.5', signals: { sck: 'gpio.18', mosi: 'gpio.23', miso: 'gpio.19' } },
    { id: 'tft', owner: 'display', reference: 'TFT', resource: 'spi3', role: 'spi-device', discriminator: 'gpio.25', signals: { sck: 'gpio.18', mosi: 'gpio.23', miso: 'gpio.19' } },
  ];
  const report = analyze(model.resource_graph, spiClaims);
  assert.equal(report.conflicts.length, 0);
  const view = buildInspector({ graph: model.resource_graph, analysis: report, claims: spiClaims });
  const bus = view.buses.find(item => item.id === 'spi3');
  assert.ok(bus);
  assert.equal(bus.kind, 'spi');
  assert.equal(bus.status, 'shared-bus');
  assert.equal(bus.devices.length, 2);
  assert.deepEqual(bus.devices.map(device => device.reference), ['SD Card', 'TFT']);
  assert.deepEqual(bus.signals.find(signal => signal.signal === 'sck').selectedPins, ['gpio.18']);
  assert.deepEqual(bus.devices.map(device => device.address), ['gpio.5', 'gpio.25']);
  assert.deepEqual(bus.signals.find(signal => signal.signal === 'cs').selectedPins, [], 'unresolved CS route must not be guessed');
});

test('coverage projection preserves partial, full, and unknown states', () => {
  const makeGraph = coverage => ({
    version: 1,
    resources: [{ id: 'fixture.gpio', type: 'gpio', sharing: 'exclusive', evidence: ['fixture'] }],
    routes: [],
    evidence: [{ id: 'fixture', source: 'synthetic-inspector-fixture', confidence: 'declared' }],
    coverage,
  });
  for (const state of ['partial', 'full', 'unknown']) {
    const view = buildInspector({
      graph: makeGraph(state),
      coverage: {
        declarationCoverage: state,
        analysisCoverage: state,
        projectCoverage: state,
        hardwareEvidence: 'source-verified',
        hardwareValidation: 'not-tested',
      },
    });
    assert.equal(view.coverage.graph, state);
    assert.equal(view.coverage.analysis, state);
    assert.equal(view.coverage.declaration, state);
    assert.equal(view.coverage.project, state);
    assert.equal(view.coverage.hardwareValidation, 'not-tested');
    assert.equal(view.coverage.evidence.status, 'declared');
  }
});

test('third-party board graph is rendered through the generic inspector projection', () => {
  const graph = {
    version: 1,
    resources: [
      { id: 'vendor.gpio.a', type: 'gpio', aliases: ['VGPIO_A'], sharing: 'exclusive', capabilities: ['digital-input'], evidence: ['vendor-spec'] },
      { id: 'vendor.gpio.b', type: 'gpio', aliases: ['VGPIO_B'], sharing: 'exclusive', capabilities: ['digital-input'], evidence: ['vendor-spec'] },
      { id: 'vendor.i2c0', type: 'i2c-controller', aliases: ['VendorWire'], sharing: 'address', capabilities: ['gpio-matrix'], evidence: ['vendor-spec'] },
    ],
    routes: [
      { id: 'vendor.i2c0.sda', resource: 'vendor.i2c0', signal: 'sda', mode: 'selectable', pins: ['vendor.gpio.a'] },
      { id: 'vendor.i2c0.scl', resource: 'vendor.i2c0', signal: 'scl', mode: 'selectable', pins: ['vendor.gpio.b'] },
    ],
    evidence: [{ id: 'vendor-spec', source: 'vendor.example/board-resource.json', confidence: 'declared' }],
    coverage: 'full',
  };
  const entry = {
    type: 'vendor_sensor',
    library_id: 'vendor.example',
    metadata_source: 'v2',
    inputs: [{ name: 'BUS' }],
    hardware: { claims: { version: 1, coverage: 'full', templates: [{
      id: 'device',
      resource: { kind: 'input', name: 'BUS', valueType: 'id' },
      role: 'i2c-device',
      discriminator: { kind: 'fixed', valueType: 'integer', value: 66 },
      signals: {
        sda: { kind: 'fixed', valueType: 'id', value: 'vendor.gpio.a' },
        scl: { kind: 'fixed', valueType: 'id', value: 'vendor.gpio.b' },
      },
    }] } },
  };
  const vendorBlock = block('vendor-device', 'vendor_sensor', {}, { BUS: literal('text', 'TEXT', 'VendorWire') });
  const result = bindingModule.analyzeDeclaredHardware({ resource_graph: graph }, [entry], [vendorBlock]);
  assert.equal(result.gaps.length, 0);
  const view = buildInspector({ graph, analysis: result.report, claims: result.claims });
  const bus = view.buses.find(item => item.id === 'vendor.i2c0');
  assert.ok(bus);
  assert.equal(bus.devices.length, 1);
  assert.equal(bus.devices[0].reference, 'vendor-device');
  assert.equal(bus.devices[0].address, '66');
  assert.equal(view.pins.find(item => item.id === 'vendor.gpio.a').currentUsage.length, 1);
  assert.equal(view.coverage.evidence.status, 'declared');
});

test('resource trace links capability, current usage, binding, reference and conflict', () => {
  const graph = {
    version: 1,
    resources: [
      { id: 'gpio.13', type: 'gpio', aliases: ['13', 'SCK'], capabilities: ['digital-output', 'SPI.SCK'], sharing: 'exclusive', evidence: ['spec'] },
      { id: 'spi0', type: 'spi-controller', sharing: 'selector', evidence: ['spec'] },
    ],
    routes: [{ id: 'spi0.sck', resource: 'spi0', signal: 'sck', mode: 'fixed', pins: ['gpio.13'] }],
    evidence: [{ id: 'spec', source: 'fixture-board-spec', locator: 'table-1', confidence: 'verified' }],
    coverage: 'full',
  };
  const claims = [
    { id: 'digital-claim', owner: 'ck.builtin', reference: 'block:d13', resource: 'gpio.13', role: 'digital-output' },
    { id: 'spi-claim', owner: 'vendor.display', reference: 'block:tft', resource: 'spi0', role: 'spi-device', discriminator: 'cs.tft' },
  ];
  const report = analyze(graph, claims);
  assert.ok(report.conflicts.length > 0);
  const view = buildInspector({ graph, analysis: report, claims });
  assert.equal(view.traces, view.resourceTraces, 'short trace alias remains stable');
  const pin = view.resourceTraces.find(trace => trace.resourceId === 'gpio.13');
  assert.ok(pin);
  assert.deepEqual(pin.capabilities, ['digital-output', 'SPI.SCK']);
  assert.ok(pin.currentUsage.some(usage => usage.reference === 'block:d13' && usage.direct));
  assert.ok(pin.currentUsage.some(usage => usage.reference === 'block:tft' && usage.direct), 'the analyzer emitted a direct synthetic route binding for the SPI signal');
  assert.ok(pin.claims.some(claim => claim.reference === 'block:d13'));
  assert.ok(pin.claims.some(claim => claim.reference === 'block:tft'));
  assert.ok(pin.bindings.some(binding => binding.claimId === 'digital-claim' && binding.direct));
  assert.ok(pin.bindings.some(binding => binding.claim.resource === 'gpio.13' && binding.claim.role === 'spi0.sck' && !binding.direct));
  assert.deepEqual(pin.blockReferences.sort(), ['block:d13', 'block:tft']);
  assert.deepEqual(pin.evidence.map(item => [item.id, item.confidence]), [['spec', 'verified']]);
  assert.ok(pin.conflicts.length > 0);
  const conflict = view.conflictTraces.find(trace => trace.resourceId === 'gpio.13');
  assert.ok(conflict);
  assert.ok(conflict.claims.some(claim => claim.reference === 'block:d13'));
  assert.ok(conflict.claims.some(claim => claim.reference === 'block:tft'));
  assert.deepEqual(conflict.blockReferences.sort(), ['block:d13', 'block:tft']);
  assert.deepEqual(conflict.evidence.map(item => item.source), ['fixture-board-spec']);
});

test('parent timer trace includes inherited child binding and existing conflict only', () => {
  const graph = {
    version: 1,
    resources: [
      { id: 'timer1', type: 'hardware-timer', sharing: 'shared', capabilities: ['timer'], evidence: ['timer-spec'] },
      { id: 'timer1.channelA', type: 'pwm-channel', parent: 'timer1', sharing: 'exclusive', evidence: ['timer-spec'] },
    ],
    routes: [],
    evidence: [{ id: 'timer-spec', source: 'fixture-timer-spec', confidence: 'declared' }],
    coverage: 'partial',
  };
  const claims = [
    { id: 'servo', owner: 'servo-lib', reference: 'block:servo', resource: 'timer1', role: 'servo', exclusive: true },
    { id: 'pwm', owner: 'ck.builtin', reference: 'block:pwm', resource: 'timer1.channelA', role: 'hardware-pwm' },
  ];
  const report = analyze(graph, claims);
  const view = buildInspector({ graph, analysis: report, claims });
  const timer = view.resourceTraces.find(trace => trace.resourceId === 'timer1');
  assert.ok(timer);
  assert.equal(timer.status, 'conflict');
  assert.ok(timer.bindings.some(binding => binding.claimId === 'servo' && binding.direct));
  assert.ok(timer.bindings.some(binding => binding.claimId === 'pwm' && !binding.direct));
  assert.deepEqual(timer.blockReferences.sort(), ['block:pwm', 'block:servo']);
  const conflict = view.conflictTraces.find(trace => trace.resourceId === 'timer1');
  assert.ok(conflict);
  assert.deepEqual(conflict.claims.map(claim => claim.id).sort(), ['pwm', 'servo']);
});
