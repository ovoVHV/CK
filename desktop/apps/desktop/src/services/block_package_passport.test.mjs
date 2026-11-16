import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./block_package_passport.ts', import.meta.url), 'utf8');
const runtimeSource = await readFile(new URL('./block_runtime_activation.ts', import.meta.url), 'utf8');

const runtimeStub = runtimeSource
    .replace(/import type \{[\s\S]*?\} from '\.\.\/types\/library';\s*/, '')
    .replace(/import \{ isCompleteDeclarativeRuntime \} from '\.\/declarative_block_runtime';\s*/, 'const isCompleteDeclarativeRuntime = () => true;\n');
const runtimeTranspiled = ts.transpileModule(runtimeStub, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'block_runtime_activation.ts',
    reportDiagnostics: true,
});
assert.deepEqual((runtimeTranspiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const runtimeUrl = `data:text/javascript;base64,${Buffer.from(runtimeTranspiled.outputText).toString('base64')}`;

const stripped = source
    .replace(/import type \{[\s\S]*?\} from '\.\.\/types\/library';\s*/, '')
    .replace("import { blockRuntimeActivation } from './block_runtime_activation';", `import { blockRuntimeActivation } from '${runtimeUrl}';`);
const transpiled = ts.transpileModule(stripped, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
    fileName: 'block_package_passport.ts',
    reportDiagnostics: true,
});
assert.deepEqual((transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error), []);
const passport = await import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);

const completeBlock = {
    type: 'sensor_read',
    display_name: '读取传感器',
    description: '读取值',
    semantics: { purpose: '读取', behavior: '返回数值' },
    dependencies: [],
    output: null,
    hardware: { resources: [] },
    generation: { language: 'arduino-cpp', shape: 'expression', deterministic: true, emissions: [] },
    constraints: [],
    examples: [],
    errors: [],
};

const trusted = {
    id: 'sensor-pack',
    quality_report: {
        schema_version: 2,
        package_kind: 'block-library',
        package_id: 'sensor-pack',
        status: 'passed',
        source_content_sha256: 'a'.repeat(64),
        error_count: 0,
        warning_count: 0,
        checks: [],
        validated_consumers: ['import-gate', 'runtime-loader'],
    },
    block_manifest: {
        schema_version: 2,
        id: 'sensor-pack',
        entrypoints: {
            blocks: 'blocks/blocks.json',
            generator: 'blocks/ck-generator.json',
            toolbox: 'blocks/toolbox.xml',
        },
        blocks: [completeBlock],
    },
    block_entrypoints: {
        blocks: 'blocks/blocks.json',
        generator: 'blocks/ck-generator.json',
        toolbox: 'blocks/toolbox.xml',
    },
    runtime_activation: {
        state: 'declarative-safe',
        executablePresent: false,
        packageId: 'sensor-pack',
        contentSha256: 'a'.repeat(64),
        reason: 'passed',
    },
};

test('lightweight passport distinguishes existing proof from missing compile and device evidence', () => {
    const result = passport.buildBlockPackagePassport(trusted);
    assert.equal(result.summary, 'attention');
    assert.equal(result.passedStages, 3);
    assert.deepEqual(result.stages.map(stage => [stage.id, stage.status]), [
        ['structure', 'passed'],
        ['semantics', 'passed'],
        ['runtime', 'passed'],
        ['compile', 'pending'],
        ['device', 'pending'],
    ]);
    assert.match(result.boundary, /不代表 CK 官方背书/);
});

test('author declarations are visible without being promoted to independent verification', () => {
    const result = passport.buildBlockPackagePassport({
        ...trusted,
        manifest: {
            name: 'Sensor pack',
            version: '1.0.0',
            hardware_validation: {
                tested_targets: [{
                    fqbn: 'arduino:avr:uno',
                    board_name: 'Arduino Uno',
                    core_version: '1.8.6',
                    levels: ['compile', 'upload', 'runtime'],
                    tested_at: '2026-09-14',
                }],
            },
        },
    });
    assert.equal(result.summary, 'attention');
    assert.equal(result.passedStages, 3);
    assert.equal(result.stages.find(stage => stage.id === 'compile').status, 'declared');
    assert.equal(result.stages.find(stage => stage.id === 'device').status, 'declared');
    assert.equal(result.stages.find(stage => stage.id === 'device').detailParams.targets, 'Arduino Uno');
});

test('legacy javascript is blocked rather than promoted by old trust states', () => {
    const result = passport.buildBlockPackagePassport({
        ...trusted,
        runtime_activation: {
            state: 'legacy-disabled',
            executablePresent: true,
            packageId: 'sensor-pack',
            reason: 'legacy',
        },
    });
    assert.equal(result.summary, 'blocked');
    assert.equal(result.stages.find(stage => stage.id === 'runtime').status, 'failed');
});

test('v1 or incomplete v2 semantics remain warnings and never become compile evidence', () => {
    const v1 = passport.buildBlockPackagePassport({
        ...trusted,
        block_manifest: { schema_version: 1, id: 'sensor-pack', blocks: [completeBlock] },
    });
    assert.equal(v1.stages.find(stage => stage.id === 'semantics').status, 'warning');

    const incomplete = passport.buildBlockPackagePassport({
        ...trusted,
        block_manifest: {
            schema_version: 2,
            id: 'sensor-pack',
            blocks: [{ type: 'partial', display_name: 'Partial', description: 'Partial' }],
        },
    });
    const semantic = incomplete.stages.find(stage => stage.id === 'semantics');
    assert.equal(semantic.status, 'warning');
    assert.match(semantic.detail, /仍缺/);
    assert.equal(incomplete.stages.find(stage => stage.id === 'compile').status, 'pending');
});

test('failed or wrong-kind quality reports fail closed', () => {
    const failed = passport.buildBlockPackagePassport({
        ...trusted,
        quality_report: {
            ...trusted.quality_report,
            package_kind: 'block-library',
            status: 'failed',
            error_count: 2,
            warning_count: 0,
        },
    });
    assert.equal(failed.stages[0].status, 'failed');

    const wrongKind = passport.buildBlockPackagePassport({
        ...trusted,
        quality_report: {
            ...trusted.quality_report,
            package_kind: 'arduino-library',
            status: 'passed',
            error_count: 0,
            warning_count: 0,
        },
    });
    assert.equal(wrongKind.stages[0].status, 'failed');

    const mismatched = passport.buildBlockPackagePassport({
        ...trusted,
        quality_report: { ...trusted.quality_report, package_id: 'another-pack' },
    });
    assert.equal(mismatched.stages[0].status, 'failed');

    const missingIdentity = passport.buildBlockPackagePassport({
        ...trusted,
        quality_report: { ...trusted.quality_report, source_content_sha256: null },
    });
    assert.equal(missingIdentity.stages[0].status, 'warning');

    const pending = passport.buildBlockPackagePassport({
        ...trusted,
        quality_report: { ...trusted.quality_report, status: 'pending' },
    });
    assert.equal(pending.stages[0].status, 'pending');
});

test('declarative-safe label alone cannot create runtime evidence', () => {
    const missingHash = passport.buildBlockPackagePassport({
        ...trusted,
        runtime_activation: { ...trusted.runtime_activation, contentSha256: null },
    });
    assert.equal(missingHash.stages.find(stage => stage.id === 'runtime').status, 'warning');

    const missingEntrypoints = passport.buildBlockPackagePassport({
        ...trusted,
        block_entrypoints: undefined,
        block_manifest: { ...trusted.block_manifest, entrypoints: undefined },
    });
    assert.equal(missingEntrypoints.stages.find(stage => stage.id === 'runtime').status, 'warning');

    const executableFlag = passport.buildBlockPackagePassport({
        ...trusted,
        runtime_activation: { ...trusted.runtime_activation, executablePresent: true },
    });
    assert.equal(executableFlag.stages.find(stage => stage.id === 'runtime').status, 'warning');
});
