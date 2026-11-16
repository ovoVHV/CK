// Actual desktop IPC / compiler / HTTPS feedback receiver. Explicit opt-in because
// a synthetic project's compile report is sent to the operator's private server.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
if(process.env.CK_TEST_FEEDBACK_SUBMISSION!=='1')throw Error('Set CK_TEST_FEEDBACK_SUBMISSION=1 to send synthetic test compile diagnostics');
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const out=path.join(config.paths.evidenceRoot,'compile-log-submission');fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',checks:[],runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const delay=ms=>new Promise(r=>setTimeout(r,ms));
let client;
async function wait(expression,label,timeout=45000){const started=Date.now();while(Date.now()-started<timeout){const value=await client.evaluate(expression);if(value)return value;await delay(200);}throw Error('Timeout: '+label);}
let visualSocket,visualId=0;const visualPending=new Map();
async function command(method,params){
 if(!visualSocket){
  const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.type==='page'&&p.url==='http://tauri.localhost/');
  visualSocket=new WebSocket(page.webSocketDebuggerUrl);await new Promise((res,rej)=>{visualSocket.onopen=res;visualSocket.onerror=rej;});
  visualSocket.onmessage=e=>{const m=JSON.parse(e.data),p=visualPending.get(m.id);if(p){visualPending.delete(m.id);m.error?p.reject(Error(JSON.stringify(m.error))):p.resolve(m.result);}};
 }
 return new Promise((resolve,reject)=>{const id=++visualId;visualPending.set(id,{resolve,reject});visualSocket.send(JSON.stringify({id,method,params}));});
}
async function screenshot(name){
 const result=await command('Page.captureScreenshot',{format:'png',captureBeyondViewport:false});
 fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(result.data,'base64'));
}
try{
 client=await connectDesktop();
 await wait(`!!document.querySelector('[data-ck-action="copy-official-qq-group"]')`,'home QQ button');
 assert(await client.evaluate(`document.querySelector('[data-ck-action="copy-official-qq-group"]').textContent.includes('1080798212')`));
 await screenshot('homepage');
 const fixture={format:'ck-project',schema_version:1,migration_version:1,name:'Compile log feedback test',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'feedback-loop',x:60,y:70}]}})};
 const file=path.join(out,'Feedback test.ck');fs.writeFileSync(file,JSON.stringify(fixture));
 const open={requestId:randomUUID(),path:file,source:'compile-log-submission-test'};
 await client.evaluate(`(async()=>{for(let i=0;i<160;i++){if(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('feedback-loop')&&!document.querySelector('[data-ck-role="project-load-progress"]'))return true;if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});await new Promise(r=>setTimeout(r,250));}throw Error('Fixture not opened')})()`);
 await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'compile ready');
 // Observe only. No compile response, native result or network request is mocked.
 await client.evaluate(`(()=>{window.__feedbackTest={calls:[]};const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),name=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&['compile_sketch','preview_compile_feedback','submit_compile_feedback'].includes(name)){const row={name,args:JSON.parse(options.body),started:performance.now()};window.__feedbackTest.calls.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.ms=performance.now()-row.started;row.done=true;return response;}return original(url,options);};return true})()`);
 await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
 await wait(`document.querySelector('[data-ck-action="submit-compile-log"]')?.disabled===true`,'submission disabled while compiling');
 const compiled=await wait(`window.__feedbackTest.calls.find(r=>r.name==='compile_sketch'&&r.done)||null`,'actual compile',360000);
 assert.equal(compiled.kind,'ok',compiled.response);report.runs.push({kind:'compile',ms:compiled.ms,runId:compiled.args.runId});save();
 await wait(`document.querySelector('[data-ck-action="submit-compile-log"]')?.disabled===false`,'submission enabled after compile');
 await command('Runtime.evaluate',{expression:`(()=>{window.__feedbackClipboard={};const original=navigator.clipboard.writeText.bind(navigator.clipboard);navigator.clipboard.writeText=async text=>{await original(text);window.__feedbackClipboard={success:true,text};};document.querySelector('[data-ck-role="compile-log-actions"] button').click();return true})()`,userGesture:true,returnByValue:true});
 await wait(`window.__feedbackClipboard.success===true`,'real clipboard write');
 assert(await client.evaluate(`window.__feedbackClipboard.text.includes('[Timing')&&window.__feedbackClipboard.text.length>100`));
 report.checks.push('Copy button wrote actual complete output through the system clipboard');
 await client.evaluate(`document.querySelector('[data-ck-action="submit-compile-log"]').click()`);
 await wait(`!!document.querySelector('[aria-label="将提交的脱敏日志"]')`,'preview modal');
 const preview=await client.evaluate(`JSON.parse(document.querySelector('[aria-label="将提交的脱敏日志"]').value)`);
 assert.equal(preview.fqbn,'arduino:avr:uno');assert.equal(preview.outcome,'success');assert(preview.log.includes('[Timing'));
 assert(!preview.log.includes('C:\\Users\\'));assert(!preview.log.includes('void setup'));
 assert.equal(await client.evaluate(`window.__feedbackTest.calls.filter(r=>r.name==='submit_compile_feedback').length`),0,'preview must not upload');
 await command('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1,mobile:false});
 await delay(200);
 const small=await client.evaluate(`(()=>{const d=document.querySelector('[role="dialog"][aria-modal="true"]'),b=document.querySelector('[data-ck-action="confirm-submit-compile-log"]'),r=d.getBoundingClientRect(),q=b.getBoundingClientRect();return {dialog:{x:r.x,y:r.y,right:r.right,bottom:r.bottom},button:{right:q.right,bottom:q.bottom},viewport:{width:innerWidth,height:innerHeight}}})()`);
 report.minimumLayout=small;save();await screenshot('preview-minimum-900x600');
 assert(small.dialog.y>=0&&small.dialog.right<=900&&small.dialog.bottom<=600&&small.button.bottom<=600);
 report.minimumLayout=small;await screenshot('preview-minimum-900x600');
 await command('Emulation.clearDeviceMetricsOverride',{});
 report.checks.push('Preview and submit controls fit the supported 900x600 minimum viewport');
 await screenshot('submit-preview');
 await client.evaluate(`document.querySelector('[data-ck-action="confirm-submit-compile-log"]').click()`);
 await wait(`document.querySelector('[data-ck-action="submit-compile-log"]')?.textContent.includes('本次已提交')`,'remote receipt',90000);
 const first=await client.evaluate(`window.__feedbackTest.calls.find(r=>r.name==='submit_compile_feedback'&&r.done)`);
 assert.equal(first.kind,'ok',first.response);report.receipt=JSON.parse(first.response);report.checks.push('Actual compile, local preview without network, HTTPS receipt and disabled submitted button');
 await screenshot('submitted');
 // Host and server both enforce the rule even when the UI is bypassed.
 const again=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('submit_compile_feedback',{runId:${JSON.stringify(compiled.args.runId)}})`);
 assert.deepEqual(again,report.receipt);report.checks.push('Duplicate host invoke returns same receipt');
 const missing=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('submit_compile_feedback',{runId:'not-a-finished-compile'}).then(()=>false,()=>true)`);
 assert(missing);report.checks.push('Fabricated run ID rejected by host');
 // UI tests at supported minimum viewport: check that controls remain visible.
 report.layout=await client.evaluate(`(()=>{const el=document.querySelector('[data-ck-role="compile-log-actions"]'),r=el.getBoundingClientRect();return {width:innerWidth,height:innerHeight,bar:{x:r.x,y:r.y,width:r.width,height:r.height},overflow:el.scrollWidth>el.clientWidth+1,buttons:[...el.querySelectorAll('button')].map(b=>({text:b.textContent,disabled:b.disabled}))}})()`);
 assert.equal(report.layout.overflow,false);
 // A second real compile grants a fresh report, independent of previous receipt.
 await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
 await wait(`window.__feedbackTest.calls.filter(r=>r.name==='compile_sketch'&&r.done).length===2`,'second compile',360000);
 await wait(`document.querySelector('[data-ck-action="submit-compile-log"]')?.disabled===false`,'fresh compile submission available');
 const nextRun=await client.evaluate(`window.__feedbackTest.calls.filter(r=>r.name==='compile_sketch')[1]`);
 const nextPreview=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('preview_compile_feedback',{runId:${JSON.stringify(nextRun.args.runId)}})`);
 assert.notEqual(nextPreview.report.reportId,report.receipt.reportId);assert.equal(nextPreview.receipt,null);
 report.checks.push('Next compile has a new eligible report; old receipt cannot disable it');
 // Failure path through the actual compiler (no user source).
 const badId=randomUUID();const bad=await client.build('void setup(){ missing_feedback_test_symbol(); }\nvoid loop(){}','arduino:avr:uno',{runId:badId,projectId:'feedback-test-error'});
 assert.equal(bad.success,false);
 const failed=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('preview_compile_feedback',{runId:${JSON.stringify(badId)}})`);
 assert.equal(failed.report.outcome,'failed-or-cancelled');assert(failed.report.log.length>0);
 report.checks.push('Failed real compilation also provides a bounded diagnostic preview');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);}
finally{save();visualSocket?.close();client?.close();console.log(JSON.stringify(report,null,2));}
