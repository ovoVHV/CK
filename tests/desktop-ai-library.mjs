// Real desktop/Blockly/native quality/compiler/install/export. Model responses
// are scripted so failure and cancellation are reproducible without API cost.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,`ai-library-${Date.now()}`);fs.mkdirSync(out,{recursive:true});
const report={status:'RUNNING',model:'scripted localhost SSE fixture; native compiler and package loader are real',checks:[],libraries:[]};
report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256;
const prefs=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json');
const savedPrefs=fs.existsSync(prefs)?fs.readFileSync(prefs):null;
const delay=ms=>new Promise(r=>setTimeout(r,ms));let client,mode='repair',currentId,requests=0,scope='arduino_avr_uno';
const call=(name,args={})=>({id:randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
function fixture(id,broken=false){
 const header=`#pragma once\n#include <Arduino.h>\nstruct CKAverage_${id} { float values[8] = {}; unsigned char count=0, cursor=0; void reset(); void push(float value); float mean() const; };\nextern CKAverage_${id} average_${id};\n`;
 const cpp=`#include "${id}.h"\n${broken?'#error CK_AI_LIBRARY_REPAIR_REQUIRED\n':''}CKAverage_${id} average_${id};\nvoid CKAverage_${id}::reset(){count=0;cursor=0;for(unsigned char i=0;i<8;i++)values[i]=0;}\nvoid CKAverage_${id}::push(float value){values[cursor]=value;cursor=(cursor+1)%8;if(count<8)count++;}\nfloat CKAverage_${id}::mean() const{float sum=0;for(unsigned char i=0;i<count;i++)sum+=values[i];return count?sum/count:0;}\n`;
 const row=(suffix,label,args,kind,template)=>({definition:{type:id+'_'+suffix,message0:label,...(args.length?{args0:args}:{}),...(kind==='expression'?{output:'Number'}:{previousStatement:null,nextStatement:null}),colour:'#E05263',tooltip:'8点滑动平均；尚未做真机验证',helpUrl:''},generator:{type:id+'_'+suffix,kind,template,includes:{native:`#include <${id}.h>`}},documentation:{description:label.replace(/%\d/g,''),semantics:{purpose:'8点滑动平均',behavior:suffix==='reset'?'清空样本':suffix==='push'?'写入最新样本，最多保留8个':'返回当前样本的平均值，空集合返回0',side_effects:suffix==='mean'?[]:['更新库内全局样本缓冲'],concepts:['moving-average']},hardware:{resources:[],claims:{version:1,coverage:'partial',templates:[]},notes:['使用静态数组和RAM，未访问引脚']}}});
 return {name:'AI 滑动平均测试库',description:'八点环形平均：清空、添加样本和读取平均值',readme:'先清空，再重复写入样本，读取平均值。库共享一个缓冲，不支持多实例。',blocks:[row('reset','清空平均缓冲',[],'statement',`average_${id}.reset();\n`),row('push','添加样本 %1',[{type:'input_value',name:'VALUE',check:'Number'}],'statement',`average_${id}.push({{value:VALUE}});\n`),row('mean','读取平均值',[],'expression',`average_${id}.mean()`)],files:[{path:`src/${id}.h`,content:header},{path:`src/${id}.cpp`,content:cpp}]};
}
const server=http.createServer(async(req,res)=>{
 try{let raw='';for await(const chunk of req)raw+=chunk;const body=JSON.parse(raw);requests++;
  const rows=body.messages.filter(m=>m.role==='tool').map(m=>({...JSON.parse(m.content),toolName:m.name}));
  let tools;
  if(!rows.some(r=>r.typePrefix))tools=[call('get_library_format')];
  else{
   currentId=rows.find(r=>r.typePrefix).id;
   const stages=rows.filter(r=>r.toolName==='stage_library'),fails=rows.filter(r=>r.compiled===false);
   if(!stages.length)tools=[call('stage_library',fixture(currentId,mode==='repair'))];
   else if(stages.at(-1).error)throw Error(stages.at(-1).error);
   else if(fails.length&&mode==='repair'&&stages.length===1){assert.match(fails[0].logTail,/CK_AI_LIBRARY_REPAIR_REQUIRED/);tools=[call('stage_library',{files:fixture(currentId).files})];}
   else{
    if(rows.at(-1)?.error)throw Error(rows.at(-1).error);
    tools=[call('submit_library')];
   }
  }
  res.writeHead(200,{'Content-Type':'text/event-stream'});res.end(`data: ${JSON.stringify({choices:[{delta:{tool_calls:tools.map((c,index)=>({index,...c}))},finish_reason:null}]})}\n\ndata: ${JSON.stringify({choices:[{delta:{},finish_reason:'tool_calls'}]})}\n\ndata: [DONE]\n\n`);
 }catch(e){res.writeHead(500);res.end(String(e));}
});
await new Promise(r=>server.listen(0,'127.0.0.1',r));const port=server.address().port;
const W='window.CK_NATIVE_REGRESSION.getCurrent().workspace',B='window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
const wait=async(expr,label,timeout=240000)=>{const until=Date.now()+timeout;while(Date.now()<until){const value=await client.evaluate(expr);if(value)return value;const error=await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);if(error&&label==='library loaded')throw Error(error);await delay(150);}throw Error('Timed out: '+label);};
const click=selector=>client.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Unavailable '+${JSON.stringify(selector)});b.click();return true;})()`);
const button=text=>client.evaluate(`(()=>{const b=[...document.querySelectorAll('.ck-ai-panel button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Unavailable button '+${JSON.stringify(text)});b.click();return true;})()`);
const fill=(selector,value)=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true;})()`);
const snapshot=()=>client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);
const invoke=(name,args)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const last=command=>client.evaluate(`window.__libraryIpc.filter(r=>r.command===${JSON.stringify(command)}).at(-1)`);
async function submit(nextMode,auto=true){mode=nextMode;currentId=undefined;await button('制作积木库');await delay(100);const checked=await client.evaluate(`document.querySelector('.ck-ai-library-auto input').checked`);if(checked!==auto)await click('.ck-ai-library-auto input');await fill('.ck-ai-input-shell textarea','制作滑动平均库，清空、添加和读取三个积木，使用独立C++源文件。');await delay(100);await click('button[aria-label="发送需求"]');}
async function picture(name,width=1280,height=800){
 const page=(await(await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/');const socket=new WebSocket(page.webSocketDebuggerUrl);await new Promise(r=>socket.onopen=r);let id=0;
 const cmd=(method,params)=>new Promise((resolve,reject)=>{const n=++id;socket.onmessage=e=>{const m=JSON.parse(e.data);if(m.id===n)m.error?reject(Error(JSON.stringify(m.error))):resolve(m.result);};socket.send(JSON.stringify({id:n,method,params}));});
 try{await cmd('Emulation.setDeviceMetricsOverride',{width,height,deviceScaleFactor:1,mobile:false});await delay(250);const shot=await cmd('Page.captureScreenshot',{format:'png'});fs.writeFileSync(path.join(out,name+'.png'),Buffer.from(shot.data,'base64'));const layout=await client.evaluate(`(()=>{const p=document.querySelector('.ck-ai-panel'),c=p.querySelector('.ck-ai-send'),r=c.getBoundingClientRect();return {overflow:p.scrollWidth>p.clientWidth+1,sendVisible:r.bottom<=innerHeight&&r.top>=0&&c.contains(document.elementFromPoint(r.left+r.width/2,r.top+r.height/2))};})()`);assert(!layout.overflow&&layout.sendVisible,JSON.stringify(layout));report.checks.push(name+' layout');}finally{await cmd('Emulation.clearDeviceMetricsOverride',{});socket.close();}
}
try{
 client=await connectDesktop();
 await client.evaluate(`(()=>{window.__libraryWarnings=[];for(const level of ['warn','error']){const saved=console[level].bind(console);console[level]=(...args)=>{window.__libraryWarnings.push(args.map(a=>typeof a==='string'?a:JSON.stringify(a)).join(' '));saved(...args);};}window.__libraryIpc=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&(command.startsWith('ai_')||command==='compile_ai_candidate'||command==='compile_sketch'||command==='save_recovery_draft')){const args=JSON.parse(options.body);if(command==='ai_finish_library'&&args.loaded&&window.__failLibraryActivation){window.__failLibraryActivation=false;return new Response(JSON.stringify('Injected load finalization failure'),{status:200,headers:{'Content-Type':'application/json','Tauri-Response':'error'}});}const row={command,args};window.__libraryIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;if((command==='ai_install_library'&&window.__pauseLibraryInstall)||(command==='ai_finish_library'&&args.loaded&&window.__pauseLibraryCommit)){window.__libraryPaused=true;window.__pauseLibraryInstall=false;window.__pauseLibraryCommit=false;await new Promise(resolve=>window.__resumeLibraryReply=resolve);window.__libraryPaused=false;}return response;}return original(url,options);};return true;})()`);
 const file=path.join(out,'库制作回归.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'库制作回归',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_setup_custom',id:'library-setup',x:60,y:70},{type:'controls_loop_custom',id:'library-loop',x:60,y:190}]}})}));
 for(let i=0;i<240;i++){if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;if(i%8===0)await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:randomUUID(),path:file,source:'ai-library-regression'}});await delay(250);}
 await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type==='control_delay')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board ready');
 await click('[data-ck-role="ai-assistant-trigger"]');await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`,'AI ready');
 await click('button[aria-label="模型连接设置"]');await fill('.ck-ai-settings input[type="url"]',`http://127.0.0.1:${port}/v1`);await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])','ck-library-fixture');await fill('.ck-ai-settings input[type="password"]','local-fixture-not-a-key');await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'saved');
 const before=await snapshot();
 await submit('repair');await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已加载')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'library loaded');
 const id=currentId, installed=path.join(config.paths.sysroot,'libraries',scope,id);report.libraries.push({id,installed});
 assert(fs.existsSync(path.join(installed,'src',id+'.cpp')));assert.equal(await snapshot(),before);
 assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-validations details').length`),2);
 assert(await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.filter(b=>b.library_id===${JSON.stringify(id)}).length===3`));
 report.checks.push('Three-block native library failed with real GCC diagnostic, repaired one source file, compiled and auto-loaded without workspace mutation');
 const receipt=await last('ai_prepare_library'),prepared=JSON.parse(receipt.response);
 await invoke('ai_export_library',{token:prepared.token,destination:path.join(out,'exported-library.zip')});assert(fs.statSync(path.join(out,'exported-library.zip')).size>0);
 report.checks.push('Verified standard library ZIP export');
 await picture('library-light');await client.evaluate(`document.documentElement.classList.add('dark')`);await picture('library-dark-small',900,600);await client.evaluate(`document.documentElement.classList.remove('dark')`);
 await client.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent();const reset=c.Blockly.serialization.blocks.append({type:${JSON.stringify(id+'_reset')}},c.workspace);c.workspace.getBlockById('library-setup').getInput('DO').connection.connect(reset.previousConnection);const push=c.Blockly.serialization.blocks.append({type:${JSON.stringify(id+'_push')},inputs:{VALUE:{block:{type:'math_number',fields:{NUM:42}}}}},c.workspace);c.workspace.getBlockById('library-loop').getInput('DO').connection.connect(push.previousConnection);return true;})()`);
 const buildsBefore=await client.evaluate(`window.__libraryIpc.filter(r=>r.command==='compile_sketch').length`);
 await click('[data-ck-role="build-compile-action"]');
 await wait(`window.__libraryIpc.filter(r=>r.command==='compile_sketch')[${buildsBefore}]?.done`,'ordinary compile');
 const compiled=await last('compile_sketch');assert.equal(compiled.kind,'ok',compiled.response);const firmware=JSON.parse(JSON.parse(compiled.response));assert(firmware.artifacts?.length>0);assert(compiled.args.code.includes('average_'+id));fs.writeFileSync(path.join(out,'installed-library-use.ino'),compiled.args.code);
 report.checks.push('Installed blocks generate and compile a normal project with real firmware output');
 await wait(`!document.querySelector('.ck-ai-disabled')`,'compiler settled');
 const after=await snapshot();
 await submit('tamper',false);await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已通过试编译')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'candidate ready');
 const tamperRow=await last('ai_prepare_library'),tamper=JSON.parse(tamperRow.response);
 fs.appendFileSync(path.join(config.paths.sysroot,'state/ai-libraries-v1/drafts',tamper.token,'package/src',currentId+'.cpp'),'\n// tamper same session\n');
 await button('安装并加载');await wait(`document.querySelector('.ck-ai-error')?.textContent.includes('变化')`,'tamper rejected');assert(!fs.existsSync(path.join(config.paths.sysroot,'libraries',scope,currentId)));assert.equal(await snapshot(),after);
 report.checks.push('Changed package content invalidates compile authorization before install');
 await client.evaluate(`window.__failLibraryActivation=true`);await submit('rollback');
 await wait(`document.querySelector('.ck-ai-error')?.textContent.includes('Injected')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'rollback');assert(!fs.existsSync(path.join(config.paths.sysroot,'libraries',scope,currentId)));assert(!await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.some(b=>b.library_id===${JSON.stringify(currentId)})`));assert.equal(await snapshot(),after);
 report.checks.push('Load finalization failure rolls back disk installation and active catalog');
 await submit('cancel',false);await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已通过试编译')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'cancel candidate');
 await client.evaluate(`window.__pauseLibraryInstall=true`);await button('安装并加载');await wait(`window.__libraryPaused`,'installed reply paused');
 const canceledId=currentId;assert(fs.existsSync(path.join(config.paths.sysroot,'libraries',scope,canceledId)));
 await click('button[aria-label="停止 AI 请求"]');await client.evaluate(`window.__resumeLibraryReply()`);
 await wait(`!document.querySelector('button[aria-label="停止 AI 请求"]')&&document.querySelector('.ck-ai-notice')?.textContent.includes('撤回')`,'canceled installation');
 assert(!fs.existsSync(path.join(config.paths.sysroot,'libraries',scope,canceledId)));assert.equal(await snapshot(),after);
 report.checks.push('Cancel after disk install and before activation rolls back the uncommitted library');
 await submit('late-stop',false);await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已通过试编译')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'late stop candidate');
 await client.evaluate(`window.__pauseLibraryCommit=true`);await button('安装并加载');await wait(`window.__libraryPaused`,'committed reply paused');
 await click('button[aria-label="停止 AI 请求"]');await client.evaluate(`window.__resumeLibraryReply()`);
 await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已加载')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'late stop preserves commit');
 const sameNameId=currentId;assert(fs.existsSync(path.join(config.paths.sysroot,'libraries',scope,sameNameId)));
 for(const uniqueId of [id,sameNameId])assert(await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.filter(b=>b.library_id===${JSON.stringify(uniqueId)}).length===3`));
 assert.equal(await snapshot(),after);report.checks.push('Same display name with distinct package IDs loads both libraries; late stop reports the committed installation accurately');
 await submit('pending',false);await wait(`document.querySelector('[aria-label="生成的积木库"]')?.textContent.includes('库已通过试编译')&&!document.querySelector('button[aria-label="停止 AI 请求"]')`,'pending candidate');
 const pendingRow=await last('ai_prepare_library'),pending=JSON.parse(pendingRow.response);await invoke('ai_install_library',{token:pending.token});const pendingPath=path.join(config.paths.sysroot,'libraries',scope,pending.packageId);assert(fs.existsSync(pendingPath));
 fs.writeFileSync(path.join(config.paths.evidenceRoot,'ai-library-restart-fixture.json'),JSON.stringify({committed:installed,pending:pendingPath,token:pending.token,project:file,sourceReport:path.join(out,'report.json')}));
 report.checks.push('Created unfinalized native installation for independent restart recovery test');
 report.warnings=await client.evaluate(`window.__libraryWarnings`);assert(!report.warnings.some(w=>w.includes('full-state hashes do not match')));assert(await client.evaluate(`window.__libraryIpc.some(r=>r.command==='save_recovery_draft'&&r.done&&r.kind==='ok')`));report.checks.push('Automatic recovery draft saves with the same board configuration included in its content hash');report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);if(client){report.warnings=await client.evaluate(`window.__libraryWarnings`).catch(()=>[]);report.ui=await client.evaluate(`document.body.innerText.slice(-12000)`).catch(()=>null);await picture('failure').catch(()=>{});}}
finally{report.requests=requests;fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));if(savedPrefs)fs.writeFileSync(prefs,savedPrefs);else if(fs.existsSync(prefs))fs.unlinkSync(prefs);client?.close();server.closeAllConnections();await new Promise(r=>server.close(r));console.log(JSON.stringify({out,...report}));}
