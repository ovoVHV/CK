// Scripted local provider; shipped UI, real board metadata, library install and native compiler.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(cfg.paths.evidenceRoot,'ai-boards-'+Date.now());fs.mkdirSync(out,{recursive:true});
const boards=process.env.CK_AI_BOARD_MATRIX?JSON.parse(process.env.CK_AI_BOARD_MATRIX):[
 'arduino:avr:uno','arduino:avr:nano','arduino:avr:mega','arduino:avr:diecimila',
 'esp32:esp32:esp32','esp32:esp32:esp32s3','esp32:esp32:esp32c3','esp32:esp32:esp32s2','esp32:esp32:esp32c6','esp32:esp32:esp32c5'];
const prefs=path.join(cfg.paths.sysroot,'state/ai-assistant-v1/preferences.json'),savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const report={status:'RUNNING',model:'scripted localhost provider; no live provider/model qualification',frontendOverride:process.env.CK_AI_BOARD_DEV==='1',physicalHardware:false,desktopSha256:JSON.parse(fs.readFileSync(path.join(cfg.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256,boards:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const delay=ms=>new Promise(r=>setTimeout(r,ms)),call=(name,args={})=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
let client,current,requests=0,savedSettings;
function fixture(id){return {name:'Board matrix accumulator',description:'跨架构测试：可复用的整数累加器，未访问硬件',blocks:[{
 definition:{type:id+'_add',message0:'累计数值 %1',args0:[{type:'field_number',name:'VALUE',value:2}],previousStatement:null,nextStatement:null,colour:'#f97316'},
 generator:{type:id+'_add',kind:'statement',template:`ck_add_${id}({{field:VALUE}});\n`,includes:{native:`#include <${id}.h>`}},
 documentation:{description:'加入一个数值，保留累计值；仅当前板卡试编译',hardware:{resources:[],claims:{version:1,coverage:'partial',templates:[]}}}
 }],files:[{path:'src/'+id+'.h',content:`#pragma once\n#include <Arduino.h>\nvoid ck_add_${id}(uint16_t v);\n`},
 {path:'src/'+id+'.cpp',content:`#include "${id}.h"\nstatic volatile uint32_t total;\nvoid ck_add_${id}(uint16_t v){total+=v;}\n`}]};}
const server=http.createServer(async(req,res)=>{try{
 let raw='';for await(const b of req)raw+=b;const body=JSON.parse(raw);requests++;
 const rows=body.messages.filter(r=>r.role==='tool').map(r=>({tool:r.name,...JSON.parse(r.content)}));
 const prior=rows.find(r=>r.error||r.compiled===false);if(prior)throw Error(JSON.stringify(prior));
 const has=n=>rows.some(r=>r.tool===n);let tools;
 if(!has('get_board_capabilities')){
  const marker='当前上下文(JSON)：';
  const initial=body.messages.find(m=>m.role==='user'&&typeof m.content==='string'&&m.content.includes(marker));
  assert(initial);const context=JSON.parse(initial.content.slice(initial.content.indexOf(marker)+marker.length));
  assert.equal(context.target.board,current.board);assert(context.boardCapabilities);current.context=context;save();
  tools=[call('get_board_capabilities'),call('get_board_capabilities',{section:'pins'}),call('get_board_capabilities',{section:'resources'}),call('get_verification_capabilities'),call('read_workspace'),call('search_blocks',{query:'board_matrix_accumulator'})];
 }else if(!has('begin_library')){
  current.capabilities=rows.filter(r=>r.tool==='get_board_capabilities');current.verification=rows.find(r=>r.tool==='get_verification_capabilities');
  assert.equal(current.capabilities[0].target.board,current.board);assert(current.capabilities[0].compilation.ready);
  if(!['arduino:avr:uno','arduino:avr:nano'].includes(current.board)){assert.equal(current.verification.available,false);assert(!/D13|A0–A5|1023/.test(JSON.stringify(current.verification)));}
  tools=[call('set_task_plan',{steps:['读取当前板卡并补建库','编译加载库并继续工程']}),call('set_acceptance_plan',{version:1,requirements:[{id:'device',text:'编译、加载和声明按当前板卡核对；实际硬件行为待验证',method:'hardware'}],scenarios:[]}),call('begin_library',{reason:'测试可复用的整数累加能力'})];
 }else{
  const id=rows.find(r=>r.tool==='begin_library').id;current.libraryId=id;
  if(rows.some(r=>r.installed)){
   const installed=rows.find(r=>r.installed),schema=installed.schemas.find(s=>s.type===id+'_add');assert(schema);current.installedSchemas=installed.schemas;
   // The normal CK loader may adapt editable numeric fields to value inputs.
   // Consume the returned runtime schema, just as a model must.
   if(!has('get_block_schema'))tools=[call('get_block_schema',{type:'math_number'})];
   else {const input=schema.inputs.some(i=>i.name==='VALUE');
    const nodes=input?[{key:'add',type:id+'_add',inputs:{VALUE:'number'}},{key:'number',type:'math_number',fields:{NUM:7}}]:[{key:'add',type:id+'_add',fields:{VALUE:7}}];
    tools=[call('stage_blocks',{summary:'补库后完成当前工程',nodes,placements:[{action:'append',blockId:current.loop,input:'DO',node:'add'}]}),call('read_staged_code'),call('propose_change',{summary:'当前板卡补库与工程候选编译',edits:[]})];
   }
  }
  else if(!has('stage_library'))tools=[call('stage_library',fixture(id))];
  else tools=[call('submit_library')];
 }
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:tools.map((t,index)=>({index,...t}))},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(e){current.providerError=String(e.stack);res.writeHead(500);res.end(String(e));save();}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));
const invoke=(n,a)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(n)},${JSON.stringify(a)})`);
async function wait(expr,label,timeout=360000){const at=Date.now();while(Date.now()-at<timeout){if(await client.evaluate(expr))return;const error=await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);if(error)throw Error(label+': '+error);await delay(200);}throw Error('Timeout '+label);}
const click=sel=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(sel)});e.click()})()`);
const fill=(sel,value)=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));})()`);
const snap=()=>client.evaluate(`JSON.stringify(window.CK_NATIVE_REGRESSION.getCurrent().Blockly.serialization.workspaces.save(window.CK_NATIVE_REGRESSION.getCurrent().workspace))`);
try{
 client=await connectDesktop();savedSettings=await client.evaluate(`localStorage.getItem('ck_ai_connection_v1')`);
 await client.evaluate(`(()=>{window.__boardIpc=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&(command==='compile_ai_candidate'||command==='ai_prepare_library'||command==='ai_install_library')){const row={command,args:JSON.parse(options.body),at:performance.now()};window.__boardIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.wallMs=performance.now()-row.at;row.done=true;return response;}return original(url,options);};})()`);
 for(const board of boards){
  current={board,status:'RUNNING',loop:'loop-'+randomUUID()};report.boards.push(current);save();
  const file=path.join(out,board.replaceAll(':','_')+'.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'AI 板卡兼容回归',board,board_package_id:board,options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_setup_custom',id:'setup-'+current.loop,x:60,y:70},{type:'controls_loop_custom',id:current.loop,x:60,y:200}]}})}));
  const openRequestId=randomUUID();
  for(let n=0;n<240;n++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(current.loop)})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(n%8===0)await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:openRequestId,path:file,source:'ai-boards-regression'}});await delay(250);}
  await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board ready '+board);
  if(!await client.evaluate(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`))await click('[data-ck-role="ai-assistant-trigger"]');
  await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`,'AI ready');
  await delay(800);
  if(current===report.boards[0]){
   await click('button[aria-label="模型连接设置"]');await fill('.ck-ai-settings input[type="url"]',`http://127.0.0.1:${server.address().port}/v1`);await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])','board-fixture');await fill('.ck-ai-settings input[type="password"]','local-fixture-not-a-key');await fill('input[aria-label="上下文预算"]','65536');await fill('input[aria-label="单次回复预留"]','4096');
   await client.evaluate(`(()=>{const b=[...document.querySelectorAll('.ck-ai-settings button')].find(b=>b.textContent.trim()==='保存连接设置');b.click()})()`);await wait(`!document.querySelector('.ck-ai-settings')`,'saved');
   await client.evaluate(`(()=>{const e=document.querySelector('[aria-label="AI 修改模式"]');Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,'manual');e.dispatchEvent(new Event('change',{bubbles:true}));})()`);await delay(200);
  }
  const before=await snap(),start=await client.evaluate('window.__boardIpc.length');
  await fill('.ck-ai-input-shell textarea','读取当前板卡能力，补建整数累加积木库并加载，循环累加7，保留原工程容器并本地编译。');await delay(100);await click('button[aria-label="发送需求"]');
  await wait(`Boolean(document.querySelector('.ck-ai-proposal'))&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'board candidate '+board);
  assert.equal(await snap(),before);current.ipc=await client.evaluate(`window.__boardIpc.slice(${start})`);
  const compiled=current.ipc.filter(r=>r.command==='compile_ai_candidate');assert.equal(compiled.length,2);
  for(const row of compiled){assert.equal(row.args.fqbn,current.context.target.fqbn);assert.equal(row.args.coreVersion,current.context.target.coreVersion);assert.equal(row.args.boardPackageId,board);assert.equal(row.args.captureFirmware,false);const result=JSON.parse(JSON.parse(row.response));assert(result.ok&&result.artifactCount>0);}
  assert(compiled[0].args.libraryToken);assert(!compiled[1].args.libraryToken);assert(current.ipc.some(r=>r.command==='ai_install_library'&&r.kind==='ok'));
  const prepared=current.ipc.find(r=>r.command==='ai_prepare_library'),contract=JSON.parse(prepared.args.files['ck-blocks.json']);assert.deepEqual(contract.compatibility.boards,[board]);assert.deepEqual(contract.compatibility.architectures,[board.split(':')[1]]);
  assert(await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.some(b=>b.library_id===${JSON.stringify(current.libraryId)})`));
  fs.writeFileSync(path.join(out,board.replaceAll(':','_')+'.ino'),compiled[1].args.code);
  current.status='PASS';save();console.log(JSON.stringify({board,status:'PASS',builds:compiled.map(r=>Math.round(r.wallMs)),pins:current.capabilities.find(r=>r.section==='pins')?.total}));
 }
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);if(current)current.status='FAIL';if(client)report.ui=await client.evaluate('document.body.innerText.slice(-12000)').catch(()=>null);process.exitCode=1;}
finally{
 report.requests=requests;if(client)report.allIpc=await client.evaluate('window.__boardIpc').catch(()=>[]);
 // Remove only packages created by this run, after keeping their source in the report.
 for(const row of report.boards){if(!/^ck_ai_[a-f0-9]{12}$/.test(row.libraryId||''))continue;
  const base=path.resolve(cfg.paths.sysroot,'libraries'),folder=path.resolve(base,row.board.replaceAll(':','_'),row.libraryId);
  assert(folder.startsWith(base+path.sep));
  if(fs.existsSync(folder)){const manifest=JSON.parse(fs.readFileSync(path.join(folder,'library.json'),'utf8'));assert.equal(manifest.id,row.libraryId);assert.equal(manifest.name,'Board matrix accumulator');fs.rmSync(folder,{recursive:true});row.fixtureRemoved=true;}
 }
 save();if(client){if(savedSettings===null)await client.evaluate(`localStorage.removeItem('ck_ai_connection_v1')`).catch(()=>{});else if(savedSettings!==undefined)await client.evaluate(`localStorage.setItem('ck_ai_connection_v1',${JSON.stringify(savedSettings)})`).catch(()=>{});}
 if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);
 client?.close();server.close();console.log(JSON.stringify({out,status:report.status,error:report.error}));
}
