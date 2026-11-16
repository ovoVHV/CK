import fs from 'node:fs';import path from 'node:path';import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]||'local/alpha42-evidence');
const finalDesktopSha256=createHash('sha256').update(fs.readFileSync('local/alpha42-delivery-preview/CK-V9-Preview.exe')).digest('hex');
const reports=fs.readdirSync(root).filter(n=>/^ai-phase5-(candidate|heartbeat|serial)-\d+$/.test(n)).sort().flatMap(n=>{
const file=path.join(root,n,'report.json');if(!fs.existsSync(file))return [];
const r=JSON.parse(fs.readFileSync(file,'utf8')),trace=r.modelTrace||[];
return [{file,group:n.split('-')[2],status:r.status,desktopSha256:r.desktopSha256,finalRelease:r.desktopSha256===finalDesktopSha256,prompt:r.prompt,budget:r.budget,
requests:trace.length,inputTokens:trace.reduce((s,t)=>s+(t.inputTokens||0),0),outputTokens:trace.reduce((s,t)=>s+(t.outputTokens||0),0),usageComplete:trace.length>0&&trace.every(t=>Number.isInteger(t.inputTokens)&&Number.isInteger(t.outputTokens)),taskWallMs:r.taskWallMs,error:r.error||null,
behavior:fs.existsSync(path.join(root,n,'independent-behavior.json'))?JSON.parse(fs.readFileSync(path.join(root,n,'independent-behavior.json'),'utf8')).status:null,
originalPreservedOnFailure:r.status==='PASS'?null:r.before===r.after,applied:r.ipc?.some(i=>i.command==='compile_sketch')||false}];});
const median=xs=>{const s=[...xs].sort((a,b)=>a-b);return s.length?s.length%2?s[Math.floor(s.length/2)]:(s[s.length/2-1]+s[s.length/2])/2:null;};
const groups=Object.fromEntries(['candidate','heartbeat','serial'].map(group=>{const rs=reports.filter(r=>r.group===group&&r.finalRelease);return [group,{samples:rs.length,passed:rs.filter(r=>r.status==='PASS'&&r.behavior==='passed').length,inputMedian:median(rs.map(r=>r.inputTokens)),outputMedian:median(rs.map(r=>r.outputTokens))}];}));
const final=reports.filter(r=>r.finalRelease);const sampleMatrixComplete=groups.candidate.samples===3&&groups.heartbeat.samples===1&&groups.serial.samples===1;
const qualified=sampleMatrixComplete&&final.every(r=>r.status==='PASS'&&r.behavior==='passed'&&r.usageComplete);
const result={scope:'Limited real model samples and fixed independent AVR firmware assertions; no universal requirements correctness, Token savings or hardware claim. Failed attempts retained.',finalDesktopSha256,sampleMatrixComplete,qualified,groups,reports};
fs.writeFileSync(path.join(root,'phase5-results.json'),JSON.stringify(result,null,2));console.log(JSON.stringify({finalDesktopSha256,sampleMatrixComplete,qualified,groups},null,2));
