// One-time, auditable source migration. Runtime never imports V8 directories.
import fs from 'node:fs';
import path from 'node:path';
import {fileURLToPath} from 'node:url';
import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
if(fs.existsSync(path.join(root,'src')))throw Error('Baseline already imported; use version control for subsequent changes');
const old=path.resolve(root,'../work/v8-g-20261101');
const v6=path.resolve(root,'../work/v8-a3-20261030/v6/scripts');
const hash=b=>createHash('sha256').update(b).digest('hex');
const manifest=[];
function put(name,data){const f=path.join(root,name);fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,data);}
function copy(source,dest,transform=s=>s){const b=fs.readFileSync(source);manifest.push({source,destination:dest,sha256:hash(b)});put(dest,transform(b.toString()));}
for(const name of ['engine','scheduler','resolver','discovery','qualification','frontend','worker']) {
 copy(path.join(old,name+'.mjs'),'src/'+name+'.mjs',s=>s.replaceAll('../v8-a3-20261030/v6/scripts/native-build-engine/','./native/').replaceAll('../v8-c2-20261031/discovery-graph.mjs','./source-contract.mjs').replaceAll('ExperimentSession','BuildSession'));
}
for(const name of ['plan','frontend','object-cache','discovery-history','merge-bin','elf-image'])copy(path.join(v6,'native-build-engine',name+'.mjs'),'src/native/'+name+'.mjs',s=>s.replaceAll('../Execute-CKExperimentalBuildCommand.mjs','../execute-command.mjs'));
copy(path.join(v6,'Execute-CKExperimentalBuildCommand.mjs'),'src/execute-command.mjs',s=>s.replaceAll('./native-build-engine/','./native/'));
const graph=fs.readFileSync(path.resolve(old,'../v8-c2-20261031/discovery-graph.mjs'),'utf8');
put('src/source-contract.mjs',"import fs from 'node:fs';\nimport path from 'node:path';\nimport {createHash} from 'node:crypto';\nimport {sourceContract} from './native/frontend.mjs';\nconst hash=v=>createHash('sha256').update(v).digest('hex');\n"+graph.slice(graph.indexOf('// Mask comments'),graph.indexOf('export function assetRoots')));
copy(path.join(old,'native/src/bin/assets-enum.rs'),'native/src/bin/assets.rs');
copy(path.join(old,'native/src/bin/job.rs'),'native/src/bin/job.rs');
copy(path.join(old,'native/Cargo.toml'),'native/Cargo.toml',s=>s.replace('ck-g-native','ck-build-engine-native').replace('0.1.0','9.1.0-alpha.2'));
copy(path.join(old,'native/Cargo.lock'),'native/Cargo.lock',s=>s.replace('ck-g-native','ck-build-engine-native').replace('version = "0.1.0"','version = "9.1.0-alpha.2"'));
put('provenance/imported-sources.json',JSON.stringify({version:1,importedAt:new Date().toISOString(),files:manifest},null,2)+'\n');
const archive=path.resolve(root,'../outputs/CK-Build-Engine-v8G-evidence-2026-11-01.zip');
const expected='62c44c838ab4d9d87be6ba4f7e583858e9f9a7951b24fe5eca5bc774d5cd3170';
if(hash(fs.readFileSync(archive))!==expected)throw Error('V8-G snapshot changed');
put('provenance/v8-g-freeze.json',JSON.stringify({archive,sha256:expected,bytes:fs.statSync(archive).size,sourceLock:JSON.parse(fs.readFileSync(path.join(old,'final-source-lock.json'),'utf8')),productionBaseline:JSON.parse(fs.readFileSync(path.join(old,'baseline-before.json'),'utf8')),scope:'Research baseline only; not release qualification.'},null,2)+'\n');
console.log('Imported source lineage and verified V8-G archive.');
