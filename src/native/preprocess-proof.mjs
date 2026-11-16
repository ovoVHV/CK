import path from 'node:path';
import {responses,executable,sha} from './plan.mjs';

// Same-request output only. All semantic arguments retain their order. Ignore
// output destination and diagnostic switches only after requiring the same
// explicit C++ preprocessing/output modes on both commands.
export function preprocessIdentity(argv,directory,raw){
 const expanded=responses(argv.slice(1),directory).expanded;
 if(!['-E','-CC','-dD'].every(x=>expanded.includes(x)))return null;
 const language=[];const semantic=[];let outputs=0;
 for(let i=0;i<expanded.length;i++){
  const arg=expanded[i];
  if(arg==='-o'){if(!expanded[++i])return null;outputs++;continue;}
  if(arg==='-x'){language.push(expanded[++i]);continue;}
  if(['-H','-w','-E','-CC','-dD'].includes(arg))continue;
  semantic.push(arg);
 }
 if(outputs!==1||!language.length||language.some(x=>x!=='c++'))return null;
 return sha(JSON.stringify([path.resolve(directory),executable(argv[0]),semantic,sha(raw)]));
}
export function reusablePreprocess(candidate,argv,directory,raw){
 if(!candidate||!Buffer.isBuffer(candidate.bytes)||!candidate.identity)return false;
 return candidate.identity===preprocessIdentity(argv,directory,raw)&&sha(candidate.bytes)===candidate.sha256;
}
