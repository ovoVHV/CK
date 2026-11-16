import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const here=path.dirname(fileURLToPath(import.meta.url)),directory=path.resolve(here,'../../node_modules/.cache/ai-library-host-tests');
fs.mkdirSync(directory,{recursive:true});
const output=path.join(directory,'host.mjs');
await build({entryPoints:[path.join(here,'ai_library_host.ts')],outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent',plugins:[{name:'native-test',setup(b){
 b.onResolve({filter:/^(?:@tauri-apps\/api\/core|@tauri-apps\/plugin-dialog|\.\/ai_candidate)$/},args=>({path:args.path,namespace:'fixture'}));
 b.onLoad({filter:/.*/,namespace:'fixture'},args=>({contents:args.path.includes('plugin-dialog')?'export const save=(...a)=>globalThis.__librarySave(...a)':args.path==='./ai_candidate'?'export const compileAiSource=(...a)=>globalThis.__libraryCompile(...a)':'export const invoke=(...a)=>globalThis.__libraryInvoke(...a)',loader:'js'}));
}}]});
const {createAiLibraryHost}=await import(pathToFileURL(output));
const preview={token:'token',packageId:'unique-package',types:['unique-block']};
function fixture({native=()=>{},reload=()=>{}}={}){
 const events=[],controller=new AbortController();
 globalThis.__libraryInvoke=async(name,args)=>{events.push([name,args]);return native(name,args,controller);};
 const host=createAiLibraryHost({target:()=>({}),reload:async(p,verify)=>{events.push(['reload',verify]);return reload(p,verify,controller);}});
 return {events,controller,host,install:()=>host.install(preview,controller.signal,()=>{})};
}
test('installation commits only after runtime and catalog verification',async()=>{
 const f=fixture();await f.install();assert.deepEqual(f.events,[['ai_install_library',{token:'token'}],['reload',true],['ai_finish_library',{token:'token',loaded:true}]]);
});
test('load rejection rolls back disk then refreshes the catalog',async()=>{
 const f=fixture({reload:(_p,verify)=>{if(verify)throw Error('registration rejected');}});await assert.rejects(f.install(),/registration rejected/);assert.deepEqual(f.events.slice(-2),[['ai_finish_library',{token:'token',loaded:false}],['reload',false]]);
});
test('cancellation after native installation rolls back before activation',async()=>{
 const f=fixture({native:(name,_args,c)=>{if(name==='ai_install_library')c.abort();}});await assert.rejects(f.install(),{name:'AbortError'});assert.deepEqual(f.events.slice(1),[['ai_finish_library',{token:'token',loaded:false}],['reload',false]]);
});
test('cancellation while loading rolls back instead of committing',async()=>{
 const f=fixture({reload:(_p,verify,c)=>{if(verify)c.abort();}});await assert.rejects(f.install(),{name:'AbortError'});assert(!f.events.some(([n,a])=>n==='ai_finish_library'&&a.loaded));assert.equal(f.events.at(-1)[1],false);
});
test('a successful native commit is retained when cancellation arrives with the reply',async()=>{
 const f=fixture({native:(name,args,c)=>{if(name==='ai_finish_library'&&args.loaded)c.abort();}});await f.install();assert(f.controller.signal.aborted);assert(!f.events.some(([n,a])=>n==='ai_finish_library'&&a.loaded===false));
});
test('an already canceled request starts no native installation',async()=>{
 const f=fixture();f.controller.abort();await assert.rejects(f.install(),{name:'AbortError'});assert.equal(f.events.length,0);
});
test('native finalization failure invokes rollback and preserves its error',async()=>{
 const f=fixture({native:(name,args)=>{if(name==='ai_finish_library'&&args.loaded)throw Error('commit refused');}});await assert.rejects(f.install(),/commit refused/);assert.deepEqual(f.events.slice(-2),[['ai_finish_library',{token:'token',loaded:false}],['reload',false]]);
});

test('project changes during runtime reload roll back before the native commit point',async()=>{
 let current=true;const f=fixture({reload:(_p,verify)=>{if(verify)current=false;}});
 await assert.rejects(f.host.install(preview,f.controller.signal,()=>{},()=>{if(!current)throw Error('project changed');}),/project changed/);
 assert(!f.events.some(([n,a])=>n==='ai_finish_library'&&a.loaded));
 assert.deepEqual(f.events.slice(-2),[['ai_finish_library',{token:'token',loaded:false}],['reload',false]]);
});
