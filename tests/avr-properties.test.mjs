import test from 'node:test';
import assert from 'node:assert/strict';
import {selectBoard,expandProperties,avrProperties} from '../src/avr-properties.mjs';
import {parseFqbn} from '../src/targets.mjs';
import fs from 'node:fs';import os from 'node:os';import path from 'node:path';
test('board menu defaults follow declaration order; explicit selections and invalid options are not guessed',()=>{
 const raw={'nano.name':'Nano','nano.build.f_cpu':'16000000L','nano.menu.cpu.new':'New','nano.menu.cpu.new.build.mcu':'atmega328p','nano.menu.cpu.old':'Old','nano.menu.cpu.old.build.mcu':'atmega168'};
 assert.equal(selectBoard(raw,parseFqbn('arduino:avr:nano')).board['build.mcu'],'atmega328p');
 assert.equal(selectBoard(raw,parseFqbn('arduino:avr:nano:cpu=old')).board['build.mcu'],'atmega168');
 assert.throws(()=>selectBoard(raw,parseFqbn('arduino:avr:nano:cpu=unknown')),/Unknown/);
 assert.throws(()=>selectBoard(raw,parseFqbn('arduino:avr:nano:clock=8')),/Unknown/);
 assert.throws(()=>selectBoard(raw,parseFqbn('arduino:avr:unknown')),/Missing/);
});
test('property expansion retains unresolved task substitutions and detects cycles',()=>{
 const p=expandProperties({path:'C:\\Tool Chain',compiler:'{path}/bin/avr-g++',recipe:'"{compiler}" -o "{object_file}"'});
 assert.equal(p.recipe,'"C:\\Tool Chain/bin/avr-g++" -o "{object_file}"');
 assert.throws(()=>expandProperties({a:'{b}',b:'{a}'}),/cycle/);
 assert.equal(avrProperties({fqbn:'esp32:esp32:esp32s3'}).hit,false);
 assert.equal(avrProperties({fqbn:'arduino:avr:uno',buildProperties:['build.mcu=other']}).hit,false);
});

test('an additional unqualified platform prevents selecting a lower supported Core by accident',()=>{
 const sysroot=fs.mkdtempSync(path.join(os.tmpdir(),'ck-avr-ambiguous-'));
 try{for(const version of ['1.8.6','99.0.0']){const dir=path.join(sysroot,'packages/arduino/hardware/avr',version);fs.mkdirSync(dir,{recursive:true});fs.writeFileSync(path.join(dir,'platform.txt'),'version='+version);}
  const result=avrProperties({fqbn:'arduino:avr:uno',sysroot});assert.equal(result.hit,false);assert.match(result.reason,/Ambiguous installed platform/);
 }finally{fs.rmSync(sysroot,{recursive:true,force:true});}
});
