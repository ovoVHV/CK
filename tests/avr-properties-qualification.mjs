import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';
import {avrProperties} from '../src/avr-properties.mjs';
import {asyncRun,baseArgs,properties} from '../src/discovery.mjs';
const config=loadConfig(process.argv[2]);
const targets=['uno','nano','nano:cpu=atmega328','nano:cpu=atmega328old','nano:cpu=atmega168','mega','mega:cpu=atmega2560','mega:cpu=atmega1280','leonardo','micro'];
const folder=path.join(config.paths.evidenceRoot,'avr-properties-'+Date.now());fs.mkdirSync(folder,{recursive:true});
const report={status:'RUNNING',targets:[]};
try{for(const target of targets){
 const fqbn='arduino:avr:'+target,workspace=path.join(config.paths.workspaceRoot,'properties-'+target.replaceAll(':','-').replaceAll('=','-'));
 const sketchDir=path.join(workspace,'source/sketch');fs.mkdirSync(sketchDir,{recursive:true});fs.writeFileSync(path.join(sketchDir,'sketch.ino'),'void setup() {}\nvoid loop() {}\n');
 const c={...config.paths,workspace,sketchDir,fqbn,jobs:config.limits.jobs};
 const start=performance.now(),native=avrProperties(c);assert(native.hit,native.reason);const nativeMs=performance.now()-start;
 const r=await asyncRun([...baseArgs(c),'--show-properties=expanded','--json',sketchDir],c.sysroot);assert.equal(r.code,0,r.stderr);const official=properties(JSON.parse(r.stdout));
 const checked=Object.keys(official).filter(k=>/^(build\.|compiler\.|recipe\.|preproc\.|upload\.maximum|archive_file_path|ide_version|software)/.test(k));
 for(const key of checked)assert.equal(native.properties[key],official[key],fqbn+' '+key);
 report.targets.push({fqbn,nativeMs,officialMs:r.elapsedMs,checked,properties:native.properties});console.log(JSON.stringify({fqbn,nativeMs,officialMs:r.elapsedMs,checked:checked.length}));
}report.status='PASS';}catch(e){report.status='FAIL';report.error=String(e.stack);console.error(e);process.exitCode=1;}
finally{fs.writeFileSync(path.join(folder,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+folder);}
