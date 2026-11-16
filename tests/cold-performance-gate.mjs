// Qualification is deliberately separate from successful artifact comparison.
export function coldPerformanceGate(runs,{limitMs=null,nativeUI=false,minimumSamples=5}={}){
 if(limitMs!==null&&(!Number.isFinite(limitMs)||limitMs<=0))throw Error('Invalid complete-build performance threshold');
 const walls=runs.map(r=>r.wallMs);
 if(walls.some(n=>!Number.isFinite(n)||n<0))throw Error('Invalid complete-build elapsed sample');
 const sorted=[...walls].sort((a,b)=>a-b),n=sorted.length;
 const qualified=limitMs!==null&&nativeUI&&n>=minimumSamples&&runs.every(r=>r.mode==='candidate'&&r.wallMs<=limitMs);
 return {status:limitMs===null?'NOT_EVALUATED':qualified?'PASS':'FAIL',qualified,
  samples:n,medianMs:n?(n%2?sorted[(n-1)/2]:(sorted[n/2-1]+sorted[n/2])/2):null,
  maxMs:n?sorted.at(-1):null,limitMs,minimumSamples,overLimit:limitMs===null?null:walls.filter(ms=>ms>limitMs).length};
}
