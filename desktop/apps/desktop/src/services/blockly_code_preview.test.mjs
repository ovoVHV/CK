import test from 'node:test';
import assert from 'node:assert/strict';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
const require=createRequire(import.meta.url);
const Blockly=require('blockly');require('blockly/blocks');
const generator={forBlock:{math_number:()=>0},INDENT:'  '};
const src=(await readFile(new URL('./blockly_code_preview.ts',import.meta.url),'utf8'))
 .replace("new URL('./blockly_preview.worker.ts', import.meta.url)","'test-worker'");
const out=ts.transpileModule(src,{compilerOptions:{module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2022}}).outputText;
const module={exports:{}};
new Function('require','module','exports',out)(name=>name==='blockly'?Blockly:name.endsWith('arduino_generator')?{arduinoGenerator:generator}:{},module,module.exports);
const {createBlocklyCodePreview}=module.exports;
class FakeWorker{
 static instances=[];
 constructor(){this.terminated=false;FakeWorker.instances.push(this);}
 postMessage(value){this.message=value;}
 terminate(){this.terminated=true;}
 reply(code){this.onmessage({data:{id:this.message.id,code}});}
}
const previousWorker=globalThis.Worker;globalThis.Worker=FakeWorker;
test.after(()=>{globalThis.Worker=previousWorker;});
function fixture(){const ws=new Blockly.Workspace();Blockly.Events.disable();for(let i=0;i<2000;i++)ws.newBlock('math_number',`preview-${i}`);Blockly.Events.enable();return ws;}
test('incremental field snapshots equal the official full serializer including custom metadata',async()=>{
 const ws=fixture();let metadata='before';Blockly.serialization.registry.register('ckPreviewTest',{priority:0,save:()=>({metadata}),load(){},clear(){}});
 const preview=createBlocklyCodePreview();
 try{
  preview.seed(ws,Blockly.serialization.workspaces.save(ws));metadata='after';ws.getBlockById('preview-999').setFieldValue(17,'NUM');preview.invalidate({type:'change',element:'field',blockId:'preview-999'},ws);
  const pending=preview.request(ws,'arduino:avr:uno','zh-CN');const worker=FakeWorker.instances.at(-1);
  assert.equal(worker.message.serialized,JSON.stringify(Blockly.serialization.workspaces.save(ws)));worker.reply('current');assert.deepEqual(await pending,{current:true,code:'current'});
  ws.newBlock('math_number','new-block');preview.invalidate({type:'create'},ws);
  const second=preview.request(ws,'arduino:avr:uno','en-US');const next=FakeWorker.instances.at(-1);assert.equal(next.message.serialized,JSON.stringify(Blockly.serialization.workspaces.save(ws)));next.reply('new');assert.equal((await second).code,'new');
 }finally{preview.dispose();ws.dispose();Blockly.serialization.registry.unregister('ckPreviewTest');}
});
test('late worker responses and errors cannot cancel or publish over a newer revision',async()=>{
 const ws=fixture();const preview=createBlocklyCodePreview();
 try{const first=preview.request(ws,'arduino:avr:uno','en-US');const old=FakeWorker.instances.at(-1);preview.invalidate({type:'change',element:'field',blockId:'preview-1'},ws);const second=preview.request(ws,'arduino:avr:uno','en-US');const current=FakeWorker.instances.at(-1);
  assert.equal((await first).current,false);old.reply('stale');old.onerror();assert.equal(current.terminated,false);current.reply('fresh');assert.deepEqual(await second,{current:true,code:'fresh'});
 }finally{preview.dispose();ws.dispose();}
});
test('package generator overrides are never substituted with built-in worker code',async()=>{
 const ws=fixture();const preview=createBlocklyCodePreview();const original=generator.forBlock.math_number;
 try{generator.forBlock.math_number=()=>42;const before=FakeWorker.instances.length;assert.deepEqual(await preview.request(ws,'arduino:avr:uno','en-US'),{current:true,code:null});assert.equal(FakeWorker.instances.length,before);
 }finally{generator.forBlock.math_number=original;preview.dispose();ws.dispose();}
});
test('in-place block init overrides are rejected and disposal settles pending work',async()=>{
 const ws=fixture();const preview=createBlocklyCodePreview();const original=Blockly.Blocks.math_number.init;
 try{Blockly.Blocks.math_number.init=()=>{};assert.equal((await preview.request(ws,'arduino:avr:uno','en-US')).code,null);Blockly.Blocks.math_number.init=original;const pending=preview.request(ws,'arduino:avr:uno','en-US');preview.dispose();assert.deepEqual(await pending,{current:false,code:null});
 }finally{Blockly.Blocks.math_number.init=original;preview.dispose();ws.dispose();}
});
test('implementations changed while the worker runs fall back without publishing stale code',async()=>{
 const ws=fixture();const preview=createBlocklyCodePreview();const original=generator.forBlock.math_number;
 try{const pending=preview.request(ws,'arduino:avr:uno','en-US');const worker=FakeWorker.instances.at(-1);generator.forBlock.math_number=()=>99;worker.reply('obsolete');assert.deepEqual(await pending,{current:true,code:null});
 }finally{generator.forBlock.math_number=original;preview.dispose();ws.dispose();}
});
