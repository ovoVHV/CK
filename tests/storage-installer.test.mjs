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
test('installer embeds the actual release as Windows product and file versions',()=>{
 const installer=fs.readFileSync(new URL('../scripts/package-installer.mjs',import.meta.url),'utf8');
 assert.match(ENGINE_VERSION,/^\d+\.\d+\.\d+$/);
 for(const entry of ['VIProductVersion "${ENGINE_VERSION}.0"','VIAddVersionKey "ProductVersion" "${ENGINE_VERSION}"','VIAddVersionKey "FileVersion" "${ENGINE_VERSION}"'])assert(installer.includes(entry),entry);
});
