// Fresh desktop process: verify real persisted state, without making a model request.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const fixture=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'ai-restart-fixture.json')));
const launch=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,''));
const report={status:'RUNNING',desktopSha256:launch.sha256,pid:process.env.CK_V9_DESKTOP_PID,checks:[]};
const client=await connectDesktop(),delay=ms=>new Promise(r=>setTimeout(r,ms));
async function wait(code,label){for(let i=0;i<240;i++){const value=await client.evaluate(code);if(value)return value;await delay(250);}throw Error('Timeout: '+label);}
try {
 assert.notEqual(process.env.CK_V9_DESKTOP_PID,fixture.firstPid);
 const payload={requestId:randomUUID(),path:fixture.projectFile,source:'ai-restart-regression'};
 for(let i=0;i<160;i++){
  if(await client.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('ai-other-loop')&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;
  if(i%8===0)await client.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(payload)}})`);await delay(250);
 }
 await wait(`Boolean(document.querySelector('[data-ck-role="ai-assistant-trigger"]'))`,'project open');
 await client.evaluate(`document.querySelector('[data-ck-role="ai-assistant-trigger"]').click()`);
 await wait(`document.querySelector('.ck-ai-currentchat>span')?.textContent==='持久聊天回归'`,'persisted chat');
 assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-message').length`),32);
 assert(await client.evaluate(`Boolean(document.querySelector('.ck-ai-memory'))`));
 assert.equal(await client.evaluate(`document.querySelectorAll('.ck-ai-proposal,.ck-ai-undo').length`),0);
 report.checks.push('A different desktop process restores all 32 transcript messages and the summary, without an executable preview or undo state');
 await wait(`document.querySelector('button[aria-label="模型连接设置"]')?.disabled===false`,'global settings ready');
 await client.evaluate(`document.querySelector('button[aria-label="模型连接设置"]').click()`);
 assert(await wait(`document.querySelector('.ck-ai-settings input[type="password"]')?.value==='local-fixture-not-a-real-key'`,'encrypted key restored'));
 assert.equal(await client.evaluate(`document.querySelector('input[aria-label="上下文预算"]').value`),'16384');
 assert.equal(await client.evaluate(`document.querySelector('input[aria-label="单次回复预留"]').value`),'2048');
 report.checks.push('Global key and context settings survive full process exit and restart through the actual native encrypted store');
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;}
finally{fs.writeFileSync(path.join(config.paths.evidenceRoot,'ai-restart-report.json'),JSON.stringify(report,null,2));client.close();console.log(JSON.stringify(report,null,2));}
