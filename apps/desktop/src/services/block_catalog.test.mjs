import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_catalog.ts', import.meta.url);
const schemaPath = new URL('../../../../docs/schemas/ck-blocks-v2.schema.json', import.meta.url);
const fixturePath = new URL('../../../../examples/metadata-v2/ck-blocks-v2.example.json', import.meta.url);

const source = await readFile(sourcePath, 'utf8');
const schema = JSON.parse(await readFile(schemaPath, 'utf8'));
const fixture = JSON.parse(await readFile(fixturePath, 'utf8'));
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_catalog.ts',
    reportDiagnostics: true,
});

const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'block_catalog.ts should transpile without syntax errors');

const catalog = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

const { isLibraryEligibleForBlockCatalog, normalizeBlockManifestEntry } = catalog;

test('v2 schema and fixture require all machine-readable metadata sections', () => {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.properties.schema_version.const, 2);
    assert.equal(fixture.schema_version, 2);
    assert.deepEqual(
        schema.$defs.block.required.filter(field => [
            'semantics',
            'dependencies',
            'output',
            'hardware',
            'generation',
            'constraints',
            'examples',
            'errors',
        ].includes(field)),
        [
            'semantics',
            'output',
            'dependencies',
            'hardware',
            'generation',
            'constraints',
            'examples',
            'errors',
        ],
    );

    const [block] = fixture.blocks;
    for (const section of [
        'semantics',
        'dependencies',
        'output',
        'hardware',
        'generation',
        'constraints',
        'examples',
        'errors',
    ]) {
        assert.ok(Object.hasOwn(block, section), `fixture must explicitly declare ${section}`);
    }
    assert.equal(fixture.license.spdx_id, 'MIT');
    assert.ok(fixture.dependencies.every(dependency => dependency.kind && dependency.id));
    assert.ok(block.hardware.resources.some(resource => resource.kind === 'i2c'));
    assert.ok(block.generation.emissions.some(emission => emission.section === 'expression'));
    assert.ok(block.errors.every(error => /^[A-Z][A-Z0-9_]*$/.test(error.code)));
});

test('v2 fixture keeps all referenced package paths relative and traversal-free', () => {
    const paths = [
        fixture.license.file,
        fixture.entrypoints.blocks,
        fixture.entrypoints.generator,
        fixture.entrypoints.toolbox,
        ...fixture.blocks.flatMap(block => block.examples.flatMap(example => [
            example.project,
            example.generated_code,
        ])),
    ].filter(Boolean);

    for (const path of paths) {
        assert.doesNotMatch(path, /^(?:[A-Za-z]:|[/\\])/);
        assert.ok(path.split(/[\\/]/).every(segment => segment !== '..'));
    }
});

test('normalizes complete v2 metadata without losing publisher evidence', () => {
    const [block] = fixture.blocks;
    const normalized = normalizeBlockManifestEntry(block, 2, fixture.dependencies);

    assert.equal(normalized.metadata_schema_version, 2);
    assert.equal(normalized.metadata_source, 'v2');
    assert.deepEqual(normalized.metadata_completeness, [
        'semantics',
        'dependencies',
        'output',
        'hardware',
        'generation',
        'constraints',
        'examples',
        'errors',
    ]);
    assert.equal(normalized.semantics.purpose, block.semantics.purpose);
    assert.deepEqual(normalized.output_contract, block.output);
    assert.equal(normalized.dependencies.length, fixture.dependencies.length);
    assert.equal(normalized.hardware.resources[0].kind, 'i2c');
    assert.equal(normalized.generation.language, 'arduino-cpp');
    assert.equal(normalized.constraints[0].id, 'supported-address');
    assert.equal(normalized.examples[0].id, 'serial-temperature');
    assert.equal(normalized.errors[0].code, 'I2C_DEVICE_NOT_FOUND');
});

test('adapts v1 output, requires and string examples without overstating completeness', () => {
    const normalized = normalizeBlockManifestEntry({
        type: 'legacy_temperature',
        display_name: 'Legacy temperature',
        description: 'Reads a temperature from an older manifest.',
        kind: 'value',
        keywords: ['temperature'],
        output: ['Number', 'Decimal'],
        requires: ['Wire.h', 'Wire.h'],
        examples: ['Print the temperature to Serial'],
    }, 1);

    assert.equal(normalized.metadata_source, 'v1-adapted');
    assert.deepEqual(normalized.metadata_completeness, ['output', 'examples']);
    assert.deepEqual(normalized.output_contract, {
        connection: 'value',
        types: ['Number', 'Decimal'],
        nullable: false,
    });
    assert.deepEqual(normalized.dependencies, [{
        kind: 'header',
        id: 'Wire.h',
        headers: ['Wire.h'],
        reason: '由 v1 requires 字段迁移；未计入 v2 完整性证明',
    }]);
    assert.equal(normalized.examples[0].id, 'legacy-example-1');
    assert.equal(normalized.semantics.behavior, 'Reads a temperature from an older manifest.');
    assert.equal(normalized.hardware, undefined);
    assert.deepEqual(normalized.errors, []);
});

test('keeps ambiguous v1 requirements as capabilities instead of inventing headers', () => {
    const normalized = normalizeBlockManifestEntry({
        type: 'legacy_wifi',
        display_name: 'Legacy Wi-Fi',
        description: 'Uses a legacy capability requirement.',
        requires: ['network-access'],
    }, 1);

    assert.deepEqual(normalized.dependencies, [{
        kind: 'capability',
        id: 'network-access',
        reason: '由 v1 requires 字段迁移；未计入 v2 完整性证明',
    }]);
    assert.ok(!normalized.metadata_completeness.includes('dependencies'));
});

test('merges package and block dependencies with stable de-duplication', () => {
    const shared = {
        kind: 'header',
        id: 'Wire.h',
        headers: ['Wire.h'],
    };
    const normalized = normalizeBlockManifestEntry({
        type: 'dependency_test',
        display_name: 'Dependency test',
        description: 'Dependency merge fixture.',
        dependencies: [shared, { kind: 'capability', id: 'i2c-controller' }],
        requires: ['Wire.h'],
    }, 2, [shared]);

    assert.deepEqual(normalized.dependencies.map(dependency => `${dependency.kind}:${dependency.id}`), [
        'header:Wire.h',
        'capability:i2c-controller',
    ]);
});

test('catalog snapshot is explicitly versioned after adding the v2 contract', () => {
    assert.match(source, /schemaVersion:\s*2;/);
    assert.match(source, /schemaVersion:\s*2,/);
    assert.match(source, /\.\.\.normalized/);
    assert.match(source, /package_license:\s*owner\?\.packageLicense/);
});

test('failed or structurally blocked packages cannot enter the trusted block catalog', () => {
    assert.equal(isLibraryEligibleForBlockCatalog({
        quality_report: { status: 'failed' },
        diagnostics: [],
    }), false);
    assert.equal(isLibraryEligibleForBlockCatalog({
        quality_report: { status: 'passed' },
        diagnostics: [{ severity: 'error' }],
    }), false);
    assert.equal(isLibraryEligibleForBlockCatalog({
        quality_report: { status: 'passed_with_warnings' },
        diagnostics: [{ severity: 'warning' }],
    }), true);
});
