import assert from 'node:assert/strict';
import test from 'node:test';
import {readFile} from 'node:fs/promises';
import {createRequire} from 'node:module';
import ts from 'typescript';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {JSDOM} from 'jsdom';
const require=createRequire(import.meta.url);
const source=await readFile(new URL('./CoreManagerModal.tsx',import.meta.url),'utf8');
function compile(text,stubs={}){const result=ts.transpileModule(text,{compilerOptions:{jsx:ts.JsxEmit.ReactJSX,module:ts.ModuleKind.CommonJS,target:ts.ScriptTarget.ES2020}});const exports={};new Function('require','exports',result.outputText)(n=>stubs[n]??require(n),exports);return exports;}
const model=compile(await readFile(new URL('./coreCatalog.ts',import.meta.url),'utf8'));
const {AVAILABLE_CORES,catalogFor,sourceKey,selectedVersion,installChoice}=model;
const esp=AVAILABLE_CORES.find(c=>c.id==='esp32:esp32'),avr=AVAILABLE_CORES.find(c=>c.id==='arduino:avr');
const response=(core,url,versions,latest=versions[0])=>({core_id:core.id,index_url:url,versions,latest,checked_at:1794182400});
test('new releases are selectable; the CN accelerated version remains the default',()=>{
 const states={
  [sourceKey(esp.id,esp.index_url)]:{data:response(esp,esp.index_url,['3.3.13','3.3.6'])},
  [sourceKey(esp.id,esp.mirrorIndexUrl)]:{data:response(esp,esp.mirrorIndexUrl,['3.3.13-cn','3.3.6-cn'])}};
 const catalog=catalogFor(esp,states);
 assert.equal(catalog.latest,'3.3.13');assert.equal(selectedVersion(undefined,catalog),'3.3.6-cn');
 assert.equal(selectedVersion('3.3.13',catalog),'3.3.13');
 assert.deepEqual(installChoice(esp,catalog,'3.3.13-cn',''),{version:'3.3.13-cn',indexUrl:esp.mirrorIndexUrl});
 assert.equal(installChoice(esp,catalog,'3.3.13','').indexUrl,esp.index_url);
});
test('custom sources cannot inherit unrelated entries or silently install latest',()=>{
 const url='https://example.test/custom.json';
 const states={[sourceKey(esp.id,esp.index_url)]:{data:response(esp,esp.index_url,['3.3.6'])},[sourceKey(esp.id,url)]:{data:response(esp,url,['4.0.0'])}};
 const catalog=catalogFor(esp,states,url);
 assert.deepEqual(catalog.entries.map(e=>e.version),['4.0.0']);assert.equal(selectedVersion(undefined,catalog),'');
 assert.throws(()=>installChoice(esp,catalog,'3.3.6','',url));
 assert.equal(installChoice(esp,catalog,'custom','4.1.0',url).indexUrl,url);
});
test('acceleration labels agree with engine routing',async()=>{
 const {platformVersionSupported,AVR_PLATFORMS}=await import('../../../../../src/targets.mjs');
 for(const core of AVAILABLE_CORES)for(const v of core.accelerationVersions||[])assert.equal(platformVersionSupported(core.id.split(':')[1],v),true);
 assert.deepEqual(avr.accelerationVersions,Object.keys(AVR_PLATFORMS));
 assert.ok(!AVAILABLE_CORES.find(c=>c.id==='rp2040:rp2040').accelerationVersions);
});
test('modal fetches sources independently, defaults to CN, ignores stale responses and installs exact selections',async()=>{
 const dom=new JSDOM('<div id="app"></div>',{url:'http://localhost/'});
 globalThis.window=dom.window;globalThis.document=dom.window.document;globalThis.IS_REACT_ACT_ENVIRONMENT=true;
 const requests=[],installs=[];
 const invoke=(command,args)=>{if(command==='get_installed_cores')return Promise.resolve([]);assert.equal(command,'get_core_versions');return new Promise((resolve,reject)=>requests.push({...args,resolve,reject}));};
 const {CoreManagerModal}=compile(source,{'./coreCatalog':model,'@tauri-apps/api/core':{invoke},'../contexts/DialogContext':{useDialog:()=>({alert:m=>{throw Error(JSON.stringify(m));}})},'react-i18next':{useTranslation:()=>({t:(k,args)=>k+(args?JSON.stringify(args):'')})},'lucide-react':Object.fromEntries(['Loader2','Trash2','X','Package','DownloadCloud','RefreshCw'].map(k=>[k,()=>null]))});
 const root=createRoot(document.getElementById('app'));
 const props={isOpen:true,onClose(){},onInstall:async(...args)=>installs.push(args),onUninstall:async()=>{}};
 const card=id=>document.querySelector(`[data-core-id="${id}"]`),select=id=>card(id).querySelector('select');
 const refresh=()=>[...document.querySelectorAll('button')].find(b=>b.textContent==='core.catalog.refresh');
 try{
  await act(async()=>root.render(React.createElement(CoreManagerModal,props)));
  await act(async()=>new Promise(r=>setTimeout(r,400)));assert.equal(requests.length,5);
  await act(async()=>requests.find(r=>r.indexUrl===esp.index_url).resolve(response(esp,esp.index_url,['3.3.13','3.3.6'])));
  assert.match(card(esp.id).textContent,/3\.3\.13/);
  await act(async()=>requests.find(r=>r.indexUrl===esp.mirrorIndexUrl).resolve(response(esp,esp.mirrorIndexUrl,['3.3.13-cn','3.3.6-cn'])));
  assert.equal(select(esp.id).value,'3.3.6-cn');
  assert.equal(card(esp.id).querySelector('input').value,esp.mirrorIndexUrl);
  await act(async()=>[...card(esp.id).querySelectorAll('button')].find(b=>b.textContent==='core.download').click());
  assert.deepEqual(installs,[[esp.id,'3.3.6-cn',esp.mirrorIndexUrl]]);
  await act(async()=>{select(esp.id).value='3.3.13-cn';select(esp.id).dispatchEvent(new window.Event('change',{bubbles:true}));});
  await act(async()=>refresh().click());const older=requests.filter(r=>r.indexUrl===esp.index_url).at(-1);
  await act(async()=>refresh().click());const newer=requests.filter(r=>r.indexUrl===esp.index_url).at(-1);
  await act(async()=>newer.resolve(response(esp,esp.index_url,['3.3.14','3.3.6'])));
  await act(async()=>older.resolve(response(esp,esp.index_url,['3.3.6'])));
  assert.match(card(esp.id).textContent,/3\.3\.14/);assert.equal(select(esp.id).value,'3.3.13-cn');
  await act(async()=>refresh().click());
  await act(async()=>requests.filter(r=>r.indexUrl===esp.index_url).at(-1).reject(new Error('offline')));
  assert.match(card(esp.id).textContent,/core.catalog.stale/);assert.match(card(esp.id).textContent,/3\.3\.14/);
  await act(async()=>requests.filter(r=>r.indexUrl===avr.index_url).at(-1).reject(new Error('offline')));
  assert.match(card(avr.id).textContent,/core.catalog.failed/);assert.equal(select(avr.id).value,'');
  await act(async()=>root.render(React.createElement(CoreManagerModal,{...props,isOpen:false})));
  await act(async()=>requests.find(r=>r.indexUrl===avr.index_url).resolve(response(avr,avr.index_url,['1.8.8'])));
  assert.equal(document.querySelector('select'),null);
 }finally{await act(async()=>root.unmount());dom.window.close();}
});
