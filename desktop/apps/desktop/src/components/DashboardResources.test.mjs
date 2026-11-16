import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
import {JSDOM} from 'jsdom';
import React,{act} from 'react';
import {createRoot} from 'react-dom/client';
const dom=new JSDOM('<div id="root"></div>',{url:'http://localhost'});
for(const key of ['window','document','HTMLElement','Element','Node','localStorage'])globalThis[key]=dom.window[key];
globalThis.IS_REACT_ACT_ENVIRONMENT=true;window.__TAURI_INTERNALS__={};
const messages=JSON.parse(await fs.readFile(new URL('../locales/zh-CN/common.json',import.meta.url),'utf8'));
globalThis.__resourceT=(key,options={})=>{
 let value=key.split('.').reduce((obj,k)=>obj?.[k],messages);
 if(typeof value!=='string')value=key;
 return value.replace(/\{\{(\w+)\}\}/g,(_,k)=>options[k]??'');
};
const output=new URL(`.dashboard-resource-test-${process.pid}.mjs`,import.meta.url);
const blankComponents=['DeviceSelectorModal','AppearanceSettingsModal','DataStorageSettings','DashboardProjectStatus','ThemeModeControl'];
await build({entryPoints:[fileURLToPath(new URL('./Dashboard.tsx',import.meta.url))],bundle:true,format:'esm',platform:'node',outfile:fileURLToPath(output),packages:'external',jsx:'automatic',plugins:[{name:'dashboard-native-doubles',setup(b){
 b.onResolve({filter:/.*/},a=>{
  if(a.path==='react'||a.path==='react/jsx-runtime')return{path:a.path,external:true};
  if(a.path.includes('HardwareContext')||a.path.includes('DialogContext')||a.path==='react-i18next'||a.path.startsWith('@tauri-apps/')||a.path.endsWith('DashboardUpdate')||a.path.endsWith('project_status_session')||a.path.endsWith('LibraryManagerModal')||blankComponents.some(c=>a.path.endsWith('/'+c)))return{path:a.path,namespace:'mock'};
 });
 b.onLoad({filter:/.*/,namespace:'mock'},a=>{
  let contents='';
  if(a.path.includes('HardwareContext'))contents='export const useHardware=()=>({activePort:null,availableBoards:[]});';
  else if(a.path.includes('DialogContext'))contents='export const useDialog=()=>({confirm:async()=>false,alert:async()=>{}});';
  else if(a.path==='react-i18next')contents='export const useTranslation=()=>({t:globalThis.__resourceT});';
  else if(a.path.endsWith('DashboardUpdate'))contents='export const useDashboardUpdate=()=>({settings:null,dialog:null});';
  else if(a.path.endsWith('project_status_session'))contents='export const useRecentProjectPath=()=>null;';
  else if(a.path.includes('plugin-opener'))contents='export const openUrl=(url)=>globalThis.__resourceOpen(url);';
  else if(a.path.includes('/core'))contents='export const invoke=(...args)=>globalThis.__resourceInvoke(...args);';
  else if(a.path.includes('plugin-dialog'))contents='export const open=async()=>null;';
  else if(a.path.endsWith('LibraryManagerModal'))contents='import React from "react";export default function Library(props){return React.createElement("div",{role:"dialog","aria-label":"Library probe"},React.createElement("button",{onClick:props.onClose},"Close library"));}';
  else contents='export const DashboardProjectStatus=()=>null;export default ()=>null;';
  return{contents,loader:'js'};
 });
}}],logLevel:'silent'});
const {default:Dashboard}=await import(output.href);await fs.unlink(output);
let root,calls,opened;
async function mount(){calls=[];opened=[];globalThis.__resourceInvoke=async(name,args)=>{calls.push({name,args});return[];};globalThis.__resourceOpen=async url=>{opened.push(url);throw Error('OS browser unavailable');};root=createRoot(document.getElementById('root'));await act(async()=>root.render(React.createElement(Dashboard,{onOpenProject:()=>{},onNewProject:()=>{}})));}
async function click(text){const button=[...document.querySelectorAll('button')].find(b=>b.textContent.trim()===text);assert(button,`Missing button ${text}`);await act(async()=>button.click());}
test('guide and driver navigation uses offline content without refreshing project lists',async()=>{
 await mount();try{
  assert.equal(calls.filter(c=>c.name==='list_projects').length,1);
  await click('使用指南');assert(document.querySelector('[data-ck-role="dashboard-guide"]'));
  await click('连接与驱动');assert(document.querySelector('[data-ck-role="dashboard-drivers"]'));
  assert.equal(calls.filter(c=>c.name==='list_projects'||c.name==='list_community_examples').length,1);
  const panel=document.querySelector('[data-ck-role="dashboard-drivers"]');
  assert.equal(panel.querySelectorAll('img').length,3);
  assert.equal([...panel.querySelectorAll('button')].filter(b=>b.textContent.trim()==='下载驱动 ZIP').length,5);
  await click('不会安装？查看完整图文教程');assert.equal(opened.at(-1),'https://ckswitch.site/drivers/install/');
  await click('下载驱动 ZIP');assert.equal(opened.at(-1),'https://ckswitch.site/downloads/drivers/CH341SER-4.0.ZIP');
  assert.match(document.querySelector('[role="alert"]').textContent,/无法打开浏览器.*https:/s);
  await click('示例工程');assert.equal(calls.filter(c=>c.name==='list_community_examples').length,1);
  assert(document.body.textContent.includes('浏览 CK LAB 示例'));
 }finally{await act(async()=>root.unmount());}
});

test('each chip has a direct package and matching installation guide',async()=>{
 await mount();try{
  await click('连接与驱动');
  const panel=document.querySelector('[data-ck-role="dashboard-drivers"]');
  const expected=[['ch340','ckswitch.site'],['cp210x','www.silabs.com'],['ftdi','www.ftdichip.cn'],['ch343','ckswitch.site'],['pl2303','ckswitch.site']];
  const cards=[...panel.querySelectorAll('article')].filter(c=>c.querySelector('button'));
  assert.equal(cards.length,expected.length);
  for(let i=0;i<cards.length;i++){
   const buttons=cards[i].querySelectorAll('button');
   await act(async()=>buttons[0].click());
   assert.equal(new URL(opened.at(-1)).hostname,expected[i][1]);assert.match(opened.at(-1),/\.zip$/i);
   await act(async()=>buttons[1].click());assert.equal(opened.at(-1),`https://ckswitch.site/drivers/install/#${expected[i][0]}`);
  }
  assert.match(panel.textContent,/silabser\.inf/);
 }finally{await act(async()=>root.unmount());}
});
test('library entry opens a real modal route and inactive placeholder entries are absent',async()=>{
 await mount();try{
  assert(![...document.querySelectorAll('button')].some(b=>b.textContent.trim()==='最近打开'));
  await click('积木与库');await act(async()=>{});
  assert(document.querySelector('[aria-label="Library probe"]'));
  await click('Close library');assert(!document.querySelector('[aria-label="Library probe"]'));
  await click('CK LAB');assert.equal(opened.at(-1),'https://ckswitch.site');
 }finally{await act(async()=>root.unmount());}
});
