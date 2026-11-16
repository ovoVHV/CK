import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {locatorPath,readStorage,initializeStorage,planMigration,scheduleMigration,performMigration,atomicJson} from '../src/storage.mjs';
const [op,...args]=process.argv.slice(2),file=locatorPath();
try{
  let result;
  if(op==='init'){
    const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
    const docs=spawnSync(ps,['-NoProfile','-Command',"[Console]::OutputEncoding=[Text.UTF8Encoding]::new($false);[Environment]::GetFolderPath('MyDocuments')"],{windowsHide:true,encoding:'utf8'}).stdout?.trim();
    result=initializeStorage({install:args[0],requested:args[1],documents:docs});
  }else if(op==='status')result=readStorage(file);
  else if(op==='plan')result=await planMigration(readStorage(file),args[0],args[1],args[2]==='true');
  else if(op==='schedule')result=await scheduleMigration({file,target:args[0],install:args[1],includeExternal:args[2]==='true'});
  else if(op==='cancel'){
    const pending=path.join(path.dirname(file),'storage-pending.json');if(fs.existsSync(pending))fs.unlinkSync(pending);result={cancelled:true};
  }else if(op==='migrate'){
    const progress=path.join(path.dirname(file),'storage-progress.json');let last=0;
    result=await performMigration(file,{onProgress:p=>{if(Date.now()-last>200||p.phase==='done'){atomicJson(progress,p);last=Date.now();}}});
  }else throw Error('Unknown storage operation');
  console.log(JSON.stringify(result));
}catch(e){
  if(op==='migrate'){
    atomicJson(path.join(path.dirname(file),'storage-last-error.json'),{at:new Date().toISOString(),error:String(e),originalsPreserved:true});
    const pending=path.join(path.dirname(file),'storage-pending.json');if(fs.existsSync(pending))fs.renameSync(pending,path.join(path.dirname(file),`storage-failed-${Date.now()}.json`));
  }
  console.error(e.message);process.exitCode=1;
}
