import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const config=read(process.env.CK_V9_ENGINE_CONFIG),out=path.join(config.paths.evidenceRoot,'servo-library-ui-'+Date.now());fs.mkdirSync(out,{recursive:true});
const library='E:/CK-Build-Engine-V9.1/library-author-kit-20261112/ck_servo_bundled_avr';
const report={status:'RUNNING',runs:[],physicalHardware:false};let client;
const delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(expr,label){for(let n=0;n<1200;n++){const value=await client.evaluate(expr);if(value)return value;await delay(100);}throw Error('Timed out: '+label);}
try{
 client=await connectDesktop();
 await client.evaluate(`window.__TAURI_INTERNALS__.invoke('import_library',${JSON.stringify({path:path.join(path.dirname(library),'CK-Servo-完整原库-1.0.1.zip'),board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno'})})`);
 const installed=path.join(config.paths.sysroot,'libraries/arduino_avr_uno/ck_servo_bundled_avr');
 assert.equal(read(path.join(installed,'library.json')).version,'1.0.1');
 const file=path.join(out,'Servo-real-blocks.ck');fs.copyFileSync(path.join(installed,'examples/Servo演示.ck'),file);
 const event={requestId:randomUUID(),path:file,source:'servo-speed-regression'};
 for(let n=0;n<240;n++){
  if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('servo-loop')&&window.CK_BLOCK_CATALOG?.blocks.filter(b=>b.library_id==='ck_servo_bundled_avr').length===6&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;
  if(n%8===0)await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(event)}})`);await delay(250);
 }
 await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'ready');
 await client.evaluate(`(()=>{window.__servoBuilds=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);if(u.hostname!=='ipc.localhost'||decodeURIComponent(u.pathname.slice(1))!=='compile_sketch')return original(url,options);const row={args:JSON.parse(options.body),started:performance.now()};window.__servoBuilds.push(row);const result=await original(url,options);row.response=await result.clone().text();row.kind=result.headers.get('Tauri-Response');row.ipcMs=performance.now()-row.started;row.done=true;return result;};return true;})()`);
 for(const label of ['cold','same','edit']){
  if(label==='edit')await client.evaluate(`(()=>{const w=window.CK_NATIVE_REGRESSION.getCurrent().workspace,b=w.getAllBlocks(false).find(b=>b.type==='ck_servo_bundled_avr_write');b.getInputTargetBlock('ANGLE').setFieldValue('91','NUM');return true;})()`);
  await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'button enabled');
  const index=await client.evaluate('window.__servoBuilds.length');
  const started=Date.now();await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
  const row=await wait(`window.__servoBuilds[${index}]?.done?window.__servoBuilds[${index}]:null`,'build '+label);
  await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'UI completion');
  fs.writeFileSync(path.join(out,label+'-ipc.json'),JSON.stringify(row,null,2));
  assert.equal(row.kind,'ok',row.response.slice(0,1000));assert(row.args.code.includes('#include <CKServoChannels.h>'));assert(!/^\s*#\s*(?:if|define)/m.test(row.args.code));
  const value=JSON.parse(JSON.parse(row.response)),worker=read(path.join(value.path,'native-graph-host-receipt.json')).worker;
  assert.equal(worker.officialFrontendInvoked,false);
  if(label==='same'){assert(worker.noOpFastPath.hit);assert.equal(worker.counts.CompileGCC+worker.counts.Linker+worker.counts.ImageGenerator,0);}
  if(label==='edit'){assert.equal(worker.counts.CompileGCC,1);assert.equal(worker.counts.ObjectRetained,worker.objects.length-1);}
  report.runs.push({label,clickToReadyMs:Date.now()-started,ipcMs:row.ipcMs,counts:worker.counts,phases:worker.phases,code:row.args.code,artifacts:value.artifacts});
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{client?.close();fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report}));}
