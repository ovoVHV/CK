import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import { createHash } from 'node:crypto';
import * as Blockly from 'blockly';
import { loadResourceModule } from './resource_test_loader.mjs';
const root = fileURLToPath(new URL('../../../../', import.meta.url));
const snapshot = JSON.parse(await readFile(new URL('../config/avr-resource-evidence/uno-1.8.8.json', import.meta.url), 'utf8'));
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { analyzeAvrWorkspaceResources } = await loadResourceModule('./avr_builtin_resource_claims.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const { analyzeHardwareResources } = await loadResourceModule('./hardware_resource_graph.ts');
const { analyzeProductionResolvedResources } = await loadResourceModule('./production_resource_analysis.ts');
const identity = { fqbn: snapshot.fqbn, options: {}, mcu: snapshot.mcu, variant: snapshot.variant, coreVersion: snapshot.coreVersion, fCpu: snapshot.fCpu };
async function bundled(name) {
  const output = new URL(`.avr-reality-${name}-${process.pid}.mjs`, import.meta.url);
  await build({ entryPoints: [fileURLToPath(new URL(`../components/${name}.ts`, import.meta.url))], bundle: true, format: 'esm', platform: 'node', packages: 'external', outfile: fileURLToPath(output), logLevel: 'silent',
    plugins: [{ name: 'node-blockly-singleton', setup(b) { b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true })); } }],
  });
  try { return await import(pathToFileURL(fileURLToPath(output)).href); }
  finally { await unlink(output); }
}
const setup = await bundled('blockly_setup');
const { arduinoGenerator, setArduinoGeneratorTarget } = await bundled('arduino_generator');
setup.setBlocklyBoard(identity.fqbn);
setArduinoGeneratorTarget(identity.fqbn);

test('production resolved properties → exact model → real Blockly graph, read-only', { skip: !process.env.CK_AVR_REALITY_OUTPUT }, async () => {
  const evidence = JSON.parse(await readFile(process.env.CK_AVR_REALITY_OUTPUT, 'utf8'));
  assert.equal(evidence.buildSignatureBefore, evidence.buildSignatureAfter);
  assert.equal(evidence.requestUnchanged, true);
  assert.equal(evidence.productionCompilePair, 'PASS');
  const ws = new Blockly.Workspace();
  try {
    add(ws, 'set_pin_mode', '13').setFieldValue('OUTPUT', 'MODE');
    add(ws, 'io_digital_write', '13'); add(ws, 'io_analog_write', '9', 128);
    ws.newBlock('serial_print_number');
    const before = JSON.stringify(Blockly.serialization.workspaces.save(ws));
    const cpp = arduinoGenerator.workspaceToCode(ws);
    const resolvedBefore = JSON.stringify(evidence.cases);
    const result = analyzeProductionResolvedResources(evidence.cases.normal, ws);
    assert.equal(result.status, 'ready');
    for (const resource of ['gpio.13', 'TIMER1A', 'uart0']) assert.ok(result.report.usages.some(u => u.resource === resource));
    assert.equal(result.report.conflicts.length, 0);
    for (const key of ['wrongMcu', 'wrongVariant', 'wrongCore', 'wrongCpu', 'menuContamination']) {
      assert.equal(analyzeProductionResolvedResources(evidence.cases[key], ws).status, 'not-applicable', key);
    }
    assert.equal(analyzeProductionResolvedResources(null, ws), null);
    assert.equal(JSON.stringify(evidence.cases), resolvedBefore);
    assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), before);
    assert.equal(arduinoGenerator.workspaceToCode(ws), cpp);
  } finally { ws.dispose(); }
});

test('Uno evidence exactly matches MCU-preprocessed upstream Core 1.8.8', () => {
  const actual = JSON.parse(execFileSync(process.execPath, ['scripts/Extract-AvrReality.mjs', 'uno'], { cwd: root, encoding: 'utf8', windowsHide: true }));
  assert.deepEqual(actual, snapshot);
});
test('Uno resource applicability accepts verified AVR Core 1.8.6 and rejects other mismatches', () => {
  assert.equal(resolveAvrResourceModel(identity).status, 'ready');
  assert.equal(resolveAvrResourceModel({ ...identity, coreVersion: '1.8.6' }).status, 'ready');
  for (const mismatch of [{ fqbn: 'arduino:avr:nano' }, { mcu: 'atmega168' }, { variant: 'eightanaloginputs' }, { coreVersion: '1.8.7' }, { options: { cpu: 'atmega328' } }, { fCpu: '8000000L' }]) {
    assert.equal(resolveAvrResourceModel({ ...identity, ...mismatch }).status, 'not-applicable');
  }
  assert.equal(resolveAvrResourceModel({ ...identity, displayName: 'Not an Uno' }).status, 'ready');
});
test('Uno capabilities include ADC/controller/timer/channel relationships without claiming SPI usage', () => {
  const model = resolveAvrResourceModel(identity);
  const byType = type => model.resource_graph.resources.filter(r => r.type === type);
  assert.equal(byType('gpio').length, 20);
  assert.equal(byType('adc-channel').length, 6);
  assert.equal(byType('timer').length, 3);
  assert.deepEqual(model.pwm, { 3: 'TIMER2B', 5: 'TIMER0B', 6: 'TIMER0A', 9: 'TIMER1A', 10: 'TIMER1B', 11: 'TIMER2A' });
  assert.equal(model.resource_graph.resources.find(r => r.id === 'TIMER1A').parent, 'TIMER1');
  assert.ok(model.resource_graph.resources.find(r => r.id === 'gpio.13').aliases.includes('SCK'));
});
function add(workspace, type, pin, value) {
  const block = workspace.newBlock(type);
  if (pin !== undefined) {
    const selector = workspace.newBlock('board_pin_selector');
    selector.setFieldValue(String(pin), 'PIN');
    block.getInput('PIN').connection.connect(selector.outputConnection);
  }
  if (value !== undefined) {
    const literal = workspace.newBlock('math_number');
    literal.setFieldValue(value, 'NUM');
    block.getInput('VALUE').connection.connect(literal.outputConnection);
  }
  return block;
}
test('real CK built-in workspace → formal claims/binding, unchanged serialized project and C++', async () => {
  const ws = new Blockly.Workspace();
  try {
    const mode = add(ws, 'set_pin_mode', '13'); mode.setFieldValue('OUTPUT', 'MODE');
    add(ws, 'io_digital_write', '13'); add(ws, 'io_digital_write', '13');
    add(ws, 'io_analog_write', '9', 128); add(ws, 'io_analog_read', 'A0');
    const serial = ws.newBlock('serial_setup');
    const baud = ws.newBlock('math_number'); baud.setFieldValue(9600, 'NUM');
    serial.getInput('BAUD').connection.connect(baud.outputConnection);
    const before = JSON.stringify(Blockly.serialization.workspaces.save(ws));
    const cpp = arduinoGenerator.workspaceToCode(ws);
    const generatorPath = new URL('../components/arduino_generator.ts', import.meta.url);
    const generatorBefore = await readFile(generatorPath);
    const machine = () => ({
      workspace: Blockly.serialization.workspaces.save(ws),
      generatedCpp: arduinoGenerator.workspaceToCode(ws),
      compileInput: { code: arduinoGenerator.workspaceToCode(ws), fqbn: identity.fqbn, options: identity.options },
      resolvedBoard: identity,
    });
    const machineBefore = JSON.stringify(machine());
    const identityDigest = value => createHash('sha256').update(value).digest('hex');
    const digestBefore = identityDigest(machineBefore);
    const result = analyzeAvrWorkspaceResources(identity, ws);
    assert.equal(result.status, 'ready');
    assert.equal(result.report.conflicts.length, 0);
    assert.equal(result.report.usages.find(u => u.resource === 'gpio.13').references.length, 3);
    assert.deepEqual(result.report.usages.find(u => u.resource === 'gpio.13').roles, ['digital-output']);
    assert.equal(result.report.usages.find(u => u.resource === 'gpio.13').owners.length, 1);
    assert.ok(result.claims.some(c => c.resource === 'TIMER1A'));
    assert.ok(result.claims.some(c => c.resource === 'adc.0'));
    assert.ok(result.claims.some(c => c.resource === 'uart0'));
    assert.ok(result.report.bindings.some(b => b.resource.id === 'adc.0' && b.ancestors.includes('adc')));
    for (const pin of ['gpio.0', 'gpio.1']) assert.ok(result.report.bindings.some(b => b.resource.id === pin && b.claim.role.startsWith('uart0.')));
    assert.ok(!result.claims.some(c => c.resource === 'spi'));
    assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), before);
    assert.equal(arduinoGenerator.workspaceToCode(ws), cpp);
    assert.equal(JSON.stringify(machine()), machineBefore);
    assert.equal(identityDigest(JSON.stringify(machine())), digestBefore);
    assert.deepEqual(await readFile(generatorPath), generatorBefore);
  } finally { ws.dispose(); }
});

test('real input/pullup and serial selector defaults use actual block inputs', () => {
  const ws = new Blockly.Workspace();
  try {
    const mode = add(ws, 'set_pin_mode', '2'); mode.setFieldValue('INPUT_PULLUP', 'MODE');
    add(ws, 'io_digital_read', '2');
    const serial = ws.newBlock('serial_setup');
    const selector = ws.newBlock('serial_baudrate_selector');
    selector.setFieldValue('115200', 'BAUD');
    serial.getInput('BAUD').connection.connect(selector.outputConnection);
    const r = analyzeAvrWorkspaceResources(identity, ws);
    assert.equal(r.report.conflicts.length, 0);
    assert.deepEqual(r.report.usages.find(u => u.resource === 'gpio.2').roles, ['digital-input']);
    assert.equal(r.claims.find(c => c.resource === 'uart0').configuration.baud, 115200);
  } finally { ws.dispose(); }
});

test('real Serial implicit initialization follows explicit setup, not conflicting default baud', () => {
  const ws = new Blockly.Workspace();
  try {
    ws.newBlock('serial_print_number');
    assert.equal(analyzeAvrWorkspaceResources(identity, ws).claims.find(c => c.resource === 'uart0').configuration.baud, 115200);
    const setup = ws.newBlock('serial_begin');
    const number = ws.newBlock('math_number'); number.setFieldValue(9600, 'NUM');
    setup.getInput('CONTENT').connection.connect(number.outputConnection);
    const result = analyzeAvrWorkspaceResources(identity, ws);
    assert.equal(result.report.conflicts.length, 0);
    assert.ok(result.claims.filter(c => c.resource === 'uart0').every(c => c.configuration.baud === 9600));
    assert.match(arduinoGenerator.workspaceToCode(ws), /Serial.begin\(9600\)/);
    // The production generator overwrites one setup slot; do not infer two clients.
    const other = ws.newBlock('serial_setup');
    const otherBaud = ws.newBlock('math_number'); otherBaud.setFieldValue(57600, 'NUM');
    other.getInput('BAUD').connection.connect(otherBaud.outputConnection);
    const ambiguous = analyzeAvrWorkspaceResources(identity, ws);
    assert.equal(ambiguous.coverage.declarationCoverage, 'partial');
    assert.equal(ambiguous.report.conflicts.length, 0);
  } finally { ws.dispose(); }
});

// Explicit Resource Contract fixtures, not CK product block definitions or device support.
function fixture(templates, count = 1, board = resolveAvrResourceModel(identity)) {
  return analyzeDeclaredHardware(board, [{ type: 'contract_fixture', library_id: 'uno-gate-fixture', metadata_source: 'v2', fields: [], inputs: [], hardware: { claims: { version: 1, coverage: 'full', templates } } }],
    Array.from({ length: count }, (_, i) => ({ id: `fixture-${i}`, type: 'contract_fixture', getFieldValue: () => null, getInputTargetBlock: () => null })));
}
const operand = (value, valueType = 'id') => ({ kind: 'fixed', valueType, value });
test('CONTRACT FIXTURE: I2C 0x3c/0x38/0x68 share signals; same segment duplicate address conflicts', () => {
  const templates = [0x3c, 0x38, 0x68].map((address, i) => ({ id: `device${i}`, resource: operand('i2c'), owner: operand(`device${i}`), role: 'i2c-device', discriminator: operand(address, 'integer') }));
  const r = fixture(templates);
  assert.equal(r.claims.length, 3);
  assert.equal(r.report.conflicts.length, 0);
  assert.equal(r.report.gaps.length, 0);
  assert.equal(r.report.usages.filter(u => u.resource === 'i2c').length, 1);
  assert.equal(r.report.usages.find(u => u.resource === 'i2c').owners.length, 3);
  for (const pin of ['gpio.18', 'gpio.19']) assert.equal(r.report.usages.find(u => u.resource === pin).owners.length, 1);
  templates[1].discriminator = operand(0x3c, 'integer');
  assert.ok(fixture(templates).report.conflicts.some(c => c.code === 'discriminator-conflict' && c.resource === 'i2c'));
});
test('CONTRACT FIXTURE: SPI shares signals with distinct CS; independent devices on same CS conflict', () => {
  const templates = [4, 7].map((pin, i) => ({ id: `device${i}`, resource: operand('spi'), owner: operand(`device${i}`), role: 'spi-device', discriminator: operand(`gpio.${pin}`) }));
  // CS is both the bus discriminator and a physical GPIO consumer, unlike shared signals.
  const selectors = [4, 7].map((pin, i) => ({ id: `cs${i}`, resource: operand(`gpio.${pin}`), owner: operand(`device${i}`), role: 'chip-select' }));
  const r = fixture([...templates, ...selectors]);
  assert.equal(r.report.conflicts.length, 0);
  assert.equal(r.report.gaps.length, 0);
  for (const pin of ['gpio.11', 'gpio.12', 'gpio.13']) assert.equal(r.report.usages.find(u => u.resource === pin).owners.length, 1);
  for (const pin of ['gpio.4', 'gpio.7']) assert.deepEqual(r.report.usages.find(u => u.resource === pin).roles, ['chip-select']);
  templates[1].discriminator = operand('gpio.4');
  assert.ok(fixture(templates).report.conflicts.some(c => c.code === 'discriminator-conflict' && c.resource === 'spi'));
});
test('CONTRACT FIXTURE: incompatible UART baud requirements conflict at controller', () => {
  const r = fixture([9600, 115200].map((baud, i) => ({ id: `device${i}`, resource: operand('uart0'), owner: operand(`device${i}`), role: 'uart-client', configuration: { baud: operand(baud, 'integer') } })));
  assert.ok(r.report.conflicts.some(c => c.resource === 'uart0' && c.code === 'configuration-conflict'));
});
test('MIXED FIXTURE: actual PWM D3 versus source-confirmed tone timer dependency on D8', () => {
  const ws = new Blockly.Workspace();
  try {
    add(ws, 'io_analog_write', '3', 128);
    const actual = analyzeAvrWorkspaceResources(identity, ws);
    const dependency = actual.model.coreDependencies.tone;
    assert.equal(dependency.resource, snapshot.toneTimer);
    const declaredTone = fixture([
      { id: 'timer', resource: operand(dependency.resource), owner: operand('tone'), role: 'tone', exclusive: dependency.exclusive },
      { id: 'pin', resource: operand('gpio.8'), owner: operand('tone'), role: 'tone-output' },
    ]);
    const combined = [...actual.claims, ...declaredTone.claims].map((c, i) => ({ ...c, id: `combined:${i}` }));
    const result = analyzeHardwareResources(actual.model.resource_graph, combined);
    assert.ok(result.conflicts.some(c => c.resource === snapshot.toneTimer && c.code === 'exclusive-conflict'));
    assert.ok(!result.conflicts.some(c => c.resource.startsWith('gpio.')));
  } finally { ws.dispose(); }
});
test('same legal definition and declarations analyze identically under third-party display/board identities', () => {
  const model = resolveAvrResourceModel(identity);
  const templates = [{ id: 'out', resource: operand('gpio.13'), role: 'digital-output' }];
  assert.deepEqual(fixture(templates), fixture(templates, 1, { resource_graph: model.resource_graph, id: 'independent-board', name: '第三方板卡', fqbn: 'vendor:arch:other' }));
});
test('real PWM channels across two timers and coverage semantics stay separate', () => {
  const ws = new Blockly.Workspace();
  try {
    add(ws, 'io_analog_write', '3', 128); add(ws, 'io_analog_write', '9', 128);
    const r = analyzeAvrWorkspaceResources(identity, ws);
    for (const pin of [3, 9]) {
      const channel = snapshot.timers.find(t => t.pin === pin).timer;
      assert.ok(r.report.bindings.some(b => b.resource.id === channel && b.ancestors.includes(channel.slice(0, -1))));
    }
    assert.equal(r.coverage.declarationCoverage, 'full');
    assert.equal(r.coverage.analysisCoverage, 'full');
    assert.equal(r.coverage.projectCoverage, 'partial');
    assert.equal(r.coverage.hardwareEvidence, 'source-verified-not-hardware-tested');
  } finally { ws.dispose(); }
});
test('Timer0 timebase permits normal PWM; analogWrite zero is digital output, not active PWM', () => {
  const ws = new Blockly.Workspace();
  try {
    add(ws, 'io_analog_write', '5', 128); add(ws, 'io_analog_write', '9', 0);
    const r = analyzeAvrWorkspaceResources(identity, ws);
    assert.ok(r.claims.some(c => c.resource === 'TIMER0' && c.role === 'core-timebase'));
    assert.ok(r.claims.some(c => c.resource === 'TIMER0B'));
    assert.ok(!r.claims.some(c => c.resource === 'TIMER1A'));
    assert.equal(r.report.conflicts.length, 0);
  } finally { ws.dispose(); }
});
test('uncovered Servo is explicit partial and never guessed to occupy Timer1', () => {
  const ws = new Blockly.Workspace();
  try {
    add(ws, 'write_servo', '9');
    const r = analyzeAvrWorkspaceResources(identity, ws);
    assert.equal(r.report.coverage, 'partial');
    assert.ok(r.gaps.some(g => g.code === 'builtin-claim-not-covered'));
    assert.ok(!r.claims.some(c => c.resource === 'TIMER1'));
  } finally { ws.dispose(); }
});
