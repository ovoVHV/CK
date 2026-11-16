import test from 'node:test';
import assert from 'node:assert/strict';
import {LazyBuildController} from '../src/lazy-controller.mjs';

test('missing Core at startup does not permanently disable later builds in the same session',async()=>{
 let installed=false,created=0,executed=0,closed=0;const statuses=[];
 const config={paths:{sysroot:'C:/test/assets',workspaceRoot:'C:/test/build'}};
 const c=new LazyBuildController(()=>{if(!installed)throw Error('A supported Core is not installed');return config;},{
  desktopPid:42,onStatus:s=>statuses.push(s),create:(cfg,options)=>{created++;assert.equal(options.desktopPid,42);return {config:cfg,submit:async message=>{executed++;return message;},acknowledge:async()=>true,cancel:async()=>true,close:async()=>{closed++;}};}
 });
 assert.equal(created,0);
 await assert.rejects(c.submit('before'),e=>e.code==='NOT_QUALIFIED'&&e.fallbackSafe===true);
 assert.equal(created,0);assert.equal(executed,0);
 installed=true;
 assert.deepEqual(await Promise.all([c.submit('first'),c.submit('second')]),['first','second']);
 assert.equal(created,1);assert.equal(executed,2);assert.equal(c.readinessError,null);
 // Core removal is observed before dispatch; reinstall retries the same session.
 installed=false;await assert.rejects(c.submit('removed'),e=>e.fallbackSafe===true);assert.equal(executed,2);
 installed=true;await c.submit('reinstalled');assert.equal(executed,3);assert.equal(created,1);assert.equal(c.readinessError,null);
 await c.acknowledge('first');await c.cancel('second');await c.close();assert.equal(closed,1);
 await assert.rejects(c.submit('after-close'),e=>e.code==='CLOSED');
 assert.deepEqual(statuses.map(s=>s.ready),[false,true,false,true]);
});

test('never crosses session roots or dispatches after close',async()=>{
 let root='C:/original';let executed=0;
 const c=new LazyBuildController(()=>({paths:{sysroot:root}}),{create:config=>({config,submit:async()=>{executed++;},close:async()=>{}})});
 await c.submit({});root='D:/different';await assert.rejects(c.submit({}),e=>e.code==='NOT_QUALIFIED'&&e.fallbackSafe);assert.equal(executed,1);await c.close();
 const empty=new LazyBuildController(()=>{throw Error('must not load during close');});await empty.cancel('unknown');await empty.close();await assert.rejects(empty.submit({}),e=>e.code==='CLOSED');
});
