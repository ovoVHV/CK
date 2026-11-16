import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {observeNoOpTree,proveNoOp,sameSketchNamespace} from '../src/noop.mjs';import {proof} from '../src/scheduler.mjs';
test('No-Op requires live authority and all build/graph content, including negative directory entries',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-v91-noop-'));
 try{
  const plan={build:path.join(dir,'build'),graph:path.join(dir,'graph')},validation={mode:'rust'};
  fs.mkdirSync(plan.build);fs.mkdirSync(plan.graph);const bin=path.join(plan.build,'sketch.ino.bin');fs.writeFileSync(bin,'1234');
  const command=path.join(plan.graph,'link.rsp');fs.writeFileSync(command,'obj1');
  const state={outputIdentity:observeNoOpTree(plan,validation).sha256,lastReceipt:{artifacts:[{name:'sketch.ino.bin',...proof(bin)}]}};
  assert.equal(proveNoOp({},plan,validation).hit,false);assert.equal(proveNoOp(state,plan,validation).hit,true);
  const s=fs.statSync(bin);fs.writeFileSync(bin,'5678');fs.utimesSync(bin,s.atime,s.mtime);assert.equal(proveNoOp(state,plan,validation).hit,false);
  fs.writeFileSync(bin,'1234');assert.equal(proveNoOp(state,plan,validation).hit,true);
  fs.writeFileSync(command,'obj2');assert.equal(proveNoOp(state,plan,validation).hit,false);fs.writeFileSync(command,'obj1');
  fs.mkdirSync(path.join(plan.build,'new-search-candidate'));assert.equal(proveNoOp(state,plan,validation).hit,false);
  fs.rmdirSync(path.join(plan.build,'new-search-candidate'));fs.unlinkSync(bin);assert.equal(proveNoOp(state,plan,validation).hit,false);
  const sketch=path.join(dir,'sketch');fs.mkdirSync(sketch);fs.writeFileSync(path.join(sketch,'sketch.ino'),'void setup(){}');assert(sameSketchNamespace(sketch));fs.writeFileSync(path.join(sketch,'new.h'),'');assert(!sameSketchNamespace(sketch));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
