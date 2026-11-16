import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';import {digest,normalize,validateArtifacts} from '../src/protocol.mjs';
const config=loadConfig(process.argv[2]),fqbn=process.argv[3]??'esp32:esp32:esp32s3',controller=new BuildController(config),workspace=path.join(config.paths.workspaceRoot,'cold-'+Date.now());
const report={status:'RUNNING',boundary:'controller and actual compiler; not desktop performance',runs:[]},out=path.join(config.paths.evidenceRoot,'cold-concurrency-controller.json');
const source=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8');
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
const compare=(a,b)=>{assert.equal(a.generatedSha256,b.generatedSha256);assert.deepEqual(a.compileDatabase,b.compileDatabase);assert.deepEqual(a.selectedLibraries,b.selectedLibraries);assert.deepEqual(a.objects,b.objects);assert.deepEqual(a.artifacts,b.artifacts);};
try{
 for(const [label,reference]of [['reference',true],['combined',false]]){
  config.limits.jobs=reference?8:16;console.log('START '+label);const request={requestId:label,sourceSha256:digest(normalize(source)),fqbn,sysroot:config.paths.sysroot,workspace,sketchDir:path.join(workspace,'source/sketch'),libraries:[],forceClean:true,coldPipelineReference:false};
  const result=await controller.submit({protocolVersion:1,request,source});report.runs.push(result);save();assert(result.success,JSON.stringify(result.error));validateArtifacts(result.artifacts);await controller.acknowledge(label,{sourceSha256:request.sourceSha256,success:true});
  console.log(JSON.stringify({label,wallMs:result.wallMs,counts:result.counts,phases:result.phases}));
 }
 const [reference,combined]=report.runs;assert.equal(combined.counts.ObjectProducedDuringDiscovery,70);assert.equal(combined.counts.SchedulerCompileGCC,0);assert.equal(combined.counts.PipelinedSketchGCC,1);assert.equal(reference.counts.SchedulerCompileGCC,0);assert.equal(combined.counts.CompileGCC,71);assert.equal(reference.counts.CompileGCC,71);compare(reference,combined);report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}finally{await controller.close();save();}
