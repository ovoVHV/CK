import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawn} from 'node:child_process';import {packageRoot} from '../src/config.mjs';
const delay=ms=>new Promise(r=>setTimeout(r,ms));
test('cancel reaps child and grandchild before releasing workspace mutex',async()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-v9-job-test-')),config=path.join(dir,'job.json'),cancel=path.join(dir,'cancel'),metrics=path.join(dir,'metrics.json'),pids=path.join(dir,'pids.json');
 const script=path.join(dir,'child.cjs');fs.writeFileSync(script,`const {spawn}=require('node:child_process');const fs=require('node:fs');const child=spawn(process.execPath,['-e','setInterval(()=>{},1000)'],{windowsHide:true,stdio:'ignore'});fs.writeFileSync(process.argv[2],JSON.stringify([process.pid,child.pid]));setInterval(()=>{},1000);`);
 fs.writeFileSync(config,JSON.stringify({argv:[process.execPath,script,pids],cwd:dir,owners:[process.pid],mutex:'Local\\CK-V9-Test-'+path.basename(dir),cancelFile:cancel,metricsFile:metrics}));
 const proc=spawn(path.join(packageRoot,'bin/job.exe'),[config],{windowsHide:true,stdio:['pipe','pipe','pipe']});let stderr='';proc.stderr.on('data',b=>stderr+=b);proc.stdout.resume();const ended=new Promise((res,rej)=>{proc.on('error',rej);proc.on('close',res);});
 try{for(let i=0;i<100&&!fs.existsSync(pids);i++)await delay(50);assert(fs.existsSync(pids),stderr);const ids=JSON.parse(fs.readFileSync(pids));fs.writeFileSync(cancel,'cancel');await ended;const m=JSON.parse(fs.readFileSync(metrics));assert.equal(m.activeProcesses,0);assert.equal(m.reason,'cancel-request');for(const id of ids)assert.throws(()=>process.kill(id,0));}
 finally{if(proc.exitCode===null)proc.kill();fs.rmSync(dir,{recursive:true,force:true});}
});
