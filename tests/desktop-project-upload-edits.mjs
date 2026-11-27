// CK_EDIT_FIXTURE is a private fixture folder containing main.ino, project
// members and edits.json. Changes are cumulative and applied to copies only.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash,randomUUID} from 'node:crypto';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {connectDesktop} from './desktop-client.mjs';
import {validMember} from '../src/sketch-files.mjs';

const sha=b=>createHash('sha256').update(b).digest('hex');
const load=(dir,name)=>fs.readFileSync(path.join(dir,name));
const write=(dir,name,bytes)=>{const out=path.join(dir,name);fs.mkdirSync(path.dirname(out),{recursive:true});fs.writeFileSync(out,bytes);};
const fqbn=process.env.CK_EDIT_FQBN??'arduino:avr:nano:cpu=atmega328';
const ext=fqbn.startsWith('esp32:esp32:')?'bin':'hex',artifact=`sketch.ino.${ext}`,saved=`desktop.${ext}`;
const fixture=process.env.CK_EDIT_FIXTURE??fileURLToPath(new URL('./fixtures/upload-edits/analog',import.meta.url)), name=path.basename(fixture);
const members=fs.readdirSync(fixture,{recursive:true}).map(f=>f.replaceAll('\\','/')).filter(validMember).sort();
const cases=[{name:'cold'},...JSON.parse(load(fixture,'edits.json'))];
if(process.argv[2]==='--verify-official'){
 assert.equal(ext,'hex','Independent byte-for-byte CLI comparison is supported for AVR HEX only; ESP32 BIN embeds its build-specific ELF digest.');
 const [config,...runs]=process.argv.slice(3),cfg=JSON.parse(fs.readFileSync(config));
 assert(runs.length);const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ck-field-cli-'));
 try{
  for(const step of cases){
   const input=path.join(runs[0],step.name,'sketch'),build=path.join(tmp,step.name);
   for(const run of runs.slice(1))for(const f of ['sketch.ino',...members])assert.deepEqual(load(path.join(run,step.name,'sketch'),f),load(input,f));
   execFileSync(cfg.paths.cli,['compile','--config-file',cfg.paths.cliConfig,'--fqbn',fqbn,'--jobs',String(cfg.limits.jobs),'--clean','--build-path',build,input],
    {windowsHide:true,stdio:'pipe',env:{...process.env,TZ:'UTC',SOURCE_DATE_EPOCH:String(cfg.sourceDateEpoch)}});
   const firmware=load(build,artifact);for(const run of runs)assert.equal(sha(load(path.join(run,step.name),saved)),sha(firmware));
   console.log(step.name,sha(firmware),`matched ${runs.length} desktop builds`);
  }
 }finally{fs.rmSync(tmp,{recursive:true,force:true});}
}else{
 const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG)),evidence=fs.mkdtempSync(path.join(cfg.paths.evidenceRoot,'field-'));
 const project=path.join(evidence,name),entry=path.join(project,name+'.ck');
 const bytes=Object.fromEntries(members.map(f=>[f,load(fixture,f)]));bytes['sketch.ino']=load(fixture,'main.ino');
 const client=await connectDesktop(),rows=[];
 try{
  for(const step of cases){
   if(step.from){
    const f=step.file??'sketch.ino',was=bytes[f],find=Buffer.from(step.from),at=was.indexOf(find);
    assert(at>=0&&step.from!==step.to,step.name);bytes[f]=Buffer.concat([was.subarray(0,at),Buffer.from(step.to),was.subarray(at+find.length)]);
   }
   const code=bytes['sketch.ino'].toString(),dir=path.join(evidence,step.name);
   for(const [f,b] of Object.entries(bytes)){write(path.join(dir,'sketch'),f,b);if(f!=='sketch.ino'&&(step.name==='cold'||step.file===f))write(project,f,b);}
   const xml=JSON.stringify({blocks:{languageVersion:0,blocks:[]},ckSource:{version:1,mode:'source',generatedBase:'',code}});
   write(project,name+'.ck',JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name,board:fqbn.split(':').slice(0,3).join(':'),xml,code}));
   const args={code,fqbn,projectPath:entry,projectId:entry,runId:randomUUID(),workspaceFingerprint:sha(code),qualificationToken:process.env.CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN};
   const at=performance.now(),out=JSON.parse(await client.evaluate(`window.__TAURI_INTERNALS__.invoke('observe_upload_preparation',${JSON.stringify(args)})`)),ipcMs=Math.round(performance.now()-at);
   assert(out.artifactManifestValidated&&out.toolchainIdentityRevalidated&&!out.uploadPerformed);
   const r=JSON.parse(load(out.path,'native-graph-receipt.json')),firmware=load(out.path,artifact),digest=sha(firmware);
   assert(r.success);assert.equal(r.fqbn,fqbn);assert.equal(digest,r.artifacts.find(a=>a.name===artifact).sha256);
   assert.deepEqual(Object.fromEntries(r.projectFiles.map(f=>[f.name,f.sha256])),Object.fromEntries(members.map(f=>[f,sha(bytes[f])])));
   write(dir,saved,firmware);
   const compiled=r.taskDecisions.filter(d=>d.task==='compile'&&!['Restore','Reuse'].includes(d.decision)).map(d=>path.basename(d.output)).sort();
   const row={name:step.name,ipcMs,ms:out.preparationMs,official:r.officialFrontendInvoked,reason:r.officialReason,graph:r.graphReuse,frontend:r.frontend,phases:r.phases,
    counts:r.counts,compiled,libraries:r.selectedLibraries.map(l=>l.name),[ext]:digest};
   rows.push(row);write(evidence,'report.json',JSON.stringify({fqbn,members,rows},null,2));
   console.log(step.name,row.ms,row.official,row.reason??row.graph?.reason,r.counts.CompileGCC,digest.slice(0,10));
   if(step.name==='same'){assert(r.noOpFastPath?.hit);assert.equal(r.counts.CompileGCC,0);assert.equal(digest,rows.at(-2)[ext]);}
   if(step.from)assert.equal(digest===rows.at(-2)[ext],step.unchangedFirmware===true);
   if(step.expectMarker)assert(firmware.includes(Buffer.from(step.expectMarker)));
   if(step.absentMarker)assert(!firmware.includes(Buffer.from(step.absentMarker)));
   if(process.env.CK_EDIT_EXPECT_REUSE==='1'&&step.reuse){
    assert(r.graphReuse?.hit);assert.equal(r.officialFrontendInvoked,false);
    assert.equal(r.counts.DiscoveryGCC,0);assert.equal(r.counts.CompileGCC,step.compiled.length);
    assert(r.counts.ObjectRetained>0);
    if(step.replay){assert(r.frontend.replayed);assert.equal(r.counts.PrototypeGCC,0);assert.equal(r.counts.CTags,0);}
   }
   if(step.compiled)assert.deepEqual(compiled,step.compiled.toSorted());
  }
  console.log('PASS',evidence);
 }finally{client.close();}
}
