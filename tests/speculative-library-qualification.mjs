import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {loadConfig} from '../src/config.mjs';import {BuildController} from '../src/controller.mjs';import {digest,validateArtifacts} from '../src/protocol.mjs';
import {asyncRun,baseArgs,artifactNames} from '../src/discovery.mjs';
const cfg=loadConfig(process.argv[2]),workspace=path.join(cfg.paths.workspaceRoot,'speculative-late-library'),fixture=path.join(path.dirname(cfg.paths.evidenceRoot),'fixture-libraries');
const out=path.join(cfg.paths.evidenceRoot,'speculative-library-qualification.json'),report={status:'RUNNING',boundary:'compiler correctness and failed candidate invalidation; no performance qualification'};
const library=(name,files)=>{const dir=path.join(fixture,name);fs.mkdirSync(path.join(dir,'src'),{recursive:true});fs.writeFileSync(path.join(dir,'library.properties'),`name=${name}\nversion=1.0.0\nauthor=CK\nmaintainer=CK\nsentence=Test\nparagraph=Test\ncategory=Other\nurl=https://example.invalid\narchitectures=esp32\n`);for(const [file,text]of Object.entries(files))fs.writeFileSync(path.join(dir,'src',file),text);return dir;};
const libraries=[library('CKDeferred',{'CKDeferred.h':'#pragma once\nvoid ckDeferred();\n','a.cpp':'#include "CKDeferred.h"\n#include <CKLeaf.h>\nvoid ckDeferred(){ckLeaf();}\n','b.cpp':'#include "CKDeferred.h"\nvoid ckSecond(){}\n','c.cpp':'#include "CKDeferred.h"\nvoid ckThird(){}\n'}),library('CKLeaf',{'CKLeaf.h':'#pragma once\ninline void ckLeaf(){}\n'})];
const source='#include <WiFi.h>\n#include <CKDeferred.h>\nvoid setup(){WiFi.mode(WIFI_STA);ckDeferred();}\nvoid loop(){}\n',controller=new BuildController(cfg),fqbn='esp32:esp32:esp32s3';
process.env.SOURCE_DATE_EPOCH=String(cfg.sourceDateEpoch);process.env.TZ='UTC';
fs.mkdirSync(cfg.paths.evidenceRoot,{recursive:true});const save=()=>fs.writeFileSync(out,JSON.stringify(report,null,2));
try{
 const request={requestId:'speculative-late-library',sourceSha256:digest(source),fqbn,sysroot:cfg.paths.sysroot,workspace,sketchDir:path.join(workspace,'source/sketch'),libraries,forceClean:true};
 console.log('START late library candidate');const result=await controller.submit({protocolVersion:1,request,source});report.result=result;save();assert(result.success,JSON.stringify(result.error));validateArtifacts(result.artifacts);
 assert(result.speculativeCompilation.started>0);assert(result.coldPipeline.invalidatedByFinalDiscovery);assert(result.counts.SchedulerCompileGCC>1);
 assert(result.counts.CompileGCC>result.objects.length,'Failed/stale compiler attempts must remain counted');
 assert.equal(result.counts.CacheRestored,0);await controller.acknowledge(request.requestId,{sourceSha256:request.sourceSha256,success:true});await controller.close();
 console.log('OFFICIAL CLEAN late library');const official=await asyncRun([...baseArgs({...cfg.paths,workspace,sketchDir:request.sketchDir,fqbn,jobs:cfg.limits.jobs,explicitLibraries:libraries}),'--clean','--json',request.sketchDir],cfg.paths.sysroot);report.official={code:official.code,elapsedMs:official.elapsedMs};fs.writeFileSync(path.join(cfg.paths.evidenceRoot,'speculative-official.json'),JSON.stringify(official));assert.equal(official.code,0,official.stderr.slice(-3000));
 const build=path.join(workspace,'build');assert.equal(digest(fs.readFileSync(path.join(build,'sketch/sketch.ino.cpp'))),result.generatedSha256);
 const order=rows=>[...rows].sort((a,b)=>a.file.localeCompare(b.file));assert.deepEqual(order(JSON.parse(fs.readFileSync(path.join(build,'compile_commands.json')))),order(result.compileDatabase));
 for(const o of result.objects)assert.equal(digest(fs.readFileSync(o.file)),o.sha256,o.file);
 const platform=JSON.parse(official.stdout).builder_result.build_properties.find(x=>x.startsWith('runtime.platform.path=')).slice('runtime.platform.path='.length);
 for(const name of artifactNames)assert.equal(digest(fs.readFileSync(name==='boot_app0.bin'?path.join(platform,'tools/partitions',name):path.join(build,name))),result.artifacts.find(a=>a.name===name).sha256,name);
 report.status='PASS';report.checks=['Late transitive library invalidates speculative commands','Failed and discarded GCC attempts are counted','CPP, complete database, every object and ten artifacts match official clean'];
}catch(error){report.status='FAIL';report.error=String(error.stack);console.error(error);process.exitCode=1;}finally{await controller.close();save();console.log('REPORT '+out);}
