import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';
import ts from 'typescript';

const source = await readFile(new URL('./project_identity.ts', import.meta.url), 'utf8');
const output = ts.transpileModule(source, {
    compilerOptions: { module: ts.ModuleKind.ESNext, target: ts.ScriptTarget.ES2020 },
}).outputText;
const { normalizeProjectIdentityPath } = await import(
    `data:text/javascript;base64,${Buffer.from(output).toString('base64')}`
);

test('folds Windows drive and UNC identity but preserves POSIX case', () => {
    assert.equal(normalizeProjectIdentityPath('C:\\Users\\Alice\\Demo.maker'), 'c:/users/alice/demo.maker');
    assert.equal(normalizeProjectIdentityPath('c:/USERS/ALICE/demo.maker'), 'c:/users/alice/demo.maker');
    assert.equal(normalizeProjectIdentityPath('\\\\Server\\Share\\Demo.maker'), '//server/share/demo.maker');
    assert.equal(normalizeProjectIdentityPath('/Users/Alice/Demo.maker'), '/Users/Alice/Demo.maker');
    assert.notEqual(normalizeProjectIdentityPath('/Foo/demo.maker'), normalizeProjectIdentityPath('/foo/demo.maker'));
});
