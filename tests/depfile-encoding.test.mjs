import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import fs from 'node:fs';
import os from 'node:os';
import {decodeDependencies,parseNativeDependencies} from '../src/native/depfile.mjs';
import {strictText,readPreprocessed,compilerIncludes,windowsToolEncoding} from '../src/native/tool-text.mjs';
import {linkExecution,buildFileExecution} from '../src/native/link-paths.mjs';
const cwd=path.resolve('encoding-fixture');
const join=(...p)=>path.join(cwd,...p);
// CP936 bytes for 中文. Fixtures are literal bytes, independent of host locale.
const gbk=(before,after)=>Buffer.concat([Buffer.from(before),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from(after)]);
test('compiler GBK dependency target binds to the actual Unicode output',()=>{
 const deps=decodeDependencies(gbk('','\\object.o: source.cpp header.h\n'),{cwd,output:join('中文','object.o'),encoding:'gbk'});
 assert.deepEqual(deps,['source.cpp','header.h']);
});
test('CK rewritten UTF-8 dependency files keep Chinese, spaces and make escapes',()=>{
 const text='中文/object.o: 中文/source.cpp path\\ with\\ space/a.h hash\\#name.h cash$$.h \\\n next.h\n';
 assert.deepEqual(decodeDependencies(Buffer.from(text),{cwd,output:join('中文','object.o'),encoding:'gbk'}),['中文/source.cpp','path with space/a.h','hash#name.h','cash$.h','next.h']);
});
test('ASCII target and GBK dependency resolve without replacement characters',()=>{
 assert.deepEqual(decodeDependencies(gbk('object.o: source.cpp ','/header.h\n'),{cwd,output:join('object.o'),encoding:'gbk'}),['source.cpp','中文/header.h']);
});
test('ambiguous valid byte sequences must not select one of two existing files',()=>{
 // C2 A9 is valid both as UTF-8 © and as a distinct GBK character.
 const bytes=Buffer.concat([Buffer.from('object.o: '),Buffer.from([0xc2,0xa9]),Buffer.from('.h\n')]);
 assert.throws(()=>decodeDependencies(bytes,{cwd,output:join('object.o'),encoding:'gbk',exists:()=>true}),/ambiguous/);
 const deps=decodeDependencies(bytes,{cwd,output:join('object.o'),encoding:'gbk',exists:f=>f===join('©.h')});assert.deepEqual(deps,['©.h']);
 assert.throws(()=>decodeDependencies(bytes,{cwd,output:join('object.o'),encoding:'gbk',exists:()=>false}),/ambiguous/);
});
test('malformed bytes and mismatched target fail closed',()=>{
 assert.throws(()=>decodeDependencies(Buffer.from([0xff]),{cwd,output:join('x.o'),encoding:'gbk'}));
 assert.throws(()=>decodeDependencies(Buffer.from('中文/wrong.o: a.h'),{cwd,output:join('中文','right.o'),encoding:'gbk'}));
 assert.throws(()=>strictText(Buffer.from('bad\uFFFDpath')));
 assert.throws(()=>strictText(Buffer.from('bad\0path')));
});
test('ASCII dependency parser retains original Windows path semantics',()=>{
 assert.deepEqual(parseNativeDependencies('C:\\out.o: C:\\src.cpp C:\\with\\ space\\a.h\r\n'),['C:\\src.cpp','C:\\with space\\a.h']);
});
test('Unicode linking preserves input order and resolves script/response paths before changing cwd',()=>{
 const build=join('中文 build'),cwd=join('assets');const argv=['g++','@flags',path.join(build,'a.o'),path.join(build,'core.a'),'-o',path.join(build,'out.elf')];
 const expanded=['-Llib','-T','script.ld','-Wl,--Map='+path.join(build,'out.map'),...argv.slice(2)];
 const r=linkExecution(argv,cwd,build,{expanded,resolveScript:p=>path.join(cwd,p)});
 assert.equal(r.directory,build);assert.deepEqual(r.argv,['g++','-L'+path.join(cwd,'lib'),'-T',path.join(cwd,'script.ld'),'-Wl,--Map=./out.map','./a.o','./core.a','-o','./out.elf']);
 assert.deepEqual(buildFileExecution(['size','-A',path.join(build,'out.elf')],cwd,build),{argv:['size','-A','./out.elf'],directory:build});
 assert.deepEqual(linkExecution(argv,cwd,join('ascii'),{}),{argv,directory:cwd});
});
test('mixed GCC path markers preserve UTF-8 Chinese source text', {skip:process.platform!=='win32'},()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-encoding-'));
 try{
  const source=path.join(root,'中文.cpp');fs.writeFileSync(source,'');
  const marker=Buffer.from(JSON.stringify(source));
  const text='# 1 '+marker.toString()+'\nconst char* s="中文文本";\n';
  const f=path.join(root,'mixed.i');fs.writeFileSync(f,text);
  assert.equal(readPreprocessed(f,root),text);
  if(windowsToolEncoding()==='gbk'){
   const start=JSON.stringify(source).split('中文');fs.writeFileSync(f,Buffer.concat([Buffer.from('# 1 '+start[0]),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from(start[1]+'\nconst char* s="中文文本";\n')]));
   assert.equal(readPreprocessed(f,root),text);
   const parts=source.split('中文');assert.deepEqual(compilerIncludes(Buffer.concat([Buffer.from('. '+parts[0]),Buffer.from([0xd6,0xd0,0xce,0xc4]),Buffer.from(parts[1]+'\n')]),root),[source]);
  }
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
