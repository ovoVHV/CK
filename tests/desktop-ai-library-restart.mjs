import fs from 'node:fs';import path from 'node:path';import assert from 'node:assert/strict';
import {connectDesktop} from './desktop-client.mjs';
const config=JSON.parse(fs.readFileSync(process.env.CK_V9_ENGINE_CONFIG,'utf8').replace(/^\uFEFF/,''));
const evidence=config.paths.evidenceRoot,fixture=JSON.parse(fs.readFileSync(path.join(evidence,'ai-library-restart-fixture.json'),'utf8'));
const report={status:'RUNNING',checks:[],desktopSha256:JSON.parse(fs.readFileSync(path.join(evidence,'desktop-launch.json'),'utf8').replace(/^\uFEFF/,'')).sha256};
let c;
try{
 c=await connectDesktop();assert(fs.existsSync(fixture.committed));assert(!fs.existsSync(fixture.pending));report.checks.push('Committed library survives full desktop restart; unfinalized installation is rolled back at startup');
 const unauthorized=await c.evaluate(`window.__TAURI_INTERNALS__.invoke('ai_install_library',{token:${JSON.stringify(fixture.token)}}).then(()=>({accepted:true}),e=>({accepted:false,error:String(e)}))`);assert(!unauthorized.accepted);report.checks.push('Disk candidate cannot restore in-memory compile/install authority after restart');
 const libraries=await c.evaluate(`window.__TAURI_INTERNALS__.invoke('get_all_libraries',{board:'arduino:avr:uno',boardPackageId:'arduino:avr:uno'})`);
 const id=path.basename(fixture.committed),installed=libraries.find(l=>l.id===id);assert(installed);assert.equal(installed.runtime_activation?.state,'declarative-safe');report.checks.push('Restarted library inventory accepts the committed standard declarative package');
 report.status='PASS';
}catch(e){report.status='FAIL';report.error=String(e.stack);process.exitCode=1;}
finally{c?.close();fs.writeFileSync(path.join(evidence,'ai-library-restart-report.json'),JSON.stringify(report,null,2));console.log(JSON.stringify(report));}
