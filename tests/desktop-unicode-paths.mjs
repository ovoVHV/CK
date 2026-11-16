import {parseFqbn} from '../src/targets.mjs';
// Actual editor button regression. Run through the normal bootstrap with a
// private CK_PATH_TEST_TEMP and CK_V91_TEST_DATA_ROOT; retain all raw samples.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';import {ENGINE_VERSION} from '../src/version.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG)),profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const out=process.env.CK_V91_PRODUCT_ROOT,projectRoot=path.join(out,'中文 工程目录');fs.mkdirSync(projectRoot,{recursive:true});
const targets=JSON.parse(process.env.CK_UNICODE_TARGETS??'["esp32:esp32:esp32s3","arduino:avr:uno"]');
const report={status:'RUNNING',engineVersion:ENGINE_VERSION,workspaceRoot:config.paths.workspaceRoot,startedAt:new Date().toISOString(),boundary:'Actual editor button to overlay dismissal; 100ms polling; full input and host artifact validation. No debugger. OS file cache not flushed.',runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'unicode-report.json'),JSON.stringify(report,null,2));
const hashes=w=>w.artifacts.map(x=>[x.name,x.sha256]);let c;save();
try{
 c=await connectDesktop();
 for(const fqbn of targets){
  const avr=fqbn.startsWith('arduino:'),file=path.join(projectRoot,fqbn.split(':')[2]+' 中文工程.ck');
  const fixture={format:'ck-project',schema_version:1,migration_version:1,name:'中文路径',board:fqbn,board_package_id:fqbn.split(':').slice(0,3).join(':'),options:JSON.stringify(Object.fromEntries(parseFqbn(fqbn).options)),xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:avr?'delay_ms':'wifi_connect',id:'ck-unicode-block',x:80,y:80,fields:avr?{MS:500}:{SSID:'MyWiFi',PASSWORD:'12345678'}}]}})};
  fs.writeFileSync(file,JSON.stringify(fixture));
  const open={requestId:randomUUID(),path:file,source:'unicode-regression'};
  await c.evaluate(`(async()=>{await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});await new Promise(r=>setTimeout(r,1500));for(let n=0;n<240;n++){const b=document.querySelector('[data-ck-role="build-compile-action"]');if(b&&!b.disabled&&document.querySelector('[data-id="ck-unicode-block"]')&&!document.querySelector('[data-ck-role="project-load-progress"]'))return true;if(n%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});await new Promise(r=>setTimeout(r,250))}throw Error('Project open timeout')})()`);
  async function editField(old,value){
    const location=await c.evaluate(`(()=>{const block=document.querySelector('[data-id="ck-unicode-block"]');const field=[...block.querySelectorAll('.blocklyEditableField')].find(e=>e.textContent===${JSON.stringify(old)});if(!field)throw Error('Editable field missing: '+block.outerHTML);const r=field.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2}})()`);
    await c.input('Input.dispatchMouseEvent',{type:'mousePressed',...location,button:'left',clickCount:1});
    await c.input('Input.dispatchMouseEvent',{type:'mouseReleased',...location,button:'left',clickCount:1});
    await c.evaluate(`(async()=>{for(let n=0;n<40;n++){const i=document.querySelector('input.blocklyHtmlInput');if(i){i.focus();i.select();return true}await new Promise(r=>setTimeout(r,100))}throw Error('Field editor did not open')})()`);
    await c.input('Input.insertText',{text:value});
    await c.input('Input.dispatchKeyEvent',{type:'keyDown',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await c.input('Input.dispatchKeyEvent',{type:'keyUp',key:'Enter',code:'Enter',windowsVirtualKeyCode:13});
    await c.evaluate(`(async()=>{await new Promise(r=>setTimeout(r,500));if(!document.querySelector('[data-id="ck-unicode-block"]').textContent.includes(${JSON.stringify(value)}))throw Error('Field edit not committed');return true})()`);
  }
  if(process.env.CK_UNICODE_SHORT!=='1'){await editField(avr?'500':'MyWiFi',avr?'301':'中文WiFi');await editField(avr?'301':'中文WiFi',avr?'500':'MyWiFi');}
  let first,last,edited;
  const phases=process.env.CK_UNICODE_SHORT==='1'?['cold','same-1']:['cold','same-1','edit','same-2','corrupt-object','same-3','revert'];
  for(const phase of phases){
   if(phase==='edit'||phase==='revert'){
    const field=avr?'MS':'SSID',value=phase==='edit'?(avr?'301':'中文WiFi'):(avr?'500':'MyWiFi');
    const old=phase==='edit'?(avr?'500':'MyWiFi'):(avr?'301':'中文WiFi');
    await editField(old,value);
   }
   if(phase==='corrupt-object'){
    const object=last.objects.find(x=>/[\\/]sketch[\\/]/.test(x.file));assert(object);const s=fs.statSync(object.file),bytes=fs.readFileSync(object.file);bytes[bytes.length-1]^=1;fs.writeFileSync(object.file,bytes);fs.utimesSync(object.file,s.atime,s.mtime);
   }
   fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:phase==='cold'}));
   const stage=path.join(path.dirname(config.paths.workspaceRoot),'requests'),before=new Set(fs.existsSync(stage)?fs.readdirSync(stage):[]);
   console.log('START '+fqbn+' '+phase);
   const observed=await c.evaluate(`(async()=>{const b=document.querySelector('[data-ck-role="build-compile-action"]');if(!b||b.disabled)throw Error('Compile unavailable');const at=performance.now();let runId=null,target=null;const frames=new Set();b.click();for(let n=0;n<6000;n++){const p=document.querySelector('[data-ck-role="compile-progress-overlay"]');if(p){runId=p.getAttribute('data-ck-build-run-id');target=p.getAttribute('data-ck-build-fqbn');const a=p.querySelector('[data-ck-role="compile-progress-activity"]');if(a)frames.add(a.style.transform)}if(runId&&!p&&!b.disabled)return {wallMs:performance.now()-at,runId,fqbn:target,animationFrames:frames.size,log:document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText};await new Promise(r=>setTimeout(r,100))}throw Error('Compile timeout')})()`);
   const row={target:fqbn,project:file,phase,...observed};report.runs.push(row);save();
   const dirs=fs.existsSync(stage)?fs.readdirSync(stage).filter(n=>!before.has(n)).map(n=>path.join(stage,n,'artifacts/sketch')).filter(d=>fs.existsSync(path.join(d,'native-graph-host-receipt.json'))):[];
   if(dirs.length!==1){const id=row.log?.match(/Actual request ([0-9a-f]{64})/)?.[1],receipt=id&&path.join(config.paths.evidenceRoot,'runs',id+'.receipt.json');if(receipt&&fs.existsSync(receipt))row.workerFailure=JSON.parse(fs.readFileSync(receipt));throw Error(row.workerFailure?.error??'No unique native export: '+row.log);}
   const host=JSON.parse(fs.readFileSync(path.join(dirs[0],'native-graph-host-receipt.json'))),w=host.worker;row.host=host;assert.equal(w.fqbn.split(':').slice(0,3).join(':'),fqbn.split(':').slice(0,3).join(':'));for(const [k,v] of parseFqbn(fqbn).options)assert.equal(new Map(parseFqbn(w.fqbn).options).get(k),v);assert(w.success);validateArtifacts(w.artifacts,fqbn);
   for(const a of w.artifacts)assert.equal(digest(fs.readFileSync(path.join(dirs[0],a.name))),a.sha256);
   assert(row.animationFrames>2,'Progress animation must remain active');row.artifactsVerified=w.artifacts.length;
   if(phase==='cold'){assert(w.counts.CompileGCC>1);assert.equal(w.counts.CacheRestored,0);first=w;}
   else if(phase.startsWith('same')){assert.equal(w.noOpFastPath.hit,true);for(const k of ['DiscoveryGCC','PrototypeGCC','CompileGCC','Linker','ImageGenerator'])assert.equal(w.counts[k],0);assert.deepEqual(hashes(w),hashes(last));}
   else if(phase==='edit'){assert.equal(w.counts.CompileGCC,1);assert.equal(w.counts.DiscoveryGCC,0);assert.equal(w.counts.Linker,1);if(!avr){const a=w.artifacts.find(x=>x.name==='sketch.ino.bin');assert(fs.readFileSync(a.file).includes(Buffer.from('中文WiFi')),'Chinese source string must survive the real build');}edited=w;}
   else if(phase==='corrupt-object'){assert.equal(w.noOpFastPath.hit,false);assert(w.counts.ObjectRestored>0||w.counts.CompileGCC>0);assert.deepEqual(hashes(w),hashes(edited));}
   else if(phase==='revert'){assert.deepEqual(hashes(w),hashes(first));assert(w.counts.ObjectRestored>0||w.counts.CompileGCC>0);}
   row.success=true;last=w;save();console.log(JSON.stringify({fqbn,phase,wallMs:row.wallMs,counts:w.counts,artifactsVerified:row.artifactsVerified}));
  }
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{fs.writeFileSync(profileFile,original);c?.close();save();console.log('REPORT '+path.join(out,'unicode-report.json'));}
