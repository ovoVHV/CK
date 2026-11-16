import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs} from '../src/discovery.mjs';import {avrObjectStructure} from './avr-object-proof.mjs';
import {ENGINE_VERSION,artifactsFor} from '../src/version.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const fqbn=process.env.CK_AVR_WORKFLOW_FQBN??'arduino:avr:uno',rounds=Number(process.env.CK_AVR_ROUNDS??5);
const library=process.env.CK_AVR_WORKFLOW_LIBRARY??path.join(config.paths.sysroot,'libraries/arduino_avr_uno/ck_hw_hc_sr04');
const example=path.join(library,'examples/Basic/Basic.ck'),hasSensor=fs.existsSync(example);
const A='void setup() {}\nvoid loop() { delay(500); }\n';
const B=hasSensor?JSON.parse(fs.readFileSync(example,'utf8')).code:'#include <Wire.h>\nvoid setup() { Wire.begin(); }\nvoid loop() { delay(500); }\n';
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',performanceQualified:false,boundary:'real desktop compile_sketch IPC including host verification; no debugger',fixture:hasSensor?'installed CK HC-SR04 generated example':'Wire built-in library',fqbn,rounds,filesystemCachePurged:false,runs:[],checks:[]};
const folder=path.join(config.paths.evidenceRoot,'avr-workflow-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
const ordered=a=>[...a].sort((a,b)=>a.file.localeCompare(b.file));
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';let client;save();
try{
 client=await connectDesktop();
 async function build(label,code,clean=false){
  fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:clean}));
  const result=await client.build(code,fqbn,{projectId:'avr-real-workflow',workspaceFingerprint:digest(code)}),entry={label,...result};report.runs.push(entry);save();assert(result.success,result.error);
  const output=JSON.parse(result.value).path,receipt=path.join(output,'native-graph-host-receipt.json');
  assert(fs.existsSync(receipt),'Compatibility fallback is not a native performance pass');
  const host=JSON.parse(fs.readFileSync(receipt));entry.host=host;assert.equal(host.backend,'ck-build-engine-v9');
  const worker=host.worker;validateArtifacts(worker.artifacts,fqbn);for(const a of worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(output,a.name))),a.sha256);
  const snapshot={worker,code,structures:new Map(worker.objects.map(o=>[o.file,avrObjectStructure(fs.readFileSync(o.file))]))};
  save();console.log(JSON.stringify({label,wallMs:result.wallMs,counts:worker.counts,phases:worker.phases,propertyExpansion:worker.propertyExpansion}));return snapshot;
 }
 const noWork=s=>{assert.equal(s.worker.noOpFastPath.hit,true);for(const k of ['CompileGCC','Linker','ImageGenerator','DiscoveryGCC','PrototypeGCC'])assert.equal(s.worker.counts[k],0,k);};
 for(let round=0;round<rounds;round++){
  const a=await build('cold-empty-'+round,A,true);assert(a.worker.counts.CompileGCC>1);
  noWork(await build('same-empty-'+round,A));
  const b=await build('add-library-'+round,B);assert(b.worker.counts.DiscoveryGCC>0);if(hasSensor)assert(b.worker.selectedLibraries.some(l=>path.basename(l.install_dir)==='ck_hw_hc_sr04'));
  noWork(await build('same-library-'+round,B));
  const C=hasSensor?B.replace('ckKitHcSr04(5, 6)',`ckKitHcSr04(5, ${7+round})`):B.replace('500',String(301+round));assert.notEqual(C,B);
  const edit=await build('edit-library-'+round,C);assert.equal(edit.worker.counts.DiscoveryGCC,0);assert.equal(edit.worker.counts.CompileGCC,1);
  noWork(await build('same-edit-'+round,C));
  for(const [label,snapshot]of [['empty',a],['library',b],['edit',edit]]){
   const w=snapshot.worker,buildDir=path.dirname(w.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');fs.writeFileSync(path.join(sketchDir,'sketch.ino'),snapshot.code);
   const c={...config.paths,workspace,sketchDir,fqbn:w.fqbn,jobs:config.limits.jobs,explicitLibraries:hasSensor&&label!=='empty'?[library]:[]};
   const official=await asyncRun([...baseArgs(c),'--clean','--json',sketchDir],c.sysroot);fs.writeFileSync(path.join(folder,`${round}-${label}-official.json`),JSON.stringify(official));assert.equal(official.code,0,official.stderr+official.stdout.slice(-2000));
   assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),w.generatedSha256);
   assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(w.compileDatabase));
   for(const o of w.objects)assert.deepEqual(avrObjectStructure(fs.readFileSync(o.file)),snapshot.structures.get(o.file));
   for(const name of artifactsFor(fqbn))assert.equal(digest(fs.readFileSync(path.join(buildDir,name))),w.artifacts.find(a=>a.name===name).sha256);
  }
 }
 report.checks=['Native receipt required on every request','New library rediscovered; subsequent body edits compile exactly one object','Identical source launches no compile, link, image, discovery or prototype GCC','Every exported file independently hashed','Actual official clean CPP, compile database, normalized LTO object structures and final delivery bytes match for each round'];
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{client?.close();fs.writeFileSync(profileFile,original);save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(folder,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'avr-workflow-result.json'));console.log('REPORT '+folder);}
