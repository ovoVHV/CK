// Verify the unchanged live-model library on a rebuilt final desktop, without
// spending provider tokens to regenerate a library for an unrelated IPC fix.
import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {createHash,randomUUID} from 'node:crypto';import {connectDesktop} from './desktop-client.mjs';
const read=p=>JSON.parse(fs.readFileSync(p,'utf8').replace(/^\uFEFF/,''));
const config=read(process.env.CK_V9_ENGINE_CONFIG),evidence=config.paths.evidenceRoot;
const baselinePath=process.env.CK_AI_LIBRARY_BASELINE;assert(baselinePath,'CK_AI_LIBRARY_BASELINE required');
const baseline=read(baselinePath),library=baseline.libraries[0],contract=read(path.join(library.installed,'ck-blocks.json'));
const behavior=read(path.join(path.dirname(baselinePath),'behavior/report.json'));
const hash=p=>createHash('sha256').update(fs.readFileSync(p)).digest('hex');
const report={status:'RUNNING',desktopSha256:read(path.join(evidence,'desktop-launch.json')).sha256,libraryId:library.id,liveBaseline:baselinePath,liveBaselineDesktopSha256:baseline.desktopSha256,modelRecalled:false,checks:[]};
let c;const delay=ms=>new Promise(r=>setTimeout(r,ms));
try{
 for(const [file,sha] of Object.entries(behavior.sourceFiles))assert.equal(hash(path.join(library.installed,file)),sha);
 report.checks.push('Generated C++ source SHA-256 values match the live model and 42-assertion behavior audit');
 c=await connectDesktop();const project=path.join(path.dirname(baselinePath),'库制作回归.ck');
 for(let i=0;i<200;i++){
  if(await c.evaluate(`window.CK_NATIVE_REGRESSION?.getCurrent()?.workspace.getBlockById('library-loop')&&window.CK_BLOCK_CATALOG?.blocks.filter(b=>b.library_id===${JSON.stringify(library.id)}).length>=5&&!document.querySelector('[data-ck-role="project-load-progress"]')`))break;
  if(i%8===0)await c.evaluate(`window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify({requestId:randomUUID(),path:project,source:'generated-library-final-recheck'})}})`);
  await delay(250);
 }
 const types=contract.blocks.map(b=>b.type);
 assert(await c.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent();return ${JSON.stringify(types)}.every(type=>c.Blockly.Blocks[type]&&window.CK_BLOCK_CATALOG.blocks.some(b=>b.type===type&&b.library_id===${JSON.stringify(library.id)}));})()`));
 assert(await c.evaluate(`(()=>{const c=window.CK_NATIVE_REGRESSION.getCurrent(),w=new c.Blockly.Workspace();try{for(const type of ${JSON.stringify(types)})w.newBlock(type);return w.getAllBlocks(false).length===${types.length};}finally{w.dispose();}})()`));
 report.checks.push('All five installed block definitions register and are available in the real desktop catalog after restart');
 const source=fs.readFileSync(path.join(library.installed,'examples/compile_check/compile_check.ino'),'utf8');
 const result=await c.build(source,'arduino:avr:uno',{projectId:'ai-library-final:'+library.id});assert(result.success,JSON.stringify(result));
 const compiled=JSON.parse(result.value);assert(compiled.artifacts?.length>0);report.artifactCount=compiled.artifacts.length;report.sourceSha256=createHash('sha256').update(source).digest('hex');
 report.checks.push('Final desktop ordinary build uses the installed generated library and returns verified firmware');report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;}
finally{c?.close();fs.writeFileSync(path.join(evidence,'ai-library-installed-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
