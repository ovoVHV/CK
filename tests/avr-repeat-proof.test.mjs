import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import {validateAssets,validateSummary,verifyRepeat} from '../src/asset-engine.mjs';

test('bundled repeat rereads contents and both namespaces with the ordinary proof format',t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-avr-proof-'));
 t.after(()=>fs.rmSync(dir,{recursive:true,force:true}));
 const inputs=[path.join(dir,'中文库')],outputs=[path.join(dir,'build'),path.join(dir,'graph')];
 for(const d of [...inputs,...outputs])fs.mkdirSync(d);
 const header=path.join(inputs[0],'Test.h'),artifact=path.join(outputs[0],'sketch.ino.hex');
 fs.writeFileSync(header,'v1');fs.writeFileSync(artifact,'0001');
 const v={mode:'rust',workers:4,openWorkers:4,sizeGrouped:true,bufferBytes:262144};
 const i=validateAssets(inputs,v),o=validateAssets(outputs,v);
 const summary=validateSummary(inputs,v);
 for(const field of ['sha256','namespaceSha256','files','bytes'])assert.equal(summary[field],i[field]);
 const scan=()=>verifyRepeat(inputs,outputs,i.sha256,o.sha256,v);
 const good=scan();assert.ok(good);
 for(const [key,ref] of [['before',i],['after',i],['output',o]]){
  for(const field of ['sha256','namespaceSha256','files','bytes'])assert.equal(good[key][field],ref[field]);
 }
 const stamp=new Date(1700000000000);
 fs.utimesSync(header,stamp,stamp);fs.writeFileSync(header,'v2');fs.utimesSync(header,stamp,stamp);assert.equal(scan(),null);
 fs.unlinkSync(header);assert.equal(scan(),null);
 fs.writeFileSync(header,'v1');const candidate=path.join(inputs[0],'new-library');fs.mkdirSync(candidate);assert.equal(scan(),null);
 fs.rmdirSync(candidate);fs.writeFileSync(artifact,'0002');assert.equal(scan(),null);
 fs.writeFileSync(artifact,'0001');assert.ok(scan());
});
