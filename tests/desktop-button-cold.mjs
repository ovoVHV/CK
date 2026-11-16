import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {randomUUID} from 'node:crypto';
import {connectDesktop} from './desktop-client.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';
import {coldPerformanceGate} from './cold-performance-gate.mjs';
import {avrObjectStructure} from './avr-object-proof.mjs';
import {parseFqbn} from '../src/targets.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,'')),profileFile=process.env.CK_V9_CONFIG,original=fs.readFileSync(profileFile),profile=JSON.parse(original);
const dir=path.join(config.paths.evidenceRoot,'button-cold-'+Date.now());fs.mkdirSync(dir,{recursive:true});
const jobsDir=path.join(config.paths.evidenceRoot,'jobs'),previousJobs=new Set(fs.existsSync(jobsDir)?fs.readdirSync(jobsDir):[]);
const targetFqbn=process.env.CK_BUTTON_FQBN??'esp32:esp32:esp32s3',targetBase=targetFqbn.split(':').slice(0,3).join(':');
const avr=targetFqbn.startsWith('arduino:avr:'),file=path.join(dir,avr?'AVR.ck':'WiFi.ck');fs.writeFileSync(file,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name:avr?'AVR':'WiFi',board:targetFqbn,board_package_id:targetBase,options:'{}',xml:JSON.stringify({blocks:{languageVersion:0,blocks:[{type:avr?'delay_ms':'wifi_connect',id:'ck-perf-wifi',x:80,y:80,fields:avr?{MS:500}:{SSID:'MyWiFi',PASSWORD:'12345678'}}]}})}));
if(process.env.CK_BUTTON_PROJECT){const project=JSON.parse(fs.readFileSync(process.env.CK_BUTTON_PROJECT,'utf8'));assert.equal(project.board,targetFqbn);fs.writeFileSync(file,JSON.stringify(project));}
else{const project=JSON.parse(fs.readFileSync(file));project.options=JSON.stringify(Object.fromEntries(parseFqbn(targetFqbn).options));fs.writeFileSync(file,JSON.stringify(project));}
const readyId=process.env.CK_BUTTON_READY_ID??'ck-perf-wifi';
const maxMs=process.env.CK_BUTTON_MAX_MS===undefined?null:Number(process.env.CK_BUTTON_MAX_MS);
const animationAB=process.env.CK_BUTTON_ANIMATION_AB==='1';
const buttonModes=JSON.parse(process.env.CK_BUTTON_MODES??'["reference","candidate"]');
if(buttonModes.includes('same')&&(maxMs!==null||animationAB))throw Error('Identical-source samples must not be mixed into full-build or animation qualification');
if(animationAB&&(process.env.CK_BUTTON_NATIVE!=='1'||process.env.CK_DIAGNOSTIC_DISPATCH||process.env.CK_BUTTON_IMAGE==='1'))throw Error('Animation A/B requires identical native engine settings');
if(maxMs!==null&&(!Number.isFinite(maxMs)||maxMs<=0))throw Error('Invalid complete-build performance threshold');
const report={status:'RUNNING',correctnessStatus:'RUNNING',performanceStatus:'NOT_EVALUATED',performanceQualified:false,boundary:'Blockly project loaded and actual editor compile button clicked; real progress overlay; '+(buttonModes.includes('same')?'full builds and separately labelled identical-source repeats':'all clean builds'),project:process.env.CK_BUTTON_PROJECT??null,runs:[]};const save=()=>fs.writeFileSync(path.join(dir,'report.json'),JSON.stringify(report,null,2));
let c;try{
 c=await connectDesktop();
 const openRequest={requestId:randomUUID(),path:file,source:'local-performance-test'};
 await c.evaluate(`(async()=>{for(let n=0;n<240;n++){const b=document.querySelector('[data-ck-role="build-compile-action"]');if(b&&!b.disabled&&document.querySelector(${JSON.stringify('[data-id="'+readyId+'"]')})&&!document.querySelector('[data-ck-role="project-load-progress"]'))return true;if(n%8===0)await window.__TAURI_INTERNALS__.invoke('plugin:event|emit',{event:'ck-project-open-requested',payload:${JSON.stringify(openRequest)}});await new Promise(r=>setTimeout(r,250))}throw Error('Editor compile button not ready')})()`);

 let baseline,baselineObjects;
 for(const mode of buttonModes){
  if(process.env.CK_DIAGNOSTIC_DISPATCH)fs.writeFileSync(process.env.CK_DIAGNOSTIC_DISPATCH,mode);
  const candidate=mode==='candidate'||mode==='same';fs.writeFileSync(profileFile,JSON.stringify({...profile,coldReference:mode!=='same',...(avr?{avrPropertiesReference:!candidate,directExecutionReference:!candidate}:{}),...(process.env.CK_BUTTON_IMAGE==='1'?{nativeImageReference:!candidate}:{}),...(process.env.CK_BUTTON_NATIVE==='1'?{}:{coldLibraryPchReference:false,discoveryBatchReference:false})}));
  if(process.env.CK_BUTTON_ESP_PROPERTIES==='1')fs.writeFileSync(profileFile,JSON.stringify({...JSON.parse(fs.readFileSync(profileFile)),esp32PropertiesReference:!candidate}));
  const css=animationAB&&!candidate?`[data-ck-role="compile-progress-activity"],.ck-progress-indeterminate{will-change:auto!important}`:candidate&&process.env.CK_BUTTON_NATIVE!=='1'?`[data-ck-role="compile-progress-overlay"]{backdrop-filter:none!important;background-color:#fff!important}.ck-workspace-shell:has([data-ck-role="compile-progress-overlay"]) .animate-spin{animation-timing-function:steps(12,end)!important}.ck-workspace-shell:has([data-ck-role="compile-progress-overlay"]) :is(.animate-pulse,.animate-ping,.animate-bounce){animation:none!important}.ck-progress-indeterminate{animation-timing-function:steps(16,end)!important;will-change:auto!important}`:'';
  await c.evaluate(`(()=>{let e=document.getElementById('ck-render-test');if(!e){e=document.createElement('style');e.id='ck-render-test';document.head.appendChild(e)}e.textContent=${JSON.stringify(css)};return true})()`);
  if(animationAB)await c.evaluate(`(()=>{
   window.__ckRestoreActivityTimer?.();
   const request=window.requestAnimationFrame,cancel=window.cancelAnimationFrame,callbacks=new Map();let id=-1;
   // Identify only the build loop; do not throttle Blockly or other UI callbacks.
   // Measured update-rate gates below reject a stale/nonmatching recognizer.
   const activity=callback=>callback.toString().includes('document.hidden')&&callback.toString().includes('requestAnimationFrame');
   const timer=${candidate}?null:setInterval(()=>{const pending=[...callbacks.values()];callbacks.clear();for(const callback of pending)callback(performance.now())},1000/30);
   window.requestAnimationFrame=function(callback){if(${candidate}||!activity(callback))return request.call(window,callback);const key=id--;callbacks.set(key,callback);return key};
   window.cancelAnimationFrame=function(key){if(callbacks.has(key))callbacks.delete(key);else cancel.call(window,key)};
   window.__ckRestoreActivityTimer=()=>{if(timer!==null)clearInterval(timer);callbacks.clear();window.requestAnimationFrame=request;window.cancelAnimationFrame=cancel;delete window.__ckRestoreActivityTimer};
   return true;
  })()`);
  console.log('START BUTTON '+mode);
  const stageRoot=path.join(path.dirname(config.paths.workspaceRoot),'requests');const previous=new Set(fs.existsSync(stageRoot)?fs.readdirSync(stageRoot):[]);
  const observation=await c.evaluate(`(async()=>{const at=performance.now(),b=document.querySelector('[data-ck-role="build-compile-action"]');if(!b||b.disabled)throw Error('Compile button disabled');let runId=null,fqbn=null,activityFrames=new Set(),motion=null,motionStarted=0,lastMotion=0,gaps=[];b.click();for(let n=0;n<4000;n++){const p=document.querySelector('[data-ck-role="compile-progress-overlay"]');if(p){const icon=p.querySelector('[data-ck-role="compile-progress-activity"]');if(icon){activityFrames.add(icon.style.transform);if(!motion){motionStarted=performance.now();motion=new MutationObserver(()=>{const now=performance.now();if(lastMotion)gaps.push(now-lastMotion);lastMotion=now});motion.observe(icon,{attributes:true,attributeFilter:["style"]})}}runId=p.getAttribute('data-ck-build-run-id');fqbn=p.getAttribute('data-ck-build-fqbn');if(!fqbn.startsWith(${JSON.stringify(targetBase)})){await window.__TAURI_INTERNALS__.invoke('cancel_foreground_build',{runId});throw Error('Unexpected UI board '+fqbn)}}if(runId&&!p&&!b.disabled){motion?.disconnect();const sorted=[...gaps].sort((a,b)=>a-b);return {wallMs:performance.now()-at,runId,fqbn,activityFrames:[...activityFrames],motion:{changes:gaps.length+1,observedMs:lastMotion-motionStarted,updatesPerSecond:(gaps.length+1)*1000/(lastMotion-motionStarted),gapP95:sorted[Math.ceil(sorted.length*.95)-1]},log:document.querySelector('[data-ck-role="compile-log-scroll-container"]')?.innerText}};await new Promise(r=>setTimeout(r,250))}motion?.disconnect();throw Error('UI build timed out')})()`);
  const row={mode,...(animationAB?{animationHz:candidate?60:30}:{}),...observation};report.runs.push(row);save();
  const exported=fs.readdirSync(stageRoot).filter(n=>!previous.has(n)).map(n=>path.join(stageRoot,n,'artifacts/sketch')).filter(p=>fs.existsSync(path.join(p,'native-graph-host-receipt.json')));assert.equal(exported.length,1,row.log);
  row.host=JSON.parse(fs.readFileSync(path.join(exported[0],'native-graph-host-receipt.json')));const w=row.host.worker;validateArtifacts(w.artifacts,w.fqbn);for(const a of w.artifacts)assert.equal(digest(fs.readFileSync(path.join(exported[0],a.name))),a.sha256);
  assert.equal(parseFqbn(w.fqbn).board,parseFqbn(targetFqbn).board);assert.deepEqual([...parseFqbn(w.fqbn).options].sort(),[...parseFqbn(targetFqbn).options].sort(),'Actual button build must preserve the requested menu configuration');
  if(process.env.CK_BUTTON_ESP_PROPERTIES==='1'&&mode!=='same')assert.equal(w.propertyExpansion.native,candidate,'Property A/B selector must change the actual expansion path');
  if(mode==='same'){assert.equal(w.noOpFastPath.hit,true);for(const name of ['CompileGCC','Linker','ImageGenerator','DiscoveryGCC','PrototypeGCC'])assert.equal(w.counts[name],0,name);}
  else{assert(w.counts.CompileGCC>=w.objects.length);assert.equal(w.counts.CacheRestored,0);assert.equal(w.counts.ObjectRetained,0);}
  if(baseline){for(const k of ['generatedSha256','compileDatabase',...(avr?[]:['objects']),'artifacts'])assert.deepEqual(w[k],baseline[k],k);if(avr)for(const o of w.objects)assert.deepEqual(avrObjectStructure(fs.readFileSync(o.file)),baselineObjects.get(o.file));}
  else{baseline=w;if(avr)baselineObjects=new Map(w.objects.map(o=>[o.file,avrObjectStructure(fs.readFileSync(o.file))]));}
  save();console.log(JSON.stringify({mode,wallMs:row.wallMs,ipcMs:row.ipcMs,workerMs:w.wallMs,fqbn:w.fqbn,counts:w.counts}));
 }
 if(process.env.CK_BUTTON_REQUIRE_ACTIVITY==='1')for(const r of report.runs)assert(r.activityFrames.length>=4,'Progress activity did not move');
 if(process.env.CK_COLLECT_JOB_METRICS==='1'){
  report.jobMetrics=[];for(const name of fs.readdirSync(jobsDir).filter(n=>!previousJobs.has(n))){const job=JSON.parse(fs.readFileSync(path.join(jobsDir,name,'job.json')));fs.writeFileSync(job.cancelFile,'diagnostic-session-complete');for(let n=0;n<100;n++){try{const metrics=JSON.parse(fs.readFileSync(job.metricsFile));report.jobMetrics.push(metrics);break;}catch{}await new Promise(r=>setTimeout(r,100));}}
 }
 report.correctnessStatus='PASS';report.status='CORRECTNESS_PASS';
 report.performance=coldPerformanceGate(report.runs,{limitMs:maxMs,nativeUI:process.env.CK_BUTTON_NATIVE==='1'});
 if(animationAB){
  const median=values=>{const v=[...values].sort((a,b)=>a-b);return(v[Math.floor((v.length-1)/2)]+v[Math.floor(v.length/2)])/2};
  const reference=report.runs.filter(r=>r.mode==='reference'),candidate=report.runs.filter(r=>r.mode==='candidate');
  const baseline=median(reference.map(r=>r.wallMs)),updated=median(candidate.map(r=>r.wallMs));
  report.animationQualification={referenceHz:30,candidateHz:60,referenceSamples:reference.length,candidateSamples:candidate.length,referenceMedianMs:baseline,candidateMedianMs:updated,ratio:updated/baseline,maxMedianRatio:1.03,referenceObservedHz:median(reference.map(r=>r.motion.updatesPerSecond)),candidateObservedHz:median(candidate.map(r=>r.motion.updatesPerSecond))};
  const q=report.animationQualification;
  q.passed=reference.length>=5&&candidate.length>=5&&q.ratio<=q.maxMedianRatio&&q.referenceObservedHz>=25&&q.referenceObservedHz<=35&&q.candidateObservedHz>=50&&q.candidateObservedHz<=61&&q.candidateObservedHz>=q.referenceObservedHz*1.5;
  report.performanceQualified=q.passed;report.performanceStatus=q.passed?'PASS':'FAIL';report.status=q.passed?'ANIMATION_PERFORMANCE_PASS':'ANIMATION_PERFORMANCE_FAIL';
  if(!q.passed){console.error('Animation performance gate failed; all samples retained.');process.exitCode=1;}
 }
 if(maxMs!==null){
  report.performanceQualified=report.performance.qualified;
  report.performanceStatus=report.performanceQualified?'PASS':'FAIL';report.status=report.performanceQualified?'LOCAL_PERFORMANCE_PASS':'PERFORMANCE_FAIL';
  if(!report.performanceQualified){console.error('Complete-build performance gate failed; correctness passed, all slow samples retained.');process.exitCode=1;}
 }
}catch(e){report.status='CORRECTNESS_FAIL';report.correctnessStatus='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{fs.writeFileSync(profileFile,original);if(c){try{await c.evaluate(`(()=>{window.__ckRestoreActivityTimer?.();document.getElementById('ck-render-test')?.remove();return true})()`);}catch{}c.close();}save();if(process.env.CK_V91_PRODUCT_ROOT)fs.copyFileSync(path.join(dir,'report.json'),path.join(process.env.CK_V91_PRODUCT_ROOT,'button-cold-result.json'));console.log('REPORT '+path.join(dir,'report.json'));}
