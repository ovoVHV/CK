import assert from 'node:assert/strict';
import test, { after } from 'node:test';
import { readFile, unlink, writeFile, mkdtemp, rm } from 'node:fs/promises';
import { fileURLToPath } from 'node:url';
import os from 'node:os';
import path from 'node:path';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import 'blockly/blocks';

// Exercise the production loader and both analyzers in one runtime. Only the
// Tauri filesystem transport is substituted; the package bytes are unchanged.
const output = new URL(`.compat-analysis-${process.pid}.mjs`, import.meta.url);
await build({
    stdin: {
        contents: `export * from './extension_loader'; export * from './pin_preflight';
            export * from './resource_claim_binding'; export * from './production_resource_analysis';
            export { default as generator } from '../components/arduino_generator';`,
        resolveDir: fileURLToPath(new URL('.', import.meta.url)), loader: 'ts',
    },
    bundle: true, format: 'esm', platform: 'node', packages: 'external',
    outfile: fileURLToPath(output), logLevel: 'silent',
    plugins: [{ name: 'headless-host', setup(b) {
        b.onResolve({ filter: /^blockly\/core$/ }, () => ({ path: 'blockly', external: true }));
        b.onResolve({ filter: /^ajv\/dist\/2020$/ }, () => ({ path: 'ajv/dist/2020.js', external: true }));
        b.onResolve({ filter: /^@tauri-apps\/plugin-fs$/ }, () => ({ path: 'fs', namespace: 'test-host' }));
        b.onLoad({ filter: /.*/, namespace: 'test-host' }, () => ({ contents:
            `export { readFile, readdir as readDir, stat } from 'node:fs/promises';
             import { readFile } from 'node:fs/promises';
             export const readTextFile = file => readFile(file, 'utf8');` }));
    } }],
});
let api;
try { api = await import(output.href); } finally { await unlink(output); }
const fixture = new URL('./fixtures/hc-sr04-0.2.0/', import.meta.url);
const manifest = JSON.parse(await readFile(new URL('ck-blocks.json', fixture), 'utf8'));
const ext = { id: manifest.id, name: manifest.display_name, dir_path: fileURLToPath(fixture),
    blocks_path: fileURLToPath(new URL('blocks/blocks.json', fixture)),
    generator_path: fileURLToPath(new URL('blocks/ck-generator.json', fixture)), has_generator: true };
await api.registerExtensionBlocks(ext, Blockly);
await api.registerExtensionGenerator(ext, Blockly);
const catalog = manifest.blocks.map(b => ({ ...b, metadata_source: 'v2', library_id: manifest.id }));
const board = {
    name: 'Arduino Uno', fqbn: 'arduino:avr:uno',
    pins: Array.from({ length: 20 }, (_, i) => ({ label: 'D' + i, value: String(i), capabilities: ['digital'] })),
    resource_graph: { version: 1, coverage: 'partial', routes: [],
        evidence: [{ id: 'fixture', source: 'Test fixture; no hardware claim', confidence: 'declared' }],
        resources: [5, 6, 7].map(i => ({ id: 'gpio.' + i, type: 'gpio', aliases: [String(i)], sharing: 'shared', evidence: ['fixture'] })) },
};
function inspect(ws) {
    return api.analyzePinPreflight({ workspace: ws, boardFqbn: board.fqbn, officialBoards: [board],
        blockRules: api.pinBlockRulesFromCatalog(catalog), blockCatalog: catalog });
}
function claims(ws) { return api.analyzeDeclaredHardware(board, catalog, [ws.getBlocksByType(manifest.blocks[0].type)[0]]); }
async function fixtureWorkspace() {
    const ws = new Blockly.Workspace();
    const toolbox = JSON.parse(await readFile(new URL('blocks/toolbox.json', fixture), 'utf8'));
    const category = api.jsonCategoryToXml(toolbox[0]);
    Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(`<xml>${category.match(/<block[\s\S]*<\/block>/)[0]}</xml>`), ws);
    return ws;
}

test('original HC-SR04 package: converted TRIG/ECHO resolve as D5/D6 and preserve generated code', async () => {
    const ws = await fixtureWorkspace();
    try {
        const block = ws.getBlocksByType(manifest.blocks[0].type)[0];
        assert.equal(block.getFieldValue('TRIG'), null, 'reproduce the field-to-input conversion');
        assert.equal(block.getInputTargetBlock('TRIG').getFieldValue('NUM'), 5);
        const before = JSON.stringify(Blockly.serialization.workspaces.save(ws));
        const code = api.generator.forBlock[block.type](block)[0];
        assert.equal(code, 'ckKitHcSr04(5, 6)');
        const report = inspect(ws);
        assert.deepEqual(report.groups.map(g => g.value), ['5', '6']);
        assert.equal(report.usages.filter(u => u.resolution === 'known').length, 2);
        assert.deepEqual(report.issues.map(i => i.code), ['library-hardware-uncovered']);
        const resources = claims(ws);
        assert.deepEqual(resources.claims.map(c => c.resource), ['gpio.5', 'gpio.6']);
        assert(!resources.gaps.some(g => g.code === 'unresolved-claim'));
        assert(resources.gaps.some(g => g.code === 'incomplete-claim-declaration'), 'partial package coverage remains partial');
        assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), before);
        assert.equal(api.generator.forBlock[block.type](block)[0], code);
        const saved = Blockly.serialization.workspaces.save(ws);
        const restored = new Blockly.Workspace();
        try {
            Blockly.serialization.workspaces.load(saved, restored);
            assert.deepEqual(inspect(restored).groups.map(g => g.value), ['5', '6']);
            assert.deepEqual(claims(restored).claims.map(c => c.resource), ['gpio.5', 'gpio.6']);
        } finally { restored.dispose(); }
    } finally { ws.dispose(); }
});

test('converted pins follow edits; out-of-range, missing and dynamic inputs are not treated as defaults', async () => {
    const ws = await fixtureWorkspace();
    try {
        const block = ws.getBlocksByType(manifest.blocks[0].type)[0];
        const trig = block.getInputTargetBlock('TRIG');
        trig.setFieldValue(7, 'NUM');
        assert.deepEqual(inspect(ws).groups.map(g => g.value), ['6', '7']);
        assert.equal(claims(ws).claims[0].resource, 'gpio.7');
        trig.setFieldValue(99, 'NUM');
        assert(inspect(ws).issues.some(i => i.code === 'pin-not-on-board'));
        trig.dispose();
        assert(inspect(ws).issues.some(i => i.code === 'missing-pin-input'));
        const variable = ws.newBlock('variables_get');
        block.getInput('TRIG').connection.connect(variable.outputConnection);
        assert(inspect(ws).issues.some(i => i.code === 'dynamic-pin-expression'));
        assert(claims(ws).gaps.some(g => g.code === 'unresolved-claim'));
        variable.dispose();
        const number = ws.newBlock('math_number'); number.setFieldValue(5, 'NUM');
        block.getInput('TRIG').connection.connect(number.outputConnection);
        assert.deepEqual(inspect(ws).groups.map(g => g.value), ['5', '6']);
        number.setFieldValue(-1, 'NUM');
        assert(inspect(ws).issues.some(i => i.code === 'invalid-pin-literal'));
        number.setFieldValue(5.5, 'NUM');
        assert(inspect(ws).issues.some(i => i.code === 'invalid-pin-literal'));
        number.setFieldValue(0, 'NUM');
        assert.deepEqual(inspect(ws).groups.map(g => g.value), ['0', '6']);
    } finally { ws.dispose(); }
});

test('unregistered lookalike shadow names and undeclared field/input rewrites are not trusted', () => {
    const fake = { id: 'fake', type: manifest.blocks[0].type, getFieldValue: () => null,
        getInputTargetBlock: () => ({ type: 'ck_shadow_number_fake_TRIG', getFieldValue: () => 5 }) };
    const report = inspect({ getAllBlocks: () => [fake] });
    assert.equal(report.groups.length, 0);
    assert.equal(report.usages.filter(u => u.unknownReason === 'invalid_literal').length, 2);
});

test('a different package with a converted dropdown resolves the chosen alias and rejects expressions', async () => {
    const dir = await mkdtemp(path.join(os.tmpdir(), 'ck-pin-dropdown-'));
    const ws = new Blockly.Workspace();
    try {
        const type = 'vendor_pin_selector_fixture';
        const blocks = path.join(dir, 'blocks.json');
        await writeFile(blocks, JSON.stringify([{ type, message0: 'Output %1', args0: [
            { type: 'field_dropdown', name: 'OUTPUT', options: [['First', '5'], ['Second', '6']] },
        ], previousStatement: null, nextStatement: null }]));
        await api.registerExtensionBlocks({ id: 'dropdown_fixture', name: 'Dropdown fixture',
            dir_path: dir, blocks_path: blocks, has_generator: false }, Blockly);
        const xml = api.jsonCategoryToXml({ kind: 'category', name: 'Fixture', contents: [{ kind: 'block', type }] });
        Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(`<xml>${xml.match(/<block[\s\S]*<\/block>/)[0]}</xml>`), ws);
        const block = ws.getBlocksByType(type)[0];
        const entry = { type, metadata_source: 'v2', fields: [{ name: 'OUTPUT' }], inputs: [], hardware: {
            resources: [{ kind: 'gpio', source: { kind: 'field', name: 'OUTPUT' } }],
            claims: { version: 1, coverage: 'full', templates: [{ id: 'gpio', role: 'digital-output',
                resource: { kind: 'field', name: 'OUTPUT', valueType: 'id' } }] },
        } };
        const analyze = () => api.analyzePinPreflight({ workspace: ws, boardFqbn: board.fqbn,
            officialBoards: [board], blockRules: api.pinBlockRulesFromCatalog([entry]) });
        assert.deepEqual(analyze().groups.map(g => g.value), ['5']);
        const input = block.getInputTargetBlock('OUTPUT');
        input.setFieldValue('6', 'VALUE');
        assert.deepEqual(analyze().groups.map(g => g.value), ['6']);
        assert.equal(api.analyzeDeclaredHardware(board, [entry], [block]).claims[0].resource, 'gpio.6');
        input.dispose();
        const expression = ws.newBlock('math_arithmetic');
        block.getInput('OUTPUT').connection.connect(expression.outputConnection);
        assert(analyze().issues.some(i => i.code === 'dynamic-pin-expression'));
        assert.equal(api.analyzeDeclaredHardware(board, [entry], [block]).claims.length, 0);
    } finally { ws.dispose(); await rm(dir, { recursive: true }); }
});

const corpus = new URL('./fixtures/hardware-0.2.0/', import.meta.url);
const sources = JSON.parse((await readFile(new URL('sources.json', corpus), 'utf8')).replace(/^\uFEFF/, ''));
const audit = [];
after(async () => {
    if (process.env.CK_HARDWARE_AUDIT_REPORT) await writeFile(process.env.CK_HARDWARE_AUDIT_REPORT, JSON.stringify({
        boundary: 'Declarative loading and binding only; no hardware certification', packages: sources.length, blocks: audit,
    }, null, 2));
});
const mega = { fqbn: 'arduino:avr:mega:cpu=atmega2560', mcu: 'atmega2560', variant: 'mega', coreVersion: '1.8.6', fCpu: '16000000L', options: { cpu: 'atmega2560' } };
const corpusBoard = { ...board, pins: Array.from({ length: 70 }, (_, i) => ({ label: 'D' + i, value: String(i), capabilities: ['digital', 'digital-input', 'digital-output', 'pwm', 'interrupt'] })) };
for (const source of sources) {
    test(`real package contract → production loader → pin and AVR resource checks: ${source.package}`, async () => {
        const dir = new URL(source.package.replace(/\.zip$/, '/') , corpus);
        const metadata = JSON.parse(await readFile(new URL('ck-blocks.json', dir), 'utf8'));
        const library = { id: metadata.id, name: metadata.display_name, dir_path: fileURLToPath(dir),
            blocks_path: fileURLToPath(new URL(metadata.entrypoints.blocks, dir)), has_generator: false };
        await api.registerExtensionBlocks(library, Blockly);
        const entries = metadata.blocks.map(entry => ({ ...entry, metadata_source: 'v2', library_id: metadata.id }));
        const resourceCatalog = api.resourceCatalogFromLibraries([{ id: metadata.id, block_manifest: metadata }]);
        for (const entry of entries) {
            const ws = new Blockly.Workspace();
            try {
                // Ask the real loader to populate its own numeric/dropdown shadows.
                const category = api.jsonCategoryToXml({ kind: 'category', name: 'Audit', contents: [{ kind: 'block', type: entry.type }] });
                Blockly.Xml.domToWorkspace(Blockly.utils.xml.textToDom(`<xml>${category.match(/<block[\s\S]*<\/block>/)[0]}</xml>`), ws);
                const block = ws.getBlocksByType(entry.type)[0];
                const snapshot = JSON.stringify(Blockly.serialization.workspaces.save(ws));
                const pinReport = api.analyzePinPreflight({ workspace: ws, boardFqbn: board.fqbn, officialBoards: [corpusBoard],
                    blockRules: api.pinBlockRulesFromCatalog(entries), blockCatalog: entries });
                const gpioSources = entry.hardware.resources.filter(r => ['gpio', 'pwm', 'adc', 'interrupt'].includes(r.kind) && r.source?.kind === 'field');
                const expected = gpioSources.map(r => String(entry.fields.find(f => f.name === r.source.name).default));
                assert.deepEqual(pinReport.usages.map(u => u.value), expected, entry.type);
                assert(!pinReport.issues.some(i => i.code === 'invalid-pin-literal'), entry.type);
                assert(pinReport.notices.some(i => i.code === 'library-hardware-uncovered'), 'partial remains explicit');
                const resourceReport = api.analyzeProductionResolvedResources(mega, ws, { catalog: resourceCatalog });
                audit.push({ package: source.package, type: entry.type, expectedPins: expected,
                    actualPins: pinReport.usages.map(u => u.value), declaredClaims: entry.hardware.claims.templates.length,
                    resources: resourceReport.claims?.filter(c => c.reference === block.id).map(c => c.resource),
                    gaps: resourceReport.gaps?.map(g => g.code), coverage: resourceReport.coverage });
                assert.equal(resourceReport.status, 'ready');
                for (const pin of expected) assert(resourceReport.claims.some(c => c.reference === block.id && c.resource === 'gpio.' + pin), `${entry.type}: GPIO ${pin} must reach production`);
                assert(!resourceReport.gaps.some(g => g.code === 'builtin-claim-not-covered'), 'loader-created shadows are operands, not undeclared devices');
                assert(resourceReport.gaps.some(g => g.code === 'incomplete-claim-declaration'));
                assert.equal(JSON.stringify(Blockly.serialization.workspaces.save(ws)), snapshot, 'analysis is read-only');
            } finally { ws.dispose(); }
        }
    });
}

test('package claims reach ESP32 and custom-board production adapters without a library-name branch', async () => {
    const ws = await fixtureWorkspace();
    try {
        const esp = { fqbn: 'esp32:esp32:esp32s3', mcu: 'esp32s3', variant: 'esp32s3', coreVersion: '3.3.6', fCpu: '240000000L', options: {} };
        // Binding-only test: the original package declares AVR support, not ESP32 hardware qualification.
        for (const context of [{ catalog }, { catalog, boardResourceGraph: board.resource_graph }]) {
            const result = api.analyzeProductionResolvedResources(esp, ws, context);
            assert.deepEqual(result.claims.map(c => c.resource), ['gpio.5', 'gpio.6']);
            assert(!result.gaps.some(g => g.code === 'missing-claim-declaration' || g.code === 'builtin-claim-not-covered'));
            assert.equal(result.coverage.declarationCoverage, 'partial');
        }
    } finally { ws.dispose(); }
});

test('absent metadata and unresolved board defaults are disclosed; literal fixed pins need no loader-specific code', () => {
    const block = { id: 'vendor', type: 'vendor_unseen_device', getFieldValue: () => 6, getInputTargetBlock: () => null };
    const inspectEntry = entry => api.analyzePinPreflight({ workspace: { getAllBlocks: () => [block] },
        boardFqbn: board.fqbn, officialBoards: [board], blockCatalog: [entry], blockRules: api.pinBlockRulesFromCatalog([entry]) });
    assert(inspectEntry({ type: block.type, library_id: 'vendor' }).notices.some(n => n.code === 'library-hardware-uncovered'));
    assert(!inspectEntry({ type: block.type, source: 'toolbox' }).notices.some(n => n.code === 'library-hardware-uncovered'), 'a toolbox listing alone is not a library declaration');
    const entry = { type: block.type, library_id: 'vendor', metadata_source: 'v2', hardware: { resources: [{ kind: 'gpio', id: 'led', source: { kind: 'fixed', value: 5 } }], claims: { version: 1, coverage: 'full', templates: [] } } };
    assert.deepEqual(inspectEntry(entry).groups.map(g => g.value), ['5']);
    entry.hardware.resources[0].source = { kind: 'board-default' };
    const unresolved = inspectEntry(entry);
    assert.equal(unresolved.groups.length, 0);
    assert(unresolved.notices.some(n => n.code === 'library-hardware-uncovered'));
    const result = api.analyzeProductionResolvedResources(mega, { getAllBlocks: () => [block] }, { catalog: [{ type: block.type }] });
    assert(result.gaps.some(g => g.code === 'missing-claim-declaration'));
});
