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
 for(const code of ['#include HEADER','#include <WiFi.h>\n#define ROUTE 1','#if 0\n#include <WiFi.h>\n#endif','class C {};','/*unterminated','#include <WiFi.h> /*ok*/ extra','const char*x=R"(raw)";','#include <WiFi.h>\n_Pragma("message x")','#include <WiFi.h> //comment\\\n#define ROUTE 1','#inc/**/lude <WiFi.h>','#include "WiFi.h>'])assert.throws(()=>sourceContract(code),undefined,code);
});
