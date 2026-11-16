import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
const [input,output]=process.argv.slice(2);if(!input||!output)throw Error('Usage: report-avr-performance INPUT_JSON OUTPUT_JSON');
const bytes=fs.readFileSync(input),r=JSON.parse(bytes);
const summarize=values=>{const a=[...values].sort((a,b)=>a-b);return a.length?{count:a.length,minMs:a[0],medianMs:(a[Math.floor((a.length-1)/2)]+a[Math.floor(a.length/2)])/2,maxMs:a.at(-1),allMs:values}:null;};
const summary={engineVersion:r.engineVersion,correctness:r.status,performanceQualified:false,machine:r.machine,boundaries:r.boundaries,filesystemCachePurged:r.filesystemCachePurged,source:{file:path.resolve(input),sha256:createHash('sha256').update(bytes).digest('hex')},targets:r.targets.map(t=>{
 const samples={};for(const mode of ['baseline','reference','properties-only','direct-only','candidate','official'])for(const kind of ['cold','edit','same']){
  const s=summarize(t.runs.filter(x=>x.label.startsWith(mode+'-'+kind+'-')).map(x=>x.wallMs));if(s)samples[mode+'-'+kind]=s;
 }
 const comparisons={};for(const kind of ['cold','edit','same']){const a=samples['reference-'+kind],b=samples['candidate-'+kind];if(a&&b)comparisons[kind]={referenceCount:a.count,candidateCount:b.count,savedMs:a.medianMs-b.medianMs,reductionPercent:100*(1-b.medianMs/a.medianMs)};}
 return {fqbn:t.fqbn,status:t.status,initialUnwarmed:t.runs.filter(x=>x.label==='initial-unwarmed').map(x=>x.wallMs),samples,comparisons};
})};
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify(summary,null,2));
console.log(JSON.stringify(summary.targets.map(t=>({fqbn:t.fqbn,comparisons:t.comparisons})),null,2));
