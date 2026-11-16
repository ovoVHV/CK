import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import ts from 'typescript';
const compiled=ts.transpileModule(fs.readFileSync(new URL('./build_activity_animation.ts',import.meta.url),'utf8'),{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2020}}).outputText;
const {subscribeBuildActivity}=await import('data:text/javascript;base64,'+Buffer.from(compiled).toString('base64'));

test('toolbar and overlay share a 60 Hz loop, pause, resume and fully clean up',()=>{
 const callbacks=new Map(),listeners=new Map();let id=0;const media={matches:false,addEventListener:(type,fn)=>listeners.set('media',fn),removeEventListener:()=>listeners.delete('media')};
 globalThis.window={matchMedia:()=>media};globalThis.document={hidden:false,addEventListener:(type,fn)=>listeners.set(type,fn),removeEventListener:type=>listeners.delete(type)};
 globalThis.requestAnimationFrame=fn=>{callbacks.set(++id,fn);return id;};globalThis.cancelAnimationFrame=id=>callbacks.delete(id);
 const a=[],b=[],offA=subscribeBuildActivity(phase=>a.push(phase)),offB=subscribeBuildActivity(phase=>b.push(phase));
 assert.equal(callbacks.size,1);
 const frame=time=>{const pending=[...callbacks.values()];callbacks.clear();pending.forEach(fn=>fn(time));};
 const start=performance.now();for(let n=0;n<120;n++)frame(start+n*1000/120);
 assert(a.length>=58&&a.length<=61);assert.deepEqual(a,b);assert.equal(callbacks.size,1);
 document.hidden=true;listeners.get('visibilitychange')();assert.equal(callbacks.size,0);
 document.hidden=false;listeners.get('visibilitychange')();assert.equal(callbacks.size,1);
 media.matches=true;listeners.get('media')();assert.equal(callbacks.size,0);assert.equal(a.at(-1),null);
 media.matches=false;listeners.get('media')();assert.equal(callbacks.size,1);
 offA();assert.equal(callbacks.size,1);offB();assert.equal(callbacks.size,0);assert.equal(listeners.size,0);
});
