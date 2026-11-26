import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import test from 'node:test';import assert from 'node:assert/strict';
import {compileIdentity,observeDiscoveryCompile,acceptsDiscoveryCompile} from '../src/native/discovery-compile-proof.mjs';
import {createHash} from 'node:crypto';
import {RequestLibraryPch} from '../src/native/library-pch.mjs';
test('discovery objects require a live grant, final command and intact source, dependencies and outputs',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-early-object-'));
 try{
  const source=path.join(dir,'library.cpp'),header=path.join(dir,'library.h'),output=path.join(dir,'library.o'),depfile=path.join(dir,'library.d'),rsp=path.join(dir,'opts.rsp');
  for(const [file,bytes]of [[source,'source'],[header,'header'],[output,'object'],[rsp,'-DFLAG=1']])fs.writeFileSync(file,bytes);
  const makePath=f=>f.replaceAll('\\','/').replaceAll(' ','\\ ');
  fs.writeFileSync(depfile,`${makePath(output)}: ${makePath(source)} ${makePath(header)}\n`);
  const argv=[process.execPath,'-c','@'+rsp,'-Ifirst','-Isecond',source,'-o',output],identity=compileIdentity(argv,dir);
  const grant=observeDiscoveryCompile({argv,cwd:dir,source,output,depfile,identity}),rule={kind:'compile',argv,directory:dir,output,depfile,inputs:[source]};
  assert(acceptsDiscoveryCompile(grant,rule));assert(!acceptsDiscoveryCompile(JSON.parse(JSON.stringify(grant)),rule));
  assert.equal(observeDiscoveryCompile({argv,actualArgv:[...argv,'-include','untrusted.hpp'],pchGrant:{},cwd:dir,source,output,depfile,identity}),null);
  assert(!acceptsDiscoveryCompile(grant,{...rule,argv:argv.map(x=>x==='-Ifirst'?'-Isecond':x==='-Isecond'?'-Ifirst':x)}));
  assert(!acceptsDiscoveryCompile(grant,{...rule,argv:[...argv,'-DNEW=1']}));
  for(const file of [source,header,output,depfile,rsp]){const bytes=fs.readFileSync(file),s=fs.statSync(file);fs.writeFileSync(file,Buffer.alloc(bytes.length,120));fs.utimesSync(file,s.atime,s.mtime);assert(!acceptsDiscoveryCompile(grant,rule),file);fs.writeFileSync(file,bytes);}
  fs.unlinkSync(output);assert(!acceptsDiscoveryCompile(grant,rule));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('one batch shares input reads but rechecks each output and never carries proof to the next batch',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-object-batch-'));
 try{
  const header=path.join(dir,'common.h');fs.writeFileSync(header,'first!');
  const records=['a','b'].map(name=>{
   const source=path.join(dir,name+'.cpp'),output=path.join(dir,name+'.o'),depfile=path.join(dir,name+'.d');
   fs.writeFileSync(source,'source');fs.writeFileSync(output,'object');
   const escape=f=>f.replaceAll('\\','/').replaceAll(' ','\\ ');
   fs.writeFileSync(depfile,`${escape(output)}: ${escape(source)} ${escape(header)}\n`);
   const argv=[process.execPath,'-c',source,'-o',output],rule={kind:'compile',argv,directory:dir,output,depfile,inputs:[source]};
   return {rule,record:observeDiscoveryCompile({argv,cwd:dir,source,output,depfile,identity:compileIdentity(argv,dir)})};
  });
  const reads=new Map(),memo=new Map(),get=file=>{if(!memo.has(file)){reads.set(file,(reads.get(file)??0)+1);memo.set(file,{sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')});}return memo.get(file);};
  for(const {rule,record} of records)assert(acceptsDiscoveryCompile(record,rule,get));
  assert.equal(reads.get(header),1);
  const {rule,record}=records[1];fs.writeFileSync(rule.output,'forged');assert(!acceptsDiscoveryCompile(record,rule,get));
  fs.writeFileSync(rule.output,'object');const s=fs.statSync(header);fs.writeFileSync(header,'second');fs.utimesSync(header,s.atime,s.mtime);
  memo.clear();for(const {rule,record} of records)assert(!acceptsDiscoveryCompile(record,rule,get));
  assert.equal(reads.get(header),2);
  assert(!acceptsDiscoveryCompile(JSON.parse(JSON.stringify(record)),rule,get));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});

test('PCH observations bind original header bytes once and recheck them at object admission',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-pch-proof-'));
 const workspace=path.join(dir,'session'),cwd=dir,source=path.join(dir,'a.cpp'),header=path.join(dir,'original.h');
 const output=path.join(dir,'a.o'),depfile=path.join(dir,'a.d'),argv=[process.execPath,'-c',source,'-o',output];
 const rule={kind:'compile',argv,directory:cwd,output,depfile,inputs:[source]};
 const escape=file=>file.replaceAll('\\','/').replaceAll(' ','\\ ');
 const writeDeps=(file,target,deps)=>fs.writeFileSync(file,`${escape(target)}: ${deps.map(escape).join(' ')}\n`);
 const pch=new RequestLibraryPch({workspaceRoot:dir,workspace,sketchDir:path.join(workspace,'source/sketch'),sysroot:cwd},
  {run:(_priority,fn)=>fn()},async args=>{
   const target=args[args.indexOf('-o')+1];
   fs.writeFileSync(target,'binary');
   if(args.includes('-MF'))writeDeps(args[args.indexOf('-MF')+1],target,[header]);
   else writeDeps(depfile,target,[source]);
   return {code:0,elapsedMs:1};
  },()=>[]);
 try{
  fs.writeFileSync(header,'first!');fs.writeFileSync(source,'#include "original.h"\n');
  const plan=await pch.build({header,args:[process.execPath],entries:[1,2,3]});
  const {actual,grant}=await pch.compile(plan,argv,cwd),identity=compileIdentity(argv,cwd);
  const observe=()=>observeDiscoveryCompile({argv,actualArgv:actual,pchGrant:grant,cwd,source,output,depfile,identity});
  const record=observe();assert(acceptsDiscoveryCompile(record,rule));assert.equal(observe(),null);
  const s=fs.statSync(header);fs.writeFileSync(header,'wrong!');fs.utimesSync(header,s.atime,s.mtime);
  assert(!acceptsDiscoveryCompile(record,rule));
  await assert.rejects(pch.compile(plan,argv,cwd),/PCH input\/output changed/);
 }finally{await pch.close();fs.rmSync(dir,{recursive:true,force:true});}
});
