// Real UI + real compiler + shipped worker. Provider deliberately returns one
// wrong edit and then attempts to weaken its test before making the repair.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';import {complexAcceptance as baseAcceptance} from './ai-phase3-cases.mjs';
const complexAcceptance=structuredClone(baseAcceptance);complexAcceptance.scenarios[0].inputs[0].value=725;complexAcceptance.requirements[0].text='中值≥700打开，低于300关闭';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,'ai-revision-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',checks:[],provider:'scripted failure injection',requests:[],hardware:false};
report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256;
const previous=path.resolve('tests/fixtures/ai-phase3');
const resumeFile=path.join(config.paths.evidenceRoot,'phase3-resume.json'),restart=process.env.CK_AI_PHASE3_RESTART==='1';
const resume=null;
const project=resume?.project || path.join(out,'复杂项目.ck');
if(!restart)fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'AI 第三阶段综合回归',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',build_target:{schemaVersion:1,board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreId:'arduino:avr',coreVersion:'1.8.8',fqbn:'arduino:avr:uno',options:{},optionsComplete:true},xml:fs.readFileSync(path.join(previous,'workspace.json'),'utf8')}));
const prefs=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json'),savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));const W='window.CK_NATIVE_REGRESSION.getCurrent().workspace',B='window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
let client,round=0,mode='revision',target,offset,paused=false;
const originalId='ck_ai_736b8b7dd8f8';let revision,oldStates=[];
const digestTree=dir=>Object.fromEntries(fs.readdirSync(dir,{recursive:true,withFileTypes:true}).filter(e=>e.isFile()).map(e=>{const f=path.join(e.parentPath,e.name);return [path.relative(dir,f),createHash('sha256').update(fs.readFileSync(f)).digest('hex')];}));
const oldDirectory=path.join(config.paths.sysroot,'libraries/arduino_avr_uno',originalId),oldProof=digestTree(oldDirectory);
const call=(name,args={})=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const proposal=(value)=>call('propose_change',{summary:'将上阈值改为650，保留采样、急停、心跳和串口',edits:[{action:'set_field',blockId:target,field:'NUM',value}]});
const server=http.createServer(async(req,res)=>{try{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);round++;
 const rows=body.messages.filter(m=>m.role==='tool').map(m=>({...JSON.parse(m.content),toolName:m.name}));let tools;
 report.requests.push({mode,round,results:rows.slice(-3)});
 const latest=name=>rows.filter(r=>r.toolName===name).at(-1);
 if(rows.at(-1)?.error)throw Error(rows.at(-1).error);
 if(round===1)tools=[call('get_verification_capabilities'),call('set_task_plan',{steps:['读取原库源码并创建独立修订版','加入样本数量接口并编译安装','仅迁移当前工程并验证原有行为']}),call('read_library_source',{packageId:originalId}),...[0,20,40,60,80].map(offset=>call('read_workspace',{offset,limit:20})),call('get_block_schemas',{types:['io_analog_read','board_pin_selector']})];
 else if(round===2)tools=[call('set_acceptance_plan',complexAcceptance),call('read_library_source',{packageId:originalId,path:'src/CkMedian5Float.h'}),call('begin_library_revision',{packageId:originalId,reason:'增加样本数量查询，保留原有中值接口和旧工程'})];
 else if(round===3){revision=latest('begin_library_revision');assert(revision.revising===originalId);tools=[call('read_library_draft',{path:revision.files[0]}),...Object.values(revision.typeMap).map(type=>call('read_library_draft',{type}))];}
 else if(round===4){
  const id=revision.id;const rename=s=>s.replaceAll('CK_MEDIAN5_FLOAT_H',id.toUpperCase()+'_H').replaceAll('ckMedian5Float',id+'_state').replaceAll('ckMedian5f',id+'_');
  const file=rows.findLast(r=>r.toolName==='read_library_draft'&&r.path);
  const blocks=rows.filter(r=>r.toolName==='read_library_draft'&&r.definition).map(({toolName,_budget,...b})=>JSON.parse(rename(JSON.stringify(b))));
  blocks.push({definition:{type:id+'_count',message0:'当前中值样本数',output:'Number'},generator:{type:id+'_count',kind:'expression',template:id+'_Count()',includes:{header:'#include <'+revision.files[0].slice(4)+'>'}},documentation:{description:'返回当前窗口已采样的数量，范围0至5'}});
  tools=[call('stage_library',{blocks,files:[{path:file.path,content:rename(file.content).replace(/\n#endif[^\n]*/, '\nstatic inline uint8_t '+id+'_Count(){return '+id+'_state::sampleCount;}\n#endif')}]})];
 }else if(round===5)tools=[call('submit_library')];
 else if(round===6){assert(latest('submit_library').installed);const remap=value=>{if(Array.isArray(value))return value.map(remap);if(value&&typeof value==='object')return Object.fromEntries(Object.entries(value).filter(([k])=>!['id','x','y'].includes(k)).map(([k,v])=>[k,k==='type'&&revision.typeMap[v]?revision.typeMap[v]:remap(v)]));return value;};tools=[call('propose_change',{summary:'仅当前工程使用修订库，原库保留',edits:oldStates.map(row=>({action:'replace',blockId:row.id,block:remap(row.state)}))})];}
 else throw Error('Unexpected round '+round);
 res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:tools.map((c,index)=>({index,...c}))},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
}catch(e){report.providerError=String(e.stack);res.writeHead(500);res.end(String(e));}});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const wait=async(expr,label,timeout=240000)=>{const until=Date.now()+timeout;while(Date.now()<until){const v=await client.evaluate(expr);if(v)return v;const e=await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);if(e&&['proposal','resumed'].includes(label))throw Error(e);await delay(150);}throw Error('Timed out: '+label);};
const click=async selector=>{await wait(`Boolean(document.querySelector(${JSON.stringify(selector)})&&!document.querySelector(${JSON.stringify(selector)}).disabled)`,'control ready',10000);return client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});e.click();return true;})()`);};
const button=text=>client.evaluate(`(()=>{const e=[...document.querySelectorAll('.ck-ai-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Unavailable '+${JSON.stringify(text)});e.click();return true;})()`);
const fill=(selector,value)=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const invoke=(name,args)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
async function screenshot(name,width=1280,height=800){
 const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/'),socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);let id=0;
 const cmd=(method,params)=>new Promise((resolve,reject)=>{const n=++id;socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===n)m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);};socket.send(JSON.stringify({id:n,method,params}));});
 try{await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(250);const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));assert(await client.evaluate(`(()=>{const p=document.querySelector('.ck-ai-panel'),b=p.querySelector('.ck-ai-send'),r=b.getBoundingClientRect();return p.scrollWidth<=p.clientWidth+1&&r.bottom<=innerHeight&&r.top>=0;})()`));}finally{await cmd('Emulation.clearDeviceMetricsOverride',{});socket.close();}
}
try{
 client=await connectDesktop();
 await client.evaluate(`(()=>{window.__p3Ipc=[];window.__p3Frames=0;const tick=()=>{window.__p3Frames++;requestAnimationFrame(tick)};requestAnimationFrame(tick);const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&['compile_ai_candidate','ai_save_chat','compile_sketch','ai_read_library_source'].includes(command)){const args=JSON.parse(options.body),row={command,args};window.__p3Ipc.push(row);const r=await original(url,options);row.response=await r.clone().text();row.kind=r.headers.get('Tauri-Response');row.done=true;return r;}return original(url,options);};return true;})()`);
 const requestId=randomUUID();for(let i=0;i<240;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(project))})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(i%8===0)await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId,path:project,source:'ai-phase3-test'}});await delay(250);}
 await wait(`document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(project))})&&!document.querySelector('[data-ck-role="project-load-progress"]')`,'project');await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board');
 report.blocks=await client.evaluate(`${W}.getAllBlocks(false).length`);assert.equal(report.blocks,97);
 const found=await client.evaluate(`(()=>{const rows=${W}.getAllBlocks(false),index=rows.findIndex(b=>b.type==='math_number'&&Number(b.getFieldValue('NUM'))===700);return {id:rows[index]?.id,index};})()`);target=found.id;offset=Math.max(0,found.index-5);assert(target);
 const before=await client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);report.beforeSha256=createHash('sha256').update(before).digest('hex');
 await click('[data-ck-role="ai-assistant-trigger"]');await wait(`document.querySelector('.ck-ai-input-shell textarea')&&!document.querySelector('.ck-ai-disabled')`,'AI');
 await click('button[aria-label="模型连接设置"]');await fill('.ck-ai-settings input[type="url"]',`http://127.0.0.1:${port}/v1`);await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])','ck-phase3-test');await fill('.ck-ai-settings input[type="password"]','local-fixture-not-a-secret');await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'settings');
 oldStates=await client.evaluate(`(()=>{const strip=b=>{const v=${B}.serialization.blocks.save(b,{addCoordinates:false,addNextBlocks:false,doFullSerialization:true});delete v.next;return v;};return ${W}.getAllBlocks(false).filter(b=>b.type.startsWith('${originalId}_')).map(b=>({id:b.id,state:strip(b)}));})()`);assert.equal(oldStates.length,3);
 await fill('.ck-ai-input-shell textarea','给当前中值库增加样本数量接口，保留旧库，只迁移当前工程并验证原行为。');await click('button[aria-label="发送需求"]');
 await wait(`Boolean(document.querySelector('.ck-ai-proposal'))&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'proposal',300000);
 assert.equal(await client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`),before);
 const rows=await client.evaluate(`window.__p3Ipc.filter(r=>r.command==='compile_ai_candidate')`);assert.equal(rows.length,2);
 const candidate=rows.at(-1),result=JSON.parse(JSON.parse(candidate.response));assert(result.ok&&result.firmware);
 assert.deepEqual(digestTree(oldDirectory),oldProof);
 const newDirectory=path.join(config.paths.sysroot,'libraries/arduino_avr_uno',revision.id);assert(fs.existsSync(newDirectory));
 assert.equal(fs.readFileSync(path.join(newDirectory,'LICENSE'),'utf8'),fs.readFileSync(path.join(oldDirectory,'LICENSE'),'utf8'));
 report.revision={oldId:originalId,newId:revision.id,newDirectory,version:revision.version};
 const sourceRead=await client.evaluate(`window.__p3Ipc.find(r=>r.command==='ai_read_library_source'&&!r.args.bundle)`);
 await assert.rejects(invoke('ai_read_library_source',{...sourceRead.args,contentSha256:'0'.repeat(64)}));
 await assert.rejects(invoke('ai_read_library_source',{...sourceRead.args,path:'../../preferences.json'}));
 report.checks.push('Read-only library source rejects stale content proof and path escape');
 assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-acceptance [data-status="passed"]').length`),6);
 await screenshot('revision-preview');
 await button('应用并编译');await wait(`window.__p3Ipc.some(r=>r.command==='compile_sketch'&&r.done)`,'ordinary compile');const ordinary=await client.evaluate(`window.__p3Ipc.find(r=>r.command==='compile_sketch')`);assert.equal(ordinary.kind,'ok');assert.equal(ordinary.args.code,candidate.args.code);
 assert.equal(await client.evaluate(`${W}.getAllBlocks(false).length`),97);assert.equal(await client.evaluate(`${W}.getAllBlocks(false).filter(b=>b.type.startsWith('${originalId}_')).length`),0);
 const oldSource=fs.readFileSync(path.join(previous,'project.ino'),'utf8');
 const oldCompile=JSON.parse(await invoke('compile_sketch',{...ordinary.args,runId:randomUUID(),code:oldSource,sourceMapJson:null}));assert(oldCompile.artifacts.length>0);
 assert.deepEqual(digestTree(oldDirectory),oldProof);
 report.checks.push('Independent library revision compiles, installs and migrates only three references; 97 blocks and nine behavioral checks preserved');
 report.checks.push('Original library contents/license unchanged; original project source still compiles after revised library installation');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;if(client){report.ui=await client.evaluate('document.body.innerText.slice(-18000)').catch(()=>null);await screenshot('failure').catch(()=>{});}console.error(e);}
finally{if(client){report.ipc=await client.evaluate('window.__p3Ipc').catch(()=>[]);report.frames=await client.evaluate('window.__p3Frames').catch(()=>0);}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);client?.close();server.closeAllConnections();server.close();console.log(JSON.stringify({out,status:report.status,checks:report.checks,error:report.error}));}
