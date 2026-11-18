// Actual desktop UI regression. No model requests or physical serial access.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';

const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,`compact-panels-${Date.now()}`);
fs.mkdirSync(out,{recursive:true});
const launch=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8'));
const report={status:'RUNNING',desktopSha256:launch.sha256,checks:[],layouts:[],hardware:false,liveModel:false};
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let client,socket,savedDark,seq=0;
const pending=new Map();
const command=(method,params={})=>new Promise((resolve,reject)=>{const id=++seq;pending.set(id,{resolve,reject});socket.send(JSON.stringify({id,method,params}));});
const wait=async(expression,label)=>{for(let i=0;i<240;i++){if(await client.evaluate(expression))return;await delay(150);}throw Error('Timed out: '+label);};
const click=selector=>client.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Unavailable control');b.click();return true;})()`);
const fill=value=>client.evaluate(`(()=>{const e=document.querySelector('.ck-ai-input-shell textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const snapshot=()=>client.evaluate(`JSON.stringify(window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace))`);
const metrics=()=>client.evaluate(`(()=>{
 const p=document.querySelector('.ck-ai-panel'),t=p.querySelector('textarea[aria-label="发给 AI 的需求"]'),f=p.querySelector('.ck-ai-feed'),c=document.querySelector('.ck-console-panel');
 const rect=e=>{const r=e.getBoundingClientRect();return {x:r.x,y:r.y,width:r.width,height:r.height,right:r.right,bottom:r.bottom}};
 const visible=e=>{if(!e)return false;const r=e.getBoundingClientRect(),hit=document.elementFromPoint(r.x+r.width/2,r.y+r.height/2);return r.width>0&&r.height>0&&r.x>=0&&r.y>=0&&r.right<=innerWidth+1&&r.bottom<=innerHeight+1&&!!hit&&(e===hit||e.contains(hit))};
 const checked=[t,p.querySelector('.ck-ai-send'),...p.querySelectorAll('.ck-ai-controls select'),p.querySelector('.ck-ai-project-path button'),p.querySelector('[aria-label="关闭 AI 面板"]'),...(c?[c.querySelector('[data-ck-action="toggle-console-size"]'),c.querySelector('[aria-label="收起控制台"]'),c.querySelector('.ck-serial-input')]:[])];
 for(const e of checked)if(!visible(e)){const r=e?.getBoundingClientRect();throw Error('Unavailable control '+e?.outerHTML.slice(0,230)+' hit '+(r&&document.elementFromPoint(r.x+r.width/2,r.y+r.height/2)?.outerHTML.slice(0,150)));}
 return {width:innerWidth,height:innerHeight,panel:rect(p),drawer:p.classList.contains('ck-ai-panel--drawer'),compact:p.classList.contains('ck-ai-panel--compact'),input:rect(t),inputMax:parseFloat(getComputedStyle(t).maxHeight),inputResize:getComputedStyle(t).resize,inputOverflow:t.scrollHeight>t.clientHeight+1,feed:rect(f),console:c?rect(c):null,consoleExpanded:c?.dataset.expanded,resizeHandles:document.querySelectorAll('.ck-panel-resizer[role="separator"]').length,pageOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:p.scrollWidth>p.clientWidth+1,controlsVisible:[t,p.querySelector('.ck-ai-send'),...p.querySelectorAll('.ck-ai-controls select'),p.querySelector('.ck-ai-project-path button'),p.querySelector('[aria-label="关闭 AI 面板"]'),...(c?[c.querySelector('[data-ck-action="toggle-console-size"]'),c.querySelector('[aria-label="收起控制台"]'),c.querySelector('.ck-serial-input')]:[])].every(visible)};
})()`);
async function capture(name){await delay(300);const m=await metrics();assert.equal(m.pageOverflow,false,name);assert.equal(m.panelOverflow,false,name);assert(m.controlsVisible,name+': controls outside or obscured '+JSON.stringify(m));assert.equal(m.inputResize,'none');assert.equal(m.resizeHandles,m.console?2:1);assert(m.panel.width<=361&&m.panel.width>=340);assert(m.feed.height>=32,name+': no conversation space');assert(m.input.height<=m.inputMax+1);if(m.console){assert(m.console.height<=innerLimit(m.height)+1);assert(m.console.height>=130);}
 const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));report.layouts.push({name,...m});return m;
}
const innerLimit=height=>Math.max(220,height*.45);
try{
 client=await connectDesktop();
 const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/');
 socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((resolve,reject)=>{socket.onopen=resolve;socket.onerror=reject;});
 socket.onmessage=event=>{const m=JSON.parse(event.data),p=pending.get(m.id);if(p){pending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 savedDark=await client.evaluate(`document.documentElement.classList.contains('dark')`);
 const project=path.join(out,'紧凑面板检查.ck');
 fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'紧凑面板检查',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_setup_custom',id:'compact-setup',x:40,y:50},{type:'controls_loop_custom',id:'compact-loop',x:40,y:160}]}})}));
 const requestId=randomUUID();
 for(let i=0;i<240;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('compact-loop')&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(i%8===0)await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId,path:project,source:'compact-panels-test'})}})`);await delay(250);}
 await wait(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('compact-loop'))`,'project');
 report.before=await snapshot();
 await client.evaluate(`(()=>{window.__compactCalls=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);if(u.hostname==='ipc.localhost')window.__compactCalls.push(decodeURIComponent(u.pathname.slice(1)));return original(url,options)};return true})()`);
 await click('[data-ck-role="ai-assistant-trigger"]');
 await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`,'composer');
 // Open only the view, without claiming or opening a hardware serial port.
 if(!await client.evaluate(`Boolean(document.querySelector('.ck-console-panel'))`))await client.evaluate(`(()=>{const s=[...document.querySelectorAll('span')].find(e=>e.textContent==='打开控制台');if(!s)throw Error('Missing console opener');s.click();return true;})()`);
 await wait(`Boolean(document.querySelector('[data-ck-action="toggle-console-size"]'))`,'console');
 await client.evaluate(`(()=>{const tab=[...document.querySelectorAll('.ck-serial-console-tab')].find(b=>b.textContent.includes('串口监视器'));tab.click();return true;})()`);
 await wait(`Boolean(document.querySelector('.ck-serial-terminal-host'))`,'serial display');
 await client.evaluate(`Boolean(window.__compactTerminal=document.querySelector('.ck-serial-terminal-host'))`);
 const longDraft=Array.from({length:30},(_,i)=>`第${i+1}项：保留已有采样、急停、心跳和串口行为，修改对应阈值。`).join('\n');
 for(const [width,height,dark] of [[1366,860,false],[1280,800,true],[1024,768,false],[900,600,false],[900,600,true]]){
  await command('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});
  await client.evaluate(`document.documentElement.classList.toggle('dark',${dark})`);await delay(300);
  if(await client.evaluate(`document.querySelector('.ck-console-panel').dataset.expanded==='true'`))await click('[data-ck-action="toggle-console-size"]');
  await fill('');const small=await capture(`${width}-${height}-${dark?'dark':'light'}-compact`);assert(small.console.height<=177);assert(small.input.height<=43);
  await fill(longDraft);const long=await capture(`${width}-${height}-${dark?'dark':'light'}-long`);assert(long.input.height>small.input.height);assert(long.inputOverflow);assert.equal(await client.evaluate(`document.querySelector('.ck-ai-input-shell textarea').value`),longDraft);
  await click('[data-ck-action="toggle-console-size"]');const large=await capture(`${width}-${height}-${dark?'dark':'light'}-expanded`);assert(large.console.height>small.console.height+30);assert.equal(large.consoleExpanded,'true');
  await fill('');const reset=await metrics();assert(reset.input.height<=43);await click('[data-ck-action="toggle-console-size"]');
 }
 report.checks.push('Light/dark at 1366, 1280, 1024 and 900x600: default AI width, functional sizing controls, visible controls and no horizontal overflow');
 report.checks.push('Long draft grows within the cap, scrolls internally, preserves text and shrinks after deletion at every viewport');
 assert(await client.evaluate(`window.__compactTerminal===document.querySelector('.ck-serial-terminal-host')`));
 report.checks.push('Console expansion preserves the live terminal instance and does not reinstall the serial view');
 // Verify real event delivery and xterm rendering survive the new compact layout.
 await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'serial-data',payload:'COMPACT_UI_EVENT_OK\\r\\n'})`);
 await wait(`document.querySelector('[data-ck-role="serial-terminal"]')?.classList.contains('has-output')`,'serial event displayed');
 report.checks.push('Real desktop serial-data event reaches xterm in compact mode (synthetic data, no physical port)');
 await click('button[aria-label="收起控制台"]');await capture('900-600-console-hidden');
 await click('button[aria-label="关闭 AI 面板"]');await click('[data-ck-role="ai-assistant-trigger"]');
 await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`,'AI reopen');
 assert.equal(await client.evaluate(`document.querySelector('.ck-ai-input-shell textarea').value`),'');
 report.checks.push('Closing/reopening AI and hiding the console retain a usable composer');
 report.calls=await client.evaluate('window.__compactCalls');
 assert(!report.calls.some(c=>['chat_with_glm_stream','compile_sketch','compile_ai_candidate','open_serial_monitor','close_serial_monitor','send_serial_data'].includes(c)));
 assert.equal(await snapshot(),report.before);
 report.checks.push('Layout interactions do not modify blocks or invoke models, compilers, serial open/close or send');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);if(socket)try{const shot=await command('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,'failure.png'),Buffer.from(shot.data,'base64'));}catch{}}
finally{
 if(client){report.after=await snapshot().catch(()=>null);if(savedDark!==undefined)await client.evaluate(`document.documentElement.classList.toggle('dark',${savedDark})`).catch(()=>{});}
 if(socket){await command('Emulation.clearDeviceMetricsOverride').catch(()=>{});socket.close();}client?.close();
 fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,status:report.status,checks:report.checks,error:report.error}));
}
