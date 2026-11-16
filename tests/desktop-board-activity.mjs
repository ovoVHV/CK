// Installed desktop + real compile/failure. Upload display is explicitly synthetic;
// the harness never claims a physical board upload or writes synthetic host history.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, 'board-activity-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const restart = process.env.CK_BOARD_ACTIVITY_RESTART === '1';
const report = { status: 'RUNNING', version: config.engineVersion, restart, boundary: 'Real desktop IPC compilation; upload display uses synthetic read response, no physical hardware', findings: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let client;
const id = 'arduino:avr:diecimila';
const fqbn = id + ':cpu=atmega328';
const card = `document.querySelector('[data-ck-board-id="${id}"]')`;
async function wait(expression, label, timeout = 30000) {
    const start = Date.now();
    do { const value = await client.evaluate(expression); if (value) return value; await sleep(150); } while (Date.now() - start < timeout);
    throw Error('Timeout: ' + label + '\n' + await client.evaluate('document.body.innerText.slice(-10000)'));
}
async function snapshot(name) {
    const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p => p.url === 'http://tauri.localhost/');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const data = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(Error('Screenshot timeout')); }, 10000);
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
        socket.onmessage = e => { const m = JSON.parse(e.data); if (m.id === 1) { clearTimeout(timer); socket.close(); m.error ? reject(Error(JSON.stringify(m.error))) : resolve(m.result.data); } };
    });
    fs.writeFileSync(path.join(out, name + '.png'), Buffer.from(data, 'base64'));
}
async function history() { return client.evaluate(`window.__TAURI_INTERNALS__.invoke('get_board_success_history')`); }
async function compile(code) {
    const args = { code, fqbn, boardPackageId: id, runId: randomUUID(), workspaceFingerprint: 'board-status-regression', projectId: 'board-status-regression', sourceMapJson: null, silent: false, qualification: false };
    return client.evaluate(`(async()=>{const start=performance.now();try{return {success:true,result:await window.__TAURI_INTERNALS__.invoke('compile_sketch',${JSON.stringify(args)}),wallMs:performance.now()-start}}catch(e){return {success:false,error:String(e),wallMs:performance.now()-start}}})()`);
}

try {
    client = await connectDesktop();
    await wait(`!![...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建工程'))`, 'dashboard');
    await client.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.includes('新建工程')).click()`);
    await wait(`${card}?.innerText.includes('当前环境已就绪') && !${card}?.innerText.includes('正在读取记录')`, 'board list loaded', 60000);
    for (const board of ['uno', 'nano', 'mega', 'diecimila']) {
        const text = await client.evaluate(`document.querySelector('[data-ck-board-id="arduino:avr:${board}"]')?.innerText`);
        assert(text, board + ' card missing');
        assert.doesNotMatch(text, /尚未真板验证|真机专项|尚未本机编译/);
    }
    report.findings.push('Uno, Nano, Mega and Duemilanove cards hide unsupported device qualification');
    const initial = await history();
    fs.writeFileSync(path.join(out, 'history-before.json'), JSON.stringify(initial, null, 2));
    if (restart) {
        assert(initial.some(r => r.fqbn === fqbn && r.operation === 'compile' && r.boardPackageId === id), 'success survives process restart');
        await wait(`${card}?.querySelector('[data-ck-role="board-activity-compile"]')?.dataset.status==='passed'`, 'persisted green compile');
        report.findings.push('Real compile history survives desktop restart and appears green');
    } else {
        const result = await compile('void setup() {}\nvoid loop() { delay(100); }\n');
        fs.writeFileSync(path.join(out, 'compile.json'), JSON.stringify(result, null, 2));
        assert.equal(result.success, true, result.error);
        const after = await history();
        const success = after.find(r => r.boardPackageId === id && r.fqbn === fqbn && r.operation === 'compile');
        assert(success && success.coreVersion, 'host records actual complete target and Core');
        await wait(`${card}?.querySelector('[data-ck-role="board-activity-compile"]')?.dataset.status==='passed'`, 'live compile badge without reopen');
        assert.equal(after.filter(r=>r.operation==='upload').length, initial.filter(r=>r.operation==='upload').length);
        report.findings.push({ name: 'Real compile refreshes already-open board card without claiming upload', fqbn, core: success.coreVersion, wallMs: result.wallMs });
        const failure = await compile('void setup() { definitely_missing_identifier(); }\nvoid loop() {}\n');
        fs.writeFileSync(path.join(out, 'compile-failure.json'), JSON.stringify(failure, null, 2));
        assert.equal(failure.success, false);
        assert.deepEqual(await history(), after, 'failed compile never invents or replaces success');
        report.findings.push('Failed compile preserves previous historical success and creates no new observation');
    }
    await client.evaluate(`${card}.scrollIntoView({block:'center'});[...${card}.querySelectorAll('button')].find(b=>b.textContent.includes('板卡状态详情')).click()`);
    await wait(`${card}?.querySelector('[data-ck-role="board-activity-details"]')?.textContent.includes(${JSON.stringify(fqbn)})`, 'complete configuration shown');
    assert.doesNotMatch(await client.evaluate(`${card}.innerText`), /真板型号|尚无真机专项/);
    await snapshot('real-compile-history');
    if (!restart) {
        const actual = await history();
        const success = actual.find(r=>r.boardPackageId === id && r.operation === 'compile');
        const upload = { ...success, operation: 'upload' };
        await client.evaluate(`(()=>{
            window.__boardActivityAudit={records:${JSON.stringify([...actual,upload])},originalFetch:window.fetch.bind(window)};
            window.fetch=async(url,options)=>{
                const u=new URL(String(url),location.href);
                if(u.hostname==='ipc.localhost'&&decodeURIComponent(u.pathname.slice(1))==='get_board_success_history')
                    return new Response(JSON.stringify(window.__boardActivityAudit.records),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
                return window.__boardActivityAudit.originalFetch(url,options);
            };
            const label=document.createElement('div');label.id='activity-audit-label';label.textContent='上传显示回归：模拟读取结果；未烧录实体板卡';
            label.style='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#8b1632;color:white;text-align:center;padding:5px;font:14px sans-serif';document.body.appendChild(label);
        })()`);
        await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'board-success-history-changed',payload:null})`);
        await wait(`${card}.querySelector('[data-ck-role="board-activity-upload"]')?.dataset.status==='passed'`, 'synthetic upload displayed');
        assert.match(await client.evaluate(`${card}.innerText`), /普通上传成功/);
        assert.doesNotMatch(await client.evaluate(`${card}.innerText`), /真机专项验证通过/);
        await snapshot('synthetic-upload-display-only');
        await client.evaluate(`window.fetch=window.__boardActivityAudit.originalFetch;document.querySelector('#activity-audit-label').remove()`);
        assert.deepEqual(await history(), actual, 'UI mock never writes host records');
        report.findings.push('Synthetic upload response displays ordinary upload success without hardware qualification or persisted fake evidence');
    }
    report.status='PASS';save();console.log(JSON.stringify({status:report.status,evidence:out,findings:report.findings}));
} catch (e) {
    report.status='FAIL';report.error=String(e);save();try{await snapshot('failure');}catch{} console.error(e);process.exitCode=1;
} finally { client?.close(); }
