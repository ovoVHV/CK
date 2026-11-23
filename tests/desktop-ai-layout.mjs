// Use Start-Preview.ps1 with an isolated WebView profile. No model or board needed.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const cfg = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const before = process.env.CK_AI_LAYOUT_BASELINE === '1';
const out = path.join(cfg.paths.evidenceRoot,`${before?'before':'after'}-${Date.now()}`);
fs.mkdirSync(out,{recursive:true});
const client = await connectDesktop();
const {evaluate} = client;
const sleep = ms=>new Promise(resolve=>setTimeout(resolve,ms));
const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p=>p.url==='http://tauri.localhost/');
const socket = new WebSocket(page.webSocketDebuggerUrl);
await new Promise((r,j)=>{socket.onopen=r;socket.onerror=j;});
const pending = new Map(); let seq = 0;
socket.onmessage = e=>{const m=JSON.parse(e.data);if(pending.has(m.id)){const {r,j}=pending.get(m.id);pending.delete(m.id);m.error?j(Error(m.error.message)):r(m.result);}};
const command=(method,params)=>new Promise((r,j)=>{const id=++seq;pending.set(id,{r,j});socket.send(JSON.stringify({id,method,params}));});
const wait=async expr=>{for(let i=0;i<160;i++){if(await evaluate(`Boolean(${expr})`))return;await sleep(125);}throw Error(`Timeout: ${expr}`);};
const click=selector=>evaluate(`(()=>{const el=document.querySelector(${JSON.stringify(selector)});if(!el||el.disabled)throw Error('Unavailable: '+${JSON.stringify(selector)});el.click()})()`);
const textButton=text=>evaluate(`(()=>{const btn=Array.from(document.querySelectorAll('.ck-ai-panel button')).find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!btn||btn.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});btn.click()})()`);
const report={layouts:[],checks:[]};
async function measure(name) {
    await sleep(150);
    const box=await evaluate(`(()=>{const p=document.querySelector('.ck-ai-panel'),f=p.querySelector('.ck-ai-feed'),c=p.querySelector('.ck-ai-composer'),r=p.getBoundingClientRect();
    const visible=e=>{const b=e.getBoundingClientRect(),hit=document.elementFromPoint(b.x+b.width/2,b.y+b.height/2);return b.width>0&&b.height>0&&e.contains(hit)&&b.bottom<=r.bottom+1&&b.right<=r.right+1&&b.left>=r.left-1};
    return {x:r.x,y:r.y,width:r.width,height:r.height,feed:f.clientHeight,composer:c.clientHeight,boardNotice:p.querySelector('.ck-ai-disabled')?.textContent||'',emptyOverflows:f.scrollHeight>f.clientHeight+1,overflow:p.scrollWidth>p.clientWidth+1,controlsVisible:[...p.querySelectorAll('.ck-ai-controls select,.ck-ai-model-connect,.ck-ai-send,.ck-ai-attach,textarea,.ck-ai-project-path button')].every(visible)}})()`);
    assert(!box.overflow && box.controlsVisible, JSON.stringify({name,box}));report.layouts.push({name,...box});
    fs.writeFileSync(path.join(out,name+'.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png',clip:{x:box.x,y:box.y,width:box.width,height:box.height,scale:1.5}})).data,'base64'));
    return box;
}
try {
    await wait(`document.body.innerText.includes('我的工程')`);
    // Intercept only AI preferences/history, before the editor mounts. Do not read or change the user's AI store.
    await evaluate(`(()=>{const api=window.__TAURI_INTERNALS__,original=api.invoke,rows=new Map();let prefs=null;window.__ckLayoutCalls=[];
        const stub=async(cmd,args,...rest)=>{if(cmd==='chat_with_glm_stream'){window.__ckLayoutCalls.push(cmd);return {content:'已读取当前工程，这是本地测试回复。',finishReason:'stop',toolCalls:[]};}if(cmd.startsWith('ai_')){window.__ckLayoutCalls.push(cmd);
            if(cmd==='ai_load_preferences')return prefs;
            if(cmd==='ai_save_preferences'){prefs=structuredClone(args.value);return;}
            if(cmd==='ai_list_chats')return {chats:[...rows.values()].filter(x=>x.projectKey===args.projectKey).map(x=>({...x,messages:x.messages.length})),unreadable:0};
            if(cmd==='ai_save_chat'){let v=structuredClone(args.value);v.revision++;rows.set(v.id,v);return v.revision;}
            if(cmd==='ai_load_chat')return structuredClone(rows.get(args.id));if(cmd==='ai_delete_chat')return rows.delete(args.id);
            throw Error('Unexpected AI command: '+cmd);}
            return original(cmd,args,...rest);};
        // Tauri may expose invoke as a non-writable property: intercept through the configurable IPC transport instead.
        if(Object.getOwnPropertyDescriptor(api,'invoke')?.writable){api.invoke=stub;return;}
        const oldFetch=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
        if(u.hostname==='ipc.localhost'&&(cmd.startsWith('ai_')||cmd==='chat_with_glm_stream'))return new Response(JSON.stringify((await stub(cmd,JSON.parse(options.body||'{}')))??null),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
        return oldFetch(url,options);};})()`);
    await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
    const file=path.join(out,'Nano.ck'),id=randomUUID();
    fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'Nano',board:'arduino:avr:nano',board_package_id:'arduino:avr:nano',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'ai-layout-loop',x:48,y:64}]}})}));
    for(let i=0;i<30;i++){if(await evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('ai-layout-loop'))`))break;
        await evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId:id,path:file,source:'ai-layout'})}})`);await sleep(350);}
    await wait(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('ai-layout-loop')`);
    await click('[data-ck-role="ai-assistant-trigger"]');
    await wait(`document.querySelector('.ck-ai-input-shell textarea') && document.querySelector('[aria-label="新对话"]')?.disabled===false`);
    assert(await evaluate(`window.__ckLayoutCalls.includes('ai_list_chats')`));
    await evaluate(`document.querySelector('.ck-ai-panel [role="separator"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.documentElement.classList.remove('dark')`);
    await wait(`!document.querySelector('.ck-ai-disabled')`);
    await measure('nano-light');
    await command('Emulation.setDeviceMetricsOverride',{width:900,height:600,deviceScaleFactor:1,mobile:false});await sleep(250);
    await measure('nano-short');
    if(!before) {
        assert(report.layouts.every(x=>!x.emptyOverflows));
        const sep='.ck-ai-panel [role="separator"]';
        await evaluate(`document.querySelector(${JSON.stringify(sep)}).dispatchEvent(new KeyboardEvent('keydown',{key:'Home',bubbles:true}));document.documentElement.classList.add('dark')`);
        await measure('nano-narrow-dark');
        await click('.ck-ai-context-details summary');await wait(`document.querySelector('.ck-ai-context-details[open]')`);await click('.ck-ai-context-details summary');
        await textButton('制作积木库');await wait(`document.querySelector('.ck-ai-library-auto input')?.checked`);await click('.ck-ai-library-auto input');await measure('library-dark');
        await textButton('编程助手');await textButton('解释当前程序');await wait(`document.querySelector('.ck-ai-input-shell textarea')?.value==='解释当前程序'`);
        await click('.ck-ai-access-entry');await wait(`document.activeElement===document.querySelector('.ck-ai-permissions .ck-ai-back')`);
        assert(await evaluate(`!document.querySelector('.ck-ai-composer') && !document.querySelector('.ck-ai-scopebar') && document.querySelectorAll('.ck-ai-permissions fieldset').length===2 && document.querySelector('.ck-ai-permissions').scrollWidth<=document.querySelector('.ck-ai-permissions').clientWidth+1`));
        const rect=await evaluate(`document.querySelector('.ck-ai-panel').getBoundingClientRect().toJSON()`);
        fs.writeFileSync(path.join(out,'project-device-narrow-dark.png'),Buffer.from((await command('Page.captureScreenshot',{format:'png',clip:{x:rect.x,y:rect.y,width:rect.width,height:rect.height,scale:1.5}})).data,'base64'));
        await client.input('Input.dispatchKeyEvent',{type:'keyDown',key:'Escape',windowsVirtualKeyCode:27});
        await client.input('Input.dispatchKeyEvent',{type:'keyUp',key:'Escape',windowsVirtualKeyCode:27});
        await wait(`document.activeElement===document.querySelector('.ck-ai-input-shell textarea') && document.activeElement.value==='解释当前程序'`);
        await click('.ck-ai-model-connect');await wait(`document.querySelector('.ck-ai-settings')`);await textButton('返回对话');await wait(`document.querySelector('.ck-ai-input-shell textarea')?.value==='解释当前程序'`);
        // A synthetic preference response is enough to check the configured footer without calling a real model.
        await click('.ck-ai-model-connect');
        await evaluate(`(()=>{const set=(sel,v)=>{const el=document.querySelector(sel);Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,v);el.dispatchEvent(new Event('input',{bubbles:true}))};
        set('.ck-ai-settings input[type=url]','http://127.0.0.1:9/v1');set('.ck-ai-settings [aria-label="手动填写模型名称"]','layout-test');set('.ck-ai-settings input[type=password]','fixture-only');})()`);
        await textButton('保存连接设置');await wait(`document.querySelector('[aria-label="当前 AI 模型"]')?.value==='layout-test'`);
        await evaluate(`document.querySelector('[aria-label="思考强度"]').value='high';document.querySelector('[aria-label="思考强度"]').dispatchEvent(new Event('change',{bubbles:true}));`);
        await wait(`document.querySelector('[aria-label="思考强度"]')?.value==='high'`);
        await evaluate(`document.querySelector('[aria-label="AI 修改模式"]').value='manual';document.querySelector('[aria-label="AI 修改模式"]').dispatchEvent(new Event('change',{bubbles:true}));`);
        await wait(`document.querySelector('[aria-label="AI 修改模式"]')?.value==='manual'`);
        await click('[aria-label="发送需求"]');await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('本地测试回复')`);
        await click('[aria-label="聊天记录"]');await wait(`document.querySelector('.ck-ai-history')`);await textButton('返回对话');
        await click('[aria-label="新对话"]');await wait(`document.querySelector('.ck-ai-input-shell textarea')?.value===''`);
        await evaluate(`(()=>{const f=document.querySelector('input[aria-label="选择 AI 附件"]'),dt=new DataTransfer();dt.items.add(new File(['int pin = 5;'],'pins.cpp',{type:'text/plain'}));f.files=dt.files;f.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await wait(`document.querySelector('[aria-label="移除附件 pins.cpp"]')`);await click('[aria-label="移除附件 pins.cpp"]');
        await evaluate(`(()=>{const t=document.querySelector('.ck-ai-input-shell textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(t,'很长的草稿\\n'.repeat(40));t.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        await wait(`document.querySelector('.ck-ai-input-shell textarea').scrollHeight>document.querySelector('.ck-ai-input-shell textarea').clientHeight && !document.querySelector('.ck-ai-send').disabled`);
        await measure('configured-long-draft');
        const projectKey='file:'+file.replaceAll('\\','/').toLowerCase(), chatId=randomUUID();
        const sample={schemaVersion:1,revision:0,id:chatId,projectKey,title:'Nano 采样程序',messages:[
            {id:'1',role:'user',text:'每隔 100 毫秒读一次 A0，串口输出最近四次读数的平均值。'},
            {id:'2',role:'assistant',text:'可以在 loop 里用 millis() 判断是否到了采样时间。用长度为 4 的数组保存读数，每采到一个值，就替换最旧的读数。'},
            {id:'3',role:'user',text:'启动时还没采够四次，平均值应该怎么算？'},
            {id:'4',role:'assistant',text:'单独记录有效样本数。第一次除以 1，第二次除以 2，直到收到第四个读数后再固定除以 4。这样前几次的平均值不会被初始的零拉低。'}
        ],draft:'',updatedAt:Date.now()+60000};
        await evaluate(`window.__TAURI_INTERNALS__.invoke('ai_save_chat',{value:${JSON.stringify(sample)}})`);
        await click('[aria-label="聊天记录"]');await wait(`Array.from(document.querySelectorAll('.ck-ai-chat-select')).some(e=>e.textContent.includes('Nano 采样程序'))`);
        await evaluate(`Array.from(document.querySelectorAll('.ck-ai-chat-select')).find(e=>e.textContent.includes('Nano 采样程序')).click()`);
        await wait(`document.querySelectorAll('.ck-ai-message').length===4`);
        await command('Emulation.setDeviceMetricsOverride',{width:1280,height:800,deviceScaleFactor:1,mobile:false});
        await evaluate(`document.querySelector('.ck-ai-panel [role="separator"]').dispatchEvent(new MouseEvent('dblclick',{bubbles:true}));document.documentElement.classList.remove('dark')`);
        await measure('conversation-light');
        assert(await evaluate(`document.querySelector('.ck-ai-chat-caption')?.textContent==='Nano 采样程序' && document.querySelector('.ck-ai-chat-caption').getBoundingClientRect().width>20`));
        await evaluate(`document.documentElement.classList.add('dark')`);await measure('conversation-dark');
        report.checks.push('Narrow dark composer, collapsible usage, library checkbox, shortcut, connection and draft preservation, model and effort selection, manual mode, history, new chat, attachment add/remove and long draft');
    }
    report.ok=true;
} catch(e) {report.error=String(e.stack);process.exitCode=1;}
finally {fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify({out,...report}));socket.close();client.close();}
