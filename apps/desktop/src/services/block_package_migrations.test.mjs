import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./block_package_migrations.ts', import.meta.url);
const schemaPath = new URL('../../../../docs/schemas/ck-migrations.schema.json', import.meta.url);
const fixturePath = new URL(
    '../../../../examples/importable-packages/ck_example_i2c_sensor_v2/ck-migrations.json',
    import.meta.url,
);
const [source, schemaText, fixtureText] = await Promise.all([
    readFile(sourcePath, 'utf8'),
    readFile(schemaPath, 'utf8'),
    readFile(fixturePath, 'utf8'),
]);
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2020,
    },
    fileName: 'block_package_migrations.ts',
    reportDiagnostics: true,
});
const syntaxErrors = (transpiled.diagnostics || []).filter(
    diagnostic => diagnostic.category === ts.DiagnosticCategory.Error,
);
assert.deepEqual(syntaxErrors, [], 'block_package_migrations.ts should transpile without syntax errors');

const migrations = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);
const {
    BlockPackageMigrationBlockedError,
    BlockPackageMigrationValidationError,
    applyBlockPackageMigration,
    parseBlockPackageMigrationManifest,
    planBlockPackageMigration,
} = migrations;

const schema = JSON.parse(schemaText);
const fixture = JSON.parse(fixtureText);
const defaultRequest = {
    packageId: 'ck_example_i2c_sensor_v2',
    fromVersion: '1.5.0',
    toVersion: '2.0.0',
};
const emptyWorkspace = () => ({ blocks: { languageVersion: 0, blocks: [] } });

const manifest = migrationsList => ({
    schema_version: 1,
    package_id: 'example.package',
    migrations: migrationsList,
});
const rename = (from, to) => ({ op: 'renameBlockType', from, to });
const step = (id, from, to, operations = [rename(`unused_${id}`, `unused_${id}_new`)]) => ({
    id,
    from,
    to,
    operations,
});
const request = (fromVersion, toVersion) => ({
    packageId: 'example.package',
    fromVersion,
    toVersion,
});

test('publishes a closed data-only schema and parses the example contract', () => {
    assert.equal(schema.$schema, 'https://json-schema.org/draft/2020-12/schema');
    assert.equal(schema.additionalProperties, false);
    assert.deepEqual(schema.required, ['schema_version', 'package_id', 'migrations']);
    assert.equal(schema.properties.schema_version.const, 1);
    assert.equal(schema.properties.package_id.$ref, '#/$defs/packageId');
    assert.equal(schema.$defs.migration.additionalProperties, false);
    assert.equal(schema.$defs.renameBlockType.additionalProperties, false);
    assert.equal(schema.$defs.renameField.additionalProperties, false);
    assert.equal(schema.$defs.mapEnum.additionalProperties, false);
    assert.equal(schema.$defs.enumMapping.additionalProperties, false);
    const openObjectSchemas = [];
    const inspectSchema = (node, path = '$') => {
        if (!node || typeof node !== 'object') return;
        if (node.type === 'object' && node.additionalProperties !== false) {
            openObjectSchemas.push(path);
        }
        for (const [key, value] of Object.entries(node)) {
            inspectSchema(value, `${path}.${key}`);
        }
    };
    inspectSchema(schema);
    assert.deepEqual(openObjectSchemas, [], 'every object contract must reject additional properties');
    assert.deepEqual(
        schema.$defs.operation.oneOf.map(entry => entry.$ref),
        [
            '#/$defs/renameBlockType',
            '#/$defs/renameField',
            '#/$defs/mapEnum',
        ],
    );
    assert.equal(schema.$defs.migration.properties.from.$ref, '#/$defs/versionSelector');
    assert.equal(schema.$defs.migration.properties.to.$ref, '#/$defs/semver');

    const parsed = parseBlockPackageMigrationManifest(fixture);
    assert.equal(parsed.schema_version, 1);
    assert.equal(parsed.package_id, 'ck_example_i2c_sensor_v2');
    assert.equal(parsed.migrations[0].from, '>=1.0.0 <2.0.0');
    assert.equal(parsed.migrations[0].to, '2.0.0');
    assert.deepEqual(parsed.migrations[0].operations.map(operation => operation.op), [
        'renameBlockType',
        'renameField',
        'mapEnum',
    ]);
    assert.notEqual(parsed, fixture, 'runtime parsing must return a detached typed contract');
});

test('rejects arbitrary script properties, unsupported operations and loose ranges', () => {
    const withScript = structuredClone(fixture);
    withScript.migrations[0].operations[0].script = 'globalThis.pwned = true';
    assert.throws(
        () => parseBlockPackageMigrationManifest(withScript),
        error => error instanceof BlockPackageMigrationValidationError
            && error.code === 'INVALID_MANIFEST'
            && /script/.test(error.path),
    );

    const executable = structuredClone(fixture);
    executable.migrations[0].operations = [{ op: 'javascript', code: 'return workspace' }];
    assert.throws(
        () => parseBlockPackageMigrationManifest(executable),
        error => error instanceof BlockPackageMigrationValidationError
            && /Only renameBlockType/.test(error.message),
    );

    const looseRange = structuredClone(fixture);
    looseRange.migrations[0].from = '^1.0.0';
    assert.throws(
        () => parseBlockPackageMigrationManifest(looseRange),
        error => error instanceof BlockPackageMigrationValidationError
            && error.path.includes('.from'),
    );
});

test('deeply migrates JSON blocks, inputs, next and shadows without touching opaque state', () => {
    const workspace = {
        blocks: {
            languageVersion: 0,
            blocks: [{
                type: 'ck_example_read_temperature',
                id: 'root',
                fields: { I2C_ADDRESS: '72', LABEL: '根积木' },
                inputs: {
                    SENSOR: {
                        block: {
                            type: 'ck_example_read_temperature',
                            id: 'input-block',
                            fields: { I2C_ADDRESS: '73' },
                        },
                    },
                    DEFAULT: {
                        shadow: {
                            type: 'ck_example_read_temperature',
                            id: 'input-shadow',
                            fields: { I2C_ADDRESS: '72' },
                        },
                    },
                },
                next: {
                    block: {
                        type: 'ck_example_read_temperature',
                        id: 'next-block',
                        fields: { I2C_ADDRESS: '73' },
                    },
                },
                extraState: {
                    rawBlockLikeData: {
                        type: 'ck_example_read_temperature',
                        fields: { I2C_ADDRESS: '72' },
                    },
                },
                mutation: {
                    archived: [{
                        type: 'ck_example_read_temperature',
                        fields: { I2C_ADDRESS: '73' },
                    }],
                },
            }],
        },
    };
    const before = structuredClone(workspace);

    const plan = planBlockPackageMigration(workspace, fixture, defaultRequest);

    assert.deepEqual(workspace, before, 'planning must not mutate caller data');
    assert.equal(plan.status, 'ready');
    assert.equal(plan.canApply, true);
    assert.deepEqual(plan.path, [{
        id: 'legacy-1x-to-2.0.0',
        from: '>=1.0.0 <2.0.0',
        to: '2.0.0',
        operationCount: 3,
    }]);
    assert.equal(plan.changedBlockCount, 4);
    assert.deepEqual(plan.changedBlocks.map(block => block.id), [
        'root',
        'input-block',
        'input-shadow',
        'next-block',
    ]);
    assert.deepEqual(plan.changedBlocks.map(block => [block.originalType, block.migratedType]), [
        ['ck_example_read_temperature', 'ck_example_read_temperature_v2'],
        ['ck_example_read_temperature', 'ck_example_read_temperature_v2'],
        ['ck_example_read_temperature', 'ck_example_read_temperature_v2'],
        ['ck_example_read_temperature', 'ck_example_read_temperature_v2'],
    ]);
    assert.deepEqual(plan.operationDetails.map(detail => ({
        op: detail.operation.op,
        status: detail.status,
        matched: detail.matchedBlockCount,
        changed: detail.changedBlockCount,
    })), [
        { op: 'renameBlockType', status: 'applied', matched: 4, changed: 4 },
        { op: 'renameField', status: 'applied', matched: 4, changed: 4 },
        { op: 'mapEnum', status: 'applied', matched: 4, changed: 4 },
    ]);

    const outputRoot = plan.outputWorkspace.blocks.blocks[0];
    assert.notEqual(plan.outputWorkspace, workspace);
    assert.notEqual(outputRoot, workspace.blocks.blocks[0]);
    assert.equal(outputRoot.type, 'ck_example_read_temperature_v2');
    assert.deepEqual(outputRoot.fields, { ADDRESS: '0x48', LABEL: '根积木' });
    assert.equal(outputRoot.inputs.SENSOR.block.fields.ADDRESS, '0x49');
    assert.equal(outputRoot.inputs.DEFAULT.shadow.fields.ADDRESS, '0x48');
    assert.equal(outputRoot.next.block.fields.ADDRESS, '0x49');
    assert.deepEqual(outputRoot.extraState, before.blocks.blocks[0].extraState);
    assert.deepEqual(outputRoot.mutation, before.blocks.blocks[0].mutation);
    assert.notEqual(outputRoot.extraState, workspace.blocks.blocks[0].extraState);
    assert.equal(
        outputRoot.extraState.rawBlockLikeData.type,
        'ck_example_read_temperature',
        'extraState must remain opaque even when it looks like a block',
    );
    assert.equal(
        outputRoot.mutation.archived[0].fields.I2C_ADDRESS,
        '73',
        'mutation must remain opaque even when it looks like a block',
    );

    const repeated = planBlockPackageMigration(workspace, fixture, defaultRequest);
    assert.deepEqual(repeated, plan, 'planning and audit details must be deterministic');
});

test('applies only ready plans and still returns a detached workspace', () => {
    const workspace = {
        blocks: { blocks: [{
            type: 'ck_example_read_temperature',
            fields: { I2C_ADDRESS: '72' },
        }] },
    };
    const before = structuredClone(workspace);
    const application = applyBlockPackageMigration(workspace, fixture, defaultRequest);

    assert.equal(application.plan.canApply, true);
    assert.equal(application.workspace.blocks.blocks[0].type, 'ck_example_read_temperature_v2');
    assert.equal(application.workspace.blocks.blocks[0].fields.ADDRESS, '0x48');
    assert.notEqual(application.workspace, workspace);
    assert.deepEqual(workspace, before);
});

test('reports an unmapped enum value and preserves it in the blocked preview', () => {
    const workspace = {
        blocks: { blocks: [{
            type: 'ck_example_read_temperature',
            id: 'unmapped',
            fields: { I2C_ADDRESS: '74', KEEP: 'untouched' },
        }] },
    };
    const plan = planBlockPackageMigration(workspace, fixture, defaultRequest);

    assert.equal(plan.status, 'blocked');
    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.unresolved.map(issue => issue.code), ['ENUM_VALUE_UNMAPPED']);
    assert.equal(plan.unresolved[0].value, '74');
    assert.equal(plan.unresolved[0].blockId, 'unmapped');
    assert.deepEqual(plan.outputWorkspace.blocks.blocks[0].fields, {
        ADDRESS: '74',
        KEEP: 'untouched',
    });
    assert.deepEqual(workspace.blocks.blocks[0].fields, {
        I2C_ADDRESS: '74',
        KEEP: 'untouched',
    });

    assert.throws(
        () => applyBlockPackageMigration(workspace, fixture, defaultRequest),
        error => error instanceof BlockPackageMigrationBlockedError
            && error.plan.canApply === false
            && error.plan.unresolved[0].code === 'ENUM_VALUE_UNMAPPED',
    );
});

test('blocks an ambiguous field collision without deleting either value', () => {
    const collisionManifest = structuredClone(fixture);
    collisionManifest.migrations[0].operations = collisionManifest.migrations[0].operations.slice(0, 2);
    const workspace = {
        blocks: { blocks: [{
            type: 'ck_example_read_temperature',
            id: 'collision',
            fields: { I2C_ADDRESS: '72', ADDRESS: '0x49' },
        }] },
    };

    const plan = planBlockPackageMigration(workspace, collisionManifest, defaultRequest);
    const fields = plan.outputWorkspace.blocks.blocks[0].fields;

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.ambiguous.map(issue => issue.code), ['FIELD_NAME_COLLISION']);
    assert.deepEqual(fields, { I2C_ADDRESS: '72', ADDRESS: '0x49' });
    assert.equal(plan.operationDetails[1].status, 'blocked');
    assert.equal(plan.operationDetails[1].matchedBlockCount, 1);
});

test('resolves one multi-step range path and applies operations in declared order', () => {
    const contract = manifest([
        step('one-to-two', '>=1.0.0 <2.0.0', '2.0.0', [rename('old.type', 'middle.type')]),
        step('two-to-three', '2.0.0', '3.0.0', [rename('middle.type', 'new.type')]),
    ]);
    const workspace = { blocks: { blocks: [{ type: 'old.type', id: 'chain' }] } };
    const plan = planBlockPackageMigration(workspace, contract, request('1.8.4', '3.0.0'));

    assert.equal(plan.canApply, true);
    assert.deepEqual(plan.path.map(entry => entry.id), ['one-to-two', 'two-to-three']);
    assert.equal(plan.outputWorkspace.blocks.blocks[0].type, 'new.type');
    assert.equal(plan.changedBlockCount, 1);
    assert.deepEqual(plan.changedBlocks[0].changes.map(change => [change.before, change.after]), [
        ['old.type', 'middle.type'],
        ['middle.type', 'new.type'],
    ]);
});

test('fails closed when no version path exists', () => {
    const contract = manifest([step('one-to-two', '1.0.0', '2.0.0')]);
    const workspace = emptyWorkspace();
    const plan = planBlockPackageMigration(workspace, contract, request('1.0.0', '3.0.0'));

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.path, []);
    assert.deepEqual(plan.unresolved.map(issue => issue.code), ['NO_VERSION_PATH']);
    assert.deepEqual(plan.outputWorkspace, workspace);
    assert.notEqual(plan.outputWorkspace, workspace);
});

test('fails closed when more than one version path reaches the target', () => {
    const contract = manifest([
        step('direct', '1.0.0', '3.0.0'),
        step('via-two', '1.0.0', '2.0.0'),
        step('two-to-three', '2.0.0', '3.0.0'),
    ]);
    const plan = planBlockPackageMigration(emptyWorkspace(), contract, request('1.0.0', '3.0.0'));

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.path, []);
    assert.deepEqual(plan.ambiguous.map(issue => issue.code), ['MULTIPLE_VERSION_PATHS']);
    assert.equal(plan.changedBlockCount, 0);
});

test('detects a reachable migration cycle before considering a partial route', () => {
    const contract = manifest([
        step('one-to-two', '1.0.0', '2.0.0'),
        step('two-to-one', '2.0.0', '1.0.0'),
        step('unreachable-target', '4.0.0', '3.0.0'),
    ]);
    const plan = planBlockPackageMigration(emptyWorkspace(), contract, request('1.0.0', '3.0.0'));

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.path, []);
    assert.deepEqual(plan.ambiguous.map(issue => issue.code), ['VERSION_PATH_CYCLE']);
    assert.match(plan.ambiguous[0].message, /one-to-two.*two-to-one/);
});

test('binds the plan to the declared package ID', () => {
    const workspace = emptyWorkspace();
    const plan = planBlockPackageMigration(workspace, fixture, {
        ...defaultRequest,
        packageId: 'another.package',
    });

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.unresolved.map(issue => issue.code), ['PACKAGE_ID_MISMATCH']);
    assert.equal(plan.changedBlockCount, 0);
    assert.deepEqual(plan.outputWorkspace, workspace);
    assert.notEqual(plan.outputWorkspace, workspace);
});

test('surfaces overlapping declarations as ambiguity instead of order-dependent loss', () => {
    const contract = manifest([
        step('conflict', '1.0.0', '2.0.0', [
            rename('old.type', 'new.a'),
            rename('old.type', 'new.b'),
        ]),
    ]);
    const workspace = { blocks: { blocks: [{ type: 'old.type', id: 'conflict' }] } };
    const plan = planBlockPackageMigration(workspace, contract, request('1.0.0', '2.0.0'));

    assert.equal(plan.canApply, false);
    assert.deepEqual(plan.ambiguous.map(issue => issue.code), ['CONFLICTING_OPERATIONS']);
    assert.deepEqual(plan.ambiguous[0].relatedOperationIndexes, [0, 1]);
    assert.equal(plan.outputWorkspace.blocks.blocks[0].type, 'old.type');
    assert.deepEqual(plan.operationDetails.map(detail => detail.status), ['blocked', 'blocked']);
});
