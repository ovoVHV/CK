import {cliDirectories} from './cli-directories.mjs';
import fs from 'node:fs';
import path from 'node:path';
import os from 'node:os';
import {fileURLToPath} from 'node:url';
import {ENGINE_VERSION,PROTOCOL_VERSION} from './version.mjs';
import {rejectReparse,beneath} from './paths.mjs';
import {TARGET_FAMILIES,parseFqbn,installedPlatforms} from './targets.mjs';
export const packageRoot=path.resolve(path.dirname(fileURLToPath(import.meta.url)),'..');
export const defaultJobs=()=>Math.min(16,Math.max(1,os.availableParallelism()));
const keys=(x,allowed,label)=>{if(!x||typeof x!=='object'||Array.isArray(x))throw Error('Invalid '+label);for(const k of Object.keys(x))if(!allowed.includes(k))throw Error('Unknown '+label+' field: '+k);};
function absolute(p,label,kind){if(typeof p!=='string'||!path.isAbsolute(p))throw Error('Absolute '+label+' required');rejectReparse(p);if(kind){const s=fs.statSync(p);if(kind==='file'?!s.isFile():!s.isDirectory())throw Error('Invalid '+label);}return path.resolve(p);}
export function loadConfig(file) {return validateConfig(JSON.parse(fs.readFileSync(file,'utf8').replace(/^\uFEFF/,'')));}
export function validateConfig(c) {
 for(const name of ['CPATH','C_INCLUDE_PATH','CPLUS_INCLUDE_PATH','GCC_EXEC_PREFIX','LIBRARY_PATH','COMPILER_PATH','GCC_COMPARE_DEBUG'])if(process.env[name])throw Error('External search environment outside V9.0 profile: '+name);
 keys(c,['schemaVersion','engineVersion','paths','features','limits','allowedFqbns','sourceDateEpoch','assetValidation'],'config');
 if(c.schemaVersion!==PROTOCOL_VERSION||c.engineVersion!==ENGINE_VERSION)throw Error('Unsupported configuration version');
 keys(c.paths,['sysroot','node','cli','ninja','cliConfig','userLibraries','workspaceRoot','evidenceRoot'],'paths');
 const p=c.paths;for(const n of ['node','cli','ninja','cliConfig'])absolute(p[n],n,'file');for(const n of ['sysroot','userLibraries'])absolute(p[n],n,'directory');
 for(const n of ['workspaceRoot','evidenceRoot'])absolute(p[n],n);
 if(path.resolve(p.node).toLowerCase()!==path.resolve(process.execPath).toLowerCase())throw Error('Controller must use the configured Node runtime');
 if(Number(process.versions.node.split('.')[0])!==24)throw Error('V9.0 requires the qualified Node 24 runtime');
 if(beneath(p.workspaceRoot,p.evidenceRoot,true)||beneath(p.evidenceRoot,p.workspaceRoot,true))throw Error('Sessions and evidence must be separate');
 const defaults={enabled:false,independentDiscovery:true,frontendReplay:true,sessionHistory:true,assetBackend:'rust',receiptOptimize:false,noOpFastPath:true,sharedHeaderPch:true,batchInputProof:true,nativeImageRecipes:true,coldScheduling:true,avrProperties:true,avrRepeatValidation:true,esp32Properties:true,esp32RepeatValidation:true,directExecution:true,deferCoreOnRediscovery:true};
 keys(c.features??{},Object.keys(defaults),'feature');const features={...defaults,...c.features};
 for(const k of ['enabled','independentDiscovery','frontendReplay','sessionHistory','receiptOptimize','noOpFastPath','sharedHeaderPch','batchInputProof','nativeImageRecipes','coldScheduling','avrProperties','avrRepeatValidation','esp32Properties','esp32RepeatValidation','directExecution'])if(typeof features[k]!=='boolean')throw Error('Feature must be boolean: '+k);
 if(features.receiptOptimize)throw Error('G3 is not a V9.0 candidate');
 if(typeof features.deferCoreOnRediscovery!=='boolean')throw Error('Feature must be boolean: deferCoreOnRediscovery');
 if(!['rust','node-reference'].includes(features.assetBackend))throw Error('Unqualified asset backend');
 keys(c.assetValidation??{},['workers','openWorkers','bufferBytes','sizeGrouped'],'assetValidation');
 const assetValidation={workers:4,openWorkers:16,bufferBytes:1048576,sizeGrouped:true,...c.assetValidation};
 if(![0,4,8,16].includes(assetValidation.openWorkers)||![1,2,4,8].includes(assetValidation.workers)||![65536,262144,1048576,4194304].includes(assetValidation.bufferBytes)||typeof assetValidation.sizeGrouped!=='boolean')throw Error('Invalid complete-validation tuning');
 keys(c.limits??{},['jobs','maxWorkspaces','historyBytes','leaseTimeoutMs','requestTimeoutMs'],'limit');
 const limits={jobs:defaultJobs(),maxWorkspaces:4,historyBytes:128*1024*1024,leaseTimeoutMs:120000,requestTimeoutMs:900000,...c.limits};
 for(const [k,v]of Object.entries(limits))if(!Number.isSafeInteger(v)||v<1)throw Error('Invalid limit: '+k);
 if(limits.jobs>16||limits.maxWorkspaces>8||limits.historyBytes>512*1024*1024||limits.leaseTimeoutMs>300000||limits.requestTimeoutMs>3600000)throw Error('Limit exceeds V9.0 bound');
 if(!Array.isArray(c.allowedFqbns)||!c.allowedFqbns.length||c.allowedFqbns.some(x=>!TARGET_FAMILIES.includes(x)&&!parseFqbn(x)))throw Error('Invalid native target selectors');
 if(!['esp32','avr'].some(arch=>installedPlatforms(p.sysroot,arch).length))throw Error('A supported ESP32 or Arduino AVR Core is not installed');
 if(!Number.isSafeInteger(c.sourceDateEpoch)||c.sourceDateEpoch<0)throw Error('A deterministic source date epoch is required by the V9.0 profile');
 const yaml=fs.readFileSync(p.cliConfig,'utf8'),{data,user}=cliDirectories(yaml);
 if(!data||!user||path.resolve(data)!==path.resolve(p.sysroot)||path.resolve(user,'libraries')!==path.resolve(p.userLibraries))throw Error('CLI directory mapping differs');
 // Explicit pinned profile, including all installed version namespaces of each tool.
 const roots=[p.node,p.cli,p.ninja,p.cliConfig,p.userLibraries,path.join(packageRoot,'src'),path.join(packageRoot,'bin'),process.env.ComSpec??path.join(process.env.SystemRoot,'System32/cmd.exe'),
  path.join(p.sysroot,'packages/builtin/tools/ctags'),
  ...fs.readdirSync(p.sysroot).filter(n=>/^package.*\.json$/.test(n)).sort().map(n=>path.join(p.sysroot,n))];
 for(const r of roots){rejectReparse(r);if(!fs.existsSync(r))throw Error('Missing asset root: '+r);if(beneath(r,p.workspaceRoot,true)||beneath(r,p.evidenceRoot,true))throw Error('Mutable runtime inside validated assets');}
 return {...c,paths:Object.fromEntries(Object.entries(p).map(([k,v])=>[k,path.resolve(v)])),features,limits,assetValidation,assetRoots:[...new Set(roots.map(x=>path.resolve(x)))]};
}
