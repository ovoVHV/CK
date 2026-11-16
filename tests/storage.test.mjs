import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import path from 'node:path';import os from 'node:os';
import {initializeStorage,locatorPath,readStorage,planMigration,scheduleMigration,performMigration} from '../src/storage.mjs';
function fixture(t){
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-storage-test-'));
 t.after(()=>{assert(path.resolve(dir).startsWith(path.resolve(os.tmpdir())+path.sep+'ck-storage-test-'));fs.rmSync(dir,{recursive:true,force:true});});
 const env={LOCALAPPDATA:path.join(dir,'local'),APPDATA:path.join(dir,'roaming'),USERPROFILE:path.join(dir,'user')},install=path.join(dir,'program','CK'),requested=path.join(dir,'program','CKData');
 fs.mkdirSync(install,{recursive:true});return {dir,env,install,requested,file:locatorPath(env)};
}
function write(f,s){fs.mkdirSync(path.dirname(f),{recursive:true});fs.writeFileSync(f,s);}
test('new install stores all managed paths beside installation, upgrade preserves choice',t=>{
 const x=fixture(t),cfg=initializeStorage(x);assert.equal(cfg.root,x.requested);assert.equal(cfg.assets,x.requested);
 for(const k of ['desktop','webview','temp','projects','examples'])assert(cfg[k].startsWith(cfg.root+path.sep));
 assert.deepEqual(initializeStorage({...x,requested:path.join(x.dir,'other')}),cfg);
 assert.deepEqual(fs.readdirSync(path.dirname(x.file)),['storage.json']);
});
test('legacy upgrade keeps external assets and existing desktop data without copying',t=>{
 const x=fixture(t),assets=path.join(x.dir,'Documents','CK');write(path.join(assets,'packages','core.txt'),'core');
 write(path.join(path.dirname(x.file),'environment.json'),JSON.stringify({sysroot:assets}));
 const cfg=initializeStorage({...x,documents:path.join(x.dir,'Documents')});assert.equal(cfg.assets,assets);assert.equal(cfg.root,path.dirname(x.file));assert.equal(cfg.legacy,true);assert(!fs.existsSync(x.requested));
});

test('broken legacy location cannot silently reset an existing user to fresh data',t=>{
 const x=fixture(t),old=path.join(path.dirname(x.file),'environment.json');
 for(const contents of ['broken','{}']){
  write(old,contents);assert.throws(()=>initializeStorage(x),/旧版/);assert(!fs.existsSync(x.file));assert(!fs.existsSync(x.requested));
 }
});
test('migration verifies contents, preserves originals and preferences, rebuilds caches and relocates managed paths',async t=>{
 const x=fixture(t),cfg=initializeStorage(x),target=path.join(x.dir,'中文 # 数据');
 write(path.join(cfg.root,'packages','vendor','core.txt'),'core bytes');write(path.join(cfg.root,'cache','old.o'),'obsolete');
 write(path.join(cfg.root,'updates','preferences.json'),'{"suppressReminders":true}');write(path.join(cfg.root,'updates','setup.exe'),'discard download');
 write(path.join(cfg.root,'arduino-cli.yaml'),`board_manager:\n  additional_urls:\n    - https://example.invalid/index.json\ndirectories:\n  data: "${cfg.root.replaceAll('\\','/')}"\n  user: old\nother: retained\n`);
 write(path.join(cfg.desktop,'config.json'),JSON.stringify({project_roots:[path.join(cfg.root,'projects'),path.join(x.dir,'external-projects')]}));
 write(path.join(cfg.webview,'EBWebView','Default','preferences'),'theme');
 const plan=await scheduleMigration({...x,target});assert(plan.files>=5);assert.equal(readStorage(x.file).root,cfg.root);
 const next=await performMigration(x.file);
 assert.equal(next.root,target);assert.equal(next.assets,target);assert.equal(next.temp,path.join(target,'tmp'));
 assert.equal(fs.readFileSync(path.join(target,'packages','vendor','core.txt'),'utf8'),'core bytes');
 assert.equal(fs.readFileSync(path.join(cfg.root,'packages','vendor','core.txt'),'utf8'),'core bytes');
 assert(!fs.existsSync(path.join(target,'cache')));assert(!fs.existsSync(path.join(target,'updates','setup.exe')));
 assert(fs.existsSync(path.join(target,'updates','preferences.json')));assert(fs.existsSync(path.join(target,'webview','EBWebView','Default','preferences')));
 const yaml=fs.readFileSync(path.join(target,'arduino-cli.yaml'),'utf8');assert(yaml.includes(JSON.stringify(target.replaceAll('\\','/'))));assert(yaml.includes('other: retained'));assert(yaml.includes('https://example.invalid/index.json'));
 const projects=JSON.parse(fs.readFileSync(path.join(target,'desktop','config.json'))).project_roots;assert.equal(projects[0],path.join(target,'projects'));assert.equal(projects[1],path.join(x.dir,'external-projects'));
 assert(!fs.existsSync(path.join(path.dirname(x.file),'storage-pending.json')));
});
test('external assets stay referenced unless explicitly selected for copy',async t=>{
 const x=fixture(t),assets=path.join(x.dir,'Arduino15');write(path.join(assets,'packages','vendor','core'),'external');write(path.join(path.dirname(x.file),'environment.json'),JSON.stringify({sysroot:assets}));
 initializeStorage(x);const target=path.join(x.dir,'moved');await scheduleMigration({...x,target});const cfg=await performMigration(x.file);
 assert.equal(cfg.assets,assets);assert(!fs.existsSync(path.join(target,'packages')));assert(fs.existsSync(path.join(assets,'packages','vendor','core')));
 const target2=path.join(x.dir,'copied');await scheduleMigration({...x,target:target2,includeExternal:true});const copied=await performMigration(x.file);assert.equal(copied.assets,target2);assert.equal(fs.readFileSync(path.join(target2,'packages','vendor','core'),'utf8'),'external');assert(fs.existsSync(path.join(assets,'packages','vendor','core')));
});
test('same-size same-timestamp source changes fail without switching or deleting source',async t=>{
 const x=fixture(t),cfg=initializeStorage(x),source=path.join(cfg.root,'packages','core');write(source,'AAAA');const stat=fs.statSync(source);
 const target=path.join(x.dir,'moved');await scheduleMigration({...x,target});
 await assert.rejects(performMigration(x.file,{beforeVerify:()=>{fs.writeFileSync(source,'BBBB');fs.utimesSync(source,stat.atime,stat.mtime);}}),/内容变化|校验失败/);
 assert.equal(readStorage(x.file).root,cfg.root);assert.equal(fs.readFileSync(source,'utf8'),'BBBB');assert(!fs.existsSync(target));
});
test('copy corruption, new source members and cancellation cannot commit destination',async t=>{
 for(const mode of ['corrupt','member','cancel']){
  const sub={after:t.after.bind(t)},x=fixture(sub),cfg=initializeStorage(x),target=path.join(x.dir,'moved');write(path.join(cfg.root,'a'),'AAAA');await scheduleMigration({...x,target});
  const request=JSON.parse(fs.readFileSync(path.join(path.dirname(x.file),'storage-pending.json')));
  await assert.rejects(performMigration(x.file,{beforeVerify:()=>{if(mode==='corrupt')write(`${target}.ck-migrating-${request.id}${path.sep}a`,'ZZZZ');if(mode==='member')write(path.join(cfg.root,'new'),'new');if(mode==='cancel')write(path.join(path.dirname(x.file),'storage-cancel'),'cancel');}}));
  assert.equal(readStorage(x.file).root,cfg.root);assert.equal(fs.readFileSync(path.join(cfg.root,'a'),'utf8'),'AAAA');assert(!fs.existsSync(target));
 }
});
test('rejects occupied, overlapping and junction destinations',async t=>{
 const x=fixture(t),cfg=initializeStorage(x);write(path.join(x.dir,'occupied','mine'),'keep');
 for(const target of [cfg.root,path.join(cfg.root,'child'),x.dir,path.join(x.install,'data'),path.join(x.dir,'occupied')])await assert.rejects(planMigration(cfg,target,x.install));
 const link=path.join(x.dir,'linked');fs.symlinkSync(cfg.root,link,'junction');await assert.rejects(planMigration(cfg,path.join(link,'child'),x.install));
 assert.equal(fs.readFileSync(path.join(x.dir,'occupied','mine'),'utf8'),'keep');
});
test('unexpected links within data are rejected without following them',async t=>{
 const x=fixture(t),cfg=initializeStorage(x),external=path.join(x.dir,'external');write(path.join(external,'file'),'outside');fs.symlinkSync(external,path.join(cfg.root,'alias'),'junction');
 await assert.rejects(planMigration(cfg,path.join(x.dir,'moved'),x.install),/链接|重定向/);
});

test('migration preserves empty folders and external library paths and records config transformations',async t=>{
 const x=fixture(t),cfg=initializeStorage(x),target=path.join(x.dir,'moved'),external=path.join(x.dir,'my-libraries');
 fs.mkdirSync(path.join(cfg.root,'projects','empty'),{recursive:true});fs.mkdirSync(external);
 write(path.join(cfg.root,'arduino-cli.yaml'),`directories:\n  data: ${JSON.stringify(cfg.root.replaceAll('\\','/'))}\n  user: ${JSON.stringify(external.replaceAll('\\','/'))}\n`);
 await scheduleMigration({...x,target});await performMigration(x.file);
 assert(fs.statSync(path.join(target,'projects','empty')).isDirectory());
 assert(fs.readFileSync(path.join(target,'arduino-cli.yaml'),'utf8').includes(external.replaceAll('\\','/')));
 const receipt=JSON.parse(fs.readFileSync(path.join(target,'migration-receipt.json')));
 assert.equal(receipt.transformations.length,1);assert.equal(receipt.transformations[0].relative,'arduino-cli.yaml');
 assert.notEqual(receipt.transformations[0].sourceSha256,receipt.transformations[0].destinationSha256);
});

test('migration copies between Windows volumes without moving the source',{skip:!process.env.CK_STORAGE_QA_VOLUME},async t=>{
 const x=fixture(t),cfg=initializeStorage(x),parent=path.resolve(process.env.CK_STORAGE_QA_VOLUME);
 const target=path.join(parent,'ck-cross-volume-'+path.basename(x.dir));
 t.after(()=>{assert.equal(path.dirname(path.resolve(target)),parent);if(fs.existsSync(target))fs.rmSync(target,{recursive:true});});
 write(path.join(cfg.root,'packages','test-core'),'cross-volume');assert.notEqual(path.parse(cfg.root).root.toLowerCase(),path.parse(target).root.toLowerCase());
 await scheduleMigration({...x,target});const next=await performMigration(x.file);assert.equal(next.root,target);
 for(const root of [cfg.root,target])assert.equal(fs.readFileSync(path.join(root,'packages','test-core'),'utf8'),'cross-volume');
});
