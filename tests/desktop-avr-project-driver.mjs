// CK_FABO_CHECKOUT: FaBoPlatform/FaBoPWM-PCA9685-Library at fe0946e.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectDesktop} from './desktop-client.mjs';

const fqbn='arduino:avr:nano:cpu=atmega328', driver='FaBoPWM_PCA9685', sha=b=>createHash('sha256').update(b).digest('hex');
const read=(dir,file)=>fs.readFileSync(path.join(dir,file));
const put=(dir,files)=>{for(const [name,bytes] of Object.entries(files)){const f=path.join(dir,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,bytes);}};
const names=['cold','body','driver','header','same','pin','pin-body'];
if(process.argv[2]==='--verify-official'){
 const [config,...runs]=process.argv.slice(3);assert(runs.length);
 const cfg=JSON.parse(fs.readFileSync(config)), tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ck-fabo-cli-'));
 try{
  for(const name of names){
   const source=path.join(runs[0],name,'sketch'),build=path.join(tmp,name);
   const members=['sketch.ino',`src/${driver}.cpp`,`src/${driver}.h`];
   for(const run of runs.slice(1))for(const f of members)assert.deepEqual(read(path.join(run,name,'sketch'),f),read(source,f));
   execFileSync(cfg.paths.cli,['compile','--config-file',cfg.paths.cliConfig,'--fqbn',fqbn,'--jobs',String(cfg.limits.jobs),'--clean','--build-path',build,source],
    {windowsHide:true,env:{...process.env,TZ:'UTC',SOURCE_DATE_EPOCH:String(cfg.sourceDateEpoch)}});
   const official=read(build,'sketch.ino.hex');for(const run of runs)assert.deepEqual(read(path.join(run,name),'desktop.hex'),official);
   console.log(name,sha(official),`matched ${runs.length} desktop builds`);
  }
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}else{
 const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG)), stock=process.env.CK_PREAMBLE_ENGINE==='stock';
 const upstream=process.env.CK_FABO_CHECKOUT, evidence=fs.mkdtempSync(path.join(cfg.paths.evidenceRoot,'fabo-'));
 const proj=path.join(evidence,'ServoDemo'),entry=path.join(proj,'ServoDemo.ck');
 const cpp=`src/${driver}.cpp`, h=`src/${driver}.h`, members={[cpp]:read(upstream,cpp),[h]:read(upstream,h)};
 let code=read(upstream,'example/servo/servo.ino').toString().replace(`#include "${driver}.h"`,`#include "${h}"`);
 const sample=JSON.parse(fs.readFileSync(new URL('../desktop/examples/多文件闪灯/多文件闪灯.ck',import.meta.url)));
 const client=await connectDesktop(), rows=[];
 try{
  for(const name of names){
   if(name==='body')code=code.replaceAll('delay(15)','delay(21)');
   if(name==='driver')members[cpp]=Buffer.from(members[cpp].toString().replaceAll('delay(100)','delay(107)'));
   if(name==='header')members[h]=Buffer.from(members[h].toString().replace(/(PCA9685_SLAVE_ADDRESS\s+)0x40/,(_,prefix)=>prefix+'0x41'));
   if(name==='pin')code='#define PWM_CHANNEL 2\n'+code.replaceAll('set_channel_value(0,','set_channel_value(PWM_CHANNEL,');
   if(name==='pin-body')code=code.replaceAll('delay(21)','delay(29)');
   const xml=JSON.parse(sample.xml);xml.ckSource.code=code;
   put(proj,{'ServoDemo.ck':JSON.stringify({...sample,name:'ServoDemo',code,xml:JSON.stringify(xml)}),...members});
   const dir=path.join(evidence,name);put(path.join(dir,'sketch'),{'sketch.ino':code,...members});
   const args={code,fqbn,projectPath:entry,projectId:entry,workspaceFingerprint:sha(code),runId:randomUUID(),qualificationToken:process.env.CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN};
   const at=performance.now(), out=JSON.parse(await client.evaluate(`window.__TAURI_INTERNALS__.invoke('observe_upload_preparation',${JSON.stringify(args)})`)), ipcMs=Math.round(performance.now()-at);
   assert(out.artifactManifestValidated&&out.toolchainIdentityRevalidated&&!out.uploadPerformed);
   const r=JSON.parse(read(out.path,'native-graph-receipt.json')), hex=read(out.path,'sketch.ino.hex');
   assert.equal(r.fqbn,fqbn);assert(r.success);assert.equal(sha(hex),r.artifacts.find(a=>a.name==='sketch.ino.hex').sha256);
   assert.deepEqual(Object.fromEntries(r.projectFiles.map(f=>[f.name,f.sha256])),Object.fromEntries(Object.entries(members).map(([n,b])=>[n,sha(b)])));
   assert(r.selectedLibraries.some(l=>l.name==='Wire'));
   fs.writeFileSync(path.join(dir,'desktop.hex'),hex);
   const row={name,ipcMs,preparationMs:out.preparationMs,official:r.officialFrontendInvoked,reason:r.officialReason,graph:r.graphReuse,frontend:r.frontend,
    counts:r.counts,phases:r.phases,compiled:r.taskDecisions.filter(d=>d.task==='compile'&&!['Restore','Reuse'].includes(d.decision)).map(d=>path.basename(d.output??'')),hex:sha(hex)};
   rows.push(row);fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({variant:stock?'stock':'candidate',rows},null,2));
   console.log(name,row.preparationMs,row.official,row.graph.reason,r.counts.CompileGCC,row.hex.slice(0,12));
   if(name==='same'){assert(r.noOpFastPath?.hit);assert.equal(r.counts.CompileGCC,0);assert.equal(row.hex,rows.at(-2).hex);}
   else if(rows.length>1)assert.notEqual(row.hex,rows.at(-2).hex);
   if(['body','driver','header'].includes(name)){
    const expected=name==='body'?['sketch.ino.cpp.o']:name==='driver'?[driver+'.cpp.o']:[driver+'.cpp.o','sketch.ino.cpp.o'];
    assert.deepEqual([...row.compiled].sort(),expected);assert.equal(r.counts.CompileGCC,expected.length);assert.equal(row.official,false);
   }
   if(name==='body'||name==='pin-body'&&!stock)assert(row.graph.hit);
   if(!stock&&['body','pin-body'].includes(name)){assert(r.frontend.replayed,r.frontend.reason);assert.equal(r.counts.CTags,0);}
   if(['pin','pin-body'].includes(name))assert.equal(row.official,stock);
  }
  console.log('PASS '+evidence);
 }finally{client.close();}
}
