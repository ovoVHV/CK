import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const dir=path.join(config.paths.evidenceRoot,'live-activity-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const report={status:'RUNNING',runs:[],boundary:'Real editor compile button and installed WebView; upload spinner exercised while compile/upload actions are busy; no physical board flashing.'};
const c=await connectDesktop(),sleep=ms=>new Promise(r=>setTimeout(r,ms));
const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
try{
 const fqbn=process.env.CK_ACTIVITY_FQBN??'esp32:esp32:esp32s3',avr=fqbn.startsWith('arduino:avr:');
 const file=path.join(process.env.USERPROFILE,'Documents','CK','artifacts','activity-'+randomUUID()+'.ck');fs.mkdirSync(path.dirname(file),{recursive:true});
 fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'Live build activity',board:fqbn,board_package_id:fqbn.split(':').slice(0,3).join(':'),options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:avr?'delay_ms':'wifi_connect',id:'live-activity-project',x:60,y:60,fields:avr?{MS:500}:{SSID:'MyWiFi',PASSWORD:'12345678'}}]}})}));
 await c.evaluate(`(async()=>{for(let n=0;n<240;n++){const b=document.querySelector('[data-ck-role="build-compile-action"]');if(b&&!b.disabled&&document.querySelector('[data-id="live-activity-project"]')&&!document.querySelector('[data-ck-role="project-load-progress"]'))return true;if(n%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId:randomUUID(),path:file,source:'live-activity-regression'})}});await new Promise(r=>setTimeout(r,250))}throw Error('Editor not ready')})()`);
 for(const mode of ['cold','same','cancel','recover']){
  fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:mode==='cold'||mode==='cancel'}));
  const requests=path.join(path.dirname(config.paths.workspaceRoot),'requests'),previous=new Set(fs.existsSync(requests)?fs.readdirSync(requests):[]);
  const row={mode,samples:[],startedAt:Date.now()};report.runs.push(row);save();
  await c.evaluate(`(()=>{const button=document.querySelector('[data-ck-role="build-compile-action"]');if(!button||button.disabled)throw Error('Compile unavailable');button.click();return true})()`);
  let active=false,cancelled=false;
  for(let n=0;n<900;n++){
   const state=await c.evaluate(`(()=>{const p=document.querySelector('[data-ck-role="compile-progress-overlay"]'),log=document.querySelector('[data-ck-role="compile-log-scroll-container"]');return {busy:!!p,buttons:[...document.querySelectorAll('[data-ck-role="build-action-spinner"]')].map(e=>e.style.transform),message:document.querySelector('[data-ck-role="compile-progress-message"]')?.innerText,log:log?.innerText??'',bottom:log?log.scrollHeight-log.clientHeight-log.scrollTop:null}})()`);
   row.samples.push({ms:Date.now()-row.startedAt,...state});
   if(state.busy)active=true;
   if(mode==='cancel'&&active&&!cancelled&&state.log.includes('[V9 进度]')){await c.evaluate(`(()=>{document.querySelector('[data-ck-role="build-cancel-action"]').click();return true})()`);cancelled=true;}
   if(active&&!state.busy){await sleep(400);row.final=await c.evaluate(`({spinners:document.querySelectorAll('[data-ck-role="build-action-spinner"]').length,log:document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText??'',enabled:!document.querySelector('[data-ck-role="build-compile-action"]')?.disabled})`);break;}
   await sleep(500);
  }
  assert(row.final?.enabled,'Build did not settle');assert.equal(row.final.spinners,0);
  const busy=row.samples.filter(s=>s.busy),live=busy.filter(s=>s.log.includes('[V9 进度]'));
  assert(live.length>0,'No activity delivered before build completed');
  for(const index of [0,1])assert(new Set(busy.map(s=>s.buttons[index]).filter(Boolean)).size>=2,'Toolbar spinner did not move');
  if(mode==='cancel'){assert(cancelled);assert.match(row.final.log,/取消|cancel/i);}
  else{
   assert.match(row.final.log,/编译成功/);
   const exports=fs.readdirSync(requests).filter(id=>!previous.has(id)).map(id=>path.join(requests,id,'artifacts/sketch')).filter(p=>fs.existsSync(path.join(p,'native-graph-host-receipt.json')));
   assert.equal(exports.length,1);const host=JSON.parse(fs.readFileSync(path.join(exports[0],'native-graph-host-receipt.json'))),w=host.worker;
   validateArtifacts(w.artifacts,w.fqbn);for(const a of w.artifacts)assert.equal(digest(fs.readFileSync(path.join(exports[0],a.name))),a.sha256);
   row.counts=w.counts;row.wallMs=w.wallMs;row.artifacts=w.artifacts.map(a=>({name:a.name,sha256:a.sha256}));
   if(mode==='same'){assert.equal(w.noOpFastPath.hit,true);assert.equal(w.counts.CompileGCC,0);assert.equal(w.counts.Linker,0);assert.equal(w.counts.ImageGenerator,0);assert.deepEqual(row.artifacts,report.runs[0].artifacts);}
   if(mode==='cold'||mode==='recover')assert(new Set(live.map(s=>s.log.length)).size>=3,'Logs arrived only at completion');
  }
  row.liveUpdates=new Set(live.map(s=>s.log.length)).size;row.status='PASS';save();console.log(JSON.stringify({mode,status:row.status,liveUpdates:row.liveUpdates,wallMs:row.wallMs}));
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{fs.writeFileSync(profileFile,original);c.close();save();console.log('REPORT '+path.join(dir,'report.json'));}
