import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';import {createHash} from 'node:crypto';import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8'));
const source=fs.readFileSync(path.join(config.paths.evidenceRoot,'official-empty-libraries-repro.ino'),'utf8');
const report={status:'RUNNING',desktopSha256:JSON.parse(fs.readFileSync(path.join(config.paths.evidenceRoot,'desktop-launch.json'),'utf8')).sha256,sourceSha256:createHash('sha256').update(source).digest('hex'),sourceModified:false};let client;
try {
 client=await connectDesktop();
 const started=Date.now(),result=await client.build(source,'arduino:avr:uno');assert(result.success,JSON.stringify(result));
 const value=JSON.parse(result.value);assert(value.artifacts?.length>0);report.artifacts=value.artifacts.length;
 const runs=path.join(config.paths.evidenceRoot,'runs');
 const receipts=fs.readdirSync(runs).filter(n=>n.endsWith('.receipt.json')).map(n=>({file:path.join(runs,n),value:JSON.parse(fs.readFileSync(path.join(runs,n),'utf8'))}));
 const current=receipts.filter(r=>r.value.startedUnixMs>=started&&r.value.success&&r.value.discoveryMode==='official');assert.equal(current.length,1);
 assert.deepEqual(current[0].value.selectedLibraries,[]);report.receipt=current[0].file;report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;}
finally {client?.close();fs.writeFileSync(path.join(config.paths.evidenceRoot,'official-empty-libraries-regression.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
