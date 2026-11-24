import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {execFile,spawnSync} from 'node:child_process';
import {fingerprint} from './source-contract.mjs';import {packageRoot} from './config.mjs';import {sha,read,write} from './resolver.mjs';
export function validateAssets(roots,{mode='rust',workers=4,openWorkers=16,sizeGrouped=true,bufferBytes=1048576,temporary=os.tmpdir()}={}) {
 if(mode==='node')return {...fingerprint(roots),mode:'node',metrics:null};
 if(!['rust','cng'].includes(mode))throw Error('Unknown validator');
 if(mode==='rust'){
  const at=performance.now(),input=JSON.stringify({roots:roots.map(p=>path.resolve(p)),mode,workers,openWorkers,sizeGrouped,bufferBytes});
  const r=spawnSync(path.join(packageRoot,'bin/assets.exe'),['--rows-v1'],{input,encoding:'utf8',windowsHide:true,maxBuffer:8*1024*1024});
  if(!r.error&&r.status===0){const data=JSON.parse(r.stdout);data.sha256=sha(JSON.stringify([data.roots,data.rows]));data.namespaceSha256=sha(JSON.stringify(data.rows.map(x=>x.slice(0,2))));data.nativeElapsedMs=data.elapsedMs;data.elapsedMs=performance.now()-at;return data;}
  // Oversized manifests retain the unbounded on-disk transport.
  if(r.error?.code!=='ENOBUFS')throw Error('Full content validation rejected: '+(r.error?.message??r.stderr));
 }
 const at=performance.now();fs.mkdirSync(temporary,{recursive:true});const dir=fs.mkdtempSync(path.join(temporary,'ck-v9-assets-'));
 const input=path.join(dir,'input.json'),output=path.join(dir,'output.json');write(input,{roots:roots.map(p=>path.resolve(p)),mode,workers,openWorkers,sizeGrouped,bufferBytes});
 try{const result=spawnSync(path.join(packageRoot,'bin/assets.exe'),[input,output],{windowsHide:true,encoding:'utf8',maxBuffer:4e6});
  if(result.error||result.status!==0)throw Error('Full content validation rejected: '+(result.error?.message??result.stderr));
  const data=read(output);data.sha256=sha(JSON.stringify([data.roots,data.rows]));data.namespaceSha256=sha(JSON.stringify(data.rows.map(x=>x.slice(0,2))));data.nativeElapsedMs=data.elapsedMs;data.elapsedMs=performance.now()-at;return data;
 }finally{for(const f of [input,output])if(fs.existsSync(f))fs.unlinkSync(f);fs.rmdirSync(dir);}
}

export function validateSummary(roots,validation){
 if(validation?.mode!=='rust')return validateAssets(roots,validation);
 const at=performance.now(),input=JSON.stringify({...validation,roots:roots.map(p=>path.resolve(p))});
 const r=spawnSync(path.join(packageRoot,'bin/assets.exe'),['--summary-v1'],{input,encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 if(r.error||r.status!==0)throw Error('Full content validation rejected: '+(r.error?.message??r.stderr));
 const proof=JSON.parse(r.stdout);
 if(!/^[a-f0-9]{64}$/.test(proof.sha256)||!/^[a-f0-9]{64}$/.test(proof.namespaceSha256))throw Error('Invalid full content summary');
 return {...proof,nativeElapsedMs:proof.elapsedMs,elapsedMs:performance.now()-at};
}
export function outputSummary(roots,validation){
 if(validation?.mode!=='rust')return Promise.resolve().then(()=>validateAssets(roots,validation));
 const at=performance.now(),input=JSON.stringify({...validation,roots:roots.map(p=>path.resolve(p))});
 return new Promise((resolve,reject)=>{
  const child=execFile(path.join(packageRoot,'bin/assets.exe'),['--summary-v1'],{windowsHide:true,encoding:'utf8',maxBuffer:1024*1024},(err,stdout)=>{
   if(err)return reject(err);
   try{const proof=JSON.parse(stdout);
    if(!/^[a-f0-9]{64}$/.test(proof.sha256)||!/^[a-f0-9]{64}$/.test(proof.namespaceSha256))throw Error('Invalid output content proof');
    resolve({...proof,nativeElapsedMs:proof.elapsedMs,elapsedMs:performance.now()-at});
   }catch(e){reject(e);}
  });
  // Let the process callback report the failure after the child has drained.
  child.stdin.on('error',()=>{});child.stdin.end(input);
 });
}
export function verifyRepeat(inputs,outputs,inputIdentity,outputIdentity,validation){
 const req={inputs:inputs.map(p=>path.resolve(p)),outputs:outputs.map(p=>path.resolve(p)),inputIdentity,outputIdentity,validation};
 const r=spawnSync(path.join(packageRoot,'bin/assets.exe'),['--verify-repeat-v1'],{input:JSON.stringify(req),encoding:'utf8',windowsHide:true,maxBuffer:1024*1024});
 // An absent or damaged intermediate is recoverable by the ordinary scheduler;
 // failure here is never authority to reuse anything.
 if(r.error||r.status!==0)return null;
 const result=JSON.parse(r.stdout);if(result.hit!==true)return null;
 if(result.before?.sha256!==inputIdentity||result.after?.sha256!==inputIdentity||result.output?.sha256!==outputIdentity
  ||result.before.namespaceSha256!==result.after.namespaceSha256)throw Error('Invalid full repeat proof');
 for(const proof of [result.before,result.after,result.output])proof.nativeElapsedMs=proof.elapsedMs;
 return result;
}
