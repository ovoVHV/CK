import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
const config=loadConfig(process.argv[2]),id='avr-safety-'+Date.now(),root=path.join(config.paths.evidenceRoot,id);
fs.mkdirSync(root,{recursive:true});
const lib=path.join(root,'ProofLibrary'),header=path.join(lib,'src/ProofLibrary.h');fs.mkdirSync(path.dirname(header),{recursive:true});
fs.writeFileSync(path.join(lib,'library.properties'),'name=ProofLibrary\nversion=1.0.0\nauthor=CK\nmaintainer=CK\nsentence=Regression fixture\nparagraph=Content invalidation check\ncategory=Other\nurl=https://example.invalid\narchitectures=avr\n');
fs.writeFileSync(header,'#pragma once\ninline int observedValue() { return 1; }\n');
const source='#include <ProofLibrary.h>\nvoid setup() { Serial.begin(9600); }\nvoid loop() { Serial.println(observedValue()); delay(100); }\n';
const workspace=path.join(config.paths.workspaceRoot,id),sketchDir=path.join(workspace,'source/sketch');
let controller=new BuildController(config),sequence=0;
const report={status:'RUNNING',boundary:'Controller/native AVR correctness and invalidation; not desktop latency qualification',runs:[],checks:[]};
const save=()=>fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));
async function build(label,code=source,fqbn='arduino:avr:uno',expectedSuccess=true){
 const request={requestId:id+'-'+sequence++,sourceSha256:digest(code),fqbn,sysroot:config.paths.sysroot,workspace,sketchDir,libraries:[lib]};
 const r=await controller.submit({protocolVersion:1,request,source:code});report.runs.push({label,...r});save();assert.equal(r.success,expectedSuccess,JSON.stringify(r.error));
 if(r.success){validateArtifacts(r.artifacts,fqbn);for(const a of r.artifacts)assert.equal(digest(fs.readFileSync(a.file)),a.sha256);await controller.acknowledge(request.requestId,{sourceSha256:request.sourceSha256,success:true});}
 console.log(label+' '+r.success);return r;
}
try{
 const a=await build('cold'),same=await build('same');assert(same.noOpFastPath.hit);assert.equal(same.counts.CompileGCC,0);
 const file=a.objects[0].file,stat=fs.statSync(file),bytes=fs.readFileSync(file);bytes[bytes.length-1]^=1;fs.writeFileSync(file,bytes);fs.utimesSync(file,stat.atime,stat.mtime);
 const repaired=await build('same-size-same-time-object-tamper');assert(!repaired.noOpFastPath.hit);assert(repaired.counts.ObjectRestored>0||repaired.counts.CompileGCC>0);assert.deepEqual(repaired.artifacts,a.artifacts);report.checks.push('Same size/time object replacement rejected and repaired');
 const bin=a.artifacts.find(a=>a.name==='sketch.ino.hex').file,bstat=fs.statSync(bin),bad=fs.readFileSync(bin);bad[10]^=1;fs.writeFileSync(bin,bad);fs.utimesSync(bin,bstat.atime,bstat.mtime);
 const fixed=await build('same-size-same-time-hex-tamper');assert(!fixed.noOpFastPath.hit);assert.deepEqual(fixed.artifacts,a.artifacts);report.checks.push('HEX replacement rejected; authorized original recovered');
 const hstat=fs.statSync(header);fs.writeFileSync(header,fs.readFileSync(header,'utf8').replace('return 1','return 2'));fs.utimesSync(header,hstat.atime,hstat.mtime);
 const changed=await build('same-size-same-time-public-header');assert(!changed.graphReuse.hit);assert(changed.counts.CompileGCC>0);assert.notEqual(changed.artifacts.find(x=>x.name.endsWith('.hex')).sha256,a.artifacts.find(x=>x.name.endsWith('.hex')).sha256);report.checks.push('Header content change invalidates despite unchanged size/time');
 const included=await build('added-include','#include <EEPROM.h>\n'+source.replace('observedValue()','EEPROM.read(0)'));assert(!included.graphReuse.hit);report.checks.push('Added include invalidates discovery');
 const board=await build('changed-board',source,'arduino:avr:nano:cpu=atmega168');assert(!board.graphReuse.hit);assert(board.sketchCommand.includes('-mmcu=atmega168'));report.checks.push('Board/MCU change establishes a new build identity');
 await build('compiler-error',source.replace('observedValue()','missingFunction()'),'arduino:avr:uno',false);
 const recovered=await build('after-error');assert(!recovered.graphReuse.hit);report.checks.push('Failed compile confers no authority');
 await controller.close();controller=new BuildController(config);const restarted=await build('controller-restarted');assert(!restarted.graphReuse.hit);assert.equal(restarted.counts.ObjectRestored,0);assert.equal(restarted.counts.LinkRestored,0);report.checks.push('Controller restart cannot authorize disk graph or history');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}finally{await controller.close();save();console.log('REPORT '+root);}
