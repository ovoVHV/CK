import fs from 'node:fs';
import path from 'node:path';

// Node 24.13's Windows bulk cp/rm fast paths can fail on Unicode paths.
// Callers must validate ownership before removing a build/scratch directory.
// Use individual Unicode-safe operations and never traverse directory links.
export function removeScratchTree(target){
 let st;try{st=fs.lstatSync(target);}catch(e){if(e.code==='ENOENT')return;throw e;}
 if(st.isSymbolicLink())throw Error('Linked scratch entry rejected: '+target);
 if(st.isDirectory()){
  for(const name of fs.readdirSync(target))removeScratchTree(path.join(target,name));
  fs.rmdirSync(target);
 }else fs.unlinkSync(target);
}
export function removeOptionalFile(target){
 try{fs.unlinkSync(target);}catch(e){if(e.code!=='ENOENT')throw e;}
}
export function copyDirectory(source,target){
 const st=fs.lstatSync(source);if(st.isSymbolicLink())throw Error('Linked copy source rejected: '+source);
 if(st.isDirectory()){
  fs.mkdirSync(target,{recursive:true});
  for(const name of fs.readdirSync(source))copyDirectory(path.join(source,name),path.join(target,name));
 }else{fs.mkdirSync(path.dirname(target),{recursive:true});fs.copyFileSync(source,target);}
}
