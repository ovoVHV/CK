import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
import {editorBuilder} from './core-rediscovery-button.mjs';

const file=process.env.CK_V9_ENGINE_CONFIG,original=fs.readFileSync(file),cfg=JSON.parse(original);
const profileFile=process.env.CK_V9_CONFIG,profileBytes=fs.readFileSync(profileFile),profile=JSON.parse(profileBytes);
const board=process.env.CK_AB_BOARD,avr=board.startsWith('arduino:avr:');
const A='#include <Wire.h>\nvoid setup(){Wire.begin();}\nvoid loop(){delay(331);}\n';
const B='#include <SPI.h>\n'+A.replace('Wire.begin();','SPI.begin();Wire.begin();');
const button=process.env.CK_AB_BUTTON==='1',smoke=process.env.CK_CORE_MATRIX_SMOKE==='1';
const dst=path.join(cfg.paths.evidenceRoot,'core-rediscovery-'+(smoke?'matrix-':button?'button-':'ipc-')+Date.now()+'.json');
const report={board,boundary:(button?'Editor compile button through progress overlay closed':'Desktop compile_sketch IPC to verified export')+'; history restore disabled on both sides',rows:[]};
const save=()=>fs.writeFileSync(dst,JSON.stringify(report,null,2));
const projectId=randomUUID(),outputs=new Map();let corrupt=null,assets;
const client=await connectDesktop();
let build=(src,opts)=>client.build(src,board,opts);
async function run(next,src,scenario){
 const features={...cfg.features};
 if(process.env.CK_CORE_DEFAULT==='1')delete features.deferCoreOnRediscovery;
 else features.deferCoreOnRediscovery=next;
 fs.writeFileSync(file,JSON.stringify({...cfg,features}));
 fs.writeFileSync(profileFile,JSON.stringify({...profile,historyReference:true}));
 const call=await build(src,{projectId,workspaceFingerprint:digest(src)});
 const row={next,scenario,source:digest(src),ms:call.wallMs,success:call.success};report.rows.push(row);save();
 assert.ok(call.success,call.error);
 const dir=JSON.parse(call.value).path,h=JSON.parse(fs.readFileSync(path.join(dir,'native-graph-host-receipt.json'))),w=h.worker;
 assert.equal(w.sourceSha256,digest(src));assert.equal(w.fqbn,board);assert.equal(h.adapterPhases.transport,'host-loopback');validateArtifacts(w.artifacts,board);
 assert.equal(w.assetProof.sha256,w.postAssetProof.sha256);if(assets)assert.equal(assets,w.assetProof.sha256);assets=w.assetProof.sha256;
 assert.equal(w.deferredCoreAdmission,scenario!=='first'&&next);assert.equal(w.graphReuse.hit,false);
 const hashes=Object.fromEntries(w.artifacts.map(a=>{const hash=digest(fs.readFileSync(path.join(dir,a.name)));assert.equal(hash,a.sha256);return [a.name,hash];}));
 if(outputs.has(src))assert.deepEqual(hashes,outputs.get(src));else outputs.set(src,hashes);
 const core=w.taskDecisions.filter(d=>d.task==='compile'&&/[\\/]build[\\/]core[\\/]/.test(d.output));
 assert.ok(core.length>10);const retained=core.filter(d=>d.decision==='Reuse').length;
 assert.equal(retained,next&&scenario!=='first'?core.length-Number(scenario==='damaged-core'):0);
 if(scenario==='damaged-core'){const d=core.find(x=>x.output===corrupt);assert.equal(d?.decision,'Compile');assert.equal(d.reason,'output-content-changed');}
 Object.assign(row,{core:core.length,retained,compiles:w.counts.CompileGCC,counts:w.counts,phases:w.phases,artifacts:hashes});save();
 console.log(JSON.stringify({board,next,scenario,ms:row.ms,core:core.length,retained,compiles:row.compiles}));
 return core[0].output;
}
try{
 if(button)build=await editorBuilder(client,cfg,board);
 await run(false,A,'first');
 // Each direction is sampled once per route, in counterbalanced order.
 const order=smoke?[true,true]:avr?[false,true,true,false]:[true,false,false,true];
 for(const [i,next] of order.entries())corrupt=await run(next,i%2?A:B,i%2?'remove-library':'add-library');
 assert.notEqual(outputs.get(A)[avr?'sketch.ino.hex':'sketch.ino.bin'],outputs.get(B)[avr?'sketch.ino.hex':'sketch.ino.bin']);
 const before=fs.statSync(corrupt),bad=fs.readFileSync(corrupt);bad[0]^=1;fs.writeFileSync(corrupt,bad);fs.utimesSync(corrupt,before.atime,before.mtime);
 await run(true,B,'damaged-core');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);throw error;}
finally{save();client.close();fs.writeFileSync(file,original);fs.writeFileSync(profileFile,profileBytes);console.log('REPORT '+dst);}
