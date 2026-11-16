import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
const config=loadConfig(process.argv[2]),targets=JSON.parse(process.env.CK_PCH_TARGETS??'["esp32:esp32:esp32s3","esp32:esp32:esp32","esp32:esp32:esp32c3"]');
const A=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),B=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
const report={status:'RUNNING',boundary:'compiler correctness and session regression; may overlap desktop packaging, not performance evidence',targets:[]};
fs.mkdirSync(config.paths.evidenceRoot,{recursive:true});const file=path.join(config.paths.evidenceRoot,'shared-pch-qualification.json');const save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
try{for(const [i,fqbn] of targets.entries()){
 const controller=new BuildController(config),workspace=path.join(config.paths.workspaceRoot,'target-'+i),row={fqbn,runs:[],checks:[]};report.targets.push(row);
 async function build(label,source,clean=false){const requestId='q'+i+'-'+label,request={requestId,sourceSha256:digest(source),fqbn,sysroot:config.paths.sysroot,workspace,sketchDir:path.join(workspace,'source/sketch'),libraries:[],forceClean:clean};console.log('START '+fqbn+' '+label);const result=await controller.submit({protocolVersion:1,request,source});row.runs.push(result);save();assert(result.success,JSON.stringify(result.error));validateArtifacts(result.artifacts);await controller.acknowledge(requestId,{sourceSha256:request.sourceSha256,success:true});console.log(JSON.stringify({fqbn,label,counts:result.counts}));return result;}
 let a;
 try{
  a=await build('cold',A,true);assert(a.libraryPch.some(p=>p.accepted&&p.compiled>=3));assert(a.counts.PchGCC>=2);assert.equal(a.counts.CacheRestored,0);
  const same=await build('same',A);assert(same.noOpFastPath.hit);assert.equal(same.counts.CompileGCC,0);assert.equal(same.counts.PchGCC,0);
  const b=await build('wait-block',B);assert.equal(b.counts.CompileGCC,1);assert.equal(b.counts.DiscoveryGCC,0);assert.equal(b.counts.PchGCC,0);
  const back=await build('restore-A',A);assert.equal(back.counts.CompileGCC,0);assert.deepEqual(back.artifacts,a.artifacts);
  const object=a.objects.find(o=>o.file.endsWith('Esp.cpp.o'));assert(object);fs.writeFileSync(object.file,'corrupt');const repaired=await build('repair-core-object',A);assert.equal(repaired.counts.ObjectRestored,1);assert.equal(repaired.counts.CompileGCC,0);assert.deepEqual(repaired.artifacts,a.artifacts);
  row.checks.push('Cold shared headers, unchanged source, wait-block edit, A restoration and corrupted shared-PCH-produced Core object recovery');
 }finally{await controller.close();}
 console.log('OFFICIAL CLEAN '+fqbn);const official=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir:path.join(workspace,'source/sketch'),fqbn,jobs:config.limits.jobs}),'--clean','--json',path.join(workspace,'source/sketch')],config.paths.sysroot);
 fs.writeFileSync(path.join(config.paths.evidenceRoot,'official-'+i+'.json'),JSON.stringify(official));assert.equal(official.code,0,official.stderr.slice(-2000));
 const buildDir=path.join(workspace,'build');assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),a.generatedSha256);
 const order=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(order(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),order(a.compileDatabase));
 for(const o of a.objects)assert.equal(digest(fs.readFileSync(o.file)),o.sha256,o.file);
 const platform=JSON.parse(official.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
 for(const name of artifactNames)assert.equal(digest(fs.readFileSync(name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name))),a.artifacts.find(x=>x.name===name).sha256,name);
 row.checks.push('Official clean CPP, complete compile database, every object and all ten delivery files byte-identical');row.status='PASS';save();
}report.status='PASS';}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}finally{save();console.log('REPORT '+file);}
