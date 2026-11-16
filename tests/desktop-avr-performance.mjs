import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs} from '../src/discovery.mjs';
import {avrObjectStructure} from './avr-object-proof.mjs';
import {ENGINE_VERSION,artifactsFor} from '../src/version.mjs';

const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const targets=JSON.parse(process.env.CK_AVR_TARGETS??'["arduino:avr:uno","arduino:avr:nano:cpu=atmega328old","arduino:avr:mega:cpu=atmega2560"]');
const rounds=Number(process.env.CK_AVR_ROUNDS??3),ab=process.env.CK_AVR_AB==='1';
const A='#include <Wire.h>\n#include <SPI.h>\nvoid setup() { Wire.begin(); SPI.begin(); Serial.begin(9600); }\nvoid loop() { digitalWrite(LED_BUILTIN, HIGH); delay(500); digitalWrite(LED_BUILTIN, LOW); delay(500); }\n';
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const folder=path.join(config.paths.evidenceRoot,'avr-performance-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',performanceQualified:false,filesystemCachePurged:false,machine:{hostname:os.hostname(),cpu:os.cpus()[0]?.model,logicalProcessors:os.availableParallelism(),memoryBytes:os.totalmem()},boundaries:{ck:'real desktop compile_sketch IPC including independent host verification',official:'direct unmodified Arduino CLI process; excludes desktop IPC; not an equal-boundary speedup ratio'},ab,rounds,targets:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
const ordered=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));
let client;save();
try {
 client=await connectDesktop();
 for(const [i,fqbn]of targets.entries()){
  const row={fqbn,runs:[]};report.targets.push(row);
  async function build(label,code,{clean=false,reference=false,propertyReference=reference,executionReference=reference}={}){
   fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:clean,avrPropertiesReference:propertyReference,directExecutionReference:executionReference}));
   const result=await client.build(code,fqbn,{projectId:'avr-performance-'+i,workspaceFingerprint:digest(code)});
   const entry={label,...result};row.runs.push(entry);save();assert(result.success,result.error);
   const out=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(out,'native-graph-host-receipt.json')));entry.host=host;
   validateArtifacts(host.worker.artifacts,fqbn);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(out,a.name))),a.sha256);
   save();console.log(JSON.stringify({fqbn,label,wallMs:result.wallMs,counts:host.worker.counts,phases:host.worker.phases}));return host.worker;
  }
  await build('initial-unwarmed',A,{clean:true});
  for(let n=0;n<rounds;n++){
   const B=A.replaceAll('500',String(301+n));
   let expected,structures;
   const modes=process.env.CK_AVR_MODES?JSON.parse(process.env.CK_AVR_MODES):ab?['reference','candidate']:['baseline'];
   if(n%2)modes.reverse();let compared;
   for(const mode of modes){
    const flags={propertyReference:mode==='reference'||mode==='direct-only',executionReference:mode==='reference'||mode==='properties-only'};
    const cold=await build(mode+'-cold-'+n,A,{clean:true,...flags});assert.equal(cold.counts.CacheRestored,0);assert.equal(cold.counts.ObjectRetained,0);
    expected=await build(mode+'-edit-'+n,B,flags);
    if(compared){assert.deepEqual(expected.artifacts,compared.artifacts);assert.equal(expected.generatedSha256,compared.generatedSha256);assert.deepEqual(ordered(expected.compileDatabase),ordered(compared.compileDatabase));}compared=expected;
    assert.equal(expected.counts.CompileGCC,1);assert.equal(expected.counts.DiscoveryGCC,0);
    structures=new Map(expected.objects.map(o=>[o.file,avrObjectStructure(fs.readFileSync(o.file))]));
    const same=await build(mode+'-same-'+n,B,flags);assert.equal(same.counts.CompileGCC,0);assert.equal(same.counts.Linker,0);
    assert.deepEqual(same.artifacts,expected.artifacts);
   }
   const buildDir=path.dirname(expected.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');
   const c={...config.paths,workspace,sketchDir,fqbn:expected.fqbn,jobs:config.limits.jobs};
   for(const [label,code,clean]of [['cold',A,true],['edit',B,false],['same',B,false]]){
    fs.writeFileSync(path.join(sketchDir,'sketch.ino'),code);
    const r=await asyncRun([...baseArgs(c),...(clean?['--clean']:[]),'--json',sketchDir],c.sysroot);
    fs.writeFileSync(path.join(folder,`${i}-${n}-official-${label}.json`),JSON.stringify(r));
    row.runs.push({label:`official-${label}-${n}`,wallMs:r.elapsedMs,boundary:'direct CLI process',success:r.code===0});save();assert.equal(r.code,0,r.stderr+r.stdout.slice(-2000));
    if(!clean){assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),expected.generatedSha256);assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(expected.compileDatabase));
     for(const o of expected.objects)assert.deepEqual(avrObjectStructure(fs.readFileSync(o.file)),structures.get(o.file),'Object sections '+o.file);
     for(const name of artifactsFor(fqbn))assert.equal(digest(fs.readFileSync(path.join(buildDir,name))),expected.artifacts.find(x=>x.name===name).sha256,'Official '+name);
    }
    console.log(JSON.stringify({fqbn,label:'official-'+label,round:n,wallMs:r.elapsedMs}));
   }
  }
  row.status='PASS';save();
 }
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);}
finally{client?.close();fs.writeFileSync(profileFile,original);save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(folder,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'avr-performance-result.json'));console.log('REPORT '+folder);}
