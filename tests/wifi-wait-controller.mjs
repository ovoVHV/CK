import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';import {digest,normalize,validateArtifacts} from '../src/protocol.mjs';
const c=loadConfig(process.argv[2]),controller=new BuildController(c),workspace=path.join(c.paths.workspaceRoot,'wait-'+Date.now()),report={boundary:'real controller/compiler, not desktop performance',status:'RUNNING',runs:[]};
const A=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),B=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
const file=path.join(c.paths.evidenceRoot,'wifi-wait-controller.json');const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));
async function build(label,code,reference=false){console.log('START '+label);const request={requestId:label,sourceSha256:digest(normalize(code)),fqbn:process.argv[3]??'esp32:esp32:esp32s3',sysroot:c.paths.sysroot,workspace,sketchDir:path.join(workspace,'source/sketch'),libraries:[],frontendReference:reference,historyReference:true};const r=await controller.submit({protocolVersion:1,request,source:code});report.runs.push(r);save();assert(r.success,JSON.stringify(r.error));validateArtifacts(r.artifacts);await controller.acknowledge(label,{sourceSha256:request.sourceSha256,success:true});console.log(JSON.stringify({label,ms:r.wallMs,frontend:r.frontend,counts:r.counts,batch:r.batchTimings}));return r;}
try{
 const a=await build('cold-A',A),reference=await build('reference-B',B,true);await build('reset-A',A);const fast=await build('fast-B',B);
 assert.equal(fast.counts.PrototypeGCC,0);assert.equal(reference.counts.PrototypeGCC,1);assert.equal(reference.counts.CompileGCC,1);assert.equal(fast.counts.CompileGCC,1);assert.equal(fast.counts.CacheRestored,0);
 assert.equal(fast.generatedSha256,reference.generatedSha256);assert.deepEqual(fast.artifacts,reference.artifacts);
 assert.deepEqual(fast.objects.map(x=>[x.file,x.sha256]),reference.objects.map(x=>[x.file,x.sha256]));
 assert.deepEqual(fast.compileDatabase,reference.compileDatabase);report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}finally{await controller.close();save();}
