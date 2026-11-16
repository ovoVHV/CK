import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {esp32Properties} from '../src/esp32-properties.mjs';import {platformInstallations} from '../src/targets.mjs';
const config=loadConfig(process.argv[2]),installed=platformInstallations(config.paths.sysroot)[0],version=path.basename(installed);
const root=path.join(config.paths.evidenceRoot,'property-safety-'+Date.now()),sysroot=path.join(root,'assets'),platform=path.join(sysroot,'packages/esp32/hardware/esp32',version);
fs.mkdirSync(platform,{recursive:true});for(const name of ['platform.txt','boards.txt'])fs.copyFileSync(path.join(installed,name),path.join(platform,name));
let dependencies;for(const name of fs.readdirSync(config.paths.sysroot).filter(n=>/^package.*\.json$/.test(n)))for(const pkg of JSON.parse(fs.readFileSync(path.join(config.paths.sysroot,name))).packages??[])if(pkg.name==='esp32')for(const p of pkg.platforms??[])if(p.architecture==='esp32'&&p.version===version)dependencies??=p.toolsDependencies;
assert(dependencies);const index=deps=>({packages:[{name:'esp32',platforms:[{architecture:'esp32',version,toolsDependencies:deps}]}]});
const indexFile=path.join(sysroot,'package_test.json');fs.writeFileSync(indexFile,JSON.stringify(index(dependencies)));for(const d of dependencies)fs.mkdirSync(path.join(sysroot,'packages',d.packager,'tools',d.name,d.version,'bin'),{recursive:true});
const c={...config.paths,sysroot,workspace:path.join(root,'work'),sketchDir:path.join(root,'work/source/sketch'),userLibraries:path.join(sysroot,'sketchbook/libraries'),fqbn:'esp32:esp32:esp32s3'};
const report={status:'RUNNING',boundary:'Temporary isolated property fixtures; no installed toolchain changes',checks:[]};
const rejected=label=>{const r=esp32Properties(c);assert.equal(r.hit,false,label);report.checks.push({label,reason:r.reason});};
function mutate(file,bytes,work){const original=fs.existsSync(file)?fs.readFileSync(file):null;fs.writeFileSync(file,bytes);try{work();}finally{original===null?fs.unlinkSync(file):fs.writeFileSync(file,original);}}
try{
 const baseline=esp32Properties(c);assert(baseline.hit,baseline.reason);report.checks.push({label:'qualified platform with matching package paths'});
 mutate(path.join(sysroot,'package_duplicate.json'),JSON.stringify(index([...dependencies].reverse())),()=>{assert(esp32Properties(c).hit);report.checks.push({label:'duplicate index order is not a version conflict'});});
 mutate(path.join(sysroot,'package_conflict.json'),JSON.stringify(index(dependencies.map((d,i)=>i===0?{...d,version:'other'}:d))),()=>rejected('conflicting tool versions'));
 for(const name of ['platform.local.txt','boards.local.txt'])mutate(path.join(platform,name),'x=y',()=>rejected(name));
 for(const name of ['platform.txt','boards.txt'])mutate(path.join(platform,name),fs.readFileSync(path.join(platform,name),'utf8')+'\n# changed\n',()=>rejected('changed '+name));
 for(const fqbn of ['esp32:esp32:unknown','esp32:esp32:esp32s3:Unknown=x','esp32:esp32:esp32s3:PSRAM=unknown']){assert.equal(esp32Properties({...c,fqbn}).hit,false);report.checks.push({label:fqbn});}
 assert.equal(esp32Properties({...c,buildProperties:['compiler.cpp.extra_flags=-DUSER=1']}).hit,false);report.checks.push({label:'custom build properties'});
 mutate(indexFile,JSON.stringify(index([{packager:'esp32',name:'esp-x32',version:'../escape'}])),()=>rejected('unsafe package path'));
 const extra=path.join(path.dirname(platform),'unqualified');fs.mkdirSync(extra);mutate(path.join(extra,'platform.txt'),'name=extra',()=>rejected('multiple installed platform versions'));
 report.status='PASS';
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}finally{fs.writeFileSync(path.join(root,'report.json'),JSON.stringify(report,null,2));console.log('REPORT '+root);}
