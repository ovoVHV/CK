import test from 'node:test';
import assert from 'node:assert/strict';
import { loadResourceModule } from './resource_test_loader.mjs';

const modelModule = await loadResourceModule('./esp32_resource_model.ts');
const claimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const bindingModule = await loadResourceModule('./resource_claim_binding.ts');
const productionModule = await loadResourceModule('./production_resource_analysis.ts');
const graphModule = await loadResourceModule('./hardware_resource_graph.ts');
const identity = { fqbn: 'esp32:esp32:esp32', options: {}, mcu: 'esp32', variant: 'esp32', coreVersion: '3.3.6', fCpu: '240000000L' };
const literal = (type, field, value) => ({ id: `literal:${field}`, type, getFieldValue: name => name === field ? value : undefined, getInputTargetBlock: () => null });
const block = (id, type, fields = {}, inputs = {}) => ({ id, type, getFieldValue: name => fields[name], getInputTargetBlock: name => inputs[name] ?? null });
const workspace = (...blocks) => ({ getAllBlocks: () => blocks });

test('classic ESP32 identity resolves only from compiler properties', () => {
  const model = modelModule.resolveEsp32ResourceModel(identity);
  assert.equal(model.status, 'ready');
  assert.equal(model.resource_graph.coverage, 'full');
  assert.ok(model.resource_graph.resources.some(r => r.id === 'gpio.34' && r.capabilities.includes('input-only')));
  assert.ok(model.resource_graph.resources.some(r => r.id === 'uart2' && r.aliases.includes('Serial2')));
  assert.ok(model.resource_graph.routes.some(r => r.id === 'i2c1.sda' && r.mode === 'selectable'));
  assert.equal(modelModule.resolveEsp32ResourceModel({ ...identity, fqbn: 'esp32:esp32:esp32c3' }).status, 'not-applicable');
});

test('board exposure distinguishes flash and optional PSRAM reservation', () => {
  const plain = modelModule.resolveEsp32ResourceModel(identity);
  const psram = modelModule.resolveEsp32ResourceModel({ ...identity, options: { PSRAM: 'enabled' } });
  assert.equal(plain.resource_graph.resources.find(r => r.id === 'gpio.16').reserved, false);
  assert.equal(psram.resource_graph.resources.find(r => r.id === 'gpio.16').reserved, true);
  assert.equal(plain.resource_graph.resources.find(r => r.id === 'gpio.6').reserved, true);
});

test('GPIO-matrix peripherals preserve defaults as metadata and expose selectable routes', () => {
  const model = modelModule.resolveEsp32ResourceModel(identity);
  const route = (resource, signal) => model.resource_graph.routes.find(r => r.resource === resource && r.signal === signal);
  assert.equal(route('i2c0', 'sda').mode, 'selectable');
  assert.equal(route('i2c1', 'sda').mode, 'selectable');
  assert.equal(route('uart0', 'rx').mode, 'selectable');
  assert.equal(route('uart0', 'tx').mode, 'selectable');
  assert.equal(route('uart0.cts', 'cts').mode, 'selectable');
  assert.equal(route('uart0.rts', 'rts').mode, 'selectable');
  assert.equal(route('spi2', 'sck').mode, 'selectable');
  assert.equal(route('spi3', 'miso').mode, 'selectable');
  assert.ok(model.resource_graph.resources.find(r => r.id === 'uart0').capabilities.includes('default-route.rx.gpio.3'));
  assert.ok(model.resource_graph.resources.find(r => r.id === 'i2c0').capabilities.includes('default-route.sda.gpio.21'));
  assert.ok(model.resource_graph.resources.find(r => r.id === 'spi3').capabilities.includes('default-route.sck.gpio.18'));
});

test('LEDC capability inventory reflects two groups, 16 channels and four timers per group', () => {
  const model = modelModule.resolveEsp32ResourceModel(identity);
  assert.deepEqual(model.ledc, { groups: 2, channelsPerGroup: 8, totalChannels: 16, timersPerGroup: 4, maxResolution: 20, allocation: 'dynamic' });
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'ledc-channel').length, 16);
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'ledc-timer').length, 8);
  assert.equal(model.resource_graph.resources.find(r => r.id === 'ledc.channel8').parent, 'ledc.group1');
});

test('formal route binding accepts custom I2C/UART/SPI pins without changing defaults', () => {
  const model = modelModule.resolveEsp32ResourceModel(identity);
  const customClaims = [
    { id: 'i2c-custom', owner: 'fixture.i2c', reference: 'fixture', resource: 'i2c0', role: 'i2c', discriminator: '0x3c', segment: 'i2c0', signals: { sda: 'gpio.25', scl: 'gpio.26' } },
    { id: 'uart-custom', owner: 'fixture.uart', reference: 'fixture', resource: 'uart0', role: 'uart', configuration: { baud: 115200 }, signals: { rx: 'gpio.16', tx: 'gpio.17' } },
    { id: 'uart-cts-custom', owner: 'fixture.uart', reference: 'fixture', resource: 'uart0.cts', role: 'uart-cts', configuration: { baud: 115200 }, signals: { cts: 'gpio.34' } },
    { id: 'uart-rts-custom', owner: 'fixture.uart', reference: 'fixture', resource: 'uart0.rts', role: 'uart-rts', configuration: { baud: 115200 }, signals: { rts: 'gpio.25' } },
    { id: 'spi-custom', owner: 'fixture.spi', reference: 'fixture', resource: 'spi2', role: 'spi', discriminator: 'gpio.27', signals: { sck: 'gpio.14', miso: 'gpio.12', mosi: 'gpio.13', cs: 'gpio.27' } },
  ];
  const report = graphModule.analyzeHardwareResources(model.resource_graph, customClaims);
  assert.equal(report.gaps.length, 0);
  assert.ok(report.bindings.some(b => b.resource.id === 'gpio.25'));
  assert.ok(report.bindings.some(b => b.resource.id === 'gpio.27'));
});

test('built-in digital output rejects input-only GPIO34', () => {
  const result = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('d34', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '34') })));
  assert.ok(result.gaps.some(g => g.code === 'input-only-gpio'));
  assert.equal(result.claims.length, 0);
});

test('ADC1 A0 claim resolves to the source-backed channel', () => {
  const result = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('adc', 'io_analog_read', {}, { PIN: literal('board_pin_selector', 'PIN', 'A0') })));
  assert.equal(result.gaps.length, 0);
  assert.equal(result.claims[0].resource, 'adc1.channel0');
});

test('LEDC PWM records the pin and an explicit dynamic-channel gap', () => {
  const result = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('pwm', 'io_analog_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13'), VALUE: literal('math_number', 'NUM', '128') })));
  assert.ok(result.claims.some(c => c.resource === 'gpio.13'));
  assert.ok(result.claims.some(c => c.resource === 'ledc'));
  assert.ok(result.gaps.some(g => g.code === 'dynamic-ledc-channel-unresolved'));
});

test('Serial1/Serial2 use stable UART resources and expose reserved defaults', () => {
  const serial1 = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('s1', 'serial_setup_with_pins', { PORT: 'Serial1' }, { BAUD: literal('math_number', 'NUM', '115200') })));
  assert.equal(serial1.claims[0].resource, 'uart1');
  assert.ok(serial1.report.conflicts.some(c => c.resource === 'gpio.9'));
  const serial2 = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('s2', 'serial_setup_with_pins', { PORT: 'Serial2' }, { BAUD: literal('math_number', 'NUM', '115200') })));
  assert.equal(serial2.claims[0].resource, 'uart2');
  assert.equal(serial2.gaps.length, 0);
});

test('reserved flash GPIO produces a hidden conflict instead of a guessed exemption', () => {
  const result = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('flash', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '6') })));
  assert.ok(result.report.conflicts.some(c => c.code === 'reserved-resource' && c.resource === 'gpio.6'));
});

test('third-party claim fixture binds without a built-in board branch', () => {
  const model = modelModule.resolveEsp32ResourceModel(identity);
  const entry = { type: 'vendor_sensor', library_id: 'vendor.example', metadata_source: 'v2', inputs: [{ name: 'PIN' }], hardware: { claims: { version: 1, coverage: 'full', templates: [{ id: 'sensor-pin', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role: 'sensor-input' }] } } };
  const result = bindingModule.analyzeDeclaredHardware({ resource_graph: model.resource_graph }, [entry], [block('vendor-1', 'vendor_sensor', {}, { PIN: literal('text', 'TEXT', '13') })]);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.claims[0].resource, 'gpio.13');
  assert.equal(result.report.conflicts.length, 0);
});

test('production observation dispatch and identity safety do not mutate machine data', () => {
  const observed = structuredClone(identity);
  const before = JSON.stringify(observed);
  const code = 'pinMode(13, OUTPUT);';
  const result = productionModule.analyzeProductionResolvedResources(observed, workspace(block('p', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13') })));
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(observed), before);
  assert.equal(code, 'pinMode(13, OUTPUT);');
  assert.equal(observed.fqbn, 'esp32:esp32:esp32');
});
