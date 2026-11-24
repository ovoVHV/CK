// Real Uno toolchain: returning to the same sketch must not revive a graph
// after a library changed, a build failed, or a clean build was requested.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const [engine,configFile,dir]=process.argv.slice(2),root=path.resolve(dir);
if(fs.existsSync(root))throw Error('Fresh directory required');
fs.mkdirSync(root,{recursive:true});
const load=name=>import(pathToFileURL(path.resolve(engine,'src',name+'.mjs')).href);
const {BuildController}=await load('controller'),{validateConfig}=await load('config');
const t=JSON.parse(fs.readFileSync(configFile)),workspaceRoot=path.join(root,'sessions'),evidenceRoot=path.join(root,'evidence');
fs.mkdirSync(evidenceRoot);
const cfg=validateConfig({...t,paths:{...t.paths,workspaceRoot,evidenceRoot}}),controller=new BuildController(cfg);
const workspace=path.join(workspaceRoot,'project'),lib=path.join(root,'Fixture'),src=path.join(lib,'src');
fs.mkdirSync(src,{recursive:true});fs.writeFileSync(path.join(lib,'library.properties'),'name=Fixture\nversion=1.0.0\narchitectures=avr\n');
const header=path.join(src,'Fixture.h'),value=n=>'#pragma once\n#define FIXTURE_VALUE '+n+'\n';
fs.writeFileSync(header,value(3));
const a='#include <Fixture.h>\nvoid setup(){}\nvoid loop(){digitalWrite(7,FIXTURE_VALUE);delay(FIXTURE_VALUE);}\n';
const b='#include <SPI.h>\n'+a.replace('void setup(){}','void setup(){SPI.begin();}');
const hash=x=>createHash('sha256').update(x).digest('hex');
const report={status:'RUNNING',rows:[]};
async function build(id,source,options={}){
 const sourceSha256=hash(source),res=await controller.submit({protocolVersion:1,source,request:{requestId:id,sourceSha256,
  fqbn:'arduino:avr:uno',workspace,sketchDir:path.join(workspace,'source/sketch'),sysroot:cfg.paths.sysroot,libraries:[lib],...options}});
 const row={id,success:res.success,graph:res.graphReuse,firmware:null};report.rows.push(row);
 if(res.success){assert.equal(res.assetProof.sha256,res.postAssetProof.sha256);
  for(const art of res.artifacts){assert.equal(hash(fs.readFileSync(art.file)),art.sha256);if(art.name==='sketch.ino.hex')row.firmware=art.sha256;}
  await controller.acknowledge(id,{sourceSha256,success:true});
 }else assert.deepEqual(res.artifacts,[]);
 return row;
}
try{
 const first=await build('A',a);assert.ok(first.firmware);assert.ok((await build('B',b)).success);
 const back=await build('back',a);assert.equal(back.graph.reason,'live-session-exact-graph-history');assert.equal(back.firmware,first.firmware);
 const st=fs.statSync(header);fs.writeFileSync(header,value(7));fs.utimesSync(header,st.atime,st.mtime);
 const changed=await build('changed',b);assert.equal(changed.graph.hit,false);
 const rebuilt=await build('rebuilt',a);assert.equal(rebuilt.graph.hit,false);assert.notEqual(rebuilt.firmware,first.firmware);
 assert.equal((await build('error',b.replace('SPI.begin();','missing_function();'))).success,false);
 assert.equal((await build('after-error',a)).graph.hit,false);
 assert.equal((await build('clean',b,{forceClean:true})).graph.hit,false);
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);throw e;}
finally{await controller.close();fs.writeFileSync(path.join(root,'invalidation.json'),JSON.stringify(report,null,2));}
