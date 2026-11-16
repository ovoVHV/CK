import assert from 'node:assert/strict';
import { createHash } from 'node:crypto';
import { readFile } from 'node:fs/promises';
import test from 'node:test';
import ts from 'typescript';

const loadTypeScriptModule = async (relativePath) => {
    const url = new URL(relativePath, import.meta.url);
    const source = await readFile(url, 'utf8');
    const executableSource = relativePath === './block_dock.ts'
        ? source.replace(
            /import \{[\s\S]*?\} from '\.\/blockly_locale';/,
            `
const getBlocklyBlockLabel = () => '';
const getBlocklyCategoryLabel = (value) => String(value ?? '');
const translateBlocklyText = (value) => String(value ?? '');
`,
        )
        : source;
    const transpiled = ts.transpileModule(executableSource, {
        compilerOptions: {
            module: ts.ModuleKind.ESNext,
            target: ts.ScriptTarget.ES2022,
        },
        fileName: relativePath,
        reportDiagnostics: true,
    });
    assert.deepEqual(
        (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
        [],
        `${relativePath} should transpile for the identity gate`,
    );
    return import(`data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`);
};

const [dock, serial, lastWorkingPresentation, boardIdentity, buildResult] = await Promise.all([
    loadTypeScriptModule('./block_dock.ts'),
    loadTypeScriptModule('./serial_field_identity.ts'),
    loadTypeScriptModule('./last_working_version_presentation.ts'),
    loadTypeScriptModule('./board_selector_identity.ts'),
    loadTypeScriptModule('./build_operation_result.ts'),
]);

const sha256 = value => createHash('sha256').update(value).digest('hex');

const semanticBlockState = workspace => workspace.blocks.blocks.map(block => ({
    id: block.id,
    type: block.type,
    fields: structuredClone(block.fields || {}),
    inputs: structuredClone(block.inputs || {}),
}));

test('zh-CN/en-US hot presentation switching cannot mutate project, build, recovery or serial identity', () => {
    const workspace = {
        blocks: {
            languageVersion: 0,
            blocks: [{
                type: 'controls_if',
                id: 'block-if-001',
                x: 48,
                y: 80,
                fields: { MODE: 'IF' },
                inputs: {
                    IF0: {
                        block: {
                            type: 'logic_compare',
                            id: 'block-compare-002',
                            fields: { OP: 'EQ' },
                        },
                    },
                },
            }],
        },
    };
    const serializedWorkspace = JSON.stringify(workspace);
    const generatedCpp = 'void setup() {}\nvoid loop() { if (sensor == 0) {} }\n';
    const fqbn = 'esp32:esp32:esp32c3:FlashSize=4M';
    const buildIdentity = {
        workspaceSha256: sha256(serializedWorkspace),
        generatedCodeSha256: sha256(generatedCpp),
        fqbn,
        buildSignature: 'Fast|esp32-core@3.3.0|release',
    };
    const lastWorkingEvidence = {
        id: 'lwv-001',
        workspaceSha256: buildIdentity.workspaceSha256,
        generatedCodeSha256: buildIdentity.generatedCodeSha256,
        fqbn,
        buildSignature: buildIdentity.buildSignature,
        firmwareManifestSha256: 'f'.repeat(64),
    };
    const generatedField = serial.createGeneratedSerialField(1);
    const sourceField = serial.createSourceSerialField('温度');
    const serialRecord = {
        values: {
            [generatedField.fieldId]: 17,
            [sourceField.fieldId]: 24,
        },
        fields: {
            [generatedField.fieldId]: generatedField,
            [sourceField.fieldId]: sourceField,
        },
        format: 'numbers',
    };

    const machineBefore = structuredClone({
        serializedWorkspace,
        blocks: semanticBlockState(workspace),
        generatedCpp,
        fqbn,
        buildIdentity,
        buildIdentityHash: sha256(JSON.stringify(buildIdentity)),
        lastWorkingEvidence,
        lastWorkingEvidenceHash: sha256(JSON.stringify(lastWorkingEvidence)),
        serialRecord,
        serialFieldIds: Object.keys(serialRecord.values),
    });

    const zhEntry = {
        type: 'controls_if',
        category_id: 'logic',
        category: '逻辑',
        keywords: [],
        source: 'toolbox',
    };
    const enEntry = { ...zhEntry, category: 'Logic' };
    const zhPin = dock.createBlockDockPin(zhEntry);
    const enPin = dock.createBlockDockPin(enEntry);
    const zhPresentation = {
        generatedField: serial.getSerialFieldDisplayLabel(generatedField, 'zh-CN'),
        diffGroup: lastWorkingPresentation.lastWorkingDiffGroupLabel(
            'workspace',
            lastWorkingPresentation.LAST_WORKING_DIFF_GROUP_LABELS_ZH_CN,
        ),
        category: zhPin.label,
    };
    const enPresentation = {
        generatedField: serial.getSerialFieldDisplayLabel(generatedField, 'en-US'),
        diffGroup: lastWorkingPresentation.lastWorkingDiffGroupLabel(
            'workspace',
            lastWorkingPresentation.lastWorkingDiffGroupLabelsForLocale('en-US'),
        ),
        category: enPin.label,
    };

    assert.notDeepEqual(zhPresentation, enPresentation, 'visible labels should be able to hot-switch');
    assert.deepEqual(
        { key: zhPin.key, value: zhPin.value },
        { key: enPin.key, value: enPin.value },
        'translated category labels must share one category identity',
    );
    assert.equal(boardIdentity.boardCategoryId({ fqbn }), 'esp32');
    assert.equal(buildResult.completedBuildOperationResult('compile'), 'compile_succeeded');

    const machineAfter = {
        serializedWorkspace: JSON.stringify(workspace),
        blocks: semanticBlockState(workspace),
        generatedCpp,
        fqbn,
        buildIdentity,
        buildIdentityHash: sha256(JSON.stringify(buildIdentity)),
        lastWorkingEvidence,
        lastWorkingEvidenceHash: sha256(JSON.stringify(lastWorkingEvidence)),
        serialRecord,
        serialFieldIds: Object.keys(serialRecord.values),
    };

    assert.deepEqual(machineAfter, machineBefore);
    assert.equal(serialRecord.fields[generatedField.fieldId].fieldId, 'serial.generated.1');
    assert.equal(sourceField.fieldId, 'serial.source.6e29-5ea6');
});

test('high-risk control-flow boundaries retain machine codes instead of translated copy', async () => {
    const read = relativePath => readFile(new URL(relativePath, import.meta.url), 'utf8');
    const [
        blockDockSource,
        boardSelectorSource,
        libraryManagerSource,
        workspaceSource,
        lastWorkingSource,
        compileIssueSource,
        projectOpenRust,
    ] = await Promise.all([
        read('./block_dock.ts'),
        read('../components/BoardSelector.tsx'),
        read('../components/LibraryManagerModal.tsx'),
        read('../components/Workspace.tsx'),
        read('./last_working_version.ts'),
        read('./compile_issue_cards.ts'),
        read('../../src-tauri/src/project_open.rs'),
    ]);

    assert.match(blockDockSource, /blockDockCategoryId\(entry\) === pin\.value/);
    assert.doesNotMatch(blockDockSource, /blockDockRootCategory\(entry\)[^\n]*pin\.value/);
    assert.doesNotMatch(boardSelectorSource, /activeCategory(?:Id)?\s*===\s*['"]自定义['"]/);
    assert.doesNotMatch(boardSelectorSource, /cleanMsg\.startsWith\([^\n]*正在下载/);
    assert.doesNotMatch(libraryManagerSource, /includes\(\s*['"]超时['"]\s*\)/);
    assert.match(workspaceSource, /isBuildOperationSuccessful\(operationResultCode\)/);
    assert.doesNotMatch(workspaceSource, /(?:includes|startsWith|endsWith)\([^\n]*(?:编译成功|上传成功)/);
    assert.doesNotMatch(lastWorkingSource, /group:\s*['"][^'"]*[\u3400-\u9fff][^'"]*['"]/u);
    assert.match(compileIssueSource, /rawDiagnostic:\s*string/);
    assert.match(compileIssueSource, /explanationCode:\s*CompileIssueExplanationCode/);
    assert.match(projectOpenRust, /Result<ProjectOpenTarget, ErrorDescriptor>/);
    const projectOpenProduction = projectOpenRust.split('#[cfg(test)]')[0];
    assert.doesNotMatch(projectOpenProduction, /(?:contains|starts_with|ends_with)\([^\n]*工程/);
});
