import fs from 'node:fs';import path from 'node:path';import {spawnSync} from 'node:child_process';import {fileURLToPath} from 'node:url';
const root=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');let checked=0;
function visit(dir){for(const e of fs.readdirSync(dir,{withFileTypes:true})){const f=path.join(dir,e.name);if(e.isDirectory())visit(f);else if(f.endsWith('.mjs')){const s=fs.readFileSync(f,'utf8');if(/v8-\w+-\d{8}|CK-Build-Engine-V8|ck-g-/.test(s))throw Error('Experimental runtime dependency: '+f);const r=spawnSync(process.execPath,['--check',f],{encoding:'utf8'});if(r.status)throw Error(r.stderr);checked++;}}}
visit(path.join(root,'src'));console.log('Checked '+checked+' self-contained modules.');
