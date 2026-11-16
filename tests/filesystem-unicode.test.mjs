import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {copyDirectory,removeScratchTree,removeOptionalFile} from '../src/filesystem.mjs';
test('Unicode scratch cleanup works for missing files, empty trees and populated trees',()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'ck-unicode-fs-')),root=path.join(parent,'中文 # 空格'),outside=path.join(parent,'keep');
 try{
  fs.writeFileSync(outside,'keep');removeScratchTree(root);removeOptionalFile(path.join(root,'absent'));
  fs.mkdirSync(path.join(root,'空文件夹'),{recursive:true});fs.writeFileSync(path.join(root,'文件.txt'),'中文内容');
  const copy=path.join(parent,'复制 目录');copyDirectory(root,copy);assert.equal(fs.readFileSync(path.join(copy,'文件.txt'),'utf8'),'中文内容');assert(fs.statSync(path.join(copy,'空文件夹')).isDirectory());
  removeOptionalFile(path.join(copy,'文件.txt'));removeOptionalFile(path.join(copy,'文件.txt'));removeScratchTree(copy);removeScratchTree(root);
  assert(!fs.existsSync(copy));assert(!fs.existsSync(root));assert.equal(fs.readFileSync(outside,'utf8'),'keep');
 }finally{removeScratchTree(parent);}
});
test('scratch cleanup rejects redirected directories without traversing them',()=>{
 const parent=fs.mkdtempSync(path.join(os.tmpdir(),'ck-unicode-link-')),scratch=path.join(parent,'build'),external=path.join(parent,'external');
 try{
  fs.mkdirSync(scratch);fs.mkdirSync(external);fs.writeFileSync(path.join(external,'keep'),'keep');
  fs.symlinkSync(external,path.join(scratch,'redirect'),'junction');assert.throws(()=>removeScratchTree(scratch),/Linked/);assert(fs.existsSync(path.join(external,'keep')));
  fs.unlinkSync(path.join(scratch,'redirect'));
 }finally{removeScratchTree(parent);}
});
