import path from 'node:path';import test from 'node:test';import assert from 'node:assert/strict';
import {qualifyNativeElfRecipe} from '../src/native/elf-image.mjs';import {qualifyNativeMergeRecipe,mergeImage} from '../src/native/merge-bin.mjs';
const sysroot=path.resolve('image-test-assets'),build=path.resolve('image-test-build'),platform=path.join(sysroot,'packages/esp32/hardware/esp32/3.3.6-cn');
const tool=path.join(sysroot,'packages/esp32/tools/esptool_py/5.1.0-cn/esptool.exe'),fqbn='esp32:esp32:esp32s3:USBMode=hwcdc,FlashSize=4M';
test('S3 image admission binds recipe parameters independently of unrelated board menus',()=>{
 const argv=[tool,'--chip','esp32s3','elf2image','--flash-mode','dio','--flash-freq','80m','--flash-size','4MB','--elf-sha256-offset','0xb0','-o',path.join(build,'sketch.ino.bin'),path.join(build,'sketch.ino.elf')];
 const qualify=argv=>qualifyNativeElfRecipe({expanded:true,fqbn,argv,build,sysroot});assert.equal(qualify(argv).flashSize,'4MB');
 assert.equal(qualifyNativeElfRecipe({fqbn,argv,build,sysroot}),null,'expanded recipe is not enabled by default');
 for(const [index,value]of [[0,path.join(sysroot,'untrusted/esptool.exe')],[0,tool.replace('5.1.0-cn','5.2.0')],[2,'esp32c3'],[5,'keep'],[7,'unknown'],[9,'3MB'],[11,'0x80'],[13,path.join(build,'other.bin')]]){const other=[...argv];other[index]=value;assert.equal(qualify(other),null);}
 assert.equal(qualify([...argv,'--secure-pad']),null);assert(qualify(argv.map(x=>x===tool?tool.replace('5.1.0-cn','5.1.0'):x)));
});
test('raw merge accepts only bounded keep-parameter layouts and rejects header mutation recipes',()=>{
 const argv=[tool,'--chip','esp32','merge-bin','-o',path.join(build,'sketch.ino.merged.bin'),'--pad-to-size','8MB','--flash-mode','keep','--flash-freq','keep','--flash-size','keep','0x1000',path.join(build,'sketch.ino.bootloader.bin'),'0x8000',path.join(build,'sketch.ino.partitions.bin'),'0xe000',path.join(platform,'tools/partitions/boot_app0.bin'),'0x10000',path.join(build,'sketch.ino.bin')];
 const qualify=argv=>qualifyNativeMergeRecipe({expanded:true,fqbn:'esp32:esp32:esp32',argv,build,sysroot,platform});assert.equal(qualify(argv).padBytes,8*1024*1024);
 for(const [index,value]of [[7,'3MB'],[9,'dio'],[11,'80m'],[13,'8MB'],[14,'0x0'],[18,'0x8000'],[20,'0x8000'],[21,path.join(build,'different.bin')]]){const other=[...argv];other[index]=value;assert.equal(qualify(other),null);}
 assert.equal(qualify([...argv,'--target-offset','0x1000']),null);assert.throws(()=>mergeImage({...qualify(argv),padBytes:1024}),/Invalid/);
});
