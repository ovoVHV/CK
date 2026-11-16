import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve(process.argv[2]||'local/alpha41-evidence');
const finalDesktopSha256=createHash('sha256').update(fs.readFileSync('local/alpha41-delivery-preview/CK-V9-Preview.exe')).digest('hex');
const reports=fs.readdirSync(root).filter(n=>/^ai-phase4-(baseline|candidate|heartbeat|serial)-\d+$/.test(n)).sort().flatMap(n=>{
 const file=path.join(root,n,'report.json');if(!fs.existsSync(file))return [];
 const r=JSON.parse(fs.readFileSync(file,'utf8')),trace=r.modelTrace||[],calls=trace.flatMap(t=>t.toolCalls||[]);
 return [{file,group:n.split('-')[2],status:r.status,desktopSha256:r.desktopSha256,finalRelease:r.desktopSha256===finalDesktopSha256,prompt:r.prompt,variant:r.variant||'threshold',budget:r.budget,
  requests:trace.length,inputTokens:trace.reduce((s,t)=>s+(t.inputTokens||0),0),outputTokens:trace.reduce((s,t)=>s+(t.outputTokens||0),0),
  inputComplete:trace.every(t=>Number.isInteger(t.inputTokens)),workspaceReads:calls.filter(t=>t.function.name==='read_workspace').map(t=>JSON.parse(t.function.arguments)),
  codeReads:calls.filter(t=>t.function.name==='read_project_code').length,taskWallMs:r.taskWallMs,error:r.error||null,
  behavior:fs.existsSync(path.join(root,n,'independent-behavior.json'))?JSON.parse(fs.readFileSync(path.join(root,n,'independent-behavior.json'),'utf8')).status:null}];
});
const median=rows=>{const s=[...rows].sort((a,b)=>a-b),i=Math.floor(s.length/2);return s.length%2?s[i]:(s[i-1]+s[i])/2;};
const groups=Object.fromEntries(['baseline','candidate','heartbeat','serial'].map(g=>{const rows=reports.filter(r=>r.group===g&&(g==='baseline'||r.finalRelease));return [g,{samples:rows.length,passed:rows.filter(r=>r.status==='PASS').length,inputMedian:rows.length?median(rows.map(r=>r.inputTokens)):null,outputMedian:rows.length?median(rows.map(r=>r.outputTokens)):null,requests:rows.map(r=>r.requests)}];}));
const compare=reports.filter(r=>r.group==='baseline'||r.group==='candidate'&&r.finalRelease);
assert(compare.every(r=>r.prompt===compare[0].prompt&&JSON.stringify(r.budget)===JSON.stringify(compare[0].budget)),'Matched tasks must have identical prompts and budgets');
const completeMatchedSamples=groups.baseline.samples===3&&groups.candidate.samples===3&&compare.every(r=>r.inputComplete);
const qualified=completeMatchedSamples&&groups.baseline.passed===3&&groups.candidate.passed===3&&compare.every(r=>r.behavior==='passed');
const finalFailures=reports.filter(r=>r.finalRelease&&r.status!=='PASS').map(r=>({file:r.file,group:r.group,error:r.error,behavior:r.behavior}));
const result={scope:'Limited real-model samples; no universal stability or billing claim. Wall time not compared because baseline overlapped native EXE build. All pre-fix failures retained; finalRelease identifies the delivered binary. Unsuccessful attempts remain in raw medians and cannot support a successful-task Token savings claim.',finalDesktopSha256,completeMatchedSamples,qualified,groups,finalFailures,
 inputMedianReductionPercent:qualified?100*(1-groups.candidate.inputMedian/groups.baseline.inputMedian):null,reports};
fs.writeFileSync(path.join(root,'phase4-comparison.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify({...result,reports:reports.map(({prompt,...r})=>r)},null,2));
