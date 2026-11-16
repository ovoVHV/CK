import {AsyncLocalStorage} from 'node:async_hooks';
const diagnostics=new AsyncLocalStorage();
export const withBuildDiagnostics=operation=>diagnostics.run({warningCount:0},operation);
export function observeCommandDiagnostics(result){
 const state=diagnostics.getStore();if(!state)return;
 let stdout=String(result.stdout??''),stderr=String(result.stderr??'');
 // CLI JSON may contain escaped compiler output; count the actual channels.
 try{const json=JSON.parse(stdout);if(typeof json.compiler_out==='string'||typeof json.compiler_err==='string')stdout=(json.compiler_out??'')+'\n'+(json.compiler_err??'');}catch{}
 state.warningCount+=(stdout+'\n'+stderr).split(/\r?\n/).filter(line=>/warning:/i.test(line)).length;
}
export const currentWarningCount=()=>diagnostics.getStore()?.warningCount??null;
export function buildResourceEvidence(bytes,policy,warningCount){
 const value=JSON.parse(bytes.toString());
 for(const key of ['flash','ram','flashLimit','ramLimit'])if(!Number.isSafeInteger(value[key])||value[key]<0)throw Error('Invalid native size evidence: '+key);
 if(value.flashLimit!==policy.flashLimit||value.ramLimit!==policy.ramLimit||value.flashLimit<=0||value.ramLimit<=0
  ||value.flash>value.flashLimit||value.ram>value.ramLimit)throw Error('Native size evidence differs from qualified platform limits');
 if(!Number.isSafeInteger(warningCount)||warningCount<0)throw Error('Native warning observation missing');
 return {...value,warningCount,source:'qualified-size-recipe',warningScope:'observed-build-process-output'};
}
export function formatResourceEvidence(value){
 if(!value||value.source!=='qualified-size-recipe')return [];
 const v=buildResourceEvidence(Buffer.from(JSON.stringify(value)),value,value.warningCount);
 return [
  `Sketch uses ${v.flash} bytes (${Math.floor(v.flash*100/v.flashLimit)}%) of program storage space. Maximum is ${v.flashLimit} bytes.`,
  `Global variables use ${v.ram} bytes (${Math.floor(v.ram*100/v.ramLimit)}%) of dynamic memory, leaving ${v.ramLimit-v.ram} bytes for local variables. Maximum is ${v.ramLimit} bytes.`,
  `[DIAG] Compile evidence: warning_count=${v.warningCount}`,
 ];
}
