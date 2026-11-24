import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';
import {editorBuilder} from './core-rediscovery-button.mjs';
import {digest,validateArtifacts} from '../src/protocol.mjs';
import {parseFqbn} from '../src/targets.mjs';
import {verifyMergedApp} from './merged-app-proof.mjs';

const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG));
const board=process.env.CK_AB_BOARD, avr=board?.startsWith('arduino:avr:');
assert.ok(parseFqbn(board)&&board.split(':').length===3,'Expected a base AVR or ESP32 board');
const sources=avr?[
 '#include <Wire.h>\nvoid setup(){Wire.begin();}\nvoid loop(){delay(331);}\n',
 '#include <Wire.h>\nvoid setup(){Wire.begin();}\nvoid loop(){Wire.beginTransmission(42);Wire.write(7);Wire.endTransmission();delay(331);}\n'
]:[
 '#include <WiFi.h>\nvoid setup(){\n  WiFi.begin("MyWiFi", "12345678");\n  WiFi.mode(WIFI_STA);\n}\nvoid loop(){}\n',
 '#include <WiFi.h>\nvoid setup(){\n  Serial.begin(115200);\n  WiFi.begin("MyWiFi", "12345678");\n  WiFi.mode(WIFI_STA);\n}\nvoid loop(){\n  while (WiFi.status() != WL_CONNECTED) { delay(500); Serial.print("."); }\n  Serial.println("\\nWiFi Connected!");\n}\n'
];
const evidence=config.paths.evidenceRoot, out=path.join(evidence,'timings.json');
const repeatCount=Number(process.env.CK_AB_REPEAT_COUNT??1);
assert.ok(Number.isInteger(repeatCount)&&repeatCount>=1&&repeatCount<=50);
const edits=Number(process.env.CK_AB_NEW_EDITS??0), histories=Number(process.env.CK_AB_HISTORY??0);
const offset=Number(process.env.CK_AB_EDIT_OFFSET??0);
assert.ok([edits,histories,offset].every(n=>Number.isSafeInteger(n)&&n>=0)&&edits<=30&&histories<=20);
const plan=[{scenario:'cold',source:sources[0]},{scenario:'edit',source:sources[1]},
 ...Array.from({length:repeatCount},()=>({scenario:'repeat',source:sources[1]})),
 ...Array.from({length:edits},(_,i)=>({scenario:'edit',source:sources[1].replace(avr?'Wire.write(7)':'delay(500)',avr?`Wire.write(${8+offset+i})`:`delay(${501+offset+i})`)})),
 ...Array.from({length:histories},(_,i)=>({scenario:'history',source:sources[i%2]}))];
if(process.env.CK_AB_REDISCOVERY==='1'){
 const extra='#include <SPI.h>\n'+sources[1].replace('void setup(){','void setup(){SPI.begin();');
 sources.push(extra);
 for(let i=0;i<2;i++)plan.push({scenario:'add-library',source:extra},{scenario:'remove-library',source:sources[1]});
}
const report={version:config.engineVersion,route:process.env.CK_AB_ROUTE,board,jobs:config.limits.jobs,sources,rows:[],boundary:'Desktop compile button click to progress overlay closed and button enabled; fresh CK workspace, OS cache uncontrolled'};
const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
const client=await connectDesktop();
try{
 const build=await editorBuilder(client,config,board);
 const outputs=new Map();let previousFirmware;
 for(const {scenario,source:expected} of plan){
  const call=await build(scenario==='repeat'?undefined:expected);
  const dir=JSON.parse(call.value).path,receiptFile=path.join(dir,'native-graph-host-receipt.json');
  const host=JSON.parse(fs.readFileSync(receiptFile)),w=host.worker,c=w.counts;
  const row={scenario,requestId:host.requestId,ms:call.wallMs,source:w.sourceSha256,counts:c,phases:w.phases,stageTimings:w.stageTimings,
   noOp:w.noOpFastPath?.hit===true,graph:w.graphReuse,asset:w.assetProof.sha256,artifacts:{},
   workerWallMs:w.wallMs,hostWallMs:host.endToEndMs,hostPhases:host.adapterPhases,discovery:w.coldDiscovery??null,bootloader:w.bootloaderPreparation??null};report.rows.push(row);save();
  assert.equal(w.sourceSha256,digest(expected));assert.equal(w.fqbn.split(':').slice(0,3).join(':'),board);assert.equal(host.adapterPhases.transport,'host-loopback');
  report.effectiveFqbn??=w.fqbn;assert.equal(w.fqbn,report.effectiveFqbn);
  validateArtifacts(w.artifacts,board);assert.equal(w.assetProof.sha256,w.postAssetProof.sha256);
  assert.equal(row.asset,report.rows[0].asset);
  for(const a of w.artifacts){const sha=digest(fs.readFileSync(path.join(dir,a.name)));assert.equal(sha,a.sha256);row.artifacts[a.name]=sha;}
  if(!avr)row.verifiedMergedApp=verifyMergedApp(fs.readFileSync(path.join(dir,'flash_args'),'utf8'),
   fs.readFileSync(path.join(dir,'sketch.ino.bin')),fs.readFileSync(path.join(dir,'sketch.ino.merged.bin')));
  assert.equal(row.noOp,scenario==='repeat');
  const rediscovery=scenario.endsWith('-library');
  if(scenario!=='history'&&!rediscovery)assert.equal(c.ObjectRestored,0);
  if(scenario==='cold'){assert.equal(w.graphReuse.hit,false);assert.equal(c.ObjectRetained,0);assert.ok(c.CompileGCC>1);assert.equal(c.Linker,1);}
  const firmware=row.artifacts[avr?'sketch.ino.hex':'sketch.ino.bin'];assert.ok(firmware);
  if(rediscovery){
   const graphHistory=process.env.CK_AB_GRAPH_HISTORY==='1'&&process.env.CK_AB_ROUTE==='candidate'&&outputs.has(expected);
   assert.equal(w.graphReuse.hit,graphHistory);assert.equal(w.officialFrontendInvoked,false);
   if(graphHistory){assert.equal(w.graphReuse.reason,'live-session-exact-graph-history');assert.equal(c.DiscoveryGCC,0);assert.equal(c.CompileGCC,0);assert.equal(c.Linker,0);}
   assert.equal(w.selectedLibraries.some(l=>l.name==='SPI'),scenario==='add-library');
   if(outputs.has(expected))assert.deepEqual(row.artifacts,outputs.get(expected));else assert.notEqual(firmware,previousFirmware);
   if(!avr&&!graphHistory&&process.env.CK_AB_ROUTE==='candidate')assert.equal(w.bootloaderPreparation?.reused,true);
  }
  if(scenario==='edit'){assert.ok(!outputs.has(expected));assert.equal(w.graphReuse.hit,true);assert.equal(c.DiscoveryGCC,0);assert.equal(c.CompileGCC,1);assert.equal(c.Linker,1);assert.ok(c.ObjectRetained>0);
   assert.notEqual(firmware,previousFirmware);}
  if(scenario==='repeat'||scenario==='history'){
   for(const key of ['DiscoveryGCC','CompileGCC','PchGCC','Linker','ImageGenerator',...(scenario==='repeat'?['PrototypeGCC']:[])])assert.equal(c[key],0,key);
   assert.deepEqual(row.artifacts,outputs.get(expected));
   if(scenario==='history'){assert.ok(c.ObjectRestored>0&&c.LinkRestored>0);row.verifiedHistory=true;}
  }
  outputs.set(expected,row.artifacts);previousFirmware=firmware;
  row.verified=true;save();console.log(`${board} ${report.version} ${scenario}: ${(row.ms/1000).toFixed(2)} s, GCC ${c.CompileGCC}, linker ${c.Linker}`);
  if(process.env.CK_AB_COMPACT_EXPORTS==='1'){
   // This harness owns the newly launched session. Its request export has
   // already been read and checked; preserve receipts and all session inputs.
   const expectedDir=path.join(path.dirname(config.paths.workspaceRoot),'requests',host.requestId,'artifacts','sketch');
   assert.equal(path.resolve(dir),path.resolve(expectedDir));
   for(const name of Object.keys(row.artifacts)){assert.equal(name,path.basename(name));fs.unlinkSync(path.join(dir,name));}
  }
 }
 report.status='PASS';
}catch(err){report.status='FAIL';report.error=String(err.stack);throw err;}
finally{client.close();save();}
