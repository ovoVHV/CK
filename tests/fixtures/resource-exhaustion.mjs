import {mock} from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import * as discovery from '../../src/discovery.mjs';
import * as targets from '../../src/targets.mjs';
import * as qualification from '../../src/qualification.mjs';
const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-resource-failure-'));
let officialCalls=0;
// Inject a native tool failure at the discovery boundary. No disk is filled
// and no compiler is launched; the real BuildSession catch/authority path runs.
mock.module('../../src/discovery.mjs',{namedExports:{...discovery,
 clearBuild(){},run(){throw new discovery.NeedsOfficial('fatal error: error writing temp.s: No space left on device');},
 asyncRun(){officialCalls++;throw Error('Official fallback must never run');}
}});
mock.module('../../src/targets.mjs',{namedExports:{...targets,targetAssetRoots:()=>[]}});
mock.module('../../src/qualification.mjs',{namedExports:{...qualification,requestScope:()=>({qualified:true})}});
mock.module('../../src/asset-engine.mjs',{namedExports:{outputSummary:()=>{throw Error('Failed build must not summarize outputs');},validateAssets:()=>({sha256:'test-content-proof',elapsedMs:0,roots:[]}),validateSummary:()=>{throw Error('Failed build must not certify outputs');},verifyRepeat:()=>{throw Error('Cold build must not use a repeat proof');}}});
try{
 const {BuildSession}=await import('../../src/engine.mjs');
 fs.mkdirSync(path.join(dir,'sketch'));fs.writeFileSync(path.join(dir,'sketch/sketch.ino'),'void setup() {}\nvoid loop() {}\n');
 const session=new BuildSession(),id=session.id;
 await assert.rejects(session.build({sysroot:dir,sketchDir:path.join(dir,'sketch'),workspace:path.join(dir,'workspace'),evidence:path.join(dir,'evidence'),assetRoots:[],fqbn:'arduino:avr:uno',features:{independentDiscovery:true,noOpFastPath:true}}),error=>error.code==='RESOURCE_EXHAUSTED'&&error.fallbackSafe===false);
 assert.equal(officialCalls,0);assert.notEqual(session.id,id,'failure expires session authority');
 const receipt=JSON.parse(fs.readFileSync(path.join(dir,'evidence/run.receipt.json')));
 assert.equal(receipt.success,false);assert.equal(receipt.errorCode,'RESOURCE_EXHAUSTED');assert(receipt.wallMs>=0);
}finally{mock.restoreAll();fs.rmSync(dir,{recursive:true,force:true});}
