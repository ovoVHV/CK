import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
const root=path.resolve('docs/audits/esp32-core-matrix-2026-11-04');
const read=file=>JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,''));
const digest=file=>createHash('sha256').update(fs.readFileSync(file)).digest('hex');
const median=a=>[...a].sort((a,b)=>a-b)[Math.floor(a.length/2)];
const result={createdAt:new Date().toISOString(),scope:'ESP32-S3 default FQBN; WiFi and GPIO/Serial; desktop IPC; compatibility samples, not P95 qualification',
 releaseIndex:read(path.join(root,'index-check-2026-11-05.json')),versions:[],retainedNonPassingAttempts:[]};
for(const version of ['3.3.6','3.3.10','3.3.12']){
 const dir=path.join(root,version),paths=fs.readdirSync(dir).filter(n=>n.startsWith('desktop-matrix-')).map(n=>path.join(dir,n,'report.json'));
 const accepted=[];
 for(const file of paths){
  const report=read(file),reviewPath=path.join(path.dirname(file),'comparison-review.json');
  const review=fs.existsSync(reviewPath)?read(reviewPath):null;
  if(review){assert.equal(review.sourceReportSha256,digest(file));assert.equal(review.status,'PASS');}
  if(report.status==='PASS'||review){accepted.push({file,report,review,reviewPath});}
  else result.retainedNonPassingAttempts.push({version,report:file,sha256:digest(file),status:report.status,error:report.error,runs:report.runs.map(r=>({label:r.label,success:r.success,wallSeconds:r.wallMs/1000,discovery:r.host?.worker?.discoveryMode,fallback:r.host?.worker?.fallbackAttempt}))});
 }
 assert.equal(accepted.length,1,version+' needs exactly one completed matrix');
 const {file,report,review,reviewPath}=accepted[0];assert.equal(report.runs.length,9);assert(report.runs.every(r=>r.success));assert.equal(report.official.length,3);
 const run=name=>report.runs.find(r=>r.label===name),seconds=name=>run(name).wallMs/1000;
 const cold=run('wifi-cold').host.worker,changed=run('wifi-edit').host.worker,same=report.runs.filter(r=>r.label.startsWith('wifi-unchanged-'));
 assert.equal(changed.counts.CompileGCC,1);assert.equal(changed.counts.DiscoveryGCC,0);assert.equal(changed.counts.PrototypeGCC,0);
 assert(same.every(r=>r.host.worker.noOpFastPath.hit&&r.host.worker.counts.CompileGCC===0&&r.host.worker.counts.Linker===0&&r.host.worker.counts.ImageGenerator===0));
 result.versions.push({version,report:file,reportSha256:digest(file),comparisonReview:review?reviewPath:null,
  sharedHeaderPch:report.config.features.sharedHeaderPch,workspaceRoot:report.config.paths.workspaceRoot,sysroot:report.sysroot,
  desktopSeconds:{wifiCold:seconds('wifi-cold'),wifiEdit:seconds('wifi-edit'),wifiUnchangedMedian:median(same.map(r=>r.wallMs/1000)),wifiUnchangedSamples:same.map(r=>r.wallMs/1000),wifiHistoryA:seconds('wifi-history-A'),gpioCold:seconds('gpio-cold'),gpioEdit:seconds('gpio-edit'),gpioUnchanged:seconds('gpio-unchanged')},
  assets:{files:cold.assetProof.files,bytes:cold.assetProof.bytes},coldCounts:cold.counts,editCounts:changed.counts,
  correctness:report.official.map(r=>({label:r.label,status:review?'PASS after structural comparison review':r.status,objects:r.objectCount,artifacts:r.artifactCount,officialProcessSeconds:r.elapsedMs/1000}))});
}
fs.writeFileSync(path.join(root,'summary.json'),JSON.stringify(result,null,2));
console.log(JSON.stringify(result.versions.map(r=>({version:r.version,...r.desktopSeconds})),null,2));
