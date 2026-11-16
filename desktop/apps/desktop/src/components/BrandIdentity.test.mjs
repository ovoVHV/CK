import assert from 'node:assert/strict';
import test from 'node:test';
import { readFile } from 'node:fs/promises';

const workspace = await readFile(new URL('./Workspace.tsx', import.meta.url), 'utf8');
const indexHtml = await readFile(new URL('../../index.html', import.meta.url), 'utf8');
const tauri = JSON.parse(
    await readFile(new URL('../../src-tauri/tauri.conf.json', import.meta.url), 'utf8'),
);

test('CK branding retains the versioned preview identity and isolated user data', () => {
    assert.equal(tauri.productName, 'CK V9.1 Alpha');
    assert.equal(tauri.app.windows[0].title, `CK V9.1 测试版 — ${tauri.version}`);
    assert.equal(tauri.identifier, 'com.ai.makerblockly.v91alpha', 'the preview identifier keeps user data separate from production');
    assert.match(indexHtml, /<title>CK<\/title>/);
    assert.match(indexHtml, /href="\/ck\.svg"/);
    assert.doesNotMatch(indexHtml, /vite\.svg|CK Editor|MakerBlockly|Maker Blockly/);
    assert.match(workspace, /CK\r?\n\s*\{isProjectDirty &&/);
    assert.doesNotMatch(workspace, /CK Editor|MakerBlockly|Maker Blockly/);
});
