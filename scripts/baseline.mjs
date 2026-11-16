import fs from 'node:fs';import path from 'node:path';import {fileURLToPath} from 'node:url';import {createHash} from 'node:crypto';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..'),hash=b=>createHash('sha256').update(b).digest('hex'),output=process.argv[2];if(!output)throw Error('Output manifest required');
const freeze=JSON.parse(fs.readFileSync(path.join(root,'provenance/v8-g-freeze.json'))),production=freeze.productionBaseline.map(x=>({file:x.File,expected:x.Expected,actual:hash(fs.readFileSync(x.File))}));
if(production.some(x=>x.expected!==x.actual))throw Error('Frozen production baseline changed');
if(hash(fs.readFileSync(freeze.archive))!==freeze.sha256)throw Error('V8-G archive changed');
// Development dependency installations are not source. Include lockfiles and
// the actual packaged dist/runtime; do not follow a local node_modules junction.
const excludedDirectories=['.git','local','target','test-results','node_modules'];
const files=[];function walk(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true}).sort((a,b)=>a.name.localeCompare(b.name))){if(excludedDirectories.includes(e.name))continue;const f=path.join(dir,e.name);if(e.isSymbolicLink())throw Error('Linked source rejected: '+f);if(e.isDirectory())walk(f);else{const b=fs.readFileSync(f);files.push({path:path.relative(root,f).replaceAll('\\','/'),bytes:b.length,sha256:hash(b)});}}}walk(root);
fs.mkdirSync(path.dirname(path.resolve(output)),{recursive:true});fs.writeFileSync(output,JSON.stringify({engineVersion:'9.1.0-alpha.26',createdAt:new Date().toISOString(),excludedDirectories,files,production,v8GArchive:{path:freeze.archive,sha256:freeze.sha256}},null,2)+'\n');console.log('Recorded '+files.length+' V9 files; all '+production.length+' frozen production checks match.');
