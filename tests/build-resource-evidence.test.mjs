import test from 'node:test';
import assert from 'node:assert/strict';
import {withBuildDiagnostics,observeCommandDiagnostics,currentWarningCount,buildResourceEvidence,formatResourceEvidence} from '../src/build-resource-evidence.mjs';
const size={flash:1234,ram:12,flashLimit:32256,ramLimit:2048};
test('size measurements preserve actual configuration limits and render consumable upload evidence',()=>{
 const evidence=buildResourceEvidence(Buffer.from(JSON.stringify(size)),size,2);
 const text=formatResourceEvidence(evidence).join('\n');
 assert.match(text,/Sketch uses 1234 bytes \(3%\).*Maximum is 32256 bytes/);
 assert.match(text,/Global variables use 12 bytes \(0%\).*Maximum is 2048 bytes/);
 assert.match(text,/warning_count=2/);
});
test('mismatched, incomplete and oversized evidence fails closed instead of reporting a false safe budget',()=>{
 for(const changes of [{flashLimit:10000},{ramLimit:4096},{ram:-1},{flash:40000},{flash:null},{ram:0.5}]){
  assert.throws(()=>buildResourceEvidence(Buffer.from(JSON.stringify({...size,...changes})),size,0));
 }
 assert.throws(()=>buildResourceEvidence(Buffer.from(JSON.stringify(size)),size,null));
 assert.deepEqual(formatResourceEvidence(null),[]);
});
test('warning observations stay inside each request and include compiler JSON channels',async()=>{
 const result=await Promise.all([withBuildDiagnostics(async()=>{
  observeCommandDiagnostics({stderr:'sketch.ino:4: warning: unused value\n'});
  await new Promise(r=>setTimeout(r,10));
  observeCommandDiagnostics({stdout:JSON.stringify({compiler_out:'unit.cpp:1: warning: text\n',compiler_err:'unit.cpp:2: warning: text\n'})});
  return currentWarningCount();
 }),withBuildDiagnostics(async()=>{observeCommandDiagnostics({stdout:'no warnings'});return currentWarningCount();})]);
 assert.deepEqual(result,[3,0]);assert.equal(currentWarningCount(),null);
});
