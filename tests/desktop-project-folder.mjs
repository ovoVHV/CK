// File manager + direct IPC controls. Toolbar/mode/autosave coverage: desktop-project-folder-button.mjs.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {randomUUID} from 'node:crypto';
import {fileURLToPath} from 'node:url';
import {connectDesktop} from './desktop-client.mjs';
const cfg=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const evidence=path.join(cfg.paths.evidenceRoot,'desktop-folder-'+Date.now());
fs.mkdirSync(evidence,{recursive:true});
process.on('uncaughtException',error=>{fs.writeFileSync(path.join(evidence,'error.txt'),error.stack??String(error));process.exit(1);});
const sample=path.join(evidence,'多文件闪灯'),entry=path.join(sample,'多文件闪灯.ck');
const sourceDir=fileURLToPath(new URL('../desktop/examples/多文件闪灯',import.meta.url));
fs.mkdirSync(path.join(sample,'src'),{recursive:true});
for(const name of ['多文件闪灯.ck','Blink.cpp','Blink.h','src/Timing.h'])fs.writeFileSync(path.join(sample,name),fs.readFileSync(path.join(sourceDir,name)));
const code=JSON.parse(fs.readFileSync(entry)).code,fqbn='arduino:avr:nano:cpu=atmega328',client=await connectDesktop();
const call=(command,args)=>client.evaluate(`window.__TAURI_INTERNALS__.invoke(${JSON.stringify(command)},${JSON.stringify(args)})`);
const wait=async expr=>{for(let i=0;i<200;i++){if(await client.evaluate(expr))return;await new Promise(r=>setTimeout(r,150));}throw Error('Desktop did not reach: '+expr);};
const rows=[];
const bench='.ck-file-workbench', content=`${bench} .cm-content`;
const click=sel=>client.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
async function expand(){if(await client.evaluate(`!!document.querySelector('[title="展开工程文件"]')`))await click('[title="展开工程文件"]');}
async function file(name){await expand();await click(`.ck-tree-leaf[title="${name}"]`);}
async function filename(text){
 await client.evaluate(`document.querySelector('dialog[open] input').select()`);
 await client.input('Input.insertText',{text});await click('dialog[open] .ck-member-primary');
}
async function more(name,which){
 await expand();await click(`[aria-label="${name} 的文件操作"]`);await click(`.ck-file-actions button:nth-child(${which})`);
 await wait(`!!document.querySelector('dialog[open] form')`);
}
try{
 await call('prepare_project_open_v2',{path:entry});await call('load_project',{path:entry});
 assert.deepEqual(await call('list_project_sources',{path:entry}),['Blink.cpp','Blink.h','src/Timing.h']);
 await wait(`document.body.innerText.includes('我的工程')`);
 await call('plugin:event|emit',{event:'ck-project-open-requested',payload:{requestId:randomUUID(),path:entry,source:'desktop-project-folder'}});
 await wait(`document.querySelector('#ck-source-tab')?.disabled===false`);
 for (const [mode,file,text] of [['blocks','Blink.cpp','pinMode'],['source','src/Timing.h','500']]) {
  await client.evaluate(`document.querySelector('#ck-${mode}-tab').click()`);
  await wait(`document.querySelector('.ck-workspace-stage').dataset.editorMode==='${mode}' && !!document.querySelector('.ck-project-dock')`);
  if(await client.evaluate(`!!document.querySelector('[title="展开工程文件"]')`))await client.evaluate(`document.querySelector('[title="展开工程文件"]').click()`);
  const sel=`.ck-tree-leaf[title="${file}"]`;
  await wait(`document.querySelector(${JSON.stringify(sel)})?.getBoundingClientRect().height>0`);
  if(mode==='blocks')fs.writeFileSync(path.join(evidence,'blocks-files.png'),await client.screenshot());
  await client.evaluate(`document.querySelector(${JSON.stringify(sel)}).click()`);
  await wait(`document.querySelector('${content}')?.innerText.includes('${text}') && !document.querySelector('dialog[open]')`);
  if(mode==='blocks'){
   const colors=await client.evaluate(`(()=>{const els=[...document.querySelectorAll('${content} span')];return Object.fromEntries(['void','initBlink','pinMode','LED_BUILTIN'].map(s=>{const el=els.find(x=>x.textContent===s && !x.querySelector('span'));return [s,el&&getComputedStyle(el).color];}));})()`);
   assert(Object.values(colors).every(Boolean));assert.equal(colors.initBlink,colors.pinMode);
   assert.equal(new Set([colors.void,colors.pinMode,colors.LED_BUILTIN]).size,3);
   rows.push({label:'highlight',colors,expectedConstant:await client.evaluate(`document.documentElement.classList.contains('dark')?'rgb(255, 158, 201)':'rgb(150, 43, 99)'`)});
   const before=await client.evaluate(`localStorage.getItem('app_theme') || 'system'`);
   const toggleTheme=mode=>client.evaluate(`window.dispatchEvent(new StorageEvent('storage',{key:'app_theme',newValue:${JSON.stringify(mode)}}))`);
   try{
    for(const [modeName,color] of [['light','rgb(150, 43, 99)'],['dark','rgb(255, 158, 201)']]){
     await toggleTheme(modeName);
     await wait(`getComputedStyle([...document.querySelectorAll('${content} span')].find(e=>e.textContent==='LED_BUILTIN'&&!e.querySelector('span'))).color===${JSON.stringify(color)}`);
     rows.push({label:'macro-'+modeName,color});
    }
   }finally{await toggleTheme(before);}
  }
  if(mode==='source')fs.writeFileSync(path.join(evidence,'header-editor.png'),await client.screenshot());
  await click(`${bench} button[aria-label="关闭文件编辑器"]`);
  assert.equal(await client.evaluate(`document.querySelector('.ck-workspace-stage').dataset.editorMode`),mode);
  const editor=mode==='blocks'?'[aria-label="积木生成的 C++ 源码"]':'#ck-source-panel .cm-content';
  if(mode==='blocks')await click('[title="显示代码预览"]');
  await wait(`[...document.querySelectorAll('${editor} span')].some(x=>x.textContent==='setup')`);
  const fn=await client.evaluate(`getComputedStyle([...document.querySelectorAll('${editor} span')].find(x=>x.textContent==='setup')).color`);
  assert.equal(fn,rows.find(x=>x.label==='highlight').colors.pinMode);
  if(mode==='blocks')await click('[aria-label="关闭代码预览"]');
 }
 await expand();await click('[aria-label="新建源码文件"]');
 await wait(`!!document.querySelector('dialog[open] input')`);await filename('Example.h');
 await wait(`document.querySelector('.ck-member-path')?.innerText.includes('Example.h')`);
 await expand();
 const center=sel=>client.evaluate(`(()=>{const e=document.querySelector(${JSON.stringify(sel)});e.scrollIntoView({block:'nearest'});const r=e.getBoundingClientRect();return {x:r.x+r.width/2,y:r.y+r.height/2};})()`);
 const from=await center('.ck-tree-leaf[title="Example.h"]'),to=await center('summary[data-drop-dir="src/"]');
 await client.input('Input.dispatchMouseEvent',{type:'mousePressed',...from,button:'left',buttons:1,clickCount:1});
 await client.input('Input.dispatchMouseEvent',{type:'mouseMoved',...to,button:'left',buttons:1});
 await wait(`!!document.querySelector('summary[data-drop-dir="src/"][data-drop-over=true]')`);
 await client.input('Input.dispatchMouseEvent',{type:'mouseReleased',...to,button:'left',buttons:0,clickCount:1});
 await wait(`document.querySelector('dialog[open] input')?.value==='src/Example.h'`);
 await click('dialog[open] .ck-member-primary');
 await wait(`document.querySelector('.ck-member-path')?.innerText.includes('src/Example.h')`);
 assert(!fs.existsSync(path.join(sample,'Example.h'))&&fs.existsSync(path.join(sample,'src/Example.h')));
 await more('src/Example.h',1);await filename('src/驱动/Example.hpp');
 await wait(`document.querySelector('.ck-member-path')?.innerText.includes('src/驱动/Example.hpp')`);
 await more('src/驱动/Example.hpp',1);await filename('Blink.h');
 await wait(`!!document.querySelector('dialog[open] [role=alert]')`);
 assert.equal(fs.readFileSync(path.join(sample,'Blink.h'),'utf8'),fs.readFileSync(path.join(sourceDir,'Blink.h'),'utf8'));
 await click('dialog[open] [aria-label="取消"]');
 await more('src/驱动/Example.hpp',2);await click('dialog[open] [aria-label="取消"]');
 assert(fs.existsSync(path.join(sample,'src/驱动/Example.hpp')));
 const external=path.join(sample,'src/驱动/Example.hpp');
 fs.writeFileSync(external,'// externally updated\n');
 await client.evaluate(`document.querySelector('${content}').focus()`);
 await client.input('Input.insertText',{text:'// editor draft'});
 await wait(`document.querySelector('${bench} .ck-member-primary')?.disabled===false`);
 await click(`${bench} .ck-member-primary`);
 await wait(`document.querySelector('${bench} [role=alert]')?.innerText.includes('外部修改')`);
 assert.equal(fs.readFileSync(external,'utf8'),'// externally updated\n');
 assert((await client.evaluate(`document.querySelector('${content}').innerText`)).includes('// editor draft'));
 await click(`${bench} [aria-label="关闭文件编辑器"]`);
 await wait(`document.querySelector('dialog[open] .ck-member-primary')?.innerText==='放弃修改'`);
 await click('dialog[open] .ck-member-primary');
 await wait(`!document.querySelector('dialog[open]')`);
 await more('src/驱动/Example.hpp',2);await click('dialog[open] .ck-member-primary');
 await wait(`!document.querySelector('.ck-tree-leaf[title="src/驱动/Example.hpp"]')`);
 assert(!fs.existsSync(path.join(sample,'src/驱动/Example.hpp')));
 for(const label of ['cold','same','header']){
  if(label==='header'){
   const header=path.join(sample,'src/Timing.h'),newText=fs.readFileSync(header,'utf8').replace('500','250').replace(/\r\n/g,'\n');
   await file('src/Timing.h');
   await wait(`document.querySelector('${content}')?.innerText.includes('500')`);
   await client.evaluate(`document.querySelector('${content}').focus()`);
   for(const type of ['keyDown','keyUp'])await client.input('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',windowsVirtualKeyCode:65,modifiers:2});
   await client.input('Input.insertText',{text:newText});
   await wait(`document.querySelector('${bench} .ck-member-primary')?.disabled===false`);
   await file('Blink.cpp');await wait(`document.querySelector('${content}')?.innerText.includes('pinMode')`);
   fs.writeFileSync(path.join(evidence,'explorer-tabs.png'),await client.screenshot());
   await file('src/Timing.h');await wait(`document.querySelector('${content}')?.innerText.includes('250')`);
   await click(`${bench} [aria-label="关闭文件编辑器"]`);
   await wait(`document.querySelector('dialog[open] [role=alert]')?.innerText.includes('尚未保存')`);
   await click('dialog[open] [aria-label="取消"]');
   await click(`${bench} .ck-member-primary`);
   await wait(`document.querySelector('${bench} .ck-member-primary')?.disabled===true && !document.querySelector('${bench} .ck-source-dirty')`);
   assert.equal(fs.readFileSync(header,'utf8').replace(/\r\n/g,'\n'),newText);
   await click(`${bench} [aria-label="关闭文件编辑器"]`);
  }
  const at=performance.now();
  const output=JSON.parse(await call('compile_sketch',{code,fqbn,projectPath:entry,projectId:entry,runId:randomUUID(),silent:false}));
  const wallMs=performance.now()-at;
  const r=JSON.parse(fs.readFileSync(path.join(output.path,'native-graph-receipt.json')));
  assert.equal(r.projectFiles.length,3);assert(r.success);const hex=r.artifacts.find(a=>a.name==='sketch.ino.hex').sha256;
  if(label==='same'){assert(r.noOpFastPath?.hit);assert.equal(r.counts.CompileGCC,0);assert.equal(hex,rows.find(x=>x.label==='cold').hex);}
  if(label==='header'){assert.equal(r.counts.CompileGCC,1);assert.notEqual(hex,rows.find(x=>x.label==='cold').hex);}
  rows.push({label,wallMs,compile:r.counts.CompileGCC,link:r.counts.Linker,hex});console.log(rows.at(-1));
 }
 if(!process.env.CK_FOLDER_COMPILE_ONLY){
 const prepared=JSON.parse(await call('observe_upload_preparation',{code,fqbn,projectPath:entry,projectId:entry,runId:randomUUID(),qualificationToken:process.env.CK_FORGE_NATIVE_RELINK_QUALIFICATION_TOKEN}));
 assert(prepared.artifactManifestValidated&&prepared.toolchainIdentityRevalidated&&!prepared.uploadPerformed);
 const r=JSON.parse(fs.readFileSync(path.join(prepared.path,'native-graph-receipt.json')));assert(r.noOpFastPath?.hit);
 assert.equal(r.artifacts.find(a=>a.name==='sketch.ino.hex').sha256,rows.at(-1).hex);
 rows.push({label:'upload-preparation',wallMs:prepared.preparationMs,compile:r.counts.CompileGCC,link:r.counts.Linker,uploadPerformed:false});
 }
 const highlight=rows.find(x=>x.label==='highlight');assert.equal(highlight.colors.LED_BUILTIN,highlight.expectedConstant);
 fs.writeFileSync(path.join(evidence,'report.json'),JSON.stringify(rows,null,2));console.log('PASS '+evidence);
}finally{client.close();}
