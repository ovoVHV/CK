import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
import * as Blockly from 'blockly';
import 'blockly/blocks';
const root=path.dirname(fileURLToPath(import.meta.url)),cache=path.resolve(root,'../../node_modules/.cache/ck-ai-phase4');fs.mkdirSync(cache,{recursive:true});
const entry=path.join(cache,'entry.mjs'),output=path.join(cache,'runtime.mjs');
fs.writeFileSync(entry,['ai_workspace','ai_assistant_runtime','ai_task_state','ai_task_checkpoint','ai_acceptance'].map(n=>`export * from ${JSON.stringify(path.join(root,n+'.ts'))};`).join('\n'));
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const {aiReadWorkspace,aiWorkspaceSnapshot,runAiTask,validateAiCheckpoint,aiExactStagedState,aiCodePage,aiAcceptanceHash,aiFailureContext,aiFailurePage}=await import(pathToFileURL(output));
Blockly.defineBlocksWithJsonArray([{type:'p4_root',message0:'程序 %1',args0:[{type:'input_statement',name:'DO'}]},
 {type:'p4_step',message0:'数值 %1',args0:[{type:'field_number',name:'VALUE',value:0}],previousStatement:null,nextStatement:null}]);
const catalog=['p4_root','p4_step','variables_get'].map(type=>({type,source:'library',library_id:'third_party_no_ai',keywords:[type]}));
const create=()=>{const ws=new Blockly.Workspace();Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'p4_root',id:'root',inputs:{DO:{block:{type:'p4_step',id:'a',fields:{VALUE:700},next:{block:{type:'p4_step',id:'b',fields:{VALUE:300}}}}}}}]}},ws);return ws;};
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(...toolCalls)=>({content:'',finishReason:'tool_calls',toolCalls});
const base=ws=>({prompt:'修改阈值，保留其他功能',intent:{id:1,kind:'edit'},connection:{baseUrl:'https://example.com/v1',model:'fixture',apiKey:'test-private-secret'},signal:new AbortController().signal,onText(){},onStep(){},host:{workspace:()=>ws,catalog:()=>catalog,target:()=>({fqbn:'arduino:avr:uno'}),identity:()=> 'stable',projectIdentity:()=> 'p',libraryInventory:()=>[],diagnostics:()=>({}),inspectCandidate:()=> 'void setup() {}\nvoid loop() { /* test-private-secret */ }',validateCandidate:async()=>({ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'compiled',diagnostics:[],artifactCount:1})}});

test('actual desktop checkpoint fixture is accepted by both renderer and native contract tests',()=>{
 const saved=JSON.parse(fs.readFileSync(path.resolve(root,'../../../../../tests/fixtures/ai-phase4/checkpoint.json'),'utf8'));
 assert(saved.lastFailure);assert.equal(saved.lastFailure.result.behavior.status,'failed');assert.deepEqual(validateAiCheckpoint(saved),saved);
});

test('targeted reads work for third-party blocks without metadata and retain exact links',()=>{
 const ws=create(),before=aiWorkspaceSnapshot(ws);
 try{const result=aiReadWorkspace(ws,{query:'700'});assert.equal(result.total,1);assert.equal(result.blocks[0].id,'a');assert.equal(result.blocks[0].nextId,'b');assert.equal(result.blocks[0].parentId,'root');
 assert.deepEqual(aiReadWorkspace(ws,{ids:['b','a']}).blocks.map(b=>b.id),['b','a']);assert.equal(aiReadWorkspace(ws,{subtreeId:'root',query:'300'}).blocks[0].id,'b');
 for(const args of [{ids:['missing']},{query:33},{offset:-1},{limit:21},{subtreeId:'missing'}])assert.throws(()=>aiReadWorkspace(ws,args));
 assert.equal(aiWorkspaceSnapshot(ws),before);
 }finally{ws.dispose();}
});

test('search resolves variable names and complete result pages are bounded',()=>{
 const ws=create();try{const v=ws.getVariableMap().createVariable('传感器阈值'),block=ws.newBlock('variables_get');block.setFieldValue(v.getId(),'VAR');
 const r=aiReadWorkspace(ws,{query:'传感器'});assert.equal(r.blocks.length,1);assert.equal(r.variables[0].name,'传感器阈值');
 for(let i=0;i<38;i++){const b=ws.newBlock('p4_step');b.setFieldValue(88,'VALUE');}
 const a=aiReadWorkspace(ws,{query:'88',limit:20}),b=aiReadWorkspace(ws,{query:'88',limit:20,offset:a.nextOffset});assert.equal(a.blocks.length+b.blocks.length,38);assert.equal(b.nextOffset,null);
 }finally{ws.dispose();}
});

test('code reads cannot authorize unread block edits or expose API secrets',async()=>{
 const ws=create(),input=base(ws);let n=0;
 input.transport=async req=>{assert(!JSON.stringify(req.historyMessages).includes('test-private-secret'));
 if(++n===1)return reply(call('read_project_code'),call('propose_change',{summary:'未读目标',edits:[{action:'set_field',blockId:'a',field:'VALUE',value:650}]}));
 if(n===2){const rows=req.historyMessages.filter(r=>r.role==='tool').map(r=>JSON.parse(r.content));assert.equal(rows[0].scope,'original-workspace');assert.match(rows[1].error,/先使用 read_workspace/);return reply(call('read_workspace',{query:'700'}));}
 return reply(call('propose_change',{summary:'精确修改',edits:[{action:'set_field',blockId:'a',field:'VALUE',value:650}]}));};
 try{const result=await runAiTask(input);assert.equal(result.preview.changed,1);assert.equal(ws.getBlockById('a').getFieldValue('VALUE'),700);}finally{ws.dispose();}
});

test('mixed graph and raw edits compact in exact order without duplicated expanded blocks',()=>{
 const raw={action:'set_field',blockId:'a',field:'VALUE',value:650},graph={action:'append',blockId:'root',input:'DO',block:{type:'p4_step',fields:{VALUE:3}}};
 const state=aiExactStagedState([raw,graph],new Map([['n',{key:'n',type:'p4_step',fields:{VALUE:3}}]]),[{action:'append',blockId:'root',input:'DO',node:'n',editIndex:1}]);
 assert.deepEqual(state.stagedEdits,[{index:0,edit:raw}]);assert.equal(state.stagedPlacements[0].editIndex,1);assert.equal(state.stagedEditCount,2);
});

test('actual compaction preserves exact field edits, then submits them once',async()=>{
 const ws=create(),input=base(ws);let n=0,compacted=false;
 input.contextSettings={contextTokens:16384,responseTokens:2048,autoCompact:true};
 input.host.catalog=()=>catalog.map(b=>b.type==='p4_step'?{...b,constraints:Array.from({length:10},(_,i)=>({id:'long-'+i,description:'x'.repeat(7000)})),metadata_completeness:['constraints']}:b);
 input.transport=async req=>{
  if(!req.tools?.length){compacted=true;return {content:'保留目标，阈值修改已暂存，原工程未修改',finishReason:'stop',toolCalls:[]};}
  if(++n===1)return reply(call('read_workspace',{ids:['a']}),call('stage_changes',{summary:'阈值650',edits:[{action:'set_field',blockId:'a',field:'VALUE',value:650}]}));
  if(n<9)return reply(call('get_block_documentation',{type:'p4_step',section:'constraints',offset:n-2,limit:1}));
  const state=req.historyMessages.findLast(r=>r.content.startsWith('当前任务真实暂存状态：'));assert(state);assert(compacted);
  const facts=JSON.parse(state.content.slice(state.content.indexOf('{')));assert.deepEqual(facts.stagedEdits,[{index:0,edit:{action:'set_field',blockId:'a',field:'VALUE',value:650}}]);
  return reply(call('propose_change',{summary:'保留完整修改',edits:[]}));
 };
 try{const r=await runAiTask(input);assert.equal(r.preview.proposal.edits.length,1);assert.equal(r.preview.proposal.edits[0].value,650);}finally{ws.dispose();}
});

test('checkpoint rejects corrupt graph mappings and retains actual failure across cancellation/resume',async()=>{
 const ws=create(),input=base(ws),abort=new AbortController();let n=0,saved;
 input.signal=abort.signal;input.onCheckpoint=c=>saved=c;
 input.host.validateCandidate=async()=>({ok:false,runId:crypto.randomUUID(),sourceSha256:'b'.repeat(64),elapsedMs:1,log:'exact failure 73',diagnostics:[{message:'exact failure 73',line:3}],artifactCount:0});
 input.transport=async()=>{
  if(++n===1)return reply(call('read_workspace',{ids:['root']}),call('get_block_schema',{type:'p4_step'}),call('stage_blocks',{summary:'新增节点',nodes:[{key:'n',type:'p4_step',fields:{VALUE:8}}],placements:[{action:'append',blockId:'root',input:'DO',node:'n'}]}),call('propose_change',{summary:'验证',edits:[]}));
  abort.abort();abort.signal.throwIfAborted();
 };
 try{await assert.rejects(runAiTask(input));assert.equal(saved.projectAttempts,1);assert.match(saved.lastFailure.result.logTail,/exact failure 73/);validateAiCheckpoint(saved);
 for(const mutate of [s=>s.placements[0].editIndex=30,s=>s.nodes[0].fields.VALUE=9,s=>s.nodes.push(s.nodes[0]),s=>s.observed=[],s=>s.nodes[0].next='n']){const bad=structuredClone(saved);mutate(bad);assert.throws(()=>validateAiCheckpoint(bad));}
 const next=base(ws);next.resume=saved;next.transport=async req=>{assert(req.contextJson.includes('exact failure 73'));return reply(call('stage_blocks',{summary:'局部修复',patch:true,nodes:[{key:'n',type:'p4_step',fields:{VALUE:9}}],placements:[]}),call('propose_change',{summary:'重验',edits:[]}));};
 const r=await runAiTask(next);assert(r.preview);assert.equal(r.preview.added,1);assert.equal(r.preview.proposal.edits[0].block.fields.VALUE,9);
 }finally{ws.dispose();}
});

test('read-only answers do not leave empty resumable tasks and code paging is exact',async()=>{
 const ws=create(),input=base(ws);let saves=0;
 input.onCheckpoint=()=>saves++;input.transport=async()=>({content:'解释完成',finishReason:'stop',toolCalls:[]});
 try{await runAiTask(input);assert.equal(saves,0);}finally{ws.dispose();}
 const lines=Array.from({length:87},(_,i)=>'line '+i);const first=aiCodePage(lines.join('\n'));assert.equal(first.nextOffset,80);assert.equal(first.code.split('\n').length,80);assert.equal(aiCodePage(lines.join('\n'),80).nextOffset,null);assert.throws(()=>aiCodePage('x',-1));
});

test('large exact failure is represented once, remains fully pageable and allows repair within 32k',async()=>{
 const ws=create(),input=base(ws),contract=JSON.parse(fs.readFileSync(path.resolve(root,'../../../../../tests/fixtures/ai-phase4/large-acceptance.json'),'utf8'));
 input.contextSettings={contextTokens:32768,responseTokens:8192,autoCompact:true};let n=0,checks=0,saved;
 input.onCheckpoint=c=>saved=c;input.host.validateCandidate=async()=>({ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'compile detail '.repeat(800),diagnostics:[],artifactCount:1});
 input.host.validateBehavior=async({contract,sourceSha256,fqbn})=>({status:++checks===1?'failed':'passed',sourceSha256,fqbn,contractSha256:aiAcceptanceHash(contract),elapsedMs:1,engine:'avr8js-0.21.1',hardware:false,
  checks:contract.scenarios.flatMap(s=>s.assertions.map(a=>({scenario:s.id,id:a.id,requirement:a.requirement,ok:checks>1,expected:'expected detail '.repeat(35),actual:'actual detail '.repeat(35)})))});
 input.transport=async req=>{
  if(!req.tools?.length)return {content:'真实失败必须修复，标准保持',finishReason:'stop',toolCalls:[]};
  if(++n===1)return reply(call('read_project_code'),call('read_workspace',{ids:['root']}),call('get_block_schema',{type:'p4_step'}),call('get_verification_capabilities'));
  if(n===2)return {...reply(call('set_acceptance_plan',contract),call('stage_blocks',{summary:'验证候选',nodes:[{key:'n',type:'p4_step',fields:{VALUE:8}}],placements:[{action:'append',blockId:'root',input:'DO',node:'n'}]}),call('propose_change',{summary:'验证',edits:[]})),content:'重复推理资料'.repeat(1800)};
  if(n===3){const state=req.historyMessages.findLast(r=>r.content.startsWith('当前任务真实暂存状态：'));assert(state);const facts=JSON.parse(state.content.slice(state.content.indexOf('{')));assert(facts.lastFailure);assert(!facts.lastFailure.result.fixedAcceptance);assert(!facts.lastFailure.result.logTail);assert.equal(facts.acceptance.scenarios.length,contract.scenarios.length);assert.equal(facts.projectCodePages.length,1);assert(facts.observedBlocks[0].inputs);return reply(call('read_task_feedback'));}
  if(n===4){const r=JSON.parse(req.historyMessages.findLast(m=>m.role==='tool').content);assert(r.text.includes('compiled'));assert(r.nextOffset);return reply(call('stage_blocks',{summary:'修复',patch:true,nodes:[{key:'n',type:'p4_step',fields:{VALUE:9}}],placements:[]}),call('propose_change',{summary:'重验',edits:[]}));}
  throw Error('Unexpected round');
 };
 try{const result=await runAiTask(input);assert(result.preview);assert.equal(checks,2);assert(result.usage.compressions>0);
 const full=saved.lastFailure;assert(full.result.logTail);assert(aiFailureContext(full).hasLog);let text='',offset=0;do{const p=aiFailurePage(full,offset);text+=p.text;offset=p.nextOffset;}while(offset!==null);assert.deepEqual(JSON.parse(text),full.result);
 }finally{ws.dispose();}
});
