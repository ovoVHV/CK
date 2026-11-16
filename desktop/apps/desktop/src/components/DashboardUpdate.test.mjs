import assert from 'node:assert/strict';
import test from 'node:test';
import fs from 'node:fs/promises';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React, {act} from 'react';
import {createRoot} from 'react-dom/client';
import {fileURLToPath} from 'node:url';

const dom=new JSDOM('<!doctype html><div id="root"></div>',{url:'http://localhost'});
for(const name of ['window','document','HTMLElement','Event','MouseEvent'])globalThis[name]=dom.window[name];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;
const translations=JSON.parse(await fs.readFile(new URL('../locales/zh-CN/common.json',import.meta.url),'utf8')).updates;
globalThis.__updateTranslate=(key,options={})=>String(translations[key.replace('updates.','')]||key).replace('{{version}}',options.version||'');
const output=new URL(`.update-test-${process.pid}.mjs`,import.meta.url);
const result=await build({entryPoints:[fileURLToPath(new URL('./DashboardUpdate.tsx',import.meta.url))],bundle:true,write:false,format:'esm',platform:'node',jsx:'automatic',external:['react','react/jsx-runtime'],plugins:[{name:'mock-native',setup(b){
 b.onResolve({filter:/^(@tauri-apps\/api\/(core|event)|react-i18next|lucide-react)$/},a=>({path:a.path,namespace:'mock'}));
 b.onLoad({filter:/.*/,namespace:'mock'},a=>({contents:a.path.endsWith('/core')?'export const invoke=(...a)=>globalThis.__updateInvoke(...a)':a.path.endsWith('/event')?'export const listen=async(n,f)=>{globalThis.__updateProgress=f;return()=>{globalThis.__updateProgress=null}}':a.path==='react-i18next'?'export const useTranslation=()=>({t:globalThis.__updateTranslate})':'export const Download=()=>null,RefreshCw=()=>null,X=()=>null'}));
}}]});
await fs.writeFile(output,result.outputFiles[0].contents);
const {useDashboardUpdate}=await import(output.href);
function Probe(){const u=useDashboardUpdate();return React.createElement(React.Fragment,null,u.settings,u.dialog);}
let root,calls,suppressed=false,checkResult={version:'9.1.0-alpha.25',notes:'测试说明',size:100},checkError=null;
const setup=async()=>{
 calls=[];
 globalThis.__updateInvoke=async(name,args)=>{
  calls.push([name,args]);
  if(name==='app_update_status')return{currentVersion:'9.1.0-alpha.24',suppressReminders:suppressed};
  if(name==='app_update_preferences'){suppressed=args.suppressReminders;return;}
  if(name==='app_update_check'){if(checkError)throw Error(checkError);return checkResult;}
 };
 root=createRoot(document.getElementById('root'));
 await act(async()=>root.render(React.createElement(Probe)));
};
const click=async(selector)=>{const el=document.querySelector(selector);assert.ok(el,selector);await act(async()=>el.click());};
const cleanup=async()=>{if(root){await act(async()=>root.unmount());root=null;}};
test('automatic reminder requires download consent; suppression persists and manual check still works',async()=>{
 try {
  await setup(); assert.ok(document.querySelector('[data-ck-role="software-update-dialog"]'));
  assert.equal(calls.filter(c=>c[0]==='app_update_download').length,0);
  await click('[data-ck-role="suppress-update-reminders"]');assert.equal(suppressed,true);
  await cleanup();await setup();assert.equal(calls.filter(c=>c[0]==='app_update_check').length,0);
  assert.equal(document.querySelector('[data-ck-role="software-update-dialog"]'),null);
  await click('[data-ck-role="check-software-update"]');
  assert.deepEqual(calls.find(c=>c[0]==='app_update_check')[1],{manual:true});
  await click('[data-ck-role="download-software-update"]');
  assert.ok(document.querySelector('[data-ck-role="install-software-update"]'));
  assert.equal(calls.filter(c=>c[0]==='app_update_install').length,0);
  await click('[data-ck-role="install-software-update"]');assert.equal(calls.filter(c=>c[0]==='app_update_install').length,1);
 }finally{await cleanup();}
});
test('manual network failure is visible and does not start download or install',async()=>{
 try {
  checkError='网络中断';await setup();await click('[data-ck-role="check-software-update"]');
  assert.match(document.querySelector('[role="alert"]').textContent,/网络中断/);
  assert.equal(calls.filter(c=>c[0]==='app_update_download'||c[0]==='app_update_install').length,0);
 }finally{checkError=null;await cleanup();}
});
test('leaving home revokes native permission and ignores a late response',async()=>{
 try{
  let resolve;checkResult=new Promise(r=>{resolve=r});await setup();
  await click('[data-ck-role="check-software-update"]');await cleanup();
  assert.deepEqual(calls.filter(c=>c[0]==='app_update_home').at(-1)[1],{home:false});
  await act(async()=>resolve({version:'9.1.0-alpha.25',notes:'late',size:100}));
  assert.equal(document.querySelector('[data-ck-role="software-update-dialog"]'),null);
 }finally{await cleanup();}
});
test.after(async()=>{await cleanup();await fs.unlink(output);dom.window.close();});
