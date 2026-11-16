import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
const root=path.dirname(fileURLToPath(import.meta.url)),cache=path.resolve(root,'../../node_modules/.cache/ck-ai-boards');
fs.mkdirSync(cache,{recursive:true});
const entry=path.join(cache,'entry.mjs'),output=path.join(cache,'runtime.mjs');
fs.writeFileSync(entry,['ai_board_context','ai_assistant_runtime','ai_library_authoring','ai_acceptance'].map(n=>`export * from ${JSON.stringify(path.join(root,n+'.ts'))};`).join('\n'));
await build({entryPoints:[entry],outfile:output,bundle:true,platform:'node',format:'esm',packages:'external',logLevel:'silent'});
const api=await import(pathToFileURL(output));
const targets=['arduino:avr:uno','arduino:avr:nano:cpu=atmega328old','arduino:avr:mega:cpu=atmega2560','arduino:avr:diecimila:cpu=atmega168',
 'esp32:esp32:esp32','esp32:esp32:esp32s3:CDCOnBoot=cdc,PSRAM=opi','esp32:esp32:esp32c3','esp8266:esp8266:nodemcuv2',
 'arduino:samd:mkrzero','rp2040:rp2040:rpipico','STMicroelectronics:stm32:GenF4','future-vendor:future_arch:custom-rev2:clock=fast'];
function target(fqbn){const bits=fqbn.split(':'),board=bits.slice(0,3).join(':');return {schemaVersion:1,board,boardPackageId:board,coreId:bits.slice(0,2).join(':'),coreVersion:'fixture-1.0',optionsComplete:true,fqbn,options:Object.fromEntries((bits[3]||'').split(',').filter(Boolean).map(s=>s.split('=')))};}
const profile=t=>({board:t.board,boardPackageId:t.boardPackageId,name:'Selected carrier',isCustom:t.boardPackageId!==t.board,pinSource:'publisher',
 pins:Array.from({length:33},(_,i)=>({label:'P'+i,value:String(i),capabilities:['digital'],risks:[{title:'menu-dependent',when:{options:{mode:'debug'}},reserved_by:'debug'}]})),
 resourceGraph:{version:1,coverage:'partial',resources:[{id:'bus0',type:'i2c',sharing:'address',evidence:['publisher']}],routes:[{id:'sda',resource:'bus0',signal:'SDA',mode:'selectable',pins:['P7','P8']}],evidence:[{id:'publisher',source:'board package',confidence:'declared'}]}});

for(const fqbn of targets)test('generic target and library architecture: '+fqbn,()=>{
 const t=target(fqbn),s=api.aiBoardSummary(t),v=api.aiVerificationCapabilities(t,true);
 assert(s.programming.available);assert(s.compilation.ready);assert.deepEqual(s.target.options,t.options);assert.equal(s.target.fqbn,fqbn);assert.equal(s.target.coreVersion,t.coreVersion);
 assert.equal(s.declarations.pinSource,'unknown');assert.equal(api.aiBoardCapabilities(t,undefined,{section:'pins'}).status,'undeclared');
 if(!api.aiSimulationTarget(t)){assert.equal(v.available,false);assert.equal(v.engine,null);assert(!/D13|A0|1023|16MHz/.test(JSON.stringify(v)));assert(v.programmingAvailable);assert.equal(v.compilation.ready,true);}
 let d=api.newAiLibraryDraft();d=api.stageAiLibrary(d,api.aiLibraryFormat(d.id).example);const files=api.buildAiLibrary(d,t).files;
 const manifest=JSON.parse(files['ck-blocks.json']);assert.deepEqual(manifest.compatibility.boards,[t.board]);assert.deepEqual(manifest.compatibility.architectures,[t.board.split(':')[1]]);
});
test('exact package isolation, menu risks and complete resource pages',()=>{
 const t=target('future:custom:carrier:mode=debug'),p=profile(t),rows=[];let offset=0;
 do{const page=api.aiBoardCapabilities(t,p,{section:'pins',offset});rows.push(...page.records);offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(rows,p.pins);assert.deepEqual(api.aiBoardCapabilities(t,p,{section:'routes'}).records,p.resourceGraph.routes);
 assert.deepEqual(api.aiBoardCapabilities(t,p,{section:'evidence'}).records,p.resourceGraph.evidence);
 assert.deepEqual(api.aiBoardCapabilities(t,p,{section:'resources'}).records,p.resourceGraph.resources);
 assert.equal(api.aiBoardCapabilities(t,p,{section:'pins',query:'P32'}).records[0].value,'32');
 assert.throws(()=>api.aiBoardSummary(t,{...p,boardPackageId:'other'}),/不一致/);
 assert.throws(()=>api.aiBoardCapabilities(t,p,{offset:-1}));
 assert.throws(()=>api.aiBoardCapabilities(t,p,{section:'invented'}));
 const huge={...p,pins:[{label:'X',value:'1',source:'x'.repeat(13000)}]};assert.throws(()=>api.aiBoardCapabilities(t,huge,{section:'pins'}),/过大/);
});
test('custom Uno carrier never inherits official simulator, even without loaded metadata',()=>{
 const t={...target('arduino:avr:uno'),boardPackageId:'custom-carrier'};
 assert.equal(api.aiSimulationTarget(t),null);assert.equal(api.aiVerificationCapabilities(t,true).available,false);
 assert.equal(api.aiVerificationCapabilities(t,true,profile(t)).available,false);
 assert.equal(api.aiVerificationCapabilities(target('arduino:avr:uno'),true).available,true);
 assert.equal(api.aiVerificationCapabilities(target('arduino:avr:uno'),false).available,false);
});
test('metadata and syntax do not invent environment readiness',()=>{
 const t=target(targets[0]);assert.equal(api.aiBoardSummary({...t,coreVersion:null}).compilation.ready,false);
 assert.equal(api.aiBoardSummary({...t,optionsComplete:false}).compilation.ready,false);
 assert.equal(api.aiBoardSummary({...t,fqbn:'arduino:avr:mega'}).compilation.ready,false);
 assert.equal(api.aiBoardSummary(t,{...profile(t),compileBlockedReason:'missing package'}).compilation.reason,'missing package');
 assert.equal(api.aiBoardSummary({fqbn:'bad'}).programming.available,false);
});

Blockly.defineBlocksWithJsonArray([{type:'board_test_root',message0:'program %1',args0:[{type:'input_statement',name:'DO'}]},
 {type:'board_test_step',message0:'value %1',args0:[{type:'field_number',name:'VALUE',value:1}],previousStatement:null,nextStatement:null}]);
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const reply=(...toolCalls)=>({content:'',finishReason:'tool_calls',toolCalls});
function fixture(fqbn){
 const ws=new Blockly.Workspace();Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'board_test_root',id:'root'}]}},ws);
 const t=target(fqbn),p=profile(t);let compiles=0;
 const input={prompt:'使用当前板卡编程',intent:{id:1,kind:'generate'},connection:{baseUrl:'http://127.0.0.1:9999/v1',model:'fixture',apiKey:'fixture'},signal:new AbortController().signal,onStep(){},onText(){},host:{
  workspace:()=>ws,catalog:()=>['board_test_root','board_test_step'].map(type=>({type,source:'toolbox',keywords:[type]})),target:()=>t,boardProfile:()=>p,identity:()=> 'stable',projectIdentity:()=> 'stable-project',libraryInventory:()=>[],diagnostics:()=>[],inspectCandidate:()=>'',
  validateBehavior:async()=>{throw Error('No simulation should run for review-only criteria');},
  validateCandidate:async (_preview,ctx)=>{assert.equal(ctx.captureFirmware,false);compiles++;return {ok:true,runId:crypto.randomUUID(),sourceSha256:'a'.repeat(64),elapsedMs:1,log:'mock compiler',diagnostics:[],artifactCount:1};}
 }};return {input,ws,t,p,compiles:()=>compiles};
}
for(const fqbn of targets)test('real runtime builds Blockly plan for '+fqbn+' (compiler mocked)',async()=>{
 const f=fixture(fqbn);let n=0;
 f.input.transport=async req=>{
  const history=req.historyMessages?.filter(m=>m.role==='tool').map(m=>({name:m.name,...JSON.parse(m.content)}))||[];
  if(++n===1){assert.equal(JSON.parse(req.contextJson).target.fqbn,fqbn);return reply(call('get_board_capabilities',{section:'pins'}),call('get_verification_capabilities'),call('read_workspace'),call('get_block_schema',{type:'board_test_step'}));}
  assert.equal(history.find(r=>r.name==='get_board_capabilities').records.length,16);
  return reply(call('set_task_plan',{steps:['按当前板卡构建','本地编译']}),call('set_acceptance_plan',{version:1,requirements:[{id:'device',text:'实际硬件待验证',method:'hardware'}],scenarios:[]}),call('stage_blocks',{summary:'candidate',nodes:[{key:'n',type:'board_test_step',fields:{VALUE:42}}],placements:[{action:'append',blockId:'root',input:'DO',node:'n'}]}),call('propose_change',{summary:'编程候选',edits:[]}));
 };
 try{const r=await api.runAiTask(f.input);assert(r.preview);assert.equal(f.compiles(),1);assert.equal(f.ws.getAllBlocks(false).length,1);assert.match(r.text,/真机.*待验证/);}finally{f.ws.dispose();}
});
for(const change of ['board','core','options','profile'])test('in-flight '+change+' change stops before compile',async()=>{
 const f=fixture('future:custom:carrier');f.input.transport=async()=>{if(change==='board')f.t.fqbn='other:arch:board';if(change==='core')f.t.coreVersion='changed';if(change==='options')f.t.options.mode='changed';if(change==='profile')f.p.pins[0].value='changed';return reply(call('get_board_capabilities'));};
 try{await assert.rejects(api.runAiTask(f.input),/变化/);assert.equal(f.compiles(),0);}finally{f.ws.dispose();}
});
test('independent library mode exposes exact target capability tool',async()=>{
 const f=fixture('future:arch:board');f.input.intent.kind='library';f.input.host.library={validate:async()=>{throw Error('unexpected compile');}};let n=0;
 f.input.transport=async req=>{assert(req.tools.some(t=>t.function.name==='get_board_capabilities'));if(++n===1)return reply(call('get_board_capabilities',{section:'resources'}));assert(req.historyMessages.some(r=>r.role==='tool'&&r.content.includes('bus0')));return {content:'已读取板卡声明，缺少硬件资料，未制作库。',finishReason:'stop'};};
 try{await api.runAiTask(f.input);assert.equal(f.compiles(),0);}finally{f.ws.dispose();}
});
test('background alias enrichment preserves the task snapshot; package declaration changes still stop it',async()=>{
 for(const replacePackage of [false,true]){
  const f=fixture('future:arch:carrier');f.p.declarationIdentity='package-v1';let round=0;
  f.input.transport=async req=>{
   if(++round===1){f.p.pins[0].aliases=['newly-loaded-core-alias'];if(replacePackage)f.p.declarationIdentity='package-v2';return reply(call('get_board_capabilities',{section:'pins'}));}
   const pins=JSON.parse(req.historyMessages.find(r=>r.name==='get_board_capabilities').content).records;
   assert.equal(pins[0].aliases,undefined,'tool uses the coherent starting snapshot');
   return {content:'资料已读取，未修改工程。',finishReason:'stop'};
  };
  try{if(replacePackage)await assert.rejects(api.runAiTask(f.input),/声明已变化/);else await api.runAiTask(f.input);}finally{f.ws.dispose();}
 }
});
