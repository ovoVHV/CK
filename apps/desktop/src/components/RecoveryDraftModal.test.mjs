import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./RecoveryDraftModal.tsx', import.meta.url), 'utf8');

test('recovery UI distinguishes drafts from formal project versions', () => {
    assert.match(source, /最新的一份有效恢复稿/);
    assert.match(source, /不会冒充正式版本或自动覆盖工程/);
    assert.match(source, /不会接着连续弹出/);
    assert.match(source, /发现未保存恢复稿/);
});

test('recovery UI exposes all safe resolution paths', () => {
    assert.match(source, /放弃恢复稿/);
    assert.match(source, /恢复为新工程/);
    assert.match(source, /覆盖当前工作区/);
    assert.match(source, /会先建立正式检查点/);
    assert.match(source, /所选稿保留到正式保存成功/);
    assert.match(source, /本次会话内不再提示同基线旧稿/);
    assert.match(source, /重新打开工程后可再次判断/);
});

test('recovery UI promises to stop when a third-party block is unavailable', () => {
    assert.match(source, /停止恢复并保留原始数据/);
});
