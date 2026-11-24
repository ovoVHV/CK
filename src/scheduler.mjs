import {reportActivity} from './build-activity.mjs';
import {checkedBuildPath} from './paths.mjs';
// Isolated T1 session scheduler. Disk metadata never creates authority.
import fs from 'node:fs';import path from 'node:path';
import {constants as zlib,zstdCompressSync,zstdDecompressSync} from 'node:zlib';
import {sha} from './resolver.mjs';import {asyncRun} from './discovery.mjs';
import {emitGraph,responses,writeChanged} from './native/plan.mjs';
import {readNativeDependencies} from './native/depfile.mjs';
import {acceptsDiscoveryCompile} from './native/discovery-compile-proof.mjs';
import {executeBatch,supportsDirectRule} from './direct-executor.mjs';
export const proof=f=>{const b=fs.readFileSync(f);return {file:f,bytes:b.length,sha256:sha(b)};};
export function commandKey(r){return sha(JSON.stringify([r.kind,r.directory,r.argv,responses(r.argv.slice(1),r.directory).expanded,r.nativeElfImage??null,r.nativeMergeBin??null,r.windowsVerbatimArguments??false,r.sizePolicy??null]));}
function memoProof(stats){const memo=new Map();return f=>{if(!memo.has(f)){try{const p=proof(f);if(stats){stats.reads++;stats.bytes+=p.bytes;}memo.set(f,p);}catch{memo.set(f,null);}}return memo.get(f);};}
function dependencies(r){return [...new Set([...r.inputs,...responses(r.argv.slice(1),r.directory).files,...(r.depfile&&fs.existsSync(r.depfile)?readNativeDependencies(r.depfile,r.directory,r.output).map(f=>path.resolve(r.directory,f)):[])])];}
function remove(c,file){const base=path.resolve(c.workspace,'build'),f=path.resolve(file),rel=path.relative(base,f);if(!rel||rel.startsWith('..')||path.isAbsolute(rel))throw Error('Outside F isolated build');checkedBuildPath(c,f);if(fs.existsSync(f))fs.unlinkSync(f);}
const stages=[['pch'],['compile'],['archive'],['link'],['image','metadata']];
const executeDecision={pch:'Compile',compile:'Compile',archive:'Rebuild',link:'Link',image:'Generate',metadata:'Generate'};
export function packHistory(row){
 if(row.bytes.length<262144)return row;
 const bytes=zstdCompressSync(row.bytes,{params:{[zlib.ZSTD_c_compressionLevel]:1}});
 return bytes.length<row.bytes.length*0.9?{...row,bytes,compressed:true}:row;
}
export function verifiedHistory(row){
 try{
  const bytes=row.compressed?zstdDecompressSync(row.bytes,{maxOutputLength:row.proof.bytes}):row.bytes;
  if(bytes.length!==row.proof.bytes||sha(bytes)!==row.proof.sha256||row.depBytes&&sha(row.depBytes)!==row.dependencyMetadata.sha256)return null;
  return {...row,bytes};
 }catch{return null;}
}
export class NativeScheduler {
 #history=new Map();#retained=new Map();#historyOrder=[];#historyBytes=0;#capacity;
 constructor({historyBytes=128*1024*1024}={}){this.#capacity=historyBytes;}
 reset(){this.#history.clear();this.#retained.clear();this.#historyOrder=[];this.#historyBytes=0;}
 async execute(c,plan,identity,{restore=true,optimize=false,produced=new Map()}={}){
  const decisions=[],steps=[],timings=[],batchTimings=[],runs=[],pending=[];let invocations=0;
  const historyKey=key=>sha(JSON.stringify([identity.context,identity.assets,identity.namespace,key]));
  const retentionKey=key=>sha(JSON.stringify([identity.context,identity.fixedAssets,identity.namespace,key]));
  // A stage is a topological batch. Completed outputs are fixed file inputs of
  // the next batch. Only content-qualified tasks may be omitted from Ninja.
  for(const kinds of stages){const remaining=plan.rules.filter(r=>kinds.includes(r.kind));
   while(remaining.length){const batch=remaining.filter(r=>!r.inputs.some(f=>remaining.some(other=>other!==r&&other.output===f)));if(!batch.length)throw Error('Task cycle');const get=memoProof(),dirty=[];
    for(const r of batch){
     // Share fresh content observations only within this topological batch,
     // just as retained-object admission already does below. Output and .d
     // proofs remain individual; the request still rechecks all assets after
     // execution before committing any new authority.
     if(acceptsDiscoveryCompile(produced.get(r.output),r,c.features?.batchInputProof===false?undefined:get)){decisions.push({task:r.kind,output:r.output,decision:produced.get(r.output).producer==='sketch-pipeline'?'UsePipelinedObject':'UseDiscoveryObject',reason:'same-request-compiler-result-with-final-inputs',actualWrites:0});continue;}
     const key=commandKey(r),prior=this.#retained.get(r.output),current=get(r.output),matches=x=>x&&x.inputs.every(p=>get(p.file)?.sha256===p.sha256),validPrior=prior&&prior.retentionKey===retentionKey(key)&&prior.key===key&&matches(prior),metadataOk=x=>!r.depfile||get(r.depfile)?.sha256===x.dependencyMetadata?.sha256;
     let reason=!current?'output-missing':!prior?'no-session-authority':!validPrior?'input-or-command-changed':prior.proof.sha256!==current.sha256?'output-content-changed':!metadataOk(prior)?'dependency-metadata-changed':null;
     if(!reason){decisions.push({task:r.kind,output:r.output,decision:'Reuse',reason:'session-observed-content',actualWrites:0});}
     else {let old=null;if(restore)for(const x of this.#history.get(historyKey(key))??[]){if(matches(x)&&(old=verifiedHistory(x)))break;}
      if(old){const wrote=writeChanged(r.output,old.bytes);const depWrote=r.depfile?writeChanged(r.depfile,old.depBytes):false;decisions.push({task:r.kind,output:r.output,decision:'Restore',reason,version:old.version,sha256:old.proof.sha256,actualWrites:Number(wrote)+Number(depWrote),outputWritten:wrote,dependencyMetadataWritten:depWrote});}
      else {remove(c,r.output);dirty.push(r);decisions.push({task:r.kind,output:r.output,decision:executeDecision[r.kind],reason});}
     }
    }
    if(dirty.length){
     const stage={pch:'预编译头',compile:'对象编译',archive:'静态归档',link:'链接固件',image:'生成镜像',metadata:'产物元数据'}[kinds[0]];reportActivity(c,`${stage}：开始 ${dirty.length} 项任务`);let completed=0;const taskDone=r=>reportActivity(c,`${stage}：完成 ${++completed}/${dirty.length} · ${path.basename(r.output)}`);

     const direct=c.features?.directExecution!==false&&!c.directExecutionReference&&['avr','esp32'].includes(plan.props['build.arch']?.toLowerCase())&&dirty.every(supportsDirectRule);
     if(direct){const result=await executeBatch(dirty,c.jobs??8,{onComplete:taskDone});runs.push({executor:'direct',code:0,elapsedMs:result.elapsedMs,tasks:result.results});batchTimings.push({kinds,tasks:dirty.length,executor:'direct',elapsedMs:result.elapsedMs});
      if(result.results.length!==dirty.length)throw Error('Scheduled/observed task count mismatch');
      for(const [i,r]of dirty.entries()){const {stdout,stderr,...timing}=result.results[i];timings.push(timing);steps.push({kind:r.kind.toUpperCase(),output:path.basename(r.output)});}
     }else{const stagePlan={...plan,rules:dirty,finalOutputs:dirty.map(r=>r.output)},ninja=emitGraph(stagePlan),start=Date.now();let pendingOutput='';const onStdout=text=>{pendingOutput+=text;let end;while((end=pendingOutput.indexOf('\n'))>=0){const line=pendingOutput.slice(0,end).trim();pendingOutput=pendingOutput.slice(end+1);if(/^\[\d+\/\d+\] /.test(line))reportActivity(c,`${stage}：${line}`);}if(pendingOutput.length>8192)pendingOutput=pendingOutput.slice(-8192);};const run=await asyncRun([c.ninja,'-C',plan.build,'-f',ninja,'-j',String(c.jobs??8),'-d','keepdepfile'],c.sysroot,{onStdout});invocations++;runs.push(run);batchTimings.push({kinds,tasks:dirty.length,executor:'ninja',elapsedMs:run.elapsedMs});if(run.code)throw Error(run.stderr+run.stdout);const actual=[...run.stdout.matchAll(/^\[\d+\/\d+\] (\S+) (.+)$/gm)].map(m=>({kind:m[1],output:m[2]}));if(actual.length!==dirty.length)throw Error('Scheduled/observed task count mismatch');steps.push(...actual);for(const r of dirty){const f=path.join(plan.graph,'timings',r.name+'.json');if(!fs.existsSync(f)||fs.statSync(f).mtimeMs<start-2)throw Error('Missing executor result');timings.push({rule:r.name,kind:r.kind,...JSON.parse(fs.readFileSync(f,'utf8'))});}}
    }
    for(const r of batch)remaining.splice(remaining.indexOf(r),1);
   }
  }
  // Prepare receipts only. The caller commits them after final source/asset
  // checks and artifact observation. Failed requests cannot publish authority.
  reportActivity(c,'收据验证：正在核对实际任务输出和依赖内容');
  const t=performance.now(),observation={optimize,reads:0,bytes:0},get=memoProof(observation),snapshots=new Map();
  function countedBytes(f){const b=fs.readFileSync(f);observation.reads++;observation.bytes+=b.length;return b;} function countedProof(f){const bytes=countedBytes(f);return {file:f,bytes:bytes.length,sha256:sha(bytes)};}
  const keepBytes=new Set(plan.rules.flatMap(r=>[r.output,...(r.depfile?[r.depfile]:[])]));
  function snapshot(f){if(!snapshots.has(f)){const bytes=countedBytes(f);snapshots.set(f,{bytes:keepBytes.has(f)?bytes:undefined,proof:{file:f,bytes:bytes.length,sha256:sha(bytes)}});}return snapshots.get(f);}
  for(const r of plan.rules){const inputs=dependencies(r).map(f=>{const x=optimize?snapshot(f).proof:get(f);if(!x)throw Error('Missing input '+f);return x;}),p=optimize?snapshot(r.output).proof:countedProof(r.output),dep=r.depfile?(optimize?snapshot(r.depfile).proof:countedProof(r.depfile)):null,bytes=optimize?snapshot(r.output).bytes:countedBytes(r.output),depBytes=r.depfile?(optimize?snapshot(r.depfile).bytes:countedBytes(r.depfile)):null;
   const key=commandKey(r),history=historyKey(key);
   pending.push({output:r.output,kind:r.kind,key,historyKey:history,retentionKey:retentionKey(key),proof:p,inputs,dependencyMetadata:dep,bytes,depBytes,version:sha(JSON.stringify([history,inputs,dep,p.sha256]))});}
  let committed=false;return {decisions,steps,timings,batchTimings,runs,invocations,observation,bytesFor:file=>pending.find(x=>x.output===file)?.bytes,observationMs:performance.now()-t,records:pending.map(({bytes,depBytes,...x})=>x),commit:()=>{if(committed)throw Error('Duplicate commit');for(const x of pending){const {bytes,depBytes,...proofOnly}=x;this.#retained.set(x.output,proofOnly);if(restore){const rows=this.#history.get(x.historyKey)??[];if(!rows.some(r=>r.version===x.version)){const stored=packHistory(x);rows.push(stored);this.#historyOrder.push(stored);this.#historyBytes+=stored.bytes.length+(depBytes?.length??0);}this.#history.set(x.historyKey,rows);}}
   // Cache capacity affects performance only. Eviction removes authority and
   // causes normal execution on a miss; it never substitutes weaker identity.
   while(this.#historyBytes>this.#capacity&&this.#historyOrder.length){const x=this.#historyOrder.shift(),rows=this.#history.get(x.historyKey);const rest=rows.filter(r=>r.version!==x.version);if(rest.length)this.#history.set(x.historyKey,rest);else this.#history.delete(x.historyKey);this.#historyBytes-=x.bytes.length+(x.depBytes?.length??0);}observation.historyBytes=this.#historyBytes;observation.historyCapacityBytes=this.#capacity;committed=true;}};
 }
}

