import test from 'node:test';
import assert from 'node:assert/strict';
import {windowsProperties,expandNestedProperties,esp32Properties,dependencyIdentity} from '../src/esp32-properties.mjs';
import {selectBoard} from '../src/avr-properties.mjs';
import {parseFqbn} from '../src/targets.mjs';
test('installed package index ordering does not change tool identity; different versions and collisions do',()=>{
 const a={packager:'esp32',name:'esp-x32',version:'2511'},b={packager:'esp32',name:'esp32s3-libs',version:'3.3.6'};
 assert.equal(dependencyIdentity([a,b]),dependencyIdentity([b,a]));assert.notEqual(dependencyIdentity([a,b]),dependencyIdentity([a,{...b,version:'3.3.6-cn'}]));
 assert.throws(()=>dependencyIdentity([a,{...a,packager:'other'}]),/Ambiguous/);assert.throws(()=>dependencyIdentity([{...a,version:'../other'}]),/Unsafe/);
});
test('ESP32 property parser keeps literal Windows paths and expands nested tool keys',()=>{
 const raw=windowsProperties('# comment\ncompiler.path=wrong\ncompiler.path.windows={runtime.tools.{build.chip_variant}-libs.path}/\nbuild.chip_variant=esp32s3\nruntime.tools.esp32s3-libs.path=C:\\SDK\ndebug.path.windows=C:\\scripts\\\nrecipe={compiler.path}{source_file}\n');
 const p=expandNestedProperties(raw);
 assert.equal(p['compiler.path'],'C:\\SDK/');assert.equal(p['debug.path'],'C:\\scripts\\');assert.equal(p.recipe,'C:\\SDK/{source_file}');
 assert.throws(()=>windowsProperties('broken line'),/syntax/);assert.throws(()=>expandNestedProperties({a:'{b}',b:'{a}'}),/cycle/);
});
test('ESP32 menu expansion follows definition order, preserves selections and rejects guesses',()=>{
 const all=windowsProperties('chip.name=Chip\nchip.build.variant=chip\nchip.menu.Memory.none=None\nchip.menu.Memory.none.build.memory=0\nchip.menu.Memory.octal=Octal\nchip.menu.Memory.octal.build.memory=8\nchip.menu.USB.off=Off\nchip.menu.USB.off.build.usb=0\nchip.menu.USB.on=On\nchip.menu.USB.on.build.usb=1\n');
 const defaults=selectBoard(all,parseFqbn('esp32:esp32:chip'));assert.equal(defaults.board['build.memory'],'0');
 const changed=selectBoard(all,parseFqbn('esp32:esp32:chip:USB=on,Memory=octal'));assert.equal(changed.board['build.memory'],'8');assert.equal(changed.board['build.usb'],'1');
 for(const fqbn of ['esp32:esp32:missing','esp32:esp32:chip:Unknown=x','esp32:esp32:chip:USB=invalid'])assert.throws(()=>selectBoard(all,parseFqbn(fqbn)));
 assert.equal(esp32Properties({fqbn:'arduino:avr:uno'}).hit,false);
 assert.equal(esp32Properties({fqbn:'esp32:esp32:esp32s3',buildProperties:['compiler.cpp.extra_flags=-DCHANGE']}).hit,false);
});
