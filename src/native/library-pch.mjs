import fs from 'node:fs';
import path from 'node:path';
import {executable,responses,sha} from './plan.mjs';
import {readNativeDependencies} from './depfile.mjs';
import {nativeDependencyTarget} from './object-cache.mjs';
import {checkedBuildPath} from '../paths.mjs';

const grants=new WeakMap();
const identity=(args,cwd)=>sha(JSON.stringify([executable(args[0]),path.resolve(cwd),responses(args.slice(1),cwd).expanded]));
const proof=file=>({file:path.resolve(file),sha256:sha(fs.readFileSync(file))});
function leading(text){
 text=text.replace(/^\uFEFF/,'');
 for(;;){text=text.trimStart();if(text.startsWith('//')){const end=text.indexOf('\n');if(end<0)return '';text=text.slice(end+1);}
  else if(text.startsWith('/*')){const end=text.indexOf('*/');if(end<0)return '';text=text.slice(end+2);}else return text;}
}
export function firstGuardedHeader(entry,searchDirectories){
 const text=leading(fs.readFileSync(entry.file,'utf8'));
 const first=text.match(/^#\s*include\s*([<"])([^>"\r\n]+)[>"]\s*(?:\r?\n|$)/);
 if(!first)return null;
 const dirs=[...(first[1]==='"'?[path.dirname(entry.file)]:[]),...searchDirectories(entry.arguments,entry.directory)];
 const header=dirs.map(d=>path.resolve(d,first[2])).find(f=>fs.existsSync(f));if(!header)return null;
 const body=leading(fs.readFileSync(header,'utf8'));
 // Absolute wrapper inclusion must not change include-next's starting point.
 if(/\b(?:include_next|__has_include_next)\b/.test(body))return null;
 const guard=body.match(/^#\s*ifndef\s+([A-Za-z_]\w*)[^\S\r\n]*(?:\r?\n)/);
 const once=/^#\s*pragma\s+once[^\S\r\n]*(?:\r?\n|$)/.test(body);
 if(!once&&(!guard||!new RegExp('^#\\s*define\\s+'+guard[1]+'[^\\S\\r\\n]*(?:\\r?\\n|$)').test(leading(body.slice(guard[0].length)))))return null;
 const expanded=responses(entry.arguments.slice(1),entry.directory).expanded;
 if(expanded.some(a=>/^(?:-include|-imacros|-Wp,|-Xpreprocessor|-save-temps|-fpreprocessed)/.test(a)))return null;
 const args=entry.arguments.filter(a=>a!==entry.file),at=args.indexOf('-o');if(at<0)return null;args.splice(at,2);
 return {header,args,key:sha(JSON.stringify([header,entry.directory,executable(args[0]),responses(args.slice(1),entry.directory).expanded]))};
}
export function acceptsLibraryPchGrant(grant,canonical,actual,cwd){
 const g=grants.get(grant);return !!g&&g.canonical===identity(canonical,cwd)&&g.actual===identity(actual,cwd);
}

// Consume only the post-compiler header hashes from this live invocation.
// The scheduler independently rechecks every input before admitting its object.
export function takeLibraryPchInputProofs(grant,canonical,actual,cwd){
 const g=grants.get(grant);
 if(!g||!acceptsLibraryPchGrant(grant,canonical,actual,cwd))return null;
 grants.delete(grant);return g.inputs;
}

// Only a repeated, unconditional first include with its own include guard is
// eligible. The wrapper includes the ORIGINAL header by absolute path; source
// and header search directories never move. No PCH is restored from disk.
export class RequestLibraryPch {
 constructor(c,pool,run,searchDirectories){this.c=c;this.pool=pool;this.run=run;this.searchDirectories=searchDirectories;this.groups=new Map();this.rows=[];this.files=[];this.next=0;}
 prepare(entries,observedHeaders=null){
  const groups=new Map(),plans=new Map();
  for(const entry of entries){const p=firstGuardedHeader(entry,this.searchDirectories);if(!p||observedHeaders&&!observedHeaders.has(path.resolve(p.header).toLowerCase()))continue;const group=groups.get(p.key)??{...p,entries:[]};group.entries.push(entry);groups.set(p.key,group);}
  for(const [key,group]of groups){
   if(group.entries.length<3&&!this.groups.has(key))continue;
   if(!this.groups.has(key)){
    const pending=this.pool.run(0,()=>this.build(group));
    // Discovery can still be visiting an earlier source while this speculative
    // group completes. Attach a rejection handler immediately; its consumer
    // still receives the original rejection and normal request cleanup drains.
    pending.catch(()=>{});this.groups.set(key,pending);
   }
   for(const entry of group.entries)plans.set(identity(entry.arguments,entry.directory),this.groups.get(key));
  }
  return plans;
 }
 async build(group){
  const dir=checkedBuildPath(this.c,path.join(this.c.workspace,'build','.pch'));fs.mkdirSync(dir,{recursive:true});
  // Full identities stay in the request-local map. Short disposable filenames
  // avoid MAX_PATH failures under the installed desktop's longer workspace.
  const wrapper=path.join(dir,String(this.next++)+'.hpp'),gch=wrapper+'.gch',depfile=wrapper+'.d';
  for(const file of [wrapper,gch,depfile])checkedBuildPath(this.c,file);this.files.push(wrapper,gch,depfile);
  fs.writeFileSync(wrapper,'#include '+JSON.stringify(group.header.replaceAll('\\','/'))+'\n');
  const args=[...group.args.filter(a=>!['-c','-MMD'].includes(a)),'-x','c++-header','-MD','-MF',depfile,wrapper,'-o',gch];
  const r=await this.run(args,this.c.sysroot),row={header:group.header,units:group.entries.length,compileMs:r.elapsedMs,exitCode:r.code,accepted:false};this.rows.push(row);
  if(r.code!==0){row.reason='header-build-failed';return null;}
  const deps=[...new Set(readNativeDependencies(depfile,this.c.sysroot,gch).map(f=>path.resolve(this.c.sysroot,f)))].filter(f=>f!==wrapper);
  const headerProofs=[];
  for(const file of deps){
   const bytes=fs.readFileSync(file);
   if(/\b(?:__BASE_FILE__|__INCLUDE_LEVEL__)\b/.test(bytes.toString('utf8'))){row.reason='source-context-sensitive-header';return null;}
   headerProofs.push({file,sha256:sha(bytes)});
  }
  row.accepted=true;row.dependencies=deps.length;
  return {wrapper,gch,deps,proofs:[proof(wrapper),proof(gch),...headerProofs],row};
 }
 async compile(plan,args,cwd,priority=0){
  const p=await plan;if(!p)return {result:await this.pool.run(priority,()=>this.run(args,cwd)),actual:args,grant:null};
  const actual=[...args,'-include',p.wrapper];
  const result=await this.pool.run(priority,()=>this.run(actual,cwd));
  if(result.code!==0)return {result,actual,grant:null};
  const proofAt=performance.now();
  if(!p.proofs.every(x=>proof(x.file).sha256===x.sha256))throw Error('Request PCH input/output changed');
  p.row.proofMs=(p.row.proofMs??0)+performance.now()-proofAt;
  const output=args[args.indexOf('-o')+1],depfile=output.replace(/\.o$/,'.d');
  const dependencies=[...new Set([...readNativeDependencies(depfile,cwd,output).map(f=>path.resolve(cwd,f)),...p.deps])].filter(f=>f!==p.wrapper&&f!==p.gch);
  // GCC omits the PCH closure from -MMD. Bind its compiler-observed full -MD
  // closure into the ordinary dependency file before observing this object.
  // The disposable wrapper has no content beyond the original absolute include.
  fs.writeFileSync(depfile,nativeDependencyTarget(output)+': '+dependencies.map(nativeDependencyTarget).join(' \\\n ' )+'\n');
  const grant={};grants.set(grant,{canonical:identity(args,cwd),actual:identity(actual,cwd),inputs:new Map(p.proofs.slice(2).map(x=>[x.file,x.sha256]))});
  p.row.compiled=(p.row.compiled??0)+1;return {result,actual,grant};
 }
 async close(){await Promise.allSettled(this.groups.values());for(const file of this.files){checkedBuildPath(this.c,file);if(fs.existsSync(file))fs.unlinkSync(file);}const dir=checkedBuildPath(this.c,path.join(this.c.workspace,'build','.pch'));if(fs.existsSync(dir)&&fs.readdirSync(dir).length===0)fs.rmdirSync(dir);}
}
