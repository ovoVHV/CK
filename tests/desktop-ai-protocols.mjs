// Run with Start-Preview.ps1 -Harness. No project, saved account, or board required.
import http from 'node:http';
import { once } from 'node:events';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { createConnection } from 'node:net';
import assert from 'node:assert/strict';
import { connectDesktop } from './desktop-client.mjs';

const client=await connectDesktop();
const invoke=(name,args)=>client.evaluate(`(async()=>{try{return {value:await window.__TAURI_INTERNALS__.invoke(${JSON.stringify(name)},${JSON.stringify(args)})};}catch(e){return {error:String(e)};}})()`);
const functionDef={type:'function',function:{name:'ck_echo',description:'Return the test marker',parameters:{type:'object',properties:{},additionalProperties:false}}};
const testTool={type:'function_call',id:'fc_fixture',call_id:'call_fixture',name:'ck_echo',arguments:'{}',status:'completed'};
const reason={type:'reasoning',id:'rs_fixture',summary:[],encrypted_content:'fixture-only'};
const completed=output=>({status:'completed',model:'fixture',output,usage:{input_tokens:7,output_tokens:4,total_tokens:11}});
const text=value=>({type:'message',content:[{type:'output_text',text:value}]});
const fixtureModels=['codex-auto-review','gpt-6.2-sol',...Array.from({length:11},(_,i)=>`fixture-${i}`)];
let requests=[];
const server=http.createServer(async(req,res)=>{
    let raw=''; for await(const c of req)raw+=c;
    const b=raw?JSON.parse(raw):null;requests.push({path:req.url,b});
    if(req.url==='/v1/models'){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify({data:fixtureModels.map(id=>({id}))}));}
    res.setHeader('Content-Type','text/event-stream');
    const emit=e=>res.write(`data: ${JSON.stringify(e)}\r\n\r\n`);
    if(req.url==='/v1/chat/completions'){emit({choices:[{delta:{content:'CHAT_OK'},finish_reason:'stop'}]});return res.end('data: [DONE]\n\n');}
    if(req.url!=='/v1/responses'){res.statusCode=404;return res.end();}
    if(!b.stream){res.setHeader('Content-Type','application/json');return res.end(JSON.stringify(completed([text('SYNC_OK')])));}
    if(b.model==='cut'){emit({type:'response.output_item.done',item:testTool});return res.end();}
    if(b.model==='short'){emit({type:'response.incomplete',response:{status:'incomplete',incomplete_details:{reason:'max_output_tokens'},output:[testTool]}});return res.end();}
    const next=b.input.some(i=>i.type==='function_call_output');
    if(next)emit({type:'response.output_text.delta',delta:'RESULT_OK'});
    emit({type:'response.completed',response:completed(next?[text('RESULT_OK')]:[reason,testTool])});res.end();
});
server.listen(0,'127.0.0.1');await once(server,'listening');
const local=`http://127.0.0.1:${server.address().port}/v1`;
async function chat(baseUrl,apiKey,patch={},cmd='chat_with_glm_stream'){
    return invoke(cmd,{req:{baseUrl,apiKey,model:'fixture',userMessage:'Protocol check.',systemPrompt:'Follow the request.',timeoutMs:40000,maxTokens:512,...patch}});
}
try {
    if(process.env.CK_PROTOCOL_QA_ROOT){
        const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
        assert.equal(path.resolve(cfg.paths.sysroot),path.resolve(process.env.CK_PROTOCOL_QA_ROOT));
        assert.equal((await invoke('ai_load_preferences',{})).value,null,'Requires an empty isolated user profile');
        const e=client.evaluate,wait=async expr=>{for(let i=0;i<120;i++){if(await e(`Boolean(${expr})`))return;await new Promise(r=>setTimeout(r,200));}throw Error(`UI timeout: ${expr}`);};
        const project=path.join(cfg.paths.evidenceRoot,'protocol-test.ck');
        fs.writeFileSync(project,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'Protocol test',board:'arduino:avr:nano',board_package_id:'arduino:avr:nano',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'ck-protocol-loop',x:48,y:64}]}})}));
        await wait(`document.body.innerText.includes('我的工程')`);
        const payload={requestId:randomUUID(),path:project,source:'protocol-test'};
        for(let i=0;i<20&&!await e(`!!window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace?.getBlockById('ck-protocol-loop')`);i++){
            await invoke('plugin:event|emit',{event:'ck-project-open-requested',payload});await new Promise(r=>setTimeout(r,350));
        }
        await wait(`document.querySelector('[data-ck-role="ai-assistant-trigger"]')`);await e(`document.querySelector('[data-ck-role="ai-assistant-trigger"]').click()`);
        await wait(`document.querySelector('.ck-ai-model-connect')?.disabled===false`);await e(`document.querySelector('.ck-ai-model-connect').click()`);
        const protocol=`Array.from(document.querySelectorAll('.ck-ai-settings select')).find(s=>s.querySelector('option[value="responses"]'))`;
        await wait(protocol);assert.equal(await e(`(${protocol}).value`),'chat');
        await e(`(()=>{const p=(${protocol});p.value='responses';p.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        const setInput=(sel,value)=>e(`(()=>{const el=document.querySelector('.ck-ai-settings ${sel}');Object.getOwnPropertyDescriptor(HTMLInputElement.prototype,'value').set.call(el,${JSON.stringify(value)});el.dispatchEvent(new Event('input',{bubbles:true}));})()`);
        const manual='input[aria-label="手动填写模型名称"]';
        const fetchButton=`Array.from(document.querySelectorAll('.ck-ai-settings button')).find(b=>b.textContent.includes('获取服务商模型列表'))`;
        await setInput('input[type=url]',local);await setInput('input[type=password]','fixture-only');
        await e(`(${fetchButton}).click()`);
        const picker=`document.querySelector('[aria-label="服务商模型列表"]')`;
        await wait(`${picker}?.querySelectorAll('optgroup option').length===13`);
        assert.equal(await e(`${picker}.value`),'','Multiple choices should not silently select the first model');
        // Recreate a connection already holding the first alphabetic name.
        await setInput('input[type=password]','fixture-updated');
        await setInput(manual,'codex-auto-review');
        await e(`(${fetchButton}).click()`);await wait(`${picker}?.querySelectorAll('optgroup option').length===13`);
        assert.equal(await e(`${picker}.selectedOptions[0].textContent`),'codex-auto-review');
        assert.deepEqual(await e(`Array.from(${picker}.querySelectorAll('optgroup option'),o=>o.textContent)`),[...fixtureModels].sort());
        const choose=value=>e(`(()=>{const p=${picker};p.value=${JSON.stringify(value)};p.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await choose('manual');await wait(`document.querySelector('[aria-label="手动填写模型名称"]')?.value==='codex-auto-review'`);
        await setInput(manual,'private-alias');
        await e(`(${fetchButton}).click()`);await wait(`(${fetchButton}) && !(${fetchButton}).disabled`);
        assert.equal(await e(`document.querySelector('[aria-label="手动填写模型名称"]').value`),'private-alias');
        await choose('id:gpt-6.2-sol');
        await e(`document.querySelector('.ck-ai-settings button[type=submit]').click()`);
        await wait(`document.querySelector('[aria-label="当前 AI 模型"]')?.value==='gpt-6.2-sol'`);
        const saved=(await invoke('ai_load_preferences',{})).value;assert.equal(saved.apiProtocol,'responses');assert.equal(saved.model,'gpt-6.2-sol');
        await e(`document.querySelector('.ck-ai-panel button[title*="设置"], .ck-ai-panel button[aria-label*="设置"]').click()`);
        await wait(protocol);assert.equal(await e(`(${protocol}).value`),'responses');
        assert.equal(await e(`${picker}.querySelectorAll('optgroup option').length`),13);
        assert.equal(await e(`${picker}.selectedOptions[0].textContent`),'gpt-6.2-sol');
        await e(`(${protocol}).scrollIntoView({block:'nearest'})`);
        fs.writeFileSync(path.join(cfg.paths.evidenceRoot,'ai-protocol-settings.png'),await client.screenshot());
        delete saved.apiProtocol;saved.rememberKey=false;saved.apiKey='';
        await invoke('ai_save_preferences',{value:saved});assert.equal((await invoke('ai_load_preferences',{})).value.apiProtocol,'chat');
        console.log('PASS settings: all 13 models visible with a prefilled name, manual entry, switched and reopened gpt-6.2-sol, Responses saved, legacy defaults to Chat');
    }
    for(const suffix of ['','/responses','/chat/completions']){
        assert.deepEqual((await invoke('ai_list_models',{baseUrl:local+suffix,apiKey:'fixture'})).value,[...fixtureModels].sort());
    }
    assert.equal((await chat(local,'fixture')).value.content,'CHAT_OK');
    assert.equal((await chat(local+'/responses','fixture',{apiProtocol:'chat'})).value.content,'CHAT_OK');
    const first=(await chat(local+'/chat/completions','fixture',{apiProtocol:'responses',tools:[functionDef],reasoningEffort:'max',images:['data:image/png;base64,YQ==']})).value;
    assert.equal(first.finishReason,'tool_calls');assert.equal(first.toolCalls[0].id,'call_fixture');
    assert.deepEqual(first.responseReasoning,[reason]);
    const body=requests.at(-1).b;
    assert.equal(body.store,false);assert.equal(body.tools[0].name,'ck_echo');assert.equal(body.reasoning.effort,'xhigh');
    assert.equal(body.input.at(-1).content[1].type,'input_image');assert.equal(body.max_output_tokens,512);
    const history=[{role:'user',content:'Use the tool.'},{role:'assistant',content:'',tool_calls:first.toolCalls,responseReasoning:first.responseReasoning},{role:'tool',tool_call_id:'call_fixture',content:'RESULT_OK'}];
    const second=(await chat(local,'fixture',{apiProtocol:'responses',userMessage:'__TOOL_CONTINUE__',historyMessages:history})).value;
    assert.equal(second.content,'RESULT_OK');assert.equal(second.totalTokens,11);
    assert.deepEqual(requests.at(-1).b.input.slice(-3).map(i=>i.type),['reasoning','function_call','function_call_output']);
    const sync=await chat(local,'fixture',{apiProtocol:'responses'},'chat_with_glm');
    assert.ifError(sync.error?Error(sync.error.slice(0,300)):null);assert.equal(sync.value.content,'SYNC_OK');
    assert.match((await chat(local,'fixture',{model:'cut',apiProtocol:'responses'})).error,/中断/);
    const short=(await chat(local,'fixture',{model:'short',apiProtocol:'responses'})).value;
    assert.equal(short.finishReason,'length');assert.ok(!short.toolCalls?.length);
    console.log('PASS desktop IPC: model listing, default and explicit Chat, Responses stream/sync, images, reasoning, tool continuation, truncation and aborted stream');

    // Optional live check. The key is supplied once on a local current-user pipe, never saved.
    if(process.env.CK_PROTOCOL_TEST_PIPE){
        const baseUrl=process.env.CK_PROTOCOL_TEST_BASE_URL,model=process.env.CK_PROTOCOL_TEST_MODEL;
        assert.ok(baseUrl && new URL(baseUrl).protocol==='https:' && model,'Explicit HTTPS provider and model required for live tests');
        const pipe=createConnection(process.env.CK_PROTOCOL_TEST_PIPE);
        pipe.setEncoding('utf8');let key='';pipe.on('data',s=>{key+=s;});await once(pipe,'end');
        const check=(x,label)=>{if(x.error)throw Error(label+': '+String(x.error).replaceAll(key,'[redacted]').replace(/sk-[a-zA-Z0-9_-]+/g,'[redacted]').slice(0,300));return x.value;};
        if(process.env.CK_PROTOCOL_CN_LIST_ONLY==='1'){
        const ids=check(await invoke('ai_list_models',{baseUrl,apiKey:key}),'Model list');key='';
        assert.ok(ids.includes(model));console.log(`PASS desktop: ${ids.length} models including requested model (listing only)`);
        }else{
        const models=check(await invoke('ai_list_models',{baseUrl,apiKey:key}),'Live model list');
        assert.ok(models?.includes(model),'Live model not listed');
        console.log(`PASS live desktop: ${models.length} models listed; found ${model}`);
        const prompt='Call ck_echo exactly once. After the tool returns, reply only with its exact marker.';
        const failures=[];
        for(const apiProtocol of ['chat','responses']){
            try{
                const common={apiProtocol,model,tools:[functionDef],timeoutMs:75000,maxTokens:1024};
                const a=check(await chat(baseUrl,key,{...common,userMessage:prompt,toolChoice:{type:'function',function:{name:'ck_echo'}}}),'Tool request');
                assert.equal(a.toolCalls?.length,1);const call=a.toolCalls[0];
                assert.equal(call.function.name,'ck_echo');assert.ok(call.id);
                const marker=`CK_${randomUUID().slice(0,8)}`;
                const b=check(await chat(baseUrl,key,{...common,userMessage:'__TOOL_CONTINUE__',toolChoice:'none',historyMessages:[
                    {role:'user',content:prompt},
                    {role:'assistant',content:a.content||'',tool_calls:a.toolCalls,responseReasoning:a.responseReasoning,reasoning_content:a.reasoningContent},
                    {role:'tool',tool_call_id:call.id,content:marker}
                ]}),'Tool continuation');
                assert.ok(b.content?.trim()===marker,'Reply did not exactly match the random tool result');
                console.log(`PASS live desktop: ${model} ${apiProtocol}: called ${call.function.name}, returned ${marker}`);
            }catch(e){failures.push(apiProtocol);console.error(`FAIL live desktop: ${model} ${apiProtocol}: ${String(e.message).slice(0,350)}`);}
        }
        key=''; assert.deepEqual(failures,[],'Live protocol failures');
        }
    }
} finally {client.close();server.closeAllConnections();server.close();}
