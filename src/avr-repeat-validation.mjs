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
