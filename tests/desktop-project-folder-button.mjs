// Real toolbar acceptance. The fetch observer forwards every IPC call unchanged;
// neither the compiler input nor its result is provided by the harness.
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import { randomUUID } from 'node:crypto';
import { digest, normalize } from '../src/protocol.mjs';
import { connectDesktop } from './desktop-client.mjs';
import { installFixture, makeProject, header, markers, firmwareData } from './project-folder-fixture.mjs';

const read=f=>JSON.parse(fs.readFileSync(f,'utf8').replace(/^\uFEFF/,''));
const cfg=read(process.env.CK_V9_ENGINE_CONFIG), out=fs.mkdtempSync(path.join(cfg.paths.evidenceRoot,'folder-button-'));
const report={status:'RUNNING',launch:read(path.join(cfg.paths.evidenceRoot,'desktop-launch.json')),runs:[]};
const record=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const btn='[data-ck-role="build-compile-action"]', bench='.ck-file-workbench', member=bench+' .cm-content', dirty=bench+' .ck-source-dirty';
const q=JSON.stringify, sel=s=>`document.querySelector(${q(s)})`, delay=ms=>new Promise(r=>setTimeout(r,ms));
let c; const ids=new Set();
async function wait(expr,label,ms=45000){
    const until=Date.now()+ms;
    do{const value=await c.evaluate(expr);if(value)return value;await delay(80);}while(Date.now()<until);
    throw Error('Timed out: '+label+' / '+await c.evaluate('document.body.innerText.slice(-1500)'));
}
const click=s=>c.evaluate(`(()=>{const b=${sel(s)};if(!b||b.disabled||!b.getClientRects().length)throw Error('Unavailable: '+${q(s)});b.click()})()`);
async function replaceText(s,text){
    await c.evaluate(`${sel(s)}.focus()`);
    for(const type of ['keyDown','keyUp'])await c.input('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
    await c.input('Input.insertText',{text});
}
async function openProject(p){
    const event={requestId:randomUUID(),path:p.entry,source:'multifile-button-regression'};
    await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${q(event)}})`);
    await wait(`!!document.querySelector('[data-id="${p.blockId}"]') && ${sel(btn)}?.disabled===false && !document.querySelector('[data-ck-role="project-load-progress"]')`,'open '+p.board);
}
async function editHeader(p,oldValue,newValue){
    if(await c.evaluate(`!!${sel('[title="展开工程文件"]')}`))await click('[title="展开工程文件"]');
    await wait(`!!${sel('.ck-tree-leaf[title="src/Timing.h"]')}`,'file tree');await click('.ck-tree-leaf[title="src/Timing.h"]');
    await wait(`${sel(member)}?.textContent.includes('CK_HEADER_${oldValue}')`,'original header');
    await replaceText(member,header(newValue));
    await wait(`!!${sel(dirty)} && ${sel(member)}?.textContent.includes('CK_HEADER_${newValue}')`,'unsaved header');
    assert.equal(fs.readFileSync(p.timing,'utf8'),header(oldValue));
}
async function build(p,mode,label,n,prior){
    report.current={board:p.board,mode,label};record();console.log('BUTTON',p.board,mode,label);
    assert.equal(await c.evaluate(`${sel('.ck-workspace-stage')}.dataset.editorMode`),mode);
    await wait(`${sel(btn)}?.disabled===false`,'enabled compile');
    const i=await c.evaluate('window.__mfCalls.length');
    const start=await c.evaluate(`(()=>{const b=${sel(btn)};if(b.disabled||!b.getClientRects().length)throw Error('Compile unavailable');const at=performance.now();b.click();return at})()`);
    await wait(`window.__mfCalls.length>${i}`,'toolbar dispatch');
    const row=await wait(`window.__mfCalls[${i}]?.done && window.__mfCalls[${i}]`,'compile response',600000);
    const end=await wait(`${sel(btn)}?.disabled===false && !document.querySelector('[data-ck-role="compile-progress-overlay"]') && performance.now()`,'toolbar ready');
    const prefix=[p.board,mode,label].join('-');
    fs.writeFileSync(path.join(out,prefix+'.log'),await c.evaluate(`${sel('[data-ck-role="compile-log-scroll-container"]')}?.innerText || ''`));
    fs.writeFileSync(path.join(out,prefix+'.ino'),row.args.code);
    assert.equal(row.kind,'ok',String(row.response).slice(-2000));
    const result=JSON.parse(JSON.parse(row.response));const host=read(path.join(result.path,'native-graph-host-receipt.json')), r=host.worker;
    assert.equal(host.backend,'ck-build-engine-v9');assert(r.success);assert.equal(r.requestId,host.requestId);
    assert(!ids.has(r.requestId),'stale receipt');ids.add(r.requestId);
    assert.equal(r.fqbn,p.fqbn);assert.equal(row.args.fqbn,r.fqbn);assert.equal(path.resolve(row.args.projectPath),p.entry);
    assert.equal(r.sourceSha256,digest(normalize(row.args.code)));assert.equal(host.sourceSha256,r.sourceSha256);
    assert(row.args.code.includes(`emitBlink("${markers[mode]}")`));
    const other=mode==='blocks'?'source':'blocks';assert(!row.args.code.includes(markers[other]));
    assert.deepEqual(r.projectFiles.map(f=>f.name).sort(),['Blink.cpp','Blink.h','src/Timing.h']);
    for(const f of r.projectFiles)assert.equal(f.sha256,digest(fs.readFileSync(path.join(path.dirname(p.entry),f.name))));
    assert.equal(fs.readFileSync(p.timing,'utf8'),header(n));
    if(label==='header')assert.equal(await c.evaluate(`!!${sel(dirty)}`),false);
    const artifact=r.artifacts.find(a=>a.name===(p.board==='nano'?'sketch.ino.hex':'sketch.ino.bin'));
    const bytes=fs.readFileSync(path.join(result.path,artifact.name)),sha=digest(bytes),data=firmwareData(artifact.name,bytes);
    assert.equal(sha,artifact.sha256);assert(data.includes(markers[mode])&&!data.includes(markers[other]),'compiled mode marker');
    for(const rev of [101,202,303])assert.equal(data.includes('CK_HEADER_'+rev),rev===n,'compiled header '+rev);
    const core=r.propertyExpansion?.coreVersion || prior?.core;
    const run={...report.current,core,fqbn:r.fqbn,header:n,buttonMs:Math.round(end-start),ipcRunId:row.args.runId,requestId:r.requestId,receipt:path.join(result.path,'native-graph-host-receipt.json'),sourceSha256:r.sourceSha256,artifact:artifact.name,sha256:sha,counts:r.counts,noOp:r.noOpFastPath?.hit===true,compiled:r.steps?.filter(s=>s.kind==='COMPILE').map(s=>s.output)??[]};
    assert(core,'actual Core version missing');
    if(label==='same'){
        assert(run.noOp);for(const key of ['DiscoveryGCC','PrototypeGCC','CompileGCC','Linker','ImageGenerator'])assert.equal(run.counts[key],0,key);assert.equal(sha,prior.sha256);
    }else{
        assert(!run.noOp);if(prior)assert.notEqual(sha,prior.sha256);
        if(label==='header'){assert.equal(run.counts.CompileGCC,1);assert.deepEqual(run.compiled.map(x=>path.basename(x)),['Blink.cpp.o']);assert.equal(run.sourceSha256,prior.sourceSha256);}
    }
    report.runs.push(run);record();console.log('PASS',prefix,run.buttonMs+'ms',run.counts.CompileGCC,sha.slice(0,12));return run;
}
try{
    const type=installFixture(cfg);c=await connectDesktop();
    await wait(`document.body.innerText.includes('我的工程')`,'desktop home');
    await c.evaluate(`(()=>{const orig=window.fetch;window.__mfCalls=[];window.fetch=async function(url,options){const u=new URL(String(url),location.href);if(u.hostname!=='ipc.localhost'||u.pathname!=='/compile_sketch')return orig.apply(this,arguments);const row={args:JSON.parse(options.body)};window.__mfCalls.push(row);try{const res=await orig.apply(this,arguments);row.response=await res.clone().text();row.kind=res.headers.get('Tauri-Response');return res;}finally{row.done=true;}};window.__mfRestore=()=>{window.fetch=orig;delete window.__mfCalls;delete window.__mfRestore;};})()`);
    for(const fqbn of ['arduino:avr:nano:cpu=atmega328','esp32:esp32:esp32s3']){
        const p=makeProject(out,fqbn,type);await openProject(p);
        const cold=await build(p,'blocks','first',101);
        await editHeader(p,101,202);const edited=await build(p,'blocks','header',202,cold);await build(p,'blocks','same',202,edited);
        await click(`${bench} [aria-label="关闭文件编辑器"]`);await click('#ck-source-tab');
        const main='#ck-source-panel .cm-content';await wait(`${sel(main)}?.textContent.includes('${markers.blocks}')`,'generated source');
        const hand=`#include "Blink.h"\nvoid setup() {}\nvoid loop() { emitBlink("${markers.source}"); }\n`;
        await replaceText(main,hand);await wait(`${sel(main)}?.textContent.includes('${markers.source}')`,'handwritten source');
        const switched=await build(p,'source','switch',202,edited);
        await editHeader(p,202,303);const handEdit=await build(p,'source','header',303,switched);await build(p,'source','same',303,handEdit);
        await click(`${bench} [aria-label="关闭文件编辑器"]`);
        // Save this QA project's hand-written main before opening the next project.
        for(const type of ['keyDown','keyUp'])await c.input('Input.dispatchKeyEvent',{type,key:'s',code:'KeyS',windowsVirtualKeyCode:83,modifiers:2});
        for(let i=0;i<80&&!read(p.entry).code?.includes(markers.source);i++)await delay(100);
        assert(read(p.entry).code?.includes(markers.source));
    }
    report.status='PASS';delete report.current;
}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{record();try{await c?.evaluate('window.__mfRestore?.()');}finally{c?.close();}console.log('REPORT',out);}
