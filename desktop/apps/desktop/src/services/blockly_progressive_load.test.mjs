import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const Blockly=require('blockly');require('blockly/blocks');
const src=await readFile(new URL('./blockly_progressive_load.ts',import.meta.url),'utf8');
const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};
new Function('require','module','exports',out)(require,module,module.exports);
const {loadBlocklyWorkspaceProgressively,countSerializedBlocks}=module.exports;
const fixture=()=>({variables:[{name:'counter',id:'stable-variable'}],blocks:{languageVersion:0,blocks:[
 {type:'variables_set',id:'setter',x:10,y:10,fields:{VAR:{id:'stable-variable'}},inputs:{VALUE:{block:{type:'math_number',id:'value',fields:{NUM:13}}}}},
 ...Array.from({length:1998},(_,i)=>({type:'math_number',id:`number-${i}`,x:i*20,y:100,fields:{NUM:i},collapsed:i===1,enabled:i!==2,data:i===3?'custom-data':undefined})),
 ]},ckLoadMetadata:{evidence:'retain-me'}});
function workspace(){const ws=new Blockly.Workspace();ws.setResizesEnabled=value=>{ws.resizeEnabled=value;};return ws;}

test('progressive load equals official load: IDs, values, variables, custom serializers and metadata',async()=>{
 const actual=workspace(),expected=workspace();const metadata=new WeakMap();
 Blockly.serialization.registry.register('ckLoadMetadata',{priority:20,save:ws=>metadata.get(ws),load:(state,ws)=>metadata.set(ws,state),clear:ws=>metadata.delete(ws)});
 let slices=0,staged=0;
 try{
  const state=fixture();assert.equal(countSerializedBlocks(state),2000);
  Blockly.serialization.workspaces.load(state,expected);
  await loadBlocklyWorkspaceProgressively(state,actual,{stageStack:()=>staged++,yieldToHost:async()=>{slices++;assert.equal(Blockly.Events.isEnabled(),true);assert.equal(Blockly.Events.getRecordUndo(),true);}});
  assert.equal(staged,1999);assert.equal(slices,staged);
  assert.deepEqual(Blockly.serialization.workspaces.save(actual),Blockly.serialization.workspaces.save(expected));
  assert.equal(actual.resizeEnabled,true);assert.equal(actual.undoStack_.length,0);
 }finally{actual.dispose();expected.dispose();Blockly.serialization.registry.unregister('ckLoadMetadata');}
});

test('cancel checks each yield and restores events, undo, cache and resize state',async()=>{
 const ws=workspace(),controller=new AbortController();let slices=0;
 try{
  await assert.rejects(loadBlocklyWorkspaceProgressively(fixture(),ws,{signal:controller.signal,yieldToHost:async()=>{if(++slices===3)controller.abort();}}),{name:'AbortError'});
  assert.equal(slices,3);assert(ws.getAllBlocks(false).length<2000);
  assert.equal(Blockly.Events.isEnabled(),true);assert.equal(Blockly.Events.getRecordUndo(),true);assert.equal(ws.resizeEnabled,true);
 }finally{ws.dispose();}
});

test('custom block serializer uses the official workspace path, never bypasses extension load',async()=>{
 const ws=workspace();const original=Blockly.registry.getAllItems(Blockly.registry.Type.SERIALIZER,true).blocks;
 let called=0;class CustomSerializer extends Blockly.serialization.blocks.BlockSerializer{load(state,ws){called++;return super.load(state,ws);}}
 Blockly.serialization.registry.unregister('blocks');Blockly.serialization.registry.register('blocks',new CustomSerializer());
 try{
  const result=await loadBlocklyWorkspaceProgressively(fixture(),ws,{yieldToHost:async()=>assert.fail('custom serializer must remain authoritative')});
  assert.equal(result.progressive,false);assert.equal(called,1);assert.equal(ws.getAllBlocks(false).length,2000);
 }finally{ws.dispose();Blockly.serialization.registry.unregister('blocks');Blockly.serialization.registry.register('blocks',original);}
});

test('small workspaces retain the standard Blockly loader',async()=>{
 const ws=workspace();
 try{assert.equal((await loadBlocklyWorkspaceProgressively({blocks:{blocks:[{type:'math_number',id:'small'}]}},ws)).progressive,false);assert(ws.getBlockById('small'));}
 finally{ws.dispose();}
});
