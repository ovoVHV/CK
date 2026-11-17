// Actual desktop/editor/IPC regression. Only native file-picker answers are injected.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, `integrated-source-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', checks: [], builds: [], out };
const record = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function wait(expression, label, timeout=60000) {
    const start=Date.now(); while(Date.now()-start<timeout) { const value=await client.evaluate(expression); if(value) return value; await delay(200); }
    throw Error('Timed out: '+label+' / '+await client.evaluate('document.body.innerText.slice(-1800)'));
}
const click = selector => client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});e.click()})()`);
const state = id => ({ blocks: { languageVersion: 0, blocks: [{ type:'controls_loop_custom', id, x:60, y:70 }] } });
const snapshot = () => client.evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();return Blockly.serialization.workspaces.save(workspace)})()`);
const makeProject = (name, board, id) => {
    const file=path.join(out,name+'.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name,board,board_package_id:board,options:'{}',xml:JSON.stringify(state(id))}));return file;
};
async function openProject(file,id) {
    const payload={requestId:randomUUID(),path:file,source:'source-integration-regression'};
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(payload)}})`);
    await wait(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(id)}) && document.querySelector('[data-ck-role="edit-source"]')?.disabled===false)`, 'project '+id);
}
async function setCode(code) {
    await client.evaluate(`document.querySelector('.ck-source-pane .cm-content').focus()`);
    await client.input('Input.dispatchKeyEvent',{type:'keyDown',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
    await client.input('Input.dispatchKeyEvent',{type:'keyUp',key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
    await client.input('Input.insertText',{text:code}); await delay(150);
    assert.equal((await snapshot()).ckSource.code,code);
}
async function saveProject(file,code,mode='source') {
    const before=await client.evaluate('window.__integratedCalls.length');
    await client.input('Input.dispatchKeyEvent',{type:'keyDown',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});
    await client.input('Input.dispatchKeyEvent',{type:'keyUp',key:'s',code:'KeyS',modifiers:2,windowsVirtualKeyCode:83});
    const row=await wait(`window.__integratedCalls.slice(${before}).find(r=>['save_project','save_project_as'].includes(r.command)&&r.done)`, 'formal save');
    assert.equal(row.kind,'ok',row.response);const saved=JSON.parse(fs.readFileSync(file,'utf8'));
    const source=JSON.parse(saved.xml).ckSource; assert.equal(source.code,code);assert.equal(source.mode,mode);
    if(mode==='source')assert.equal(saved.code,code);
    return saved;
}
async function build(label,code,success=true,cancel=false) {
    const before=await client.evaluate('window.__integratedCalls.length');const clicked=await client.evaluate('performance.now()');
    await click('[data-ck-role="build-compile-action"]');
    await wait(`window.__integratedCalls.slice(${before}).some(r=>r.command==='compile_sketch')`,'compile dispatch');
    assert.equal(await client.evaluate(`document.querySelector('[data-ck-role="edit-blocks"]').disabled`),true);
    if(cancel){await delay(400);await click('[data-ck-role="build-cancel-action"]');}
    const row=await wait(`window.__integratedCalls.slice(${before}).find(r=>r.command==='compile_sketch'&&r.done)`,'real build',300000);
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'build completion');
    const elapsed=await client.evaluate('performance.now()')-clicked;
    assert.equal(row.args.code,code);if(success)assert.equal(row.kind,'ok',row.response);else assert.notEqual(row.kind,'ok');
    const log=await client.evaluate(`document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText||''`);
    fs.writeFileSync(path.join(out,label+'.log'),log);report.builds.push({label,wallMs:elapsed,ipcMs:row.ended-row.started,success:row.kind==='ok',fqbn:row.args.fqbn,projectId:row.args.projectId,log:label+'.log'});record();return log;
}
async function screenshots() {
    await delay(3000);
    assert.equal(await client.evaluate(`Boolean(document.querySelector('[data-ck-role="global-block-search"]'))`),false,'block search must be hidden in source mode');
    const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(x=>x.url==='http://tauri.localhost/');
    const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j});let n=0;const pending=new Map();
    socket.onmessage=e=>{const m=JSON.parse(e.data),r=pending.get(m.id);if(r){pending.delete(m.id);m.error?r.reject(Error(JSON.stringify(m.error))):r.resolve(m.result)}};
    const send=(method,params={})=>new Promise((resolve,reject)=>{const id=++n;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}))});
    try {
        for(const [name,width,height,themeIndex] of [['light-1280',1280,800,0],['dark-900',900,650,1]]) {
            await send('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
            await client.evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'app_theme',newValue:${JSON.stringify(themeIndex===0?'light':'dark')}}))`);await delay(250);
            const layout=await client.evaluate(`['.ck-editor-tabs','.ck-source-pane','.ck-source-edit-area','.ck-source-status'].map(selector=>{const r=document.querySelector(selector).getBoundingClientRect();return {selector,x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})`);
            for(const r of layout)assert.ok(r.x>=-1&&r.right<=width+1&&r.y>=0&&r.bottom<=height+1&&r.height>=20,JSON.stringify(r));
            fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await send('Page.captureScreenshot',{format:'png'})).data,'base64'));report.checks.push({screenshot:name+'.png',layout});record();
        }
        await send('Emulation.clearDeviceMetricsOverride');
    } finally {socket.close();}
}
try {
    client=await connectDesktop();
    await client.evaluate(`(()=>{window.__integratedCalls=[];window.__integratedPickers=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&command.startsWith('plugin:dialog|')){const answer=window.__integratedPickers.shift();if(answer!==undefined)return new Response(JSON.stringify(answer),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});}if(u.hostname==='ipc.localhost'&&['compile_sketch','save_project','save_project_as','save_recovery_draft','create_project_checkpoint','open_source_project'].includes(command)){const row={command,args:JSON.parse(options.body),started:performance.now()};window.__integratedCalls.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.ended=performance.now();row.done=true;return response;}return original(url,options);};return true})()`);
    const uno=makeProject('中文-同工程源码','arduino:avr:uno','integrated-uno');
    await openProject(uno,'integrated-uno'); await click('[data-ck-role="edit-source"]');
    await wait(`Boolean(document.querySelector('.ck-source-pane .cm-content'))`,'source editor');
    const initial=(await snapshot()).ckSource.code;
    assert.match(initial,/void loop/);
    const code='// 同一工程中的手写代码\nvoid setup() { Serial.begin(115200); pinMode(13, OUTPUT); }\nvoid loop() { digitalWrite(13, HIGH); delay(250); digitalWrite(13, LOW); delay(250); }\n';
    await setCode(code);await click('[data-ck-role="edit-blocks"]');
    assert.equal((await snapshot()).ckSource.code,code);assert.equal(await client.evaluate(`document.querySelector('.blocklySvg').getBoundingClientRect().width>0`),true);
    await click('[data-ck-role="edit-source"]');assert.equal((await snapshot()).ckSource.code,code);
    report.checks.push('Switch inside the same project preserves blocks and manual C++; active source is explicit');record();
    await saveProject(uno,code);
    const other=makeProject('切换用空工程','arduino:avr:uno','integrated-other');
    await openProject(other,'integrated-other');assert.equal((await snapshot()).ckSource,undefined);
    await openProject(uno,'integrated-uno');await wait(`Boolean(document.querySelector('.ck-source-pane .cm-content'))`,'reopened manual source');assert.equal((await snapshot()).ckSource.code,code);
    report.checks.push('Real native .ck save/reopen restores code, active mode and target; old projects do not inherit source');record();
    await build('uno-source-initial',code);
    const edited=code.replaceAll('250','260');await setCode(edited);await build('uno-source-edited',edited);
    const noop=await build('uno-source-identical',edited);assert.match(noop,/ck-build-engine-v9|V9/);
    await click('[data-ck-role="edit-blocks"]');
    const blockCode=await client.evaluate(`window.__integratedCalls.filter(r=>r.command==='compile_sketch').at(-1).args.code`);assert.equal(blockCode,edited);
    await click('[data-ck-role="build-compile-action"]');
    await wait(`window.__integratedCalls.filter(r=>r.command==='compile_sketch').at(-1).args.code!==${JSON.stringify(edited)}`,'blocks are compiler input after switch');
    await wait(`window.__integratedCalls.filter(r=>r.command==='compile_sketch').at(-1).done`,'block compile');
    assert.equal(await client.evaluate(`window.__integratedCalls.filter(r=>r.command==='compile_sketch').at(-1).kind`),'ok');
    await wait(`document.querySelector('[data-ck-role="edit-source"]').disabled===false`,'block compile UI settled');
    await click('[data-ck-role="edit-source"]');assert.equal((await snapshot()).ckSource.code,edited);
    report.checks.push('Native compiler receives manual code in source mode and generated code in blocks mode, using the same project');record();
    const bad='void setup() {\n  missing_integrated_source_symbol();\n}\nvoid loop() {}\n';await setCode(bad);await build('uno-source-error',bad,false);
    await wait(`document.querySelector('.ck-source-errors')?.innerText.includes('第 2 行')`,'source error line');
    await setCode(edited);await saveProject(uno,edited);
    // Verify recoverability using the production serializer payload, including an actual checkpoint.
    const serialized=JSON.stringify(await snapshot());
    const checkpoint=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('create_project_checkpoint',{input:{projectPath:${JSON.stringify(uno)},reason:'manual',workspaceJson:${JSON.stringify(serialized)},code:${JSON.stringify(edited)},board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',options:'{}',blockCount:1}})`);
    const savedCheckpoint=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('load_project_checkpoint',{projectPath:${JSON.stringify(uno)},checkpointId:${JSON.stringify(checkpoint.id)}})`);
    assert.equal(JSON.parse(savedCheckpoint.workspaceJson).ckSource.code,edited);
    report.checkpoint=checkpoint;report.checks.push('Source diagnostics locate line 2; manual source participates in actual native checkpoint persistence');record();
    // Export and import through real persistence commands, with only picker answers supplied.
    const exported=path.join(out,'中文导出.ino');await client.evaluate(`window.__integratedPickers.push(${JSON.stringify(exported)})`);
    await click('[data-ck-role="source-actions"]');
    await client.evaluate(`[...document.querySelectorAll('#ck-source-actions button')].find(b=>b.textContent==='导出 .ino').click()`);
    for(let i=0;i<50&&!fs.existsSync(exported);i++)await delay(100);
    assert.ok(fs.readFileSync(exported,'utf8').includes(edited));
    const imported='// 导入当前工程\nvoid setup() {}\nvoid loop() { delay(100); }\n';const input=path.join(out,'导入.ino');fs.writeFileSync(input,imported);
    await click('[data-ck-role="source-actions"]');
    await client.evaluate(`window.__integratedPickers.push(${JSON.stringify(input)});[...document.querySelectorAll('#ck-source-actions button')].find(b=>b.textContent==='导入 .ino').click()`);
    await wait(`Boolean(document.querySelector('[data-ck-action="submit-confirm"]'))`,'import confirmation');await click('[data-ck-action="submit-confirm"]');
    await wait(`document.querySelector('.ck-source-pane .cm-content')?.textContent.includes('导入当前工程')`,'imported code');assert.equal((await snapshot()).ckSource.code,imported);
    await click('[data-ck-role="source-actions"]');
    await client.evaluate(`[...document.querySelectorAll('#ck-source-actions button')].find(b=>b.textContent==='从积木重新生成').click()`);
    await wait(`Boolean(document.querySelector('[data-ck-action="cancel-confirm"]'))`,'replace confirmation');await click('[data-ck-action="cancel-confirm"]');assert.equal((await snapshot()).ckSource.code,imported);
    // Unsaved navigation can be cancelled; it cannot quietly drop the hand-written program.
    await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId:randomUUID(),path:other,source:'source-unsaved-regression'})}})`);
    await wait(`Boolean(document.querySelector('[data-ck-role="unsaved-changes-dialog"]'))`,'unsaved source protection');
    await client.evaluate(`document.querySelectorAll('[data-ck-role="unsaved-changes-dialog"] button')[1].click()`);assert.equal((await snapshot()).ckSource.code,imported);
    const draft=await wait(`window.__integratedCalls.find(r=>r.command==='save_recovery_draft'&&r.done&&r.args.input.sourceCode===${JSON.stringify(imported)})`,'source autosave recovery',25000);
    assert.equal(draft.kind,'ok',draft.response);assert.equal(JSON.parse(draft.args.input.workspaceJson).ckSource.code,imported);
    report.checks.push('Real .ino export/import, overwrite cancellation, unsaved navigation protection and native recovery draft preserve the manual program');record();
    await setCode(edited);await saveProject(uno,edited);
    await setCode(edited.replaceAll('260','270'));await build('uno-source-cancel',edited.replaceAll('260','270'),false,true);
    await setCode(edited);await saveProject(uno,edited);
    if(process.env.CK_SOURCE_QA_SKIP_ESP32!=='1') {
        const esp=makeProject('ESP32-源码加速','esp32:esp32:esp32s3','integrated-esp');await openProject(esp,'integrated-esp');await click('[data-ck-role="edit-source"]');
        const wifi='#include <WiFi.h>\nvoid setup() { Serial.begin(115200); WiFi.mode(WIFI_STA); WiFi.begin("MyWiFi", "12345678"); }\nvoid loop() { if (WiFi.status() == WL_CONNECTED) { Serial.println("connected"); } delay(500); }\n';
        await setCode(wifi);await build('s3-source-initial',wifi);
        const wifiEdit=wifi.replace('delay(500)','delay(510)');await setCode(wifiEdit);const editLog=await build('s3-source-edited',wifiEdit);assert.match(editLog,/Compile GCC=1/);
        const sameLog=await build('s3-source-identical',wifiEdit);assert.match(sameLog,/Compile GCC=0/);
        await saveProject(esp,wifiEdit);
    }
    await screenshots();
    report.status='PASS';
} catch(error) {report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}
finally {record();client?.close();console.log('REPORT '+out);}
