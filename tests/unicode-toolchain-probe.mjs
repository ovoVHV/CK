// Real compiler + GNU binutils regression, independent of WiFi or Arduino SDK.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {spawnSync} from 'node:child_process';
import {readNativeDependencies} from '../src/native/depfile.mjs';import {linkExecution,buildFileExecution} from '../src/native/link-paths.mjs';import {digest} from '../src/protocol.mjs';
const [sysroot,root]=process.argv.slice(2);if(!sysroot||!root)throw Error('Usage: unicode-toolchain-probe SYSROOT OUTPUT');fs.mkdirSync(root,{recursive:true});
const report={status:'RUNNING',startedAt:new Date().toISOString(),rows:[]};const save=()=>fs.writeFileSync(path.join(root,'toolchain-report.json'),JSON.stringify(report,null,2));
const tools=[['esp32','esp-x32','xtensa-esp32-elf-'],['esp32','esp-x32','xtensa-esp32s3-elf-'],['esp32','esp-rv32','riscv32-esp-elf-'],['arduino','avr-gcc','avr-']];
try{for(const [vendor,family,prefix]of tools){
 const parent=path.join(sysroot,'packages',vendor,'tools',family),version=fs.readdirSync(parent).sort().at(-1),compiler=path.join(parent,version,'bin',prefix+'g++.exe');assert(fs.existsSync(compiler));
 const row={family,prefix,compiler,cases:[]};report.rows.push(row);save();let baseline;
 for(const label of ['ascii','中文 路径']){
  const build=path.join(root,prefix,label);fs.mkdirSync(build,{recursive:true});const source=path.join(build,'probe.cpp'),header=path.join(build,'probe.h'),object=path.join(build,'probe.o'),elf=path.join(build,'probe.elf');
  fs.writeFileSync(header,'#pragma once\n#define VALUE 7\n');fs.writeFileSync(source,'#include "probe.h"\nextern "C" { const char message[]="中文内容"; int _start(){return VALUE+message[0];} }\n');
  const extra=vendor==='arduino'?['-mmcu=atmega328p']:[],commands=[];
  const run=(argv,cwd)=>{const r=spawnSync(argv[0],argv.slice(1),{cwd,windowsHide:true});commands.push({argv,cwd,status:r.status,stderr:r.stderr?.toString()});assert.equal(r.status,0,r.stderr?.toString());return r;};
  run([compiler,...extra,'-c','-MMD','-MF',path.join(build,'probe.d'),source,'-o',object],build);
  const deps=readNativeDependencies(path.join(build,'probe.d'),build,object).map(p=>path.resolve(build,p));assert(deps.includes(source));assert(deps.includes(header));assert(deps.every(fs.existsSync));
  const argv=[compiler,...extra,'-nostdlib','-Wl,-e,_start','-Wl,--Map='+path.join(build,'probe.map'),object,'-o',elf];
  const link=linkExecution(argv,root,build,{expanded:argv.slice(1),resolveScript:p=>p});run(link.argv,link.directory);
  const size=buildFileExecution([compiler.replace(/g\+\+\.exe$/,'size.exe'),'-A',elf],root,build);run(size.argv,size.directory);
  const binary=path.join(build,'probe.bin'),copy=buildFileExecution([compiler.replace(/g\+\+\.exe$/,'objcopy.exe'),'-O','binary',elf,binary],root,build);run(copy.argv,copy.directory);
  const hashes={object:digest(fs.readFileSync(object)),elf:digest(fs.readFileSync(elf)),binary:digest(fs.readFileSync(binary))};
  assert(fs.readFileSync(elf).includes(Buffer.from('中文内容')),'UTF-8 source string must survive compilation');
  if(baseline)assert.deepEqual(hashes,baseline,'Unicode and ASCII compiler/linker products must match byte for byte');else baseline=hashes;
  row.cases.push({label,build,dependencies:deps,hashes,commands,success:true});save();
 }
}report.status='PASS';}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}finally{save();console.log(path.join(root,'toolchain-report.json'));}
