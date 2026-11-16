import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
import {allowsFqbn,parseFqbn,parseEsp32Fqbn,targetAssetRoots,propertiesCovered,coreVersionSupported,installedPlatforms,platformVersionSupported} from '../src/targets.mjs';
import {artifactsFor} from '../src/version.mjs';
import {validateArtifacts} from '../src/protocol.mjs';
import {prepare} from '../src/discovery.mjs';
test('ESP32 menus route independently of flash/partition/PSRAM/USB values',()=>{
 for(const fqbn of ['esp32:esp32:esp32','esp32:esp32:esp32c3','esp32:esp32:esp32s3:FlashSize=4M,PartitionScheme=default','esp32:esp32:esp32s3:FlashSize=16M,PSRAM=opi,USBMode=hwcdc','esp32:esp32:esp32da:CPUFreq=160'])assert(allowsFqbn(['esp32:esp32:*'],fqbn));
 for(const fqbn of ['esp32:esp32:*','esp32:esp32:../x','esp32:esp32:esp32:','esp32:esp32:esp32:FlashSize=4M,FlashSize=16M','arduino:avr:uno'])assert.equal(parseEsp32Fqbn(fqbn),null);
 assert(!allowsFqbn(['esp32:esp32:esp32s3:FlashSize=16M'],'esp32:esp32:esp32s3:FlashSize=4M'));
 assert(coreVersionSupported('3.3.6-cn'));assert(!coreVersionSupported('3.3.6-cn-modified'));
});

test('unknown platform recipes reject before any native build preparation',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-platform-reject-'));
 try{
  const platform=path.join(root,'1.8.8'),workspace=path.join(root,'workspace');fs.mkdirSync(platform);fs.writeFileSync(path.join(platform,'platform.txt'),'modified recipe');
  const props={'build.arch':'AVR','runtime.platform.path':platform,'build.core.platform.path':platform};
  assert.throws(()=>prepare({workspace},props),e=>e.code==='NOT_QUALIFIED'&&e.fallbackSafe===true);
  assert(!fs.existsSync(path.join(workspace,'build')));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
test('asset closure follows installed board MCU and every selectable SDK variant',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-targets-'));
 try{
 const core=path.join(root,'packages/esp32/hardware/esp32/3.3.6-cn'),tools=path.join(root,'packages/esp32/tools');fs.mkdirSync(core,{recursive:true});fs.writeFileSync(path.join(core,'platform.txt'),'version=3.3.6');
 fs.writeFileSync(path.join(core,'boards.txt'),'board.build.mcu=esp32p4\nboard.build.chip_variant=esp32p4_es\nboard.menu.ChipVariant.new.build.chip_variant=esp32p4\ns3.build.mcu=esp32s3\n');
 for(const name of ['esptool_py','esp-rv32','esp-x32','esp32p4-libs','esp32p4_es-libs','esp32s3-libs'])fs.mkdirSync(path.join(tools,name),{recursive:true});
 assert.deepEqual(targetAssetRoots(root,'esp32:esp32:board:ChipVariant=new').map(p=>path.basename(p)),['esp32','esp-rv32','esp32p4-libs','esp32p4_es-libs','esptool_py']);
 assert.deepEqual(targetAssetRoots(root,'esp32:esp32:s3').map(p=>path.basename(p)),['esp32','esp-x32','esp32s3-libs','esptool_py']);
 assert.throws(()=>targetAssetRoots(root,'esp32:esp32:missing'),/absent/);
 const p=Object.fromEntries(['runtime.platform.path','build.core.path','build.variant.path','compiler.path','compiler.sdk.path'].map(k=>[k,path.join(core,k)]));assert(propertiesCovered(p,[core]));p['compiler.path']=core+'-other';assert(!propertiesCovered(p,[core]));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('AVR menu identities, artifact schemas and asset closure are independent of ESP32',()=>{
 for(const fqbn of ['arduino:avr:uno','arduino:avr:nano:cpu=atmega328old','arduino:avr:nano:cpu=atmega168','arduino:avr:mega:cpu=atmega2560']){
  assert.equal(parseFqbn(fqbn).arch,'avr');assert(allowsFqbn(['arduino:avr:*'],fqbn));assert(!allowsFqbn(['esp32:esp32:*'],fqbn));
  const artifacts=artifactsFor(fqbn).map(name=>({name,file:path.resolve(name),bytes:1,sha256:'a'.repeat(64)}));
  assert(validateArtifacts(artifacts,fqbn));assert.throws(()=>validateArtifacts(artifacts,'esp32:esp32:esp32s3'));
  assert.throws(()=>validateArtifacts(artifacts.slice(1),fqbn));
 }
 assert(!allowsFqbn(['arduino:avr:nano:cpu=atmega328'],'arduino:avr:nano:cpu=atmega328old'));
 assert.equal(parseFqbn('arduino:avr:nano:cpu=atmega328,cpu=atmega168'),null);
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-avr-'));
 try{
  const platform=path.join(root,'packages/arduino/hardware/avr/1.8.8'),compiler=path.join(root,'packages/arduino/tools/avr-gcc');
  fs.mkdirSync(platform,{recursive:true});fs.mkdirSync(compiler,{recursive:true});fs.writeFileSync(path.join(platform,'platform.txt'),'version=1.8.8');fs.writeFileSync(path.join(platform,'boards.txt'),'uno.build.mcu=atmega328p\n');
  const roots=targetAssetRoots(root,'arduino:avr:uno');assert.equal(roots.length,2);assert(roots.every(p=>!p.includes('esp32')));
  assert.throws(()=>targetAssetRoots(root,'arduino:avr:missing'),/absent/);
  const props={'build.arch':'AVR','runtime.platform.path':platform,'build.core.path':path.join(platform,'cores/arduino'),'build.variant.path':path.join(platform,'variants/standard'),'compiler.path':compiler};assert(propertiesCovered(props,roots));props['compiler.path']=compiler+'-outside';assert(!propertiesCovered(props,roots));
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});

test('AVR 1.8.6, 1.8.7 and 1.8.8 installations route Uno without pretending its board is missing',()=>{
 const root=fs.mkdtempSync(path.join(os.tmpdir(),'ck-avr-versions-'));
 try{for(const version of ['1.8.6','1.8.7','1.8.8']){
  const sysroot=path.join(root,version),platform=path.join(sysroot,'packages/arduino/hardware/avr',version);
  fs.mkdirSync(platform,{recursive:true});fs.mkdirSync(path.join(sysroot,'packages/arduino/tools/avr-gcc'),{recursive:true});
  fs.writeFileSync(path.join(platform,'platform.txt'),'version='+version);fs.writeFileSync(path.join(platform,'boards.txt'),'uno.build.mcu=atmega328p\n');
  assert(platformVersionSupported('avr',version));assert.deepEqual(installedPlatforms(sysroot,'avr'),[platform]);assert.equal(targetAssetRoots(sysroot,'arduino:avr:uno').length,2);
 }
 const unsupported=path.join(root,'unsupported/packages/arduino/hardware/avr/99.0.0');fs.mkdirSync(unsupported,{recursive:true});fs.writeFileSync(path.join(unsupported,'platform.txt'),'version=99.0.0');
 assert.throws(()=>targetAssetRoots(path.join(root,'unsupported'),'arduino:avr:uno'),/Unsupported installed AVR Core version\(s\): 99\.0\.0/);
 }finally{fs.rmSync(root,{recursive:true,force:true});}
});
