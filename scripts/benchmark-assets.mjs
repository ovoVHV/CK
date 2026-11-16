import fs from 'node:fs';import path from 'node:path';import {loadConfig} from '../src/config.mjs';import {roots} from '../src/engine.mjs';import {validateAssets} from '../src/asset-engine.mjs';
const config=loadConfig(process.argv[2]),out=process.argv[3];if(!out)throw Error('Output directory required');fs.mkdirSync(out,{recursive:true});
const all=roots({...config.paths,assetRoots:config.assetRoots,collections:[],explicitLibraries:[]});
const variants=[{name:'rust-4-1m',mode:'rust',workers:4,bufferBytes:1048576},{name:'rust-8-1m',mode:'rust',workers:8,bufferBytes:1048576},{name:'rust-2-1m',mode:'rust',workers:2,bufferBytes:1048576},{name:'rust-8-256k',mode:'rust',workers:8,bufferBytes:262144},{name:'rust-4-256k',mode:'rust',workers:4,bufferBytes:262144},{name:'cng-8-1m',mode:'cng',workers:8,bufferBytes:1048576}];
const report={boundary:'full content validator including process/JSON overhead',roots:all,allSamples:[],coldCacheProven:false,status:'RUNNING'};let expected;
for(let round=0;round<5;round++)for(const v of round%2?[...variants].reverse():variants){
 const proof=validateAssets(all,{...v,sizeGrouped:true});expected??=proof.sha256;if(proof.sha256!==expected)throw Error('Asset identity changed across implementations');
 const row={round,...v,...proof,rows:undefined};report.allSamples.push(row);fs.writeFileSync(path.join(out,'asset-ab.json'),JSON.stringify(report,null,2));console.log(v.name,round,proof.elapsedMs.toFixed(3),proof.files,proof.bytes);
}
report.summary=variants.map(v=>{const a=report.allSamples.filter(x=>x.name===v.name).map(x=>x.elapsedMs).sort((a,b)=>a-b);return {...v,medianMs:a[2],minMs:a[0],maxMs:a[4]};}).sort((a,b)=>a.medianMs-b.medianMs);report.status='COMPLETE';fs.writeFileSync(path.join(out,'asset-ab.json'),JSON.stringify(report,null,2));console.log(report.summary);
