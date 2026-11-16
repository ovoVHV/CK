import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';
import { JSDOM } from 'jsdom';
import { loadResourceModule } from './resource_test_loader.mjs';

const managerSource = await readFile(new URL('./library_manager.ts', import.meta.url), 'utf8');
const constantsStart = managerSource.indexOf('const BLOCK_ID_RE');
const constantsEnd = managerSource.indexOf('\nfunction parseHardwareValidation', constantsStart);
const listStart = managerSource.indexOf('function stringList');
const listEnd = managerSource.indexOf('\nfunction isSafeRelativeEntrypoint', listStart);
const parserStart = managerSource.indexOf('function parseBlockEntry');
const parserEnd = managerSource.indexOf('\n\nfunction parseManifest', parserStart);
const toolboxStart = managerSource.indexOf('function toolboxEntries');
const toolboxEnd = managerSource.indexOf('\n/**\n * Standard custom Blockly package layout', toolboxStart);
assert.ok(constantsStart >= 0 && constantsEnd > constantsStart);
assert.ok(listStart >= 0 && listEnd > listStart);
assert.ok(parserStart >= 0 && parserEnd > parserStart);
assert.ok(toolboxStart >= 0 && toolboxEnd > toolboxStart);

// Keep the test on the production parser implementation without importing the
// Tauri-only filesystem module in Node. This avoids duplicating the parser in
// the regression fixture while keeping parseBlockEntry private to the app.
const parserSource = [
    managerSource.slice(constantsStart, constantsEnd),
    managerSource.slice(listStart, listEnd),
    managerSource.slice(parserStart, parserEnd).replace('function parseBlockEntry', 'export function parseBlockEntry'),
    managerSource.slice(toolboxStart, toolboxEnd).replace('function toolboxEntries', 'export function toolboxEntries'),
].join('\n');
const parserOutput = ts.transpileModule(parserSource, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'library_manager_parser.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (parserOutput.diagnostics || []).filter(diagnostic => diagnostic.category === ts.DiagnosticCategory.Error),
    [],
    'library_manager parser should transpile without syntax errors',
);
const { parseBlockEntry, toolboxEntries } = await import(
    `data:text/javascript;base64,${Buffer.from(parserOutput.outputText).toString('base64')}`,
);

const fixtureRoot = new URL('../../../../examples/resource-contract-fixture/', import.meta.url);
const fixtureManifest = JSON.parse(await readFile(new URL('libraries/orchard_probe/ck-blocks.json', fixtureRoot), 'utf8'));
const fixtureBoard = JSON.parse(await readFile(new URL('board.json', fixtureRoot), 'utf8'));
const { buildBlockCatalog } = await loadResourceModule('./block_catalog.ts');
const { resourceCatalogFromLibraries } = await loadResourceModule('./production_resource_analysis.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const domWindow = new JSDOM('').window;
globalThis.DOMParser = domWindow.DOMParser;
globalThis.XMLSerializer = domWindow.XMLSerializer;

test('package manifest parser preserves claim metadata through catalog and binding', () => {
    const parsedBlock = parseBlockEntry(fixtureManifest.blocks[0]);
    assert.ok(parsedBlock);
    assert.equal(parsedBlock.hardware?.claims?.version, 1);
    assert.equal(parsedBlock.semantics?.purpose, fixtureManifest.blocks[0].semantics.purpose);
    assert.equal(parsedBlock.dependencies?.[0]?.id, 'OrchardProbe.h');
    assert.equal(parsedBlock.generation?.language, 'arduino-cpp');
    assert.equal(parsedBlock.constraints?.length, 0);
    assert.equal(parsedBlock.errors?.length, 0);
    assert.deepEqual(parsedBlock.output, fixtureManifest.blocks[0].output);
    assert.deepEqual(parsedBlock.examples, fixtureManifest.blocks[0].examples);

    // This mirrors the hydrated local package shape consumed by buildBlockCatalog.
    // The fixture itself is also installed through the ZIP -> Rust E2E, so this
    // closes the frontend projection leg without introducing a second metadata path.
    const toolbox = '<xml><category name="Orchard"><block type="orchard_probe_read" /></category></xml>';
    const toolboxCatalog = toolboxEntries(toolbox, {
        schema_version: 2,
        id: fixtureManifest.id,
        dependencies: fixtureManifest.dependencies,
        blocks: [parsedBlock],
    });
    assert.equal(toolboxCatalog[0].hardware?.claims?.version, 1);
    assert.equal(toolboxCatalog[0].semantics?.purpose, fixtureManifest.blocks[0].semantics.purpose);
    assert.equal(toolboxCatalog[0].dependencies?.[0]?.id, 'OrchardProbe.h');
    assert.deepEqual(toolboxCatalog[0].examples, fixtureManifest.blocks[0].examples);
    assert.deepEqual(toolboxCatalog[0].output_contract, fixtureManifest.blocks[0].output);

    const catalog = buildBlockCatalog('orchard:fabric:carrier', toolbox, [{
        id: 'orchard_probe',
        block_manifest: {
            schema_version: 2,
            id: fixtureManifest.id,
            dependencies: fixtureManifest.dependencies,
            blocks: [parsedBlock],
        },
    }]).blocks;
    const [entry] = catalog;
    assert.equal(entry.metadata_source, 'v2');
    assert.equal(entry.hardware?.claims?.version, 1);
    assert.equal(entry.semantics?.purpose, fixtureManifest.blocks[0].semantics.purpose);
    assert.equal(entry.dependencies?.[0]?.id, 'OrchardProbe.h');
    assert.equal(entry.generation?.language, 'arduino-cpp');
    assert.deepEqual(entry.examples, fixtureManifest.blocks[0].examples);
    assert.deepEqual(entry.output_contract, fixtureManifest.blocks[0].output);

    const projectedCatalog = resourceCatalogFromLibraries([{
        id: fixtureManifest.id,
        block_manifest: {
            schema_version: 2,
            id: fixtureManifest.id,
            blocks: [parsedBlock],
        },
        // LibraryManager.loadUserLibraries() supplies this projection. It must
        // remain claim-complete because production prefers it over manifest.blocks.
        block_search_entries: toolboxCatalog,
    }]);
    assert.equal(projectedCatalog[0].hardware?.claims?.version, 1);

    const probeBlock = {
        id: 'probe-instance',
        type: 'orchard_probe_read',
        getFieldValue(name) { return name === 'BUS' ? 'sensor-port' : undefined; },
        getInputTargetBlock(name) {
            return name === 'ADDRESS'
                ? { type: 'math_number', getFieldValue(field) { return field === 'NUM' ? '60' : undefined; } }
                : null;
        },
    };
    const analysis = analyzeDeclaredHardware(fixtureBoard, projectedCatalog, [probeBlock]);
    assert.equal(analysis.report?.coverage, 'full');
    assert.equal(analysis.gaps.length, 0);
    assert.equal(analysis.claims.length, 1);
    assert.equal(analysis.claims[0].resource, 'fabric.sensorbus');
});

test('absent optional declarations stay unknown after local parser and catalog normalization', () => {
    const block = parseBlockEntry({ type: 'old_probe', display_name: 'Old probe', description: 'Legacy description' });
    const toolbox = '<xml><category name="Old"><block type="old_probe" /></category></xml>';
    const [entry] = buildBlockCatalog('arduino:avr:uno', toolbox, [{ id: 'old', block_manifest: { schema_version: 1, id: 'old', blocks: [block] } }]).blocks;
    assert.equal(entry.metadata_source, 'v1-adapted');
    for (const section of ['semantics','hardware','constraints','examples','output']) assert(!entry.metadata_completeness.includes(section), section);
});
