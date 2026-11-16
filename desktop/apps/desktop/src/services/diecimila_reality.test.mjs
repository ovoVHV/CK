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
const snapshots = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/diecimila-1.8.8.json', import.meta.url)));
const production = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/diecimila-production-resolved.json', import.meta.url)));
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { analyzeProductionResolvedResources } = await loadResourceModule('./production_resource_analysis.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
async function component(name) {
  const output = new URL(`.diecimila-${name}-${process.pid}.mjs`, import.meta.url);
  await build({ entryPoints: [fileURLToPath(new URL(`../components/${name}.ts`, import.meta.url))], outfile: fileURLToPath(output), bundle: true, platform: 'node', format: 'esm', packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'blockly-singleton', setup(b) { b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true })); } }],
  });
  try { return await import(output.href); } finally { await unlink(output); }
}
const setup = await component('blockly_setup');
const { arduinoGenerator, setArduinoGeneratorTarget } = await component('arduino_generator');
const fixed = (value, valueType = 'id') => ({ kind: 'fixed', valueType, value });
function fixture(model, templates) {
  return analyzeDeclaredHardware(model, [{ type: 'gate_fixture', library_id: 'diecimila-gate', metadata_source: 'v2', fields: [], inputs: [], hardware: { claims: { version: 1, coverage: 'full', templates } } }],
    [{ id: 'fixture', type: 'gate_fixture', getFieldValue: () => null, getInputTargetBlock: () => null }]);
}
function block(ws, type, pin, value) {
  const b = ws.newBlock(type);
  if (pin !== undefined) {
    const selector = ws.newBlock('board_pin_selector'); selector.setFieldValue(String(pin), 'PIN');
    assert.equal(selector.getFieldValue('PIN'), String(pin));
    b.getInput('PIN').connection.connect(selector.outputConnection);
  }
  if (value !== undefined) {
    const number = ws.newBlock('math_number'); number.setFieldValue(value, 'NUM');
    b.getInput('VALUE').connection.connect(number.outputConnection);
  }
  return b;
}
test('fresh independent preprocessing equals admitted evidence for every actual diecimila menu', async () => {
  const boards = await readFile(new URL('packages/arduino/hardware/avr/1.8.8/boards.txt', root), 'utf8');
  const menus = [...boards.matchAll(/^diecimila\.menu\.cpu\.([^.=]+)=/gm)].map(m => m[1]);
  assert.deepEqual(production.processors, menus);
  assert.deepEqual(snapshots.slice(0, -1).map(s => s.identity.options.cpu), menus);
  assert.deepEqual(snapshots.at(-1).identity, production.defaultIdentity);
  const fresh = JSON.parse(execFileSync(process.execPath, ['scripts/Extract-DiecimilaReality.mjs'], { cwd: fileURLToPath(root), encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(fresh, snapshots);
});
for (const data of snapshots) {
  const identity = data.identity;
  test(`${identity.fqbn}: exact production identity, cross-menu rejection and A/B evidence`, () => {
    assert.deepEqual(resolveAvrResourceModel(identity).identity, identity);
    for (const other of snapshots.filter(s => s.identity.fqbn !== identity.fqbn)) {
      assert.equal(resolveAvrResourceModel({ ...identity, fqbn: other.identity.fqbn }).status, 'not-applicable');
    }
    for (const delta of [{ mcu: 'unknown' }, { variant: 'eightanaloginputs' }, { fCpu: '8000000L' }, { coreVersion: '0.0.0' }, { options: { cpu: 'unsupported' } }]) {
      assert.equal(resolveAvrResourceModel({ ...identity, ...delta }).status, 'not-applicable');
    }
    const record = production.applicabilities.find(a => a.identity.fqbn === identity.fqbn);
    if (record) {
      assert.equal(record.productionCompilePair, 'PASS'); assert.equal(record.requestUnchanged, true);
      assert.equal(record.buildSignatureBefore, record.buildSignatureAfter);
      assert.ok(Object.keys(record.firmwareHashes).some(p => p.endsWith('.elf')));
      assert.ok(Object.keys(record.firmwareHashes).some(p => p.endsWith('.hex')));
      for (const bad of Object.values(record.rejected)) assert.equal(resolveAvrResourceModel(bad).status, 'not-applicable');
    }
  });
  test(`${identity.fqbn}: independently extracted capabilities; A6/A7 constants are not exposed ADC`, () => {
    const model = resolveAvrResourceModel(identity), graph = model.resource_graph;
    assert.equal(data.digital, 20); assert.equal(data.analog, 6);
    assert.equal(graph.resources.filter(r => r.type === 'gpio').length, data.digital);
    assert.equal(graph.resources.filter(r => r.type === 'adc-channel').length, data.analog);
    for (let c = 0; c < data.analog; c++) {
      assert.equal(model.adc[`A${c}`], `adc.${c}`);
      assert.deepEqual(graph.routes.find(r => r.resource === `adc.${c}`).pins, [`gpio.${data.analogGpio[c]}`]);
    }
    for (const alias of ['A6', 'A7', '20', '21']) assert.equal(model.adc[alias], undefined);
    assert.ok(!graph.resources.some(r => ['gpio.20', 'gpio.21', 'adc.6', 'adc.7'].includes(r.id)));
    assert.deepEqual(model.pwm, Object.fromEntries(data.timers.filter(t => t.timer !== 'NOT_ON_TIMER').map(t => [t.pin, t.timer])));
    assert.equal(model.coreDependencies.tone.resource, data.toneTimer);
    for (const [bus, signals] of [['spi', data.spi], ['i2c', data.i2c]]) for (const [signal, pin] of Object.entries(signals).filter(([s]) => s !== 'ss')) {
      assert.deepEqual(graph.routes.find(r => r.resource === bus && r.signal === signal).pins, [`gpio.${pin}`]);
    }
  });
  test(`${identity.fqbn}: real Blockly Blink/ADC/PWM/Serial remain immutable under resource analysis`, async () => {
    setup.setBlocklyBoard(identity.fqbn); setArduinoGeneratorTarget(identity.fqbn);
    const ws = new Blockly.Workspace();
    try {
      const start = ws.newBlock('controls_setup_custom'), loop = ws.newBlock('controls_loop_custom');
      const mode = block(ws, 'set_pin_mode', String(data.led)); mode.setFieldValue('OUTPUT', 'MODE');
      // Actual control containers, when present, connect through their production statement input.
      start.inputList.find(i => i.connection?.type === Blockly.NEXT_STATEMENT).connection.connect(mode.previousConnection);
      const write = block(ws, 'io_digital_write', String(data.led));
      loop.inputList.find(i => i.connection?.type === Blockly.NEXT_STATEMENT).connection.connect(write.previousConnection);
      for (let i = 0; i < data.analog; i++) block(ws, 'io_analog_read', `A${i}`);
      for (const t of data.timers.filter(t => t.timer !== 'NOT_ON_TIMER')) block(ws, 'io_analog_write', String(t.pin), 128);
      const serial = ws.newBlock('serial_setup'), baud = ws.newBlock('math_number'); baud.setFieldValue(9600, 'NUM');
      serial.getInput('BAUD').connection.connect(baud.outputConnection); ws.newBlock('serial_print_number');
      const generatorPath = new URL('../components/arduino_generator.ts', import.meta.url), bytes = await readFile(generatorPath);
      const state = () => JSON.stringify({ workspace: Blockly.serialization.workspaces.save(ws), cpp: arduinoGenerator.workspaceToCode(ws), identity });
      const before = state(), hash = createHash('sha256').update(before).digest('hex');
      const r = analyzeProductionResolvedResources(identity, ws);
      assert.equal(r.status, 'ready'); assert.equal(r.report.conflicts.length, 0);
      for (const resource of [`gpio.${data.led}`, 'uart0', 'TIMER0', ...Object.values(r.model.pwm), ...Array.from({ length: data.analog }, (_, i) => `adc.${i}`)]) assert.ok(r.report.usages.some(u => u.resource === resource), resource);
      assert.ok(!r.claims.some(c => c.resource === 'spi' || c.resource === 'i2c'));
      assert.equal(r.claims.find(c => c.resource === 'uart0').configuration.baud, 9600);
      assert.equal(r.coverage.analysisCoverage, 'full'); assert.equal(r.coverage.projectCoverage, 'partial');
      assert.equal(r.coverage.hardwareEvidence, 'source-verified-not-hardware-tested');
      assert.equal(state(), before); assert.equal(createHash('sha256').update(state()).digest('hex'), hash);
      assert.deepEqual(await readFile(generatorPath), bytes); assert.equal(analyzeProductionResolvedResources(null, ws), null);
      block(ws, 'write_servo', '9');
      const partial = analyzeProductionResolvedResources(identity, ws);
      assert.ok(partial.gaps.some(g => g.code === 'builtin-claim-not-covered'));
      assert.ok(!partial.claims.some(c => c.resource === 'TIMER1' && c.exclusive));
    } finally { ws.dispose(); }
  });
  test(`${identity.fqbn}: CONTRACT FIXTURE shared buses/timer conflict use generic analysis`, () => {
    const model = resolveAvrResourceModel(identity);
    for (const [bus, values, type] of [['spi', ['gpio.4', 'gpio.7'], 'id'], ['i2c', [60, 104], 'integer']]) {
      const templates = values.map((v, i) => ({ id: `device${i}`, resource: fixed(bus), role: 'device', owner: fixed(`device${i}`), discriminator: fixed(v, type) }));
      assert.equal(fixture(model, templates).report.conflicts.length, 0);
      templates[1].discriminator = templates[0].discriminator;
      assert.ok(fixture(model, templates).report.conflicts.some(c => c.code === 'discriminator-conflict'));
      assert.deepEqual(fixture(model, templates), fixture({ resource_graph: model.resource_graph, id: 'third-party', name: 'Unrelated', fqbn: 'other:vendor:board' }, templates));
    }
    const timer = model.coreDependencies.tone.resource, pwm = model.resource_graph.resources.find(r => r.parent === timer && r.type === 'pwm-channel').id;
    const result = fixture(model, [
      { id: 'tone', resource: fixed(timer), owner: fixed('tone'), role: 'tone', exclusive: true },
      { id: 'pwm', resource: fixed(pwm), owner: fixed('pwm'), role: 'hardware-pwm' },
    ]);
    assert.ok(result.report.conflicts.some(c => c.resource === timer && c.code === 'exclusive-conflict'));
  });
}
