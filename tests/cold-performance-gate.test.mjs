import test from 'node:test';import assert from 'node:assert/strict';
import {coldPerformanceGate} from './cold-performance-gate.mjs';
const rows=times=>times.map(wallMs=>({mode:'candidate',wallMs}));
test('successful firmware cannot hide a slow installed sample or qualify an incomplete run',()=>{
 const limits={limitMs:90000,nativeUI:true};
 const slow=rows([85000,84000,91000,86000,83000]),original=structuredClone(slow);
 const result=coldPerformanceGate(slow,limits);assert.equal(result.status,'FAIL');assert.equal(result.overLimit,1);assert.equal(result.medianMs,85000);assert.equal(result.maxMs,91000);assert.deepEqual(slow,original);
 assert.equal(coldPerformanceGate(rows([80000,80000]),limits).qualified,false);
 assert.equal(coldPerformanceGate(rows([80000,80000,80000,80000,90000]),limits).qualified,true);
 assert.equal(coldPerformanceGate(rows([80000,80000,80000,80000,80000]),{...limits,nativeUI:false}).qualified,false);
 const reference=rows([80000,80000,80000,80000,80000]);reference[2].mode='reference';assert.equal(coldPerformanceGate(reference,limits).qualified,false);
 assert.equal(coldPerformanceGate(rows([80000,80000,80000,80000,80000])).status,'NOT_EVALUATED');
 assert.equal(coldPerformanceGate([],limits).qualified,false);
 assert.throws(()=>coldPerformanceGate(rows([NaN]),limits));
});
