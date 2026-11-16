import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile, unlink } from 'node:fs/promises';
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { fileURLToPath } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import { loadResourceModule } from './resource_test_loader.mjs';

const repo = fileURLToPath(new URL('../../../../', import.meta.url));
const evidenceDir = new URL('../config/avr-resource-evidence/', import.meta.url);
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { analyzeProductionResolvedResources } = await loadResourceModule('./production_resource_analysis.ts');
const { evaluateResourcePreflight } = await loadResourceModule('./resource_preflight.ts');
const { resourceOverviewState } = await loadResourceModule('../components/resource_presentation.ts');

async function component(name) {
  const output = new URL(`.avr186-${name}-${process.pid}.mjs`, import.meta.url);
  await build({
    entryPoints: [fileURLToPath(new URL(`../components/${name}.ts`, import.meta.url))],
    outfile: fileURLToPath(output), bundle: true, platform: 'node', format: 'esm',
    packages: 'external', logLevel: 'silent',
    plugins: [{ name: 'blockly-singleton', setup(b) {
      b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true }));
    } }],
  });
  try { return await import(output.href); } finally { await unlink(output); }
}

const setup = await component('blockly_setup');
const { arduinoGenerator, setArduinoGeneratorTarget } = await component('arduino_generator');
const identityOf = data => data.identity ?? Object.fromEntries(
  ['fqbn', 'options', 'mcu', 'variant', 'coreVersion', 'fCpu'].map(key => [key, data[key]]),
);
const hash = value => createHash('sha256').update(value).digest('hex');

function pinBlock(ws, type, pin, value) {
  const block = ws.newBlock(type);
  const selector = ws.newBlock('board_pin_selector');
  selector.setFieldValue(String(pin), 'PIN');
  assert.equal(selector.getFieldValue('PIN'), String(pin));
  block.getInput('PIN').connection.connect(selector.outputConnection);
  if (value !== undefined) {
    const literal = ws.newBlock('math_number');
    literal.setFieldValue(value, 'NUM');
    block.getInput('VALUE').connection.connect(literal.outputConnection);
  }
  return block;
}

for (const board of ['uno', 'nano', 'diecimila', 'mega']) {
  const file = `${board}-1.8.6.json`;
  const parsed = JSON.parse(await readFile(new URL(file, evidenceDir), 'utf8'));
  const snapshots = board === 'uno' ? [parsed] : parsed;
  const captureUrl = new URL(`${board}-1.8.6-production-resolved.json`, evidenceDir);
  const production = JSON.parse(await readFile(captureUrl, 'utf8'));

  test(`${board}: independent 1.8.6 preprocessing reproduces admitted evidence`, {
    skip: !process.env.CK_AVR186_SOURCE_ROOT,
  }, () => {
    const fresh = JSON.parse(execFileSync(process.execPath, [
      'scripts/Extract-AvrCoreEvidence.mjs',
      process.env.CK_AVR186_SOURCE_ROOT, '1.8.6', board, fileURLToPath(captureUrl),
    ], { cwd: repo, encoding: 'utf8', windowsHide: true, maxBuffer: 8 * 1024 * 1024 }));
    assert.deepEqual(fresh, parsed);
  });

  for (const data of snapshots) {
    const identity = identityOf(data);
    test(`${identity.fqbn}: exact 1.8.6 evidence and fail-closed mismatches`, () => {
      const model = resolveAvrResourceModel(identity);
      assert.equal(model.status, 'ready');
      assert.deepEqual(model.identity, identity);
      assert.equal(resolveAvrResourceModel({ ...identity, coreVersion: '1.8.8' }).status, 'ready');
      for (const delta of [
        { coreVersion: '1.8.7' }, { coreVersion: '0.0.0' }, { mcu: 'unknown' },
        { variant: 'unknown' }, { fCpu: '8000000L' }, { options: { wrong: 'menu' } },
      ]) assert.equal(resolveAvrResourceModel({ ...identity, ...delta }).status, 'not-applicable');
      assert.equal(resolveAvrResourceModel({ ...identity, displayName: 'User renamed board' }).status, 'ready');
      assert.equal(model.resource_graph.resources.filter(r => r.type === 'gpio').length, data.digital);
      assert.equal(model.resource_graph.resources.filter(r => r.type === 'adc-channel').length, data.analog);
      assert.deepEqual(model.pwm, Object.fromEntries(
        data.timers.filter(t => t.timer !== 'NOT_ON_TIMER').map(t => [t.pin, t.timer]),
      ));
      assert.equal(model.coreDependencies.tone.resource, data.toneTimer);
      assert.ok(data.evidence.every(source => /^[0-9a-f]{64}$/.test(source.sha256)));
      assert.ok(data.evidence.every(source => !source.path.includes('/1.8.8/')));
      assert.ok(model.resource_graph.evidence.every(source => !source.source.includes('/1.8.8/')));
    });

    test(`${identity.fqbn}: blocks reach Inspector/Preflight under 1.8.6`, () => {
      setup.setBlocklyBoard(identity.fqbn);
      setArduinoGeneratorTarget(identity.fqbn);
      const ws = new Blockly.Workspace();
      try {
        pinBlock(ws, 'set_pin_mode', '13').setFieldValue('OUTPUT', 'MODE');
        pinBlock(ws, 'io_digital_write', '13');
        pinBlock(ws, 'io_analog_read', 'A0');
        pinBlock(ws, 'io_analog_write', '9', 128);
        ws.newBlock('serial_print_number');
        const workspaceBefore = JSON.stringify(Blockly.serialization.workspaces.save(ws));
        const cppBefore = arduinoGenerator.workspaceToCode(ws);
        const machine = () => JSON.stringify({
          workspace: Blockly.serialization.workspaces.save(ws),
          identity,
          compileRequest: {
            code: arduinoGenerator.workspaceToCode(ws),
            fqbn: identity.fqbn,
            options: identity.options,
          },
        });
        const machineBefore = machine();
        const analysis = analyzeProductionResolvedResources(identity, ws);
        assert.equal(analysis.status, 'ready');
        assert.ok(analysis.report.usages.some(u => u.resource === 'gpio.13' && u.roles.includes('digital-output')));
        assert.ok(!analysis.report.usages.some(u => u.resource === 'spi'));
        const evaluation = evaluateResourcePreflight({
          phase: 'compile', resolvedIdentity: identity, workspace: ws,
        });
        assert.equal(evaluation.report.available, true);
        assert.notEqual(evaluation.report.status, 'unavailable');
        assert.notEqual(resourceOverviewState(evaluation.report), 'unavailable');
        assert.ok(evaluation.inspector);
        assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), workspaceBefore);
        assert.equal(arduinoGenerator.workspaceToCode(ws), cppBefore);
        assert.equal(machine(), machineBefore);
        assert.equal(hash(machine()), hash(machineBefore));
      } finally {
        ws.dispose();
      }
    });
  }

  test(`${board}: captured native production A/B uses 1.8.6`, () => {
    const cases = board === 'uno'
      ? [{ ...production, identity: production.cases.normal }]
      : production.applicabilities;
    assert.ok(cases.length > 0);
    for (const captured of cases) {
      assert.equal(captured.identity.coreVersion, '1.8.6');
      assert.equal(captured.requestUnchanged, true);
      assert.equal(captured.productionCompilePair, 'PASS');
      assert.equal(captured.buildSignatureBefore, captured.buildSignatureAfter);
      assert.equal(resolveAvrResourceModel(captured.identity).status, 'ready');
      if (captured.firmwareHashes) {
        assert.ok(Object.keys(captured.firmwareHashes).some(file => file.endsWith('.hex')));
        assert.ok(Object.keys(captured.firmwareHashes).some(file => file.endsWith('.elf')));
      }
    }
  });
}
