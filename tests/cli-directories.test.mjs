import test from 'node:test';import assert from 'node:assert/strict';import {cliDirectories} from '../src/cli-directories.mjs';
test('selected Unicode paths with spaces and hash characters retain their full identity',()=>{
 const value='E:/中文 # 数据';assert.deepEqual(cliDirectories(`directories:\n  data: ${JSON.stringify(value)}\n  downloads: 'E:/缓存'\n  user: "E:/项目"\nbuild_cache:\n  data: ignored\n`),{data:value,downloads:'E:/缓存',user:'E:/项目'});
});
test('existing unquoted profiles remain supported and ambiguous keys fail closed',()=>{
 assert.equal(cliDirectories('directories:\r\n  data: C:/Users/AI/CK\r\n  user: C:/Users/AI/CK/sketchbook\r\n').data,'C:/Users/AI/CK');
 assert.throws(()=>cliDirectories('directories:\n  data: a\n  data: b\n'),/Duplicate/);
});
