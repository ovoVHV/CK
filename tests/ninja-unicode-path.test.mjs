import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {emitGraph} from '../src/native/plan.mjs';

test('Ninja resolves a multibyte Windows operand below 240 characters but over 260 bytes',{skip:process.platform!=='win32'},t=>{
 const tmp=fs.mkdtempSync(path.join(os.tmpdir(),'ck-ninja-'));
 t.after(()=>fs.rmSync(tmp,{recursive:true,force:true}));
 const build=path.join(tmp,'目'.repeat(75),'build'),graph=path.join(tmp,'graph');
 fs.mkdirSync(build,{recursive:true});
 const input=path.join(build,'fixture.cpp');
 assert(input.length<240 && Buffer.byteLength(input)>260);
 fs.writeFileSync(input,'fixture');
 const output=path.join(build,'result');
 const ninja=emitGraph({build,graph,finalOutputs:[output],rules:[{name:'fixture',kind:'metadata',directory:build,argv:[process.execPath,'--version'],inputs:[input],output}]});
 const run=spawnSync(fileURLToPath(new URL('../runtime/ninja.exe',import.meta.url)),['-C',build,'-f',ninja,'-n'],{encoding:'utf8'});
 assert.equal(run.status,0,run.stderr);
});
