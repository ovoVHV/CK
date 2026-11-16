import test from 'node:test';
import assert from 'node:assert/strict';
import { loadResourceModule } from './resource_test_loader.mjs';

const modelModule = await loadResourceModule('./esp32_c3_resource_model.ts');
const familyModule = await loadResourceModule('./esp32_resource_family.ts');
const claimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const bindingModule = await loadResourceModule('./resource_claim_binding.ts');
const productionModule = await loadResourceModule('./production_resource_analysis.ts');
const graphModule = await loadResourceModule('./hardware_resource_graph.ts');

const identity = { fqbn: 'esp32:esp32:esp32c3', options: {}, mcu: 'esp32c3', variant: 'esp32c3', coreVersion: '3.3.6', fCpu: '160000000L' };
const literal = (type, field, value) => ({ id: `literal:${field}`, type, getFieldValue: name => name === field ? value : undefined, getInputTargetBlock: () => null });
const block = (id, type, fields = {}, inputs = {}) => ({ id, type, getFieldValue: name => fields[name], getInputTargetBlock: name => inputs[name] ?? null });
const workspace = (...blocks) => ({ getAllBlocks: () => blocks });

test('C3 exact resolved identity selects the independent model', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  assert.equal(model.status, 'ready');
  assert.equal(model.identity.fqbn, 'esp32:esp32:esp32c3');
  assert.equal(model.resource_graph.coverage, 'full');
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'gpio').length, 22);
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, mcu: 'esp32', variant: 'esp32' }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { CPUFreq: '80' } }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { CPUFreq: '80' }, fCpu: '80000000L' }).status, 'ready');
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { UploadSpeed: '460800' } }).status, 'ready');
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { UploadSpeed: '999999' } }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { FlashMode: 'qout' } }).status, 'not-applicable');
  assert.equal(familyModule.resolveEsp32FamilyResourceModel(identity).status, 'ready');
});

test('C3 GPIO, reservations and aliases are not classic ESP32 values', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  const gpio = pin => model.resource_graph.resources.find(r => r.id === `gpio.${pin}`);
  assert.deepEqual(model.boardExposure.validGpio, Array.from({ length: 22 }, (_, i) => i));
  assert.equal(gpio(21).aliases.includes('TX'), true);
  assert.equal(gpio(8).aliases.includes('SDA'), true);
  assert.equal(gpio(12).reserved, true);
  assert.equal(gpio(17).reserved, true);
  assert.equal(gpio(34), undefined);
  assert.equal(gpio(2).capabilities.includes('strapping'), true);
  assert.equal(gpio(8).capabilities.includes('strapping'), true);
  assert.equal(gpio(9).capabilities.includes('strapping'), true);
});

test('C3 ADC has independently mapped channels and no classic Wi-Fi priority claim', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  assert.equal(model.adc.A0, 'adc1.channel0');
  assert.equal(model.adc.A4, 'adc1.channel4');
  assert.equal(model.adc.A5, 'adc2.channel0');
  assert.equal(model.adc['5'], 'adc2.channel0');
  const adc = model.resource_graph.resources.find(r => r.id === 'adc');
  assert.equal(adc.capabilities.includes('adc2-wifi-shared'), false);
  assert.equal(adc.capabilities.includes('no-classic-wifi-priority'), true);
});

test('C3 exposes two UARTs, USB Serial/JTAG separately, and selectable routes', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'uart-controller').length, 2);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'uart2'), false);
  const usb = model.resource_graph.resources.find(r => r.id === 'usb-serial-jtag');
  assert.equal(usb.type, 'usb-serial-jtag-controller');
  assert.deepEqual(model.resource_graph.routes.filter(r => r.resource === 'usb-serial-jtag').map(r => [r.signal, r.mode, r.pins]), [
    ['dm', 'fixed', ['gpio.18']], ['dp', 'fixed', ['gpio.19']],
  ]);
  assert.equal(model.resource_graph.routes.find(r => r.resource === 'uart1' && r.signal === 'rx').mode, 'selectable');
  assert.deepEqual(model.serialDefaults.Serial1, { resource: 'uart1', transport: 'uart', rx: 'gpio.18', tx: 'gpio.19' });
});

test('C3 SPI/I2C expose only Arduino sketch controllers with variant defaults', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'spi2'), true);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'spi3'), false);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'i2c0'), true);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'i2c1'), false);
  assert.equal(model.resource_graph.resources.find(r => r.id === 'spi2').capabilities.includes('default-route.sck.gpio.4'), true);
  assert.equal(model.resource_graph.resources.find(r => r.id === 'i2c0').capabilities.includes('default-route.sda.gpio.8'), true);
  assert.equal(model.resource_graph.resources.find(r => r.id === 'mspi.flash').reserved, true);
});

test('C3 dynamic peripheral inventory is source-backed', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  assert.deepEqual(model.ledc, { groups: 1, channelsPerGroup: 6, totalChannels: 6, timersPerGroup: 4, maxResolution: 14, allocation: 'dynamic' });
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'ledc-channel').length, 6);
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'ledc-timer').length, 4);
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'rmt-channel').length, 4);
  assert.equal(model.resource_graph.resources.filter(r => r.type === 'hardware-timer').length, 2);
  assert.equal(model.resource_graph.resources.some(r => r.id === 'twai0'), true);
});

test('C3 built-in digital, analog and PWM claims use the generic analyzer', () => {
  const digital = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('d10', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '10') })));
  assert.equal(digital.gaps.length, 0);
  assert.equal(digital.claims[0].resource, 'gpio.10');
  const analog = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('a0', 'io_analog_read', {}, { PIN: literal('board_pin_selector', 'PIN', 'A0') })));
  assert.equal(analog.gaps.length, 0);
  assert.equal(analog.claims[0].resource, 'adc1.channel0');
  const pwm = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('pwm', 'io_analog_write', {}, { PIN: literal('board_pin_selector', 'PIN', '10'), VALUE: literal('math_number', 'NUM', '128') })));
  assert.equal(pwm.claims.some(c => c.resource === 'ledc'), true);
  assert.equal(pwm.gaps.some(g => g.code === 'dynamic-ledc-channel-unresolved'), true);
});

test('C3 Serial and Serial1 bind stable resources; CDC switches Serial to USB type', () => {
  const serial = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('s', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') })));
  assert.equal(serial.gaps.length, 0);
  assert.equal(serial.claims[0].resource, 'uart0');
  const serial1 = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(block('s1', 'serial_setup_with_pins', { PORT: 'Serial1' }, { BAUD: literal('math_number', 'NUM', '115200') })));
  assert.equal(serial1.claims[0].resource, 'uart1');
  assert.equal(serial1.gaps.length, 0);
  const cdc = { ...identity, options: { CDCOnBoot: 'cdc' } };
  const usb = claimsModule.analyzeEsp32WorkspaceResources(cdc, workspace(block('usb', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') })));
  assert.equal(usb.claims[0].resource, 'usb-serial-jtag');
  assert.equal(usb.claims[0].role, 'hardware-serial');
  assert.equal(usb.gaps.length, 0);
});

test('C3 USB/JTAG menu applicability changes only conditional reservations and Serial mapping', () => {
  const base = modelModule.resolveEsp32C3ResourceModel(identity);
  const cdc = modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { CDCOnBoot: 'cdc' } });
  const jtag = modelModule.resolveEsp32C3ResourceModel({ ...identity, options: { JTAGAdapter: 'builtin' } });
  const pin = (model, id) => model.resource_graph.resources.find(r => r.id === id);
  assert.equal(pin(base, 'gpio.18').reserved, false);
  assert.equal(pin(cdc, 'gpio.18').reserved, false);
  assert.equal(pin(cdc, 'gpio.18').capabilities.includes('system-owned-when-usb-active'), true);
  assert.equal(pin(jtag, 'gpio.19').reserved, false);
  assert.equal(pin(jtag, 'gpio.19').capabilities.includes('potential-system-owned-when-jtag-active'), true);
  assert.equal(pin(jtag, 'gpio.19').capabilities.includes('system-owned-when-usb-active'), false);
  assert.equal(pin(cdc, 'usb-serial-jtag').reserved, false);
  assert.equal(base.defaultSerial, 'uart0');
  assert.equal(cdc.defaultSerial, 'usb-serial-jtag');
});

test('C3 USB fixed pads conflict with a simultaneous Serial1 route, not with USB itself', () => {
  const cdc = { ...identity, options: { CDCOnBoot: 'cdc' } };
  const baud = literal('math_number', 'NUM', '115200');
  const result = claimsModule.analyzeEsp32WorkspaceResources(cdc, workspace(
    block('usb', 'serial_setup', {}, { BAUD: baud }),
    block('s1', 'serial_setup_with_pins', { PORT: 'Serial1' }, { BAUD: baud }),
  ));
  assert.equal(result.gaps.length, 0);
  assert.equal(result.report.conflicts.some(c => c.code === 'exclusive-conflict' && c.resource === 'gpio.18'), true);
  assert.equal(result.report.conflicts.some(c => c.code === 'exclusive-conflict' && c.resource === 'gpio.19'), true);
  assert.equal(result.report.conflicts.some(c => c.code === 'reserved-resource' && c.resource === 'usb-serial-jtag'), false);
});

test('C3 third-party Resource Contract fixture binds through generic routes', () => {
  const model = modelModule.resolveEsp32C3ResourceModel(identity);
  const entry = { type: 'vendor_c3_sensor', library_id: 'vendor.example', metadata_source: 'v2', inputs: [{ name: 'PIN' }], hardware: { claims: { version: 1, coverage: 'full', templates: [{ id: 'sensor-pin', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role: 'sensor-input' }] } } };
  const vendorBlock = block('vendor-1', 'vendor_c3_sensor', {}, { PIN: literal('text', 'TEXT', '10') });
  const result = bindingModule.analyzeDeclaredHardware({ resource_graph: model.resource_graph }, [entry], [vendorBlock]);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.report.conflicts.length, 0);
  assert.equal(result.claims[0].resource, 'gpio.10');
  assert.equal(entry.hardware.claims.version, 1);
});

test('production dispatch uses resolved C3 properties and does not mutate identity', () => {
  const observed = structuredClone(identity);
  const before = JSON.stringify(observed);
  const result = productionModule.analyzeProductionResolvedResources(observed, workspace(block('p', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '10') })));
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(observed), before);
  assert.equal(observed.fqbn, 'esp32:esp32:esp32c3');
});

test('production dispatch does not guess unsupported ESP32 variants as AVR', () => {
  const unsupported = { ...identity, fqbn: 'esp32:esp32:esp32c5', mcu: 'esp32c5', variant: 'esp32c5' };
  const result = productionModule.analyzeProductionResolvedResources(unsupported, workspace());
  assert.deepEqual(result, { status: 'not-applicable', reason: 'unverified-resolved-identity' });
});
