// Real desktop controls and real AVR compilation. Upload-only checks substitute
// Tauri transport explicitly: they do not certify physical hardware or firmware.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, 'health-ui-' + Date.now());
fs.mkdirSync(out, { recursive: true });
const report = { version: config.engineVersion, status: 'RUNNING',
    boundary: 'Real installed WebView controls and AVR compile; upload transport substituted, no physical board test', findings: [] };
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
        board: fqbn, board_package_id: fqbn, options: '{}',
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
        const original=window.__TAURI_INTERNALS__.invoke.bind(window.__TAURI_INTERNALS__);
        const a=window.__healthAudit={calls:[],baseline:null,savePath:null,pending:[],deferUpload:false,baselineFailure:null,compileResult:null};
        a.release=()=>{a.deferUpload=false;a.pending.splice(0).forEach(f=>f());};
        const hash=async text=>[...new Uint8Array(await crypto.subtle.digest('SHA-256',new TextEncoder().encode(text)))].map(b=>b.toString(16).padStart(2,'0')).join('');
        const invoke=async(cmd,args)=>{
            if(cmd==='list_serial_ports')return [{port_name:'COM_AUDIT',description:'MOCK UPLOAD TRANSPORT, NO PHYSICAL BOARD'}];
            if(cmd==='plugin:dialog|save'){if(!a.savePath)throw Error('No export destination');return a.savePath;}
            if(cmd==='get_last_working_version')return a.baseline;
            if(cmd==='upload_sketch'){
                a.calls.push({cmd,args});
                if(a.deferUpload)await new Promise(r=>a.pending.push(r));
                if(!a.baselineFailure){
                    const c=args.lastWorkingVersion,now=new Date().toISOString();
                    if(!c)throw Error('No normal upload capture');
                    a.baseline={schemaVersion:1,id:'mock-baseline',createdAt:now,verifiedAt:now,
                        project:{...c,name:'Mock uploaded project',originalPath:c.projectPath,workspaceSha256:await hash(c.workspaceJson),generatedCodeSha256:await hash(args.code)},
                        environment:{fqbn:args.fqbn,coreId:'arduino:avr',coreVersion:a.coreVersion,arduinoCliVersion:'1.4.1',toolchainKey:'mock',buildSignature:'mock',compileProfile:'release',optimization:'-Os'},
                        lock:{content:'{}',sha256:await hash('{}'),dependencies:[],path:'ck.lock'},
                        firmware:{buildDirectory:'mock',manifestPath:'mock',manifestSha256:'a'.repeat(64),partition:null,artifacts:[]},
                        device:{chip:null,revision:null,flashBytes:null,psramBytes:null},
                        resources:{flashUsedBytes:1234,flashMaxBytes:32256,ramUsedBytes:12,ramMaxBytes:2048,warningCount:0},
                        logs:{compilePath:'mock',uploadPath:'mock'}};
                }
                return JSON.stringify({kind:'ck-upload-result',schemaVersion:1,success:true,runId:args.runId,fqbn:args.fqbn,
                    compileLog:'[信息] 目标 FQBN: '+args.fqbn+'\\nSketch uses 1234 bytes (3%) of program storage space. Maximum is 32256 bytes.\\nGlobal variables use 12 bytes (0%) of dynamic memory. Maximum is 2048 bytes.',
                    log:'[AUDIT] Upload transport substituted; NO PHYSICAL BOARD.',baselineId:a.baseline?.id||null,baselineFailure:a.baselineFailure});
            }
            return original(cmd,args);
        };
        const originalFetch=window.fetch.bind(window);
        window.fetch=async(url,options)=>{
            const u=new URL(String(url),location.href),cmd=decodeURIComponent(u.pathname.slice(1));
            if(u.hostname==='ipc.localhost'&&['list_serial_ports','plugin:dialog|save','get_last_working_version','upload_sketch'].includes(cmd)){
                try{return new Response(JSON.stringify(await invoke(cmd,JSON.parse(options.body))),{headers:{'Content-Type':'application/json','Tauri-Response':'ok'}});}
                catch(e){return new Response(JSON.stringify(String(e)),{headers:{'Content-Type':'application/json','Tauri-Response':'error'}});}
            }
            const response=await originalFetch(url,options);
            if(u.hostname==='ipc.localhost'&&cmd==='compile_sketch'){
                try {a.compileResult=await response.clone().json();}catch{}
            }
            return response;
        };
        const label=document.createElement('div');label.textContent='桌面回归：真实 AVR 编译；上传使用模拟传输，没有烧录实体板卡';
        label.style='position:fixed;bottom:0;left:0;right:0;z-index:99999;background:#8b1632;color:white;text-align:center;padding:5px;font:14px sans-serif;pointer-events:none';document.body.appendChild(label);
    })()`);
    await openFixture('arduino:avr:uno', 'uno');
    assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-button"]')`), false);
    await openReport();
    const initial = await exportJson('uno-before');
    await client.evaluate(`window.__healthAudit.coreVersion=${JSON.stringify(initial.target.coreVersion)}`);
    assert.equal(initial.hardware.state, 'unsupported');
    assert.equal(initial.health.checks.some(c => c.id === 'device-health'), false);
    await client.evaluate(`window.dispatchEvent(new KeyboardEvent('keydown',{key:'Escape',bubbles:true}))`);
    await wait(`!${modal}`, 'Escape still closes report after export');
    report.findings.push({ name: 'Escape remains available after report export' });
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'compile ready');
    await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
    await openReport();
    await wait(`${modal}?.innerText.includes('编译\\n编译通过')`, 'live report after real AVR compile', 180000);
    const compiled = await exportJson('uno-compiled');
    assert.equal(compiled.build.state, 'passed');
    assert(compiled.build.flashUsedBytes > 0); assert.equal(compiled.build.ramTotalBytes, 2048);
    assert.equal(compiled.health.checks.find(c => c.id === 'resource-budget').state, 'pass');
    const realCompile = await client.evaluate('window.__healthAudit.compileResult');
    fs.writeFileSync(path.join(out, 'uno-compile-ipc.json'), realCompile);
    report.findings.push({ name: 'Real Uno compile refreshes open report without refresh click', flash: compiled.build.flashUsedBytes, ram: compiled.build.ramUsedBytes });
    await screenshot('uno-compiled'); await closeReport(); save();
    await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
    await openReport();
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false && ${modal}?.innerText.includes('编译\\n编译通过')`, 'unchanged compile complete', 180000);
    const sameSource = await exportJson('uno-unchanged');
    assert.equal(sameSource.build.flashUsedBytes, compiled.build.flashUsedBytes);
    assert.equal(sameSource.build.ramUsedBytes, compiled.build.ramUsedBytes);
    const unchangedRaw = await client.evaluate('window.__healthAudit.compileResult');
    fs.writeFileSync(path.join(out, 'uno-unchanged-ipc.json'), unchangedRaw);
    assert.match(JSON.parse(unchangedRaw).log, /Compile GCC=0/);
    assert.match(JSON.parse(unchangedRaw).log, /warning_count=\d+/);
    report.findings.push({ name: 'Unchanged source with zero compiles still refreshes measured resource evidence' });
    await closeReport();

    // A completed upload must refresh an already-open report even with no log events.
    await client.evaluate(`document.querySelector('button[title="刷新串口"]').click()`); await sleep(250);
    await client.evaluate(`document.querySelector('button[title="选择串口"]').click()`);
    await wait(`!![...document.querySelectorAll('[role="menuitem"]')].find(b=>b.innerText.includes('COM_AUDIT'))`, 'mock port');
    assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-menu-action"]')`), false);
    await client.evaluate(`[...document.querySelectorAll('[role="menuitem"]')].find(b=>b.innerText.includes('COM_AUDIT')).click();window.__healthAudit.deferUpload=true`);
    await client.evaluate(`document.querySelector('[data-ck-role="build-normal-upload-action"]').click()`);
    await wait(`window.__healthAudit.pending.length>0`, 'pending mocked upload');
    await openReport();
    await client.evaluate(`window.__healthAudit.release()`);
    await wait(`${modal}?.innerText.includes('最近验证于')`, 'automatic upload/baseline refresh');
    const uploaded = await exportJson('uno-uploaded-mock');
    assert.equal(uploaded.build.state, 'passed'); assert.equal(uploaded.build.flashUsedBytes, 1234);
    assert.equal(uploaded.dependencies.lockAvailable, true);
    assert.equal(uploaded.health.checks.find(c => c.id === 'device-health'), undefined);
    report.findings.push({ name: 'Mock upload without streamed logs refreshes compile/resources/baseline/lock', evidence: 'Substituted transport' });
    await screenshot('uno-uploaded-mock'); await closeReport();
    const zip = path.join(out, 'uno-diagnostics.zip');
    await client.evaluate(`window.__healthAudit.savePath=${JSON.stringify(zip)};document.querySelector('button[title="导出或导入工程诊断包"]').click()`);
    await wait(`!!document.querySelector('[aria-label="关闭诊断包"]')`, 'diagnostic modal');
    await client.evaluate(`(()=>{const b=[...document.querySelectorAll('[role="dialog"] button')].find(b=>b.innerText.includes('选择位置并导出 ZIP'));if(!b)throw Error('ZIP button missing');b.click()})()`);
    for (let i = 0; i < 200 && !fs.existsSync(zip); i++) await sleep(100);
    assert(fs.existsSync(zip), 'Diagnostic ZIP missing');
    await wait(`document.querySelector('[aria-label="关闭诊断包"]')?.disabled===false`, 'ZIP finished');
    const inspected = await client.evaluate(`window.__TAURI_INTERNALS__.invoke('inspect_diagnostic_bundle',{path:${JSON.stringify(zip)}})`);
    fs.writeFileSync(path.join(out, 'diagnostic-inspection.json'), JSON.stringify(inspected, null, 2));
    assert.equal(inspected.summary.fqbn, 'arduino:avr:uno');
    await client.evaluate(`document.querySelector('[aria-label="关闭诊断包"]').click()`);
    report.findings.push({ name: 'Diagnostic ZIP exported through actual desktop and validated by Rust inspector' });

    // Missing baseline is a real warning only after a matching failed capture.
    await client.evaluate(`window.__healthAudit.baseline=null;window.__healthAudit.baselineFailure='测试：缺少资源证据';document.querySelector('[data-ck-role="build-normal-upload-action"]').click()`);
    await wait(`window.__healthAudit.calls.filter(c=>c.cmd==='upload_sketch').length===2`, 'second mock upload');
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'second mock complete');
    await openReport();
    await wait(`${modal}?.innerText.includes('上传已成功，但可用版本未保存')`, 'baseline failure reason');
    await exportJson('uno-baseline-failure-mock'); await closeReport();
    report.findings.push({ name: 'Baseline capture failure is displayed instead of unchanged generic waiting text' });

    await openFixture('esp32:esp32:esp32s3', 's3');
    assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-button"]')`), true);
    await openReport();
    const switched = await exportJson('s3-switched');
    assert.equal(switched.build.flashUsedBytes, null);
    assert(switched.health.checks.some(c => c.id === 'device-health'));
    assert.notEqual(switched.hardware.state, 'verified');
    assert(!JSON.stringify(switched).includes('测试：缺少资源证据'));
    await screenshot('s3-switched'); await closeReport();
    report.findings.push({ name: 'ESP32 retains supported inspection; switching board discards Uno evidence' });
    for (const [fqbn, id, ramLimit] of [['arduino:avr:nano', 'nano', 2048], ['arduino:avr:mega', 'mega', 8192]]) {
        await openFixture(fqbn, id);
        assert.equal(await client.evaluate(`!!document.querySelector('[data-ck-role="device-health-button"]')`), false);
        await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, id + ' ready');
        await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
        await openReport();
        await wait(`${modal}?.innerText.includes('编译\\n编译通过')`, id + ' real compile', 180000);
        const compiledBoard = await exportJson(id + '-compiled');
        assert(compiledBoard.build.flashUsedBytes > 0);
        assert.equal(compiledBoard.build.ramTotalBytes, ramLimit);
        assert.equal(compiledBoard.hardware.state, 'unsupported');
        fs.writeFileSync(path.join(out, id + '-compile-ipc.json'), await client.evaluate('window.__healthAudit.compileResult'));
        report.findings.push({ name: 'Real ' + id + ' compile updates its own board limits', fqbn: compiledBoard.target.fqbn, ramLimit });
        await closeReport();
    }
    report.status = 'PASS'; save(); console.log(JSON.stringify({ status: 'PASS', evidence: out, findings: report.findings }));
} catch (error) {
    report.status = 'FAIL'; report.error = String(error); save();
    try { await screenshot('failure'); } catch {}
    console.error(error); process.exitCode = 1;
} finally { client?.close(); }
