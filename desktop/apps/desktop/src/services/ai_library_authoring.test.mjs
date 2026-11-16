import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath,pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import Ajv from 'ajv/dist/2020.js';
const here=path.dirname(fileURLToPath(import.meta.url));
const cache=path.resolve(here,'../../node_modules/.cache/ai-library-tests');fs.mkdirSync(cache,{recursive:true});
const output=path.join(cache,'authoring.mjs');
await build({stdin:{contents:`export * from ${JSON.stringify(path.join(here,'ai_library_authoring.ts'))};export * from ${JSON.stringify(path.join(here,'ai_assistant_runtime.ts'))};`,resolveDir:here,loader:'ts'},outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
const api=await import(pathToFileURL(output));
const target={schemaVersion:1,board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreId:'arduino:avr',coreVersion:'1.8.6',fqbn:'arduino:avr:uno',options:{},optionsComplete:true};
const sample=()=>{const draft=api.newAiLibraryDraft();return api.stageAiLibrary(draft,api.aiLibraryFormat(draft.id).example);};
const schema=JSON.parse(fs.readFileSync(path.resolve(here,'../../../../docs/schemas/ck-blocks-v2.schema.json'),'utf8'));
const validate=new Ajv({strict:false,allErrors:true}).compile(schema);
test('generated package uses actual v2 metadata, bounded JSON runtime and current target',()=>{
    const draft=sample(), result=api.buildAiLibrary(draft,target);
    const manifest=JSON.parse(result.files['ck-blocks.json']);
    assert(validate(manifest),JSON.stringify(validate.errors));
    assert.deepEqual(manifest.compatibility.boards,[target.board]);
    assert.match(result.source,/pinMode\(13, OUTPUT\)/);assert.match(result.source,/digitalWrite\(13, HIGH\)/);
    assert.equal(Blockly.Blocks[draft.blocks[0].definition.type],undefined);
    assert(!result.files['.ck-quality-report.json']);assert(!result.files['blocks/generator.js']);
});

test('metadata errors identify their exact field before any native preparation or compilation',()=>{
    const draft=sample(),before=JSON.stringify(draft);
    draft.blocks[0].documentation.constraints={range:'invalid map'};
    assert.throws(()=>api.buildAiLibrary(draft,target),/\/blocks\/0\/constraints: must be array/);
    assert(!Blockly.Blocks[draft.blocks[0].definition.type]);assert(Blockly.Events.isEnabled());
    delete draft.blocks[0].documentation.constraints;
    assert.equal(JSON.stringify(draft),before);assert(api.buildAiLibrary(draft,target).source);
});
test('malformed stage rejects atomically, valid same-type update retains other files',()=>{
    const draft=sample(), before=JSON.stringify(draft), type=draft.blocks[0].definition.type;
    assert.throws(()=>api.stageAiLibrary(draft,{name:'bad attempt',files:[{path:'../escape.h',content:'x'}]}));
    assert.equal(JSON.stringify(draft),before);
    const next=api.stageAiLibrary(draft,{files:[{path:'src/Example.h',content:'#pragma once'}],blocks:[{...draft.blocks[0],generator:{type,kind:'statement',template:'delay(123);\n'}}]});
    assert.equal(next.blocks.length,1);assert.match(next.files['src/Example.h'],/pragma/);assert.equal(JSON.stringify(draft),before);
});
test('namespace collision never replaces an existing block definition',()=>{
    const draft=sample(), type=draft.blocks[0].definition.type, original={init(){this.appendDummyInput().appendField('existing');}};
    Blockly.Blocks[type]=original;
    try{assert.throws(()=>api.buildAiLibrary(draft,target),/占用/);assert.equal(Blockly.Blocks[type],original);}finally{delete Blockly.Blocks[type];}
});
test('missing or wrong-kind placeholders are rejected and registration/events are restored',()=>{
    const draft=sample();draft.blocks[0].generator.template='digitalWrite({{value:PIN}},0);';
    assert.throws(()=>api.buildAiLibrary(draft,target),/类型不符/);assert(Blockly.Events.isEnabled());assert(!Blockly.Blocks[draft.blocks[0].definition.type]);
});
test('all blocks contribute to the actual smoke source including expression output',()=>{
    const draft=sample(),type=draft.id+'_read';
    const next=api.stageAiLibrary(draft,{blocks:[{definition:{type,message0:'读取',output:'Number'},generator:{type,kind:'expression',template:'analogRead(A0)'},documentation:{description:'读取模拟值'}}]});
    const result=api.buildAiLibrary(next,target);assert.match(result.source,/digitalWrite/);assert.match(result.source,/\(void\)\(analogRead\(A0\)\)/);
    const contract=JSON.parse(result.files['ck-blocks.json']);assert(validate(contract),JSON.stringify(validate.errors));
    assert.equal(contract.blocks[1].hardware.claims.coverage,'unknown');
});
test('scripts, external resources, foreign namespace and duplicate files are refused',()=>{
    const draft=sample();
    for(const file of ['src/evil.js','src/../evil.h','src/Evil.h:stream','/src/evil.h'])assert.throws(()=>api.stageAiLibrary(draft,{files:[{path:file,content:'x'}]}));
    assert.throws(()=>api.stageAiLibrary(draft,{blocks:[{...draft.blocks[0],definition:{...draft.blocks[0].definition,type:'existing_type'}}]}),/前缀/);
    assert.throws(()=>api.stageAiLibrary(draft,{blocks:[{...draft.blocks[0],definition:{...draft.blocks[0].definition,extensions:['execute']}}]}),/脚本/);
});
test('unresolved target does not issue source or compatibility claims',()=>{assert.throws(()=>api.buildAiLibrary(sample(),{...target,optionsComplete:false}),/尚未就绪/);});

const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
function task(transport,validate){const ws=new Blockly.Workspace();return {ws,input:{prompt:'制作一个数字输出库',intent:{id:1,kind:'library'},connection:{baseUrl:'http://127.0.0.1:9876/v1',model:'fixture',apiKey:'fixture'},signal:new AbortController().signal,transport,onText(){},onStep(){},host:{workspace:()=>ws,catalog:()=>[],target:()=>target,identity:()=> 'stable',diagnostics:()=>[],inspectCandidate:()=>'',validateCandidate:async()=>{throw Error('wrong compiler')},library:{validate,discard:async()=>{},install:async()=>{throw Error('runtime must not install before UI gate')},export:async()=>null}}}};}
test('library tool loop preserves draft through real failures and returns only compiled preview',async()=>{
    let rounds=0, compiles=0, id;
    const t=task(async req=>{
        rounds++;const results=req.historyMessages.filter(r=>r.role==='tool').map(r=>JSON.parse(r.content));
        if(rounds===1)return {toolCalls:[call('get_library_format')],finishReason:'tool_calls'};
        if(rounds===2){id=results.find(r=>r.typePrefix).id;return {toolCalls:[call('stage_library',api.aiLibraryFormat(id).example)],finishReason:'tool_calls'};}
        if(rounds===4){assert(results.some(r=>r.compiled===false));return {toolCalls:[call('read_library_draft',{type:id+'_write'})],finishReason:'tool_calls'};}
        return {toolCalls:[call('submit_library')],finishReason:'tool_calls'};
    },async draft=>{compiles++;assert.equal(draft.blocks.length,1);api.buildAiLibrary(draft,target);return {token:'fixture-token',packageId:draft.id,name:draft.name,version:draft.version,types:[id+'_write'],files:[],source:'sample',contentSha256:'hash',validation:{ok:compiles===2,runId:crypto.randomUUID(),sourceSha256:'source',elapsedMs:1,log:compiles===1?'error: fixture actual compile diagnostic':'ok',diagnostics:[],artifactCount:compiles===2?1:0}};});
    try{const result=await api.runAiTask(t.input);assert(result.library);assert.equal(result.validations.length,2);assert.equal(t.ws.getAllBlocks(false).length,0);}finally{t.ws.dispose();}
});
test('host without guarded installation never exposes or executes library mutation tools',async()=>{
    let validates=0;
    const t=task(async req=>{assert(!req.tools.some(t=>t.function.name==='stage_library'));return req.historyMessages.length?{content:'不能在当前模式制作库',finishReason:'stop'}:{toolCalls:[call('stage_library',{name:'forbidden'})],finishReason:'tool_calls'};},async()=>{validates++;});
    t.input.intent.kind='generate';try{await api.runAiTask(t.input);assert.equal(validates,0);}finally{t.ws.dispose();}
});
test('library format supports on-demand actual resource and dependency contracts',()=>{for(const section of ['hardware','dependencies','semantics','constraints','examples','errors']){const result=api.aiLibraryFormat('id',section);assert.equal(result.section,section);assert(result.schema);}});

test('authoring tools expose exact generator enums and usable statement/expression examples',()=>{
 const tools=api.AI_LIBRARY_TOOLS.find(t=>t.function.name==='stage_library').function.parameters;
 assert.deepEqual(tools.properties.blocks.items.properties.generator.properties.kind.enum,['statement','expression']);
 const d=sample(),format=api.aiLibraryFormat(d.id);
 const withValue=api.stageAiLibrary(d,{blocks:[format.expressionExample]});const built=api.buildAiLibrary(withValue,target);assert.match(built.source,/analogRead\(A0\)/);
 const bad={...d.blocks[0],generator:{...d.blocks[0].generator,kind:'value'}};
 assert.throws(()=>api.stageAiLibrary(d,{blocks:[bad]}),/expression.*不能写value/);
 bad.generator={...d.blocks[0].generator,includes:['#include <Arduino.h>']};assert.throws(()=>api.stageAiLibrary(d,{blocks:[bad]}),/includes.*对象.*数组/);
 bad.generator={...d.blocks[0].generator,kind:'expression'};assert.throws(()=>api.stageAiLibrary(d,{blocks:[bad]}),/output/);
});
