import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';

// Run via Start-Preview, on an isolated profile. Both routes use the same
// project, absolute build paths and toolchain. Disable history for edit pairs.
const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const file=process.env.CK_V9_CONFIG,original=fs.readFileSync(file),profile=JSON.parse(original);
const boards=JSON.parse(process.env.CK_ESP_PROOF_BOARDS??'["esp32:esp32:esp32s3","esp32:esp32:esp32c3","esp32:esp32:esp32"]');
const runs=[],out=path.join(cfg.paths.evidenceRoot,'esp-pairs-'+Date.now()+'.json');
const save=status=>fs.writeFileSync(out,JSON.stringify({status,boundary:'desktop compile_sketch IPC through verified export',runs},null,2));
const client=await connectDesktop();
try{
 for(const fqbn of boards){
  const projectId=randomUUID(),artifacts=new Map();
  const A=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8');
  const B=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
  for(const [index,[scenario,ref,source]] of [
    ['first',false,A],['edit',true,B],['repeat',true,B],['repeat',false,B],
    ['edit',false,A],['repeat',false,A],['repeat',true,A],['edit',false,B],
    ['repeat',true,B],['repeat',false,B],['edit',true,A]
  ].entries()){
   fs.writeFileSync(file,JSON.stringify({...profile,historyReference:true,bridgeReference:ref,validationReference:ref}));
   const call=await client.build(source,fqbn,{projectId,workspaceFingerprint:digest(source)});
   const row={fqbn,index,scenario,route:ref?'reference':'candidate',ms:call.wallMs,success:call.success};
   runs.push(row);save('RUNNING');assert.ok(call.success,call.error);
   const res=JSON.parse(call.value),host=JSON.parse(fs.readFileSync(path.join(res.path,'native-graph-host-receipt.json'))),w=host.worker;
   validateArtifacts(w.artifacts,fqbn);
   row.transport=host.adapterPhases.transport;row.phases=w.phases;row.counts=w.counts;row.bundle=w.noOpFastPath?.validationTransport;
   assert.equal(row.transport,ref?'node-bridge':'host-loopback');assert.equal(w.fqbn,fqbn);
   assert.equal(w.assetProof.sha256,w.postAssetProof.sha256);
   const hashes=Object.fromEntries(w.artifacts.map(a=>{const hash=digest(fs.readFileSync(path.join(res.path,a.name)));assert.equal(hash,a.sha256);return [a.name,hash];}));
   if(artifacts.has(source))assert.deepEqual(hashes,artifacts.get(source));
   else{if(artifacts.size)assert.notEqual(artifacts.get(A)['sketch.ino.bin'],hashes['sketch.ino.bin']);artifacts.set(source,hashes);}
   if(scenario==='repeat'){
    assert.ok(w.noOpFastPath.hit);
    for(const k of ['CompileGCC','Linker','ImageGenerator','PrototypeGCC','DiscoveryGCC'])assert.equal(w.counts[k],0);
    assert.equal(row.bundle,ref?undefined:'single-process-three-full-scans');
   }else if(scenario==='edit'){assert.equal(w.counts.CompileGCC,1);assert.equal(w.counts.Linker,1);}
   else assert.ok(w.counts.CompileGCC>1);
   save('RUNNING');console.log(JSON.stringify({fqbn,index,scenario,ref,ms:call.wallMs}));
  }
 }
 save('PASS');
}catch(error){save('FAIL');throw error;}finally{fs.writeFileSync(file,original);client.close();console.log('REPORT '+out);}
