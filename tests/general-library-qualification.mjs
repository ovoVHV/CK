import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {BuildController} from '../src/controller.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';

const config=loadConfig(process.argv[2]);
const cases=[
 {name:'storage-spi',fqbn:'esp32:esp32:esp32s3',source:'#include <SD.h>\n#include <SPI.h>\nvoid setup(){Serial.begin(115200);SPI.begin();if(SD.begin()){File f=SD.open("/check.txt",FILE_WRITE);if(f){f.println("storage check");f.close();}}}\nvoid loop(){delay(100);}\n'},
 {name:'wire-preferences',fqbn:'esp32:esp32:esp32c3',source:'#include <Wire.h>\n#include <Preferences.h>\nvoid setup(){Wire.begin();Preferences prefs;prefs.begin("ck-check",false);prefs.putUInt("counter",1);prefs.end();}\nvoid loop(){delay(100);}\n'},
];
const report={status:'RUNNING',boundary:'Non-WiFi library correctness; full clean, same source, body edit, restoration and official byte comparison. These are not performance samples.',cases:[]};
fs.mkdirSync(config.paths.evidenceRoot,{recursive:true});
const output=path.join(config.paths.evidenceRoot,'general-library-qualification.json');
const save=()=>fs.writeFileSync(output,JSON.stringify(report,null,2));
process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
try {
 for(const fixture of cases){
  const controller=new BuildController(config),workspace=path.join(config.paths.workspaceRoot,fixture.name),sketchDir=path.join(workspace,'source/sketch');
  const row={name:fixture.name,fqbn:fixture.fqbn,runs:[],official:[]};report.cases.push(row);
  const A=fixture.source,B=A.replace('delay(100)','delay(137)');
  async function build(label,source,forceClean=false){
   const request={requestId:fixture.name+'-'+label,sourceSha256:digest(source),fqbn:fixture.fqbn,sysroot:config.paths.sysroot,workspace,sketchDir,libraries:[],forceClean};
   console.log('NATIVE '+request.requestId);
   const result=await controller.submit({protocolVersion:1,request,source});row.runs.push({label,result});save();
   assert(result.success,JSON.stringify(result.error));validateArtifacts(result.artifacts);
   assert(result.compileDatabase.every(unit=>!/[\\/]libraries[\\/](?:WiFi|Network)[\\/]/i.test(unit.file)),'Non-WiFi fixture must not select WiFi/Network');
   await controller.acknowledge(request.requestId,{sourceSha256:request.sourceSha256,success:true});return result;
  }
  let cold,edit;
  try{
   cold=await build('cold',A,true);assert(cold.counts.CompileGCC>=cold.objects.length);assert.equal(cold.counts.CacheRestored,0);
   const same=await build('same',A);assert(same.noOpFastPath.hit);assert.equal(same.counts.CompileGCC,0);
   edit=await build('edit',B);assert.equal(edit.counts.DiscoveryGCC,0);assert.equal(edit.counts.CompileGCC,1);
   const restore=await build('restore',A);assert.equal(restore.counts.CompileGCC,0);assert.deepEqual(restore.artifacts,cold.artifacts);
  }finally{await controller.close();}
  for(const [label,source,expected]of [['edited',B,edit],['original',A,cold]]){
   fs.writeFileSync(path.join(sketchDir,'sketch.ino'),source);
   console.log('OFFICIAL '+fixture.name+' '+label);
   const official=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn:fixture.fqbn,jobs:config.limits.jobs}),'--clean','--json',sketchDir],config.paths.sysroot);
   fs.writeFileSync(path.join(config.paths.evidenceRoot,fixture.name+'-'+label+'-official.json'),JSON.stringify(official));
   assert.equal(official.code,0,official.stderr.slice(-3000));
   const buildDir=path.join(workspace,'build'),ordered=units=>[...units].sort((a,b)=>a.file.localeCompare(b.file));
   assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),expected.generatedSha256);
   assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(expected.compileDatabase));
   for(const object of expected.objects)assert.equal(digest(fs.readFileSync(object.file)),object.sha256,object.file);
   const platform=JSON.parse(official.stdout).builder_result.build_properties.find(p=>p.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
   for(const name of artifactNames)assert.equal(digest(fs.readFileSync(name==='boot_app0.bin'?path.join(platform,'tools/partitions',name):path.join(buildDir,name))),expected.artifacts.find(a=>a.name===name).sha256,name);
   row.official.push({label,cpp:true,compileDatabase:true,objects:expected.objects.length,artifacts:artifactNames.length});save();
  }
  row.status='PASS';save();
 }
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}
finally{save();console.log('REPORT '+output);}
