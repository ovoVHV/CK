// Execute a dependency-free scheduler batch in the existing Job-owned worker.
// Child processes inherit the same Windows Job and cancellation boundary.
import fs from 'node:fs';
import {spawn} from 'node:child_process';
import {nonInteractiveStdio} from './process-stdio.mjs';
import {checkSize} from './native/size-check.mjs';
import {observeCommandDiagnostics} from './build-resource-evidence.mjs';
export function supportsDirectRule(rule){return !rule.compilerCache&&!rule.nativeMergeBin&&!rule.nativeElfImage&&!rule.windowsVerbatimArguments;}
async function execute(rule){
 if(!supportsDirectRule(rule))throw Error('Unsupported direct rule');
 if(rule.archiveTemporary&&fs.existsSync(rule.archiveTemporary))fs.unlinkSync(rule.archiveTemporary);
 const at=performance.now(),startedUnixMs=Date.now(),out=[],err=[];
 const child=spawn(rule.argv[0],rule.argv.slice(1),{cwd:rule.directory,windowsHide:true,shell:false,stdio:nonInteractiveStdio()});
 child.stdout.on('data',b=>out.push(b));child.stderr.on('data',b=>err.push(b));
 const code=await new Promise((resolve,reject)=>{child.once('error',reject);child.once('close',resolve);});
 const stdout=Buffer.concat(out).toString(),stderr=Buffer.concat(err).toString();
 observeCommandDiagnostics({stdout,stderr});
 if(code!==0)throw Error(stderr||stdout||'Native task failed: '+rule.name+' ('+code+')');
 if(rule.sizePolicy)fs.writeFileSync(rule.sizeOutput,JSON.stringify(checkSize(stdout,rule.sizePolicy))+'\n');
 if(rule.archiveTemporary)fs.renameSync(rule.archiveTemporary,rule.archiveOutput);
 if(!fs.existsSync(rule.output))throw Error('Native task did not produce '+rule.output);
 return {rule:rule.name,kind:rule.kind,pid:child.pid,startedUnixMs,elapsedMs:performance.now()-at,exitCode:0,mode:rule.sizePolicy?'official-size-validation':'official',executable:rule.argv[0],stdout,stderr};
}
export async function executeBatch(rules,jobs,{onComplete}={}){
 if(!Number.isInteger(jobs)||jobs<1||jobs>16)throw Error('Invalid execution concurrency');
 const at=performance.now(),results=new Array(rules.length);let next=0,failure;
 // Stop dispatch on the first failure and wait for every already-started task
 // before returning, so the caller can never clear a still-writing workspace.
 await Promise.all(Array.from({length:Math.min(jobs,rules.length)},async()=>{
  while(!failure){const index=next++;if(index>=rules.length)return;try{results[index]=await execute(rules[index]);try{onComplete?.(rules[index]);}catch{}}catch(e){failure??=e;}}
 }));
 if(failure)throw failure;
 return {results,elapsedMs:performance.now()-at};
}
