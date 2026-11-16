// Run with isolated candidate scripts/Start-Preview.ps1 and one Core per sysroot.
// Desktop latency is measured inside compile_sketch IPC; official clean runs
// are correctness controls and are not presented as desktop performance.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {pathToFileURL} from 'node:url';
import {isDeepStrictEqual} from 'node:util';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
const candidate=path.resolve(process.env.CK_CORE_MATRIX_CANDIDATE??'local/core-matrix-engine');
const {asyncRun,baseArgs,artifactNames,properties}=await import(pathToFileURL(path.join(candidate,'src/discovery.mjs')));
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const profilePath=process.env.CK_V9_CONFIG,originalProfile=fs.readFileSync(profilePath),profile=JSON.parse(originalProfile);
const fqbn='esp32:esp32:esp32s3';
const sources={
 wifiA:fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),
 wifiB:fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8'),
 gpioA:'void setup() {\n  pinMode(4, OUTPUT);\n  Serial.begin(115200);\n}\nvoid loop() {\n  digitalWrite(4, HIGH);\n  delay(100);\n  digitalWrite(4, LOW);\n  Serial.println("GPIO A");\n  delay(100);\n}\n',
 gpioB:'void setup() {\n  pinMode(4, OUTPUT);\n  Serial.begin(115200);\n}\nvoid loop() {\n  digitalWrite(4, HIGH);\n  delay(150);\n  digitalWrite(4, LOW);\n  Serial.println("GPIO edited");\n  delay(200);\n}\n'
};
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
const folder=path.join(config.paths.evidenceRoot,'desktop-matrix-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={status:'RUNNING',candidate,startedAt:new Date().toISOString(),fqbn,sysroot:config.paths.sysroot,config,
 boundary:'Isolated source compatibility candidate with installed alpha.22 desktop IPC; no DEBUG_PROCESS; no firmware upload',
 performanceQualified:false,filesystemCachePurged:false,runs:[],official:[]};
const save=()=>fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));
const ordered=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));
const equivalent=(a,b)=>{assert.equal(a.generatedSha256,b.generatedSha256);assert.deepEqual(a.compileDatabase,b.compileDatabase);assert.deepEqual(a.objects,b.objects);assert.deepEqual(a.artifacts,b.artifacts);};
let client;save();
try{
 fs.writeFileSync(profilePath,JSON.stringify({...profile,coldReference:false}));client=await connectDesktop();
 async function build(label,sourceKey,project){
  console.log('START '+label);const result=await client.build(sources[sourceKey],fqbn,{projectId:'core-matrix-'+project,workspaceFingerprint:digest(sources[sourceKey])});
  const row={label,sourceKey,...result};report.runs.push(row);save();assert(result.success,result.error);
  const exported=JSON.parse(result.value).path,host=JSON.parse(fs.readFileSync(path.join(exported,'native-graph-host-receipt.json'),'utf8'));row.host=host;
  validateArtifacts(host.worker.artifacts,fqbn);for(const a of host.worker.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported,a.name))),a.sha256,a.name);
  assert.equal(host.worker.success,true);save();console.log(JSON.stringify({label,wallMs:result.wallMs,discovery:host.worker.discoveryMode,counts:host.worker.counts,phases:host.worker.phases}));return host.worker;
 }
 const a=await build('wifi-cold','wifiA','wifi');assert.equal(a.discoveryMode,'independent');
 const b=await build('wifi-edit','wifiB','wifi');assert.equal(b.counts.DiscoveryGCC,0);assert.equal(b.counts.PrototypeGCC,0);assert.equal(b.counts.CompileGCC,1);
 for(let n=1;n<=3;n++){const same=await build('wifi-unchanged-'+n,'wifiB','wifi');assert(same.noOpFastPath.hit);assert.equal(same.counts.CompileGCC,0);assert.equal(same.counts.Linker,0);assert.equal(same.counts.ImageGenerator,0);equivalent(b,same);}
 const history=await build('wifi-history-A','wifiA','wifi');equivalent(a,history);
 const gpio=await build('gpio-cold','gpioA','gpio');assert.equal(gpio.discoveryMode,'independent');
 const gpioEdit=await build('gpio-edit','gpioB','gpio');assert.equal(gpioEdit.counts.CompileGCC,1);assert.equal(gpioEdit.counts.DiscoveryGCC,0);
 const gpioSame=await build('gpio-unchanged','gpioB','gpio');assert(gpioSame.noOpFastPath.hit);equivalent(gpioEdit,gpioSame);
 // All controller requests are finished before official clean changes these
 // disposable workspaces. No changed disk graph receives live authorization.
 for(const [label,sourceKey,worker]of [['wifi-A','wifiA',a],['wifi-B','wifiB',b],['gpio-B','gpioB',gpioEdit]]){
  console.log('OFFICIAL CLEAN '+label);const buildDir=path.dirname(worker.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');
  fs.writeFileSync(path.join(sketchDir,'sketch.ino'),sources[sourceKey]);
  const result=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn,jobs:config.limits.jobs}),'--clean','--json',sketchDir],config.paths.sysroot);
  fs.writeFileSync(path.join(folder,label+'-official.json'),JSON.stringify(result));
  const row={label,elapsedMs:result.elapsedMs,code:result.code,differences:[]};report.official.push(row);save();assert.equal(result.code,0,result.stderr+result.stdout.slice(-3000));
  const check=(name,actual,expected)=>{if(!isDeepStrictEqual(actual,expected))row.differences.push({name,actual,expected});};
  const parsed=JSON.parse(result.stdout),p=properties(parsed);
  check('generated CPP',digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),worker.generatedSha256);
  check('compile database',ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(worker.compileDatabase));
  const libs=(parsed.builder_result.used_libraries??[]).map(l=>({name:l.name,source_dir:l.source_dir,install_dir:l.install_dir,version:l.version??null}));
  check('selected libraries',libs,worker.selectedLibraries);
  for(const o of worker.objects)check(o.file,digest(fs.readFileSync(o.file)),o.sha256);
  for(const name of artifactNames)check(name,digest(fs.readFileSync(name==='boot_app0.bin'?path.join(p['runtime.platform.path'],'tools/partitions/boot_app0.bin'):path.join(buildDir,name))),worker.artifacts.find(a=>a.name===name).sha256);
  row.objectCount=worker.objects.length;row.artifactCount=artifactNames.length;row.status=row.differences.length?'FAIL':'PASS';save();
  console.log(JSON.stringify({label,status:row.status,objects:row.objectCount,artifacts:row.artifactCount,differences:row.differences.map(x=>x.name)}));
 }
 assert(report.official.every(x=>x.status==='PASS'),'Official output differences; inspect complete report');report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}
finally{fs.writeFileSync(profilePath,originalProfile);client?.close();report.finishedAt=new Date().toISOString();save();console.log('REPORT '+path.join(folder,'report.json'));}
