// Live model library authoring with actual desktop, native compiler and loader.
// The authorized provider key is supplied only through the child environment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,`ai-library-live-${Date.now()}`);fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',model:'deepseek-flash (live)',checks:[],libraries:[]};
report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256;
const liveKey=process.env.CK_AI_LIVE_KEY;delete process.env.CK_AI_LIVE_KEY;if(!liveKey)throw Error('Authorized test key unavailable');
const prefs=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json');
const savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));let client;const scope='arduino_avr_uno';
const W='window.CK_NATIVE_REGRESSION.getCurrent().workspace',B='window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
const wait=async(expr,label,timeout=240000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=await client.evaluate(expr);if(value)return value;const error=await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);if(error&&label==='library loaded')throw Error(error);await delay(150);}throw Error('Timed out: '+label);};
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
 await client.evaluate(`(()=>{window.__libraryIpc=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&(command.startsWith('ai_')||command==='compile_ai_candidate'||command==='compile_sketch')){const args=JSON.parse(options.body);if(command==='ai_finish_library'&&args.loaded&&window.__failLibraryActivation){window.__failLibraryActivation=false;throw Error('Injected load finalization failure');}const row={command,args};window.__libraryIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true;})()`);
 const file=path.join(out,'库制作回归.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'库制作回归',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_setup_custom',id:'library-setup',x:60,y:70},{type:'controls_loop_custom',id:'library-loop',x:60,y:190}]}})}));
 for(let i=0;i<240;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(i%8===0)await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:randomUUID(),path:file,source:'ai-library-regression'}});await delay(250);}
 await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type==='control_delay')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board ready');
 await click('[data-ck-role="ai-assistant-trigger"]');await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`,'AI ready');
 await click('button[aria-label="模型连接设置"]');await fill('.ck-ai-settings input[type="url"]','https://api.deepseek.com/v1');await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])','deepseek-flash');await fill('.ck-ai-settings input[type="password"]',liveKey);await fill('input[aria-label="上下文预算"]',65536);await fill('input[aria-label="单次回复预留"]',8192);await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'saved');
 const before=await snapshot();await button('制作积木库');
 await fill('.ck-ai-input-shell textarea','制作一个可复用的单通道非阻塞按键去抖库，当前板卡Uno，INPUT_PULLUP低电平按下。至少提供初始化(可选引脚及去抖毫秒)、轮询更新、读取稳定按下状态、读取并消费按下沿、读取并消费松开沿五个可编辑积木。初始化以引脚当前状态建基线，不凭空产生边沿。用 unsigned long 的时间差处理 millis 回绕，禁止 delay。状态放库自己的.h/.cpp内，不要写桌面JS。声明引脚来源和占用，写清轮询和消费事件语义，检查后试编译并加载。');
 await delay(150);await click('button[aria-label="发送需求"]');
 await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已加载')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'library loaded',740000);
 assert.equal(await snapshot(),before);
 const preparedRow=await last('ai_prepare_library'),prepared=JSON.parse(preparedRow.response),id=prepared.packageId;
 const installed=path.join(config.paths.sysroot,'libraries',scope,id);assert(fs.existsSync(installed));
 const contract=JSON.parse(fs.readFileSync(path.join(installed,'ck-blocks.json'),'utf8'));assert(contract.blocks.length>=5);
 assert(await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.filter(b=>b.library_id===${JSON.stringify(id)}).length>=5`));
 const files=fs.readdirSync(path.join(installed,'src'));assert(files.some(name=>name.endsWith('.cpp')));assert(files.some(name=>name.endsWith('.h')));
 report.libraries.push({id,installed,types:contract.blocks.map(b=>b.type),files});
 report.checks.push('Live model created at least five button/debounce blocks, native C++ sources and v2 resource metadata, passed native checks and auto-loaded without editing the project');
 const source=preparedRow.args.files['examples/compile_check/compile_check.ino'];fs.writeFileSync(path.join(out,'installed-library-smoke.ino'),source);
 const firmware=await client.build(source,'arduino:avr:uno',{projectId:'ai-library-live:'+id});assert(firmware.success,JSON.stringify(firmware));
 report.checks.push('Independent ordinary compile consumes the installed library and produces firmware');
 report.usage=await client.evaluate(`document.querySelector('.ck-ai-token-detail')?.textContent`);report.requestSummary=await client.evaluate(`document.querySelector('.ck-ai-usage')?.textContent`);report.budget={context:65536,response:8192};
 report.validation=await client.evaluate(`document.querySelector('.ck-ai-validations')?.textContent`);
 report.messages=await client.evaluate(`Array.from(document.querySelectorAll('.ck-ai-message')).map(e=>e.textContent)`);
 await picture('live-library-loaded');
 report.hardwareTested=false;report.behaviorTested=false;
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);if(client){report.ui=await client.evaluate(`document.body.innerText.slice(-12000)`).catch(()=>null);await picture('failure').catch(()=>{});}}
finally{fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2).split(liveKey).join('[REDACTED]'));if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);client?.close();console.log(JSON.stringify({out,status:report.status,checks:report.checks,error:report.error}).split(liveKey).join('[REDACTED]'));}
