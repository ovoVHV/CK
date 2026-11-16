import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import net from 'node:net';
import {spawn} from 'node:child_process';
import {randomBytes} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {ENGINE_VERSION} from '../src/version.mjs';

test('authenticated service starts without Core assets and keeps the configured evidence destination',async t=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-readiness-'));
 const evidence=path.join(dir,'custom-evidence'),config=path.join(dir,'engine.json'),profile=path.join(dir,'host.json');
 const socket=net.createServer();await new Promise(r=>socket.listen(0,'127.0.0.1',r));const port=socket.address().port;await new Promise(r=>socket.close(r));
 const token=randomBytes(32).toString('hex');
 // Deliberately incomplete environment; startup must not validate Core assets.
 fs.writeFileSync(config,JSON.stringify({schemaVersion:1,engineVersion:ENGINE_VERSION,paths:{evidenceRoot:evidence}}));
 fs.writeFileSync(profile,JSON.stringify({token,port}));
 const child=spawn(process.execPath,[fileURLToPath(new URL('../src/server.mjs',import.meta.url)),'--config',config,'--profile',profile,'--desktop-pid',String(process.pid)],{windowsHide:true,stdio:['ignore','pipe','pipe']});
 let stderr='';child.stderr.on('data',b=>stderr+=b);const exited=new Promise(r=>child.once('exit',r));
 t.after(async()=>{child.kill();await exited;assert(path.basename(dir).startsWith('ck-readiness-'));fs.rmSync(dir,{recursive:true,force:true});});
 const url=`http://127.0.0.1:${port}`,headers={authorization:'Bearer '+token};let health;
 for(let i=0;i<80;i++){try{health=await(await fetch(url+'/health',{headers})).json();break;}catch{}if(child.exitCode!==null)throw Error(stderr);await new Promise(r=>setTimeout(r,50));}
 assert.equal(health?.engineVersion,ENGINE_VERSION,stderr);assert.equal(health.initialized,false);
 assert(fs.existsSync(path.join(evidence,'server-ready.json')));
 const denied=await fetch(url+'/health');assert.equal(denied.status,400);
 const response=await fetch(url+'/build',{method:'POST',headers:{...headers,'Content-Type':'application/json'},body:JSON.stringify({request:{requestId:'missing-assets'}})});
 const result=await response.json();assert.equal(result.success,false);assert.match(JSON.stringify(result),/NOT_QUALIFIED/);
 assert.equal(JSON.parse(fs.readFileSync(path.join(evidence,'readiness.json'))).ready,false);
 assert(!fs.existsSync(path.join(evidence,'jobs')));
});
