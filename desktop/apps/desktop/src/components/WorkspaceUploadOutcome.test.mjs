import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('native upload Result is authoritative and diagnostic words cannot invert success', () => {
    const start = source.indexOf('const uploadResult = await uploadProject(');
    const end = source.indexOf('return operationResultCode;', start);
    assert.ok(start >= 0 && end > start, 'upload success branch must exist');
    const uploadBranch = source.slice(start, end);

    assert.match(uploadBranch, /operationResultCode = completedBuildOperationResult\('upload'\)/);
    assert.match(uploadBranch, /publishCompileResources\(evidenceLog, true, uploadResult\.fqbn\)/);
    assert.doesNotMatch(uploadBranch, /log\.includes\(['"]Success['"]\)/);
    assert.doesNotMatch(uploadBranch, /\/error\|fail\/i\.test\(log\)/);
});
