import test from 'node:test';
import assert from 'node:assert/strict';
import {officialLibraries} from '../src/discovery.mjs';
test('official frontend core-only result may omit used_libraries',()=>{
 assert.deepEqual(officialLibraries({builder_result:{build_path:'build',build_properties:[]}}),[]);
 assert.deepEqual(officialLibraries({builder_result:{used_libraries:null}}),[]);
});
test('official selected libraries preserve exact paths and malformed lists are rejected',()=>{
 const libraries=[{name:'Example',source_dir:'C:/库/src',install_dir:'C:/库',version:'1.0.0'}];
 assert.deepEqual(officialLibraries({builder_result:{used_libraries:libraries}}),libraries);
 for(const bad of [{},'none',0])assert.throws(()=>officialLibraries({builder_result:{used_libraries:bad}}),/Invalid official/);
});
