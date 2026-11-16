import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {tokens,responses,setRecipeTokenMemo} from '../src/native/plan.mjs';
test('token reuse is content based, returns independent arrays, and still rereads nested response files',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-token-memo-'));
 try{setRecipeTokenMemo(true);const text='-DNAME="value with spaces"\t-I"C:/my includes"\r\n';
  assert.deepEqual(tokens(text),['-DNAME=value with spaces','-IC:/my includes']);tokens(text).push('injected');assert.equal(tokens(text).length,2);
  const outer=path.join(dir,'outer.rsp'),inner=path.join(dir,'inner.rsp');fs.writeFileSync(outer,'@inner.rsp');fs.writeFileSync(inner,'-DFLAG=1');
  assert.deepEqual(responses(['@'+outer],dir).expanded,['-DFLAG=1']);const s=fs.statSync(inner);fs.writeFileSync(inner,'-DFLAG=2');fs.utimesSync(inner,s.atime,s.mtime);
  assert.deepEqual(responses(['@'+outer],dir).expanded,['-DFLAG=2']);fs.writeFileSync(inner,'@outer.rsp');assert.throws(()=>responses(['@'+outer],dir),/cycle/);
  assert.throws(()=>tokens('"unclosed'),/quote/);fs.unlinkSync(inner);assert.throws(()=>responses(['@'+outer],dir));
 }finally{setRecipeTokenMemo(false);fs.rmSync(dir,{recursive:true,force:true});}
});
