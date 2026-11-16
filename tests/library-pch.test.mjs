import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {firstGuardedHeader,acceptsLibraryPchGrant} from '../src/native/library-pch.mjs';
test('shared PCH requires an unconditional first include and a guarded original header',()=>{
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-first-header-'));
 const file=path.join(dir,'source.cpp'),header=path.join(dir,'Header.h'),output=path.join(dir,'source.o');
 const args=[process.execPath,'-c','-MMD',file,'-o',output],entry={directory:dir,file,arguments:args};
 try{
  fs.writeFileSync(header,'#pragma once\nvoid f();\n');fs.writeFileSync(file,'/* comment */\n#include "Header.h"\nvoid g(){}\n');
  assert.equal(firstGuardedHeader(entry,()=>[dir]).header,header);
  fs.writeFileSync(file,'#define A 1\n#include "Header.h"\n');assert.equal(firstGuardedHeader(entry,()=>[dir]),null);
  fs.writeFileSync(file,'#if A\n#include "Header.h"\n#endif\n');assert.equal(firstGuardedHeader(entry,()=>[dir]),null);
  fs.writeFileSync(file,'#include "Header.h"\n');fs.writeFileSync(header,'void f();\n');assert.equal(firstGuardedHeader(entry,()=>[dir]),null);
  fs.writeFileSync(header,'#ifndef CK_HEADER\n#define CK_HEADER\nvoid f();\n#endif\n');assert(firstGuardedHeader(entry,()=>[dir]));
  assert.equal(firstGuardedHeader({...entry,arguments:[...args,'-include','other.h']},()=>[dir]),null);
  assert.equal(acceptsLibraryPchGrant({},args,args,dir),false);
 }finally{for(const f of [file,header])if(fs.existsSync(f))fs.unlinkSync(f);fs.rmdirSync(dir);}
});
