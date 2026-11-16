import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {executeBatch} from '../src/direct-executor.mjs';
import {spawn} from 'node:child_process';
import {packageRoot} from '../src/config.mjs';
test('failed direct batch drains running tasks and does not start queued tasks',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-direct-test-'));
 const rule=(name,code)=>({name,kind:'compile',argv:[process.execPath,'-e',code],directory:dir,output:path.join(dir,name)});
 try{
  const fail=rule('fail','setTimeout(()=>process.exit(7),50)'),running=rule('running','setTimeout(()=>require("fs").writeFileSync("running","done"),250)'),queued=rule('queued','require("fs").writeFileSync("queued","bad")');
  await assert.rejects(executeBatch([fail,running],2),/failed/);
  assert.equal(fs.readFileSync(running.output,'utf8'),'done');
  // A queued task must not start after an observed failure. Do not assume
  // relative child startup times under concurrent compiler/antivirus load.
  await assert.rejects(executeBatch([fail,queued],1),/failed/);assert(!fs.existsSync(queued.output));
  await assert.rejects(executeBatch([rule('missing','process.exit(0)')],1),/did not produce/);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('direct archive publishes only a successful temporary output; size failure rejects',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-direct-archive-'));
 try{
  const output=path.join(dir,'core.a'),temporary=output+'.tmp';fs.writeFileSync(temporary,'stale');
  const rule={name:'archive',kind:'archive',directory:dir,argv:[process.execPath,'-e','require("fs").writeFileSync("core.a.tmp","valid")'],output,archiveTemporary:temporary,archiveOutput:output};
  const r=await executeBatch([rule],1);assert.equal(r.results[0].exitCode,0);assert.equal(fs.readFileSync(output,'utf8'),'valid');assert(!fs.existsSync(temporary));
  const size={name:'size',kind:'metadata',directory:dir,argv:[process.execPath,'-e','console.log(".text 100\\n.data 2")'],output:path.join(dir,'size.json'),sizeOutput:path.join(dir,'size.json'),sizePolicy:{flashRegex:'^\\.text (\\d+)',ramRegex:'^\\.data (\\d+)',flashLimit:50,ramLimit:10}};
  await assert.rejects(executeBatch([size],1),/exceeds/);assert(!fs.existsSync(size.output));
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
});
test('Job cancellation drains a directly scheduled tool and its child',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-direct-cancel-')),cancel=path.join(dir,'cancel'),metrics=path.join(dir,'metrics.json'),pids=path.join(dir,'pids.json'),job=path.join(dir,'job.json');
 const tool=path.join(dir,'tool.cjs'),worker=path.join(dir,'worker.mjs');
 fs.writeFileSync(tool,'const {spawn}=require("node:child_process");const child=spawn(process.execPath,["-e","setInterval(()=>{},1000)"],{windowsHide:true,stdio:"ignore"});require("fs").writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);');
 fs.writeFileSync(worker,`import {executeBatch} from ${JSON.stringify(new URL('../src/direct-executor.mjs',import.meta.url).href)};await executeBatch(${JSON.stringify([{name:'fake-compiler',kind:'compile',argv:[process.execPath,tool,pids],directory:dir,output:path.join(dir,'absent.o')}])},1);`);
 fs.writeFileSync(job,JSON.stringify({argv:[process.execPath,worker],cwd:dir,owners:[process.pid],cancelFile:cancel,metricsFile:metrics}));
 const proc=spawn(path.join(packageRoot,'bin/job.exe'),[job],{windowsHide:true,stdio:['pipe','pipe','pipe']});let error='';proc.stderr.on('data',b=>error+=b);proc.stdout.resume();const exited=new Promise((resolve,reject)=>{proc.once('error',reject);proc.once('close',resolve);});
 try{
  for(let i=0;i<200&&!fs.existsSync(pids);i++)await new Promise(r=>setTimeout(r,50));assert(fs.existsSync(pids),error);
  const ids=JSON.parse(fs.readFileSync(pids));fs.writeFileSync(cancel,'cancel');await exited;
  assert.equal(JSON.parse(fs.readFileSync(metrics)).activeProcesses,0);for(const id of ids)assert.throws(()=>process.kill(id,0));
 }finally{if(proc.exitCode===null){fs.writeFileSync(cancel,'cancel');await exited;}fs.rmSync(dir,{recursive:true,force:true});}
});
