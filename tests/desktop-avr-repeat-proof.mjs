import fs from 'node:fs';
import path from 'node:path';
import crypto from 'node:crypto';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';

const sha=b=>crypto.createHash('sha256').update(b).digest('hex');
const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const file=process.env.CK_V9_CONFIG,raw=fs.readFileSync(file),profile=JSON.parse(raw);
const guardsOnly=process.env.CK_AVR_REPEAT_GUARDS_ONLY==='1';
const out=path.join(cfg.paths.evidenceRoot,guardsOnly?'avr-repeat-guards.json':'avr-repeat-desktop.json');
const report={boundary:'compile_sketch IPC to independently verified export',runs:[],checks:[]};
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
const c=await connectDesktop();
const A='#include <Wire.h>\n#include <SPI.h>\nvoid setup(){Wire.begin(); SPI.begin(); pinMode(LED_BUILTIN, OUTPUT);}\nvoid loop(){digitalWrite(LED_BUILTIN,HIGH);delay(351);}\n';
const B=A.replace('HIGH','LOW');
const set=which=>fs.writeFileSync(file,JSON.stringify({...profile,enabled:which!=='compat',bridgeReference:which==='reference',validationReference:which==='reference'}));
const ids=new Map();
async function build(board,which,scenario,source,project=null){
 set(which);
 const id=project??(board+':'+(which==='compat'?'compat':'v9'));
 if(!ids.has(id))ids.set(id,crypto.randomUUID());
 const call=await c.build(source,board,{projectId:ids.get(id),workspaceFingerprint:sha(source)});
 const row={board,which,scenario,ms:call.wallMs,success:call.success};report.runs.push(row);save();assert.ok(call.success,call.error);
 const res=JSON.parse(call.value);let worker;
 if(which!=='compat'){
  const host=JSON.parse(fs.readFileSync(path.join(res.path,'native-graph-host-receipt.json')));
  worker=host.worker;
  row.transport=host.adapterPhases.transport;row.bundle=worker.noOpFastPath?.validationTransport;
  row.hit=!!worker.noOpFastPath?.hit;row.counts=worker.counts;row.phases=worker.phases;row.adapter=host.adapterPhases;
  assert.equal(row.transport,which==='reference'?'node-bridge':'host-loopback');
  assert.equal(worker.assetProof.sha256,worker.postAssetProof.sha256);
  row.identity=[worker.assetProof.sha256,worker.assetProof.namespaceSha256,worker.assetProof.files,worker.assetProof.bytes];
  for(const a of worker.artifacts)assert.equal(sha(fs.readFileSync(path.join(res.path,a.name))),a.sha256);
  assert.match(res.log,/\[V9\] 实际任务/);
  if(scenario==='repeat'){
   assert.ok(row.hit);for(const k of ['DiscoveryGCC','PrototypeGCC','CompileGCC','Linker','ImageGenerator'])assert.equal(row.counts[k],0);
   assert.equal(row.bundle,which==='reference'?undefined:'single-process-three-full-scans');
  }
 }else assert.ok(!res.log.includes('Build backend: ck-build-engine-v9'));
 for(const ext of ['hex','eep']){
  const files=res.artifacts.filter(f=>f.endsWith('.ino.'+ext));assert.equal(files.length,1);row[ext]=sha(fs.readFileSync(files[0]));
 }
 save();return {row,worker};
}
try{
 const boards=['arduino:avr:diecimila:cpu=atmega328','arduino:avr:uno','arduino:avr:nano:cpu=atmega328old','arduino:avr:mega:cpu=atmega2560'];
 for(const [i,board] of (guardsOnly?[]:boards).entries()){
  let first,edit,identity,last;
  for(const which of i%2?['compat','candidate']:['candidate','compat']){
   const a=await build(board,which,'first',A);const b=await build(board,which,'edit',B);
   if(which==='candidate'){identity=b.row.identity;assert.equal(b.row.counts.CompileGCC,1);}
   assert.notEqual(a.row.hex,b.row.hex);
   if(first){assert.deepEqual([a.row.hex,a.row.eep],first);assert.deepEqual([b.row.hex,b.row.eep],edit);}
   first=[a.row.hex,a.row.eep];edit=[b.row.hex,b.row.eep];
  }
  const modes=['reference','candidate','compat'];
  for(let r=0;r<6;r++)for(let j=0;j<3;j++){
   const which=modes[(i+r+(r%2?2-j:j))%3];
   last=await build(board,which,'repeat',B);assert.deepEqual([last.row.hex,last.row.eep],edit);
   if(which!=='compat')assert.deepEqual(last.row.identity,identity);
  }
  if(i===1){
   const proof=await build(board,'candidate','before-corrupt',B);
   const a=proof.worker.artifacts.find(x=>x.name==='sketch.ino.hex');
   const bytes=fs.readFileSync(a.file);bytes[1]^=1;fs.writeFileSync(a.file,bytes);
   const restore=await build(board,'candidate','corrupt-hex',B);
   assert.equal(restore.row.hit,false);assert.equal(restore.row.hex,edit[0]);
   report.checks.push('Corrupt managed HEX rejected and correct bytes independently exported');save();
  }
  console.log(board+' complete');save();
 }
 const board='arduino:avr:uno',location=path.join(cfg.paths.evidenceRoot,'多文件闪灯'),entry=path.join(location,'多文件闪灯.ck');
 const fixture=new URL('../desktop/examples/多文件闪灯/',import.meta.url);
 fs.mkdirSync(path.join(location,'src'),{recursive:true});
 for(const name of ['多文件闪灯.ck','Blink.h','Blink.cpp','src/Timing.h'])fs.copyFileSync(new URL(name,fixture),path.join(location,name));
 const invoke=(cmd,args)=>c.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(cmd)},${JSON.stringify(args)})`);
 set('candidate');await invoke('prepare_project_open_v2',{path:entry});await invoke('load_project',{path:entry});
 assert.deepEqual(await invoke('list_project_sources',{path:entry}),['Blink.cpp','Blink.h','src/Timing.h']);
 async function folder(board){
  const res=JSON.parse(await invoke('compile_sketch',{code:JSON.parse(fs.readFileSync(entry)).code,fqbn:board,projectPath:entry,projectId:entry,runId:crypto.randomUUID(),silent:false}));
  const h=JSON.parse(fs.readFileSync(path.join(res.path,'native-graph-host-receipt.json'))),hex=sha(fs.readFileSync(path.join(res.path,'sketch.ino.hex')));
  assert.equal(h.worker.artifacts.find(a=>a.name==='sketch.ino.hex').sha256,hex);
  return {hex,hit:h.worker.noOpFastPath?.hit===true,compile:h.worker.counts.CompileGCC,id:h.worker.sessionId};
 }
 const seed=await folder(board),same=await folder(board);assert.ok(same.hit);assert.equal(seed.hex,same.hex);
 const h=path.join(location,'src/Timing.h'),old=fs.statSync(h);fs.writeFileSync(h,fs.readFileSync(h,'utf8').replace('500','700'));fs.utimesSync(h,old.atime,old.mtime);
 const changed=await folder(board);assert.ok(!changed.hit&&changed.compile>0);assert.notEqual(changed.hex,seed.hex);
 const other=await folder('arduino:avr:nano:cpu=atmega168');assert.ok(!other.hit&&other.compile>0);assert.notEqual(other.id,changed.id);
 report.checks.push('Chinese folder: same-mtime header edit rebuilt firmware; different FQBN used a distinct session');
 const cancelId=crypto.randomUUID(),project=crypto.randomUUID(),life=path.join(cfg.paths.evidenceRoot,'lifecycle.jsonl');
 const expected=report.runs.find(r=>r.board===board&&r.scenario==='first')?.hex??(await build(board,'compat','cancel-reference',A)).row.hex;
 set('candidate');
 const initial=fs.statSync(life).size;
 const pending=c.build(A,board,{runId:cancelId,projectId:project,workspaceFingerprint:sha(A)});
 let queued=false;
 for(let n=0;n<250;n++){if(fs.readFileSync(life).subarray(initial).toString().includes('"type":"queued"')){queued=true;break;}await new Promise(r=>setTimeout(r,20));}
 assert.ok(queued);await invoke('cancel_foreground_build',{runId:cancelId});const cancelled=await pending;assert.equal(cancelled.success,false);
 const recovered=await c.build(A,board,{projectId:project,workspaceFingerprint:sha(A)});assert.ok(recovered.success,recovered.error);
 assert.equal(sha(fs.readFileSync(path.join(JSON.parse(recovered.value).path,'sketch.ino.hex'))),expected);
 report.checks.push('Active desktop build cancelled and the same project compiled with the expected HEX');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);throw error;}
finally{save();fs.writeFileSync(file,raw);c.close();}
