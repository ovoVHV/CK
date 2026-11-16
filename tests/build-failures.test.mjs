import test from 'node:test';import assert from 'node:assert/strict';
import {spawnSync} from 'node:child_process';
import {fileURLToPath} from 'node:url';
import {isResourceExhaustion,attachFallbackAttempt} from '../src/build-failures.mjs';
test('resource exhaustion is a terminal error, never an official-discovery retry',()=>{
 for(const message of ['fatal error: error writing to temp.s: No space left on device','磁盘空间不足。','fatal error: out of memory','Cannot allocate memory'])assert(isResourceExhaustion(Error(message)));
 assert(isResourceExhaustion(Object.assign(Error('write'),{code:'ENOSPC'})));
 for(const message of ['fatal error: Unknown.h: No such file or directory','unknown prototype form','ambiguous library candidates'])assert(!isResourceExhaustion(Error(message)));
});
test('fallback receipts include failed attempt time without rewriting successful task counts',()=>{
 const counts={CompileGCC:29},successful={success:true,wallMs:7000,counts},failed={label:'cold',wallMs:3000,error:'ambiguous include',phases:{discoveryMs:2500}};
 const result=attachFallbackAttempt(successful,failed,10025);
 assert.equal(result.wallMs,10025);assert.deepEqual(result.fallbackAttempts,[{label:'cold',elapsedMs:3000,error:'ambiguous include',phases:{discoveryMs:2500}}]);assert.equal(result.counts,counts);assert.equal(successful.wallMs,7000);
});
test('BuildSession rejects disk exhaustion without invoking an official retry',()=>{
 const result=spawnSync(process.execPath,['--experimental-test-module-mocks',fileURLToPath(new URL('./fixtures/resource-exhaustion.mjs',import.meta.url))],{encoding:'utf8',windowsHide:true,timeout:30000});
 assert.equal(result.status,0,result.stderr+result.stdout);
});
