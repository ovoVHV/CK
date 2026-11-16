import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import os from 'node:os';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';import {ENGINE_VERSION,artifactsFor} from '../src/version.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
import {parseFqbn} from '../src/targets.mjs';
import {avrObjectStructure} from './avr-object-proof.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG)),A=fs.readFileSync(new URL('user-wifi-A.ino',import.meta.url),'utf8'),B=fs.readFileSync(new URL('user-wifi-B.ino',import.meta.url),'utf8');
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const targets=JSON.parse(process.env.CK_V91_MATRIX_FQBNS??JSON.stringify(['esp32:esp32:esp32','esp32:esp32:esp32s3','esp32:esp32:esp32c3','esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc']));
const folder=path.join(config.paths.evidenceRoot,'desktop-configurations-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={engineVersion:ENGINE_VERSION,boundary:'real desktop compile_sketch IPC; no process debugger',status:'RUNNING',performanceQualified:false,machine:{hostname:os.hostname(),cpus:os.cpus().map(c=>c.model),memory:os.totalmem()},targets:[]},save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));save();let client;
try{client=await connectDesktop();
 for(const [i,fqbn]of targets.entries()){
  const avr=fqbn.startsWith('arduino:avr:');
  const sourceA=avr?'#include <Wire.h>\n#include <SPI.h>\nvoid setup() { Wire.begin(); SPI.begin(); Serial.begin(9600); }\nvoid loop() { digitalWrite(LED_BUILTIN, HIGH); delay(500); digitalWrite(LED_BUILTIN, LOW); delay(500); }\n':A;
  const sourceB=avr?sourceA.replaceAll('500','300'):B;
  const row={fqbn,runs:[],checks:[]};report.targets.push(row);save();
  async function build(label,code){console.log('DESKTOP '+fqbn+' '+label);const r=await client.build(code,fqbn,{workspaceFingerprint:digest(code),projectId:'v91-configurations-'+i});row.runs.push({label,...r});save();assert(r.success,r.error);const output=JSON.parse(r.value).path,host=JSON.parse(fs.readFileSync(path.join(output,'native-graph-host-receipt.json')));assert.equal(host.backend,'ck-build-engine-v9');
   const requested=parseFqbn(fqbn),effective=parseFqbn(host.fqbn);assert(requested&&effective);assert.equal(effective.arch,requested.arch);assert.equal(effective.board,requested.board);assert.deepEqual([...effective.options].sort(),[...requested.options].sort(),'Host must preserve every selected menu value');row.effectiveFqbn=host.fqbn;
   validateArtifacts(host.worker.artifacts,host.fqbn);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(output,a.name))),a.sha256);row.runs.at(-1).host=host;save();console.log(JSON.stringify({fqbn:host.fqbn,label,ms:r.wallMs,counts:host.worker.counts}));return host.worker;}
  const a=await build('A',sourceA),b=await build('B',sourceB);
  const structures=avr?new Map(b.objects.map(o=>[o.file,avrObjectStructure(fs.readFileSync(o.file))])):null;
  const restored=await build('A-restored',sourceA),same=await build('A-same',sourceA);
  assert.equal(b.counts.DiscoveryGCC,0);assert.equal(b.counts.CompileGCC,1);assert.equal(restored.counts.CompileGCC,0);assert.equal(restored.counts.Linker,0);assert.equal(same.counts.CompileGCC,0);assert.equal(same.counts.Linker,0);
  assert.equal(path.dirname(a.artifacts[0].file),path.dirname(b.artifacts[0].file),'Changing source fingerprint must keep the project workspace');
  const digests=x=>x.artifacts.map(a=>[a.name,a.sha256]);assert.deepEqual(digests(a),digests(restored));assert.deepEqual(digests(a),digests(same));row.checks.push('Actual V9 route for unmodified requested FQBN','Changing source fingerprints retain stable project workspace','User code A/B: one sketch compile, no discovery','History and identical-source target artifacts verified');save();
  if(i===0){
   const isolated=await client.build(sourceA,fqbn,{workspaceFingerprint:digest(sourceA),projectId:'v91-other-project'});assert(isolated.success,isolated.error);const h=JSON.parse(fs.readFileSync(path.join(JSON.parse(isolated.value).path,'native-graph-host-receipt.json')));
   assert(h.worker.counts.CompileGCC>1);assert.equal(h.worker.counts.CacheRestored,0);assert.notEqual(path.dirname(a.artifacts[0].file),path.dirname(h.worker.artifacts[0].file));row.otherProject={wallMs:isolated.wallMs,host:h};row.checks.push('Separate project gets a distinct cold workspace and no cross-project restore');save();
  }
  // The structured IPC result was independently exported and acknowledged.
  // Compare its edited-source outputs with a real full official CLI run in
  // this now-idle test workspace, so source-path bytes also remain comparable.
  const buildDir=path.dirname(b.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');fs.writeFileSync(path.join(sketchDir,'sketch.ino'),sourceB);
  const c={...config.paths,workspace,sketchDir,fqbn:b.fqbn,jobs:config.limits.jobs};console.log('DESKTOP OFFICIAL CLEAN B '+b.fqbn);
  const official=await asyncRun([...baseArgs(c),'--clean','--json',sketchDir],config.paths.sysroot);fs.writeFileSync(path.join(folder,`${i}-official-B.json`),JSON.stringify(official));assert.equal(official.code,0,official.stderr+official.stdout.slice(-2000));
  assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),b.generatedSha256);
  const ordered=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(b.compileDatabase));
  for(const object of b.objects){if(avr)assert.deepEqual(avrObjectStructure(fs.readFileSync(object.file)),structures.get(object.file),'Official AVR object sections '+object.file);else assert.equal(digest(fs.readFileSync(object.file)),object.sha256,'Official object '+object.file);}
  const platform=JSON.parse(official.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
  for(const name of artifactsFor(fqbn)){const file=name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name);assert.equal(digest(fs.readFileSync(file)),b.artifacts.find(x=>x.name===name).sha256,'Official artifact '+name);}
  row.checks.push('Real official CLI clean B: identical CPP, compile database, '+(avr?'object sections/symbols with LTO identifier normalized':'every object')+', and byte-identical target delivery files');row.status='PASS';save();
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}finally{client?.close();save();if(process.env.CK_V91_PRODUCT_ROOT){const destination=path.join(process.env.CK_V91_PRODUCT_ROOT,'configuration-check-result.json');fs.copyFileSync(path.join(folder,'report.json'),destination);console.log('RESULT '+destination);}console.log('REPORT '+folder);}
