import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';import {digest,normalize,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
import {artifactsFor} from '../src/version.mjs';
import {avrObjectStructure} from './avr-object-proof.mjs';
const [configFile,...targets]=process.argv.slice(2),config=loadConfig(configFile),controller=new BuildController(config);
// Compare the actual CLI with the same deterministic clock environment as the
// product worker, including __DATE__/__TIME__ in chip-debug-report.cpp.
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const A=fs.readFileSync(new URL('user-wifi-A.ino',import.meta.url),'utf8'),B=fs.readFileSync(new URL('user-wifi-B.ino',import.meta.url),'utf8');
const root=path.join(config.paths.evidenceRoot,'configuration-matrix-'+Date.now());fs.mkdirSync(root,{recursive:true});
const report={boundary:'controller + real compiler; official full clean CLI comparisons',startedAt:new Date().toISOString(),status:'RUNNING',targets:[]};const save=()=>fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));save();
const ordered=rows=>[...rows].sort((a,b)=>a.file.localeCompare(b.file));
const proof=file=>({file,sha256:digest(fs.readFileSync(file))});
try{for(const [i,fqbn]of targets.entries()){
 const workspace=path.join(config.paths.workspaceRoot,'matrix-'+Date.now()+'-'+i),sketchDir=path.join(workspace,'source/sketch'),entry={fqbn,runs:[],checks:[]};report.targets.push(entry);save();
 const avr=fqbn.startsWith('arduino:avr:');
 const sourceA=avr?(process.env.CK_AVR_FIXTURE?fs.readFileSync(process.env.CK_AVR_FIXTURE,'utf8'):'#include <Wire.h>\n#include <SPI.h>\nvoid setup() { Wire.begin(); SPI.begin(); Serial.begin(9600); }\nvoid loop() { digitalWrite(LED_BUILTIN, millis() % 1000 < 500); }\n'):(process.env.CK_ESP_FIXTURE?fs.readFileSync(process.env.CK_ESP_FIXTURE,'utf8'):A);
 entry.sourceA=sourceA;
 const sourceB=avr||process.env.CK_ESP_FIXTURE?sourceA.replace('500','300'):B;
 assert.notEqual(sourceA,sourceB,'The supplied fixture must contain an editable 500 expression');
 const objectStructures=new Map();
 async function build(label,code){console.log('START '+fqbn+' '+label);const request={requestId:'matrix-'+i+'-'+label,sourceSha256:digest(normalize(code)),fqbn,sysroot:config.paths.sysroot,workspace,sketchDir,libraries:[]};const r=await controller.submit({protocolVersion:1,request,source:code});entry.runs.push({label,...r});save();assert(r.success,JSON.stringify(r.error));validateArtifacts(r.artifacts,fqbn);await controller.acknowledge(request.requestId,{sourceSha256:request.sourceSha256,success:true});console.log(JSON.stringify({fqbn,label,ms:r.wallMs,counts:r.counts,phases:r.phases}));return r;}
 const a=await build('A',sourceA);
 if(avr)for(const o of a.objects)objectStructures.set('A:'+o.file,avrObjectStructure(fs.readFileSync(o.file)));
 const b=await build('B',sourceB);
 if(avr)for(const o of b.objects)objectStructures.set('B:'+o.file,avrObjectStructure(fs.readFileSync(o.file)));
 const again=await build('A-restored',sourceA),same=await build('A-same',sourceA);
 assert.equal(b.counts.DiscoveryGCC,0);assert.equal(b.counts.CompileGCC,1);assert.deepEqual(a.artifacts,again.artifacts);assert.equal(again.counts.CompileGCC,0);assert.equal(same.counts.CompileGCC,0);assert.equal(same.counts.Linker,0);
 entry.checks.push('User A to B: one sketch compile and no library rediscovery','A history and identical-source artifacts match');save();
 for(const [label,code,expected]of [['A',sourceA,a],['B',sourceB,b]]){
  console.log('OFFICIAL CLEAN '+fqbn+' '+label);fs.writeFileSync(path.join(sketchDir,'sketch.ino'),normalize(code));
  const c={...config.paths,workspace,sketchDir,fqbn,jobs:config.limits.jobs};const run=await asyncRun([...baseArgs(c),'--clean','--json',sketchDir],config.paths.sysroot);fs.writeFileSync(path.join(root,`${i}-${label}-official.json`),JSON.stringify(run));assert.equal(run.code,0,run.stderr+run.stdout.slice(-2000));
  const build=path.join(workspace,'build');assert.equal(digest(fs.readFileSync(path.join(build,'sketch/sketch.ino.cpp'))),expected.generatedSha256,'CPP '+fqbn);
  const db=JSON.parse(fs.readFileSync(path.join(build,'compile_commands.json')));assert.deepEqual(ordered(db),ordered(expected.compileDatabase),'Compile database '+fqbn);
  for(const object of expected.objects){if(avr)assert.deepEqual(avrObjectStructure(fs.readFileSync(object.file)),objectStructures.get(label+':'+object.file),'AVR object structure '+object.file);else assert.equal(proof(object.file).sha256,object.sha256,'Object '+object.file);}
  // boot_app0.bin is delivered by CK from the platform; the other nine files
  // are all checked after the actual official CLI clean compiler run.
  for(const name of artifactsFor(fqbn)){const file=name==='boot_app0.bin'?path.join(JSON.parse(run.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).split('=').slice(1).join('='),'tools/partitions/boot_app0.bin'):path.join(build,name);assert.equal(proof(file).sha256,expected.artifacts.find(x=>x.name===name).sha256,'Artifact '+name+' '+fqbn);}
  entry.checks.push('Official full clean '+label+': CPP, compile database, '+(avr?'all object sections/symbols (GCC LTO identifier normalized), byte-identical ELF/HEX/EEP':'every object')+' and every target delivery file match');save();
 }
 // This completed case has an acknowledged export and no future writes.
 // Closing workers between boards bounds disk/memory without merging authority.
 entry.status='PASS';save();
 }report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}finally{await controller.close();save();console.log('REPORT '+root);}
