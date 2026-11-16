import test from 'node:test';
import assert from 'node:assert/strict';
import { loadResourceModule } from './resource_test_loader.mjs';

const modelModule = await loadResourceModule('./esp32_c6_resource_model.ts');
const familyModule = await loadResourceModule('./esp32_resource_family.ts');
const claimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const bindingModule = await loadResourceModule('./resource_claim_binding.ts');
const productionModule = await loadResourceModule('./production_resource_analysis.ts');

const identity = {
  fqbn: 'esp32:esp32:esp32c6', options: {}, mcu: 'esp32c6', variant: 'esp32c6',
  coreVersion: '3.3.6', fCpu: '160000000L',
};
const literal = (type, field, value) => ({
  id: `literal:${field}`, type,
  getFieldValue: name => name === field ? value : undefined,
  getInputTargetBlock: () => null,
});
const block = (id, type, fields = {}, inputs = {}) => ({
  id, type,
  getFieldValue: name => fields[name],
  getInputTargetBlock: name => inputs[name] ?? null,
});
const workspace = (...blocks) => ({ getAllBlocks: () => blocks });

const resource = (model, id) => model.resource_graph.resources.find(item => item.id === id);
const routes = (model, id) => model.resource_graph.routes.filter(route => route.resource === id);

test('C6 exact resolved identity and menu applicability are enforced', () => {
  assert.equal(modelModule.matchesEsp32C6Identity(identity), true);
  assert.equal(modelModule.resolveEsp32C6ResourceModel(identity).status, 'ready');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, mcu: 'esp32' }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, variant: 'esp32c6-evb' }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, fqbn: 'esp32:esp32:esp32c6-evb' }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, options: { CPUFreq: '80' } }).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, options: { CPUFreq: '80' }, fCpu: '80000000L' }).status, 'ready');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, options: { ZigbeeMode: 'ed' } }).status, 'ready');
  assert.equal(modelModule.resolveEsp32C6ResourceModel({ ...identity, options: { USBMode: 'hwcdc' } }).status, 'not-applicable');
  assert.equal(familyModule.resolveEsp32FamilyResourceModel(identity).status, 'ready');
});

test('C6 GPIO, ADC, strapping, flash and board aliases are independently modeled', () => {
  const model = modelModule.resolveEsp32C6ResourceModel(identity);
  assert.deepEqual(model.boardExposure.validGpio, Array.from({ length: 31 }, (_, pin) => pin));
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'gpio').length, 31);
  assert.equal(resource(model, 'gpio.27').reserved, true);
  assert.equal(resource(model, 'gpio.24').capabilities.includes('system-owned-by-mspi'), true);
  for (const pin of [4, 5, 8, 9, 15]) assert.equal(resource(model, `gpio.${pin}`).capabilities.includes('strapping'), true);
  assert.equal(resource(model, 'gpio.8').aliases.includes('RGB_BUILTIN'), true);
  assert.equal(resource(model, 'gpio.16').aliases.includes('TX'), true);
  assert.equal(resource(model, 'gpio.17').aliases.includes('RX'), true);
  assert.equal(model.adc.A0, 'adc1.channel0');
  assert.equal(model.adc.A6, 'adc1.channel6');
  assert.equal(routes(model, 'adc1.channel6').some(route => route.mode === 'fixed' && route.pins.includes('gpio.6')), true);
});

test('C6 default routes and selectable routes remain separate', () => {
  const model = modelModule.resolveEsp32C6ResourceModel(identity);
  assert.equal(routes(model, 'uart0').some(route => route.signal === 'rx' && route.mode === 'selectable'), true);
  assert.equal(routes(model, 'uart0').some(route => route.signal === 'rx' && route.mode === 'fixed'), false);
  assert.deepEqual(model.serialDefaults.Serial0, { resource: 'uart0', transport: 'uart', rx: 'gpio.17', tx: 'gpio.16' });
  assert.equal(routes(model, 'uart2').some(route => route.signal === 'rx' && route.mode === 'fixed' && route.pins.includes('gpio.4')), true);
  assert.equal(routes(model, 'uart2').some(route => route.signal === 'cts' && route.mode === 'fixed' && route.pins.includes('gpio.3')), true);
  assert.deepEqual(routes(model, 'usb-serial-jtag').map(route => [route.signal, route.mode, route.pins]), [
    ['dm', 'fixed', ['gpio.12']], ['dp', 'fixed', ['gpio.13']],
  ]);
  assert.equal(routes(model, 'spi2').some(route => route.mode === 'selectable'), true);
  assert.equal(resource(model, 'spi2').capabilities.includes('default-route.sck.gpio.21'), true);
  assert.equal(routes(model, 'mspi.flash').length, 7);
  assert.equal(routes(model, 'i2c0').some(route => route.mode === 'selectable'), true);
  assert.equal(routes(model, 'i2c1').every(route => route.mode === 'fixed'), true);
  assert.equal(resource(model, 'i2c1').capabilities.includes('default-route.sda.gpio.6'), true);
});

test('C6 peripheral inventory reflects source-backed capabilities', () => {
  const model = modelModule.resolveEsp32C6ResourceModel(identity);
  assert.deepEqual(model.ledc, { groups: 1, channelsPerGroup: 6, totalChannels: 6, timersPerGroup: 4, maxResolution: 20, allocation: 'dynamic' });
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'ledc-channel').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'ledc-timer').length, 4);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'rmt-channel').length, 4);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-timer').length, 3);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-operator').length, 3);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-comparator').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-generator').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-trigger').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-capture-channel').length, 3);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-fault-detector').length, 3);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-gpio-sync').length, 3);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'hardware-timer').length, 2);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'twai-controller').length, 2);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'system-timer-counter').length, 2);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'system-timer-alarm').length, 3);
  assert.equal(resource(model, 'ieee802154.radio').reserved, false);
  const zigbee = modelModule.resolveEsp32C6ResourceModel({ ...identity, options: { ZigbeeMode: 'ed' } });
  assert.equal(resource(zigbee, 'ieee802154.radio').reserved, true);
  assert.equal(resource(zigbee, 'ieee802154.radio').capabilities.includes('zigbee-mode:ed'), true);
  assert.equal(model.boardExposure.psram.supported, false);
  assert.equal(model.boardExposure.packageExposure.status, 'blocked');
});

test('C6 built-in Digital IO, ADC and PWM claims use the generic adapter', () => {
  const digital = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('d10', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '10') }),
  ));
  assert.equal(digital.gaps.length, 0);
  assert.equal(digital.claims[0].resource, 'gpio.10');
  const analog = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('a6', 'io_analog_read', {}, { PIN: literal('board_pin_selector', 'PIN', 'A6') }),
  ));
  assert.equal(analog.gaps.length, 0);
  assert.equal(analog.claims[0].resource, 'adc1.channel6');
  const pwm = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('pwm', 'io_analog_write', {}, {
      PIN: literal('board_pin_selector', 'PIN', '10'), VALUE: literal('math_number', 'NUM', '128'),
    }),
  ));
  assert.equal(pwm.claims.some(claim => claim.resource === 'ledc'), true);
  assert.equal(pwm.gaps.some(gap => gap.code === 'dynamic-ledc-channel-unresolved'), true);
});

test('C6 Serial claims bind UART0/UART2 and CDC maps Serial to fixed USB pads', () => {
  const serial = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('s', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(serial.gaps.length, 0);
  assert.equal(serial.claims[0].resource, 'uart0');
  const serial2 = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('s2', 'serial_setup_with_pins', { PORT: 'Serial2' }, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(serial2.gaps.length, 0);
  assert.equal(serial2.claims[0].resource, 'uart2');
  const cdcIdentity = { ...identity, options: { CDCOnBoot: 'cdc' } };
  const cdc = claimsModule.analyzeEsp32WorkspaceResources(cdcIdentity, workspace(
    block('usb', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(cdc.gaps.length, 0);
  assert.equal(cdc.claims[0].resource, 'usb-serial-jtag');
  assert.equal(cdc.claims[0].role, 'hardware-serial');
  const collision = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('s1', 'serial_setup_with_pins', { PORT: 'Serial1' }, { BAUD: literal('math_number', 'NUM', '115200') }),
    block('s2b', 'serial_setup_with_pins', { PORT: 'Serial2' }, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(collision.report.conflicts.some(conflict => conflict.resource === 'gpio.4'), true);
  assert.equal(collision.report.conflicts.some(conflict => conflict.resource === 'gpio.5'), true);
});

test('C6 third-party resource contract binds through generic graph routes', () => {
  const model = modelModule.resolveEsp32C6ResourceModel(identity);
  const entry = {
    type: 'vendor_c6_sensor', library_id: 'vendor.example', metadata_source: 'v2',
    inputs: [{ name: 'PIN' }],
    hardware: { claims: { version: 1, coverage: 'full', templates: [{
      id: 'sensor-pin', resource: { kind: 'input', name: 'PIN', valueType: 'id' }, role: 'sensor-input',
    }] } },
  };
  const vendorBlock = block('vendor-c6-1', 'vendor_c6_sensor', {}, { PIN: literal('text', 'TEXT', '10') });
  const result = bindingModule.analyzeDeclaredHardware({ resource_graph: model.resource_graph }, [entry], [vendorBlock]);
  assert.equal(result.gaps.length, 0);
  assert.equal(result.report.conflicts.length, 0);
  assert.equal(result.claims[0].resource, 'gpio.10');
});

test('C6 production dispatch uses resolved identity and does not mutate it', () => {
  const observed = structuredClone(identity);
  const before = JSON.stringify(observed);
  const result = productionModule.analyzeProductionResolvedResources(observed, workspace(
    block('p', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '10') }),
  ));
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(observed), before);
  assert.equal(observed.fqbn, 'esp32:esp32:esp32c6');
  const unsupported = productionModule.analyzeProductionResolvedResources(
    { ...identity, fqbn: 'esp32:esp32:esp32c5', mcu: 'esp32c5', variant: 'esp32c5' }, workspace(),
  );
  assert.deepEqual(unsupported, { status: 'not-applicable', reason: 'unverified-resolved-identity' });
});
