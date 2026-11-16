import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import * as Blockly from 'blockly';
import { loadResourceModule } from './resource_test_loader.mjs';

const root = new URL('../../../../', import.meta.url);
const snapshots = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/mega-1.8.8.json', import.meta.url)));
const production = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/mega-production-resolved.json', import.meta.url)));
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { analyzeProductionResolvedResources } = await loadResourceModule('./production_resource_analysis.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');

async function component(name) {
  const output = new URL(`.mega-reality-${name}-${process.pid}.mjs`, import.meta.url);
  await build({ entryPoints: [fileURLToPath(new URL(`../components/${name}.ts`, import.meta.url))], outfile: fileURLToPath(output), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'blockly-singleton', setup(b) { b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true })); } }],
  });
  try { return await import(output.href); } finally { await unlink(output); }
}
const setup = await component('blockly_setup');
const { arduinoGenerator, setArduinoGeneratorTarget } = await component('arduino_generator');
const fixed = (value, valueType = 'id') => ({ kind: 'fixed', valueType, value });
function fixture(model, templates) {
  return analyzeDeclaredHardware(model, [{ type: 'mega_gate_fixture', library_id: 'mega-gate', metadata_source: 'v2', fields: [], inputs: [], hardware: { claims: { version: 1, coverage: 'full', templates } } }],
    [{ id: 'fixture', type: 'mega_gate_fixture', getFieldValue: () => null, getInputTargetBlock: () => null }]);
}
function pinBlock(ws, type, pin, value) {
  const block = ws.newBlock(type);
  if (pin !== undefined) {
    const selector = ws.newBlock('board_pin_selector');
    selector.setFieldValue(String(pin), 'PIN');
    assert.equal(selector.getFieldValue('PIN'), String(pin));
    block.getInput('PIN').connection.connect(selector.outputConnection);
  }
  if (value !== undefined) {
    const literal = ws.newBlock('math_number'); literal.setFieldValue(value, 'NUM');
    block.getInput('VALUE').connection.connect(literal.outputConnection);
  }
  return block;
}
function serialSetup(ws, port, baud = 9600) {
  const block = ws.newBlock('serial_setup_with_pins');
  block.setFieldValue(port, 'PORT');
  for (const [name, value] of [['BAUD', baud], ['RX', 0], ['TX', 1]]) {
    const literal = ws.newBlock('math_number'); literal.setFieldValue(value, 'NUM');
    block.getInput(name).connection.connect(literal.outputConnection);
  }
  return block;
}

test('Mega menu inventory and independent compiler evidence cover every actual option', async () => {
  const boards = await readFile(new URL('packages/arduino/hardware/avr/1.8.8/boards.txt', root), 'utf8');
  const menus = [...boards.matchAll(/^mega\.menu\.cpu\.([^.=]+)=/gm)].map(m => m[1]);
  assert.deepEqual(production.processors, menus);
  assert.deepEqual(snapshots.slice(0, -1).map(s => s.identity.options.cpu), menus);
  assert.deepEqual(snapshots.at(-1).identity, production.defaultIdentity);
  const fresh = JSON.parse(execFileSync(process.execPath, ['scripts/Extract-MegaReality.mjs'], { cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(fresh, snapshots);
});

for (const data of snapshots) {
  const identity = data.identity;
  test(`${identity.fqbn}: exact identity and production compile A/B`, () => {
    const model = resolveAvrResourceModel(identity);
    assert.equal(model.status, 'ready');
    assert.deepEqual(model.identity, identity);
    for (const other of snapshots.filter(s => s.identity.fqbn !== identity.fqbn)) {
      assert.equal(resolveAvrResourceModel({ ...identity, fqbn: other.identity.fqbn }).status, 'not-applicable');
    }
    for (const delta of [{ mcu: 'unknown' }, { variant: 'standard' }, { fCpu: '8000000L' }, { coreVersion: '0.0.0' }, { options: { cpu: 'unsupported' } }]) {
      assert.equal(resolveAvrResourceModel({ ...identity, ...delta }).status, 'not-applicable');
    }
    const record = production.applicabilities.find(a => a.identity.fqbn === identity.fqbn);
    if (record) {
      assert.equal(record.productionCompilePair, 'PASS');
      assert.equal(record.requestUnchanged, true);
      assert.equal(record.buildSignatureBefore, record.buildSignatureAfter);
      assert.ok(Object.keys(record.firmwareHashes).some(name => name.endsWith('.elf')));
      assert.ok(Object.keys(record.firmwareHashes).some(name => name.endsWith('.hex')));
      for (const rejected of Object.values(record.rejected)) assert.equal(resolveAvrResourceModel(rejected).status, 'not-applicable');
    }
  });

  test(`${identity.fqbn}: expanded GPIO/ADC/UART/SPI/I2C/timer model`, () => {
    const model = resolveAvrResourceModel(identity), graph = model.resource_graph;
    assert.equal(data.digital, 70); assert.equal(data.analog, 16);
    assert.equal(graph.resources.filter(r => r.type === 'gpio').length, 70);
    assert.equal(graph.resources.filter(r => r.type === 'adc-channel').length, 16);
    assert.equal(graph.resources.filter(r => r.type === 'uart-controller').length, 4);
    assert.deepEqual(data.uart.map(u => [u.port, u.rx, u.tx]), [['Serial', 0, 1], ['Serial1', 19, 18], ['Serial2', 17, 16], ['Serial3', 15, 14]]);
    for (const uart of data.uart) {
      assert.deepEqual(graph.routes.find(r => r.resource === uart.id && r.signal === 'rx').pins, [`gpio.${uart.rx}`]);
      assert.deepEqual(graph.routes.find(r => r.resource === uart.id && r.signal === 'tx').pins, [`gpio.${uart.tx}`]);
      assert.ok(graph.resources.find(r => r.id === uart.id).aliases.includes(uart.port));
    }
    for (const channel of [0, 15]) {
      assert.equal(model.adc[`A${channel}`], `adc.${channel}`);
      assert.deepEqual(graph.routes.find(r => r.resource === `adc.${channel}`).pins, [`gpio.${54 + channel}`]);
    }
    assert.deepEqual(model.pwm, Object.fromEntries(data.timers.filter(t => t.timer !== 'NOT_ON_TIMER').map(t => [t.pin, t.timer])));
    assert.equal(model.coreDependencies.tone.resource, 'TIMER2');
    assert.deepEqual(graph.routes.find(r => r.resource === 'spi' && r.signal === 'sck').pins, ['gpio.52']);
    assert.deepEqual(graph.routes.find(r => r.resource === 'spi' && r.signal === 'mosi').pins, ['gpio.51']);
    assert.deepEqual(graph.routes.find(r => r.resource === 'spi' && r.signal === 'miso').pins, ['gpio.50']);
    assert.deepEqual(graph.routes.find(r => r.resource === 'i2c' && r.signal === 'sda').pins, ['gpio.20']);
    assert.deepEqual(graph.routes.find(r => r.resource === 'i2c' && r.signal === 'scl').pins, ['gpio.21']);
    for (const alias of ['ICSP.SCK', 'ICSP.MOSI', 'ICSP.MISO']) assert.ok(graph.resources.some(r => r.aliases.includes(alias)));
  });

  test(`${identity.fqbn}: real product claims cover Serial1 and Serial2 without collapsing to UART0`, async () => {
    setup.setBlocklyBoard(identity.fqbn); setArduinoGeneratorTarget(identity.fqbn);
    const ws = new Blockly.Workspace();
    try {
      pinBlock(ws, 'set_pin_mode', 13).setFieldValue('OUTPUT', 'MODE');
      pinBlock(ws, 'io_digital_write', 13);
      pinBlock(ws, 'io_digital_read', 22);
      for (const channel of [0, 15]) pinBlock(ws, 'io_analog_read', `A${channel}`);
      const selectedPwm = data.timers.filter(t => t.timer !== 'NOT_ON_TIMER').filter((_, i) => i % 2 === 0);
      for (const { pin } of selectedPwm) pinBlock(ws, 'io_analog_write', pin, 128);
      serialSetup(ws, 'Serial1', 9600); serialSetup(ws, 'Serial2', 115200);
      const before = JSON.stringify(Blockly.serialization.workspaces.save(ws));
      const cpp = arduinoGenerator.workspaceToCode(ws);
      const generatorPath = new URL('../components/arduino_generator.ts', import.meta.url), generatorBytes = await readFile(generatorPath);
      const digest = value => createHash('sha256').update(value).digest('hex');
      const stateBefore = JSON.stringify({ workspace: Blockly.serialization.workspaces.save(ws), cpp, identity });
      const result = analyzeProductionResolvedResources(identity, ws);
      assert.equal(result.status, 'ready');
      assert.equal(result.report.conflicts.length, 0);
      assert.ok(result.claims.some(c => c.resource === 'uart1' && c.configuration.baud === 9600));
      assert.ok(result.claims.some(c => c.resource === 'uart2' && c.configuration.baud === 115200));
      assert.ok(!result.claims.some(c => c.resource === 'uart0' && c.owner !== 'arduino-core'));
      for (const resource of ['gpio.13', 'gpio.22', 'adc.0', 'adc.15', 'TIMER0', ...selectedPwm.map(({ pin }) => result.model.pwm[String(pin)])]) assert.ok(result.report.usages.some(u => u.resource === resource), resource);
      assert.equal(result.coverage.analysisCoverage, 'full');
      assert.equal(result.coverage.projectCoverage, 'partial');
      assert.equal(result.coverage.hardwareEvidence, 'source-verified-not-hardware-tested');
      assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), before);
      assert.equal(arduinoGenerator.workspaceToCode(ws), cpp);
      assert.equal(digest(JSON.stringify({ workspace: Blockly.serialization.workspaces.save(ws), cpp: arduinoGenerator.workspaceToCode(ws), identity })), digest(stateBefore));
      assert.deepEqual(await readFile(generatorPath), generatorBytes);
      assert.equal(analyzeProductionResolvedResources(null, ws), null);
    } finally { ws.dispose(); }
  });

  test(`${identity.fqbn}: generic fixture sharing/conflict and unsupported Servo remain explicit`, () => {
    const model = resolveAvrResourceModel(identity);
    const buses = [
      ['spi', ['gpio.4', 'gpio.7'], 'id'],
      ['i2c', [60, 104], 'integer'],
    ];
    for (const [bus, values, type] of buses) {
      const templates = values.map((value, i) => ({ id: `device${i}`, resource: fixed(bus), owner: fixed(`device${i}`), role: 'device', discriminator: fixed(value, type) }));
      assert.equal(fixture(model, templates).report.conflicts.length, 0);
      templates[1].discriminator = templates[0].discriminator;
      assert.ok(fixture(model, templates).report.conflicts.some(c => c.code === 'discriminator-conflict'));
    }
    const uartConflict = fixture(model, [
      { id: 'serial-a', resource: fixed('uart1'), owner: fixed('serial-a'), role: 'hardware-uart', configuration: { baud: fixed(9600, 'integer') } },
      { id: 'serial-b', resource: fixed('uart1'), owner: fixed('serial-b'), role: 'hardware-uart', configuration: { baud: fixed(115200, 'integer') } },
    ]);
    assert.ok(uartConflict.report.conflicts.some(c => c.resource === 'uart1' && c.code === 'configuration-conflict'));
    const timer = model.coreDependencies.tone.resource;
    const pwm = model.resource_graph.resources.find(r => r.parent === timer && r.type === 'pwm-channel').id;
    const conflict = fixture(model, [{ id: 'tone', resource: fixed(timer), owner: fixed('tone'), role: 'tone', exclusive: true }, { id: 'pwm', resource: fixed(pwm), owner: fixed('pwm'), role: 'hardware-pwm' }]);
    assert.ok(conflict.report.conflicts.some(c => c.resource === timer && c.code === 'exclusive-conflict'));
  });
}
