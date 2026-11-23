import fs from 'node:fs';
import path from 'node:path';
import {validateAssets} from './asset-engine.mjs';
import {sha} from './resolver.mjs';

// Authority is supplied only by the live BuildSession after a successful
// request. This reads ALL build/graph bytes and directory members again;
// timestamps, an on-disk receipt, and source identity alone never authorize it.
export function observeNoOpTree(plan, validation) {
 return validateAssets([plan.build,plan.graph],validation);
}
export function proveNoOp(state,plan,validation,observed=null) {
 const at=performance.now();
 if(!state.outputIdentity||!state.lastReceipt)return {hit:false,reason:'no-live-output-identity'};
 try {
  const proof=observed??observeNoOpTree(plan,validation);
  if(proof.sha256!==state.outputIdentity)return {hit:false,reason:'build-content-or-directory-changed',elapsedMs:performance.now()-at};
  const artifacts=state.lastReceipt.artifacts.map(a=>{
   const bytes=fs.readFileSync(a.file);
   if(bytes.length!==a.bytes||sha(bytes)!==a.sha256)throw Error('Delivery content changed: '+a.name);
   return {...a};
  });
  return {hit:true,reason:'live-session-plus-full-assets-and-build-content',proof:{...proof,rows:undefined},artifacts,elapsedMs:performance.now()-at+(observed?.elapsedMs??0)};
 }catch(error){return {hit:false,reason:'output-proof-rejected',error:String(error),elapsedMs:performance.now()-at};}
}
export function sameSketchNamespace(sketchDir) {
 const names=fs.readdirSync(sketchDir);
 return names.length===1&&names[0]==='sketch.ino'&&fs.lstatSync(path.join(sketchDir,'sketch.ino')).isFile();
}
