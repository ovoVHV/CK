import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import ts from 'typescript';
import {JSDOM} from 'jsdom';
const load = async name => {
 const src=await readFile(new URL(`./${name}.ts`,import.meta.url),'utf8');
 const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.ESNext,target:ts.ScriptTarget.ES2022}}).outputText;
 return import(`data:text/javascript;base64,${Buffer.from(out).toString('base64')}`);
};
const {createBlocklyEditScheduler}=await load('blockly_edit_scheduler');
function fakeClock(){let now=0,id=0;const tasks=new Map();return {now:()=>now,setTimeout(fn,delay){tasks.set(++id,{at:now+delay,fn});return id;},clearTimeout(key){tasks.delete(key);},advance(ms){const end=now+ms;while(true){const next=[...tasks].sort((a,b)=>a[1].at-b[1].at)[0];if(!next||next[1].at>end)break;now=next[1].at;tasks.delete(next[0]);next[1].fn();}now=end;},get count(){return tasks.size;}};}
test('50,000 grouped changes enqueue one update, without losing the final state',()=>{
 const clock=fakeClock();let model=0,observed=0,calls=0;
 const scheduler=createBlocklyEditScheduler(()=>{observed=model;calls++;},{clock});
 for(let i=1;i<=50000;i++){model=i;scheduler.schedule();}
 assert.equal(clock.count,1);assert.equal(calls,0);clock.advance(160);
 assert.equal(observed,50000);assert.equal(calls,1);assert.equal(scheduler.pending,false);
});
test('continued typing cannot starve the update forever',()=>{
 const clock=fakeClock();let calls=0;const s=createBlocklyEditScheduler(()=>calls++,{clock});
 for(let i=0;i<20;i++){s.schedule();clock.advance(100);}assert.equal(calls,2);
});
test('dragging defers work but explicit snapshot flush is synchronous',()=>{
 const clock=fakeClock();let dragging=true,calls=0;const s=createBlocklyEditScheduler(()=>calls++,{clock,isInteracting:()=>dragging});
 s.schedule();clock.advance(1500);assert.equal(calls,0);s.flush();assert.equal(calls,1);
 s.schedule();clock.advance(200);dragging=false;clock.advance(100);assert.equal(calls,2);
});
test('dispose and cancellation cannot update a replaced workspace',()=>{
 const clock=fakeClock();let calls=0;const s=createBlocklyEditScheduler(()=>calls++,{clock});
 s.schedule();s.cancel();clock.advance(2000);assert.equal(calls,0);
 s.schedule();s.dispose();s.schedule();s.flush();clock.advance(2000);assert.equal(calls,0);assert.equal(clock.count,0);
});
test('flush clears pending before invoking callback so reentrant edits are retained',()=>{
 const clock=fakeClock();let calls=0;const s=createBlocklyEditScheduler(()=>{if(++calls===1)s.schedule();},{clock});
 s.schedule();s.flush();assert.equal(s.pending,true);clock.advance(160);assert.equal(calls,2);
});

const {installBlocklyViewportCulling}=await load('blockly_viewport');
test('viewport culling preserves model/geometry and restores visibility on disposal',()=>{
 const previousRaf=globalThis.requestAnimationFrame,previousCancel=globalThis.cancelAnimationFrame;
    const previousDocument=globalThis.document;
    const dom=new JSDOM('<svg xmlns="http://www.w3.org/2000/svg"><g class="blocklyBlockCanvas"></g></svg>');
    globalThis.document=dom.window.document;
    const svg=document.querySelector('svg'),canvas=document.querySelector('g');
 const frames=new Map();let id=0;
 globalThis.requestAnimationFrame=fn=>{frames.set(++id,fn);return id;};globalThis.cancelAnimationFrame=id=>frames.delete(id);
 try{
  let listener;let left=0,scans=0;const blocks=Array.from({length:2000},(_,i)=>{const root=document.createElementNS(svg.namespaceURI,'g');canvas.appendChild(root);return {id:String(i),root,getSvgRoot(){return this.root;},isDisposed:()=>false,getBoundingRectangle:()=>({left:i*100,right:i*100+50,top:0,bottom:30})};});
  const layers={hasLayer:element=>element===canvas};const originalHasLayer=layers.hasLayer;
  const ws={scale:1,getLayerManager:()=>layers,getCanvas:()=>canvas,getParentSvg:()=>svg,getAllBlocks:()=>{scans++;return blocks;},getTopBlocks:()=>blocks,isDragging:()=>false,getMetricsManager:()=>({getViewMetrics:()=>({left,top:0,width:100,height:100})}),addChangeListener:fn=>listener=fn,removeChangeListener:fn=>{assert.equal(fn,listener);listener=null;}};
  const run=()=>{for(const [key,fn]of [...frames]){frames.delete(key);fn();}};
  const c=installBlocklyViewportCulling(ws,{overscan:0});run();assert.equal(c.stats.culledStacks,1998);assert.equal(scans,1);
  left=5000;listener({type:'viewport_change'});run();assert.equal(scans,1);assert.equal(blocks[50].root.parentNode,canvas);assert.notEqual(blocks[0].root.parentNode,canvas);
  ws.scale=0.3;listener({type:'viewport_change'});run();assert.equal(c.stats.overview,true);assert.equal(c.stats.culledStacks,2000);
  assert.equal(canvas.querySelectorAll('[data-ck-overview-id]').length,2000);
  assert.equal(canvas.querySelectorAll('[data-id]').length,0);
  ws.scale=1;listener({type:'viewport_change'});run();assert.equal(c.stats.overview,false);assert.equal(blocks[50].root.parentNode,canvas);
  c.dispose();assert.equal(listener,null);assert.deepEqual([...canvas.children],blocks.map(b=>b.root));assert.equal(svg.querySelector('[data-ck-viewport-parking]'),null);assert.equal(layers.hasLayer,originalHasLayer);
 }finally{globalThis.requestAnimationFrame=previousRaf;globalThis.cancelAnimationFrame=previousCancel;globalThis.document=previousDocument;dom.window.close();}
});
