import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {preprocessIdentity,reusablePreprocess} from '../src/native/preprocess-proof.mjs';import {digest} from '../src/protocol.mjs';
test('request-local preprocessing binds source, compiler, semantic argument order and response content',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-preprocess-'));
 try{
  const rsp=path.join(root,'flags.rsp');fs.writeFileSync(rsp,'-DVALUE=1');
  const a=[process.execPath,'-E','-CC','-dD','-x','c++','@'+rsp,'-Iearly','-Ifallback','source.cpp','-o','first.i'];
  const data=Buffer.from('processed content'),p={identity:preprocessIdentity(a,root,'raw'),bytes:data,sha256:digest(data)};
  assert(reusablePreprocess(p,[...a.slice(0,-1),'second.i','-H','-w'],root,'raw'));
  assert(!reusablePreprocess(p,a,root,'new raw'));
  assert(!reusablePreprocess(p,a.map(x=>x==='-Iearly'?'-Ifallback':x==='-Ifallback'?'-Iearly':x),root,'raw'));
  assert(!reusablePreprocess(p,a.filter(x=>x!=='-dD'),root,'raw'));
  assert(!reusablePreprocess(p,a.map(x=>x==='c++'?'c':x),root,'raw'));
  fs.writeFileSync(rsp,'-DVALUE=2');assert(!reusablePreprocess(p,a,root,'raw'));fs.writeFileSync(rsp,'-DVALUE=1');
  assert(!reusablePreprocess({...p,bytes:Buffer.from('forged')},a,root,'raw'));
  assert(!reusablePreprocess(null,a,root,'raw'));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
