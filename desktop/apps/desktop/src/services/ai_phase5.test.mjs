import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';import * as Blockly from 'blockly';
const root=path.dirname(fileURLToPath(import.meta.url)),cache=path.resolve(root,'../../node_modules/.cache/ck-ai-phase5');fs.mkdirSync(cache,{recursive:true});
const entry=path.join(cache,'entry.mjs'),output=path.join(cache,'runtime.mjs');
fs.writeFileSync(entry,['ai_repair_scope','ai_workspace','ai_assistant_runtime','ai_task_checkpoint','ai_acceptance','ai_avr_simulator','compile_source_map'].map(n=>`export * from ${JSON.stringify(path.join(root,n+'.ts'))};`).join('\n'));
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const {lockAiRepairScope,checkAiRepairEdits,parseAiRepairScope,previewAiProposal,aiWorkspaceSnapshot,runAiTask,validateAiCheckpoint,parseAiAcceptance,simulateAiFirmware,sha256Hex}=await import(pathToFileURL(output));
Blockly.defineBlocksWithJsonArray([{type:'p5_root',message0:'程序 %1',args0:[{type:'input_statement',name:'DO'}]},
{type:'p5_step',message0:'值 %1 辅助 %2',args0:[{type:'field_number',name:'VALUE',value:0},{type:'field_number',name:'OTHER',value:0}],previousStatement:null,nextStatement:null}]);
const catalog=['p5_root','p5_step'].map(type=>({type,source:'library',library_id:'third-party',keywords:[type]}));
const create=()=>{const ws=new Blockly.Workspace();Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'p5_root',id:'root',inputs:{DO:{block:{type:'p5_step',id:'a',fields:{VALUE:700,OTHER:0},next:{block:{type:'p5_step',id:'b',fields:{VALUE:300,OTHER:0}}}}}}}]}},ws);return ws;};
const edit=(value=650,id='a',field='VALUE')=>({action:'set_field',blockId:id,field,value});
const proposal=(edits=[edit()],variables=[])=>({summary:'修改阈值',edits,variables});
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(...toolCalls)=>({content:'',finishReason:'tool_calls',toolCalls});
const base=ws=>({prompt:'只改阈值，保留所有其他行为',intent:{id:1,kind:'edit'},connection:{baseUrl:'https://example.com/v1',model:'fixture',apiKey:'fixture'},signal:new AbortController().signal,onText(){},onStep(){},host:{workspace:()=>ws,catalog:()=>catalog,target:()=>({fqbn:'arduino:avr:uno'}),identity:()=> 'stable',projectIdentity:()=> 'p',libraryInventory:()=>[],diagnostics:()=>({}),inspectCandidate:()=>'',validateCandidate:async()=>({ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'compiled',diagnostics:[],artifactCount:1})}});

test('field scope locks exact target set, allows value repair, rejects structural expansion and other fields',()=>{
const ws=create();try{const first=previewAiProposal(ws,proposal(),catalog),scope=lockAiRepairScope(undefined,first);assert.equal(scope.fields.length,1);
assert.deepEqual(lockAiRepairScope(scope,previewAiProposal(ws,proposal([edit(640)]),catalog)),scope);
for(const p of [proposal([edit(650,'b')]),proposal([edit(5,'a','OTHER')]),proposal([edit()],[{name:'sampleCount'}]),proposal([{action:'remove',blockId:'b'}]),proposal([{action:'add_top',block:{type:'p5_root'}}])])assert.throws(()=>checkAiRepairEdits(scope,p),/修复范围已固定/);
assert.equal(ws.getBlockById('a').getFieldValue('VALUE'),700);
}finally{ws.dispose();}});

test('third-party field side effects cannot change connections or unapproved state unnoticed',()=>{
const ws=create();try{const p=previewAiProposal(ws,proposal(),catalog);const data=JSON.parse(p.after);data.blocks.blocks[0].inputs.DO.block.fields.OTHER=1;
assert.throws(()=>lockAiRepairScope(undefined,{...p,after:JSON.stringify(data)}),/范围外/);
const unrelated=JSON.parse(p.before);unrelated.variables=[{name:'newVar',id:'new'}];assert.throws(()=>lockAiRepairScope(undefined,{...p,after:JSON.stringify(unrelated)}),/范围外/);
}finally{ws.dispose();}});

test('structure tasks remain possible; scope is not falsely claimed for them',()=>{
const ws=create();try{const p=previewAiProposal(ws,proposal([{action:'append',blockId:'b',block:{type:'p5_step',fields:{VALUE:9}}}]),catalog);assert.equal(lockAiRepairScope(undefined,p),undefined);}finally{ws.dispose();}});

test('runtime refuses widening/reset without another compile, still permits correction within fixed fields',async()=>{
const ws=create(),input=base(ws);let n=0,compiles=0,saved;
input.onCheckpoint=s=>saved=s;input.host.validateCandidate=async()=>({ok:++compiles>1,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'real failure',diagnostics:[],artifactCount:compiles>1?1:0});
input.transport=async req=>{if(++n===1)return reply(call('read_workspace'),call('propose_change',proposal([edit(800)])));
if(n===2){assert(saved.repairScope);return reply(call('stage_changes',{...proposal([edit()],[{name:'sampleCount'}]),reset:true}),call('stage_blocks',{summary:'新增启动延迟',nodes:[],placements:[]}),call('propose_change',proposal([edit(250,'b')])));}
if(n===3){const rows=req.historyMessages.filter(r=>r.role==='tool').slice(-3).map(r=>JSON.parse(r.content));assert(rows.every(r=>/范围已固定/.test(r.error)));assert.equal(compiles,1);return reply(call('propose_change',proposal()));}throw Error('extra round');};
try{const r=await runAiTask(input);assert(r.preview);assert.equal(compiles,2);assert.equal(saved.repairScope.fields.length,1);validateAiCheckpoint(saved);}finally{ws.dispose();}});

test('scope survives canceled compile and resume; corrupted or broadened saved drafts rejected',async()=>{
const ws=create(),input=base(ws),abort=new AbortController();let n=0,saved;input.signal=abort.signal;input.onCheckpoint=s=>saved=s;
input.host.validateCandidate=async()=>{abort.abort();throw Error('canceled');};input.transport=async()=>reply(call('read_workspace'),call('propose_change',proposal()));
try{await assert.rejects(runAiTask(input));assert.equal(saved.projectAttempts,1);assert(saved.repairScope);validateAiCheckpoint(saved);
for(const mutate of [s=>s.repairScope.workspaceSha256='0'.repeat(64),s=>s.repairScope.fields.push(s.repairScope.fields[0]),s=>s.edits.push(edit(9,'b')),s=>s.observed=[]]){const bad=structuredClone(saved);mutate(bad);assert.throws(()=>validateAiCheckpoint(bad));}
const next=base(ws);next.resume=saved;next.transport=async req=>{if(n===0)assert(req.contextJson.includes('repairScope'));if(++n===1)return reply(call('propose_change',proposal([edit(5,'b')])));assert.match(JSON.parse(req.historyMessages.at(-1).content).error,/范围已固定/);return reply(call('propose_change',{summary:'继续',edits:[]}));};const r=await runAiTask(next);assert(r.preview);assert.equal(r.validations[0].attempt,2);
}finally{ws.dispose();}});

test('malformed scope cannot smuggle executable metadata',()=>{for(const s of [null,{version:1,mode:'fields',workspaceSha256:'a'.repeat(64),fields:[]},{version:1,mode:'fields',workspaceSha256:'a'.repeat(64),fields:[{blockId:'a',field:'VALUE',token:'bad'}]}])assert.throws(()=>parseAiRepairScope(s));});

test('context compaction retains the fixed repair scope and does not authorize additional fields',async()=>{
const ws=create(),input=base(ws);let n=0,compiles=0,compacted=false;
input.contextSettings={contextTokens:16384,responseTokens:2048,autoCompact:true};
input.host.catalog=()=>catalog.map(b=>b.type==='p5_step'?{...b,constraints:Array.from({length:10},(_,i)=>({id:'long-'+i,description:'x'.repeat(7000)})),metadata_completeness:['constraints']}:b);
input.host.validateCandidate=async()=>({ok:++compiles>1,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'real failure',diagnostics:[],artifactCount:compiles>1?1:0});
input.transport=async req=>{
if(!req.tools?.length){compacted=true;return {content:'保留原需求和字段修复范围，仍需验证',finishReason:'stop',toolCalls:[]};}
if(++n===1)return reply(call('read_workspace'),call('propose_change',proposal([edit(800)])));
if(n<9)return reply(call('get_block_documentation',{type:'p5_step',section:'constraints',offset:n-2,limit:1}));
if(n===9){const state=req.historyMessages.findLast(r=>r.content.startsWith('当前任务真实暂存状态：'));assert(state&&compacted);const scope=JSON.parse(state.content.slice(state.content.indexOf('{'))).repairScope;assert.equal(scope.fields[0].blockId,'a');return reply(call('propose_change',proposal([edit(250,'b')])));}
assert.match(JSON.parse(req.historyMessages.at(-1).content).error,/范围已固定/);return reply(call('propose_change',proposal()));
};try{assert((await runAiTask(input)).preview);assert.equal(compiles,2);}finally{ws.dispose();}
});

test('retained alpha41 real failure cannot be laundered by model self-tests or widened repair',()=>{
const fixture=JSON.parse(fs.readFileSync(path.resolve(root,'../../../../../tests/fixtures/ai-phase5/alpha41-failure.json'),'utf8'));
assert.equal(simulateAiFirmware(fixture.firstFirmware,fixture.independentContract).status,'passed');
assert.equal(simulateAiFirmware(fixture.firstFirmware,fixture.modelContract).status,'failed');
assert.equal(simulateAiFirmware(fixture.expandedFirmware,fixture.modelContract).status,'passed');
const independent=simulateAiFirmware(fixture.expandedFirmware,fixture.independentContract);assert.equal(independent.status,'failed');assert(independent.checks.some(c=>c.id==='upper_on'&&!c.ok));
const scope={version:1,mode:'fields',workspaceSha256:'a'.repeat(64),fields:fixture.firstProposal.edits.map(({blockId,field})=>({blockId,field}))};
assert.throws(()=>checkAiRepairEdits(scope,fixture.expandedProposal),/修复范围已固定/);
});

const hex=words=>{const b=words.flatMap(w=>[w&255,w>>8]),r=[b.length,0,0,0,...b];return ':'+[...r,(-r.reduce((a,b)=>a+b,0))&255].map(n=>n.toString(16).padStart(2,'0')).join('').toUpperCase()+'\n:00000001FF\n';};
const firmware=words=>{const content=hex(words);return {format:'ihex',content,sha256:sha256Hex(content),sourceSha256:'a'.repeat(64),fqbn:'arduino:avr:uno'};};
const spec=()=>({version:1,requirements:[{id:'hold',text:'输出保持不变',method:'simulation'}],scenarios:[{id:'hold',name:'窗口保持',durationMs:100,inputs:[],assertions:[{id:'still',requirement:'hold',kind:'edges',pin:'D13',fromMs:1,toMs:100,min:0,max:0}]}]});
test('zero-edge assertion verifies real stable output, rejects undriven input and real toggles',()=>{
const contract=parseAiAcceptance(spec());assert.equal(simulateAiFirmware(firmware([0xe200,0xb904,0xb905,0xcfff]),contract).status,'passed');
assert.equal(simulateAiFirmware(firmware([0xcfff]),contract).status,'failed');
// Write PINB after a bounded decrement loop: real output transitions.
assert.equal(simulateAiFirmware(firmware([0xe200,0xb904,0xb905,0xef1f,0x951a,0xf7f1,0xb903,0xcffb]),contract).status,'failed');
const invalid=spec();invalid.scenarios[0].assertions[0].min=-1;assert.throws(()=>parseAiAcceptance(invalid));
});
