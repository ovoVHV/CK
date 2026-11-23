// Runs against the preview IPC; never selects a serial port or flashes firmware.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {randomUUID,createHash} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';

const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const root=fs.mkdtempSync(path.join(config.paths.evidenceRoot,'多文件-'));
const project=path.join(root,path.basename(root)+'.ck'), modulePath='src/sampling', member=path.join(root,modulePath,'helper.cpp');
fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:path.basename(root),board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'member-fixture',x:50,y:64}]}})}));
const code=`#include "${modulePath}/helper.h"\nvolatile int observed;\nvoid setup(){observed=readFixture();}\nvoid loop(){}\n`;
const sourceSha256=createHash('sha256').update(code).digest('hex');
const client=await connectDesktop();
const invoke=(command,params)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(params)})`);
const candidateId=randomUUID();
const compile=async()=>JSON.parse(await invoke('compile_ai_candidate',{candidateId,runId:randomUUID(),code,fqbn:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreVersion:'1.8.8',projectPath:project,sourceMapJson:JSON.stringify({schema:'ck-sourcemap',version:1,file:'sketch.ino',lineCount:code.split('\n').length,codeSha256:sourceSha256,mappings:[]})}));
try {
    const create=files=>invoke('create_ai_project_sources',{path:project,files});
    const header={path:modulePath+'/helper.h',code:'int readFixture();\n'};
    const impl={path:modulePath+'/helper.cpp',code:'#include "helper.h"\n// 采样模块\nint readFixture(){return 17;}\n'};
    const wait=async expr=>{for(let i=0;i<150;i++){if(await client.evaluate(`Boolean(${expr})`))return;await new Promise(r=>setTimeout(r,160));}throw Error('Timeout: '+expr);};
    const click=selector=>client.evaluate(`document.querySelector(${JSON.stringify(selector)}).click()`);
    await wait("document.body.innerText.includes('我的工程')");
    // Stub model and private chat store only. File writes, project tree and compiler use native IPC.
    await client.evaluate(`(()=>{
        const stub=async(cmd,args)=>{
            if(cmd==='ai_load_preferences')return {baseUrl:'http://127.0.0.1:9/v1',model:'fixture',apiKey:'test',autoApply:false};
            if(cmd==='ai_list_chats')return {chats:[],unreadable:0};
            if(cmd==='ai_save_chat')return args.value.revision+1;
            const seen=args.req.historyMessages.filter(m=>m.role==='tool');
            const tool=(name,args)=>({id:crypto.randomUUID(),type:'function',function:{name,arguments:JSON.stringify(args)}});
            if(!seen.length)return {content:'',finishReason:'tool_calls',toolCalls:[tool('project_files',{}),tool('create_project_sources',{files:[{path:'src/采样/fixture.h',code:'// rejected'}]})]};
            if(seen.length===2){
                if(!JSON.parse(seen[1].content).error?.includes('AVR'))throw Error('Expected AVR path correction');
                return {content:'',finishReason:'tool_calls',toolCalls:[tool('create_project_sources',{files:${JSON.stringify([header,impl])}})]};
            }
            return {content:'已结束文件任务',finishReason:'stop',toolCalls:[]};
        };
        const match=cmd=>['ai_load_preferences','ai_list_chats','ai_save_chat','chat_with_glm_stream'].includes(cmd);
        const api=window.__TAURI_INTERNALS__,original=api.invoke;
        if(Object.getOwnPropertyDescriptor(api,'invoke')?.writable){api.invoke=(cmd,args,...rest)=>match(cmd)?stub(cmd,args):original(cmd,args,...rest);return;}
        const before=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
            if(u.hostname==='ipc.localhost'&&match(cmd))return new Response(JSON.stringify(await stub(cmd,JSON.parse(options.body||'{}'))),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
            return before(url,options);};
    })()`);
    await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:randomUUID(),path:project,source:'member-fixture'}});
    await wait(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('member-fixture')`);
    await click('[data-ck-role="ai-assistant-trigger"]');
    await wait(`document.querySelector('[aria-label="新对话"]')?.disabled===false && !document.querySelector('.ck-ai-disabled')`);
    await click('.ck-ai-access-entry');
    const grant=`[...document.querySelectorAll('.ck-ai-permissions label')].find(l=>l.textContent.includes('src/')).querySelector('input')`;
    assert.equal(await client.evaluate(`${grant}.checked`),false);
    await client.evaluate(`${grant}.click()`);
    await click('.ck-ai-permissions .ck-ai-back');
    await client.evaluate(`(()=>{const el=document.querySelector('.ck-ai-input-shell textarea');Object.getOwnPropertyDescriptor(HTMLTextAreaElement.prototype,'value').set.call(el,'创建采样模块');el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
    await wait(`document.querySelector('.ck-ai-send')?.disabled===false`);await click('.ck-ai-send');
    await wait(`document.querySelector('.ck-ai-source-review')`);
    assert(!fs.existsSync(member));assert(!fs.existsSync(path.join(root,'src','采样')));await click('.ck-ai-source-review details summary');
    assert((await client.evaluate(`document.querySelector('.ck-ai-source-review pre').textContent`)).includes('readFixture'));
    await click('.ck-ai-source-review .ck-ai-primary');
    await wait(`document.querySelector('.ck-ai-feed').innerText.includes('工程文件已创建')`);
    if(await client.evaluate(`!!document.querySelector('.ck-files-rail')`))await click('.ck-files-rail');
    await wait(`document.querySelector('.ck-tree-leaf[title="${impl.path}"]')`);
    await click(`.ck-tree-leaf[title="${impl.path}"]`);
    await wait(`document.querySelector('.ck-member-content .cm-content')?.textContent.includes('readFixture')`);
    await assert.rejects(()=>create([{path:'src/orphan/extra.cpp',code:'// rejected batch'}, {...header,code:'oops'}]),/同名/);
    await assert.rejects(()=>create([{path:'src/rollback/a.h',code:'// first member'}, {path:'src/rollback/a.h/child.h',code:'// parent must be a dir'}]));
    assert.equal(fs.existsSync(path.join(root,'src','rollback')),false);
    for(const name of ['src/../../bad.h','build.cmd','root.cpp'])await assert.rejects(()=>create([{path:name,code:'// rejected'}]));
    assert.equal(fs.existsSync(path.join(root,'src','orphan')),false);
    assert.equal((await invoke('read_project_source',{path:project,name:header.path})).code,header.code);
    assert.deepEqual(await invoke('list_project_sources',{path:project}),[impl.path,header.path]);
    const valid=await compile();
    assert.equal(valid.ok,true,valid.log.slice(-2200));assert.ok(valid.artifactCount>0);
    assert.equal(valid.memberIdentity,await invoke('project_source_identity',{path:project}));
    fs.writeFileSync(member,'#error CK_TEST_MEMBER_CHANGED\n');
    const invalid=await compile();
    assert.equal(invalid.ok,false);assert.match(invalid.log,/CK_TEST_MEMBER_CHANGED/);
    assert.notEqual(valid.memberIdentity,invalid.memberIdentity);
    await assert.rejects(()=>invoke('upload_sketch',{code,fqbn:'arduino:avr:uno',runId:randomUUID(),port:'CK-QA-NOT-A-PORT',projectPath:project,expectedMemberIdentity:valid.memberIdentity}),/候选验证后的工程源码文件已变化/);
    await assert.rejects(()=>invoke('ai_serial_sample',{port:'CK-QA-NOT-A-PORT',baud:115200,waitMs:100}),/所选串口会话未连接/);
    const report={board:'arduino:avr:uno',core:'1.8.8',created:[header.path,impl.path],avrNameCorrectedBeforeWrite:true,manualReviewBeforeDiskWrite:true,openedFromTree:true,model:'scripted',rejectedBatchLeftNoOrphan:true,positiveArtifacts:valid.artifactCount,negativeDiagnostic:'CK_TEST_MEMBER_CHANGED',memberHashChanged:true,staleUploadRejected:true,disconnectedReadRejected:true,flashed:false};
    fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log(report);
} finally {client.close();}
