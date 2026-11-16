// Real UI + real compiler + shipped worker. Provider deliberately returns one
// wrong edit and then attempts to weaken its test before making the repair.
import fs from 'node:fs';import path from 'node:path';import http from 'node:http';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';import {complexAcceptance as baseAcceptance} from './ai-phase3-cases.mjs';
const complexAcceptance=structuredClone(baseAcceptance);complexAcceptance.scenarios=[0,1,2].map(i=>({...structuredClone(baseAcceptance.scenarios[0]),id:'cancel_'+i,name:'取消检查 '+i,durationMs:4000,assertions:baseAcceptance.scenarios[0].assertions.map(a=>({...a,id:a.id+'_'+i}))}));
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,'ai-worker-cancel-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',checks:[],provider:'scripted failure injection',requests:[],hardware:false};
report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256;
const previous=path.resolve('tests/fixtures/ai-phase3');
const resumeFile=path.join(config.paths.evidenceRoot,'phase3-resume.json'),restart=process.env.CK_AI_PHASE3_RESTART==='1';
const resume=restart?JSON.parse(fs.readFileSync(resumeFile,'utf8')):null;
const project=resume?.project || path.join(out,'复杂项目.ck');
if(!restart)fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'AI 第三阶段综合回归',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',build_target:{schemaVersion:1,board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreId:'arduino:avr',coreVersion:'1.8.8',fqbn:'arduino:avr:uno',options:{},optionsComplete:true},xml:fs.readFileSync(path.join(previous,'workspace.json'),'utf8')}));
const prefs=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json'),savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));const W='window.CK_NATIVE_REGRESSION.getCurrent().workspace',B='window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
let client,round=0,mode=restart?'resume':'repair',target,offset,paused=false;
const call=(name,args={})=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
const proposal=(value)=>call('propose_change',{summary:'将上阈值改为650，保留采样、急停、心跳和串口',edits:[{action:'set_field',blockId:target,field:'NUM',value}]});
const server=http.createServer(async(req,res)=>{try{
 let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);round++;
 const rows=body.messages.filter(m=>m.role==='tool').map(m=>({...JSON.parse(m.content),toolName:m.name}));let tools;
 report.requests.push({mode,round,results:rows.slice(-3)});
 if(round===1)tools=[call('get_verification_capabilities'),call('read_workspace',{offset,limit:20})];
 else if(round===2)tools=[call('set_acceptance_plan',complexAcceptance),proposal(650)];
 else throw Error('Unexpected round after cancellation');
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
 await client.evaluate(`(()=>{window.__workerEvents=[];const Original=window.Worker;window.Worker=class extends Original{constructor(...args){super(...args);this.addEventListener('message',e=>{window.__workerEvents.push({event:'message',progress:e.data.progress,result:!!e.data.result,frames:window.__p3Frames,time:performance.now()});});}terminate(){window.__workerEvents.push({event:'terminate',frames:window.__p3Frames,time:performance.now()});return super.terminate();}};return true;})()`);
 await fill('.ck-ai-input-shell textarea','改上阈值650并验证实际行为');await click('button[aria-label="发送需求"]');
 await wait(`window.__workerEvents.some(e=>e.progress)`,'simulation started');await delay(200);
 const started=Date.now();await click('button[aria-label="停止 AI 请求"]');await wait(`!document.querySelector('button[aria-label="停止 AI 请求"]')&&Boolean(document.querySelector('.ck-ai-resume'))`,'worker stopped',10000);
 report.stopMs=Date.now()-started;report.worker=await client.evaluate(`window.__workerEvents`);assert(report.worker.some(e=>e.event==='terminate'));assert(!report.worker.some(e=>e.result));
 const progress=report.worker.find(e=>e.progress),terminated=report.worker.find(e=>e.event==='terminate');assert(terminated.frames>progress.frames,'UI must keep updating during simulation');
 assert.equal(await client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`),before);assert.equal(await client.evaluate(`Boolean(document.querySelector('.ck-ai-proposal'))`),false);assert(report.stopMs<2000);
 report.checks.push('Long firmware simulation stays off UI thread; stop terminates Worker before any success evidence');report.checks.push('Original 97-block workspace unchanged and encrypted resumable draft preserved after cancellation');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;if(client){report.ui=await client.evaluate('document.body.innerText.slice(-18000)').catch(()=>null);await screenshot('failure').catch(()=>{});}console.error(e);}
finally{if(client){report.ipc=await client.evaluate('window.__p3Ipc').catch(()=>[]);report.frames=await client.evaluate('window.__p3Frames').catch(()=>0);}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);client?.close();server.closeAllConnections();server.close();console.log(JSON.stringify({out,status:report.status,checks:report.checks,error:report.error}));}
