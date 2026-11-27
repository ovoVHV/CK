import {compilerIncludes} from './native/tool-text.mjs';
import {observeCommandDiagnostics} from './build-resource-evidence.mjs';
import {reportActivity,compilerSourceArgument} from './build-activity.mjs';
import {StringDecoder} from 'node:string_decoder';
import {checkedBuildPath} from './paths.mjs';
import {removeScratchTree} from './filesystem.mjs';
import fs from 'node:fs';import path from 'node:path';import {spawnSync,spawn} from 'node:child_process';
import os from 'node:os';
import {buildIndex,resolve,recipe,sourceFiles,sha,read,write} from './resolver.mjs';
import {createPlan,emitGraph,writeChanged,responses,setRecipeTokenMemo} from './native/plan.mjs';
import {generateSketch,NeedsOfficialFrontend,literalSketchIncludes} from './native/frontend.mjs';
import {requestScope,propertyScope} from './qualification.mjs';
import {fingerprint,bodyContract} from './source-contract.mjs';
import {preprocessIdentity} from './native/preprocess-proof.mjs';
import {compileIdentity,observeDiscoveryCompile} from './native/discovery-compile-proof.mjs';
import {readNativeDependencies} from './native/depfile.mjs';
import {DiscoveryPool} from './native/discovery-pool.mjs';
import {RequestLibraryPch} from './native/library-pch.mjs';
import {nonInteractiveStdio} from './process-stdio.mjs';
import {platformRecipeHash} from './targets.mjs';
import {bootIdentity} from './native/session-boot.mjs';
import {sketchSnapshot,mirrorMembers} from './sketch-files.mjs';
export class NeedsOfficial extends Error{}
export const artifactNames=['sketch.ino.elf','sketch.ino.bin','sketch.ino.partitions.bin','sketch.ino.merged.bin','flash_args','boot_app0.bin','sketch.ino.bootloader.bin','sdkconfig','build.options.json','partitions.csv'];
const norm=p=>path.resolve(p),source=c=>path.join(c.sketchDir,'sketch.ino');
export function run(argv,options={}){const r=spawnSync(argv[0],argv.slice(1),{cwd:options.cwd,windowsHide:true,stdio:nonInteractiveStdio(),encoding:'utf8',maxBuffer:64*1024*1024});observeCommandDiagnostics(r);if(r.status!==0)throw Error('Command failed '+argv[0]+': '+r.stderr);return r;}
export async function asyncRun(argv,cwd,{critical=false,onStdout}={}){const at=performance.now(),startedUnixMs=Date.now(),child=spawn(argv[0],argv.slice(1),{cwd,windowsHide:true,stdio:nonInteractiveStdio()}),out=[],err=[];let priority=null;if(critical&&child.pid){try{os.setPriority(child.pid,os.constants.priority.PRIORITY_ABOVE_NORMAL);priority=os.getPriority(child.pid);}catch{priority='unchanged';}}const decoder=new StringDecoder('utf8');child.stdout.on('data',b=>{out.push(b);if(onStdout)onStdout(decoder.write(b));});child.stderr.on('data',b=>err.push(b));const code=await new Promise((res,rej)=>{child.on('error',rej);child.on('close',res);});if(onStdout)onStdout(decoder.end());const result={pid:child.pid,startedUnixMs,code,stdout:Buffer.concat(out).toString(),stderr:Buffer.concat(err).toString(),elapsedMs:performance.now()-at,...(critical?{priority}:{})};Object.defineProperty(result,'stderrBytes',{value:Buffer.concat(err)});observeCommandDiagnostics(result);return result;}
export function baseArgs(c){const a=[c.cli,'compile','--config-file',c.cliConfig,'--fqbn',c.fqbn,'--build-path',path.join(c.workspace,'build'),'--jobs',String(c.jobs??8),'--discovery-timeout','100ms'];for(const dir of c.collections??[])a.push('--libraries',dir);for(const dir of c.explicitLibraries??[])a.push('--library',dir);for(const p of c.buildProperties??[])a.push('--build-property',p);return a;}
export function properties(front){return Object.fromEntries(front.builder_result.build_properties.map(x=>{const i=x.indexOf('=');return [x.slice(0,i),x.slice(i+1)];}));}
// Arduino CLI omits this optional field when only the platform core is used.
// A missing list is an empty selection; malformed present lists remain errors.
export function officialLibraries(front){const selected=front.builder_result.used_libraries??[];if(!Array.isArray(selected))throw Error('Invalid official used_libraries list');return selected;}
export function initialSketch(c,snapshot=sketchSnapshot(c.sketchDir)){const code=fs.readFileSync(source(c),'utf8').replace(/^\uFEFF/,'').replaceAll('\r\n','\n');if(snapshot.other.length)throw new NeedsOfficial('Additional sketch inputs require official discovery');mirrorMembers(c,snapshot);const raw=(/^\s*#\s*include\s*[<"]Arduino\.h[>"]/m.test(code)?'':'#include <Arduino.h>\n')+'#line 1 '+JSON.stringify(source(c))+'\n'+code+'\n';const file=path.join(c.workspace,'build/sketch/sketch.ino.cpp');writeChanged(file,raw);return file;}
export function prepare(c,p,{before,prior}={}){
 let bootResult=null;
 const unsupported=reason=>{throw Object.assign(Error(reason),{code:'NOT_QUALIFIED',fallbackSafe:true});};
 const q=propertyScope(p);if(!q.qualified)unsupported(q.reason);const build=path.join(c.workspace,'build'),platform=p['runtime.platform.path'],variant=p['build.variant.path'],sdk=p['compiler.sdk.path'];
 // Reject unsupported recipes before doing discovery twice: an official
 // frontend cannot make this native executor understand new platform rules.
 if(sha(fs.readFileSync(path.join(platform,'platform.txt')))!==platformRecipeHash(p['build.arch'].toLowerCase(),path.basename(platform)))unsupported('unqualified platform');
 for(const name of ['boards.local.txt','platform.local.txt'])if(fs.existsSync(path.join(platform,name)))unsupported('local platform override requires qualification');
 fs.mkdirSync(build,{recursive:true});
 if(p['build.arch'].toLowerCase()==='esp32'){
 const partitions=[path.join(c.sketchDir,'partitions.csv'),path.join(variant,'partitions.csv'),path.join(platform,'tools/partitions',p['build.partitions']+'.csv')].find(fs.existsSync);writeChanged(path.join(build,'partitions.csv'),fs.readFileSync(partitions));
 const variantBoot=p['build.custom_bootloader'];
 if(!/^[\w-]+$/.test(variantBoot??''))throw new NeedsOfficial('Unqualified variant bootloader name');
 const output=path.join(build,'sketch.ino.bootloader.bin');
 const boot=[path.join(c.sketchDir,'bootloader.bin'),path.join(variant,variantBoot+'.bin')].find(fs.existsSync);
 if(boot)fs.copyFileSync(boot,output);
 else{
  const hook=p['recipe.hooks.prebuild.4.pattern'],match=hook.match(/"([^"\r\n]+esptool\.exe)" ([\s\S]*?)\s*\) \)$/);
  if(!match)throw new NeedsOfficial('bootloader hook differs');
  const argv=recipe({boot:'"'+match[1]+'" '+match[2]},'boot'),key=bootIdentity(argv,c,output,before);
  if(key&&prior?.key===key&&sha(prior.bytes)===prior.sha256){
   writeChanged(output,prior.bytes);bootResult={...prior,reused:true};
  }else{
   run(argv,{cwd:c.sysroot});
   if(key){const bytes=fs.readFileSync(output);bootResult={key,bytes,sha256:sha(bytes),reused:false};}
  }
 }
 writeChanged(path.join(build,'build_opt.h'),'');writeChanged(path.join(build,'file_opts'),'');writeChanged(path.join(build,'sdkconfig'),fs.readFileSync(path.join(sdk,'sdkconfig')));
 }
 const opts={'additionalFiles':'','compiler.optimization_flags':p['compiler.optimization_flags']??'',customBuildProperties:(c.buildProperties??[]).join(','),fqbn:c.fqbn,hardwareFolders:[platform,p['build.core.platform.path']].join(','),otherLibrariesFolders:[...(c.collections??[]),c.userLibraries].join(','),sketchLocation:path.resolve(c.sketchDir)};writeChanged(path.join(build,'build.options.json'),JSON.stringify(opts,null,2));
 return bootResult;
}
function includeArgs(dirs){return dirs.map(d=>'"-I'+d+'"').join(' ');}
function compileEntry(c,p,file,base,out,dirs){
 const ext=path.extname(file),kind=['.cc','.cxx'].includes(ext)?'.cpp':ext,key='recipe'+kind+'.o.pattern',object=path.join(out,path.relative(base,file)+'.o');
 fs.mkdirSync(path.dirname(object),{recursive:true});
 return {directory:c.sysroot,arguments:recipe(p,key,{includes:includeArgs(dirs),source_file:file,object_file:object}),file};
}
function preprocArgs(p,file,dirs){const row={...p,'recipe.preproc':p['recipe.cpp.o.pattern'].replace(p['compiler.cpp.flags'],p['compiler.cpp.flags']+' -w -x c++ -E -CC')};return recipe(row,'recipe.preproc',{includes:includeArgs(dirs),source_file:file,object_file:'nul'}).filter(a=>a!=='-MMD');}
function searchDirectories(args,cwd){const expanded=responses(args.slice(1),cwd).expanded;const dirs=[];let prefix='';for(let i=0;i<expanded.length;i++){const a=expanded[i];if(a==='-iprefix')prefix=expanded[++i];else if(['-I','-isystem','-iquote','-idirafter'].includes(a))dirs.push(expanded[++i]);else if(['-iwithprefix','-iwithprefixbefore'].includes(a))dirs.push(path.join(prefix,expanded[++i]));else if(a.startsWith('-I'))dirs.push(a.slice(2));}return dirs;}
export async function discover(c,p,index,{onSketchReady,deferCore=false}={}){const limit=c.jobs??8,workers=p['build.arch'].toLowerCase()==='esp32'&&c.features?.coldScheduling!==false?Math.min(limit,os.availableParallelism()):limit,started=performance.now(),snapshot=sketchSnapshot(c.sketchDir),selected=[],includes=[p['build.core.path'],p['build.variant.path']],queue=[{file:initialSketch(c,snapshot),extra:null},...snapshot.units.map(name=>({file:path.join(c.workspace,'build/sketch',name),extra:null,projectUnit:true}))],seen=new Set(queue.map(x=>x.file)),probes=[],decisions=[],compiledObjects=new Map(),pool=new DiscoveryPool(workers);let pos=0,sketchPreprocess=null;const captureFile=path.join(c.workspace,'graph','frontend','discovery-sketch.cpp');fs.mkdirSync(path.dirname(captureFile),{recursive:true});
 const result={selected,includes,probes,decisions,indexSha256:index.sha256,timings:{workers}};
 Object.defineProperty(result,'sketchPreprocess',{enumerable:false,writable:true,value:null});
 Object.defineProperty(result,'compiledObjects',{enumerable:false,writable:true,value:compiledObjects});
 const coreJobs=[],sketchJobs=[];
 // The diagnostic selector only disables optimizations for matched desktop
 // A/B tests; it cannot bypass any content proof or enable unsupported inputs.
 const optimized=c.features?.coldScheduling!==false&&(!process.env.CK_DIAGNOSTIC_DISPATCH||fs.readFileSync(process.env.CK_DIAGNOSTIC_DISPATCH,'utf8')==='candidate');
 setRecipeTokenMemo(optimized);pool.eagerRelease=optimized;
 let completedCompilers=0;
 const runCompiler=async(argv,cwd)=>{const r=await asyncRun(argv,cwd,{critical:optimized&&(argv.includes('-E')||argv.includes('c++-header'))});const file=compilerSourceArgument(argv);reportActivity(c,`发现/编译：已结束 ${++completedCompilers} 个 GCC 任务 · ${path.basename(file)}${r.code===0?'':'（正在处理诊断）'}`);return r;};
 const earlyLibrary=optimized&&c.discoveryCompileReference!==true,earlyResults=new Map(),earlyJobs=[];result.speculativeCompiles=[];
 const sourceHeaders=earlyLibrary?literalSketchIncludes(fs.readFileSync(source(c),'utf8')):[];
 const libraryPch=p['build.arch'].toLowerCase()==='esp32'&&c.features?.sharedHeaderPch!==false&&c.coldLibraryPchReference!==true?new RequestLibraryPch(c,pool,runCompiler,searchDirectories):null;
 if(libraryPch)result.libraryPch=libraryPch.rows;
 // Core commands have their own include order and do not select libraries.
 // On rediscovery leave their outputs for the content-checking scheduler.
 if(c.discoveryCompileReference!==true&&!deferCore){
  const coreDirs=[p['build.core.path'],p['build.variant.path']],entries=[];
  for(const dir of [...coreDirs].reverse())for(const file of sourceFiles(dir,true))entries.push(compileEntry(c,p,file,dir,path.join(c.workspace,'build/core'),coreDirs));
  const outputs=entries.map(e=>e.arguments[e.arguments.indexOf('-o')+1]);
  // A duplicate output requires the existing scheduler/qualification handling.
  if(new Set(outputs).size===outputs.length){
   const rsp=path.join(c.workspace,'graph','core-file-options.rsp');writeChanged(rsp,'-DARDUINO_CORE_BUILD\n');
   for(const entry of entries)entry.arguments=entry.arguments.map(arg=>arg.startsWith('@')&&path.basename(arg.slice(1))==='file_opts'?'@'+rsp:arg);
   const corePlans=libraryPch?.prepare(entries.filter(e=>['.cpp','.cc','.cxx'].includes(path.extname(e.file))));
   for(const entry of entries)coreJobs.push((async()=>{
    const args=entry.arguments.map(arg=>arg.startsWith('@')&&path.basename(arg.slice(1))==='file_opts'?'@'+rsp:arg),object=args[args.indexOf('-o')+1],depfile=object.replace(/\.o$/,'.d'),identity=compileIdentity(args,c.sysroot);
    const corePlan=corePlans?.get(identity),produced=corePlan?await libraryPch.compile(corePlan,args,c.sysroot,1):null;
    const r=produced?.result??await pool.run(1,()=>runCompiler(args,c.sysroot));if(r.code!==0)throw Error('Core compilation failed: '+r.stderr.slice(-2000));
    const record=observeDiscoveryCompile({argv:args,actualArgv:produced?.actual??args,pchGrant:produced?.grant,cwd:c.sysroot,source:entry.file,output:object,depfile,identity});if(record)compiledObjects.set(object,record);
    probes.push({unit:entry.file,kind:'compile',role:'core',argv:produced?.actual??args,...r,positiveIncludes:readNativeDependencies(depfile,c.sysroot,object).map(f=>path.resolve(c.sysroot,f)),positiveObservation:'compiler-MMD-plus-complete-system-asset-proof'});
   })().then(()=>null,error=>error));
  }
 }
 let failure;
 try{
 // Submit the known closure to the bounded pool. A fixed-size batch barrier
 // used to leave idle slots while its slowest unit delayed the next library.
 // All jobs use this immutable include generation and drain before a missing
 // header changes selection; result handling retains deterministic queue order.
 while(pos<queue.length){let batch=queue.slice(pos,pos===0?1:pos+(c.jobs??8));const version=includes.join('\0');
 const plans=libraryPch?.prepare(queue.slice(pos).filter(u=>u.library&&['.cpp','.cc','.cxx'].includes(path.extname(u.file))).map(u=>{
  const e=compileEntry(c,p,u.file,u.base,u.out,[...includes,...(u.extra?[u.extra]:[])]),rsp=path.join(c.workspace,'graph','normal-file-options.rsp');writeChanged(rsp,'');e.arguments=e.arguments.map(a=>a.startsWith('@')&&path.basename(a.slice(1))==='file_opts'?'@'+rsp:a);return e;
 }),pos===0?new Set(probes.flatMap(p=>p.positiveIncludes??[]).map(f=>path.resolve(f).toLowerCase())):null);
 if(pos>0&&c.discoveryBatchReference===false&&(!libraryPch||plans?.size))batch=queue.slice(pos);
 // A compiler-observed header/PCH group makes this a worthwhile candidate,
 // never a selection decision. Jobs use immutable arguments, issue content
 // proofs immediately on exit and drain before any include-order change.
 const avrEarly=p['build.arch'].toLowerCase()==='avr'&&workers>=4;
 if(earlyLibrary&&pos===0&&(plans?.size||avrEarly)&&sourceHeaders.every(header=>[c.sketchDir,...includes].some(dir=>fs.existsSync(path.resolve(dir,header))))){for(const unit of queue.filter(u=>u.library&&(['.cpp','.cc','.cxx'].includes(path.extname(u.file))||avrEarly&&path.extname(u.file)==='.c'))){
  const entry=compileEntry(c,p,unit.file,unit.base,unit.out,[...includes,...(unit.extra?[unit.extra]:[])]),rsp=path.join(c.workspace,'graph','normal-file-options.rsp');writeChanged(rsp,'');
  const args=entry.arguments.map(a=>a.startsWith('@')&&path.basename(a.slice(1))==='file_opts'?'@'+rsp:a),identity=compileIdentity(args,c.sysroot);if(earlyResults.has(identity))continue;
  const attempt={unit:unit.file,identity,includeOrder:version,consumed:false};result.speculativeCompiles.push(attempt);
  const plan=plans?.get(identity),pending=(async()=>{
   const produced=plan?await libraryPch.compile(plan,args,c.sysroot,1):null,actual=produced?.actual??args,r=produced?.result??await pool.run(avrEarly?0:1,()=>runCompiler(args,c.sysroot));
   Object.assign(attempt,{pid:r.pid,startedUnixMs:r.startedUnixMs,elapsedMs:r.elapsedMs,exitCode:r.code});
   const output=args[args.indexOf('-o')+1],record=r.code===0?observeDiscoveryCompile({argv:args,actualArgv:actual,pchGrant:produced?.grant,cwd:c.sysroot,source:unit.file,output,depfile:output.replace(/\.o$/,'.d'),identity}):null;
   return {result:r,actual,grant:produced?.grant??null,record,attempt};
  })();
  pending.catch(()=>{});earlyResults.set(identity,pending);earlyJobs.push(pending);
 }}
 const completed=await Promise.allSettled(batch.map(async unit=>{
  const dirs=[...includes,...(unit.extra?[unit.extra]:[])];
  // A cold project C++ unit can discover its headers while producing its
  // final object, just like a library unit. Rediscovery leaves existing
  // objects for the scheduler. Only the final command and depfile can admit it.
  const projectCompile=unit.projectUnit&&optimized&&!deferCore;
  const eager=(unit.library||projectCompile)&&['.cpp','.cc','.cxx'].includes(path.extname(unit.file))&&c.discoveryCompileReference!==true;
  const sketchRoot=path.join(c.workspace,'build','sketch');
  const entry=eager?compileEntry(c,p,unit.file,unit.base??sketchRoot,unit.out??sketchRoot,dirs):null;
  let args=entry?entry.arguments:preprocArgs(p,unit.file,dirs);
  if(unit.projectUnit&&['.c','.S'].includes(path.extname(unit.file))){
   const row=compileEntry(c,p,unit.file,path.dirname(unit.file),path.dirname(unit.file),dirs);
   args=[row.arguments[0],'-E','-CC',...row.arguments.slice(1).filter(a=>a!=='-MMD')];args[args.indexOf('-o')+1]='nul';
  }
  if(eager){const rsp=path.join(c.workspace,'graph','normal-file-options.rsp');writeChanged(rsp,'');args=args.map(arg=>arg.startsWith('@')&&path.basename(arg.slice(1))==='file_opts'?'@'+rsp:arg);}
  const output=args.indexOf('-o'),identity=eager?compileIdentity(args,c.sysroot):null;
  const capture=unit.file===queue[0].file&&c.discoveryPreprocessReference!==true&&output>=0&&output<args.length-1;
  if(capture){args.push('-dD');args[output+1]=captureFile;}
  // -H is recorded in this compiler's DW_AT_producer. An object-producing
  // probe must use the exact final command; read its actual .d file instead.
  const canonical=[...args,'-H'];
  const libraryPlan=eager?plans?.get(identity):null;
  const libraryResult=earlyResults.has(identity)?await earlyResults.get(identity):libraryPlan?await libraryPch.compile(libraryPlan,args,c.sysroot):null;
  if(libraryResult?.attempt)libraryResult.attempt.consumed=true;
  const executed=libraryResult?.actual??(eager?args:canonical),r=libraryResult?.result??await pool.run(0,()=>runCompiler(executed,c.sysroot));
  if(eager&&r.code===0){const object=args[output+1],record=libraryResult?.attempt?libraryResult.record:observeDiscoveryCompile({argv:args,actualArgv:executed,pchGrant:libraryResult?.grant,cwd:c.sysroot,source:unit.file,output:object,depfile:object.replace(/\.o$/,'.d'),identity});if(record)compiledObjects.set(object,record);}
  if(capture&&r.code===0){const bytes=fs.readFileSync(captureFile);sketchPreprocess={identity:preprocessIdentity(canonical,c.sysroot,fs.readFileSync(unit.file)),bytes,sha256:sha(bytes),includeOrder:version};}
  // Keep Arduino's C++ discovery probe for C library units. Once it has
  // succeeded, the actual C recipe can use an available slot before the
  // scheduler's compile barrier. Only the final argv and .d closure admit it.
  if(optimized&&r.code===0&&unit.library&&path.extname(unit.file)==='.c'&&c.discoveryCompileReference!==true){
   const entry=compileEntry(c,p,unit.file,unit.base,unit.out,dirs),rsp=path.join(c.workspace,'graph','normal-file-options.rsp');writeChanged(rsp,'');
   const argv=entry.arguments.map(a=>a.startsWith('@')&&path.basename(a.slice(1))==='file_opts'?'@'+rsp:a);
   const id=compileIdentity(argv,c.sysroot);
   if(earlyResults.has(id)){
    const early=await earlyResults.get(id);early.attempt.consumed=true;
    probes.push({unit:unit.file,kind:'compile',role:'c-library',argv,...early.result});
    if(early.record)compiledObjects.set(early.record.output,early.record);
   }else{
    const object=argv[argv.indexOf('-o')+1],depfile=object.replace(/\.o$/,'.d');
    // Restarted discovery can change -I while a prior result is pending.
    // Finish this generation before permitting any other writer to its output.
    const result=await pool.run(0,()=>runCompiler(argv,c.sysroot));
    probes.push({unit:unit.file,kind:'compile',role:'c-library',argv,...result});
    if(result.code===0){
     const observed=observeDiscoveryCompile({argv,cwd:c.sysroot,source:unit.file,output:object,depfile,identity:id});
     if(observed)compiledObjects.set(object,observed);
    }
   }
  }
  const positives=eager?(r.code===0?readNativeDependencies(args[output+1].replace(/\.o$/,'.d'),c.sysroot,args[output+1]).map(f=>path.resolve(c.sysroot,f)):[]):compilerIncludes(r.stderrBytes,c.sysroot);
  const probe={unit:unit.file,kind:eager?'compile':'preprocess',argv:executed,...r,explicitSearchOrder:searchDirectories(args,c.sysroot),positiveIncludes:[...new Set(positives)],positiveObservation:eager?'compiler-MMD-plus-complete-system-asset-proof':'compiler-H',missingHeader:null};probes.push(probe);return probe;
 }));const failed=completed.find(r=>r.status==='rejected');if(failed)throw failed.reason;const results=completed.map(r=>r.value);if(earlyLibrary&&results.some(r=>r.code!==0))await Promise.allSettled(earlyJobs);let restart=false;
  for(const probe of results){if(includes.join('\0')!==version)break;if(probe.code===0){
   if(pos===0&&onSketchReady){result.timings.sketchReadyMs=performance.now()-started;result.sketchPreprocess=sketchPreprocess?.includeOrder===includes.join('\0')?sketchPreprocess:null;
    // This candidate is speculative until the complete library closure has
    // been checked. The final planner rechecks its full command and inputs.
    sketchJobs.push(Promise.resolve().then(()=>onSketchReady(result,pool)).then(()=>null,error=>error));
   }
   pos++;continue;}const match=probe.stderr.match(/fatal error: ([^\r\n]+): No such file or directory/);if(!match)throw new NeedsOfficial('preprocessor error: '+probe.stderr.slice(-1500));const header=match[1];probe.missingHeader=header;probe.negativeExplicitCandidates=[path.dirname(probe.unit),...probe.explicitSearchOrder].map(d=>({file:path.resolve(d,header),exists:fs.existsSync(path.resolve(d,header))}));const choice=resolve(index,header,p['build.arch'].toLowerCase());decisions.push(choice);if(!choice.qualified)throw Object.assign(new NeedsOfficial(choice.reason+': '+header),{decisions,probes});const lib=choice.winner;if(selected.some(x=>x.install_dir===lib.install_dir))throw new NeedsOfficial('selected candidate still missing header');if(lib.precompiled||lib.dot_a_linkage||lib.ldflags||fs.existsSync(path.join(lib.install_dir,'arch')))throw new NeedsOfficial('unsupported library archive/hook layout');selected.push(lib);includes.push(lib.source_dir);for(const file of [...sourceFiles(lib.source_dir,lib.layout==='recursive'),...(lib.utility?sourceFiles(lib.utility,false):[])])if(!seen.has(file)){seen.add(file);const utility=lib.utility&&path.relative(lib.utility,file).split(path.sep)[0]!=='..';queue.push({file,extra:lib.utility,library:lib,base:utility?lib.utility:lib.source_dir,out:path.join(c.workspace,'build','libraries',lib.dirName,...(utility?['utility']:[]))});}restart=true;break;}
  if(!restart&&pos<queue.length&&batch.length===0)throw Error('empty discovery queue');if(probes.length>1000)throw new NeedsOfficial('discovery work bound');
 }
 result.timings.selectionReadyMs=performance.now()-started;
 result.sketchPreprocess=sketchPreprocess?.includeOrder===includes.join('\0')?sketchPreprocess:null;

 }catch(error){failure=error;}
 // Even a rejected resolver must not let old compilers write while the
 // fallback clears this workspace. Cancellation still drains the owned Job.
 const coreFailures=(await Promise.all([...coreJobs,...sketchJobs])).filter(Boolean);
 await Promise.allSettled(earlyJobs);
 if(libraryPch)await libraryPch.close();
 if(failure)throw failure;if(coreFailures.length)throw coreFailures[0];
 result.timings.completeMs=performance.now()-started;
 result.timings.compileObservationMs=[...compiledObjects.values()].reduce((total,r)=>total+(r.observationMs??0),0);
 return result;
}
export function compilationDatabase(c,p,d){const build=path.join(c.workspace,'build'),entries=[];
 function add(file,base,out,dirs){entries.push(compileEntry(c,p,file,base,out,dirs));}
 const sketchDir=path.join(build,'sketch');for(const name of [...sketchSnapshot(c.sketchDir).units,'sketch.ino.cpp'].sort())add(path.join(sketchDir,name),sketchDir,sketchDir,d.includes);
 for(const lib of d.selected){const dirs=[...d.includes,...(lib.utility?[lib.utility]:[])],out=path.join(build,'libraries',lib.dirName);for(const f of sourceFiles(lib.source_dir,lib.layout==='recursive'))add(f,lib.source_dir,out,dirs);if(lib.utility)for(const f of sourceFiles(lib.utility,false))add(f,lib.utility,path.join(out,'utility'),dirs);}
 const coreDirs=[p['build.core.path'],p['build.variant.path']];for(const dir of [...coreDirs].reverse())for(const f of sourceFiles(dir,true))add(f,dir,path.join(build,'core'),coreDirs);
 write(path.join(build,'compile_commands.json'),entries);return entries;
}
export function frontendObject(p,selected){return {success:true,builder_result:{build_properties:Object.keys(p).sort().map(k=>k+'='+p[k]),used_libraries:selected.map(l=>({...l,location:l.location==='user'?'user':l.location,source_dir:l.source_dir,install_dir:l.install_dir}))}};}
export function clearBuild(c){const base=path.resolve(c.workspace),target=path.resolve(base,'build');checkedBuildPath(c,target,true);removeScratchTree(target);}
