import fs from 'node:fs';
import path from 'node:path';
import {toolTextCandidates,windowsToolEncoding} from './tool-text.mjs';

export function parseNativeDependencies(text){
 const flat=text.replace(/\\\r?\n/g,' '),colon=flat.search(/:\s/);
 if(colon<0)throw Error('Unsupported dependency target');
 return dependencyWords(flat.slice(colon+1));
}
function dependencyWords(text){
 const result=[];let token='';
 for(let i=0;i<text.length;i++){
  const c=text[i];
  if(c==='\\'&&/[\s#:$]/.test(text[i+1]??'')){token+=text[++i];continue;}
  if(c==='$'&&text[i+1]==='$'){token+='$';i++;continue;}
  if(/\s/.test(c)){if(token){result.push(token);token='';}}else token+=c;
 }
 if(token)result.push(token);if(!result.length)throw Error('Empty dependency list');return result;
}
export function decodeDependencies(bytes,{cwd,output,encoding,exists=fs.existsSync}={}){
 // ASCII is identical in all supported encodings; avoid filesystem probes on
 // the common path. For non-ASCII, bind the decoding to the actual -o target.
 if(!bytes.some(b=>b>=128))return parseNativeDependencies(bytes.toString('ascii'));
 encoding??=windowsToolEncoding();
 const candidates=[];
 for(const {text} of toolTextCandidates(bytes,encoding))try{
  const flat=text.replace(/\\\r?\n/g,' '),colon=flat.search(/:\s/);
  if(colon<0)continue;
  const targets=dependencyWords(flat.slice(0,colon));
  if(output&&(targets.length!==1||path.resolve(cwd,targets[0]).toLowerCase()!==path.resolve(output).toLowerCase()))continue;
  const deps=parseNativeDependencies(text);
  candidates.push(deps);
 }catch{}
 if(candidates.length===1)return candidates[0];
 // ASCII targets cannot identify an encoding. Require one complete existing
 // dependency set, rejecting both ambiguous and incomplete interpretations.
 const valid=candidates.filter(deps=>deps.every(f=>exists(path.resolve(cwd,f))));
 if(valid.length!==1)throw Error('Missing or ambiguous dependency encoding for '+output);
 return valid[0];
}
export function readNativeDependencies(file,cwd,output){return decodeDependencies(fs.readFileSync(file),{cwd,output});}
