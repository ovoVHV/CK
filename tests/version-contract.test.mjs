import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import {ENGINE_VERSION} from '../src/version.mjs';
test('desktop, controller and native receipt validators share the release version',()=>{
 const root=new URL('../',import.meta.url);
 assert.equal(JSON.parse(fs.readFileSync(new URL('config.example.json',root),'utf8')).engineVersion,ENGINE_VERSION);
 for(const file of ['package.json','desktop/apps/desktop/src-tauri/tauri.conf.json'])assert.equal(JSON.parse(fs.readFileSync(new URL(file,root),'utf8')).version,ENGINE_VERSION,file);
 for(const file of ['desktop/crates/ck_core/src/builder/demo/native_graph_backend.rs','desktop/crates/ck_core/src/builder/demo/v9_protocol.rs']){
  const versions=[...fs.readFileSync(new URL(file,root),'utf8').matchAll(/9\.1\.0-alpha\.\d+/g)].map(m=>m[0]);assert(versions.length);assert(versions.every(v=>v===ENGINE_VERSION),file);
 }
});
