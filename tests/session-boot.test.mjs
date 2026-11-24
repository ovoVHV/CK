import test from 'node:test';
import assert from 'node:assert/strict';
import path from 'node:path';
import {bootIdentity} from '../src/native/session-boot.mjs';

test('a session conversion binds the input bytes, tool, full menu, arguments and validated assets',()=>{
 const sysroot=path.resolve('sys'),out=path.resolve('build/sketch.ino.bootloader.bin');
 const exe=path.join(sysroot,'packages/esp32/tools/esptool_py/5.1.0-cn/esptool.exe'),elf=path.join(sysroot,'sdk/bin/boot.elf');
 const cfg={sysroot,fqbn:'esp32:esp32:esp32s3',sourceDateEpoch:1};
 const argv=[exe,'--chip','esp32s3','elf2image','--flash-mode','dio','--flash-freq','80m','--flash-size','4MB','-o',out,elf];
 const proof={rows:[[exe,'file',32,'a'.repeat(64)],[elf,'file',64,'b'.repeat(64)]],sha256:'c'.repeat(64)};
 const id=bootIdentity(argv,cfg,out,proof);assert.match(id,/^[a-f0-9]{64}$/);
 for(const i of [2,5,7,9])assert.notEqual(bootIdentity(argv.with(i,'other'),cfg,out,proof),id);
 for(const i of [0,1]){const p=structuredClone(proof);p.rows[i][3]='0'.repeat(64);assert.notEqual(bootIdentity(argv,cfg,out,p),id);}
 assert.notEqual(bootIdentity(argv,{...cfg,fqbn:cfg.fqbn+':FlashSize=8M'},out,proof),id);
 assert.notEqual(bootIdentity(argv,cfg,out,{...proof,sha256:'f'.repeat(64)}),id);
 assert.equal(bootIdentity(argv,cfg,out,{...proof,rows:proof.rows.slice(1)}),null);
 assert.equal(bootIdentity([...argv,'--extra'],cfg,out,proof),null);
 assert.equal(bootIdentity(argv,cfg,out+'-wrong',proof),null);
});
