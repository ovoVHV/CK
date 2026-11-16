import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath,pathToFileURL} from 'node:url';
import {build} from 'esbuild';
const root=path.dirname(fileURLToPath(import.meta.url));
const out=path.resolve(root,'../../node_modules/.cache/ck-ai-tests/library-context.mjs');
await build({entryPoints:[path.join(root,'ai_library_context.ts')],outfile:out,platform:'node',format:'esm',bundle:true,logLevel:'silent'});
const {aiSearchBlocks,aiListLibraries,aiCapabilitySummary,aiReadBlockDocumentation}=await import(pathToFileURL(out));
const probe={type:'vendor_xyz',display_name:'模块读取',source:'manifest',library_id:'third_party',keywords:[],
 semantics:{purpose:'超声波测距',behavior:'触发后等待回波，最多等待30毫秒',concepts:['距离','测距'],side_effects:['阻塞直到超时']},
 output:{connection:'value',types:['Number'],unit:'cm',description:'测量距离；-1表示超时'},
 hardware:{resources:[{kind:'gpio',source:{kind:'field',name:'TRIG'},description:'触发输出'},{kind:'gpio',source:{kind:'input',name:'ECHO'},description:'回波输入'}],notes:['接线由用户确认']},
 constraints:[{id:'min-period',description:'两次测量间隔至少60毫秒',message:'采样过快',severity:'warning'}],
 examples:[{id:'distance',title:'周期测距',description:'60毫秒间隔',expected_behavior:'输出厘米值；超时返回-1',project:'examples/demo.ck'}],
 errors:[{code:'timeout',message:'回波超时',cause:'未收到回波',recovery:'检查接线'}],
};
test('capability search finds neutral third-party names by authored purpose and side effects',()=>{
 assert.equal(aiSearchBlocks([probe],{query:'测距'}).blocks[0].type,'vendor_xyz');
 assert.equal(aiSearchBlocks([probe],{query:'阻塞'}).total,1);
 assert.equal(aiSearchBlocks([probe],{query:'测距',libraryId:'other'}).total,0);
 assert.equal(aiListLibraries([probe],{query:'测距'}).libraries[0].libraryId,'third_party');
});
test('documentation retains units, pin source, constraints, example and recovery as read-only data',()=>{
 const before=JSON.stringify(probe);
 for(const section of ['output','hardware','constraints','examples','errors']){
  const r=aiReadBlockDocumentation([probe],{type:probe.type,section});
  assert.equal(r.status,'declared');assert.equal(r.hardwareTested,'unknown');assert(r.records.length);
 }
 assert.equal(aiReadBlockDocumentation([probe],{type:probe.type,section:'output'}).records[0].unit,'cm');
 assert.equal(aiReadBlockDocumentation([probe],{type:probe.type,section:'hardware'}).records[2].value.source.name,'ECHO');
 assert.equal(aiReadBlockDocumentation([probe],{type:probe.type,section:'examples'}).records[0].project,'examples/demo.ck');
 assert.equal(JSON.stringify(probe),before);
});
test('legacy fallback and explicitly empty declarations are distinguished',()=>{
 const old={type:'old',source:'toolbox',keywords:[],metadata_source:'v1-adapted',metadata_completeness:[],semantics:{purpose:'默认说明'},constraints:[]};
 assert.equal(aiReadBlockDocumentation([old],{type:'old',section:'constraints'}).status,'adapted');
 assert.equal(aiReadBlockDocumentation([old],{type:'old',section:'hardware'}).status,'undeclared');
 assert.equal(aiCapabilitySummary(old).declaredSections.length,0);
 assert.equal(aiListLibraries([old],{}).libraries[0].describedBlocks,0);
 assert.equal(aiReadBlockDocumentation([{...old,metadata_completeness:['constraints']}],{type:'old',section:'constraints'}).status,'declared');
});
test('large documents paginate complete records and report oversized entries explicitly',()=>{
 const big={...probe,examples:Array.from({length:30},(_,i)=>({id:String(i),description:'a'.repeat(2000)}))};
 const ids=[];let offset=0;
 do{const page=aiReadBlockDocumentation([big],{type:big.type,section:'examples',offset,limit:20});for(const r of page.records){assert.equal(r.description.length,2000);ids.push(r.id);}offset=page.nextOffset;}while(offset!==null);
 assert.deepEqual(ids,Array.from({length:30},(_,i)=>String(i)));
 assert.throws(()=>aiReadBlockDocumentation([{...probe,examples:[{description:'x'.repeat(20000)}]}],{type:probe.type,section:'examples'}),/过大/);
});
test('invalid requests cannot read arbitrary paths or use inherited properties as sections',()=>{
 for(const args of [{type:'absent',section:'semantics'},{type:probe.type,section:'constructor'},{type:probe.type,section:'examples',offset:-1},{type:probe.type,section:'examples',limit:0}])assert.throws(()=>aiReadBlockDocumentation([probe],args));
 assert.throws(()=>aiSearchBlocks([probe],{query:'x',offset:NaN}));
 assert.throws(()=>aiListLibraries([probe],{query:'x'.repeat(300)}));
});
test('library and search pagination cover all current entries with no invented availability',()=>{
 const catalog=Array.from({length:19},(_,i)=>({...probe,type:'x'+i,library_id:'lib'+i}));
 let offset=0,count=0;do{const r=aiListLibraries(catalog,{offset});count+=r.libraries.length;offset=r.nextOffset;}while(offset!==null);assert.equal(count,19);
 assert.equal(aiSearchBlocks(catalog,{query:'测距'}).nextOffset,16);
 assert.equal(aiSearchBlocks(catalog,{query:'测距',offset:16}).blocks.length,3);
 assert.equal(aiSearchBlocks([],{query:'测距'}).total,0);
});
