import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const source = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');

test('late trusted alias reconciliation also re-applies the warning and first-block focus', () => {
    assert.match(source, /listen\('compile-sketch-alias'/);
    assert.match(source, /setCompileIssues\(issues => reconcileCompileIssueBlocks\(issues\)\)/);
    assert.match(source, /const mappedIssues = compileIssues\.filter\(issue => issue\.blockContext\)/);
    assert.match(source, /block\.setWarningText\(/);
    assert.match(source, /lastAutoLocatedCompileIssueRef/);
    assert.match(source, /ws\.centerOnBlock\(first\.blockId\)/);
});

test('compile log offers a key-error digest while keeping the complete log available', () => {
    assert.match(source, /extractCompileLogDigest\(compileLog\)/);
    assert.match(source, />关键错误<\/button>/);
    assert.match(source, />完整日志<\/button>/);
    assert.match(source, /lookupCompileBlock\(entry\.raw\)/);
});

