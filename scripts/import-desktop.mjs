// Frozen source import for a distinct preview binary. Never writes the source repo.
import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),source=path.resolve(process.argv[2]),dest=path.join(root,'desktop');
if(fs.existsSync(dest))throw Error('Desktop source already imported');
const files=[];
function copy(rel){if(path.basename(rel)==='.git')return;const f=path.join(source,rel),d=path.join(dest,rel),s=fs.lstatSync(f);if(s.isSymbolicLink())throw Error('Source link rejected: '+rel);if(s.isDirectory()){fs.mkdirSync(d,{recursive:true});for(const n of fs.readdirSync(f))copy(path.join(rel,n));}else{const bytes=fs.readFileSync(f);fs.mkdirSync(path.dirname(d),{recursive:true});fs.writeFileSync(d,bytes);files.push({path:rel.replaceAll('\\','/'),bytes:bytes.length,sha256:createHash('sha256').update(bytes).digest('hex')});}}
for(const rel of ['Cargo.toml','Cargo.lock','.cargo','crates','apps/desktop/src-tauri','apps/desktop/dist','tools/ccache.exe','docs/schemas','scripts/experimental-linux-backend/product_worker.py','scripts/experimental-linux-backend/process_tree.py'])copy(rel);
fs.writeFileSync(path.join(root,'provenance/desktop-source.json'),JSON.stringify({source,files},null,2)+'\n');
const cf=path.join(dest,'apps/desktop/src-tauri/tauri.conf.json'),conf=JSON.parse(fs.readFileSync(cf));
conf.productName='CK V9 Preview';conf.identifier='com.ai.makerblockly.v9preview';conf.version='9.1.0-alpha.2';conf.app.windows[0].title='CK V9 Preview — 9.1.0-alpha.2';conf.bundle.active=false;delete conf.bundle.fileAssociations;delete conf.bundle.windows;conf.build.beforeBuildCommand='';
fs.writeFileSync(cf,JSON.stringify(conf,null,2)+'\n');
const cargo=path.join(dest,'apps/desktop/src-tauri/Cargo.toml');fs.writeFileSync(cargo,fs.readFileSync(cargo,'utf8').replace('version = "1.0.0"','version = "9.1.0-alpha.2"'));
const lock=path.join(dest,'Cargo.lock');fs.writeFileSync(lock,fs.readFileSync(lock,'utf8').replace(/(name = "appsdesktop"\r?\n)version = "1.0.0"/,'$1version = "9.1.0-alpha.2"'));
console.log('Imported '+files.length+' desktop source/frontend/resource files.');
