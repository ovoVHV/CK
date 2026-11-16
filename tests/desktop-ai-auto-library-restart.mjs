import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {connectDesktop} from './desktop-client.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,'')),config=read(process.env.CK_V9_ENGINE_CONFIG),baseline=read(process.env.CK_AI_LIBRARY_BASELINE),evidence=config.paths.evidenceRoot;
const report={status:'RUNNING',desktopSha256:read(path.join(evidence,'desktop-launch.json')).sha256,baseline:process.env.CK_AI_LIBRARY_BASELINE,checks:[]};
const dir=path.dirname(process.env.CK_AI_LIBRARY_BASELINE),workspace=read(path.join(dir,'workspace.json'));
const file=path.join(evidence,'main-chat-restart-'+Date.now()+'.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:'主聊天补库重启验证',board:'arduino:avr:uno',board_package_id:'arduino:avr:uno',options:'{}',xml:JSON.stringify(workspace)}));
let c;const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 c=await connectDesktop();const types=baseline.libraries.flatMap(l=>l.types);
 const openRequestId=randomUUID();
 for(let i=0;i<240;i++){
  if(await c.evaluate(`Boolean(window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&document.querySelector('[data-ck-role="workspace-project-identity"]')?.title.endsWith(${JSON.stringify(path.basename(file))})&&${JSON.stringify(types)}.every(type=>window.CK_BLOCK_CATALOG?.blocks.some(b=>b.type===type))&&!document.querySelector('[data-ck-role="project-load-progress"]'))`))break;
  if(i%8===0)await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId:openRequestId,path:file,source:'ai-auto-library-restart'})}})`);await delay(250);
 }
 assert(await c.evaluate(`(()=>{const ctx=window.CK_NATIVE_REGRESSION.getCurrent();return ${JSON.stringify(types)}.every(type=>ctx.Blockly.Blocks[type]&&ctx.workspace.getAllBlocks(false).some(b=>b.type===type));})()`));
 report.checks.push('Restart loads all generated library blocks inside the saved complex project');
 await c.evaluate(`(()=>{window.__restartCompile=null;const original=window.fetch.bind(window);window.fetch=async(url,options)=>{const u=new URL(String(url),location.href);if(u.hostname==='ipc.localhost'&&u.pathname==='/compile_sketch'){const row={args:JSON.parse(options.body)};window.__restartCompile=row;const response=await original(url,options);row.response=await response.clone().text();row.kind=response.headers.get('Tauri-Response');row.done=true;return response;}return original(url,options);};return true;})()`);
 for(let i=0;i<160;i++){if(await c.evaluate(`document.querySelector('[data-ck-role="build-compile-action"]')?.disabled===false`))break;await delay(250);}
 await c.evaluate(`(()=>{const button=document.querySelector('[data-ck-role="build-compile-action"]');if(!button||button.disabled)throw Error('Compile button unavailable');button.click();return true;})()`);
 let compiled;
 for(let i=0;i<960;i++){compiled=await c.evaluate('window.__restartCompile');if(compiled?.done)break;await delay(250);}
 assert(compiled?.done,'Restart compile did not finish');assert.equal(compiled.kind,'ok');
 const source=fs.readFileSync(path.join(dir,'project.ino'),'utf8');assert.equal(compiled.args.code,source,'Saved blocks must regenerate identical source after restart');
 const value=JSON.parse(JSON.parse(compiled.response));assert(value.artifacts?.length>0);
 report.sourceSha256=createHash('sha256').update(source).digest('hex');report.artifacts=value.artifacts.length;report.checks.push('Restart compile button regenerates identical source from saved blocks and produces firmware with durable installed library');report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;}
finally{c?.close();fs.writeFileSync(path.join(evidence,'ai-auto-library-restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
