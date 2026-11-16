import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import {createHash} from 'node:crypto';
import {verifyRelease} from './release.js';
const origin='https://ckswitch.site';
const rows=[];
for(const page of ['/','/features/','/performance/','/guide/','/examples/','/drivers/','/drivers/install/','/download/','/about/','/licenses/']){
 const response=await fetch(origin+page,{signal:AbortSignal.timeout(20000),headers:{'Cache-Control':'no-cache'}});
 assert.equal(response.status,200,page);
 const html=await response.text();assert(html.includes('CK LAB'),page);
 rows.push({page,status:response.status,bytes:Buffer.byteLength(html),compression:response.headers.get('content-encoding')});
}
const manifestResponse=await fetch(origin+'/site-sha256.json',{signal:AbortSignal.timeout(20000),cache:'no-store'});
assert.equal(manifestResponse.status,200);
const files=await manifestResponse.json();
assert.deepEqual(files,JSON.parse(fs.readFileSync(new URL('./dist/site-sha256.json',import.meta.url),'utf8')),'Deployed manifest must match this local build');
for(const file of files){
 const response=await fetch(origin+'/'+file.path,{signal:AbortSignal.timeout(20000),cache:'no-store'});
 assert.equal(response.status,200,file.path);const bytes=Buffer.from(await response.arrayBuffer());
 assert.equal(bytes.length,file.bytes,file.path);
 assert.equal(createHash('sha256').update(bytes).digest('hex'),file.sha256,file.path);
}
const release=await verifyRelease(await(await fetch(origin+'/ck-updates/preview/windows-x86_64/latest.json',{signal:AbortSignal.timeout(20000)})).json());
const range=await fetch(release.url,{headers:{Range:'bytes=0-1023'},signal:AbortSignal.timeout(20000)});
assert.equal(range.status,206);assert.equal((await range.arrayBuffer()).byteLength,1024);
const redirect=await fetch('http://ckswitch.site/',{redirect:'manual',signal:AbortSignal.timeout(20000)});assert([301,308].includes(redirect.status));assert.equal(redirect.headers.get('location'),origin+'/');
const missing=await fetch(origin+'/ck-lab-acceptance-page-not-found',{signal:AbortSignal.timeout(20000)});assert.equal(missing.status,404);
const result={status:'PASS',checkedAt:new Date().toISOString(),pages:rows,allStaticFilesVerified:files.length,updateVersion:release.version,updateSignatureVerified:true,installerRange:range.status,httpRedirect:redirect.status,notFound:missing.status};
const evidence=process.env.CK_LAB_EVIDENCE_DIR||new URL('../local/alpha30-evidence/',import.meta.url);
fs.mkdirSync(evidence,{recursive:true});
const evidenceFile=typeof evidence==='string'?path.join(evidence,'live-site-verification.json'):new URL('live-site-verification.json',evidence);
fs.writeFileSync(evidenceFile,JSON.stringify(result,null,2));console.log(JSON.stringify(result));
