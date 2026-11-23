import fs from 'node:fs';
import path from 'node:path';
import {randomUUID} from 'node:crypto';
import assert from 'node:assert/strict';

export async function editorBuilder(client,config,board){
 const blockId=randomUUID(),file=path.join(config.paths.evidenceRoot,blockId+'.ck');
 fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,
  name:'Core admission',board,board_package_id:board.split(':').slice(0,3).join(':'),options:'{}',
  xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:blockId,x:80,y:80}]}})}));
 const open={requestId:randomUUID(),path:file,source:'performance-test'};
 await client.evaluate(`(async()=>{for(let i=0;i<220;i++){const b=document.querySelector('[data-ck-role="edit-source"]');
 if(b&&!b.disabled&&document.querySelector('[data-id="${blockId}"]')){b.click();return}
 if(i%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(open)}});
 await new Promise(r=>setTimeout(r,250))}throw Error('Source editor did not open')})()`);
 const requests=path.join(path.dirname(config.paths.workspaceRoot),'requests');
 return async code=>{
  await client.evaluate(`(async()=>{for(let i=0;i<100;i++){const e=document.querySelector('.ck-source-pane .cm-content');if(e){e.focus();return}await new Promise(r=>setTimeout(r,50))}throw Error('Missing editor')})()`);
  for(const type of ['keyDown','keyUp'])await client.input('Input.dispatchKeyEvent',{type,key:'a',code:'KeyA',modifiers:2,windowsVirtualKeyCode:65});
  await client.input('Input.insertText',{text:code});
  const previous=new Set(fs.existsSync(requests)?fs.readdirSync(requests):[]);
  const elapsed=await client.evaluate(`(async()=>{await new Promise(r=>setTimeout(r,250));const b=document.querySelector('[data-ck-role="build-compile-action"]');
  if(!b||b.disabled)throw Error('Compile unavailable');const at=performance.now();b.click();let started=false;
  while(performance.now()-at<240000){if(document.querySelector('[data-ck-role="compile-progress-overlay"]'))started=true;
   else if(started&&!b.disabled)return performance.now()-at;await new Promise(r=>setTimeout(r,40))}
  throw Error('Compile never completed')})()`);
  const dirs=fs.readdirSync(requests).filter(n=>!previous.has(n)).map(n=>path.join(requests,n,'artifacts','sketch')).filter(d=>fs.existsSync(path.join(d,'native-graph-host-receipt.json')));
  assert.equal(dirs.length,1,'Expected one verified export for the button press');
  return {success:true,wallMs:elapsed,value:JSON.stringify({path:dirs[0]})};
 };
}
