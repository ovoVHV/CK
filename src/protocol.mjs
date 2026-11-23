import path from 'node:path';
import {allowsFqbn} from './targets.mjs';
import {validateMembers} from './sketch-files.mjs';
import {createHash} from 'node:crypto';
import {ENGINE_VERSION,PROTOCOL_VERSION,CACHE_SCHEMA,THREAT_MODEL,ARTIFACTS,artifactsFor} from './version.mjs';
export const normalize=s=>s.replace(/^\uFEFF/,'').replaceAll('\r\n','\n');
export const digest=b=>createHash('sha256').update(b).digest('hex');
export class BuildError extends Error {
 constructor(code,message,{fallbackSafe=false}={}){super(message);this.code=code;this.fallbackSafe=fallbackSafe;}
}
export function validateRequest(msg,config) {
 if(msg.protocolVersion!==PROTOCOL_VERSION)throw new BuildError('PROTOCOL_VERSION','Unsupported request protocol');
 const r=msg.request;if(!r||!/^[a-zA-Z0-9_-]{1,100}$/.test(r.requestId??''))throw new BuildError('INVALID_REQUEST','Invalid request ID');
 if(typeof msg.source!=='string'||Buffer.byteLength(msg.source)>4*1024*1024)throw new BuildError('INVALID_SOURCE','Invalid or oversized source');
 if(r.sourceSha256!==digest(normalize(msg.source)))throw new BuildError('IDENTITY_MISMATCH','Source digest differs');
 if(/\b__TIMESTAMP__\b/.test(msg.source))throw new BuildError('NOT_QUALIFIED','File-time-dependent source is outside V9.0 scope',{fallbackSafe:true});
 if(!config.features.enabled||!allowsFqbn(config.allowedFqbns,r.fqbn))throw new BuildError('NOT_QUALIFIED','V9 disabled or unsupported target',{fallbackSafe:true});
 if(path.resolve(r.sysroot)!==config.paths.sysroot)throw new BuildError('IDENTITY_MISMATCH','Sysroot differs');
 if(r.forceClean!==undefined&&typeof r.forceClean!=='boolean')throw new BuildError('INVALID_REQUEST','Invalid clean flag');
 if(!Array.isArray(r.libraries)||r.libraries.length>64||r.libraries.some(p=>typeof p!=='string'||!path.isAbsolute(p)))throw new BuildError('INVALID_REQUEST','Invalid library paths');
 const safe={};for(const k of ['requestId','sourceSha256','fqbn','sysroot','workspace','sketchDir','libraries','forceClean','buildSignature'])safe[k]=r[k];
 if(r.projectFiles!=null){
  safe.projectFiles=validateMembers(r.projectFiles);
  if(safe.projectFiles.some(f=>Buffer.from(f.hex,'hex').includes('__TIMESTAMP__')))throw new BuildError('NOT_QUALIFIED','File-time-dependent project source',{fallbackSafe:true});
 }
 if(r.forceOfficial!==undefined&&typeof r.forceOfficial!=='boolean')throw new BuildError('INVALID_REQUEST','Invalid official mode');
 for(const key of ['frontendReference','historyReference','discoveryPreprocessReference','discoveryCompileReference','coldPipelineReference','nativeImageReference','coldLibraryPchReference','discoveryBatchReference','assetOpenReference','coldReference','avrPropertiesReference','esp32PropertiesReference','directExecutionReference']){
  if(r[key]!==undefined&&typeof r[key]!=='boolean')throw new BuildError('INVALID_REQUEST','Invalid reference flag');
  safe[key]=r[key]===true;
 }
 // Rolling library dispatch did not improve matched desktop latency.
 // Preserve alpha.6 scheduling unless a diagnostic explicitly requests it.
 if(r.discoveryBatchReference===undefined)safe.discoveryBatchReference=config.features?.sharedHeaderPch!==true||r.coldLibraryPchReference===true;
 if(safe.coldReference)safe.forceClean=true;
 if(r.noOpReference!==undefined&&typeof r.noOpReference!=='boolean')throw new BuildError('INVALID_REQUEST','Invalid no-op reference flag');safe.noOpReference=r.noOpReference===true;if(r.validationReference!==undefined&&typeof r.validationReference!=='boolean')throw new BuildError('INVALID_REQUEST','Invalid validation reference flag');safe.validationReference=r.validationReference===true;safe.forceOfficial=r.forceOfficial===true;return safe;
}
export function envelope(r,data) {
 return {engineVersion:ENGINE_VERSION,protocolVersion:PROTOCOL_VERSION,cacheSchema:CACHE_SCHEMA,threatModel:THREAT_MODEL,requestId:r.requestId,sourceSha256:r.sourceSha256,fqbn:r.fqbn,...data};
}
export function failure(r,e){return envelope(r,{success:false,error:{code:e.code??'BUILD_FAILED',message:String(e.message??e),fallbackSafe:e.fallbackSafe===true},artifacts:[]});}
export function validateArtifacts(items,fqbn='esp32:esp32:esp32s3'){
 const names=artifactsFor(fqbn);
 if(!Array.isArray(items)||items.length!==names.length)throw Error('Wrong target artifact count');
 const seen=new Set();for(const a of items){if(!names.includes(a.name)||seen.has(a.name)||path.basename(a.file)!==a.name||!Number.isSafeInteger(a.bytes)||a.bytes<0||!/^[0-9a-f]{64}$/.test(a.sha256))throw Error('Invalid or duplicate artifact');seen.add(a.name);}
 return true;
}
