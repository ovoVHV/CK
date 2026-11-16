// Live difficulty audit of the shipped EXE. No model responses or generated code are replaced.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID, createHash } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
import { complexCases, stagedControllerCases } from './ai-complex-cases.mjs';

const key = process.env.CK_AI_LIVE_KEY; delete process.env.CK_AI_LIVE_KEY;
assert(key, 'Explicit live-provider test key required');
const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const phase2 = process.env.CK_AI_PHASE2_CHECKS === '1';
const out = path.join(config.paths.evidenceRoot, `ai-complex-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const clean = text => String(text).split(key).join('[REDACTED]');
const write = (name, value) => fs.writeFileSync(path.join(out, name), clean(JSON.stringify(value, null, 2)));
const report = { status: 'RUNNING', model: process.env.CK_AI_LIVE_MODEL || 'deepseek-flash',
  desktopSha256: JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot, 'desktop-launch.json'), 'utf8').replace(/^\uFEFF/, '')).sha256,
  executableModified: false, hardwareUploaded: false, results: [] };
report.workflow = phase2 ? 'single request, candidate compile/repair, explicit application, independent normal compile' : process.env.CK_AI_COMPLEX_TASKS ? 'explicit follow-up with independent verification feedback' : process.env.CK_AI_COMPLEX_STAGED ? 'three explicit user requests' : 'single request per complete project';
const delay = ms => new Promise(r => setTimeout(r, ms));
const W = 'window.CK_NATIVE_REGRESSION.getCurrent().workspace';
const B = 'window.CK_NATIVE_REGRESSION.getCurrent().Blockly';
let c, oldSettings;
async function wait(expression, label, timeout = 180000) {
  const at = Date.now();
  let settledWithoutProposal = 0;
  while (Date.now() - at < timeout) {
    const value = await c.evaluate(expression); if (value) return value;
    if (label === 'proposal') {
      const error = await c.evaluate(`document.querySelector('.ck-ai-error')?.textContent`);
      if (error) throw Error(clean(error));
      // React can commit the completed message between two CDP evaluations.
      // Require a stable completed state, and inspect proposal/busy together.
      if (await c.evaluate(`!document.querySelector('.ck-ai-current')&&!document.querySelector('.ck-ai-proposal')&&Boolean(document.querySelector('.ck-ai-message--assistant'))`)) {
        settledWithoutProposal ||= Date.now();
        if (Date.now() - settledWithoutProposal > 1200) throw Error('Model finished without a valid proposal');
      } else settledWithoutProposal = 0;
    }
    await delay(200);
  }
  throw Error('Timed out: ' + label);
}
const click = selector => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});if(!e||e.disabled)throw Error('Unavailable control');e.click();return true})()`);
const button = text => c.evaluate(`(()=>{const e=[...document.querySelectorAll('[data-ck-role="ai-assistant"] button')].find(e=>e.textContent.trim()===${JSON.stringify(text)});if(!e||e.disabled)throw Error('Unavailable button');e.click();return true})()`);
const fill = (selector, value) => c.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(selector)});Object.getOwnPropertyDescriptor(e.tagName==='TEXTAREA'?HTMLTextAreaElement.prototype:HTMLInputElement.prototype,'value').set.call(e,${JSON.stringify(value)});e.dispatchEvent(new Event('input',{bubbles:true}));return true})()`);
const snapshot = () => c.evaluate(`JSON.stringify(${B}.serialization.workspaces.save(${W}))`);
async function open(file, id) {
  const payload = { requestId: randomUUID(), path: file, source: 'ai-complex-audit' };
  for (let i = 0; i < 240; i++) {
    if (await c.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(id)})&&!document.querySelector('[data-ck-role="project-load-progress"]'))`)) return;
    if (i % 8 === 0) await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(payload)}})`);
    await delay(250);
  }
  throw Error('Project did not open');
}
async function picture(name) {
  const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(x => x.url === 'http://tauri.localhost/');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  await new Promise((resolve, reject) => { socket.onopen = resolve; socket.onerror = reject; });
  try {
    const result = await new Promise((resolve, reject) => { socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) m.error ? reject(Error('Screenshot failed')) : resolve(m.result); }; socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } })); });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(result.data, 'base64'));
  } finally { socket.close(); }
}
try {
  c = await connectDesktop(); const evaluate=c.evaluate.bind(c); c.evaluate=async expression=>{let timer;try{return await Promise.race([evaluate(expression),new Promise((_,reject)=>{timer=setTimeout(()=>reject(Error('Desktop disconnected or response timed out')),30000);})]);}finally{clearTimeout(timer);}}; oldSettings = await c.evaluate(`localStorage.getItem('ck_ai_connection_v1')`);
  await c.evaluate(`(()=>{window.__complexRequests=[];window.__complexCompiles=[];window.__candidateCompiles=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));if(u.hostname!=='ipc.localhost')return original(url,options);if(cmd==='chat_with_glm_stream'){const req=JSON.parse(options.body).req;const row={model:req.model,startedAt:Date.now(),toolResults:req.historyMessages?.filter(m=>m.role==='tool')};window.__complexRequests.push(row);const response=await original(url,options);const result=await response.clone().json();row.wallMs=Date.now()-row.startedAt;row.kind=response.headers.get('Tauri-Response');if(row.kind==='ok'){row.finish=result.finishReason;row.content=result.content;row.toolCalls=result.toolCalls;row.tokens=result.totalTokens;row.promptTokens=result.promptTokens;row.completionTokens=result.completionTokens;}else row.error=String(result);return response;}if(cmd==='compile_sketch'||cmd==='compile_ai_candidate'){const row={args:JSON.parse(options.body)};(cmd==='compile_ai_candidate'?window.__candidateCompiles:window.__complexCompiles).push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options)};return true})()`);
  let configured = false;
  const tasks = process.env.CK_AI_COMPLEX_TASKS ? JSON.parse(fs.readFileSync(process.env.CK_AI_COMPLEX_TASKS,'utf8').replace(/^\uFEFF/,'')) : process.env.CK_AI_COMPLEX_STAGED ? stagedControllerCases : complexCases;
  for (const task of tasks.filter(t => !process.env.CK_AI_COMPLEX_CASE || t.id === process.env.CK_AI_COMPLEX_CASE)) {
    const row = { ...task, generation: 'NOT_RUN', compile: 'NOT_RUN', behavior: 'NOT_RUN' };
    report.results.push(row); write('report.json', report);
    const projectId = task.projectId || task.id;
    const file = path.join(out, projectId + '.ck');
    const continuing = task.projectId && fs.existsSync(file);
    const setupId = projectId + '-setup', loopId = projectId + '-loop';
    const project = { format: 'ck-project', schema_version: 1, migration_version: 1, name: task.title, board: task.board || 'arduino:avr:uno', board_package_id: task.board || 'arduino:avr:uno', options: JSON.stringify(task.options || {}), xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_setup_custom', id: setupId, x: 50, y: 60 }, { type: 'controls_loop_custom', id: loopId, x: 50, y: 180 }] } }) };
    if (!continuing) { if(task.sourceProject)fs.copyFileSync(task.sourceProject,file);else fs.writeFileSync(file, JSON.stringify(project)); await open(file, loopId); }
    await wait(`window.CK_BLOCK_CATALOG?.blocks.length>0&&document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'board ready');
    if (!await c.evaluate(`Boolean(document.querySelector('.ck-ai-panel'))`)) await click('[data-ck-role="ai-assistant-trigger"]');
    await wait(`Boolean(document.querySelector('.ck-ai-input-shell textarea'))&&!document.querySelector('.ck-ai-disabled')`, 'AI ready');
    if (!configured) {
      await click('button[aria-label="模型连接设置"]');
      await fill('.ck-ai-settings input[type="url"]', 'https://api.deepseek.com');
      await fill('.ck-ai-settings input:not([type="url"]):not([type="password"])', report.model);
      await fill('.ck-ai-settings input[type="password"]', key);
      if(process.env.CK_AI_CONTEXT_TOKENS)await fill('input[aria-label="上下文预算"]',String(Number(process.env.CK_AI_CONTEXT_TOKENS)));
      report.contextSettings=await c.evaluate(`({contextTokens:Number(document.querySelector('input[aria-label="上下文预算"]').value),responseTokens:Number(document.querySelector('input[aria-label="单次回复预留"]').value)})`);
      await button('保存连接设置'); await wait(`!document.querySelector('.ck-ai-settings')&&Boolean(document.querySelector('.ck-ai-input-shell textarea'))`,'settings saved'); configured = true;
    } else { await click('button[aria-label="新对话"]'); await wait(`document.querySelectorAll('.ck-ai-message').length===0&&Boolean(document.querySelector('.ck-ai-input-shell textarea'))`,'new chat ready'); }
    const before = await snapshot(); const requestIndex = await c.evaluate(`window.__complexRequests.length`); const started = Date.now(); const candidateIndex = await c.evaluate('window.__candidateCompiles.length');
    try {
      await fill('.ck-ai-input-shell textarea', task.prompt); await delay(150); await click('button[aria-label="发送需求"]');
      await wait(`Boolean(document.querySelector('.ck-ai-proposal'))`, 'proposal', 780000);
      row.generation = 'PASS'; row.modelWallMs = Date.now() - started;
      assert.equal(await snapshot(), before, 'Preview mutated original'); row.previewPreservedOriginal = true;
      await button('查看具体变化'); await picture(task.id + '-preview');
      row.preview = await c.evaluate(`document.querySelector('.ck-ai-proposal').innerText`);
      let compile;
      if(phase2){
        const candidates=await c.evaluate(`window.__candidateCompiles.slice(${candidateIndex})`);
        assert(candidates.length>0);compile=candidates.at(-1);assert(compile.done && compile.kind==='ok');
        const value=JSON.parse(JSON.parse(compile.response));assert(value.ok&&value.artifactCount>0);
        row.candidateAttempts=candidates.map(r=>({kind:r.kind,...JSON.parse(JSON.parse(r.response))}));
        row.firstPass=row.candidateAttempts.length===1;row.repairedSuccess=!row.firstPass;
        const verifiedCandidate=compile;
        const compileIndex=await c.evaluate('window.__complexCompiles.length');
        await button('应用并编译');
        compile=await wait(`window.__complexCompiles[${compileIndex}]?.done?window.__complexCompiles[${compileIndex}]:null`,'materialized project compile',240000);
        assert.equal(compile.args.code,verifiedCandidate.args.code,'Applied workspace must generate the same candidate source');row.appliedCodeMatchesCandidate=true;
      }else{
        const compileIndex = await c.evaluate(`window.__complexCompiles.length`);
        await button('应用并编译');
        compile = await wait(`window.__complexCompiles[${compileIndex}]?.done?window.__complexCompiles[${compileIndex}]:null`, 'compiler result', 180000);
      }
      row.compile = compile.kind === 'ok' ? 'PASS' : 'FAIL';
      write(task.id + '-compile.json', compile);
      fs.writeFileSync(path.join(out, task.id + '.ino'), clean(compile.args.code));
      row.generatedCode = task.id + '.ino';
      row.snapshot = JSON.parse(await snapshot()); write(task.id + '-workspace.json', row.snapshot);
      const blocks = await c.evaluate(`${W}.getAllBlocks(false).map(b=>({id:b.id,type:b.type}))`);
      row.blocks = blocks.length; row.blockTypes = [...new Set(blocks.map(b => b.type))];
      row.rawCodeBlocks = row.blockTypes.filter(type => /raw|custom_code|code_insert|code_statement|code_expression/i.test(type));
      row.hasBlockingDelay = /\bdelay\s*\(/.test(compile.args.code);
      const readableCode=compile.args.code.replace(/\/\* @ck(?:-source-(?:begin|end))?:v1:[a-f0-9]+ \*\//g,'');
      row.staticRequirementChecks={editableBlocks:row.rawCodeBlocks.length===0,noBlockingDelay:!row.hasBlockingDelay,
        ...(task.prompt.includes('115200')?{serial115200:/Serial\.begin\s*\(\s*115200\s*\)/.test(readableCode)}:{}),
        nonemptyLoop:!(/void\s+loop\s*\(\s*\)\s*\{\s*\}/.test(readableCode))};
      row.staticRequirements=Object.values(row.staticRequirementChecks).every(Boolean)?'PASS':'FAIL';
      row.behavior='NOT_VERIFIED_BY_COMPILATION';
      row.mainContainersPreserved = await c.evaluate(`Boolean(${W}.getBlockById(${JSON.stringify(setupId)})&&${W}.getBlockById(${JSON.stringify(loopId)}))`);
      if (compile.kind === 'ok') {
        const result = JSON.parse(JSON.parse(compile.response));
        row.compileMs = result.diagnostics?.timing?.totalMs;
        row.artifactCount=result.artifactCount;row.artifacts = (result.artifacts||[]).map(file => ({ file, bytes: fs.statSync(file).size, sha256: createHash('sha256').update(fs.readFileSync(file)).digest('hex') }));
      } else row.compileError = clean(compile.response);
      await picture(task.id + '-result');
      // Save the real returned workspace for handoff, and clear dirty state before opening the next case.
      await c.input('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
      await c.input('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 }); await delay(700);
    } catch (error) {
      if (row.generation === 'NOT_RUN') row.generation = 'FAIL';
      row.error = clean(error.stack); row.modelWallMs ??= Date.now() - started;
      row.unchangedOnFailure = await snapshot() === before;
      if (await c.evaluate(`Boolean(document.querySelector('button[aria-label="停止 AI 请求"]:not(:disabled)'))`)) await click('button[aria-label="停止 AI 请求"]');
      await wait(`!document.querySelector('.ck-ai-current')`,'stopped after failure',240000);
      await picture(task.id + '-failure');
    } finally {
      row.allCandidateIpc=await c.evaluate(`window.__candidateCompiles.slice(${candidateIndex})`).catch(()=>[]);
      row.requests = await c.evaluate(`window.__complexRequests.slice(${requestIndex})`).catch(()=>[]);
      row.totalTokens=row.requests.some(r=>r.tokens!=null)?row.requests.reduce((sum,r)=>sum+(r.tokens||0),0):null;
      row.finalUi = clean(await c.evaluate(`document.querySelector('.ck-ai-feed')?.innerText`).catch(()=>''));
      write('report.json', report); console.log(JSON.stringify({case:task.id,generation:row.generation,compile:row.compile,error:row.error,requests:row.requests.length}));
    }
    if (task.projectId && (row.generation !== 'PASS' || row.compile !== 'PASS')) { report.stoppedAfterFailedStage = task.id; break; }
  }
  report.status = 'AUDIT_COMPLETE';
} catch (error) { report.status = 'HARNESS_ERROR'; report.error = clean(error.stack); process.exitCode = 1; }
finally {
  if (c && oldSettings !== undefined) try { await c.evaluate(oldSettings === null ? `localStorage.removeItem('ck_ai_connection_v1')` : `localStorage.setItem('ck_ai_connection_v1',${JSON.stringify(oldSettings)})`); } catch {}
  c?.close(); write('report.json', report); console.log('REPORT ' + out);
}
