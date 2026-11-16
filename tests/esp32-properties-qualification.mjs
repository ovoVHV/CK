import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {esp32Properties,windowsProperties} from '../src/esp32-properties.mjs';
import {selectBoard} from '../src/avr-properties.mjs';
import {parseFqbn,platformInstallations} from '../src/targets.mjs';
import {asyncRun,baseArgs,properties} from '../src/discovery.mjs';
const config=loadConfig(process.argv[2]);
const definitions=windowsProperties(fs.readFileSync(path.join(platformInstallations(config.paths.sysroot)[0],'boards.txt'),'utf8'));
const targets=[];
for(const board of ['esp32','esp32s2','esp32s3','esp32c3','esp32c5','esp32c6','esp32h2','esp32p4']){
 const fqbn='esp32:esp32:'+board;targets.push(fqbn);
 const {selected}=selectBoard(definitions,parseFqbn(fqbn)),options=[];
 for(const name of selected.keys()){
  const prefix=board+'.menu.'+name+'.';
  const values=Object.keys(definitions).filter(k=>k.startsWith(prefix)&&!k.slice(prefix.length).includes('.')).map(k=>k.slice(prefix.length));
  if(values.length>1)options.push(name+'='+values.at(-1));
 }
 // Exercise menu defaults and every alternative menu in combination. This is
 // property qualification, not a claim that every combination is flashable.
 if(options.length)targets.push(fqbn+':'+options.join(','));
}
targets.push('esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc');
const folder=path.join(config.paths.evidenceRoot,'esp32-properties-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={status:'RUNNING',targets:[]};
try{for(const fqbn of targets){
 const workspace=path.join(config.paths.workspaceRoot,'properties-'+report.targets.length),sketchDir=path.join(workspace,'source/sketch');fs.mkdirSync(sketchDir,{recursive:true});fs.writeFileSync(path.join(sketchDir,'sketch.ino'),'void setup() {}\nvoid loop() {}\n');
 const c={...config.paths,workspace,sketchDir,fqbn,jobs:config.limits.jobs};
 const start=performance.now(),native=esp32Properties(c);assert(native.hit,native.reason);const nativeMs=performance.now()-start;
 const r=await asyncRun([...baseArgs(c),'--show-properties=expanded','--json',sketchDir],c.sysroot);assert.equal(r.code,0,r.stderr);const official=properties(JSON.parse(r.stdout));
 const checked=Object.keys(official).filter(k=>/^(build\.|compiler\.|recipe\.|preproc\.|upload\.maximum|archive_file_path|ide_version|software)/.test(k));
 const differences=checked.filter(k=>native.properties[k]!==official[k]).map(k=>({key:k,native:native.properties[k],official:official[k]}));
 report.targets.push({fqbn,nativeMs,officialMs:r.elapsedMs,checked,differences,properties:native.properties});
 assert.deepEqual(differences,[],fqbn);console.log(JSON.stringify({fqbn,nativeMs,officialMs:r.elapsedMs,checked:checked.length}));
}report.status='PASS';}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+folder);}
