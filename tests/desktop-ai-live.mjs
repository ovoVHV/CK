// Explicit opt-in live-provider qualification. Never contains or writes a credential.
// Run through Start-Preview.ps1 with CK_AI_LIVE_KEY in the harness environment.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { createHash, randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const key = process.env.CK_AI_LIVE_KEY;
delete process.env.CK_AI_LIVE_KEY;
assert(key, 'Explicit live-provider test key required');
const baseUrl = process.env.CK_AI_LIVE_URL || 'https://api.deepseek.com';
const model = process.env.CK_AI_LIVE_MODEL || 'deepseek-flash';
const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, `ai-live-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', provider: baseUrl, model, checks: [], tasks: [], hardwareUploaded: false };
report.desktopSha256 = JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot, 'desktop-launch.json'), 'utf8').replace(/^\uFEFF/, '')).sha256;
const clean = value => String(value).split(key).join('[REDACTED]');
const write = (name, value) => fs.writeFileSync(path.join(out, name), clean(JSON.stringify(value, null, 2)));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
const W = 'window.CK_NATIVE_REGRESSION.getCurrent().workspace';
const B = 'window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
let client, savedSettings;
async function wait(expression, label, timeout = 180000) {
    const started = Date.now();
    while (Date.now() - started < timeout) {
        const value = await client.evaluate(expression); if (value) return value;
        const error = await client.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);
        if (error) throw Error(`${label}: ${clean(error)}`);
        if (label.endsWith(' proposal') && Date.now() - started > 1500 && await client.evaluate(`!document.querySelector('.ck-ai-current')&&Boolean(document.querySelector('.ck-ai-message--assistant'))`)) {
            throw Error(`${label}: model returned a response without a validated proposal`);
        }
        await delay(200);
    }
    throw Error(`Timed out: ${label}`);
}
const click = selector => client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');e.click();return true})()`);
const button = text => client.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-ck-role="ai-assistant"] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Unavailable button');e.click();return true})()`);
const fill = (selector, value) => client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e)throw Error('Missing input');Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
const snapshot = () => client.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);
async function open(file, blockId) {
    const payload = { requestId: randomUUID(), path: file, source: 'ai-live-qualification' };
    for (let i = 0; i < 240; i++) {
        if (await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(blockId)})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`)) return;
        if (i % 8 === 0) await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(payload)}})`);
        await delay(250);
    }
    throw Error('Project open timed out');
}
async function picture(name) {
    const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(x => x.url === 'http://tauri.localhost/');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
    try {
        const result = await new Promise((resolve, reject) => {
            socket.onmessage = e => { const row = JSON.parse(e.data); if (row.id === 1) row.error ? reject(Error('Screenshot failed')) : resolve(row.result); };
            socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
        });
        fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
    } finally { socket.close(); }
}
async function proposal(prompt, taskName) {
    const before = await snapshot(); const started = Date.now();
    const previous = await client.evaluate(`window.__aiLiveModel.length`);
    await fill('.ck-ai-input-shell textarea', prompt); await delay(120);
    await click('button[aria-label="发送需求"]');
    await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`, taskName + ' proposal', 240000);
    assert.equal(await snapshot(), before, 'A live model proposal must not mutate the original');
    const task = { name: taskName, prompt, modelWallMs: Date.now() - started,
        summary: await client.evaluate(`document.querySelector('.ck-ai-feed').innerText`),
        requests: await client.evaluate(`window.__aiLiveModel.slice(${previous})`) };
    report.tasks.push(task); write('report.json', report);
    return task;
}
async function applyCompile(task, requiredCode) {
    const index = await client.evaluate(`window.__aiLiveIpc.filter(r=>r.command==='compile_sketch').length`);
    await button('应用并编译');
    const row = await wait(`window.__aiLiveIpc.filter(r=>r.command==='compile_sketch')[${index}]?.done?window.__aiLiveIpc.filter(r=>r.command==='compile_sketch')[${index}]:null`, 'actual compiler result', 240000);
    assert.equal(row.kind, 'ok', clean(row.response));
    for (const pattern of requiredCode) assert.match(row.args.code, pattern);
    await wait(`document.querySelector('.ck-ai-notice')?.textContent.includes('本地编译通过')`, 'compile result notice');
    const result = JSON.parse(JSON.parse(row.response));
    task.compile = { fqbn: row.args.fqbn, code: row.args.code, totalMs: result.diagnostics?.timing?.totalMs,
        artifacts: result.artifacts.map(file => ({ file, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') })) };
    const checkpoints = await client.evaluate(`window.__aiLiveIpc.filter(r=>r.command==='create_project_checkpoint')`);
    assert(checkpoints.length && checkpoints.every(r => r.done && r.kind === 'ok'), 'Native checkpoints must succeed');
    write('report.json', report);
}
try {
    client = await connectDesktop();
    savedSettings = await client.evaluate(`localStorage.getItem('ck_ai_connection_v1')`);
    // Observe actual IPC results. Never retain apiKey or the complete model request.
    await client.evaluate(`(()=>{window.__aiLiveIpc=[];window.__aiLiveModel=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname!=='ipc.localhost')return original(url,options);if(command==='chat_with_glm_stream'){const req=JSON.parse(options.body).req;const row={model:req.model,url:req.baseUrl,historyRoles:req.historyMessages?.map(m=>m.role)};window.__aiLiveModel.push(row);const response=await original(url,options);const result=await response.clone().json();row.kind=response.headers.get('Tauri-Response');if(row.kind==='ok'){row.finishReason=result.finishReason;row.content=result.content;row.toolCalls=result.toolCalls;row.tokens=result.totalTokens;}else row.error=String(result);return response;}if(['compile_sketch','create_project_checkpoint'].includes(command)){const row={command,args:JSON.parse(options.body)};window.__aiLiveIpc.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true})()`);
    const file = path.join(out, 'DeepSeek真实生成.ck');
    fs.writeFileSync(file, JSON.stringify({ format: 'ck-project', schema_version: 1, migration_version: 1, name: 'DeepSeek真实生成', board: 'arduino:avr:uno', board_package_id: 'arduino:avr:uno', options: '{}',
        xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_setup_custom', id: 'ai-live-setup', x: 50, y: 60 }, { type: 'controls_loop_custom', id: 'ai-live-loop', x: 50, y: 180 }] } }) }));
    await open(file, 'ai-live-loop');
    await wait(`window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type==='control_delay')&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'catalog and compiler ready');
    await click('[data-ck-role="ai-assistant-trigger"]');
    await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`, 'AI ready');
    await click('button[aria-label="模型连接设置"]');
    await fill('.ck-ai-settings input[type="url"]', baseUrl);
    await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])', model);
    await fill('.ck-ai-settings input[type="password"]', key);
    await button('保存连接设置');
    const stored = await client.evaluate(`JSON.parse(localStorage.getItem('ck_ai_connection_v1'))`);
    assert.deepEqual(Object.keys(stored).sort(), ['baseUrl', 'model']);
    report.checks.push('Real provider URL/model and session-only credential configured through the actual settings UI');
    const generated = await proposal('Arduino Uno 的板载 LED 是 D13。请生成可编辑积木：初始化 D13 为输出，循环里点亮、等待500毫秒、熄灭、再等待500毫秒。保留现有初始化和循环容器。', 'generate-led');
    await button('查看具体变化'); await picture('01-live-proposal');
    await applyCompile(generated, [/pinMode\(\s*13\s*,\s*OUTPUT\s*\)/, /digitalWrite\(\s*13\s*,\s*HIGH\s*\)/, /digitalWrite\(\s*13\s*,\s*LOW\s*\)/, /delay\(500\)/]);
    await picture('02-live-compiled');
    report.checks.push('Live DeepSeek generated editable pin-mode, digital-output and delay blocks; user-confirmed proposal created a checkpoint and compiled to real Uno artifacts');
    await client.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent();const block=c.workspace.getAllBlocks(false).find(b=>b.type==='control_delay');if(!block)throw Error('Generated delay block missing');const action=c.Blockly.ContextMenuRegistry.registry.getItem('ckAiEditBlock');action.callback({block});return true})()`);
    await wait(`document.querySelector('.ck-ai-intent')?.textContent==='修改积木 · 已选中积木'`, 'selected-block mode');
    const edited = await proposal('只将选中的这个等待积木改为200毫秒，其他等待和引脚输出保持原样。', 'edit-selected-delay');
    await applyCompile(edited, [/delay\(200\)/, /delay\(500\)/]);
    report.checks.push('Live model edited only the selected delay; remaining delay stayed at 500 ms and actual native compilation passed');
    const compiledBeforeError = await client.evaluate(`window.__aiLiveIpc.filter(r=>r.command==='compile_sketch').length`);
    await client.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent();const bad=c.Blockly.serialization.blocks.append({type:'math_compound_assign_custom',id:'ai-live-invalid',fields:{OP:'+='},inputs:{VAR:{block:{type:'math_number',id:'ai-live-constant-lvalue',fields:{NUM:1}}},VALUE:{shadow:{type:'math_number',fields:{NUM:0}}}}},c.workspace);let end=c.workspace.getBlockById('ai-live-loop').getInputTargetBlock('DO');while(end.getNextBlock())end=end.getNextBlock();end.nextConnection.connect(bad.previousConnection);return true})()`);
    await delay(250); await click('[data-ck-role="build-compile-action"]');
    const failed = await wait(`window.__aiLiveIpc.filter(r=>r.command==='compile_sketch')[${compiledBeforeError}]?.done?window.__aiLiveIpc.filter(r=>r.command==='compile_sketch')[${compiledBeforeError}]:null`, 'intentional compiler failure');
    assert.equal(failed.kind, 'error'); assert.match(failed.response, /lvalue|left operand/i);
    write('intentional-compile-error.json', failed);
    await wait(`Boolean(document.querySelector('button[aria-label="让 AI 分析这条错误"]'))`, 'AI diagnostic entry');
    await click('button[aria-label="让 AI 分析这条错误"]'); await delay(150);
    const repaired = await proposal('请读取真实编译错误，解释原因。刚刚误加了“1 += 0”的无用语句，请删除这个错误语句，保留所有闪灯和等待积木，提交最小修改。', 'repair-compiler-error');
    assert(repaired.requests.flatMap(r=>r.toolCalls||[]).some(c=>c.function.name==='read_diagnostics'), 'Live model must actually read compiler diagnostics');
    await applyCompile(repaired, [/delay\(200\)/, /delay\(500\)/, /digitalWrite/]);
    await picture('03-live-repaired');
    report.checks.push('Live model read an actual compiler error, proposed a local repair and the user-confirmed program compiled successfully');
    write('final-workspace.json', JSON.parse(await snapshot()));
    assert(!await client.evaluate(`JSON.stringify(localStorage).includes(${JSON.stringify(key)})`), 'Credential persisted unexpectedly');
    report.checks.push('No credential persisted in desktop localStorage or qualification artifacts');
    report.status = 'PASS';
} catch (error) {
    report.status = 'FAIL'; report.error = clean(error.stack); console.error(clean(error.stack)); process.exitCode = 1;
    if (client) try { report.lastUi = clean(await client.evaluate(`document.body.innerText.slice(-12000)`)); await picture('failure'); } catch {}
} finally {
    if (client) {
        try { report.modelRequests = await client.evaluate(`window.__aiLiveModel`); } catch {}
        if (savedSettings !== undefined) try { await client.evaluate(savedSettings === null ? `localStorage.removeItem('ck_ai_connection_v1')` : `localStorage.setItem('ck_ai_connection_v1',${JSON.stringify(savedSettings)})`); } catch {}
        client.close();
    }
    write('report.json', report); console.log(`REPORT ${out}`);
}
