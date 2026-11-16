import test from 'node:test';import assert from 'node:assert/strict';
import {formatBuildDiagnostics} from '../src/build-diagnostics.mjs';
test('UI reports official overhead, unknown discovery counts and actual restores honestly',()=>{
 const text=formatBuildDiagnostics({counts:{DiscoveryGCC:null,CompileGCC:0,Linker:0,ImageGenerator:0,ObjectRetained:0,ObjectRestored:71},phases:{officialFrontendMs:81435.3285,inputValidationMs:2176.2863,postValidationMs:2107.2548},graphReuse:{hit:false,reason:'source-contract-not-supported'},sourceEligibility:{eligible:false,reason:'Nonliteral include or other preprocessing directive'}});
 assert(text.includes('官方前端=81.435s'));assert(text.includes('Discovery GCC=未统计'));assert(text.includes('Compile GCC=0'));assert(text.includes('对象沿用=0，对象恢复=71'));assert(!text.includes('快速路径=命中'));
});

test('asset opening diagnostics label cumulative worker times separately from elapsed time',()=>{
 const text=formatBuildDiagnostics({assetProof:{workers:4,openWorkers:16,metrics:{enumerationMs:1000,openSumMs:72000,readSumMs:1400,hashSumMs:1100}},phases:{inputValidationMs:20000},counts:{}});
 assert(text.includes('前=20.000s'));assert(text.includes('打开线程累计=72.000s'));assert(text.includes('不能相加当总耗时'));assert(text.includes('打开线程=16，读取线程=4'));
});
