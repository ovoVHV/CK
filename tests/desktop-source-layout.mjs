// Real WebView layout regression: no mocked Blockly or CodeMirror surfaces.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, `source-layout-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', checks: [], screens: [], out };
const client = await connectDesktop();
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const wait = async expression => { for (let i = 0; i < 300; i++) { const value = await client.evaluate(expression); if (value) return value; await delay(100); } throw Error('Timeout: ' + expression); };
const click = selector => client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
const frame = () => client.evaluate('new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)))');
const state = () => client.evaluate('(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();return Blockly.serialization.workspaces.save(workspace)})()');
const key = async (name, code, keyCode, modifiers = 0) => {
    await client.input('Input.dispatchKeyEvent', { type: 'keyDown', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
    await client.input('Input.dispatchKeyEvent', { type: 'keyUp', key: name, code, windowsVirtualKeyCode: keyCode, modifiers });
};
const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p => p.url === 'http://tauri.localhost/');
const socket = new WebSocket(page.webSocketDebuggerUrl); await new Promise((r, j) => { socket.onopen = r; socket.onerror = j; });
let sequence = 0; const pending = new Map();
socket.onmessage = event => { const m = JSON.parse(event.data), r = pending.get(m.id); if (r) { pending.delete(m.id); m.error ? r.reject(Error(JSON.stringify(m.error))) : r.resolve(m.result); } };
const command = (method, params = {}) => new Promise((resolve, reject) => { const id = ++sequence; pending.set(id, { resolve, reject }); socket.send(JSON.stringify({ id, method, params })); });
const capture = async name => { await frame(); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from((await command('Page.captureScreenshot', { format: 'png' })).data, 'base64')); report.screens.push(name + '.png'); };
try {
    const file = path.join(out, '源码界面回归.ck');
    fs.writeFileSync(file, JSON.stringify({ format: 'ck-project', schema_version: 1, migration_version: 1, name: '源码界面回归', board: 'arduino:avr:uno', board_package_id: 'arduino:avr:uno', options: '{}', xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_loop_custom', id: 'source-ui', x: 80, y: 80 }] } }) }));
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({ requestId: randomUUID(), path: file, source: 'source-layout-test' })}})`);
    await wait(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('source-ui') && document.querySelector('[data-ck-role="edit-source"]')?.disabled===false`);
    await client.evaluate(`window.__sourceUiErrors=[];window.addEventListener('error',e=>window.__sourceUiErrors.push(String(e.error||e.message)));window.addEventListener('unhandledrejection',e=>window.__sourceUiErrors.push(String(e.reason)))`);
    await click('[data-ck-role="edit-source"]'); await wait(`Boolean(document.querySelector('.cm-content'))`);
    assert.equal(await client.evaluate(`Boolean(document.querySelector('.ck-workspace-header [data-ck-role="edit-source"]'))`), true);
    assert.equal(await client.evaluate(`Boolean(document.querySelector('.ck-editor-modes'))`), false);
    const code = '// 同一工程 · 源码编辑\nvoid setup() {\n  Serial.begin(115200);\n  pinMode(13, OUTPUT);\n}\n\nvoid loop() {\n  digitalWrite(13, HIGH);\n  delay(500);\n  digitalWrite(13, LOW);\n  delay(500);\n}\n';
    await client.evaluate(`document.querySelector('.cm-content').focus()`); await key('a', 'KeyA', 65, 2); await client.input('Input.insertText', { text: code });
    assert.equal((await state()).ckSource.code, code);
    await client.evaluate(`window.__sameSourceEditor=document.querySelector('.cm-editor');window.__frameViolations=[];window.__modeFrameCount=0;window.__checkModes=true;function inspect(){if(!window.__checkModes)return;const source=document.querySelector('[data-ck-role="edit-source"]')?.getAttribute('aria-selected')==='true';const block=document.querySelector('#ck-blocks-panel');if(source&&block&&[block,...block.querySelectorAll('.blocklyToolboxDiv,.blocklyToolbox,.blocklyTreeRow,.blocklySvg')].some(e=>e.checkVisibility()))window.__frameViolations.push('visible block surface');if(source&&document.querySelector('.ck-toolbox-search-dock-overlay'))window.__frameViolations.push('search overlay');window.__modeFrameCount++;requestAnimationFrame(inspect)}requestAnimationFrame(inspect)`);
    for (let i = 0; i < 20; i++) {
        await click('[data-ck-role="edit-blocks"]'); await frame();
        assert.equal(await client.evaluate(`document.querySelector('#ck-blocks-panel').checkVisibility()`), true);
        await click('[data-ck-role="edit-source"]'); await frame();
    }
    assert.equal(await client.evaluate(`window.__sameSourceEditor===document.querySelector('.cm-editor')`), true, 'Switch must retain editor instance');
    assert.equal((await state()).ckSource.code, code);
    assert.deepEqual(await client.evaluate('window.__frameViolations'), []);
    await client.evaluate(`document.querySelector('.cm-content').focus()`); await key('z', 'KeyZ', 90, 2);
    assert.notEqual((await state()).ckSource.code, code, 'Undo survives switches');
    await key('y', 'KeyY', 89, 2); assert.equal((await state()).ckSource.code, code); await key('ArrowRight', 'ArrowRight', 39);
    const longCode=code+Array.from({length:100},(_,i)=>'// scroll line '+i).join('\n');
    await key('a','KeyA',65,2);await client.input('Input.insertText',{text:longCode});await frame();
    const beforeScroll=await client.evaluate(`(()=>{const e=document.querySelector('.cm-scroller');e.scrollTop=450;return {scroll:e.scrollTop,cursor:document.querySelector('.ck-source-cursor').textContent}})()`);
    assert.ok(beforeScroll.scroll>0);await click('[data-ck-role="edit-blocks"]');await frame();await click('[data-ck-role="edit-source"]');await frame();
    const afterScroll=await client.evaluate(`({scroll:document.querySelector('.cm-scroller').scrollTop,cursor:document.querySelector('.ck-source-cursor').textContent})`);
    assert.deepEqual(afterScroll,beforeScroll,'Scroll and cursor remain stable');
    await client.evaluate(`document.querySelector('.cm-content').focus()`);await key('a','KeyA',65,2);await client.input('Input.insertText',{text:code});await key('ArrowRight','ArrowRight',39);await key('s','KeyS',83,2);await delay(2200);
    report.checks.push('20 round trips retain editor, source and undo, with no visible Blockly surface on sampled frames');
    for (const [name, width, height, theme] of [['light-1280', 1280, 800, 'light'], ['light-1024', 1024, 768, 'light'], ['light-900', 900, 650, 'light'], ['dark-900', 900, 650, 'dark'], ['dark-1440', 1440, 900, 'dark']]) {
        await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await client.evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'app_theme',newValue:${JSON.stringify(theme)}}))`); await delay(150);
        const layout = await client.evaluate(`(()=>{const selectors=['.ck-project-tools','.ck-device-tools','.ck-workspace-toolbar-actions','.ck-editor-tabs','.ck-source-filebar','.ck-source-edit-area','.ck-source-status'];return selectors.map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {selector,x:r.x,y:r.y,right:r.right,bottom:r.bottom,width:r.width,height:r.height}})})()`);
        for (const r of layout) assert.ok(r.x >= 0 && r.right <= width + 1 && r.y >= 0 && r.bottom <= height + 1 && r.height >= 20, JSON.stringify({ name, r }));
        assert.ok(layout[0].right + 3 <= layout[1].x && layout[1].right + 3 <= layout[2].x, 'Header controls overlap: ' + JSON.stringify({ name, layout }));
        await capture(name); report.checks.push({ name, layout });
    }
    await click('[data-ck-role="source-actions"]'); await capture('source-menu');
    assert.equal(await client.evaluate(`document.querySelector('#ck-source-actions').checkVisibility()`), true);
    await key('Escape', 'Escape', 27); assert.equal(await client.evaluate(`document.querySelector('#ck-source-actions')===null`), true);
    await click('[data-ck-role="source-actions"]'); const point=await client.evaluate(`(()=>{const r=document.querySelector('.cm-content').getBoundingClientRect();return {x:r.x+30,y:r.y+20}})()`); await client.input('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',clickCount:1,...point});await client.input('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',clickCount:1,...point}); assert.equal(await client.evaluate(`document.querySelector('#ck-source-actions')===null`), true);
    await click('[data-ck-role="edit-blocks"]'); await frame(); await capture('blocks-restored');
    await click('[data-ck-role="edit-source"]'); await frame();
    await client.evaluate(`document.querySelector('.cm-content').focus()`);await key('s','KeyS',83,2);await delay(500);
    await client.evaluate('window.__checkModes=false');
    assert.deepEqual(await client.evaluate('window.__sourceUiErrors'), []);
    report.checks.push('Long source scroll position and cursor survive a mode round trip; source action menu closes on Escape and outside pointer input');
    report.frameCount = await client.evaluate('window.__modeFrameCount'); report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack); await capture('failure').catch(() => {}); console.error(error); process.exitCode = 1; }
finally { fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2)); await command('Emulation.clearDeviceMetricsOverride').catch(() => {}); socket.close(); client.close(); console.log('LAYOUT REPORT ' + out); }
