// Real desktop controls and real AVR compilation. Upload-only checks substitute
// Tauri transport explicitly: they do not certify physical hardware or firmware.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, 'board-capabilities-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { version: config.engineVersion, status: 'RUNNING',
    boundary: 'Installed alpha.21 UI and real report exports; no build or physical board test', findings: [] };
const save = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const sleep = ms => new Promise(r => setTimeout(r, ms));
let client;
async function wait(expression, label, timeout = 25000) {
    const start = Date.now();
    do { const value = await client.evaluate(expression); if (value) return value; await sleep(150); } while (Date.now() - start < timeout);
    throw Error('Timeout: ' + label + '\n' + await client.evaluate('document.body.innerText.slice(-12000)'));
}
async function clickText(text, scope = 'document') {
    await client.evaluate(`(()=>{const b=[...${scope}.querySelectorAll('button')].find(b=>b.innerText.trim()===${JSON.stringify(text)});if(!b||b.disabled)throw Error('Missing button '+${JSON.stringify(text)});b.click()})()`);
}
const modal = `document.querySelector('[role="dialog"][aria-label="项目验收报告"]')`;
async function openReport() {
    await client.evaluate(`(()=>{const b=[...document.querySelectorAll('button[aria-haspopup="menu"]')].find(b=>b.textContent.includes('文件'));if(!b)throw Error('File menu missing');b.click()})()`);
    await clickText('项目验收报告');
    await wait(`${modal}?.innerText.includes('工程健康检查')`, 'acceptance report');
}
async function closeReport() {
    await client.evaluate(`(()=>{const b=${modal}?.querySelector('header button[aria-label]');if(!b||b.disabled)throw Error('Close unavailable');b.click()})()`);
    await wait(`!${modal}`, 'report closed');
}
async function exportJson(name) {
    const file = path.join(out, name + '.json');
    await client.evaluate(`window.__healthAudit.savePath=${JSON.stringify(file)}`);
    await clickText('结构化 JSON', modal);
    for (let i = 0; i < 100 && !fs.existsSync(file); i++) await sleep(100);
    assert(fs.existsSync(file), 'JSON export missing');
    await wait(`!${modal}?.querySelector('header button[aria-label]')?.disabled`, 'export complete');
    return JSON.parse(fs.readFileSync(file, 'utf8'));
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
async function openFixture(fqbn, id) {
    const project = { format: 'ck-project', schema_version: 1, migration_version: 1, name: 'Health regression ' + id,
        board: fqbn.split(':').slice(0,3).join(':'), board_package_id: fqbn.split(':').slice(0,3).join(':'), options: JSON.stringify(Object.fromEntries((fqbn.split(':')[3] || '').split(',').filter(Boolean).map(x=>x.split('=')))),
        xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [
            { type: 'controls_setup_custom', id: id + '-setup', x: 20, y: 20 },
            { type: 'controls_loop_custom', id: id + '-loop', x: 20, y: 180,
                inputs: { DO: { block: { type: 'delay_ms', id: id + '-delay', fields: { MS: 100 } } } } },
        ] } }) };
    const file = path.join(out, id + '.ck'); fs.writeFileSync(file, JSON.stringify(project));
    const open = { requestId: randomUUID(), path: file, source: 'health-regression' };
    await client.evaluate(`(async()=>{for(let i=0;i<160;i++){
        if(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(id + '-delay')}))return true;
        if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});
        await new Promise(r=>setTimeout(r,250));
    }throw Error('Fixture not open')})()`);
    await sleep(900);
    return file;
}

try {
    client = await connectDesktop();
    await client.evaluate(`(()=>{
        window.__healthAudit={savePath:null};
        const original=window.fetch.bind(window);
        window.fetch=async(url,options)=>{
            const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
            if(u.hostname==='ipc.localhost'&&cmd==='plugin:dialog|save'){
                return new Response(JSON.stringify(window.__healthAudit.savePath),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});
            }
            return original(url,options);
        };
    })()`);
    const targets = [
        ['esp32:esp32:esp32s3','esp32',true],
        ['arduino:avr:diecimila','duemilanove-default',false],
        ['arduino:avr:diecimila:cpu=atmega328','duemilanove-328',false],
        ['arduino:avr:diecimila:cpu=atmega168','duemilanove-168',false],
        ['arduino:avr:uno','uno',false],
        ['arduino:avr:nano:cpu=atmega328old','nano-old',false],
        ['arduino:avr:mega:cpu=atmega2560','mega',false],
        ['esp32:esp32:esp32s3','esp32-return',true],
    ];
    for(const [fqbn,id,supported] of targets){
        await openFixture(fqbn,id);
        await wait(`document.querySelector('[data-ck-role="board-config-button"]')?.getAttribute('data-ck-board-options-status') !== 'loading'`,id+' board options ready');
        if(fqbn.includes('cpu='))await wait(`document.querySelector('[data-ck-role="board-config-button"]')?.title.endsWith(${JSON.stringify(fqbn)})`,id+' selected CPU identity');
        assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-button"]')`),supported,id+' toolbar');
        await client.evaluate(`document.querySelector('button[title="选择串口"]').click()`);
        await sleep(100);
        assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-menu-action"]')`),supported,id+' serial menu');
        await client.evaluate(`document.querySelector('button[title="选择串口"]').click()`);
        if(!await client.evaluate(`!!document.querySelector('[data-ck-role="engineering-health-view"]')`)){
            await client.evaluate(`document.querySelector('[data-ck-role="engineering-health-button"]').click()`);
        }
        await wait(`!!document.querySelector('[data-ck-role="engineering-health-view"]')`,'health drawer');
        assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="health-device"]')`),supported,id+' drawer');
        await openReport();
        const r=await exportJson(id);
        assert.equal(r.target.fqbn.split(':').slice(0,3).join(':'),fqbn.split(':').slice(0,3).join(':'));
        if(fqbn.includes('cpu='))assert.equal(r.target.fqbn,fqbn);
        assert.equal(r.hardware.state==='unsupported',!supported);
        assert.equal(r.health.checks.some(c=>c.id==='device-health'),supported,id+' report');
        assert.equal(r.health.checks.find(c=>c.id==='board-passport').stages.some(c=>c.id==='device'),supported,id+' passport stage');
        for(const item of ['resource-budget','last-working-version','dependency-lock'])assert(r.health.checks.some(c=>c.id===item));
        const html=path.join(out,id+'.html');
        await client.evaluate(`window.__healthAudit.savePath=${JSON.stringify(html)}`);
        await clickText('打印 / 保存 PDF',modal);
        for(let i=0;i<100&&!fs.existsSync(html);i++)await sleep(100);
        assert(fs.existsSync(html),'HTML export');
        assert.equal(fs.readFileSync(html,'utf8').includes('class="label">真机'),supported,id+' printable report');
        await wait(`!${modal}?.querySelector('header button[aria-label]')?.disabled`,'HTML complete');
        if(id.startsWith('duemilanove'))await screenshot(id);
        report.findings.push({target:r.target.fqbn,id,deviceHealth:supported,checks:['toolbar','serial-menu','health-drawer','report','passport-stage','JSON','HTML'],supportedFeaturesPreserved:true});save();
        await closeReport();
    }
    report.status='PASS';save();console.log(JSON.stringify({status:'PASS',evidence:out,findings:report.findings}));
}catch(error){
    report.status='FAIL';report.error=String(error);save();try{await screenshot('failure');}catch{}
    console.error(error);process.exitCode=1;
}finally{client?.close();}
