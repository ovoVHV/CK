import test from 'node:test';import assert from 'node:assert/strict';import {checkSize} from '../src/native/size-check.mjs';
test('selected partition and RAM limits reject oversized firmware and malformed observations',()=>{
 const text='.flash.text 500 0\n.dram0.data 50 0\n.dram0.bss 100 0\n',policy={flashRegex:'^(?:\\.flash\\.text|\\.dram0\\.data)\\s+(\\d+)',ramRegex:'^\\.dram0\\.(?:data|bss)\\s+(\\d+)',flashLimit:550,ramLimit:150};
 assert.deepEqual(checkSize(text,policy),{flash:550,ram:150,flashLimit:550,ramLimit:150});
 assert.throws(()=>checkSize(text,{...policy,flashLimit:549}),/program size/);assert.throws(()=>checkSize(text,{...policy,ramLimit:149}),/RAM size/);assert.throws(()=>checkSize('',policy),/required sections/);assert.throws(()=>checkSize(text,{...policy,flashLimit:NaN}),/Invalid/);
});
