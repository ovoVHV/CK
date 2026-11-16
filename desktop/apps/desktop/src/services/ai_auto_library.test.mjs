import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath, pathToFileURL } from 'node:url';
import { build } from 'esbuild';
import * as Blockly from 'blockly';
import 'blockly/blocks';
const here=path.dirname(fileURLToPath(import.meta.url));
const output=path.resolve(here,'../../node_modules/.cache/ai-auto-library/runtime.mjs');
await build({stdin:{contents:`export * from ${JSON.stringify(path.join(here,'ai_assistant_runtime.ts'))};export * from ${JSON.stringify(path.join(here,'ai_library_authoring.ts'))};export * from ${JSON.stringify(path.join(here,'ai_workspace.ts'))};`,resolveDir:here,loader:'ts'},outfile:output,platform:'node',format:'esm',bundle:true,packages:'external',logLevel:'silent'});
const api=await import(pathToFileURL(output));
Blockly.defineBlocksWithJsonArray([
 {type:'auto_test_root',message0:'程序 %1',args0:[{type:'input_statement',name:'DO'}]},
 {type:'auto_test_wait',message0:'等待 %1',args0:[{type:'field_number',name:'MS',value:1}],previousStatement:null,nextStatement:null},
]);
const call=(name,args={})=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const result=()=>({ok:true,runId:crypto.randomUUID(),sourceSha256:'source',elapsedMs:1,log:'ok',diagnostics:[],artifactCount:1});
function fixture(){
 const ws=new Blockly.Workspace();Blockly.serialization.workspaces.load({blocks:{languageVersion:0,blocks:[{type:'auto_test_root',id:'root'}]}},ws);
 const state={identity:'catalog-0',project:'same-project',inventory:[],catalog:['auto_test_root','auto_test_wait'].map(type=>({type,source:'toolbox',keywords:[type]})),installs:[],drafts:[],validations:[],queue:[],round:0,projectCompiles:0,registered:[],events:[],discarded:[],controller:new AbortController()};
 const host={workspace:()=>ws,catalog:()=>state.catalog,target:()=>({fqbn:'arduino:avr:uno'}),identity:()=>state.identity,projectIdentity:()=>state.project,libraryInventory:()=>state.inventory,diagnostics:()=>[],inspectCandidate:()=> 'code',validateCandidate:async()=>{state.projectCompiles++;return result();},library:{
  validate:async draft=>{state.drafts.push(draft);return {token:crypto.randomUUID(),packageId:draft.id,name:draft.name,version:draft.version,contentSha256:'sha-'+draft.id,types:draft.blocks.map(b=>b.definition.type),files:Object.keys(draft.files),source:'code',validation:result()};},
  install:async (preview,signal,_step,check)=>{check?.();signal.throwIfAborted();const draft=state.drafts.at(-1);Blockly.defineBlocksWithJsonArray(draft.blocks.map(b=>b.definition));state.registered.push(...preview.types);state.inventory.push({packageId:preview.packageId,contentSha256:preview.contentSha256});state.catalog.push(...preview.types.map(type=>({type,source:'toolbox',library_id:preview.packageId,keywords:[type,'custom']})));state.identity='catalog-'+preview.packageId;check?.();state.installs.push(preview);},
  discard:async token=>{state.discarded.push(token);},export:async()=>null,
 }};
 const input={prompt:'完成原工程，缺少的底层能力自行补库',intent:{id:1,kind:'generate'},connection:{baseUrl:'http://127.0.0.1:9876/v1',model:'fixture',apiKey:'fixture'},host,signal:state.controller.signal,onText(){},onStep(){},onValidation:v=>state.validations.push(v),onLibraryInstalled:v=>state.events.push(v),transport:async req=>{
  const next=state.queue[state.round++];assert(next,'unexpected extra model request');const calls=typeof next==='function'?await next(req):next;return {toolCalls:calls,finishReason:'tool_calls'};
 }};
 const tools=req=>req.historyMessages.filter(r=>r.role==='tool').map(r=>({...JSON.parse(r.content),name:r.name}));
 const begin=()=>[call('search_blocks',{query:'custom'}),call('begin_library',{reason:'现有库缺少可复用测试能力'})];
 const stage=req=>{const id=tools(req).findLast(r=>r.name==='begin_library'&&r.id)?.id;assert(id);return [call('stage_library',api.aiLibraryFormat(id).example)];};
 const use=req=>{const entry=tools(req).findLast(r=>r.installed);assert(entry);const schema=entry.schemas[0];return [call('read_workspace'),call('stage_blocks',{summary:'原工程新增能力',nodes:[{key:'new',type:schema.type,fields:schema.template.fields}],placements:[{action:'append',blockId:'root',input:'DO',node:'new'}]}),call('propose_change',{summary:'完整工程',edits:[]})];};
 return {state,host,input,ws,begin,stage,use,tools,close(){ws.dispose();for(const type of state.registered)delete Blockly.Blocks[type];}};
}

test('main chat installs a missing library, consumes refreshed schemas and returns a compiled project without editing live workspace',async()=>{
 const t=fixture(),before=api.aiWorkspaceSnapshot(t.ws);t.state.queue=[t.begin(),t.stage,[call('submit_library')],req=>{assert(!req.tools.some(t=>t.function.name==='stage_library'));assert(!req.historyMessages.some(r=>r.tool_calls?.some(c=>c.function.name==='stage_library')),'committed draft payload is not resent');assert(req.historyMessages.some(r=>r.role==='tool'&&JSON.parse(r.content).installed),'installation proof remains');return t.use(req);}];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.equal(res.identity,t.state.identity);assert.equal(res.installedLibraries.length,1);assert.deepEqual(t.state.validations.map(v=>v.scope),['library','project']);assert.equal(api.aiWorkspaceSnapshot(t.ws),before);assert.equal(t.state.installs.length,1);assert(t.state.discarded.includes(t.state.installs[0].token),'release committed draft');assert.equal(t.state.projectCompiles,1);}finally{t.close();}
});

test('library retries are separate from project attempts and duplicate submit cannot reinstall',async()=>{
 const t=fixture();const validate=t.host.library.validate;let n=0;
 t.host.library.validate=async d=>{const p=await validate(d);p.validation.ok=++n===3;return p;};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')],[call('submit_library')],[call('submit_library')],req=>[call('submit_library'),...t.use(req)]];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.deepEqual(t.state.validations.map(v=>[v.scope,v.attempt]),[['library',1],['library',2],['library',3],['project',1]]);assert.equal(t.state.installs.length,1);}finally{t.close();}
});

test('search is required and explain mode cannot create or install',async()=>{
 for(const explain of [false,true]){const t=fixture();if(explain)t.input.intent.kind='explain';
  t.state.queue=[[call('begin_library',{reason:'skip search'})],req=>{assert(t.tools(req).at(-1).error);if(explain)assert(!req.tools.some(t=>t.function.name==='begin_library'));return [call('report_blocker',{reason:'缺少信息'})];}];
  try{const res=await api.runAiTask(t.input);assert.match(res.text,/尚未完成/);assert.equal(t.state.installs.length,0);}finally{t.close();}
 }
});

test('failed activation may retry only after complete inventory rollback; then catalog searches see new entries',async()=>{
 const t=fixture();const install=t.host.library.install;let attempts=0;
 t.host.library.install=async(...args)=>{if(++attempts===1){t.state.identity='catalog-rollback';throw Error('load failed; rolled back');}return install(...args);};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')],req=>{assert.match(t.tools(req).at(-1).error,/load failed/);return [call('submit_library')];},[call('search_blocks',{query:'custom'})],req=>{const search=t.tools(req).at(-1);assert(!search.unchanged);assert(JSON.stringify(search).includes(t.state.installs[0].packageId));return t.use(req);}];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.equal(t.state.installs.length,1);}finally{t.close();}
});

for(const change of ['project','workspace','other-library'])test(`installation cannot authorize concurrent ${change} changes`,async()=>{
 const t=fixture();t.host.library.install=async(_p,_s,_step,check)=>{if(change==='project')t.state.project='new-project';else if(change==='workspace')t.ws.newBlock('auto_test_wait');else t.state.inventory.push({packageId:'foreign',contentSha256:'new'});check();};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')]];
 try{await assert.rejects(api.runAiTask(t.input),/变化|可用库集合/);assert.equal(t.state.projectCompiles,0);assert.equal(t.state.installs.length,0);}finally{t.close();}
});

test('late cancellation records committed installation without returning or compiling a project',async()=>{
 const t=fixture(),install=t.host.library.install;t.host.library.install=async(...args)=>{await install(...args);t.state.controller.abort();};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')]];
 try{await assert.rejects(api.runAiTask(t.input));assert.equal(t.state.events.length,1);assert.equal(t.state.installs.length,1);assert.equal(t.state.projectCompiles,0);}finally{t.close();}
});

test('two distinct supplements preserve the prior graph and report each installation once',async()=>{
 const t=fixture();let firstType;
 t.state.queue=[[call('read_workspace'),call('get_block_schema',{type:'auto_test_wait'}),call('stage_blocks',{summary:'保留原需求',nodes:[{key:'wait',type:'auto_test_wait',fields:{MS:123}}],placements:[{action:'append',blockId:'root',input:'DO',node:'wait'}]}),...t.begin()],t.stage,[call('submit_library')],req=>{firstType=t.tools(req).findLast(r=>r.installed).schemas[0].type;return t.begin();},t.stage,[call('submit_library')],req=>{const calls=t.use(req);calls[1].function.arguments=JSON.stringify({summary:'组合两个库',nodes:[{key:'new',type:t.state.installs[1].types[0],next:'first'},{key:'first',type:firstType}],placements:[{action:'append',blockId:'root',input:'DO',node:'new'}]});return calls;}];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.equal(res.installedLibraries.length,2);assert.equal(res.preview.proposal.edits[0].block.fields.MS,123);assert.equal(t.state.projectCompiles,1);}finally{t.close();}
});

test('failed project compile keeps exact staged graph for a local patch instead of rebuilding',async()=>{
 const t=fixture();t.host.validateCandidate=async()=>({...result(),ok:++t.state.projectCompiles>1});
 t.state.queue=[[call('read_workspace'),call('get_block_schema',{type:'auto_test_wait'}),call('stage_blocks',{summary:'保留状态',nodes:[{key:'wait',type:'auto_test_wait',fields:{MS:123}}],placements:[{action:'append',blockId:'root',input:'DO',node:'wait'}]}),call('propose_change',{summary:'完整方案',edits:[]})],req=>{assert.match(t.tools(req).at(-1).instruction,/暂存图保留/);return [call('stage_blocks',{summary:'局部修复',patch:true,nodes:[{key:'wait',type:'auto_test_wait',fields:{MS:456}}],placements:[]}),call('propose_change',{summary:'修复后完整方案',edits:[]})];}];
 try{const res=await api.runAiTask(t.input);assert.equal(res.preview.proposal.edits[0].block.fields.MS,456);assert.equal(res.preview.proposal.edits.length,1);assert.equal(t.state.projectCompiles,2);}finally{t.close();}
});

test('library limit stops a third creation without losing already committed installation records',async()=>{
 const t=fixture();t.state.queue=[t.begin(),t.stage,[call('submit_library')],t.begin(),t.stage,[call('submit_library')],t.begin()];
 try{await assert.rejects(api.runAiTask(t.input),/补库上限/);assert.equal(t.state.installs.length,2);assert.equal(t.state.events.length,2);assert.equal(t.state.projectCompiles,0);}finally{t.close();}
});

test('a changed existing block schema is not silently authorized by a library refresh',async()=>{
 const t=fixture(),install=t.host.library.install,old=Blockly.Blocks.auto_test_wait;
 t.host.library.install=async(...args)=>{await install(...args);Blockly.Blocks.auto_test_wait={init(){this.appendDummyInput().appendField('changed');this.setOutput(true);}};};
 t.state.queue=[[call('get_block_schema',{type:'auto_test_wait'}),...t.begin()],t.stage,[call('submit_library')]];
 try{await assert.rejects(api.runAiTask(t.input),/已有积木结构发生变化/);assert.equal(t.state.projectCompiles,0);assert.equal(t.state.events.length,1);}finally{Blockly.Blocks.auto_test_wait=old;t.close();}
});

test('previously inspected loop variable schemas survive library reload and resume project compilation',async()=>{
 const t=fixture();t.state.catalog.push({type:'controls_for',source:'toolbox',keywords:[],xml_template:'<block type="controls_for"><field name="VAR">i</field></block>'});
 t.state.queue=[[call('get_block_schema',{type:'controls_for'}),...t.begin()],t.stage,[call('submit_library')],t.use];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.equal(t.state.projectCompiles,1);assert.equal(t.state.installs.length,1);}finally{t.close();}
});

test('temporary inventory clearing during toolbox reload is not mistaken for external library mutation',async()=>{
 const t=fixture(),install=t.host.library.install;
 t.state.inventory=[{packageId:'old',contentSha256:'stable'}];
 t.host.library.install=async(...args)=>{const before=t.state.inventory;t.state.inventory=[];await new Promise(r=>setTimeout(r,220));t.state.inventory=before;args[1].throwIfAborted();await install(...args);};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')],t.use];
 try{const res=await api.runAiTask(t.input);assert(res.preview);assert.equal(t.state.installs.length,1);}finally{t.close();}
});

test('metadata preflight failures do not spend the real compiler retry budget',async()=>{
 const t=fixture(),validate=t.host.library.validate;let attempts=0;
 t.host.library.validate=async(...args)=>{if(++attempts<=3)throw Error('/blocks/0/constraints: must be array; not compiled');return validate(...args);};
 t.state.queue=[t.begin(),t.stage,[call('submit_library')],[call('submit_library')],[call('submit_library')],[call('submit_library')],t.use];
 try{const result=await api.runAiTask(t.input);assert(result.preview);assert.deepEqual(t.state.validations.map(v=>[v.scope,v.attempt]),[['library',1],['project',1]]);assert.equal(t.state.installs.length,1);}finally{t.close();}
});
