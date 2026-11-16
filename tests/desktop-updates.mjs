import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
import {ENGINE_VERSION} from '../src/version.mjs';
const out=process.env.CK_V91_PRODUCT_ROOT;
const report={version:ENGINE_VERSION,status:'RUNNING',checks:[]};
const save=()=>fs.writeFileSync(path.join(out,'update-check.json'),JSON.stringify(report,null,2));
let c,original;
try{
 c=await connectDesktop();
 await c.evaluate(`(async()=>{for(let i=0;i<120;i++){if(document.querySelector('button[aria-label="打开设置"]')){await new Promise(r=>setTimeout(r,500));return;}await new Promise(r=>setTimeout(r,250))}throw Error('Homepage not mounted')})()`);
 original=await c.evaluate("window.__TAURI_INTERNALS__.invoke('app_update_status')");
 assert.equal(original.currentVersion,ENGINE_VERSION);
 const latest=await c.evaluate(`(async()=>{for(let i=0;i<80;i++){try{return await window.__TAURI_INTERNALS__.invoke('app_update_check',{manual:true})}catch(e){if(!String(e).includes('正在处理更新'))throw e;await new Promise(r=>setTimeout(r,250))}}throw Error('Update busy timeout')})()`);
 assert.equal(latest,null);report.checks.push('Real HTTPS signed manifest verified; current version is not offered again');
 await c.evaluate(`document.querySelector('button[aria-label="打开设置"]').click()`);
 await c.evaluate(`(async()=>{for(let i=0;i<40;i++){const b=document.querySelector('[data-ck-role="check-software-update"]');if(b){b.click();return;}await new Promise(r=>setTimeout(r,100))}throw Error('Update settings missing')})()`);
 await c.evaluate(`(async()=>{for(let i=0;i<100;i++){const d=document.querySelector('[data-ck-role="software-update-dialog"]');if(d?.textContent.includes('当前已是最新版本'))return;if(d?.querySelector('[role="alert"]'))throw Error(d.textContent);await new Promise(r=>setTimeout(r,200))}throw Error('Manual check did not complete')})()`);
 report.checks.push('Actual homepage settings button shows the up-to-date dialog');
 await c.evaluate("window.__TAURI_INTERNALS__.invoke('app_update_preferences',{suppressReminders:true})");
 assert.equal((await c.evaluate("window.__TAURI_INTERNALS__.invoke('app_update_status')")).suppressReminders,true);
 assert.equal(await c.evaluate("window.__TAURI_INTERNALS__.invoke('app_update_check',{manual:true})"),null);
 report.checks.push('Saved global suppression leaves manual checks available');
 await c.evaluate(`(()=>{document.querySelector('[aria-label="关闭更新窗口"]').click();document.querySelector('[data-ck-role="appearance-settings-modal"] header button').click()})()`);
 const file=path.join(out,'更新入口回归.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'更新入口回归',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'delay_ms',id:'update-fixture',x:80,y:80,fields:{MS:500}}]}})}));
 const open={requestId:randomUUID(),path:file,source:'update-regression'};
 await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}})`);
 await c.evaluate(`(async()=>{for(let i=0;i<180;i++){if(document.querySelector('[data-ck-role="build-compile-action"]')&&!document.querySelector('[data-ck-role="project-load-progress"]'))return;await new Promise(r=>setTimeout(r,200))}throw Error('Workspace did not open')})()`);
 assert.equal(await c.evaluate(`Boolean(document.querySelector('[data-ck-role="software-update-dialog"],[data-ck-role="software-update-settings"],[data-ck-role="check-software-update"]'))`),false);
 const blocked=await c.evaluate(`window.__TAURI_INTERNALS__.invoke('app_update_check',{manual:true}).then(()=>({blocked:false}),e=>({blocked:true,message:String(e)}))`);
 assert.equal(blocked.blocked,true);assert.match(blocked.message,/主页/);
 report.checks.push('Real programming route has no update UI and the backend rejects checks');
 const build=await c.build('void setup() {}\nvoid loop() { delay(500); }','arduino:avr:uno',{workspaceFingerprint:'alpha24-update-smoke'});
 assert.equal(build.success,true,build.error);report.compileSmoke={success:true,wallMs:build.wallMs};
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;}
finally{if(c&&original)try{await c.evaluate(`window.__TAURI_INTERNALS__.invoke('app_update_preferences',{suppressReminders:${original.suppressReminders}})`)}catch{}c?.close();save();console.log(JSON.stringify(report));}
