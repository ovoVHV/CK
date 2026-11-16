import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';import {ENGINE_VERSION} from '../src/version.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const A=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),B=A.replace('12345678','87654321');
const targets=JSON.parse(process.env.CK_V91_WIFI_FQBNS??'["esp32:esp32:esp32s3"]');
const official=process.env.CK_V91_WIFI_OFFICIAL==='1';
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const folder=path.join(config.paths.evidenceRoot,'blockly-wifi-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,status:'RUNNING',boundary:'real desktop compile_sketch IPC with unstripped production Blockly generator output; no process debugger',performanceQualified:false,officialControl:official,targets:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));let client;save();
try{client=await connectDesktop();for(const [i,fqbn]of targets.entries()){
 const row={fqbn,runs:[],checks:[]};report.targets.push(row);save();
 async function build(label,source){
  console.log('START '+fqbn+' '+label);
  const result=await client.build(source,fqbn,{projectId:'blockly-wifi-'+i,workspaceFingerprint:digest(source)});
  const entry={label,...result};row.runs.push(entry);save();assert(result.success,result.error);
  const exported=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json')));entry.host=host;
  validateArtifacts(host.worker.artifacts);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256);
  assert.equal(host.worker.officialFrontendInvoked,false,'Inline Blockly comments must not trigger official discovery');
  assert.equal(host.worker.sourceEligibility.eligible,true);save();console.log(JSON.stringify({fqbn,label,wallMs:result.wallMs,counts:host.worker.counts,phases:host.worker.phases}));return host.worker;
 }
 const digests=r=>r.artifacts.map(a=>[a.name,a.sha256]);
 function noWork(r){assert.equal(r.noOpFastPath.hit,true);for(const name of ['DiscoveryGCC','PrototypeGCC','CTags','CompileGCC','PchGCC','Linker','ImageGenerator','CacheRestored'])assert.equal(r.counts[name],0,name);}
 const a=await build('cold-A',A);
 assert(a.counts.CompileGCC>1);assert(a.counts.DiscoveryGCC>0);
 for(let n=1;n<=3;n++){const same=await build('same-A-'+n,A);noWork(same);assert.deepEqual(digests(a),digests(same));}
 const b=await build('new-B',B);assert.equal(b.counts.DiscoveryGCC,0);assert.equal(b.counts.PrototypeGCC,0);assert.equal(b.counts.CompileGCC,1);
 const back=await build('restore-A',A);assert.equal(back.counts.CompileGCC,0);assert.equal(back.counts.Linker,0);assert.deepEqual(digests(a),digests(back));
 const final=await build('same-A-final',A);noWork(final);
 row.checks.push('Actual marked Blockly source: native discovery; three consecutive No-Op requests and all ten host-exported artifacts match','Body edit: zero discovery/prototype, one compile','Return to A restores session history; following identical source runs no native tasks');save();
 if(official){
  const object=a.objects.find(x=>x.file.includes('sketch.ino.cpp.o'));fs.writeFileSync(object.file,'corrupt-object');
  const repair=await build('corrupt-object-repair',A);assert.equal(repair.noOpFastPath.hit,false);assert.equal(repair.counts.ObjectRestored,1);assert.equal(repair.counts.CompileGCC,0);assert.deepEqual(digests(a),digests(repair));row.checks.push('Object corruption rejects No-Op and restores authorized object bytes');save();
  const buildDir=path.dirname(a.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');
  console.log('OFFICIAL CLEAN '+fqbn);const control=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn:a.fqbn,jobs:config.limits.jobs}),'--clean','--json',sketchDir],config.paths.sysroot);
  fs.writeFileSync(path.join(folder,`${i}-official.json`),JSON.stringify(control));assert.equal(control.code,0,control.stderr+control.stdout.slice(-2000));
  assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),a.generatedSha256,'Official CPP');
  const ordered=x=>[...x].sort((x,y)=>x.file.localeCompare(y.file));assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(a.compileDatabase));
  for(const object of a.objects)assert.equal(digest(fs.readFileSync(object.file)),object.sha256,'Official object '+object.file);
  const platform=JSON.parse(control.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
  for(const name of artifactNames){const file=name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name);assert.equal(digest(fs.readFileSync(file)),a.artifacts.find(x=>x.name===name).sha256,'Official artifact '+name);}
  row.checks.push('Official CLI clean: same marked CPP, compile database, every object and all ten delivery files');
 }
 row.status='PASS';save();
 }report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally{client?.close();save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(folder,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'wifi-check-result.json'));console.log('REPORT '+path.join(folder,'report.json'));}
