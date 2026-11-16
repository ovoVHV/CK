// Actual desktop save/open pipeline and native persistence; no compile results are substituted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
const config = JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG, 'utf8').replace(/^\uFEFF/, ''));
const out = path.join(config.paths.evidenceRoot, `project-config-${Date.now()}`);
fs.mkdirSync(out, { recursive: true });
const report = { status: 'RUNNING', checks: [] };
const saveReport = () => fs.writeFileSync(path.join(out, 'report.json'), JSON.stringify(report, null, 2));
const delay = ms => new Promise(resolve => setTimeout(resolve, ms));
let client;
async function wait(expression, label, timeout = 60000) {
    const start = Date.now();
    while (Date.now() - start < timeout) {
        const value = await client.evaluate(expression);
        if (value) return value;
        await delay(200);
    }
    throw Error(`Timed out: ${label}`);
}
const state = id => ({ blocks: { languageVersion: 0, blocks: [{ type: 'controls_loop_custom', id, x: 60, y: 70 }] } });
async function open(file, id) {
    const payload = { requestId: randomUUID(), path: file, source: 'project-target-regression' };
    for (let attempt = 0; attempt < 240; attempt++) {
        if (await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById(${JSON.stringify(id)}) && !document.querySelector('[data-ck-role="project-load-progress"]'))`)) return;
        if (attempt % 8 === 0) await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit', { event: 'ck-project-open-requested', payload: ${JSON.stringify(payload)} })`);
        await delay(250);
    }
    throw Error('Timed out: project opened');
}
async function ctrlSave() {
    const index = await client.evaluate('window.__projectConfigCalls.length');
    await client.input('Input.dispatchKeyEvent', { type: 'keyDown', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    await client.input('Input.dispatchKeyEvent', { type: 'keyUp', key: 's', code: 'KeyS', modifiers: 2, windowsVirtualKeyCode: 83 });
    const result = await wait(`window.__projectConfigCalls.slice(${index}).find(r => r.command === 'save_project_as' && r.done)`, 'desktop save');
    assert.equal(result.kind, 'ok', result.response);
    await delay(300);
    return result;
}
try {
    client = await connectDesktop();
    await client.evaluate(`(()=>{window.__projectConfigCalls=[];const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href),command=decodeURIComponent(u.pathname.slice(1));if(u.hostname==='ipc.localhost'&&['save_project_as','save_project','compile_sketch'].includes(command)){const row={command,args:JSON.parse(options.body)};window.__projectConfigCalls.push(row);const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true})()`);
    const project = { format: 'ck-project', schema_version: 1, migration_version: 1, name: '配置保存',
        board: 'arduino:avr:nano', board_package_id: 'arduino:avr:nano', options: '{"cpu":"atmega328old"}', xml: JSON.stringify(state('config-loop')) };
    const file = path.join(out, '配置保存.ck'); fs.writeFileSync(file, JSON.stringify(project));
    await open(file, 'config-loop');
    // Menu loading is asynchronous. The actual save snapshot must report resolution, not assume it.
    for (let attempt = 0; attempt < 30; attempt++) {
        await ctrlSave();
        const saved = JSON.parse(fs.readFileSync(file));
        if (saved.build_target?.optionsComplete && saved.build_target?.coreVersion) { report.saved = saved.build_target; break; }
        await delay(1000);
    }
    assert(report.saved, 'Core/menu resolution and save must complete');
    assert.equal(report.saved.options.cpu, 'atmega328old');
    assert.equal(report.saved.board, 'arduino:avr:nano');
    assert.equal(report.saved.fqbn, 'arduino:avr:nano:cpu=atmega328old');
    report.checks.push('Actual Ctrl+S persisted Nano processor, concrete package, installed Core and full FQBN'); saveReport();

    const mismatch = JSON.parse(fs.readFileSync(file));
    mismatch.name = '不同核心版本'; mismatch.xml = JSON.stringify(state('mismatch-loop')); mismatch.build_target.coreVersion = '0.0.0-regression';
    const mismatchFile = path.join(out, '不同核心版本.ck'); fs.writeFileSync(mismatchFile, JSON.stringify(mismatch));
    await open(mismatchFile, 'mismatch-loop');
    const notice = await wait(`document.querySelector('[data-ck-build-target-notice]')?.textContent.includes('0.0.0-regression') && document.querySelector('[data-ck-build-target-notice]').textContent`, 'Core mismatch warning');
    assert.match(notice, /采用当前环境/); report.notice = notice;
    const count = await client.evaluate(`window.__projectConfigCalls.filter(x=>x.command==='compile_sketch').length`);
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'compile action ready');
    await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`); await delay(800);
    assert.equal(await client.evaluate(`window.__projectConfigCalls.filter(x=>x.command==='compile_sketch').length`), count);
    await ctrlSave();
    assert.equal(JSON.parse(fs.readFileSync(mismatchFile)).build_target.coreVersion, '0.0.0-regression');
    report.checks.push('Reopen warns about a different Core, blocks compile before native dispatch, and saving preserves the recorded Core'); saveReport();

    await wait(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='采用当前环境')?.disabled===false`, 'adoption ready');
    await client.evaluate(`[...document.querySelectorAll('button')].find(b=>b.textContent.trim()==='采用当前环境').click()`);
    await wait(`!document.querySelector('[data-ck-build-target-notice]')`, 'explicit adoption clears notice');
    await ctrlSave();
    const adopted = JSON.parse(fs.readFileSync(mismatchFile));
    assert.equal(adopted.build_target.coreVersion, report.saved.coreVersion);
    assert.equal(adopted.build_target.options.cpu, 'atmega328old');
    report.checks.push('Explicit adoption records the current Core without losing Nano processor choice');
    await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`, 'adopted compile ready');
    await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
    const built = await wait(`window.__projectConfigCalls.filter(x=>x.command==='compile_sketch')[${count}]?.done ? window.__projectConfigCalls.filter(x=>x.command==='compile_sketch')[${count}] : null`, 'actual compile after adopting environment', 180000);
    assert.equal(built.kind, 'ok', built.response);
    assert.match(built.args.fqbn, /arduino:avr:nano:.*cpu=atmega328old/);
    report.actualCompile = { fqbn: built.args.fqbn, result: built.response };
    report.checks.push('Actual native compilation succeeds with the saved Nano old-bootloader target after adoption');
    report.status = 'PASS';
} catch (error) { report.status = 'FAIL'; report.error = String(error.stack); console.error(error); process.exitCode = 1; }
finally { saveReport(); client?.close(); console.log(`REPORT ${out}`); }
