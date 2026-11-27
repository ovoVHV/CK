// Run via Start-Preview.ps1 with CK_PREAMBLE_ENGINE=stock or candidate.
import assert from 'node:assert/strict';
import {execFileSync} from 'node:child_process';
import {createHash, randomUUID} from 'node:crypto';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {connectDesktop} from './desktop-client.mjs';

const fqbn='arduino:avr:nano:cpu=atmega328';
const hash=data=>createHash('sha256').update(data).digest('hex');
const initial='#define OUTPUT_PIN 13\nvoid setup() {\n  pinMode(OUTPUT_PIN, OUTPUT);\n}\nvoid loop() {\n  digitalWrite(OUTPUT_PIN, HIGH);\n  delay(137);\n}\n';
const edit=initial.replace('137','291'), pin=edit.replace('PIN 13','PIN 12');
const conditional=pin.replace('#define OUTPUT_PIN 12','#if defined(ARDUINO_ARCH_AVR)\n#define OUTPUT_PIN 11\n#else\n#define OUTPUT_PIN 10\n#endif');
const cases=[['cold',initial],['body',edit],['constant',pin],['same',pin],['conditional',conditional]];
// Check every desktop result outside its timed session, using a fresh CLI build
// per distinct source. Usage: --verify-official <engine-config.json> <run-dir> ...
if(process.argv[2]==='--verify-official'){
 const [config,...runs]=process.argv.slice(3);assert(config&&runs.length);
 const cfg=JSON.parse(fs.readFileSync(config,'utf8'));
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-nano-reference-'));
 const bySource=new Map();
 try{
  for(const [name,code] of cases){
   if(!bySource.has(code)){
    const sketch=path.join(dir,name,'sketch'),build=path.join(dir,name,'build');
    fs.mkdirSync(sketch,{recursive:true});fs.writeFileSync(path.join(sketch,'sketch.ino'),code);
    execFileSync(cfg.paths.cli,['compile','--config-file',cfg.paths.cliConfig,'--fqbn',fqbn,
     '--jobs',String(cfg.limits.jobs),'--clean','--build-path',build,sketch],
     {windowsHide:true,env:{...process.env,TZ:'UTC',SOURCE_DATE_EPOCH:String(cfg.sourceDateEpoch)}});
    bySource.set(code,fs.readFileSync(path.join(build,'sketch.ino.hex')));
   }
   const official=bySource.get(code);
   for(const run of runs){
    assert.equal(fs.readFileSync(path.join(run,name,'sketch/sketch.ino'),'utf8'),code);
    assert.deepEqual(fs.readFileSync(path.join(run,name,'desktop.hex')),official);
   }
   console.log(name,hash(official),`matched ${runs.length} desktop builds`);
  }
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
 process.exit(0);
}
const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const variant=process.env.CK_PREAMBLE_ENGINE;
assert(['stock','candidate'].includes(variant));
const evidence=fs.mkdtempSync(path.join(cfg.paths.evidenceRoot,'nano-preamble-'));
const client=await connectDesktop(), rows=[], projectId=randomUUID();
try {
 for(const [name,code] of cases){
  const dir=path.join(evidence,name,'sketch');
  fs.mkdirSync(dir,{recursive:true});
  fs.writeFileSync(path.join(dir,'sketch.ino'),code);
  const args={code,fqbn,projectId,runId:randomUUID(),workspaceFingerprint:hash(code),
   qualificationToken:process.env.CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN};
  const started=performance.now();
  const output=JSON.parse(await client.evaluate(`window.__TAURI_INTERNALS__.invoke('observe_upload_preparation',${JSON.stringify(args)})`));
  const ipcMs=Math.round(performance.now()-started);
  assert(output.artifactManifestValidated&&output.toolchainIdentityRevalidated&&!output.uploadPerformed);
  const r=JSON.parse(fs.readFileSync(path.join(output.path,'native-graph-receipt.json')));
  assert(r.success);assert.equal(r.fqbn,fqbn);
  const bytes=fs.readFileSync(path.join(output.path,'sketch.ino.hex')), hex=hash(bytes);
  assert.equal(hex,r.artifacts.find(a=>a.name==='sketch.ino.hex').sha256);
  fs.writeFileSync(path.join(evidence,name,'desktop.hex'),bytes);
  const row={name,ipcMs,preparationMs:output.preparationMs,official:r.officialFrontendInvoked,
   officialMs:r.phases.officialFrontendMs??0,graph:r.graphReuse,frontend:r.frontend,counts:r.counts,hex};
  rows.push(row);
  fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify({variant,fqbn,rows},null,2));
  console.log(name,output.preparationMs+'ms',row.graph.reason,hex.slice(0,12));
  if(name==='same'){
   assert(r.noOpFastPath?.hit);assert.equal(r.counts.CompileGCC,0);assert.equal(hex,rows.at(-2).hex);
  }else{
   assert.equal(row.official,variant==='stock'||name==='conditional');
   if(rows.length>1)assert.notEqual(hex,rows.at(-2).hex);
   if(variant==='candidate'&&name==='body'){
    assert(row.graph.hit&&r.frontend.replayed);assert.equal(r.counts.DiscoveryGCC,0);
    assert.equal(r.counts.PrototypeGCC,0);assert.equal(r.counts.CompileGCC,1);assert(r.counts.ObjectRetained>0);
   }
   if(variant==='candidate'&&name==='constant'){assert(!row.graph.hit);assert(r.counts.DiscoveryGCC>0);}
  }
 }
 console.log('PASS '+evidence);
}finally{client.close();}
