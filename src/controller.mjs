import fs from 'node:fs';import path from 'node:path';import {spawn} from 'node:child_process';import readline from 'node:readline';import {randomUUID} from 'node:crypto';
import {packageRoot} from './config.mjs';import {checkedWorkspace,rejectReparse} from './paths.mjs';import {validateRequest,BuildError} from './protocol.mjs';import {write,read,sha} from './resolver.mjs';
export class BuildController {
 constructor(config,{desktopPid}={}){this.config=config;this.desktopPid=desktopPid;this.workspaces=new Map();this.requests=new Map();this.closed=false;this.allocation=Promise.resolve();}
 async reserve(key,id){
  const predecessor=this.allocation;let unlock;this.allocation=new Promise(r=>unlock=r);await predecessor;
  try{
   if(this.closed)throw new BuildError('CLOSED','Controller closed');
   if(this.requests.has(id))throw new BuildError('DUPLICATE_REQUEST','Request already active');
   let slot=this.workspaces.get(key);
   if(!slot){if(this.workspaces.size>=this.config.limits.maxWorkspaces){const idle=[...this.workspaces].find(([k,s])=>![...this.requests.values()].some(r=>r.key===k)&&!s.quarantined);if(!idle)throw new BuildError('CAPACITY','All workspace slots are busy');await this.stopWorker(idle[1]);this.workspaces.delete(idle[0]);}slot={tail:Promise.resolve(),dead:true};this.workspaces.set(key,slot);}
   const previous=slot.tail;let release;slot.tail=new Promise(r=>release=r);const request={id,key,slot,release,active:false,cancelled:false};this.requests.set(id,request);return {request,previous};
  }finally{unlock();}
 }
 event(type,data={}){fs.mkdirSync(this.config.paths.evidenceRoot,{recursive:true});fs.appendFileSync(path.join(this.config.paths.evidenceRoot,'lifecycle.jsonl'),JSON.stringify({type,at:Date.now(),...data})+'\n');}
 async startWorker(key,slot){
  if(slot.quarantined)throw new BuildError('WORKSPACE_QUARANTINED','Unverified process exit; use a new desktop session');
  if(slot.runner&&!slot.dead)return;
  const dir=path.join(this.config.paths.evidenceRoot,'jobs',randomUUID());fs.mkdirSync(dir,{recursive:true});slot.dir=dir;slot.pending=new Map();
  const input=path.join(dir,'job.json');write(input,{argv:[this.config.paths.node,path.join(packageRoot,'src/worker.mjs')],cwd:packageRoot,owners:[process.pid,...(this.desktopPid?[this.desktopPid]:[])],mutex:'Local\\CK-V9-'+sha(key),startedFile:path.join(dir,'started.json'),metricsFile:path.join(dir,'metrics.json'),cancelFile:path.join(dir,'cancel')});
  const child=spawn(path.join(packageRoot,'bin/job.exe'),[input],{windowsHide:true,stdio:['pipe','pipe','pipe']});slot.runner=child;slot.dead=false;
  let readyResolve,readyReject;const ready=new Promise((a,b)=>{readyResolve=a;readyReject=b;});
  slot.exit=new Promise(resolve=>{
   const end=code=>{if(slot.dead)return;slot.dead=true;let drained=false;try{drained=read(path.join(dir,'metrics.json')).activeProcesses===0;}catch{}
    if(!drained)slot.quarantined=true;for(const p of slot.pending.values())p.reject(new BuildError('WORKER_EXIT','Worker exited: '+code));slot.pending.clear();readyReject(new BuildError('WORKER_EXIT','Worker failed to start'));this.event('worker-exit',{key,code,drained});resolve();};
   child.once('error',e=>end(e.message));child.once('close',end);
  });
  child.stderr.on('data',b=>fs.appendFileSync(path.join(dir,'stderr.log'),b));
  readline.createInterface({input:child.stdout}).on('line',line=>{try{const msg=JSON.parse(line);if(msg.type==='ready'){slot.pid=msg.pid;readyResolve();}else{const p=slot.pending.get(msg.id);if(!p)throw Error('Unexpected worker result');if(msg.type==='activity'){p.onActivity?.(msg.messages);return;}slot.pending.delete(msg.id);msg.type==='result'?p.resolve(msg.receipt):p.reject(Error(msg.error));}}catch(e){this.event('protocol-error',{key,error:String(e)});this.stopWorker(slot).catch(()=>{});}});
  const timer=setTimeout(()=>{readyReject(new BuildError('WORKER_TIMEOUT','Worker startup timed out'));this.stopWorker(slot).catch(()=>{});},15000);
  try{await ready;}finally{clearTimeout(timer);}
 }
 async submit(msg,{signal,onActivity}={}){
  if(this.closed)throw new BuildError('CLOSED','Controller closed');
  const r=validateRequest(msg,this.config),key=checkedWorkspace(r,this.config.paths.workspaceRoot);
  const {request,previous:predecessor}=await this.reserve(key,r.requestId),slot=request.slot;
  const abort=()=>{request.cancelled=true;if(request.active)this.stopWorker(slot).catch(()=>{});};
  signal?.addEventListener('abort',abort,{once:true});this.event('queued',{id:r.requestId,key});
  try{
   await predecessor;if(request.cancelled||signal?.aborted||this.closed)throw new BuildError('CANCELLED','Cancelled while queued');
   request.active=true;for(const p of r.libraries){rejectReparse(p);if(!fs.statSync(p).isDirectory())throw Error('Invalid library');}
   await this.startWorker(key,slot);if(request.cancelled||signal?.aborted)throw new BuildError('CANCELLED','Cancelled before execution');
   const cfg=this.config,p=cfg.paths;
   const c={sysroot:p.sysroot,cli:p.cli,ninja:p.ninja,cliConfig:p.cliConfig,userLibraries:p.userLibraries,workspaceRoot:p.workspaceRoot,evidence:path.join(p.evidenceRoot,'runs'),assetRoots:cfg.assetRoots,features:cfg.features,historyBytes:cfg.limits.historyBytes,sourceDateEpoch:cfg.sourceDateEpoch,jobs:cfg.limits.jobs,...r,collections:[],explicitLibraries:r.libraries,buildProperties:[],validation:{mode:cfg.features.assetBackend==='rust'?'rust':'node',...(r.validationReference?{workers:4,bufferBytes:1048576,sizeGrouped:true}:cfg.assetValidation),...(r.assetOpenReference?{openWorkers:0}:{})},receiptOptimize:false};
   const timeout=setTimeout(abort,cfg.limits.requestTimeoutMs);let receipt;
   try{receipt=await new Promise((resolve,reject)=>{slot.pending.set(r.requestId,{resolve,reject,onActivity});slot.runner.stdin.write(JSON.stringify({id:r.requestId,c,code:msg.source,options:{mode:r.forceOfficial?'official':'auto',frontendReplay:cfg.features.frontendReplay&&!r.frontendReference,objectRestore:cfg.features.sessionHistory&&!r.historyReference,linkHistory:cfg.features.sessionHistory&&!r.historyReference,noOpFastPath:r.noOpReference!==true}})+'\n',e=>{if(e)reject(e);});});}finally{clearTimeout(timeout);}
   if(request.cancelled||signal?.aborted)throw new BuildError('CANCELLED','Cancelled before result publication');
   request.active=false;request.receipt=receipt;
   if(!receipt.success){this.release(r.requestId,'build-failed');return receipt;}
   // Outputs remain leased until the host acknowledges its independent export.
   request.timer=setTimeout(()=>{this.cancel(r.requestId).catch(()=>{});},cfg.limits.leaseTimeoutMs);
   this.event('awaiting-export',{id:r.requestId,key});return receipt;
  }catch(e){try{if(request.active)await this.stopWorker(slot);}finally{this.release(r.requestId,'failed-or-cancelled');}throw e;}
  finally{signal?.removeEventListener('abort',abort);}
 }
 release(id,reason){const r=this.requests.get(id);if(!r)return;clearTimeout(r.timer);this.requests.delete(id);r.release();this.event('released',{id,key:r.key,reason});}
 async acknowledge(id,{sourceSha256,success}){const r=this.requests.get(id);if(!r?.receipt||r.receipt.sourceSha256!==sourceSha256)throw new BuildError('ACK_MISMATCH','Export acknowledgement differs');if(success!==true)return this.cancel(id);this.release(id,'host-verified-export');}
 async stopWorker(slot){if(!slot.runner||slot.dead){if(slot.quarantined)throw new BuildError('WORKSPACE_QUARANTINED','Process exit unverified');return;}if(slot.stopping)return slot.stopping;
  slot.stopping=(async()=>{fs.writeFileSync(path.join(slot.dir,'cancel'),'cancel');await slot.exit;if(slot.quarantined)throw new BuildError('WORKSPACE_QUARANTINED','Process tree drain unverified');})().finally(()=>{slot.stopping=null;});return slot.stopping;}
 async cancel(id){const r=this.requests.get(id);if(!r)return;r.cancelled=true;if(r.active){await this.stopWorker(r.slot);}else if(r.receipt){try{await this.stopWorker(r.slot);}finally{this.release(id,'export-aborted');}}/* queued requests retain their queue position until predecessor releases */}
 async close(){this.closed=true;for(const r of this.requests.values())r.cancelled=true;const results=await Promise.allSettled([...this.workspaces.values()].map(s=>this.stopWorker(s)));for(const id of [...this.requests.keys()])this.release(id,'controller-close');if(results.some(x=>x.status==='rejected'))throw Error('One or more workspaces quarantined');}
}
