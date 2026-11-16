import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {fingerprint} from './source-contract.mjs';import {packageRoot} from './config.mjs';import {sha,read,write} from './resolver.mjs';
export function validateAssets(roots,{mode='rust',workers=4,openWorkers=16,sizeGrouped=true,bufferBytes=1048576,temporary=os.tmpdir()}={}) {
 if(mode==='node')return {...fingerprint(roots),mode:'node',metrics:null};
 if(!['rust','cng'].includes(mode))throw Error('Unknown validator');
 const at=performance.now();fs.mkdirSync(temporary,{recursive:true});const dir=fs.mkdtempSync(path.join(temporary,'ck-v9-assets-'));
 const input=path.join(dir,'input.json'),output=path.join(dir,'output.json');write(input,{roots:roots.map(p=>path.resolve(p)),mode,workers,openWorkers,sizeGrouped,bufferBytes});
 try{const result=spawnSync(path.join(packageRoot,'bin/assets.exe'),[input,output],{windowsHide:true,encoding:'utf8',maxBuffer:4e6});
  if(result.error||result.status!==0)throw Error('Full content validation rejected: '+(result.error?.message??result.stderr));
  const data=read(output);data.sha256=sha(JSON.stringify([data.roots,data.rows]));data.namespaceSha256=sha(JSON.stringify(data.rows.map(x=>x.slice(0,2))));data.nativeElapsedMs=data.elapsedMs;data.elapsedMs=performance.now()-at;return data;
 }finally{for(const f of [input,output])if(fs.existsSync(f))fs.unlinkSync(f);fs.rmdirSync(dir);}
}
