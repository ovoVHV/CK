import test from 'node:test';
import assert from 'node:assert/strict';
import {packHistory,verifiedHistory} from '../src/scheduler.mjs';
import {sha} from '../src/resolver.mjs';
test('history compression preserves the original content proof and rejects corrupt or oversized restores',()=>{
 const bytes=Buffer.alloc(1024*1024,0x81),depBytes=Buffer.from('o: src');
 const row={bytes,depBytes,proof:{bytes:bytes.length,sha256:sha(bytes)},dependencyMetadata:{sha256:sha(depBytes)}};
 const stored=packHistory(row);assert.equal(stored.compressed,true);assert.ok(stored.bytes.length<row.bytes.length);
 assert.deepEqual(verifiedHistory(stored).bytes,bytes);
 assert.equal(verifiedHistory({...stored,bytes:stored.bytes.subarray(0,5)}),null);
 assert.equal(verifiedHistory({...stored,depBytes:Buffer.from('changed')}),null);
 assert.equal(verifiedHistory({...stored,proof:{...row.proof,bytes:32}}),null);
 assert.equal(verifiedHistory({...stored,proof:{...row.proof,sha256:'0'.repeat(64)}}),null);
});
