import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
import {ENGINE_VERSION} from '../src/version.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const source=fs.readFileSync(new URL('user-wifi-A.ino',import.meta.url),'utf8');
const fqbn=process.env.CK_REPEAT_FQBN??'esp32:esp32:esp32s3';
const folder=path.join(config.paths.evidenceRoot,'repeat-wifi-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',boundary:'real desktop IPC; no debugger; unchanged WiFi sketch; one continuous desktop session',fqbn,sourceSha256:digest(source),performanceQualified:false,runs:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
let client;save();
try{
 client=await connectDesktop();
 for(let i=0;i<4;i++){
  console.log('START '+(i===0?'cold':'unchanged-'+i));
  const r=await client.build(source,fqbn,{projectId:'project-path:C:\\CK-Repeat-Diagnostic\\WiFi.ck',workspaceFingerprint:digest(source)});
  const row={label:i===0?'cold':'unchanged-'+i,...r};report.runs.push(row);save();assert(r.success,r.error);
  const exported=JSON.parse(r.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));
  row.host=host;validateArtifacts(host.worker.artifacts);
  for(const artifact of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,artifact.name))),artifact.sha256);
  if(i){
   const first=report.runs[0].host.worker;
   assert.equal(host.worker.sessionId,first.sessionId);
   for(const k of ['DiscoveryGCC','PrototypeGCC','CompileGCC','PchGCC','Linker','ImageGenerator'])assert.equal(host.worker.counts[k],0,k);
   assert.equal(host.worker.noOpFastPath.hit,true);
   assert.deepEqual(host.worker.artifacts.map(a=>[a.name,a.sha256]),first.artifacts.map(a=>[a.name,a.sha256]));
  }
  console.log(JSON.stringify({label:row.label,wallMs:r.wallMs,counts:host.worker.counts,phases:host.worker.phases,adapter:host.adapterPhases,graph:host.worker.graphReuse}));save();
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{save();client?.close();console.log('REPORT '+path.join(folder,'report.json'));}
