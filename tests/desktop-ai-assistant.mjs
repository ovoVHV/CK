// Real Tauri, Blockly, checkpoint storage and local compiler. Only the model is scripted.
import fs from 'node:fs';
import path from 'node:path';
import http from 'node:http';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { createHash } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, `ai-desktop-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', model: 'scripted localhost SSE, no live provider qualification', frontendStyleOverride: Boolean(process.env.CK_AI_STYLE_FIXTURE || process.env.CK_AI_UI_OVERLAY), modelListFixture: process.env.CK_AI_MODEL_LIST_FIXTURE==='1', checks: [] };
report.desktopSha256 = JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot, 'desktop-launch.json'), 'utf8').replace(/^\uFEFF/, '')).sha256;
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let client, savedSettings, savedDark, mode = 'generate', requestCount = 0, canceledConnections = 0;
const requests = [];
const call = (name, args) => ({ id: randomUUID(), type: 'function', function: { name, arguments: JSON.stringify(args) } });
let metadataProbe;
const phase2Checks=process.env.CK_AI_PHASE2_CHECKS==='1';
const productChecks=process.env.CK_AI_PRODUCT_CHECKS==='1';
const controlsChecks=process.env.CK_AI_CONTROLS_CHECKS==='1';
const preferencesPath=path.join(config.paths.sysroot,'state/ai-assistant-v1/preferences.json');
const savedPreferences=productChecks&&fs.existsSync(preferencesPath)?fs.readFileSync(preferencesPath):null;
function completion(body) {
    if(mode==='attachments') {
        assert.equal(body.reasoning_effort,'high');assert.equal(body.model,'ck-vision-fixture');
        const user=body.messages.find(m=>m.role==='user'&&Array.isArray(m.content)&&m.content.some(p=>p.type==='image_url'));
        assert(user,'Image must reach native HTTP as image_url');
        assert(user.content.some(p=>p.type==='image_url'&&p.image_url.url.startsWith('data:image/jpeg;base64,')));
        const text=user.content.find(p=>p.type==='text').text;
        const id=text.match(/"id":"([^"]+)","name":"参数.txt"/)[1];
        if(!body.messages.some(m=>m.role==='tool'&&m.name==='read_attachment'))return {tool_calls:[call('read_attachment',{id})]};
        assert(body.messages.some(m=>m.role==='tool'&&m.content.includes('ATTACHMENT_TEXT_MARKER')));
        return {content:'已收到图片和 UTF-8 参数附件；这是传输测试，不修改工程。'};
    }
    if(mode==='truncated')return {tool_calls:[call('propose_change',{summary:'Truncated output must never be executed',edits:[{action:'remove',blockId:'ai-loop'}]})]};
    if(mode==='context-compression') {
        if(!body.tools?.length) { assert(JSON.stringify(body.messages).includes('温度使用摄氏度'));return {content:'长期目标：温度使用摄氏度，控制逻辑不得阻塞；保留硬件约束。尚未做真机验证。'}; }
        assert(JSON.stringify(body.messages).includes('末条历史完整性标记_END'));
        assert(JSON.stringify(body.messages).includes('温度使用摄氏度'));return {content:'已读取压缩后的目标；下一步会重新读取当前工程再修改。'};
    }
    const tools = body.messages.filter(m => m.role === 'tool');
    const lookup = name => tools.filter(m => m.name === name).map(m => JSON.parse(m.content));
    if (mode === 'library-metadata') {
        if (!lookup('list_libraries').length) return {tool_calls:[call('list_libraries',{query:metadataProbe.type}),call('search_blocks',{query:metadataProbe.type,libraryId:metadataProbe.library_id || '@toolbox'}),call('get_block_schema',{type:metadataProbe.type})]};
        assert(lookup('search_blocks')[0].blocks.some(b=>b.type===metadataProbe.type));
        assert(lookup('list_libraries')[0].libraries.some(library=>library.libraryId===(metadataProbe.library_id||'@toolbox')));
        const schema=lookup('get_block_schema')[0];assert.equal(schema.capability.libraryId,metadataProbe.library_id||'@toolbox');
        if (!lookup('get_block_documentation').length) return {tool_calls:['semantics','output','constraints','examples'].map(section=>call('get_block_documentation',{type:metadataProbe.type,section}))};
        const documents=lookup('get_block_documentation');
        assert.equal(documents.length,4);
        const semantics=documents.find(d=>d.section==='semantics');
        if(metadataProbe.semantics) assert.deepEqual(semantics.records[0],metadataProbe.semantics);else assert.equal(semantics.status,'undeclared');
        const output=metadataProbe.output_contract ?? metadataProbe.output;
        if(output!==undefined) assert.deepEqual(documents.find(d=>d.section==='output').records[0],output);
        for(const section of ['constraints','examples']) {
            const document=documents.find(d=>d.section===section);
            assert.deepEqual(document.records,metadataProbe[section]||[]);
            assert.equal(document.status,metadataProbe[section]===undefined?'undeclared':metadataProbe.metadata_completeness?.includes(section)?'declared':'adapted');
        }
        assert(documents.every(d=>d.hardwareTested==='unknown'));
        return {content:'库能力、返回值与限制已按实际声明读取；缺失信息没有当作已验证。'};
    }
    if (mode === 'explain') return { content: '循环中按顺序执行等待。此处只是程序解释，尚未验证硬件。🔧' };
    if (mode === 'long-history') {
        assert(body.messages.some(m=>m.role==='user'&&m.content.includes('历史链路验证标记')),'Original request must survive >40 messages');
        const ids=new Set(body.messages.filter(m=>m.role==='assistant').flatMap(m=>m.tool_calls||[]).map(c=>c.id));
        for(const row of tools)assert(ids.has(row.tool_call_id),'No orphaned tool responses');
        if(tools.length<44)return {tool_calls:Array.from({length:4},()=>call('read_workspace',{}))};
        return {content:'完整历史链路验证完成。'};
    }
    if (!lookup('read_workspace').length) return { tool_calls: [call('read_workspace', {})] };
    const blocks = lookup('read_workspace').flatMap(x => x.blocks || []);
    if (mode === 'candidate-repair' || mode === 'candidate-bounded') {
        if (!lookup('get_block_schemas').length) return {tool_calls:[call('get_verification_capabilities'),call('set_task_plan',{steps:['保留现有程序','隔离编译候选并修复实际错误']}),call('get_block_schemas',{types:['math_compound_assign_custom','math_number','control_delay']})]};
        if (!lookup('set_acceptance_plan').length) return {tool_calls:[call('set_acceptance_plan',{version:1,requirements:[{id:'preserve',text:'保留已有逻辑，验证编译错误修复；功能行为待人工核对',method:'review'}],scenarios:[]})]};
        const failed=lookup('propose_change').filter(r=>r.compiled===false);
        if(failed.length){assert.match(JSON.stringify(failed.at(-1)),/lvalue|left operand/i);assert(failed.at(-1).diagnostics.some(d=>d.blockId),'Native source evidence must map the actual error to candidate blocks');}
        const fix=mode==='candidate-repair'&&failed.length;
        return {tool_calls:[call('propose_change',{summary:fix?'修复候选中的非法赋值，保留已有逻辑。':'验证候选报错隔离。',edits:[{action:'append',blockId:blocks.find(b=>b.type==='controls_loop_custom').id,input:'DO',block:fix?
            {type:'control_delay',fields:{UNIT:'MS'},inputs:{TIME:{shadow:{type:'math_number',fields:{NUM:456}}}}}:
            {type:'math_compound_assign_custom',fields:{OP:'+='},inputs:{VAR:{block:{type:'math_number',fields:{NUM:1+failed.length}}},VALUE:{shadow:{type:'math_number',fields:{NUM:0}}}}}}]})]};
    }
    if (mode === 'repair') {
        if (!lookup('read_diagnostics').length) return { tool_calls: [call('read_diagnostics', {})] };
        assert.match(JSON.stringify(lookup('read_diagnostics')), /lvalue|left operand/i);
        assert(blocks.some(b => b.id === 'ai-bad-lvalue'));
        return { tool_calls: [call('propose_change', { summary: '赋值左侧不能使用常量，移除该输入并采用已有积木的默认变量。其他语句保持不变。', edits: [{ action: 'remove', blockId: 'ai-bad-lvalue' }] })] };
    }
    if (mode === 'generate') {
        if (!lookup('search_blocks').length) return { tool_calls: [call('search_blocks', { query: 'control_delay' })] };
        assert(lookup('search_blocks')[0].blocks.some(b => b.type === 'control_delay'));
        if (!lookup('get_block_schema').length) return { tool_calls: [call('get_block_schema', { type: 'control_delay' }), call('get_block_schema', { type: 'math_number' })] };
        assert(lookup('get_block_schema').some(b => b.type === 'control_delay' && b.inputs.some(i => i.name === 'TIME')));
        if(phase2Checks){
            const stages=lookup('stage_blocks');
            if(!stages.length)return {tool_calls:[call('stage_blocks',{summary:'暂存候选等待',nodes:[{key:'delay',type:'control_delay',fields:{UNIT:'MS'},inputs:{TIME:'value'}},{key:'value',type:'math_number',fields:{NUM:600}}],placements:[{action:'append',blockId:blocks.find(b=>b.type==='controls_loop_custom').id,input:'DO',node:'delay'}]})]};
            if(!stages.some(s=>s.patched))return {tool_calls:[call('stage_blocks',{summary:'只修改候选数值节点',patch:true,nodes:[{key:'value',type:'math_number',fields:{NUM:500}}],placements:[]})]};
            if(!lookup('read_staged_code').length)return {tool_calls:[call('read_staged_code',{})]};
            assert.match(lookup('read_staged_code').at(-1).code,/delay\(500\)/);assert(!/delay\(600\)/.test(lookup('read_staged_code').at(-1).code));
            return {tool_calls:[call('propose_change',{summary:'在现有循环中新增等待500毫秒，候选已局部修订并核对实际代码。',edits:[]})]};
        }
        return { tool_calls: [call('propose_change', { summary: '在现有循环中新增等待 500 毫秒。保留初始化与其他积木。', edits: [{ action: 'append', blockId: blocks.find(b => b.type === 'controls_loop_custom').id,
            input: 'DO', block: { type: 'control_delay', fields: { UNIT: 'MS' }, inputs: { TIME: { shadow: { type: 'math_number', fields: { NUM: 500 } } } } } }] })] };
    }
    return { tool_calls: [call('propose_change', { summary: '将等待改为 750 毫秒。', edits: [{ action: 'set_field', blockId: blocks.find(b => b.type === 'math_number').id, field: 'NUM', value: 750 }] })] };
}
const server = http.createServer(async (req, res) => {
    if(req.method==='GET'&&req.url==='/v1/models'){res.writeHead(200,{'Content-Type':'application/json'});res.end(JSON.stringify({data:[{id:'ck-local-fixture'},{id:'ck-vision-fixture'}]}));return;}
    let raw = ''; for await (const chunk of req) raw += chunk;
    try {
        const body = JSON.parse(raw); requestCount++;
        requests.push({ mode, messages: body.messages, tools: body.tools?.map(t => t.function.name), model:body.model, reasoningEffort:body.reasoning_effort });
        if (mode === 'slow') {
            res.on('close', () => { if (!res.writableEnded) canceledConnections++; });
            return; // No headers: cancellation must interrupt the pending Rust HTTP send.
        }
        if (mode === 'error') { res.writeHead(401, { 'Content-Type': 'application/json' }); res.end(JSON.stringify({ error: { message: '测试密钥被拒绝，请检查连接设置' } })); return; }
        const value = completion(body);
        const delta = value.tool_calls ? { tool_calls: value.tool_calls.map((c, index) => ({ index, ...c })) } : value;
        const data = `data: ${JSON.stringify({ model: 'ck-local-fixture', choices: [{ delta, finish_reason: null }] })}\n\n`;
        res.writeHead(200, { 'Content-Type': 'text/event-stream' });
        if (mode === 'explain') {
            const empty=`data: ${JSON.stringify({choices:[{delta:{},finish_reason:null}]})}\n\n`;
            for(let batch=0;batch<50;batch++){res.write(empty.repeat(100));await delay(1);}
        }
        // Deliberately split a multibyte Chinese character over separate TCP writes.
        const bytes = Buffer.from(data); const split = bytes.findIndex(b => b >= 0xe0) + 1;
        res.write(bytes.subarray(0, split)); await delay(15); res.write(bytes.subarray(split));
        res.end(`data: ${JSON.stringify({ choices: [{ delta: {}, finish_reason: mode==='truncated' ? 'length' : value.tool_calls ? 'tool_calls' : 'stop' }] })}\n\ndata: [DONE]\n\n`);
    } catch (error) { res.writeHead(500); res.end(String(error.stack)); }
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
const port = server.address().port;
const W = 'window.CK_NATIVE_REGRESSION.getCurrent().workspace';
const B = 'window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
async function wait(expression, label, timeout = 240000) {
    const at = Date.now();
    while (Date.now() - at < timeout) {
        const value = await client.evaluate(expression); if (value) return value;
        if (label.includes('proposal') || label === 'edit preview' || label === 'native model discovery') {
            const error = await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);
            if (error) throw Error(`${label}: ${error}`);
        }
        await delay(150);
    }
    throw Error(`Timed out: ${label}`);
}
const click = async selector => {
    const result=await client.evaluate(`(()=>{const b=document.querySelector(${JSON.stringify(selector)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(selector)});b.click();return true})()`);
    if(productChecks&&selector==='button[aria-label="新对话"]')await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='新聊天'&&document.querySelectorAll('.ck-ai-message').length===0`,'new chat ready');
    return result;
};
const button = async text => {
    await client.evaluate(`(()=>{const b=[...document.querySelectorAll('[data-ck-role="ai-assistant"] button')].find(b=>b.textContent.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Button unavailable: '+${JSON.stringify(text)});b.click();return true})()`);
    if(productChecks&&text==='新聊天')await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='新聊天'&&Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&document.querySelectorAll('.ck-ai-message').length===0`,'new chat composer ready');
};
const fill = (selector, value) => client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Input missing');const prototype=e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype;Object.getOwnPropertyDescriptor(prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
async function submit(prompt) {
    await fill('.ck-ai-input-shell textarea', prompt); await delay(150);
    assert.equal(await client.evaluate(`document.querySelector('.ck-ai-input-shell textarea').value`), prompt);
    await click('button[aria-label="发送需求"]');
    await delay(300);
    console.log('SUBMIT', await client.evaluate(`JSON.stringify({text:document.querySelector('.ck-ai-feed')?.textContent.slice(-1200),draft:document.querySelector('.ck-ai-input-shell textarea')?.value})`));
}
const select=async(selector,value)=>{await client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(HTMLSelectElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('change',{bubbles:true}));return true})()`);await wait(`document.querySelector(${JSON.stringify(selector)}).disabled===false&&document.querySelector(${JSON.stringify(selector)}).value===${JSON.stringify(value)}`,'selection persisted');};
const snapshot = () => client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);
async function open(file, id) {
    const payload = { requestId: randomUUID(), path: file, source: 'ai-regression' };
    for (let i = 0; i < 240; i++) {
        if (await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(id)})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`)) return;
        if (i % 8 === 0) await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(payload)}})`);
        await delay(250);
    }
    throw Error('Project open timed out');
}
async function picture(name, width, height) {
    const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(x => x.url === 'http://tauri.localhost/');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    let id = 0;
    const command = (method, params) => new Promise((resolve, reject) => {
        const current = ++id; socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id === current) m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result); };
        socket.send(JSON.stringify({ id: current, method, params }));
    });
    try {
        if (width) await command('Emulation.setDeviceMetricsOverride', { width, height, deviceScaleFactor: 1, mobile: false });
        await delay(350);
        const shot = await command('Page.captureScreenshot', { format: 'png' }); fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(shot.data, 'base64'));
        return await client.evaluate(`(()=>{
            const p=document.querySelector('.ck-ai-panel'),r=p.getBoundingClientRect(),h=p.querySelector('.ck-ai-header').getBoundingClientRect(),c=p.querySelector('.ck-ai-composer')?.getBoundingClientRect();
            const obscured=[];
            if(c)for(const x of [.05,.25,.5,.75,.95])for(const y of [.1,.3,.6,.8,.95]){const hit=document.elementFromPoint(c.left+c.width*x,c.top+c.height*y);if(hit&&!p.contains(hit))obscured.push({x,y,element:hit.className});}
            const controlsVisible=!c||['.ck-ai-input-shell textarea','.ck-ai-send'].every(selector=>{
                const control=p.querySelector(selector);if(!control)return false;const box=control.getBoundingClientRect(),hit=document.elementFromPoint(box.left+box.width/2,box.top+box.height/2);
                return box.width>0&&box.height>0&&box.left>=Math.max(c.left,r.left)-1&&box.right<=Math.min(c.right,r.right)+1&&box.top>=Math.max(c.top,r.top)-1&&box.bottom<=Math.min(c.bottom,r.bottom,innerHeight)+1&&Boolean(hit&&(hit===control||control.contains(hit)));
            });
            return {width:innerWidth,height:innerHeight,pageOverflow:document.documentElement.scrollWidth>innerWidth,panelOverflow:p.scrollWidth>p.clientWidth+1,drawer:p.classList.contains('ck-ai-panel--drawer'),compact:p.classList.contains('ck-ai-panel--compact'),visible:r.right<=innerWidth+1&&r.left>=0,composerVisible:!c||c.bottom<=innerHeight+1,controlsVisible,composerObscured:obscured,headerHeight:h.height};
        })()`);
    } finally { if (width) await command('Emulation.clearDeviceMetricsOverride', {}); socket.close(); }
}
try {
    client = await connectDesktop();
    savedSettings = await client.evaluate(`localStorage.getItem('ck_ai_connection_v1')`);
    savedDark = await client.evaluate(`document.documentElement.classList.contains('dark')`);
    await client.evaluate(`(()=>{window.__aiTestIpc=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&['compile_sketch','compile_ai_candidate','cancel_foreground_build','create_project_checkpoint','save_project_as','save_project'].includes(command)){const row={command,args:JSON.parse(options.body)};window.__aiTestIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true})()`);
    const file = path.join(out, 'AI功能回归.ck');
    fs.writeFileSync(file, JSON.stringify({ format: 'ck-project', schema_version: 1, migration_version: 1, name: 'AI功能回归', board: 'arduino:avr:uno', board_package_id: 'arduino:avr:uno', options: '{}',
        xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_setup_custom', id: 'ai-setup', x: 50, y: 60 }, { type: 'controls_loop_custom', id: 'ai-loop', x: 50, y: 180 }] } }) }));
    if(controlsChecks) await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_save_preferences',{value:{baseUrl:'',model:'',apiKey:'',rememberKey:true,contextTokens:32768,responseTokens:8192,autoCompact:true}})`);
    await open(file, 'ai-loop');
    await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type==='control_delay')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'catalog and actual compile ready');
    await click('[data-ck-role="ai-assistant-trigger"]'); await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))`, 'AI panel');
    if (process.env.CK_AI_STYLE_FIXTURE) {
        const css = fs.readFileSync(process.env.CK_AI_STYLE_FIXTURE, 'utf8');
        await client.evaluate(`(()=>{const style=document.createElement('style');style.dataset.ckAiStyleTest='true';style.textContent=${JSON.stringify(css)};document.head.append(style);return true})()`);
    }
    await wait(`!document.querySelector('.ck-ai-disabled')`, 'AI ready for resolved board');
    await client.evaluate(`document.documentElement.classList.remove('dark')`);
    assert.equal(await client.evaluate(`document.querySelector('.ck-ai-feed').scrollTop`), 0);
    report.layout = {};
    report.layout.welcome = await picture('01-ai-welcome', 1366, 860);
    await wait(`document.querySelector('button[aria-label="模型连接设置"]')?.disabled===false`,'preferences loaded');
    await click('button[aria-label="模型连接设置"]');
    await fill('.ck-ai-settings input[type="url"]', `http://127.0.0.1:${port}/v1`);
    await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])', 'ck-local-fixture');
    await fill('.ck-ai-settings input[type="password"]', 'local-fixture-not-a-real-key');
    // Transport history preservation has a separate purpose from compaction.
    // Give its 44 paired tool replies room; the compaction case below uses 16k.
    await fill('input[aria-label="上下文预算"]', '65536');
    await fill('input[aria-label="单次回复预留"]', '4096');
    await button('保存连接设置');
    await wait(`!document.querySelector('.ck-ai-settings')`,'settings saved');
    const storage = await client.evaluate(`JSON.parse(localStorage.getItem('ck_ai_connection_v1'))`);
    assert.deepEqual(Object.keys(storage).sort(), ['baseUrl', 'model']);
    report.checks.push('Connection URL/model persisted; API key omitted from browser localStorage');
    if(productChecks){
        assert(fs.existsSync(preferencesPath));assert(!fs.readFileSync(preferencesPath,'utf8').includes('local-fixture-not-a-real-key'));
        assert.equal(await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_load_preferences').then(v=>v.apiKey==='local-fixture-not-a-real-key')`),true);
        report.checks.push('Real Windows DPAPI store retains the key globally while the preferences file has no plaintext credential');
    }
    if(controlsChecks){
        assert.equal(await client.evaluate(`document.querySelector('[aria-label="AI 修改模式"]').value`),'auto');
        assert.equal(await client.evaluate(`document.querySelector('.ck-ai-project-path span').title`),file);
        const original=await snapshot();
        await submit('自动模式：在循环添加500毫秒等待');await wait(`Boolean(document.querySelector('.ck-ai-undo'))&&!document.querySelector('[aria-label="停止 AI 请求"]')`,'automatic commit');
        assert.notEqual(await snapshot(),original);assert.equal(await client.evaluate(`Boolean(document.querySelector('.ck-ai-proposal'))`),false);
        assert.match(await client.evaluate(`document.querySelector('.ck-ai-feed').textContent`),/AI 已自动应用/);
        await button('撤销本次修改');await delay(200);assert.equal(await snapshot(),original);
        report.checks.push('Default automatic mode really applies a compiled candidate after checkpoint; recorded diff and undo restore the original workspace');
        // Stop during the asynchronous checkpoint must not apply the already-compiled candidate.
        await client.evaluate(`(()=>{window.__autoCheckpointHeld=false;window.__autoHold=true;const previous=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);const response=await previous(url,options);if(u.hostname==='ipc.localhost'&&decodeURIComponent(u.pathname.slice(1))==='create_project_checkpoint'&&window.__autoHold){window.__autoCheckpointHeld=true;await new Promise(r=>setTimeout(r,1800));}return response;};return true;})()`);
        await submit('再次添加等待，验证自动应用前取消');await wait('window.__autoCheckpointHeld','checkpoint in flight');await click('button[aria-label="停止 AI 请求"]');await wait(`!document.querySelector('[aria-label="停止 AI 请求"]')`,'checkpoint cancellation settled');assert.equal(await snapshot(),original);
        await client.evaluate('window.__autoHold=false');report.checks.push('Cancellation after candidate compile but before checkpoint reply leaves the original workspace unchanged');

        await click('button[aria-label="新对话"]');await delay(500);
        await click('button[aria-label="模型连接设置"]');await button('获取服务商模型列表');await wait(`document.querySelectorAll('[aria-label="服务商模型列表"] optgroup option').length===2`,'native model discovery');await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'settings saved');
        await select('[aria-label="当前 AI 模型"]','ck-vision-fixture');await select('[aria-label="思考强度"]','high');
        assert.equal(await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_load_preferences').then(v=>v.reasoningEffort)`),'high');
        await client.evaluate(`(async()=>{const canvas=document.createElement('canvas');canvas.width=160;canvas.height=80;const c=canvas.getContext('2d');c.fillStyle='#b84913';c.fillRect(0,0,160,80);c.fillStyle='white';c.font='20px sans-serif';c.fillText('GPIO 13',20,45);const blob=await new Promise(r=>canvas.toBlob(r,'image/png'));const dt=new DataTransfer();dt.items.add(new File(['ATTACHMENT_TEXT_MARKER: pin=13; interval=500'], '参数.txt',{type:'text/plain'}));dt.items.add(new File([blob],'接线.png',{type:'image/png'}));const e=document.querySelector('input[type=file][aria-label="选择 AI 附件"]');e.files=dt.files;e.dispatchEvent(new Event('change',{bubbles:true}));})()`);
        await wait(`document.querySelectorAll('.ck-ai-attachments>div').length===2`,'attachments imported');
        await picture('00-attachments-controls',1280,800);mode='attachments';await submit('根据上传的接线图和参数解释连接');await wait(`document.querySelector('.ck-ai-feed').textContent.includes('已收到图片和 UTF-8 参数附件')&&!document.querySelector('[aria-label="停止 AI 请求"]')`,'multimodal native request');
        assert.equal(await snapshot(),original);await wait(`document.querySelector('.ck-ai-context-details [role=status]').textContent==='已保存到本机'`,'attachments saved');
        const saved=await client.evaluate(`(async()=>{const projectKey=${JSON.stringify('file:'+file.replace(/\\/g,'/').toLowerCase())};const rows=await window.__TAURI_INTERNALS__.invoke('ai_list_chats',{projectKey});const chat=await window.__TAURI_INTERNALS__.invoke('ai_load_chat',{id:rows.chats[0].id,projectKey});return {id:chat.id,attachments:chat.messages.find(m=>m.attachments?.length)?.attachments.length}})()`);
        assert.equal(saved.attachments,2);const raw=fs.readFileSync(path.join(config.paths.sysroot,'state/ai-assistant-v1/chats',saved.id+'.json'),'utf8');assert(!raw.includes('ATTACHMENT_TEXT_MARKER'));assert(!raw.includes('data:image/'));
        report.checks.push('Provider model list, selectable high reasoning and image_url actually reach Rust HTTP; text is paginated by read_attachment; attachments survive encrypted chat roundtrip');
        await click('button[aria-label="新对话"]');await delay(500);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-attachments>div').length`),0);
        mode='generate';await select('[aria-label="当前 AI 模型"]','ck-local-fixture');await select('[aria-label="思考强度"]','auto');
    }
    // Existing proposal/stale/repair tests deliberately exercise manual mode.
    if(await client.evaluate(`Boolean(document.querySelector('[aria-label="AI 修改模式"]'))`))await select('[aria-label="AI 修改模式"]','manual');
    const before = await snapshot();
    await submit('在循环里新增等待 500 毫秒的积木。');
    await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`, 'real HTTP tool loop proposal');
    assert.equal(await snapshot(), before);
    await button('查看具体变化');
    report.layout.preview = await picture('02-ai-proposal', 1366, 860);
    report.checks.push('Rust SSE tool loop reads real catalog/schema and stages proposal without changing original');
    const candidate = await client.evaluate(`window.__aiTestIpc.find(r=>r.command==='compile_ai_candidate'&&r.done)`);
    assert(candidate && candidate.kind==='ok');const candidateResult=JSON.parse(JSON.parse(candidate.response));assert(candidateResult.ok&&candidateResult.artifactCount>0);
    assert.equal(await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_sketch').length`),0);
    report.checks.push('Candidate really compiled through a separate native IPC before preview; original workspace and normal compile state were untouched');

    await button('应用并编译');
    const compile = await wait(`window.__aiTestIpc.find(r=>r.command==='compile_sketch'&&r.done)`, 'real native compile', 240000);
    assert.equal(compile.kind, 'ok', compile.response); assert.match(compile.args.code, /delay\(500\)/);
    await wait(`document.querySelector('.ck-ai-notice')?.textContent.includes('本地编译通过')`, 'compile result in AI panel');
    const checkpoint = await client.evaluate(`window.__aiTestIpc.find(r=>r.command==='create_project_checkpoint')`);
    assert(checkpoint?.done && checkpoint.kind === 'ok', 'before-apply checkpoint succeeds');
    const compiled = JSON.parse(JSON.parse(compile.response));
    fs.writeFileSync(path.join(out, 'compile-response.json'), JSON.stringify(compiled, null, 2));
    report.compile = { fqbn: compile.args.fqbn, totalMs: compiled.diagnostics?.timing?.totalMs, artifacts: compiled.artifacts.map(file => {
        assert(fs.existsSync(file), `Missing actual compiler output: ${file}`);
        return { file, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') };
    }) };
    report.checks.push('Apply created native checkpoint and compiled current generated delay(500) on Uno');
    const applied = await snapshot(); assert.notEqual(applied, before);
    report.layout.applied = await picture('03-ai-applied', 1366, 860);
    await button('撤销本次修改'); await delay(300); assert.equal(await snapshot(), before);
    await client.evaluate(`${W}.undo(true)`); await delay(300); assert.equal(await snapshot(), applied);
    report.checks.push('Native Blockly undo/redo restores complete workspace after actual local compile'); save();

    mode = 'edit'; await submit('把等待改成750毫秒'); await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`, 'edit preview');
    await client.evaluate(`${W}.getAllBlocks(false).find(b=>b.type==='math_number').setFieldValue(800,'NUM')`); await delay(250);
    assert(await client.evaluate(`document.querySelector('.ck-ai-proposal-actions .ck-ai-primary').disabled`));
    assert.match(await client.evaluate(`document.querySelector('.ck-ai-stale').textContent`), /变化/);
    await button('放弃'); report.checks.push('Editing the workspace after preview disables application of stale changes');

    mode = 'error'; await submit('测试连接失败'); await wait(`document.querySelector('.ck-ai-error')?.textContent.includes('401')`, 'native HTTP error');
    assert.equal(await client.evaluate(`document.querySelector('.ck-ai-input-shell textarea').value`), '测试连接失败');
    report.checks.push('HTTP authentication error is visible and the input is retained for retry');
    mode = 'slow'; const oldCount = requestCount; await submit('测试取消');
    while (requestCount === oldCount) await delay(40);
    const cancelAt = Date.now(); await click('button[aria-label="停止 AI 请求"]');
    while (!canceledConnections && Date.now() - cancelAt < 3000) await delay(40);
    assert(canceledConnections > 0, 'Rust request without response headers must actually close');
    report.cancelMs = Date.now() - cancelAt;
    report.checks.push('Stop closes the pending Rust HTTP connection, including before response headers');

    await wait(`!document.querySelector('.ck-ai-current')`,'cancel cleanup finished');
    mode = 'explain'; await click('button[aria-label="新对话"]');
    await button('解释当前程序');
    await click('button[aria-label="发送需求"]');
    await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('🔧')`, 'split UTF-8 explanation');
    assert(!await client.evaluate(`document.body.textContent.includes('�')`));
    assert.equal(await client.evaluate(`document.querySelector('.ck-ai-intent').textContent`), '解释积木');
    await button('分析最新错误');
    assert.equal(await client.evaluate(`document.querySelector('.ck-ai-intent').textContent`), '修复报错');
    report.checks.push('Chinese/emoji survive split HTTP chunks; explanation switches cleanly to error analysis');

    await client.evaluate(`(()=>{const ctx=window.CK_NATIVE_REGRESSION.getCurrent();const entry=ctx.Blockly.ContextMenuRegistry.registry.getItem('ckAiExplainBlock');const scope={block:ctx.workspace.getBlockById('ai-loop')};if(entry.preconditionFn(scope)!=='enabled')throw Error('AI context entry disabled');entry.callback(scope);return true})()`);
    await wait(`document.querySelector('.ck-ai-intent')?.textContent==='解释积木 · 已选中积木'`, 'selected-block entry');
    report.checks.push('Registered Blockly context action opens explanation for the actual selected loop');

    const beforeFailureCount = await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_sketch').length`);
    await client.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent();const bad=c.Blockly.serialization.blocks.append({type:'math_compound_assign_custom',id:'ai-bad-statement',fields:{OP:'+='},inputs:{VAR:{block:{type:'math_number',id:'ai-bad-lvalue',fields:{NUM:1}}},VALUE:{shadow:{type:'math_number',fields:{NUM:0}}}}},c.workspace);const delayBlock=c.workspace.getAllBlocks(false).find(b=>b.type==='control_delay');delayBlock.nextConnection.connect(bad.previousConnection);return true})()`);
    await delay(200); await click('[data-ck-role="build-compile-action"]');
    const failed = await wait(`window.__aiTestIpc.filter(r=>r.command==='compile_sketch')[${beforeFailureCount}]?.done?window.__aiTestIpc.filter(r=>r.command==='compile_sketch')[${beforeFailureCount}]:null`, 'intentional real compile error', 180000);
    assert.equal(failed.kind, 'error'); assert.match(failed.response, /lvalue|left operand/i);
    await wait(`Boolean(document.querySelector('button[aria-label="让 AI 分析这条错误"]'))`, 'actual issue AI entry');
    mode = 'repair'; await click('button[aria-label="让 AI 分析这条错误"]'); await delay(150);
    assert.match(await client.evaluate(`document.querySelector('.ck-ai-intent').textContent`), /修复报错/);
    await click('button[aria-label="发送需求"]'); await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`, 'repair proposal');
    assert(await client.evaluate(`Boolean(${W}.getBlockById('ai-bad-lvalue'))`));
    await button('应用并编译');
    const repaired = await wait(`window.__aiTestIpc.filter(r=>r.command==='compile_sketch')[${beforeFailureCount + 1}]?.done?window.__aiTestIpc.filter(r=>r.command==='compile_sketch')[${beforeFailureCount + 1}]:null`, 'real repaired compilation', 180000);
    assert.equal(repaired.kind, 'ok', repaired.response);
    await wait(`document.querySelector('.ck-ai-notice')?.textContent.includes('本地编译通过')`, 'repair success notice');
    report.checks.push('Actual compiler lvalue failure opens AI from its error card; tools read the real diagnostic, user applies a minimal repair and native compilation succeeds');

    if(phase2Checks){
        const beforeCandidate=await snapshot();
        const lastCandidate=await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate').slice(-1)[0]`);
        const changedCore=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('compile_ai_candidate',${JSON.stringify({...lastCandidate.args,candidateId:randomUUID(),runId:randomUUID(),coreVersion:'0.0.0-must-not-match'})}).then(()=>({accepted:true}),e=>({accepted:false,error:String(e)}))`);
        assert.equal(changedCore.accepted,false);assert.match(changedCore.error,/Core/);
        assert.equal(await snapshot(),beforeCandidate);
        report.checks.push('Native candidate command rejects a changed Core version before compiling and leaves the original unchanged');
        mode='candidate-repair';await click('button[aria-label="新对话"]');await submit('隔离编译候选，使用实际报错修复，保留已有积木。');
        await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`,'candidate repair proposal');
        assert.equal(await snapshot(),beforeCandidate);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-validations details').length`),2);
        assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-validations .is-fail').length`),1);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-validations .is-pass').length`),1);
        report.layout.candidateRepair=await picture('07-candidate-repair',1366,860);
        await button('应用修改');await wait(`!document.querySelector('.ck-ai-proposal')&&Boolean(document.querySelector('.ck-ai-undo'))`,'candidate applied after checkpoint');assert.notEqual(await snapshot(),beforeCandidate);await button('撤销本次修改');await delay(200);assert.equal(await snapshot(),beforeCandidate);
        report.checks.push('Actual candidate lvalue compile fails with authenticated block mapping, repair compiles successfully, original stays unchanged until Apply and whole-change Undo restores it');
        mode='candidate-bounded';await click('button[aria-label="新对话"]');await submit('测试候选编译错误次数上限，原工程不得变化。');
        await wait(`!document.querySelector('.ck-ai-current')&&document.querySelectorAll('.ck-ai-validations .is-fail').length===3`,'bounded failed candidates');
        assert.equal(await snapshot(),beforeCandidate);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-proposal').length`),0);
        report.checks.push('Three real compiler failures are retained; the repair loop stops without an applicable preview or original mutation');
        mode='truncated';await click('button[aria-label="新对话"]');
        const beforeTruncationCompiles=await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate').length`);
        await submit('验证连续超长停止，原工程必须保留。');
        await wait(`!document.querySelector('.ck-ai-current')&&document.querySelector('.ck-ai-error')?.textContent.includes('连续三次回复超出长度')`,'repeated truncation stopped');
        assert.equal(requests.filter(r=>r.mode==='truncated').length,3);
        assert.equal(await snapshot(),beforeCandidate);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-proposal').length`),0);
        assert.equal(await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate').length`),beforeTruncationCompiles);
        report.checks.push('Three consecutive native SSE length responses stop further model calls without executing truncated tools, compiling, or modifying the original');
        mode='generate';await click('button[aria-label="新对话"]');
        const candidateCount=await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate').length`);
        await submit('候选编译取消检查');
        await wait(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate').length>${candidateCount}`,'candidate native request start');
        await click('button[aria-label="停止 AI 请求"]');
        await wait(`!document.querySelector('.ck-ai-current')&&document.querySelector('.ck-ai-notice')?.textContent.includes('已停止')`,'candidate cancellation drained');
        const canceled=await client.evaluate(`window.__aiTestIpc.filter(r=>r.command==='compile_ai_candidate')[${candidateCount}]`);
        assert(canceled.done);assert.equal(canceled.kind,'error');assert.match(canceled.response,/cancel/i);
        assert.equal(await snapshot(),beforeCandidate);assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-proposal').length`),0);
        report.checks.push('Stop waits for actual candidate native IPC completion and rejects canceled output without changing the project');
    }
    await client.evaluate(`document.documentElement.classList.add('dark')`);
    report.layout.dark = await picture('04-ai-dark', 1280, 800);
    report.layout.narrow = await picture('05-ai-narrow', 1024, 768);
    report.layout.minimum = await picture('06-ai-minimum', 900, 600);
    await client.evaluate(`document.documentElement.classList.remove('dark')`);
    for (const [name, row] of Object.entries(report.layout)) assert(!row.pageOverflow && !row.panelOverflow && row.visible && row.composerVisible && row.controlsVisible && !row.composerObscured.length, `${name} UI overflow or obstruction: ${JSON.stringify(row)}`);
    report.checks.push('Actual desktop light/dark layouts at 1366, 1280, 1024 and minimum 900x600 have no horizontal overflow or obscured composer');
    assert(!requests.some(r => JSON.stringify(r).includes('local-fixture-not-a-real-key')));
    report.checks.push('Model messages exclude connection credential; credentials only used by HTTP authorization');
    await client.input('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await client.input('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await delay(500);
    const otherFile = path.join(out, '另一个工程.ck'); const other = JSON.parse(fs.readFileSync(file));
    other.name = '另一个工程'; other.xml = JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_loop_custom', id: 'ai-other-loop', x: 60, y: 80 }] } });
    fs.writeFileSync(otherFile, JSON.stringify(other)); await open(otherFile, 'ai-other-loop');
    await delay(250);
    if (!await client.evaluate(`Boolean(document.querySelector('.ck-ai-panel'))`)) await click('[data-ck-role="ai-assistant-trigger"]');
    assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-message,.ck-ai-proposal').length`), 0);
    report.checks.push('Opening another saved project clears the previous AI conversation and proposals');
    mode='long-history';await click('button[aria-label="新对话"]');
    await submit('历史链路验证标记：请读取工作区并完成检查。');
    await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('完整历史链路验证完成')`,'complete tool history');
    assert(requests.filter(r=>r.mode==='long-history').some(r=>r.messages.length>40));
    report.checks.push('More than 40 messages retain original request and all paired tool calls/results');
    report.checks.push('Actual Rust SSE accepted explanation after 5000 fragmented events with UTF-8 intact');
    metadataProbe=await client.evaluate(`(()=>{const active=window.CK_BLOCK_CATALOG.blocks.filter(b=>window.CK_NATIVE_REGRESSION.getCurrent().Blockly.Blocks[b.type]);return active.find(b=>b.library_id&&b.semantics&&b.metadata_completeness?.includes('semantics'))||active.find(b=>b.semantics)||active[0]})()`);
    assert(metadataProbe,'Actual active catalog required');
    const metadataBefore=await snapshot();mode='library-metadata';await click('button[aria-label="新对话"]');
    await submit('读取当前库的功能、返回值、限制和示例，不修改工程。');
    await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('库能力、返回值与限制已按实际声明读取')`,'library capability docs');
    assert.equal(await snapshot(),metadataBefore,'Reading library docs cannot mutate the workspace');
    report.libraryMetadata={type:metadataProbe.type,libraryId:metadataProbe.library_id,metadataSource:metadataProbe.metadata_source,declaredSections:metadataProbe.metadata_completeness};
    report.checks.push('Actual desktop active catalog exposes library capability/schema/docs to native model tools, preserves units and provenance, and does not edit the project');
    if(productChecks) {
        await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='已保存到本机'`,'chat saved');
        const projectKey='file:'+otherFile.replaceAll('\\','/').toLowerCase();
        const initial=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_list_chats',{projectKey:${JSON.stringify(projectKey)}})`);
        assert(initial.chats.length>=1);
        const existingId=initial.chats[0].id;
        await click('button[aria-label="聊天记录"]');
        report.layout.history=await picture('07-ai-history',1024,768);
        await click('button[aria-label^="重命名 "]');await fill('input[aria-label="聊天名称"]','持久聊天回归');await button('保存');
        await wait(`document.querySelector('.ck-ai-chat-select strong')?.textContent==='持久聊天回归'`,'chat renamed');
        await button('新聊天');await fill('.ck-ai-input-shell textarea','尚未发送的草稿，重开后继续。');
        await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='已保存到本机'`,'draft saved');
        await click('button[aria-label="聊天记录"]');
        await wait(`document.querySelectorAll('.ck-ai-chat-select').length>=2`,'two saved chats');
        await client.evaluate(`(()=>{const b=[...document.querySelectorAll('.ck-ai-chat-select')].find(b=>b.textContent.includes('持久聊天回归'));b.click();return true})()`);
        await wait(`document.querySelector('.ck-ai-chat-caption')?.textContent==='持久聊天回归'`,'restored chat');
        await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='已保存到本机'`,'restored chat saved');
        assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-proposal').length`),0);
        report.checks.push('Desktop chat list creates, renames and switches saved conversations; old executable proposals are not restored');
        // Seed ordinary historical transcript data through the actual storage API,
        // then exercise real UI -> Rust transport -> summary model -> tool loop.
        const seed=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_load_chat',{id:${JSON.stringify(existingId)},projectKey:${JSON.stringify(projectKey)}})`);
        seed.messages=Array.from({length:30},(_,i)=>({id:'seed-'+i,role:i%2?'assistant':'user',text:'温度使用摄氏度；控制逻辑不得阻塞。'+'historical context '.repeat(200)+(i===29?'末条历史完整性标记_END':'')}));seed.memory=null;seed.draft='';
        await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_save_chat',{value:${JSON.stringify(seed)}})`);
        // Reload the actual WebView: all in-memory connections, previews and chat
        // state are discarded, then loaded from the native persisted records.
        await client.evaluate(`(()=>{setTimeout(()=>location.reload(),0);return true})()`);await delay(1500);await open(otherFile,'ai-other-loop');
        await wait(`Boolean(document.querySelector('[data-ck-role="ai-assistant-trigger"]'))`,'workspace after reload');
        if(!await client.evaluate(`Boolean(document.querySelector('.ck-ai-panel'))`))await click('[data-ck-role="ai-assistant-trigger"]');
        await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='已保存到本机'`,'chat after reload');
        await click('button[aria-label="模型连接设置"]');
        await wait(`document.querySelector('.ck-ai-settings input[type="password"]')?.value==='local-fixture-not-a-real-key'`,'key restored after reload');
        await fill('input[aria-label="上下文预算"]','16384');await fill('input[aria-label="单次回复预留"]','2048');
        report.layout.settings=await picture('08-ai-settings',900,600);
        await button('保存连接设置');await wait(`!document.querySelector('.ck-ai-settings')`,'context settings saved');
        await click('button[aria-label="聊天记录"]');
        await wait(`Boolean([...document.querySelectorAll('.ck-ai-chat-select')].find(b=>b.textContent.includes('持久聊天回归')))`,'history after reload');
        await client.evaluate(`(()=>{[...document.querySelectorAll('.ck-ai-chat-select')].find(b=>b.textContent.includes('持久聊天回归')).click();return true})()`);
        await wait(`document.querySelectorAll('.ck-ai-message').length===30`,'seeded history visible');
        await wait(`!document.querySelector('.ck-ai-disabled')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'board parameters ready after WebView reload');
        mode='context-compression';const compactBefore=await snapshot();await submit('继续检查我们的长期目标，只解释，不修改。');
        await wait(`document.querySelector('.ck-ai-message--assistant:last-of-type')?.textContent.includes('已读取压缩后的目标')`,'automatic compaction',90000);
        assert.equal(await snapshot(),compactBefore);assert(await client.evaluate(`Boolean(document.querySelector('.ck-ai-memory'))`));
        await wait(`document.querySelector('.ck-ai-context-details [role=status]')?.textContent==='已保存到本机'`,'compaction saved');
        const saved=await client.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_load_chat',{id:${JSON.stringify(existingId)},projectKey:${JSON.stringify(projectKey)}})`);
        assert.equal(saved.messages.length,32);assert(saved.memory.summary.includes('摄氏度'));
        assert(requests.some(r=>r.mode==='context-compression'&&(!r.tools||!r.tools.length)));
        report.layout.compression=await picture('09-ai-compression',1024,768);
        report.checks.push('Reload restores global key and chat from native files; configured 16k context triggers a real summary call, preserving all 32 local messages and the unchanged project');
        await click('button[aria-label="聊天记录"]');
        await wait(`document.querySelectorAll('.ck-ai-chat-select').length>=2`,'draft chat exists');
        await client.evaluate(`(()=>{[...document.querySelectorAll('.ck-ai-chat-select')].find(b=>b.textContent.includes('新聊天')).click();return true})()`);
        await wait(`document.querySelector('.ck-ai-input-shell textarea')?.value==='尚未发送的草稿，重开后继续。'`,'draft restored');
        await wait(`document.querySelector('button[aria-label="聊天记录"]')?.disabled===false`,'chat switching finished');
        await click('button[aria-label="聊天记录"]');await click('button[aria-label="删除 新聊天"]');await button('确认删除');
        await wait(`![...document.querySelectorAll('.ck-ai-chat-select')].some(b=>b.textContent.includes('新聊天'))`,'chat deleted');
        report.checks.push('Unsent draft survives reload and switching; explicit deletion removes only the selected chat');
        fs.writeFileSync(path.join(config.paths.evidenceRoot,'ai-restart-fixture.json'),JSON.stringify({projectFile:otherFile,projectKey,chatId:existingId,desktopReport:path.join(out,'report.json'),firstPid:process.env.CK_V9_DESKTOP_PID},null,2));
        for(const [name,row] of Object.entries(report.layout))assert(!row.pageOverflow&&!row.panelOverflow&&row.visible&&row.composerVisible&&row.controlsVisible&&!row.composerObscured.length,`${name} layout failure`);
    }
    if(process.env.CK_AI_METADATA_MATRIX==='1') {
        report.libraryMetadataMatrix=[];
        for(const [board,libraryId] of [['arduino:avr:nano','arduino_sht20'],['esp32:esp32:esp32c6','ck_example_i2c_sensor_v2']]) {
            const projectFile=path.join(out,libraryId+'.ck'),rootId=libraryId+'-loop';
            fs.writeFileSync(projectFile,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'库能力验证 '+libraryId,board,board_package_id:board,options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:rootId,x:60,y:80}]}})}));
            await open(projectFile,rootId);
            await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.library_id===${JSON.stringify(libraryId)}&&window.CK_NATIVE_REGRESSION.getCurrent().Blockly.Blocks[b.type])&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'installed library catalog '+libraryId);
            if(!await client.evaluate(`Boolean(document.querySelector('.ck-ai-panel'))`))await click('[data-ck-role="ai-assistant-trigger"]');
            metadataProbe=await client.evaluate(`window.CK_BLOCK_CATALOG.blocks.find(b=>b.library_id===${JSON.stringify(libraryId)}&&window.CK_NATIVE_REGRESSION.getCurrent().Blockly.Blocks[b.type])`);
            const beforeDocs=await snapshot();mode='library-metadata';await click('button[aria-label="新对话"]');
            await submit('请读取当前传感器库声明的功能、返回值、限制和示例，不修改工程。');
            await wait(`document.querySelector('.ck-ai-message--assistant')?.textContent.includes('库能力、返回值与限制已按实际声明读取')`,'installed library docs '+libraryId);
            assert.equal(await snapshot(),beforeDocs);
            report.libraryMetadataMatrix.push({board,libraryId,type:metadataProbe.type,metadataSource:metadataProbe.metadata_source,declaredSections:metadataProbe.metadata_completeness,output:metadataProbe.output_contract});
            report.checks.push('Installed '+libraryId+' library metadata reaches the native AI tool loop on '+board+' without project edits');
        }
    }
    report.status = 'PASS';
} catch (error) {
    report.status = 'FAIL'; report.error = String(error.stack); console.error(error);
    if (client) { try { report.lastUi = await client.evaluate(`document.body.innerText.slice(-16000)`); await picture('failure'); } catch {} }
    process.exitCode = 1;
} finally {
    if (client && savedSettings !== undefined) { try { await client.evaluate(savedSettings === null ? `localStorage.removeItem('ck_ai_connection_v1')` : `localStorage.setItem('ck_ai_connection_v1',${JSON.stringify(savedSettings)})`); } catch {} }
    if (client && savedDark !== undefined) { try { await client.evaluate(`document.documentElement.classList.toggle('dark',${savedDark})`); } catch {} }
    if(productChecks&&process.env.CK_AI_KEEP_PREFERENCES!=='1'){if(savedPreferences)fs.writeFileSync(preferencesPath,savedPreferences);else if(fs.existsSync(preferencesPath))fs.unlinkSync(preferencesPath);}
    save(); fs.writeFileSync(path.join(out, 'model-requests.json'), JSON.stringify(requests, null, 2));
    client?.close(); server.closeAllConnections(); server.close(); console.log(`REPORT ${out}`);
}
