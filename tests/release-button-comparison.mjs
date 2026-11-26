import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';

const read = file => JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const median = xs => {
 const sorted = [...xs].sort((a,b)=>a-b), mid=Math.floor(sorted.length/2);
 return sorted.length%2 ? sorted[mid] : (sorted[mid-1]+sorted[mid])/2;
};
export function summarize(directory, baseline, candidate, rounds) {
 assert.notEqual(baseline,candidate);
 const result = {baseline,candidate,rounds,boundary:'Desktop button click to overlay gone and button enabled; fresh CK workspaces, OS file cache uncontrolled',boards:[]};
 for(const [family,target] of [['avr','arduino:avr:uno'],['esp','esp32:esp32:esp32s3']]){
  const raw=new Map([[baseline,[]],[candidate,[]]]);
  const board={target,comparisons:[],scenarios:{}}; result.boards.push(board);
  for(let round=1;round<=rounds;round++){
   const pair=[baseline,candidate].map(version=>{
    const dir=path.join(directory,`${round}-${family}-${version}`),r=read(path.join(dir,'evidence/timings.json'));
    const cfg=read(path.join(dir,'config.json')),launch=read(path.join(dir,'evidence/desktop-launch.json'));
    assert.equal(r.status,'PASS');assert.equal(r.version,version);assert.equal(launch.engineVersion,version);
    assert.equal(r.board,target);assert.ok(r.rows.length && r.rows.every(row=>row.verified && Number.isFinite(row.ms) && row.ms>0));
    raw.get(version).push(r.rows);
    return {r,launch,context:[r.effectiveFqbn,r.jobs,cfg.paths.sysroot,cfg.paths.cliConfig,cfg.paths.userLibraries,cfg.features,cfg.assetValidation,launch.elevated],sources:r.rows.map(row=>[row.scenario,row.source])};
   });
   assert.deepEqual(pair[0].context,pair[1].context,'Different build context');assert.deepEqual(pair[0].sources,pair[1].sources,'Unpaired source or scenario');
   const name=family==='avr'?'sketch.ino.hex':'sketch.ino.bin';
   board.comparisons.push({round,desktopSha256:pair.map(x=>x.launch.sha256),imageHashesIdenticalAcrossSeparateBuildPaths:pair[0].r.rows.every((row,i)=>row.artifacts[name]===pair[1].r.rows[i].artifacts[name])});
  }
  for(const scenario of ['cold','repeat','edit']){
   const stats=version=>{
    const runs=raw.get(version).map(rs=>rs.filter(r=>r.scenario===scenario));
    assert(runs.every(t=>t.length));const rows=runs.flat(),samples=rows.map(r=>r.ms);
    const distinctSources=new Set(rows.map(r=>r.source)).size;
    const p95 = distinctSources>=30 ? [...samples].sort((a,b)=>a-b)[Math.ceil(.95*samples.length)-1] : null;
    return {timesMsByRound:runs.map(rs=>rs.map(r=>+r.ms.toFixed(3))),n:samples.length,medianMs:Math.round(median(samples)),...(scenario==='edit'?{distinctSources,over20s:samples.filter(v=>v>20000).length,p95Ms:p95}:{})};
   };
   const a=stats(baseline),b=stats(candidate);
   const pairedDeltas=a.timesMsByRound.map((ts,i)=>Math.round(median(b.timesMsByRound[i])-median(ts)));
   board.scenarios[scenario]={baseline:a,candidate:b,medianDeltaMs:b.medianMs-a.medianMs,pairedRoundMedianDeltasMs:pairedDeltas};
   if(scenario==='edit')board.candidateEditP95Status=b.p95Ms===null?'INSUFFICIENT_SAMPLES':b.p95Ms>20000?'FAIL':'PASS';
  }
 }
 return result;
}
if(process.argv[1] && import.meta.url===pathToFileURL(path.resolve(process.argv[1])).href){
 const [dir,base,candidate,count]=process.argv.slice(2),rounds=Number(count);assert(Number.isInteger(rounds)&&rounds>=1);
 const result=summarize(dir,base,candidate,rounds);
 fs.writeFileSync(path.join(dir,'comparison.json'),JSON.stringify(result,null,2)+'\n');
 for(const board of result.boards)console.log(board.target,board.candidateEditP95Status,'edits over 20s:',board.scenarios.edit.candidate.over20s+'/'+board.scenarios.edit.candidate.n);
 if(process.argv.includes('--require-edit-p95') && result.boards.some(b=>b.candidateEditP95Status!=='PASS'))process.exitCode=2;
}
