// Same desktop, workspace, source, asset roots and complete host verification.
// Toggle only the No-Op request option through the leased controller protocol
// for component measurements; desktop end-to-end samples follow separately.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';import {digest} from '../src/protocol.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG)),profile=JSON.parse(fs.readFileSync(process.env.CK_V9_CONFIG));
const A=fs.readFileSync(new URL('./wifi.ino',import.meta.url),'utf8'),report={boundary:'real desktop IPC No-Op capability toggle, full host verification',samples:[],checks:[]};
const file=path.join(config.paths.evidenceRoot,'g1-desktop-ab.json'),save=()=>fs.writeFileSync(file,JSON.stringify(report,null,2));let desktop;
try{
 desktop=await connectDesktop();
 const seed=await desktop.build(A,(config.allowedFqbns[0].endsWith(':*')?'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB':config.allowedFqbns[0]));assert(seed.success,seed.error);
 for(let round=0;round<5;round++)for(const enabled of round%2?[true,false]:[false,true]){
  fs.writeFileSync(process.env.CK_V9_CONFIG,JSON.stringify({...profile,validationReference:!enabled}));
  const r=await desktop.build(A,(config.allowedFqbns[0].endsWith(':*')?'esp32:esp32:esp32s3:FlashSize=16M,PartitionScheme=app3M_fat9M_16MB':config.allowedFqbns[0]));assert(r.success,r.error);
  const directory=JSON.parse(r.value).path,host=JSON.parse(fs.readFileSync(path.join(directory,'native-graph-host-receipt.json'))),receipt=host.worker;
  for(const a of receipt.artifacts)assert.equal(digest(fs.readFileSync(path.join(directory,a.name))),a.sha256);
  assert.equal(receipt.counts.CompileGCC,0);assert.equal(receipt.counts.Linker,0);
  assert(receipt.noOpFastPath?.hit);assert.equal(receipt.assetProof.workers,enabled?8:4);assert.equal(receipt.assetProof.bufferBytes,enabled?262144:1048576);
  report.samples.push({round,enabled,wallMs:r.wallMs,host});save();console.log(JSON.stringify({round,enabled,wallMs:r.wallMs,phases:receipt.phases}));
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;console.error(e);}finally{fs.writeFileSync(process.env.CK_V9_CONFIG,JSON.stringify(profile));save();desktop?.close();}
