import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {sourceContract} from '../src/native/frontend.mjs';
import {bodyContract} from '../src/source-contract.mjs';
test('real Blockly provenance comments must not disable native discovery or No-Op eligibility',()=>{
 const raw=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8');
 const preview=fs.readFileSync(new URL('blockly-wifi-preview.ino',import.meta.url),'utf8');
 assert.notEqual(raw,preview);assert.equal(sourceContract(raw),sourceContract(preview));assert.equal(bodyContract(raw).qualified,true);
 const changed=raw.replace('12345678','namespace class struct');assert.equal(sourceContract(changed),sourceContract(raw));
});
test('comments are lexical whitespace, not preprocessor directives or C++ constructs',()=>{
 const base=sourceContract('#include <WiFi.h>\nvoid setup(){}\nvoid loop(){}');
 assert.equal(sourceContract('#include <WiFi.h> /* class */ /* metadata */\nvoid setup(){}\nvoid loop(){}'),base);
 assert.equal(sourceContract('/*\n#include <Other.h>\n#define HIDE 1\n*/\n#include <WiFi.h> // namespace\nvoid setup(){}\nvoid loop(){}'),base);
 assert.notEqual(sourceContract('#include <WiFi.h>'),sourceContract('#include <Other.h>'));
 assert.notEqual(sourceContract('#include <a/*x*/b.h>'),sourceContract('#include <a/*y*/b.h>'));
 assert.notEqual(sourceContract('#include "a//x.h"'),sourceContract('#include "a//y.h"'));
});
test('active preprocessing, complex syntax and ambiguous lexing retain official fallback',()=>{
 for(const code of ['#include HEADER','#if 0\n#include <WiFi.h>\n#endif','class C {};','/*unterminated','#include <WiFi.h> /*ok*/ extra','const char*x=R"(raw)";','#include <WiFi.h>\n_Pragma("message x")','#include <WiFi.h> //comment\\\n#define ROUTE 1','#inc/**/lude <WiFi.h>','#include "WiFi.h>'])assert.throws(()=>sourceContract(code),undefined,code);
});
test('a trailing R inside a literal or comment is not a raw string opener',()=>{
 const sketch=body=>`void setup() { ${body} }\nvoid loop() {}`;
 for(const body of ['show("ROUTER");','show("R"); /* R" */'])assert.equal(bodyContract(sketch(body)).qualified,true);
 for(const prefix of ['R','u8R','LR'])assert.equal(bodyContract(sketch(`show(${prefix}"tag(value)tag");`)).qualified,false);
});
test('integer constants are bound in order with the includes they can configure',()=>{
 const def='#define SENSOR_PIN 0x0Du',inc='#include <Sensor.h>',body='void setup() {}\nvoid loop() { delay(SENSOR_PIN); }';
 const source=[def,inc,body].join('\n'),base=sourceContract(source);
 assert.equal(base,sourceContract(source.replace('delay(SENSOR_PIN);','delay(17);')));
 assert.equal(base,sourceContract(source.replace(def,def+' /* note */')));
 for(const next of [source.replace('0x0D','0x07'),source.replaceAll('SENSOR_PIN','OTHER_PIN'),[inc,def,body].join('\n')])assert.notEqual(base,sourceContract(next));
 for(const value of ['0','01','-42L','0b101U','22ULL'])assert.doesNotThrow(()=>sourceContract('#define VALUE '+value));
 for(const line of ['#define FN(x) x','#define NUM OTHER','#define NUM (1+2)','#define setup 1','#define _Pin 1','#define A__B 1','#define NUM 08','#define NUM 0LLL','#define NUM "private"','#undef NUM','#define NUM 2\\ \n3'])assert.throws(()=>sourceContract(line));
 for(const source of [def+'\n'+def,body+'\n'+def])assert.throws(()=>sourceContract(source));
 assert.throws(()=>sourceContract('// note\n#include SECRET_HEADER'),e=>e.message.includes('#include at line 2')&&!e.message.includes('SECRET'));
 assert.throws(()=>sourceContract('#private_token secret'),e=>!e.message.includes('private_token')&&!e.message.includes('secret'));
});
