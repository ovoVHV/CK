import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
const root=path.dirname(fileURLToPath(import.meta.url)),cache=path.resolve(root,'../../node_modules/.cache/ck-ai-phase3');fs.mkdirSync(cache,{recursive:true});
const entry=path.join(cache,'entry.mjs'),output=path.join(cache,'runtime.mjs');
fs.writeFileSync(entry,['ai_acceptance','ai_avr_simulator','ai_task_checkpoint','ai_project_map','ai_library_revision','ai_library_authoring','ai_assistant_runtime','ai_workspace','compile_source_map'].map(n=>`export * from ${JSON.stringify(path.join(root,n+'.ts'))};`).join('\n'));
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const api=await import(pathToFileURL(output));
const {parseAiAcceptance,aiAcceptanceHash,aiRequirementStatus,lockAiAcceptance,aiSimulationTarget,parseAiHex,simulateAiFirmware,sha256Hex,runAiTask,aiWorkspaceSnapshot,checkAiResume,forkAiLibrary,stageAiLibrary,newAiLibraryDraft,buildAiLibrary,aiProjectMap}=api;
const spec=()=>({version:1,requirements:[{id:'output',text:'D13在50ms输出高电平',method:'simulation'},{id:'wiring',text:'实际接线',method:'hardware'}],scenarios:[{id:'s',name:'基本输出',durationMs:100,inputs:[],assertions:[{id:'high',requirement:'output',kind:'pin',atMs:50,pin:'D13',value:1}]}]});
const hex=(words)=>{const bytes=words.flatMap(w=>[w&255,w>>8]);const row=(data)=>':'+[...data,(-data.reduce((a,b)=>a+b,0))&255].map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase();return row([bytes.length,0,0,0,...bytes])+'\n:00000001FF\n';};
// Actual AVR opcodes: ldi r16,32; out DDRB,r16; out PORTB,r16; rjmp -1.
const firmware=(code=hex([0xe200,0xb904,0xb905,0xcfff]))=>({format:'ihex',content:code,sha256:sha256Hex(code),fqbn:'arduino:avr:uno',sourceSha256:'a'.repeat(64)});
test('acceptance is fixed and each simulated requirement needs a real assertion',()=>{
 const s=parseAiAcceptance(spec());assert.deepEqual(lockAiAcceptance(s,s),s);
 for(const mutate of [v=>v.scenarios[0].assertions[0].value=0,v=>v.requirements[0].method='review',v=>v.scenarios=[]]){const v=spec();mutate(v);assert.throws(()=>lockAiAcceptance(s,v));}
 const empty=spec();empty.scenarios[0].assertions=[];assert.throws(()=>parseAiAcceptance(empty));
 const input=spec();input.scenarios[0].inputs=[{atMs:0,pin:'D13',value:1}];assert.throws(()=>parseAiAcceptance(input),/外部输入/);
 const huge=spec();huge.scenarios[0].durationMs=5001;assert.throws(()=>parseAiAcceptance(huge));
});

test('incomplete scenario inputs are rejected before locking; corrected plans remain immutable',()=>{
 const a=spec();a.scenarios[0].inputs=[{atMs:0,pin:'D2',value:1},{atMs:0,pin:'A0',value:675}];
 const b=structuredClone(a.scenarios[0]);b.id='second';b.assertions[0].id='high2';b.inputs=[{atMs:0,pin:'A0',value:200}];a.scenarios.push(b);
 assert.throws(()=>lockAiAcceptance(undefined,a),/场景second缺少外部输入D2/);
 b.inputs.push({atMs:20,pin:'D2',value:1});assert.throws(()=>lockAiAcceptance(undefined,a),/0ms/);
 b.inputs.at(-1).atMs=0;const fixed=lockAiAcceptance(undefined,a);assert.equal(fixed.scenarios.length,2);
 const changed=structuredClone(a);changed.scenarios[1].inputs.at(-1).value=0;assert.throws(()=>lockAiAcceptance(fixed,changed),/已固定/);
});
test('real AVR opcodes pass only configured output, retain pending hardware requirements',()=>{
 const s=spec(),r=simulateAiFirmware(firmware(),s);assert.equal(r.status,'passed');assert.equal(r.checks[0].actual,'1');
 assert.deepEqual(aiRequirementStatus(s,r).map(r=>r.status),['passed','unverified']);
 const inputOnly=simulateAiFirmware(firmware(hex([0xe200,0xb905,0xcfff])),s);assert.equal(inputOnly.status,'failed');assert.match(inputOnly.checks[0].actual,/未设置/);
 const off=simulateAiFirmware(firmware(hex([0xe200,0xb904,0xe000,0xb905,0xcfff])),s);assert.equal(off.status,'failed');
 assert.equal(aiRequirementStatus(s,{...r,contractSha256:'0'.repeat(64)})[0].status,'unverified');
});
test('unsupported targets, peripheral activation and invalid HEX never produce pass evidence',()=>{
 for(const target of ['esp32:esp32:esp32s3','arduino:avr:mega','arduino:avr:nano:cpu=atmega168','arduino:avr:uno:clock=8'])assert.equal(aiSimulationTarget(target),null);
 assert(aiSimulationTarget('arduino:avr:nano:cpu=atmega328old'));
 assert.throws(()=>parseAiHex(':02000000000000\n:00000001FF'),/校验和/);
 assert.throws(()=>simulateAiFirmware({...firmware(),content:firmware().content+' '},spec()),/证明/);
 // ldi r16,64; out SPCR,r16 -> unsupported SPI, even if other outputs match.
 const spi=simulateAiFirmware(firmware(hex([0xe400,0xbd0c,0xcfff])),spec());assert.equal(spi.status,'unsupported');assert.match(spi.reason,/SPI/);
});

test('serial assertions decode Chinese UTF8 bytes and reject a disabled transmitter',()=>{
 const s={version:1,requirements:[{id:'text',text:'串口中文',method:'simulation'}],scenarios:[{id:'s',name:'中文输出',durationMs:100,inputs:[],assertions:[{id:'hello',requirement:'text',kind:'serial',fromMs:0,toMs:100,contains:'你好'}]}]};
 const write=(byte,addr)=>[0xe000|((byte&0xf0)<<4)|(byte&15),0x9300,addr];
 const bytes=[...new TextEncoder().encode('你好')].flatMap(b=>write(b,0xc6));
 const r=simulateAiFirmware(firmware(hex([...write(8,0xc1),...bytes,0xcfff])),s);
 assert.equal(r.status,'passed');assert.equal(r.checks[0].actual,'你好');
 assert.equal(simulateAiFirmware(firmware(hex([...bytes,0xcfff])),s).status,'unsupported');
});

Blockly.defineBlocksWithJsonArray([{type:'p3_root',message0:'程序 %1',args0:[{type:'input_statement',name:'DO'}]},
 {type:'p3_step',message0:'数值 %1',args0:[{type:'field_number',name:'VALUE',value:0}],previousStatement:null,nextStatement:null}]);
const catalog=['p3_root','p3_step'].map(type=>({type,source:'toolbox',keywords:[type]}));
const create=()=>{const ws=new Blockly.Workspace();Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'p3_root',id:'root'}]}},ws);return ws;};
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const answer=(...toolCalls)=>({content:'',finishReason:'tool_calls',toolCalls});
const base=(ws)=>({prompt:'复杂任务',intent:{id:1,kind:'generate'},connection:{baseUrl:'https://example.com/v1',model:'fixture',apiKey:'fixture'},signal:new AbortController().signal,onText(){},onStep(){},host:{workspace:()=>ws,catalog:()=>catalog,target:()=>({fqbn:'arduino:avr:uno'}),identity:()=> 'stable',projectIdentity:()=> 'p',libraryInventory:()=>[],diagnostics:()=>({}),inspectCandidate:()=>'',validateCandidate:async()=>({ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'compiled',diagnostics:[],artifactCount:1})}});
const stage=(value=0)=>call('stage_blocks',{summary:'输出值',nodes:[{key:'write',type:'p3_step',fields:{VALUE:value}}],placements:[{action:'append',blockId:'root',input:'DO',node:'write'}]});
test('behavior failure returns to model, test weakening is rejected, local repair gets a second real check',async()=>{
 const ws=create(),before=aiWorkspaceSnapshot(ws),input=base(ws),seen=[];let n=0,checks=0;
 input.host.validateBehavior=async ({contract,sourceSha256,fqbn})=>({status:++checks===1?'failed':'passed',contractSha256:aiAcceptanceHash(contract),sourceSha256,fqbn,elapsedMs:2,engine:'avr8js-0.21.1',hardware:false,checks:[{scenario:'s',id:'high',requirement:'output',ok:checks>1,expected:'1',actual:checks>1?'1':input.connection.apiKey}]});
 input.onBehavior=r=>{assert(!JSON.stringify(r).includes(input.connection.apiKey));seen.push(r.status);};
 input.transport=async req=>{n++;const rows=(req.historyMessages||[]).filter(r=>r.role==='tool').map(r=>JSON.parse(r.content));
  if(n===1)return answer(call('read_workspace'),call('get_block_schemas',{types:['p3_step']}),call('get_verification_capabilities'));
  if(n===2)return answer(call('set_acceptance_plan',spec()),stage(),call('propose_change',{summary:'候选',edits:[]}));
  if(n===3){assert.equal(rows.at(-1).behavior.status,'failed');const changed=spec();changed.scenarios[0].assertions[0].value=0;return answer(call('set_acceptance_plan',changed));}
  if(n===4){assert.match(rows.at(-1).error,/已固定/);return answer(call('stage_blocks',{summary:'修复输出',patch:true,nodes:[{key:'write',type:'p3_step',fields:{VALUE:1}}],placements:[]}),call('propose_change',{summary:'修复',edits:[]}));}
  throw Error('Unexpected round');
 };
 try{const result=await runAiTask(input);assert(result.preview);assert.equal(result.behavior.status,'passed');assert.deepEqual(seen,['failed','passed']);assert.equal(aiWorkspaceSnapshot(ws),before);assert.equal(checks,2);}finally{ws.dispose();}
});
test('interrupted task resumes exact nodes only after identity checks and recompilation',async()=>{
 const ws=create(),input=base(ws),abort=new AbortController();let checkpoint,round=0,compiles=0;
 input.signal=abort.signal;input.onCheckpoint=c=>checkpoint=c;input.host.validateCandidate=async()=>{compiles++;return {ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'compiled',diagnostics:[],artifactCount:1};};
 input.transport=async()=>{if(++round===1)return answer(call('read_workspace'),call('get_block_schema',{type:'p3_step'}),stage(7));abort.abort();abort.signal.throwIfAborted();};
 try{
  await assert.rejects(runAiTask(input));assert.equal(checkpoint.nodes.length,1);assert.equal(compiles,0);assert.equal(checkpoint.status,'paused');
  assert.throws(()=>checkAiResume(checkpoint,aiWorkspaceSnapshot(ws),{fqbn:'arduino:avr:nano'},'[]'),/已变化/);
  assert.throws(()=>checkAiResume(checkpoint,aiWorkspaceSnapshot(ws),input.host.target(),'[["lib","changed"]]'),/已变化/);
  const resumed=await runAiTask({...input,resume:checkpoint,signal:new AbortController().signal,transport:async req=>{assert(req.contextJson.includes('write'));return answer(call('propose_change',{summary:'继续',edits:[]}));}});
  assert.equal(compiles,1);assert.equal(resumed.preview.added,1);assert.equal(ws.getAllBlocks(false).length,1);
 }finally{ws.dispose();}
});
test('project map pages exact dependency groups without treating metadata as verification',()=>{
 const ws=create();try{const overview=aiProjectMap(ws,catalog,{fqbn:'arduino:avr:uno'});assert.equal(overview.blocks,1);const rows=aiProjectMap(ws,catalog,{}, {section:'hardware'});assert.equal(rows.rows[0].status,'undeclared');assert.throws(()=>aiProjectMap(ws,catalog,{}, {offset:-1}));}finally{ws.dispose();}
});
test('library revision preserves source license, bumps version and uses independent header/type identities',()=>{
 let d=newAiLibraryDraft();const old=d.id;
 d=stageAiLibrary(d,{name:'测试',description:'返回小数',blocks:[{definition:{type:old+'_value',message0:'值',output:'Number'},generator:{type:old+'_value',kind:'expression',template:'0.5f',includes:{header:'#include <'+old+'.h>'}},documentation:{description:'返回小数'}}],files:[{path:'src/'+old+'.h',content:'#pragma once\n'}]});
 const built=buildAiLibrary(d,{board:'arduino:avr:uno',coreVersion:'1.8.8',optionsComplete:true});
 built.files.LICENSE='original license notice';
 const fork=forkAiLibrary({packageId:old,contentSha256:'b'.repeat(64),files:built.files});
 assert.equal(fork.draft.version,'0.1.1');assert.equal(fork.draft.origin.license,'original license notice');assert.notEqual(fork.draft.id,old);
 const source=Object.keys(fork.draft.files)[0].slice(4);assert(fork.draft.blocks[0].generator.includes.header.includes(source));
 const reset=stageAiLibrary(fork.draft,{reset:true});assert.equal(reset.origin.license,'original license notice');
 assert.equal(fork.typeMap[old+'_value'],fork.draft.id+'_value');
});
