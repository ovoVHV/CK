import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';
import {digest} from '../src/protocol.mjs';
import {asyncRun,baseArgs} from '../src/discovery.mjs';
import {artifactsFor} from '../src/version.mjs';

const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const config=read(process.env.CK_V9_ENGINE_CONFIG),profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const out=path.join(config.paths.evidenceRoot,'servo-performance-'+Date.now());fs.mkdirSync(out,{recursive:true});
const source=fs.readFileSync(process.env.CK_SERVO_SOURCE??'local/library-author-kit/generated-all-blocks.ino','utf8');
const targets=JSON.parse(process.env.CK_SERVO_TARGETS??'["arduino:avr:uno","arduino:avr:nano:cpu=atmega328","arduino:avr:mega:cpu=atmega2560"]');
const rounds=Number(process.env.CK_SERVO_ROUNDS??1),official=process.env.CK_SERVO_OFFICIAL==='1';
const report={status:'RUNNING',rounds,sourceSha256:digest(source),desktopSha256:read(path.join(config.paths.evidenceRoot,'desktop-launch.json')).sha256,boundaries:{ck:'desktop compile_sketch IPC to return; includes host validation; excludes UI render',official:'Arduino CLI process only; not equal desktop boundary'},filesystemCachePurged:false,runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';let client;
try {
 client=await connectDesktop();
 if(process.env.CK_SERVO_PACKAGE)for(const fqbn of targets){
  const board=fqbn.split(':').slice(0,3).join(':');
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('import_library',${JSON.stringify({path:process.env.CK_SERVO_PACKAGE,board,boardPackageId:board})})`);
 }
 for(const [i,fqbn]of targets.entries())for(let n=0;n<rounds;n++){
  const changed=source.replace('(1500)',`(${1501+n})`);assert.notEqual(source,changed);
  const expected=new Map();
  for(const [label,code]of [['cold',source],['same',source],['edit',changed],['same-after-edit',changed]]){
   fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:label==='cold'}));
   const r=await client.build(code,fqbn,{projectId:'servo-performance-'+i,workspaceFingerprint:digest(code)});
   assert(r.success,r.error);const value=JSON.parse(r.value),receipt=path.join(value.path,'native-graph-host-receipt.json'),host=read(receipt),worker=host.worker;
   if(process.env.CK_SERVO_EXPECT_NATIVE==='1'){
    assert.equal(worker.officialFrontendInvoked,false,'unexpected official frontend');
    if(label==='cold'){assert.equal(worker.counts.ObjectRetained,0);assert.equal(worker.counts.ObjectRestored,0);}
    if(label.startsWith('same')){assert.equal(worker.noOpFastPath?.hit,true,'identical source must use validated no-op');assert.equal(worker.counts.CompileGCC,0);assert.equal(worker.counts.PrototypeGCC,0);assert.equal(worker.counts.Linker,0);assert.equal(worker.counts.ImageGenerator,0);}
    if(label==='edit'){assert.equal(worker.counts.CompileGCC,1);assert.equal(worker.counts.DiscoveryGCC,0);assert.equal(worker.counts.ObjectRetained,worker.objects.length-1);}
   }
   const exported=value.artifacts.map(file=>({file,sha256:digest(fs.readFileSync(file))}));
   for(const a of worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(value.path,a.name))),a.sha256);
   const entry={fqbn,round:n,label,wallMs:r.wallMs,receipt,counts:worker.counts,phases:worker.phases,graphReuse:worker.graphReuse,officialReason:worker.officialReason,frontend:worker.frontend,noOp:worker.noOpFastPath,selectedLibraries:worker.selectedLibraries,diagnostics:value.diagnostics,exported};
   report.runs.push(entry);expected.set(label,{worker,code});save();console.log(JSON.stringify({fqbn,round:n,label,wallMs:r.wallMs,counts:worker.counts,phases:worker.phases,reason:worker.officialReason}));
  }
  if(official){
   const worker=expected.get('edit').worker,workspace=path.dirname(path.dirname(worker.artifacts[0].file));
   const c={...config.paths,workspace,sketchDir:path.join(workspace,'source/sketch'),fqbn,jobs:config.limits.jobs,explicitLibraries:worker.selectedLibraries.map(x=>x.install_dir)};
   for(const [label,{code,worker:reference}]of expected){
    fs.writeFileSync(path.join(c.sketchDir,'sketch.ino'),code);
    const r=await asyncRun([...baseArgs(c),...(label==='cold'?['--clean']:[]),'--json',c.sketchDir],c.sysroot);
    fs.writeFileSync(path.join(out,`${i}-${n}-official-${label}.json`),JSON.stringify(r));assert.equal(r.code,0,r.stderr+r.stdout.slice(-3000));
    const hashes=artifactsFor(fqbn).map(name=>({name,sha256:digest(fs.readFileSync(path.join(workspace,'build',name)))}));
    for(const a of hashes)assert.equal(a.sha256,reference.artifacts.find(x=>x.name===a.name).sha256,'official output '+a.name);
    const entry={fqbn,round:n,label:'official-'+label,wallMs:r.elapsedMs,artifactHashes:hashes,match:true};report.runs.push(entry);save();console.log(JSON.stringify(entry));
   }
  }
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}
finally {client?.close();fs.writeFileSync(profileFile,original);save();console.log('REPORT '+out);}
