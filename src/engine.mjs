import {readPreprocessed} from './native/tool-text.mjs';
import {reportActivity} from './build-activity.mjs';
import {withBuildDiagnostics,currentWarningCount,buildResourceEvidence} from './build-resource-evidence.mjs';
import {ENGINE_VERSION,CACHE_SCHEMA,artifactsFor} from './version.mjs';
import {targetAssetRoots,propertiesCovered} from './targets.mjs';
import {validateAssets,validateSummary,verifyRepeat} from './asset-engine.mjs';
import {avrRepeatValidation} from './avr-repeat-validation.mjs';
import {NativeScheduler} from './scheduler.mjs';
import {avrProperties} from './avr-properties.mjs';
import {esp32Properties} from './esp32-properties.mjs';
import {isResourceExhaustion,attachFallbackAttempt} from './build-failures.mjs';
import {observeNoOpTree,proveNoOp} from './noop.mjs';
import {sketchSnapshot,mirrorMembers} from './sketch-files.mjs';
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {randomUUID} from 'node:crypto';
import {read,write,sha,buildIndex} from './resolver.mjs';
import {run,asyncRun,baseArgs,properties,officialLibraries,prepare,discover,compilationDatabase,frontendObject,artifactNames,NeedsOfficial,clearBuild} from './discovery.mjs';
import {createPlan,emitGraph,writeChanged,responses} from './native/plan.mjs';
import {generateSketch,sourceContract,NeedsOfficialFrontend} from './native/frontend.mjs';
import {readNativeDependencies} from './native/depfile.mjs';
import {compileIdentity,observeDiscoveryCompile} from './native/discovery-compile-proof.mjs';
import {fingerprint,bodyContract} from './source-contract.mjs';
import {requestScope} from './qualification.mjs';import {captureTemplate,replayTemplate} from './frontend.mjs';
const root=path.dirname(fileURLToPath(import.meta.url));
const norm=s=>s.replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
export function roots(c){const metadata=fs.readdirSync(c.sysroot).filter(n=>/^package.*\.json$/.test(n)||n==='inventory.yaml').sort().map(n=>path.join(c.sysroot,n));return [...new Set([...c.assetRoots,...targetAssetRoots(c.sysroot,c.fqbn),...metadata,...(c.collections??[]),...(c.explicitLibraries??[])])];}
const envKeys=['SOURCE_DATE_EPOCH','TZ','PATH','ComSpec','CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','GCC_EXEC_PREFIX','LIBRARY_PATH','COMPILER_PATH','GCC_COMPARE_DEBUG'];
const context=c=>JSON.stringify([ENGINE_VERSION,CACHE_SCHEMA,c.features,c.workspace,c.sketchDir,c.fqbn,c.buildSignature,c.buildProperties,c.collections,c.explicitLibraries,c.userLibraries,Object.fromEntries(envKeys.map(k=>[k,process.env[k]??null])),c.pchDiagnostics??false]);
const statProof=f=>{const b=fs.readFileSync(f);return {file:f,bytes:b.length,sha256:sha(b)};};
const existingProof=f=>{try{return statProof(f);}catch{return null;}};
function ruleInputs(rule){const all=[...rule.inputs,...responses(rule.argv.slice(1),rule.directory).files];if(rule.depfile&&fs.existsSync(rule.depfile))all.push(...readNativeDependencies(rule.depfile,rule.directory,rule.output).map(f=>path.resolve(rule.directory,f)));return [...new Set(all)].map(statProof);}
function ruleKey(rule){return sha(JSON.stringify([rule.kind,rule.argv,rule.directory,responses(rule.argv.slice(1),rule.directory).expanded]));}
function restoreDerived(c,plan){const repairs=[];function set(file,bytes){if(writeChanged(file,bytes))repairs.push({file,reason:'reconstructed-from-qualified-recipe-or-validated-asset'});}
 set(path.join(plan.graph,'core-file-options.rsp'),'-DARDUINO_CORE_BUILD\n');set(path.join(plan.graph,'normal-file-options.rsp'),'');set(path.join(plan.build,'build_opt.h'),'');set(path.join(plan.build,'file_opts'),'');set(path.join(plan.build,'compile_commands.json'),JSON.stringify(plan.db,null,2)+'\n');
 for(const r of plan.rules.filter(r=>r.kind==='pch'))set(r.inputs[0],fs.readFileSync(path.join(plan.props['build.core.path'],'Arduino.h')));return repairs;}
function saveTree(dir){const rows=[];function visit(d){if(!fs.existsSync(d))return;for(const e of fs.readdirSync(d,{withFileTypes:true})){const p=path.join(d,e.name);if(e.isDirectory())visit(p);else{const s=fs.statSync(p);rows.push({file:p,bytes:fs.readFileSync(p),atime:s.atime,mtime:s.mtime});}}}visit(dir);return rows;}
export class BuildSession {
 #scheduler;#state=null;id=randomUUID();
 constructor({historyBytes=128*1024*1024}={}){this.#scheduler=new NativeScheduler({historyBytes});}
 reset(){this.#scheduler.reset();this.#state=null;this.id=randomUUID();}
 async build(c,options={}){return withBuildDiagnostics(()=>this.buildObserved(c,options));}
 async buildObserved(c,{label='run',mode='auto',frontendReplay=true,linkHistory=true,objectRestore=true,noOpFastPath=true}={}){
 const at=performance.now(),sourceFile=path.join(c.sketchDir,'sketch.ino'),source=norm(fs.readFileSync(sourceFile,'utf8')),receipt={label,startedUnixMs:Date.now(),sessionId:this.id,success:false,phases:{},steps:[],productAuthorized:false,continuousNamespaceProof:false,diskGraphAuthority:false,mode};
 const validation=avrRepeatValidation(c,this.#state?.source===source && noOpFastPath && c.features.noOpFastPath && mode!=='official');
 if(validation!==c.validation)c={...c,validation};
 const activity=message=>reportActivity(c,message);
 receipt.executionJobs=c.jobs??8;activity('资产校验：开始完整输入内容验证');
 let state=this.#state,p,d,front,plan,template,fullFrontend=false,frontendReady=false,provisionalIncludes=null;
 const sameContext=state?.context===context(c),members=sketchSnapshot(c.sketchDir),names=JSON.stringify(members.names);
 const sameMembers=state?.memberIdentity===members.identity&&!members.other.length;
 const inputs=roots(c);
 let bundle=null;
 const bundledRepeat=c.fqbn.startsWith('arduino:avr:')?c.features.avrRepeatValidation!==false:
    c.fqbn.startsWith('esp32:esp32:')&&c.features.esp32RepeatValidation!==false;
 if(state?.outputIdentity&&sameContext&&sameMembers&&state.source===source&&bundledRepeat
    &&noOpFastPath&&c.features.noOpFastPath&&!c.validationReference
    &&mode!=='official'&&c.validation?.mode==='rust'){
  bundle=verifyRepeat(inputs,[state.plan.build,state.plan.graph],state.assetSha256,state.outputIdentity,c.validation);
  if(bundle&&JSON.stringify(inputs)!==JSON.stringify(roots(c)))throw Error('Asset roots changed during No-Op build');
 }
 let before=bundle?.before??validateAssets(inputs,c.validation??{mode:'node'});receipt.phases.inputValidationMs=before.elapsedMs;receipt.assetProof={...before,rows:undefined};
 const buildPlan=()=>{const gt=performance.now();try{if(!propertiesCovered(p,before.roots))throw Error('Expanded tool/platform paths outside complete asset proof');plan=createPlan({...c,objectCache:false,pipeCompilation:false,discoveryHistory:false},front);}catch(e){e.code='NOT_QUALIFIED';e.fallbackSafe=true;throw e;}receipt.phases.graphMs=performance.now()-gt;};
 const coldFrontend=discovered=>{
  activity('原型处理：正在运行 Sketch 前端');
  receipt.derivedRepairs=restoreDerived(c,plan);const ft=performance.now(),g=generateSketch(c,plan,discovered.sketchPreprocess);discovered.sketchPreprocess=null;
  receipt.frontend={replayed:false,reason:'real-frontend-required'};receipt.prototypePreprocessReused=g.preprocessReused;receipt.generatedWritten=writeChanged(g.generated,g.code);
  template=captureTemplate(source,g.code,readPreprocessed(path.join(plan.graph,'frontend/sketch_merged.cpp'),c.sysroot));receipt.phases.prototypeMs=performance.now()-ft;frontendReady=true;
 };
 const sameAssets=state?.assetSha256===before.sha256;
 let directives,sourceContractError;try{directives=sourceContract(source);}catch(e){sourceContractError=String(e.message);}
 receipt.sourceEligibility={eligible:!!directives,reason:sourceContractError??'literal-includes-and-supported-syntax'};
 const unchanged=()=>{const now=sketchSnapshot(c.sketchDir);return now.identity===members.identity&&JSON.stringify(now.other)===JSON.stringify(members.other)&&norm(fs.readFileSync(sourceFile,'utf8'))===source;};
 receipt.projectFiles=members.files.map(({name,digest})=>({name,sha256:digest}));
 const graphAllowed=mode!=='official'&&sameContext&&sameAssets&&directives&&directives===state.directives&&sameMembers&&!state.official;
 receipt.graphReuse={hit:!!graphAllowed,reason:graphAllowed?'live-session-input-proof':!state?'no-live-authority':!sameContext?'build-context-changed':!sameAssets?'asset-or-namespace-changed':!directives?'source-contract-not-supported':'source-discovery-contract-changed'};
 try{
  if(c.features.noOpFastPath&&noOpFastPath&&mode!=='official'&&sameContext&&sameAssets&&sameMembers&&state.source===source){
   activity('相同源码：正在验证已有构建输出');
   const candidate=proveNoOp(state,state.plan,c.validation,bundle?.output);receipt.noOpFastPath=candidate;
   receipt.phases.noOpOutputValidationMs=candidate.elapsedMs??0;
   if(candidate.hit){
    receipt.graphReuse={hit:true,reason:'live-session-input-proof'};
    activity('资产复核：确认完整输入内容一致');const after=bundle?.after??validateAssets(roots(c),c.validation);receipt.phases.postValidationMs=after.elapsedMs;
    if(bundle)receipt.noOpFastPath.validationTransport='single-process-three-full-scans';
    if(before.sha256!==after.sha256||!unchanged())throw Error('Input changed during No-Op build');
    const previous=state.lastReceipt;
    receipt.resources=previous.resources;
    Object.assign(receipt,{success:true,artifacts:candidate.artifacts,postAssetProof:{...after,rows:undefined},objects:previous.objects,pch:previous.pch,generatedSha256:previous.generatedSha256,compileDatabase:previous.compileDatabase,selectedLibraries:previous.selectedLibraries,sketchCommand:previous.sketchCommand,sourceSha256:sha(source),fqbn:c.fqbn,officialFrontendInvoked:false,compilerInvoked:false,ninjaInvocations:0,frontendMode:'session-identical-transform',frontend:{replayed:true,reason:'identical-validated-source'},generatedWritten:false,derivedRepairs:[],restoredObjects:[],linkHistory:{hit:false},stageTimings:[],batchTimings:[],observation:{optimize:false,noop:true,reads:candidate.proof.files,bytes:candidate.proof.bytes},counts:Object.fromEntries(Object.keys(previous.counts).map(k=>[k,k==='ObjectRetained'?previous.objects.length:0])),taskDecisions:previous.taskDecisions.map(d=>({...d,decision:d.task==='frontend'?'Replay':'Reuse',reason:'full-content-noop-proof',actualWrites:0}))});
    receipt.phases.executeMs=0;receipt.phases.ruleObservationMs=0;receipt.phases.prototypeMs=0;
    receipt.wallMs=performance.now()-at;write(path.join(c.evidence,label+'.receipt.json'),receipt);return receipt;
   }
   if(bundle)throw Error('Output changed after full repeat verification');
  }
  if(graphAllowed){activity('依赖发现：复用已验证的会话发现图');mirrorMembers(c,members);p=state.p;d=state.d;front=state.front;plan=state.plan;}
  else {
   const q=requestScope(c);let useOfficial=mode==='official'||!c.features.independentDiscovery||!q.qualified||!directives;
   if(useOfficial)receipt.officialReason=mode==='official'?'explicit-official-request':!c.features.independentDiscovery?'independent-discovery-disabled':!q.qualified?q.reason:sourceContractError;
   if(useOfficial){activity('官方前端：正在解析板卡、库及 Sketch');clearBuild(c);const t=performance.now(),r=await asyncRun([...baseArgs(c),'--only-compilation-database','--verbose','--json','--clean',c.sketchDir],c.sysroot);receipt.phases.officialFrontendMs=performance.now()-t;write(path.join(c.evidence,label+'.official.json'),r);if(r.code)throw Error(r.stderr+r.stdout.slice(-2000));front=JSON.parse(r.stdout);p=properties(front);d={selected:officialLibraries(front),probes:[],decisions:[]};fullFrontend=true;receipt.discoveryMode='official';state=null;}
   else {activity('板卡配置：正在解析实际参数和库候选');if(!state||!sameContext||state.memberNames!==names||state.official)clearBuild(c);const t=performance.now();const esp32=c.fqbn.startsWith('esp32:esp32:');
    const expanded=(esp32?c.features.esp32Properties!==false&&!c.esp32PropertiesReference:c.features.avrProperties!==false&&!c.avrPropertiesReference)?(esp32?esp32Properties(c):avrProperties(c)):{hit:false,reason:'reference-or-feature-disabled'};
    if(expanded.hit)p=expanded.properties;else{const r=run([...baseArgs(c),'--show-properties=expanded','--json',c.sketchDir],{cwd:c.sysroot});const info=JSON.parse(r.stdout);if(info.compiler_out||info.builder_result.used_libraries?.length)throw Error('Property bootstrap performed discovery');p=properties(info);}
    receipt.propertyExpansion={native:expanded.hit,reason:expanded.reason,coreVersion:path.basename(p['runtime.platform.path'])};receipt.phases.propertiesMs=performance.now()-t;
    const prepAt=performance.now(),retained=state?saveTree(path.join(c.workspace,'build')).filter(x=>!/[.]o$|[.]gch$|[.]a$|[.]bin$|[.]elf$/.test(x.file)):[];prepare(c,p);for(const x of retained)if(fs.existsSync(x.file)&&fs.readFileSync(x.file).equals(x.bytes))fs.utimesSync(x.file,x.atime,x.mtime);receipt.phases.prepareMs=performance.now()-prepAt;
    const indexAt=performance.now(),index=buildIndex([{dir:path.join(p['runtime.platform.path'],'libraries'),location:'platform'},{dir:c.userLibraries,location:'user'},...(c.collections??[]).map(dir=>({dir,location:'user'})),...(c.explicitLibraries??[]).map(dir=>({dir,location:'unmanaged',single:true}))]);if(index.diagnostics.length)throw new NeedsOfficial('Index diagnostics');receipt.phases.indexMs=performance.now()-indexAt;
    const rediscover=state&&sameAssets&&sameContext&&state.memberNames===names&&!sameMembers;
    const deferCore=!!((c.deferCoreOnRediscovery??c.features?.deferCoreOnRediscovery)!==false&&state&&!state.official&&sameContext&&sameAssets&&sameMembers&&state.memberNames===names);
    receipt.deferredCoreAdmission=deferCore;
    activity('依赖发现：开始 GCC 探测和并行编译');const dt=performance.now();d=await discover(rediscover?{...c,discoveryCompileReference:true}:c,p,index,{deferCore,onSketchReady:rediscover||members.units.length||c.discoveryCompileReference||c.coldPipelineReference||c.pchDiagnostics?undefined:async(discovered,pool)=>{
     provisionalIncludes=discovered.includes.join('\0');compilationDatabase(c,p,discovered);front=frontendObject(p,discovered.selected);buildPlan();coldFrontend(discovered);
     const sketch=plan.rules.find(r=>r.kind==='compile'&&r.inputs[0]===path.join(plan.build,'sketch/sketch.ino.cpp'));
     // PCH-dependent recipes keep the ordinary PCH-before-Sketch scheduler.
     if(sketch.inputs.length!==1||plan.rules.some(r=>r.kind==='pch'))return;
     const queuedAt=performance.now();await pool.run(c.discoveryBatchReference!==false?0:-1,async()=>{
      activity('编译 Sketch：开始 sketch.ino.cpp');const start=performance.now(),identity=compileIdentity(sketch.argv,sketch.directory),r=await asyncRun(sketch.argv,sketch.directory);
      activity('编译 Sketch：'+(r.code===0?'完成':'失败')+' sketch.ino.cpp');
      receipt.coldPipeline={sketchStartedMs:start-dt,sketchFinishedMs:performance.now()-dt,queueMs:start-queuedAt,processMs:r.elapsedMs};
      receipt.coldPipeline.compiled=1;receipt.coldPipeline.exitCode=r.code;
      if(r.code!==0)return; // Final dependency closure may still change the command; scheduler decides.
      const record=observeDiscoveryCompile({argv:sketch.argv,cwd:sketch.directory,source:sketch.inputs[0],output:sketch.output,depfile:sketch.depfile,identity});
      if(record){record.producer='sketch-pipeline';discovered.compiledObjects.set(sketch.output,record);}
      receipt.coldPipeline.compiled=1;
     });
    }});receipt.phases.discoveryMs=performance.now()-dt;receipt.coldDiscovery=d.timings;receipt.libraryPch=d.libraryPch??[];write(path.join(c.evidence,label+'.discovery.json'),d);write(path.join(c.evidence,label+'.index.json'),index);if(provisionalIncludes!==null&&provisionalIncludes!==d.includes.join('\0')){plan=null;frontendReady=false;template=null;if(receipt.coldPipeline)receipt.coldPipeline.invalidatedByFinalDiscovery=true;}compilationDatabase(c,p,d);front=frontendObject(p,d.selected);receipt.discoveryMode='independent';
   }
   if(!plan)buildPlan();
  }
  const qualifiedPlan=plan;
  // Diagnostic-only request: do not inject -H into Arduino's discovery probes.
  // Keep the actual command and the diagnostic context in session identity.
  if(c.pchDiagnostics){plan=structuredClone(plan);const sketch=plan.rules.find(r=>r.kind==='compile'&&r.inputs[0]===path.join(plan.build,'sketch/sketch.ino.cpp'));if(!sketch.argv.includes('-H'))sketch.argv.push('-H');receipt.pchDiagnostics=true;}
  receipt.derivedRepairs=restoreDerived(c,plan);const ft=performance.now();let generated=path.join(plan.build,'sketch/sketch.ino.cpp');
  if(!fullFrontend&&!frontendReady){activity('原型处理：检查可复用转换并生成 CPP');const replay=frontendReplay&&graphAllowed?replayTemplate(state.template,source):{hit:false,reason:'real-frontend-required'};receipt.frontend={replayed:replay.hit,reason:replay.reason};if(replay.hit){receipt.generatedWritten=writeChanged(generated,replay.code);template=replay.template??{...state.template,source,generated:replay.code,contract:bodyContract(source)};}else{const g=generateSketch(c,plan,graphAllowed?null:d.sketchPreprocess);if(d.sketchPreprocess)d.sketchPreprocess=null;receipt.prototypePreprocessReused=g.preprocessReused;receipt.generatedWritten=writeChanged(g.generated,g.code);template=captureTemplate(source,g.code,readPreprocessed(path.join(plan.graph,'frontend/sketch_merged.cpp'),c.sysroot));}receipt.phases.prototypeMs=performance.now()-ft;}else if(fullFrontend)receipt.frontend={replayed:false,reason:'official-transform'};
  if(d.sketchPreprocess)d.sketchPreprocess=null;
  if(template)write(path.join(c.evidence,label+'.prototype-template.json'),template);if(!fullFrontend&&!receipt.frontend.replayed)fs.copyFileSync(path.join(plan.graph,'frontend/sketch_merged.cpp'),path.join(c.evidence,label+'.preprocessed.cpp'));
  writeChanged(path.join(plan.build,'file_opts'),'');
  if(graphAllowed&&state.auxiliary)for(const x of state.auxiliary)writeChanged(x.file,x.bytes);
  const fixedAssets=sha(JSON.stringify(before.rows.filter(r=>!r[0].toLowerCase().startsWith(path.resolve(c.userLibraries).toLowerCase()+path.sep))));
  activity('任务调度：验证依赖、对象和历史产物');
  const execAt=performance.now(),scheduled=await this.#scheduler.execute(c,plan,{context:context(c),assets:before.sha256,fixedAssets,namespace:sha(JSON.stringify([before.namespaceSha256,names]))},{restore:objectRestore&&linkHistory,optimize:c.receiptOptimize===true,produced:!graphAllowed&&d.compiledObjects?d.compiledObjects:new Map()});
  if(d.compiledObjects)d.compiledObjects=null;
  receipt.phases.executeMs=performance.now()-execAt;receipt.phases.ruleObservationMs=scheduled.observationMs;receipt.observation=scheduled.observation;
  receipt.steps=scheduled.steps;receipt.stageTimings=scheduled.timings;receipt.batchTimings=scheduled.batchTimings;receipt.taskDecisions=[{task:'discovery',decision:graphAllowed?'Reuse':'Rebuild',reason:receipt.graphReuse.reason},{task:'frontend',decision:receipt.frontend.replayed?'Replay':'Rebuild',reason:receipt.frontend.reason},...scheduled.decisions];
  receipt.restoredObjects=scheduled.decisions.filter(x=>['compile','pch'].includes(x.task)&&x.decision==='Restore');
  receipt.linkHistory={hit:scheduled.decisions.some(x=>x.task==='link'&&x.decision==='Restore')};
  const sizeRule=plan.rules.find(rule=>rule.sizePolicy);
  receipt.resources=buildResourceEvidence(scheduled.bytesFor(sizeRule.output),sizeRule.sizePolicy,currentWarningCount());
  write(path.join(c.evidence,label+'.ninja.json'),scheduled.runs);
  receipt.sketchCommand=[...plan.rules.find(r=>r.kind==='compile'&&r.inputs[0]===path.join(plan.build,'sketch/sketch.ino.cpp')).argv];
  if(p['build.arch'].toLowerCase()==='esp32')writeChanged(path.join(plan.build,'boot_app0.bin'),fs.readFileSync(path.join(p['runtime.platform.path'],'tools/partitions/boot_app0.bin')));
  const destination=path.join(c.evidence,label,'artifacts');if(c.captureEvidence)fs.mkdirSync(destination,{recursive:true});receipt.artifacts=artifactsFor(c.fqbn).map(name=>{const file=path.join(plan.build,name),bytes=fs.readFileSync(file);if(c.captureEvidence)fs.writeFileSync(path.join(destination,name),bytes);return {name,file,bytes:bytes.length,sha256:sha(bytes)};});
  const objects=path.join(c.evidence,label,'objects');if(c.captureEvidence)fs.mkdirSync(objects,{recursive:true});receipt.objects=plan.rules.filter(r=>r.kind==='compile').map(r=>{const proof=c.receiptOptimize?scheduled.records.find(x=>x.output===r.output).proof:statProof(r.output);const dest=sha(r.output)+'.o';if(c.captureEvidence){if(c.receiptOptimize)fs.writeFileSync(path.join(objects,dest),scheduled.bytesFor(r.output));else fs.copyFileSync(r.output,path.join(objects,dest));}return {...proof,stored:dest};});
  receipt.pch=plan.rules.filter(r=>r.kind==='pch').map(r=>({output:c.receiptOptimize?scheduled.records.find(x=>x.output===r.output).proof:statProof(r.output),command:ruleKey(r),argv:r.argv,expanded:responses(r.argv.slice(1),r.directory).expanded,dependencies:c.receiptOptimize?scheduled.records.find(x=>x.output===r.output).inputs:ruleInputs(r),assetIdentity:before.sha256,context:context(c)}));
  receipt.generatedSha256=sha(fs.readFileSync(generated));fs.copyFileSync(generated,path.join(c.evidence,label+'.ino.cpp'));receipt.compileDatabase=plan.db;receipt.selectedLibraries=d.selected.map(l=>({name:l.name,source_dir:l.source_dir,install_dir:l.install_dir,version:l.version??null}));
  activity('资产复核：再次完整验证输入内容');const after=(c.validationReference?validateAssets:validateSummary)(roots(c),c.validation??{mode:'node'});receipt.phases.postValidationMs=after.elapsedMs;receipt.postAssetProof={...after,rows:undefined};if(before.sha256!==after.sha256||!unchanged())throw Error('Input changed during build');
  const ruleProof=scheduled.records;
  const auxiliary=(p['build.arch'].toLowerCase()==='avr'?['build.options.json']:['partitions.csv','sketch.ino.bootloader.bin','sdkconfig','build.options.json']).map(n=>{const file=path.join(plan.build,n);return {file,bytes:fs.readFileSync(file)};});
  const outputAt=performance.now(),outputIdentity=c.features.noOpFastPath?observeNoOpTree(plan,c.validation).sha256:null;
  receipt.phases.noOpAuthorityCaptureMs=performance.now()-outputAt;
  activity('固件验证：输入及产物验证完成，准备宿主交付');
  scheduled.commit();
  this.#state={context:context(c),assetSha256:before.sha256,namespace:before.namespaceSha256,fixedAssets:sha(JSON.stringify(before.rows.filter(r=>!r[0].toLowerCase().startsWith(path.resolve(c.userLibraries).toLowerCase()+path.sep)))),source,directives,p,d,front,plan:qualifiedPlan,template,rules:ruleProof,auxiliary};
  receipt.success=true;receipt.wallMs=performance.now()-at;receipt.officialFrontendInvoked=fullFrontend;receipt.frontendMode=receipt.frontend.replayed?'session-prototype-replay':fullFrontend?'official':'compiler-and-ctags';receipt.compilerInvoked=receipt.steps.some(x=>x.kind==='COMPILE');receipt.ninjaInvocations=scheduled.invocations;receipt.sourceSha256=sha(source);receipt.fqbn=c.fqbn;
  const unusedSpeculative=!graphAllowed&&!fullFrontend?(d.speculativeCompiles??[]).filter(p=>!p.consumed&&Number.isInteger(p.pid)):[];
  const discoveryCompiles=!graphAllowed&&!fullFrontend?d.probes.filter(p=>p.kind==='compile').length+unusedSpeculative.length:0;
  receipt.speculativeCompilation=graphAllowed?{started:0,consumed:0,discarded:0}:{started:d.speculativeCompiles?.length??0,consumed:d.speculativeCompiles?.filter(p=>p.consumed).length??0,discarded:unusedSpeculative.length};
  receipt.counts={LibraryPchGCC:graphAllowed?0:d.libraryPch?.length??0,DiscoveryGCC:receipt.graphReuse.hit?0:null,DiscoveryCompileGCC:discoveryCompiles,PrototypeGCC:receipt.frontend.replayed||receipt.prototypePreprocessReused?0:1,CTags:receipt.frontend.replayed?0:1,CompileGCC:receipt.steps.filter(x=>x.kind==='COMPILE').length+discoveryCompiles+(receipt.coldPipeline?.compiled??0),PipelinedSketchGCC:receipt.coldPipeline?.compiled??0,SchedulerCompileGCC:receipt.steps.filter(x=>x.kind==='COMPILE').length,ObjectProducedDuringDiscovery:scheduled.decisions.filter(x=>x.decision==='UseDiscoveryObject').length,PchGCC:receipt.steps.filter(x=>x.kind==='PCH').length+(!graphAllowed?(d.libraryPch?.length??0):0),Linker:receipt.steps.filter(x=>x.kind==='LINK').length,ImageGenerator:receipt.steps.filter(x=>x.kind==='IMAGE').length,CacheRestored:scheduled.decisions.filter(x=>x.decision==='Restore').length,ObjectRestored:scheduled.decisions.filter(x=>x.task==='compile'&&x.decision==='Restore').length,ObjectRetained:scheduled.decisions.filter(x=>x.task==='compile'&&x.decision==='Reuse').length,PchRestored:scheduled.decisions.filter(x=>x.task==='pch'&&x.decision==='Restore').length,LinkRestored:scheduled.decisions.filter(x=>x.task==='link'&&x.decision==='Restore').length,ImageRestored:scheduled.decisions.filter(x=>x.task==='image'&&x.decision==='Restore').length,RestoredFileWrites:scheduled.decisions.reduce((n,x)=>n+(x.actualWrites??0),0)};if(!fullFrontend)receipt.counts.DiscoveryGCC=receipt.graphReuse.hit?0:d.probes.filter(p=>p.kind!=='compile').length;
  receipt.compilerInvoked=receipt.compilerInvoked||discoveryCompiles>0||(receipt.coldPipeline?.compiled??0)>0;
  Object.assign(this.#state,{outputIdentity,lastReceipt:receipt,memberIdentity:members.identity,memberNames:names,official:fullFrontend});
  write(path.join(c.evidence,label+'.receipt.json'),receipt);return receipt;
 }catch(e){
  this.reset();receipt.error=String(e.stack);receipt.wallMs=performance.now()-at;
  if(isResourceExhaustion(e)){e.code='RESOURCE_EXHAUSTED';e.fallbackSafe=false;receipt.errorCode=e.code;try{write(path.join(c.evidence,label+'.receipt.json'),receipt);}catch{}throw e;}
  write(path.join(c.evidence,label+'.receipt.json'),receipt);
  if(mode!=='official'&&(e instanceof NeedsOfficial||e instanceof NeedsOfficialFrontend)){
   activity('兼容回退：独立前端未满足条件，改用官方发现');
   const result=await this.build(c,{label:label+'-fallback',mode:'official',frontendReplay:false});
   const combined=attachFallbackAttempt(result,receipt,performance.now()-at);write(path.join(c.evidence,label+'.result.json'),combined);return combined;
  }
  throw e;
 }
 }
}



