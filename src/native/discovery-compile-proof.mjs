import fs from 'node:fs';import path from 'node:path';
import {executable,responses,sha} from './plan.mjs';
import {readNativeDependencies} from './depfile.mjs';
import {takeLibraryPchInputProofs} from './library-pch.mjs';

// Issued only by the live discovery caller after a successful compiler exit.
// JSON records and records from a previous request cannot acquire this grant.
const issued=new WeakSet();
const proof=file=>({file:path.resolve(file),sha256:sha(fs.readFileSync(file))});
function commandIdentity(argv,cwd,expanded){return sha(JSON.stringify([executable(argv[0]),path.resolve(cwd),expanded]));}
export function compileIdentity(argv,cwd){return commandIdentity(argv,cwd,responses(argv.slice(1),cwd).expanded);}
export function observeDiscoveryCompile({argv,actualArgv=argv,pchGrant=null,cwd,source,output,depfile,identity}){
 const at=performance.now();
 const nominal=responses(argv.slice(1),cwd);
 if(commandIdentity(argv,cwd,nominal.expanded)!==identity)return null;
 let observedHeaders=null;
 if(actualArgv!==argv&&compileIdentity(actualArgv,cwd)!==identity){
  observedHeaders=takeLibraryPchInputProofs(pchGrant,argv,actualArgv,cwd);
  if(!observedHeaders)return null;
 }
 const dependencies=[...new Set([source,...nominal.files,...readNativeDependencies(depfile,cwd,output).map(f=>path.resolve(cwd,f))])];
 const inputs=dependencies.map(f=>{const file=path.resolve(f),sha256=observedHeaders?.get(file);return sha256?{file,sha256}:proof(file);});
 const record={identity,source:path.resolve(source),output:path.resolve(output),depfile:path.resolve(depfile),inputs,object:proof(output),metadata:proof(depfile)};
 record.observationMs=performance.now()-at;issued.add(record);return record;
}
export function acceptsDiscoveryCompile(record,rule,inputProof=proof){
 if(!record||!issued.has(record)||rule.kind!=='compile'||rule.compilerCache)return false;
 try{return record.output===path.resolve(rule.output)&&record.depfile===path.resolve(rule.depfile)&&record.source===path.resolve(rule.inputs[0])&&
  record.identity===compileIdentity(rule.argv,rule.directory)&&[record.object,record.metadata].every(p=>proof(p.file).sha256===p.sha256)&&record.inputs.every(p=>inputProof(p.file)?.sha256===p.sha256);
 }catch{return false;}
}
