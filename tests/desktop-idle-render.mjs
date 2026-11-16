import fs from 'node:fs';import path from 'node:path';import {execFileSync} from 'node:child_process';
import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,'')),out=path.join(config.paths.evidenceRoot,'idle-render-'+Date.now()+'.json');
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const command=`$all=Get-CimInstance Win32_Process;$ids=[System.Collections.Generic.HashSet[uint32]]::new();[void]$ids.Add(${Number(process.env.CK_V9_DESKTOP_PID)});for($i=0;$i -lt 5;$i++){foreach($p in $all){if($ids.Contains($p.ParentProcessId)){[void]$ids.Add($p.ProcessId)}}};@($all | Where-Object {$ids.Contains($_.ProcessId) -and $_.CommandLine -match '--type=(gpu-process|renderer)'} | ForEach-Object {@{id=$_.ProcessId;kind=$matches[1]}}) | ConvertTo-Json -Compress`;
const procs=JSON.parse(execFileSync(ps,['-NoProfile','-Command',command],{encoding:'utf8',windowsHide:true}));
const readCpu=()=>JSON.parse(execFileSync(ps,['-NoProfile','-Command',`@(${procs.map(p=>`@{id=${p.id};cpu=(Get-Process -Id ${p.id}).CPU}`).join(',')}) | ConvertTo-Json -Compress`],{encoding:'utf8',windowsHide:true}));
const pause=ms=>new Promise(r=>setTimeout(r,ms));const report={boundary:'idle desktop process CPU, not compile latency',procs,samples:[]};
const c=await connectDesktop();try{
 for(const [label,css] of [['original',''],['pulse-off','.animate-pulse { animation: none !important; }'],['blur-off','header { backdrop-filter: none !important; }'],['both','.animate-pulse { animation: none !important; } header { backdrop-filter: none !important; }'],['restored','']]){
  await c.evaluate(`(()=>{let e=document.getElementById('ck-render-test');if(!e){e=document.createElement('style');e.id='ck-render-test';document.head.appendChild(e)}e.textContent=${JSON.stringify(css)};return true})()`);
  await pause(1500);const before=readCpu(),at=performance.now();await pause(8000);const after=readCpu(),wallMs=performance.now()-at;
  const sample={label,wallMs,processes:after.map(p=>({id:p.id,cpuSeconds:p.cpu-before.find(x=>x.id===p.id).cpu}))};report.samples.push(sample);fs.writeFileSync(out,JSON.stringify(report,null,2));console.log(JSON.stringify(sample));
 }
}finally{await c.evaluate("document.getElementById('ck-render-test')?.remove()");c.close();console.log('REPORT '+out);}
