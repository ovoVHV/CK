import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFileSync } from 'node:fs';
import test from 'node:test';
import * as Blockly from 'blockly';
import 'blockly/blocks';
import { JSDOM } from 'jsdom';
import { loadResourceModule } from './resource_test_loader.mjs';

const { resolveProviderForBlock } = await loadResourceModule('./provider_resolution.ts');
const { buildBlockCatalog } = await loadResourceModule('./block_catalog.ts');
const { analyzeDeclaredHardware } = await loadResourceModule('./resource_claim_binding.ts');
const { resolveAvrResourceModel } = await loadResourceModule('./avr_resource_model.ts');
const { resolveEsp32FamilyResourceModel } = await loadResourceModule('./esp32_resource_family.ts');
const runtime = await loadResourceModule('./declarative_block_runtime.ts');
const root = new URL('../../../../', import.meta.url);
const dom = new JSDOM('');
globalThis.DOMParser = dom.window.DOMParser;
globalThis.XMLSerializer = dom.window.XMLSerializer;

const read = path => readFileSync(new URL(path, root), 'utf8');
const readJson = path => JSON.parse(read(path));
const sha256 = value => createHash('sha256').update(value).digest('hex');
const clone = value => structuredClone(value);
function deepFreeze(value) {
    if (value && typeof value === 'object' && !Object.isFrozen(value)) {
        Object.values(value).forEach(deepFreeze);
        Object.freeze(value);
    }
    return value;
}

const uno = {
    fqbn: 'arduino:avr:uno', mcu: 'atmega328p', variant: 'standard',
    coreVersion: '1.8.8', fCpu: '16000000L', options: {},
};
const c6 = {
    fqbn: 'esp32:esp32:esp32c6', mcu: 'esp32c6', variant: 'esp32c6',
    coreVersion: '3.3.6', fCpu: '160000000L', options: {},
};
const orchard = {
    fqbn: 'orchard:fabric:carrier', mcu: 'fixture-mcu', variant: 'fixture-carrier',
    coreVersion: '1.0.0', fCpu: '1L', options: {},
};
const orchardBoard = readJson('examples/resource-contract-fixture/board.json');

function packageMaterial(directory, boardContext) {
    const manifestPath = `${directory}/ck-blocks.json`;
    const manifest = readJson(manifestPath);
    const metadata = readJson(`${directory}/library.json`);
    const definitions = runtime.parseDeclarativeBlockDocument(read(`${directory}/${manifest.entrypoints.blocks}`));
    const generatorPath = `${directory}/${manifest.entrypoints.generator}`;
    const document = runtime.parseDeclarativeGeneratorDocument(read(generatorPath));
    for (const definition of definitions) {
        if (!Blockly.Blocks[definition.type]) Blockly.defineBlocksWithJsonArray([definition]);
    }
    const toolbox = `<xml><category name="Provider audit">${manifest.blocks.map(block =>
        `<block type="${block.type}" />`).join('')}</category></xml>`;
    const catalog = buildBlockCatalog(boardContext.fqbn, toolbox, [{
        id: manifest.id, block_manifest: manifest,
    }]).blocks;
    assert.equal(catalog.length, manifest.blocks.length);
    assert.equal(catalog[0].metadata_source, 'v2');
    assert.deepEqual(catalog[0].hardware, manifest.blocks[0].hardware);
    assert.deepEqual(catalog[0].generation, manifest.blocks[0].generation);
    const rule = document.rules.find(item => item.type === catalog[0].type);
    assert.ok(rule, 'actual validated generator rule must match the catalog block type');
    return {
        directory, manifest, metadata, catalog, rule,
        generator: {
            sourcePackage: manifest.id,
            sourcePath: generatorPath,
            rule,
            ownershipEvidence: [`${manifestPath}#entrypoints.generator`, `${generatorPath}#rules/${rule.type}`],
        },
    };
}

function sourcePart(ref, kind, paths, context) {
    return {
        ref, kind, sourcePaths: paths,
        contentSha256: sha256(paths.map(path => read(path)).join('\n')),
        evidenceRefs: paths.map(path => `${path}#source-snapshot`),
        ...(context ? { boardContext: clone(context), version: context.coreVersion } : {}),
    };
}

function candidate(material, ref, implementation = []) {
    return {
        ref,
        packageId: material.manifest.id,
        packageVersion: material.metadata.version,
        blockType: material.rule.type,
        generator: material.generator,
        implementation,
        declaredSupport: material.manifest.compatibility,
        evidenceRefs: [`${material.directory}/ck-blocks.json`, `${material.directory}/library.json`],
    };
}

function instance(t, material, fields = {}) {
    const workspace = new Blockly.Workspace();
    t.after(() => workspace.dispose());
    const block = workspace.newBlock(material.rule.type);
    for (const [name, value] of Object.entries(fields)) block.setFieldValue(String(value), name);
    return { workspace, block };
}

function blockSnapshot(block) {
    return {
        fields: Object.fromEntries(block.inputList.flatMap(input => input.fieldRow
            .filter(field => field.name).map(field => [field.name, field.getValue()]))),
        inputs: Object.fromEntries(block.inputList.filter(input => input.name).map(input => {
            const target = block.getInputTargetBlock(input.name);
            return [input.name, target ? {
                blockId: target.id,
                blockType: target.type,
                fields: Object.fromEntries(target.inputList.flatMap(child => child.fieldRow
                    .filter(field => field.name).map(field => [field.name, field.getValue()]))),
            } : null];
        })),
    };
}

function claimObservation(material, board, block, boardContext, additionalBlocks = []) {
    const analysis = analyzeDeclaredHardware(board, material.catalog, [block, ...additionalBlocks]);
    assert.ok(analysis.report, 'the existing resource binder must produce the observation');
    return {
        blockId: block.id,
        blockSnapshot: blockSnapshot(block),
        boardContext: clone(boardContext),
        claims: analysis.claims.filter(claim => claim.reference === block.id),
        bindings: analysis.report.bindings.filter(binding => binding.claim.reference === block.id),
        coverage: analysis.report.coverage,
        gaps: [...analysis.gaps, ...analysis.report.gaps],
        conflicts: analysis.report.conflicts,
        evidenceRefs: ['existing:analyzeDeclaredHardware', ...board.resource_graph.evidence.map(item => item.source)],
    };
}

function inputFor(material, block, boardContext, candidates, observation) {
    return {
        blockRef: {
            packageId: material.manifest.id,
            packageVersion: material.metadata.version,
            blockType: block.type,
            blockId: block.id,
        },
        workspaceBlock: block,
        catalog: material.catalog,
        packageDependencies: material.manifest.dependencies ?? [],
        libraryMetadata: [material.metadata],
        candidates,
        boardContext,
        claimObservation: observation,
    };
}

// These are the actual declarative rule outputs, not a compiler invocation.
function generate(material, block) {
    const emitted = { includes: [], declarations: [], setup: [] };
    const host = {
        addInclude: (key, value) => emitted.includes.push([key, value]),
        addDeclaration: (key, value) => emitted.declarations.push([key, value]),
        addSetup: (key, value) => emitted.setup.push([key, value]),
        valueToCode: (current, name) => {
            const operand = current.getInputTargetBlock(name);
            return operand?.type === 'math_number' ? String(operand.getFieldValue('NUM')) : '';
        },
        statementToCode: () => '',
    };
    const output = runtime.bindDeclarativeGeneratorFunction(material.rule, host)(block);
    return { ...emitted, output };
}

function identitySnapshot(material, workspace, block, context) {
    const generated = generate(material, block);
    const code = JSON.stringify(generated);
    // Deliberately in-memory fixtures, not production compile/evidence claims.
    const compileRequest = { fqbn: context.fqbn, code, libraries: [], fast: false };
    const buildIdentity = { context: clone(context), requestHash: sha256(JSON.stringify(compileRequest)) };
    return {
        workspace: Blockly.serialization.workspaces.save(workspace),
        blockId: block.id,
        blockType: block.type,
        fields: block.inputList.flatMap(input => input.fieldRow.filter(field => field.name)
            .map(field => [field.name, field.getValue()])),
        generated,
        compileRequest,
        fqbn: context.fqbn,
        buildIdentity,
        buildHash: sha256(JSON.stringify(buildIdentity)),
        lastWorkingEvidence: { artifact: 'in-memory-fixture', hash: sha256(code) },
    };
}

const cases = [
    { id: 'ck_hw_aht20', fields: { VALUE: '0' }, context: c6 },
    { id: 'ck_hw_servo', fields: { PIN: '9', ANGLE: '90' }, context: uno },
    { id: 'ck_hw_u8g2_oled', fields: { TEXT: 'Provider test', X: '0', Y: '16' }, context: c6 },
    { id: 'ck_hw_vibration_motor', fields: { PIN: '3', VALUE: '128' }, context: uno },
];

for (const item of cases) {
    test(`real ${item.id}: catalog, Blockly, generator and existing claim binding remain read-only`, t => {
        const material = packageMaterial(`packages/block-libraries/${item.id}`, item.context);
        const { workspace, block } = instance(t, material, item.fields);
        const board = item.context === uno ? resolveAvrResourceModel(uno) : resolveEsp32FamilyResourceModel(c6);
        assert.equal(board.status, 'ready');
        const implementations = item.id === 'ck_hw_aht20'
            ? [sourcePart('bundled-driver', 'package-src', [
                `${material.directory}/src/CKAht20.h`, `${material.directory}/src/CKAht20.cpp`,
            ])]
            : item.id === 'ck_hw_vibration_motor'
                ? [sourcePart('avr-core-api', 'core-api', [
                    'packages/arduino/hardware/avr/1.8.8/cores/arduino/wiring_analog.c',
                ], uno)]
                : item.id === 'ck_hw_u8g2_oled'
                    ? [{
                        ref: 'unresolved-display-library',
                        kind: 'external-library',
                        sourcePaths: [], // No selected U8g2 library source was observed.
                        includes: ['U8g2lib.h'],
                        details: {
                            constructor: 'U8G2_SSD1306_128X64_NONAME_F_HW_I2C',
                            transport: 'hardware-i2c',
                        },
                        evidenceRefs: [`${material.generator.sourcePath}#declarations/oled`],
                    }]
                    : [];
        const observation = claimObservation(material, board, block, item.context);
        const input = inputFor(material, block, item.context, [
            candidate(material, `${item.id}:material-only`, implementations),
        ], observation);
        const before = identitySnapshot(material, workspace, block, item.context);
        const result = resolveProviderForBlock(input);
        assert.equal(result.status, 'Partial', 'available source material is not an active selection observation');
        assert.equal(result.selectedCandidateRef, undefined);
        assert.deepEqual(result.implementation, []);
        assert.ok(result.unresolved.includes('provider.not-selected'));
        assert.equal(result.candidates[0].generator.rule.type, block.type);
        assert.deepEqual(result.claims.observation, observation);
        assert.deepEqual(identitySnapshot(material, workspace, block, item.context), before);
        assert.deepEqual(result.dependencies.catalog, material.catalog[0].dependencies);
        assert.deepEqual(result.dependencies.libraryMetadata, [material.metadata]);

        if (item.id === 'ck_hw_aht20') {
            assert.deepEqual(result.candidates[0].implementation[0].sourcePaths, [
                `${material.directory}/src/CKAht20.h`, `${material.directory}/src/CKAht20.cpp`,
            ]);
            assert.ok(result.dependencies.combined.some(dependency => dependency.id === 'Wire.h'));
            assert.ok(result.claims.observation.claims.some(claim =>
                claim.role === 'i2c-device' && claim.discriminator === '56'));
            assert.match(JSON.stringify(before.generated), /ckAht20Read\(0\)/);
        } else if (item.id === 'ck_hw_servo') {
            assert.ok(result.dependencies.combined.some(dependency => dependency.id === 'Servo'));
            assert.equal(result.claims.declaration.coverage, 'partial');
            assert.ok(result.claims.declaration.templates.some(claim => claim.role === 'servo-signal'));
            assert.equal(typeof block.getFieldValue('PIN'), 'number');
            assert.ok(result.claims.observation.gaps.some(gap => gap.code === 'unresolved-claim'),
                'the existing id operand rejects the real Blockly numeric field; report this gap, do not invent binding');
            assert.ok(result.claims.observation.claims.every(claim => !/^timer/i.test(claim.resource)));
            assert.match(JSON.stringify(before.generated), /Servo\.h/);
        } else if (item.id === 'ck_hw_u8g2_oled') {
            assert.ok(result.dependencies.combined.some(dependency => dependency.id === 'U8g2'));
            assert.match(JSON.stringify(result.candidates[0].generator.rule), /U8G2_SSD1306_128X64_NONAME_F_HW_I2C/);
            assert.deepEqual(result.candidates[0].implementation[0].details, {
                constructor: 'U8G2_SSD1306_128X64_NONAME_F_HW_I2C',
                transport: 'hardware-i2c',
            });
            assert.match(material.rule.includes.u8g2, /U8g2lib\.h/);
            assert.match(JSON.stringify(before.generated), /drawUTF8/);
            assert.equal(result.claims.declaration, undefined);
            assert.ok(result.unresolved.includes('claims.declaration.missing'));
        } else {
            assert.match(JSON.stringify(before.generated), /analogWrite\(3, 128\)/);
            assert.equal(result.candidates[0].implementation[0].kind, 'core-api');
            assert.equal(result.claims.declaration, undefined);
        }
    });
}

test('Servo on an ESP32 target retains its partial signal declaration without inventing a library or Timer', t => {
    const material = packageMaterial('packages/block-libraries/ck_hw_servo', c6);
    const { block } = instance(t, material, { PIN: '9', ANGLE: '90' });
    const observation = claimObservation(material, resolveEsp32FamilyResourceModel(c6), block, c6);
    const result = resolveProviderForBlock(inputFor(material, block, c6, [candidate(material, 'servo-unselected')], observation));
    assert.equal(result.status, 'Partial');
    assert.equal(result.selectedCandidateRef, undefined);
    assert.deepEqual(result.implementation, []);
    assert.ok(result.claims.observation.claims.every(claim => !/^timer/i.test(claim.resource)));
    assert.equal(result.claims.declaration.coverage, 'partial');
    assert.match(JSON.stringify(result.candidates[0].generator.rule), /Servo\.h/);
    assert.doesNotMatch(JSON.stringify(result), /ESP32Servo|Timer1/);
});

test('the same analogWrite rule can retain distinct AVR and ESP32 Core material without choosing one', t => {
    const material = packageMaterial('packages/block-libraries/ck_hw_vibration_motor', uno);
    const { block } = instance(t, material, { PIN: '3', VALUE: '128' });
    const candidates = [
        candidate(material, 'avr-core-material', [sourcePart('avr-analogWrite', 'core-api', [
            'packages/arduino/hardware/avr/1.8.8/cores/arduino/wiring_analog.c',
        ], uno)]),
        candidate(material, 'esp32-core-material', [sourcePart('esp32-analogWrite', 'core-api', [
            'packages/esp32/hardware/esp32/3.3.6/cores/esp32/esp32-hal-ledc.c',
        ], c6)]),
    ];
    assert.notEqual(candidates[0].implementation[0].contentSha256, candidates[1].implementation[0].contentSha256);
    for (const context of [uno, c6]) {
        const result = resolveProviderForBlock(inputFor(material, block, context, candidates));
        assert.equal(result.status, 'Partial');
        assert.equal(result.selectedCandidateRef, undefined, 'target context alone must not auto-select');
        assert.equal(result.candidates.length, 2);
        assert.equal(result.candidates[0].generator.rule.template, result.candidates[1].generator.rule.template);
        assert.deepEqual(result.implementation, []);
    }
});

function fixture(t) {
    const directory = 'examples/resource-contract-fixture/libraries/orchard_probe';
    const material = packageMaterial(directory, orchard);
    const { workspace, block } = instance(t, material, { BUS: 'sensor-port' });
    const operand = workspace.newBlock('math_number');
    operand.setFieldValue('60', 'NUM');
    block.getInput('ADDRESS').connection.connect(operand.outputConnection);
    const observation = claimObservation(material, orchardBoard, block, orchard);
    const implementation = sourcePart('fixture-driver', 'package-src', [`${directory}/src/OrchardProbe.h`]);
    implementation.version = 'test-1';
    const chosen = candidate(material, 'fixture-source', [implementation]);
    const input = inputFor(material, block, orchard, [chosen], observation);
    // Isolated, complete-selection fixture. This does not claim that production
    // selected a Provider or that the source package declares a dependency version.
    input.catalog = clone(input.catalog);
    input.catalog[0].dependencies.forEach(dependency => { dependency.version = 'test-1'; });
    input.selections = [{
        candidateRef: chosen.ref,
        boardContext: clone(orchard),
        blockId: block.id,
        blockSnapshot: blockSnapshot(block),
        evidenceRefs: ['synthetic-test:existing-selection-observation'],
        dependencyBindings: [{
            kind: 'header',
            id: 'OrchardProbe.h',
            implementationRef: implementation.ref,
            evidenceRefs: ['synthetic-test:existing-dependency-binding'],
            versionConstraintSatisfied: true,
        }],
    }];
    return { material, workspace, block, operand, input, chosen };
}

function pureInput(input) {
    const { workspaceBlock, ...original } = input;
    const data = clone(original);
    if (workspaceBlock) Object.assign(data.blockRef, blockSnapshot(workspaceBlock));
    return data;
}

test('a third-party field/input block preserves its values and resolved claim binding', t => {
    const { material, workspace, block, operand, input } = fixture(t);
    const before = identitySnapshot(material, workspace, block, orchard);
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Resolved');
    assert.equal(result.selectedCandidateRef, 'fixture-source');
    assert.equal(result.blockRef.fields.BUS, 'sensor-port');
    assert.equal(result.blockRef.inputs.ADDRESS.blockId, operand.id);
    assert.equal(result.blockRef.inputs.ADDRESS.blockType, 'math_number');
    assert.equal(result.blockRef.inputs.ADDRESS.fields.NUM, 60);
    assert.equal(result.claims.observation.claims[0].resource, 'fabric.sensorbus');
    assert.equal(result.claims.observation.claims[0].discriminator, '60');
    assert.deepEqual(identitySnapshot(material, workspace, block, orchard), before);
    assert.equal('compatibility' in result, false, 'resolution is not a support verdict');
});

test('one candidate without an explicit selection is not automatically selected', t => {
    const { input } = fixture(t);
    delete input.selections;
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.equal(result.selectedCandidateRef, undefined);
    assert.deepEqual(result.implementation, []);
    assert.ok(result.unresolved.includes('provider.not-selected'));
});

test('multiple implementation sources and candidates are generic, order independent and not conflicts', t => {
    const { input, chosen } = fixture(t);
    delete input.selections;
    input.candidates = ['package-src', 'external-library', 'core-api', 'sdk-hal', 'vendor', 'other'].map((kind, index) => ({
        ...clone(chosen),
        ref: `arbitrary-provider-${index}`,
        implementation: [{
            ref: `arbitrary-implementation-${index}`,
            kind,
            sourcePaths: [`synthetic-fixture/${kind}/implementation`],
            version: 'test-1',
            boardContext: clone(orchard),
            evidenceRefs: [`synthetic-test:${kind}`],
        }],
    }));
    const first = resolveProviderForBlock(input);
    const reversed = resolveProviderForBlock({ ...input, candidates: [...input.candidates].reverse() });
    const semanticResult = result => ({
        ...result,
        candidates: [...result.candidates].sort((a, b) => a.ref.localeCompare(b.ref)),
    });
    assert.deepEqual(semanticResult(first), semanticResult(reversed));
    assert.equal(first.status, 'Partial');
    assert.equal(first.selectedCandidateRef, undefined);
    assert.equal(first.candidates.length, 6);
    assert.deepEqual(new Set(first.candidates.map(item => item.implementation[0].kind)),
        new Set(['package-src', 'external-library', 'core-api', 'sdk-hal', 'vendor', 'other']));
});

test('an explicit observed selection is echoed among alternatives, independent of candidate order', t => {
    const { input, chosen } = fixture(t);
    input.candidates.push({ ...clone(chosen), ref: 'unselected-alternative' });
    const result = resolveProviderForBlock(input);
    const reverse = resolveProviderForBlock({ ...input, candidates: [...input.candidates].reverse() });
    assert.equal(result.status, 'Resolved');
    assert.equal(reverse.status, 'Resolved');
    assert.equal(result.selectedCandidateRef, 'fixture-source');
    assert.equal(reverse.selectedCandidateRef, 'fixture-source');
    assert.deepEqual(result.implementation, reverse.implementation);
});

test('SDK/HAL and vendor implementations accept an arbitrary target without adding a Board model', t => {
    const { input } = fixture(t);
    const context = {
        fqbn: 'thirdparty:stm32:fixture:transport=vendor', mcu: 'fixture-stm32',
        variant: 'fixture-only', coreVersion: 'test-2', fCpu: '1L', options: { transport: 'vendor' },
    };
    input.boardContext = clone(context);
    input.selections[0].boardContext = clone(context);
    input.claimObservation.boardContext = clone(context);
    for (const kind of ['core-api', 'sdk-hal', 'vendor']) {
        input.candidates[0].implementation.push({
            ref: `fixture-${kind}`,
            kind,
            sourcePaths: [`synthetic-fixture/${kind}`],
            version: 'test-2',
            boardContext: clone(context),
            evidenceRefs: [`synthetic-test:${kind}`],
        });
    }
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Resolved');
    assert.deepEqual(result.boardContext, context);
    assert.deepEqual(result.implementation.map(part => part.kind), ['package-src', 'core-api', 'sdk-hal', 'vendor']);
    assert.equal(result.claims.observation.claims[0].resource, 'fabric.sensorbus',
        'fixture resource data is relayed, not replaced by guessed STM32 facts');
});

test('absent or incomplete board context is Unknown despite complete candidate material', t => {
    const { input } = fixture(t);
    const missing = { ...input, boardContext: undefined };
    assert.equal(resolveProviderForBlock(missing).status, 'Unknown');
    for (const property of ['fqbn', 'mcu', 'variant', 'coreVersion', 'fCpu', 'options']) {
        const context = clone(orchard);
        delete context[property];
        const result = resolveProviderForBlock({ ...input, boardContext: context });
        assert.equal(result.status, 'Unknown', `missing ${property} must not be guessed`);
        assert.equal(result.selectedCandidateRef, undefined);
    }
});

test('selection must match exact FQBN, MCU, variant, Core, CPU and menu context', t => {
    const { input } = fixture(t);
    for (const [property, value] of [
        ['fqbn', 'orchard:fabric:other'], ['mcu', 'other'], ['variant', 'other'],
        ['coreVersion', '2.0.0'], ['fCpu', '2L'], ['options', { cpu: 'other' }],
    ]) {
        const selection = clone(input.selections[0]);
        selection.boardContext[property] = value;
        const result = resolveProviderForBlock({ ...input, selections: [selection] });
        assert.equal(result.status, 'Partial');
        assert.equal(result.selectedCandidateRef, undefined, `${property} mismatch must not select`);
        assert.ok(result.unresolved.includes('provider.selection.stale-context'));
    }
});

test('selection without source evidence is not promoted to Resolved', t => {
    const { input } = fixture(t);
    input.selections[0].evidenceRefs = [];
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.equal(result.selectedCandidateRef, undefined);
    assert.ok(result.unresolved.includes('provider.selection.evidence-missing'));
});

test('missing dependency versions and library resolver paths remain explicit gaps', t => {
    const { input } = fixture(t);
    delete input.catalog[0].dependencies[0].version;
    let result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('dependency.version.unspecified'));
    input.catalog[0].dependencies[0].version = 'test-1';
    input.candidates[0].implementation[0].kind = 'external-library';
    result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('dependency.library-selection.unconfirmed'));
    const selectedLibraryPath = 'examples/resource-contract-fixture/libraries/orchard_probe';
    input.libraryResolverResult = { customLibraries: [selectedLibraryPath], arduinoLibraries: [] };
    input.selections[0].dependencyBindings[0].selectedLibraryPath = selectedLibraryPath;
    result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Resolved', 'existing resolver path evidence is correlated, not recomputed');
});

test('contradictory existing selections are Conflict; ordinary alternatives are not', t => {
    const { input, chosen } = fixture(t);
    input.candidates.push({ ...clone(chosen), ref: 'other-selected-source' });
    input.selections.push({ ...clone(input.selections[0]), candidateRef: 'other-selected-source' });
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Conflict');
    assert.equal(result.selectedCandidateRef, undefined);
    assert.ok(result.unresolved.includes('provider.selection.contradictory'));
});

test('resource conflicts remain resource facts and do not become Provider selection conflicts', t => {
    const { material, workspace, block, input } = fixture(t);
    const second = workspace.newBlock(block.type);
    const address = workspace.newBlock('math_number');
    address.setFieldValue('60', 'NUM');
    second.getInput('ADDRESS').connection.connect(address.outputConnection);
    input.claimObservation = claimObservation(material, orchardBoard, block, orchard, [second]);
    assert.ok(input.claimObservation.conflicts.some(conflict => conflict.code === 'discriminator-conflict'));
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Resolved');
    assert.deepEqual(result.claims.observation.conflicts, input.claimObservation.conflicts);
    assert.equal(result.unresolved.some(code => code.startsWith('provider.selection.')), false);
});

test('a stale binding is not relayed as current resource evidence', t => {
    const { input } = fixture(t);
    input.claimObservation.boardContext = clone(c6);
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.equal(result.claims.observation, undefined);
    assert.ok(result.unresolved.includes('claims.binding.stale-context'));
});

test('changed field/input snapshots invalidate stale claim and selection observations', t => {
    const { input, operand } = fixture(t);
    operand.setFieldValue('61', 'NUM');
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.equal(result.selectedCandidateRef, undefined);
    assert.equal(result.claims.observation, undefined);
    assert.ok(result.unresolved.includes('provider.selection.stale-instance'));
    assert.ok(result.unresolved.includes('claims.binding.stale-context'));
});

test('unverified instance snapshots and empty or foreign claim bindings cannot yield Resolved', t => {
    const { input } = fixture(t);
    const absentSnapshot = pureInput(input);
    delete absentSnapshot.claimObservation.blockSnapshot;
    delete absentSnapshot.selections[0].blockSnapshot;
    let result = resolveProviderForBlock(absentSnapshot);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('claims.binding.instance-unverified'));
    assert.ok(result.unresolved.includes('provider.selection.instance-unverified'));

    const empty = pureInput(input);
    empty.claimObservation.claims = [];
    empty.claimObservation.bindings = [];
    result = resolveProviderForBlock(empty);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('claims.binding.empty'));

    const foreign = pureInput(input);
    foreign.claimObservation.claims[0].reference = 'different-block';
    result = resolveProviderForBlock(foreign);
    assert.equal(result.status, 'Conflict');
    assert.ok(result.unresolved.includes('claims.binding.instance-mismatch'));
});

test('dependency version satisfaction is an existing observation, never inferred from matching strings', t => {
    const { input } = fixture(t);
    delete input.selections[0].dependencyBindings[0].versionConstraintSatisfied;
    let result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('dependency.version-constraint.unverified'));
    input.selections[0].dependencyBindings[0].versionConstraintSatisfied = false;
    result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Conflict');
    assert.ok(result.unresolved.includes('dependency.version-constraint.unsatisfied'));
});

test('an unrelated resolver library path cannot certify an implementation source', t => {
    const { input } = fixture(t);
    input.candidates[0].implementation[0].kind = 'external-library';
    input.libraryResolverResult = { customLibraries: ['synthetic-fixture/unrelated'], arduinoLibraries: [] };
    input.selections[0].dependencyBindings[0].selectedLibraryPath = 'synthetic-fixture/unrelated';
    const result = resolveProviderForBlock(input);
    assert.equal(result.status, 'Partial');
    assert.ok(result.unresolved.includes('dependency.library-source.unconfirmed'));
});

test('deep-frozen pure inputs are unchanged and returned nested data never writes back', t => {
    const { input } = fixture(t);
    const data = pureInput(input);
    const before = clone(data);
    deepFreeze(data);
    const result = resolveProviderForBlock(data);
    assert.equal(result.status, 'Resolved');
    result.candidates[0].implementation[0].sourcePaths.push('result-only');
    result.dependencies.catalog[0].id = 'result-only';
    result.boardContext.options.changed = 'result-only';
    result.claims.observation.claims[0].resource = 'result-only';
    result.claims.declaration.templates[0].role = 'result-only';
    result.selectionObservations[0].evidenceRefs.push('result-only');
    result.generator.rule.template = 'result-only';
    assert.deepEqual(data, before);
});
