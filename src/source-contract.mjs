import fs from 'node:fs';
import path from 'node:path';
import {createHash} from 'node:crypto';
import {sourceContract} from './native/frontend.mjs';
const hash=v=>createHash('sha256').update(v).digest('hex');
// Mask comments and strings before delimiter inspection, preserving offsets.
function masked(code){let result='',i=0;while(i<code.length){const tail=code.slice(i),m=tail.match(/^(?:\/\/[^\n]*|\/\*[\s\S]*?\*\/|"(?:\\[\s\S]|[^"\\])*"|'(?:\\[\s\S]|[^'\\])*')/);if(m){result+=m[0].replace(/[^\n]/g,' ');i+=m[0].length;}else {result+=code[i];i++;}}return result;}
export function bodyContract(source){
 try{
  const directives=sourceContract(source);if(source.includes('R"'))return {qualified:false,reason:'raw-string'};
  const mask=masked(source),lines=mask.split('\n');let seenCode=false;
  for(const line of lines){if(!line.trim())continue;if(/^\s*#/.test(line)){if(seenCode)return {qualified:false,reason:'include-after-code'};}else seenCode=true;}
  const starts=[...mask.matchAll(/^\s*void\s+(setup|loop)\s*\(\s*\)\s*\{/gm)];
  if(starts.length!==2||new Set(starts.map(m=>m[1])).size!==2)return {qualified:false,reason:'requires-ordinary-setup-loop'};
  let cursor=0,skeleton='';const spans=[];
  for(const start of starts){const begin=start.index+start[0].lastIndexOf('{');if(begin<cursor)return {qualified:false,reason:'nested-function'};let depth=1,end=begin+1;for(;end<mask.length&&depth;end++){if(mask[end]==='{')depth++;if(mask[end]==='}')depth--;}
   if(depth)return {qualified:false,reason:'unbalanced-body'};skeleton+=source.slice(cursor,begin+1)+'<BODY:'+start[1]+'>'+source.slice(end-1,end);spans.push({function:start[1],begin:begin+1,end:end-1});cursor=end;
  }
  skeleton+=source.slice(cursor);const outer=masked(skeleton.replaceAll(/<BODY:(setup|loop)>/g,''));
  if((outer.match(/\{/g)||[]).length!==2||(outer.match(/\}/g)||[]).length!==2)return {qualified:false,reason:'other-braced-construct'};
  return {qualified:true,contract:'single-ino-fixed-top-level-void-setup-loop-v1',skeletonSha256:hash(skeleton),directivesSha256:directives,spans};
 }catch(e){return {qualified:false,reason:String(e.message)};}
}

export function fingerprint(roots){
 const at=performance.now(),rows=[],buffer=Buffer.allocUnsafe(1024*1024);let bytes=0,files=0;
 function walk(file){const st=fs.lstatSync(file);if(st.isSymbolicLink())throw Error('Reparse input: '+file);if(st.isDirectory()){rows.push([file,'directory']);for(const n of fs.readdirSync(file).sort())walk(path.join(file,n));return;}if(!st.isFile())throw Error('Nonregular input');
  const fd=fs.openSync(file,'r'),h=createHash('sha256');try{const a=fs.fstatSync(fd,{bigint:true});let size=0,n;while((n=fs.readSync(fd,buffer,0,buffer.length,null))){size+=n;h.update(buffer.subarray(0,n));}const b=fs.fstatSync(fd,{bigint:true});if(a.ino!==b.ino||a.size!==b.size||a.mtimeNs!==b.mtimeNs||a.ctimeNs!==b.ctimeNs||BigInt(size)!==b.size)throw Error('Input changed during read: '+file);rows.push([file,'file',size,h.digest('hex')]);files++;bytes+=size;}finally{fs.closeSync(fd);}}
 const normalizedRoots=roots.map(r=>path.resolve(typeof r==='string'?r:r.file));
 for(const r of normalizedRoots){for(let p=r;;p=path.dirname(p)){if(fs.lstatSync(p).isSymbolicLink())throw Error('Reparse ancestor: '+p);if(path.dirname(p)===p)break;}walk(r);}
 return {roots:normalizedRoots,sha256:hash(JSON.stringify([normalizedRoots,rows])),namespaceSha256:hash(JSON.stringify(rows.map(r=>r.slice(0,2)))),files,bytes,elapsedMs:performance.now()-at,rows};
}
