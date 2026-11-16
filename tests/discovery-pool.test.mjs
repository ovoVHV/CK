import test from 'node:test';import assert from 'node:assert/strict';import {DiscoveryPool} from '../src/native/discovery-pool.mjs';
test('discovery and Core share one bounded queue, with probes first and failures draining',async()=>{
 const pool=new DiscoveryPool(2),order=[],gates=[];let active=0,peak=0;
 const task=name=>async()=>{active++;peak=Math.max(peak,active);order.push(name);await new Promise(r=>gates.push(r));active--;if(name==='failed')throw Error('expected');return name;};
 const tasks=[pool.run(1,task('core-a')),pool.run(1,task('core-b')),pool.run(0,task('probe')),pool.run(1,task('failed'))];
 const results=Promise.allSettled(tasks);await new Promise(r=>setImmediate(r));assert.deepEqual(order,['probe','core-a']);assert.equal(peak,2);
 gates.shift()();gates.shift()();await new Promise(r=>setImmediate(r));assert.deepEqual(order,['probe','core-a','core-b','failed']);assert.equal(peak,2);
 gates.shift()();gates.shift()();const done=await results;assert.equal(done.filter(x=>x.status==='rejected').length,1);assert.equal(active,0);assert.equal(await pool.run(0,()=>42),42);
});
test('released compiler slots start queued work before synchronous receipt consumers',async()=>{
 const pool=new DiscoveryPool(1);pool.eagerRelease=true;const order=[];let release;
 const a=pool.run(0,()=>{order.push('a-start');return new Promise(resolve=>release=resolve);});
 const b=pool.run(0,()=>{order.push('b-start');return 2;});a.then(()=>order.push('a-observe'));
 await new Promise(r=>setImmediate(r));release(1);await Promise.all([a,b]);
 assert.deepEqual(order,['a-start','b-start','a-observe']);
 await assert.rejects(pool.run(0,()=>{throw Error('sync failure');}));assert.equal(await pool.run(0,()=>3),3);
});
