import fs from 'node:fs';import path from 'node:path';import os from 'node:os';import {spawnSync} from 'node:child_process';
import {ENGINE_VERSION} from '../src/version.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG));
// The product shortcut always runs all three required cohorts. Developer
// shell settings from an earlier partial run must never truncate this batch.
delete process.env.CK_V9_QUALIFICATION_MODE;
const destination=process.env.CK_V91_PRODUCT_ROOT;
const machine={engineVersion:ENGINE_VERSION,date:new Date().toISOString(),platform:os.platform(),arch:os.arch(),osRelease:os.release(),hostname:os.hostname(),cpus:os.cpus().map(x=>({model:x.model,speed:x.speed})),totalMemory:os.totalmem(),source:'installed-package',secondMachineClaim:false};
fs.mkdirSync(config.paths.evidenceRoot,{recursive:true});
fs.writeFileSync(path.join(config.paths.evidenceRoot,'machine.json'),JSON.stringify(machine,null,2));
await import('../tests/performance.mjs');
const batches=fs.readdirSync(config.paths.evidenceRoot).filter(x=>x.startsWith('qualification-')).sort();
const batch=path.join(config.paths.evidenceRoot,batches.at(-1)||'missing');
const report=JSON.parse(fs.readFileSync(path.join(batch,'report.json')));
const summary={engineVersion:ENGINE_VERSION,machine,batch,status:report.status,summary:report.summary,allThresholdsPassed:report.status==='COMPLETE_SINGLE_MACHINE'&&['newEdit','history','identical'].every(k=>report.summary[k]?.passed===true),twoMachineQualified:false};
fs.writeFileSync(path.join(destination,'qualification-summary.json'),JSON.stringify(summary,null,2));
fs.writeFileSync(path.join(destination,'qualification-summary.txt'),`CK ${ENGINE_VERSION}\r\n状态: ${report.status}\r\n本机三项性能门槛全部通过: ${summary.allThresholdsPassed}\r\n双机资格: 尚需汇总另一台结果\r\n${JSON.stringify(report.summary,null,2)}\r\n全部原始样本: ${batch}\r\n`);
const archive=path.join(destination,'CK-V9.1-qualification-'+new Date().toISOString().replaceAll(/[:.]/g,'-')+'.zip');
const ps=path.join(process.env.SystemRoot,'System32/WindowsPowerShell/v1.0/powershell.exe');
const script=path.join(destination,'collect-qualification.ps1');
fs.writeFileSync(script,`param([string]$Batch,[string]$Machine,[string]$Summary,[string]$Destination)\n$ErrorActionPreference='Stop'\nCompress-Archive -LiteralPath $Batch,$Machine,$Summary -DestinationPath $Destination -CompressionLevel Optimal\n`);
const zipped=spawnSync(ps,['-NoProfile','-ExecutionPolicy','Bypass','-File',script,'-Batch',batch,'-Machine',path.join(config.paths.evidenceRoot,'machine.json'),'-Summary',path.join(destination,'qualification-summary.json'),'-Destination',archive],{windowsHide:true,encoding:'utf8'});
if(zipped.status!==0){console.error(zipped.stderr);process.exitCode=1;}else console.log('Qualification evidence ZIP: '+archive);
