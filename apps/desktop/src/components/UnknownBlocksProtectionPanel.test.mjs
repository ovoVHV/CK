import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./UnknownBlocksProtectionPanel.tsx', import.meta.url), 'utf8');

test('unknown block protection is explicitly read-only and preserves opaque state', () => {
    assert.match(source, /只读保护模式/);
    assert.match(source, /不会允许普通保存覆盖原工程/);
    assert.match(source, /mutation、extraState/);
});

test('users can repair, retry, inspect, and export without destructive loading', () => {
    assert.match(source, /安装或启用对应积木包/);
    assert.match(source, /重新检查/);
    assert.match(source, /导出原始积木数据/);
    assert.match(source, /查看原始数据/);
});

