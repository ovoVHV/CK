import assert from 'node:assert/strict';
import { readFileSync } from 'node:fs';
import test from 'node:test';

const source = readFileSync(new URL('./LibraryManagerModal.tsx', import.meta.url), 'utf8');

test('library manager has no legacy JavaScript approval or revoke controls', () => {
    assert.doesNotMatch(source, /approve_block_package_runtime/);
    assert.doesNotMatch(source, /revoke_block_package_runtime/);
    assert.doesNotMatch(source, /我信任并启用|审查并启用|停用代码/);
    assert.doesNotMatch(source, /libraryCanRequestRuntimeApproval/);
});

test('library manager visibly labels a certified declarative runtime', () => {
    assert.match(source, /activation\.state === 'declarative-safe'/);
    assert.match(source, /t\(runtimeActivationLabelKey\(lib\)\)/);
    assert.match(source, /runtimeBadgeClass\(lib\)/);
});
