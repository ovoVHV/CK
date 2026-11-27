import test from 'node:test';import assert from 'node:assert/strict';import fs from 'node:fs';
import {captureTemplate,replayTemplate} from '../src/frontend.mjs';
const source='#include <WiFi.h>\n\nvoid setup() {\n  WiFi.begin("MyWiFi", "12345678");\n}\n\nvoid loop() {\n}\n';
const generated='#include <Arduino.h>\n#line 1 "C:\\test\\sketch.ino"\n#include <WiFi.h>\n\n#line 3 "C:\\test\\sketch.ino"\nvoid setup();\n#line 7 "C:\\test\\sketch.ino"\nvoid loop();\n#line 3 "C:\\test\\sketch.ino"\n'+source.slice(source.indexOf('void setup'))+'\n';
const macros='#define Serial Serial0\n#define UNSAFE(x) x\n#define ALIAS UNSAFE\n';
const template=()=>captureTemplate(source,generated,macros);
test('ordinary body line additions update prototype line markers and keep exact new source',()=>{
 const t=template();assert(t.ordinary);
 const next=source.replace('  WiFi.begin','  Serial.begin(115200);\n  WiFi.begin').replace('void loop() {\n','void loop() {\n  while (WiFi.status() != WL_CONNECTED) {\n    delay(500);\n  }\n');
 const result=replayTemplate(t,next);assert(result.hit,result.reason);
 assert(result.code.includes('#line 8 "C:\\test\\sketch.ino"\nvoid loop();'));
 assert(result.code.endsWith(next.slice(next.indexOf('void setup'))+'\n'));
 const reverse=replayTemplate(result.template,source);assert(reverse.hit);assert.equal(reverse.code,generated);
 const commentOnly=replayTemplate(t,'/*\n#include <Arduino.h>\n*/\n'+next);
 assert(commentOnly.hit);assert(commentOnly.code.startsWith('#include <Arduino.h>\n'));
});
test('top-level declarations and unknown macro/template/lambda edits fall back',()=>{
 const t=template();
 for(const extra of ['UNSAFE(1);','ALIAS(2);','int local();','auto f=[](){return 1;};','foo<int>();','ns::foo();','int n=__LINE__;']){
  const r=replayTemplate(t,source.replace('void loop() {\n','void loop() {\n  '+extra+'\n'));assert.equal(r.hit,false,extra);
 }
 for(const next of [source.replace('WiFi.h','Other.h'),source.replace('void setup','int global;\nvoid setup'),source+'#define ROUTE 1\n',source.replace('void loop','int loop')])assert.equal(replayTemplate(t,next).hit,false);
});
test('observed transform mismatch does not authorize line-changing synthesis',()=>{
 const bad=captureTemplate(source,generated.replace('void loop();','void wrong();'),macros);assert.equal(bad.ordinary,null);
 assert.equal(replayTemplate(bad,source.replace('void loop() {\n','void loop() {\n  delay(1);\n')).hit,false);
});
test('a standalone wait edit in an unchanged comparison loop preserves the observed transform',()=>{
 const a=source.replace('void setup()', 'int pos = 0;\nvoid setup()').replace('void loop() {\n','void loop() {\n  for (pos=0; pos<10; ++pos) {\n    delay(15);\n  }\n');
 const g=generated.replace('#line 3','int pos = 0;\n#line 4').replace('void loop() {\n','void loop() {\n  for (pos=0; pos<10; ++pos) {\n    delay(15);\n  }\n');
 const b=a.replace('delay(15)','delay(201)'), t=captureTemplate(a,g,macros), r=replayTemplate(t,b);
 assert(r.hit,r.reason);assert.equal(r.code,g.replace('delay(15)','delay(201)'));assert.equal(replayTemplate(r.template,a).code,g);
 for(const next of [b.replace('pos<10','pos<11'),b.replace('delay(201)','delay(201+2)'),b.replace('WiFi.h','Other.h')])assert.equal(replayTemplate(t,next).hit,false);
 for(const extra of ['#define delay unsigned','#define delay(x) WRAP(x)'])assert.equal(replayTemplate(captureTemplate(a,g,macros+extra),b).hit,false);
});
test('unchanged preamble constants permit observed replay; edited constants require fresh discovery',()=>{
 const def='#define SENSOR_PIN 13';
 const a=source.replace('#include <WiFi.h>',def),g=generated.replace('#include <WiFi.h>',def);
 const t=captureTemplate(a,g,macros+'\n'+def);assert(t.ordinary);
 const b=a.replace('void loop() {\n','void loop() {\n  delay(SENSOR_PIN);\n');
 assert.equal(replayTemplate(t,b).code,g.replace('void loop() {\n','void loop() {\n  delay(SENSOR_PIN);\n'));
 assert.equal(replayTemplate(t,b.replace('PIN 13','PIN 12')).hit,false);
});
test('actual Blockly add-wait input changes comment numbering and body line count',()=>{
 const a=fs.readFileSync(new URL('blockly-wifi-A.ino',import.meta.url),'utf8'),b=fs.readFileSync(new URL('blockly-wifi-wait.ino',import.meta.url),'utf8');
 assert(a.includes('@ck-source-begin:'));assert(b.includes('while (WiFi.status() != WL_CONNECTED)'));assert.notEqual(a.split('\n').length,b.split('\n').length);
 assert.notEqual(a.split('\n')[0],b.split('\n')[0]);
});
