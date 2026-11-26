import os from 'node:os';

// Source equality selects I/O scheduling only. It never authorizes reuse.
export function avrRepeatValidation(c, sameSource, cpuCount = os.availableParallelism()) {
 const v=c.validation;
 if(!sameSource || !c.fqbn?.startsWith('arduino:avr:') || !v || v.mode!=='rust'
   || c.features?.avrRepeatValidation===false || c.validationReference || c.assetOpenReference
   || !(c.jobs>=8 && cpuCount>=8) || v.workers!==4 || v.openWorkers!==16
   || v.bufferBytes!==1048576 || v.sizeGrouped!==true) return v;
 return {...v,workers:8,bufferBytes:262144};
}

// A fresh session has no verified working set. Keep the configured full-scan
// profile for its first build and reserve the warm I/O profile for later builds.
export function buildValidation(c,sameSource,hasSession,cpuCount=os.availableParallelism()){
 if(!hasSession)return c.validation;
 const v=c.validation,avr=c.fqbn?.startsWith('arduino:avr:'),esp=c.fqbn?.startsWith('esp32:esp32:');
 if((avr||esp)&&v?.mode==='rust'&&!c.validationReference&&!c.assetOpenReference
  &&c.features?.[avr?'avrRepeatValidation':'esp32RepeatValidation']!==false
  &&cpuCount>=8&&c.jobs>=8&&v.workers===4&&v.openWorkers===16&&v.bufferBytes===1048576&&v.sizeGrouped===true)
  return {...v,workers:8,openWorkers:8,bufferBytes:262144};
 return avrRepeatValidation(c,sameSource,cpuCount);
}
