import assert from 'node:assert/strict';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {pathToFileURL} from 'node:url';
const [next,...priors]=process.argv.slice(2);
assert(next && priors.length);
const moduleOf=root=>import(pathToFileURL(path.resolve(root,'engine/src/storage.mjs')));
for(const prior of priors){
 const [legacy,current]=await Promise.all([moduleOf(prior),moduleOf(next)]);
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-release-migration-'));
 try{
  const install=path.join(dir,'软件'),requested=path.join(dir,'旧版数据'),env={LOCALAPPDATA:path.join(dir,'local'),USERPROFILE:dir,APPDATA:path.join(dir,'roaming')};
  fs.mkdirSync(install);
  const original=legacy.initializeStorage({install,requested,env});
  const locator=legacy.locatorPath(env),before=fs.readFileSync(locator);
  const files=[path.join(original.projects,'项目.ck'),path.join(original.assets,'packages','vendor','board','core.cpp')];
  for(const file of files){fs.mkdirSync(path.dirname(file),{recursive:true});fs.writeFileSync(file,'existing data');}
  const restored=current.initializeStorage({install,requested:path.join(dir,'other'),env});
  assert.deepEqual(restored,original);assert.deepEqual(fs.readFileSync(current.locatorPath(env)),before);
  for(const file of files)assert.equal(fs.readFileSync(file,'utf8'),'existing data');
  console.log(`${JSON.parse(fs.readFileSync(path.join(prior,'engine/package.json'))).version}: stored paths, project and core preserved`);
 }finally{fs.rmSync(dir,{recursive:true,force:true});}
}
