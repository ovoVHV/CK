import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {BuildController} from '../src/controller.mjs';
import {digest,normalize,validateArtifacts} from '../src/protocol.mjs';
const config=loadConfig(process.argv[2]), controller=new BuildController(config);
const source=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8');
const workspace=path.join(config.paths.workspaceRoot,'local-jobs');
const report={status:'RUNNING',boundary:'real clean compiler runs through controller; screening only, desktop confirmation required',runs:[]};
const out=path.join(config.paths.evidenceRoot,(process.env.CK_LIBRARY_PCH==='1'?'local-library-pch-':'local-cold-jobs-')+Date.now()+'.json');
fs.mkdirSync(config.paths.evidenceRoot,{recursive:true});
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
try {
  for(const [n,jobs] of JSON.parse(process.env.CK_LOCAL_JOBS??'[8,4,2]').entries()){
    config.limits.jobs=jobs;
    const requestId='jobs-'+jobs+'-'+n;
    const request={requestId,sourceSha256:digest(normalize(source)),fqbn:'esp32:esp32:esp32s3',sysroot:config.paths.sysroot,workspace,sketchDir:path.join(workspace,'source/sketch'),libraries:[],forceClean:true,coldLibraryPchReference:process.env.CK_LIBRARY_PCH!=='1',discoveryBatchReference:process.env.CK_ROLLING!=='1'};
    console.log('START '+requestId);
    const result=await controller.submit({protocolVersion:1,request,source});
    report.runs.push({jobs,result});save();assert(result.success,JSON.stringify(result.error));
    validateArtifacts(result.artifacts);
    await controller.acknowledge(requestId,{sourceSha256:request.sourceSha256,success:true});
    if(n){const a=report.runs[0].result;for(const key of ['generatedSha256','compileDatabase','selectedLibraries','objects','artifacts'])assert.deepEqual(result[key],a[key],key);}
    assert.equal(result.counts.CompileGCC,71);assert.equal(result.counts.CacheRestored,0);assert.equal(result.counts.ObjectRetained,0);
    console.log(JSON.stringify({jobs,wallMs:result.wallMs,phases:result.phases,coldDiscovery:result.coldDiscovery,coldPipeline:result.coldPipeline}));
  }
  report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{await controller.close();save();console.log('REPORT '+out);}
