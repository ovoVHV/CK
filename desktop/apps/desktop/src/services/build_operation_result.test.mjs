import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const sourcePath = new URL('./build_operation_result.ts', import.meta.url);
const source = await readFile(sourcePath, 'utf8');
const transpiled = ts.transpileModule(source, {
    compilerOptions: {
        module: ts.ModuleKind.ESNext,
        target: ts.ScriptTarget.ES2022,
    },
    fileName: 'build_operation_result.ts',
    reportDiagnostics: true,
});
assert.deepEqual(
    (transpiled.diagnostics || []).filter(item => item.category === ts.DiagnosticCategory.Error),
    [],
);
const service = await import(
    `data:text/javascript;base64,${Buffer.from(transpiled.outputText).toString('base64')}`
);

test('build completion uses stable result codes instead of localized messages', () => {
    assert.equal(service.completedBuildOperationResult('compile'), 'compile_succeeded');
    assert.equal(service.completedBuildOperationResult('upload'), 'upload_succeeded');
    assert.equal(service.isBuildOperationSuccessful('compile_succeeded'), true);
    assert.equal(service.isBuildOperationSuccessful('upload_succeeded'), true);
    assert.equal(service.isBuildOperationSuccessful('pending'), false);
    assert.equal(service.isBuildOperationSuccessful('failed'), false);
    assert.equal(service.isBuildOperationSuccessful('cancelled'), false);
});

test('Workspace does not infer a build result from success copy', async () => {
    const workspace = await readFile(new URL('../components/Workspace.tsx', import.meta.url), 'utf8');
    assert.match(workspace, /completedBuildOperationResult\('compile'\)/);
    assert.match(workspace, /completedBuildOperationResult\('upload'\)/);
    assert.match(workspace, /isBuildOperationSuccessful\(operationResultCode\)/);
    assert.doesNotMatch(
        workspace,
        /lower\.includes\('compilation successful'\)|lower\.includes\('upload finished successfully'\)|text\.includes\('编译成功'\)|text\.includes\('上传成功'\)/,
    );
});
