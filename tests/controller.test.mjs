import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {BuildController} from '../src/controller.mjs';import {digest,envelope} from '../src/protocol.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('queued cancellation cannot release a later writer before export acknowledgement',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-v9-queue-')),paths={workspaceRoot:path.join(dir,'sessions'),evidenceRoot:path.join(dir,'events'),sysroot:dir,node:process.execPath,userLibraries:dir};
 const c=new BuildController({paths,features:{enabled:true,sessionHistory:true,frontendReplay:true,assetBackend:'rust'},limits:{maxWorkspaces:1,historyBytes:1024,jobs:1,requestTimeoutMs:10000,leaseTimeoutMs:10000},allowedFqbns:['esp32:esp32:*'],assetRoots:[]});const started=[];
 c.startWorker=async(key,slot)=>{slot.dead=false;slot.pending=new Map();slot.runner={stdin:{write(line){const m=JSON.parse(line);started.push(m.id);queueMicrotask(()=>{const p=slot.pending.get(m.id);slot.pending.delete(m.id);p.resolve(envelope(m.c,{success:true,artifacts:[]}));});}}};};c.stopWorker=async slot=>{slot.dead=true;};
 const msg=(id,workspace='a')=>({protocolVersion:1,source:'x',request:{requestId:id,sourceSha256:digest('x'),fqbn:'esp32:esp32:esp32s3',sysroot:dir,workspace:path.join(paths.workspaceRoot,workspace),sketchDir:path.join(paths.workspaceRoot,workspace,'source/sketch'),libraries:[]}});
 try{const a=await c.submit(msg('a'));const abort=new AbortController(),b=c.submit(msg('b'),{signal:abort.signal}).catch(e=>e),d=c.submit(msg('d'));await delay(30);abort.abort();await delay(30);assert.deepEqual(started,['a']);await assert.rejects(c.submit(msg('a')),/already active/);await assert.rejects(c.submit(msg('other','other')),/busy/);
  await c.acknowledge('a',{sourceSha256:a.sourceSha256,success:true});assert.equal((await b).code,'CANCELLED');const r=await d;assert.deepEqual(started,['a','d']);await c.acknowledge('d',{sourceSha256:r.sourceSha256,success:true});assert.equal(c.requests.size,0);
  const next=await c.submit(msg('new','other'));assert.equal(c.workspaces.size,1);await c.acknowledge('new',{sourceSha256:next.sourceSha256,success:true});
 }finally{await c.close();fs.rmSync(dir,{recursive:true,force:true});}
});
