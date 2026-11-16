import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';

const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const evidence = path.join(config.paths.evidenceRoot, 'pin-preflight-' + Date.now());
fs.mkdirSync(evidence, { recursive: true });
const sensorType = 'ck_common_hc_sr04_distance', sensorId = 'pin-regression-sensor';
const shadow = (name, value) => ({ shadow: { type: `ck_shadow_number_${sensorType}_${name}`, fields: { NUM: value } } });
const project = {
    format: 'ck-project', schema_version: 1, migration_version: 1, name: 'Pin analysis regression',
    board: 'arduino:avr:uno', board_package_id: 'arduino:avr:uno', options: '{}',
    xml: JSON.stringify({ blocks: { languageVersion: 0, blocks: [
        { type: 'controls_setup_custom', id: 'pin-test-setup', x: 20, y: 20 },
        { type: 'controls_loop_custom', id: 'pin-test-loop', x: 20, y: 180, inputs: { DO: { block: {
            type: 'serial_print', id: 'pin-test-print', fields: { NEWLINE: 'TRUE' }, inputs: { MSG: { block: {
                type: sensorType, id: sensorId, inputs: { TRIG: shadow('TRIG', 5), ECHO: shadow('ECHO', 6) },
            } } },
        } } } },
    ] } }),
};
const projectFile = path.join(evidence, 'HC-SR04.ck'); fs.writeFileSync(projectFile, JSON.stringify(project));
const report = { status: 'RUNNING', engineVersion: config.engineVersion, boundary: 'Actual packaged WebView and engineering-health panel; original HC-SR04 package', checks: [] };
let client;
const save = () => fs.writeFileSync(path.join(evidence, 'report.json'), JSON.stringify(report, null, 2));
try {
    client = await connectDesktop();
    report.libraryDiagnostics = await client.evaluate(`(async()=>{
        const libs=await window.__TAURI_INTERNALS__.invoke('get_all_libraries',{board:'arduino:avr:uno',boardPackageId:null});
        return libs.filter(l=>l.id==='ck_hw_hc_sr04').map(l=>({id:l.id,dir:l.dir_path,has_blocks:l.has_blocks,
            runtime_activation:l.runtime_activation,diagnostics:l.diagnostics,quality_report:l.quality_report}));
    })()`);
    save();
    const open = { requestId: randomUUID(), path: projectFile, source: 'pin-analysis-regression' };
    await client.evaluate(`(async()=>{for(let i=0;i<240;i++){
        const context=window.CK_NATIVE_REGRESSION?.getCurrent();
        if(context?.workspace.getBlockById(${JSON.stringify(sensorId)}))return true;
        if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});
        await new Promise(r=>setTimeout(r,250));
    }throw Error('HC-SR04 fixture not loaded')})()`);
    await client.evaluate(`(()=>{document.querySelector('[data-ck-role="engineering-health-button"]').click();return true})()`);
    async function panel(expected = ['5', '6']) {
        return client.evaluate(`(async()=>{for(let i=0;i<100;i++){
            const p=document.querySelector('section[aria-label="引脚体检"]');
            const pins=p?[...p.querySelectorAll('[data-ck-pin-state="used"]')].map(e=>e.dataset.ckPinValue).sort():[];
            if(p&&p.innerText.includes('2 个引脚正在使用')&&JSON.stringify(pins)===JSON.stringify(${JSON.stringify(expected)})){p.scrollIntoView({block:'center'});return p.innerText}
            await new Promise(r=>setTimeout(r,100));
        }throw Error('Pin panel not showing two used pins: '+document.body.innerText.slice(-6000))})()`);
    }
    report.initial = await panel();
    assert(!report.initial.includes('引脚值无效'));
    assert(report.initial.includes('库的硬件检查尚未完整覆盖'));
    assert(report.initial.includes('有未覆盖或待确认项'));
    assert(!report.initial.includes('库未声明硬件检查信息'), 'built-in setup/loop/print blocks must not be misreported as undeclared library devices');
    report.checks.push('TRIG=5 / ECHO=6: two used pins, no invalid literal warning');
    const snapshot = await client.evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();
        return {state:Blockly.serialization.workspaces.save(workspace),fields:['TRIG','ECHO'].map(n=>workspace.getBlockById('${sensorId}').getInputTargetBlock(n).getFieldValue('NUM'))}})()`);
    assert.deepEqual(snapshot.fields, [5, 6]);
    await client.evaluate(`(()=>{const {workspace}=window.CK_NATIVE_REGRESSION.getCurrent();workspace.getBlockById('${sensorId}').getInputTargetBlock('TRIG').setFieldValue(7,'NUM');return true})()`);
    await new Promise(r => setTimeout(r, 800));
    report.edited = await panel(['6', '7']); assert(!report.edited.includes('引脚值无效'));
    report.checks.push('Editing TRIG to 7 keeps two recognized pins');
    await client.evaluate(`(()=>{const {Blockly,workspace}=window.CK_NATIVE_REGRESSION.getCurrent();Blockly.serialization.workspaces.load(${JSON.stringify(snapshot.state)},workspace);return true})()`);
    await new Promise(r => setTimeout(r, 800));
    report.restored = await panel(); assert(!report.restored.includes('引脚值无效'));
    report.checks.push('Reloaded serialized workspace retains recognition');
    const page = (await (await fetch(process.env.CK_CDP_LIST_URL)).json()).find(p => p.url === 'http://tauri.localhost/');
    const socket = new WebSocket(page.webSocketDebuggerUrl);
    const capture = await new Promise((resolve, reject) => {
        const timer = setTimeout(() => { socket.close(); reject(Error('Screenshot timeout')); }, 10000);
        socket.onopen = () => socket.send(JSON.stringify({ id: 1, method: 'Page.captureScreenshot', params: { format: 'png' } }));
        socket.onmessage = e => { const r = JSON.parse(e.data); if (r.id === 1) { clearTimeout(timer); socket.close(); r.error ? reject(Error(JSON.stringify(r.error))) : resolve(r.result.data); } };
    });
    fs.writeFileSync(path.join(evidence, 'panel.png'), Buffer.from(capture, 'base64'));
    report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack); process.exitCode = 1; console.error(error); }
finally { save(); client?.close(); console.log('REPORT ' + path.join(evidence, 'report.json')); }
