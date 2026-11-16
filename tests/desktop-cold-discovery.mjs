import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';import {ENGINE_VERSION} from '../src/version.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,'')),profilePath=process.env.CK_V9_CONFIG,originalProfile=fs.readFileSync(profilePath),profile=JSON.parse(originalProfile);
const source=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),edited=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
const targets=JSON.parse(process.env.CK_V91_WIFI_FQBNS??'["esp32:esp32:esp32s3"]'),pairs=Number(process.env.CK_V91_COLD_PAIRS??3),official=process.env.CK_V91_WIFI_OFFICIAL!=='0';
const pipeline=process.env.CK_V91_PIPELINE_AB==='1',queueComparison=process.env.CK_V91_QUEUE_AB==='1';
assert(Number.isInteger(pairs)&&pairs>=1&&pairs<=5);process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const folder=path.join(config.paths.evidenceRoot,'cold-discovery-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',boundary:'installed desktop compile_sketch IPC; all clean rebuilds; no native process debugger',filesystemCachePurged:false,performanceQualified:false,comparison:queueComparison?'alpha6-versus-rolling-queue':pipeline?'alpha5-versus-sketch-pipeline':'serial-discovery-versus-combined',pairs,targets:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));let client;save();
const compare=(a,b)=>{assert.equal(a.generatedSha256,b.generatedSha256);assert.deepEqual(a.compileDatabase,b.compileDatabase);assert.deepEqual(a.selectedLibraries,b.selectedLibraries);assert.deepEqual(a.objects,b.objects);assert.deepEqual(a.artifacts,b.artifacts);};
try{
 client=await connectDesktop();for(const [i,fqbn]of targets.entries()){
  const row={fqbn,runs:[],checks:[]};report.targets.push(row);let baseline;
  async function build(label,code,{reference=false,clean=true,assetReference=queueComparison}={}){
   fs.writeFileSync(profilePath,JSON.stringify({...profile,discoveryCompileReference:pipeline||queueComparison?false:reference,coldPipelineReference:pipeline&&reference,discoveryBatchReference:queueComparison?reference:true,assetOpenReference:assetReference,coldReference:clean}));
   console.log('START '+fqbn+' '+label);const result=await client.build(code,fqbn,{projectId:'cold-discovery-'+i,workspaceFingerprint:digest(code)}),entry={label,...result};row.runs.push(entry);save();assert(result.success,result.error);
   const exported=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));entry.host=host;validateArtifacts(host.worker.artifacts);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256);save();
   console.log(JSON.stringify({fqbn,label,wallMs:result.wallMs,counts:host.worker.counts,phases:host.worker.phases}));return host.worker;
  }
  // Record the first-ever build separately. Subsequent clean pairs use the
  // same physical paths and cannot restore objects or prior session history.
  const initial=await build('initial',source);baseline=initial;
  for(let n=1;n<=pairs;n++){
   const modes=n%2?['reference','combined']:['combined','reference'];
   for(const mode of modes){const r=await build(`${mode}-${n}`,source,{reference:mode==='reference'});compare(baseline,r);assert.equal(r.counts.CompileGCC,71);assert.equal(r.counts.CacheRestored,0);assert.equal(r.counts.ObjectRetained,0);assert.equal(r.counts.ObjectProducedDuringDiscovery,mode==='reference'&&!pipeline&&!queueComparison?0:70);assert.equal(r.counts.SchedulerCompileGCC,mode==='reference'?(queueComparison?0:pipeline?1:71):0);}
   row.checks.push(`Pair ${n}: all 71 new objects, same CPP, compile database, selected libraries and all ten outputs`);save();
  }
  if(queueComparison){const defaultRun=await build('default-settings',source,{assetReference:false});compare(baseline,defaultRun);assert.equal(defaultRun.assetProof.openWorkers,16);}
  const b=await build('added-wait',edited,{clean:false});assert.equal(b.counts.CompileGCC,1);assert.equal(b.counts.PrototypeGCC,0);assert.equal(b.counts.DiscoveryGCC,0);
  const same=await build('same-source',edited,{clean:false});assert(same.noOpFastPath.hit);assert.equal(same.counts.CompileGCC,0);compare(b,same);
  if(queueComparison){
   row.assetSamples=[];
   for(let n=0;n<5;n++)for(const openEnabled of n%2?[true,false]:[false,true]){
    fs.writeFileSync(profilePath,JSON.stringify({...profile,discoveryCompileReference:false,coldPipelineReference:false,discoveryBatchReference:false,assetOpenReference:!openEnabled,coldReference:false}));
    const result=await client.build(edited,fqbn,{projectId:'cold-discovery-'+i,workspaceFingerprint:digest(edited)});assert(result.success,result.error);const exported=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));assert(host.worker.noOpFastPath.hit);compare(b,host.worker);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256);
    row.assetSamples.push({round:n,openEnabled,wallMs:result.wallMs,host});save();console.log(JSON.stringify({assetRound:n,openEnabled,wallMs:result.wallMs}));
   }
  }
  if(official){
   const buildDir=path.dirname(b.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');console.log('OFFICIAL CLEAN '+fqbn);
   const control=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn:b.fqbn,jobs:config.limits.jobs}),'--clean','--json',sketchDir],config.paths.sysroot);fs.writeFileSync(path.join(folder,`${i}-official.json`),JSON.stringify(control));assert.equal(control.code,0,control.stderr+control.stdout.slice(-2000));
   assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),b.generatedSha256);const ordered=x=>[...x].sort((a,c)=>a.file.localeCompare(c.file));assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(b.compileDatabase));for(const o of b.objects)assert.equal(digest(fs.readFileSync(o.file)),o.sha256,o.file);
   const platform=JSON.parse(control.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);for(const name of artifactNames)assert.equal(digest(fs.readFileSync(name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name))),b.artifacts.find(x=>x.name===name).sha256,name);
   row.checks.push('Official full clean: CPP, compile database, all objects and ten delivery artifacts byte-identical');
  }
  row.status='PASS';save();
 }report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{fs.writeFileSync(profilePath,originalProfile);client?.close();save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(folder,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'cold-discovery-result.json'));console.log('REPORT '+path.join(folder,'report.json'));}
