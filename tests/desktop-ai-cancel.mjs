import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID,createHash} from 'node:crypto';import {spawnSync} from 'node:child_process';import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const launch=JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,''));
const report={status:'RUNNING',desktopSha256:launch.sha256,hardwareUploaded:false};
const c=await connectDesktop(),runId=randomUUID(),candidateId=randomUUID();
const delay=ms=>new Promise(r=>setTimeout(r,ms));
const processList=()=>{const dir=path.basename(launch.session).replaceAll("'","''");const script=`@(Get-CimInstance Win32_Process | Where-Object { $_.Name -match '(avr-g\\+\\+|cc1plus)' -and $_.CommandLine -like '*${dir}*' } | Select-Object ProcessId,ParentProcessId,Name) | ConvertTo-Json -Compress`;const p=spawnSync('powershell.exe',['-NoProfile','-Command',script],{encoding:'utf8',windowsHide:true,timeout:15000});assert.equal(p.status,0);const data=JSON.parse(p.stdout.replace(/^\uFEFF/,'').trim()||'[]');return Array.isArray(data)?data:[data];};
try{
 const source='#include <Arduino.h>\n'+Array.from({length:12000},(_,i)=>`int candidate_function_${i}(int x) { return (x*${i+1}+${i}) ^ ${i+3}; }`).join('\n')+'\nvoid setup(){}\nvoid loop(){}\n';
 await c.evaluate(`(()=>{window.__candidateCancelDone=false;window.__TAURI_INTERNALS__.invoke('compile_ai_candidate',${JSON.stringify({candidateId,runId,code:source,fqbn:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreVersion:'1.8.8',sourceMapJson:''})}).then(value=>{window.__candidateCancelValue=value;window.__candidateCancelDone=true;},error=>{window.__candidateCancelError=String(error);window.__candidateCancelDone=true;});return true})()`);
 let children=[];const started=Date.now();while(Date.now()-started<90000){children=processList();if(children.length)break;if(await c.evaluate('window.__candidateCancelDone'))break;await delay(100);}
 assert(children.length,'Must observe real compiler processes before cancellation');report.observedCompilerProcesses=children;
 const cancelStarted=Date.now();report.cancelResult=await c.evaluate(`window.__TAURI_INTERNALS__.invoke('cancel_foreground_build',{runId:${JSON.stringify(runId)}})`);report.cancelMs=Date.now()-cancelStarted;
 for(let i=0;i<100&&!await c.evaluate('window.__candidateCancelDone');i++)await delay(100);
 assert(await c.evaluate('window.__candidateCancelDone'));report.result=await c.evaluate('window.__candidateCancelError||window.__candidateCancelValue');assert.match(report.result,/cancel/i);
 const alive=processList();assert.equal(alive.length,0,'Compiler processes must be reaped');report.remainingCompilerProcesses=alive;
 const hostPath=process.env.CK_V9_CONFIG;assert(hostPath&&hostPath.startsWith(launch.session));const hostBytes=fs.readFileSync(hostPath);
 try{
  const host=JSON.parse(hostBytes.toString('utf8').replace(/^\uFEFF/,''));host.enabled=false;fs.writeFileSync(hostPath,JSON.stringify(host));
  const fallbackId=randomUUID();const raw=await c.evaluate(`window.__TAURI_INTERNALS__.invoke('compile_ai_candidate',${JSON.stringify({candidateId:fallbackId,runId:randomUUID(),code:'void setup(){}\nvoid loop(){}\n',fqbn:'arduino:avr:uno',boardPackageId:'arduino:avr:uno',coreVersion:'1.8.8',sourceMapJson:''})})`);
  const value=JSON.parse(raw);report.compatibilityFallback=value;assert(value.ok&&value.artifactCount>0);
  const isolatedRoot=path.join(launch.session,'CK_Builds','ai',fallbackId.replaceAll('-',''));assert(fs.existsSync(isolatedRoot),'Compatibility root must be isolated');const names=fs.readdirSync(isolatedRoot,{recursive:true});assert(names.some(p=>p.endsWith('.hex')));assert(names.some(p=>p.endsWith(path.join('src','rel','sketch','sketch.ino'))));report.compatibilityRoot=isolatedRoot;report.compatibilityFiles=names.length;
 }finally{fs.writeFileSync(hostPath,hostBytes);}
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;try{await c.evaluate(`window.__TAURI_INTERNALS__.invoke('cancel_foreground_build',{runId:${JSON.stringify(runId)}})`);}catch{}}
finally{c.close();fs.writeFileSync(path.join(config.paths.evidenceRoot,`candidate-process-cancel-${Date.now()}.json`),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));}
