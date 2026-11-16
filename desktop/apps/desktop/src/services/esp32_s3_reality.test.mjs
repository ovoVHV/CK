import test from 'node:test';
import assert from 'node:assert/strict';
import { loadResourceModule } from './resource_test_loader.mjs';

const modelModule = await loadResourceModule('./esp32_s3_resource_model.ts');
const familyModule = await loadResourceModule('./esp32_resource_family.ts');
const claimsModule = await loadResourceModule('./esp32_builtin_resource_claims.ts');
const productionModule = await loadResourceModule('./production_resource_analysis.ts');

const identity = {
  fqbn: 'esp32:esp32:esp32s3', options: {}, mcu: 'esp32s3', variant: 'esp32s3',
  coreVersion: '3.3.6', fCpu: '240000000L',
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

test('S3 exact FQBN, MCU, variant, core, CPU and menu applicability are enforced', () => {
  assert.equal(modelModule.matchesEsp32S3Identity(identity), true);
  assert.equal(modelModule.resolveEsp32S3ResourceModel(identity).status, 'ready');
  for (const bad of [
    { ...identity, mcu: 'esp32' },
    { ...identity, variant: 'esp32s3-evb' },
    { ...identity, fqbn: 'esp32:esp32:esp32s3-devkitc-1' },
    { ...identity, coreVersion: '3.3.5' },
    { ...identity, options: { CPUFreq: '80' } },
    { ...identity, options: { USBMode: 'not-real' } },
  ]) assert.equal(modelModule.resolveEsp32S3ResourceModel(bad).status, 'not-applicable');
  assert.equal(modelModule.resolveEsp32S3ResourceModel({ ...identity, options: { CPUFreq: '80' }, fCpu: '80000000L' }).status, 'ready');
  const menuFqbn = 'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB,PSRAM=opi,CDCOnBoot=cdc,JTAGAdapter=builtin';
  assert.equal(modelModule.resolveEsp32S3ResourceModel({
    ...identity,
    fqbn: menuFqbn,
    options: { FlashSize: '16M', PartitionScheme: 'app3M_fat9M_16MB', PSRAM: 'opi', CDCOnBoot: 'cdc', JTAGAdapter: 'builtin' },
  }).status, 'ready');
  assert.equal(familyModule.resolveEsp32FamilyResourceModel(identity).status, 'ready');
});

test('S3 SoC capability and generic board exposure remain separate', () => {
  const model = modelModule.resolveEsp32S3ResourceModel(identity);
  assert.deepEqual(model.boardExposure.validGpio, [
    ...Array.from({ length: 22 }, (_, pin) => pin),
    ...Array.from({ length: 23 }, (_, index) => index + 26),
  ]);
  assert.deepEqual(model.boardExposure.exposedGpio, [
    ...Array.from({ length: 22 }, (_, pin) => pin),
    ...Array.from({ length: 14 }, (_, index) => index + 35),
  ]);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'gpio').length, 45);
  assert.equal(resource(model, 'gpio.26').reserved, true);
  assert.equal(resource(model, 'gpio.33').capabilities.includes('board-not-exposed'), true);
  assert.equal(resource(model, 'gpio.0').capabilities.includes('strapping'), true);
  assert.equal(resource(model, 'gpio.48').aliases.includes('LED_BUILTIN'), true);
  assert.equal(resource(model, 'gpio.43').aliases.includes('TX'), true);
  assert.equal(resource(model, 'gpio.44').aliases.includes('RX'), true);
  assert.equal(model.adc.A0, 'adc1.channel0');
  assert.equal(model.adc['adc2.9'], 'adc2.channel9');
});

test('S3 default routes and selectable routes are distinct', () => {
  const model = modelModule.resolveEsp32S3ResourceModel(identity);
  assert.equal(routes(model, 'uart0').some(route => route.mode === 'selectable' && route.signal === 'rx'), true);
  assert.equal(routes(model, 'uart0').some(route => route.mode === 'fixed'), false);
  assert.deepEqual(model.serialDefaults.Serial0, { resource: 'uart0', transport: 'uart', rx: 'gpio.44', tx: 'gpio.43' });
  assert.equal(routes(model, 'spi2').some(route => route.mode === 'selectable'), true);
  assert.equal(resource(model, 'spi2').capabilities.includes('default-route.sck.gpio.12'), true);
  assert.equal(resource(model, 'spi3').capabilities.includes('no-arduino-default-route'), true);
  assert.equal(routes(model, 'i2c0').some(route => route.mode === 'selectable'), true);
  assert.equal(routes(model, 'i2c1').some(route => route.mode === 'selectable'), true);
  assert.equal(routes(model, 'mspi.flash').length, 7);
  assert.deepEqual(routes(model, 'usb-serial-jtag').map(route => [route.signal, route.mode, route.pins]), [
    ['dm', 'fixed', ['gpio.19']], ['dp', 'fixed', ['gpio.20']],
  ]);
});

test('S3 peripheral inventory matches independent source snapshot', () => {
  const model = modelModule.resolveEsp32S3ResourceModel(identity);
  assert.deepEqual(model.ledc, { groups: 1, channelsPerGroup: 8, totalChannels: 8, timersPerGroup: 4, maxResolution: 14, allocation: 'dynamic' });
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'ledc-channel').length, 8);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'ledc-timer').length, 4);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'rmt-channel').length, 8);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-group').length, 2);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-timer').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'mcpwm-operator').length, 6);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'hardware-timer').length, 4);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'twai-controller').length, 1);
  assert.equal(model.resource_graph.resources.filter(item => item.type === 'system-timer-alarm').length, 3);
  assert.equal(resource(model, 'gpio.19').capabilities.includes('usb-serial-jtag-pad'), true);
  assert.equal(resource(model, 'usb-serial-jtag').type, 'usb-serial-jtag-controller');
  assert.equal(resource(model, 'usb-otg').type, 'usb-otg-controller');
  assert.equal(model.boardExposure.psram.supported, true);
});

test('S3 OPI applicability activates conditional memory ownership without changing identity', () => {
  const octalIdentity = {
    ...identity,
    fqbn: 'esp32:esp32:esp32s3-octal',
    options: { PSRAM: 'opi', FlashMode: 'opi', CDCOnBoot: 'cdc', JTAGAdapter: 'builtin' },
  };
  const model = modelModule.resolveEsp32S3ResourceModel(octalIdentity);
  assert.equal(model.status, 'ready');
  assert.equal(model.boardExposure.psram.mode, 'opi');
  assert.equal(model.boardExposure.activeSystemRoutes.octalMemory, true);
  assert.equal(resource(model, 'gpio.33').reserved, true);
  assert.equal(resource(model, 'usb-serial-jtag').capabilities.includes('cdc-on-boot'), true);
  assert.equal(model.serialDefaults.Serial.resource, 'usb-serial-jtag');
});

test('S3 octal board honors explicit non-OPI menu overrides', () => {
  const model = modelModule.resolveEsp32S3ResourceModel({
    ...identity,
    fqbn: 'esp32:esp32:esp32s3-octal:PSRAM=disabled,FlashMode=qio',
    options: { PSRAM: 'disabled', FlashMode: 'qio' },
  });
  assert.equal(model.status, 'ready');
  assert.equal(model.boardExposure.psram.mode, 'disabled');
  assert.equal(model.boardExposure.activeSystemRoutes.octalMemory, false);
  assert.equal(resource(model, 'gpio.33').reserved, false);
  assert.equal(model.coreDependencies.flash.resources.includes('gpio.33'), false);
  assert.equal(modelModule.resolveEsp32S3ResourceModel({ ...identity, fqbn: 'esp32:esp32:esp32s3-octal', options: { ZigbeeMode: 'zczr' } }).status, 'not-applicable');
});

test('S3 native USB CDC maps Serial to USB-OTG and ADC2 remains arbitrated', () => {
  const model = modelModule.resolveEsp32S3ResourceModel({ ...identity, options: { USBMode: 'default', CDCOnBoot: 'cdc' } });
  assert.deepEqual(model.serialDefaults.Serial, { resource: 'usb-otg', transport: 'usb-otg' });
  assert.equal(model.boardExposure.activeSystemRoutes.usbOtg, true);
  assert.equal(resource(model, 'usb-otg').capabilities.includes('system-owned-when-active'), true);
  assert.equal(resource(model, 'adc2.channel0').capabilities.includes('runtime-arbitrated'), true);
});

test('S3 built-in claims use the family-generic adapter', () => {
  const digital = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('d13', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13') }),
  ));
  assert.equal(digital.gaps.length, 0);
  assert.equal(digital.claims[0].resource, 'gpio.13');
  const analog = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('a0', 'io_analog_read', {}, { PIN: literal('board_pin_selector', 'PIN', 'A0') }),
  ));
  assert.equal(analog.gaps.length, 0);
  assert.equal(analog.claims[0].resource, 'adc1.channel0');
  const pwm = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('pwm', 'io_analog_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13'), VALUE: literal('math_number', 'NUM', '128') }),
  ));
  assert.equal(pwm.claims.some(claim => claim.resource === 'ledc'), true);
  assert.equal(pwm.gaps.some(gap => gap.code === 'dynamic-ledc-channel-unresolved'), true);
});

test('S3 USB Serial/JTAG stays distinct from UART claims', () => {
  const uart = claimsModule.analyzeEsp32WorkspaceResources(identity, workspace(
    block('s', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(uart.gaps.length, 0);
  assert.equal(uart.claims[0].resource, 'uart0');
  const cdc = claimsModule.analyzeEsp32WorkspaceResources({ ...identity, options: { CDCOnBoot: 'cdc' } }, workspace(
    block('s', 'serial_setup', {}, { BAUD: literal('math_number', 'NUM', '115200') }),
  ));
  assert.equal(cdc.gaps.length, 0);
  assert.equal(cdc.claims[0].resource, 'usb-serial-jtag');
});

test('S3 production dispatch uses resolved identity and preserves it', () => {
  const observed = structuredClone(identity);
  const before = JSON.stringify(observed);
  const result = productionModule.analyzeProductionResolvedResources(observed, workspace(
    block('p', 'io_digital_write', {}, { PIN: literal('board_pin_selector', 'PIN', '13') }),
  ));
  assert.equal(result.status, 'ready');
  assert.equal(JSON.stringify(observed), before);
  const unsupported = productionModule.analyzeProductionResolvedResources(
    { ...identity, fqbn: 'esp32:esp32:esp32c5', mcu: 'esp32c5', variant: 'esp32c5' }, workspace(),
  );
  assert.deepEqual(unsupported, { status: 'not-applicable', reason: 'unverified-resolved-identity' });
});
