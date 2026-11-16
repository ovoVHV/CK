import fs from 'node:fs';
import path from 'node:path';
import {spawnSync} from 'node:child_process';
import {createHash} from 'node:crypto';
const source=path.resolve(process.argv[2]);
const out=path.join(source,'behavior-'+Date.now());fs.mkdirSync(out,{recursive:true});
const tools='C:/Program Files (x86)/Microsoft Visual Studio/18/BuildTools/VC';
const compiler=tools+'/Tools/MSVC/14.50.35717/bin/Hostx64/x64';
const header=path.resolve('tests/ai-ui/Arduino.h');
const driver=path.resolve('tests/ai-ui/complex-behavior.cpp');
const include=p=>p.replaceAll('\\','/');
const report={hardware:false,sourceModified:false,host:'Windows x64 MSVC AddressSanitizer, 32-bit unsigned long',limitations:'Host int is 32-bit; Uno int is 16-bit. Sensor sums here remain <=8184. Arduino APIs and clock are simulated.',results:[]};
for(const id of ['uno-debounce','hysteresis-safety','traffic-emergency','ring-buffer-filter']){
  const file=path.join(source,id+'.ino');if(!fs.existsSync(file))continue;
  const row={id,sha256:createHash('sha256').update(fs.readFileSync(file)).digest('hex')};report.results.push(row);
  const cpp=path.join(out,id+'.cpp'),exe=path.join(out,id+'.exe');
  fs.writeFileSync(cpp,`#include "${include(header)}"\n#include "${include(file)}"\n#include "${include(driver)}"\n`);
  const cmd=path.join(out,id+'.cmd');
  fs.writeFileSync(cmd,`@echo off\r\ncall "${tools}/Auxiliary/Build/vcvars64.bat" >nul\r\nif errorlevel 1 exit /b 1\r\n"${compiler}/cl.exe" /nologo /std:c++17 /EHsc /utf-8 /fsanitize=address /Zi /I"${path.dirname(header)}" "${cpp}" /Fe:"${exe}" /Fo:"${path.join(out,id+'.obj')}" /Fd:"${path.join(out,id+'.pdb')}" /link /INCREMENTAL:NO\r\nexit /b %errorlevel%\r\n`);
  const built=spawnSync('cmd.exe',['/d','/c',cmd],{encoding:'utf8',windowsHide:true,timeout:60000});
  fs.writeFileSync(path.join(out,id+'-compile.log'),(built.stdout||'')+(built.stderr||''));
  row.hostCompile=built.status===0?'PASS':'FAIL';
  if(built.status===0){row.scenarios=[];for(const mode of id==='traffic-emergency'?[id,'traffic-rollover']:id==='uno-debounce'?[id,'debounce-rollover']:[id]){
    const result=spawnSync(exe,[mode],{encoding:'utf8',windowsHide:true,timeout:10000,env:{...process.env,PATH:compiler+';'+process.env.PATH}});
    row.scenarios.push({mode,status:result.status===0?'PASS':'FAIL',stdout:result.stdout,stderr:result.stderr,error:result.error?.message});
  }}
}
report.status=report.results.length===4&&report.results.every(r=>r.hostCompile==='PASS'&&r.scenarios.every(s=>s.status==='PASS'))?'PASS':'NOT_QUALIFIED';
fs.writeFileSync(path.join(out,'report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report,null,2));console.log('REPORT '+out);
if(report.status!=='PASS')process.exitCode=1;
