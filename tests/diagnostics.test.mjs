import test from 'node:test';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
test('diagnostic collector reads alpha.2 receipts without exporting source, commands or tokens',{skip:process.platform!=='win32'},()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-diagnostics-'));
 const write=(file,value)=>{fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,JSON.stringify(value));};
 const data=path.join(dir,'data'),build=path.join(dir,'build'),out=path.join(dir,'out');fs.mkdirSync(out);
 const request=path.join(build,'session-1/requests/request-1');
 write(path.join(data,'environment.json'),{engineVersion:'9.1.0-alpha.3',core:['3.3.6-cn']});
 write(path.join(data,'sessions/session-1/host.json'),{token:'SECRET_BEARER_TOKEN'});
 write(path.join(data,'sessions/session-1/evidence/runs/request-1.discovery.json'),{timings:{sketchReadyMs:15000,selectionReadyMs:70000},probes:[{unit:'C:/private/sketch.ino.cpp',kind:'preprocess',elapsedMs:12345,code:0,startedUnixMs:1790000000000,stdout:'SECRET_SOURCE',stderr:'SECRET_ERROR_SOURCE',argv:['SECRET_ARGUMENTS']}]});
 write(path.join(data,'wifi-wait-result.json'),{engineVersion:'9.1.0-alpha.4',status:'PASS',pairs:5,targets:[{fqbn:'esp32:esp32:esp32s3',status:'PASS',runs:[{label:'cold-reuse-A',success:true,wallMs:80000,value:'SECRET_SOURCE',host:{token:'SECRET_BEARER_TOKEN',worker:{prototypePreprocessReused:true,counts:{PrototypeGCC:0},compileDatabase:[{command:'SECRET_ARGUMENTS'}]}}}]}]});
 write(path.join(request,'request.json'),{requestId:'request-1',fqbn:'esp32:esp32:esp32s3',workspace:'C:/private/workspace',source:'SECRET_SOURCE'});
 write(path.join(request,'artifacts/sketch/native-graph-host-receipt.json'),{endToEndMs:90000,worker:{engineVersion:'9.1.0-alpha.3',success:true,wallMs:89000,counts:{CompileGCC:71,Linker:1},graphReuse:{hit:false,reason:'no-live-authority'},phases:{discoveryMs:30000},compileDatabase:[{command:'SECRET_ARGUMENTS'}],error:{message:'SECRET_SOURCE'},artifacts:[{name:'sketch.ino.bin',sha256:'a'.repeat(64),bytes:123}]}});
 try{
  const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
  const r=spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/Collect-Compile-Diagnostics.ps1'),'-DataRoot',data,'-BuildRoot',build,'-OutputDirectory',out],{windowsHide:true,encoding:'utf8'});assert.equal(r.status,0,r.stderr+r.stdout);
  const reportDir=fs.readdirSync(out).find(n=>!n.endsWith('.zip')),text=fs.readFileSync(path.join(out,reportDir,'diagnostics.json'),'utf8').replace(/^\uFEFF/,'');assert(!text.includes('SECRET_'));const report=JSON.parse(text);
  assert.equal(report.requests[0].host.endToEndMs,90000);assert.equal(report.requests[0].worker.counts.CompileGCC,71);assert.equal(report.requests[0].worker.graphReuse.reason,'no-live-authority');assert(fs.readdirSync(out).some(n=>n.endsWith('.zip')));
  assert.equal(report.wifiComparison.targets[0].runs[0].worker.prototypePreprocessReused,true);assert.equal(report.wifiComparison.targets[0].runs[0].wallMs,80000);
  assert.equal(JSON.parse(fs.readFileSync(path.join(data,'sessions/session-1/host.json'))).token,'SECRET_BEARER_TOKEN');
  const selected=path.join(dir,'selected');fs.mkdirSync(selected);
  const filtered=spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',path.resolve('scripts/Collect-Compile-Diagnostics.ps1'),'-DataRoot',data,'-BuildRoot',build,'-OutputDirectory',selected,'-RequestId','request-1'],{windowsHide:true,encoding:'utf8'});assert.equal(filtered.status,0,filtered.stderr+filtered.stdout);
  const selectedDir=fs.readdirSync(selected).find(n=>!n.endsWith('.zip')),selectedText=fs.readFileSync(path.join(selected,selectedDir,'diagnostics.json'),'utf8').replace(/^\uFEFF/,'');assert(!selectedText.includes('SECRET_'));const detail=JSON.parse(selectedText);
  assert.equal(detail.requestedId,'request-1');assert.equal(detail.discoveryProcesses.length,1);assert.equal(detail.discoveryProcesses[0].probes[0].unitName,'sketch.ino.cpp');assert.equal(detail.discoveryProcesses[0].probes[0].elapsedMs,12345);assert.equal(detail.discoveryProcesses[0].timings.selectionReadyMs,70000);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
