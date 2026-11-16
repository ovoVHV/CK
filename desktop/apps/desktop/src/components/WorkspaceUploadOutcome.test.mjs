import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';

const source = fs.readFileSync(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('native upload Result is authoritative and diagnostic words cannot invert success', () => {
    const start = source.indexOf("const log = await invoke('upload_sketch'");
    const end = source.indexOf('} catch (e: any)', start);
    assert.ok(start >= 0 && end > start, 'upload success branch must exist');
    const uploadBranch = source.slice(start, end);

    assert.match(uploadBranch, /operationResultCode = completedBuildOperationResult\('upload'\)/);
    assert.match(uploadBranch, /publishCompileResources\(log, true\)/);
    assert.doesNotMatch(uploadBranch, /log\.includes\(['"]Success['"]\)/);
    assert.doesNotMatch(uploadBranch, /\/error\|fail\/i\.test\(log\)/);
});
