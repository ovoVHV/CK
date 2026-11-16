// Live complex-project modification with actual desktop, compiler and firmware simulation.
// The authorized provider key is supplied only through the child environment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import {pathToFileURL} from 'node:url';
import {complexAcceptance} from './ai-phase3-cases.mjs';
import { connectDesktop } from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,`${process.env.CK_AI_LIVE_EVIDENCE_PREFIX||'ai-phase3-live'}-${Date.now()}`);fs.mkdirSync(out,{recursive:true});
const baselineFile=path.resolve('tests/fixtures/ai-phase3/workspace.json');const baselineDir=path.dirname(baselineFile);
const report={status:'RUNNING',model:'deepseek-flash (live)',repairOf:baselineFile,feedbackSource:'live requirements plus independent fixed acceptance suite',checks:[],libraries:[]};
report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256;
const replyTokens=Number(process.env.CK_AI_LIVE_REPLY_TOKENS||8192),contextTokens=Number(process.env.CK_AI_LIVE_CONTEXT_TOKENS||65536);const liveKey=process.env.CK_AI_LIVE_KEY;delete process.env.CK_AI_LIVE_KEY;if(!liveKey)throw Error('Authorized test key unavailable');
const prefs=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json');
const savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));let client;const scope='arduino_avr_uno';
const W='window.CK_NATIVE_REGRESSION.getCurrent().workspace',B='window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
const wait=async(expr,label,timeout=240000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=await client.evaluate(expr);if(value)return value;const error=await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);if(error&&label==='library loaded')throw Error(error);if(label==='library loaded'&&await client.evaluate(`window.__liveRequests?.length>0&&!document.querySelector('button[aria-label="停止 AI 请求"]')&&Array.from(document.querySelectorAll('.ck-ai-message')).some(x=>x.textContent.includes('已停止，原工程未修改')||x.textContent.includes('尚未完成'))`))throw Error('Model task stopped without a complete project; see retained messages and tool results');await delay(150);}throw Error('Timed out: '+label);};
const click=selector=>client.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});b.click();return true;})()`);
const button=text=>client.evaluate(`(()=>{const b=[...document.querySelectorAll('.ck-ai-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button '+${JSON.stringify(text)});b.click();return true;})()`);
const fill=(selector,value)=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const snapshot=()=>client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);
const invoke=(name,args)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const last=command=>client.evaluate(`window.__libraryIpc.filter(r=>r.command===${JSON.stringify(command)}).at(-1)`);
async function picture(name,width=1280,height=800){
 const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/');const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);let id=0;
 const cmd=(method,params)=>new Promise((resolve,reject)=>{const n=++id;socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===n)m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);};socket.send(JSON.stringify({id:n,method,params}));});
 try{await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(250);const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));const layout=await client.evaluate(`(()=>{const p=document.querySelector('.ck-ai-panel'),c=p.querySelector('.ck-ai-send'),r=c.getBoundingClientRect();return {overflow:p.scrollWidth>p.clientWidth+1,sendVisible:r.bottom<=innerHeight&&r.top>=0&&c.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);assert(!layout.overflow&&layout.sendVisible,JSON.stringify(layout));report.checks.push(name+' layout');}finally{await cmd('Emulation.clearDeviceMetricsOverride',{});socket.close();}
}
try{
 client=await connectDesktop();
 await client.evaluate(`(()=>{window.__libraryIpc=[];window.__liveRequests=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname!=='ipc.localhost')return original(url,options);if(command==='chat_with_glm_stream'){const req=JSON.parse(options.body).req,row={model:req.model,toolResults:req.historyMessages?.filter(m=>m.role==='tool'),startedAt:Date.now()};window.__liveRequests.push(row);const response=await original(url,options),value=await response.clone().json();row.wallMs=Date.now()-row.startedAt;row.kind=response.headers.get('Tauri-Response');if(row.kind==='ok'){row.finish=value.finishReason;row.toolCalls=value.toolCalls;row.content=value.content;row.inputTokens=value.promptTokens;row.outputTokens=value.completionTokens;}else row.error=String(value);return response;}if(['ai_prepare_library','ai_install_library','ai_finish_library','ai_discard_library','compile_ai_candidate','compile_sketch','ai_read_library_source'].includes(command)){const args=JSON.parse(options.body),row={command,args};window.__libraryIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true;})()`);
 const file=path.join(out,'任务-'+path.basename(out)+'.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'复杂工程行为验收',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:fs.readFileSync(path.join(baselineDir,'workspace.json'),'utf8')}));
 const openRequestId=randomUUID();
 for(let i=0;i<240;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(file))})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(i%8===0)await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:openRequestId,path:file,source:'ai-library-regression'}});await delay(250);}
 await wait(`document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(file))})`,'correct project opened');
 await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type==='control_delay')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board ready');
 await click('[data-ck-role="ai-assistant-trigger"]');await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`,'AI ready');
 await click('button[aria-label="模型连接设置"]');await fill('.ck-ai-settings input[type="url"]','https://api.deepseek.com/v1');await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])','deepseek-flash');await fill('.ck-ai-settings input[type="password"]',liveKey);await fill('input[aria-label="上下文预算"]',contextTokens);await fill('input[aria-label="单次回复预留"]',replyTokens);await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'saved');
 const before=await snapshot();report.before=before;
 let prompt="请接手当前97个积木的复杂Uno工程，先读取工程地图，理解已有变量、库、采样、急停、心跳和串口，保留全部原有功能。只把中值控制的上阈值从700改为650，下阈值300不变，D2低电平急停优先关闭D9，急停期间继续20ms采样，释放后按最新中值恢复；D13每250ms翻转，串口115200每200ms输出中值；五样本中值库保留，代码不能加delay。请先读取当前行为验证能力，固定验收清单，自动模拟实际候选固件，若失败局部修复，最后提供可应用方案。测试应覆盖A0取675高于新阈值、A0低值关闭、中间区间保持、急停/释放、持续采样、独立心跳和串口。ADC与D2输入需从0ms给定，滤波变化留出100ms以上稳定时间；测试总时长不需超过两秒。小数接口精度和millis回绕本次可以标为待核对，真实接线保持真机未验证。不要重建工程、不要重复制库，找不到源码可用read_library_source查看已有库，但本次不需要修库。";const variant=process.env.CK_AI_LIVE_VARIANT||'threshold';report.variant=variant;
 if(variant!=='threshold')prompt=prompt.replace('只把中值控制','把中值控制');
 if(variant==='heartbeat')prompt=prompt.replace('D13每250ms翻转','另外把D13心跳从250ms改为200ms翻转');
 if(variant==='serial')prompt=prompt.replace('串口115200每200ms输出中值','另外把串口115200输出中值的周期从200ms改为100ms');
 report.prompt=prompt;await fill('.ck-ai-input-shell textarea',prompt);
 await delay(150);const taskStarted=Date.now();await click('button[aria-label="发送需求"]');
 await wait(`Boolean(document.querySelector('.ck-ai-proposal'))&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'library loaded',740000);
 report.taskWallMs=Date.now()-taskStarted;assert.equal(await snapshot(),before);
 report.checks.push('Live model preserves existing project until confirmation');
 const behaviorUi=await client.evaluate(`document.querySelector('.ck-ai-acceptance')?.textContent`);assert(behaviorUi&&behaviorUi.includes('场景通过'),'Model must run actual fixed behavioral checks');report.behaviorUi=behaviorUi;
 const candidate=await last('compile_ai_candidate');assert(!candidate.args.libraryToken);const value=JSON.parse(JSON.parse(candidate.response));assert(value.ok&&value.artifactCount>0&&value.firmware);
 const simulator=await import(pathToFileURL(path.resolve('tests/fixtures/ai-phase3/simulator.mjs')));
 const independentContract=structuredClone(complexAcceptance);
 if(variant==='heartbeat'){const a=independentContract.scenarios[0].assertions.find(a=>a.id==='heartbeat_count');a.min=5;a.max=5;independentContract.requirements.find(r=>r.id==='heartbeat').text='D13独立200ms心跳';}
 if(variant==='serial')independentContract.scenarios[0].assertions.push({id:'serial_100ms',requirement:'serial',kind:'serial',fromMs:95,toMs:140,contains:'675.00'});
 fs.writeFileSync(path.join(out,'independent-contract.json'),JSON.stringify(independentContract,null,2));
 const independent=simulator.simulateAiFirmware(value.firmware,independentContract);fs.writeFileSync(path.join(out,'independent-behavior.json'),JSON.stringify(independent,null,2));assert.equal(independent.status,'passed');
 report.checks.push('Exact candidate HEX independently passes fixed behavioral assertions on actual AVR instructions');
 report.checks.push('Complete existing-project proposal compiled; original workspace unchanged until confirmation');
 const index=await client.evaluate(`window.__libraryIpc.filter(r=>r.command==='compile_sketch').length`);await button('应用并编译');await wait(`window.__libraryIpc.filter(r=>r.command==='compile_sketch')[${index}]?.done`,'normal compile',240000);
 const ordinary=await last('compile_sketch');assert.equal(ordinary.kind,'ok');assert.equal(ordinary.args.code,candidate.args.code);const firmware=JSON.parse(JSON.parse(ordinary.response));assert(firmware.artifacts?.length>0);fs.writeFileSync(path.join(out,'project.ino'),ordinary.args.code);fs.writeFileSync(path.join(out,'workspace.json'),await snapshot());
 const types=await client.evaluate(`${W}.getAllBlocks(false).map(b=>b.type)`);assert(!types.some(type=>/raw|custom_code|code_insert|code_statement|code_expression/i.test(type)));assert(!/\bdelay\s*\(/.test(ordinary.args.code));report.blocks=types.length;report.blockTypes=[...new Set(types)];
 report.checks.push('Applied workspace generates identical source, normal build produces firmware, editable blocks and no blocking delay');
 report.usage=await client.evaluate(`document.querySelector('.ck-ai-token-detail')?.textContent`);report.requestSummary=await client.evaluate(`document.querySelector('.ck-ai-usage')?.textContent`);report.budget={context:contextTokens,response:replyTokens};
 report.validation=await client.evaluate(`document.querySelector('.ck-ai-validations')?.textContent`);
 report.messages=await client.evaluate(`Array.from(document.querySelectorAll('.ck-ai-message')).map(e=>e.textContent)`);
 await picture('live-library-loaded');
 report.hardwareTested=false;report.behaviorTested=true;
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);if(client){report.usage=await client.evaluate(`document.querySelector('.ck-ai-token-detail')?.textContent`).catch(()=>null);report.requestSummary=await client.evaluate(`document.querySelector('.ck-ai-usage')?.textContent`).catch(()=>null);report.budget={context:contextTokens,response:replyTokens};report.ui=await client.evaluate(`document.body.innerText.slice(-12000)`).catch(()=>null);await picture('failure').catch(()=>{});}}
finally{if(client){report.after=await snapshot().catch(()=>null);report.modelTrace=await client.evaluate('window.__liveRequests').catch(()=>[]);report.ipc=await client.evaluate('window.__libraryIpc').catch(()=>[]);}fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2).split(liveKey).join('[REDACTED]'));if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);client?.close();console.log(JSON.stringify({out,status:report.status,checks:report.checks,error:report.error}).split(liveKey).join('[REDACTED]'));}
