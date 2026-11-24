import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const start = source.indexOf('const beginBuild =');
const end = source.indexOf('const handleCompileIssueAction', start);
assert.ok(start >= 0 && end > start);
const handler = source.slice(start, end);

test('compile UI initializes before automatic checkpoint persistence starts', () => {
    const initialLog = handler.indexOf("正在初始化编译环境...\\n");
    const schedule = handler.indexOf('scheduleBuildCheckpoint({');
    assert.ok(initialLog >= 0 && schedule > initialLog);
    assert.match(handler.slice(initialLog, schedule), /setBuildProgress\(/);
    assert.match(handler.slice(initialLog, schedule), /showToast\([\s\S]*?buildT\('status\.compiling'\)/);
});

test('ordinary compile persists after its hot path while upload waits before backend work', () => {
    assert.match(handler, /beforeUpload: isUpload \? async \(\) => \{\s*await run\.checkpoint\('upload'\)/);
    assert.match(handler, /afterCompile: isUpload \? undefined : \(\) => \{ void run\.checkpoint\('compile'\)/);
    assert.match(source, /const checkpointInput = createWorkspaceCheckpointInput\([\s\S]{0,100}before_upload[\s\S]{0,100}before_compile/);
});

test('checkpoint failures remain visible without replacing compiler output', () => {
    assert.match(handler, /\[检查点警告\] 自动保存失败/);
    assert.match(handler, /if \(isCurrentSession\(\)\) appendCompileLog\(warning\)/);
    assert.doesNotMatch(handler, /replaceCompileLog\(warning\)/);
});
