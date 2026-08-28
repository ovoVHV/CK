import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const tauri = JSON.parse(
    await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);

test('all user-visible desktop surfaces use the CK 1.0 product name', () => {
    assert.equal(tauri.productName, 'CK');
    assert.equal(tauri.app.windows[0].title, 'CK');
    assert.equal(tauri.identifier, 'com.ai.makerblockly', 'the stable identifier keeps user data continuity');
    assert.match(indexHtml, /<title>CK<\/title>/);
    assert.match(indexHtml, /href="\/ck\.svg"/);
    assert.doesNotMatch(indexHtml, /vite\.svg|CK Editor|MakerBlockly|Maker Blockly/);
    assert.match(workspace, /CK\r?\n\s*\{isProjectDirty &&/);
    assert.doesNotMatch(workspace, /CK Editor|MakerBlockly|Maker Blockly/);
});
