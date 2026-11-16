import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';import {spawnSync} from 'node:child_process';
import {storageIncludes,storageFunctions} from '../scripts/storage-installer.mjs';
import {ENGINE_VERSION} from '../src/version.mjs';
test('installer computes defaults for nonexistent folders and preserves explicit choice',t=>{
 const nsis=process.env.CK_NSIS||path.join(process.env.LOCALAPPDATA,'tauri/NSIS/makensis.exe');
 if(!fs.existsSync(nsis)){t.skip('NSIS unavailable');return;}
 const dir=fs.mkdtempSync(path.join(os.tmpdir(),'ck-installer-check-'));
 t.after(()=>{assert(path.basename(dir).startsWith('ck-installer-check-'));fs.rmSync(dir,{recursive:true,force:true});});
 const file=path.join(dir,'check.nsi'),out=path.join(dir,'result.txt');
 const slash=s=>s.replaceAll('/','\\');
 const defaults=storageFunctions.slice(0,storageFunctions.indexOf('Function CKDataPage\n'));
 fs.writeFileSync(file,'\uFEFF'+`Unicode True\nName "Storage default test"\nOutFile "${slash(path.join(dir,'check.exe'))}"\nRequestExecutionLevel user\nSilentInstall silent\n${storageIncludes}\n${defaults}\nFunction .onInit\n FileOpen $9 "${slash(out)}" w\n StrCpy $INSTDIR "E:\\新目录 不存在\\CK"\n Call CKDataDefault\n FileWriteUTF16LE $9 "$DataRoot$\\r$\\n"\n StrCpy $INSTDIR "C:\\Another\\CK"\n Call CKDataDefault\n FileWriteUTF16LE $9 "$DataRoot$\\r$\\n"\n StrCpy $DataRoot "E:\\CustomData"\n StrCpy $INSTDIR "C:\\Third\\CK"\n Call CKDataDefault\n FileWriteUTF16LE $9 "$DataRoot$\\r$\\n"\n FileClose $9\n SetErrorLevel 0\n Quit\nFunctionEnd\nSection\nSectionEnd\n`);
 const built=spawnSync(nsis,['/V2',file],{windowsHide:true,encoding:'utf8'});assert.equal(built.status,0,built.stdout+built.stderr);
 const run=spawnSync(path.join(dir,'check.exe'),['/S'],{windowsHide:true});assert.equal(run.status,0);
 assert.deepEqual(fs.readFileSync(out,'utf16le').trim().split(/\r?\n/),['E:\\新目录 不存在\\CKData','C:\\Another\\CKData','E:\\CustomData']);
});
test('desktop and engine enforce the same release identity',()=>{
 for(const f of ['desktop/crates/ck_core/src/builder/demo/native_graph_backend.rs','desktop/crates/ck_core/src/builder/demo/v9_protocol.rs']){
  const versions=fs.readFileSync(new URL('../'+f,import.meta.url),'utf8').match(/9\.1\.0-alpha\.\d+/g);assert(versions?.length);assert(versions.every(v=>v===ENGINE_VERSION),f);
 }
 const desktop=JSON.parse(fs.readFileSync(new URL('../desktop/apps/desktop/src-tauri/tauri.conf.json',import.meta.url)));assert.equal(desktop.version,ENGINE_VERSION);
});
