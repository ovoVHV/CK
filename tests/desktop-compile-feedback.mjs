// Real desktop compile button, native compiler, host alias event and Blockly UI.
// No compiler, diagnostic, alias or output IPC is substituted.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';
import { connectDesktop } from './desktop-client.mjs';
import { ENGINE_VERSION } from '../src/version.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const out=path.join(config.paths.evidenceRoot,'compile-feedback-'+Date.now());fs.mkdirSync(out,{recursive:true});
const report={version:ENGINE_VERSION,status:'RUNNING',boundary:'Actual Uno compiler and desktop compile button; no mocked build result',checks:[],runs:[]};
const save=()=>fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));
const pause=ms=>new Promise(r=>setTimeout(r,ms));let client;save();
async function wait(expression,label,timeout=30000){const start=Date.now();do{const value=await client.evaluate(expression);if(value)return value;await pause(150);}while(Date.now()-start<timeout);throw Error('Timed out: '+label);}
const blockState=()=>client.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent(),b=c.workspace.getBlockById('error-statement'),parent=c.workspace.getBlockById('error-loop');return {marked:b.getSvgRoot().classList.contains('ck-block-compile-error'),warning:b.getIcon(c.Blockly.icons.WarningIcon.TYPE)?.getText()||'',stroke:getComputedStyle(b.pathObject.svgPath).stroke,collapsed:parent.isCollapsed(),locateButtons:[...document.querySelectorAll('button')].filter(x=>x.textContent.trim()==='定位积木').length}})()`);
try{
 client=await connectDesktop();
 const fixture={format:'ck-project',schema_version:1,migration_version:1,name:'Compile error mapping regression',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:'error-loop',x:60,y:70,collapsed:true,inputs:{DO:{block:{type:'math_compound_assign_custom',id:'error-statement',fields:{OP:'+='},inputs:{VAR:{block:{type:'math_number',id:'bad-lvalue',fields:{NUM:1}}},VALUE:{shadow:{type:'math_number',fields:{NUM:0}}}}}}}}]}})};
 const file=path.join(out,'Compile feedback.ck');fs.writeFileSync(file,JSON.stringify(fixture));
 const open={requestId:randomUUID(),path:file,source:'compile-feedback-regression'};
 await client.evaluate(`(async()=>{for(let i=0;i<160;i++){if(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('error-statement')&&!document.querySelector('[data-ck-role="project-load-progress"]'))return true;if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});await new Promise(r=>setTimeout(r,250));}throw Error('Fixture not opened')})()`);
 await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'compile ready');
 await client.evaluate(`(()=>{window.__compileFeedback={calls:[]};const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);if(u.hostname==='ipc.localhost'&&decodeURIComponent(u.pathname.slice(1))==='compile_sketch'){const row={args:JSON.parse(options.body),started:performance.now()};window.__compileFeedback.calls.push(row);const r=await original(url,options);row.response=await r.clone().text();row.responseKind=r.headers.get('Tauri-Response');row.ms=performance.now()-row.started;row.done=true;return r;}return original(url,options);};window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('error-statement').setWarningText('Library-owned warning retained','library-own');return true})()`);
 async function compile(label){
  const index=await client.evaluate('window.__compileFeedback.calls.length');
  await client.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]').click()`);
  const row=await wait(`window.__compileFeedback.calls[${index}]?.done?window.__compileFeedback.calls[${index}]:null`,label,300000);
  report.runs.push({label,...row});save();return row;
 }
 const failed=await compile('bad-lvalue');
 assert.equal(failed.responseKind,'error');
 const error=JSON.parse(failed.response);assert.match(error,/V9 build failed/);assert.match(error,/\.ino:\d+:\d+: error:/);
 assert.match(error,/sessions/);assert.match(error,/\n[^\n]*\.ino:\d+/);
 assert(JSON.parse(failed.args.sourceMapJson).mappings.some(m=>m.blockId==='error-statement'));
 await wait(`document.querySelector('[data-id="error-statement"]')?.classList.contains('ck-block-compile-error')`,'error outline');
 report.failedState=await blockState();assert.equal(report.failedState.collapsed,false);
 assert.match(report.failedState.warning,/编译错误/);assert.match(report.failedState.warning,/Library-owned warning retained/);
 assert.equal(report.failedState.stroke,'rgb(220, 38, 38)');assert(report.failedState.locateButtons>0);
 await client.evaluate(`[...document.querySelectorAll('button')].find(x=>x.textContent.trim()==='定位积木').click()`);
 assert((await blockState()).marked);
 report.checks.push('Real native diagnostic located; red SVG outline, warning icon, expanded parent, locate action and library warning preserved');save();
 await client.evaluate(`(()=>{window.CK_NATIVE_REGRESSION.getCurrent().workspace.getBlockById('bad-lvalue').dispose();return true})()`);
 await wait(`!document.querySelector('[data-id="error-statement"]')?.classList.contains('ck-block-compile-error')`,'stale mark cleared after edit');
 await wait(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`,'corrected compile ready');
 const fixed=await compile('corrected-fallback-variable');assert.equal(fixed.responseKind,'ok',fixed.response);
 report.fixedState=await blockState();assert.equal(report.fixedState.marked,false);assert.equal(report.fixedState.warning,'Library-owned warning retained');
 const result=JSON.parse(JSON.parse(fixed.response)),host=JSON.parse(fs.readFileSync(path.join(result.path,'native-graph-host-receipt.json')));
 assert.equal(host.backend,'ck-build-engine-v9');report.correctedArtifacts=host.worker.artifacts;
 report.checks.push('Editing clears stale mapping; corrected actual native compile succeeds; compiler warning cleared without deleting library warning');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}
finally{save();client?.close();console.log('REPORT '+out);}
