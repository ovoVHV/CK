import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';import {ENGINE_VERSION} from '../src/version.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,'')),profilePath=process.env.CK_V9_CONFIG,originalProfile=fs.readFileSync(profilePath),profile=JSON.parse(originalProfile);
const A=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),B=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
const targets=JSON.parse(process.env.CK_V91_WIFI_FQBNS??'["esp32:esp32:esp32s3"]'),pairs=Number(process.env.CK_V91_WAIT_PAIRS??1),official=process.env.CK_V91_WIFI_OFFICIAL==='1',coldCompare=process.env.CK_V91_COLD_AB==='1';
assert(Number.isInteger(pairs)&&pairs>=1&&pairs<=10);
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const folder=path.join(config.paths.evidenceRoot,'wifi-wait-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',boundary:'actual desktop IPC with production Blockly connect and wait-until-ready blocks',performanceQualified:false,pairs,officialControl:official,targets:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));let client;save();
const digests=r=>r.artifacts.map(a=>[a.name,a.sha256]);
function compare(x,y){assert.equal(x.generatedSha256,y.generatedSha256);assert.deepEqual(x.compileDatabase,y.compileDatabase);assert.deepEqual(x.objects.map(a=>[a.file,a.sha256]),y.objects.map(a=>[a.file,a.sha256]));assert.deepEqual(digests(x),digests(y));}
try{client=await connectDesktop();for(const [i,fqbn]of targets.entries()){
 const row={fqbn,runs:[],checks:[]};report.targets.push(row);save();
 async function build(label,source,{reference=false,history=false,cold=false,discoveryReference=false}={}){
  fs.writeFileSync(profilePath,JSON.stringify({...profile,frontendReference:reference,historyReference:!history,coldReference:cold,discoveryPreprocessReference:discoveryReference}));
  console.log('START '+fqbn+' '+label);const result=await client.build(source,fqbn,{projectId:'wifi-wait-'+i,workspaceFingerprint:digest(source)}),entry={label,...result};row.runs.push(entry);save();assert(result.success,result.error);
  const exported=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));entry.host=host;validateArtifacts(host.worker.artifacts);
  for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256);
  console.log(JSON.stringify({fqbn,label,wallMs:result.wallMs,counts:host.worker.counts,frontend:host.worker.frontend,batch:host.worker.batchTimings}));save();return host.worker;
 }
 const a=await build('cold-A',A,{history:true});assert(a.counts.CompileGCC>1);let lastB;
 if(coldCompare){
  const ref=await build('cold-reference-A',A,{history:true,cold:true,discoveryReference:true});
  const fast=await build('cold-reuse-A',A,{history:true,cold:true});
  assert.equal(ref.counts.PrototypeGCC,1);assert.equal(fast.counts.PrototypeGCC,0);assert.equal(fast.counts.CTags,1);
  assert.equal(fast.prototypePreprocessReused,true);assert.equal(ref.counts.CompileGCC,fast.counts.CompileGCC);assert(fast.counts.CompileGCC>1);compare(ref,fast);
  row.checks.push('Complete clean-build pair: same 71 compile tasks and all outputs, one redundant preprocessing invocation removed; filesystem cache not forcibly purged');save();
 }
 for(let n=1;n<=pairs;n++){
  // Alternating order prevents consistently giving the second mode hotter
  // filesystem caches. Both paths perform one compile, one link and images.
  const modes=n%2?['reference','replay']:['replay','reference'];const observed={};
  for(const mode of modes){
   await build(`prepare-A-${n}-${mode}`,A,{history:true});
   const r=await build(`${mode}-B-${n}`,B,{reference:mode==='reference'});observed[mode]=r;lastB=r;
   assert.equal(r.counts.DiscoveryGCC,0);assert.equal(r.counts.CompileGCC,1);assert.equal(r.counts.Linker,1);assert.equal(r.counts.ImageGenerator,2);assert.equal(r.counts.CacheRestored,0);
   assert.equal(r.counts.PrototypeGCC,mode==='reference'?1:0);assert.equal(r.counts.CTags,mode==='reference'?1:0);
  }
  compare(observed.reference,observed.replay);row.checks.push(`Pair ${n}: identical CPP, compile database, 71 object contents and ten artifacts with equal native task workload`);save();
 }
 const same=await build('same-B',B);assert.equal(same.counts.CompileGCC,0);assert.equal(same.noOpFastPath.hit,true);compare(lastB,same);
 if(official){
  const buildDir=path.dirname(lastB.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');
  console.log('OFFICIAL CLEAN WAIT '+fqbn);const control=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn:lastB.fqbn,jobs:config.limits.jobs}),'--clean','--json',sketchDir],config.paths.sysroot);
  fs.writeFileSync(path.join(folder,`${i}-official.json`),JSON.stringify(control));assert.equal(control.code,0,control.stderr+control.stdout.slice(-2000));
  assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),lastB.generatedSha256);
  const ordered=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(lastB.compileDatabase));
  for(const o of lastB.objects)assert.equal(digest(fs.readFileSync(o.file)),o.sha256,o.file);
  const platform=JSON.parse(control.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
  for(const name of artifactNames){const file=name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name);assert.equal(digest(fs.readFileSync(file)),lastB.artifacts.find(x=>x.name===name).sha256,name);}
  row.checks.push('Added wait block: full official clean CPP, compile database, all objects and all ten artifacts byte-identical');
 }
 row.status='PASS';save();
 }report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{fs.writeFileSync(profilePath,originalProfile);client?.close();save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(folder,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'wifi-wait-result.json'));console.log('REPORT '+path.join(folder,'report.json'));}
