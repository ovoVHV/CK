import assert from 'node:assert/strict';
import test from 'node:test';
import { execFile } from 'node:child_process';
import { promisify } from 'node:util';
import { mkdtemp, readFile, realpath, rm } from 'node:fs/promises';
import { tmpdir } from 'node:os';
import { join, resolve, sep } from 'node:path';
import { fileURLToPath } from 'node:url';
import * as Blockly from 'blockly';
import 'blockly/blocks';
import { loadResourceModule, loadResourceBoardNormalizer } from './resource_test_loader.mjs';

const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const { analyzeProductionResolvedResources, resourceCatalogFromLibraries } = await loadResourceModule('./production_resource_analysis.ts');
const { normalizeUserBoard } = await loadResourceBoardNormalizer();
const { buildHardwareResourceInspector } = await loadResourceModule('./hardware_resource_inspector.ts');
const { buildResourcePreflight } = await loadResourceModule('./resource_preflight.ts');

const fixtureProfiles = {
  'resource-contract-fixture': {
    blockType: 'orchard_probe_read',
    field: 'BUS',
    fieldValue: 'sensor-port',
    input: 'ADDRESS',
    literalType: 'math_number',
    literalField: 'NUM',
    values: [60, 56],
    duplicate: 60,
    resource: 'fabric.sensorbus',
    busKind: 'i2c',
  },
  'resource-contract-fixture-esp32': {
    blockType: 'juniper_route_probe',
    field: 'BUS',
    fieldValue: 'sensor-port',
    input: 'ADDRESS',
    literalType: 'math_number',
    literalField: 'NUM',
    values: [60, 56],
    duplicate: 60,
    resource: 'juniper.i2c0',
    busKind: 'i2c',
  },
  'resource-contract-fixture-avr-complex': {
    blockType: 'copper_spi_probe',
    field: 'BUS',
    fieldValue: 'sensor-bus',
    input: 'CS',
    literalType: 'text',
    literalField: 'TEXT',
    values: ['CS-A', 'P10'],
    duplicate: 'CS-A',
    resource: 'copper.spi0',
    busKind: 'spi',
    reservedPin: 'copper.gpio.13',
  },
};

test('third-party ZIP install → Rust gates → IPC payload → real Blockly field/input → binding → analysis', { timeout: 600000 }, async t => {
  const temp = await mkdtemp(join(tmpdir(), 'ck-resource-e2e-'));
  t.after(async () => {
    const target = await realpath(temp), root = await realpath(tmpdir());
    assert.ok(target.startsWith(root + sep));
    await rm(target, { recursive: true, force: true });
  });
  const payloadFile = join(temp, 'installed.json');
  const repo = fileURLToPath(new URL('../../../../', import.meta.url));
  const { stdout } = await promisify(execFile)('cargo', ['test', '--manifest-path', 'apps/desktop/src-tauri/Cargo.toml', '--lib', 'resource_contract', '--no-default-features', '--', '--nocapture'], {
    cwd: repo, env: { ...process.env, CK_RESOURCE_E2E_OUTPUT: payloadFile }, timeout: 540000, maxBuffer: 8 * 1024 * 1024,
  });
  assert.match(stdout, /test result: ok/);
  assert.match(stdout, /resource_contract_e2e_install_export_and_reject_invalid.*ok/);
  const payload = JSON.parse(await readFile(payloadFile, 'utf8'));
  const fixtures = Array.isArray(payload.fixtures) ? payload.fixtures : [payload];
  assert.equal(fixtures.length, 3, 'three independent third-party resource fixtures must be exported');

  for (const fixturePayload of fixtures) {
    const profile = fixtureProfiles[fixturePayload.fixture_id];
    assert.ok(profile, `missing test profile for ${fixturePayload.fixture_id}`);
    const board = normalizeUserBoard(fixturePayload.board);
    assert.equal(board.is_custom, true);
    assert.equal(fixturePayload.boardValidation.error_count, 0);
    assert.equal(fixturePayload.libraryValidation.error_count, 0);
    assert.deepEqual(board.resource_graph, fixturePayload.installedManifest.resource_graph);
    assert.equal(fixturePayload.catalog[0].type, profile.blockType);
    assert.equal(fixturePayload.catalog[0].metadata_source, 'v2');
    Blockly.defineBlocksWithJsonArray(fixturePayload.definitions);
    const workspace = new Blockly.Workspace();
    t.after(() => workspace.dispose());
    function probe(value) {
      const b = workspace.newBlock(profile.blockType);
      b.setFieldValue(profile.fieldValue, profile.field);
      const literal = workspace.newBlock(profile.literalType);
      literal.setFieldValue(String(value), profile.literalField);
      b.getInput(profile.input).connection.connect(literal.outputConnection);
      return { b, literal };
    }
    const a = probe(profile.values[0]), b = probe(profile.values[1]);
    const before = JSON.stringify(Blockly.serialization.workspaces.save(workspace));
    const analysis = analyzeDeclaredHardware(board, fixturePayload.catalog, [a.b, b.b]);
    assert.equal(analysis.report.coverage, 'full');
    assert.equal(analysis.report.conflicts.length, 0);
    assert.equal(analysis.claims.length, 2);
    assert.equal(analysis.claims[0].resource, profile.resource);

    // The live production bridge accepts the same installed graph/catalog
    // explicitly selected by the board package. It must use the generic
    // claim/binding path, while literal helper blocks remain operands only.
    const production = analyzeProductionResolvedResources({
      fqbn: board.fqbn,
      mcu: 'fixture-mcu',
      variant: 'fixture-variant',
      coreVersion: 'fixture-core',
      fCpu: '160000000L',
      options: {},
    }, workspace, {
      boardResourceGraph: board.resource_graph,
      catalog: fixturePayload.catalog,
    });
    assert.equal(production.status, 'ready');
    assert.equal(production.report.coverage, 'full');
    assert.equal(production.claims.length, 2);
    assert.equal(production.claims[0].resource, profile.resource);
    const productionInspector = buildHardwareResourceInspector({
      graph: board.resource_graph,
      analysis: production.report,
      claims: production.claims,
      gaps: production.gaps,
    });
    assert.equal(buildResourcePreflight({ phase: 'compile', analysis: production.report, inspector: productionInspector }).status, 'pass');
    assert.deepEqual(resourceCatalogFromLibraries([{ id: 'fixture', block_manifest: { schema_version: 2, blocks: fixturePayload.catalog } }]).map(entry => entry.type), [profile.blockType]);

    // The exact same graph/analysis feeds the Inspector and Preflight. These
    // are presentation projections; neither reparses generated source.
    const inspector = buildHardwareResourceInspector({
      graph: board.resource_graph,
      analysis: analysis.report,
      claims: analysis.claims,
      gaps: analysis.gaps,
      coverage: {
        declarationCoverage: 'full',
        analysisCoverage: 'full',
        projectCoverage: 'full',
        hardwareEvidence: 'declared-not-hardware-tested',
        hardwareValidation: 'not-tested',
      },
    });
    const preflight = buildResourcePreflight({ phase: 'compile', analysis: analysis.report, inspector });
    assert.equal(preflight.available, true);
    assert.equal(preflight.status, 'pass');
    assert.equal(inspector.buses.filter(bus => bus.id === profile.resource && bus.kind === profile.busKind).length, 1);
    assert.equal(inspector.buses.find(bus => bus.id === profile.resource).devices.length, 2);
    if (profile.reservedPin) assert.equal(inspector.pins.find(pin => pin.id === profile.reservedPin).status, 'reserved');
    if (fixturePayload.fixture_id === 'resource-contract-fixture-esp32') {
      const routes = inspector.buses.find(bus => bus.id === profile.resource).signals;
      assert.ok(routes.some(route => route.mode === 'selectable'));
    }
    assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(workspace)), before);

    b.literal.setFieldValue(String(profile.duplicate), profile.literalField);
    const conflictAnalysis = analyzeDeclaredHardware(board, fixturePayload.catalog, [a.b, b.b]);
    assert.equal(conflictAnalysis.report.conflicts[0].code, 'discriminator-conflict');
    const conflictInspector = buildHardwareResourceInspector({ graph: board.resource_graph, analysis: conflictAnalysis.report, claims: conflictAnalysis.claims });
    const conflictPreflight = buildResourcePreflight({ phase: 'compile', analysis: conflictAnalysis.report, inspector: conflictInspector });
    assert.equal(conflictPreflight.status, 'conflict');
    assert.ok(conflictInspector.conflictTraces.some(trace => trace.resourceId === profile.resource));

    // Renaming every board/package display identity cannot change graph-based analysis.
    const renamed = { ...board, id: 'independent_other_board', name: '其他第三方板', fqbn: 'different:vendor:target' };
    assert.deepEqual(analyzeDeclaredHardware(renamed, fixturePayload.catalog, [a.b, b.b]), conflictAnalysis);

    // Non-literal input must remain unresolved, never code-executed or asserted safe.
    a.b.getInput(profile.input).connection.disconnect();
    const expression = workspace.newBlock('math_arithmetic');
    a.b.getInput(profile.input).connection.connect(expression.outputConnection);
    const unknown = analyzeDeclaredHardware(board, fixturePayload.catalog, [a.b, b.b]);
    assert.equal(unknown.report.coverage, 'partial');
    assert.ok(unknown.gaps.some(g => g.code === 'unresolved-claim'));
  }
  console.log('RESOURCE E2E: three isolated ZIP transactions, installed catalogs, Blockly binding, graph analysis, Inspector and Preflight PASS');
});
