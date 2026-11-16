import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';import {digest} from '../src/protocol.mjs';
const [configFile,reportFile]=process.argv.slice(2),config=JSON.parse(fs.readFileSync(configFile)),report=JSON.parse(fs.readFileSync(reportFile));
const expected=process.argv[4]?report.runs.find(r=>r.label===process.argv[4]):report.runs[0];assert(expected,'Requested reference run missing');
const buildDir=path.dirname(expected.artifacts[0].file),workspace=path.dirname(buildDir),sketchDir=path.join(workspace,'source/sketch');
const result={status:'RUNNING',boundary:'full official CLI clean compile, separate from NativeScheduler',reference:reportFile,checks:[]};
const file=path.join(path.dirname(reportFile),'official-full-control.json'),save=()=>fs.writeFileSync(file,JSON.stringify(result,null,2));save();
try{
 process.env.SOURCE_DATE_EPOCH=String(config.sourceDateEpoch);process.env.TZ='UTC';
 const run=await asyncRun([...baseArgs({...config.paths,workspace,sketchDir,fqbn:expected.fqbn,jobs:config.limits.jobs,explicitLibraries:report.libraries??[]}),'--clean','--json',sketchDir],config.paths.sysroot);
 fs.writeFileSync(path.join(path.dirname(file),'official-full-run.json'),JSON.stringify(run));assert.equal(run.code,0,run.stderr+run.stdout.slice(-2000));
 assert.equal(digest(fs.readFileSync(path.join(buildDir,'sketch/sketch.ino.cpp'))),expected.generatedSha256);
 const ordered=x=>[...x].sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(ordered(JSON.parse(fs.readFileSync(path.join(buildDir,'compile_commands.json')))),ordered(expected.compileDatabase));
 for(const object of expected.objects)assert.equal(digest(fs.readFileSync(object.file)),object.sha256,object.file);
 const platform=JSON.parse(run.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
 for(const name of artifactNames){const f=name==='boot_app0.bin'?path.join(platform,'tools/partitions/boot_app0.bin'):path.join(buildDir,name);assert.equal(digest(fs.readFileSync(f)),expected.artifacts.find(x=>x.name===name).sha256,name);}
 result.checks.push('CPP and complete compilation database equal',`${expected.objects.length} objects byte-identical`,'All ten delivery artifacts byte-identical');result.status='PASS';
}catch(e){result.status='FAIL';result.error=String(e.stack);process.exitCode=1;console.error(e);}finally{save();console.log(JSON.stringify(result));}
