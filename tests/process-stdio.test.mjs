import test from 'node:test';import assert from 'node:assert/strict';
import {run,asyncRun} from '../src/discovery.mjs';
test('noninteractive native calls receive EOF and retain stdout, stderr and failure codes',async()=>{
 const code="const fs=require('fs');const b=fs.readFileSync(0);process.stdout.write('empty='+b.length);process.stderr.write('diagnostic');";
 const sync=run([process.execPath,'-e',code]);assert.equal(sync.stdout,'empty=0');assert.equal(sync.stderr,'diagnostic');
 const async=await asyncRun([process.execPath,'-e',code+'process.exitCode=7;'],process.cwd());assert.equal(async.code,7);assert.equal(async.stdout,'empty=0');assert.equal(async.stderr,'diagnostic');
 assert.throws(()=>run([process.execPath,'-e',code+'process.exitCode=7;']),/diagnostic/);
 await assert.rejects(()=>asyncRun(['ck-does-not-exist-stdio-test.exe'],process.cwd()));
});
