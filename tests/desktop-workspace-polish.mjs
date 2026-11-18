// Real WebView, production Blockly fields/serializer, native save and pointer input.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,`workspace-polish-${Date.now()}`);fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',checks:[],layouts:[],out};const delay=ms=>new Promise(r=>setTimeout(r,ms));
const client=await connectDesktop();const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/');
const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});let seq=0;const pending=new Map();
socket.onmessage=e=>{const m=JSON.parse(e.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const wait=async(expr)=>{for(let i=0;i<250;i++){const value=await client.evaluate(expr);if(value)return value;await delay(100);}throw Error('Timeout '+expr);};
const click=selector=>client.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Missing/disabled '+${JSON.stringify(selector)});b.click()})()`);
const state=()=>client.evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();return Blockly.serialization.workspaces.save(workspace)})()`);
const key=async(name,code,vk,modifiers=0)=>{await client.input('Input.dispatchKeyEvent',{type:'keyDown',key:name,code,windowsVirtualKeyCode:vk,modifiers});await client.input('Input.dispatchKeyEvent',{type:'keyUp',key:name,code,windowsVirtualKeyCode:vk,modifiers});};
const setCode=async code=>{await client.evaluate(`document.querySelector('.cm-content').focus()`);await key('a','KeyA',65,2);await client.input('Input.insertText',{text:code});await wait(`window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace).ckSource.code===${JSON.stringify(code)}`);};
const rect=selector=>client.evaluate(`(()=>{const r=document.querySelector(${JSON.stringify(selector)}).getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}})()`);
const capture=async name=>{await delay(200);fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png'})).data,'base64'));};
const save=async()=>{await key('s','KeyS',83,2);await delay(800);};
async function drag(selector,dx,dy){const r=await rect(selector),x=r.x+r.width/2,y=r.y+r.height/2;await client.input('Input.dispatchMouseEvent',{type:'mouseMoved',x,y});await client.input('Input.dispatchMouseEvent',{type:'mousePressed',button:'left',buttons:1,clickCount:1,x,y});for(let i=1;i<=8;i++){await client.input('Input.dispatchMouseEvent',{type:'mouseMoved',button:'left',buttons:1,x:x+dx*i/8,y:y+dy*i/8});await delay(20);}await client.input('Input.dispatchMouseEvent',{type:'mouseReleased',button:'left',buttons:0,clickCount:1,x:x+dx,y:y+dy});await delay(150);}
const file=path.join(out,'同步与面板.ck');
try{
 await wait(`document.body.innerText.includes('我的工程')`);
 const ws={blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'polish-loop',x:70,y:70,inputs:{DO:{block:{type:'delay_ms',id:'polish-delay',fields:{MS:100}}}}}]}};
 fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'同步与面板',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify(ws)}));
 const openFixture = JSON.stringify({requestId:randomUUID(),path:file,source:'workspace-polish'});
 for(let i=0;i<25;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('polish-delay'))`))break;
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${openFixture}})`);await delay(400);}
 await wait(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('polish-delay') && document.querySelector('[data-ck-role="edit-source"]')?.disabled===false`);
 await click('.ck-target-detail summary');assert.ok(await client.evaluate(`document.querySelector('.ck-target-detail').open`));
 await client.evaluate(`document.querySelector('.ck-target-detail summary').focus()`);await key('Escape','Escape',27);
 assert.equal(await client.evaluate(`document.querySelector('.ck-target-detail').open`),false);
 await click('[data-ck-role="toolbar-port-select"]');await wait(`Boolean(document.querySelector('.ck-device-tools [role="menu"]'))`);
 await click('.ck-device-tools .fixed');
 await client.evaluate(`window.__polishCalls=[];window.__polishErrors=[];window.addEventListener('error',e=>window.__polishErrors.push(String(e.error||e.message)));const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);if(u.hostname==='ipc.localhost')window.__polishCalls.push(decodeURIComponent(u.pathname.slice(1)));return original(url,options);}`);
 await click('[data-ck-role="edit-source"]');await wait(`Boolean(document.querySelector('.cm-content'))`);
 let code=(await state()).ckSource.code;assert.match(code,/delay\(100\)/);
 await click('[data-ck-role="edit-blocks"]');await client.evaluate(`window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('polish-delay').setFieldValue(200,'MS')`);
 await wait(`window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace).ckSource.code.includes('delay(200)')`);
 assert.equal((await state()).ckSource.mode,'blocks');await click('[data-ck-role="edit-source"]');
 code=(await state()).ckSource.code;const extra='\nvoid userExtra() { /* 手写函数保留 */ }\n';await setCode(code+extra);
 await click('[data-ck-role="edit-blocks"]');await client.evaluate(`window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('polish-delay').setFieldValue(300,'MS')`);
 await wait(`window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace).ckSource.code.includes('delay(300)')`);
 assert.ok((await state()).ckSource.code.endsWith(extra));await click('[data-ck-role="edit-source"]');await setCode((await state()).ckSource.code.replace('delay(300)','delay(400)'));
 await click('[data-ck-role="edit-blocks"]');await client.evaluate(`window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('polish-delay').setFieldValue(500,'MS')`);
 await wait(`Boolean(window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace).ckSource.pendingGenerated)`);
 await click('[data-ck-role="edit-source"]');await wait(`Boolean(document.querySelector('.ck-source-sync-review'))`);
 await click('[data-ck-role="build-compile-action"]');await delay(250);assert.equal(await client.evaluate(`window.__polishCalls.includes('compile_sketch')`),false);
 await save();const saved=JSON.parse(JSON.parse(fs.readFileSync(file,'utf8')).xml).ckSource;assert.match(saved.pendingGenerated,/delay\(500\)/);assert.match(saved.code,/delay\(400\)/);
 await click('.ck-source-sync-summary button');await capture('source-conflict');
 assert.equal(await client.evaluate(`document.querySelector('.ck-source-sync-apply').disabled`),true);
 await client.evaluate(`document.querySelectorAll('.ck-source-sync-options input')[1].click()`);await click('.ck-source-sync-apply');
 await wait(`!document.querySelector('.ck-source-sync-review')`);code=(await state()).ckSource.code;assert.match(code,/delay\(500\)/);assert.ok(code.endsWith(extra));
 report.checks.push('Live block updates; disjoint manual function preserved; overlapping edit presented; unresolved source compile blocked; pending conflict saved; explicit generated choice retains other manual code');
 // Save immediately after a block edit, before the preview debounce completes.
 await click('[data-ck-role="edit-blocks"]');await client.evaluate(`window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('polish-delay').setFieldValue(600,'MS')`);await save();
 assert.match(JSON.parse(JSON.parse(fs.readFileSync(file,'utf8')).xml).ckSource.code,/delay\(600\)/);report.checks.push('Immediate save synchronizes source from actual blocks');
 await click('[data-ck-role="library-manager-trigger"]');await wait(`Boolean(document.querySelector('[aria-labelledby="library-manager-title"]'))`);await capture('library-visible');await click('[aria-labelledby="library-manager-title"] button[aria-label="关闭库管理器"]');
 await click('[data-ck-role="ai-assistant-trigger"]');await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`);
 await client.evaluate(`const s=[...document.querySelectorAll('span')].find(e=>e.textContent==='打开控制台');if(s)s.click()`);await wait(`Boolean(document.querySelector('.ck-console-panel'))`);
 await client.evaluate(`[...document.querySelectorAll('.ck-serial-console-tab')].find(e=>e.textContent.includes('串口监视器')).click()`);
 await wait(`Boolean(document.querySelector('.ck-serial-terminal-host'))`);await client.evaluate(`Boolean(window.__polishTerminal=document.querySelector('.ck-serial-terminal-host'))`);
 await command('Emulation.setDeviceMetricsOverride',{width:1440,height:900,deviceScaleFactor:1,mobile:false});await delay(250);
 for(const [selector,initial,arrow,vk] of [['.ck-console-panel [role="separator"]',168,'ArrowUp',38],['.ck-ai-panel [role="separator"]',360,'ArrowLeft',37]]){
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).dispatchEvent(new MouseEvent('dblclick',{bubbles:true}))`);await delay(100);
  await client.evaluate(`document.querySelector(${JSON.stringify(selector)}).focus()`);await key(arrow,arrow,vk);await delay(100);
  assert.equal(await client.evaluate(`Number(document.querySelector(${JSON.stringify(selector)}).getAttribute('aria-valuenow'))`),initial+20);
 }
 const h=(await rect('.ck-console-panel')).height;await drag('.ck-console-panel [role="separator"]',0,-120);assert.ok((await rect('.ck-console-panel')).height>h+100);
 const w=(await rect('.ck-ai-panel')).width;await drag('.ck-ai-panel [role="separator"]',-160,0);assert.ok((await rect('.ck-ai-panel')).width>w+140);
 const width=(await rect('.ck-ai-panel')).width,height=(await rect('.ck-console-panel')).height;
 assert.equal(await client.evaluate(`document.querySelector('[data-ck-action="toggle-console-size"]').getAttribute('aria-expanded')`),'true');
 assert.equal(await client.evaluate(`window.__polishTerminal===document.querySelector('.ck-serial-terminal-host')`),true);
 assert.equal(await client.evaluate(`document.body.style.userSelect`),'');
 await click('button[aria-label="关闭 AI 面板"]');await click('[data-ck-role="ai-assistant-trigger"]');await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`);assert.ok(Math.abs((await rect('.ck-ai-panel')).width-width)<2);
 await click('button[aria-label="收起控制台"]');await client.evaluate(`[...document.querySelectorAll('span')].find(e=>e.textContent==='打开控制台').click()`);await wait(`Boolean(document.querySelector('.ck-console-panel'))`);assert.ok(Math.abs((await rect('.ck-console-panel')).height-height)<2);
 report.checks.push('Pointer drag expands AI and console; terminal instance preserved during resize; sizes survive close/reopen; cursor and selection restored');
 for(const [width,height,theme] of [[1440,900,'light'],[1280,800,'light'],[1024,768,'dark'],[900,650,'light'],[900,650,'dark']]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await client.evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'app_theme',newValue:${JSON.stringify(theme)}}))`);await delay(250);
  const selectors=['.ck-project-tools','.ck-device-tools','.ck-workspace-toolbar-actions','[data-ck-role="library-manager-trigger"]','.ck-ai-panel','.ck-console-panel','.ck-workspace-stage'];const rects=[];
  for(const selector of selectors){const r=await rect(selector);assert.ok(r.x>=-1&&r.right<=width+1&&r.y>=0&&r.bottom<=height+1&&r.width>20,JSON.stringify({selector,width,r}));rects.push(r);}
  assert.ok(rects[0].right+3<=rects[1].x && rects[1].right+3<=rects[2].x,'Toolbar overlap '+width);
  assert.ok(rects[3].right<=rects[1].x,'Library label overlaps the device selector '+width);
  const search=await rect('.ck-toolbox-search-dock-overlay'), category=await rect('.ck-blockly-toolbox-root .blocklyToolboxCategory');
  assert.ok(category.y>=search.bottom-1,'First toolbox category hidden by search '+JSON.stringify({width,search,category}));
  assert.ok(Math.abs(rects[4].bottom-rects[5].bottom)<=1 && Math.abs(rects[4].y-rects[6].y)<=1 && rects[5].right<=rects[4].x+1,'AI/console overlap '+width);
  assert.ok(await client.evaluate(`(()=>{const e=document.querySelector('[data-ck-role="library-manager-trigger"]'),r=e.getBoundingClientRect();return e.contains(document.elementFromPoint(r.x+r.width/2,r.y+r.height/2))})()`));
  await capture(`panels-${width}-${theme}`);report.layouts.push({width,height,theme,rects});
 }
 await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'serial-data',payload:'RESIZABLE_UI_OK\\r\\n'})`);
 await wait(`document.querySelector('[data-ck-role="serial-terminal"]')?.classList.contains('has-output')`);
 assert.equal(await client.evaluate(`window.__polishCalls.some(c=>['chat_with_glm_stream','open_serial_monitor','send_serial_data'].includes(c))`),false);
 report.checks.push('Five viewport/theme layouts keep library button and controls in bounds; synthetic native serial event renders; no model request or hardware serial port opened');
 await click('button[aria-label="关闭 AI 面板"]');await click('[data-ck-role="edit-source"]');await save();await capture('synced-source');
 assert.deepEqual(await client.evaluate('window.__polishErrors'),[]);report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;await capture('failure').catch(()=>{});}
finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));await command('Emulation.clearDeviceMetricsOverride').catch(()=>{});socket.close();client.close();console.log('POLISH REPORT '+out+' '+report.status);}
