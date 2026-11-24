// A disposable, declarative Blockly package calls a function implemented by the *project*.
// It has no C++ sources of its own. Never install it in a user's normal library store.
import fs from 'node:fs';
import path from 'node:path';
import assert from 'node:assert/strict';
import { randomUUID } from 'node:crypto';

export const markers = { blocks:'CK_MODE_BLOCKS_31', source:'CK_MODE_SOURCE_72' };
export const header = n => `#pragma once\n#define CK_HEADER_TEXT "CK_HEADER_${n}"\n`;

export function installFixture(config) {
    assert.equal(path.resolve(process.env.CK_MF_PRIVATE_SYSROOT || '.'), path.resolve(config.paths.sysroot),
        'Set CK_MF_PRIVATE_SYSROOT to the disposable QA asset store');
    const id='ck_mf_'+randomUUID().replaceAll('-','').slice(0,12), type=id+'_call';
    const pkg=path.join(config.paths.sysroot,'libraries',id);
    fs.mkdirSync(path.dirname(pkg),{recursive:true}); fs.mkdirSync(pkg); fs.mkdirSync(path.join(pkg,'blocks'));
    const json=(name,value)=>fs.writeFileSync(path.join(pkg,name),JSON.stringify(value,null,2));
    const title='多文件回归', endpoints={blocks:'blocks/blocks.json',generator:'blocks/ck-generator.json',toolbox:'blocks/toolbox.json'};
    json('library.json',{id,name:title,version:'1.0.0',architectures:['avr','esp32'],description:title});
    json('ck-blocks.json',{schema_version:1,id,display_name:title,description:title,entrypoints:endpoints,
        blocks:[{type,display_name:'调用工程模块',description:'输出工程模块与当前模式标记',kind:'statement'}]});
    json(endpoints.blocks,[{type,message0:'调用工程模块',previousStatement:null,nextStatement:null,colour:180}]);
    json(endpoints.generator,{schema:'ck-generator',version:1,rules:[{type,kind:'statement',includes:{project:'#include "Blink.h"'},template:`emitBlink("${markers.blocks}");\n`}]});
    json(endpoints.toolbox,{kind:'category',name:title,contents:[{kind:'block',type}]});
    return type;
}
export function makeProject(dir, fqbn, type) {
    const [vendor,arch,board,menu]=fqbn.split(':'), name='多文件闪灯-'+board, root=path.join(dir,name), entry=path.join(root,name+'.ck');
    fs.mkdirSync(path.join(root,'src'),{recursive:true});
    const blockId='loop-'+board;
    const tree={blocks:{languageVersion:0,blocks:[{type:'controls_loop_custom',id:blockId,x:70,y:60,inputs:{DO:{block:{type,id:'emit-'+board}}}}]}};
    fs.writeFileSync(entry,JSON.stringify({format:'ck-project',schema_version:1,migration_version:1,name,board:[vendor,arch,board].join(':'),board_package_id:[vendor,arch,board].join(':'),options:JSON.stringify(Object.fromEntries(menu?menu.split(',').map(s=>s.split('=')):[])),xml:JSON.stringify(tree)}));
    fs.writeFileSync(path.join(root,'Blink.h'),'#pragma once\nvoid emitBlink(const char *mode);\n');
    fs.writeFileSync(path.join(root,'Blink.cpp'),'#include <Arduino.h>\n#include "Blink.h"\n#include "src/Timing.h"\nvoid emitBlink(const char *mode) { Serial.println(mode); Serial.println(CK_HEADER_TEXT); delay(250); }\n');
    const timing=path.join(root,'src/Timing.h');fs.writeFileSync(timing,header(101));
    return {entry,blockId,timing,fqbn,board};
}
// Arduino's HEX encodes bytes as text. Read only type-00 data, so ASCII markers
// that cross HEX record boundaries can be checked in flash just like ESP app BIN.
export function firmwareData(file,bytes){
    if(!file.endsWith('.hex'))return bytes;
    const records=[];
    for(const line of bytes.toString('ascii').trim().split(/\r?\n/)){
        assert.match(line,/^:(?:[\da-f]{2})+$/i);const r=Buffer.from(line.slice(1),'hex');
        assert.equal(r.length,r[0]+5);assert.equal(r.reduce((a,b)=>a+b,0)&255,0,'HEX checksum');
        if(r[3]===0)records.push(r.subarray(4,-1));
    }
    return Buffer.concat(records);
}
