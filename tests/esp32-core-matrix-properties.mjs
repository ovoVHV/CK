// Isolated compatibility qualification. Never adds production version authority.
import fs from 'node:fs';
import path from 'node:path';
import {pathToFileURL} from 'node:url';
import assert from 'node:assert/strict';
const candidate=path.resolve(process.env.CK_CORE_MATRIX_CANDIDATE??'local/core-matrix-engine');
const moduleFrom=name=>import(pathToFileURL(path.join(candidate,'src',name)));
const {loadConfig}=await moduleFrom('config.mjs');
const {esp32Properties}=await moduleFrom('esp32-properties.mjs');
const {asyncRun,baseArgs,properties}=await moduleFrom('discovery.mjs');
const config=loadConfig(process.argv[2]);
const targets=['esp32:esp32:esp32s3','esp32:esp32:esp32s3:FlashSize=8M,PartitionScheme=default_8MB,PSRAM=opi,USBMode=hwcdc,CDCOnBoot=cdc'];
fs.mkdirSync(config.paths.evidenceRoot,{recursive:true});
const report={status:'RUNNING',candidate,targets:[]};
try {for(const [i,fqbn]of targets.entries()){
 const workspace=path.join(config.paths.workspaceRoot,'properties-'+i),sketchDir=path.join(workspace,'source/sketch');
 fs.mkdirSync(sketchDir,{recursive:true});fs.writeFileSync(path.join(sketchDir,'sketch.ino'),'void setup() {}\nvoid loop() {}\n');
 const c={...config.paths,workspace,sketchDir,fqbn,jobs:config.limits.jobs};
 const native=esp32Properties(c);assert(native.hit,native.reason);
 const result=await asyncRun([...baseArgs(c),'--show-properties=expanded','--json',sketchDir],c.sysroot);
 assert.equal(result.code,0,result.stderr+'\n'+result.stdout);const official=properties(JSON.parse(result.stdout));
 const checked=Object.keys(official).filter(k=>/^(build\.|compiler\.|recipe\.|preproc\.|upload\.maximum|archive_file_path|ide_version|software)/.test(k));
 const differences=checked.filter(k=>native.properties[k]!==official[k]).map(key=>({key,native:native.properties[key],official:official[key]}));
 report.targets.push({fqbn,checked:checked.length,differences,native:native.properties,official});
 console.log(JSON.stringify({fqbn,checked:checked.length,differences}));assert.deepEqual(differences,[]);
 }report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);process.exitCode=1;console.error(error);}
finally{fs.writeFileSync(path.join(config.paths.evidenceRoot,'properties.json'),JSON.stringify(report,null,2));}
