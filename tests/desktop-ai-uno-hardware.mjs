// Opt-in only. Uses the explicitly selected Uno, replaces its sketch, and leaves the serial port closed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';

const port=process.env.CK_QA_UNO_PORT;
if(process.env.CK_QA_FLASH_UNO!=='1'||!/^COM[1-9]\d*$/i.test(port||''))throw Error('Explicit CK_QA_FLASH_UNO=1 and CK_QA_UNO_PORT required');
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const dir=fs.mkdtempSync(path.join(config.paths.evidenceRoot,'实机回包-')), project=path.join(dir,path.basename(dir)+'.ck');
const fqbn='arduino:avr:uno', baud=115200;
const blocks=[{type:'controls_setup_custom',id:'probe-setup',x:48,y:42,inputs:{DO:{block:{type:'serial_setup',inputs:{BAUD:{block:{type:'math_number',fields:{NUM:baud}}}}}}}},
    {type:'controls_loop_custom',id:'uno-probe',x:48,y:180,inputs:{DO:{block:{type:'math_compound_assign_custom',id:'invalid-assign',fields:{OP:'+='},inputs:{VAR:{block:{type:'math_number',fields:{NUM:1}}},VALUE:{shadow:{type:'math_number',fields:{NUM:0}}}}}}}}];
fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:path.basename(dir),board:fqbn,board_package_id:fqbn,options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:blocks.map(({inputs,...root})=>root)}})}));
const files=[{path:'src/probe/probe.h',code:'#pragma once\nvoid pollProbe();\n'},{path:'src/probe/probe.cpp',code:`#include <Arduino.h>
#include "probe.h"
void pollProbe(){
  static char buf[40]; static uint8_t n;
  while(Serial.available()){
    char c=Serial.read();
    if(c=='\\n'){buf[n]=0; if(!strncmp(buf,"CK?",3)){Serial.print(F("CK_ACK:")); Serial.println(buf+3);} n=0;}
    else if(n+1<sizeof(buf)) buf[n++]=c;
  }
}
void serialEvent(){pollProbe();}
`}];
const report={port,fqbn,baud,model:'local scripted tool caller',uploaded:false,challenges:[]};
const client=await connectDesktop(), {evaluate}=client;
const invoke=(name,args={})=>evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})`);
const sleep=ms=>new Promise(r=>setTimeout(r,ms));
const wait=async (expr,limit=35000)=>{const until=Date.now()+limit;while(Date.now()<until){if(await evaluate(`Boolean(${expr})`))return;const err=await evaluate(`document.querySelector('.ck-ai-error')?.innerText`);if(err)throw Error(err);await sleep(180);}throw Error('Timed out: '+expr+'; '+await evaluate(`document.querySelector('.ck-ai-feed')?.innerText.slice(-1200) || ''`));};
const click=sel=>evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
const nonces=[randomUUID().slice(0,12),randomUUID().slice(0,12)];
try {
    const listed=await invoke('list_serial_ports');
    report.desktopSha256=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8')).sha256;
    assert(listed.some(p=>p.port_name===port),'Selected port missing');
    await invoke('create_ai_project_sources',{path:project,files});
    await wait(`document.body.innerText.includes('我的工程')`);
    // Only the remote model and chat persistence are replaced. Native serial IPC and the permissions UI are real.
    await evaluate(`(()=>{
        localStorage.setItem('ck.serial.baudRate','115200');
        const nonces=${JSON.stringify(nonces)},api=window.__TAURI_INTERNALS__,original=api.invoke;
        window.__ckSerialResults=[];window.__ckProbeMode='repair';window.__ckNativeProbe=[];
        const handles=cmd=>['ai_load_preferences','ai_list_chats','ai_save_chat','chat_with_glm_stream'].includes(cmd);
        const stub=async(cmd,args)=>{
            if(cmd==='ai_load_preferences')return {baseUrl:'http://127.0.0.1:9/v1',model:'probe-fixture',apiKey:'fixture',autoApply:false};
            if(cmd==='ai_list_chats')return {chats:[],unreadable:0};
            if(cmd==='ai_save_chat')return args.value.revision+1;
            const seen=args.req.historyMessages.filter(m=>m.role==='tool').map(m=>JSON.parse(m.content));
            const call=(name,args)=>({content:'',finishReason:'tool_calls',toolCalls:[{id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}}]});
            if(window.__ckProbeMode==='repair'){
                if(!seen.length)return call('read_diagnostics',{});
                if(!/lvalue|left operand/i.test(JSON.stringify(seen)))throw Error('Expected a real compiler diagnostic');
                if(seen.length===1)return call('read_workspace',{});
                if(seen.length>2)return {content:'修复工具失败',finishReason:'stop',toolCalls:[]};
                return call('propose_change',{summary:'移除给常量赋值的语句，保留串口初始化和工程文件。',edits:[{action:'remove',blockId:'invalid-assign'}]});
            }
            window.__ckSerialResults=seen;
            if(seen.some(x=>x.error)||seen.length>=3)return {content:'采样结束',finishReason:'stop',toolCalls:[]};
            const sample=seen.length?{text:'CK?'+nonces[seen.length-1]+'\\n',waitMs:900}:{waitMs:1800};
            return {content:'',finishReason:'tool_calls',toolCalls:[{id:crypto.randomUUID(),type:'function',function:{name:'serial_sample',arguments:JSON.stringify(sample)}}]};
        };
        const watch=cmd=>['compile_ai_candidate','upload_sketch'].includes(cmd);
        const record=(cmd,args,raw)=>{const v=typeof raw==='string'?JSON.parse(raw):raw;window.__ckNativeProbe.push({cmd,port:args.port,member:args.expectedMemberIdentity,runId:args.runId,value:v});};
        if(Object.getOwnPropertyDescriptor(api,'invoke')?.writable){api.invoke=async(cmd,args,...rest)=>{if(handles(cmd))return stub(cmd,args);const v=await original(cmd,args,...rest);if(watch(cmd))record(cmd,args,v);return v;};return;}
        const first=window.fetch.bind(window);window.fetch=async(url,opts)=>{const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
            if(u.hostname==='ipc.localhost'&&handles(cmd))return new Response(JSON.stringify(await stub(cmd,JSON.parse(opts.body||'{}'))),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
            const r=await first(url,opts);if(u.hostname==='ipc.localhost'&&watch(cmd)&&r.headers.get('Tauri-Response')==='ok')record(cmd,JSON.parse(opts.body||'{}'),await r.clone().json());return r;};})()`);
    await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:randomUUID(),path:project,source:'hardware-qa'}});
    await wait(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('uno-probe') && !document.querySelector('[data-ck-role="project-load-progress"]')`);
    await evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();for(const root of ${JSON.stringify(blocks)}){const child=Blockly.serialization.blocks.append(root.inputs.DO.block,workspace);workspace.getBlockById(root.id).getInput('DO').connection.connect(child.previousConnection);}})()`);
    await click('[data-ck-role="toolbar-port-select"]');const pick=`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.querySelector('.font-mono')?.textContent===${JSON.stringify(port)})`;
    await wait(pick);await evaluate(`${pick}.click()`);
    await click('[data-ck-role="ai-assistant-trigger"]');await wait(`document.querySelector('[aria-label="新对话"]')?.disabled===false && !document.querySelector('.ck-ai-disabled')`);
    await click('.ck-ai-access-entry');
    const device=`document.querySelectorAll('.ck-ai-permissions fieldset:nth-of-type(2) input')`;
    await wait(`${device}.length===3`);
    assert(await evaluate(`${device}[1].disabled && !${device}[0].checked && !${device}[2].checked`));
    await evaluate(`${device}[0].click()`);await evaluate(`${device}[1].click()`);
    await evaluate(`${device}[0].click()`);assert(await evaluate(`${device}[1].disabled && !${device}[1].checked`));
    await evaluate(`${device}[0].click()`);await evaluate(`${device}[1].click()`);
    await evaluate(`${device}[2].click()`);
    await click('.ck-ai-permissions .ck-ai-back');
    await click('[data-ck-role="build-compile-action"]');
    await wait(`document.querySelector('button[aria-label="让 AI 分析这条错误"]')`,120000);
    await click('button[aria-label="让 AI 分析这条错误"]');
    await wait(`document.querySelector('.ck-ai-intent')?.textContent.includes('修复报错') && !document.querySelector('.ck-ai-send').disabled`);
    await click('.ck-ai-send');await wait(`document.querySelector('.ck-ai-proposal')`,120000);
    assert.equal(await evaluate(`window.__ckNativeProbe.filter(x=>x.cmd==='upload_sketch').length`),0);
    await click('.ck-ai-proposal-actions .ck-ai-primary');
    await wait(`document.querySelector('.ck-ai-notice')?.textContent.includes('修复固件已上传')`,120000);
    const traces=await evaluate(`window.__ckNativeProbe`),uploads=traces.filter(x=>x.cmd==='upload_sketch'),candidate=traces.find(x=>x.cmd==='compile_ai_candidate'&&x.value.ok);
    assert.equal(uploads.length,1);const upload=uploads[0],v=upload.value;
    assert(v.success&&v.runId===upload.runId&&v.fqbn===fqbn&&upload.port===port&&upload.member===candidate.value.memberIdentity);
    report.uploaded=true;report.artifacts=candidate.value.artifactCount;
    fs.writeFileSync(path.join(dir,'upload.log'),`${v.compileLog}\n${v.log}`);console.log('Real AI repair and one-time upload completed');
    await click('.ck-ai-access-entry');assert.equal(await evaluate(`${device}[2].checked`),false);report.uploadGrantConsumed=true;
    await click('.ck-ai-permissions .ck-ai-back');
    await click('[aria-label="新对话"]');await wait(`!document.querySelector('.ck-ai-message') && !document.querySelector('[aria-label="新对话"]').disabled`);
    await click('.ck-ai-access-entry');assert(await evaluate(`[...${device}].every(x=>!x.checked)`));
    await evaluate(`${device}[0].click()`);await evaluate(`${device}[1].click()`);
    await click('.ck-ai-permissions .ck-ai-back');await evaluate(`window.__ckProbeMode='serial'`);
    await evaluate(`(()=>{const el=document.querySelector('.ck-ai-input-shell textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'测试串口收发');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`document.querySelector('.ck-ai-send')?.disabled===false`);await click('.ck-ai-send');
    await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('采样结束') || document.querySelector('.ck-ai-error')`);
    const samples=await evaluate(`window.__ckSerialResults`);assert.equal(samples.length,3,JSON.stringify(samples));
    for(let i=0;i<nonces.length;i++){
        const s=samples[i+1];assert.equal(s.port,port);assert.equal(s.baud,baud);assert.equal(s.truncated,false);
        assert.equal(s.text.trim(),'CK_ACK:'+nonces[i]);report.challenges.push({sent:'CK?'+nonces[i],received:s.text.trim()});
    }
    report.revocationChecked=true;
} catch(e){report.error=String(e);process.exitCode=1;
    fs.writeFileSync(path.join(dir,'failure.png'),await client.screenshot());
    const details=await evaluate(`({feed:document.querySelector('.ck-ai-feed')?.innerText,native:window.__ckNativeProbe,parts:document.body.innerText.slice(-6000)})`);fs.writeFileSync(path.join(dir,'failure.json'),JSON.stringify(details,null,2));}
finally {
    try {await invoke('close_serial_monitor');await assert.rejects(()=>invoke('ai_serial_sample',{port,baud,waitMs:100}),/所选串口会话未连接/);report.portReleased=true;}
    finally{fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({dir,...report}));client.close();}
}
