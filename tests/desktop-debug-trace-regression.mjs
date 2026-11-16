// Regression of the repaired UI through its real controls. Only upload/serial IPC is
// substituted; this does not test a physical board or claim a real upload.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, 'desktop-regression-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', version: config.engineVersion,
  boundary: 'Built alpha.20 WebView and actual controls; upload and serial transport substituted at Tauri IPC; no physical device or upload',
  findings: [], observations: {} };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let client;
async function wait(expression, label, timeout = 20000) {
  const start = Date.now();
  do { const value = await client.evaluate(expression); if (value) return value; await sleep(100); } while (Date.now() - start < timeout);
  throw Error('Timed out: ' + label + '\n' + await client.evaluate('document.body.innerText.slice(-9000)'));
}
async function screenshot(name) {
  const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p => p.url === 'http://tauri.localhost/');
  const socket = new WebSocket(page.webSocketDebuggerUrl);
  const data = await new Promise((resolve, reject) => {
    const timer = setTimeout(() => { socket.close(); reject(Error('Screenshot timeout')); }, 10000);
    socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
    socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); socket.close(); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result.data); } };
  });
  fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data, 'base64'));
}
const state = () => client.evaluate(`(()=>{const d=document.querySelector('[data-ck-role="block-debug-controls"]'),t=document.querySelector('[data-ck-role="block-trace-panel"]');
  return {debug:d?.dataset.ckDebugPhase||null,trace:t?.dataset.ckTracePhase||null,text:(d||t)?.innerText||'',
  compileDisabled:document.querySelector('[data-ck-role="build-compile-action"]')?.disabled,
  uploadDisabled:document.querySelector('[data-ck-role="build-normal-upload-action"]')?.disabled,
  buttons:[...(d||t||document.createElement('div')).querySelectorAll('button')].map(b=>({text:b.innerText,disabled:b.disabled}))}})()`);
const frame = line => client.evaluate(`window.__debugAudit.frame(${JSON.stringify(line)})`);
async function clickText(text, scope = 'document') {
  await client.evaluate(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing/enabled button '+${JSON.stringify(text)});b.click();return true})()`);
}

try {
  client = await connectDesktop();
  await client.evaluate(`(()=>{
    const original=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
    const a=window.__debugAudit={calls:[],uploads:[],pending:[],session:'',sequence:0,defer:false,ackStop:false};
    a.frame=(tail,sequence=a.sequence)=>original('plugin:event|emit',{event:'serial-data',payload:'\\x1e@@CKDBG|'+a.session+'|'+tail+(/^(TRACE|READY)/.test(tail)?'':'|'+sequence)+'\\n'});
    a.release=()=>{a.defer=false;a.pending.splice(0).forEach(f=>f());};
    const auditInvoke=async(cmd,args,options)=>{
      if(cmd==='list_serial_ports')return [{port_name:'COM_AUDIT',description:'AUDIT MOCK TRANSPORT — NOT A PHYSICAL BOARD'}];
      if(['upload_sketch','open_serial_monitor','close_serial_monitor','send_serial_data'].includes(cmd)) {
        a.calls.push({cmd,at:performance.now(),data:cmd==='send_serial_data'?new TextDecoder().decode(new Uint8Array(args.data)):null});
        if(cmd==='upload_sketch') {a.uploads.push(args);const m=args.code.match(/@@CKDBG\\|([a-zA-Z0-9_-]+)\\|/);if(!m)throw Error('Session not found');a.session=m[1];return '[AUDIT] Mock upload transport: firmware captured; no device written.';}
        if(cmd==='send_serial_data') {const line=new TextDecoder().decode(new Uint8Array(args.data));
          const sequence=Number(line.trim().split('|').at(-1));a.sequence=sequence;if(line.includes('|CMD|ATTACH'))setTimeout(()=>a.frame('ATTACHED|RUNNING',sequence),150);
          if(line.includes('|CMD|STOP')&&a.ackStop)setTimeout(()=>a.frame('STOPPED',sequence),150);
          if(a.defer&&/\\|CMD\\|(STEP|CONTINUE)/.test(line))await new Promise(r=>a.pending.push(r));
        }return null;
      }
      if(/compile_sketch|precompile/.test(cmd))throw Error('Audit blocks real build command: '+cmd);
      return original(cmd,args,options);
    };
    // Tauri defines invoke as read-only. Substitute the local IPC fetch transport
    // for these commands, retaining the actual Tauri invoke/callback machinery.
    const originalFetch=window.fetch.bind(window);
    window.fetch=async(url,options)=>{
      const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
      if(u.hostname==='ipc.localhost'&&(['list_serial_ports','upload_sketch','open_serial_monitor','close_serial_monitor','send_serial_data'].includes(cmd)||/compile_sketch|precompile/.test(cmd))){
        try {const result=await auditInvoke(cmd,JSON.parse(options.body));return new Response(JSON.stringify(result),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});}
        catch(e){return new Response(JSON.stringify(String(e)),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}});}
      }
      return originalFetch(url,options);
    };
    const label=document.createElement('div');label.textContent='回归测试：桌面 UI + 模拟串口；没有连接或烧录实体板卡';
    label.style='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#8b1632;color:white;text-align:center;padding:5px;font:14px sans-serif;pointer-events:none';document.body.appendChild(label);
    return true;
  })()`);
  let chain;
  for (let i = 69; i >= 0; i--) chain = { type: 'delay_ms', id: 'audit-delay-' + i, fields: { MS: i + 1 }, ...(chain ? { next: { block: chain } } : {}) };
  const project = { format: 'ck-project', schema_version: 1, migration_version: 1, name: 'Debug trace audit — mocked transport',
    board: 'arduino:avr:uno', board_package_id: 'arduino:avr:uno', options: '{}',
    xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [
      { type: 'controls_setup_custom', id: 'audit-setup', x: 20, y: 20 },
      { type: 'controls_loop_custom', id: 'audit-loop', x: 20, y: 180, inputs: { DO: { block: chain } } },
    ] }, ckBreakpoints: { ids: ['audit-delay-0', 'audit-delay-1'] } }) };
  const file = path.join(out, 'Audit.ck'); fs.writeFileSync(file, JSON.stringify(project));
  const open = { requestId: randomUUID(), path: file, source: 'debug-trace-audit' };
  await client.evaluate(`(async()=>{for(let i=0;i<160;i++){
    if(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('audit-delay-69'))return true;
    if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});
    await new Promise(r=>setTimeout(r,250));
  }throw Error('70-block fixture not opened: '+document.body.innerText.slice(-4000))})()`);
  await client.evaluate(`document.querySelector('button[title="刷新串口"]').click()`);
  await sleep(300);
  await client.evaluate(`document.querySelector('button[title="选择串口"]').click()`);
  await wait(`!![...document.querySelectorAll('[role="menuitem"]')].find(b=>b.innerText.includes('COM_AUDIT'))`, 'mock port menu');
  await client.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.innerText.includes('COM_AUDIT')).click()`);
  await sleep(500);
  await client.evaluate(`document.querySelector('button[title="运行轨迹：上传采样固件，不暂停开发板程序"]').click()`);
  await wait(`document.querySelector('[data-ck-trace-phase="running"]')!==null`, 'trace attached');
  report.observations.traceStarted = await state();
  await frame('PAUSED|ignored-trace-token');
  assert.equal((await state()).trace, 'running');
  const traceCode = await client.evaluate('window.__debugAudit.uploads.at(-1).code');
  fs.writeFileSync(path.join(out, 'uploaded-trace.ino'), traceCode);
  report.observations.trackedIndices = [...traceCode.matchAll(/__ck_debug_checkpoint\(__CK_DEBUG_TEXT\("[0-9a-f]+"\), (\d+)U?\);/g)].map(m => Number(m[1]));
  for (let i = 0; i < 64; i++) await frame(`TRACE|${i}|${1000 + i * 1000}|F`);
  await wait(`document.querySelector('[data-ck-role="block-trace-panel"]')?.innerText.includes('64 / 64')`, 'all tracked points');
  report.observations.coverage = await state();
  assert(report.observations.coverage.text.includes('100%'));
  assert.match(report.observations.coverage.text, /未纳入\s*6\s*个/);
  await screenshot('trace-coverage'); save();

  // Start a fresh firmware/desktop rate window, then send two samples in one
  // batch. The trailing publication must work without any further input.
  await sleep(1100);
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'serial-data',payload:'\\x1e@@CKDBG|'+window.__debugAudit.session+'|TRACE|0|100000|S\\n\\x1e@@CKDBG|'+window.__debugAudit.session+'|TRACE|1|200000|S\\n'})`);
  await sleep(1100);
  report.observations.afterFinalBatch = await state();
  const stale = report.observations.afterFinalBatch.text.includes('65 次采样命中');
  assert.equal(stale, false); assert.match(report.observations.afterFinalBatch.text, /66 次采样命中/);
  await screenshot('trace-final-batch');
  await frame('READY'); await sleep(50); await frame('READY'); await sleep(450);
  report.observations.afterTraceReboot = await state();
  assert.equal(await client.evaluate(`document.querySelector('[aria-label="积木采样覆盖率"]')?.getAttribute('aria-valuenow')`), '0');
  assert.match(report.observations.afterTraceReboot.text, /0 次采样命中/);
  assert.match(report.observations.afterTraceReboot.text, /第\s*2\s*轮/);
  await screenshot('trace-after-reboot');
  await clickText('结束轨迹');
  await wait(`document.querySelector('[data-ck-trace-phase="stopping"]')!==null`, 'trace stopping');
  const stopStart = Date.now(); await sleep(5000);
  report.observations.stopWithoutAck = { elapsedMs: Date.now() - stopStart, ...await state() };
  assert.equal(report.observations.stopWithoutAck.trace, 'unresponsive');
  assert(report.observations.stopWithoutAck.buttons.some(b=>b.text==='退出桌面会话'&&!b.disabled));
  await screenshot('stop-without-ack'); save();
  await clickText('退出桌面会话');
  await wait(`!!document.querySelector('[data-ck-role="debug-recovery-notice"]')`, 'unconfirmed stop notice');
  report.observations.localExitBeforeAck = await state();
  assert.equal(report.observations.localExitBeforeAck.compileDisabled, false);
  assert.equal(report.observations.localExitBeforeAck.uploadDisabled, false);
  await frame('STOPPED');
  await wait(`!document.querySelector('[data-ck-role="block-trace-panel"]')`, 'stop confirmation');
  report.observations.stopped = await state(); assert.equal(report.observations.stopped.compileDisabled, false); assert.equal(report.observations.stopped.uploadDisabled, false);

  await client.evaluate(`document.querySelector('[data-ck-role="build-special-upload-trigger"]').click()`);
  await wait(`!!document.querySelector('[data-ck-role="build-debug-upload-action"]')`, 'debug menu');
  await client.evaluate(`document.querySelector('[data-ck-role="build-debug-upload-action"]').click()`);
  await wait(`document.querySelector('[data-ck-debug-phase="running"]')!==null`, 'breakpoint attached');
  fs.writeFileSync(path.join(out, 'uploaded-debug.ino'), await client.evaluate('window.__debugAudit.uploads.at(-1).code'));
  const token = i => Buffer.from('audit-delay-' + i).toString('hex');
  for (const [label, command] of [['单步', 'STEP'], ['继续', 'CONTINUE']]) {
    await frame('PAUSED|' + token(0));
    await wait(`document.querySelector('[data-ck-debug-phase="paused"]')!==null`, 'pause before ' + command);
    if (command === 'STEP') {
      await sleep(500);
      report.observations.pausedBlockVisibility = await client.evaluate(`(()=>{
        const {workspace}=window.CK_NATIVE_REGRESSION.getCurrent(),block=workspace.getBlockById('audit-delay-0');
        const field=block.getField('MS').getSvgRoot().getBoundingClientRect(),viewport=workspace.getInjectionDiv().getBoundingClientRect();
        const box=r=>({x:r.x,y:r.y,width:r.width,height:r.height});
        return {field:box(field),viewport:box(viewport),visible:field.bottom>viewport.top&&field.top<viewport.bottom&&field.right>viewport.left&&field.left<viewport.right};
      })()`);
      assert.equal(report.observations.pausedBlockVisibility.visible, true);
      await screenshot('paused-block-location');
    }
    await client.evaluate('window.__debugAudit.defer=true');
    await clickText(label);
    await wait('window.__debugAudit.pending.length===1', 'pending ' + command);
    await client.evaluate(`window.__debugAudit.frame('PAUSED|${token(0)}',window.__debugAudit.sequence-1)`);
    await client.evaluate(`window.__debugAudit.frame('STOPPED',window.__debugAudit.sequence-1)`);
    await sleep(80);
    assert.match((await state()).text, /等待开发板确认/);
    await frame('PAUSED|' + token(1)); await sleep(150);
    const before = await state();
    await client.evaluate('window.__debugAudit.release()'); await sleep(150);
    const after = await state();
    report.observations[command.toLowerCase() + 'Race'] = { beforeWriteResolved: before, afterWriteResolved: after };
    assert.equal(before.debug, 'paused'); assert.equal(after.debug, 'paused'); assert.match(after.text, /延时 2 毫秒/);
    assert(after.buttons.some(b=>b.text==='单步'&&!b.disabled));
    await screenshot(command.toLowerCase() + '-race');
  }
  report.observations.serialSendBlocked = await client.evaluate(`!!document.querySelector('input[placeholder="调试/轨迹期间串口由控制协议独占"]')?.disabled`);
  assert.equal(report.observations.serialSendBlocked, true);
  await clickText('单步');
  await wait(`document.querySelector('[data-ck-debug-phase="unresponsive"]')!==null`, 'missing step acknowledgement');
  report.observations.stepWithoutAck = await state();
  assert(report.observations.stepWithoutAck.buttons.some(b=>b.text==='退出桌面会话'&&!b.disabled));
  await frame('PAUSED|' + token(1)); await sleep(150);
  await frame('READY'); await sleep(450);
  report.observations.debugAfterReboot = await state();
  assert.equal(report.observations.debugAfterReboot.debug, 'running');
  assert(!report.observations.debugAfterReboot.text.includes('已暂停'));
  await screenshot('debug-after-reboot');
  await frame('ATTACHED|PAUSED|' + token(0)); await sleep(150);
  report.observations.explicitPausedAttachment = await state();
  assert.equal(report.observations.explicitPausedAttachment.debug, 'paused');
  await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'serial-disconnected',payload:'AUDIT simulated cable disconnect'})`);
  await sleep(150);
  report.observations.disconnected = await state();
  await sleep(3000);
  report.observations.reconnected = await state();
  assert.equal(report.observations.reconnected.debug, 'running');
  assert(!report.observations.reconnected.text.includes('已暂停'));
  await frame('STOPPED');
  await wait(`!document.querySelector('[data-ck-role="block-debug-controls"]')`, 'cleanup acknowledgement');
  // Exercise both real start handlers with the shipped Serial.readStringUntil
  // block. A readString control case checks that the guard is actually active.
  async function loadSerialReader(type) {
    const fixture = { blocks: { languageVersion: 0, blocks: [
      { type: 'controls_setup_custom', id: 'reader-setup', x: 20, y: 20 },
      { type: 'controls_loop_custom', id: 'reader-loop', x: 20, y: 180, inputs: { DO: { block: {
        type: 'serial_print', id: 'reader-print', fields: { NEWLINE: 'TRUE' }, inputs: { MSG: { block: { type, id: 'reader-input', fields: type.endsWith('_until') ? { DELIM: '\\n' } : {} } } },
      } } } },
    ] }, ckBreakpoints: { ids: ['reader-print'] } };
    await client.evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();Blockly.serialization.workspaces.load(${JSON.stringify(fixture)},workspace);return true})()`);
    await sleep(600);
  }
  await loadSerialReader('serial_read_string_until');
  for (const mode of ['trace', 'debug']) {
    const priorUploads = await client.evaluate('window.__debugAudit.uploads.length');
    if (mode === 'trace') await client.evaluate(`document.querySelector('button[title="运行轨迹：上传采样固件，不暂停开发板程序"]').click()`);
    else {
      await client.evaluate(`document.querySelector('[data-ck-role="build-special-upload-trigger"]').click()`);
      await wait(`!!document.querySelector('[data-ck-role="build-debug-upload-action"]')`, 'serial debug menu');
      await client.evaluate(`document.querySelector('[data-ck-role="build-debug-upload-action"]').click()`);
    }
    await sleep(400);
    assert.equal(await client.evaluate('window.__debugAudit.uploads.length'), priorUploads);
    assert(await client.evaluate(`document.body.innerText.includes('Serial')`));
    report.observations['rejectedSerialReader' + mode] = await state();
    assert.equal(report.observations['rejectedSerialReader' + mode][mode], null);
    await screenshot('read-until-' + mode + '-rejected');
  }
  await loadSerialReader('serial_read_string');
  const beforeBlocked = await client.evaluate('window.__debugAudit.uploads.length');
  await client.evaluate(`document.querySelector('button[title="运行轨迹：上传采样固件，不暂停开发板程序"]').click()`);
  await sleep(300);
  report.observations.serialReadStringControl = { uploadsBefore: beforeBlocked,
    uploadsAfter: await client.evaluate('window.__debugAudit.uploads.length'),
    warningShown: await client.evaluate(`document.body.innerText.includes('当前程序会读取或复用 Serial')`), ...await state() };
  assert.equal(report.observations.serialReadStringControl.uploadsAfter, beforeBlocked);
  assert.equal(report.observations.serialReadStringControl.warningShown, true);
  report.observations.final = await state();
  report.calls = await client.evaluate('window.__debugAudit.calls');
  report.status = 'PASS';
} catch (error) {
  report.status = 'HARNESS_ERROR'; report.error = String(error.stack); process.exitCode = 1;
  if (client) { report.observations.failureState = await state().catch(() => null); await screenshot('harness-error').catch(() => {}); }
  console.error(error);
} finally { save(); client?.close(); console.log('REPORT ' + path.join(out, 'report.json')); }
