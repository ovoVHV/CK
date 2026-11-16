import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const source=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8');
const pairs=Number(process.env.CK_SHARED_PAIRS??5),fqbn=process.env.CK_SHARED_FQBN??'esp32:esp32:esp32s3';
const uiOnly=process.env.CK_UI_ONLY==='1';
const dir=path.join(config.paths.evidenceRoot,'shared-pch-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const report={status:'RUNNING',boundary:'real desktop compile_sketch IPC, full clean build every sample, no debugger',comparison:uiOnly?'same shared-PCH engine, decorative pulse/blur on versus off':'reference engine versus shared PCH',filesystemCachePurged:false,runs:[]};
const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
let client;try{
 client=await connectDesktop();let baseline;
 for(let n=0;n<pairs;n++)for(const candidate of n%2?[true,false]:[false,true]){
  fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:true,coldLibraryPchReference:uiOnly?false:!candidate,discoveryBatchReference:uiOnly?false:!candidate}));
  if(uiOnly)await client.evaluate(`(()=>{let e=document.getElementById('ck-render-test');if(!e){e=document.createElement('style');e.id='ck-render-test';document.head.appendChild(e)}e.textContent=${JSON.stringify(candidate?'.com-capsule .animate-pulse, .com-capsule .animate-ping { animation:none !important } header.backdrop-blur-sm { backdrop-filter:none !important }':'')};return true})()`);
  const label=(candidate?'candidate':'reference')+'-'+(n+1);console.log('START '+label);
  const result=await client.build(source,fqbn,{projectId:'local-shared-pch',workspaceFingerprint:digest(source)});const row={label,candidate,...result};report.runs.push(row);save();assert(result.success,result.error);
  const exported=JSON.parse(result.value).path;row.host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));const worker=row.host.worker;validateArtifacts(worker.artifacts);
  for(const a of worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256,a.name);
  if(baseline)for(const k of ['generatedSha256','compileDatabase','selectedLibraries','objects','artifacts'])assert.deepEqual(worker[k],baseline[k],k);else baseline=worker;
  assert.equal(worker.counts.CompileGCC,71);assert.equal(worker.counts.ObjectRetained,0);assert.equal(worker.counts.CacheRestored,0);
  if(candidate||uiOnly)assert(worker.libraryPch.some(x=>x.accepted&&x.compiled>=3));else assert.equal(worker.libraryPch.length,0);
  save();console.log(JSON.stringify({label,wallMs:result.wallMs,workerMs:worker.wallMs,phases:worker.phases,pch:worker.libraryPch}));
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{fs.writeFileSync(profileFile,original);client?.close();save();console.log('REPORT '+path.join(dir,'report.json'));}
