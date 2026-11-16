import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import { loadResourceModule } from './resource_test_loader.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const snapshots = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/nano-1.8.8.json', import.meta.url), 'utf8'));
const production = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/nano-production-resolved.json', import.meta.url), 'utf8'));
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { analyzeProductionResolvedResources } = await loadResourceModule('./production_resource_analysis.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const { analyzeHardwareResources } = await loadResourceModule('./hardware_resource_graph.ts');
async function bundled(name) {
  const output = new URL(`.nano-reality-${name}-${process.pid}.mjs`, import.meta.url);
  await build({ entryPoints: [fileURLToPath(new URL(`../components/${name}.ts`, import.meta.url))], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: fileURLToPath(output), logLevel: 'silent',
    plugins: [{ name: 'node-blockly-singleton', setup(b) { b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true })); } }],
  });
  try { return await import(pathToFileURL(fileURLToPath(output)).href); } finally { await unlink(output); }
}
const setup = await bundled('blockly_setup');
const { arduinoGenerator, setArduinoGeneratorTarget } = await bundled('arduino_generator');
function add(ws, type, pin, value) {
  const block = ws.newBlock(type);
  if (pin !== undefined) {
    const selector = ws.newBlock('board_pin_selector'); selector.setFieldValue(String(pin), 'PIN');
    assert.equal(selector.getFieldValue('PIN'), String(pin), 'actual Nano selector accepts the pin');
    block.getInput('PIN').connection.connect(selector.outputConnection);
  }
  if (value !== undefined) {
    const literal = ws.newBlock('math_number'); literal.setFieldValue(value, 'NUM');
    block.getInput('VALUE').connection.connect(literal.outputConnection);
  }
  return block;
}
const fixed = (value, valueType = 'id') => ({ kind: 'fixed', valueType, value });
function fixture(model, templates) {
  return analyzeDeclaredHardware(model, [{ type: 'contract_fixture', library_id: 'nano-gate-fixture', metadata_source: 'v2', fields: [], inputs: [], hardware: { claims: { version: 1, coverage: 'full', templates } } }],
    [{ id: 'fixture', type: 'contract_fixture', getFieldValue: () => null, getInputTargetBlock: () => null }]);
}
test('Nano independently re-extracts all production-resolved menus and default from installed compiler', async () => {
  const actual = JSON.parse(execFileSync(process.execPath, ['scripts/Extract-NanoReality.mjs'], { cwd: root, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(actual, snapshots);
  const boards = await readFile(`${root}packages/arduino/hardware/avr/1.8.8/boards.txt`, 'utf8');
  const menus = [...boards.matchAll(/^nano\.menu\.cpu\.([^.=]+)=/gm)].map(m => m[1]);
  assert.deepEqual(production.processors, menus);
  assert.deepEqual(snapshots.slice(0, -1).map(s => s.identity.options.cpu), menus);
  assert.deepEqual(snapshots.at(-1).identity, production.defaultIdentity);
});
for (const snapshot of snapshots) {
  const { identity } = snapshot;
  test(`${identity.fqbn}: exact applicability and no cross-selection`, () => {
    const model = resolveAvrResourceModel(identity);
    assert.equal(model.status, 'ready'); assert.deepEqual(model.identity, identity);
    for (const other of snapshots.filter(s => s.identity.fqbn !== identity.fqbn)) {
      assert.equal(resolveAvrResourceModel({ ...identity, fqbn: other.identity.fqbn }).status, 'not-applicable');
    }
    const observed = production.applicabilities.find(a => a.identity.fqbn === identity.fqbn);
    if (observed) {
      assert.equal(observed.requestUnchanged, true);
      assert.equal(observed.productionCompilePair, 'PASS');
      assert.equal(observed.buildSignatureBefore, observed.buildSignatureAfter);
      assert.ok(Object.keys(observed.firmwareHashes).some(p => p.endsWith('.elf')));
      for (const rejected of Object.values(observed.rejected)) assert.equal(resolveAvrResourceModel(rejected).status, 'not-applicable');
    }
    assert.equal(resolveAvrResourceModel({ ...identity, coreVersion: '1.8.6' }).status, 'ready');
    for (const delta of [{ mcu: 'unknown' }, { variant: 'standard' }, { fCpu: '8000000L' }, { coreVersion: '1.8.7' }, { options: { wrong: 'menu' } }]) {
      assert.equal(resolveAvrResourceModel({ ...identity, ...delta }).status, 'not-applicable');
    }
  });
  test(`${identity.fqbn}: capabilities, ADC-only channels and independent PWM/Tone mapping`, () => {
    const model = resolveAvrResourceModel(identity), graph = model.resource_graph;
    assert.equal(graph.resources.filter(r => r.type === 'gpio').length, snapshot.digital);
    assert.equal(graph.resources.filter(r => r.type === 'adc-channel').length, snapshot.analog);
    assert.equal(snapshot.digital, 20); assert.equal(snapshot.analog, 8);
    assert.deepEqual(snapshot.analogGpio, [14, 15, 16, 17, 18, 19, -1, -1]);
    for (const channel of [6, 7]) {
      assert.equal(model.adc[`A${channel}`], `adc.${channel}`);
      assert.ok(graph.resources.some(r => r.id === `adc.${channel}`));
      assert.ok(!graph.routes.some(r => r.resource === `adc.${channel}`));
      assert.ok(!graph.resources.some(r => r.type === 'gpio' && r.aliases.includes(`A${channel}`)));
      assert.ok(!graph.resources.some(r => r.id === `gpio.${snapshot.analogPins[channel]}`));
    }
    assert.deepEqual(model.pwm, Object.fromEntries(snapshot.timers.filter(t => t.timer !== 'NOT_ON_TIMER').map(t => [t.pin, t.timer])));
    assert.equal(model.coreDependencies.tone.resource, snapshot.toneTimer);
    for (const [controller, signals] of [['spi', snapshot.spi], ['i2c', snapshot.i2c]]) {
      for (const [signal, pin] of Object.entries(signals).filter(([key]) => key !== 'ss')) {
        assert.deepEqual(graph.routes.find(r => r.resource === controller && r.signal === signal).pins, [`gpio.${pin}`]);
      }
    }
  });
  test(`${identity.fqbn}: real Blink/ADC/PWM/Serial, read-only production bridge`, async () => {
    setup.setBlocklyBoard(identity.fqbn); setArduinoGeneratorTarget(identity.fqbn);
    const ws = new Blockly.Workspace();
    try {
      add(ws, 'set_pin_mode', '13').setFieldValue('OUTPUT', 'MODE');
      add(ws, 'io_digital_write', '13');
      for (const channel of [0, 6, 7]) add(ws, 'io_analog_read', `A${channel}`);
      for (const { pin, timer } of snapshot.timers) if (timer !== 'NOT_ON_TIMER') add(ws, 'io_analog_write', String(pin), 128);
      const serial = ws.newBlock('serial_setup'); const baud = ws.newBlock('math_number'); baud.setFieldValue(9600, 'NUM');
      serial.getInput('BAUD').connection.connect(baud.outputConnection); ws.newBlock('serial_print_number');
      const before = JSON.stringify(Blockly.serialization.workspaces.save(ws));
      const cpp = arduinoGenerator.workspaceToCode(ws);
      const file = new URL('../components/arduino_generator.ts', import.meta.url), bytes = await readFile(file);
      const r = analyzeProductionResolvedResources(identity, ws);
      assert.equal(r.status, 'ready'); assert.equal(r.report.conflicts.length, 0);
      for (const resource of ['gpio.13', 'adc.0', 'adc.6', 'adc.7', 'uart0', ...Object.values(r.model.pwm)]) assert.ok(r.report.usages.some(u => u.resource === resource), resource);
      assert.ok(!r.claims.some(c => c.resource === 'spi'));
      assert.ok(!r.report.usages.some(u => ['gpio.20', 'gpio.21'].includes(u.resource)));
      assert.equal(r.claims.find(c => c.resource === 'uart0').configuration.baud, 9600);
      assert.equal(r.coverage.analysisCoverage, 'full');
      assert.equal(r.coverage.hardwareEvidence, 'source-verified-not-hardware-tested');
      assert.equal(r.coverage.projectCoverage, 'partial');
      assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), before);
      assert.equal(arduinoGenerator.workspaceToCode(ws), cpp); assert.deepEqual(await readFile(file), bytes);
      assert.equal(analyzeProductionResolvedResources(null, ws), null);
      add(ws, 'io_digital_write', 'A6');
      const invalid = analyzeProductionResolvedResources(identity, ws);
      assert.equal(invalid.coverage.declarationCoverage, 'partial');
      assert.ok(!invalid.claims.some(c => c.resource === 'gpio.20'));
      add(ws, 'write_servo', '9');
      const servo = analyzeProductionResolvedResources(identity, ws);
      assert.ok(servo.gaps.some(g => g.code === 'builtin-claim-not-covered'));
      assert.ok(!servo.claims.some(c => c.resource === 'TIMER1' && c.exclusive));
    } finally { ws.dispose(); }
  });
  test(`${identity.fqbn}: CONTRACT FIXTURE bus sharing, collisions and timer conflict; no product coverage claim`, () => {
    const model = resolveAvrResourceModel(identity);
    for (const [bus, values, type] of [['i2c', [0x3c, 0x68], 'integer'], ['spi', ['gpio.4', 'gpio.7'], 'id']]) {
      const templates = values.map((v, i) => ({ id: `dev${i}`, resource: fixed(bus), owner: fixed(`device${i}`), role: 'device', discriminator: fixed(v, type) }));
      assert.equal(fixture(model, templates).report.conflicts.length, 0);
      templates[1].discriminator = templates[0].discriminator;
      assert.ok(fixture(model, templates).report.conflicts.some(c => c.code === 'discriminator-conflict'));
      assert.deepEqual(fixture(model, templates), fixture({ resource_graph: model.resource_graph, id: 'independent-vendor', name: 'Not Nano' }, templates));
    }
    const timer = model.coreDependencies.tone.resource;
    const channel = model.resource_graph.resources.find(r => r.parent === timer && r.type === 'pwm-channel').id;
    const claims = fixture(model, [
      { id: 'tone', resource: fixed(timer), owner: fixed('tone'), role: 'tone', exclusive: true },
      { id: 'pwm', resource: fixed(channel), owner: fixed('pwm'), role: 'hardware-pwm' },
    ]).claims;
    assert.ok(analyzeHardwareResources(model.resource_graph, claims).conflicts.some(c => c.resource === timer && c.code === 'exclusive-conflict'));
  });
}
