// CK_V9_ENGINE_CONFIG points at a locally installed CK profile.
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import assert from 'node:assert/strict';
import {validateConfig} from '../src/config.mjs';
import {ENGINE_VERSION} from '../src/version.mjs';
import {BuildController} from '../src/controller.mjs';
import {digest} from '../src/protocol.mjs';
import {asyncRun,baseArgs} from '../src/discovery.mjs';
const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-mf-'));
const raw=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
raw.engineVersion=ENGINE_VERSION;Object.assign(raw.paths,{node:process.execPath,workspaceRoot:path.join(root,'sessions'),evidenceRoot:path.join(root,'proof')});
const config=validateConfig(raw),ctl=new BuildController(config);
const workspace=path.join(config.paths.workspaceRoot,'nano'),sketchDir=path.join(workspace,'source','sketch'),fqbn='arduino:avr:nano:cpu=atmega328';
const source='#include "Motor.h"\nvoid setup() { motor(); }\nvoid loop() {}\n';
const files={'Motor.h':'void motor();\n','src/Motor.cpp':'#include <Wire.h>\n#include "settings.h"\nvoid motor(){ Wire.begin(); Wire.beginTransmission(CK_ADDR); Wire.endTransmission(); }\n','src/settings.h':'#define CK_ADDR 21\n'};
const report=[],checks=[];
try{
 for(const label of ['cold','same','header','add','delete']){
  if(label==='header')files['src/settings.h']='#define CK_ADDR 42\n';
  if(label==='add')files['Extra.cpp']='int unused_function(){return 123;}\n';
  if(label==='delete')delete files['Extra.cpp'];
  const request={requestId:label,workspace,sketchDir,sysroot:config.paths.sysroot,sourceSha256:digest(source),fqbn,libraries:[],projectFiles:Object.entries(files).map(([name,text])=>({name,hex:Buffer.from(text).toString('hex')}))};
  const r=await ctl.submit({protocolVersion:1,request,source});assert(r.success,JSON.stringify(r.error));
  await ctl.acknowledge(label,{sourceSha256:request.sourceSha256,success:true});
  const row={label,ms:r.wallMs,counts:r.counts,firmware:r.artifacts.find(a=>a.name==='sketch.ino.hex').sha256,official:r.officialFrontendInvoked};
  report.push(row);console.log(label,Math.round(row.ms),'ms',r.counts.CompileGCC,'compiles',r.counts.Linker,'links',row.firmware);
  assert.equal(r.officialFrontendInvoked,false);assert(r.selectedLibraries.some(l=>l.name==='Wire'));
  assert.equal(r.compileDatabase.some(e=>e.file.endsWith('Extra.cpp')),label==='add');
  if(label==='same'){assert(r.noOpFastPath?.hit);assert.equal(row.counts.CompileGCC,0);assert.equal(row.counts.Linker,0);}
  if(label==='header'){assert.equal(row.counts.CompileGCC,1);assert.notEqual(row.firmware,report[0].firmware);}
  if(label==='cold'||label==='header')checks.push({label,files:{...files},artifacts:r.artifacts});
 }
 const advanced=source.replace('void setup()', 'struct Example { int value; };\nvoid setup()');
 for(const label of ['official-first','official-repeat']){
  const request={requestId:label,workspace,sketchDir,sysroot:config.paths.sysroot,sourceSha256:digest(advanced),fqbn,libraries:[],projectFiles:Object.entries(files).map(([name,text])=>({name,hex:Buffer.from(text).toString('hex')}))};
  const r=await ctl.submit({protocolVersion:1,request,source:advanced});assert(r.success,JSON.stringify(r.error));
  assert(label==='official-first'?r.officialFrontendInvoked:r.noOpFastPath?.hit);
  await ctl.acknowledge(label,{sourceSha256:request.sourceSha256,success:true});
 }
 await ctl.close();fs.writeFileSync(path.join(sketchDir,'sketch.ino'),source);
 process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
 for(const check of checks){
  for(const [n,v]of Object.entries(check.files))fs.writeFileSync(path.join(sketchDir,n),v);
  const c={...config.paths,workspace,sketchDir,fqbn,jobs:8};
  const r=await asyncRun([...baseArgs(c),'--clean',sketchDir],c.sysroot);assert.equal(r.code,0,r.stderr);
  for(const a of check.artifacts.filter(a=>/\.(?:hex|eep|elf)$/.test(a.name)))assert.equal(digest(fs.readFileSync(a.file)),a.sha256,'official '+check.label+' '+a.name);
 }
 console.log('Official ELF/HEX/EEP matched. Evidence:',root);
}finally{await ctl.close();fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));}
