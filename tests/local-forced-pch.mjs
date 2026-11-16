import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {asyncRun} from '../src/discovery.mjs';import {sha} from '../src/native/plan.mjs';
const r=JSON.parse(fs.readFileSync(process.argv[2])).runs.at(-1).result,dir=process.argv[3];fs.mkdirSync(dir,{recursive:true});
process.env.SOURCE_DATE_EPOCH='1792800000';process.env.TZ='UTC';
const report={status:'RUNNING',runs:[],checks:[]};const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
async function run(label,args,cwd){const x=await asyncRun(args,cwd);report.runs.push({label,args,...x});save();assert.equal(x.code,0,x.stderr.slice(-2000));console.log(label+' '+x.elapsedMs.toFixed(1));return x;}
for(const name of ['Esp.cpp','WiFi.cpp']){
 const row=r.compileDatabase.find(x=>path.basename(x.file)===name),header=path.join(path.dirname(row.file),name==='Esp.cpp'?'Arduino.h':'WiFi.h');
 const wrapper=path.join(dir,name+'.hpp');fs.writeFileSync(wrapper,'#include '+JSON.stringify(header.replaceAll('\\','/'))+'\n');
 const original=row.arguments.map(a=>a.startsWith('@')&&path.basename(a.slice(1))==='file_opts'?'@'+path.join(path.dirname(path.dirname(r.artifacts[0].file)),'graph',name==='Esp.cpp'?'core-file-options.rsp':'normal-file-options.rsp'):a);
 const base=original.filter(a=>!['-c','-MMD',row.file].includes(a));base.splice(base.indexOf('-o'),2);
 await run(name+'-make-pch',[...base,'-x','c++-header','-MD','-MF',wrapper+'.d',wrapper,'-o',wrapper+'.gch'],row.directory);
 const ref=original.slice();ref[ref.indexOf('-o')+1]=path.join(dir,name+'.reference.o');await run(name+'-reference',ref,row.directory);
 const fast=[...original,'-include',wrapper];fast[fast.indexOf('-o')+1]=path.join(dir,name+'.pch.o');await run(name+'-pch',fast,row.directory);
 const equal=sha(fs.readFileSync(path.join(dir,name+'.reference.o')))===sha(fs.readFileSync(path.join(dir,name+'.pch.o')));report.checks.push({name,equal});save();console.log(JSON.stringify({name,equal}));
 await run(name+'-consumption',[...fast,'-H'],row.directory);
}
report.status=report.checks.every(x=>x.equal)?'PASS':'FAIL';save();
