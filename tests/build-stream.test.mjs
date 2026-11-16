import test from 'node:test';
import assert from 'node:assert/strict';
import {createBuildStreamReader} from '../src/build-stream.mjs';
import {createActivityReporter,compilerSourceArgument} from '../src/build-activity.mjs';
import {asyncRun} from '../src/discovery.mjs';

test('activity labels the compiler input, excluding forced headers and response files',()=>{
 assert.equal(compilerSourceArgument(['g++','@options.h','-include','build_opt.h','-c','WiFi.cpp','-include','Arduino.h','-o','WiFi.cpp.o']),'WiFi.cpp');
 assert.equal(compilerSourceArgument(['g++','-x','c++-header','-include','build_opt.h','common.hpp','-o','common.hpp.gch']),'common.hpp');
 assert.equal(compilerSourceArgument(['gcc','-I','directory.cpp','-MF','dependencies.h','-c','wiring.c','-o','wiring.c.o']),'wiring.c');
});

test('activity is delivered before final receipt, including split UTF-8 bytes', () => {
 const seen=[],reader=createBuildStreamReader('r',messages=>seen.push(...messages));
 const first=Buffer.from(JSON.stringify({type:'activity',requestId:'r',messages:['对象编译：完成 1/8 · sketch.ino.cpp']})+'\n');
 for(const byte of first)reader.push(Buffer.from([byte]));
 assert.deepEqual(seen,['对象编译：完成 1/8 · sketch.ino.cpp']);
 const receipt={success:true,requestId:'r'};
 reader.push(Buffer.from(JSON.stringify({type:'result',requestId:'r',receipt})+'\n'));
 assert.deepEqual(reader.finish(),receipt);
});

test('activity can never substitute for a result or another request', () => {
 const reader=createBuildStreamReader('r',()=>{});
 reader.push(Buffer.from('{"type":"activity","requestId":"r","messages":["done"]}\n'));
 assert.throws(()=>reader.finish(),/Incomplete/);
 assert.throws(()=>createBuildStreamReader('r',()=>{}).push(Buffer.from('{"type":"result","requestId":"other","receipt":{"success":true}}\n')),/identity/);
 const duplicate=createBuildStreamReader('r',()=>{}),frame=Buffer.from('{"type":"result","requestId":"r","receipt":{}}\n');
 duplicate.push(frame);assert.throws(()=>duplicate.push(frame),/order/);
});

test('reporter batches bursts, bounds pending data, flushes before close and stops', () => {
 let clock=0;const batches=[],reporter=createActivityReporter(rows=>batches.push(rows),{now:()=>clock});
 reporter.push('start');for(let n=0;n<200;n++)reporter.push('task '+n);
 assert.equal(batches.length,1);
 reporter.close();assert.equal(batches.length,2);assert.equal(batches[1].length,64);assert.equal(batches[1].at(-1),'task 199');
 reporter.push('late');assert.equal(batches.length,2);
});

test('executor streams stdout before child exit while preserving captured evidence',async()=>{
 let live=false,returned=false;
 const run=await asyncRun([process.execPath,'-e','console.log("[1/2] COMPILE first.o");setTimeout(()=>console.log("[2/2] COMPILE second.o"),200)'],process.cwd(),{onStdout:text=>{assert.equal(returned,false);if(text.includes('first.o'))live=true;}});
 returned=true;assert(live);assert.equal(run.code,0);assert.match(run.stdout,/first.o[\s\S]*second.o/);
});
