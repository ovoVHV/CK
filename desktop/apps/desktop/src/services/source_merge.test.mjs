import test from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs/promises';
import {fileURLToPath} from 'node:url';
import {build} from 'esbuild';
const output=new URL(`./.source-merge-test-${process.pid}.mjs`,import.meta.url);
await build({entryPoints:[fileURLToPath(new URL('./source_merge.ts',import.meta.url))],outfile:fileURLToPath(output),bundle:true,platform:'node',format:'esm',logLevel:'silent'});
const {mergeSource,resolveSourceMerge}=await import(output.href);await fs.unlink(output);
const merged=(base,manual,generated)=>resolveSourceMerge(mergeSource(base,manual,generated),{});
test('block changes merge with hand-written functions and independent edits on the same line',()=>{
 const base='void setup() { pinMode(13, OUTPUT); }\nvoid loop() { delay(500); }\n';
 assert.equal(merged(base,base+'void extra() {}\n',base.replace('500','600')),base.replace('500','600')+'void extra() {}\n');
 const single='void loop() { digitalWrite(13, HIGH); delay(500); }';
 assert.equal(merged(single,single.replace('13','12'),single.replace('500','600')),single.replace('13','12').replace('500','600'));
});
test('conflicts require an explicit choice, retaining unrelated changes',()=>{
 const base='int speed=100;\nint led=13;\n';
 const manual='int speed=200;\nint led=13;\nvoid extra(){}\n';
 const generated='int speed=300;\nint led=12;\n';
 const result=mergeSource(base,manual,generated);assert.equal(result.conflicts.length,1);
 assert.throws(()=>resolveSourceMerge(result,{}),/全部/);
 assert.equal(resolveSourceMerge(result,{0:'manual'}),'int speed=200;\nint led=12;\nvoid extra(){}\n');
 assert.equal(resolveSourceMerge(result,{0:'generated'}),'int speed=300;\nint led=12;\nvoid extra(){}\n');
});
test('identical edits deduplicate, delete versus modify and competing insertions conflict',()=>{
 assert.equal(merged('abc','aBc','aBc'),'aBc');
 assert.equal(mergeSource('a\nb\nc\n','a\nc\n','a\nB\nc\n').conflicts.length,1);
 const r=mergeSource('a\nc\n','a\nmanual\nc\n','a\ngenerated\nc\n');assert.equal(r.conflicts.length,1);
 assert.equal(resolveSourceMerge(r,{0:'manual'}),'a\nmanual\nc\n');
});
test('different edits within one literal or identifier cannot invent a third value',()=>{
 for(const [base,a,b] of [['delay(1234);','delay(9234);','delay(1238);'],['int ledPin;','int redPin;','int ledPot;'],['f("abcdef");','f("xbcdef");','f("abcdez");']]){
  const r=mergeSource(base,a,b);assert.equal(r.conflicts.length,1);
  assert.equal(resolveSourceMerge(r,{0:'manual'}),a);assert.equal(resolveSourceMerge(r,{0:'generated'}),b);
 }
});
test('an oversized combination offers both complete, individually valid documents',()=>{
 const base='void setup(){}\nvoid loop(){}\n',a='//'+ 'a'.repeat(550000)+'\n'+base,b=base+'//'+'b'.repeat(550000);
 const r=mergeSource(base,a,b);assert.ok(r.wholeFile);assert.throws(()=>resolveSourceMerge(r,{}));
 assert.equal(resolveSourceMerge(r,{0:'manual'}),a);assert.equal(resolveSourceMerge(r,{0:'generated'}),b);
});
test('Unicode, CRLF and trailing newline remain byte-for-byte intact',()=>{
 const base='// 中文😀\r\nvoid loop(){delay(100);}\r\n';
 assert.equal(merged(base,base.replace('中文😀','中文😀注释'),base.replace('100','200')),base.replace('中文😀','中文😀注释').replace('100','200'));
 assert.equal(merged('', 'hello', ''),'hello');
});
test('large unrelated replacements are bounded and remain selectable',()=>{
 const a='a\n'.repeat(5000), b='b\n'.repeat(5000), c='c\n'.repeat(5000);
 const start=performance.now(), r=mergeSource(a,b,c);
 assert.ok(r.conflicts.length>0);assert.equal(resolveSourceMerge(r,Object.fromEntries(r.conflicts.map(x=>[x.id,'manual']))),b);
 assert.ok(performance.now()-start<2000);
});
test('deterministic varied edits round-trip unchanged sides and merge independent positions',()=>{
 for(let i=1;i<=120;i++){
  const base=`// case ${i}\nvoid setup(){pinMode(${i}, OUTPUT);}\nvoid loop(){delay(${i+100});}\n`;
  const a=base.replace('OUTPUT','INPUT'), b=base.replace(`delay(${i+100})`,`delay(${i+101})`);
  assert.equal(merged(base,a,base),a);assert.equal(merged(base,base,b),b);
  assert.equal(merged(base,a,b),a.replace(`delay(${i+100})`,`delay(${i+101})`));
 }
});
